# Jev Trade

## Persistent paper-trading fork

This fork of [aowang-ai/jev-trade](https://github.com/aowang-ai/jev-trade) keeps
Jev's open/close/hold decisions and adds a durable simulated account. Our deployment
uses BTC public mainnet data, Jev through Gateway once per minute, `DRY_RUN=true`,
and no trading wallet. The original project's live-trading documentation follows below.

- Each coin has its own SQLite account: $200 starting equity, $100 maximum position
  notional, 1x collateral and a $20 loss/drawdown halt by default. The bankroll is
  now enforced in simulation, not just used as a percentage denominator.
- PnL includes configured maker/taker fees, crossing the bid/ask on exits,
  configurable exit slippage, estimated funding and model costs. The dashboard
  labels assumptions as estimates. Funding uses the observed hourly rate and mark
  held constant over the cursor gap, including downtime, rather than historical
  venue settlements. Model billing uses reported Gateway cost when available;
  otherwise configured token rates. Failed requests use a rough input-token
  estimate. Reconcile against actual provider bills before treating this as net profit.
- Simulated maker fills use only prints timestamped after a quote was created and
  at most 10% of their observed size. This is a participation assumption, not a
  queue-priority or latency model. Exits use the current touch plus assumed slippage;
  there is no full-depth market-impact or liquidation model.
- Account and audit updates commit atomically with SQLite WAL and FULL synchronous
  writes. Restart restores balances, positions, costs, halts and recent tick history.
  Resting simulated quotes are cancelled at restart. Run one writer per account.
- Stale books, expired decisions, insufficient collateral and exposure violations
  block orders independently of Jev. A loss/drawdown halt closes the simulated position
  at the next fresh tick and stops further model calls for that sleeve. A gap can
  exceed the loss threshold; the threshold does not guarantee an exit price.
- Local audit records include the exact market-facing request, question version,
  validated raw answers, usage, orders and fills. They are not exposed through the
  public API. No code was copied from projects with undeclared reuse licenses.

### Jev consumption balance

The dashboard shows today's UTC consumption and the full account period: request
counts, input/output tokens, confirmed Gateway charges and unreconciled estimates.
It separates realized trading PnL, open-position PnL, simulated fees, estimated
funding, AI costs and the final net result. Net PnL already includes AI costs;
do not subtract them again.

Each paid-model attempt gets a durable local ID before the request starts.
Successful, failed and late responses update the same charge. Gateway generation
IDs are retained privately. A background job uses the official
`gateway.getGenerationInfo()` lookup to replace an estimate with `totalCost`,
including a confirmed zero, rather than adding a second cost. These billing reads
do not generate additional inference requests. Lookup failures retry with backoff;
the existing estimate remains visible until reconciliation succeeds. BYOK upstream
costs are not treated as confirmed provider invoices.

The old `providerMetadata.gateway.cost` field has no documented billing contract
and is no longer treated as an actual charge. Existing account charges without
generation IDs remain estimated, with unknown tokens/status explicitly counted;
the account and its positions are not reset. Usage before the persistent account
was created is outside this report. Official lookup documentation:
https://vercel.com/docs/ai-gateway/observability-and-spend/usage

`GET /usage` returns aggregate usage per coin, without generation IDs, API keys or
request/response bodies. The dashboard refreshes these figures with the next normal
market tick. Simulated fees/funding and open-position marks still make the overall
trading result provisional even when all Gateway charges are confirmed.

Use `.env.example` for the configuration. Persist `PAPER_DATA_DIR` on a named volume;
`docker-compose.dry-run.yml` includes one. Never use `down -v` or Dokploy's Fresh
Volumes for this deployment. Keep a backup of the SQLite database using SQLite's
backup API while running, or copy it after stopping the bot. Changing financial
account settings with an existing database fails closed; preserve the old database
and select a new directory for a separate experiment instead of silently resetting it.

```sh
bun install --frozen-lockfile
bun test test
bun run typecheck
docker compose -f docker-compose.dry-run.yml up -d --build
```

This fork adds measurement and safeguards. It has not established a profitable
strategy. `HOLD` remains a valid model decision, and no account deposit is needed.

The owner-authorized daily optimization workflow is documented in
[`OPTIMIZATION.md`](OPTIMIZATION.md). It may implement, test and deploy bounded
paper-only improvements. `DAILY_AI_BUDGET_USD=0.60` pauses new calls when recorded daily cost plus a reserve would exceed the threshold
with a conservative next-request reserve; late billing remains a limitation.
At fixed 1x leverage, Jev answers only bias and intent; code supplies the fixed
leverage rather than paying for a question with no alternative.

Run `bun run optimize:report` for a read-only operating/financial summary. It
does not call Jev. Insufficient history, unresolved bills and unsupported
multi-sleeve aggregation are reported rather than interpreted as an edge.

[![Live desk](https://img.shields.io/badge/live-jev--trade.com-111)](https://www.jev-trade.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-111)](LICENSE)

I built a trading bot with Jev. Jev reads the Hyperliquid book every tick and answers buy, sell, or hold. The bot sends the order. Five coins, five wallets, real fills.

**[Watch the live desk](https://www.jev-trade.com/)**

[![Jev Trade live desk](assets/desk.png)](https://www.jev-trade.com/)

Jev makes the call. Hold is one of its answers, so a tick can end with no order. Position, balance, and PnL come from Hyperliquid.

Based on [jev-trader](https://github.com/jarrodwatts/jev-trader) by Jarrod Watts (MIT). Venue is Hyperliquid, not Monad / Kuru.

## What you are looking at

- Five isolated sleeves: BTC, ETH, SOL, DOGE, BNB. Each has its own wallet and its own Jev call.
- The left pane is the live book as candles. Green and red marks are fills. The entry line is the open position.
- The right pane is the latest Jev call and the tape of every tick.
- The table is Positions and Trades, the same split a futures desk uses.

A live key on testnet or mainnet sends real orders. Start with a dry run.

## How a tick works

1. The bot reads the book.
2. Jev picks long or short, then open, close, or hold.
3. An entry is a post-only Alo quote one tick inside the touch, so it sits on the maker side until a taker hits it.
4. An exit is an Ioc that crosses the touch and fills on the spot.
5. Hold sends no order and pulls any resting quote Jev no longer wants.

The bot is Bun on port 3000. The dashboard is Next in `web/` on port 3001. Keys, evaluate, and orders stay on the Bun process.

## Dry run

[Bun](https://bun.sh) 1.2 or newer. No `PRIVATE_KEY` means a dry run: real book, real decisions, simulated fills. Default `MODEL=mock` is a momentum stand-in and needs no API key.

```sh
cp .env.example .env
bun install
bun run start
```

Dashboard (second terminal):

```sh
cp web/.env.example web/.env.local
bun run dev:web
```

Open http://localhost:3001. The page reads `$NEXT_PUBLIC_API_URL/events` (default `http://localhost:3000`).

## Live Jev

Set `MODEL=jev` and pick an API. Official TypeSafe is the default.

```sh
MODEL=jev
JEV_PROVIDER=typesafe
TYPESAFE_API_KEY=
# JEV_MODEL_ID defaults to jev-latest
```

Get a key from [docs.typesafe.ai](https://docs.typesafe.ai/).

Vercel AI Gateway is still supported:

```sh
MODEL=jev
JEV_PROVIDER=gateway
AI_GATEWAY_API_KEY=
# JEV_MODEL_ID defaults to typesafe-ai/jev
```

If `JEV_PROVIDER` is unset, the bot uses TypeSafe when `TYPESAFE_API_KEY` is set, otherwise Gateway when `AI_GATEWAY_API_KEY` is set.

## Live testnet orders

1. Keep `HL_TESTNET=true`.
2. Set `PRIVATE_KEY` for the first coin (BTC).
3. Copy `.wallets.example.json` to `.wallets.json` and put a key on each other sleeve. Or set `WALLETS_JSON`.
4. Get mock USDC from https://app.hyperliquid-testnet.xyz/drip. The faucet only pays addresses that have deposited on mainnet.
5. Leave `DRY_RUN=false`. A missing key on a sleeve still dry-runs that sleeve.

`HL_TESTNET=false` is mainnet. Do not flip that until you mean it.

## Tests

```sh
bun test
```

CI runs the same command on push and pull request.

## Env

See [`.env.example`](.env.example). The ones that change behavior:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HL_COINS` | `BTC,ETH,SOL,DOGE,BNB` | Sleeves to run |
| `HL_TESTNET` | `true` | `false` is mainnet |
| `MODEL` | `mock` | `jev` needs a TypeSafe or Gateway key |
| `JEV_PROVIDER` | `typesafe` | `typesafe` or `gateway` |
| `TYPESAFE_API_KEY` | empty | Official TypeSafe key |
| `AI_GATEWAY_API_KEY` | empty | Vercel AI Gateway key |
| `PRIVATE_KEY` | empty | First coin. Empty is a dry run |
| `DRY_RUN` | `false` | `true` simulates every sleeve |
| `TICK_MS` | `2000` | Decision + requote cadence |
| `PRICE_MS` | `200` | Chart and mid prints. Does not call Jev |
| `QUOTE_USD` | `40` | Quote notional per tick |
| `CLOSE_SLIPPAGE_BPS` | `5` | How far an exit crosses the touch |
| `PORT` | `3000` | Bot SSE |

## Endpoints

- `GET /` snapshot: model, sleeves, latestByCoin
- `GET /history` last 1000 ticks per coin
- `GET /tape` all-time mid series plus fill marks per coin
- `GET /usage` persistent model usage and confirmed/estimated costs per coin
- `GET /events` SSE: `snapshot` on connect (`historyByCoin`, `tapeByCoin`), then `block`, `quote`, `fill` keyed by coin

## Layout

```
src/           Bun bot
test/          bun tests
web/           Next dashboard
assets/        README shots of the live desk
```

## License

MIT. Copyright 2026 aowang. Includes MIT code originally published as jev-trader by Jarrod Watts.
