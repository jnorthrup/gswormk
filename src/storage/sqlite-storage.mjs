import { DatabaseSync } from 'node:sqlite';
import { migrations, schema } from './schema.mjs';

export class SQLiteStorage {
  constructor({ path }) {
    this.path = path;
    this.db = null;
  }

  async init() {
    this.db = new DatabaseSync(this.path);
    this.db.exec(schema.candles);
    this.db.exec(schema.signals);
    this.db.exec(schema.orders);
    this.db.exec(schema.quotaMetrics);
    this.db.exec(schema.decisions);
    this.db.exec(schema.portfolioSnapshots);
    this.db.exec(schema.positions);
    for (const statement of migrations.signalColumns) {
      try {
        this.db.exec(statement);
      } catch (error) {
        if (!String(error.message).includes('duplicate column name')) {
          throw error;
        }
      }
    }
  }

  async close() {
    this.db?.close();
  }

  async upsertCandles(candles) {
    const statement = this.db.prepare(`
      INSERT INTO candles (symbol, granularity, start, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, granularity, start)
      DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume
    `);

    for (const candle of candles) {
      statement.run(
        candle.symbol,
        candle.granularity,
        candle.start,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
      );
    }
  }

  async getRecentCandles({ symbol, limit }) {
    const statement = this.db.prepare(`
      SELECT symbol, granularity, start, open, high, low, close, volume
      FROM candles
      WHERE symbol = ?
      ORDER BY start DESC
      LIMIT ?
    `);
    return statement.all(symbol, limit);
  }

  async insertSignal(signal) {
    const statement = this.db.prepare(`
      INSERT INTO signals (
        timestamp, symbol, mid, spread, effective_cost, obi, innovation_z, rv_down,
        tail_dependence, alignment, cache_quality, effective_drift, target_weight,
        current_weight, trigger, drawdown, quota_hit, regime_momentum,
        regime_mean_reversion, regime_volatility, risk_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    statement.run(
      signal.timestamp,
      signal.symbol,
      signal.mid,
      signal.spread,
      signal.effectiveCost,
      signal.obi,
      signal.innovationZ,
      signal.rvDown,
      signal.tailDependence,
      signal.alignment,
      signal.cacheQuality,
      signal.effectiveDrift,
      signal.targetWeight,
      signal.currentWeight,
      signal.trigger,
      signal.drawdown,
      signal.quotaHit,
      signal.regimeMomentum,
      signal.regimeMeanReversion,
      signal.regimeVolatility,
      signal.riskState,
    );
  }

  async insertOrder(order) {
    const statement = this.db.prepare(`
      INSERT INTO orders (timestamp, symbol, side, quantity, price, gross, remaining_cash, remaining_units)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    statement.run(
      order.timestamp,
      order.symbol,
      order.side,
      order.quantity,
      order.price,
      order.gross,
      order.remainingCash,
      order.remainingUnits,
    );
  }

  async insertQuotaMetric(metric) {
    const statement = this.db.prepare(`
      INSERT INTO quota_metrics (timestamp, symbol, cache_hits, api_calls, gap_count, cache_hit_ratio)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    statement.run(
      metric.timestamp,
      metric.symbol,
      metric.cacheHits,
      metric.apiCalls,
      metric.gapCount,
      metric.cacheHitRatio,
    );
  }

  async getRecentSignals({ limit }) {
    return this.db.prepare('SELECT * FROM signals ORDER BY id DESC LIMIT ?').all(limit);
  }

  async insertDecision(decision) {
    const statement = this.db.prepare(`
      INSERT INTO decisions (timestamp, symbol, target_weight, current_weight, deviation, trigger, notional_delta, executed, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    statement.run(
      decision.timestamp,
      decision.symbol,
      decision.targetWeight,
      decision.currentWeight,
      decision.deviation,
      decision.trigger,
      decision.notionalDelta,
      decision.executed ? 1 : 0,
      decision.reason,
    );
  }

  async insertPortfolioSnapshot(snapshot) {
    this.db.prepare(`
      INSERT INTO portfolio_snapshots (timestamp, nav, cash, peak_nav, drawdown)
      VALUES (?, ?, ?, ?, ?)
    `).run(snapshot.timestamp, snapshot.nav, snapshot.cash, snapshot.peakNav, snapshot.drawdown);

    this.db.prepare('DELETE FROM positions WHERE timestamp = ?').run(snapshot.timestamp);
    const statement = this.db.prepare(`
      INSERT INTO positions (timestamp, symbol, units, price, market_value, weight)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const position of snapshot.positions) {
      statement.run(snapshot.timestamp, position.symbol, position.units, position.price, position.marketValue, position.weight);
    }
  }

  async getRecentOrders({ limit }) {
    return this.db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?').all(limit);
  }

  async getRecentDecisions({ limit }) {
    return this.db.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT ?').all(limit);
  }

  async getLatestPortfolioSnapshot() {
    return this.db.prepare('SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT 1').get();
  }

  async getLatestPositions() {
    const latest = await this.getLatestPortfolioSnapshot();
    if (!latest) return [];
    return this.db.prepare('SELECT * FROM positions WHERE timestamp = ? ORDER BY market_value DESC').all(latest.timestamp);
  }

  async getLatestQuotaSummary() {
    return this.db.prepare(`
      SELECT
        MAX(cache_hits) AS cacheHits,
        MAX(api_calls) AS apiCalls,
        MAX(gap_count) AS gapCount,
        MAX(cache_hit_ratio) AS cacheHitRatio
      FROM quota_metrics
    `).get();
  }

  async getStatusSnapshot() {
    const candleCount = this.db.prepare('SELECT COUNT(*) AS count FROM candles').get().count;
    const signalCount = this.db.prepare('SELECT COUNT(*) AS count FROM signals').get().count;
    const orderCount = this.db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
    const decisionCount = this.db.prepare('SELECT COUNT(*) AS count FROM decisions').get().count;
    const portfolioSnapshotCount = this.db.prepare('SELECT COUNT(*) AS count FROM portfolio_snapshots').get().count;
    const latestSignals = await this.getRecentSignals({ limit: 5 });
    const latestOrders = await this.getRecentOrders({ limit: 5 });
    const latestDecisions = await this.getRecentDecisions({ limit: 5 });
    const latestQuota = this.db.prepare('SELECT * FROM quota_metrics ORDER BY id DESC LIMIT 5').all();
    const latestPortfolio = await this.getLatestPortfolioSnapshot();
    const latestPositions = await this.getLatestPositions();
    const latestQuotaSummary = await this.getLatestQuotaSummary();

    return {
      db: { kind: 'sqlite', path: this.path },
      counts: { candleCount, signalCount, orderCount, decisionCount, portfolioSnapshotCount },
      latestSignals,
      latestOrders,
      latestDecisions,
      latestQuota,
      latestPortfolio,
      latestPositions,
      latestQuotaSummary,
    };
  }
}