import { SYMBOLS } from './slot-engine.js';

export { SYMBOLS } from './slot-engine.js';

export const SYMBOL_STEP_PX = 212;
export const REEL_SPEED = 9;

const PHASE_STEP = 0.35;

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function integer(value, name) {
  finite(value, name);
  if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer`);
  return value;
}

function immutable(value) {
  return Object.freeze(value);
}

/**
 * Create an unbounded downward reel. Motion uses only the supplied timestamp;
 * callers can render it from a RAF timestamp or a recorded clock.
 */
export function createReel(startMs, column) {
  const start = finite(startMs, 'startMs');
  const reelColumn = integer(column, 'column');
  if (reelColumn < 0) throw new RangeError('column must be non-negative');

  return immutable({
    startMs: start,
    column: reelColumn,
    speed: REEL_SPEED,
    startPosition: reelColumn * PHASE_STEP,
    landing: null,
  });
}

function timestamp(nowMs) {
  return finite(nowMs, 'nowMs');
}

/** Return the reel's position and velocity at a supplied timestamp. */
export function reelFrame(reel, nowMs) {
  const now = timestamp(nowMs);
  const timeMs = Math.max(now, reel.startMs);

  if (!reel.landing) {
    return {
      position: reel.startPosition + (timeMs - reel.startMs) / 1000 * reel.speed,
      velocity: reel.speed,
      stopped: false,
    };
  }

  const landing = reel.landing;
  const elapsed = Math.min(landing.durationSeconds,
    Math.max(0, (timeMs - landing.startedMs) / 1000));
  if (elapsed >= landing.durationSeconds) {
    return { position: landing.index, velocity: 0, stopped: true };
  }

  const acceleration = landing.startVelocity / landing.durationSeconds;
  return {
    position: landing.startPosition + landing.startVelocity * elapsed
      - 0.5 * acceleration * elapsed * elapsed,
    velocity: landing.startVelocity - acceleration * elapsed,
    stopped: false,
  };
}

/**
 * Freeze a result target and start constant-deceleration braking. A landing
 * already exists, so repeated or late locks are deliberately no-ops.
 */
export function lockReel(reel, nowMs, symbol, minBrakeMs = 1100 + reel.column * 180) {
  if (reel.landing) return reel;

  const now = timestamp(nowMs);
  finite(minBrakeMs, 'minBrakeMs');
  if (minBrakeMs < 0) throw new RangeError('minBrakeMs must be non-negative');
  if (!SYMBOLS.includes(symbol)) throw new RangeError(`Unknown reel symbol: ${symbol}`);

  const frame = reelFrame(reel, now);
  const minBrakeSeconds = minBrakeMs / 1000;
  const landingIndex = Math.max(
    Math.ceil(frame.position + reel.speed * minBrakeSeconds / 2),
    Math.ceil(frame.position) + 4,
  );
  const distance = landingIndex - frame.position;
  const durationSeconds = 2 * distance / frame.velocity;

  return immutable({
    ...reel,
    landing: immutable({
      index: landingIndex,
      symbol,
      startedMs: Math.max(now, reel.startMs),
      startPosition: frame.position,
      startVelocity: frame.velocity,
      durationSeconds,
      durationMs: durationSeconds * 1000,
    }),
  });
}

// Stable hash: no Math.random, DOM, or clock means replayed frames agree.
function symbolSeed(column, index) {
  let hash = 2166136261;
  for (const character of `${column}:${index}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Return a deterministic symbol for a virtual integer slot index. */
export function reelSymbol(reel, index) {
  integer(index, 'index');
  if (reel.landing && reel.landing.index === index) return reel.landing.symbol;
  return SYMBOLS[symbolSeed(reel.column, index) % SYMBOLS.length];
}

/** An executed ledger outcome can resolve a reel even when inference failed. */
export function hasReelResult(validDecision, event) {
  return Boolean(validDecision || ['opened', 'partial-close', 'closed-win', 'closed-loss', 'closed-unverified'].includes(event?.kind));
}
