/**
 * jobs/lib/todo-manager.js
 *
 * Read, update, and write reports/health/TODO.md.
 *
 * Rules:
 * - New recommendation → new OPEN item with stable ID TUNE-YYYYMMDD-NNN
 * - Same recommendation within 7 days → increment seen_count, update last_seen
 * - Never auto-close items (only humans mark DONE or DISMISSED)
 * - Auto-generate summary header: count of open items by type
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateId(date, existingIds) {
  const dateStr = date.replace(/-/g, ""); // YYYYMMDD
  let seq = 1;
  while (existingIds.has(`TUNE-${dateStr}-${String(seq).padStart(3, "0")}`)) {
    seq++;
  }
  return `TUNE-${dateStr}-${String(seq).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Item schema
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} TodoItem
 * @property {string} id
 * @property {string} title
 * @property {'OPEN'|'DONE'|'DISMISSED'} status
 * @property {string} firstSeen      — YYYY-MM-DD
 * @property {string} lastSeen       — YYYY-MM-DD
 * @property {number} seenCount
 * @property {string} bot
 * @property {string} metricCited
 * @property {string} confidence
 * @property {string} [proposedChange]
 * @property {string} doNotApplyIf
 * @property {string} humanDecision
 * @property {string} recId          — the recommendation id (stable key for dedup)
 */

// ---------------------------------------------------------------------------
// Parser: read existing TODO.md into structured items
// ---------------------------------------------------------------------------

const ITEM_START_RE = /^### (TUNE-\d{8}-\d{3}) — (.+)$/;
const FIELD_RE      = /^- \*\*(.+?)\*\*:\s*(.*)$/;

export function parseTodo(content) {
  const lines = content.split("\n");
  const items = [];
  let current = null;

  for (const line of lines) {
    const startMatch = line.match(ITEM_START_RE);
    if (startMatch) {
      if (current) items.push(current);
      current = {
        id:           startMatch[1],
        title:        startMatch[2],
        status:       "OPEN",
        firstSeen:    "",
        lastSeen:     "",
        seenCount:    1,
        bot:          "",
        metricCited:  "",
        confidence:   "",
        proposedChange: "",
        doNotApplyIf: "",
        humanDecision: "_pending_",
        recId:        "",
      };
      continue;
    }

    if (!current) continue;

    const fieldMatch = line.match(FIELD_RE);
    if (!fieldMatch) continue;

    const [, key, val] = fieldMatch;
    switch (key.toLowerCase()) {
      case "status":          current.status         = val.trim(); break;
      case "first seen":      current.firstSeen      = val.trim(); break;
      case "last seen":       current.lastSeen       = val.trim(); break;
      case "seen count":      current.seenCount      = parseInt(val.trim(), 10) || 1; break;
      case "bot":             current.bot            = val.trim(); break;
      case "metric":          current.metricCited    = val.trim(); break;
      case "confidence":      current.confidence     = val.trim().split("—")[0].trim(); break;
      case "proposed change": current.proposedChange = val.trim(); break;
      case "do not apply if": current.doNotApplyIf   = val.trim(); break;
      case "human decision":  current.humanDecision  = val.trim(); break;
      case "rec id":          current.recId          = val.trim(); break;
    }
  }

  if (current) items.push(current);
  return items;
}

// ---------------------------------------------------------------------------
// Upsert: add new item or increment seen_count on existing
// ---------------------------------------------------------------------------

/**
 * Given the current item list and a new recommendation, either:
 * - Add a new item (if rec.id not seen in last 7 days), or
 * - Increment seen_count on the existing OPEN item
 *
 * @param {TodoItem[]}     items
 * @param {Recommendation} rec
 * @param {string}         bot    — "btc-15m" etc.
 * @param {string}         today  — YYYY-MM-DD
 * @returns {TodoItem[]}   updated items (new array, original unmodified)
 */
export function upsertItem(items, rec, bot, today) {
  const existing = items.find(
    (it) =>
      it.recId === rec.id &&
      it.bot === bot &&
      it.status === "OPEN"
  );

  if (existing) {
    return items.map((it) =>
      it === existing
        ? { ...it, seenCount: it.seenCount + 1, lastSeen: today }
        : it
    );
  }

  const existingIds = new Set(items.map((it) => it.id));
  const newId = generateId(today, existingIds);

  const newItem = {
    id:           newId,
    title:        rec.title,
    status:       "OPEN",
    firstSeen:    today,
    lastSeen:     today,
    seenCount:    1,
    bot,
    metricCited:  rec.metricCited,
    confidence:   `${rec.confidence} — ${rec.why.slice(0, 80)}`,
    proposedChange: rec.proposedChange ?? "",
    doNotApplyIf: rec.doNotApplyIf,
    humanDecision: "_pending_",
    recId:        rec.id,
  };

  return [...items, newItem];
}

// ---------------------------------------------------------------------------
// Serialise items back to markdown
// ---------------------------------------------------------------------------

function serializeItem(item) {
  const lines = [
    `### ${item.id} — ${item.title}`,
    `- **Status**: ${item.status}`,
    `- **First seen**: ${item.firstSeen}`,
    `- **Last seen**: ${item.lastSeen}`,
    `- **Seen count**: ${item.seenCount}`,
    `- **Bot**: ${item.bot}`,
    `- **Metric**: ${item.metricCited}`,
    `- **Confidence**: ${item.confidence}`,
  ];
  if (item.proposedChange) {
    lines.push(`- **Proposed change**: ${item.proposedChange}`);
  }
  lines.push(`- **Do NOT apply if**: ${item.doNotApplyIf}`);
  lines.push(`- **Rec id**: ${item.recId}`);
  lines.push(`- **Human decision**: ${item.humanDecision}`);
  return lines.join("\n");
}

function buildSummaryHeader(items) {
  const open = items.filter((it) => it.status === "OPEN");
  const done = items.filter((it) => it.status === "DONE").length;
  const dismissed = items.filter((it) => it.status === "DISMISSED").length;

  // Group open items by rec type
  const byType = {};
  for (const it of open) {
    byType[it.recId] = (byType[it.recId] ?? 0) + 1;
  }

  const typeLines = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `  - ${type}: ${n}`)
    .join("\n");

  return [
    "# Health Check — TODO",
    "",
    `<!-- AUTO-GENERATED SUMMARY — do not edit this block manually -->`,
    `**Open items**: ${open.length}  |  **Done**: ${done}  |  **Dismissed**: ${dismissed}`,
    "",
    open.length > 0
      ? `Open by type:\n${typeLines}`
      : "_No open items._",
    `<!-- END SUMMARY -->`,
    "",
    "---",
    "",
    "> Items marked OPEN require human review.",
    "> To close an item, change its **Status** to DONE or DISMISSED and note the reason in **Human decision**.",
    "",
    "---",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public I/O
// ---------------------------------------------------------------------------

export function loadTodo(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  return parseTodo(content);
}

export function saveTodo(filePath, items) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const header  = buildSummaryHeader(items);
  const bodies  = items.map(serializeItem).join("\n\n");
  fs.writeFileSync(filePath, header + bodies + "\n", "utf8");
}
