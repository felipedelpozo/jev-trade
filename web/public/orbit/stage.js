import { money } from './core.js';

export const SAFE_ZONE = Object.freeze({ x: 72, y: 170, width: 828, height: 1390 });

export function fitStage(fit) {
  const ratio = 800 / 952;
  return { s: fit.s * ratio, tx: 486 + (fit.tx - 524) * ratio,
    ty: 240 + (fit.ty - 32) * ratio };
}

export function resultCue(event, preview = '') {
  if (preview === 'win' || preview === 'loss') return { kind: preview, netUsd: null, duration: preview === 'win' ? 4800 : 2800 };
  if (!Number.isFinite(event?.netUsd)) return null;
  if (event.kind === 'closed-win' && event.netUsd > 1e-12) return { kind: 'win', netUsd: event.netUsd, duration: 4800 };
  if (event.kind === 'closed-loss' && event.netUsd < -1e-12) return { kind: 'loss', netUsd: event.netUsd, duration: 2800 };
  return null;
}

export function mascotReaction({ spinning, error, stale, cue, event, elapsed }) {
  if (error || stale) return 'signal';
  if (spinning) return 'curious';
  if (cue) return cue.kind;
  if (elapsed < 2500 && event?.kind === 'opened') return 'opened';
  if (elapsed < 1400 && event?.kind === 'none') return 'miss';
  return 'idle';
}

export function cueProgress(cue, now, motion = true) {
  const elapsed = Math.max(0, now - cue.at);
  if (elapsed >= cue.duration) return null;
  const opacity = Math.min(1, elapsed / 220, (cue.duration - elapsed) / 380);
  return { elapsed, opacity, count: motion ? 1 - (1 - Math.min(1, elapsed / 1550)) ** 3 : 1 };
}

export function accountReadout(value) {
  if (!Number.isFinite(value)) return { text: '—', positive: null };
  if (Math.abs(value) < 0.00005) return { text: '$0.0000', positive: null };
  return { text: money(value, 4), positive: value > 0 };
}

export function updateCycle(previous, row) {
  if (!Number.isFinite(row?.ts)) return previous;
  const key = Number.isFinite(row.block) ? `block:${row.block}` : `request:${row.requests}`;
  return previous?.key === key ? previous : { key, at: row.ts };
}

export function timerReadout({ now, mode, tickMs, cycle, connected, stale, spin }) {
  if (spin) {
    const elapsed = Math.max(0, spin.elapsed), duration = spin.duration;
    return { value: `${Math.ceil(Math.max(0, duration - elapsed) / 1000)} s`,
      label: spin.label || (spin.waiting ? 'CONSULTA' : 'TIRADA'), progress: Math.min(1, elapsed / duration), active: true };
  }
  if (mode === 'replay') return { value: `${Math.ceil(tickMs / 1000)} s`, label: 'CADENCIA', progress: 0, active: false };
  if (!connected || stale || !cycle || !Number.isFinite(tickMs) || tickMs <= 0) {
    return { value: '—', label: !connected ? 'SIN SEÑAL' : 'SIN DATOS', progress: 0, active: false };
  }
  const remaining = Math.max(0, tickMs - Math.max(0, now - cycle.at));
  return { value: `${String(Math.ceil(remaining / 1000)).padStart(2, '0')} s`,
    label: remaining === 0 ? 'ESPERANDO' : 'PRÓXIMA', progress: remaining / tickMs, active: remaining > 0 };
}

export function closeBalanceTransition(event, from, to, now) {
  const cue = resultCue(event);
  if (!cue || !Number.isFinite(from) || !Number.isFinite(to) || from === to) return null;
  return { from, to, at: now + cue.duration, duration: 1500 };
}

export function animatedBalance(transition, fallback, now, motion = true) {
  if (!transition) return { value: fallback, active: false, pulse: 0 };
  if (!motion) return { value: transition.to, active: false, pulse: 0 };
  const progress = Math.max(0, Math.min(1, (now - transition.at) / transition.duration));
  return { value: progress === 1 ? transition.to : transition.from + (transition.to - transition.from) * (1 - (1 - progress) ** 3),
    active: progress < 1, pulse: Math.sin(Math.PI * progress) * .025 };
}

export function scoreboardRows(top, bottom, titleHeight, amountHeight, captionHeight) {
  const height = titleHeight + 14 + amountHeight + 10 + captionHeight;
  const start = (top + bottom - height) / 2;
  return { title: start + titleHeight / 2,
    amount: start + titleHeight + 14 + amountHeight / 2,
    caption: start + titleHeight + 14 + amountHeight + 10 + captionHeight / 2 };
}
