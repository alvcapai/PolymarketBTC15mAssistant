export function sizeTrade(balance, price, cfg) {
  if (balance <= 0 || price <= 0) return 0;
  const rawStake = balance * cfg.stakePct;
  const stake    = Math.max(cfg.minStakeUsd, Math.min(cfg.maxStakeUsd, rawStake));
  const effective = price * (1 + cfg.feeRate);
  if (effective <= 0) return 0;
  const shares = stake / effective;
  return Math.floor(shares * 100) / 100;
}
