use crate::prediction::config::PredictionConfig;
use crate::prediction::state::PredictionState;
use crate::prediction::time::in_trading_hours;
use crate::prediction::types::{MarketSnapshot, Side};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    TradingDisabled,
    OpenPositionExists,
    OutsideTradingHours,
    MarketNotAlive,
    CheapSideOutOfRange,
    PricesUnavailable,
    CircuitBreakerTripped,
}

impl SkipReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            SkipReason::TradingDisabled => "trading_disabled",
            SkipReason::OpenPositionExists => "open_position_exists",
            SkipReason::OutsideTradingHours => "outside_trading_hours",
            SkipReason::MarketNotAlive => "market_not_alive",
            SkipReason::CheapSideOutOfRange => "cheap_side_out_of_range",
            SkipReason::PricesUnavailable => "prices_unavailable",
            SkipReason::CircuitBreakerTripped => "circuit_breaker_tripped",
        }
    }
}

#[derive(Debug, Clone)]
pub struct EntryOrder {
    pub side: Side,
    pub price: Decimal,
}

#[derive(Debug, Clone)]
pub enum EntryDecision {
    Enter(EntryOrder),
    Skip(SkipReason),
}

pub fn evaluate_entry(
    state: &PredictionState,
    snapshot: &MarketSnapshot,
    cfg: &PredictionConfig,
    now: DateTime<Utc>,
) -> EntryDecision {
    if !state.trading_enabled {
        return EntryDecision::Skip(SkipReason::TradingDisabled);
    }
    if state.has_open_position {
        return EntryDecision::Skip(SkipReason::OpenPositionExists);
    }
    if state.circuit_breaker_tripped(now) {
        return EntryDecision::Skip(SkipReason::CircuitBreakerTripped);
    }
    if !in_trading_hours(
        now,
        cfg.trading_hours_start_pst,
        cfg.trading_hours_end_pst,
        cfg.allow_weekends,
    ) {
        return EntryDecision::Skip(SkipReason::OutsideTradingHours);
    }
    if snapshot.time_left_minutes(now) < cfg.time_left_min_minutes {
        return EntryDecision::Skip(SkipReason::MarketNotAlive);
    }

    let up_ask = snapshot.up_ask;
    let down_ask = snapshot.down_ask;
    if up_ask.is_none() && down_ask.is_none() {
        return EntryDecision::Skip(SkipReason::PricesUnavailable);
    }

    let up_ok = up_ask
        .map(|p| p >= cfg.cheap_side_min && p <= cfg.cheap_side_max)
        .unwrap_or(false);
    let down_ok = down_ask
        .map(|p| p >= cfg.cheap_side_min && p <= cfg.cheap_side_max)
        .unwrap_or(false);

    let pick = match (up_ok, down_ok) {
        (false, false) => return EntryDecision::Skip(SkipReason::CheapSideOutOfRange),
        (true, false) => Some((Side::Up, up_ask.unwrap())),
        (false, true) => Some((Side::Down, down_ask.unwrap())),
        (true, true) => {
            let up = up_ask.unwrap();
            let dn = down_ask.unwrap();
            if up <= dn {
                Some((Side::Up, up))
            } else {
                Some((Side::Down, dn))
            }
        }
    };

    match pick {
        Some((side, price)) => EntryDecision::Enter(EntryOrder { side, price }),
        None => EntryDecision::Skip(SkipReason::CheapSideOutOfRange),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use rust_decimal_macros::dec;

    fn cfg() -> PredictionConfig {
        PredictionConfig {
            stake_pct: dec!(0.08),
            min_stake_usd: dec!(25),
            max_stake_usd: dec!(250),
            stop_loss_pct: dec!(0.30),
            cheap_side_min: dec!(0.15),
            cheap_side_max: dec!(0.45),
            time_left_min_minutes: 1.5,
            trading_hours_start_pst: 6,
            trading_hours_end_pst: 17,
            allow_weekends: false,
            fee_rate: dec!(0.02),
        }
    }

    fn snapshot_at(
        up: Option<Decimal>,
        down: Option<Decimal>,
        end_in_min: i64,
        now: DateTime<Utc>,
    ) -> MarketSnapshot {
        MarketSnapshot {
            market_slug: "btc-updown-5m-x".into(),
            end_date: now + chrono::Duration::minutes(end_in_min),
            up_price: up.unwrap_or(dec!(0.5)),
            down_price: down.unwrap_or(dec!(0.5)),
            up_ask: up,
            down_ask: down,
            up_bid: up,
            down_bid: down,
            fetched_at: now,
        }
    }

    fn snapshot(up: Option<Decimal>, down: Option<Decimal>, end_in_min: i64) -> MarketSnapshot {
        snapshot_at(up, down, end_in_min, weekday_active_now())
    }

    fn weekday_active_now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 4, 15, 17, 0, 0).unwrap()
    }

    fn enabled_state() -> PredictionState {
        PredictionState {
            trading_enabled: true,
            ..PredictionState::default()
        }
    }

    #[test]
    fn trading_disabled_blocks() {
        let s = PredictionState::default();
        let snap = snapshot(Some(dec!(0.25)), Some(dec!(0.75)), 4);
        let d = evaluate_entry(&s, &snap, &cfg(), weekday_active_now());
        assert!(matches!(d, EntryDecision::Skip(SkipReason::TradingDisabled)));
    }

    #[test]
    fn happy_path_picks_cheap_side() {
        let s = enabled_state();
        let snap = snapshot(Some(dec!(0.25)), Some(dec!(0.75)), 4);
        match evaluate_entry(&s, &snap, &cfg(), weekday_active_now()) {
            EntryDecision::Enter(o) => {
                assert_eq!(o.side, Side::Up);
                assert_eq!(o.price, dec!(0.25));
            }
            other => panic!("expected Enter, got {other:?}"),
        }
    }

    #[test]
    fn picks_cheaper_of_two_in_range() {
        let s = enabled_state();
        let snap = snapshot(Some(dec!(0.40)), Some(dec!(0.30)), 4);
        match evaluate_entry(&s, &snap, &cfg(), weekday_active_now()) {
            EntryDecision::Enter(o) => {
                assert_eq!(o.side, Side::Down);
                assert_eq!(o.price, dec!(0.30));
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn out_of_range_skips() {
        let s = enabled_state();
        let snap = snapshot(Some(dec!(0.10)), Some(dec!(0.90)), 4);
        assert!(matches!(
            evaluate_entry(&s, &snap, &cfg(), weekday_active_now()),
            EntryDecision::Skip(SkipReason::CheapSideOutOfRange)
        ));
    }

    #[test]
    fn no_prices_skips() {
        let s = enabled_state();
        let snap = snapshot(None, None, 4);
        assert!(matches!(
            evaluate_entry(&s, &snap, &cfg(), weekday_active_now()),
            EntryDecision::Skip(SkipReason::PricesUnavailable)
        ));
    }

    #[test]
    fn near_settlement_skips() {
        let s = enabled_state();
        let snap = snapshot(Some(dec!(0.25)), Some(dec!(0.75)), 1);
        assert!(matches!(
            evaluate_entry(&s, &snap, &cfg(), weekday_active_now()),
            EntryDecision::Skip(SkipReason::MarketNotAlive)
        ));
    }

    #[test]
    fn outside_hours_skips() {
        let s = enabled_state();
        let after_hours = Utc.with_ymd_and_hms(2026, 4, 15, 2, 0, 0).unwrap();
        let snap = snapshot_at(Some(dec!(0.25)), Some(dec!(0.75)), 4, after_hours);
        assert!(matches!(
            evaluate_entry(&s, &snap, &cfg(), after_hours),
            EntryDecision::Skip(SkipReason::OutsideTradingHours)
        ));
    }

    #[test]
    fn open_position_skips() {
        let mut s = enabled_state();
        s.has_open_position = true;
        let snap = snapshot(Some(dec!(0.25)), Some(dec!(0.75)), 4);
        assert!(matches!(
            evaluate_entry(&s, &snap, &cfg(), weekday_active_now()),
            EntryDecision::Skip(SkipReason::OpenPositionExists)
        ));
    }
}
