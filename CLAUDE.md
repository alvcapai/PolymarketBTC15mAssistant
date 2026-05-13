# CLAUDE.md — Context for Claude Code

## Runtime environment

- **Process manager:** `pm2`, process name `btc-15m` (id 0)
- **Working directory at runtime:** `/root/workspace/PolymarketBTC15mAssistant`
  - Bankroll state: `/root/workspace/PolymarketBTC15mAssistant/logs/bankroll-btc-15m.json`
  - CSV logs: `/root/workspace/PolymarketBTC15mAssistant/logs/counterfactual.csv`, `/root/workspace/PolymarketBTC15mAssistant/logs/signals-btc-15m.csv`
  - Pino log files in `logs/` exist but stay 0 bytes (pino-roll worker thread issue)
  - Live output: `/root/.pm2/logs/btc-15m-out.log` (TUI, not structured JSON)
- **Source:** `/root/workspace/PolymarketBTC15mAssistant/src/index.js`
- **Trade mode:** `TRADE_MOCK_MODE=false` — real orders via Polymarket CLOB v2
- **Restart:** `pm2 restart btc-15m`

## Key constants (risk-management.js)

| Constant | Value | Meaning |
|---|---|---|
| `MAX_POSITIONS` | 1 | Only one open position at a time |
| `REDEEM_INTERVAL_MS` | 2 min | Redeem + reconcile cycle |
| `TAKE_PROFIT_INTERVAL_MS` | 10 s | Take-profit check cycle |
| `STALE_POSITION_MS` | 25 min | Ghost position reconcile threshold |

## Known gotchas

**Ghost positions (`max_positions_1_reached` with no position on Polymarket):**
GTC orders are recorded in `bankrollState` immediately on post, before fill
confirmation. Unfilled orders leave ghost positions invisible to `runAutoRedeem`.
Fixed by `reconcileStalePositions` (runs every 2 min) — clears positions >25 min
old via CLOB midpoint + Gamma API (`?closed=true`). If the bot is stuck with
this error, restart it; the position will clear within 2 minutes.

**Gamma API response format for closed markets:**
Token IDs and prices are JSON-encoded strings, not nested objects:
```
clobTokenIds: "[\"tokenA\", \"tokenB\"]"
outcomePrices: "[\"0\", \"1\"]"
```
Always add `&closed=true` to fetch resolved markets.

## Documentation map

| File | Purpose |
|---|---|
| `README.md` | Setup and run instructions |
| `AGENT-OPS.md` | Operator runbook (pm2, logs, smoke-test) |
| `BOT-LOGIC.md` | Trading logic, indicators, risk guardrails |
| `CHANGELOG.md` | Notable changes per commit |

## Commit style

`type(scope): short description` — types: `fix`, `feat`, `refactor`, `docs`, `chore`
