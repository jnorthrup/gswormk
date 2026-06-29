import test from 'node:test';
import assert from 'node:assert/strict';
import { MS, GRANULARITIES, requireGranularity, granularityMs, granularityMinutes, granularityEnum, candleCountBetween } from '../src/lib/time.ts';
import { GRANULARITY_MAP } from '../src/feeds/coinbase-rest.ts';

// DRY guard: time.mjs is the single source of truth for time constants.
// These tests assert the invariant so future agent passes can't silently
// re-introduce duplicate granularity tables.

// ─────────────────────────────────────────────────────────────────────────────
// Base constants
// ─────────────────────────────────────────────────────────────────────────────

test('MS constants are derived consistently', () => {
  assert.strictEqual(MS.SECOND, 1_000);
  assert.strictEqual(MS.MINUTE, 60 * MS.SECOND);
  assert.strictEqual(MS.HOUR, 60 * MS.MINUTE);
  assert.strictEqual(MS.DAY, 24 * MS.HOUR);
  assert.strictEqual(MS.WEEK, 7 * MS.DAY);
});

// ─────────────────────────────────────────────────────────────────────────────
// Granularity lookups
// ─────────────────────────────────────────────────────────────────────────────

test('requireGranularity: returns definition for known granularity', () => {
  const g = requireGranularity('1m');
  assert.strictEqual(g.enum, 'ONE_MINUTE');
  assert.strictEqual(g.seconds, 60);
});

test('requireGranularity: throws on unknown granularity', () => {
  assert.throws(() => requireGranularity('3m'), /Unknown granularity/);
});

test('granularityMs / granularityMinutes / granularityEnum: basic lookups', () => {
  assert.strictEqual(granularityMs('1m'), 60_000);
  assert.strictEqual(granularityMs('5m'), 300_000);
  assert.strictEqual(granularityMs('15m'), 900_000);
  assert.strictEqual(granularityMs('1h'), 3_600_000);
  assert.strictEqual(granularityMs('1d'), 86_400_000);

  assert.strictEqual(granularityMinutes('1m'), 1);
  assert.strictEqual(granularityMinutes('5m'), 5);
  assert.strictEqual(granularityMinutes('1h'), 60);
  assert.strictEqual(granularityMinutes('1d'), 1440);

  assert.strictEqual(granularityEnum('1m'), 'ONE_MINUTE');
  assert.strictEqual(granularityEnum('1d'), 'ONE_DAY');
});

test('candleCountBetween: counts candles in a span', () => {
  const oneDay = MS.DAY;
  assert.strictEqual(candleCountBetween('1m', 0, oneDay), 1440);
  assert.strictEqual(candleCountBetween('5m', 0, oneDay), 288);
  assert.strictEqual(candleCountBetween('1h', 0, oneDay), 24);
  assert.strictEqual(candleCountBetween('1d', 0, oneDay), 1);
});

test('candleCountBetween: returns 0 for non-positive span', () => {
  assert.strictEqual(candleCountBetween('1m', 1000, 1000), 0);
  assert.strictEqual(candleCountBetween('1m', 1000, 500), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// DRY invariant: coinbase-rest GRANULARITY_MAP must equal time.mjs GRANULARITIES
// ─────────────────────────────────────────────────────────────────────────────

test('DRY invariant: GRANULARITY_MAP in coinbase-rest.mjs matches time.mjs exactly', () => {
  // Every key in GRANULARITY_MAP must be in GRANULARITIES with matching seconds + enum
  for (const [key, val] of Object.entries(GRANULARITY_MAP)) {
    assert.ok(key in GRANULARITIES, `granularity ${key} missing from time.mjs GRANULARITIES`);
    assert.strictEqual(val.seconds, GRANULARITIES[key].seconds, `${key} seconds mismatch`);
    assert.strictEqual(val.enum, GRANULARITIES[key].enum, `${key} enum mismatch`);
  }
  // And vice versa — time.mjs must not define granularities the REST client doesn't know
  for (const key of Object.keys(GRANULARITIES)) {
    assert.ok(key in GRANULARITY_MAP, `granularity ${key} in time.mjs but missing from coinbase-rest GRANULARITY_MAP`);
  }
});
