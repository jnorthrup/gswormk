import { schema } from './schema.mjs';

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

  async getRecentCandles({ symbol, limit }) {
    return this.all(`SELECT * FROM candles WHERE symbol='${escapeSql(symbol)}' ORDER BY start DESC LIMIT ${Number(limit)}`);
  }

  async insertSignal(signal) {
    await this.exec(`
      INSERT INTO signals (
        timestamp, symbol, mid, spread, effective_cost, obi, innovation_z, rv_down,
        tail_dependence, alignment, cache_quality, effective_drift, target_weight,
        current_weight, trigger, drawdown, quota_hit
      ) VALUES (
        '${escapeSql(signal.timestamp)}', '${escapeSql(signal.symbol)}', ${signal.mid}, ${signal.spread}, ${signal.effectiveCost}, ${signal.obi},
        ${signal.innovationZ}, ${signal.rvDown}, ${signal.tailDependence}, ${signal.alignment}, ${signal.cacheQuality},
        ${signal.effectiveDrift}, ${signal.targetWeight}, ${signal.currentWeight}, ${signal.trigger}, ${signal.drawdown}, ${signal.quotaHit}
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

  async getRecentSignals({ limit }) {
    return this.all(`SELECT * FROM signals ORDER BY id DESC LIMIT ${Number(limit)}`);
  }

  async getRecentOrders({ limit }) {
    return this.all(`SELECT * FROM orders ORDER BY id DESC LIMIT ${Number(limit)}`);
  }

  async getStatusSnapshot() {
    const candleCount = (await this.all('SELECT COUNT(*) AS count FROM candles'))[0]?.count ?? 0;
    const signalCount = (await this.all('SELECT COUNT(*) AS count FROM signals'))[0]?.count ?? 0;
    const orderCount = (await this.all('SELECT COUNT(*) AS count FROM orders'))[0]?.count ?? 0;
    return {
      db: { kind: 'duckdb', path: this.path },
      counts: { candleCount, signalCount, orderCount },
      latestSignals: await this.getRecentSignals({ limit: 5 }),
      latestOrders: await this.getRecentOrders({ limit: 5 }),
      latestQuota: await this.all('SELECT * FROM quota_metrics ORDER BY id DESC LIMIT 5'),
    };
  }
}

function escapeSql(value) {
  return String(value).replaceAll("'", "''");
}