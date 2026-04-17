use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Side {
    Up,
    Down,
}

impl Side {
    pub fn opposite(self) -> Self {
        match self {
            Side::Up => Side::Down,
            Side::Down => Side::Up,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Side::Up => "UP",
            Side::Down => "DOWN",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketSnapshot {
    pub market_slug: String,
    pub end_date: DateTime<Utc>,
    pub up_price: Decimal,
    pub down_price: Decimal,
    pub up_ask: Option<Decimal>,
    pub down_ask: Option<Decimal>,
    pub up_bid: Option<Decimal>,
    pub down_bid: Option<Decimal>,
    pub fetched_at: DateTime<Utc>,
}

impl MarketSnapshot {
    pub fn time_left(&self, now: DateTime<Utc>) -> chrono::Duration {
        self.end_date - now
    }

    pub fn time_left_sec(&self, now: DateTime<Utc>) -> i64 {
        self.time_left(now).num_seconds()
    }

    pub fn time_left_minutes(&self, now: DateTime<Utc>) -> f64 {
        (self.end_date - now).num_milliseconds() as f64 / 60_000.0
    }

    pub fn ask_for(&self, side: Side) -> Option<Decimal> {
        match side {
            Side::Up => self.up_ask,
            Side::Down => self.down_ask,
        }
    }

    pub fn bid_for(&self, side: Side) -> Option<Decimal> {
        match side {
            Side::Up => self.up_bid,
            Side::Down => self.down_bid,
        }
    }

    pub fn price_for(&self, side: Side) -> Decimal {
        match side {
            Side::Up => self.up_price,
            Side::Down => self.down_price,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenPosition {
    pub side: Side,
    pub entry_price: Decimal,
    pub shares: Decimal,
    pub contract_size: Decimal,
    pub market_slug: String,
    pub market_end_date: DateTime<Utc>,
    pub max_unrealized_pnl: Decimal,
    pub min_unrealized_pnl: Decimal,
}

impl OpenPosition {
    pub fn unrealized_pnl(&self, current_price: Decimal) -> Decimal {
        (current_price - self.entry_price) * self.shares
    }

    pub fn update_mfe_mae(&mut self, current_price: Decimal) {
        let pnl = self.unrealized_pnl(current_price);
        if pnl > self.max_unrealized_pnl {
            self.max_unrealized_pnl = pnl;
        }
        if pnl < self.min_unrealized_pnl {
            self.min_unrealized_pnl = pnl;
        }
    }
}
