pub mod config;
pub mod entry;
pub mod exit;
pub mod sizing;
pub mod state;
pub mod time;
pub mod types;

pub use config::PredictionConfig;
pub use entry::{EntryDecision, EntryOrder, SkipReason, evaluate_entry};
pub use exit::{ExitDecision, ExitReason, evaluate_exit};
pub use sizing::size_trade;
pub use state::{CircuitBreaker, PredictionState};
pub use time::in_trading_hours;
pub use types::{MarketSnapshot, OpenPosition, Side};
