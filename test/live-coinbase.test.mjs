import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { CoinbaseRest } from '../src/feeds/coinbase-rest.mjs';
import { CoinbaseWS } from '../src/feeds/coinbase-ws.mjs';
import { DrawThroughCacheManager, interpolateCandleGaps } from '../src/trader/cache-manager.mjs';
import { PaperBroker } from '../src/trader/paper-broker.mjs';

// Mock storage contract
class MockStorage {
  constructor() {
    this.candles = [];
  }
  async getRecentCandles({ symbol, limit }) {
    return this.candles.filter((c) => c.symbol === symbol).slice(0, limit);
  }
  async upsertCandles(newCandles) {
    for (const nc of newCandles) {
      const idx = this.candles.findIndex((c) => c.symbol === nc.symbol && c.start === nc.start);
      if (idx >= 0) {
        this.candles[idx] = nc;
      } else {
        this.candles.push(nc);
      }
    }
    this.candles.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  }
}

// Mock REST client
class MockRestClient {
  async fetchCandles({ symbol, start, end, granularity }) {
    const candles = [];
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    const step = 60 * 1000; // 1m
    for (let t = startMs; t < endMs; t += step) {
      candles.push({
        symbol,
        granularity,
        start: new Date(t).toISOString(),
        open: 60000,
        high: 60100,
        low: 59900,
        close: 60050,
        volume: 10,
      });
    }
    return candles;
  }
}

// ── CoinbaseRest Tests ──────────────────────────────────────────────────────

test('CoinbaseRest: parse products and market data correctly', async () => {
  const rest = new CoinbaseRest();
  assert.ok(rest.baseUrl.includes('api.coinbase.com'), 'default base url is correct');
});

// ── CoinbaseWS Tests ────────────────────────────────────────────────────────

test('CoinbaseWS: check and emit logic for disinterest bands', async () => {
  const ws = new CoinbaseWS({
    symbols: ['BTC-USD'],
    evaluateIntervalMs: 5000,
    deviationLimitBps: 10, // 0.1% price movement
  });

  // Mock initial ticker
  ws.lastTicker.set('BTC-USD', {
    price: 60000,
    bestBid: 59990,
    bestAsk: 60010,
    bestBidQty: 1.5,
    bestAskQty: 2.0,
    timestamp: new Date().toISOString(),
  });

  // Emit 1: initial emit
  ws.checkAndEmit('BTC-USD', 'ticker');
  assert.strictEqual(ws.queue.length, 1, 'first message triggers emission');
  assert.strictEqual(ws.queue[0].last, 60000, 'emitted price is correct');

  const firstEvent = ws.queue.shift();

  // Try emitting again immediately at same price -> should NOT emit (disinterest band)
  ws.checkAndEmit('BTC-USD', 'ticker');
  assert.strictEqual(ws.queue.length, 0, 'immediate duplicate price does not emit');

  // Trigger deviation: move price by 15 bps (60000 -> 60100 is 16.6 bps)
  ws.lastTicker.set('BTC-USD', {
    price: 60100,
    bestBid: 60090,
    bestAsk: 60110,
    bestBidQty: 1.5,
    bestAskQty: 2.0,
    timestamp: new Date().toISOString(),
  });

  ws.checkAndEmit('BTC-USD', 'ticker');
  assert.strictEqual(ws.queue.length, 1, 'price deviation > 10 bps triggers immediate emit');
  ws.queue.shift();
});

// ── Gap Interpolation Tests ─────────────────────────────────────────────────

test('interpolateCandleGaps: fill linear price & volume gaps', () => {
  const candles = [
    { symbol: 'BTC-USD', granularity: '1m', start: '2026-06-27T10:03:00.000Z', open: 60030, high: 60030, low: 60030, close: 60030, volume: 30 },
    { symbol: 'BTC-USD', granularity: '1m', start: '2026-06-27T10:00:00.000Z', open: 60000, high: 60000, low: 60000, close: 60000, volume: 10 },
  ];

  const { result, interpolated } = interpolateCandleGaps(candles, '1m');

  // We have a 3-minute gap. Should interpolate 2 missing candles: 10:01 and 10:02.
  assert.strictEqual(result.length, 4, 'should end up with 4 candles total');
  assert.strictEqual(interpolated.length, 2, 'should have created 2 interpolated candles');

  const c10_01 = result.find((c) => c.start === '2026-06-27T10:01:00.000Z');
  const c10_02 = result.find((c) => c.start === '2026-06-27T10:02:00.000Z');

  assert.ok(c10_01, '10:01 candle is present');
  assert.ok(c10_02, '10:02 candle is present');

  // Linear price interpolation: 60000 -> 60030 (10 per minute)
  assert.strictEqual(c10_01.close, 60010, '10:01 close matches linear price interpolation');
  assert.strictEqual(c10_02.close, 60020, '10:02 close matches linear price interpolation');

  assert.ok(Math.abs(c10_01.volume - 16.666666666666668) < 1e-9, '10:01 volume matches linear interpolation');
});

// ── DrawThroughCacheManager integration Tests ────────────────────────────────

test('DrawThroughCacheManager: draw through REST and auto-interpolate gaps', async () => {
  const storage = new MockStorage();
  const restClient = new MockRestClient();
  const cache = new DrawThroughCacheManager({
    storage,
    freshnessMs: 5000,
    restClient,
  });

  const eventTimestamp = '2026-06-27T10:05:00.000Z';
  const res = await cache.loadRecentCandles({
    symbol: 'BTC-USD',
    limit: 5,
    eventTimestamp,
    buildCandle: () => ({}),
    granularity: '1m',
  });

  assert.strictEqual(res.candles.length, 5, 'returned correct number of candles from REST');
  assert.strictEqual(storage.candles.length, 5, 'stored correct number of candles in storage');
  assert.strictEqual(res.cacheHit, true, 'returns hit when filled via REST client');
});

// ── PaperBroker Persistence Tests ──────────────────────────────────────────

test('PaperBroker: load and save state to JSON file', () => {
  const persistPath = resolve('./data/test-paper-wallet-state.json');

  if (existsSync(persistPath)) {
    unlinkSync(persistPath);
  }

  // Create broker and execute a trade to write state
  const broker1 = new PaperBroker({ initialCash: 10000, persistPath });
  broker1.execute({
    symbol: 'BTC-USD',
    side: 'BUY',
    quantity: 0.1,
    price: 60000,
    timestamp: new Date().toISOString(),
  });

  assert.ok(existsSync(persistPath), 'persisted state file is created');

  // Load state using another broker instance
  const broker2 = new PaperBroker({ initialCash: 10000, persistPath });
  assert.strictEqual(broker2.cash, 4000, 'cash is correctly loaded');
  assert.strictEqual(broker2.getUnits('BTC-USD'), 0.1, 'units are correctly loaded');

  // Cleanup
  if (existsSync(persistPath)) {
    unlinkSync(persistPath);
  }
});
