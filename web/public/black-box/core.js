export const STATES = Object.freeze(['observe', 'evaluate', 'wait']);
export const STATE_LABELS = Object.freeze({ observe: 'Observar', evaluate: 'Evaluar', wait: 'Esperar' });
export const EVALUATION_MS = 12000;

export function clipFor(from, to = from) {
  if (!STATES.includes(from) || !STATES.includes(to)) throw new TypeError('Unknown visual state');
  return `/black-box/assets/${from === to ? `${from}-loop` : `${from}-to-${to}`}.mp4`;
}

export function readSnapshot(meta) {
  const row = meta?.latestByCoin?.BTC;
  const paper = row?.paper;
  if (meta?.dryRun !== true || meta.wallet !== null || meta.sleeves?.some(s => s.wallet !== null || s.dryRun === false)) {
    throw new Error('Esta vista requiere una cuenta simulada sin cartera');
  }
  if (!row || !Number.isFinite(row.ts) || !Number.isFinite(row.mid) || row.mid <= 0
      || !Number.isFinite(meta.tickMs) || meta.tickMs <= 0 || !Number.isFinite(meta.startedAt)
      || !Number.isFinite(paper?.netPnlUsd) || !Number.isFinite(paper.modelUsd)
      || !Number.isFinite(paper.equityUsd) || !Number.isFinite(paper.usage?.allTime?.requests)) {
    throw new Error('La lectura del bot está incompleta');
  }
  const decision = row.decision && !row.decision.late
    && ['open', 'hold', 'close'].includes(row.decision.intent) ? row.decision : null;
  return { ...row, decision, tickMs: meta.tickMs, startedAt: meta.startedAt,
    revision: meta.revision, requests: paper.usage.allTime.requests, accountSince: paper.usage.since };
}

export function isNewDecision(previous, next) {
  return Boolean(previous && next.decision && next.startedAt === previous.startedAt
    && next.accountSince === previous.accountSince && next.requests > previous.requests
    && next.block > previous.block);
}

export function visualState(row, now, evaluationUntil = 0, connected = true) {
  if (!row || !connected || now - row.ts > Math.max(90000, row.tickMs * 3)
      || row.riskReason || row.paper.halted || !row.decision) return 'wait';
  if (now < evaluationUntil) return 'evaluate';
  return row.decision.intent === 'hold' ? 'wait' : 'observe';
}

export function health(row, now, connected) {
  if (!connected) return { kind: 'offline', label: 'Reconectando', detail: 'Últimos valores recibidos. No son nuevas decisiones.' };
  if (!row) return { kind: 'loading', label: 'Conectando', detail: 'Esperando la primera lectura del bot.' };
  if (now - row.ts > Math.max(90000, row.tickMs * 3)) return { kind: 'stale', label: 'Lectura antigua', detail: 'El bot no ha publicado una lectura reciente.' };
  if (row.paper.halted) return { kind: 'paused', label: 'Parada de riesgo', detail: 'La cuenta simulada está detenida por su límite de riesgo.' };
  if (row.riskReason === 'Daily AI budget reached') return { kind: 'paused', label: 'IA en pausa', detail: 'Presupuesto diario alcanzado. Se mantiene la observación del mercado.' };
  if (row.riskReason) return { kind: 'paused', label: 'Bot en pausa', detail: 'No hay una nueva decisión válida para ejecutar.' };
  if (!row.decision) return { kind: 'paused', label: 'Sin decisión válida', detail: 'La última lectura no contiene una respuesta válida de Jev.' };
  return { kind: 'live', label: 'Datos en directo', detail: 'Mercado real. Operaciones simuladas.' };
}

export function decisionText(row) {
  if (!row?.decision) return 'Sin nueva decisión';
  const { intent, bias } = row.decision;
  if (intent === 'hold') return 'HOLD / Mantener';
  if (intent === 'close') return 'Cerrar posición';
  return bias === 'long' ? 'Abrir largo' : bias === 'short' ? 'Abrir corto' : 'Abrir posición';
}

export function intentProbability(row) {
  const value = row?.decision?.probabilities?.[row.decision.intent];
  return Number.isFinite(value) && value >= 0 && value <= 1 ? `${Math.round(value * 100)}%` : '—';
}

export function signedMoney(value, digits = 4) {
  if (!Number.isFinite(value)) return '—';
  return `${value < 0 ? '−' : value > 0 ? '+' : ''}$${Math.abs(value).toFixed(digits)}`;
}

export function remaining(row, now, connected) {
  if (!row || health(row, now, connected).kind !== 'live') return null;
  return Math.max(0, row.tickMs - Math.max(0, now - row.ts));
}

export function chartPath(points, width = 740, height = 110) {
  const valid = points.filter(p => Number.isFinite(p.ts) && Number.isFinite(p.mid) && p.mid > 0);
  if (valid.length < 2) return '';
  const low = Math.min(...valid.map(p => p.mid)), high = Math.max(...valid.map(p => p.mid));
  const start = valid[0].ts, span = valid.at(-1).ts - start;
  if (span <= 0) return '';
  return valid.map((p, i) => `${i ? 'L' : 'M'}${((p.ts - start) / span * width).toFixed(1)},${(height - 8 - (p.mid - low) / (high - low || 1) * (height - 16)).toFixed(1)}`).join(' ');
}
