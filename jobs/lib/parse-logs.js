/**
 * jobs/lib/parse-logs.js
 *
 * Read-only parsers for every log source the bots produce.
 * All functions return plain objects/arrays — no side effects.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CALIBRATION_A = 6.0; // must match signal-validation.js

/** Sigmoid inverse (logit). Returns null if p is 0 or 1. */
export function logit(p) {
  if (p <= 0 || p >= 1) return null;
  return Math.log(p / (1 - p));
}

/**
 * Recover the pre-calibration adjustedUp from a calibrated prob_model_up.
 * calibratedUp = sigmoid(a * (adjustedUp - 0.5))
 * → adjustedUp  = 0.5 + logit(calibratedUp) / a
 */
export function deriveAdjustedUp(probModelUp) {
  const p = Number(probModelUp);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return 0.5 + logit(p) / CALIBRATION_A;
}

/** Parse a timestamp string; return ms epoch or null. */
function parseTs(s) {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/** Read a file line by line via readline (streaming, handles large files). */
async function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    lines.push(line);
  }
  return lines;
}

/** Parse a CSV file (with header row). Returns array of row objects. */
async function parseCsv(filePath) {
  const lines = await readLines(filePath);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Naive CSV split — quotes not used in these files
    const vals = line.split(",");
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = vals[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Signals CSV  (logs/signals-{asset}-{window}.csv)
// ---------------------------------------------------------------------------

/**
 * Returns signal rows for one bot within a time window.
 * @param {string} logDir
 * @param {string} bot  e.g. "btc-15m"
 * @param {number} sinceMs  epoch ms (inclusive lower bound)
 * @param {number} untilMs  epoch ms (exclusive upper bound), default = now
 */
export async function readSignals(logDir, bot, sinceMs, untilMs = Date.now()) {
  const [asset, window] = bot.split("-"); // "btc", "15m"
  const filePath = path.join(logDir, `signals-${asset}-${window}.csv`);
  const rows = await parseCsv(filePath);
  return rows
    .map((r) => ({
      tsMs:          parseTs(r.timestamp),
      entryMinute:   Number(r.entry_minute),
      timeLeftMin:   Number(r.time_left_min),
      signal:        r.signal,
      decisionReason: r.decision_reason,
      side:          r.side,
      probModelUp:   Number(r.prob_model_up),
      probModelDown: Number(r.prob_model_down),
      probMarketUp:  Number(r.prob_market_up),
      probMarketDown: Number(r.prob_market_down),
      edgeUp:        Number(r.edge_up),
      edgeDown:      Number(r.edge_down),
      stakeUsd:      Number(r.stake_usd),
      // Derived: adjustedUp via inverse calibration
      adjustedUp: deriveAdjustedUp(r.prob_model_up),
    }))
    .filter((r) => r.tsMs !== null && r.tsMs >= sinceMs && r.tsMs < untilMs);
}

// ---------------------------------------------------------------------------
// Counterfactual CSV  (logs/counterfactual.csv — shared across all bots)
// ---------------------------------------------------------------------------

const SLUG_PREFIX = {
  "btc-15m": "btc-",
  "eth-15m": "eth-",
  "btc-5m":  "btc-",
  "eth-5m":  "eth-",
};

/**
 * Returns counterfactual rows for one bot within a time window.
 * Distinguishes bots by market_slug prefix.
 */
export async function readCounterfactuals(logDir, bot, sinceMs, untilMs = Date.now()) {
  const filePath = path.join(logDir, "counterfactual.csv");
  const rows = await parseCsv(filePath);
  const slugPrefix = SLUG_PREFIX[bot] ?? "";
  const windowFilter = bot.includes("15m") ? "updown-15m" : "updown-5m";

  return rows
    .map((r) => ({
      tsMs:          parseTs(r.timestamp),
      marketSlug:    r.market_slug,
      sideConsidered: r.side_considered,
      probModel:     Number(r.prob_model) || null,
      probMarket:    Number(r.prob_market) || null,
      rawEdge:       r.raw_edge !== "" ? Number(r.raw_edge) : null,
      netEdge:       r.net_edge !== "" ? Number(r.net_edge) : null,
      gateThatBlocked: r.gate_that_blocked,
      wouldHaveStake: r.would_have_stake !== "" ? Number(r.would_have_stake) : null,
      settledOutcome: r.actual_settled_outcome || null,
    }))
    .filter(
      (r) =>
        r.tsMs !== null &&
        r.tsMs >= sinceMs &&
        r.tsMs < untilMs &&
        r.marketSlug.startsWith(slugPrefix) &&
        r.marketSlug.includes(windowFilter)
    );
}

// ---------------------------------------------------------------------------
// Trade JSONL  (data/trades_opened.jsonl / trades_closed.jsonl)
// ---------------------------------------------------------------------------

const MARKET_TYPE_MAP = {
  BTC15M: "btc-15m",
  ETH15M: "eth-15m",
  BTC5M:  "btc-5m",
  ETH5M:  "eth-5m",
};

async function readJsonl(filePath) {
  const lines = await readLines(filePath);
  const records = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // malformed line — skip
    }
  }
  return records;
}

/** Returns { opened, closed } filtered to the given bot and time window. */
export async function readTrades(dataDir, bot, sinceMs, untilMs = Date.now()) {
  const openedPath = path.join(dataDir, "trades_opened.jsonl");
  const closedPath = path.join(dataDir, "trades_closed.jsonl");

  const [allOpened, allClosed] = await Promise.all([
    readJsonl(openedPath).catch(() => []),
    readJsonl(closedPath).catch(() => []),
  ]);

  const botKey = Object.entries(MARKET_TYPE_MAP).find(([, v]) => v === bot)?.[0];

  const opened = allOpened.filter((r) => {
    const ts = parseTs(r.timestamp_open);
    return (
      ts !== null &&
      ts >= sinceMs &&
      ts < untilMs &&
      (r.market_type === botKey || r.market_slug?.includes(bot.replace("-", "-updown-")))
    );
  });

  // Build a trade_id → close map for quick lookup
  const closedByTradeId = new Map(allClosed.map((r) => [r.trade_id, r]));

  return { opened, closedByTradeId };
}

// ---------------------------------------------------------------------------
// Bankroll state  (logs/bankroll-{asset}-{window}.json)
// ---------------------------------------------------------------------------

export function readBankrollState(logDir, bot) {
  const [asset, window] = bot.split("-");
  const filePath = path.join(logDir, `bankroll-${asset}-${window}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// [TELEMETRY] lines from err.log
// ---------------------------------------------------------------------------

// ANSI escape codes injected by the bot; strip them before processing.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Parse [TELEMETRY] block-distribution entries from an err.log file.
 * Returns an array of { sinceTs, untilTs, distribution: { reason → count } }
 * for entries whose last-line timestamp falls within the time window.
 */
export async function readTelemetryBlocks(logDir, bot, sinceMs, untilMs = Date.now()) {
  const logName = bot.replace("-", "").replace("m", "m"); // btc15m / eth15m
  const filePath = path.join(logDir, `${logName}-err.log`);
  const lines = await readLines(filePath);

  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i].replace(ANSI_RE, "");
    if (!raw.includes("[TELEMETRY]") || !raw.includes("Block distribution")) {
      i++;
      continue;
    }

    // Extract timestamp from the PM2 prefix (format: "2026-04-19T18:xx:xx: ...")
    const tsMatch = raw.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+):/);
    const tsMs = tsMatch ? parseTs(tsMatch[1]) : null;

    if (tsMs === null || tsMs < sinceMs || tsMs >= untilMs) {
      i++;
      continue;
    }

    // Parse continuation lines (indented reason rows)
    const distribution = {};
    i++;
    while (i < lines.length) {
      const contRaw = lines[i].replace(ANSI_RE, "");
      // Reason lines are indented with spaces and have a right-aligned count
      const match = contRaw.match(/^\s{2,}(\S.*?)\s+(\d+)\s*$/);
      if (!match) break;
      distribution[match[1].trim()] = Number(match[2]);
      i++;
    }

    blocks.push({ tsMs, distribution });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Historical report index (for consecutive-zero-days check)
// ---------------------------------------------------------------------------

/**
 * Returns the dates (YYYY-MM-DD strings) for which a health report exists
 * in the reports directory, sorted ascending.
 */
export function listReportDates(reportsDir) {
  if (!fs.existsSync(reportsDir)) return [];
  return fs
    .readdirSync(reportsDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => f.replace(".md", ""))
    .sort();
}
