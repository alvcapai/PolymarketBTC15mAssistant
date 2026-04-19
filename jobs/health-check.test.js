/**
 * jobs/health-check.test.js
 *
 * Unit tests for the health check job modules.
 * Uses node:test (built-in, no new deps).
 *
 *   node --test jobs/health-check.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { logit, deriveAdjustedUp } from "./lib/parse-logs.js";
import {
  bucketize,
  computeSignalHealth,
  computeGateHealth,
  computeTradeHealth,
  computeBankrollHealth,
  computeUptime,
  normalizeGateKey,
} from "./lib/metrics.js";
import {
  checkDeadNeutral,
  checkProbMarketBlocks,
  checkMinTicketBlocks,
  checkCalibrationDrift,
  checkZeroTradeDays,
  checkLosingStreakPause,
  checkUptime,
  generateRecommendations,
} from "./lib/recommendations.js";
import { parseTodo, upsertItem, saveTodo, loadTodo } from "./lib/todo-manager.js";
import { formatReport } from "./lib/report-writer.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// parse-logs helpers
// ---------------------------------------------------------------------------

describe("logit", () => {
  it("returns null for p=0", () => assert.equal(logit(0), null));
  it("returns null for p=1", () => assert.equal(logit(1), null));
  it("returns 0 for p=0.5", () => assert.equal(logit(0.5), 0));
  it("returns positive for p>0.5", () => assert.ok(logit(0.7) > 0));
  it("returns negative for p<0.5", () => assert.ok(logit(0.3) < 0));
});

describe("deriveAdjustedUp", () => {
  it("returns null for out-of-range inputs", () => {
    assert.equal(deriveAdjustedUp(0),   null);
    assert.equal(deriveAdjustedUp(1),   null);
    assert.equal(deriveAdjustedUp(-0.1), null);
    assert.equal(deriveAdjustedUp(1.1),  null);
  });

  it("returns 0.5 for probModelUp=0.5 (round-trip identity)", () => {
    const v = deriveAdjustedUp(0.5);
    assert.ok(v !== null);
    assert.ok(Math.abs(v - 0.5) < 1e-9);
  });

  it("inverse is consistent with calibration (a=6)", () => {
    // If adjustedUp = 0.6, calibratedUp = sigmoid(6*(0.6-0.5)) = sigmoid(0.6)
    const a = 6.0;
    const adjustedUp = 0.6;
    const calibratedUp = 1 / (1 + Math.exp(-a * (adjustedUp - 0.5)));
    const recovered = deriveAdjustedUp(calibratedUp);
    assert.ok(Math.abs(recovered - adjustedUp) < 1e-9);
  });

  it("handles string input (CSV parse artifact)", () => {
    const v = deriveAdjustedUp("0.7");
    assert.ok(v !== null && Number.isFinite(v));
  });
});

// ---------------------------------------------------------------------------
// metrics: bucketize
// ---------------------------------------------------------------------------

describe("bucketize", () => {
  it("returns correct bucket count", () => {
    const buckets = bucketize([0.1, 0.5, 0.9], 0, 1, 5);
    assert.equal(buckets.length, 5);
  });

  it("assigns values to correct buckets", () => {
    const buckets = bucketize([0.0, 0.25, 0.75, 1.0], 0, 1, 4);
    // [0,.25) [.25,.5) [.5,.75) [.75,1.0)
    // 0.0 → bucket 0; 0.25 → bucket 1; 0.75 → bucket 3; 1.0 → clamped to bucket 3
    assert.equal(buckets[0].n, 1);
    assert.equal(buckets[1].n, 1);
    assert.equal(buckets[2].n, 0);
    assert.equal(buckets[3].n, 2);
  });

  it("ignores non-finite values", () => {
    const buckets = bucketize([NaN, Infinity, 0.5], 0, 1, 2);
    const total = buckets.reduce((s, b) => s + b.n, 0);
    assert.equal(total, 1);
  });

  it("pct sums to ~1", () => {
    const buckets = bucketize([0.1, 0.3, 0.5, 0.7, 0.9]);
    const sum = buckets.reduce((s, b) => s + b.pct, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9);
  });
});

// ---------------------------------------------------------------------------
// metrics: normalizeGateKey
// ---------------------------------------------------------------------------

describe("normalizeGateKey", () => {
  it("strips numeric values between gate labels", () => {
    assert.equal(
      normalizeGateKey("prob_model_0.4502_below_0.54"),
      "prob_model_below_0.54"
    );
  });

  it("strips _bankroll_N suffix", () => {
    assert.equal(
      normalizeGateKey("min_ticket_3.03_exceeds_risk_cap_3.05_bankroll_20.34"),
      "min_ticket_exceeds_risk_cap"
    );
  });

  it("leaves clean keys unchanged", () => {
    assert.equal(normalizeGateKey("prob_market_below_0.50"), "prob_market_below_0.50");
  });

  it("returns 'none' for empty/null", () => {
    assert.equal(normalizeGateKey(""), "none");
    assert.equal(normalizeGateKey(null), "none");
    assert.equal(normalizeGateKey(undefined), "none");
    assert.equal(normalizeGateKey("none"), "none");
  });
});

// ---------------------------------------------------------------------------
// metrics: computeSignalHealth
// ---------------------------------------------------------------------------

describe("computeSignalHealth", () => {
  it("returns nulls for empty input", () => {
    const r = computeSignalHealth([]);
    assert.equal(r.n, 0);
    assert.equal(r.deadNeutralRate, null);
  });

  it("computes dead-neutral rate correctly", () => {
    const rows = [
      { probModelUp: 0.50, adjustedUp: 0.5 },
      { probModelUp: 0.50, adjustedUp: 0.5 },
      { probModelUp: 0.70, adjustedUp: 0.6 },
      { probModelUp: 0.30, adjustedUp: 0.4 },
    ];
    const r = computeSignalHealth(rows);
    assert.equal(r.deadNeutralRate, 0.5); // 2 out of 4
  });

  it("computes spurious neutral rate (should be 0 for good data)", () => {
    const rows = [
      { probModelUp: 0.50, adjustedUp: 0.5 },   // neutral — not spurious
      { probModelUp: 0.70, adjustedUp: 0.6 },   // not neutral
    ];
    const r = computeSignalHealth(rows);
    assert.equal(r.spuriousNeutralRate, 0);
  });

  it("detects spurious neutral (calibration bug simulation)", () => {
    // If adjustedUp is extreme but probModel is neutral, that's a bug
    const rows = [
      { probModelUp: 0.50, adjustedUp: 0.80 }, // extreme adjustedUp but neutral probModel
    ];
    const r = computeSignalHealth(rows);
    assert.equal(r.spuriousNeutralRate, 1.0);
  });

  it("analyzes prob_model_blocked ticks", () => {
    const rows = [
      { probModelUp: 0.48, adjustedUp: 0.49, decisionReason: "prob_model_0.48_below_0.54" },
      { probModelUp: 0.45, adjustedUp: 0.40, decisionReason: "prob_model_0.45_below_0.54" },
    ];
    const r = computeSignalHealth(rows);
    const a = r.blockedByProbModelAnalysis;
    assert.ok(a !== null);
    assert.equal(a.total, 2);
    assert.equal(a.genuineNeutral, 1); // only first has adjustedUp in [0.45, 0.55]
    assert.equal(a.realSignalBlocked, 1);
  });
});

// ---------------------------------------------------------------------------
// metrics: computeGateHealth
// ---------------------------------------------------------------------------

describe("computeGateHealth", () => {
  it("returns zero struct for empty input", () => {
    const r = computeGateHealth([]);
    assert.equal(r.n, 0);
    assert.deepEqual(r.distribution, {});
  });

  it("aggregates normalized gate keys", () => {
    const rows = [
      { gateThatBlocked: "prob_model_0.45_below_0.54", tsMs: 1 },
      { gateThatBlocked: "prob_model_0.48_below_0.54", tsMs: 2 },
      { gateThatBlocked: "prob_market_below_0.50",     tsMs: 3 },
    ];
    const r = computeGateHealth(rows);
    assert.equal(r.distribution["prob_model_below_0.54"], 2);
    assert.equal(r.distribution["prob_market_below_0.50"], 1);
    assert.equal(r.n, 3);
  });

  it("returns top 3 by count", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      gateThatBlocked: i < 5 ? "gate_a" : i < 8 ? "gate_b" : "gate_c",
    }));
    const r = computeGateHealth(rows);
    assert.equal(r.top3[0].reason, "gate_a");
    assert.equal(r.top3[1].reason, "gate_b");
    assert.equal(r.top3[2].reason, "gate_c");
  });

  it("computes deltas vs previous window", () => {
    const curr = [
      { gateThatBlocked: "gate_a" },
      { gateThatBlocked: "gate_a" },
    ];
    const prev = [{ gateThatBlocked: "gate_a" }];
    const r = computeGateHealth(curr, prev);
    // curr: gate_a = 2/2 = 100%. prev: gate_a = 1/1 = 100%. delta = 0.
    assert.ok(Math.abs(r.deltas["gate_a"]) < 1e-9);
  });
});

// ---------------------------------------------------------------------------
// metrics: computeTradeHealth
// ---------------------------------------------------------------------------

describe("computeTradeHealth", () => {
  it("returns zero struct for empty input", () => {
    const r = computeTradeHealth([], new Map());
    assert.equal(r.n, 0);
    assert.equal(r.winRate, null);
  });

  it("computes win rate from settled trades", () => {
    const opens = [
      { trade_id: "t1", prob_modelo: 0.6, edge: 0.05 },
      { trade_id: "t2", prob_modelo: 0.6, edge: 0.05 },
      { trade_id: "t3", prob_modelo: 0.6, edge: 0.05 },
    ];
    const closedByTradeId = new Map([
      ["t1", { won: true,  pnl_realized: 1.0 }],
      ["t2", { won: false, pnl_realized: -1.0 }],
      // t3 not settled
    ]);
    const r = computeTradeHealth(opens, closedByTradeId);
    assert.equal(r.n, 3);
    assert.equal(r.settled, 2);
    assert.equal(r.won, 1);
    assert.equal(r.lost, 1);
    assert.equal(r.winRate, 0.5);
    assert.ok(Math.abs(r.totalPnl - 0.0) < 1e-9);
  });
});

// ---------------------------------------------------------------------------
// metrics: computeBankrollHealth
// ---------------------------------------------------------------------------

describe("computeBankrollHealth", () => {
  it("returns available=false for null state", () => {
    const r = computeBankrollHealth(null);
    assert.equal(r.available, false);
  });

  it("surfaces losing_streak_pause risk event", () => {
    const r = computeBankrollHealth({
      bankroll: 15.0, cycleNumber: 2, losingStreak: 3,
      paused: true, cycleEnded: false, totalWithdrawn: 0,
      openPositions: [], totalExposure: 0, savedAt: new Date().toISOString()
    });
    assert.ok(r.riskEvents.includes("losing_streak_pause"));
  });

  it("no risk events when healthy", () => {
    const r = computeBankrollHealth({
      bankroll: 25.0, cycleNumber: 1, losingStreak: 0,
      paused: false, cycleEnded: false, totalWithdrawn: 0,
      openPositions: [], totalExposure: 0, savedAt: new Date().toISOString()
    });
    assert.deepEqual(r.riskEvents, []);
  });
});

// ---------------------------------------------------------------------------
// metrics: computeUptime
// ---------------------------------------------------------------------------

describe("computeUptime", () => {
  it("computes pct from tick count", () => {
    const rows = Array.from({ length: 43200 }); // 12h of ticks
    const r = computeUptime(rows, 24);
    assert.ok(Math.abs(r.pct - 0.5) < 1e-9);
  });

  it("returns 0 for empty rows", () => {
    const r = computeUptime([], 24);
    assert.equal(r.pct, 0);
  });
});

// ---------------------------------------------------------------------------
// recommendations
// ---------------------------------------------------------------------------

describe("checkDeadNeutral", () => {
  it("returns null when rate <= 0.60", () => {
    assert.equal(checkDeadNeutral(0.60, 1000), null);
    assert.equal(checkDeadNeutral(0.55, 1000), null);
  });

  it("returns null when sample < 500", () => {
    assert.equal(checkDeadNeutral(0.80, 499), null);
  });

  it("returns recommendation when rate > 0.60 and n >= 500", () => {
    const r = checkDeadNeutral(0.75, 1000);
    assert.ok(r !== null);
    assert.equal(r.id, "dead_neutral_rate");
  });

  it("confidence HIGH after 3 days", () => {
    const r = checkDeadNeutral(0.75, 1000, 3);
    assert.equal(r.confidence, "HIGH");
  });

  it("confidence LOW with fewer days", () => {
    const r = checkDeadNeutral(0.75, 1000, 1);
    assert.equal(r.confidence, "LOW");
  });
});

describe("checkProbMarketBlocks", () => {
  it("returns null when blockPct <= 0.30", () => {
    assert.equal(checkProbMarketBlocks(0.30, 100), null);
  });

  it("returns LOW confidence without trade data", () => {
    const r = checkProbMarketBlocks(0.40, 10);
    assert.equal(r.confidence, "LOW");
  });

  it("returns MEDIUM confidence with sufficient trades", () => {
    const r = checkProbMarketBlocks(0.40, 50, 0.55);
    assert.equal(r.confidence, "MEDIUM");
  });
});

describe("checkMinTicketBlocks", () => {
  it("returns null when blockPct <= 0.15", () => {
    assert.equal(checkMinTicketBlocks(0.15, 20), null);
  });

  it("returns recommendation when blockPct > 0.15", () => {
    const r = checkMinTicketBlocks(0.20, 20.34);
    assert.ok(r !== null);
    assert.equal(r.id, "min_ticket_exceeds_risk_cap");
    assert.ok(r.metricCited.includes("20.34"));
  });
});

describe("checkCalibrationDrift", () => {
  it("returns null when n < 50", () => {
    assert.equal(checkCalibrationDrift(0.6, 0.45, 49), null);
  });

  it("returns null when drift <= 10pp", () => {
    assert.equal(checkCalibrationDrift(0.55, 0.50, 100), null);
  });

  it("returns recommendation when drift > 10pp", () => {
    const r = checkCalibrationDrift(0.35, 0.55, 100);
    assert.ok(r !== null);
    assert.equal(r.id, "calibration_drift");
  });

  it("confidence HIGH at n >= 200", () => {
    const r = checkCalibrationDrift(0.35, 0.55, 200);
    assert.equal(r.confidence, "HIGH");
  });
});

describe("checkZeroTradeDays", () => {
  it("returns null with fewer than 3 dates", () => {
    const counts = new Map([["2026-04-17", 0], ["2026-04-18", 0]]);
    assert.equal(
      checkZeroTradeDays(["2026-04-17", "2026-04-18"], counts, {}),
      null
    );
  });

  it("returns null when not all last 3 are zero", () => {
    const dates = ["2026-04-17", "2026-04-18", "2026-04-19"];
    const counts = new Map([["2026-04-17", 0], ["2026-04-18", 1], ["2026-04-19", 0]]);
    assert.equal(checkZeroTradeDays(dates, counts, {}), null);
  });

  it("returns recommendation for 3 zero-trade days", () => {
    const dates = ["2026-04-17", "2026-04-18", "2026-04-19"];
    const counts = new Map([["2026-04-17", 0], ["2026-04-18", 0], ["2026-04-19", 0]]);
    const r = checkZeroTradeDays(dates, counts, { n: 0, distribution: {} });
    assert.ok(r !== null);
    assert.equal(r.id, "zero_trade_days");
  });
});

describe("checkLosingStreakPause", () => {
  it("returns null when not paused", () => {
    assert.equal(checkLosingStreakPause(false, 3), null);
  });

  it("returns recommendation when paused", () => {
    const r = checkLosingStreakPause(true, 4);
    assert.ok(r !== null);
    assert.equal(r.id, "losing_streak_pause");
    assert.ok(r.metricCited.includes("4"));
  });
});

describe("checkUptime", () => {
  it("returns null when uptime >= 95%", () => {
    assert.equal(checkUptime(0.95), null);
    assert.equal(checkUptime(1.0), null);
  });

  it("returns recommendation when uptime < 95%", () => {
    const r = checkUptime(0.90);
    assert.ok(r !== null);
    assert.equal(r.id, "uptime_below_95");
  });
});

describe("generateRecommendations", () => {
  it("returns empty array when all metrics are healthy", () => {
    const metrics = {
      signalHealth:   { deadNeutralRate: 0.20, n: 1000 },
      gateHealth:     { n: 1000, distribution: {}, top3: [], deltas: {} },
      tradeHealth:    { n: 5, settled: 5, won: 3, lost: 2, winRate: 0.6, predictedWinRate: 0.6 },
      bankrollHealth: { available: true, bankroll: 30, losingStreak: 0, paused: false, cycleEnded: false, riskEvents: [] },
      uptime:         { pct: 0.99 },
    };
    const recs = generateRecommendations(metrics, { recentDates: ["2026-04-19"], tradeCounts: new Map([["2026-04-19", 5]]) });
    assert.equal(recs.length, 0);
  });

  it("returns uptime rec when uptime is low", () => {
    const metrics = {
      signalHealth:   { deadNeutralRate: 0.10, n: 1000 },
      gateHealth:     { n: 100, distribution: {}, top3: [], deltas: {} },
      tradeHealth:    { n: 0, settled: 0, won: 0, lost: 0, winRate: null, predictedWinRate: null },
      bankrollHealth: { available: true, bankroll: 30, losingStreak: 0, paused: false, cycleEnded: false, riskEvents: [] },
      uptime:         { pct: 0.80 },
    };
    const recs = generateRecommendations(metrics, {});
    assert.ok(recs.some((r) => r.id === "uptime_below_95"));
  });
});

// ---------------------------------------------------------------------------
// todo-manager
// ---------------------------------------------------------------------------

describe("parseTodo", () => {
  it("returns empty array for empty content", () => {
    assert.deepEqual(parseTodo(""), []);
  });

  it("parses a single item", () => {
    const content = [
      "### TUNE-20260419-001 — Some recommendation title",
      "- **Status**: OPEN",
      "- **First seen**: 2026-04-19",
      "- **Last seen**: 2026-04-19",
      "- **Seen count**: 1",
      "- **Bot**: btc-15m",
      "- **Metric**: dead_neutral_rate = 75.0%",
      "- **Confidence**: HIGH — because reasons",
      "- **Rec id**: dead_neutral_rate",
      "- **Human decision**: _pending_",
    ].join("\n");

    const items = parseTodo(content);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "TUNE-20260419-001");
    assert.equal(items[0].title, "Some recommendation title");
    assert.equal(items[0].status, "OPEN");
    assert.equal(items[0].bot, "btc-15m");
    assert.equal(items[0].recId, "dead_neutral_rate");
    assert.equal(items[0].seenCount, 1);
  });

  it("parses multiple items", () => {
    const content = [
      "### TUNE-20260419-001 — First item",
      "- **Status**: OPEN",
      "- **First seen**: 2026-04-19",
      "- **Last seen**: 2026-04-19",
      "- **Seen count**: 1",
      "- **Bot**: btc-15m",
      "- **Metric**: x",
      "- **Confidence**: HIGH — y",
      "- **Rec id**: rec_a",
      "- **Human decision**: _pending_",
      "",
      "### TUNE-20260419-002 — Second item",
      "- **Status**: DONE",
      "- **First seen**: 2026-04-18",
      "- **Last seen**: 2026-04-19",
      "- **Seen count**: 2",
      "- **Bot**: eth-15m",
      "- **Metric**: y",
      "- **Confidence**: LOW — z",
      "- **Rec id**: rec_b",
      "- **Human decision**: fixed it",
    ].join("\n");

    const items = parseTodo(content);
    assert.equal(items.length, 2);
    assert.equal(items[1].status, "DONE");
    assert.equal(items[1].seenCount, 2);
    assert.equal(items[1].humanDecision, "fixed it");
  });
});

describe("upsertItem", () => {
  const existingItem = {
    id: "TUNE-20260418-001",
    title: "Old title",
    status: "OPEN",
    firstSeen: "2026-04-18",
    lastSeen: "2026-04-18",
    seenCount: 1,
    bot: "btc-15m",
    metricCited: "x",
    confidence: "LOW — y",
    proposedChange: "",
    doNotApplyIf: "z",
    humanDecision: "_pending_",
    recId: "dead_neutral_rate",
  };

  const rec = {
    id: "dead_neutral_rate",
    title: "Scorecard produces too many neutral readings",
    what: "adjust weights",
    why: "dead-neutral is high",
    expectedImpact: "fewer neutrals",
    risk: "bias risk",
    metricCited: "dead_neutral_rate = 80.0%",
    confidence: "HIGH",
    reversibility: "easy",
    doNotApplyIf: "win rate already good",
  };

  it("increments seenCount when OPEN item with same recId exists", () => {
    const updated = upsertItem([existingItem], rec, "btc-15m", "2026-04-19");
    assert.equal(updated.length, 1);
    assert.equal(updated[0].seenCount, 2);
    assert.equal(updated[0].lastSeen, "2026-04-19");
  });

  it("adds new item when no matching OPEN item exists", () => {
    const updated = upsertItem([existingItem], rec, "eth-15m", "2026-04-19");
    assert.equal(updated.length, 2);
    assert.ok(updated[1].id.startsWith("TUNE-20260419-"));
    assert.equal(updated[1].bot, "eth-15m");
    assert.equal(updated[1].seenCount, 1);
  });

  it("adds new item when existing item is DONE (not OPEN)", () => {
    const doneItem = { ...existingItem, status: "DONE" };
    const updated = upsertItem([doneItem], rec, "btc-15m", "2026-04-19");
    assert.equal(updated.length, 2);
  });

  it("generates sequential IDs (no collision)", () => {
    const items = [existingItem];
    const rec2 = { ...rec, id: "uptime_below_95" };
    const rec3 = { ...rec, id: "min_ticket_exceeds_risk_cap" };

    let updated = upsertItem(items, rec, "eth-15m", "2026-04-19");  // TUNE-20260419-001
    updated = upsertItem(updated, rec2, "eth-15m", "2026-04-19");    // TUNE-20260419-002
    updated = upsertItem(updated, rec3, "eth-15m", "2026-04-19");    // TUNE-20260419-003

    const ids = updated.map((it) => it.id);
    assert.equal(new Set(ids).size, ids.length); // all unique
  });
});

describe("saveTodo + loadTodo round-trip", () => {
  it("saves and reloads items without data loss", () => {
    const tmpFile = path.join(os.tmpdir(), `todo-test-${Date.now()}.md`);

    const items = [
      {
        id: "TUNE-20260419-001",
        title: "Test item",
        status: "OPEN",
        firstSeen: "2026-04-19",
        lastSeen: "2026-04-19",
        seenCount: 3,
        bot: "btc-15m",
        metricCited: "dead_neutral_rate = 75.0%",
        confidence: "HIGH — because",
        proposedChange: "change weights",
        doNotApplyIf: "win rate > 60%",
        humanDecision: "_pending_",
        recId: "dead_neutral_rate",
      },
    ];

    saveTodo(tmpFile, items);
    const reloaded = loadTodo(tmpFile);

    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].id,        items[0].id);
    assert.equal(reloaded[0].seenCount, items[0].seenCount);
    assert.equal(reloaded[0].status,    items[0].status);
    assert.equal(reloaded[0].bot,       items[0].bot);
    assert.equal(reloaded[0].recId,     items[0].recId);

    fs.unlinkSync(tmpFile);
  });

  it("loadTodo returns [] for non-existent file", () => {
    assert.deepEqual(loadTodo("/tmp/definitely-does-not-exist-health-check.md"), []);
  });
});

// ---------------------------------------------------------------------------
// report-writer
// ---------------------------------------------------------------------------

describe("formatReport", () => {
  const botResults = {
    "btc-15m": {
      signalHealth:   { n: 500, adjustedUpDist: [], probModelDist: [], deadNeutralRate: 0.20, spuriousNeutralRate: 0, blockedByProbModelAnalysis: null },
      gateHealth:     { n: 200, distribution: { "prob_model_below_0.54": 80, "prob_market_below_0.50": 60 }, top3: [], deltas: {} },
      tradeHealth:    { n: 2, filled: 2, settled: 2, won: 1, lost: 1, winRate: 0.5, predictedWinRate: 0.6, winRateDelta: -0.1, avgEdge: 0.03, totalPnl: 0.5, pnlRows: [] },
      bankrollHealth: { available: true, bankroll: 20.34, cycleNumber: 1, losingStreak: 0, paused: false, cycleEnded: false, totalWithdrawn: 0, openPositions: [], totalExposure: 0, riskEvents: [] },
      uptime:         { observedTicks: 80000, expectedTicks: 86400, pct: 0.926 },
      recommendations: [],
    },
  };

  it("produces a non-empty markdown string", () => {
    const md = formatReport("2026-04-19", botResults, []);
    assert.ok(typeof md === "string");
    assert.ok(md.length > 100);
    assert.ok(md.includes("# Bot Health Report"));
    assert.ok(md.includes("2026-04-19"));
  });

  it("includes all major sections", () => {
    const md = formatReport("2026-04-19", botResults, []);
    for (const section of ["TL;DR", "Signal health", "Gate distribution", "Trade performance", "Bankroll", "Uptime", "Recommended adjustments", "Data quality"]) {
      assert.ok(md.includes(section), `Missing section: ${section}`);
    }
  });

  it("includes data quality notes when provided", () => {
    const md = formatReport("2026-04-19", botResults, ["test quality note XYZ"]);
    assert.ok(md.includes("test quality note XYZ"));
  });
});
