import { readSnapshot, visualState, health, isNewDecision, decisionText, intentProbability, signedMoney, remaining, chartPath, STATE_LABELS, EVALUATION_MS } from './core.js';
import { StatePlayer } from './player.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let row = null, connected = false, evaluationUntil = 0, preview = null;
let price = null, points = [], lastChartSecond = 0, controller, timer, source;
let mediaError = '', motionAllowed = !reducedMotion.matches, renderedState = 'observe';
let stopped = false, generation = 0, lastPriceAt = 0;
const priceFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const clock = new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const player = new StatePlayer([$('video-a'), $('video-b')], {
  onState(state) {
    renderedState = state;
    $('stage').dataset.visualState = state;
    $('poster').src = `/black-box/assets/${state}.jpg`;
    for (const step of document.querySelectorAll('[data-state]')) step.classList.toggle('active', step.dataset.state === state);
  },
  onError(message) { mediaError = message; $('resume').hidden = false; render(); },
});

function fit() {
  const broadcast = document.body.classList.contains('broadcast');
  const narrow = innerWidth <= 760;
  const availableWidth = broadcast ? innerWidth : narrow ? innerWidth - 32 : innerWidth - 450;
  const availableHeight = broadcast ? innerHeight : innerHeight - 48;
  const scale = Math.min(availableWidth / 1080, availableHeight / 1920, broadcast ? Infinity : .65);
  document.documentElement.style.setProperty('--scale', Math.max(.12, scale));
}

function setBroadcast(enabled) {
  preview = null;
  $('preview-status').textContent = 'Estado automático';
  document.body.classList.toggle('broadcast', enabled);
  document.body.classList.remove('show-guides');
  $('guides').checked = false;
  const url = new URL(location.href);
  if (enabled) url.searchParams.set('broadcast', '1'); else url.searchParams.delete('broadcast');
  history.replaceState(null, '', url);
  fit(); render();
}

function addPoint(point) {
  if (!Number.isFinite(point?.ts) || !Number.isFinite(point.mid) || point.mid <= 0
      || point.ts > Date.now() + 30000) return;
  const second = Math.floor(point.ts / 1000);
  if (second < lastChartSecond) return;
  if (second === lastChartSecond && points.length) points[points.length - 1] = point;
  else { points.push(point); lastChartSecond = second; }
  points = points.filter(p => p.ts >= point.ts - 15 * 60 * 1000).slice(-1000);
  $('chart-line').setAttribute('d', chartPath(points, 740, 100));
}

function ingest(meta) {
  const next = readSnapshot(meta);
  // A reconnect paints the current account; it never replays unseen evaluations.
  if (connected && isNewDecision(row, next)) evaluationUntil = Date.now() + EVALUATION_MS;
  if (row && (row.startedAt !== next.startedAt || row.accountSince !== next.accountSince || next.requests < row.requests)) {
    evaluationUntil = 0;
  }
  row = next; connected = true;
  if (!price || next.ts >= price.ts) { price = { ts: next.ts, mid: next.mid }; lastPriceAt = Date.now(); }
  addPoint({ ts: next.ts, mid: next.mid });
  render();
}

function render() {
  const now = Date.now(), status = health(row, now, connected);
  const desired = preview ?? visualState(row, now, evaluationUntil, connected);
  if (desired !== player.desired) player.request(desired);
  const probability = row?.decision && status.kind === 'live' ? intentProbability(row) : '—';
  $('signal').dataset.kind = status.kind;
  $('signal').textContent = status.label;
  $('control-connection').textContent = status.label;
  $('state-title').textContent = STATE_LABELS[desired];
  $('decision-kicker').textContent = preview ? 'PRUEBA DE ANIMACIÓN / DATOS EN DIRECTO'
    : desired === 'evaluate' ? 'VISUALIZANDO LA DECISIÓN RECIBIDA' : 'ÚLTIMA RESPUESTA DE JEV';
  $('decision-answer').textContent = status.kind === 'live' ? decisionText(row) : status.label;
  $('probability').textContent = probability;
  $('probability').hidden = probability === '—';
  $('decision-detail').textContent = status.kind !== 'live' ? status.detail
    : desired === 'evaluate' ? 'La respuesta ya ha llegado. Así se representa.'
    : row?.decision?.intent === 'hold' ? 'Mantener no implica abrir ni cerrar una operación.'
    : 'Una intención de Jev no garantiza una ejecución.';
  const rest = remaining(row, now, connected);
  $('countdown').textContent = rest === null ? '—' : `${String(Math.ceil(rest / 1000)).padStart(2, '0')}s`;
  $('next-label').textContent = rest === null ? 'Cadencia en pausa' : rest === 0 ? 'Esperando lectura' : 'Próxima lectura prevista';
  $('cycle-fill').style.transform = `scaleX(${rest === null ? 0 : Math.min(1, rest / row.tickMs)})`;
  $('account-disclosure').textContent = row ? 'Mercado real. Operaciones simuladas.' : 'Verificando cuenta simulada';
  if (row) {
    const paper = row.paper;
    const usage = paper.usage.allTime;
    $('revision').textContent = `Revisión ${row.revision?.slice(0, 7) ?? 'desconocida'} / solo lectura`;
    $('net-pnl').textContent = signedMoney(paper.netPnlUsd);
    $('net-pnl').classList.toggle('negative', paper.netPnlUsd < 0);
    $('ai-cost').textContent = `$${paper.modelUsd.toFixed(4)}`;
    $('cost-coverage').textContent = usage.estimatedRequests > 0 ? `${usage.estimatedRequests} costes estimados` : 'Costes de IA confirmados';
    const position = row.position;
    $('position').textContent = position?.side === 'flat' ? 'Sin posición abierta'
      : position && Number.isFinite(position.size) ? `${position.side === 'long' ? 'Largo' : 'Corto'} / ${position.size.toFixed(5)} BTC` : 'Posición no disponible';
    $('request-count').textContent = `${row.requests.toLocaleString('es-ES')} consultas`;
    $('last-time').textContent = `${clock.format(row.ts)} UTC`;
  }
  if (price) {
    $('btc-price').textContent = priceFormat.format(price.mid);
    const fresh = connected && now - price.ts <= 15000 && now - lastPriceAt <= 15000;
    $('price-age').textContent = fresh ? 'Hyperliquid / en directo' : `Último precio ${clock.format(price.ts)} UTC`;
  }
  $('notice').hidden = !mediaError && !['offline', 'stale'].includes(status.kind);
  $('notice').textContent = mediaError || 'Se conservan los últimos datos recibidos.';
  $('stage').dataset.visualState = renderedState;
  $('stage').dataset.targetState = desired;
  $('stage').dataset.connection = status.kind;
}

async function poll() {
  if (stopped) return;
  const pollGeneration = generation;
  controller = new AbortController();
  try {
    const response = await fetch('/api', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
    if (!response.ok) throw new Error('Bot unavailable');
    const meta = await response.json();
    if (pollGeneration !== generation) return;
    ingest(meta);
  } catch {
    if (pollGeneration !== generation) return;
    connected = false; evaluationUntil = 0; render();
  } finally {
    if (!stopped && pollGeneration === generation) timer = setTimeout(poll, 3000);
  }
}

function connectPrices() {
  source = new EventSource('/api/events?lite=1');
  source.addEventListener('price', event => {
    try {
      const next = JSON.parse(event.data);
      if (next.coin !== 'BTC' || !Number.isFinite(next.ts) || !Number.isFinite(next.mid)
          || next.mid <= 0 || next.ts > Date.now() + 30000 || (price && next.ts < price.ts)) return;
      price = { ts: next.ts, mid: next.mid }; lastPriceAt = Date.now();
      addPoint(price);
    } catch { /* Polling retains the last validated account if one price event is invalid. */ }
  });
}

async function loadHistory() {
  try {
    const response = await fetch('/api/history', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return;
    const body = await response.json();
    if (!Array.isArray(body.BTC)) return;
    const merged = [...body.BTC.map(r => ({ ts: r.ts, mid: r.mid })), ...points]
      .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.mid) && p.mid > 0 && p.ts <= Date.now() + 30000)
      .sort((a, b) => a.ts - b.ts);
    const last = merged.at(-1)?.ts ?? 0;
    const unique = new Map(merged.filter(p => p.ts >= last - 900000).map(p => [Math.floor(p.ts / 1000), p]));
    points = [...unique.values()].slice(-1000);
    lastChartSecond = Math.floor((points.at(-1)?.ts ?? 0) / 1000);
    $('chart-line').setAttribute('d', chartPath(points, 740, 100));
  } catch { /* An unavailable history leaves a chart built from new observed prices. */ }
}

$('broadcast-url').value = `${location.origin}/black-box/index.html?broadcast=1`;
$('broadcast').addEventListener('click', () => setBroadcast(true));
$('leave-broadcast').addEventListener('click', () => setBroadcast(false));
$('guides').addEventListener('change', e => document.body.classList.toggle('show-guides', e.target.checked));
$('motion').checked = motionAllowed;
player.setMotion(motionAllowed);
$('motion').addEventListener('change', e => { motionAllowed = e.target.checked; mediaError = ''; $('resume').hidden = true; player.setMotion(motionAllowed); render(); });
reducedMotion.addEventListener('change', e => { motionAllowed = !e.matches; $('motion').checked = motionAllowed; player.setMotion(motionAllowed); });
$('resume').addEventListener('click', () => { mediaError = ''; $('resume').hidden = true; motionAllowed = true; $('motion').checked = true; player.setMotion(true); });
for (const button of document.querySelectorAll('[data-preview]')) button.addEventListener('click', () => {
  if (document.body.classList.contains('broadcast')) return;
  preview = button.dataset.preview; $('preview-status').textContent = `Prueba visual: ${STATE_LABELS[preview]}`; render();
});
$('end-preview').addEventListener('click', () => { preview = null; $('preview-status').textContent = 'Estado automático'; render(); });
$('copy-url').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('broadcast-url').value); $('copy-url').textContent = 'URL copiada'; }
  catch { $('broadcast-url').select(); $('copy-url').textContent = 'Seleccionada para copiar'; }
});
addEventListener('keydown', event => {
  if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  if (event.key === 'Escape') setBroadcast(false);
  if (event.key.toLowerCase() === 'f') setBroadcast(!document.body.classList.contains('broadcast'));
  if (event.key.toLowerCase() === 'm') { $('motion').checked = !$('motion').checked; $('motion').dispatchEvent(new Event('change')); }
});
addEventListener('resize', fit);
addEventListener('pagehide', () => { stopped = true; generation++; clearTimeout(timer); clearInterval(renderTimer); controller?.abort(); source?.close(); });
const renderTimer = setInterval(render, 250);
if (params.get('broadcast') === '1') document.body.classList.add('broadcast');
fit(); render(); poll(); connectPrices(); loadHistory();
