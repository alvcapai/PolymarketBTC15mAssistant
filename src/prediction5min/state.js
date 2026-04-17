const CIRCUIT_TRIP_LOSSES    = 3;
const CIRCUIT_BASE_COOLDOWN_MS = 5_000;
const CIRCUIT_MAX_COOLDOWN_MS  = 60_000;

export function createCircuitBreaker() {
  return { consecutiveLosses: 0, cooldownUntil: null };
}

export function isCircuitTripped(cb, nowMs = Date.now()) {
  return cb.cooldownUntil !== null && nowMs < cb.cooldownUntil;
}

export function circuitReset(cb) {
  cb.consecutiveLosses = 0;
  cb.cooldownUntil = null;
}

export function circuitRecordLoss(cb, nowMs = Date.now()) {
  cb.consecutiveLosses += 1;
  if (cb.consecutiveLosses >= CIRCUIT_TRIP_LOSSES) {
    const extra = cb.consecutiveLosses - CIRCUIT_TRIP_LOSSES;
    const ms = Math.min(CIRCUIT_BASE_COOLDOWN_MS * Math.pow(2, Math.min(extra, 5)), CIRCUIT_MAX_COOLDOWN_MS);
    cb.cooldownUntil = nowMs + ms;
  }
}

export function createPrediction5mState() {
  return {
    tradingEnabled:  true,
    killSwitch:      false,
    hasOpenPosition: false,
    circuitBreaker:  createCircuitBreaker(),
  };
}
