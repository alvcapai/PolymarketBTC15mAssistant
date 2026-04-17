import { clamp } from "../utils.js";
import { inTradingHours } from "./time.js";
import { isCircuitTripped } from "./state.js";

export const SkipReason = Object.freeze({
  TRADING_DISABLED:        "trading_disabled",
  OPEN_POSITION_EXISTS:    "open_position_exists",
  CIRCUIT_BREAKER_TRIPPED: "circuit_breaker_tripped",
  OUTSIDE_TRADING_HOURS:   "outside_trading_hours",
  MARKET_NOT_ALIVE:        "market_not_alive",
  PRICES_UNAVAILABLE:      "prices_unavailable",
  PROB_TOO_LOW:            "prob_too_low",
  EDGE_OUT_OF_RANGE:       "edge_out_of_range",
});

/**
 * 5m entry decision — TA-driven, completely separate from the 15m decideEntry().
 *
 * Flow:
 *   1. Circuit breaker + session guards
 *   2. Time-left guard (don't enter near settlement)
 *   3. Apply 5m time-decay to rawUp from scoreDirection5m()
 *   4. Calibrate model probabilities
 *   5. Compute edge (model vs market price)
 *   6. Threshold checks: minProb, minEdge/maxEdge
 *
 * @param {object}  state    — pred5mState (circuit breaker, kill switch, hasOpenPosition)
 * @param {object}  snapshot — marketSnapshot5m from index.js
 * @param {object}  cfg      — createPrediction5mConfig()
 * @param {number}  rawUp    — [0,1] from scoreDirection5m()
 * @param {Date}    now
 * @returns {{ type: 'enter'|'skip', ... }}
 */
export function evaluateEntry(state, snapshot, cfg, rawUp, now = new Date()) {
  // ── Guards ───────────────────────────────────────────────────────────────
  if (!state.tradingEnabled)  return { type: "skip", reason: SkipReason.TRADING_DISABLED };
  if (state.hasOpenPosition)  return { type: "skip", reason: SkipReason.OPEN_POSITION_EXISTS };
  if (isCircuitTripped(state.circuitBreaker, now.getTime())) {
    return { type: "skip", reason: SkipReason.CIRCUIT_BREAKER_TRIPPED };
  }
  if (!inTradingHours(now, cfg.tradingHoursStartPst, cfg.tradingHoursEndPst, cfg.allowWeekends)) {
    return { type: "skip", reason: SkipReason.OUTSIDE_TRADING_HOURS };
  }

  const timeLeftMin = snapshot.endDate !== null
    ? (snapshot.endDate - now.getTime()) / 60_000
    : null;
  if (timeLeftMin === null || timeLeftMin < cfg.timeLeftMinMinutes) {
    return { type: "skip", reason: SkipReason.MARKET_NOT_ALIVE };
  }

  // ── Market prices ────────────────────────────────────────────────────────
  const marketUp   = snapshot.upAsk   ?? snapshot.upPrice   ?? null;
  const marketDown = snapshot.downAsk ?? snapshot.downPrice ?? null;
  if (marketUp === null || marketDown === null) {
    return { type: "skip", reason: SkipReason.PRICES_UNAVAILABLE };
  }

  // ── Time decay (5m window) ────────────────────────────────────────────────
  // Reduces model conviction linearly as settlement approaches.
  // At full time remaining: decay=1 (full signal). At 0 min: decay=0 (neutral).
  const decay      = clamp(timeLeftMin / cfg.candleWindowMinutes, 0, 1);
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * decay, 0, 1);

  // ── Calibration ───────────────────────────────────────────────────────────
  // Shrinks model confidence toward 0.5 to account for signal uncertainty.
  const factor    = cfg.calibrationFactor;
  const probUp    = clamp(0.5 + (adjustedUp       - 0.5) * factor, 0, 1);
  const probDown  = clamp(0.5 + ((1 - adjustedUp) - 0.5) * factor, 0, 1);

  // ── Edge calculation ──────────────────────────────────────────────────────
  const edgeUp   = probUp   - marketUp;
  const edgeDown = probDown - marketDown;

  const side       = edgeUp >= edgeDown ? "UP" : "DOWN";
  const probModel  = side === "UP" ? probUp   : probDown;
  const probMarket = side === "UP" ? marketUp : marketDown;
  const askPrice   = side === "UP" ? (snapshot.upAsk ?? marketUp) : (snapshot.downAsk ?? marketDown);
  const edge       = side === "UP" ? edgeUp   : edgeDown;

  // ── Threshold checks ─────────────────────────────────────────────────────
  if (probModel < cfg.minProb) {
    return {
      type: "skip",
      reason: `${SkipReason.PROB_TOO_LOW}_${probModel.toFixed(3)}_below_${cfg.minProb}`,
    };
  }
  if (edge < cfg.minEdge || edge > cfg.maxEdge) {
    return {
      type: "skip",
      reason: `${SkipReason.EDGE_OUT_OF_RANGE}_${edge.toFixed(3)}_[${cfg.minEdge},${cfg.maxEdge}]`,
    };
  }

  return { type: "enter", side, probModel, probMarket, askPrice, edge, edgeUp, edgeDown, adjustedUp };
}
