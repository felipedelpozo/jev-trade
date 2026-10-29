import { expect, test } from "bun:test";
import type { GatewayGenerationInfo } from "@ai-sdk/gateway";
import { reconcileGatewayUsage, type BillingRetries } from "../src/billing";
import { PaperAccount } from "../src/paper";

function account() {
  const paper = new PaperAccount(":memory:", "BTC", {
    initialUsd: 200, maxPositionUsd: 100, maxLossUsd: 20, maxLeverage: 1, makerFeeBps: 1.5, takerFeeBps: 4.5,
  });
  paper.chargeModel(0.001, { requestId: "local-1", generationId: "gen_example1234", provider: "gateway", modelId: "typesafe-ai/jev", status: "success", costSource: "estimated" });
  return paper;
}

function info(overrides: Partial<GatewayGenerationInfo> = {}): GatewayGenerationInfo {
  return {
    id: "gen_example1234", totalCost: 0.0002, upstreamInferenceCost: 0, usage: 0.0002,
    createdAt: "2026-10-29T11:00:00Z", model: "typesafe-ai/jev", isByok: false,
    providerName: "typesafe-ai", streamed: false, finishReason: "stop", latency: 100, generationTime: 200,
    promptTokens: 1500, completionTokens: 100, reasoningTokens: 0, cachedTokens: 0,
    cacheCreationTokens: 0, billableWebSearchCalls: 0, ...overrides,
  };
}

test("official Gateway cost replaces the estimate once, including an actual zero", async () => {
  const paper = account();
  const retries: BillingRetries = new Map();
  let calls = 0;
  const lookup = async () => { calls++; return info({ totalCost: 0 }); };
  try {
    expect(await reconcileGatewayUsage(paper, retries, lookup)).toBe(1);
    expect(await reconcileGatewayUsage(paper, retries, lookup)).toBe(0);
    expect(calls).toBe(1);
    expect(paper.state.modelUsd).toBe(0);
    expect(paper.usage.allTime).toMatchObject({ requests: 1, reportedRequests: 1, estimatedRequests: 0, inputTokens: 1500, outputTokens: 100 });
  } finally { paper.close(); }
});

test("unavailable billing details remain estimated and retry with backoff", async () => {
  const paper = account();
  const retries: BillingRetries = new Map();
  let calls = 0;
  const lookup = async () => { calls++; if (calls === 1) throw new Error("404"); return info(); };
  try {
    expect(await reconcileGatewayUsage(paper, retries, lookup, 1000)).toBe(0);
    expect(await reconcileGatewayUsage(paper, retries, lookup, 1001)).toBe(0);
    expect(calls).toBe(1);
    expect(paper.state.modelUsd).toBe(0.001);
    expect(await reconcileGatewayUsage(paper, retries, lookup, 100000)).toBe(1);
    expect(paper.state.modelUsd).toBeCloseTo(0.0002);
  } finally { paper.close(); }
});

test("BYOK, mismatched generation IDs and invalid costs cannot be marked confirmed", async () => {
  for (const response of [info({ isByok: true, totalCost: 0 }), info({ id: "other" }), info({ totalCost: NaN })]) {
    const paper = account();
    try {
      expect(await reconcileGatewayUsage(paper, new Map(), async () => response)).toBe(0);
      expect(paper.usage.allTime.reportedRequests).toBe(0);
      expect(paper.state.modelUsd).toBe(0.001);
    } finally { paper.close(); }
  }
});
