import { clamp } from "../utils.js";

/**
 * 5-minute signal engine — completely separate from the 15m probability.js.
 *
 * Design principles for 5m:
 *  - Heiken Ashi momentum is the dominant signal (fastest reliable indicator at 5m)
 *  - MACD(5/13/8) histogram direction + expansion (half-period of standard)
 *  - RSI(5) used for extreme mean-reversion zones, NOT trend-following
 *  - Volume surge confirms direction when present
 *  - Rate-of-change over last 5 bars captures micro-momentum
 *
 * Each signal contributes a value in [-1, +1] scaled by its weight.
 * rawUp = (weighted_sum / total_weight + 1) / 2  →  [0, 1]
 *
 * 15m uses additive integer votes (scoreDirection).
 * 5m uses continuous weighted scoring (more granular, less threshold-sensitive).
 */
export function scoreDirection5m({
  closes,
  volumes,
  rsi5,
  rsiSlope5,
  macd,
  heikenColor,
  heikenCount,
}) {
  const signals = [];
  const n = closes?.length ?? 0;

  // ── 1. Heiken Ashi momentum (weight 0.30) ─────────────────────────────────
  // At 5m, 2+ consecutive same-color candles indicates real short-term momentum.
  // Strength caps at 3 consecutive (diminishing returns beyond that).
  if (heikenColor != null && heikenCount != null) {
    const direction = heikenColor === "green" ? 1 : -1;
    const strength  = Math.min(heikenCount / 3, 1.0);
    signals.push({ v: direction * strength, w: 0.30 });
  }

  // ── 2. MACD(5/13/8) histogram direction + expansion (weight 0.25) ─────────
  // histDelta > 0 means histogram is growing (momentum building) → strong signal.
  // histDelta < 0 means histogram is shrinking → weaker signal.
  if (macd != null) {
    const histDir  = macd.hist > 0 ? 1 : macd.hist < 0 ? -1 : 0;
    const expanding = macd.histDelta !== null && (
      (macd.hist > 0 && macd.histDelta > 0) ||
      (macd.hist < 0 && macd.histDelta < 0)
    );
    const strength = expanding ? 1.0 : 0.45;
    signals.push({ v: histDir * strength, w: 0.25 });
  }

  // ── 3. RSI(5) — extreme zones only (weight 0.20) ──────────────────────────
  // At 5m RSI overshoots are frequent and unreliable in mid-range.
  // Only act on genuine extremes where mean-reversion probability is high.
  // Slope confirmation amplifies the signal ±0.15.
  if (rsi5 != null) {
    let rv = 0;
    if      (rsi5 < 15) rv =  1.0;
    else if (rsi5 < 25) rv =  0.7;
    else if (rsi5 < 35) rv =  0.35;
    else if (rsi5 > 85) rv = -1.0;
    else if (rsi5 > 75) rv = -0.7;
    else if (rsi5 > 65) rv = -0.35;
    // else: mid-range RSI → no signal at 5m

    if (rsiSlope5 != null && rv !== 0) {
      if (rv > 0 && rsiSlope5 > 0) rv = Math.min(rv + 0.15, 1.0);
      if (rv < 0 && rsiSlope5 < 0) rv = Math.max(rv - 0.15, -1.0);
    }
    signals.push({ v: rv, w: 0.20 });
  }

  // ── 4. Volume surge + price direction (weight 0.15) ───────────────────────
  // Compares avg volume of last 3 bars vs prior 15 bars.
  // A surge (>1.25×) with a directional price move = confirmation.
  // No surge → neutral (still contributes 0 weight so total weight stays consistent).
  if (volumes && n >= 20 && volumes.length >= 18) {
    const recent = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const base   = volumes.slice(-18, -3).reduce((a, b) => a + b, 0) / 15;
    const surge  = base > 0 ? recent / base : 1;

    if (surge > 1.25 && n >= 5) {
      const priceDir = closes[n - 1] > closes[n - 4] ? 1 : -1;
      const strength = clamp((surge - 1.0) / 1.5, 0, 1); // 1.25→0.17, 2.5→1.0
      signals.push({ v: priceDir * strength, w: 0.15 });
    } else {
      signals.push({ v: 0, w: 0.15 });
    }
  }

  // ── 5. Rate of change — last 5 bars (weight 0.10) ─────────────────────────
  // Captures micro-momentum: a 0.33% move in 5 bars saturates the signal.
  // Provides the most recent "pure price direction" reading.
  if (n >= 6) {
    const roc = (closes[n - 1] - closes[n - 6]) / closes[n - 6];
    const rv  = clamp(roc * 300, -1, 1);
    signals.push({ v: rv, w: 0.10 });
  }

  if (signals.length === 0) return { rawUp: 0.5 };

  const totalW   = signals.reduce((a, s) => a + s.w, 0);
  const weighted = signals.reduce((a, s) => a + s.v * s.w, 0);
  const score    = weighted / totalW;        // -1 … +1
  const rawUp    = clamp((score + 1) / 2, 0, 1); // 0 … 1

  return { rawUp };
}
