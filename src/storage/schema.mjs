export const schema = {
  candles: `
    CREATE TABLE IF NOT EXISTS candles (
      symbol TEXT NOT NULL,
      granularity TEXT NOT NULL,
      start TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      PRIMARY KEY (symbol, granularity, start)
    )
  `,
  signals: `
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      mid REAL NOT NULL,
      spread REAL NOT NULL,
      effective_cost REAL NOT NULL,
      obi REAL NOT NULL,
      innovation_z REAL NOT NULL,
      rv_down REAL NOT NULL,
      tail_dependence REAL NOT NULL,
      alignment REAL NOT NULL,
      cache_quality REAL NOT NULL,
      effective_drift REAL NOT NULL,
      target_weight REAL NOT NULL,
      current_weight REAL NOT NULL,
      trigger REAL NOT NULL,
      drawdown REAL NOT NULL,
      quota_hit INTEGER NOT NULL,
      regime_momentum REAL NOT NULL DEFAULT 0,
      regime_mean_reversion REAL NOT NULL DEFAULT 0,
      regime_volatility REAL NOT NULL DEFAULT 0,
      risk_state TEXT NOT NULL DEFAULT 'OK',
      dominant_regime TEXT NOT NULL DEFAULT 'meanReversion'
    )
  `,
  orders: `
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      gross REAL NOT NULL,
      remaining_cash REAL NOT NULL,
      remaining_units REAL NOT NULL
    )
  `,
  quotaMetrics: `
    CREATE TABLE IF NOT EXISTS quota_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      cache_hits INTEGER NOT NULL,
      api_calls INTEGER NOT NULL,
      gap_count INTEGER NOT NULL,
      cache_hit_ratio REAL NOT NULL
    )
  `,
  decisions: `
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      target_weight REAL NOT NULL,
      current_weight REAL NOT NULL,
      deviation REAL NOT NULL,
      trigger REAL NOT NULL,
      notional_delta REAL NOT NULL,
      executed INTEGER NOT NULL,
      reason TEXT NOT NULL
    )
  `,
  portfolioSnapshots: `
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      nav REAL NOT NULL,
      cash REAL NOT NULL,
      peak_nav REAL NOT NULL,
      drawdown REAL NOT NULL
    )
  `,
  positions: `
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      units REAL NOT NULL,
      price REAL NOT NULL,
      market_value REAL NOT NULL,
      weight REAL NOT NULL
    )
  `,
  spotMarketStats: `
    CREATE TABLE IF NOT EXISTS spot_market_stats (
      symbol TEXT NOT NULL,
      price REAL,
      change_24h REAL,
      rsi_1d REAL,
      rsi_1h REAL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (symbol, updated_at)
    )
  `,
};

export const migrations = {
  signalColumns: [
    `ALTER TABLE signals ADD COLUMN regime_momentum REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE signals ADD COLUMN regime_mean_reversion REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE signals ADD COLUMN regime_volatility REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE signals ADD COLUMN risk_state TEXT NOT NULL DEFAULT 'OK'`,
    `ALTER TABLE signals ADD COLUMN dominant_regime TEXT NOT NULL DEFAULT 'meanReversion'`,
  ],
};