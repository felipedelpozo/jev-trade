const env = (key: string, fallback?: string) => process.env[key] ?? fallback;

export type JevProvider = "typesafe" | "gateway";

export function resolveJevProvider(e: {
  JEV_PROVIDER?: string;
  TYPESAFE_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
}): JevProvider {
  const explicit = e.JEV_PROVIDER?.trim().toLowerCase();
  if (explicit === "typesafe" || explicit === "gateway") return explicit;
  if (explicit) throw new Error("JEV_PROVIDER must be typesafe or gateway");
  if (e.TYPESAFE_API_KEY?.trim()) return "typesafe";
  if (e.AI_GATEWAY_API_KEY?.trim()) return "gateway";
  return "typesafe";
}

export function resolveJevModelId(e: { JEV_MODEL_ID?: string }, provider: JevProvider): string {
  const set = e.JEV_MODEL_ID?.trim();
  if (set) return set;
  return provider === "gateway" ? "typesafe-ai/jev" : "jev-latest";
}

export function assertJevCredentials(
  model: string,
  provider: JevProvider,
  e: { TYPESAFE_API_KEY?: string; AI_GATEWAY_API_KEY?: string },
): void {
  if (model !== "jev") return;
  if (provider === "typesafe" && !e.TYPESAFE_API_KEY?.trim()) {
    throw new Error("MODEL=jev with JEV_PROVIDER=typesafe needs TYPESAFE_API_KEY. Get a key at https://docs.typesafe.ai/ or set JEV_PROVIDER=gateway with AI_GATEWAY_API_KEY.");
  }
  if (provider === "gateway" && !e.AI_GATEWAY_API_KEY?.trim()) {
    throw new Error("MODEL=jev with JEV_PROVIDER=gateway needs AI_GATEWAY_API_KEY. Or set JEV_PROVIDER=typesafe with TYPESAFE_API_KEY.");
  }
}

const hlTestnet = env("HL_TESTNET", "true") !== "false";
const jevProvider = resolveJevProvider({
  JEV_PROVIDER: process.env.JEV_PROVIDER,
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
});
const jevModelId = resolveJevModelId({ JEV_MODEL_ID: process.env.JEV_MODEL_ID }, jevProvider);

function numeric(key: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(env(key, String(fallback)));
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}

export const config = {
  hlTestnet,
  tickMs: Number(env("TICK_MS", "2000")),
  /** Book/price prints for the chart. Independent of Jev ticks. */
  priceMs: Math.max(50, Number(env("PRICE_MS", "200"))),
  explorerTx: hlTestnet
    ? "https://app.hyperliquid-testnet.xyz/explorer/tx/"
    : "https://app.hyperliquid.xyz/explorer/tx/",
  privateKey: env("PRIVATE_KEY"),
  dryRun: env("DRY_RUN") === "true",
  /** Target notional of one post-only quote. */
  quoteUsd: Number(env("QUOTE_USD", "40")),
  quoteInsideTicks: Number(env("QUOTE_INSIDE_TICKS", "1")),
  /** How far an Ioc exit crosses the touch so it fills on the spot. */
  closeSlippageBps: numeric("CLOSE_SLIPPAGE_BPS", 5, 0, 1000),
  horizonBlocks: Number(env("HORIZON_BLOCKS", "100")),
  model: env("MODEL", "mock") as "mock" | "jev",
  /** typesafe = official TypeSafe API. gateway = Vercel AI Gateway. */
  jevProvider,
  jevModelId,
  port: Number(env("PORT", "3000")),
  historySize: 1000,
  bankrollUsd: numeric("BANKROLL_USD", 200, 0.01),
  paperDir: env("PAPER_DATA_DIR", "data/paper")!,
  paperMaxPositionUsd: numeric("PAPER_MAX_POSITION_USD", 100, 0.01),
  paperMaxLossUsd: numeric("PAPER_MAX_LOSS_USD", 20, 0.01),
  paperMaxLeverage: numeric("PAPER_MAX_LEVERAGE", 1, 1, 1),
  paperMakerFeeBps: numeric("PAPER_MAKER_FEE_BPS", 1.5, 0, 1000),
  paperTakerFeeBps: numeric("PAPER_TAKER_FEE_BPS", 4.5, 0, 1000),
  paperSlippageBps: numeric("PAPER_SLIPPAGE_BPS", 2, 0, 1000),
  paperFillParticipation: numeric("PAPER_FILL_PARTICIPATION", 0.1, 0.001, 1),
  modelInputUsdPerMTok: numeric("MODEL_INPUT_USD_PER_MTOK", 0.042, 0),
  modelOutputUsdPerMTok: numeric("MODEL_OUTPUT_USD_PER_MTOK", 0.042, 0),
  maxBookAgeMs: numeric("MAX_BOOK_AGE_MS", 10000, 100),
  maxDecisionAgeMs: numeric("MAX_DECISION_AGE_MS", 4000, 100),
};

if (config.paperSlippageBps > config.closeSlippageBps) {
  throw new Error("PAPER_SLIPPAGE_BPS must not exceed CLOSE_SLIPPAGE_BPS");
}

export function hexKey(key: string): `0x${string}` {
  return (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
}
