/**
 * Symbols used by the canvas reel. The tracker deliberately does not know
 * anything about the artwork beyond this small, stable vocabulary.
 */
export const SYMBOLS = Object.freeze(['btc', 'bull', 'bear', 'hold', 'exit', 'processor']);

const POSITION_SIDES = new Set(['long', 'short', 'flat']);
const FINANCIAL_FIELDS = ['realizedUsd', 'feesUsd', 'fundingUsd', 'modelUsd'];
const COST_FIELDS = ['feesUsd', 'fundingUsd', 'modelUsd'];
const EPSILON = 1e-12;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function unwrap(row) {
  return row?.latestByCoin?.BTC && typeof row.latestByCoin.BTC === 'object'
    ? row.latestByCoin.BTC
    : row;
}

function normalizePosition(row) {
  const source = row?.position;
  if (!source || typeof source !== 'object') return { known: false, side: 'flat', size: 0 };
  const size = finite(source.size);
  const side = typeof source.side === 'string' ? source.side.toLowerCase() : '';
  if (size === null || !POSITION_SIDES.has(side) || size < 0) {
    return { known: false, side: 'flat', size: 0 };
  }
  // A zero-sized position is flat even when a stale public side is retained.
  return size === 0 || side === 'flat'
    ? { known: true, side: 'flat', size: 0 }
    : { known: true, side, size };
}

function normalizeFinancials(row) {
  const paper = row?.paper;
  if (!paper || typeof paper !== 'object') return null;
  const values = Object.fromEntries(FINANCIAL_FIELDS.map((field) => [field, finite(paper[field])]));
  return {
    ...values,
    complete: FINANCIAL_FIELDS.every((field) => values[field] !== null),
    estimated: paper.modelCostEstimated === true,
  };
}

function normalizeFills(row) {
  return finite(row?.totals?.fills ?? row?.fills);
}

function normalizeBlock(row) {
  const value = row?.block;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function normalize(row) {
  const source = unwrap(row);
  if (!source || typeof source !== 'object') return null;
  const ts = finite(source.ts);
  const position = normalizePosition(source);
  const financials = normalizeFinancials(source);
  const fills = normalizeFills(source);
  const block = normalizeBlock(source);
  if (ts === null || !position.known) return null;
  return { source, ts, block, position, financials, fills };
}

function stableValue(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
}

function fingerprint(snapshot) {
  // Only public state that can affect the tracker is included. This also
  // makes a same-block price/unrealized update a harmless duplicate.
  return stableValue({
    ts: snapshot.ts,
    block: snapshot.block,
    position: snapshot.position,
    financials: snapshot.financials,
    fills: snapshot.fills,
  });
}

function keyEquals(a, b) {
  if (!a || !b) return false;
  if (a.block !== null && b.block !== null) return a.block === b.block;
  return a.block === null && b.block === null && a.ts === b.ts;
}

function isOlder(a, b) {
  if (!a || !b) return false;
  if (a.block !== null && b.block !== null) return a.block < b.block;
  if (a.block !== null || b.block !== null) return a.ts < b.ts;
  return a.ts < b.ts;
}

function positionChanged(previous, next) {
  return previous.position.side !== next.position.side || previous.position.size !== next.position.size;
}

function symbolForSide(side) {
  return side === 'long' ? 'bull' : side === 'short' ? 'bear' : 'processor';
}

function event(kind, id = null, fields = {}) {
  return { kind, id, ...fields };
}

function none(reason) {
  return event('none', null, reason ? { reason } : {});
}

/**
 * Return a non-winning reel combination. `held` is kept where possible so a
 * position can visually remain in place while the other columns advance.
 */
export function randomCombination(random = Math.random, held = []) {
  const source = typeof random === 'function' ? random : Math.random;
  const result = Array.from({ length: 3 }, (_, index) => {
    const value = held[index];
    return SYMBOLS.includes(value) ? value : SYMBOLS[Math.min(SYMBOLS.length - 1,
      Math.max(0, Math.floor((Number(source()) || 0) * SYMBOLS.length)))];
  });

  // A non-win must never accidentally become a triple, including when all
  // three columns were requested as held symbols.
  if (result[0] === result[1] && result[1] === result[2]) {
    const current = SYMBOLS.indexOf(result[2]);
    result[2] = SYMBOLS[(current + 1) % SYMBOLS.length];
  }
  return result;
}

/**
 * Convert a tracker event into reel symbols. Winning events are the only
 * events allowed to produce a triple; every other event is non-winning.
 */
export function presentation(trackerEvent, trackerPositionState, random = Math.random) {
  const position = trackerPositionState?.side;
  if (trackerEvent?.kind === 'closed-win' && trackerEvent.netUsd > EPSILON) {
    // BTC is the winning visual; the side remains available on the event for
    // the HUD, but direction must not change the winning visual.
    const symbol = 'btc';
    return { symbols: [symbol, symbol, symbol], winning: true, event: trackerEvent };
  }
  const held = Array.isArray(trackerPositionState?.symbols)
    ? trackerPositionState.symbols
    : [];
  return { symbols: randomCombination(random, held), winning: false, event: trackerEvent };
}

export class TradeTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.last = null;
    this.blockBaseline = null;
    this.active = null;
    this.nextEpisode = 1;
    this.episodes = [];
    this.historicalEvents = [];
    this.gap = false;
    return this;
  }

  /** Rebuild state from public history without emitting historical spins. */
  initialize(history = []) {
    this.reset();
    if (!Array.isArray(history)) return this;
    const snapshots = history.map(normalize).filter(Boolean);
    snapshots.sort((a, b) => {
      const ak = a.block ?? a.ts;
      const bk = b.block ?? b.ts;
      return ak - bk;
    });
    // A history endpoint may contain several revisions of one block. The
    // latest occurrence is the only public state we can safely reconstruct.
    const unique = [];
    for (const snapshot of snapshots) {
      const previous = unique[unique.length - 1];
      if (previous && keyEquals(previous, snapshot)) unique[unique.length - 1] = snapshot;
      else unique.push(snapshot);
    }
    for (const snapshot of unique) {
      // Reuse ingest so historical reconstruction applies the same stale-row,
      // reset and block-gap safeguards as live polling.
      const historical = this.ingest(snapshot.source);
      if (historical.kind !== 'none') this.historicalEvents.push(historical);
    }
    return this;
  }

  ingest(row) {
    const snapshot = normalize(row);
    if (!snapshot) return none('invalid-row');
    if (!this.last) return this.#consume(snapshot, true, null);

    if (isOlder(snapshot, this.last)) return none('stale-row');
    const sameKey = keyEquals(this.last, snapshot);
    // History polling may replay earlier revisions of the latest block. Keep
    // equal-timestamp edits eligible, but never walk state backwards in time.
    if (sameKey && snapshot.ts < this.last.ts) return none('stale-row');
    if (sameKey && fingerprint(this.last) === fingerprint(snapshot)) return none('duplicate-row');

    // Same-block revisions are processed as a state transition from the last
    // public revision. This preserves a newly visible position transition but
    // does not re-award an already closed episode on a cost-only edit.
    if (!sameKey && this.last.block !== null && snapshot.block !== null
        && snapshot.block > this.last.block + 1) this.gap = true;
    // A same-block revision may be the first filled position after an entry
    // query. Its baseline is the last row from the preceding block, not the
    // prior flat revision that already includes the query cost.
    if (!sameKey) this.blockBaseline = this.last;
    const openingBaseline = sameKey ? this.blockBaseline : this.last;
    return this.#consume(snapshot, true, openingBaseline);
  }

  get positionState() {
    if (!this.active) return { side: 'flat', size: 0, id: null, symbols: [] };
    return {
      side: this.active.side,
      size: this.active.size,
      id: this.active.id,
      symbols: [symbolForSide(this.active.side), 'processor', 'processor'],
    };
  }

  /** True while a position is open and awaiting a fully attributed close. */
  get hasOpenPosition() {
    return Boolean(this.active);
  }

  /** The latest accepted public row, useful to seed a subsequent poll. */
  get lastRow() {
    return this.last?.source || null;
  }

  /** Historical close/open events collected by initialize, without UI effects. */
  get closedEpisodes() {
    return this.episodes.filter((episode) => episode.closed);
  }

  #consume(snapshot, emit, openingBaseline) {
    const previous = this.last;
    this.last = snapshot;
    if (!previous) {
      if (snapshot.position.side !== 'flat') {
        this.#open(snapshot, null, false);
        return emit ? event('opened', this.active.id, {
          side: this.active.side,
          reason: 'missing-flat-baseline',
        }) : none();
      }
      return none();
    }

    this.#observeCounters(previous, snapshot);
    if (!snapshot.position.known || !previous.position.known) return none('unknown-position');
    if (!positionChanged(previous, snapshot)) return none();

    const oldPosition = previous.position;
    const newPosition = snapshot.position;
    if (oldPosition.side === 'flat' && newPosition.side !== 'flat') {
      const baseline = openingBaseline?.position.side === 'flat' ? openingBaseline : null;
      this.#open(snapshot, baseline, !this.gap && Boolean(baseline));
      this.gap = false;
      return emit ? event('opened', this.active.id, {
        side: this.active.side,
        size: this.active.size,
        reason: this.active.baselineKnown ? undefined : 'missing-baseline',
      }) : none();
    }

    if (!this.active) {
      // This can happen after a silently rebuilt history whose last row was a
      // position we could not attribute. Keep the new episode conservative.
      if (newPosition.side !== 'flat') {
        this.#open(snapshot, null, false);
        return emit ? event('opened', this.active.id, { side: this.active.side, reason: 'missing-baseline' }) : none();
      }
      return none();
    }

    if (oldPosition.side !== 'flat' && newPosition.side === 'flat') {
      const closed = this.#close(snapshot, oldPosition.side, this.gap);
      this.gap = false;
      return emit ? closed : none();
    }

    if (oldPosition.side !== 'flat' && newPosition.side !== oldPosition.side) {
      const closed = this.#close(snapshot, oldPosition.side, true, 'position-flip');
      this.#open(snapshot, null, false);
      this.gap = false;
      return emit ? { ...closed, reason: 'position-flip;new-baseline-unknown' } : none();
    }

    if (newPosition.side === oldPosition.side && newPosition.size < oldPosition.size) {
      this.active.size = newPosition.size;
      return emit ? event('partial-close', this.active.id, {
        side: this.active.side,
        size: newPosition.size,
        estimated: this.active.estimated,
      }) : none();
    }

    this.active.size = newPosition.size;
    return none();
  }

  #open(snapshot, previous, baselineAllowed) {
    const baseline = previous?.financials;
    const baselineKnown = baselineAllowed && Boolean(baseline?.complete);
    const openingCostReconciled = baselineKnown && snapshot.financials?.complete
      && COST_FIELDS.some((field) => snapshot.financials[field] < baseline[field] - EPSILON);
    this.active = {
      id: `episode-${this.nextEpisode++}`,
      side: snapshot.position.side,
      size: snapshot.position.size,
      baseline,
      baselineKnown,
      reconciled: Boolean(openingCostReconciled),
      estimated: Boolean(snapshot.financials?.estimated || baseline?.estimated),
    };
    this.episodes.push(this.active);
  }

  #observeCounters(previous, snapshot) {
    if (!this.active) return;
    const before = previous.financials;
    const after = snapshot.financials;
    if (!before || !after || !before.complete || !after.complete) {
      this.active.reconciled = true;
      return;
    }
    if (COST_FIELDS.some((field) => after[field] < before[field] - EPSILON)) {
      this.active.reconciled = true;
    }
    if (previous.fills !== null && snapshot.fills !== null && snapshot.fills < previous.fills) {
      this.active.reconciled = true;
    }
    this.active.estimated ||= after.estimated;
  }

  #close(snapshot, side, forcedUnverified = false, reason) {
    const active = this.active;
    this.active = null;
    if (!active) return none(reason || 'missing-episode');
    const current = snapshot.financials;
    const baseline = active.baseline;
    const valid = active.baselineKnown && !active.reconciled && !forcedUnverified
      && baseline?.complete && current?.complete;
    let result;
    if (!valid) {
      result = event('closed-unverified', active.id, {
        side,
        estimated: active.estimated || Boolean(current?.estimated),
        reason: reason || (!active.baselineKnown ? 'missing-baseline' : active.reconciled ? 'cost-reconciliation' : 'unknown-financials'),
      });
    } else {
      const grossUsd = current.realizedUsd - baseline.realizedUsd;
      const netUsd = grossUsd
        - (current.feesUsd - baseline.feesUsd)
        - (current.fundingUsd - baseline.fundingUsd)
        - (current.modelUsd - baseline.modelUsd);
      const details = {
        side,
        grossUsd,
        netUsd,
        estimated: active.estimated || current.estimated,
      };
      result = netUsd > EPSILON
        ? event('closed-win', active.id, { ...details, symbol: 'btc' })
        : event('closed-loss', active.id, details);
    }
    active.closed = true;
    active.closeEvent = result;
    return result;
  }
}

