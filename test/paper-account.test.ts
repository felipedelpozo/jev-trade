import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperAccount, type PaperOptions } from "../src/paper";

const options: PaperOptions = {
  initialUsd: 100,
  maxPositionUsd: 500,
  maxLossUsd: 10,
  makerFeeBps: 1,
  takerFeeBps: 10,
  maxLeverage: 3,
};

test("decimal partial closes do not leave floating-point phantom exposure", () => {
  const account = new PaperAccount(":memory:", "BTC", options);
  account.fill({ side: "buy", size: 0.3, price: 100, orderId: 1, txHash: null, simulated: true });
  account.fill({ side: "sell", size: 0.1, price: 100, orderId: 2, txHash: null, simulated: true });
  account.fill({ side: "sell", size: 0.2, price: 100, orderId: 3, txHash: null, simulated: true });
  expect(account.state.positionSz).toBe(0);
  expect(account.state.costUsd).toBe(0);
  account.close();
});

function fill(side: "buy" | "sell", size: number, price: number, extra: Record<string, unknown> = {}) {
  return { side, size, price, txHash: null, orderId: 1, simulated: true, ...extra } as Parameters<PaperAccount["fill"]>[0];
}

test("settles long, partial close, and flip with an averaged cost basis", () => {
  const account = new PaperAccount(":memory:", "BTC", options);
  account.fill(fill("buy", 1, 100));
  account.fill(fill("sell", 0.4, 110));
  expect(account.state).toMatchObject({ positionSz: 0.6, costUsd: 60, realizedUsd: 4 });
  account.fill(fill("sell", 1, 90));
  expect(account.state.positionSz).toBeCloseTo(-0.4, 10);
  expect(account.state.costUsd).toBeCloseTo(-36, 10);
  expect(account.state.realizedUsd).toBeCloseTo(-2, 10);
  expect(account.snapshot(80).unrealizedUsd).toBeCloseTo(4, 10);
  account.close();
});

test("fees, estimated funding, and model costs remain separate", () => {
  const account = new PaperAccount(":memory:", "ETH", { ...options, initialUsd: 1000 });
  account.fill(fill("buy", 2, 100));
  account.fund(0.01, 100, 0);
  account.fund(0.01, 100, 3_600_000);
  account.chargeModel(3);
  expect(account.state.feesUsd).toBeCloseTo(0.2, 10);
  expect(account.state.fundingUsd).toBeCloseTo(2, 10);
  expect(account.state.modelUsd).toBe(3);
  expect(account.state.lastFundingAt).toBe(3_600_000);
  expect(account.snapshot(100)).toMatchObject({ pnlUsd: -5.2, equityUsd: 994.8 });
  account.close();
});

test("approval enforces collateral, exposure, leverage, and allows exits after halt", () => {
  const account = new PaperAccount(":memory:", "BTC", { ...options, maxPositionUsd: 200 });
  expect(account.approve("buy", 0.9, 100, 1)).toBeNull();
  expect(account.approve("buy", 3, 100, 1)).toBe("max position");
  expect(account.approve("buy", 0.1, 100, 4)).toBe("max leverage");
  account.fill(fill("buy", 0.9, 100));
  expect(account.observe(80)).toBe("max loss");
  expect(account.state.halted).toBe(true);
  expect(account.approve("buy", 0.1, 80, 1)).toBe("halted");
  expect(account.approve("sell", 0.1, 80, 1)).toBeNull();
  account.close();
});

test("recovers state, halted flag, funding cursor, and rejects mismatched config", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-paper-"));
  const path = join(dir, "account.sqlite");
  try {
    const first = new PaperAccount(path, "BTC", options);
    first.fill(fill("buy", 0.5, 100));
    first.fund(0.01, 100, 1_000);
    first.observe(70);
    const expected = first.state;
    first.close();

    const resumed = new PaperAccount(path, "BTC", options);
    expect(resumed.state).toEqual(expected);
    resumed.close();
    expect(() => new PaperAccount(path, "BTC", { ...options, maxLeverage: 2 })).toThrow("config mismatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects corrupt state without resetting the database and audits redact secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-paper-"));
  const path = join(dir, "account.sqlite");
  try {
    const account = new PaperAccount(path, "BTC", options);
    account.record("note", { ok: true, apiKey: "do-not-store" });
    account.close();
    const db = new Database(path);
    const audit = db.query("SELECT payload FROM paper_audit WHERE kind = 'note'").get() as { payload: string };
    expect(audit.payload).not.toContain("do-not-store");
    db.query("UPDATE paper_meta SET value = ? WHERE key = 'state'").run("not-json");
    db.close();
    expect(() => new PaperAccount(path, "BTC", options)).toThrow("corrupt paper account metadata");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed financial validation does not partially mutate state", () => {
  const account = new PaperAccount(":memory:", "BTC", options);
  expect(() => account.fill(fill("buy", Number.NaN, 100))).toThrow();
  expect(account.state).toMatchObject({ positionSz: 0, feesUsd: 0, realizedUsd: 0 });
  account.close();
});

test("recent returns bounded durable audit rows", () => {
  const account = new PaperAccount(":memory:", "BTC", options);
  account.record("block", { n: 1 });
  account.record("block", { n: 2 });
  account.record("other", { n: 3 });
  expect(account.recent("block", 1).map((row) => row.payload)).toEqual([{ n: 2 }]);
  expect(account.recent("block", 2).map((row) => row.payload)).toEqual([{ n: 2 }, { n: 1 }]);
  expect(account.recent("block", 2_000)).toHaveLength(2);
  expect(account.recent().map((row) => row.kind)).toEqual(["other", "block", "block", "init"]);
  account.close();
});
