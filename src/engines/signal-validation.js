const CALIBRATION_FACTOR = 0.85;

function clamp01(x) {
  if (!Number.isFinite(x)) return null;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function calibrateModelProbabilities(adjustedUp) {
  const up = clamp01(Number(adjustedUp));
  if (up === null) {
    return { ok: false, probModelUp: null, probModelDown: null, reason: "invalid_adjusted_up" };
  }

  const probModelUp = clamp01(0.5 + (up - 0.5) * CALIBRATION_FACTOR);
  const probModelDown = clamp01(1 - probModelUp);

  return {
    ok: true,
    probModelUp,
    probModelDown
  };
}
