use crate::prediction::config::PredictionConfig;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;

pub fn size_trade(balance: Decimal, price: Decimal, cfg: &PredictionConfig) -> Decimal {
    if balance <= dec!(0) || price <= dec!(0) {
        return dec!(0);
    }
    let raw_stake = balance * cfg.stake_pct;
    let stake = raw_stake.clamp(cfg.min_stake_usd, cfg.max_stake_usd);
    let effective = price * (dec!(1) + cfg.fee_rate);
    if effective <= dec!(0) {
        return dec!(0);
    }
    let shares = stake / effective;
    round_down(shares, 2)
}

fn round_down(value: Decimal, dp: u32) -> Decimal {
    value.round_dp_with_strategy(dp, rust_decimal::RoundingStrategy::ToZero)
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn happy_path_8pct_of_1000_at_0_25() {
        let s = size_trade(dec!(1000), dec!(0.25), &cfg());
        assert_eq!(s, dec!(313.72));
    }

    #[test]
    fn clamps_to_min_stake() {
        let s = size_trade(dec!(100), dec!(0.25), &cfg());
        assert_eq!(s, dec!(98.03));
    }

    #[test]
    fn clamps_to_max_stake() {
        let s = size_trade(dec!(10000), dec!(0.25), &cfg());
        assert_eq!(s, dec!(980.39));
    }

    #[test]
    fn zero_balance_returns_zero() {
        assert_eq!(size_trade(dec!(0), dec!(0.25), &cfg()), dec!(0));
    }

    #[test]
    fn zero_price_returns_zero() {
        assert_eq!(size_trade(dec!(1000), dec!(0), &cfg()), dec!(0));
    }
}
