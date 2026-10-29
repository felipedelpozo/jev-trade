import { expect, test } from "bun:test";
import {
  createJevAudit,
  decideFromJevAnswers,
  generationIdFromError,
  jevQuestions,
  marketFacing,
  validateJevAnswers,
  type TradeState,
} from "../src/model";

function fixture(side: TradeState["position"]["side"], maxLeverage = 40): TradeState {
  return {
    coin: "BTC",
    market: "BTC-USD",
    tick: 1,
    tickMs: 500,
    mid: 77000,
    spreadBps: 0.13,
    bookImbalance: 0,
    depth: {},
    book: { bids: [], asks: [] },
    returnsBps: { last1: 0, last5: 0, last20: 0, last100: 0 },
    recentMids: "",
    trades: { count: 0, buySz: 0, sellSz: 0, cvdSz: 0, vwap: null, lastPrice: null, lastSide: null },
    recentTrades: [],
    position: {
      coin: "BTC",
      side,
      size: side === "flat" ? 0 : 0.001,
      notionalUsd: side === "flat" ? 0 : 77,
      entry: side === "flat" ? null : 77000,
      leverage: 1,
      liquidationPx: null,
      distanceBps: null,
      unrealizedUsd: side === "flat" ? 0 : -1.25,
    },
    indicators: {
      sma20: null, sma50: null, ema20: null, midVsSma20Bps: null, midVsSma50Bps: null,
      rsi14: null, vol20Bps: null, high20: null, low20: null, rangePos20: null,
    },
    asset: {
      markPx: null, oraclePx: null, fundingBps: null, premiumBps: null,
      openInterest: null, dayNtlVlmUsd: null, dayChangeBps: null, maxLeverage,
    },
    maxLeverage,
  };
}

function blob(side: TradeState["position"]["side"]) {
  return JSON.stringify(jevQuestions(fixture(side))).toLowerCase();
}

const scoreboard = [
  "recentfills",
  "this wallet",
  "realized",
  "feesusd",
  "pnlusd",
  "pnlpct",
  "pnl $",
  "equity=",
  "withdrawable",
  "worth paying",
  "not worth trading",
  "most ticks",
  "clears the spread",
  "round trip",
  "by more than the spread",
  "only when",
  "pick this when",
  "stay flat",
  "you are flat",
  "leave it alone",
  "ignored on a hold",
  "horizonticks",
  "post-only",
  "no order",
  "spread=",
];

test("Jev questions name the actions and do not coach a pick", () => {
  const flat = blob("flat");
  const long = blob("long");
  expect(flat).toContain("open or hold btc?");
  expect(flat).toContain('"open":"open"');
  expect(flat).toContain('"hold":"hold"');
  expect(long).toContain("open, close, or hold btc?");
  expect(long).toContain('"close":"close"');
  for (const text of [flat, long]) {
    for (const phrase of scoreboard) {
      expect(text).not.toContain(phrase);
    }
  }
});

test("1x requests omit leverage while higher caps keep all three questions", () => {
  expect(Object.keys(jevQuestions(fixture("flat", 1)))).toEqual(["bias", "intent"]);
  expect(Object.keys(jevQuestions(fixture("flat", 5)))).toEqual(["bias", "intent", "leverage"]);
});

test("evaluate state is the book and live position, not the wallet scoreboard", () => {
  const fat = {
    ...fixture("flat"),
    recentFills: ["sell 0.001 @ 77000 close"],
    horizonTicks: 100,
    position: {
      ...fixture("flat").position,
      realizedUsd: -10.5,
      feesUsd: 3.8,
      pnlUsd: -14.3,
      pnlPct: -7,
      equity: 185,
      withdrawable: 185,
    },
  };
  const seen = marketFacing(fat as TradeState);
  const text = JSON.stringify(seen).toLowerCase();
  expect(seen.book).toEqual(fat.book);
  expect(seen.trades).toEqual(fat.trades);
  expect(seen.position.side).toBe("flat");
  expect("unrealizedUsd" in seen.position).toBe(false);
  for (const phrase of ["recentfills", "realizedusd", "feesusd", "pnlusd", "pnlpct", "equity", "withdrawable", "horizonticks"]) {
    expect(text).not.toContain(phrase);
  }

  const open = marketFacing(fixture("long"));
  expect(open.position.unrealizedUsd).toBe(-1.25);
  expect(JSON.stringify(open).toLowerCase()).not.toContain("pnlusd");
});

test("a short answer keeps its case and still sells", () => {
  for (const choice of ["SHORT", "Short", " short "]) {
    const d = decideFromJevAnswers(
      { bias: { choice }, intent: { choice: "open" }, leverage: { choice: "2" } },
      "flat",
      40,
      1,
    );
    expect(d.bias).toBe("short");
    expect(d.intent).toBe("open");
    expect(d.action).toBe("sell");
  }
});

test("an unrecognised bias stands down instead of opening long", () => {
  const d = decideFromJevAnswers(
    { bias: { choice: "up" }, intent: { choice: "open" }, leverage: { choice: "5" } },
    "flat",
    40,
    1,
  );
  expect(d.intent).toBe("hold");
  expect(d.action).toBe("hold");
  expect(d.probabilities.long).toBe(d.probabilities.short);
  expect(d.probabilities.long).toBeLessThan(1);
});

function validProviderAnswers() {
  return {
    bias: { type: "choice", choice: "long", confidence: 1, probabilities: { long: 1, short: 0 } },
    intent: { type: "choice", choice: "hold", probabilities: { open: 0, hold: 1 } },
    leverage: { type: "choice", choice: "5", probabilities: { "1": 0, "2": 0, "3": 0, "5": 1 } },
  } as const;
}

function validFixedLeverageAnswers() {
  const { leverage: _leverage, ...answers } = validProviderAnswers();
  return answers;
}

test("1x answers validate against the two questions and normalize leverage to 1", () => {
  const answers = validateJevAnswers(validFixedLeverageAnswers(), "flat", 1);
  expect("leverage" in answers).toBe(false);
  expect(decideFromJevAnswers(answers, "flat", 1, 40).leverage).toBe(1);
  expect(() => validateJevAnswers(validProviderAnswers(), "flat", 1)).toThrow();
});

test("provider answers are validated without normalising away zero probabilities", () => {
  const answers = validateJevAnswers(validProviderAnswers(), "flat", 5);
  expect(answers.bias?.probabilities).toEqual({ long: 1, short: 0 });
  expect(answers.intent?.probabilities).toEqual({ open: 0, hold: 1 });
  expect(answers.leverage?.choice).toBe("5");
});

test("malformed provider answers fail at the boundary", () => {
  const malformed = [
    { ...validProviderAnswers(), bias: undefined },
    { ...validProviderAnswers(), bias: { ...validProviderAnswers().bias, probabilities: { long: Number.NaN, short: 0 } } },
    { ...validProviderAnswers(), bias: { ...validProviderAnswers().bias, probabilities: { long: 0.7, short: 0.1 } } },
    { ...validProviderAnswers(), bias: { ...validProviderAnswers().bias, choice: "short" } },
    { ...validProviderAnswers(), leverage: { ...validProviderAnswers().leverage, choice: "4" } },
  ];
  for (const answers of malformed) {
    expect(() => validateJevAnswers(answers, "flat", 5)).toThrow();
  }
});

class GatewayErrorLike extends Error {
  generationId = "gen_gateway12345678";
  secret = "do-not-forward";
}

test("billing metadata accepts provider error instances without forwarding the raw error", () => {
  const error = new GatewayErrorLike("provider failed");
  expect(generationIdFromError(error)).toBe("gen_gateway12345678");
  expect(JSON.stringify(generationIdFromError(error))).not.toContain("do-not-forward");
  expect(generationIdFromError({ generationId: "not-a-generation-id", secret: "do-not-forward" })).toBeUndefined();
});

test("Jev audit snapshots only the market-facing request and safe answer fields", () => {
  const state = fixture("flat");
  const audit = createJevAudit({
    provider: "gateway",
    modelId: "typesafe-ai/jev",
    state: marketFacing(state),
    questions: jevQuestions(state),
    rawAnswers: validateJevAnswers(validProviderAnswers(), "flat", 5),
    usage: { inputTokens: 12, outputTokens: 7 },
  });

  expect(audit.provider).toBe("gateway");
  expect(audit.modelId).toBe("typesafe-ai/jev");
  expect(audit.promptVersion).toBeString();
  expect(audit.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
  expect(audit.rawAnswers.bias?.probabilities?.short).toBe(0);
  expect(JSON.stringify(audit)).not.toContain("headers");
  state.book.bids.push("mutated after request");
  expect(audit.state.book.bids).toEqual([]);
});
