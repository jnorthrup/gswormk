import test from 'node:test';
import assert from 'node:assert/strict';
import { runWalkForwardReplay, renderWalkForwardReport } from '../src/trader/walkforward.ts';

class ReplayStorage {
  constructor(candles) {
    this.candles = candles;
    this.signals = [];
    this.orders = [];
    this.decisions = [];
    this.quotaMetrics = [];
    this.portfolioSnapshots = [];
  }

  async getCandlesInRange({ symbol, start, end, granularity }) {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    return this.candles
      .filter((candle) => candle.symbol === symbol && (!granularity || candle.granularity === granularity))
      .filter((candle) => Date.parse(candle.start) >= startMs && Date.parse(candle.start) < endMs)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  async getRecentCandles({ symbol, limit, granularity }) {
    return this.candles
      .filter((candle) => candle.symbol === symbol && (!granularity || candle.granularity === granularity))
      .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
      .slice(0, limit);
  }

  async upsertCandles(candles) {
    this.candles.push(...candles);
  }

  async insertSignal(signal) {
    this.signals.push(signal);
  }

  async insertOrder(order) {
    this.orders.push(order);
  }

  async insertDecision(decision) {
    this.decisions.push(decision);
  }

  async insertQuotaMetric(metric) {
    this.quotaMetrics.push(metric);
  }

  async insertPortfolioSnapshot(snapshot) {
    this.portfolioSnapshots.push(snapshot);
  }

  async getRecentSpotMarketStats() {
    return [];
  }
}

function makeCandles({ symbol = 'BTC-USD', count = 18, start = '2026-06-01T00:00:00.000Z', granularity = '1h' } = {}) {
  const candles = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const timestamp = new Date(Date.parse(start) + index * 3_600_000).toISOString();
    const drift = index % 3 === 0 ? 1.8 : (index % 3 === 1 ? -0.4 : 1.2);
    const open = close;
    close = Math.max(1, close + drift);
    candles.push({
      symbol,
      granularity,
      start: timestamp,
      open,
      high: Math.max(open, close) + 0.2,
      low: Math.min(open, close) - 0.2,
      close,
      volume: 10 + index,
    });
  }
  return candles;
}

test('runWalkForwardReplay replays test candles through the real engine path and reports edge metrics', async () => {
  const storage = new ReplayStorage(makeCandles());

  const result = await runWalkForwardReplay({
    storage,
    symbols: ['BTC-USD'],
    granularity: '1h',
    trainStart: '2026-06-01T00:00:00.000Z',
    trainEnd: '2026-06-01T12:00:00.000Z',
    testEnd: '2026-06-01T18:00:00.000Z',
    initialCash: 10_000,
    semivarianceWindow: 4,
  });

  assert.strictEqual(result.folds.length, 1);
  assert.strictEqual(result.folds[0].symbols.join(','), 'BTC-USD');
  assert.ok(result.folds[0].trainCandles > 0);
  assert.ok(result.folds[0].testCandles > 0);
  assert.ok(result.folds[0].signals > 0, 'replay should create real persisted signals');
  assert.ok(result.folds[0].decisions > 0, 'replay should create real persisted decisions');
  assert.strictEqual(result.folds[0].ordersAccepted + result.folds[0].ordersRejected, result.folds[0].decisions);
  assert.ok(Number.isFinite(result.folds[0].avgNetEdgeBps), 'replay should aggregate real signal net edge');
  assert.ok(result.totals.decisions > 0);

  const report = renderWalkForwardReport(result);
  assert.match(report, /folds=1/);
  assert.match(report, /decisions=/);
  assert.match(report, /avgNetEdgeBps=/);
  assert.doesNotMatch(report, /not fully implemented/i);
});
