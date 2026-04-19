# Bot Health Report — 2026-04-19

_Generated at 2026-04-19T19:49:17.650Z_

---

## TL;DR

⚠️ One or more bots have health issues — see sections below. No trades fired in the last 24h. **Dominant blocker:** `prob_model_below_0.54` (13536 occurrences). **1 tuning recommendation(s)** generated — see Recommended Adjustments section.

---

## Signal health

### Pre-calibration adjustedUp distribution

| Bucket | BTC-15M | ETH-15M |
| --- | --- | --- |
| [0.0, 0.1) | 46 (0.0%) | 54 (0.1%) |
| [0.1, 0.2) | 1133 (1.1%) | 1273 (2.3%) |
| [0.2, 0.3) | 4196 (4.2%) | 1820 (3.3%) |
| [0.3, 0.4) | 9161 (9.1%) | 2950 (5.4%) |
| [0.4, 0.5) | 34472 (34.2%) | 16837 (30.8%) |
| [0.5, 0.6) | 46929 (46.5%) | 31278 (57.3%) |
| [0.6, 0.7) | 3290 (3.3%) | 115 (0.2%) |
| [0.7, 0.8) | 1511 (1.5%) | 140 (0.3%) |
| [0.8, 0.9) | 168 (0.2%) | 127 (0.2%) |
| [0.9, 1.0) | 13 (0.0%) | 0 (0.0%) |

### Post-calibration probModel distribution

| Bucket | BTC-15M | ETH-15M |
| --- | --- | --- |
| [0.0, 0.1) | 291 (0.3%) | 394 (0.7%) |
| [0.1, 0.2) | 3200 (3.2%) | 2068 (3.8%) |
| [0.2, 0.3) | 6305 (6.2%) | 2443 (4.5%) |
| [0.3, 0.4) | 10335 (10.2%) | 2773 (5.1%) |
| [0.4, 0.5) | 28877 (28.6%) | 15256 (27.9%) |
| [0.5, 0.6) | 44407 (44.0%) | 31043 (56.9%) |
| [0.6, 0.7) | 4355 (4.3%) | 258 (0.5%) |
| [0.7, 0.8) | 2156 (2.1%) | 93 (0.2%) |
| [0.8, 0.9) | 908 (0.9%) | 266 (0.5%) |
| [0.9, 1.0) | 85 (0.1%) | 0 (0.0%) |

### Key rates

| Metric | BTC-15M | ETH-15M |
| --- | --- | --- |
| Dead-neutral rate (probModelUp ∈ [0.49, 0.51]) | 29.3% | 42.1% |
| Spurious neutral (adjustedUp outside [0.45,0.55] but probModel neutral) | 0.0% | 0.0% |

**BTC-15M — of 38984 prob_model-blocked ticks:** 28927 (74.2%) were genuinely neutral (adjustedUp ∈ [0.45,0.55]); 10057 had a real signal that calibration compressed below MIN_PROB.

**ETH-15M — of 39721 prob_model-blocked ticks:** 29602 (74.5%) were genuinely neutral (adjustedUp ∈ [0.45,0.55]); 10119 had a real signal that calibration compressed below MIN_PROB.

---

## Gate distribution (last 24h)

### BTC-15M

Total ticks: 13207

| Reason | Count | % | Δ vs prev 24h |
| --- | --- | --- | --- |
| prob_model_below_0.54 | 6674 | 50.5% | — |
| prob_market_below_0.55 | 3843 | 29.1% | — |
| price_requires_above_max_stake_1.02 | 1004 | 7.6% | — |
| net_edge_out_of_range_0.03_0.5 | 810 | 6.1% | — |
| prob_market_below_0.5 | 710 | 5.4% | — |
| none | 156 | 1.2% | — |
| min_ticket_exceeds_risk_cap | 10 | 0.1% | — |

### ETH-15M

Total ticks: 13096

| Reason | Count | % | Δ vs prev 24h |
| --- | --- | --- | --- |
| prob_model_below_0.54 | 6862 | 52.4% | — |
| prob_market_below_0.55 | 3734 | 28.5% | — |
| net_edge_out_of_range_0.03_0.5 | 931 | 7.1% | — |
| price_requires_above_max_stake_1.02 | 794 | 6.1% | — |
| prob_market_below_0.5 | 503 | 3.8% | — |
| none | 184 | 1.4% | — |
| min_ticket_exceeds_risk_cap | 88 | 0.7% | — |


---

## Trade performance (last 24h)

### BTC-15M

_No trades in this period._

### ETH-15M

_No trades in this period._

> Zero trades fired across all bots. This is not flagged as a problem unless it persists for 3+ consecutive days.


---

## Bankroll

| Bot | Bankroll | Cycle | Exposure | Losing streak | Paused | Risk events |
| --- | --- | --- | --- | --- | --- | --- |
| btc-15m | $20.34 | 1 | $0.00 | 0 | no | none |
| eth-15m | $20.34 | 1 | $0.00 | 0 | no | none |

---

## Uptime

| Bot | Observed ticks | Expected ticks | Uptime % |
| --- | --- | --- | --- |
| btc-15m | 100919 | 86400 | 116.8% |
| eth-15m | 54594 | 86400 | 63.2% |

---

## Recommended adjustments

### 1. [ETH-15M] Bot uptime below 95%

**WHAT:** Investigate PM2 restart logs and server health. This is an infrastructure issue, not a tuning issue.

**WHY:** Observed 63.2% uptime (54594 / 86400 expected ticks).

**Expected impact:** Recovering missed ticks may increase trade count if signals were firing during downtime

**Risk:** N/A — infrastructure issue

**Metric cited:** `uptime = 63.2%`

**Confidence:** HIGH

**Reversibility:** N/A

**Do NOT apply if:** N/A


---

## Data quality notes

_No data quality issues detected._
