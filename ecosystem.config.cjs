module.exports = {
  apps: [
    {
      name:       "btc-15m",
      script:     "src/index.js",
      interpreter: "node",
      env:        { TIMEFRAME: "btc-15m", NODE_ENV: "production" },
      error_file: "logs/btc15m-err.log",
      out_file:   "logs/btc15m-out.log",
      merge_logs: true,
      time:       true,
    },
    {
      name:       "eth-15m",
      script:     "src/index.js",
      interpreter: "node",
      env:        { TIMEFRAME: "eth-15m", NODE_ENV: "production" },
      error_file: "logs/eth15m-err.log",
      out_file:   "logs/eth15m-out.log",
      merge_logs: true,
      time:       true,
    },
  ],
};
