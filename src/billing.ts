import { createGateway, type GatewayGenerationInfo } from "@ai-sdk/gateway";
import type { PaperAccount } from "./paper";

type Lookup = (params: { id: string }) => Promise<GatewayGenerationInfo>;
export type BillingRetries = Map<string, { attempts: number; nextAt: number }>;

const billingGateway = createGateway({
  fetch: Object.assign(
    (url: string | URL | Request, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) }),
    { preconnect: fetch.preconnect },
  ),
});

/** Read-only billing lookups, never additional model evaluations. */
export async function reconcileGatewayUsage(
  account: PaperAccount,
  retries: BillingRetries,
  lookup: Lookup = (params) => billingGateway.getGenerationInfo(params),
  now = Date.now(),
): Promise<number> {
  const pending = account.pendingModelCharges(1000)
    .filter((row) => (retries.get(row.requestId)?.nextAt ?? 0) <= now).slice(0, 5);
  let settled = 0;
  for (const row of pending) {
    let info: GatewayGenerationInfo | undefined;
    try { info = await lookup({ id: row.generationId }); } catch { /* Eventual consistency and outages keep the estimate visible. */ }
    if (!info || info.id !== row.generationId || info.isByok || !Number.isFinite(info.totalCost) || info.totalCost < 0) {
      const attempts = (retries.get(row.requestId)?.attempts ?? 0) + 1;
      retries.set(row.requestId, { attempts, nextAt: now + Math.min(3600000, 15000 * 2 ** Math.min(attempts, 8)) });
      continue;
    }
    const tokens: { inputTokens?: number; outputTokens?: number } = {};
    if (Number.isSafeInteger(info.promptTokens) && info.promptTokens >= 0) tokens.inputTokens = info.promptTokens;
    if (Number.isSafeInteger(info.completionTokens) && info.completionTokens >= 0) tokens.outputTokens = info.completionTokens;
    account.updateModelCharge(row.requestId, tokens);
    account.reconcileModelCharge(row.requestId, info.totalCost);
    retries.delete(row.requestId);
    settled++;
  }
  return settled;
}
