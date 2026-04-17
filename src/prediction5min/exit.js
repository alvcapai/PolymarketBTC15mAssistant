const SETTLEMENT_IMMINENT_SEC = 60;

export const ExitReason = Object.freeze({
  STOP_LOSS:            "stop_loss",
  SETTLEMENT_IMMINENT:  "settlement_imminent",
  MARKET_ROLLED:        "market_rolled",
  MANUAL_KILL_SWITCH:   "manual_kill_switch",
});

export function evaluateExit(state, position, snapshot, cfg, now = new Date()) {
  const nowMs = now.getTime();

  if (state.killSwitch) return { type: "exit", reason: ExitReason.MANUAL_KILL_SWITCH };

  if (snapshot.marketSlug !== position.marketSlug && nowMs >= position.marketEndDate) {
    return { type: "exit", reason: ExitReason.MARKET_ROLLED };
  }

  if (snapshot.marketSlug === position.marketSlug && snapshot.endDate !== null) {
    const timeLeftSec = (snapshot.endDate - nowMs) / 1000;
    if (timeLeftSec < SETTLEMENT_IMMINENT_SEC) {
      return { type: "exit", reason: ExitReason.SETTLEMENT_IMMINENT };
    }
  }

  const markPrice = position.side === "UP"
    ? (snapshot.upBid ?? snapshot.upPrice)
    : (snapshot.downBid ?? snapshot.downPrice);

  if (markPrice !== null && markPrice !== undefined) {
    const unrealizedPnl    = (markPrice - position.entryPrice) * position.shares;
    const stopLossThreshold = -(position.contractSize * cfg.stopLossPct);
    if (unrealizedPnl <= stopLossThreshold) {
      return { type: "exit", reason: ExitReason.STOP_LOSS };
    }
  }

  return { type: "hold" };
}
