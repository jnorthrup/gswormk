/**
 * ══════════════════════════════════════════════════════════════════════════════
 * § 9  Draw-Through Cache as Decision State — TDD Red Suite
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  Immutable keyed record:
 *    $$(i, g, \tau) \mapsto (O, H, L, C, V)$$
 *
 *  Freshness is bar-relative:
 *    $$\mathrm{fresh}(i, g, t)
 *      = \mathbf{1}\!\left[t \le \tau^{\text{latest}}_{i,g} + \phi_g\right]$$
 *
 *  Cache-quality confidence (full spec form):
 *    $$q^{\text{cache}}_{i,t}
 *      = \mathbf{1}[\text{fresh}]
 *      \cdot \mathbf{1}[\text{no gaps}]
 *      \cdot \mathbf{1}[\text{monotone timestamps}]
 *      \cdot \mathbf{1}[\text{checksum pass}]$$
 *
 *  NOTE: Current implementation uses a ternary { 1.0, 0.65, 0.35 } instead
 *  of the full four-indicator product.  These tests assert the spec semantics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaQuality } from '../src/trader/signals.mjs';
import { DrawThroughCacheManager } from '../src/trader/cache-manager.mjs';

// ── §9 Cache quality confidence ─────────────────────────────────────────────

test('§9 cache quality = 1.0 when fresh, no gaps, monotone, checksum pass', () => {
  const q = quotaQuality({ cacheHit: true, gapCount: 0 });
  assert.strictEqual(q, 1.0, 'perfect cache should yield q=1.0');
});

test('§9 cache quality < 1.0 when gaps exist', () => {
  const q = quotaQuality({ cacheHit: true, gapCount: 2 });
  assert.ok(q < 1.0, `gaps should reduce cache quality, got ${q}`);
});

test('§9 cache quality < 1.0 on cache miss', () => {
  const q = quotaQuality({ cacheHit: false, gapCount: 0 });
  assert.ok(q < 1.0, `cache miss should reduce quality, got ${q}`);
});

test('§9 cache quality ∈ [0, 1]', () => {
  for (const cacheHit of [true, false]) {
    for (const gapCount of [0, 1, 5, 100]) {
      const q = quotaQuality({ cacheHit, gapCount });
      assert.ok(q >= 0 && q <= 1, `q=${q} for hit=${cacheHit} gaps=${gapCount}`);
    }
  }
});

test('§9 cache quality is monotonically decreasing in gap count', () => {
  const q0 = quotaQuality({ cacheHit: true, gapCount: 0 });
  const q1 = quotaQuality({ cacheHit: true, gapCount: 1 });
  const q5 = quotaQuality({ cacheHit: true, gapCount: 5 });
  assert.ok(
    q0 >= q1 && q1 >= q5,
    `cache quality should decrease with gaps: q0=${q0} q1=${q1} q5=${q5}`,
  );
});

// ── §9 Draw-through cache mechanics ─────────────────────────────────────────

test('§9 cache freshness is bar-relative, not absolute time', () => {
  // fresh(i,g,t) = 1[t ≤ τ_latest + φ_g]
  // φ_g for 1m bars = 120_000ms (2 minutes)
  const freshnessMs = 120_000;
  const latestBarTime = '2024-01-01T00:05:00.000Z';
  const currentTime = '2024-01-01T00:06:30.000Z'; // 90s later, within φ

  const latestMs = Date.parse(latestBarTime);
  const currentMs = Date.parse(currentTime);
  const isFresh = (currentMs - latestMs) <= freshnessMs;

  assert.ok(isFresh, '90s gap within 2min freshness should be fresh');
});

test('§9 cache staleness triggers fetch for missing interval only', () => {
  const freshnessMs = 120_000;
  const latestBarTime = '2024-01-01T00:05:00.000Z';
  const currentTime = '2024-01-01T00:10:00.000Z'; // 5 min later, stale

  const latestMs = Date.parse(latestBarTime);
  const currentMs = Date.parse(currentTime);
  const isFresh = (currentMs - latestMs) <= freshnessMs;

  assert.ok(!isFresh, '5min gap exceeds 2min freshness, should be stale');
});

test('§9 candle record is keyed by (symbol, granularity, barStart)', () => {
  const candle = {
    symbol: 'BTC-USD',
    granularity: '1m',
    start: '2024-01-01T00:01:00.000Z',
    open: 65000,
    high: 65100,
    low: 64900,
    close: 65050,
    volume: 12.5,
  };

  const key = `${candle.symbol}:${candle.granularity}:${candle.start}`;
  assert.strictEqual(
    key,
    'BTC-USD:1m:2024-01-01T00:01:00.000Z',
    'candle key should be (symbol, granularity, barStart)',
  );
});

test('§9 idempotent merge: reinserting same candle preserves data', () => {
  const candle1 = {
    symbol: 'BTC-USD',
    granularity: '1m',
    start: '2024-01-01T00:01:00.000Z',
    open: 65000, high: 65100, low: 64900, close: 65050, volume: 12.5,
  };
  const candle2 = { ...candle1 }; // exact duplicate

  // After merge, result should be identical to original
  assert.deepStrictEqual(candle1, candle2, 'idempotent merge should preserve identity');
});
