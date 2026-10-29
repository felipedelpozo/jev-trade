"use client";

import { useMemo, useState } from "react";
import Book from "@/components/Book/Book";
import DecisionPanel from "@/components/DecisionPanel/DecisionPanel";
import Feed from "@/components/Feed/Feed";
import FlowChart from "@/components/FlowChart/FlowChart";
import Header from "@/components/Header/Header";
import SleeveStrip from "@/components/SleeveStrip/SleeveStrip";
import { lastMeaningfulCall } from "@/lib/format";
import { portfolioBalance, portfolioPnl } from "@/lib/pnl";
import { useFeed } from "@/lib/useFeed";
import { aggregatePaper, type PaperMetrics } from "@/lib/paper";
import type { BlockEvent, Meta, SleeveFeed } from "@/lib/types";
import styles from "./page.module.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

const EMPTY: SleeveFeed = { events: [], tape: [], latest: null, avgLatencyMs: 0 };

function viewMeta(meta: Meta | null, coin: string): Meta | null {
  if (!meta) return null;
  const sleeve = meta.sleeves.find((s) => s.coin === coin);
  return {
    ...meta,
    coin,
    pair: sleeve?.pair ?? meta.pair,
    market: sleeve?.pair ?? meta.market,
    wallet: sleeve ? sleeve.wallet : meta.wallet,
    dryRun: sleeve?.dryRun ?? meta.dryRun,
  };
}

function SimulationSummary({ paper }: { paper: PaperMetrics }) {
  const usd = (value: number) => `${value < 0 ? "-" : "+"}$${Math.abs(value).toFixed(6)}`;
  const period = paper.usage?.allTime;
  const today = paper.usage?.today;
  const periodRows = [
    ["Requests", period?.requests ?? 0, today?.requests ?? 0],
    ["Input tokens", period?.inputTokens ?? 0, today?.inputTokens ?? 0],
    ["Output tokens", period?.outputTokens ?? 0, today?.outputTokens ?? 0],
    ["Confirmed Gateway cost", `$${(period?.reportedUsd ?? 0).toFixed(6)}`, `$${(today?.reportedUsd ?? 0).toFixed(6)}`],
    ["Unreconciled / estimated cost", `$${(period?.estimatedUsd ?? paper.modelUsd).toFixed(6)}`, `$${(today?.estimatedUsd ?? 0).toFixed(6)}`],
    ["Total AI cost", `$${(period?.totalUsd ?? paper.modelUsd).toFixed(6)}`, `$${(today?.totalUsd ?? 0).toFixed(6)}`],
  ] as const;
  return (
    <section className={styles.simulation} aria-label="Paper simulation and usage summary">
      <div className={styles.simulationTitle}>SIMULATION <span>(real market data, hypothetical trading)</span></div>
      <div className={styles.simulationStats}>
        <span><b>equity</b> {usd(paper.equityUsd)}</span>
        <span><b>available</b> {usd(paper.availableUsd)}</span>
        <span><b>drawdown</b> {usd(-paper.drawdownUsd)}</span>
      </div>
      <div className={styles.usageGrid}>
        <div>
          <h2>AI usage</h2>
          <table><caption className={styles.srOnly}>AI usage by period</caption><thead><tr><th scope="col">Metric</th><th scope="col">Today (UTC)</th><th scope="col">Since account start</th></tr></thead><tbody>
            {periodRows.map(([label, allTime, current]) => <tr key={label}><th scope="row">{label}</th><td>{typeof current === "number" ? current.toLocaleString() : current}</td><td>{typeof allTime === "number" ? allTime.toLocaleString() : allTime}</td></tr>)}
          </tbody></table>
          {period ? <div className={styles.usageMeta}>Confirmed {period.reportedRequests}/{period.requests} requests, unknown tokens {period.unknownTokenRequests}, pending {period.pending}, failed {period.failed}</div> : <div className={styles.usageMeta}>No usage ledger reported yet.</div>}
        </div>
        <div>
          <h2>Paper P&amp;L (account period)</h2>
          <div className={styles.pnlRows}>
            <span><b>Gross realized trade PnL</b> {usd(paper.grossRealizedUsd)}</span>
            <span><b>Unrealized open PnL</b> {usd(paper.unrealizedUsd)}</span>
            <span><b>Simulated fees</b> {usd(-paper.feesUsd)}</span>
            <span><b>Estimated funding</b> {usd(-paper.fundingUsd)}</span>
            <span><b>AI costs</b> {usd(-(period?.totalUsd ?? paper.modelUsd))}</span>
            <span className={styles.pnlTotal}><b>Net realized after all costs</b> {usd(paper.netRealizedAfterCostsUsd)}</span>
            <span className={styles.pnlTotal}><b>Net including open position</b> {usd(paper.netIncludingOpenUsd)}</span>
          </div>
          <div className={styles.usageMeta}>Trading figures are simulated. Earlier requests without billing IDs remain estimated. {period && period.estimatedRequests > 0 ? "Net result is provisional while AI charges remain unreconciled." : "Fees and funding remain simulation assumptions."}</div>
        </div>
      </div>
    </section>
  );
}

function RiskNotice({ latest }: { latest: BlockEvent | null }) {
  if (!latest?.paper?.halted && !latest?.riskReason) return null;
  const reason = latest.riskReason || "risk limits reached";
  return (
    <div className={styles.riskNotice} role="status">
      <b>{latest.paper?.halted ? "Simulation stopped" : "Order blocked"}:</b> {reason}.
    </div>
  );
}

export default function Page() {
  const feed = useFeed(API_URL);
  const [picked, setPicked] = useState<string | null>(null);

  const coins = useMemo(() => {
    if (feed.meta?.sleeves.length) return feed.meta.sleeves.map((s) => s.coin);
    return Object.keys(feed.byCoin);
  }, [feed.meta, feed.byCoin]);

  const coin = picked && coins.includes(picked) ? picked : coins[0] ?? "BTC";
  const sleeve = feed.byCoin[coin] ?? EMPTY;
  const meta = viewMeta(feed.meta, coin);

  const latestByCoin = useMemo(() => {
    const out: Record<string, BlockEvent | null> = {};
    for (const c of coins) out[c] = feed.byCoin[c]?.latest ?? null;
    return out;
  }, [coins, feed.byCoin]);

  const tapeByCoin = useMemo(() => {
    const out: Record<string, NonNullable<SleeveFeed["tape"]>> = {};
    for (const c of coins) out[c] = feed.byCoin[c]?.tape ?? [];
    return out;
  }, [coins, feed.byCoin]);

  const lastCallByCoin = useMemo(() => {
    const out: Record<string, string> = {};
    for (const c of coins) {
      const s = feed.byCoin[c];
      out[c] = lastMeaningfulCall(s?.events ?? [], s?.latest ?? null);
    }
    return out;
  }, [coins, feed.byCoin]);

  const pnl = useMemo(() => portfolioPnl(latestByCoin), [latestByCoin]);
  const balance = useMemo(() => portfolioBalance(latestByCoin), [latestByCoin]);
  const paper = useMemo(() => aggregatePaper(latestByCoin), [latestByCoin]);
  const hasBooks = coins.some((c) => latestByCoin[c]);
  const waiting = !feed.meta;

  return (
    <div className="shell">
      <Header
        connection={feed.connection}
        balance={hasBooks ? balance : null}
        unrealized={hasBooks ? pnl.unrealized : null}
        realized={hasBooks ? pnl.realized : null}
        dryRun={Boolean(feed.meta?.dryRun)}
        paper={paper}
      />
      {paper ? <SimulationSummary paper={paper} /> : null}
      <RiskNotice latest={sleeve.latest} />
      <SleeveStrip
        sleeves={feed.meta?.sleeves ?? []}
        latestByCoin={latestByCoin}
        lastCallByCoin={lastCallByCoin}
        selected={coin}
        onSelect={setPicked}
        waiting={waiting}
      />
      <div className={styles.main}>
        <div className={styles.left}>
          <div className={styles.chartWrap}>
            <FlowChart
              tape={sleeve.tape ?? []}
              events={sleeve.events}
              latest={sleeve.latest}
              meta={meta}
              onNeedMoreTape={feed.loadTape}
            />
          </div>
        </div>
        <div className={styles.right}>
          <DecisionPanel latest={sleeve.latest} meta={meta} waiting={waiting} />
          <Feed events={sleeve.events} meta={meta} waiting={waiting} />
        </div>
      </div>
      <Book
        sleeves={feed.meta?.sleeves ?? []}
        latestByCoin={latestByCoin}
        tapeByCoin={tapeByCoin}
        selected={coin}
        meta={meta}
        onSelect={setPicked}
        onNeedMoreTape={feed.loadTape}
        waiting={waiting}
      />
    </div>
  );
}
