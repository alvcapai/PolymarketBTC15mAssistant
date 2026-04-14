import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OPEN_LOG_PATH = path.resolve(process.cwd(), "data", "trades_opened.jsonl");
const CLOSE_LOG_PATH = path.resolve(process.cwd(), "data", "trades_closed.jsonl");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendJsonl(filePath, payload) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

export function createTradeId() {
  return `tr_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

export function recordTradeOpen(data) {
  const record = {
    event_type: "OPEN",
    ...data
  };
  appendJsonl(OPEN_LOG_PATH, record);
  return record;
}

export function recordTradeClose(data) {
  const record = {
    event_type: "CLOSE",
    ...data
  };
  appendJsonl(CLOSE_LOG_PATH, record);
  return record;
}

export function estimatePnlRealized({ stake, entryPrice, shareSize, won }) {
  const s = Number(stake);
  const p = Number(entryPrice);
  const sh = Number(shareSize);
  if (!Number.isFinite(s) || s <= 0) return 0;
  if (!won) return -s;
  if (Number.isFinite(sh) && sh > 0) return sh - s;
  if (Number.isFinite(p) && p > 0 && p < 1) return s * ((1 / p) - 1);
  return 0;
}
