#!/usr/bin/env node
/**
 * Central de Controle — PolymarketBTCAssistant
 * Uso: node monitor.js
 */

import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Configuração ─────────────────────────────────────────────────────────────

const REFRESH_MS   = 4000;
const THRESHOLD    = 75;
const BAR_WIDTH    = 14;
const LOG_LINES    = 6;
const RISK_TTL_MS  =  5_000;
const COUNT_TTL_MS = 60_000;
const TRADE_TTL_MS = 30_000;

const AGENTS = [
  { name: "btc-15m", timeframe: "btc-15m", csv: "logs/signals-btc-15m.csv",
    logs: ["logs/btc15m.log", "logs/btc15m-err.log"], errLog: "logs/btc15m-err.log", startLog: "logs/btc15m.log" },
  { name: "btc-5m",  timeframe: "btc-5m",  csv: "logs/signals-btc-5m.csv",
    logs: ["logs/btc5m.log",  "logs/btc5m-err.log"],  errLog: "logs/btc5m-err.log",  startLog: "logs/btc5m.log"  },
  { name: "eth-15m", timeframe: "eth-15m", csv: "logs/signals-eth-15m.csv",
    logs: ["logs/eth15m.log", "logs/eth15m-err.log"], errLog: "logs/eth15m-err.log", startLog: "logs/eth15m.log" },
  { name: "eth-5m",  timeframe: "eth-5m",  csv: "logs/signals-eth-5m.csv",
    logs: ["logs/eth5m.log",  "logs/eth5m-err.log"],  errLog: "logs/eth5m-err.log",  startLog: "logs/eth5m.log"  },
];

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const A = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
  white: "\x1b[97m", gray: "\x1b[90m",
};

// ─── Estado global ────────────────────────────────────────────────────────────

let selectedIdx = 0;
let mode        = "view";   // "view" | "detail" | "confirm-start" | "confirm-stop" | "confirm-restart" | "confirm-liberar"
let agentData   = [];
let refreshTimer;

// ─── Texto ────────────────────────────────────────────────────────────────────

function stripAnsi(s)  { return String(s).replace(/\x1b\[[0-9;]*m/g, ""); }
function visLen(s)     { return stripAnsi(s).length; }
function pad(s, w)     { const v = visLen(s); return v >= w ? s : s + " ".repeat(w - v); }
function rpad(s, w)    { const v = visLen(s); return v >= w ? s : " ".repeat(w - v) + s; }
function trunc(s, w)   { return stripAnsi(s).length > w ? stripAnsi(s).slice(0, w - 1) + "…" : s; }
function center(s, w)  {
  const v = visLen(s); if (v >= w) return s;
  const l = Math.floor((w - v) / 2);
  return " ".repeat(l) + s + " ".repeat(w - v - l);
}
function sw() { return Math.max(process.stdout.columns || 80, 78); }

// ─── PM2 ──────────────────────────────────────────────────────────────────────

let _pm2Bin = null;
function getPm2Bin() {
  if (_pm2Bin !== null) return _pm2Bin;
  for (const c of ["/usr/bin/pm2", "/usr/local/bin/pm2"]) {
    if (spawnSync(c, ["--version"], { encoding: "utf8", timeout: 2000 }).status === 0)
      return (_pm2Bin = c);
  }
  _pm2Bin = spawnSync("pm2", ["--version"], { encoding: "utf8", timeout: 2000, shell: true }).status === 0 ? "pm2" : "";
  return _pm2Bin;
}

function getRunningPids() {
  const pm2 = getPm2Bin();
  if (pm2) {
    const r = spawnSync(pm2, ["jlist"], { encoding: "utf8", timeout: 4000 });
    if (r.status === 0 && r.stdout) {
      try {
        const map = {};
        for (const proc of JSON.parse(r.stdout)) {
          const tf = proc.pm2_env?.TIMEFRAME ?? proc.pm2_env?.env?.TIMEFRAME;
          if (tf && proc.pid && proc.pm2_env?.status === "online") map[tf] = Number(proc.pid);
        }
        if (Object.keys(map).length > 0) return map;
      } catch { /* ignore */ }
    }
  }
  try {
    const map = {};
    for (const line of (spawnSync("ps", ["aux"], { encoding: "utf8", timeout: 2000 }).stdout ?? "").split("\n")) {
      if (!line.includes("node") || !line.includes("src/index")) continue;
      const tfMatch = line.match(/TIMEFRAME=([\w-]+)/);
      const pid     = line.trim().split(/\s+/)[1];
      if (tfMatch && pid) map[tfMatch[1]] = Number(pid);
    }
    return map;
  } catch { return {}; }
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

function readCsvLast(filePath) {
  try {
    const lines = readFileSync(path.resolve(__dirname, filePath), "utf8").trim().split("\n").filter(Boolean);
    if (lines.length < 2) return null;
    const headers = lines[0].split(",").map(h => h.trim());
    const values  = lines[lines.length - 1].split(",").map(v => v.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  } catch { return null; }
}

// ─── Log geral ────────────────────────────────────────────────────────────────

function bestLogFile(logPaths) {
  let best = null, bestMtime = 0;
  for (const p of logPaths) {
    const abs = path.resolve(__dirname, p);
    if (!existsSync(abs)) continue;
    try { const mt = statSync(abs).mtimeMs; if (mt > bestMtime) { bestMtime = mt; best = abs; } } catch { /* */ }
  }
  return best;
}

function readLogTail(logPaths, n = LOG_LINES) {
  const file = bestLogFile(logPaths);
  if (!file) return { lines: [], hasLog: false };
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map(stripAnsi);
    return { lines: lines.slice(-n), hasLog: true };
  } catch { return { lines: [], hasLog: false }; }
}

function lastTradeEvent(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!/DISPARANDO|confirmada|FALHA|BLOQUEADO|AVISO|EXECUCAO|MOCK EXECUCAO/.test(l)) continue;
    let color = "gray";
    if (/DISPARANDO|confirmada|Ordem aceita/.test(l))        color = "green";
    else if (/FALHA|ERRO|rejeitou|inválido|ausente/.test(l)) color = "red";
    else if (/BLOQUEADO|AVISO|MOCK/.test(l))                 color = "yellow";
    return { text: l.replace(/^\[AUTO-TRADE\]\s*/, "").replace(/^\[EXECUCAO\]\s*/, "").slice(0, 90), color };
  }
  return null;
}

// ─── Err log stats (bankroll / wins / losses) — com cache ────────────────────

const errCache = {};

function parseRiskLine(line) {
  const m = stripAnsi(line).match(
    /bankroll=\$([0-9.]+).*?cycle=(\d+).*?open_pos=(\d+).*?exposure=\$([0-9.]+).*?losing_streak=(\d+).*?paused=(true|false).*?cycle_ended=(true|false)/
  );
  if (!m) return null;
  return {
    bankroll: parseFloat(m[1]), cycle: parseInt(m[2]), openPos: parseInt(m[3]),
    exposure: parseFloat(m[4]), losingStreak: parseInt(m[5]),
    paused: m[6] === "true", cycleEnded: m[7] === "true",
  };
}

function readErrLogStats(errLogPath) {
  const abs = path.resolve(__dirname, errLogPath);
  if (!existsSync(abs)) return null;
  const now   = Date.now();
  const cache = errCache[errLogPath] ?? (errCache[errLogPath] = {
    risk: null, wins: 0, losses: 0, lastTs: null, riskFetchedAt: 0, countFetchedAt: 0,
  });

  if (now - cache.riskFetchedAt >= RISK_TTL_MS) {
    const r = spawnSync("bash", ["-c", `tail -n 200 "${abs}" | grep -F '[RISK]' | tail -n 1`],
      { encoding: "utf8", timeout: 3000 });
    const line = (r.stdout ?? "").trim();
    if (line) cache.risk = parseRiskLine(line);

    const lr = spawnSync("bash", ["-c", `tail -n 1 "${abs}"`], { encoding: "utf8", timeout: 1500 });
    const tsM = (lr.stdout ?? "").trim().match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    if (tsM) cache.lastTs = new Date(tsM[1] + "Z");
    cache.riskFetchedAt = now;
  }

  if (now - cache.countFetchedAt >= COUNT_TTL_MS) {
    const wR = spawnSync("grep", ["-cF", "[OUTCOME] WIN",  abs], { encoding: "utf8", timeout: 8000 });
    const lR = spawnSync("grep", ["-cF", "[OUTCOME] LOSS", abs], { encoding: "utf8", timeout: 8000 });
    cache.wins   = parseInt((wR.stdout ?? "").trim()) || 0;
    cache.losses = parseInt((lR.stdout ?? "").trim()) || 0;
    cache.countFetchedAt = now;
  }

  return { risk: cache.risk, wins: cache.wins, losses: cache.losses, lastTs: cache.lastTs };
}

// ─── Histórico de trades — com cache ─────────────────────────────────────────

const tradeCache = {};

function readTradeHistory(errLogPath, limit = 10) {
  const abs = path.resolve(__dirname, errLogPath);
  if (!existsSync(abs)) return [];

  const now   = Date.now();
  const cache = tradeCache[errLogPath] ?? (tradeCache[errLogPath] = { trades: [], fetchedAt: 0 });
  if (now - cache.fetchedAt < TRADE_TTL_MS) return cache.trades;

  // Grep separado para OUTCOME (janela maior) e para trades (DISPARANDO + confirmação)
  const outR = spawnSync("bash", ["-c",
    `grep -aE '\\[OUTCOME\\] (WIN|LOSS)' "${abs}" | tail -n 1000`
  ], { encoding: "utf8", timeout: 10000 });
  const tradeR = spawnSync("bash", ["-c",
    `grep -aE '\\[AUTO-TRADE\\] DISPARANDO|\\[AUTO-TRADE\\] Ordem confirmada' "${abs}" | tail -n 200`
  ], { encoding: "utf8", timeout: 10000 });

  if ((outR.status !== 0 && !outR.stdout) && (tradeR.status !== 0 && !tradeR.stdout)) return cache.trades;

  const outcomeLines = (outR.stdout ?? "").split("\n").filter(Boolean);
  const lines        = (tradeR.stdout ?? "").split("\n").filter(Boolean);
  const outcomes = new Map();   // tokenId → { result, ts }
  const trades   = [];          // ordered by time, de-duped by tokenId
  const seenTokens = new Set();

  // 1ª passagem: coletar todos os outcomes por tokenId
  for (const line of outcomeLines) {
    const clean = stripAnsi(line);
    const om = clean.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}).*\[OUTCOME\] (WIN|LOSS) token (\d+)/);
    if (om) outcomes.set(om[3], { result: om[2], ts: new Date(om[1] + "Z") });
  }

  // 2ª passagem: construir lista de trades (DISPARANDO + confirmação)
  let pending = null;
  for (const line of lines) {
    const clean = stripAnsi(line);

    // DISPARANDO — abre trade pendente
    const dm = clean.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}).*DISPARANDO (LONG|SHORT).*prob_model ([0-9.]+)%.*prob_market ([0-9.]+)%.*edge ([0-9.]+)%.*stake \$([0-9.]+).*rawAsk ([0-9.]+).*= ([0-9.]+).*token (\d+)/
    );
    if (dm) {
      pending = {
        ts:         new Date(dm[1] + "Z"),
        side:       dm[2] === "LONG" ? "UP" : "DOWN",
        probModel:  parseFloat(dm[3]),
        probMarket: parseFloat(dm[4]),
        edge:       parseFloat(dm[5]),
        stake:      parseFloat(dm[6]),
        entryPrice: parseFloat(dm[8]),
        tokenId:    dm[9],
        marketSlug: null,
        confirmed:  false,
      };
      continue;
    }

    // Confirmação — associa slug ao trade pendente
    const cm = clean.match(/\[AUTO-TRADE\] Ordem confirmada pela API \(([^)]+)\)/);
    if (cm && pending) {
      pending.marketSlug = cm[1];
      pending.confirmed  = true;
      if (!seenTokens.has(pending.tokenId)) {
        seenTokens.add(pending.tokenId);
        trades.push({ ...pending });
      }
      pending = null;
      continue;
    }
  }

  // 3ª passagem: aplicar resultados
  for (const t of trades) {
    const out = outcomes.get(t.tokenId);
    t.result   = out ? out.result : "ABERTA";
    t.resultTs = out?.ts ?? null;
  }

  // Mais recentes primeiro, limitar
  cache.trades    = trades.reverse().slice(0, limit);
  cache.fetchedAt = now;
  return cache.trades;
}

// ─── Barra de confiança ───────────────────────────────────────────────────────

function confBar(pct) {
  const filled    = Math.round((pct / 100) * BAR_WIDTH);
  const threshPos = Math.round((THRESHOLD / 100) * BAR_WIDTH);
  let bar = "";
  for (let i = 0; i < BAR_WIDTH; i++) {
    bar += i === threshPos ? A.yellow + "▒" + A.reset
         : i < filled     ? (pct >= THRESHOLD ? A.green : A.cyan) + "█" + A.reset
         :                  A.gray + "░" + A.reset;
  }
  return bar;
}

// ─── Coleta de dados ──────────────────────────────────────────────────────────

function fetchAll() {
  const pids = getRunningPids();
  agentData = AGENTS.map(agent => {
    const pid  = pids[agent.timeframe] ?? null;
    const csv  = readCsvLast(agent.csv);
    const { lines, hasLog } = readLogTail(agent.logs);
    const event    = lastTradeEvent(lines);
    const errStats = readErrLogStats(agent.errLog);

    let longPct = null, shortPct = null, regime = null, signal = null, timeLeft = null;
    if (csv) {
      const u = Number(csv.prob_model_up  ?? csv.model_up)   * 100;
      const d = Number(csv.prob_model_down ?? csv.model_down) * 100;
      longPct  = Number.isFinite(u) ? u : null;
      shortPct = Number.isFinite(d) ? d : null;
      regime   = csv.regime || csv.decision_reason || null;
      signal   = csv.side ?? csv.signal ?? null;
      const tl = Number(csv.time_left_min);
      timeLeft = Number.isFinite(tl) ? tl : null;
    }

    return { ...agent, pid, running: pid !== null, longPct, shortPct, regime, signal, timeLeft, event, hasLog, errStats };
  });
}

// ─── Helpers de formatação ────────────────────────────────────────────────────

function fmtTime(mins) {
  if (mins === null || !Number.isFinite(mins)) return null;
  const t = Math.max(0, Math.floor(mins * 60));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")} rest.`;
}

function colorText(text, color) {
  const c = { green: A.green, red: A.red, yellow: A.yellow, gray: A.gray, cyan: A.cyan }[color] ?? "";
  return `${c}${text}${A.reset}`;
}

function fmtLastActivity(lastTs) {
  if (!lastTs) return A.gray + "sem atividade" + A.reset;
  const m = Math.floor((Date.now() - lastTs.getTime()) / 60_000);
  const h = Math.floor(m / 60);
  if (m < 1)  return A.green  + "agora"       + A.reset;
  if (m < 5)  return A.green  + `${m}min`     + A.reset;
  if (m < 60) return A.yellow + `${m}min`     + A.reset;
  return        A.red    + `${h}h atrás`  + A.reset;
}

function statusBadge(ag) {
  const risk = ag.errStats?.risk;
  if (!ag.running)       return A.gray   + "○ PARADO"           + A.reset;
  if (risk?.cycleEnded)  return A.red    + A.bold + "⚠ CICLO ENCERRADO" + A.reset;
  if (risk?.paused)      return A.yellow + A.bold + "⏸ PAUSADO"         + A.reset;
  return                        A.green  + "● online"            + A.reset;
}

function fmtDate(d) {
  if (!d) return "─".repeat(14);
  return d.toISOString().slice(5, 16).replace("T", " ");  // MM-DD HH:mm
}

// ─── Render: tela principal ───────────────────────────────────────────────────

function render() {
  if (mode === "detail") { renderDetail(); return; }

  const w   = sw();
  const sep = A.dim + "─".repeat(w) + A.reset;
  const now = new Date().toLocaleTimeString("pt-BR");
  const out = [];

  out.push(A.bold + A.white + "╔" + "═".repeat(w - 2) + "╗" + A.reset);
  out.push(A.bold + A.white + "║" + A.reset + center(A.bold + "  POLYMARKET BOT — CENTRAL DE CONTROLE  " + A.reset, w - 2) + A.bold + A.white + "║" + A.reset);
  out.push(A.bold + A.white + "║" + A.reset + center(A.dim + `Atualizado: ${now}   Refresh: ${REFRESH_MS / 1000}s   Threshold: ${THRESHOLD}%` + A.reset, w - 2) + A.bold + A.white + "║" + A.reset);
  out.push(A.bold + A.white + "╚" + "═".repeat(w - 2) + "╝" + A.reset);
  out.push("");

  agentData.forEach((ag, i) => {
    const sel   = i === selectedIdx;
    const mark  = sel ? A.bold + A.white + "▶" + A.reset : " ";
    const nameC = ag.running ? A.bold + A.green : A.bold + A.gray;
    const risk  = ag.errStats?.risk;
    const wins  = ag.errStats?.wins   ?? 0;
    const losses = ag.errStats?.losses ?? 0;
    const total  = wins + losses;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(0) : "-";
    const pidStr = ag.running ? A.dim + `PID ${ag.pid}` + A.reset : "";

    out.push(`${mark}${statusBadge(ag)}  ${nameC}${pad(ag.name, 8)}${A.reset}  ${pidStr}   ${A.dim}última: ${fmtLastActivity(ag.errStats?.lastTs)}${A.reset}`);

    if (risk) {
      const brColor = risk.bankroll >= 8 ? A.green : risk.bankroll >= 4 ? A.yellow : A.red;
      const strColor = risk.losingStreak >= 3 ? A.red : risk.losingStreak >= 1 ? A.yellow : A.gray;
      out.push(
        `   Bankroll: ${brColor}${A.bold}$${risk.bankroll.toFixed(2)}${A.reset} ` +
        `${A.dim}ciclo ${risk.cycle}  exp $${risk.exposure.toFixed(2)}  ${A.reset}` +
        `${A.green}W:${wins}${A.reset}  ${A.red}L:${losses}${A.reset}  ` +
        `${total > 0 ? (Number(winRate) >= 50 ? A.green : A.yellow) : A.gray}(${winRate}%)${A.reset}  ` +
        `${strColor}streak ${risk.losingStreak}${A.reset}`
      );
    } else {
      out.push(`   ${A.gray}Bankroll: aguardando...${A.reset}   ${A.green}W:${ag.errStats?.wins ?? 0}${A.reset}  ${A.red}L:${ag.errStats?.losses ?? 0}${A.reset}`);
    }

    if (ag.longPct !== null) {
      const lColor = ag.longPct >= THRESHOLD ? A.green : A.cyan;
      const sColor = (ag.shortPct ?? 0) >= THRESHOLD ? A.green : A.cyan;
      out.push(`   ${lColor}LONG  ${String(ag.longPct.toFixed(1)).padStart(5)}%${A.reset}  ${confBar(ag.longPct)}    ${sColor}SHORT ${String((ag.shortPct ?? 0).toFixed(1)).padStart(5)}%${A.reset}  ${confBar(ag.shortPct ?? 0)}`);
      if (ag.signal) out.push(`   Sinal: ${ag.signal.includes("UP") ? A.green : A.gray}${ag.signal}${A.reset}`);
    } else {
      out.push(A.gray + "   Sem dados de sinal." + A.reset);
    }

    if (ag.event) out.push(`   ${colorText(ag.event.text, ag.event.color)}`);
    else if (!ag.running) out.push(A.dim + "   — pressione Enter para detalhes —" + A.reset);

    out.push("");
  });

  out.push(sep);
  const pm2L = getPm2Bin() ? A.green + "PM2" + A.reset : A.yellow + "manual" + A.reset;
  out.push(
    A.dim + " ↑↓ navegar  " + A.reset +
    A.white + "Enter" + A.dim + "=detalhes  " + A.reset +
    A.yellow + "R" + A.dim + "=restart  " + A.reset +
    A.cyan  + "B" + A.dim + "=liberar bankroll  " + A.reset +
    A.dim   + "q=sair  " + A.reset + `[${pm2L}${A.dim}]` + A.reset
  );

  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);
  process.stdout.write(out.join("\n") + "\n");
}

// ─── Render: tela de detalhe ──────────────────────────────────────────────────

function renderDetail() {
  const ag     = agentData[selectedIdx];
  const w      = sw();
  const risk   = ag.errStats?.risk;
  const wins   = ag.errStats?.wins   ?? 0;
  const losses = ag.errStats?.losses ?? 0;
  const total  = wins + losses;
  const trades = readTradeHistory(ag.errLog, 10);
  const out    = [];

  const hLine = (ch = "─") => A.dim + ch.repeat(w) + A.reset;
  const box   = (s) => A.bold + A.white + "║" + A.reset + center(s, w - 2) + A.bold + A.white + "║" + A.reset;

  // ── Cabeçalho ──
  out.push(A.bold + A.white + "╔" + "═".repeat(w - 2) + "╗" + A.reset);
  out.push(box(A.bold + `  DETALHE — ${ag.name.toUpperCase()}  ` + A.reset));
  out.push(A.bold + A.white + "╚" + "═".repeat(w - 2) + "╝" + A.reset);
  out.push("");

  // ── Status + atividade ──
  out.push(
    `  ${statusBadge(ag)}   ` +
    `${A.dim}Última atividade: ${A.reset}${fmtLastActivity(ag.errStats?.lastTs)}   ` +
    (ag.running ? `${A.dim}PID ${ag.pid}${A.reset}` : "")
  );
  out.push("");

  // ── Sumário financeiro ──
  out.push(hLine());
  if (risk) {
    const brColor  = risk.bankroll >= 8 ? A.green : risk.bankroll >= 4 ? A.yellow : A.red;
    const strColor = risk.losingStreak >= 3 ? A.red : risk.losingStreak >= 1 ? A.yellow : A.green;
    const wr       = total > 0 ? ((wins / total) * 100).toFixed(1) : "─";
    const wrColor  = total > 0 ? (Number(wr) >= 50 ? A.green : A.yellow) : A.gray;

    out.push(
      `  Bankroll: ${brColor}${A.bold}$${risk.bankroll.toFixed(2)}${A.reset}` +
      `  ${A.dim}│${A.reset}  Ciclo: ${A.cyan}${risk.cycle}${A.reset}` +
      `  ${A.dim}│${A.reset}  Exposição: ${A.yellow}$${risk.exposure.toFixed(2)}${A.reset} (${risk.openPos} pos. aberta${risk.openPos !== 1 ? "s" : ""})`
    );
    out.push(
      `  Wins: ${A.green}${wins}${A.reset}` +
      `  Losses: ${A.red}${losses}${A.reset}` +
      `  Win rate: ${wrColor}${wr}%${A.reset}` +
      `  ${A.dim}│${A.reset}  Losing streak: ${strColor}${risk.losingStreak}${A.reset}` +
      `  ${A.dim}│${A.reset}  Pausado: ${risk.paused ? A.yellow + "sim" : A.green + "não"}${A.reset}` +
      `  Ciclo encerrado: ${risk.cycleEnded ? A.red + "sim" : A.green + "não"}${A.reset}`
    );
  } else {
    out.push(`  ${A.gray}Sem dados de bankroll disponíveis.${A.reset}   ${A.green}W:${wins}${A.reset}  ${A.red}L:${losses}${A.reset}`);
  }

  // ── Sinal atual ──
  if (ag.longPct !== null) {
    out.push("");
    const lColor   = ag.longPct >= THRESHOLD ? A.green : A.cyan;
    const sColor   = (ag.shortPct ?? 0) >= THRESHOLD ? A.green : A.cyan;
    const timeFmt  = ag.timeLeft !== null ? `  ${A.dim}│${A.reset}  Tempo restante: ${A.cyan}${fmtTime(ag.timeLeft)}${A.reset}` : "";
    out.push(
      `  ${lColor}LONG  ${ag.longPct.toFixed(1)}%${A.reset}  ${confBar(ag.longPct)}   ` +
      `${sColor}SHORT ${(ag.shortPct ?? 0).toFixed(1)}%${A.reset}  ${confBar(ag.shortPct ?? 0)}` +
      timeFmt
    );
    if (ag.signal) out.push(`  Sinal atual: ${ag.signal.includes("UP") ? A.green : ag.signal.includes("DOWN") ? A.red : A.gray}${A.bold}${ag.signal}${A.reset}`);
  }

  out.push("");

  // ── Histórico de apostas ──
  out.push(hLine());
  out.push(`  ${A.bold}ÚLTIMAS 10 APOSTAS${A.reset}`);
  out.push("");

  if (trades.length === 0) {
    out.push(`  ${A.gray}Nenhuma aposta confirmada encontrada no histórico.${A.reset}`);
  } else {
    // cabeçalho da tabela
    out.push(
      `  ${A.bold}${A.dim}${"#".padStart(2)}  ${"Data/Hora".padEnd(14)}  ${"Lado".padEnd(5)}  ${"Stake".padEnd(6)}  ${"Model".padEnd(6)}  ${"Edge".padEnd(5)}  ${"Entrada".padEnd(6)}  ${"Mercado".padEnd(22)}  Resultado${A.reset}`
    );
    out.push(`  ${A.dim}${"─".repeat(w - 4)}${A.reset}`);

    trades.forEach((t, i) => {
      const num       = rpad(String(i + 1), 2);
      const dt        = pad(fmtDate(t.ts), 14);
      const sideStr   = t.side === "UP"
        ? A.green  + pad("▲ UP",   5) + A.reset
        : A.red    + pad("▼ DOWN", 5) + A.reset;
      const stakeStr  = pad(`$${t.stake.toFixed(2)}`, 6);
      const modelStr  = pad(`${t.probModel.toFixed(1)}%`, 6);
      const edgeStr   = pad(`${t.edge.toFixed(1)}%`, 5);
      const entryStr  = pad(t.entryPrice ? t.entryPrice.toFixed(2) : "─", 6);
      const slugShort = trunc(t.marketSlug ?? "─", 22);
      const slugStr   = pad(slugShort, 22);

      let resultStr;
      if (t.result === "WIN")    resultStr = A.green  + A.bold + "✓ WIN"    + A.reset;
      else if (t.result === "LOSS") resultStr = A.red + A.bold + "✗ LOSS"   + A.reset;
      else                       resultStr = A.yellow + "⏳ aberta"         + A.reset;

      out.push(`  ${A.dim}${num}${A.reset}  ${dt}  ${sideStr}  ${stakeStr}  ${modelStr}  ${edgeStr}  ${entryStr}  ${slugStr}  ${resultStr}`);
    });
  }

  out.push("");

  // ── Último evento de trade ──
  if (ag.event) {
    out.push(hLine());
    out.push(`  ${A.dim}Último evento:${A.reset}  ${colorText(ag.event.text, ag.event.color)}`);
    out.push("");
  }

  // ── Rodapé ──
  out.push(hLine("═"));
  const actions = [
    ag.running
      ? `${A.red}S${A.reset}${A.dim}=parar${A.reset}`
      : `${A.green}S${A.reset}${A.dim}=iniciar${A.reset}`,
    `${A.yellow}R${A.reset}${A.dim}=restart${A.reset}`,
    `${A.cyan}B${A.reset}${A.dim}=liberar bankroll${A.reset}`,
    `${A.dim}Esc=voltar${A.reset}`,
  ];
  out.push(`  ${actions.join("   ")}`);

  // Diálogos de confirmação (sobrepostos no rodapé)
  if (mode === "confirm-start") {
    out.push("");
    out.push(`  ${A.bold}${A.green}┌─────────────────────────────────────┐${A.reset}`);
    out.push(`  ${A.bold}${A.green}│  Iniciar ${pad(ag.name + "?", 27)}│${A.reset}`);
    out.push(`  ${A.bold}${A.green}│  [S] Confirmar    [N] Cancelar      │${A.reset}`);
    out.push(`  ${A.bold}${A.green}└─────────────────────────────────────┘${A.reset}`);
  }
  if (mode === "confirm-stop") {
    out.push("");
    out.push(`  ${A.bold}${A.red}┌─────────────────────────────────────┐${A.reset}`);
    out.push(`  ${A.bold}${A.red}│  Parar ${pad(ag.name + " (PID " + ag.pid + ")?", 29)}│${A.reset}`);
    out.push(`  ${A.bold}${A.red}│  [S] Confirmar    [N] Cancelar      │${A.reset}`);
    out.push(`  ${A.bold}${A.red}└─────────────────────────────────────┘${A.reset}`);
  }
  if (mode === "confirm-restart") {
    out.push("");
    out.push(`  ${A.bold}${A.yellow}┌─────────────────────────────────────┐${A.reset}`);
    out.push(`  ${A.bold}${A.yellow}│  Reiniciar ${pad(ag.name + "?", 25)}│${A.reset}`);
    out.push(`  ${A.bold}${A.yellow}│  [S] Confirmar    [N] Cancelar      │${A.reset}`);
    out.push(`  ${A.bold}${A.yellow}└─────────────────────────────────────┘${A.reset}`);
  }
  if (mode === "confirm-liberar") {
    const br = risk ? `$${risk.bankroll.toFixed(2)}` : "?";
    out.push("");
    out.push(`  ${A.bold}${A.cyan}┌────────────────────────────────────────────────┐${A.reset}`);
    out.push(`  ${A.bold}${A.cyan}│  Liberar bankroll ${pad(ag.name, 8)} (atual: ${pad(br, 6)})?  │${A.reset}`);
    out.push(`  ${A.bold}${A.cyan}│  Reinicia o agente e reseta cicloEnded/paused. │${A.reset}`);
    out.push(`  ${A.bold}${A.cyan}│  [S] Confirmar    [N] Cancelar                 │${A.reset}`);
    out.push(`  ${A.bold}${A.cyan}└────────────────────────────────────────────────┘${A.reset}`);
  }

  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);
  process.stdout.write(out.join("\n") + "\n");
}

// ─── Ações ────────────────────────────────────────────────────────────────────

function pm2Cmd(...args) {
  const bin = getPm2Bin();
  if (!bin) return false;
  return spawnSync(bin, args, { cwd: __dirname, encoding: "utf8", timeout: 8000 }).status === 0;
}

function startAgent(agent) {
  if (getPm2Bin() && (pm2Cmd("restart", agent.name) || pm2Cmd("start", "ecosystem.config.cjs", "--only", agent.name))) return;
  mkdirSync(path.resolve(__dirname, "logs"), { recursive: true });
  const fd    = openSync(path.resolve(__dirname, agent.startLog), "a");
  const child = spawn("node", ["src/index.js"], {
    cwd: __dirname, env: { ...process.env, TIMEFRAME: agent.timeframe },
    stdio: ["ignore", "ignore", fd], detached: true,
  });
  child.unref();
}

function stopAgent(agent) {
  if (getPm2Bin() && pm2Cmd("stop", agent.name)) return;
  if (agent.pid) try { process.kill(agent.pid, "SIGTERM"); } catch { /* já parado */ }
}

function restartAgent(agent) {
  if (getPm2Bin() && pm2Cmd("restart", agent.name)) return;
  stopAgent(agent);
  setTimeout(() => startAgent(agent), 1000);
}

// ─── Teclado ──────────────────────────────────────────────────────────────────

function handleKey(buf) {
  const key = buf.toString();
  if (key === "\x03") return exit();

  // ── Modo visualização ──
  if (mode === "view") {
    if (key === "\x1b[A" || key === "k") {
      selectedIdx = (selectedIdx - 1 + AGENTS.length) % AGENTS.length;
      render();
    } else if (key === "\x1b[B" || key === "j") {
      selectedIdx = (selectedIdx + 1) % AGENTS.length;
      render();
    } else if (key === "\r" || key === "\n") {
      mode = "detail";
      render();
    } else if (key === "r" || key === "R") {
      mode = "confirm-restart";
      render();
    } else if (key === "b" || key === "B") {
      mode = "confirm-liberar";
      render();
    } else if (key === "q" || key === "Q") {
      exit();
    }
    return;
  }

  // ── Modo detalhe (sem confirmação) ──
  if (mode === "detail") {
    const ag = agentData[selectedIdx];
    if (key === "\x1b" || key === "q" || key === "Q") {
      mode = "view"; render();
    } else if (key === "s" || key === "S") {
      mode = ag.running ? "confirm-stop" : "confirm-start"; render();
    } else if (key === "r" || key === "R") {
      mode = "confirm-restart"; render();
    } else if (key === "b" || key === "B") {
      mode = "confirm-liberar"; render();
    }
    return;
  }

  // ── Modos de confirmação ──
  if (key === "s" || key === "S") {
    const ag = agentData[selectedIdx];
    if (mode === "confirm-start")   startAgent(ag);
    if (mode === "confirm-stop")    stopAgent(ag);
    if (mode === "confirm-restart") restartAgent(ag);
    if (mode === "confirm-liberar") restartAgent(ag);
    mode = "detail";
    setTimeout(() => { fetchAll(); render(); }, 1500);
  } else if (key === "n" || key === "N" || key === "\x1b") {
    mode = mode === "confirm-start" || mode === "confirm-stop" ||
           mode === "confirm-restart" || mode === "confirm-liberar"
      ? "detail" : "view";
    render();
  }
}

// ─── Ciclo de vida ────────────────────────────────────────────────────────────

function exit() {
  clearInterval(refreshTimer);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);
  process.stdout.write(A.green + "Monitor encerrado.\n" + A.reset);
  process.exit(0);
}

function main() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", handleKey);

  fetchAll();
  render();

  refreshTimer = setInterval(() => {
    if (mode === "view" || mode === "detail") { fetchAll(); render(); }
  }, REFRESH_MS);
}

main();
