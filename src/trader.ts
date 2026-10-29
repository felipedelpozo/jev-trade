import { config } from "./config";
import { bpsBetween, snapshotIndicators, venueFeatures } from "./indicators";
import type { Market } from "./market";
import { jevQuestions, marketFacing, type Model, type ModelDecision, type ModelUsage, type TradeState } from "./model";
import type { PaperAccount } from "./paper";
import { planQuote, type QuotePlan } from "./plan";
import { aggregateFills, emptySummary, takeLiveFills, takeSimFills, type Resting, type TradeFeed } from "./trades";
import type { BlockEvent, Book, Fill, PricePoint, Quote, Side, Timing, Totals } from "./types";

const emptyTotals = (): Totals => ({
  blocks: 0, decisions: 0, quotes: 0, fills: 0, reverted: 0, lateBlocks: 0,
  jevUsd: 0, gasSz: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlSz: 0, pnlPct: 0,
});

const JEV_PAUSE_MS = 30_000;

export function jevUnavailable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /402\b|no available TypeSafe API credits|insufficient credits/i.test(msg);
}

/**
 * Every tick: read the book and ask the model. A tick is late only when Jev
 * is still answering. Hyperliquid leverage/order I/O runs in the background
 * so a fill or quote does not stall the next decision.
 */
export class Trader {
  readonly history: BlockEvent[] = [];
  private mids: number[] = [];
  private busy = false;
  private lastBook: Book | null = null;
  private trades: TradeFeed | null = null;
  private orders = new Map<number, Resting>();
  private simId = 0;
  private sendSeq = 0;
  private exchangeTail: Promise<void> = Promise.resolve();
  private position = { sz: 0, costUsd: 0 };
  private totals: Totals = emptyTotals();
  private jevPauseUntil = 0;
  private riskReason: string | null = null;
  private fundingRate: number | null = null;
  private pendingFills = new Map<number, Fill>();

  constructor(
    private market: Market,
    private model: Model,
    private onEvent: (e: BlockEvent, timing?: Timing) => void,
    private onFill: (block: number, fill: Fill) => void = () => {},
    private onQuote: (block: number, quote: Quote) => void = () => {},
    private paper?: PaperAccount,
  ) {
    if (paper && market.wallet) throw new Error("Paper accounts cannot use a trading wallet");
    const recovered = new Map<number, BlockEvent>();
    for (const row of paper?.recent("event", config.historySize).reverse() ?? []) {
      const event = row.payload as BlockEvent;
      if (!event || event.coin !== market.coin || !Number.isSafeInteger(event.block) || !event.totals || !event.position) {
        throw new Error("Corrupt paper event history");
      }
      recovered.set(event.block, event);
    }
    this.history.push(...[...recovered.values()].sort((a, b) => a.block - b.block));
    const funding = paper?.recent("funding", 1)[0]?.payload as { hourlyRate?: number } | undefined;
    if (typeof funding?.hourlyRate === "number" && Number.isFinite(funding.hourlyRate)) this.fundingRate = funding.hourlyRate;
    const previous = this.history.at(-1);
    if (previous) this.totals = { ...previous.totals };
    this.syncFromPaper();
  }

  get lastBlock() { return Math.max(0, ...this.history.map((e) => e.block)); }

  async settled() { await this.exchangeTail; }

  get tape(): PricePoint[] {
    return this.market.chartPoints;
  }

  attachTradeFeed(feed: TradeFeed) {
    this.trades = feed;
  }

  async onBlock(block: number) {
    this.totals.blocks++;
    if (this.totals.blocks % 5 === 0) this.market.refresh().catch(() => {});
    if (this.busy) {
      this.markLate(block, this.lastBook);
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    try {
      const book = this.market.readBook();
      const readMs = performance.now() - t0;
      this.lastBook = book;
      this.syncFromVenue();
      this.riskReason = this.bookRisk(book);
      if (!this.riskReason && this.paper && this.market.assetCtx?.funding == null) {
        this.accrueFunding(book.mid);
        this.riskReason = "Funding data unavailable";
        this.emergencyClose(block, book);
      }
      if (this.riskReason) {
        this.enqueueStandDown();
        if (Number.isFinite(book.mid) && book.mid > 0) this.emit(block, book, null, null, false);
        else this.paper?.record("rejected", { block, reason: this.riskReason });
        return;
      }
      this.accrueFunding(book.mid);
      this.mids.push(book.mid);
      if (this.mids.length > 400) this.mids.shift();
      this.harvest();

      this.syncFromVenue();
      this.riskReason = this.paper?.observe(book.mid) ?? null;
      if (this.riskReason) {
        this.enqueueStandDown();
        this.emergencyClose(block, book);
        this.emit(block, book, null, null, false);
        return;
      }
      const timing = { readMs: Math.round(readMs), loopMs: 0 };
      if (Date.now() < this.jevPauseUntil) {
        this.markLate(block, book);
        return;
      }
      const state = this.buildState(block, book);
      const requestId = this.paper && this.model.name === "jev" ? crypto.randomUUID() : undefined;
      if (requestId) {
        const estimate = Math.ceil(JSON.stringify({ state: marketFacing(state), questions: jevQuestions(state) }).length / 4) * config.modelInputUsdPerMTok / 1e6;
        this.paper!.chargeModel(estimate, {
          requestId, provider: config.jevProvider, modelId: config.jevModelId,
          status: "pending", costSource: "estimated",
        });
      }
      const metered = (usage: ModelUsage) => {
        if (!requestId || !this.paper) return;
        const patch = {
          ...(usage.generationId !== undefined ? { generationId: usage.generationId } : {}),
          ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        };
        this.paper.updateModelCharge(requestId, patch);
        if (usage.inputTokens != null) this.paper.updateModelEstimate(requestId,
          (usage.inputTokens * config.modelInputUsdPerMTok + (usage.outputTokens ?? 0) * config.modelOutputUsdPerMTok) / 1e6);
      };
      let decision: ModelDecision;
      try {
        decision = await this.model.decide(state, { onUsage: metered });
      } catch (e) {
        const msg = (e as Error).message;
        if (jevUnavailable(e)) this.jevPauseUntil = Date.now() + JEV_PAUSE_MS;
        console.error(`tick ${block}:`, msg);
        if (this.paper) {
          if (requestId) this.paper.updateModelCharge(requestId, { status: "failed" });
          this.paper.record("model-error", { block, state, requestId, reason: "Provider request or response failed" });
        }
        this.markLate(block, book, timing);
        this.enqueueStandDown();
        return;
      }
      this.totals.decisions++;
      const cost = this.model.name === "jev" ? (
        decision.inputTokens * config.modelInputUsdPerMTok + (decision.outputTokens ?? 0) * config.modelOutputUsdPerMTok
      ) / 1e6 : 0;
      if (this.paper) {
        if (requestId) {
          metered({ generationId: decision.generationId,
            inputTokens: decision.audit ? decision.audit.usage.inputTokens : decision.inputTokens,
            outputTokens: decision.audit ? decision.audit.usage.outputTokens : decision.outputTokens });
          this.paper.updateModelCharge(requestId, { status: "success" });
        }
        this.paper.record("decision", { block, state, decision, requestId });
        this.syncFromPaper();
      } else this.totals.jevUsd += cost;
      const plan = planQuote({
        intent: decision.intent,
        bias: decision.bias,
        positionSz: this.position.sz,
        quoteSz: this.market.quoteSize(book.mid),
      });
      timing.loopMs = Math.round(performance.now() - t0);
      if (performance.now() - t0 > config.maxDecisionAgeMs) this.riskReason = "Decision expired";
      this.riskReason ??= this.bookRisk(this.market.readBook());
      this.riskReason ??= this.paper?.observe(book.mid) ?? null;
      if (this.riskReason) {
        this.enqueueStandDown();
        if (this.paper?.state.halted && !this.bookRisk(this.market.readBook())) this.emergencyClose(block, this.market.readBook());
      } else if (plan) this.enqueueQuote(block, decision, plan);
      else this.enqueueStandDown();
      this.emit(block, book, decision, null, false, timing);
    } catch (e) {
      console.error(`tick ${block}:`, (e as Error).message);
      this.enqueueStandDown();
      // A failed ledger write must stop the process before another financial event.
      if (this.paper) throw e;
    } finally {
      this.busy = false;
    }
  }

  private enqueueQuote(block: number, decision: ModelDecision, plan: QuotePlan) {
    const seq = ++this.sendSeq;
    const requestedAt = Date.now();
    this.exchangeTail = this.exchangeTail.catch(() => {}).then(async () => {
      if (seq !== this.sendSeq) return;
      let currentBook = this.market.readBook();
      const rejectUnsafe = async () => {
        currentBook = this.market.readBook();
        const risk = this.bookRisk(currentBook) ?? (Date.now() - requestedAt + decision.latencyMs > config.maxDecisionAgeMs ? "Decision expired" : null)
          ?? this.paper?.approve(plan.side, plan.size, currentBook.mid, decision.leverage, plan.reduceOnly);
        if (!risk) return false;
        this.riskReason = risk;
        this.paper?.record("rejected", { block, reason: risk, plan });
        await this.market.cancelResting();
        this.orders.clear();
        this.emit(block, currentBook, decision, null, false);
        return true;
      };
      if (await rejectUnsafe()) return;
      // An exit skips the leverage write: nothing about it depends on margin, and
      // the extra round trip is pure delay on the one order that has to land now.
      if (!plan.taker) {
        await this.market.setLeverage(decision.leverage);
        if (seq !== this.sendSeq) return;
      }
      if (await rejectUnsafe()) return;
      const cancel = [...this.orders.keys()].filter((id) => id > 0);
      const quote = await this.market.send(plan.side, plan.size, currentBook, cancel, plan.reduceOnly, plan.taker);
      if (seq !== this.sendSeq) return;
      this.applyPosted(block, quote, currentBook, decision.leverage);
    }).catch((error) => {
      console.error(`order ${block}:`, (error as Error).message);
      if (this.paper) throw error;
    });
  }

  /** Jev held. Pull the standing quote so an order it no longer wants cannot get hit. */
  private enqueueStandDown() {
    const seq = ++this.sendSeq;
    this.exchangeTail = this.exchangeTail.catch(() => {}).then(async () => {
      if (seq !== this.sendSeq) return;
      await this.market.cancelResting();
      if (seq !== this.sendSeq) return;
      this.orders.clear();
    });
  }

  private markLate(block: number, book: Book | null, timing?: Timing) {
    this.totals.lateBlocks++;
    if (book) this.emit(block, book, null, null, true, timing);
  }

  private applyPosted(block: number, quote: Quote, book: Book, leverage: number) {
    const e = this.history.find((h) => h.block === block);
    if (e) e.quote = quote;
    if (!quote.unchanged) this.totals.quotes++;
    if (quote.status === "reverted") this.totals.reverted++;
    if (quote.taker) {
      // An Ioc never rests. Live fills arrive on userFills; a dry run fills here.
      this.orders.clear();
      if (quote.status === "sim") this.simTakerFill(block, quote, book, leverage);
    } else if (quote.status === "sim") {
      this.orders.clear();
      this.orders.set(--this.simId, { side: quote.side, price: quote.price, size: quote.size, block, ts: Date.now() });
    } else if (quote.status === "placed" && quote.orderId != null) {
      this.orders.clear();
      this.orders.set(quote.orderId, { side: quote.side, price: quote.price, size: quote.size, block });
    }
    this.paper?.record("quote", { block, quote });
    if (e) this.paper?.record("event", e);
    this.onQuote(block, quote);
  }

  /** A dry-run exit crosses the touch, so it fills now rather than waiting on a print. */
  private simTakerFill(block: number, quote: Quote, book: Book, leverage: number) {
    const direction = quote.side === "buy" ? 1 : -1;
    const price = (quote.side === "buy" ? book.ask : book.bid) * (1 + direction * config.paperSlippageBps / 10000);
    if (quote.side === "buy" ? price > quote.price : price < quote.price) {
      quote.status = "reverted";
      this.paper?.record("rejected", { block, reason: "Slippage exceeds exit limit" });
      return;
    }
    const fill: Fill = {
      side: quote.side,
      size: quote.size,
      price,
      txHash: null,
      orderId: --this.simId,
      simulated: true,
      dir: quote.reduceOnly ? "close" : "open",
      feeUsd: price * quote.size * config.paperTakerFeeBps / 10000,
    };
    this.applyFill(fill, leverage);
    this.recordFill(block, fill);
  }

  private harvest() {
    if (!this.trades) return;
    const prints = this.trades.drainPrints();
    const fills = this.market.wallet ? takeLiveFills(this.orders, this.trades.drainFills()) : takeSimFills(this.orders, prints, config.paperFillParticipation, 10 ** -this.market.szDecimals);
    if (!fills.length) return;
    const byBlock = new Map<number, Fill[]>();
    for (const f of fills) {
      if (f.simulated) {
        f.feeUsd = f.size * f.price * config.paperMakerFeeBps / 10000;
        const reason = this.paper?.approve(f.side, f.size, f.price, 1);
        if (reason) {
          this.paper?.record("rejected-fill", { fill: f, reason });
          this.riskReason = reason;
          continue;
        }
      }
      this.applyFill(f);
      byBlock.set(f.block, [...(byBlock.get(f.block) ?? []), f]);
    }
    for (const [block, fs] of byBlock) this.recordFill(block, aggregateFills(fs));
    this.market.refresh().catch(() => {});
  }

  private recordFill(block: number, fill: Fill) {
    const e = this.history.find((h) => h.block === block);
    if (e) e.fill = fill;
    else this.pendingFills.set(block, fill);
    this.paper?.record("fill-event", { block, fill });
    if (e) this.paper?.record("event", e);
    this.onFill(block, fill);
  }

  private restingSz(side: Side) {
    let sz = 0;
    for (const o of this.orders.values()) if (o.side === side) sz += o.size;
    return sz;
  }

  private buildState(block: number, book: Book): TradeState {
    this.syncFromVenue();
    const m = this.mids, n = m.length, H = config.horizonBlocks;
    const ret = (k: number) => (n > k ? ((m[n - 1]! - m[n - 1 - k]!) / m[n - 1 - k]!) * 10_000 : 0);
    const sampled = m.slice(-H).filter((_, i, a) => (a.length - 1 - i) % 5 === 0);
    const lvl = (l: [number, number]) => `${l[0].toFixed(6)} x ${round(l[1], 1)}`;
    const depth: TradeState["depth"] = {};
    for (const [k, v] of Object.entries(book.depthBps)) depth[k + "bps"] = { bid: round(v.bid, 1), ask: round(v.ask, 1) };
    const posSz = this.position.sz;
    const a = this.market.account;
    const entry = this.entryPrice();
    const unrealized = a ? a.unrealizedUsd : this.unrealizedUsd(book.mid);
    const indicators = snapNums(snapshotIndicators(this.market.candleCloses(80), book.mid));
    const asset = snapNums(venueFeatures(this.market.assetCtx, book.mid));
    return {
      coin: this.market.coin,
      market: this.market.pair,
      tick: block,
      tickMs: config.tickMs,
      mid: book.mid,
      spreadBps: round(book.spreadBps, 2),
      bookImbalance: round(book.imbalance, 3),
      depth,
      book: { bids: book.levels.bids.map(lvl), asks: book.levels.asks.map(lvl) },
      returnsBps: { last1: round(ret(1), 2), last5: round(ret(5), 2), last20: round(ret(20), 2), last100: round(ret(100), 2) },
      recentMids: sampled.map((x) => x.toFixed(6)).join(" "),
      trades: this.trades ? this.trades.summary(H, block) : emptySummary(),
      recentTrades: (this.trades?.recent(10) ?? []).map((t) => `${t.block} ${t.side} ${round(t.size, 1)} @ ${t.price.toFixed(6)}`),
      position: {
        coin: this.market.coin,
        side: posSz > 0 ? "long" : posSz < 0 ? "short" : "flat",
        size: round(Math.abs(posSz), 8),
        notionalUsd: round(Math.abs(posSz) * book.mid, 4),
        entry,
        leverage: a?.leverage ?? this.paper?.state.leverage ?? null,
        liquidationPx: a?.liquidationPx ?? null,
        distanceBps: rnull(bpsBetween(entry, book.mid), 2),
        unrealizedUsd: round(unrealized, 4),
      },
      indicators,
      asset: { ...asset, maxLeverage: this.paper ? config.paperMaxLeverage : this.market.maxLeverage },
      maxLeverage: this.paper ? config.paperMaxLeverage : this.market.maxLeverage,
    };
  }

  private applyFill(f: Fill, leverage = 1) {
    if (f.size <= 0) return;
    if (this.market.account) return;
    this.totals.fills++;
    if (this.paper) {
      this.paper.fill(f, leverage);
      this.syncFromPaper();
      return;
    }
    const signed = f.side === "buy" ? f.size : -f.size;
    const p = this.position;
    if (p.sz === 0 || Math.sign(p.sz) === Math.sign(signed)) {
      p.costUsd += signed * f.price;
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(p.sz)) * Math.sign(signed);
      const entry = p.costUsd / p.sz;
      this.totals.realizedUsd += -closing * (f.price - entry);
      p.costUsd += closing * entry;
      const remainder = signed - closing;
      p.costUsd += remainder * f.price;
    }
    p.sz += signed;
    if (Math.abs(p.sz) < 1e-9) { p.sz = 0; p.costUsd = 0; }
    if (f.feeUsd) this.totals.gasUsd += f.feeUsd;
  }

  private syncFromVenue() {
    this.syncFromPaper();
    const a = this.market.account;
    if (!a) return;
    this.position.sz = a.positionSz;
    this.position.costUsd = a.entryPrice != null && a.positionSz ? a.entryPrice * a.positionSz : 0;
    this.totals.realizedUsd = a.realizedUsd;
    this.totals.gasUsd = a.feesUsd;
    this.totals.fills = this.market.fillPrints.length;
  }

  private syncFromPaper() {
    if (!this.paper) return;
    const p = this.paper.state;
    this.position = { sz: p.positionSz, costUsd: p.costUsd };
    this.totals.realizedUsd = p.realizedUsd;
    this.totals.gasUsd = p.feesUsd;
    this.totals.jevUsd = p.modelUsd;
  }

  private bookRisk(book: Book): string | null {
    if (![book.mid, book.bid, book.ask].every((n) => Number.isFinite(n) && n > 0) || book.bid >= book.ask) return "Invalid market book";
    if (book.ts != null && (!Number.isFinite(book.ts) || Date.now() - book.ts > config.maxBookAgeMs || book.ts > Date.now() + 1000)) return "Market data is stale";
    return null;
  }

  private accrueFunding(mid: number) {
    if (!this.paper) return;
    const rate = this.market.assetCtx?.funding;
    if (rate != null) this.fundingRate = rate;
    this.paper.fund(this.fundingRate ?? 0, mid, Date.now());
  }

  private emergencyClose(block: number, book: Book) {
    if (!this.paper || !this.position.sz) return;
    const side = this.position.sz > 0 ? "sell" : "buy";
    const price = (side === "buy" ? book.ask : book.bid) * (1 + (side === "buy" ? 1 : -1) * config.closeSlippageBps / 10000);
    this.orders.clear();
    this.simTakerFill(block, {
      side, size: Math.abs(this.position.sz), price, txHash: null, cancel: [], status: "sim", orderId: null,
      capped: false, reduceOnly: true, taker: true,
    }, book, this.paper.state.leverage);
  }

  private entryPrice() { return this.position.sz ? this.position.costUsd / this.position.sz : null; }
  private unrealizedUsd(mid: number) { return this.position.sz ? this.position.sz * (mid - this.entryPrice()!) : 0; }

  private emit(block: number, book: Book, decision: ModelDecision | null, quote: Quote | null, late: boolean, timing?: Timing) {
    this.syncFromVenue();
    const t = this.totals;
    t.gasSz = book.mid ? t.gasUsd / book.mid : 0;
    const a = this.market.account;
    const paper = this.paper?.snapshot(book.mid);
    const usage = this.paper?.usage;
    const unrealized = a ? a.unrealizedUsd : this.unrealizedUsd(book.mid);
    t.pnlUsd = paper?.pnlUsd ?? t.realizedUsd + unrealized - t.gasUsd;
    t.pnlSz = t.pnlUsd / book.mid;
    t.pnlPct = (t.pnlUsd / (paper?.initialUsd ?? (a?.accountValue || config.bankrollUsd))) * 100;
    const size = Math.abs(this.position.sz);
    const available = paper ? Math.max(0, paper.availableUsd - [...this.orders.values()].reduce((sum, o) => sum + o.price * o.size, 0)) : null;
    const event: BlockEvent = {
      coin: this.market.coin,
      block, ts: Date.now(), mid: book.mid, bestBid: book.bid, bestAsk: book.ask, spreadBps: round(book.spreadBps, 2),
      decision: late
        ? { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: 0, late: true }
        : decision && {
          action: decision.action,
          intent: decision.intent,
          bias: decision.bias,
          leverage: decision.leverage,
          probabilities: decision.probabilities,
          upIn10: decision.upIn10,
          latencyMs: Math.round(decision.latencyMs),
          late: false,
        },
      quote,
      fill: this.pendingFills.get(block) ?? null,
      resting: { bidSz: round(this.restingSz("buy"), this.market.szDecimals), askSz: round(this.restingSz("sell"), this.market.szDecimals) },
      position: {
        side: this.position.sz > 0 ? "long" : this.position.sz < 0 ? "short" : "flat",
        size,
        entryPrice: this.entryPrice(),
        leverage: a?.leverage ?? paper?.leverage ?? decision?.leverage ?? null,
        unrealizedUsd: round(unrealized, 6),
        unrealizedSz: round(unrealized / book.mid, 8),
      },
      totals: { ...t, jevUsd: round(t.jevUsd, 6), gasSz: round(t.gasSz, 8), gasUsd: round(t.gasUsd, 6), realizedUsd: round(t.realizedUsd, 6), pnlUsd: round(t.pnlUsd, 6), pnlSz: round(t.pnlSz, 8), pnlPct: round(t.pnlPct, 4) },
      accountValue: paper?.equityUsd ?? (a && Number.isFinite(a.accountValue) ? round(a.accountValue, 2) : null),
      withdrawable: paper ? available : (a && Number.isFinite(a.withdrawable) ? round(a.withdrawable, 2) : null),
      riskReason: this.riskReason,
      ...(paper ? { paper: {
        initialUsd: paper.initialUsd, equityUsd: paper.equityUsd, availableUsd: available!,
        feesUsd: paper.feesUsd, fundingUsd: paper.fundingUsd, modelUsd: paper.modelUsd,
        drawdownUsd: paper.drawdownUsd, maxPositionUsd: config.paperMaxPositionUsd, maxLossUsd: config.paperMaxLossUsd,
        halted: paper.halted, modelCostEstimated: (usage?.allTime.estimatedRequests ?? 0) > 0, usage,
        realizedUsd: paper.realizedUsd, unrealizedUsd: paper.unrealizedUsd, netPnlUsd: paper.pnlUsd,
      } } : {}),
    };
    const index = this.history.findIndex((e) => e.block === block);
    this.pendingFills.delete(block);
    if (index < 0) this.history.push(event);
    else this.history[index] = event;
    if (this.history.length > config.historySize) this.history.shift();
    this.paper?.record("event", event);
    this.onEvent(event, timing);
  }
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const rnull = (x: number | null, d: number) => (x == null || !Number.isFinite(x) ? null : round(x, d));

function snapNums<T extends Record<string, number | null>>(obj: T): T {
  const out = { ...obj };
  for (const [k, v] of Object.entries(out)) {
    (out as Record<string, number | null>)[k] = typeof v === "number" ? round(v, 6) : v;
  }
  return out;
}
