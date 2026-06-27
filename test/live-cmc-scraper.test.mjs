import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/storage/index.mjs';
import { computeRsiSplatAndKalman } from '../src/trader/signals.mjs';
import { CoinMarketCapScraper } from '../src/feeds/coinmarketcap-scraper.mjs';
import { TraderEngine } from '../src/trader/engine.mjs';

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
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
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
