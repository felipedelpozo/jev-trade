import { config } from "./config";
import { Feed } from "./feed";
import { Market } from "./market";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PaperAccount } from "./paper";
import { reconcileGatewayUsage, type BillingRetries } from "./billing";
import { createModel } from "./model";
import { loadSleeves } from "./sleeves";
import { startServer, type SleeveView } from "./server";
import { Trader } from "./trader";
import type { BlockEvent, Fill, Meta, Quote, Timing } from "./types";

const specs = loadSleeves();
if (!specs.length) throw new Error("no sleeves");

const views: SleeveView[] = [];
const first = specs[0]!;
const meta: Meta = {
  model: config.model,
  wallet: null,
  dryRun: config.dryRun || specs.every((s) => !s.privateKey),
  market: first.pair,
  startedAt: Date.now(),
  venue: "hyperliquid",
  coin: first.coin,
  pair: first.pair,
  explorerTx: config.explorerTx,
  tickMs: config.tickMs,
  sleeves: [],
  revision: process.env.APP_REVISION ?? "development",
};

let server: ReturnType<typeof startServer> | undefined;
const starters: Array<() => void> = [];
const accounts: PaperAccount[] = [];
const traders: Trader[] = [];
const inFlight = new Set<Promise<void>>();
let shuttingDown = false;

for (const spec of specs) {
  const model = createModel();
  let paper: PaperAccount | undefined;
  if (config.dryRun || !spec.privateKey) {
    mkdirSync(config.paperDir, { recursive: true, mode: 0o700 });
    paper = new PaperAccount(join(config.paperDir, `${encodeURIComponent(spec.coin)}.sqlite`), spec.coin, {
      initialUsd: config.bankrollUsd, maxPositionUsd: config.paperMaxPositionUsd,
      maxLossUsd: config.paperMaxLossUsd, maxLeverage: config.paperMaxLeverage,
      makerFeeBps: config.paperMakerFeeBps, takerFeeBps: config.paperTakerFeeBps,
    });
    accounts.push(paper);
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const feed = new Feed(spec.coin);
      feed.onPrice = (book) => {
        server?.broadcastPrice(spec.coin, {
          ts: Date.now(),
          mid: book.mid,
          bestBid: book.bid,
          bestAsk: book.ask,
          spreadBps: book.spreadBps,
        });
      };
      await feed.connect();
      const market = new Market(feed, spec);
      await market.init();
      const trader = new Trader(
        market,
        model,
        onEvent(spec.coin),
        onFill(spec.coin),
        onQuote(spec.coin),
        paper,
      );
      feed.tick = trader.lastBlock;
      feed.trades.setTick(feed.tick);
      trader.attachTradeFeed(feed.trades);
      traders.push(trader);
      market.onVenueFill = (p) => {
        server?.broadcastFill(spec.coin, 0, {
          side: p.side,
          size: p.size,
          price: p.price,
          txHash: p.hash ?? null,
          orderId: 0,
          simulated: false,
          dir: p.dir,
        }, p.ts);
      };
      views.push({ coin: spec.coin, history: () => trader.history, tape: () => trader.tape, usage: () => paper?.usage ?? null });
      meta.sleeves.push({ coin: spec.coin, pair: spec.pair, label: spec.label, wallet: market.address, dryRun: !market.wallet });
      if (spec === first) {
        meta.wallet = market.address;
        meta.coin = spec.coin;
        meta.pair = spec.pair;
        meta.market = spec.pair;
      }
      starters.push(() => feed.start((tick) => {
        if (shuttingDown) return;
        const task = trader.onBlock(tick);
        inFlight.add(task);
        task.then(() => inFlight.delete(task), (error) => {
          console.error("Fatal account error:", (error as Error).message);
          process.exit(1);
        });
      }));
      console.log(`sleeve ${spec.label} ${spec.pair} ${config.dryRun || !spec.privateKey ? "DRY RUN" : market.address}`);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(1000 * (attempt + 1));
    }
  }
  if (lastErr) console.error(`sleeve ${spec.label} failed: ${(lastErr as Error).message}`);
}

if (!views.length) throw new Error("no sleeves started");

server = startServer(meta, views);
for (const start of starters) start();

const billingRetries: BillingRetries = new Map();
let billingBusy = false;
let billingJob = Promise.resolve();
const pollBilling = () => {
  if (shuttingDown || billingBusy || config.model !== "jev" || config.jevProvider !== "gateway") return;
  billingBusy = true;
  billingJob = (async () => {
    for (const account of accounts) await reconcileGatewayUsage(account, billingRetries);
  })().catch((error: unknown) => {
    console.error("Fatal billing ledger error:", error instanceof Error ? error.message : "unknown error");
    process.exit(1);
  }).finally(() => { billingBusy = false; });
};
const billingTimer = setInterval(pollBilling, 15000);
pollBilling();

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(billingTimer);
  setTimeout(() => process.exit(1), 10000).unref();
  await Promise.all(inFlight);
  await Promise.all(traders.map((trader) => trader.settled()));
  await billingJob;
  for (const account of accounts) account.close();
  process.exit(0);
});

console.log(`jev-trade ${meta.sleeves.map((s) => s.label).join(" ")} model=${meta.model}${config.model === "jev" ? ` ${config.jevProvider}` : ""} tick ${config.tickMs}ms price ${config.priceMs}ms quote $${config.quoteUsd} :${config.port}`);

function onEvent(coin: string) {
  return (e: BlockEvent, t?: Timing) => {
    server?.broadcast(e);
    if (e.decision && !e.decision.late) {
      const d = e.decision;
      const q = e.quote;
      // A hold applies neither bias nor leverage, and an exit skips the leverage write.
      const lev = d.intent === "open" && d.leverage != null ? ` ${d.leverage}x` : "";
      const call = d.intent === "hold" ? "hold" : d.intent && d.bias ? `${d.intent} ${d.bias}${lev}` : d.action;
      const order = q && ` ${q.side.toUpperCase()} ${q.size} @ ${q.price}${q.taker ? " cross" : ""}${q.reduceOnly ? " reduce" : ""}${q.unchanged ? " unchanged" : q.status === "sim" ? " (sim)" : ` ${q.status}`}`;
      const quote = order || (d.intent === "hold" ? " NO ORDER" : "");
      console.log(`${coin} #${e.block} ${e.mid} ${call} ${d.latencyMs}ms${quote} pnl $${e.totals.pnlUsd}${t ? ` loop ${t.loopMs}ms` : ""}`);
    }
  };
}

function onFill(coin: string) {
  return (block: number, fill: Fill) => {
    const kind = fill.dir === "open" ? "OPEN " : fill.dir === "close" ? "CLOSE " : fill.dir === "flip" ? "FLIP " : "";
    console.log(`${coin} #${block} ${kind}FILL ${fill.side} ${fill.size} @ ${fill.price}${fill.simulated ? " (sim)" : ""}`);
  };
}

function onQuote(coin: string) {
  return (block: number, quote: Quote) => {
    server?.broadcastQuote(coin, block, quote);
    if (quote.status !== "placed") console.log(`${coin} #${block} ${quote.status.toUpperCase()} ${quote.side} @ ${quote.price}`);
  };
}
