/**
 * jobs/lib/report-writer.js
 *
 * Format the daily health report as a Markdown string.
 * Pure function — no file I/O (caller writes the output).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(v, digits = 1) {
  return Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : "—";
}

function usd(v) {
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : "—";
}

function num(v, digits = 0) {
  return Number.isFinite(v) ? v.toFixed(digits) : "—";
}

function tableRow(...cells) {
  return `| ${cells.join(" | ")} |`;
}

function tableHeader(cols) {
  return [
    tableRow(...cols),
    tableRow(...cols.map(() => "---")),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderTldr(botResults, date) {
  const bots = Object.entries(botResults);
  const anyTrades = bots.some(([, r]) => (r.tradeHealth?.n ?? 0) > 0);
  const allHealthy = bots.every(([, r]) => {
    const uptime = r.uptime?.pct ?? 1;
    const paused = r.bankrollHealth?.paused ?? false;
    return uptime >= 0.95 && !paused;
  });

  // Find the dominant blocker across all bots
  const allBlocks = {};
  for (const [, r] of bots) {
    for (const [key, count] of Object.entries(r.gateHealth?.distribution ?? {})) {
      allBlocks[key] = (allBlocks[key] ?? 0) + count;
    }
  }
  const topBlock = Object.entries(allBlocks).sort((a, b) => b[1] - a[1])[0];
  const topBlockStr = topBlock ? `**Dominant blocker:** \`${topBlock[0]}\` (${topBlock[1]} occurrences).` : "No block data available.";

  const healthStatus = allHealthy ? "Both bots are **healthy** and running normally." : "⚠️ One or more bots have health issues — see sections below.";

  const tradeStatus = anyTrades
    ? `Trades fired in this period — see Trade Performance section.`
    : `No trades fired in the last 24h. ${topBlockStr}`;

  const recs = bots.flatMap(([, r]) => r.recommendations ?? []);
  const recStatus = recs.length > 0
    ? `**${recs.length} tuning recommendation(s)** generated — see Recommended Adjustments section.`
    : "No tuning adjustments recommended today.";

  return `${healthStatus} ${tradeStatus} ${recStatus}`;
}

function renderSignalHealth(botResults) {
  const lines = [];

  // adjustedUp (pre-calibration) distribution table
  lines.push("### Pre-calibration adjustedUp distribution\n");
  lines.push(tableHeader(["Bucket", ...Object.keys(botResults).map((b) => b.toUpperCase())]));

  const firstBot = Object.values(botResults)[0];
  const buckets  = firstBot?.signalHealth?.adjustedUpDist ?? [];

  if (buckets.length > 0) {
    for (const b of buckets) {
      const label = `[${b.lo.toFixed(1)}, ${b.hi.toFixed(1)})`;
      const cells = Object.values(botResults).map((r) => {
        const bucket = r.signalHealth?.adjustedUpDist?.find(
          (x) => Math.abs(x.lo - b.lo) < 0.001
        );
        return bucket ? `${bucket.n} (${pct(bucket.pct)})` : "—";
      });
      lines.push(tableRow(label, ...cells));
    }
  } else {
    lines.push("_No signal data available._");
  }

  lines.push("");
  lines.push("### Post-calibration probModel distribution\n");
  lines.push(tableHeader(["Bucket", ...Object.keys(botResults).map((b) => b.toUpperCase())]));

  if (firstBot?.signalHealth?.probModelDist?.length > 0) {
    for (const b of firstBot.signalHealth.probModelDist) {
      const label = `[${b.lo.toFixed(1)}, ${b.hi.toFixed(1)})`;
      const cells = Object.values(botResults).map((r) => {
        const bucket = r.signalHealth?.probModelDist?.find(
          (x) => Math.abs(x.lo - b.lo) < 0.001
        );
        return bucket ? `${bucket.n} (${pct(bucket.pct)})` : "—";
      });
      lines.push(tableRow(label, ...cells));
    }
  } else {
    lines.push("_No signal data available._");
  }

  lines.push("");
  lines.push("### Key rates\n");
  lines.push(tableHeader(["Metric", ...Object.keys(botResults).map((b) => b.toUpperCase())]));
  lines.push(tableRow(
    "Dead-neutral rate (probModelUp ∈ [0.49, 0.51])",
    ...Object.values(botResults).map((r) => pct(r.signalHealth?.deadNeutralRate))
  ));
  lines.push(tableRow(
    "Spurious neutral (adjustedUp outside [0.45,0.55] but probModel neutral)",
    ...Object.values(botResults).map((r) => pct(r.signalHealth?.spuriousNeutralRate))
  ));

  // Per-bot: prob_model_blocked breakdown
  for (const [bot, r] of Object.entries(botResults)) {
    const a = r.signalHealth?.blockedByProbModelAnalysis;
    if (a) {
      lines.push(
        `\n**${bot.toUpperCase()} — of ${a.total} prob_model-blocked ticks:** ` +
        `${a.genuineNeutral} (${pct(a.genuineNeutralRate)}) were genuinely neutral (adjustedUp ∈ [0.45,0.55]); ` +
        `${a.realSignalBlocked} had a real signal that calibration compressed below MIN_PROB.`
      );
    }
  }

  return lines.join("\n");
}

function renderGateHealth(botResults) {
  const lines = [];

  for (const [bot, r] of Object.entries(botResults)) {
    const g = r.gateHealth;
    lines.push(`### ${bot.toUpperCase()}\n`);

    if (!g || g.n === 0) {
      lines.push("_No counterfactual data available._\n");
      continue;
    }

    lines.push(`Total ticks: ${g.n}\n`);
    lines.push(tableHeader(["Reason", "Count", "%", "Δ vs prev 24h"]));

    const sorted = Object.entries(g.distribution)
      .sort((a, b) => b[1] - a[1]);

    for (const [reason, count] of sorted) {
      const p = count / g.n;
      const delta = g.deltas[reason];
      const deltaStr = delta !== null && delta !== undefined
        ? (delta > 0 ? "+" : "") + pct(delta)
        : "—";
      lines.push(tableRow(reason, count, pct(p), deltaStr));
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderTradeHealth(botResults) {
  const lines = [];
  let anyTrades = false;

  for (const [bot, r] of Object.entries(botResults)) {
    const t = r.tradeHealth;
    lines.push(`### ${bot.toUpperCase()}\n`);

    if (!t || t.n === 0) {
      lines.push("_No trades in this period._\n");
      continue;
    }

    anyTrades = true;
    lines.push(tableHeader(["Metric", "Value"]));
    lines.push(tableRow("Trades placed",      t.n));
    lines.push(tableRow("Settled (W/L)",       `${t.settled} (${t.won}W / ${t.lost}L)`));
    lines.push(tableRow("Realized win rate",  pct(t.winRate)));
    lines.push(tableRow("Model-predicted win rate", pct(t.predictedWinRate)));
    lines.push(tableRow("Win rate delta (realized − predicted)", pct(t.winRateDelta)));
    lines.push(tableRow("Avg edge at entry",  pct(t.avgEdge)));
    lines.push(tableRow("Total P&L",          usd(t.totalPnl)));
    lines.push("");
  }

  if (!anyTrades) {
    lines.push(
      "> Zero trades fired across all bots. This is not flagged as a problem unless it persists for 3+ consecutive days.\n"
    );
  }

  return lines.join("\n");
}

function renderBankroll(botResults) {
  const lines = [];
  lines.push(tableHeader(["Bot", "Bankroll", "Cycle", "Exposure", "Losing streak", "Paused", "Risk events"]));

  for (const [bot, r] of Object.entries(botResults)) {
    const b = r.bankrollHealth;
    if (!b?.available) {
      lines.push(tableRow(bot, "unavailable", "—", "—", "—", "—", "—"));
      continue;
    }
    lines.push(tableRow(
      bot,
      usd(b.bankroll),
      b.cycleNumber,
      usd(b.totalExposure),
      b.losingStreak,
      b.paused ? "⚠️ YES" : "no",
      b.riskEvents.length > 0 ? b.riskEvents.join(", ") : "none"
    ));
  }

  return lines.join("\n");
}

function renderRecommendations(botResults) {
  const allRecs = [];
  for (const [bot, r] of Object.entries(botResults)) {
    for (const rec of r.recommendations ?? []) {
      allRecs.push({ bot, rec });
    }
  }

  if (allRecs.length === 0) {
    return "_No adjustments recommended today._";
  }

  return allRecs.map(({ bot, rec }, i) => {
    return [
      `### ${i + 1}. [${bot.toUpperCase()}] ${rec.title}`,
      "",
      `**WHAT:** ${rec.what}`,
      "",
      `**WHY:** ${rec.why}`,
      "",
      `**Expected impact:** ${rec.expectedImpact}`,
      "",
      `**Risk:** ${rec.risk}`,
      "",
      `**Metric cited:** \`${rec.metricCited}\``,
      "",
      `**Confidence:** ${rec.confidence}`,
      "",
      `**Reversibility:** ${rec.reversibility}`,
      "",
      `**Do NOT apply if:** ${rec.doNotApplyIf}`,
      rec.proposedChange ? `\n**Proposed change:** \`${rec.proposedChange}\`` : "",
    ].filter((l) => l !== undefined).join("\n");
  }).join("\n\n---\n\n");
}

function renderDataQuality(notes) {
  if (!notes || notes.length === 0) return "_No data quality issues detected._";
  return notes.map((n) => `- ${n}`).join("\n");
}

function renderUptime(botResults) {
  const lines = [tableHeader(["Bot", "Observed ticks", "Expected ticks", "Uptime %"])];
  for (const [bot, r] of Object.entries(botResults)) {
    const u = r.uptime;
    if (!u) {
      lines.push(tableRow(bot, "—", "—", "—"));
    } else {
      lines.push(tableRow(
        bot,
        u.observedTicks,
        u.expectedTicks,
        pct(u.pct)
      ));
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

/**
 * @param {string}  date        — YYYY-MM-DD
 * @param {object}  botResults  — { "btc-15m": { signalHealth, gateHealth, tradeHealth, bankrollHealth, uptime, recommendations }, ... }
 * @param {string[]} dataQualityNotes
 * @returns {string}  full markdown document
 */
export function formatReport(date, botResults, dataQualityNotes = []) {
  const sections = [
    `# Bot Health Report — ${date}`,
    "",
    `_Generated at ${new Date().toISOString()}_`,
    "",
    "---",
    "",
    "## TL;DR",
    "",
    renderTldr(botResults, date),
    "",
    "---",
    "",
    "## Signal health",
    "",
    renderSignalHealth(botResults),
    "",
    "---",
    "",
    "## Gate distribution (last 24h)",
    "",
    renderGateHealth(botResults),
    "",
    "---",
    "",
    "## Trade performance (last 24h)",
    "",
    renderTradeHealth(botResults),
    "",
    "---",
    "",
    "## Bankroll",
    "",
    renderBankroll(botResults),
    "",
    "---",
    "",
    "## Uptime",
    "",
    renderUptime(botResults),
    "",
    "---",
    "",
    "## Recommended adjustments",
    "",
    renderRecommendations(botResults),
    "",
    "---",
    "",
    "## Data quality notes",
    "",
    renderDataQuality(dataQualityNotes),
    "",
  ];

  return sections.join("\n");
}
