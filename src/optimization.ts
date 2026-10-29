import type { BlockEvent, Meta, UsageBalance } from "./types";

export interface OptimizationInput {
  meta: Meta;
  history: Record<string, BlockEvent[]> | BlockEvent[];
  usage?: Record<string, UsageBalance | null> | UsageBalance | null;
  now?: number;
}

export function parseOptimizationInput(metaRaw: unknown, historyRaw: unknown, usageRaw: unknown): OptimizationInput {
  if (!metaRaw || typeof metaRaw !== "object" || Array.isArray(metaRaw)) throw new Error("/api: expected metadata object");
  const meta = metaRaw as Partial<Meta>;
  if (typeof meta.dryRun !== "boolean" || finite(meta.startedAt) === null || !(finite(meta.tickMs)! > 0) || !Array.isArray(meta.sleeves)
    || (meta.wallet !== null && typeof meta.wallet !== "string")) throw new Error("/api: invalid metadata");
  if (!historyRaw || typeof historyRaw !== "object" || Array.isArray(historyRaw)) throw new Error("/api/history: expected history object");
  for (const [coin, rows] of Object.entries(historyRaw)) {
    if (!Array.isArray(rows)) throw new Error(`/api/history: invalid ${coin} history`);
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") throw new Error("invalid history event");
      const row = raw as Partial<BlockEvent>;
      if (row.coin !== coin || finite(row.ts) === null || !row.position || !["flat", "long", "short"].includes(row.position.side)
        || finite(row.position.size) === null || !row.totals || finite(row.totals.fills) === null) throw new Error("invalid history event");
      for (const value of [row.position.unrealizedUsd, row.totals.realizedUsd, row.paper?.initialUsd, row.paper?.equityUsd,
        row.paper?.realizedUsd, row.paper?.unrealizedUsd, row.paper?.feesUsd, row.paper?.fundingUsd, row.paper?.modelUsd]) {
        if (value != null && finite(value) === null) throw new Error("invalid financial value in history");
      }
    }
  }
  if (!usageRaw || typeof usageRaw !== "object" || Array.isArray(usageRaw)) throw new Error("/api/usage: expected usage object");
  for (const value of Object.values(usageRaw)) {
    if (value === null) continue;
    if (!value || typeof value !== "object") throw new Error("invalid usage balance");
    const balance = value as Partial<UsageBalance>;
    for (const period of [balance.allTime, balance.today]) {
      if (!period || typeof period !== "object") throw new Error("invalid usage period");
      for (const key of ["reportedUsd", "estimatedUsd", "totalUsd", "reportedRequests", "requests", "unknownStatus", "unknownTokenRequests"] as const) {
        if (finite(period[key]) === null || period[key] < 0) throw new Error("invalid usage value");
      }
      if (Math.abs(period.reportedUsd + period.estimatedUsd - period.totalUsd) > 1e-8) throw new Error("inconsistent usage costs");
    }
  }
  return { meta: meta as Meta, history: historyRaw as Record<string, BlockEvent[]>, usage: usageRaw as Record<string, UsageBalance | null> };
}

export interface OptimizationReport {
  revision: string | null;
  startedAt: number | null;
  paper: { dryRun: boolean; valid: boolean; warnings: string[] };
  account: { initialUsd: number | null; equityUsd: number | null; netBeforeAiUsd: number | null; netAfterAiUsd: number | null };
  costs: { feesUsd: number | null; fundingUsd: number | null; actualModelUsd: number | null; estimatedModelUsd: number | null; averageConfirmedCostUsd: number | null; projected1440RequestsDayUsd: number | null };
  sample: { latestAgeMs: number | null; firstAt: number | null; lastAt: number | null; coverageMs: number | null; events: number; fills: number; observedClosedPositions: number; truncated: boolean };
  activity: { holds: number; opens: number; closes: number; errors: number; riskBlocks: number };
  baseline: { noTradeUsd: 0; excludesCosts: true; applesToApples: false; note: string };
  profitabilityEvidence: { eligible: boolean; heuristic: true; reason: string };
  flags: string[];
  warnings: string[];
}

const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

function eventsOf(history: OptimizationInput["history"]): { events: BlockEvent[]; unsupported: boolean } {
  const sleeves = Array.isArray(history) ? [] : Object.keys(history);
  if (sleeves.length > 1) return { events: [], unsupported: true };
  const rows = Array.isArray(history) ? history : Object.values(history).flat();
  return { events: rows.filter((event): event is BlockEvent => Boolean(event && typeof event === "object" && finite(event.ts) !== null)).sort((a, b) => a.ts - b.ts), unsupported: false };
}

function usageOf(usage: OptimizationInput["usage"]): UsageBalance | null {
  if (!usage) return null;
  if ("allTime" in usage) return usage as UsageBalance;
  const balances = Object.values(usage).filter((value): value is UsageBalance => Boolean(value && typeof value === "object" && "allTime" in value));
  if (!balances.length) return null;
  return balances.length === 1 ? balances[0]! : null;
}

export function summarizeOptimization(input: OptimizationInput): OptimizationReport {
  const eventResult = eventsOf(input.history);
  const events = eventResult.events;
  const first = events[0];
  const last = events.at(-1);
  const usage = usageOf(input.usage);
  const allTime = usage?.allTime;
  const paper = last?.paper;
  const warnings: string[] = [];
  const paperWarnings: string[] = [];
  if (input.meta.dryRun !== true) paperWarnings.push("non-paper configuration: meta.dryRun is not true");
  if (input.meta.wallet !== null || input.meta.sleeves.some((s) => s.wallet !== null)) paperWarnings.push("unexpected trading wallet");
  if (eventResult.unsupported) warnings.push("multi-sleeve history is unsupported; no cross-sleeve money was aggregated");
  if (!events.length) warnings.push("history is missing or empty; no zeros were inferred");
  if (events.length >= 1000) warnings.push("history may be truncated at the server limit");
  if (allTime?.unknownStatus || allTime?.unknownTokenRequests) warnings.push("usage contains unknown legacy bills or token counts");
  if (!usage) warnings.push("usage is missing; model cost may be unknown");

  const fees = finite(paper?.feesUsd);
  const funding = finite(paper?.fundingUsd);
  const actual = finite(allTime?.reportedUsd);
  const estimated = finite(allTime?.estimatedUsd) ?? finite(paper?.modelUsd);
  const modelCost = allTime ? finite(allTime.totalUsd) : finite(paper?.modelUsd);
  // Paper pnl already includes fees, funding, and model cost; use realized + mark pnl to avoid charging them twice.
  const realized = finite(paper?.realizedUsd ?? last?.totals.realizedUsd);
  const unrealized = finite(paper?.unrealizedUsd ?? last?.position.unrealizedUsd);
  const gross = realized != null && unrealized != null ? realized + unrealized : null;
  if (gross == null) warnings.push("gross PnL unavailable: legacy net PnL was not reused to avoid double-counting costs");
  if (fees == null || funding == null) warnings.push("fees/funding unavailable in latest sample");
  const before = gross == null || fees == null || funding == null ? null : gross - fees - funding;
  const after = before == null || modelCost == null ? null : before - modelCost;
  const confirmedRequests = finite(allTime?.reportedRequests) ?? 0;
  const average = confirmedRequests > 0 && actual != null ? actual / confirmedRequests : null;
  const projected = average == null ? null : average * 1440;
  const initial = finite(paper?.initialUsd);
  const latestAgeMs = last ? Math.max(0, (input.now ?? Date.now()) - last.ts) : null;
  const coverageMs = first && last ? Math.max(0, last.ts - first.ts) : null;
  const flags: string[] = [];
  if (after != null && after < 0) flags.push("recorded costs exceed gross PnL");
  if (events.length && events.filter((e) => e.decision?.action === "hold").length / events.length > 0.8) flags.push("high hold rate");
  const closes = events.filter((e) => e.decision?.intent === "close").length;
  const observedClosedPositions = events.slice(1).filter((event, index) => {
    const previous = events[index]!;
    return previous.position.side !== "flat" && previous.position.side !== event.position.side;
  }).length;
  const contiguous = events.slice(1).every((event, index) => event.ts - events[index]!.ts <= input.meta.tickMs * 2);
  const eligible = paperWarnings.length === 0 && !eventResult.unsupported && coverageMs != null
    && coverageMs >= 7 * 86_400_000 && observedClosedPositions >= 30 && contiguous && events.length < 1000;
  if (!eligible) flags.push("insufficient evidence");
  const report: OptimizationReport = {
    revision: typeof input.meta.revision === "string" ? input.meta.revision : null,
    startedAt: finite(input.meta.startedAt),
    paper: { dryRun: input.meta.dryRun === true, valid: paperWarnings.length === 0 && !eventResult.unsupported, warnings: paperWarnings },
    account: { initialUsd: initial, equityUsd: initial != null && after != null ? initial + after : null, netBeforeAiUsd: before, netAfterAiUsd: after },
    costs: { feesUsd: fees, fundingUsd: funding, actualModelUsd: actual, estimatedModelUsd: estimated, averageConfirmedCostUsd: average, projected1440RequestsDayUsd: projected },
    sample: { latestAgeMs, firstAt: first?.ts ?? null, lastAt: last?.ts ?? null, coverageMs, events: events.length, fills: last?.totals.fills ?? events.filter((e) => e.fill != null).length, observedClosedPositions, truncated: events.length >= 1000 },
    activity: { holds: events.filter((e) => e.decision?.action === "hold").length, opens: events.filter((e) => e.decision?.intent === "open").length, closes, errors: events.filter((e) => e.quote?.status === "reverted" || e.riskReason).length, riskBlocks: events.filter((e) => Boolean(e.riskReason)).length },
    baseline: { noTradeUsd: 0, excludesCosts: true, applesToApples: false, note: "zero-return no-trade baseline; no buy-and-hold comparison is claimed" },
    profitabilityEvidence: { eligible, heuristic: true, reason: "requires 7 days, 30 observed position closures and contiguous untruncated coverage; supplement bounded HTTP history with archived observations; this is not statistical significance" },
    flags,
    warnings: [...warnings, ...paperWarnings],
  };
  return report;
}
