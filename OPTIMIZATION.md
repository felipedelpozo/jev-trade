# Autonomous paper-trading optimization

The owner authorized autonomous investigation, implementation, validation and
deployment of improvements to this fork and its existing Jev Trade service.
The objective is better **simulated net PnL after trading and model costs**.
No result or schedule guarantees profitability.

## Operating bounds

- Work only on `felipedelpozo/jev-trade` and the existing Jev Trade Dokploy service.
- Keep `DRY_RUN=true`, BTC public Hyperliquid mainnet data, no wallet credentials,
  $200 starting capital, $100 position limit, 1x leverage and $20 loss/drawdown halt.
- Keep `DAILY_AI_BUDGET_USD` at or below $0.60 per UTC day. The bot reserves $0.001
  before a new request and pauses if recorded cost plus reserve exceeds the cap.
  A budget pause cancels quotes and flattens simulated exposure at a fresh book;
  the next UTC day can resume. Billing can arrive late, and estimates or an
  unexpectedly expensive request mean this is not an invoice guarantee.
- Never increase inference frequency above one request per minute in total.
  Experiments must use that existing request stream, not extra paid evaluations.
  Slower cadence is allowed as an explicitly recorded experiment.
- Never enable live orders, change wallet/credential access, reload credits, buy
  services, add paid providers or raise budget/risk limits without a new instruction.
- Preserve the account and `jev-trade-paper-data` volume. Never reset the balance,
  remove histories, use Fresh Volumes or `docker compose down -v` to improve results.
- A risk halt is durable. Investigate it; do not clear it to continue an experiment.

## One scheduled optimization cycle

1. Read this file, the current repository instructions, Git status, the current
   deployment guide and previous experiment records. Fetch the fork before work
   and preserve unrelated local changes. Use a clean isolated checkout if needed.
2. Read `/api`, `/api/usage` and a bounded `/api/history` snapshot. Run
   `bun run optimize:report`. The report makes no model requests. Verify actual
   revision, simulation, wallet absence, limits and freshness before changing code.
3. Append a UTC observation and save state atomically in the monitoring directory.
   Keep all previous observations. Distinguish restarts, strategy versions and
   experiment windows. The HTTP history is limited to 1,000 events per sleeve;
   preserve useful observations before they disappear. It cannot prove a week of
   performance at a one-minute cadence on its own.
4. Choose one bounded hypothesis, or explicitly decide that no change is justified.
   Prefer concrete defects, input-quality corrections, lower cost and execution
   realism before adding models or strategy complexity. Record the evidence,
   baseline, expected effect, validation and rollback conditions **before** changing it.
5. Implement the smallest complete change with targeted regression tests. Keep
   financial arithmetic and limits in code. Jev retains the action decision and
   HOLD. Never force activity or lower confidence thresholds just to get fills.
6. Run affected tests, `bun test test`, `bun run typecheck`, and the production build
   when relevant. Review the diff for financial correctness, private data and
   unintended changes. Independent review is useful for money or execution changes.
7. Commit and push a passing change to the owner's fork. Routine changes and
   paper-only deployments are authorized; do not ask again for those actions.
   Use a versioned paper trial for strategy hypotheses whose benefit is unproven.
8. Deploy only to the existing service using the procedure below. Verify completion
   and record the resulting revision, account continuity and ordinary Jev ticks.
9. Record the decision, outcome, next observation window and next hypothesis in
   `outputs/jev-trade/optimization/experiments.jsonl`. Keep a concise status file.
   Notify this chat for deployed improvements, meaningful evidence, failures,
   rollbacks or a required user action. Stay quiet when nothing actionable changed.

## Evidence and experiment discipline

- Compare **net** realized and marked PnL, fees, funding, confirmed/estimated AI
  charges, exposure, drawdown, execution quality, latency and data coverage.
- Net PnL already includes model costs. Billing reconciliation replaces an
  estimate and may change PnL without a trade; it is not trading alpha.
- Track confirmed billing coverage. Old calls without generation IDs remain
  estimated. Record missing data instead of filling it with assumed zeros.
- Separate attempted closes from completed positions, mark-to-market gains from
  realized gains, and sampled drawdown from continuous-market drawdown.
- A zero-return, no-trade account is an economic reference. A mark-only buy-and-hold
  calculation that excludes costs is not an equivalent executed strategy.
- More trades, a higher hit rate or a larger gross PnL do not establish improvement.
- Use chronological held-out periods and forward paper observations. Replay can
  validate accounting and an existing decision policy; old model answers cannot
  establish how a different prompt or model would have answered.
- Before calling a strategy better, require sufficient distinct closed positions,
  market regimes and cost coverage. Seven days and 30 observed closed positions
  are only a minimum screening heuristic, not statistical significance or a
  guarantee. Truncated/sparse history cannot satisfy that screen by date span alone.
- A before/after comparison across different market periods is observational,
  not a causal A/B test. If a proper comparison cannot be funded within the existing
  request stream, prepare it and collect data; do not invent a backtest result.
- Mechanical cost reductions and verified bug fixes can ship before that strategy
  screen, with measured impact and any behavior uncertainty recorded.
- Change one strategy hypothesis at a time. Keep the previous revision and
  experiment baseline. Avoid tuning many thresholds on the same small sample.

## Deployment and recovery

Workspace: `/Users/felipedelpozo/Documents/Codex/2026-10-29/ins`.
Repository: `work/jev-trade`.
Deployment guide and Compose: `outputs/jev-trade/DEPLOY.md` and
`outputs/jev-trade/docker-compose.raw-git.yml`.
Service: `https://jev-trade.jungloria.com`, Dokploy `https://jungloria.com`.

- Archive the previous pinned Compose and a public API snapshot before rollout.
- Update both Git build contexts and `APP_REVISION` to the tested commit. Preserve
  all environment references, volume identity, network isolation and domain routing.
  Keep the Gateway key in Dokploy; do not read, print or embed it.
- Financial account settings are fingerprinted. Do not change them in place;
  isolate an experiment without altering the current account if necessary.
- Use normal Deploy, never Fresh Volumes. Check the public revision, healthy
  containers, null wallets, limits, retained account/history and successful normal
  model decisions. Billing lookup is a read, not permission for more inference.
- Allow at most two ordinary decision intervals to confirm model/parser behavior.
  Roll back the source pin to the previous verified revision for a newly introduced
  functional regression. Never delete the volume, rewrite its schema backwards or
  reset finances during rollback; plan compatible migrations before deployment.
- If access expires, investigate and prepare the tested change. Ask only for the
  missing login/access or a genuine decision outside these authorized bounds.
- Do not keep a failed deployment running, suppress errors or label a pushed
  commit as publicly deployed without observing the running revision.

## Initial hypotheses

1. Remove the leverage question when leverage is fixed at 1x; measure confirmed
   per-request cost, tokens, latency and parser/decision success before/after.
2. Audit market-feature precision for small BTC sizes and freshness before
   changing the strategy prompt.
3. Specify and test a coherent prediction/holding horizon and cost-aware question
   contract. This is a hypothesis, not a reason to force buy or sell.
4. Evaluate decision cadence and maker-fill assumptions using recorded data,
   accounting for adverse selection, fees and the cost of abstaining/inferencing.
