import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import type { Market } from "../src/market";
import type { Model, ModelDecision, TradeState } from "../src/model";
import { PaperAccount } from "../src/paper";
import { Trader } from "../src/trader";
import { TradeFeed } from "../src/trades";
import type { BlockEvent, Book, Quote, Side } from "../src/types";

const options = { initialUsd: 200, maxPositionUsd: 100, maxLossUsd: 20, maxLeverage: 1, makerFeeBps: 1.5, takerFeeBps: 4.5 };

class PaperMarket {
  coin = "BTC";
  pair = "BTC-USD";
  wallet = null;
  account = null;
  margin = { usdc: 0 };
  szDecimals = 5;
  maxLeverage = 40;
  fillPrints = [];
  assetCtx = { funding: 0.00001 };
  sends = 0;
  cancels = 0;
  book: Book = { ts: Date.now(), block: 1, mid: 100, bid: 99.9, ask: 100.1, spreadBps: 20, imbalance: 0, levels: { bids: [], asks: [] }, depthBps: {} };
  candleCloses() { return []; }
  refresh() { return Promise.resolve(); }
  readBook() { return this.book; }
  quoteSize() { return 0.4; }
  setLeverage(n: number) { return Promise.resolve(n); }
  async cancelResting() { this.cancels++; return []; }
  async send(side: Side, size: number, book: Book, cancel: number[], reduceOnly = false, taker = false): Promise<Quote> {
    this.sends++;
    const price = taker ? (side === "buy" ? book.ask * 1.0005 : book.bid * 0.9995) : (side === "buy" ? book.bid : book.ask);
    return { side, size, price, cancel, reduceOnly, taker, txHash: null, status: "sim", orderId: null, capped: false };
  }
}

class PaperModel implements Model {
  name = "jev";
  intent: ModelDecision["intent"] = "open";
  calls = 0;
  delayMs = 0;
  state: TradeState | null = null;
  async decide(state: TradeState): Promise<ModelDecision> {
    this.calls++;
    this.state = state;
    if (this.delayMs) await Bun.sleep(this.delayMs);
    return { action: this.intent === "open" ? "buy" : this.intent === "close" ? "sell" : "hold", intent: this.intent, bias: "long", leverage: 1,
      probabilities: { buy: 1, sell: 0, hold: 0, long: 1, short: 0, open: 1, close: 0 }, upIn10: 1, latencyMs: this.delayMs, inputTokens: 1000 };
  }
}

function desk(account = new PaperAccount(":memory:", "BTC", options)) {
  const market = new PaperMarket();
  const model = new PaperModel();
  const prints = new TradeFeed();
  const events: BlockEvent[] = [];
  const trader = new Trader(market as unknown as Market, model, (e) => events.push(e), undefined, undefined, account);
  trader.attachTradeFeed(prints);
  return { trader, market, model, prints, events, account };
}

test("paper trading needs no wallet balance and deducts fees and model costs", async () => {
  const { trader, model, prints, events, account } = desk();
  try {
    await trader.onBlock(1);
    await trader.settled();
    expect(model.state?.maxLeverage).toBe(1);
    prints.pushPrint({ block: 2, ts: Date.now() + 1, side: "sell", size: 4, price: 99.8 });
    model.intent = "hold";
    await trader.onBlock(2);
    await trader.settled();
    expect(account.state.positionSz).toBeCloseTo(0.4);
    expect(account.state.feesUsd).toBeGreaterThan(0);
    expect(account.state.modelUsd).toBeGreaterThan(0);
    expect(events.at(-1)?.accountValue).toBeCloseTo(account.snapshot(100).equityUsd);
    expect(events.at(-1)?.paper?.availableUsd).toBeLessThan(200);
    expect(JSON.stringify(events)).not.toContain('"inputTokens"');
    expect(account.recent("decision", 10)).toHaveLength(2);
    model.intent = "close";
    await trader.onBlock(3);
    await trader.settled();
    expect(account.state.positionSz).toBe(0);
    expect(account.state.realizedUsd).toBeLessThan(0);
  } finally { account.close(); }
});

test("historical prints cannot fill a newly created paper quote", async () => {
  const { trader, prints, model, account } = desk();
  try {
    await trader.onBlock(1);
    await trader.settled();
    prints.pushPrint({ block: 2, ts: Date.now() - 1000, side: "sell", size: 10, price: 99 });
    model.intent = "hold";
    await trader.onBlock(2);
    await trader.settled();
    expect(account.state.positionSz).toBe(0);
  } finally { account.close(); }
});

test("aggregate exposure is rejected independently of the Jev open decision", async () => {
  const { trader, market, events, account } = desk();
  try {
    account.fund(0, 100, Date.now());
    account.fill({ side: "buy", price: 100, size: 0.8, orderId: 1, txHash: null, simulated: true, feeUsd: 0 });
    await trader.onBlock(1);
    await trader.settled();
    expect(market.sends).toBe(0);
    expect(events.at(-1)?.decision?.intent).toBe("open");
    expect(events.at(-1)?.riskReason).toBe("max position");
  } finally { account.close(); }
});

test("max loss closes and halts the simulated position without calling the model", async () => {
  const { trader, market, model, events, account } = desk();
  try {
    account.fund(0, 100, Date.now());
    account.fill({ side: "buy", price: 100, size: 0.9, orderId: 1, txHash: null, simulated: true, feeUsd: 0 });
    market.book = { ...market.book, bid: 69.9, ask: 70.1, mid: 70 };
    await trader.onBlock(1);
    await trader.settled();
    expect(account.state.halted).toBe(true);
    expect(account.state.positionSz).toBe(0);
    expect(model.calls).toBe(0);
    expect(events.at(-1)?.paper?.halted).toBe(true);
    await trader.onBlock(2);
    await trader.settled();
    expect(model.calls).toBe(0);
  } finally { account.close(); }
});

test("stale books and expired decisions never send a quote", async () => {
  const { trader, market, model, events, account } = desk();
  const previous = config.maxDecisionAgeMs;
  try {
    market.book.ts = Date.now() - config.maxBookAgeMs - 1;
    await trader.onBlock(1);
    await trader.settled();
    expect(model.calls).toBe(0);
    market.book.ts = Date.now();
    config.maxDecisionAgeMs = 1;
    model.delayMs = 10;
    await trader.onBlock(2);
    await trader.settled();
    expect(market.sends).toBe(0);
    expect(events.at(-1)?.riskReason).toBe("Decision expired");
  } finally { config.maxDecisionAgeMs = previous; account.close(); }
});

test("restarting restores position, equity and history but never resurrects resting orders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-trader-recovery-"));
  const path = join(dir, "BTC.sqlite");
  try {
    const first = desk(new PaperAccount(path, "BTC", options));
    await first.trader.onBlock(1);
    await first.trader.settled();
    first.prints.pushPrint({ block: 2, ts: Date.now() + 1, side: "sell", size: 1, price: 99 });
    first.model.intent = "hold";
    await first.trader.onBlock(2);
    await first.trader.settled();
    const expected = first.account.state;
    first.account.close();
    const second = desk(new PaperAccount(path, "BTC", options));
    expect(second.account.state).toEqual(expected);
    expect(second.trader.lastBlock).toBe(2);
    expect(second.trader.history.some((e) => e.fill?.size === 0.1)).toBe(true);
    expect(second.trader.history.some((e) => e.quote?.status === "sim")).toBe(true);
    second.model.intent = "hold";
    await second.trader.onBlock(3);
    await second.trader.settled();
    expect(second.events.at(-1)?.position.size).toBeCloseTo(0.1);
    expect(second.events.at(-1)?.resting).toEqual({ bidSz: 0, askSz: 0 });
    second.account.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a decision that expires while setting leverage is rejected before sending", async () => {
  const { trader, market, events, account } = desk();
  const previous = config.maxDecisionAgeMs;
  try {
    config.maxDecisionAgeMs = 5;
    market.setLeverage = async (n) => { await Bun.sleep(15); return n; };
    await trader.onBlock(1);
    await trader.settled();
    expect(market.sends).toBe(0);
    expect(events.at(-1)?.riskReason).toBe("Decision expired");
  } finally { config.maxDecisionAgeMs = previous; account.close(); }
});

test("missing funding data closes exposure using a fresh book without asking Jev", async () => {
  const { trader, market, model, account } = desk();
  try {
    account.fund(0, 100, Date.now());
    account.fill({ side: "buy", price: 100, size: 0.4, orderId: 1, txHash: null, simulated: true, feeUsd: 0 });
    market.assetCtx = null as unknown as typeof market.assetCtx;
    await trader.onBlock(1);
    await trader.settled();
    expect(account.state.positionSz).toBe(0);
    expect(model.calls).toBe(0);
  } finally { account.close(); }
});
