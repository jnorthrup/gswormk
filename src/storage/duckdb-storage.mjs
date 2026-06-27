import { migrations, schema } from './schema.mjs';

export class DuckDbStorage {
  constructor({ path }) {
    this.path = path;
    this.db = null;
    this.connection = null;
  }

  async init() {
    let duckdb;
    try {
      duckdb = await import('duckdb');
    } catch {
      throw new Error('DuckDB backend requested but the "duckdb" package is not installed. Run: npm install duckdb');
    }

    this.db = new duckdb.Database(this.path);
    this.connection = this.db.connect();
    await this.exec(schema.candles);
    await this.exec(schema.signals.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY'));
    await this.exec(schema.orders.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY'));
    await this.exec(schema.quotaMetrics.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY'));
    await this.exec(schema.decisions.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY'));
    await this.exec(schema.portfolioSnapshots.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY'));
    await this.exec(schema.positions.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY'));
    await this.exec(schema.spotMarketStats);
    for (const statement of migrations.signalColumns) {
      try {
        await this.exec(statement);
      } catch (error) {
        if (!String(error.message).toLowerCase().includes('column with name') && !String(error.message).toLowerCase().includes('duplicate')) {
          throw error;
        }
      }
    }
  }

  async close() {
    if (this.connection) {
      await new Promise((resolve, reject) => this.connection.close((error) => (error ? reject(error) : resolve())));
    }
  }

  async exec(sql) {
    await new Promise((resolve, reject) => this.connection.run(sql, (error) => (error ? reject(error) : resolve())));
  }

  async all(sql, params = []) {
    return new Promise((resolve, reject) => this.connection.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))));
  }

  async upsertCandles(candles) {
    for (const candle of candles) {
      await this.exec(`DELETE FROM candles WHERE symbol='${escapeSql(candle.symbol)}' AND granularity='${escapeSql(candle.granularity)}' AND start='${escapeSql(candle.start)}'`);
      await this.exec(`
        INSERT INTO candles (symbol, granularity, start, open, high, low, close, volume)
        VALUES ('${escapeSql(candle.symbol)}', '${escapeSql(candle.granularity)}', '${escapeSql(candle.start)}', ${candle.open}, ${candle.high}, ${candle.low}, ${candle.close}, ${candle.volume})
      `);
    }
  }

  async getRecentCandles({ symbol, limit, granularity }) {
    if (granularity) {
      return this.all(`SELECT * FROM candles WHERE symbol='${escapeSql(symbol)}' AND granularity='${escapeSql(granularity)}' ORDER BY start DESC LIMIT ${Number(limit)}`);
    }
    return this.all(`SELECT * FROM candles WHERE symbol='${escapeSql(symbol)}' ORDER BY start DESC LIMIT ${Number(limit)}`);
  }

  async insertSignal(signal) {
    await this.exec(`
      INSERT INTO signals (
        timestamp, symbol, mid, spread, effective_cost, obi, innovation_z, rv_down,
        tail_dependence, alignment, cache_quality, effective_drift, target_weight,
        current_weight, trigger, drawdown, quota_hit, regime_momentum,
        regime_mean_reversion, regime_volatility, risk_state
      ) VALUES (
        '${escapeSql(signal.timestamp)}', '${escapeSql(signal.symbol)}', ${signal.mid}, ${signal.spread}, ${signal.effectiveCost}, ${signal.obi},
        ${signal.innovationZ}, ${signal.rvDown}, ${signal.tailDependence}, ${signal.alignment}, ${signal.cacheQuality},
        ${signal.effectiveDrift}, ${signal.targetWeight}, ${signal.currentWeight}, ${signal.trigger}, ${signal.drawdown}, ${signal.quotaHit},
        ${signal.regimeMomentum}, ${signal.regimeMeanReversion}, ${signal.regimeVolatility}, '${escapeSql(signal.riskState)}'
      )
    `);
  }

  async insertOrder(order) {
    await this.exec(`
      INSERT INTO orders (timestamp, symbol, side, quantity, price, gross, remaining_cash, remaining_units)
      VALUES ('${escapeSql(order.timestamp)}', '${escapeSql(order.symbol)}', '${escapeSql(order.side)}', ${order.quantity}, ${order.price}, ${order.gross}, ${order.remainingCash}, ${order.remainingUnits})
    `);
  }

  async insertQuotaMetric(metric) {
    await this.exec(`
      INSERT INTO quota_metrics (timestamp, symbol, cache_hits, api_calls, gap_count, cache_hit_ratio)
      VALUES ('${escapeSql(metric.timestamp)}', '${escapeSql(metric.symbol)}', ${metric.cacheHits}, ${metric.apiCalls}, ${metric.gapCount}, ${metric.cacheHitRatio})
    `);
  }

  async insertDecision(decision) {
    await this.exec(`
      INSERT INTO decisions (timestamp, symbol, target_weight, current_weight, deviation, trigger, notional_delta, executed, reason)
      VALUES ('${escapeSql(decision.timestamp)}', '${escapeSql(decision.symbol)}', ${decision.targetWeight}, ${decision.currentWeight}, ${decision.deviation}, ${decision.trigger}, ${decision.notionalDelta}, ${decision.executed ? 1 : 0}, '${escapeSql(decision.reason)}')
    `);
  }

  async insertPortfolioSnapshot(snapshot) {
    await this.exec(`
      INSERT INTO portfolio_snapshots (timestamp, nav, cash, peak_nav, drawdown)
      VALUES ('${escapeSql(snapshot.timestamp)}', ${snapshot.nav}, ${snapshot.cash}, ${snapshot.peakNav}, ${snapshot.drawdown})
    `);
    await this.exec(`DELETE FROM positions WHERE timestamp='${escapeSql(snapshot.timestamp)}'`);
    for (const position of snapshot.positions) {
      await this.exec(`
        INSERT INTO positions (timestamp, symbol, units, price, market_value, weight)
        VALUES ('${escapeSql(snapshot.timestamp)}', '${escapeSql(position.symbol)}', ${position.units}, ${position.price}, ${position.marketValue}, ${position.weight})
      `);
    }
  }

  async getRecentSignals({ limit }) {
    return this.all(`SELECT * FROM signals ORDER BY id DESC LIMIT ${Number(limit)}`);
  }

  async getRecentOrders({ limit }) {
    return this.all(`SELECT * FROM orders ORDER BY id DESC LIMIT ${Number(limit)}`);
  }

  async getRecentDecisions({ limit }) {
    return this.all(`SELECT * FROM decisions ORDER BY id DESC LIMIT ${Number(limit)}`);
  }

  async getLatestPortfolioSnapshot() {
    return (await this.all('SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT 1'))[0] ?? null;
  }

  async getLatestPositions() {
    const latest = await this.getLatestPortfolioSnapshot();
    if (!latest) return [];
    return this.all(`SELECT * FROM positions WHERE timestamp='${escapeSql(latest.timestamp)}' ORDER BY market_value DESC`);
  }

  async getLatestQuotaSummary() {
    return (await this.all(`
      SELECT
        MAX(cache_hits) AS cacheHits,
        MAX(api_calls) AS apiCalls,
        MAX(gap_count) AS gapCount,
        MAX(cache_hit_ratio) AS cacheHitRatio
      FROM quota_metrics
    `))[0] ?? null;
  }

  async getStatusSnapshot() {
    const candleCount = (await this.all('SELECT COUNT(*) AS count FROM candles'))[0]?.count ?? 0;
    const signalCount = (await this.all('SELECT COUNT(*) AS count FROM signals'))[0]?.count ?? 0;
    const orderCount = (await this.all('SELECT COUNT(*) AS count FROM orders'))[0]?.count ?? 0;
    const decisionCount = (await this.all('SELECT COUNT(*) AS count FROM decisions'))[0]?.count ?? 0;
    const portfolioSnapshotCount = (await this.all('SELECT COUNT(*) AS count FROM portfolio_snapshots'))[0]?.count ?? 0;
    return {
      db: { kind: 'duckdb', path: this.path },
      counts: { candleCount, signalCount, orderCount, decisionCount, portfolioSnapshotCount },
      latestSignals: await this.getRecentSignals({ limit: 5 }),
      latestOrders: await this.getRecentOrders({ limit: 5 }),
      latestDecisions: await this.getRecentDecisions({ limit: 5 }),
      latestQuota: await this.all('SELECT * FROM quota_metrics ORDER BY id DESC LIMIT 5'),
      latestPortfolio: await this.getLatestPortfolioSnapshot(),
      latestPositions: await this.getLatestPositions(),
      latestQuotaSummary: await this.getLatestQuotaSummary(),
    };
  }

  async upsertSpotMarketStats(stat) {
    await this.exec(`DELETE FROM spot_market_stats WHERE symbol='${escapeSql(stat.symbol)}' AND updated_at='${escapeSql(stat.updatedAt)}'`);
    await this.exec(`
      INSERT INTO spot_market_stats (symbol, price, change_24h, rsi_1d, rsi_1h, updated_at)
      VALUES (
        '${escapeSql(stat.symbol)}',
        ${stat.price},
        ${stat.change24h},
        ${stat.rsi1d !== null ? stat.rsi1d : 'NULL'},
        ${stat.rsi1h !== null ? stat.rsi1h : 'NULL'},
        '${escapeSql(stat.updatedAt)}'
      )
    `);
  }

  async getRecentSpotMarketStats({ symbol, limit }) {
    const rows = await this.all(`
      SELECT symbol, price, change_24h, rsi_1d, rsi_1h, updated_at
      FROM spot_market_stats
      WHERE symbol='${escapeSql(symbol)}'
      ORDER BY updated_at DESC
      LIMIT ${Number(limit)}
    `);
    return rows.map((r) => ({
      symbol: r.symbol,
      price: r.price,
      change24h: r.change_24h,
      rsi1d: r.rsi_1d,
      rsi1h: r.rsi_1h,
      updatedAt: r.updated_at,
    }));
  }

  async getSpotMarketStats() {
    return this.all('SELECT * FROM spot_market_stats ORDER BY symbol ASC');
  }
}

function escapeSql(value) {
  return String(value).replaceAll("'", "''");
}