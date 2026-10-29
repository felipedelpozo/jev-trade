import { describe, expect, test } from "bun:test";
import type { BlockEvent } from "../web/src/lib/bot-types";
import { aggregatePaper } from "../web/src/lib/paper";

describe("paper display aggregation", () => {
  test("uses persistent account equity and sums net paper PnL", () => {
    const event = {
      accountValue: 101,
      totals: { pnlUsd: -2 },
      paper: {
        initialUsd: 100,
        equityUsd: 99,
        availableUsd: 80,
        feesUsd: 1,
        fundingUsd: 0.5,
        modelUsd: 0.2,
        drawdownUsd: 1,
        maxPositionUsd: 10,
        maxLossUsd: 5,
        halted: true,
        modelCostEstimated: true,
      },
    } as unknown as BlockEvent;

    expect(aggregatePaper({ BTC: event })).toMatchObject({ equityUsd: 101, netPnlUsd: -2, halted: true });
  });
});
