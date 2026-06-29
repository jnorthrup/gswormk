import test from 'node:test';
import assert from 'node:assert/strict';
import { planBackfillWindows, computeBackfillDateRange, estimateCandleCount } from '../src/trader/backfill.ts';

// L5: Historical Backfill Command (per TODO build order item 3)
// Needed for walk-forward validation

// ─────────────────────────────────────────────────────────────────────────────
// Date range computation
// ─────────────────────────────────────────────────────────────────────────────

test('computeBackfillDateRange: produces ISO strings for full window', () => {
  const refMs = Date.parse('2026-06-27T12:00:00Z');
  const range = computeBackfillDateRange({ days: 30, referenceMs: refMs });
  
  assert.strictEqual(range.startMs, refMs - (30 * 86_400_000));
  assert.strictEqual(range.endMs, refMs);
  assert.ok(new Date(range.startIso).toISOString() === range.startIso);
  assert.ok(new Date(range.endIso).toISOString() === range.endIso);
});

test('computeBackfillDateRange: rounds end to top of minute', () => {
  const refMs = Date.parse('2026-06-27T12:00:37.500Z');
  const range = computeBackfillDateRange({ days: 7, referenceMs: refMs });
  
  // End should be at 12:00:00.000 (rounded down to minute)
  const endMs = Date.parse(range.endIso);
  assert.strictEqual(endMs % 60_000, 0);
});

test('computeBackfillDateRange: handles fractional days', () => {
  const refMs = Date.parse('2026-06-27T12:00:00Z');
  const range = computeBackfillDateRange({ days: 1.5, referenceMs: refMs });
  
  const expectedStart = refMs - (1.5 * 86_400_000);
  // Allow 1 minute tolerance for rounding
  assert.ok(Math.abs(range.startMs - expectedStart) <= 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Window planning (chunked backfill)
// ─────────────────────────────────────────────────────────────────────────────

test('planBackfillWindows: chunks a range into 24h windows', () => {
  const refMs = Date.parse('2026-06-27T12:00:00Z');
  const range = computeBackfillDateRange({ days: 3, referenceMs: refMs });
  const windows = planBackfillWindows({ range, chunkHours: 24 });
  
  assert.strictEqual(windows.length, 3);
  for (const window of windows) {
    assert.ok(window.endMs > window.startMs);
    assert.ok(window.endMs - window.startMs <= 24 * 3600_000 + 60_000);  // 24h + 1m tolerance
  }
});

test('planBackfillWindows: smaller chunks produce more windows', () => {
  const refMs = Date.parse('2026-06-27T12:00:00Z');
  const range = computeBackfillDateRange({ days: 1, referenceMs: refMs });
  
  const sixHours = planBackfillWindows({ range, chunkHours: 6 });
  const oneHour = planBackfillWindows({ range, chunkHours: 1 });
  
  assert.ok(sixHours.length < oneHour.length);
  assert.strictEqual(sixHours.length, 4);  // 24 / 6 = 4
  assert.strictEqual(oneHour.length, 24);
});

test('planBackfillWindows: windows cover full range without gaps', () => {
  const refMs = Date.parse('2026-06-27T12:00:00Z');
  const range = computeBackfillDateRange({ days: 2, referenceMs: refMs });
  const windows = planBackfillWindows({ range, chunkHours: 6 });
  
  // First window starts at range.startMs
  assert.strictEqual(windows[0].startMs, range.startMs);
  
  // Each window's start equals previous window's end
  for (let i = 1; i < windows.length; i++) {
    assert.strictEqual(windows[i].startMs, windows[i - 1].endMs);
  }
  
  // Last window ends at range.endMs
  assert.strictEqual(windows.at(-1).endMs, range.endMs);
});

// ─────────────────────────────────────────────────────────────────────────────
// Candle count estimation
// ─────────────────────────────────────────────────────────────────────────────

test('estimateCandleCount: 1m granularity = 1440 candles per day', () => {
  const count = estimateCandleCount({ granularity: '1m', hours: 24 });
  assert.strictEqual(count, 1440);
});

test('estimateCandleCount: 5m granularity = 288 candles per day', () => {
  const count = estimateCandleCount({ granularity: '5m', hours: 24 });
  assert.strictEqual(count, 288);
});

test('estimateCandleCount: 1h granularity = 24 candles per day', () => {
  const count = estimateCandleCount({ granularity: '1h', hours: 24 });
  assert.strictEqual(count, 24);
});

test('estimateCandleCount: scales linearly with hours', () => {
  const oneDay = estimateCandleCount({ granularity: '1m', hours: 24 });
  const oneWeek = estimateCandleCount({ granularity: '1m', hours: 168 });
  assert.strictEqual(oneWeek, oneDay * 7);
});
