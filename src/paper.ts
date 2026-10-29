import { Database } from "bun:sqlite";
import type { Fill } from "./types";

export type { Fill } from "./types";

export interface PaperOptions {
  initialUsd: number;
  maxPositionUsd: number;
  maxLossUsd: number;
  makerFeeBps: number;
  takerFeeBps: number;
  maxLeverage: number;
}

export interface PaperState {
  initialUsd: number;
  positionSz: number;
  /** Signed quote cost basis. It is positionSz * entryPrice for an open position. */
  costUsd: number;
  realizedUsd: number;
  /** Fees are positive costs. */
  feesUsd: number;
  /** Funding is a signed cost: positive means the account paid funding. */
  fundingUsd: number;
  /** Model charges are positive costs. */
  modelUsd: number;
  peakEquity: number;
  halted: boolean;
  lastFundingAt: number;
  leverage: number;
}

export interface PaperSnapshot extends PaperState {
  equityUsd: number;
  availableUsd: number;
  unrealizedUsd: number;
  pnlUsd: number;
  drawdownUsd: number;
}

export interface PaperAuditRow {
  id: number;
  kind: string;
  payload: unknown;
  at: number;
}

interface StoredRow {
  key: string;
  value: string;
}

interface AuditPayload {
  [key: string]: unknown;
}

const META_TABLE = "paper_meta";
const AUDIT_TABLE = "paper_audit";
const VERSION = 1;
const POSITION_EPSILON = 1e-12;
const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|secret|password|mnemonic|seed)/i;

function numberValue(name: string, value: unknown, min = -Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new TypeError(`${name} must be a finite number${min !== -Infinity ? ` >= ${min}` : ""}`);
  }
  return value;
}

function positive(name: string, value: unknown): number {
  return numberValue(name, value, Number.MIN_VALUE);
}

function json(value: unknown): string {
  const seen = new WeakSet<object>();
  const scrub = (item: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
    if (item === undefined) return null;
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("audit payload must contain finite numbers");
      return item;
    }
    if (typeof item !== "object") throw new TypeError("audit payload must be JSON serializable");
    if (seen.has(item)) throw new TypeError("audit payload must not be circular");
    seen.add(item);
    if (Array.isArray(item)) return item.map((entry) => scrub(entry));
    const out: AuditPayload = {};
    for (const [entryKey, entryValue] of Object.entries(item)) out[entryKey] = scrub(entryValue, entryKey);
    return out;
  };
  return JSON.stringify(scrub(value)) ?? "null";
}

function sameConfig(a: PaperOptions, b: PaperOptions): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stateFrom(value: unknown): PaperState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("corrupt paper account state");
  const item = value as Record<string, unknown>;
  const state: PaperState = {
    initialUsd: numberValue("initialUsd", item.initialUsd, 0),
    positionSz: numberValue("positionSz", item.positionSz),
    costUsd: numberValue("costUsd", item.costUsd),
    realizedUsd: numberValue("realizedUsd", item.realizedUsd),
    feesUsd: numberValue("feesUsd", item.feesUsd, 0),
    fundingUsd: numberValue("fundingUsd", item.fundingUsd),
    modelUsd: numberValue("modelUsd", item.modelUsd, 0),
    peakEquity: numberValue("peakEquity", item.peakEquity, 0),
    halted: item.halted === true || item.halted === false ? item.halted : (() => { throw new Error("corrupt paper account state"); })(),
    lastFundingAt: numberValue("lastFundingAt", item.lastFundingAt, 0),
    leverage: positive("leverage", item.leverage),
  };
  if (state.positionSz === 0 && state.costUsd !== 0) throw new Error("corrupt paper account position basis");
  if (state.positionSz !== 0 && state.costUsd === 0) throw new Error("corrupt paper account position basis");
  if (state.positionSz !== 0 && sign(state.positionSz) !== sign(state.costUsd)) throw new Error("corrupt paper account position basis");
  return state;
}

function stateJson(state: PaperState): string {
  return JSON.stringify(state);
}

function sideDelta(side: unknown, size: number): number {
  if (side === "buy") return size;
  if (side === "sell") return -size;
  throw new TypeError("fill side must be buy or sell");
}

function sign(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

function cleanPosition(value: number): number {
  return Math.abs(value) < POSITION_EPSILON ? 0 : value;
}

/** A durable, single-position, simulation-only perp account. */
export class PaperAccount {
  private readonly db: Database;
  private readonly coin: string;
  private readonly options: PaperOptions;
  private current: PaperState;
  private closed = false;

  constructor(path: string, coin: string, options: PaperOptions) {
    if (typeof path !== "string" || path.length === 0) throw new TypeError("path is required");
    if (typeof coin !== "string" || coin.trim().length === 0) throw new TypeError("coin is required");
    this.coin = coin;
    this.options = {
      initialUsd: numberValue("initialUsd", options?.initialUsd, 0),
      maxPositionUsd: positive("maxPositionUsd", options?.maxPositionUsd),
      maxLossUsd: numberValue("maxLossUsd", options?.maxLossUsd, 0),
      makerFeeBps: numberValue("makerFeeBps", options?.makerFeeBps, 0),
      takerFeeBps: numberValue("takerFeeBps", options?.takerFeeBps, 0),
      maxLeverage: positive("maxLeverage", options?.maxLeverage),
    };
    this.db = new Database(path);
    try {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      const existingTables = this.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      const foreignTables = existingTables.filter(({ name }) => name !== META_TABLE && name !== AUDIT_TABLE && name !== "sqlite_sequence");
      if (foreignTables.length > 0) throw new Error("database is not a paper account");
      const hasMeta = existingTables.some(({ name }) => name === META_TABLE);
      const hasAudit = existingTables.some(({ name }) => name === AUDIT_TABLE);
      if (hasMeta !== hasAudit) throw new Error("corrupt paper account schema");
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL);`);
      const rows = this.db.query(`SELECT key, value FROM ${META_TABLE}`).all() as StoredRow[];
      if (rows.length === 0) {
        const auditCount = this.db.query(`SELECT COUNT(*) AS count FROM ${AUDIT_TABLE}`).get() as { count: number };
        if (Number(auditCount.count) !== 0) throw new Error("corrupt paper account metadata");
        this.current = {
          initialUsd: this.options.initialUsd,
          positionSz: 0,
          costUsd: 0,
          realizedUsd: 0,
          feesUsd: 0,
          fundingUsd: 0,
          modelUsd: 0,
          peakEquity: this.options.initialUsd,
          halted: false,
          lastFundingAt: 0,
          leverage: 1,
        };
        const config = JSON.stringify({ version: VERSION, coin: this.coin, options: this.options });
        const tx = this.db.transaction(() => {
          this.db.query(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?), (?, ?), (?, ?)`)
            .run("config", config, "state", stateJson(this.current), "version", String(VERSION));
          this.db.query(`INSERT INTO ${AUDIT_TABLE} (kind, payload, at) VALUES (?, ?, ?)`)
            .run("init", json({ coin: this.coin, version: VERSION }), Date.now());
        });
        tx();
      } else {
        const entries = new Map(rows.map((row) => [row.key, row.value]));
        if (entries.size !== 3 || !entries.has("config") || !entries.has("state") || !entries.has("version")) {
          throw new Error("corrupt paper account metadata");
        }
        if (entries.get("version") !== String(VERSION)) throw new Error("unsupported paper account version");
        let config: unknown;
        let storedState: unknown;
        try {
          config = JSON.parse(entries.get("config")!);
          storedState = JSON.parse(entries.get("state")!);
        } catch {
          throw new Error("corrupt paper account metadata");
        }
        if (!config || typeof config !== "object") throw new Error("corrupt paper account config");
        const saved = config as { version?: unknown; coin?: unknown; options?: unknown };
        if (saved.version !== VERSION || saved.coin !== this.coin || !saved.options || typeof saved.options !== "object" || !sameConfig(this.options, saved.options as PaperOptions)) {
          throw new Error("paper account config mismatch");
        }
        this.current = stateFrom(storedState);
        if (this.current.initialUsd !== this.options.initialUsd) throw new Error("paper account state/config mismatch");
        if (this.current.leverage > this.options.maxLeverage) throw new Error("paper account state/config mismatch");
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get state(): PaperState {
    this.assertOpen();
    return { ...this.current };
  }

  snapshot(mid: number): PaperSnapshot {
    this.assertOpen();
    const mark = positive("mid", mid);
    const unrealizedUsd = this.current.positionSz === 0 ? 0 : mark * this.current.positionSz - this.current.costUsd;
    const pnlUsd = this.current.realizedUsd + unrealizedUsd - this.current.fundingUsd - this.current.feesUsd - this.current.modelUsd;
    const equityUsd = this.current.initialUsd + pnlUsd;
    const margin = this.current.positionSz === 0 ? 0 : Math.abs(mark * this.current.positionSz) / this.current.leverage;
    return { ...this.current, equityUsd, availableUsd: equityUsd - margin, unrealizedUsd, pnlUsd, drawdownUsd: this.current.peakEquity - equityUsd };
  }

  /** Returns null when an order may be quoted, otherwise a stable rejection reason. */
  approve(side: "buy" | "sell", size: number, price: number, leverage: number, reduceOnly = false): string | null {
    this.assertOpen();
    if (side !== "buy" && side !== "sell") return "invalid side";
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return "invalid size";
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return "invalid price";
    if (typeof leverage !== "number" || !Number.isFinite(leverage) || leverage <= 0) return "invalid leverage";
    if (leverage > this.options.maxLeverage) return "max leverage";
    if (typeof reduceOnly !== "boolean") return "invalid reduceOnly";
    const delta = sideDelta(side, size);
    const currentSign = sign(this.current.positionSz);
    const next = cleanPosition(this.current.positionSz + delta);
    const isPureExit = currentSign !== 0 && (next === 0 || (sign(next) === currentSign && Math.abs(next) < Math.abs(this.current.positionSz)));
    if (reduceOnly && (currentSign === 0 || sign(delta) === currentSign || Math.abs(delta) > Math.abs(this.current.positionSz))) return "reduce only";
    if (isPureExit) return null;
    if (this.current.halted) return "halted";
    const notional = Math.abs(next * price);
    if (notional > this.options.maxPositionUsd) return "max position";
    const snapshot = this.snapshot(price);
    const fee = Math.abs(delta * price) * this.options.takerFeeBps / 10_000;
    if (snapshot.equityUsd - fee <= 0 || notional / leverage + fee > snapshot.equityUsd) return "insufficient equity";
    if (this.options.maxLossUsd > 0 && snapshot.equityUsd <= this.current.initialUsd - this.options.maxLossUsd) return "max loss";
    if (this.options.maxLossUsd === 0 && snapshot.equityUsd < this.current.initialUsd) return "max loss";
    return null;
  }

  fill(fill: Fill, leverage = 1): void {
    this.assertOpen();
    if (!fill || typeof fill !== "object") throw new TypeError("fill is required");
    const size = positive("fill.size", fill.size);
    const price = positive("fill.price", fill.price);
    const lev = positive("leverage", leverage);
    if (lev > this.options.maxLeverage) throw new RangeError("leverage exceeds maxLeverage");
    const delta = sideDelta(fill.side, size);
    const oldPosition = this.current.positionSz;
    const oldCost = this.current.costUsd;
    const oldEntry = oldPosition === 0 ? 0 : oldCost / oldPosition;
    const closedSize = oldPosition !== 0 && sign(delta) !== sign(oldPosition) ? Math.min(Math.abs(oldPosition), Math.abs(delta)) : 0;
    const realized = closedSize === 0 ? 0 : (oldPosition > 0 ? price - oldEntry : oldEntry - price) * closedSize;
    const nextPosition = cleanPosition(oldPosition + delta);
    let nextCost = 0;
    if (nextPosition !== 0) {
      nextCost = oldPosition === 0 || sign(delta) === sign(oldPosition) ? oldCost + delta * price : Math.abs(delta) < Math.abs(oldPosition) ? nextPosition * oldEntry : nextPosition * price;
    }
    const maybeFee = (fill as Fill & { taker?: unknown }).feeUsd;
    const taker = (fill as Fill & { taker?: unknown }).taker !== false;
    const fee = maybeFee === undefined ? size * price * (taker ? this.options.takerFeeBps : this.options.makerFeeBps) / 10_000 : numberValue("fill.feeUsd", maybeFee, 0);
    const next: PaperState = {
      ...this.current,
      positionSz: nextPosition,
      costUsd: nextCost,
      realizedUsd: this.current.realizedUsd + realized,
      feesUsd: this.current.feesUsd + fee,
      leverage: nextPosition === 0 ? 1 : lev,
    };
    this.mutate("fill", { side: fill.side, size, price, leverage: lev, realizedUsd: realized, feeUsd: fee }, next);
  }

  chargeModel(usd: number): void {
    this.assertOpen();
    const charge = numberValue("usd", usd, 0);
    this.mutate("model", { usd: charge }, { ...this.current, modelUsd: this.current.modelUsd + charge });
  }

  /** Estimates funding over the cursor gap using the supplied rate and mark held constant; it is not venue-settled funding. */
  fund(hourlyRate: number, mid: number, now: number): void {
    this.assertOpen();
    const rate = numberValue("hourlyRate", hourlyRate);
    const mark = positive("mid", mid);
    const timestamp = numberValue("now", now, 0);
    if (timestamp < this.current.lastFundingAt) throw new RangeError("funding cursor cannot move backwards");
    const elapsedHours = (timestamp - this.current.lastFundingAt) / 3_600_000;
    const estimated = this.current.positionSz * mark * rate * elapsedHours;
    this.mutate("funding", { hourlyRate: rate, mid: mark, from: this.current.lastFundingAt, to: timestamp, elapsedHours, estimatedUsd: estimated, estimation: "rate and mark held constant over the cursor gap; not venue-settled" }, { ...this.current, fundingUsd: this.current.fundingUsd + estimated, lastFundingAt: timestamp });
  }

  observe(mid: number): string | null {
    this.assertOpen();
    const snapshot = this.snapshot(mid);
    const peakEquity = Math.max(this.current.peakEquity, snapshot.equityUsd);
    const loss = this.current.initialUsd - snapshot.equityUsd;
    const drawdown = peakEquity - snapshot.equityUsd;
    const exceeded = this.options.maxLossUsd === 0 ? loss > 0 || drawdown > 0 : loss >= this.options.maxLossUsd || drawdown >= this.options.maxLossUsd;
    const reason = this.current.halted ? "halted" : exceeded ? "max loss" : null;
    this.mutate("observe", { mid, equityUsd: snapshot.equityUsd, peakEquity, drawdownUsd: drawdown, halted: this.current.halted || exceeded }, { ...this.current, peakEquity, halted: this.current.halted || exceeded });
    return reason;
  }

  record(kind: string, payload: unknown): void {
    this.assertOpen();
    if (typeof kind !== "string" || kind.trim().length === 0) throw new TypeError("audit kind is required");
    const payloadJson = json(payload);
    const tx = this.db.transaction(() => {
      this.db.query(`INSERT INTO ${AUDIT_TABLE} (kind, payload, at) VALUES (?, ?, ?)`)
        .run(kind, payloadJson, Date.now());
    });
    tx();
  }

  recent(kind: string, limit?: number): PaperAuditRow[];
  recent(limit?: number): PaperAuditRow[];
  recent(kindOrLimit?: string | number, requestedLimit = 100): PaperAuditRow[] {
    this.assertOpen();
    const kind = typeof kindOrLimit === "string" ? kindOrLimit : undefined;
    const limit = typeof kindOrLimit === "number" ? kindOrLimit : requestedLimit;
    if (kind !== undefined && kind.trim().length === 0) throw new TypeError("audit kind is required");
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
    const bounded = Math.min(limit, 1_000);
    const query = kind === undefined
      ? this.db.query(`SELECT id, kind, payload, at FROM ${AUDIT_TABLE} ORDER BY id DESC LIMIT ?`)
      : this.db.query(`SELECT id, kind, payload, at FROM ${AUDIT_TABLE} WHERE kind = ? ORDER BY id DESC LIMIT ?`);
    const rows = (kind === undefined ? query.all(bounded) : query.all(kind, bounded)) as { id: number; kind: string; payload: string; at: number }[];
    return rows.map((row) => {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        throw new Error("corrupt paper account audit");
      }
      return { id: row.id, kind: row.kind, payload, at: row.at };
    });
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  private mutate(kind: string, payload: unknown, next: PaperState): void {
    const payloadJson = json(payload);
    const validated = stateFrom(next);
    if (validated.leverage > this.options.maxLeverage) throw new RangeError("state leverage exceeds maxLeverage");
    const tx = this.db.transaction(() => {
      this.db.query(`UPDATE ${META_TABLE} SET value = ? WHERE key = 'state'`).run(stateJson(validated));
      this.db.query(`INSERT INTO ${AUDIT_TABLE} (kind, payload, at) VALUES (?, ?, ?)`)
        .run(kind, payloadJson, Date.now());
    });
    tx();
    this.current = validated;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("paper account is closed");
  }
}
