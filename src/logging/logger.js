import pino from "pino";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const TIMEFRAME = (process.env.TIMEFRAME || "btc-15m").trim().toLowerCase();
const LOG_DIR = resolve(process.cwd(), "logs");

try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* exists */ }

// Pino transport: async worker threads, non-blocking I/O.
// - info+  → logs/{timeframe}-info.log  (rotated 5 × 10 MB)
// - error+ → logs/{timeframe}-error.log (rotated 5 × 10 MB)
// - info+  → stderr fd:2 (for PM2 to capture)
const transport = pino.transport({
  targets: [
    {
      target: "pino-roll",
      level: "info",
      options: {
        file: resolve(LOG_DIR, `${TIMEFRAME}-info.log`),
        size: "10m",
        limit: { count: 5 },
      },
    },
    {
      target: "pino-roll",
      level: "error",
      options: {
        file: resolve(LOG_DIR, `${TIMEFRAME}-error.log`),
        size: "10m",
        limit: { count: 5 },
      },
    },
    {
      target: "pino/file",
      level: "info",
      options: { destination: 2 }, // stderr — PM2 captures this
    },
  ],
});

export const logger = pino(
  {
    level: "info",
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport,
);
