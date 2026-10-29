import { describe, expect, test } from "bun:test";
import type { BlockEvent, UsageBalance, UsagePeriod } from "../web/src/lib/bot-types";
import { aggregatePaper } from "../web/src/lib/paper";

const period = (overrides: Partial<UsagePeriod> = {}): UsagePeriod => ({
  requests: 0, pending: 0, successful: 0, failed: 0, unknownStatus: 0,
  inputTokens: 0, outputTokens: 0, reportedUsd: 0, estimatedUsd: 0, totalUsd: 0,
  reportedRequests: 0, estimatedRequests: 0, unknownTokenRequests: 0, ...overrides,
});

const event = (usage: UsageBalance, pnlUsd: number, realizedUsd: number, unrealizedUsd: number, feesUsd: number, fundingUsd: number) => ({
  totals: { pnlUsd, realizedUsd },
  position: { side: unrealizedUsd ? "long" : "flat", unrealizedUsd },
  paper: {
    initialUsd: 100, equityUsd: 100, availableUsd: 100, feesUsd, fundingUsd, modelUsd: usage.allTime.totalUsd,
    drawdownUsd: 0, maxPositionUsd: 0, maxLossUsd: 0, halted: false, modelCostEstimated: usage.allTime.estimatedUsd > 0, usage,
  },
}) as unknown as BlockEvent;

describe("paper usage and PnL display aggregation", () => {
  test("uses precise account values so a flat account has the same realized and total net", () => {
    const cost = 0.0000008;
    const row = event({ since: 1, allTime: period({ totalUsd: cost }), today: period() }, 0.4, 1, 0, 0.5, 0.1);
    row.paper = { ...row.paper!, realizedUsd: 1.00000049, unrealizedUsd: 0, netPnlUsd: 1.00000049 - 0.5 - 0.1 - cost };
    const result = aggregatePaper({ BTC: row });
    expect(result?.grossRealizedUsd).toBe(1.00000049);
    expect(result?.netRealizedAfterCostsUsd.toFixed(6)).toBe(result?.netIncludingOpenUsd.toFixed(6));
  });
  test("sums usage and costs across sleeves and preserves existing net PnL", () => {
    const a = event({ since: 200, allTime: period({ requests: 2, inputTokens: 10, outputTokens: 4, reportedUsd: 0.000001, totalUsd: 0.000001, reportedRequests: 2 }), today: period({ requests: 1, totalUsd: 0.000001 }) }, 3, 5, 1, 0.5, 0.25);
    const b = event({ since: 100, allTime: period({ requests: 3, inputTokens: 20, outputTokens: 8, estimatedUsd: 0.000002, totalUsd: 0.000002, estimatedRequests: 3, unknownTokenRequests: 1 }), today: period({ requests: 2, estimatedUsd: 0.000002, totalUsd: 0.000002 }) }, -1, -2, -3, 0.25, 0.5);

    const result = aggregatePaper({ BTC: a, ETH: b });
    expect(result?.usage).toMatchObject({ since: 100, allTime: { requests: 5, inputTokens: 30, outputTokens: 12, totalUsd: 0.000003, unknownTokenRequests: 1 } });
    expect(result?.grossRealizedUsd).toBe(3);
    expect(result?.unrealizedUsd).toBe(-2);
    expect(result?.netRealizedAfterCostsUsd).toBeCloseTo(3 - 0.75 - 0.75 - 0.000003, 10);
    expect(result?.netIncludingOpenUsd).toBe(2);
  });
});
