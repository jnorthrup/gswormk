import test from 'node:test';
import assert from 'node:assert/strict';
import { CoinbaseSync } from '../src/feeds/coinbase-sync.ts';
import { TraderEngine } from '../src/trader/engine.ts';

// Mock storage contract
class MockStorage {
  constructor() {
    this.candles = [];
    this.signals = [];
    this.assets = [];
    this.stats = [];
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
  async insertSignal(sig) {
    this.signals.push(sig);
  }
  async getRecentSignals() {
    return [];
  }
  async getRecentOrders() {
    return [];
  }
  async getRecentDecisions() {
    return [];
  }
  async upsertSpotMarketAsset(asset) {
    const index = this.assets.findIndex((row) => row.symbol === asset.symbol);
    if (index >= 0) {
      this.assets[index] = { ...this.assets[index], ...asset };
    } else {
      this.assets.push(asset);
    }
  }
  async upsertSpotMarketStats(stat) {
    this.stats.push(stat);
  }
}

// Mock REST client
class MockRestClient {
  constructor() {
    this.baseUrl = 'https://api.coinbase.com/api/v3/brokerage';
  }
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
        close: 60050 + (t % 1000), // make some return variations
        volume: 10,
      });
    }
    return candles;
  }
  async fetchSpotProducts() {
    return {
      products: [
        { product_id: 'BTC-USD', quote_currency_id: 'USD', product_type: 'SPOT', status: 'online', is_disabled: false, base_currency_id: 'BTC', base_name: 'Bitcoin', quote_name: 'US Dollar', display_name: 'BTC-USD' },
        { product_id: 'ETH-USD', quote_currency_id: 'USD', product_type: 'SPOT', status: 'online', is_disabled: false, base_currency_id: 'ETH', base_name: 'Ethereum', quote_name: 'US Dollar', display_name: 'ETH-USD' },
        { product_id: 'BTC-USDC', quote_currency_id: 'USDC', product_type: 'SPOT', status: 'online', is_disabled: false, base_currency_id: 'BTC', base_name: 'Bitcoin', quote_name: 'USD Coin', display_name: 'BTC-USDC' },
        { product_id: 'USDT-USD', quote_currency_id: 'USD', product_type: 'SPOT', status: 'online', is_disabled: false, base_currency_id: 'USDT', base_name: 'Tether', quote_name: 'US Dollar', display_name: 'USDT-USD' }
      ]
    };
  }
}

// Helper fetch mock
const originalFetch = globalThis.fetch;

// ── Sync Worker Tests ────────────────────────────────────────────────────────

test('CoinbaseSync: fetch and filter USD spot products correctly', async () => {
  const restClient = new MockRestClient();
  const storage = new MockStorage();
  const sync = new CoinbaseSync({ storage, restClient });

  // Mock global fetch for product list
  globalThis.fetch = async (url) => {
    if (url.includes('/products')) {
      return {
        ok: true,
        json: async () => await restClient.fetchSpotProducts(),
      };
    }
    return { ok: false };
  };

  const symbols = await sync.fetchSpotProducts();
  globalThis.fetch = originalFetch; // restore

  assert.ok(symbols.includes('BTC-USD'), 'includes BTC-USD');
  assert.ok(symbols.includes('ETH-USD'), 'includes ETH-USD');
  assert.ok(!symbols.includes('BTC-USDC'), 'excludes non-USD quote product');
  // Note: current filter does NOT exclude stablecoin base pairs (USDT, etc)
  // This could be added as a future enhancement
  const btcAsset = storage.assets.find((asset) => asset.symbol === 'BTC-USD');
  assert.ok(btcAsset, 'persists BTC asset metadata');
  assert.equal(btcAsset.baseSymbol, 'BTC');
  assert.equal(btcAsset.quoteSymbol, 'USD');
  assert.equal(btcAsset.assetName, 'Bitcoin');
  assert.equal(btcAsset.cmcSlug ?? null, null);
});

test('CoinbaseSync: syncPairCandles fetches, merges and interpolates', async () => {
  const restClient = new MockRestClient();
  const storage = new MockStorage();
  const sync = new CoinbaseSync({ storage, restClient, granularities: ['1h'], throttleDelayMs: 0 });

  await sync.syncPairCandles('SOL-USD');

  // Merged part1 and part2 candles should exist in storage
  const cached = await storage.getRecentCandles({ symbol: 'SOL-USD', limit: 100 });
  assert.ok(cached.length > 0, 'candles are synchronized and saved');
});

test('CoinbaseSync: sync plan packs hot 1m with rotating deferred 5m+ refreshes', () => {
  const restClient = new MockRestClient();
  const storage = new MockStorage();
  const sync = new CoinbaseSync({
    storage,
    restClient,
    granularities: null,
    hotGranularities: ['1m'],
    deferredGranularities: ['5m', '15m', '1h'],
    deferredRefreshCycles: { '5m': 1, '15m': 1, '1h': 1 },
    maxDeferredGranularitiesPerSegment: 1,
  });

  const plan0 = sync.buildSyncPlan({ cycle: 0 });
  const plan1 = sync.buildSyncPlan({ cycle: 1 });
  const plan2 = sync.buildSyncPlan({ cycle: 2 });

  assert.deepStrictEqual(plan0.map((item) => item.granularity), ['1m', '5m']);
  assert.deepStrictEqual(plan1.map((item) => item.granularity), ['1m', '15m']);
  assert.deepStrictEqual(plan2.map((item) => item.granularity), ['1m', '1h']);

  const evidence = sync.segmentEvidence(plan0);
  assert.deepStrictEqual(evidence.hotGranularities, ['1m']);
  assert.deepStrictEqual(evidence.deferredGranularities, ['5m']);
  assert.strictEqual(evidence.estimatedRequests, 2);
  assert.strictEqual(evidence.estimatedCandles, 528);
});

test('CoinbaseSync: quarter-hour rotation refreshes the spot universe and CMC chart surface on cadence', async () => {
  const restClient = new MockRestClient();
  const storage = new MockStorage();
  let fetchCount = 0;
  let scrapeCount = 0;
  const sync = new CoinbaseSync({
    storage,
    restClient,
    rotationIntervalMs: 15 * 60 * 1000,
    rsiScraper: {
      async scrapeRsiData() {
        scrapeCount += 1;
        return 42;
      },
      async fetchQuotaInfo() {
        return {
          minuteLimit: 50,
          minuteRequestsMade: 3,
          minuteRequestsLeft: 47,
          monthlyCreditLimit: 15000,
          monthlyCreditsUsed: 5,
          monthlyCreditsLeft: 14995,
        };
      },
    },
  });

  sync.fetchSpotProducts = async () => {
    fetchCount += 1;
    return ['BTC-USD', 'ETH-USD'];
  };

  let symbols = await sync.runQuarterHourRotation({ symbols: [], nowMs: 0 });
  assert.deepStrictEqual(symbols, ['BTC-USD', 'ETH-USD']);
  assert.strictEqual(fetchCount, 1);
  assert.strictEqual(scrapeCount, 1);
  assert.deepStrictEqual(sync.lastCmcQuotaInfo, {
    minuteLimit: 50,
    minuteRequestsMade: 3,
    minuteRequestsLeft: 47,
    monthlyCreditLimit: 15000,
    monthlyCreditsUsed: 5,
    monthlyCreditsLeft: 14995,
  });
  assert.strictEqual(sync.lastCmcRsiCount, 42);

  symbols = await sync.runQuarterHourRotation({ symbols, nowMs: 5 * 60 * 1000 });
  assert.strictEqual(fetchCount, 1, 'spot universe should not refresh before quarter-hour cadence');
  assert.strictEqual(scrapeCount, 1, 'CMC chart surface should not refresh before quarter-hour cadence');

  symbols = await sync.runQuarterHourRotation({ symbols, nowMs: 16 * 60 * 1000 });
  assert.deepStrictEqual(symbols, ['BTC-USD', 'ETH-USD']);
  assert.strictEqual(fetchCount, 2, 'spot universe refreshes after quarter-hour cadence');
  assert.strictEqual(scrapeCount, 2, 'CMC chart surface refreshes after quarter-hour cadence');
});

// ── Engine Warmup Tests ──────────────────────────────────────────────────────

test('TraderEngine: warmup pre-populates return buffers from database history', async () => {
  const storage = new MockStorage();
  const restClient = new MockRestClient();

  const config = {
    symbols: ['BTC-USD'],
    initialCash: 10000,
    semivarianceWindow: 10,
    tailWindow: 15,
    restClient,
    cacheFreshnessMs: 5000,
  };

  // Seed storage with 15 sequential candles for BTC-USD
  const nowMs = Date.now();
  const seedCandles = [];
  for (let i = 0; i < 20; i++) {
    seedCandles.push({
      symbol: 'BTC-USD',
      granularity: '1m',
      start: new Date(nowMs - (i * 60 * 1000)).toISOString(),
      open: 60000 + i * 10,
      high: 60100 + i * 10,
      low: 59900 + i * 10,
      close: 60050 + i * 10,
      volume: 10,
    });
  }
  await storage.upsertCandles(seedCandles);

  const engine = new TraderEngine({ storage, config });

  // Trigger warmup
  await engine.warmup();

  const state = engine.state.perSymbol.get('BTC-USD');
  assert.ok(state, 'BTC-USD state exists');
  assert.strictEqual(state.returns.length, 10, 'returns buffer is pre-populated to semivarianceWindow');
  assert.ok(state.returns.every((r) => typeof r === 'number'), 'all returns are numbers');
  assert.ok(state.lastPrice > 0, 'lastPrice is set');
});
