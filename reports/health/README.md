# reports/health/

Daily health-check reports and tuning backlog for the Polymarket bots.

## Files

| File | Description |
|------|-------------|
| `YYYY-MM-DD.md` | Daily report for that date |
| `TODO.md` | Tuning backlog — items survive across days until a human marks them DONE or DISMISSED |
| `README.md` | This file |

## Generating a report

```bash
# Daily report (today, writes files)
node jobs/health-check.js

# Dry run (stdout only, nothing written)
node jobs/health-check.js --dry-run

# Custom date and lookback window
node jobs/health-check.js --date 2026-04-18 --lookback-hours 48
```

## Scheduling

**Option A — PM2 cron** (keeps everything in PM2):

Add to `ecosystem.config.cjs`:
```js
{
  name:    "health-check",
  script:  "jobs/health-check.js",
  cron_restart: "0 8 * * *",   // 08:00 UTC daily
  autorestart: false,
  env: { NODE_ENV: "production" },
  out_file: "logs/health-check-out.log",
  error_file: "logs/health-check-err.log",
}
```
Then: `pm2 reload ecosystem.config.cjs && pm2 save`

**Option B — system crontab** (simpler, no PM2 dependency):

```bash
crontab -e
# Add:
0 8 * * *  cd /path/to/project && node jobs/health-check.js >> logs/health-check-out.log 2>> logs/health-check-err.log
```

Option B is recommended if you already manage cron on the server; Option A keeps all process management in one place.

## TODO.md format

Items are identified by `TUNE-YYYYMMDD-NNN` IDs.

- **Status** — `OPEN` | `DONE` | `DISMISSED`
- **Seen count** — how many times the recommendation fired (deduplicates same rec across days)
- **Human decision** — write your rationale when closing an item

Items are never auto-closed. The job only adds or increments `seen_count`.

## Recommendation thresholds

| Check | Threshold | Confidence |
|-------|-----------|------------|
| Dead-neutral rate | >60%, n≥500 | LOW (1 day) / HIGH (3+ days) |
| prob_market gate | >30% of blocks | LOW (<50 trades) / MEDIUM (≥50) |
| min_ticket gate | >15% of blocks | MEDIUM |
| Calibration drift | >10pp, n≥50 | MEDIUM / HIGH (n≥200) |
| Zero trade days | 3 consecutive | LOW–MEDIUM |
| Losing streak pause | any pause | HIGH (observation only) |
| Uptime | <95% | HIGH |
