export function normalizeMeta(meta) {
  const row = meta?.latestByCoin?.BTC;
  const usage = row?.paper?.usage?.allTime;
  if (typeof meta?.dryRun !== 'boolean' || !row || !Number.isFinite(row.ts)
      || !Number.isFinite(row.paper?.netPnlUsd) || !Number.isFinite(row.paper?.modelUsd)
      || !Number.isFinite(usage?.requests) || usage.requests < 0 || !Number.isFinite(meta.tickMs) || meta.tickMs <= 0) {
    throw new Error('La lectura del bot no contiene los datos necesarios');
  }
  const validDecision = row.decision && !row.decision.late
    && ['hold', 'open', 'close'].includes(row.decision.intent)
    && ['long', 'short'].includes(row.decision.bias);
  return { ...row, dryRun: meta.dryRun, tickMs: meta.tickMs, requests: usage.requests,
    startedAt: meta.startedAt, validDecision: Boolean(validDecision) };
}

export function classifyUpdate(previous, next) {
  if (!previous) return 'initial';
  if (next.requests < previous.requests) return 'reset';
  if (next.requests > previous.requests) return 'request';
  return 'update';
}

export function money(value, digits = 4) {
  if (!Number.isFinite(value)) return '—';
  return `${value < 0 ? '−' : '+'}$${Math.abs(value).toFixed(digits)}`;
}
