import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/storage/index.ts';
import { computeRsiSplatAndKalman } from '../src/trader/signals.ts';
import { CoinMarketCapScraper } from '../src/feeds/coinmarketcap-scraper.ts';
import { TraderEngine } from '../src/trader/engine.ts';

// ── Signals/Splatting Tests ──────────────────────────────────────────────────

test('computeRsiSplatAndKalman: empty history returns null', () => {
  const res = computeRsiSplatAndKalman({
    statsHistory: [],
    targetTimestamp: '2026-06-27T12:00:00Z',
    sigmaSeconds: 3600,
  });
  assert.strictEqual(res.rsi, null);
});

test('computeRsiSplatAndKalman: applies Gaussian weights properly', () => {
  const now = new Date('2026-06-27T12:00:00Z');
  // Two measurements: one exactly on target with RSI 60, one 1 hour ago with RSI 40
  const statsHistory = [
    { updatedAt: '2026-06-27T12:00:00Z', rsi1d: 60, rsi1h: null },
    { updatedAt: '2026-06-27T11:00:00Z', rsi1d: 40, rsi1h: null },
  ];

  // Using a 1-hour sigma (3600 seconds)
  // Weight of target (diff = 0) is 1.0
  // Weight of 1-hour-ago (diff = 1 sigma) is exp(-0.5) = 0.6065
  // Weighted RSI = (60 * 1.0 + 40 * 0.6065) / (1.0 + 0.6065)
  // Weighted RSI = (60 + 24.26) / 1.6065 = 52.45
  // Kalman filter will process this splatted value. With q=0.1, r=1, x=50, p=10:
  // PredictedX = 50, PredictedP = 10.1
  // Gain = 10.1 / (10.1 + 1) = 0.9099
  // nextX = 50 + 0.9099 * (52.45 - 50) = 52.23
  
  const res = computeRsiSplatAndKalman({
    statsHistory,
    targetTimestamp: '2026-06-27T12:00:00Z',
    sigmaSeconds: 3600,
    kalmanState: { x: 50, p: 10 },
    q: 0.1,
    r: 1.0,
  });

  assert.ok(res.rsi > 51 && res.rsi < 53);
  assert.ok(res.innovationZ !== undefined);
});

// ── Scraper integration with SQLite ─────────────────────────────────────

test('TraderEngine: getDenoisedRsi draw-through', async () => {
  const storage = await createStorage({ kind: 'duckdb', path: ':memory:' });
  await storage.init();
  
  // Set up engine with config
  const engine = new TraderEngine({
    storage,
    config: {
      initialCash: 10000,
      paperWalletPath: null,
      kalmanQ: 0.1,
      kalmanR: 1.0,
      annualizationFactor: 365,
    },
  });

  // Seed mock spot market stats in storage to prevent scraper network call during test
  const testTime1 = '2026-06-27T11:00:00Z';
  const testTime2 = '2026-06-27T12:00:00Z';
  await storage.upsertSpotMarketStats({
    symbol: 'BTC-USD',
    price: 60000,
    change24h: 1.5,
    rsi1d: 65,
    rsi1h: 62,
    updatedAt: testTime1,
  });
  await storage.upsertSpotMarketStats({
    symbol: 'BTC-USD',
    price: 60500,
    change24h: 2.0,
    rsi1d: 70,
    rsi1h: 68,
    updatedAt: testTime2,
  });

  const denoisedRsi = await engine.getDenoisedRsi({
    symbol: 'BTC-USD',
    timestamp: '2026-06-27T12:15:00Z',
  });

  assert.ok(denoisedRsi.rsi > 60 && denoisedRsi.rsi < 75);
  assert.ok(denoisedRsi.innovation !== null);

  await storage.close();
});

test('SQLite storage: spot market asset refs preserve names and CMC chart links', async () => {
  const storage = await createStorage({ kind: 'duckdb', path: ':memory:' });
  await storage.init();

  await storage.upsertSpotMarketAsset({
    symbol: 'BTC-USD',
    baseSymbol: 'BTC',
    quoteSymbol: 'USD',
    assetName: 'Bitcoin',
    baseName: 'Bitcoin',
    quoteName: 'US Dollar',
    displayName: 'BTC-USD',
    updatedAt: '2026-06-27T12:00:00Z',
  });

  await storage.upsertSpotMarketAsset({
    symbol: 'BTC-USD',
    baseSymbol: 'BTC',
    quoteSymbol: 'USD',
    cmcAssetId: '1',
    cmcSymbol: 'BTC',
    cmcName: 'Bitcoin',
    cmcSlug: 'bitcoin',
    cmcRsiUrl: 'https://coinmarketcap.com/charts/rsi/',
    cmcMainPageUrl: 'https://coinmarketcap.com/currencies/bitcoin/',
    updatedAt: '2026-06-27T12:05:00Z',
  });

  const asset = await storage.getSpotMarketAsset({ symbol: 'BTC-USD' });
  assert.deepStrictEqual(asset, {
    symbol: 'BTC-USD',
    baseSymbol: 'BTC',
    quoteSymbol: 'USD',
    assetName: 'Bitcoin',
    baseName: 'Bitcoin',
    quoteName: 'US Dollar',
    displayName: 'BTC-USD',
    cmcAssetId: '1',
    cmcSymbol: 'BTC',
    cmcName: 'Bitcoin',
    cmcSlug: 'bitcoin',
    cmcRsiUrl: 'https://coinmarketcap.com/charts/rsi/',
    cmcMainPageUrl: 'https://coinmarketcap.com/currencies/bitcoin/',
    updatedAt: '2026-06-27T12:05:00Z',
  });

  await storage.close();
});

test('CoinMarketCapScraper: direct API mode persists CMC chart refs without browser fallback', async () => {
  const assets = [];
  const stats = [];
  const scraper = new CoinMarketCapScraper({
    storage: {
      async upsertSpotMarketAsset(asset) {
        assets.push(asset);
      },
      async upsertSpotMarketStats(stat) {
        stats.push(stat);
      },
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          data: {
            data: [
              {
                id: '1',
                symbol: 'BTC',
                slug: 'bitcoin',
                name: 'Bitcoin',
                price: 60000,
                price24h: 1.5,
                rsi: {
                  rsi1h: 61,
                  rsi24h: 66,
                },
              },
            ],
            pagination: {
              totalPages: 1,
            },
          },
        };
      },
    }),
    browserLauncher: async () => {
      throw new Error('browser fallback should not run');
    },
  });

  const count = await scraper.scrapeRsiData();

  assert.strictEqual(count, 1);
  assert.strictEqual(assets.length, 1);
  assert.strictEqual(stats.length, 1);
  assert.strictEqual(assets[0].cmcMainPageUrl, 'https://coinmarketcap.com/currencies/bitcoin/');
  assert.strictEqual(assets[0].cmcRsiUrl, 'https://coinmarketcap.com/charts/rsi/');
  assert.strictEqual(stats[0].symbol, 'BTC-USD');
  assert.strictEqual(stats[0].rsi1d, 66);
  assert.strictEqual(stats[0].rsi1h, 61);
});

test('CoinMarketCapScraper: fetchQuotaInfo parses current plan and usage from key info', async () => {
  const scraper = new CoinMarketCapScraper({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          data: {
            plan: {
              rate_limit_minute: 50,
              credit_limit_monthly: 15000,
              credit_limit_monthly_reset: 'In 3 days',
              credit_limit_monthly_reset_timestamp: '2026-07-01T00:00:00.000Z',
            },
            usage: {
              current_minute: {
                requests_made: 7,
                requests_left: 43,
              },
              current_month: {
                credits_used: 12,
                credits_left: 14988,
              },
            },
          },
        };
      },
    }),
  });

  const quota = await scraper.fetchQuotaInfo();

  assert.deepStrictEqual(quota, {
    minuteLimit: 50,
    minuteRequestsMade: 7,
    minuteRequestsLeft: 43,
    monthlyCreditLimit: 15000,
    monthlyCreditsUsed: 12,
    monthlyCreditsLeft: 14988,
    monthlyResetText: 'In 3 days',
    monthlyResetTimestamp: '2026-07-01T00:00:00.000Z',
  });
});
