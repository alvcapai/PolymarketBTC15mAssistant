#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OPEN_PATH = path.resolve(ROOT, "data", "trades_opened.jsonl");
const CLOSE_PATH = path.resolve(ROOT, "data", "trades_closed.jsonl");
const REPORT_PATH = path.resolve(ROOT, "analysis", "trade_report.json");

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pct(v) {
  return `${(v * 100).toFixed(2)}%`;
}

function bucketLabel(value, bounds, labels) {
  for (let i = 0; i < bounds.length; i += 1) {
    if (value < bounds[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

function summarizeTrades(openRecords, closeRecords) {
  const closeByTradeId = new Map(
    closeRecords
      .map((r) => [String(r.trade_id ?? ""), r])
      .filter(([id]) => id)
  );

  const joined = [];
  for (const open of openRecords) {
    const tradeId = String(open.trade_id ?? "");
    if (!tradeId) continue;
    const close = closeByTradeId.get(tradeId);
    if (!close) continue;
    joined.push({ open, close });
  }

  const unresolved = openRecords.filter((o) => {
    const id = String(o.trade_id ?? "");
    return id && !closeByTradeId.has(id);
  });

  return { joined, unresolved };
}

function aggregateBucket(rows) {
  if (!rows.length) {
    return {
      trades: 0,
      prob_model_avg: 0,
      prob_market_avg: 0,
      edge_avg: 0,
      win_rate: 0,
      volume: 0,
      pnl: 0,
      roi: 0,
      edge_real_aproximado: 0
    };
  }

  const trades = rows.length;
  const wins = rows.reduce((a, r) => a + (toNum(r.close.won) === 1 ? 1 : 0), 0);
  const probModelAvg = rows.reduce((a, r) => a + toNum(r.open.prob_modelo), 0) / trades;
  const probMarketAvg = rows.reduce((a, r) => a + toNum(r.open.prob_mercado), 0) / trades;
  const edgeAvg = rows.reduce((a, r) => a + toNum(r.open.edge), 0) / trades;
  const volume = rows.reduce((a, r) => a + toNum(r.open.stake), 0);
  const pnl = rows.reduce((a, r) => a + toNum(r.close.pnl_realized), 0);
  const winRate = wins / trades;
  const roi = volume > 0 ? pnl / volume : 0;
  const edgeReal = winRate - probMarketAvg;

  return {
    trades,
    prob_model_avg: probModelAvg,
    prob_market_avg: probMarketAvg,
    edge_avg: edgeAvg,
    win_rate: winRate,
    volume,
    pnl,
    roi,
    edge_real_aproximado: edgeReal
  };
}

function printSection(title) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

function run() {
  const openRecords = readJsonl(OPEN_PATH);
  const closeRecords = readJsonl(CLOSE_PATH);
  const { joined, unresolved } = summarizeTrades(openRecords, closeRecords);

  const totalTrades = joined.length;
  const totalWins = joined.reduce((a, r) => a + (toNum(r.close.won) === 1 ? 1 : 0), 0);
  const totalLosses = totalTrades - totalWins;
  const totalVolume = joined.reduce((a, r) => a + toNum(r.open.stake), 0);
  const totalPnl = joined.reduce((a, r) => a + toNum(r.close.pnl_realized), 0);
  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
  const roi = totalVolume > 0 ? totalPnl / totalVolume : 0;

  const probBuckets = {
    "0.75-0.80": [],
    "0.80-0.85": [],
    "0.85-0.90": [],
    "0.90+": []
  };
  const edgeBuckets = {
    "0.04-0.06": [],
    "0.06-0.09": [],
    "0.09-0.12": [],
    "0.12+": []
  };
  const markets = {};

  for (const row of joined) {
    const p = toNum(row.open.prob_modelo);
    const e = toNum(row.open.edge);
    const market = String(row.open.market_type ?? "UNKNOWN");

    const pLabel = bucketLabel(p, [0.8, 0.85, 0.9], ["0.75-0.80", "0.80-0.85", "0.85-0.90", "0.90+"]);
    if (probBuckets[pLabel]) probBuckets[pLabel].push(row);

    const eLabel = bucketLabel(e, [0.06, 0.09, 0.12], ["0.04-0.06", "0.06-0.09", "0.09-0.12", "0.12+"]);
    if (edgeBuckets[eLabel]) edgeBuckets[eLabel].push(row);

    if (!markets[market]) markets[market] = [];
    markets[market].push(row);
  }

  printSection("SUMMARY");
  console.log(`Total trades: ${totalTrades}`);
  console.log(`Wins: ${totalWins}`);
  console.log(`Losses: ${totalLosses}`);
  console.log(`Win rate: ${pct(winRate)}`);
  console.log(`Volume total: $${totalVolume.toFixed(2)}`);
  console.log(`Lucro liquido: $${totalPnl.toFixed(2)}`);
  console.log(`ROI total: ${pct(roi)}`);
  console.log(`Open sem fechamento: ${unresolved.length}`);

  printSection("CALIBRATION BY MODEL PROBABILITY");
  for (const [label, rows] of Object.entries(probBuckets)) {
    const s = aggregateBucket(rows);
    console.log(
      `${label} | trades=${s.trades} | win_rate=${pct(s.win_rate)} | ` +
      `prob_model_avg=${pct(s.prob_model_avg)}`
    );
  }

  printSection("PERFORMANCE BY EDGE BUCKET");
  for (const [label, rows] of Object.entries(edgeBuckets)) {
    const s = aggregateBucket(rows);
    console.log(
      `${label} | trades=${s.trades} | prob_market_avg=${pct(s.prob_market_avg)} | ` +
      `prob_model_avg=${pct(s.prob_model_avg)} | edge_avg=${pct(s.edge_avg)} | ` +
      `win_rate=${pct(s.win_rate)} | edge_real_aprox=${pct(s.edge_real_aproximado)} | ` +
      `roi=${pct(s.roi)}`
    );
  }

  printSection("PERFORMANCE BY MARKET");
  for (const [market, rows] of Object.entries(markets)) {
    const s = aggregateBucket(rows);
    console.log(
      `${market} | trades=${s.trades} | win_rate=${pct(s.win_rate)} | roi=${pct(s.roi)} | pnl=$${s.pnl.toFixed(2)}`
    );
  }

  const warnings = [];
  if (totalTrades > 0) {
    const avgProbModel = joined.reduce((a, r) => a + toNum(r.open.prob_modelo), 0) / totalTrades;
    if (avgProbModel - winRate > 0.05) {
      warnings.push(`Prob_modelo parece superconfiante: media=${pct(avgProbModel)} vs win_rate=${pct(winRate)}.`);
    }
    if (winRate - avgProbModel > 0.05) {
      warnings.push(`Prob_modelo parece subconfiante: media=${pct(avgProbModel)} vs win_rate=${pct(winRate)}.`);
    }
  }

  const lowEdge = aggregateBucket(edgeBuckets["0.04-0.06"]);
  const highEdge = aggregateBucket(edgeBuckets["0.12+"]);
  if (lowEdge.trades >= 10 && highEdge.trades >= 10 && highEdge.win_rate <= lowEdge.win_rate) {
    warnings.push("Faixas maiores de edge nao melhoraram win rate.");
  }

  for (const [market, rows] of Object.entries(markets)) {
    const s = aggregateBucket(rows);
    if (s.trades >= 10 && s.roi < 0) {
      warnings.push(`Mercado ${market} com ROI negativo (${pct(s.roi)}).`);
    }
  }

  if (roi < 0 && totalTrades > 0) {
    warnings.push(`ROI total negativo (${pct(roi)}).`);
  }

  printSection("WARNINGS");
  if (!warnings.length) {
    console.log("Nenhum alerta critico detectado com os dados atuais.");
  } else {
    for (const w of warnings) {
      console.log(`- ${w}`);
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    summary: {
      total_trades: totalTrades,
      wins: totalWins,
      losses: totalLosses,
      win_rate: winRate,
      volume_total: totalVolume,
      lucro_liquido: totalPnl,
      roi_total: roi,
      unresolved_open_trades: unresolved.length
    },
    calibration_by_probability: Object.fromEntries(
      Object.entries(probBuckets).map(([label, rows]) => [label, aggregateBucket(rows)])
    ),
    performance_by_edge: Object.fromEntries(
      Object.entries(edgeBuckets).map(([label, rows]) => [label, aggregateBucket(rows)])
    ),
    performance_by_market: Object.fromEntries(
      Object.entries(markets).map(([market, rows]) => [market, aggregateBucket(rows)])
    ),
    warnings
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nRelatorio salvo em: ${REPORT_PATH}`);
}

run();
