# Rebuild Specification

Blueprint for rewriting the bot in ~40% less code with clearer module
boundaries and testable pure functions.

**Goal:** same behaviour, smaller surface, every math function independently
testable, side effects isolated to two modules (`execution/`, `state/`).

---

## 1. Design principles

1. **One-way data flow.** Each loop tick: read state → fetch feeds → compute
   signals → compute risk → execute → persist. No module reaches back up the
   call chain.

2. **Pure functions for all math.** `signals/`, `risk/` contain zero I/O,
   zero mutation. They take plain objects, return plain objects. Trivially
   unit-testable with `node:test`.

3. **Side effects only in `execution/` and `state/`.** `execution/` places
   orders, sells, redeems. `state/` reads and writes the bankroll JSON file.
   All other modules are I/O-free.

4. **No global mutable state outside `state/`.** The current `tradedTokens`,
   `tradedMarketSlugs`, `isPlacingOrder`, `basisHistory`, and `takenProfitTokens`
   sets/flags should live in the state store, not module-level variables.

5. **Fail loudly on contract violations.** Unknown market structure, missing
   token IDs, and null prices should throw, not silently return null and let
   downstream code crash with a confusing error.

---

## 2. Proposed module layout

```
src/
  feeds/
    binance.js      getKlines(symbol, interval, limit) → Candle[]
    chainlink.js    getPrice(aggregatorAddress)        → number
    polymarket.js   getMarket(seriesId)                → Market
                    getOrderBook(tokenId)              → OrderBook
  signals/
    indicators.js   scoreDirection(klines, chainlinkPrice) → ScoreResult
    calibrate.js    calibrate(rawUp, a?)               → { probUp, probDown }
    time-decay.js   applyTimeDecay(rawUp, remainingMin, windowMin) → number
  risk/
    edge.js         computeEdge(probUp, marketUp, fee, slippage, price) → EdgeResult
    entry.js        decideEntry(state, market, edgeResult) → EntryDecision
    stake.js        computeStake(bankroll, netEdge, streak) → number
    take-profit.js  computeSellThreshold(entryPrice, probModel, remainingMin) → number
  execution/
    order.js        placeOrder(tokenId, side, stake, price) → OrderResult
    sell.js         sellPosition(tokenId, shareSize, price) → SellResult
    redeem.js       redeemPositions(walletAddress)          → RedeemResult
    transfer.js     transferUsdc(toAddress, amount)         → TxResult
  state/
    bankroll.js     load(path) → BankrollState
                    save(state, path) → void
                    applyOutcome(state, won) → BankrollState
                    applyWithdrawal(state)   → BankrollState
  logging/
    csv.js          appendRow(filePath, header, row) → void
    counterfactual.js logCounterfactual(row) → void
    telemetry.js    recordOpen(data), recordClose(data) → void
  loop/
    index.js        main() — the only module that imports from all others
  config.js         pure CONFIG object, no I/O
```

---

## 3. Data contracts (JSDoc interfaces)

```js
/**
 * @typedef {Object} Candle
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume
 * @property {number} openTime   // Unix ms
 */

/**
 * @typedef {Object} ScoreResult
 * @property {number} upScore
 * @property {number} downScore
 * @property {number} rawUp      // [0, 1]
 * @property {number} adjustedUp // after time decay
 * @property {number} basisStddev
 * @property {number} vwapMargin
 */

/**
 * @typedef {Object} EdgeResult
 * @property {number} marketUp
 * @property {number} marketDown
 * @property {number} rawEdge
 * @property {number} netEdge
 * @property {string} side       // "UP" | "DOWN"
 */

/**
 * @typedef {Object} EntryDecision
 * @property {boolean} canEnter
 * @property {string}  reason
 * @property {string}  side
 * @property {number}  probModel
 * @property {number}  probMarket
 * @property {number}  edge       // netEdge
 * @property {number}  rawEdge
 * @property {number}  stake
 */

/**
 * @typedef {Object} BankrollState
 * @property {number}  bankroll
 * @property {number}  cycleNumber
 * @property {number}  losingStreak
 * @property {boolean} paused
 * @property {boolean} cycleEnded
 * @property {number}  totalWithdrawn
 * @property {Map<string, Position>} positions
 * @property {Set<string>} tradedMarketSlugs
 * @property {Set<string>} tradedTokens
 * @property {number[]} basisHistory   // rolling 30-candle basis
 */
```

If migrating to TypeScript, convert the JSDoc `@typedef` blocks to `interface`
declarations verbatim — the shapes are the same.

---

## 4. What gets dropped vs. kept vs. added

### Dropped (dead weight or renames)

| Current | Status | Reason |
|---|---|---|
| `src/engines/signal-validation.js` | Rename to `signals/calibrate.js` | Clarity |
| `src/engines/edge.js` | Merge into `risk/edge.js` | Too thin to justify own file |
| `src/engines/regime.js` | Evaluate — currently unused in main loop | Dead code? |
| Module-level mutable sets/flags in index.js | Move to state store | Single source of truth |
| `TAKE_PROFIT_THRESHOLD` export | Removed — replaced by function | No longer a constant |
| `MIN_EDGE` export | Removed — renamed `MIN_NET_EDGE` | Done in Bug 3 |
| `MAX_STAKE` constant | Removed — dynamic now | Done in Improvement 6 |

### Kept (working, don't touch)

- Order execution signing (`executor.js`) — Safe wallet + CLOB client
- Redemption logic (`redeemer.js`) — CTF contract + EIP-712
- All Binance / Chainlink / Polymarket API clients
- Config structure (`config.js`)
- CSV logging format (extend, don't replace)
- Withdrawal / Monaco Rule semantics

### Added

- `state/bankroll.js` absorbs `tradedMarketSlugs`, `tradedTokens`, `basisHistory`, `takenProfitTokens`
- `risk/take-profit.js` as a pure function (currently mixed with I/O in `trade/take-profit.js`)
- TypeScript types (or JSDoc) on all inter-module contracts

---

## 5. Test plan

### Unit tests (pure functions — no mocks needed)

| Module | Function | What to assert |
|---|---|---|
| `signals/calibrate.js` | `calibrate(rawUp)` | Monotonic: calibrate(0.6) < calibrate(0.7) < calibrate(0.8); calibrate(0.5) = 0.5; calibrate(0.0) < 0.5; calibrate(1.0) > 0.5 |
| `signals/time-decay.js` | `applyTimeDecay` | At t=0: output = 0.5; at t=window: output = rawUp; intermediate is linear |
| `risk/edge.js` | `computeEdge` | netEdge < rawEdge always; costAsProb blows up gracefully at price → 1 |
| `risk/entry.js` | `decideEntry` | Each gate fires correctly; gate #10.5 blocks at price=0.27 with bankroll=$20; passes at bankroll=$100 |
| `risk/stake.js` | `computeStake` | Returns 0 when netEdge < MIN_NET_EDGE; caps at 5% bankroll; halves at streak≥3 |
| `risk/take-profit.js` | `computeSellThreshold` | Monotone in remainingMinutes (threshold rises as t→0); never below entryPrice × 1.25 |

### Integration tests (require network or file I/O)

| Scenario | How |
|---|---|
| Full cycle without trade | Mock all feeds; assert CSV row appended, no order placed |
| Full cycle with trade | Mock feeds returning strong signal + favorable price; assert order call made with correct args |
| Redeem cycle | Mock `/positions` returning curPrice=1; assert redeemPositions called |

### 100-candle backtest harness

```js
// harness.js
import { scoreDirection } from "./signals/indicators.js";
import { calibrate } from "./signals/calibrate.js";
import { computeEdge } from "./risk/edge.js";
import { decideEntry } from "./risk/entry.js";
import { createBankrollState } from "./state/bankroll.js";
import historicalCandles from "./fixtures/btc-1m-candles-100.json" assert { type: "json" };

// Simulate 100 market windows, check P&L and gate firing rates.
// This is not a live backtest — market prices are synthetic — but it
// catches regressions in the scoring and risk pipeline.
```

The fixture file (`btc-1m-candles-100.json`) can be generated from the
Binance klines endpoint and committed once.

---

## 6. Migration note (JS → TS)

If the team decides to migrate:

1. Rename `*.js` → `*.ts`, add `tsconfig.json` with `"module": "node16"`.
2. Convert JSDoc `@typedef` → `interface` in `types.ts`, export from there.
3. Each module `import type { Candle, EdgeResult } from "../types.js"`.
4. The pure-function modules in `signals/` and `risk/` will type-check
   cleanly with zero changes to logic. The I/O modules will need explicit
   return types on async functions.

There are no dynamic typing tricks in the current codebase that would block
migration. The main friction point is the `ethers.js` / Polymarket SDK types.
