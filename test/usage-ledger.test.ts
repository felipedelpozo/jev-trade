import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperAccount, type ModelCharge, type PaperOptions } from "../src/paper";

const options: PaperOptions = {
  initialUsd: 100,
  maxPositionUsd: 500,
  maxLossUsd: 10,
  makerFeeBps: 1,
  takerFeeBps: 10,
  maxLeverage: 3,
};

function usage(requestId: string, at: number, overrides: Partial<ModelCharge> = {}): ModelCharge {
  return {
    requestId,
    provider: "gateway",
    modelId: "jev-test",
    status: "success",
    inputTokens: 10,
    outputTokens: 4,
    costSource: "reported",
    at,
    ...overrides,
  };
}

test("aggregates actual, estimated, pending, and failed usage across UTC dates", () => {
  const account = new PaperAccount(":memory:", "BTC", options);
  const dayStart = Date.UTC(2026, 9, 29);
  account.chargeModel(0, usage("reported-zero", dayStart, { inputTokens: 12, outputTokens: 0 }));
  account.chargeModel(1.25, usage("estimated-pending", dayStart + 1_000, { costSource: "estimated", status: "pending", generationId: "gen-pending" }));
  account.updateModelCharge("estimated-pending", { status: "failed", outputTokens: 7 });
  account.chargeModel(2, usage("yesterday", dayStart - 1, { costSource: "estimated", inputTokens: 2, outputTokens: 3 }));

  const balance = account.usageBalance(dayStart + 10_000);
  expect(balance.since).toBe(dayStart - 1);
  expect(balance.today).toMatchObject({
    requests: 2,
    pending: 0,
    successful: 1,
    failed: 1,
    unknownStatus: 0,
    inputTokens: 22,
    outputTokens: 7,
    reportedUsd: 0,
    estimatedUsd: 1.25,
    totalUsd: 1.25,
    reportedRequests: 1,
    estimatedRequests: 1,
    unknownTokenRequests: 0,
  });
  expect(balance.allTime).toMatchObject({ requests: 3, successful: 2, failed: 1, reportedUsd: 0, estimatedUsd: 3.25, totalUsd: 3.25 });
  expect(JSON.stringify(balance)).not.toContain("reported-zero");
  expect(account.state.modelUsd).toBe(balance.allTime.totalUsd);
  account.close();
});

test("reconciles charges, updates late metadata, queues known generations, and is idempotent", () => {
  const account = new PaperAccount(":memory:", "BTC", options);
  const charge = usage("request-1", Date.UTC(2026, 9, 29), { costSource: "estimated", status: "pending", generationId: "generation-1" });
  account.chargeModel(3, charge);
  account.chargeModel(3, charge);
  expect(account.state.modelUsd).toBe(3);
  expect(account.pendingModelCharges()).toEqual([{ requestId: "request-1", generationId: "generation-1" }]);
  account.updateModelCharge("request-1", { status: "success", inputTokens: 20, outputTokens: 8 });
  account.reconcileModelCharge("request-1", 0.75);
  account.reconcileModelCharge("request-1", 0.75);
  expect(account.state.modelUsd).toBe(0.75);
  expect(account.pendingModelCharges()).toEqual([]);
  expect(account.usage.allTime).toMatchObject({ requests: 1, successful: 1, reportedRequests: 1, estimatedRequests: 0, reportedUsd: 0.75, totalUsd: 0.75 });
  expect(() => account.chargeModel(4, { ...charge, provider: "other" })).toThrow("conflicting");
  expect(() => account.reconcileModelCharge("request-1", 0.8)).toThrow("conflicting");
  account.close();
});

test("keeps legacy model rows charged through restart and counts them as estimated unknown usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-usage-"));
  const path = join(dir, "account.sqlite");
  try {
    const first = new PaperAccount(path, "BTC", options);
    first.chargeModel(2);
    first.close();

    const resumed = new PaperAccount(path, "BTC", options);
    expect(resumed.usage.allTime).toMatchObject({ requests: 1, estimatedUsd: 2, totalUsd: 2, unknownStatus: 1, unknownTokenRequests: 1 });
    expect(resumed.state.modelUsd).toBe(resumed.usage.allTime.totalUsd);
    resumed.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validates bounded metadata, token counts, and timestamps", () => {
  const account = new PaperAccount(":memory:", "BTC", options);
  const base = usage("valid", Date.UTC(2026, 9, 29));
  expect(() => account.chargeModel(1, { ...base, inputTokens: 1.5 })).toThrow();
  expect(() => account.chargeModel(1, { ...base, at: -1 })).toThrow();
  expect(() => account.chargeModel(1, { ...base, requestId: "x".repeat(257) })).toThrow();
  expect(() => account.usageBalance(Number.MAX_SAFE_INTEGER)).toThrow();
  account.close();
});

test("reconciling the final floating-point estimate to zero keeps modelUsd at zero", () => {
  const account = new PaperAccount(":memory:", "BTC", options);
  const at = Date.UTC(2026, 9, 29);
  for (const [id, amount] of [["a", 0.1], ["b", 0.2], ["c", 0.3]] as const) {
    account.chargeModel(amount, usage(id, at, { costSource: "estimated", status: "pending" }));
  }
  account.reconcileModelCharge("a", 0);
  account.reconcileModelCharge("b", 0);
  account.reconcileModelCharge("c", 0);
  expect(account.state.modelUsd).toBe(0);
  expect(account.usage.allTime.totalUsd).toBe(0);
  account.close();
});
