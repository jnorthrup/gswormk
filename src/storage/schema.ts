// DuckDB-native schema with sequences defined BEFORE tables reference them via nextval()
const duckdbSchema = {
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
    CREATE SEQUENCE IF NOT EXISTS signals_seq START 1;
    CREATE TABLE IF NOT EXISTS signals (
      id BIGINT DEFAULT nextval('signals_seq') PRIMARY KEY,
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
      timescale_support_count INTEGER NOT NULL DEFAULT 0,
      timescale_window_center INTEGER NOT NULL DEFAULT 1,
      timescale_attention REAL NOT NULL DEFAULT 1,
      timescale_time_dilation REAL NOT NULL DEFAULT 1,
      denoised_rsi REAL,
      rsi_innovation_z REAL NOT NULL DEFAULT 0,
      confidence_scalers REAL NOT NULL DEFAULT 1,
      advantage_probability REAL NOT NULL DEFAULT 0.5,
      risk_state TEXT,
      dominant_regime TEXT NOT NULL DEFAULT 'meanReversion',
      archetype TEXT,
      gross_edge_bps REAL,
      cost_bps REAL,
      uncertainty_bps REAL,
      net_edge_bps REAL
    )
  `,
  orders: `
    CREATE SEQUENCE IF NOT EXISTS orders_seq START 1;
    CREATE TABLE IF NOT EXISTS orders (
      id BIGINT DEFAULT nextval('orders_seq') PRIMARY KEY,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      gross REAL NOT NULL,
      remaining_cash REAL NOT NULL,
      remaining_units REAL NOT NULL,
      gross_edge_bps REAL,
      cost_bps REAL,
      uncertainty_bps REAL,
      net_edge_bps REAL,
      archetype TEXT
    );
  `,
  quotaMetrics: `
    CREATE SEQUENCE IF NOT EXISTS quota_metrics_seq START 1;
    CREATE TABLE IF NOT EXISTS quota_metrics (
      id BIGINT DEFAULT nextval('quota_metrics_seq') PRIMARY KEY,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      cache_hits INTEGER NOT NULL,
      api_calls INTEGER NOT NULL,
      gap_count INTEGER NOT NULL,
      cache_hit_ratio REAL NOT NULL
    );
  `,
  decisions: `
    CREATE SEQUENCE IF NOT EXISTS decisions_seq START 1;
    CREATE TABLE IF NOT EXISTS decisions (
      id BIGINT DEFAULT nextval('decisions_seq') PRIMARY KEY,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      target_weight REAL NOT NULL,
      current_weight REAL NOT NULL,
      deviation REAL NOT NULL,
      trigger REAL NOT NULL,
      notional_delta REAL NOT NULL,
      executed INTEGER NOT NULL,
      reason TEXT NOT NULL
    );
  `,
  portfolioSnapshots: `
    CREATE SEQUENCE IF NOT EXISTS portfolio_snapshots_seq START 1;
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id BIGINT DEFAULT nextval('portfolio_snapshots_seq') PRIMARY KEY,
      timestamp TEXT NOT NULL,
      nav REAL NOT NULL,
      cash REAL NOT NULL,
      peak_nav REAL NOT NULL,
      drawdown REAL NOT NULL
    );
  `,
  positions: `
    CREATE SEQUENCE IF NOT EXISTS positions_seq START 1;
    CREATE TABLE IF NOT EXISTS positions (
      id BIGINT DEFAULT nextval('positions_seq') PRIMARY KEY,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      units REAL NOT NULL,
      price REAL NOT NULL,
      market_value REAL NOT NULL,
      weight REAL NOT NULL
    );
  `,
  spotMarketStats: `
    CREATE TABLE IF NOT EXISTS spot_market_stats (
      symbol TEXT PRIMARY KEY,
      price REAL NOT NULL,
      change_24h REAL NOT NULL,
      rsi_1d REAL,
      rsi_1h REAL,
      updated_at TEXT NOT NULL
    )
  `,
  spotMarketAssets: `
    CREATE TABLE IF NOT EXISTS spot_market_assets (
      symbol TEXT PRIMARY KEY,
      base_symbol TEXT NOT NULL,
      quote_symbol TEXT NOT NULL,
      asset_name TEXT,
      base_name TEXT,
      quote_name TEXT,
      display_name TEXT,
      cmc_asset_id TEXT,
      cmc_symbol TEXT,
      cmc_name TEXT,
      cmc_slug TEXT,
      cmc_rsi_url TEXT,
      cmc_main_page_url TEXT,
      updated_at TEXT NOT NULL
    )
  `,
  // Walk-forward backtest results
  backtestRuns: `
    CREATE SEQUENCE IF NOT EXISTS backtest_runs_seq START 1;
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id BIGINT DEFAULT nextval('backtest_runs_seq') PRIMARY KEY,
      timestamp TEXT NOT NULL,
      strategy_name TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      sharpe_ratio REAL NOT NULL,
      calmar_ratio REAL NOT NULL,
      max_drawdown REAL NOT NULL,
      total_return REAL NOT NULL,
      hit_rate REAL NOT NULL,
      num_trades INTEGER NOT NULL,
      params TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
} as const;

export const schema = duckdbSchema;

export const migrations = {
  signalColumns: [
    'ALTER TABLE signals ADD COLUMN archetype TEXT',
    'ALTER TABLE signals ADD COLUMN gross_edge_bps REAL',
    'ALTER TABLE signals ADD COLUMN cost_bps REAL',
    'ALTER TABLE signals ADD COLUMN uncertainty_bps REAL',
    'ALTER TABLE signals ADD COLUMN net_edge_bps REAL',
    'ALTER TABLE orders ADD COLUMN gross_edge_bps REAL',
    'ALTER TABLE orders ADD COLUMN cost_bps REAL',
    'ALTER TABLE orders ADD COLUMN uncertainty_bps REAL',
    'ALTER TABLE orders ADD COLUMN net_edge_bps REAL',
    'ALTER TABLE orders ADD COLUMN archetype TEXT',
  ],
} as const;
