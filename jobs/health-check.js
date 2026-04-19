#!/usr/bin/env node
/**
 * jobs/health-check.js
 *
 * Daily health check job for all running Polymarket bots.
 *
 * Usage:
 *   node jobs/health-check.js [--date YYYY-MM-DD] [--dry-run] [--lookback-hours N]
 *
 * Flags:
 *   --date YYYY-MM-DD     Override the report date (defaults to today)
 *   --dry-run             Print the report to stdout; do NOT write any files
 *   --lookback-hours N    Analysis window in hours (default: 24)
 *
 * Outputs (unless --dry-run):
 *   reports/health/YYYY-MM-DD.md  — daily report
 *   reports/health/TODO.md        — updated tuning backlog
 *
 * Read-only against bot processes. Does NOT restart, modify config, or write
 * to any log file the bots own.
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readSignals,
  readCounterfactuals,
  readTrades,
  readBankrollState,
  readTelemetryBlocks,
  listReportDates,
} from "./lib/parse-logs.js";

import {
  computeSignalHealth,
  computeGateHealth,
  computeTradeHealth,
  computeBankrollHealth,
  computeUptime,
} from "./lib/metrics.js";

import { generateRecommendations } from "./lib/recommendations.js";
import { loadTodo, upsertItem, saveTodo } from "./lib/todo-manager.js";
import { formatReport } from "./lib/report-writer.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");

const BOTS      = ["btc-15m", "eth-15m"]; // 5m bots excluded — not running
const LOGS_DIR  = path.join(ROOT, "logs");
const DATA_DIR  = path.join(ROOT, "data");
const REPORTS_DIR = path.join(ROOT, "reports", "health");
const TODO_FILE = path.join(REPORTS_DIR, "TODO.md");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    date:          todayString(),
    dryRun:        false,
    lookbackHours: 24,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      opts.dryRun = true;
    } else if (args[i] === "--date" && args[i + 1]) {
      opts.date = args[++i];
    } else if (args[i] === "--lookback-hours" && args[i + 1]) {
      opts.lookbackHours = Number(args[++i]);
    }
  }

  return opts;
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Per-bot data collection + metric computation
// ---------------------------------------------------------------------------

async function collectBotMetrics(bot, sinceMs, untilMs, prevSinceMs) {
  const dataQualityNotes = [];

  // Read current window data
  const [signalRows, cfRows, { opened, closedByTradeId }, bankrollState] =
    await Promise.all([
      readSignals(LOGS_DIR, bot, sinceMs, untilMs).catch((e) => {
        dataQualityNotes.push(`${bot}: readSignals failed — ${e.message}`);
        return [];
      }),
      readCounterfactuals(LOGS_DIR, bot, sinceMs, untilMs).catch((e) => {
        dataQualityNotes.push(`${bot}: readCounterfactuals failed — ${e.message}`);
        return [];
      }),
      readTrades(DATA_DIR, bot, sinceMs, untilMs).catch((e) => {
        dataQualityNotes.push(`${bot}: readTrades failed — ${e.message}`);
        return { opened: [], closedByTradeId: new Map() };
      }),
      Promise.resolve(readBankrollState(LOGS_DIR, bot)),
    ]);

  // Previous window data (for gate deltas)
  const prevCfRows = await readCounterfactuals(LOGS_DIR, bot, prevSinceMs, sinceMs).catch(() => []);

  // Data quality observations
  if (signalRows.length === 0) {
    dataQualityNotes.push(`${bot}: no signal rows found in window — log file may be empty or rotated`);
  }
  if (cfRows.length === 0 && signalRows.length > 0) {
    dataQualityNotes.push(`${bot}: counterfactual rows missing but signal rows present — counterfactual.csv may not be written yet`);
  }
  if (!bankrollState) {
    dataQualityNotes.push(`${bot}: bankroll state file not found`);
  }

  // Compute metrics
  const signalHealth   = computeSignalHealth(signalRows);
  const gateHealth     = computeGateHealth(cfRows, prevCfRows);
  const tradeHealth    = computeTradeHealth(opened, closedByTradeId);
  const bankrollHealth = computeBankrollHealth(bankrollState);
  const uptime         = computeUptime(signalRows, 24);

  return {
    signalHealth,
    gateHealth,
    tradeHealth,
    bankrollHealth,
    uptime,
    dataQualityNotes,
  };
}

// ---------------------------------------------------------------------------
// Historical context for recommendations
// ---------------------------------------------------------------------------

function buildHistory(date) {
  const reportDates = listReportDates(REPORTS_DIR);

  // Build a trade count map from TODO items (approximated from saved items)
  // For a full implementation we'd read each report, but the TODO's seenCount
  // on zero_trade_days is sufficient to detect persistent streaks.
  const tradeCounts = new Map(); // date → trade count (left empty; checkZeroTradeDays uses recentDates)

  return {
    recentDates:       reportDates.slice(-7),
    tradeCounts,
    deadNeutralStreak: 1, // would need to parse prior reports for a real streak count
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  const { date, dryRun, lookbackHours } = opts;

  const untilMs    = new Date(date + "T23:59:59Z").getTime();
  const sinceMs    = untilMs - lookbackHours * 3600 * 1000;
  const prevSinceMs = sinceMs - lookbackHours * 3600 * 1000;

  process.stderr.write(`[health-check] date=${date} lookback=${lookbackHours}h dryRun=${dryRun}\n`);

  // --- Collect per-bot metrics ---
  const botResults        = {};
  const allDataQualityNotes = [];

  for (const bot of BOTS) {
    process.stderr.write(`[health-check] collecting metrics for ${bot}…\n`);
    const result = await collectBotMetrics(bot, sinceMs, untilMs, prevSinceMs);
    const { dataQualityNotes, ...metrics } = result;
    allDataQualityNotes.push(...dataQualityNotes);

    // Generate recommendations
    const history = buildHistory(date);
    const recommendations = generateRecommendations(metrics, history);

    botResults[bot] = { ...metrics, recommendations };
  }

  // --- Format report ---
  const report = formatReport(date, botResults, allDataQualityNotes);

  if (dryRun) {
    process.stdout.write(report);
    process.stderr.write("\n[health-check] --dry-run: no files written\n");
    return;
  }

  // --- Write report file ---
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const reportFile = path.join(REPORTS_DIR, `${date}.md`);
  fs.writeFileSync(reportFile, report, "utf8");
  process.stderr.write(`[health-check] wrote ${reportFile}\n`);

  // --- Update TODO.md ---
  let items = loadTodo(TODO_FILE);
  for (const [bot, result] of Object.entries(botResults)) {
    for (const rec of result.recommendations) {
      items = upsertItem(items, rec, bot, date);
    }
  }
  saveTodo(TODO_FILE, items);
  process.stderr.write(`[health-check] updated ${TODO_FILE} (${items.length} items)\n`);

  // --- Summary to stdout ---
  const totalRecs = Object.values(botResults).reduce(
    (s, r) => s + (r.recommendations?.length ?? 0), 0
  );
  const openItems = items.filter((it) => it.status === "OPEN").length;
  process.stdout.write(
    `[health-check] DONE — report: ${reportFile} | recs today: ${totalRecs} | open TODO items: ${openItems}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[health-check] FATAL: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
