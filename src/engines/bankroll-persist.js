import { writeFile, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createBankrollState } from "./risk-management.js";
import { logger } from "../logging/logger.js";

/**
 * Persists bankroll state to disk (async, non-blocking).
 * Call after any state mutation: trade open, outcome, withdrawal, sync.
 */
export function saveBankrollState(state, filePath) {
  try { mkdirSync(dirname(filePath), { recursive: true }); } catch { /* already exists */ }
  const data = {
    bankroll:       state.bankroll,
    cycleNumber:    state.cycleNumber,
    losingStreak:   state.losingStreak,
    paused:         state.paused,
    cycleEnded:     state.cycleEnded,
    totalWithdrawn: state.totalWithdrawn,
    openPositions:  state.openPositions,
    totalExposure:  state.totalExposure,
    // Map is not JSON-serializable — store as array of [key, value] pairs
    positions:      [...state.positions.entries()],
    savedAt:        new Date().toISOString(),
  };
  writeFile(filePath, JSON.stringify(data, null, 2), (err) => {
    if (err) {
      logger.error({ component: "persist", err: err.message }, "Failed to save bankroll state");
    }
  });
}

/**
 * Loads bankroll state from disk.
 * Falls back to a fresh state with initialBankroll if the file doesn't exist or is corrupt.
 */
export function loadBankrollState(filePath, initialBankroll = 20) {
  try {
    const raw  = readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);

    const state = createBankrollState(initialBankroll);
    state.bankroll       = Number.isFinite(Number(data.bankroll))       ? Number(data.bankroll)       : initialBankroll;
    state.cycleNumber    = Number.isFinite(Number(data.cycleNumber))    ? Number(data.cycleNumber)    : 1;
    state.losingStreak   = Number.isFinite(Number(data.losingStreak))   ? Number(data.losingStreak)   : 0;
    state.paused         = Boolean(data.paused);
    state.cycleEnded     = Boolean(data.cycleEnded);
    state.totalWithdrawn = Number.isFinite(Number(data.totalWithdrawn)) ? Number(data.totalWithdrawn) : 0;
    state.openPositions  = Number.isFinite(Number(data.openPositions))  ? Number(data.openPositions)  : 0;
    state.totalExposure  = Number.isFinite(Number(data.totalExposure))  ? Number(data.totalExposure)  : 0;

    if (Array.isArray(data.positions)) {
      state.positions = new Map(data.positions);
    }

    logger.info({
      component: "persist", filePath,
      bankroll: state.bankroll, cycle: state.cycleNumber,
      streak: state.losingStreak, positions: state.positions.size,
      savedAt: data.savedAt,
    }, "Bankroll state loaded");
    return state;
  } catch {
    logger.warn({ component: "persist", filePath, initialBankroll }, "No saved state — starting fresh");
    return createBankrollState(initialBankroll);
  }
}
