import test from 'node:test';
import assert from 'node:assert/strict';
import { CoinbaseSync } from '../src/feeds/coinbase-sync.mjs';
import { TraderEngine } from '../src/trader/engine.mjs';

// Mock storage contract
class MockStorage {
  constructor() {
    this.candles = [];
    this.signals = [];
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
        { product_id: 'BTC-USD', quote_currency_id: 'USD', product_type: 'SPOT', status: 'online', is_disabled: false, base_currency_id: 'BTC' },
        { product_id: 'ETH-USD', quote_currency_id: 'USD', product_type: 'SPOT', status: 'online', is_disabled: false, base_currency_id: 'ETH' },
        { product_id: 'BTC-USDC', quote_currency_id: 'USDC', product_type: 'SPOT', status: 'online', is_disabled: false, base_currency_id: 'BTC' },
        { product_id: 'USDT-USD', quote_currency_id: 'USD', product_type: 'SPOT', status: 'online', is_disabled: false, base_currency_id: 'USDT' }
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
  assert.ok(!symbols.includes('USDT-USD'), 'excludes stablecoin base pair (USDT)');
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
