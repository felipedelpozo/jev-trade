import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clipFor, readSnapshot, isNewDecision, visualState, health, remaining, chartPath, intentProbability } from "../web/public/black-box/core.js";

const snapshot = () => ({ dryRun: true, wallet: null, startedAt: 1, revision: "test", tickMs: 30000,
  sleeves: [{ wallet: null, dryRun: true }], latestByCoin: { BTC: { ts: 100000, block: 10, mid: 77000,
    decision: { intent: "hold", late: false, probabilities: { hold: .7 } }, riskReason: null,
    paper: { netPnlUsd: -2.5, modelUsd: 1, equityUsd: 197.5, halted: false,
      usage: { since: 1, allTime: { requests: 10 } } } } } });

describe("Black Box read-only presentation", () => {
  test("rejects non-paper, wallets and incomplete financial reads", () => {
    const a = snapshot(); a.dryRun = false;
    expect(() => readSnapshot(a)).toThrow();
    const b = { ...snapshot(), wallet: "wallet" };
    expect(() => readSnapshot(b)).toThrow();
    const c = snapshot(); c.latestByCoin.BTC.paper.netPnlUsd = NaN;
    expect(() => readSnapshot(c)).toThrow();
    expect(readSnapshot(snapshot()).paper.netPnlUsd).toBe(-2.5);
  });
  test("only a new confirmed decision in the same runtime/account triggers evaluation", () => {
    const previous = readSnapshot(snapshot());
    const next = { ...previous, requests: 11, block: 11 };
    expect(isNewDecision(previous, next)).toBe(true);
    expect(isNewDecision(null, next)).toBe(false);
    expect(isNewDecision(previous, { ...next, startedAt: 2 })).toBe(false);
    expect(isNewDecision(previous, { ...next, accountSince: 2 })).toBe(false);
    expect(isNewDecision(previous, { ...next, decision: null })).toBe(false);
    expect(isNewDecision(previous, { ...previous, paper: { ...previous.paper, modelUsd: .8 } })).toBe(false);
  });
  test("HOLD stays animated as wait and confirmed decisions have a finite evaluation presentation", () => {
    const row = readSnapshot(snapshot());
    expect(visualState(row, 101000, 106000)).toBe("evaluate");
    expect(visualState(row, 107000, 106000)).toBe("wait");
    row.decision.intent = "open";
    expect(visualState(row, 107000, 106000)).toBe("observe");
    expect(visualState(row, 107000, 110000, false)).toBe("wait");
    expect(visualState({ ...row, riskReason: "Daily AI budget reached" }, 107000, 110000)).toBe("wait");
  });
  test("disconnections, stale data and budget pauses never imply fresh decisions or a running countdown", () => {
    const row = readSnapshot(snapshot());
    expect(health(row, 200001, true).kind).toBe("stale");
    expect(remaining(row, 200001, true)).toBeNull();
    expect(remaining(row, 101000, false)).toBeNull();
    expect(remaining(row, 110000, true)).toBe(20000);
    const pause = { ...row, riskReason: "Daily AI budget reached" };
    expect(health(pause, 101000, true).label).toBe("IA en pausa");
    expect(remaining(pause, 101000, true)).toBeNull();
  });
  test("a late/invalid response has no displayed probability", () => {
    const raw = snapshot(); raw.latestByCoin.BTC.decision.late = true;
    expect(readSnapshot(raw).decision).toBeNull();
    expect(intentProbability(readSnapshot(raw))).toBe("—");
  });
  test("every directed state pair has a real media asset", () => {
    for (const from of ["observe", "evaluate", "wait"]) for (const to of ["observe", "evaluate", "wait"]) {
      const path = clipFor(from, to);
      expect(existsSync(join(import.meta.dir, "../web/public", path))).toBe(true);
    }
    expect(() => clipFor("invalid")).toThrow();
  });
  test("price chart uses observation timestamps and ignores invalid prices", () => {
    expect(chartPath([{ ts: 1, mid: 10 }, { ts: 3, mid: 12 }], 100, 100)).toBe("M0.0,92.0 L100.0,8.0");
    expect(chartPath([{ ts: 1, mid: 10 }, { ts: 1, mid: 12 }])).toBe("");
    expect(chartPath([{ ts: 1, mid: NaN }])).toBe("");
  });
  test("broadcast is independent from Orbit and has no order or inference mutation", () => {
    const base = join(import.meta.dir, "../web/public/black-box");
    const app = readFileSync(join(base, "app.js"), "utf8");
    expect(app).toContain("fetch('/api'");
    expect(app).toContain("/api/events?lite=1");
    expect(app).not.toMatch(/method:\s*['"](?:POST|PUT|DELETE)/);
    expect(app).not.toContain("Math.random");
    expect(app).toContain("Mercado real. Operaciones simuladas.");
  });
});
