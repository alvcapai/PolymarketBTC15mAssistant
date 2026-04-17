use chrono::{DateTime, Utc};

const CIRCUIT_TRIP_LOSSES: u32 = 3;
const CIRCUIT_BASE_COOLDOWN_SEC: i64 = 5;
const CIRCUIT_MAX_COOLDOWN_SEC: i64 = 60;

#[derive(Debug, Clone)]
pub struct CircuitBreaker {
    pub consecutive_losses: u32,
    pub cooldown_until: Option<DateTime<Utc>>,
}

impl Default for CircuitBreaker {
    fn default() -> Self {
        Self {
            consecutive_losses: 0,
            cooldown_until: None,
        }
    }
}

impl CircuitBreaker {
    pub fn is_tripped(&self, now: DateTime<Utc>) -> bool {
        self.cooldown_until.map(|t| now < t).unwrap_or(false)
    }

    pub fn reset(&mut self) {
        self.consecutive_losses = 0;
        self.cooldown_until = None;
    }

    pub fn record_loss(&mut self, now: DateTime<Utc>) {
        self.consecutive_losses += 1;
        if self.consecutive_losses >= CIRCUIT_TRIP_LOSSES {
            let extra = self.consecutive_losses - CIRCUIT_TRIP_LOSSES;
            let secs = (CIRCUIT_BASE_COOLDOWN_SEC << extra.min(5))
                .min(CIRCUIT_MAX_COOLDOWN_SEC);
            self.cooldown_until = Some(now + chrono::Duration::seconds(secs));
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PredictionState {
    pub trading_enabled: bool,
    pub kill_switch: bool,
    pub has_open_position: bool,
    pub circuit_breaker: CircuitBreaker,
}

impl PredictionState {
    pub fn circuit_breaker_tripped(&self, now: DateTime<Utc>) -> bool {
        self.circuit_breaker.is_tripped(now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circuit_trips_after_three_losses() {
        let now = Utc::now();
        let mut cb = CircuitBreaker::default();
        assert!(!cb.is_tripped(now));
        cb.record_loss(now);
        cb.record_loss(now);
        assert!(!cb.is_tripped(now));
        cb.record_loss(now);
        assert!(cb.is_tripped(now));
    }

    #[test]
    fn circuit_resets_after_win() {
        let now = Utc::now();
        let mut cb = CircuitBreaker::default();
        cb.record_loss(now);
        cb.record_loss(now);
        cb.record_loss(now);
        assert!(cb.is_tripped(now));
        cb.reset();
        assert!(!cb.is_tripped(now));
        assert_eq!(cb.consecutive_losses, 0);
    }

    #[test]
    fn backoff_grows() {
        let now = Utc::now();
        let mut cb = CircuitBreaker::default();
        cb.record_loss(now);
        cb.record_loss(now);
        cb.record_loss(now);
        let first = cb.cooldown_until.unwrap();
        cb.record_loss(now);
        let second = cb.cooldown_until.unwrap();
        assert!(second > first);
    }
}
