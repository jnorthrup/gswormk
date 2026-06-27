import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRSI } from '../src/feeds/coinbase-sync.mjs';

// Mock storage for sync stats verification
class MockStorage {
  constructor() {
    this.candles = [];
    this.stats = [];
  }
  async getRecentCandles({ symbol, limit, granularity }) {
    return this.candles
      .filter((c) => c.symbol === symbol && c.granularity === granularity)
      .slice(0, limit);
  }
  async upsertCandles(newCandles) {
    for (const nc of newCandles) {
      this.candles.push(nc);
    }
  }
  async upsertSpotMarketStats(stat) {
    this.stats.push(stat);
  }
}

// ── RSI Utility Tests ────────────────────────────────────────────────────────

test('computeRSI: basic Wilder RSI calculation', () => {
  // Generate 15 candles with flat close of 100 -> closes count = 15, returns null or 100
  const flatCandles = [];
  for (let i = 0; i < 15; i++) {
    flatCandles.push({
      start: new Date(Date.now() - i * 60000).toISOString(),
      close: 100,
    });
  }

  // Not enough changes or flat
  const rsiFlat = computeRSI(flatCandles, 14);
  assert.strictEqual(rsiFlat, 100, 'flat price series results in rsi = 100 (avg loss = 0)');

  // Alternating series: 100, 110, 100, 110...
  const altCandles = [];
  for (let i = 0; i < 20; i++) {
    altCandles.push({
      start: new Date(Date.now() - i * 60000).toISOString(),
      close: i % 2 === 0 ? 100 : 110,
    });
  }

  const rsiAlt = computeRSI(altCandles, 14);
  assert.ok(rsiAlt > 0 && rsiAlt < 100, 'alternating price series returns a valid RSI strictly between 0 and 100');
});

test('computeRSI: insufficient data returns null', () => {
  const shortCandles = [{ start: new Date().toISOString(), close: 100 }];
  const rsi = computeRSI(shortCandles, 14);
  assert.strictEqual(rsi, null, 'less than 14 elements returns null');
});
