import { describe, expect, test } from "bun:test";
import { parseOptimizationInput, summarizeOptimization } from "../src/optimization";
import type { BlockEvent, Meta } from "../src/types";

const meta: Meta = { model: "mock", wallet: null, dryRun: true, market: "BTC", startedAt: 0, venue: "paper", coin: "BTC", pair: "BTC/USDC", explorerTx: "", tickMs: 1000, sleeves: [] };
const event = (ts: number, overrides: Partial<BlockEvent> = {}): BlockEvent => ({ coin: "BTC", block: ts, ts, mid: 100 + ts / 1000, bestBid: 99, bestAsk: 101, spreadBps: 200, decision: { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0, latencyMs: 1, late: false }, quote: null, fill: null, resting: { bidSz: 0, askSz: 0 }, position: { side: "flat", size: 0, entryPrice: null, leverage: null, unrealizedUsd: 0, unrealizedSz: 0 }, totals: { blocks: 1, decisions: 1, quotes: 0, fills: 0, reverted: 0, lateBlocks: 0, jevUsd: 0, gasSz: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: 10, pnlSz: 0, pnlPct: 0 }, paper: { initialUsd: 100, equityUsd: 110, availableUsd: 110, feesUsd: 2, fundingUsd: 1, modelUsd: 4, drawdownUsd: 0, maxPositionUsd: 10, maxLossUsd: 20, halted: false, modelCostEstimated: false }, ...overrides });

describe("optimization report", () => {
  test("does not double count reported model cost", () => {
    const report = summarizeOptimization({ meta, history: [event(0, { paper: { ...event(0).paper!, realizedUsd: 10, unrealizedUsd: 0 } })], usage: { since: 0, allTime: { requests: 1, pending: 0, successful: 1, failed: 0, unknownStatus: 0, inputTokens: 1, outputTokens: 1, reportedUsd: 4, estimatedUsd: 0, totalUsd: 4, reportedRequests: 1, estimatedRequests: 0, unknownTokenRequests: 0 }, today: {} as never }, now: 1 });
    expect(report.account.netBeforeAiUsd).toBe(7);
    expect(report.account.netAfterAiUsd).toBe(3);
  });
  test("marks missing usage, empty history, and non-paper config as warnings", () => {
    const report = summarizeOptimization({ meta: { ...meta, dryRun: false }, history: [], usage: null });
    expect(report.paper.valid).toBe(false);
    expect(report.warnings.join(" ")).toContain("empty");
    expect(report.warnings.join(" ")).toContain("usage");
  });
  test("keeps mark-only baseline separate from costs", () => {
    const report = summarizeOptimization({ meta, history: [event(0), event(86_400_000, { mid: 110 })], usage: null });
    expect(report.baseline.noTradeUsd).toBe(0);
    expect(report.baseline.excludesCosts).toBe(true);
    expect(report.baseline.applesToApples).toBe(false);
  });
  test("uses close intents, rejects multi-sleeve aggregation, and validates raw payloads", () => {
    const closing = event(0, { decision: { action: "sell", intent: "close", probabilities: { buy: 0, sell: 1, hold: 0 }, upIn10: 0, latencyMs: 1, late: false } });
    const report = summarizeOptimization({ meta, history: { BTC: [closing], ETH: [closing] }, usage: {} });
    expect(report.activity.closes).toBe(0);
    expect(report.warnings.join(" ")).toContain("multi-sleeve");
    expect(() => parseOptimizationInput(meta, { BTC: [event(0)] }, {})).not.toThrow();
    expect(() => parseOptimizationInput({ ...meta, dryRun: "false" }, {}, {})).toThrow();
  });
  test("rejected close intents are not completed positions and malformed bills fail closed", () => {
    const rows = Array.from({ length: 31 }, (_, index) => event(index * 86_400_000, {
      decision: { action: "sell", intent: "close", probabilities: { buy: 0, sell: 1, hold: 0 }, upIn10: 0, latencyMs: 1, late: false },
      position: { side: "long", size: 1, entryPrice: 100, leverage: 1, unrealizedUsd: 0, unrealizedSz: 0 },
    }));
    const report = summarizeOptimization({ meta, history: rows, usage: null });
    expect(report.activity.closes).toBe(31);
    expect(report.sample.observedClosedPositions).toBe(0);
    expect(report.profitabilityEvidence.eligible).toBe(false);
    expect(() => parseOptimizationInput(meta, { BTC: [event(0)] }, { BTC: { allTime: { totalUsd: "cheap" } } })).toThrow();
    const missing = summarizeOptimization({ meta, history: [], usage: null });
    expect(missing.account.netAfterAiUsd).toBeNull();
    expect(missing.costs.actualModelUsd).toBeNull();
  });
});
