import { Database } from "bun:sqlite";
import type { Fill, UsageBalance, UsagePeriod } from "./types";

export type { Fill, UsageBalance, UsagePeriod } from "./types";

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

export interface ModelCharge {
  requestId: string;
  provider: string;
  modelId: string;
  status: "pending" | "success" | "failed";
  inputTokens?: number;
  outputTokens?: number;
  costSource: "reported" | "estimated";
  generationId?: string;
  at?: number;
}

export interface ModelChargePatch {
  generationId?: string;
  inputTokens?: number;
  outputTokens?: number;
  status?: "pending" | "success" | "failed";
}

export interface PendingModelCharge {
  requestId: string;
  generationId: string;
}

interface StoredRow {
  key: string;
  value: string;
}

interface AuditPayload {
  [key: string]: unknown;
}

interface ModelAuditRow {
  id: number;
  amount: number;
  payload: Record<string, unknown>;
  usage: ModelCharge;
}

const META_TABLE = "paper_meta";
const AUDIT_TABLE = "paper_audit";
const VERSION = 1;
const POSITION_EPSILON = 1e-12;
const MONEY_EPSILON = 1e-12;
const MAX_USAGE_STRING_LENGTH = 256;
const DAY_MS = 86_400_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
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

function timestamp(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
    throw new TypeError(`${name} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function boundedString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_USAGE_STRING_LENGTH || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string of at most ${MAX_USAGE_STRING_LENGTH} characters`);
  }
  return value;
}

function tokenCount(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function modelCharge(value: ModelCharge, includeAt = true): ModelCharge {
  if (!value || typeof value !== "object") throw new TypeError("usage is required");
  const charge: ModelCharge = {
    requestId: boundedString("usage.requestId", value.requestId),
    provider: boundedString("usage.provider", value.provider),
    modelId: boundedString("usage.modelId", value.modelId),
    status: value.status === "pending" || value.status === "success" || value.status === "failed" ? value.status : (() => { throw new TypeError("usage.status must be pending, success, or failed"); })(),
    costSource: value.costSource === "reported" || value.costSource === "estimated" ? value.costSource : (() => { throw new TypeError("usage.costSource must be reported or estimated"); })(),
  };
  if (value.inputTokens !== undefined) charge.inputTokens = tokenCount("usage.inputTokens", value.inputTokens);
  if (value.outputTokens !== undefined) charge.outputTokens = tokenCount("usage.outputTokens", value.outputTokens);
  if (value.generationId !== undefined) charge.generationId = boundedString("usage.generationId", value.generationId);
  if (includeAt && value.at !== undefined) charge.at = timestamp("usage.at", value.at);
  return charge;
}

function usageFieldsEqual(a: ModelCharge, b: ModelCharge): boolean {
  return a.requestId === b.requestId && a.provider === b.provider && a.modelId === b.modelId
    && a.status === b.status && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens
    && a.costSource === b.costSource && a.generationId === b.generationId;
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
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_paper_audit_kind_at ON ${AUDIT_TABLE} (kind, at);`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_paper_audit_model_request_id ON ${AUDIT_TABLE} (json_extract(payload, '$.requestId')) WHERE kind = 'model';`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_paper_audit_model_pending ON ${AUDIT_TABLE} (at, id) WHERE kind = 'model' AND json_extract(payload, '$.costSource') = 'estimated' AND json_extract(payload, '$.generationId') IS NOT NULL;`);
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

  chargeModel(usd: number, usage?: ModelCharge): void {
    this.assertOpen();
    const charge = numberValue("usd", usd, 0);
    const normalized = usage === undefined ? undefined : modelCharge(usage);
    const at = normalized?.at ?? Date.now();
    const payload = normalized === undefined ? { usd: charge } : { usd: charge, ...normalized };
    const payloadJson = json(payload);
    const next = stateFrom({ ...this.current, modelUsd: this.current.modelUsd + charge });
    let duplicate = false;
    const tx = this.db.transaction(() => {
      if (normalized !== undefined) {
        const row = this.db.query(`SELECT payload FROM ${AUDIT_TABLE} WHERE kind = 'model' AND json_extract(payload, '$.requestId') = ? ORDER BY id ASC LIMIT 1`).get(normalized.requestId) as { payload: string } | null;
        if (row) {
          let existing: unknown;
          try {
            existing = JSON.parse(row.payload);
          } catch {
            throw new Error("corrupt paper account audit");
          }
          if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("corrupt paper account audit");
          const item = existing as Record<string, unknown>;
          const existingUsage = modelCharge(item as unknown as ModelCharge, false);
          if (item.usd === charge && usageFieldsEqual(existingUsage, normalized)) {
            duplicate = true;
            return;
          }
          throw new Error("conflicting model charge requestId");
        }
      }
      this.db.query(`UPDATE ${META_TABLE} SET value = ? WHERE key = 'state'`).run(stateJson(next));
      this.db.query(`INSERT INTO ${AUDIT_TABLE} (kind, payload, at) VALUES (?, ?, ?)`).run("model", payloadJson, at);
    });
    tx();
    if (!duplicate) this.current = next;
  }

  get usage(): UsageBalance {
    return this.usageBalance();
  }

  usageBalance(now = Date.now()): UsageBalance {
    this.assertOpen();
    const currentTime = timestamp("now", now);
    const currentDate = new Date(currentTime);
    const dayStart = Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate());
    const aggregate = (where = "", ...params: number[]): { since: number | null; period: UsagePeriod } => {
      const row = this.db.query(`
        SELECT MIN(at) AS since,
          COUNT(*) AS requests,
          COALESCE(SUM(CASE WHEN json_extract(payload, '$.status') = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN json_extract(payload, '$.status') = 'success' THEN 1 ELSE 0 END), 0) AS successful,
          COALESCE(SUM(CASE WHEN json_extract(payload, '$.status') = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(CASE WHEN json_extract(payload, '$.status') IS NULL THEN 1 ELSE 0 END), 0) AS unknownStatus,
          COALESCE(SUM(COALESCE(json_extract(payload, '$.inputTokens'), 0)), 0) AS inputTokens,
          COALESCE(SUM(COALESCE(json_extract(payload, '$.outputTokens'), 0)), 0) AS outputTokens,
          COALESCE(SUM(CASE WHEN json_extract(payload, '$.costSource') = 'reported' THEN json_extract(payload, '$.usd') ELSE 0 END), 0) AS reportedUsd,
          COALESCE(SUM(CASE WHEN json_extract(payload, '$.costSource') = 'reported' THEN 0 ELSE json_extract(payload, '$.usd') END), 0) AS estimatedUsd,
          COALESCE(SUM(json_extract(payload, '$.usd')), 0) AS totalUsd,
          COALESCE(SUM(CASE WHEN json_extract(payload, '$.costSource') = 'reported' THEN 1 ELSE 0 END), 0) AS reportedRequests,
          COALESCE(SUM(CASE WHEN json_extract(payload, '$.costSource') = 'reported' THEN 0 ELSE 1 END), 0) AS estimatedRequests,
          COALESCE(SUM(CASE WHEN json_extract(payload, '$.inputTokens') IS NULL OR json_extract(payload, '$.outputTokens') IS NULL THEN 1 ELSE 0 END), 0) AS unknownTokenRequests
        FROM ${AUDIT_TABLE} WHERE kind = 'model' ${where}`).get(...params) as Record<string, number | null>;
      const value = (name: string): number => Number(row[name] ?? 0);
      return {
        since: row.since === null ? null : timestamp("audit.at", Number(row.since)),
        period: {
          requests: value("requests"), pending: value("pending"), successful: value("successful"), failed: value("failed"), unknownStatus: value("unknownStatus"),
          inputTokens: value("inputTokens"), outputTokens: value("outputTokens"), reportedUsd: value("reportedUsd"), estimatedUsd: value("estimatedUsd"), totalUsd: value("totalUsd"),
          reportedRequests: value("reportedRequests"), estimatedRequests: value("estimatedRequests"), unknownTokenRequests: value("unknownTokenRequests"),
        },
      };
    };
    const allTime = aggregate();
    const today = aggregate("AND at >= ? AND at < ?", dayStart, dayStart + DAY_MS);
    return { since: allTime.since, allTime: allTime.period, today: today.period };
  }

  updateModelCharge(requestId: string, patch: ModelChargePatch): void {
    this.assertOpen();
    const id = boundedString("requestId", requestId);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("patch is required");
    const keys = Object.keys(patch);
    if (keys.some((key) => key !== "generationId" && key !== "inputTokens" && key !== "outputTokens" && key !== "status")) {
      throw new TypeError("unsupported model charge patch");
    }
    if (patch.generationId !== undefined) boundedString("patch.generationId", patch.generationId);
    if (patch.inputTokens !== undefined) tokenCount("patch.inputTokens", patch.inputTokens);
    if (patch.outputTokens !== undefined) tokenCount("patch.outputTokens", patch.outputTokens);
    if (patch.status !== undefined && patch.status !== "pending" && patch.status !== "success" && patch.status !== "failed") throw new TypeError("patch.status must be pending, success, or failed");
    const row = this.modelRow(id);
    if (!row) throw new Error("model charge requestId not found");
    const next = modelCharge({ ...row.usage, ...patch });
    if (usageFieldsEqual(next, row.usage)) return;
    const payload = { ...row.payload, ...patch };
    const payloadJson = json(payload);
    const tx = this.db.transaction(() => {
      this.db.query(`UPDATE ${AUDIT_TABLE} SET payload = ? WHERE id = ? AND kind = 'model'`).run(payloadJson, row.id);
      this.db.query(`INSERT INTO ${AUDIT_TABLE} (kind, payload, at) VALUES (?, ?, ?)`)
        .run("model-update", json({ requestId: id, fields: keys }), Date.now());
    });
    tx();
  }

  reconcileModelCharge(requestId: string, actualUsd: number): void {
    this.setModelCharge(requestId, actualUsd, "reported");
  }

  updateModelEstimate(requestId: string, estimatedUsd: number): void {
    this.setModelCharge(requestId, estimatedUsd, "estimated");
  }

  private setModelCharge(requestId: string, actualUsd: number, source: "reported" | "estimated"): void {
    this.assertOpen();
    const id = boundedString("requestId", requestId);
    const actual = numberValue("actualUsd", actualUsd, 0);
    const row = this.modelRow(id);
    if (!row) throw new Error("model charge requestId not found");
    if (row.payload.costSource === "reported") {
      if (source === "estimated" || row.amount === actual) return;
      throw new Error("conflicting model charge reconciliation");
    }
    if (row.amount === actual && row.payload.costSource === source) return;
    const delta = actual - row.amount;
    const modelUsd = this.current.modelUsd + delta;
    const next = stateFrom({ ...this.current, modelUsd: Math.abs(modelUsd) < MONEY_EPSILON ? 0 : modelUsd });
    const payloadJson = json({ ...row.payload, usd: actual, costSource: source });
    const tx = this.db.transaction(() => {
      this.db.query(`UPDATE ${META_TABLE} SET value = ? WHERE key = 'state'`).run(stateJson(next));
      this.db.query(`UPDATE ${AUDIT_TABLE} SET payload = ? WHERE id = ? AND kind = 'model'`).run(payloadJson, row.id);
      this.db.query(`INSERT INTO ${AUDIT_TABLE} (kind, payload, at) VALUES (?, ?, ?)`)
        .run("model-reconcile", json({ requestId: id, fromUsd: row.amount, toUsd: actual, deltaUsd: delta, source }), Date.now());
    });
    tx();
    this.current = next;
  }

  pendingModelCharges(limit = 20): PendingModelCharge[] {
    this.assertOpen();
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
    const bounded = Math.min(limit, 1_000);
    const rows = this.db.query(`
      SELECT json_extract(payload, '$.requestId') AS requestId,
        json_extract(payload, '$.generationId') AS generationId
      FROM ${AUDIT_TABLE}
      WHERE kind = 'model' AND json_extract(payload, '$.costSource') = 'estimated'
        AND json_extract(payload, '$.generationId') IS NOT NULL
      ORDER BY at ASC, id ASC LIMIT ?`).all(bounded) as { requestId: unknown; generationId: unknown }[];
    return rows.map((row) => ({ requestId: boundedString("requestId", row.requestId), generationId: boundedString("generationId", row.generationId) }));
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

  private modelRow(requestId: string): ModelAuditRow | null {
    const row = this.db.query(`SELECT id, payload FROM ${AUDIT_TABLE} WHERE kind = 'model' AND json_extract(payload, '$.requestId') = ? ORDER BY id ASC LIMIT 1`).get(requestId) as { id: number; payload: string } | null;
    if (!row) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      throw new Error("corrupt paper account audit");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("corrupt paper account audit");
    const item = payload as Record<string, unknown>;
    const usage = modelCharge(item as unknown as ModelCharge, false);
    return { id: row.id, amount: numberValue("model charge", item.usd, 0), payload: item, usage };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("paper account is closed");
  }
}
