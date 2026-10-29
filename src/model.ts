import { experimental_evaluate as evaluate } from "ai";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { assertJevCredentials, config, type JevProvider } from "./config";
import { leverageRungs, liveIntent, parseLeverage, quoteAction, type Bias, type Intent } from "./plan";
import type { Action, Side } from "./types";

/** What the model sees. Compact, relative, human-readable. */
export interface TradeState {
  coin: string;
  market: string;
  tick: number;
  tickMs: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number;
  /** Cumulative resting size within 10/25/50 bps of mid, per side. */
  depth: { [band: string]: { bid: number; ask: number } };
  /** Top 5 levels each side, best first, as "price x size". */
  book: { bids: string[]; asks: string[] };
  returnsBps: { last1: number; last5: number; last20: number; last100: number };
  recentMids: string;
  /** Taker prints in the lookback window. cvdSz = taker buy size minus taker sell size. */
  trades: { count: number; buySz: number; sellSz: number; cvdSz: number; vwap: number | null; lastPrice: number | null; lastSide: Side | null };
  recentTrades: string[];
  position: {
    coin: string;
    side: "long" | "short" | "flat";
    size: number;
    notionalUsd: number;
    entry: number | null;
    leverage: number | null;
    liquidationPx: number | null;
    distanceBps: number | null;
    unrealizedUsd: number;
  };
  indicators: {
    sma20: number | null;
    sma50: number | null;
    ema20: number | null;
    midVsSma20Bps: number | null;
    midVsSma50Bps: number | null;
    rsi14: number | null;
    vol20Bps: number | null;
    high20: number | null;
    low20: number | null;
    rangePos20: number | null;
  };
  asset: {
    markPx: number | null;
    oraclePx: number | null;
    fundingBps: number | null;
    premiumBps: number | null;
    openInterest: number | null;
    dayNtlVlmUsd: number | null;
    dayChangeBps: number | null;
    maxLeverage: number;
  };
  maxLeverage: number;
}

export interface ModelDecision {
  action: Action;
  intent: Intent;
  bias: Bias;
  leverage: number;
  probabilities: {
    buy: number;
    sell: number;
    hold: number;
    long: number;
    short: number;
    open: number;
    close: number;
  };
  upIn10: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens?: number;
  modelCostUsd?: number;
  modelCostSource?: string;
  audit?: JevAudit;
  generationId?: string;
}

export interface ModelUsage {
  generationId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelContext {
  onUsage: (usage: ModelUsage) => void;
}

export interface Model {
  readonly name: string;
  decide(state: TradeState, context?: ModelContext): Promise<ModelDecision>;
}

/** Book, tape, and the open position. Wallet fills and lifetime PnL stay off this object. */
export function marketFacing(state: TradeState) {
  const pos = state.position;
  return {
    coin: state.coin,
    market: state.market,
    tick: state.tick,
    tickMs: state.tickMs,
    mid: state.mid,
    spreadBps: state.spreadBps,
    bookImbalance: state.bookImbalance,
    depth: state.depth,
    book: state.book,
    returnsBps: state.returnsBps,
    recentMids: state.recentMids,
    trades: state.trades,
    recentTrades: state.recentTrades,
    position: {
      coin: pos.coin,
      side: pos.side,
      size: pos.size,
      notionalUsd: pos.notionalUsd,
      entry: pos.entry,
      leverage: pos.leverage,
      liquidationPx: pos.liquidationPx,
      distanceBps: pos.distanceBps,
      ...(pos.side === "flat" ? {} : { unrealizedUsd: pos.unrealizedUsd }),
    },
    indicators: state.indicators,
    asset: state.asset,
    maxLeverage: state.maxLeverage,
  };
}

export type MarketFacingState = ReturnType<typeof marketFacing>;

interface JevChoiceQuestion {
  type: "choice";
  instructions: { question: string; goal: string; timing: string; inputs: string };
  criteria: Record<string, string>;
}

export interface JevQuestionSet {
  [key: string]: JevChoiceQuestion;
  bias: JevChoiceQuestion;
  intent: JevChoiceQuestion;
  leverage: JevChoiceQuestion;
}

/** Labels and live fields only. No advice about when to pick an action. */
export function jevQuestions(state: TradeState): JevQuestionSet {
  const asset = state.coin;
  const pos = state.position;
  const stance = pos.side === "flat"
    ? `flat ${asset}`
    : `${pos.side} ${pos.size} ${asset} @ ${pos.entry ?? "?"}`;
  const levNow = pos.leverage != null ? `${pos.leverage}x` : "unset";
  const rungs = leverageRungs(state.maxLeverage);
  const levCriteria: Record<string, string> = {};
  for (const n of rungs) {
    levCriteria[String(n)] = `${n}x`;
  }
  const ctx = `${asset} ${state.market}. position has side/size/entry. indicators are 1m sma/ema/rsi/vol. asset is mark/oracle/funding/oi. trades and book are the tape.`;
  const bias = {
    type: "choice" as const,
    instructions: {
      question: `long or short ${asset}?`,
      goal: `${state.market}`,
      timing: `tickMs=${state.tickMs}. position=${stance}.`,
      inputs: ctx,
    },
    criteria: {
      long: "long",
      short: "short",
    },
  };
  const leverage = {
    type: "choice" as const,
    instructions: {
      question: `cross leverage for ${asset}?`,
      goal: `current ${levNow}. max ${state.maxLeverage}x.`,
      timing: `rungs ${rungs.join(" ")}`,
      inputs: ctx,
    },
    criteria: levCriteria,
  };
  if (pos.side === "flat") {
    return {
      bias,
      intent: {
        type: "choice" as const,
        instructions: {
          question: `open or hold ${asset}?`,
          goal: `position=${stance}.`,
          timing: `tickMs=${state.tickMs}`,
          inputs: ctx,
        },
        criteria: {
          open: "open",
          hold: "hold",
        },
      },
      leverage,
    };
  }
  return {
    bias,
    intent: {
      type: "choice" as const,
      instructions: {
        question: `open, close, or hold ${asset}?`,
        goal: `position=${stance}.`,
        timing: `tickMs=${state.tickMs}`,
        inputs: ctx,
      },
      criteria: {
        open: "open",
        close: "close",
        hold: "hold",
      },
    },
    leverage,
  };
}

interface Packed {
  intent: Intent;
  bias: Bias;
  leverage: number;
  longP: number;
  shortP: number;
  openP: number;
  closeP: number;
  holdP: number;
  latencyMs: number;
  inputTokens: number;
}

function pack(o: Packed): ModelDecision {
  const action = quoteAction(o.intent, o.bias);
  // long/short and open/close/hold are each a distribution. buy/sell are the legacy
  // pair: the mass behind the order actually being sent, discounted by the hold mass.
  const conviction = action === "buy"
    ? Math.max(o.longP, o.openP)
    : action === "sell"
      ? Math.max(o.shortP, o.closeP)
      : 0;
  const sized = conviction * (1 - o.holdP);
  return {
    action,
    intent: o.intent,
    bias: o.bias,
    leverage: o.leverage,
    probabilities: {
      buy: action === "buy" ? sized : 0,
      sell: action === "sell" ? sized : 0,
      hold: o.holdP,
      long: o.longP,
      short: o.shortP,
      open: o.openP,
      close: o.closeP,
    },
    upIn10: o.longP,
    latencyMs: o.latencyMs,
    inputTokens: o.inputTokens,
  };
}

function normChoice(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  const n = normChoice(raw);
  return (allowed as readonly string[]).includes(n) ? n as T : fallback;
}

function pickKnown<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  const n = normChoice(raw);
  return (allowed as readonly string[]).includes(n) ? n as T : null;
}

/** Normalize a choice answer over `keys`. Missing probabilities fall back to the pick. */
function choiceProbs(answer: ChoiceAnswer | undefined, keys: readonly string[]): Record<string, number> {
  const choice = normChoice(answer?.choice);
  const p = answer?.probabilities ?? {};
  const raw = keys.map((k) => Math.max(0, p[k] ?? (choice === k ? 1 : 0)));
  const sum = raw.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  if (sum <= 0) {
    const at = keys.indexOf(choice);
    if (at < 0) {
      keys.forEach((k) => { out[k] = 1 / keys.length; });
      return out;
    }
    keys.forEach((k, i) => { out[k] = i === at ? 1 : 0; });
    return out;
  }
  keys.forEach((k, i) => { out[k] = raw[i]! / sum; });
  return out;
}

export interface ChoiceAnswer {
  type?: "choice";
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface JevAnswers {
  bias?: ChoiceAnswer;
  intent?: ChoiceAnswer;
  leverage?: ChoiceAnswer;
}

export interface JevUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export const JEV_PROMPT_VERSION = "jev-questions-v1";

export interface JevAudit {
  provider: JevProvider;
  modelId: string;
  promptVersion: string;
  state: MarketFacingState;
  questions: JevQuestionSet;
  rawAnswers: JevAnswers;
  usage: JevUsage;
  modelCostUsd?: number;
  modelCostSource?: string;
}

const PROBABILITY_TOLERANCE = 1e-6;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalidJevAnswer(message: string): never {
  throw new Error(`invalid Jev answer: ${message}`);
}

function validProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateChoiceAnswer(raw: unknown, id: string, allowed: readonly string[]): ChoiceAnswer {
  if (!isRecord(raw)) invalidJevAnswer(`${id} must be an answer object`);
  if (raw.type !== undefined && raw.type !== "choice") invalidJevAnswer(`${id} has an invalid type`);
  const choice = raw.choice;
  if (typeof choice !== "string" || !allowed.includes(choice)) {
    invalidJevAnswer(`${id} selected an unknown choice`);
  }
  if (raw.confidence !== undefined && !validProbability(raw.confidence)) {
    invalidJevAnswer(`${id} has an invalid confidence`);
  }

  let probabilities: Record<string, number> | undefined;
  if (raw.probabilities !== undefined) {
    const rawProbabilities = raw.probabilities;
    if (!isRecord(rawProbabilities) || !hasExactKeys(rawProbabilities, allowed)) {
      invalidJevAnswer(`${id} probabilities must contain exactly the known choices`);
    }
    const values = allowed.map((key) => rawProbabilities[key]);
    if (!values.every(validProbability)) {
      invalidJevAnswer(`${id} probabilities must be finite numbers in [0, 1]`);
    }
    const numericValues = values as number[];
    const sum = numericValues.reduce((total, probability) => total + probability, 0);
    if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE) {
      invalidJevAnswer(`${id} probabilities must sum to 1`);
    }
    const selected = rawProbabilities[choice] as number;
    if (numericValues.some((probability) => probability > selected + PROBABILITY_TOLERANCE)) {
      invalidJevAnswer(`${id} choice must have maximal probability`);
    }
    probabilities = Object.fromEntries(allowed.map((key) => [key, rawProbabilities[key] as number]));
  }

  return {
    ...(raw.type !== undefined ? { type: "choice" as const } : {}),
    choice,
    ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}),
    ...(probabilities !== undefined ? { probabilities } : {}),
  };
}

/** Validate the successful provider boundary without changing Jev's fallback semantics. */
export function validateJevAnswers(
  answers: unknown,
  positionSide: "long" | "short" | "flat",
  maxLeverage: number,
): JevAnswers {
  if (!isRecord(answers) || !hasExactKeys(answers, ["bias", "intent", "leverage"])) {
    invalidJevAnswer("bias, intent, and leverage are required");
  }
  if (!Number.isFinite(maxLeverage) || maxLeverage < 1) invalidJevAnswer("max leverage is invalid");

  const intentChoices = positionSide === "flat" ? ["open", "hold"] : ["open", "close", "hold"];
  const rungs = leverageRungs(maxLeverage).map(String);
  return {
    bias: validateChoiceAnswer(answers.bias, "bias", ["long", "short"]),
    intent: validateChoiceAnswer(answers.intent, "intent", intentChoices),
    leverage: validateChoiceAnswer(answers.leverage, "leverage", rungs),
  };
}

function jsonSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createJevAudit(input: {
  provider: JevProvider;
  modelId: string;
  state: MarketFacingState;
  questions: JevQuestionSet;
  rawAnswers: JevAnswers;
  usage: JevUsage;
  modelCostUsd?: number;
  modelCostSource?: string;
}): JevAudit {
  return {
    provider: input.provider,
    modelId: input.modelId,
    promptVersion: JEV_PROMPT_VERSION,
    state: jsonSnapshot(input.state),
    questions: jsonSnapshot(input.questions),
    rawAnswers: jsonSnapshot(input.rawAnswers),
    usage: jsonSnapshot(input.usage),
    ...(input.modelCostUsd !== undefined ? { modelCostUsd: input.modelCostUsd } : {}),
    ...(input.modelCostSource !== undefined ? { modelCostSource: input.modelCostSource } : {}),
  };
}

/** Map a Jev answer set onto one tick. A side we cannot read is a hold, not a long. */
export function decideFromJevAnswers(
  answers: JevAnswers,
  positionSide: "long" | "short" | "flat",
  maxLeverage: number,
  currentLeverage: number | null,
  latencyMs = 0,
  inputTokens = 0,
): ModelDecision {
  const flat = positionSide === "flat";
  const biasPick = pickKnown(answers.bias?.choice, ["long", "short"] as const);
  const choices = flat ? (["open", "hold"] as const) : (["open", "close", "hold"] as const);
  const intent = liveIntent(positionSide, biasPick ? pick(answers.intent?.choice, choices, "hold") : "hold");
  const dir = choiceProbs(answers.bias, ["long", "short"]);
  const act = choiceProbs(answers.intent, choices);
  return pack({
    intent,
    bias: biasPick ?? "long",
    leverage: parseLeverage(answers.leverage?.choice, maxLeverage, currentLeverage ?? 1),
    longP: dir.long!,
    shortP: dir.short!,
    openP: act.open!,
    closeP: act.close ?? 0,
    holdP: act.hold!,
    latencyMs,
    inputTokens,
  });
}

let typesafe: TypeSafeClient | undefined;

function typesafeClient(): TypeSafeClient {
  return (typesafe ??= new TypeSafeClient({
    apiKey: process.env.TYPESAFE_API_KEY,
    defaultModel: config.jevModelId,
    retry: { maxRetries: 0 },
  }));
}

const JEV_DEADLINE_MS = 4000;

interface JevCall {
  answers: JevAnswers;
  state: MarketFacingState;
  questions: JevQuestionSet;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  modelCostUsd?: number;
  modelCostSource?: string;
  generationId?: string;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function generationId(value: unknown): string | undefined {
  return typeof value === "string" && /^gen_[a-zA-Z0-9_-]{8,128}$/.test(value) ? value : undefined;
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`jev timeout ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function callJev(state: TradeState, context?: ModelContext): Promise<JevCall> {
  const seen = marketFacing(state);
  const qs = jevQuestions(state);
  const run = async () => {
    if (config.jevProvider === "gateway") {
      const r = await evaluate({
        model: config.jevModelId,
        state: seen as never,
        questions: qs,
        maxRetries: 0,
        providerOptions: { gateway: { user: "jev-trade", tags: ["jev-trade", "paper", state.coin] } },
      });
      const metadata = r.providerMetadata?.gateway;
      const usage: ModelUsage = {
        generationId: generationId(isRecord(metadata) ? metadata.generationId : undefined),
        inputTokens: tokenCount(r.usage?.inputTokens),
        outputTokens: tokenCount(r.usage?.outputTokens),
      };
      // Persist billing metadata even if validation fails or the decision already timed out.
      context?.onUsage(usage);
      const answers = validateJevAnswers(r.answers, state.position.side, state.maxLeverage);
      return {
        answers,
        state: seen,
        questions: qs,
        modelId: r.response.modelId,
        ...usage,
      };
    }
    const r = await typesafeClient().systemOne(
      {
        model: config.jevModelId,
        state: seen as never,
        questions: qs,
      },
      { retry: { maxRetries: 0 } },
    );
    context?.onUsage({ inputTokens: tokenCount(r.usage.input_tokens), outputTokens: tokenCount(r.usage.output_tokens) });
    const answers = validateJevAnswers(r.answers, state.position.side, state.maxLeverage);
    return {
      answers,
      state: seen,
      questions: qs,
      modelId: r.model,
      inputTokens: tokenCount(r.usage.input_tokens),
      outputTokens: tokenCount(r.usage.output_tokens),
    };
  };
  return withDeadline(run().catch((error: unknown) => {
    if (isRecord(error)) {
      const id = generationId(error.generationId);
      if (id) context?.onUsage({ generationId: id });
    }
    throw error;
  }), JEV_DEADLINE_MS);
}

/** Real Jev. JEV_PROVIDER selects official TypeSafe or Vercel AI Gateway. */
export class JevModel implements Model {
  readonly name = "jev";

  async decide(state: TradeState, context?: ModelContext): Promise<ModelDecision> {
    const t0 = performance.now();
    const r = await callJev(state, context);
    const decision = decideFromJevAnswers(
      r.answers,
      state.position.side,
      state.maxLeverage,
      state.position.leverage,
      performance.now() - t0,
      r.inputTokens ?? 0,
    );
    decision.outputTokens = r.outputTokens;
    decision.modelCostUsd = r.modelCostUsd;
    decision.modelCostSource = r.modelCostSource;
    decision.generationId = r.generationId;
    decision.audit = createJevAudit({
      provider: config.jevProvider,
      modelId: r.modelId,
      state: r.state,
      questions: r.questions,
      rawAnswers: r.answers,
      usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens },
      modelCostUsd: r.modelCostUsd,
      modelCostSource: r.modelCostSource,
    });
    return decision;
  }
}

/** Deterministic stand-in: momentum + imbalance. Jev-shaped open/close/hold/long/short/leverage. */
export class MockModel implements Model {
  readonly name = "mock";

  async decide(state: TradeState): Promise<ModelDecision> {
    const t0 = performance.now();
    const flow = state.trades.buySz + state.trades.sellSz ? state.trades.cvdSz / (state.trades.buySz + state.trades.sellSz) : 0;
    const signal = state.returnsBps.last20 / 8 + state.bookImbalance * 1.5 + flow * 2 + this.noise(state.tick);
    const longP = 1 / (1 + Math.exp(-signal));
    const bias: Bias = longP >= 0.5 ? "long" : "short";
    const against = (bias === "long" && state.position.side === "short") || (bias === "short" && state.position.side === "long");
    // A weak signal is not worth a round trip, so stand down instead of forcing a side.
    const weak = Math.abs(signal) < 0.35;
    const picked: Intent = against ? "close" : weak ? "hold" : "open";
    const intent = liveIntent(state.position.side, picked);
    const holdP = intent === "hold" ? 0.7 : 0.15;
    const closeP = intent === "close" ? 0.7 : 0.15;
    const leverage = parseLeverage(1 + Math.abs(signal) * 8, state.maxLeverage, state.position.leverage ?? 1);
    await Bun.sleep(80);
    return pack({
      intent,
      bias,
      leverage,
      longP,
      shortP: 1 - longP,
      openP: Math.max(0, 1 - holdP - closeP),
      closeP,
      holdP,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    });
  }

  private noise(tick: number) {
    let h = tick * 2654435761 >>> 0;
    h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return ((h % 1000) / 1000 - 0.5) * 3;
  }
}

export const createModel = (): Model => {
  if (config.model !== "jev") return new MockModel();
  assertJevCredentials(config.model, config.jevProvider, {
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
  });
  return new JevModel();
};
