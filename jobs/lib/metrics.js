/**
 * jobs/lib/metrics.js
 *
 * Pure metric computation functions.
 * All inputs are plain arrays/objects (no file I/O here — testable).
 */

import { deriveAdjustedUp } from "./parse-logs.js";

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

/**
 * Bin an array of numbers into `count` equal-width buckets over [lo, hi].
 * Returns an array of `count` objects: { lo, hi, n, pct }.
 */
export function bucketize(values, lo = 0, hi = 1, count = 10) {
  const width = (hi - lo) / count;
  const buckets = Array.from({ length: count }, (_, i) => ({
    lo: lo + i * width,
    hi: lo + (i + 1) * width,
    n: 0,
    pct: 0,
  }));

  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const idx = Math.min(Math.floor((v - lo) / width), count - 1);
    if (idx >= 0 && idx < count) buckets[idx].n++;
  }

  const total = values.filter(Number.isFinite).length;
  if (total > 0) {
    for (const b of buckets) b.pct = b.n / total;
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Signal health
// ---------------------------------------------------------------------------

/**
 * @param {object[]} signalRows  — output of readSignals()
 * @returns {SignalHealth}
 */
export function computeSignalHealth(signalRows) {
  const n = signalRows.length;
  if (n === 0) {
    return { n: 0, adjustedUpDist: [], probModelDist: [], deadNeutralRate: null, spuriousNeutralRate: null, blockedByProbModelAnalysis: null };
  }

  // adjustedUp: pre-calibration value derived by inverting the logistic
  const adjustedUps = signalRows.map((r) => r.adjustedUp).filter((v) => v !== null);
  const probModelUps = signalRows.map((r) => r.probModelUp).filter(Number.isFinite);

  const adjustedUpDist = bucketize(adjustedUps);
  const probModelDist  = bucketize(probModelUps);

  // Dead-neutral: probModelUp within [0.49, 0.51]
  const deadNeutralN = signalRows.filter(
    (r) => Number.isFinite(r.probModelUp) && r.probModelUp >= 0.49 && r.probModelUp <= 0.51
  ).length;
  const deadNeutralRate = deadNeutralN / n;

  // Spurious neutral: adjustedUp outside [0.45, 0.55] but probModelUp still in [0.49, 0.51]
  // Should be ~0 if calibration is monotonic — any nonzero value indicates a bug
  const spuriousNeutralN = signalRows.filter(
    (r) =>
      r.adjustedUp !== null &&
      (r.adjustedUp < 0.45 || r.adjustedUp > 0.55) &&
      Number.isFinite(r.probModelUp) &&
      r.probModelUp >= 0.49 &&
      r.probModelUp <= 0.51
  ).length;
  const spuriousNeutralRate = spuriousNeutralN / n;

  // For ticks blocked by prob_model_below: what fraction were genuinely neutral
  // (adjustedUp in [0.45, 0.55]) vs. having a real signal that was compressed?
  const probModelBlocked = signalRows.filter(
    (r) => typeof r.decisionReason === "string" && r.decisionReason.startsWith("prob_model_")
  );
  let blockedByProbModelAnalysis = null;
  if (probModelBlocked.length > 0) {
    const genuineNeutralN = probModelBlocked.filter(
      (r) => r.adjustedUp !== null && r.adjustedUp >= 0.45 && r.adjustedUp <= 0.55
    ).length;
    blockedByProbModelAnalysis = {
      total:          probModelBlocked.length,
      genuineNeutral: genuineNeutralN,
      genuineNeutralRate: genuineNeutralN / probModelBlocked.length,
      realSignalBlocked:  probModelBlocked.length - genuineNeutralN,
    };
  }

  return {
    n,
    adjustedUpDist,
    probModelDist,
    deadNeutralRate,
    spuriousNeutralRate,
    blockedByProbModelAnalysis,
  };
}

// ---------------------------------------------------------------------------
// Gate health
// ---------------------------------------------------------------------------

/**
 * @param {object[]} cfRows      — counterfactual rows for current window
 * @param {object[]} prevCfRows  — counterfactual rows for previous window
 * @returns {GateHealth}
 */
export function computeGateHealth(cfRows, prevCfRows = []) {
  const n = cfRows.length;
  if (n === 0) {
    return { n: 0, distribution: {}, top3: [], deltas: {} };
  }

  // Aggregate gate_that_blocked counts (normalize numeric values)
  const distribution = {};
  for (const r of cfRows) {
    const key = normalizeGateKey(r.gateThatBlocked);
    distribution[key] = (distribution[key] ?? 0) + 1;
  }

  // Previous window distribution for deltas
  const prevDist = {};
  for (const r of prevCfRows) {
    const key = normalizeGateKey(r.gateThatBlocked);
    prevDist[key] = (prevDist[key] ?? 0) + 1;
  }
  const prevN = prevCfRows.length;

  // Compute deltas (percentage point change)
  const deltas = {};
  const allKeys = new Set([...Object.keys(distribution), ...Object.keys(prevDist)]);
  for (const k of allKeys) {
    const curPct  = (distribution[k]  ?? 0) / n;
    const prevPct = prevN > 0 ? (prevDist[k] ?? 0) / prevN : null;
    deltas[k] = prevPct !== null ? curPct - prevPct : null;
  }

  // Top 3
  const top3 = Object.entries(distribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count, pct: count / n, delta: deltas[reason] ?? null }));

  return { n, distribution, top3, deltas };
}

/**
 * Strip per-tick numeric values to produce stable bucket keys.
 * "prob_model_0.4502_below_0.54" → "prob_model_below_0.54"
 * "min_ticket_3.03_exceeds_risk_cap_3.05_bankroll_20.34" → "min_ticket_exceeds_risk_cap"
 */
export function normalizeGateKey(raw) {
  if (!raw || raw === "none") return "none";
  return raw
    .replace(/_(-?[\d.]+)(?=_[a-z])/g, "")
    .replace(/_bankroll_[\d.]+$/, "")
    .replace(/__+/g, "_")
    .replace(/_+$/, "");
}

// ---------------------------------------------------------------------------
// Trade health
// ---------------------------------------------------------------------------

/**
 * @param {object[]} opens          — trades_opened rows (filtered to bot+window)
 * @param {Map}      closedByTradeId — trade_id → close record
 */
export function computeTradeHealth(opens, closedByTradeId) {
  if (opens.length === 0) {
    return { n: 0, filled: 0, won: 0, lost: 0, winRate: null, predictedWinRate: null, winRateDelta: null, avgEdge: null, totalPnl: null, pnlRows: [] };
  }

  const pnlRows = [];
  let wonN = 0, lostN = 0, predWinSum = 0, edgeSum = 0;

  for (const open of opens) {
    const close = closedByTradeId.get(open.trade_id);
    const won = close ? (close.won === 1 || close.won === true) : null;
    const pnl = close?.pnl_realized != null ? Number(close.pnl_realized) : null;

    pnlRows.push({
      tradeId:   open.trade_id,
      marketSlug: open.market_slug,
      side:      open.side,
      stake:     open.stake,
      probModel: open.prob_modelo,
      probMarket: open.prob_mercado,
      edge:      open.edge,
      won,
      pnl,
    });

    if (won !== null) {
      if (won) wonN++; else lostN++;
    }
    if (Number.isFinite(open.prob_modelo)) predWinSum += open.prob_modelo;
    if (Number.isFinite(open.edge)) edgeSum += open.edge;
  }

  const settled = wonN + lostN;
  const winRate = settled > 0 ? wonN / settled : null;
  const predictedWinRate = opens.length > 0 ? predWinSum / opens.length : null;
  const winRateDelta = winRate !== null && predictedWinRate !== null ? winRate - predictedWinRate : null;
  const totalPnl = pnlRows.reduce((s, r) => s + (r.pnl ?? 0), 0);
  const avgEdge = opens.length > 0 ? edgeSum / opens.length : null;

  return {
    n:              opens.length,
    filled:         opens.length,
    won:            wonN,
    lost:           lostN,
    settled,
    winRate,
    predictedWinRate,
    winRateDelta,
    avgEdge,
    totalPnl,
    pnlRows,
  };
}

// ---------------------------------------------------------------------------
// Bankroll health
// ---------------------------------------------------------------------------

/**
 * @param {object|null} state      — bankroll JSON state (null if unavailable)
 * @param {object[]}    signalRows — used to detect risk-event log lines
 */
export function computeBankrollHealth(state) {
  if (!state) {
    return { available: false };
  }

  return {
    available:      true,
    bankroll:       state.bankroll,
    cycleNumber:    state.cycleNumber,
    losingStreak:   state.losingStreak,
    paused:         state.paused,
    cycleEnded:     state.cycleEnded,
    totalWithdrawn: state.totalWithdrawn,
    openPositions:  state.openPositions,
    totalExposure:  state.totalExposure,
    savedAt:        state.savedAt,
    // Risk events — derive from state fields
    riskEvents: [
      state.paused       && "losing_streak_pause",
      state.cycleEnded   && "cycle_floor_hit",
      state.bankroll >= 150 && "withdrawal_trigger_reached",
    ].filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Uptime
// ---------------------------------------------------------------------------

/**
 * Estimate uptime from tick count vs. expected ticks.
 * The bot polls every 1 second; 24h = 86400 expected ticks.
 */
export function computeUptime(signalRows, windowHours = 24) {
  const expectedTicks = windowHours * 3600;
  const observedTicks = signalRows.length;
  return {
    observedTicks,
    expectedTicks,
    pct: observedTicks / expectedTicks,
  };
}
