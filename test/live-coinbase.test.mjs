import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { CoinbaseRest } from '../src/feeds/coinbase-rest.ts';
import { CoinbaseWS } from '../src/feeds/coinbase-ws.ts';
import { DrawThroughCacheManager, interpolateCandleGaps } from '../src/trader/cache-manager.ts';
import { PaperBroker } from '../src/trader/paper-broker.ts';

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

test('CoinbaseRest: request quota evidence reports tps and tpm', () => {
  const rest = new CoinbaseRest({ requestTpsWarn: 10, requestTpmWarn: 600 });
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);

  try {
    const first = rest.recordRequest({ endpoint: 'candles', symbol: 'BTC-USD', now: 1000 });
    const second = rest.recordRequest({ endpoint: 'candles', symbol: 'ETH-USD', now: 2000 });

    assert.strictEqual(first.requestCount, 1);
    assert.ok(Math.abs(first.tps - (1 / 60)) < 1e-12);
    assert.ok(Math.abs(first.tpm - 1) < 1e-12);
    assert.strictEqual(second.requestCount, 2);
    assert.strictEqual(second.tps, 2);
    assert.strictEqual(second.tpm, 120);
    assert.ok(warnings.every((line) => line.includes('tps=') && line.includes('tpm=')));
  } finally {
    console.warn = originalWarn;
  }
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

test('CoinbaseWS: bandwidth throttling trims websocket level2 subscriptions without REST polling', () => {
  let restCalls = 0;
  const ws = new CoinbaseWS({
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD'],
    maxLevel2Subscriptions: 4,
    initialLevel2Subscriptions: 4,
    trafficHighWatermark: 100,
    restClient: {
      async fetchProductBook() {
        restCalls += 1;
        throw new Error('REST book polling must not be used by websocket throttling');
      },
    },
  });

  const sent = [];
  ws.ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };

  ws.setLevel2Subscriptions(['BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD']);
  const result = ws.adjustLevel2SubscriptionsForRate(150);

  assert.strictEqual(result, 'reduced');
  assert.strictEqual(restCalls, 0, 'traffic throttling must not poll the REST book endpoint');
  assert.ok(ws.activeLevel2Symbols.size < 4, 'active L2 websocket coverage is reduced');
  assert.ok(sent.some((msg) => msg.type === 'unsubscribe' && msg.channel === 'level2'));
});

test('CoinbaseWS: bootstraps broad ticker coverage with minimum depth funnel before quota discovery', () => {
  const ws = new CoinbaseWS({
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD'],
    maxLevel2Subscriptions: 4,
  });
  const funnels = ws.subscriptionFunnels();

  assert.strictEqual(ws.targetLevel2Subscriptions, 1);
  assert.deepStrictEqual(funnels.ticker, ['BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD']);
  assert.strictEqual(funnels.level2.length, 1);
  assert.strictEqual(funnels.tickerOnly.length, 3);
});

test('CoinbaseWS: quota evidence reports message and emitted tick tps/tpm', () => {
  const ws = new CoinbaseWS({ symbols: ['BTC-USD'] });
  const evidence = ws.quotaEvidence({
    elapsed: 10,
    messages: 50,
    emittedEvents: 5,
    channelCounts: new Map([
      ['ticker', 20],
      ['l2_data', 30],
    ]),
  });
  const formatted = ws.formatQuotaEvidence(evidence);

  assert.strictEqual(evidence.messageTps, 5);
  assert.strictEqual(evidence.messageTpm, 300);
  assert.strictEqual(evidence.tickTps, 0.5);
  assert.strictEqual(evidence.tickTpm, 30);
  assert.strictEqual(evidence.channelTps.ticker, 2);
  assert.strictEqual(evidence.channelTps.l2_data, 3);
  assert.ok(formatted.includes('msgTps=5.00'));
  assert.ok(formatted.includes('msgTpm=300.0'));
  assert.ok(formatted.includes('tickTps=0.50'));
  assert.ok(formatted.includes('tickTpm=30.0'));
  assert.ok(formatted.includes('ticker:2.00tps'));
  assert.ok(formatted.includes('l2_data:3.00tps'));
});

test('CoinbaseWS: discovered quota routes depth subscriptions into highest-interest funnel', () => {
  const ws = new CoinbaseWS({
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD', 'ADA-USD'],
    maxLevel2Subscriptions: 5,
    initialLevel2Subscriptions: 5,
    trafficHighWatermark: 10,
    quotaUtilizationTarget: 0.8,
  });

  const sent = [];
  ws.ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };

  const now = Date.now();
  ws.recordLevel2Interest('BTC-USD', 30, now);
  ws.recordLevel2Interest('ETH-USD', 10, now);
  ws.recordLevel2Interest('SOL-USD', 50, now);
  ws.recordLevel2Interest('DOGE-USD', 90, now);
  ws.recordLevel2Interest('ADA-USD', 5, now);
  ws.setLevel2Subscriptions(['BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD', 'ADA-USD']);

  const evidence = ws.quotaEvidence({
    elapsed: 10,
    messages: 100,
    emittedEvents: 12,
    channelCounts: new Map([
      ['ticker', 20],
      ['l2_data', 80],
    ]),
  });
  const result = ws.adjustLevel2SubscriptionsForRate(evidence.messageTps, evidence);

  assert.strictEqual(result, 'reduced');
  assert.strictEqual(ws.targetLevel2Subscriptions, 3);
  assert.deepStrictEqual(new Set(ws.currentSubscriptionFunnels.level2), new Set(['DOGE-USD', 'SOL-USD', 'BTC-USD']));
  assert.deepStrictEqual(new Set(ws.currentSubscriptionFunnels.tickerOnly), new Set(['ETH-USD', 'ADA-USD']));
  assert.ok(sent.some((msg) => msg.type === 'unsubscribe' && msg.channel === 'level2'));
});

test('CoinbaseWS: discovered spare quota expands depth funnel coverage', () => {
  const ws = new CoinbaseWS({
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD', 'ADA-USD'],
    maxLevel2Subscriptions: 5,
    trafficHighWatermark: 20,
    trafficLowWatermark: 5,
    quotaUtilizationTarget: 0.8,
  });

  ws.ws = {
    readyState: 1,
    send() {},
  };

  ws.targetLevel2Subscriptions = 2;
  ws.setLevel2Subscriptions(['BTC-USD', 'ETH-USD']);

  const evidence = ws.quotaEvidence({
    elapsed: 10,
    messages: 30,
    emittedEvents: 8,
    channelCounts: new Map([
      ['ticker', 10],
      ['l2_data', 20],
    ]),
  });
  const result = ws.adjustLevel2SubscriptionsForRate(evidence.messageTps, evidence);

  assert.strictEqual(result, 'expanded');
  assert.strictEqual(ws.targetLevel2Subscriptions, 5);
  assert.strictEqual(ws.currentSubscriptionFunnels.level2.length, 5);
  assert.strictEqual(ws.currentSubscriptionFunnels.tickerOnly.length, 0);
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

test('interpolateCandleGaps: uses min/max/mean aggregate price anchors when present', () => {
  const candles = [
    {
      symbol: 'BTC-USD',
      granularity: '1m',
      start: '2026-06-27T10:02:00.000Z',
      open: 130,
      close: 160,
      priceMin: 120,
      priceMax: 180,
      priceMean: 150,
      volume: 30,
    },
    {
      symbol: 'BTC-USD',
      granularity: '1m',
      start: '2026-06-27T10:00:00.000Z',
      open: 100,
      close: 100,
      priceMin: 90,
      priceMax: 110,
      priceMean: 100,
      volume: 10,
    },
  ];

  const { interpolated } = interpolateCandleGaps(candles, '1m');

  assert.strictEqual(interpolated.length, 1);
  assert.strictEqual(interpolated[0].start, '2026-06-27T10:01:00.000Z');
  assert.strictEqual(interpolated[0].open, 130);
  assert.strictEqual(interpolated[0].low, 105);
  assert.strictEqual(interpolated[0].high, 145);
  assert.strictEqual(interpolated[0].close, 125);
  assert.strictEqual(interpolated[0].volume, 20);
});

// ── DrawThroughCacheManager integration Tests ────────────────────────────────

test('DrawThroughCacheManager: draw through REST and auto-interpolate gaps', async () => {
  const storage = new MockStorage();
  const restClient = new MockRestClient();
  const cache = new DrawThroughCacheManager({
    storage,
    freshnessMs: 5000,
    restClient,
    allowRestFetch: true,
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

test('DrawThroughCacheManager: live cache miss draws through tick candle without REST by default', async () => {
  const storage = new MockStorage();
  let restCalls = 0;
  const cache = new DrawThroughCacheManager({
    storage,
    freshnessMs: 5000,
    restClient: {
      async fetchCandles() {
        restCalls += 1;
        throw new Error('REST candle fetch must be explicit');
      },
    },
  });

  const eventTimestamp = '2026-06-27T10:05:00.000Z';
  const tickCandle = {
    symbol: 'BTC-USD',
    granularity: '1m',
    start: eventTimestamp,
    open: 60000,
    high: 60000,
    low: 60000,
    close: 60000,
    volume: 1,
  };

  const res = await cache.loadRecentCandles({
    symbol: 'BTC-USD',
    limit: 5,
    eventTimestamp,
    buildCandle: () => tickCandle,
    granularity: '1m',
  });

  assert.strictEqual(restCalls, 0, 'REST is not called on default cache miss');
  assert.strictEqual(res.cacheHit, false);
  assert.deepStrictEqual(res.candles[0], tickCandle);
  assert.deepStrictEqual(storage.candles[0], tickCandle);
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
