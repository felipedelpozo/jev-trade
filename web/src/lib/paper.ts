import type { BlockEvent, PaperSummary } from "./bot-types";

export interface PaperMetrics extends PaperSummary {
  netPnlUsd: number;
}

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function aggregatePaper(latestByCoin: Record<string, BlockEvent | null | undefined>): PaperMetrics | null {
  const events = Object.values(latestByCoin).filter((event): event is BlockEvent & { paper: PaperSummary } => Boolean(event?.paper));
  if (!events.length) return null;

  return events.reduce<PaperMetrics>(
    (total, event) => {
      const paper = event.paper!;
      return {
        initialUsd: total.initialUsd + finite(paper.initialUsd),
        // accountValue is the existing persistent equity source; paper is the fallback for older events.
        equityUsd: total.equityUsd + finite(event.accountValue ?? paper.equityUsd),
        availableUsd: total.availableUsd + finite(paper.availableUsd),
        feesUsd: total.feesUsd + finite(paper.feesUsd),
        fundingUsd: total.fundingUsd + finite(paper.fundingUsd),
        modelUsd: total.modelUsd + finite(paper.modelUsd),
        drawdownUsd: total.drawdownUsd + finite(paper.drawdownUsd),
        maxPositionUsd: total.maxPositionUsd + finite(paper.maxPositionUsd),
        maxLossUsd: total.maxLossUsd + finite(paper.maxLossUsd),
        halted: total.halted || paper.halted,
        modelCostEstimated: total.modelCostEstimated || paper.modelCostEstimated,
        netPnlUsd: total.netPnlUsd + finite(event.totals.pnlUsd),
      };
    },
    {
      initialUsd: 0,
      equityUsd: 0,
      availableUsd: 0,
      feesUsd: 0,
      fundingUsd: 0,
      modelUsd: 0,
      drawdownUsd: 0,
      maxPositionUsd: 0,
      maxLossUsd: 0,
      halted: false,
      modelCostEstimated: false,
      netPnlUsd: 0,
    },
  );
}
