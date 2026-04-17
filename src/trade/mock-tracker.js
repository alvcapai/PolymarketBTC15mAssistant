/**
 * Mock calibration tracker.
 *
 * When TRADE_MOCK_MODE=true, the bot never places real orders.
 * This module records paper positions and polls Polymarket for real settlement
 * outcomes so we can measure signal accuracy and calibrate thresholds.
 *
 * Data flow:
 *   recordMockEntry()  → called when entry conditions are met (no real trade)
 *   checkMockOutcomes() → called every 2 min; resolves positions whose endDate
 *                         has passed and writes WIN/LOSS rows to calibration CSV
 */

import { fetchMarketBySlug } from "../data/polymarket.js";
import { appendCsvRow } from "../utils.js";

const mockPositions = new Map(); // marketSlug → MockPosition

export const MOCK_CSV_HEADER = [
  "timestamp_entry",
  "timestamp_outcome",
  "timeframe",
  "market_slug",
  "side",
  "entry_price",
  "stake_usd",
  "prob_model",
  "prob_market",
  "edge",
  "raw_up",
  "time_left_min_at_entry",
  "winner_side",
  "outcome",
  "pnl_mock_usd",
  "signals_json",
];

/**
 * Record a paper entry when all conditions would have been met.
 *
 * @param {object} p
 * @param {string}  p.timeframe       e.g. "btc-5m"
 * @param {string}  p.marketSlug      Polymarket market slug
 * @param {string}  p.side            "UP" | "DOWN"
 * @param {number}  p.entryPrice      Ask price at which we would have entered
 * @param {number}  p.endDateMs       Market settlement timestamp (ms)
 * @param {number}  p.stake           Dollar amount of paper trade
 * @param {number|null} p.probModel   Model probability for chosen side
 * @param {number|null} p.probMarket  Market price for chosen side
 * @param {number|null} p.edge        Model - market edge
 * @param {number|null} p.rawUp       Raw signal score from scoreDirection (0–1)
 * @param {number|null} p.timeLeftMin Minutes to settlement at entry time
 * @param {object}  [p.signals]       Extra TA snapshot for debugging (serialized as JSON)
 */
export function recordMockEntry({
  timeframe,
  marketSlug,
  side,
  entryPrice,
  endDateMs,
  stake,
  probModel   = null,
  probMarket  = null,
  edge        = null,
  rawUp       = null,
  timeLeftMin = null,
  signals     = {},
}) {
  if (!marketSlug || mockPositions.has(marketSlug)) return;

  mockPositions.set(marketSlug, {
    timestampEntry: new Date().toISOString(),
    timeframe,
    marketSlug,
    side,
    entryPrice,
    endDateMs,
    stake,
    probModel,
    probMarket,
    edge,
    rawUp,
    timeLeftMin,
    signals,
  });

  process.stderr.write(
    `\x1b[35m[MOCK-ENTRY] ${timeframe} | ${side} @ ${entryPrice} | slug=${marketSlug} | ` +
    `stake=$${stake?.toFixed(2)} | edge=${edge != null ? (edge * 100).toFixed(2) + "%" : "-"} | ` +
    `prob_model=${probModel != null ? (probModel * 100).toFixed(1) + "%" : "-"}\x1b[0m\n`
  );
}

/**
 * Poll settled paper positions and write calibration rows to CSV.
 * Called on the same 2-minute interval as runAutoRedeem().
 *
 * @param {object} opts
 * @param {string}  opts.csvPath    Path to write calibration CSV
 * @param {string}  [opts.upLabel]  Polymarket "Up" outcome label
 * @param {string}  [opts.downLabel] Polymarket "Down" outcome label
 */
export async function checkMockOutcomes({ csvPath, upLabel = "Up", downLabel = "Down" }) {
  const now = Date.now();
  const GRACE_MS = 90_000; // wait 90s after endDate — gives settlement time to propagate

  for (const [slug, pos] of mockPositions) {
    if (now < pos.endDateMs + GRACE_MS) continue;

    try {
      const market = await fetchMarketBySlug(slug);
      if (!market) continue;

      const outcomes = Array.isArray(market.outcomes)
        ? market.outcomes
        : JSON.parse(market.outcomes || "[]");
      const prices = Array.isArray(market.outcomePrices)
        ? market.outcomePrices
        : JSON.parse(market.outcomePrices || "[]");

      const upIdx   = outcomes.findIndex((o) => String(o).toLowerCase() === upLabel.toLowerCase());
      const downIdx = outcomes.findIndex((o) => String(o).toLowerCase() === downLabel.toLowerCase());
      if (upIdx < 0 || downIdx < 0) continue;

      const upSettled   = Number(prices[upIdx]);
      const downSettled = Number(prices[downIdx]);

      // Skip if not yet settled (prices still ambiguous, i.e. both near 0.5)
      if (Math.abs(upSettled - 0.5) < 0.45) continue;

      const winnerSide = upSettled > 0.5 ? "UP" : "DOWN";
      const won        = pos.side === winnerSide;

      // Estimated P&L: buying `shares` at entryPrice, each share pays $1 if won
      const shares    = pos.stake / pos.entryPrice;
      const pnlMock   = won
        ? +(shares * (1 - pos.entryPrice)).toFixed(4)
        : +(-pos.stake).toFixed(4);

      appendCsvRow(csvPath, MOCK_CSV_HEADER, [
        pos.timestampEntry,
        new Date().toISOString(),
        pos.timeframe,
        slug,
        pos.side,
        pos.entryPrice,
        pos.stake,
        pos.probModel   ?? "",
        pos.probMarket  ?? "",
        pos.edge        ?? "",
        pos.rawUp       ?? "",
        pos.timeLeftMin ?? "",
        winnerSide,
        won ? "WIN" : "LOSS",
        pnlMock,
        JSON.stringify(pos.signals),
      ]);

      mockPositions.delete(slug);

      process.stderr.write(
        `\x1b[${won ? "32" : "31"}m[MOCK-OUTCOME] ${won ? "WIN ✓" : "LOSS ✗"} | ` +
        `${pos.timeframe} | side=${pos.side} winner=${winnerSide} | ` +
        `slug=${slug} | pnl=$${pnlMock.toFixed(2)}\x1b[0m\n`
      );
    } catch {
      // Market not yet available or API error — will retry next interval
    }
  }
}

/** Number of paper positions currently being tracked. */
export function mockPositionCount() {
  return mockPositions.size;
}
