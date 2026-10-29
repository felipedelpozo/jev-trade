import type { BlockEvent, PaperSummary, UsagePeriod } from "./bot-types";

export interface PaperMetrics extends PaperSummary {
  netPnlUsd: number;
  grossRealizedUsd: number;
  unrealizedUsd: number;
  netRealizedAfterCostsUsd: number;
  netIncludingOpenUsd: number;
}

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const EMPTY_PERIOD: UsagePeriod = {
  requests: 0,
  pending: 0,
  successful: 0,
  failed: 0,
  unknownStatus: 0,
  inputTokens: 0,
  outputTokens: 0,
  reportedUsd: 0,
  estimatedUsd: 0,
  totalUsd: 0,
  reportedRequests: 0,
  estimatedRequests: 0,
  unknownTokenRequests: 0,
};

function addUsage(a: UsagePeriod, b: UsagePeriod): UsagePeriod {
  return {
    requests: a.requests + b.requests,
    pending: a.pending + b.pending,
    successful: a.successful + b.successful,
    failed: a.failed + b.failed,
    unknownStatus: a.unknownStatus + b.unknownStatus,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reportedUsd: a.reportedUsd + b.reportedUsd,
    estimatedUsd: a.estimatedUsd + b.estimatedUsd,
    totalUsd: a.totalUsd + b.totalUsd,
    reportedRequests: a.reportedRequests + b.reportedRequests,
    estimatedRequests: a.estimatedRequests + b.estimatedRequests,
    unknownTokenRequests: a.unknownTokenRequests + b.unknownTokenRequests,
  };
}

export function aggregatePaper(latestByCoin: Record<string, BlockEvent | null | undefined>): PaperMetrics | null {
  const events = Object.values(latestByCoin).filter((event): event is BlockEvent & { paper: PaperSummary } => Boolean(event?.paper));
  if (!events.length) return null;

  const result = events.reduce<PaperMetrics>(
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
        grossRealizedUsd: total.grossRealizedUsd + finite(event.totals.realizedUsd),
        unrealizedUsd: total.unrealizedUsd + (event.position?.side !== "flat" ? finite(event.position?.unrealizedUsd) : 0),
        netRealizedAfterCostsUsd: 0,
        netIncludingOpenUsd: 0,
        usage: paper.usage
          ? {
              since: total.usage?.since === null || total.usage?.since === undefined
                ? paper.usage.since
                : paper.usage.since === null ? total.usage.since : Math.min(total.usage.since, paper.usage.since),
              allTime: addUsage(total.usage?.allTime ?? EMPTY_PERIOD, paper.usage.allTime),
              today: addUsage(total.usage?.today ?? EMPTY_PERIOD, paper.usage.today),
            }
          : total.usage,
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
      grossRealizedUsd: 0,
      unrealizedUsd: 0,
      netRealizedAfterCostsUsd: 0,
      netIncludingOpenUsd: 0,
    },
  );

  const usageCost = result.usage?.allTime.totalUsd ?? result.modelUsd;
  result.netRealizedAfterCostsUsd = result.grossRealizedUsd - result.feesUsd - result.fundingUsd - usageCost;
  result.netIncludingOpenUsd = result.netPnlUsd;
  return result;
}
