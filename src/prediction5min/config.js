export function createPrediction5mConfig(overrides = {}) {
  return {
    // ── Stake sizing ────────────────────────────────────────────────────────
    stakePct:    0.20,   // 20% of bankroll (same base as 15m)
    minStakeUsd: 1.0,
    maxStakeUsd: 4.25,
    feeRate:     0.02,

    // ── TA thresholds ────────────────────────────────────────────────────────
    // 5m is noisier: lower minProb, tighter edge band to offset false signals
    minProb:            0.72,  // vs 0.80 for 15m — 5m signals are less certain
    minEdge:            0.08,  // vs 0.10 for 15m — harder to find large edges
    maxEdge:            0.20,  // wider upper bound — allow more edge capture
    calibrationFactor:  0.88,  // shrinks model confidence toward 0.5 (vs 0.85 for 15m)
    candleWindowMinutes: 5,    // used for time-decay calculation

    // ── Risk guards ──────────────────────────────────────────────────────────
    stopLossPct:        0.30,  // exit if position loses 30% of contract size
    timeLeftMinMinutes: 1.5,   // don't enter if < 1.5 min to settlement

    // ── Session ──────────────────────────────────────────────────────────────
    tradingHoursStartPst: 6,
    tradingHoursEndPst:   17,
    allowWeekends:        false,

    ...overrides,
  };
}
