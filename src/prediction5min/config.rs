use rust_decimal::Decimal;

#[derive(Debug, Clone)]
pub struct PredictionConfig {
    pub stake_pct: Decimal,
    pub min_stake_usd: Decimal,
    pub max_stake_usd: Decimal,
    pub stop_loss_pct: Decimal,
    pub cheap_side_min: Decimal,
    pub cheap_side_max: Decimal,
    pub time_left_min_minutes: f64,
    pub trading_hours_start_pst: u32,
    pub trading_hours_end_pst: u32,
    pub allow_weekends: bool,
    pub fee_rate: Decimal,
}
