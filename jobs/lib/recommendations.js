/**
 * jobs/lib/recommendations.js
 *
 * Recommendation trigger logic.
 * Each check function is pure: given metrics → Recommendation | null.
 * These are the ONLY criteria for generating recommendations — no ad-hoc logic.
 */

// ---------------------------------------------------------------------------
// Types (JSDoc)
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} Recommendation
 * @property {string}  id           — e.g. "dead_neutral_rate"
 * @property {string}  title        — short human title
 * @property {string}  what         — what to change
 * @property {string}  why          — citing specific metric
 * @property {string}  expectedImpact
 * @property {string}  risk
 * @property {string}  metricCited  — the specific number
 * @property {'LOW'|'MEDIUM'|'HIGH'} confidence
 * @property {string}  reversibility
 * @property {string}  doNotApplyIf
 * @property {string}  [proposedChange]
 */

// ---------------------------------------------------------------------------
// Individual checks (each returns Recommendation | null)
// ---------------------------------------------------------------------------

/**
 * Dead-neutral rate > 60% over 3+ days → suggest asymmetric scorecard weights.
 * @param {number} rate       — 0..1
 * @param {number} sampleSize — total ticks in window
 * @param {number} daysSeen   — how many consecutive days with rate > 60%
 */
export function checkDeadNeutral(rate, sampleSize, daysSeen = 1) {
  if (!Number.isFinite(rate) || rate <= 0.60 || sampleSize < 500) return null;

  return {
    id: "dead_neutral_rate",
    title: "Scorecard produces too many exact-neutral readings",
    what: "Apply asymmetric indicator weights to break ties: VWAP-related +2, RSI +1, MACD histogram +2, Heiken Ashi +1 (HYPOTHESIS — needs A/B validation)",
    why: `Dead-neutral rate is ${pct(rate)} (${sampleSize} ticks). The symmetric +2 weights on 4 indicators produce exact ties on balanced 2v2 splits.`,
    expectedImpact: "Reduce dead-neutral rate; increase valid signal rate",
    risk: "May introduce directional bias if weights don't reflect true indicator reliability",
    metricCited: `dead_neutral_rate = ${pct(rate)}`,
    confidence: daysSeen >= 3 ? "HIGH" : "LOW",
    reversibility: "Easy — revert weight constants in probability.js",
    doNotApplyIf: "Win rate on existing trades is already above 60%; asymmetry may not be needed",
    proposedChange: "src/engines/probability.js: change RSI and Heiken Ashi weight from +2 to +1",
  };
}

/**
 * prob_market_below_0.50 > 30% of blocks AND ≥50 real trades with realized win rate data.
 * @param {number} blockPct    — fraction of blocks due to prob_market gate
 * @param {number} tradeCount  — actual real trades in sample
 * @param {number|null} underdogWinRate — realized win rate on below-0.50 market bets
 */
export function checkProbMarketBlocks(blockPct, tradeCount, underdogWinRate = null) {
  if (!Number.isFinite(blockPct) || blockPct <= 0.30) return null;

  const hasSufficientData = tradeCount >= 50 && underdogWinRate !== null;
  const confidence = hasSufficientData ? "MEDIUM" : "LOW";

  return {
    id: "prob_market_below_threshold",
    title: "Market-probability gate blocking significant share of signals",
    what: hasSufficientData
      ? `Lower MIN_MARKET_PROB from 0.50 → 0.45 (justified: realized win rate ${pct(underdogWinRate)} on underdog bets exceeds 0.45)`
      : "Insufficient data — flag for human review when ≥50 real trades are available",
    why: `prob_market_below_0.50 accounts for ${pct(blockPct)} of blocks. Threshold may exclude profitable near-even markets.`,
    expectedImpact: "Increase trade frequency; small increase in risk (betting slight underdogs)",
    risk: "If realized win rate on below-0.50 market bets < market-implied prob, this is negative EV",
    metricCited: `prob_market_below_0.50 = ${pct(blockPct)} of blocks; real trades = ${tradeCount}`,
    confidence,
    reversibility: "Easy — single constant in risk-management.js",
    doNotApplyIf: hasSufficientData
      ? `Realized win rate on below-0.50 trades is below ${pct(underdogWinRate) }`
      : "Fewer than 50 real trades in sample — insufficient data",
    proposedChange: hasSufficientData
      ? "risk-management.js: MIN_MARKET_PROB: 0.50 → 0.45"
      : undefined,
  };
}

/**
 * min_ticket_exceeds_risk_cap > 15% of blocks → bankroll too small for contract prices.
 * @param {number} blockPct  — fraction of blocks due to min_ticket gate
 * @param {number} bankroll  — current bankroll
 */
export function checkMinTicketBlocks(blockPct, bankroll) {
  if (!Number.isFinite(blockPct) || blockPct <= 0.15) return null;

  return {
    id: "min_ticket_exceeds_risk_cap",
    title: "Bankroll too small to meet platform minimum at current contract prices",
    what: "Either top up bankroll to ≥$25 OR restrict entries to cheap-side contracts (price ≤ 0.35, minimum $1.75 ticket)",
    why: `min_ticket_exceeds_risk_cap accounts for ${pct(blockPct)} of blocks with bankroll $${bankroll?.toFixed(2) ?? "?"}.`,
    expectedImpact: "Unlock blocked entry opportunities",
    risk: "Cheap-side restriction limits to UP bets in bearish markets (and vice versa)",
    metricCited: `min_ticket_exceeds_risk_cap = ${pct(blockPct)} of blocks; bankroll = $${bankroll?.toFixed(2) ?? "?"}`,
    confidence: "MEDIUM",
    reversibility: "Easy — bankroll top-up; or add price filter in decideEntry()",
    doNotApplyIf: "Do NOT lower the 15% risk cap — that would increase per-trade risk beyond safe levels",
  };
}

/**
 * Realized win rate deviates from predicted by >10pp over ≥50 trades → recalibration candidate.
 * @param {number} realizedWinRate   — 0..1
 * @param {number} predictedWinRate  — 0..1
 * @param {number} sampleSize        — number of settled trades
 */
export function checkCalibrationDrift(realizedWinRate, predictedWinRate, sampleSize) {
  if (!Number.isFinite(realizedWinRate) || !Number.isFinite(predictedWinRate)) return null;
  if (sampleSize < 50) return null;

  const drift = Math.abs(realizedWinRate - predictedWinRate);
  if (drift <= 0.10) return null;

  const direction = realizedWinRate > predictedWinRate ? "over-predicting losses" : "over-predicting wins";

  // Rough Platt a suggestion: if model is over-confident, increase a; if under-confident, lower a
  // Current a = 6.0. If realizedWinRate < predictedWinRate (model over-confident), suggest lower a.
  const suggestedA = realizedWinRate < predictedWinRate
    ? "lower a (try 4.0–5.0)"
    : "raise a (try 7.0–8.0)";

  return {
    id: "calibration_drift",
    title: "Realized win rate deviates significantly from model-predicted win rate",
    what: `Refit the logistic calibration parameter a in signal-validation.js. ${suggestedA}. Refit from counterfactual log once ≥200 labeled trades are available.`,
    why: `Realized win rate ${pct(realizedWinRate)} vs predicted ${pct(predictedWinRate)} — ${pct(drift)} gap (${direction}) over ${sampleSize} trades.`,
    expectedImpact: "Reduces EV leakage from miscalibrated sizing; tighter Kelly stakes",
    risk: "Changing a without sufficient data can make calibration worse",
    metricCited: `realized=${pct(realizedWinRate)}, predicted=${pct(predictedWinRate)}, n=${sampleSize}`,
    confidence: sampleSize >= 200 ? "HIGH" : "MEDIUM",
    reversibility: "Easy — revert a constant in signal-validation.js",
    doNotApplyIf: `Sample size < 200 or drift has reversed in most recent 50 trades`,
    proposedChange: `signal-validation.js: a = 6.0 → ${suggestedA}`,
  };
}

/**
 * 3+ consecutive days with zero trades.
 * @param {string[]}        recentDates     — YYYY-MM-DD strings of days with reports, sorted ascending
 * @param {Map<string,number>} tradeCounts  — date → trade count
 * @param {object}          gateHealth      — gate distribution for today
 */
export function checkZeroTradeDays(recentDates, tradeCounts, gateHealth) {
  if (!recentDates || recentDates.length < 3) return null;

  const lastThree = recentDates.slice(-3);
  const allZero = lastThree.every((d) => (tradeCounts.get(d) ?? 0) === 0);
  if (!allZero) return null;

  // Only recommend if edge gate is dominant
  const edgeBlockPct = gateHealth?.distribution
    ? (gateHealth.distribution["edge_out_of_range"] ?? 0) / (gateHealth.n || 1)
    : 0;

  const isEdgeDominated = edgeBlockPct > 0.30;

  return {
    id: "zero_trade_days",
    title: "3+ consecutive days with zero trades",
    what: isEdgeDominated
      ? "Lower MIN_NET_EDGE by 0.005 (0.030 → 0.025) as a test. Monitor for 3 days before further reduction."
      : "Investigate block distribution — edge gate is not the dominant blocker; do not change MIN_NET_EDGE blindly",
    why: `Zero trades on ${lastThree.join(", ")}. Edge gate accounts for ${pct(edgeBlockPct)} of blocks.`,
    expectedImpact: "Modest increase in trade frequency if edge gate is the bottleneck",
    risk: "Lowering MIN_NET_EDGE accepts lower-quality signals; monitor realized win rate closely",
    metricCited: `zero trades for ${lastThree.length} consecutive days; edge_out_of_range = ${pct(edgeBlockPct)} of blocks`,
    confidence: isEdgeDominated ? "MEDIUM" : "LOW",
    reversibility: "Easy — single constant in risk-management.js",
    doNotApplyIf: "Block distribution shows prob_model as dominant gate — edge is not the bottleneck",
    proposedChange: isEdgeDominated ? "risk-management.js: MIN_NET_EDGE: 0.030 → 0.025" : undefined,
  };
}

/**
 * Losing-streak pause fired — always report (never recommend changes from a single streak).
 * @param {boolean} paused
 * @param {number}  losingStreak
 */
export function checkLosingStreakPause(paused, losingStreak) {
  if (!paused) return null;

  return {
    id: "losing_streak_pause",
    title: "Bot paused due to losing streak",
    what: "Human review recommended before resuming. Do not change parameters based on a single streak.",
    why: `Bot entered paused state with losing_streak = ${losingStreak}. This is a designed safety mechanism.`,
    expectedImpact: "No change — this is an observation, not a tuning recommendation",
    risk: "N/A",
    metricCited: `paused=true, losing_streak=${losingStreak}`,
    confidence: "HIGH",
    reversibility: "N/A — human should inspect recent trades before manual resume",
    doNotApplyIf: "N/A",
  };
}

/**
 * Uptime < 95% → infrastructure issue.
 * @param {number} uptimePct — 0..1
 */
export function checkUptime(uptimePct) {
  if (!Number.isFinite(uptimePct) || uptimePct >= 0.95) return null;

  return {
    id: "uptime_below_95",
    title: "Bot uptime below 95%",
    what: "Investigate PM2 restart logs and server health. This is an infrastructure issue, not a tuning issue.",
    why: `Observed ${pct(uptimePct)} uptime (${Math.round(uptimePct * 86400)} / 86400 expected ticks).`,
    expectedImpact: "Recovering missed ticks may increase trade count if signals were firing during downtime",
    risk: "N/A — infrastructure issue",
    metricCited: `uptime = ${pct(uptimePct)}`,
    confidence: "HIGH",
    reversibility: "N/A",
    doNotApplyIf: "N/A",
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Generate all recommendations for a single bot's metrics.
 * @param {object} metrics   — output of compute* functions
 * @param {object} history   — { recentDates, tradeCounts, prevGateHealth }
 * @returns {Recommendation[]}
 */
export function generateRecommendations(metrics, history = {}) {
  const recs = [];

  const push = (r) => { if (r) recs.push(r); };

  push(checkDeadNeutral(
    metrics.signalHealth?.deadNeutralRate,
    metrics.signalHealth?.n ?? 0,
    history.deadNeutralStreak ?? 1
  ));

  const probMarketBlockPct = metrics.gateHealth?.distribution
    ? (metrics.gateHealth.distribution["prob_market_below_0.50"] ?? 0) / (metrics.gateHealth.n || 1)
    : 0;
  push(checkProbMarketBlocks(
    probMarketBlockPct,
    metrics.tradeHealth?.n ?? 0,
    null // underdogWinRate — not available without per-trade market filter
  ));

  const minTicketBlockPct = metrics.gateHealth?.distribution
    ? (metrics.gateHealth.distribution["min_ticket_exceeds_risk_cap"] ?? 0) / (metrics.gateHealth.n || 1)
    : 0;
  push(checkMinTicketBlocks(minTicketBlockPct, metrics.bankrollHealth?.bankroll));

  push(checkCalibrationDrift(
    metrics.tradeHealth?.winRate,
    metrics.tradeHealth?.predictedWinRate,
    metrics.tradeHealth?.settled ?? 0
  ));

  push(checkZeroTradeDays(
    history.recentDates ?? [],
    history.tradeCounts ?? new Map(),
    metrics.gateHealth
  ));

  push(checkLosingStreakPause(
    metrics.bankrollHealth?.paused,
    metrics.bankrollHealth?.losingStreak
  ));

  push(checkUptime(metrics.uptime?.pct));

  return recs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(v) {
  return Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "n/a";
}
