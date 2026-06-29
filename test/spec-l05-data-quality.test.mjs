import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCandle, validateCandleSequence, computeStaleness, stalenessToCacheQuality } from '../src/trader/signals.ts';

// L5: Data Quality Assertions
// Per TODO: Prevent fake alpha from malformed candles

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

test('validateCandle: valid candle passes', () => {
  const candle = {
    symbol: 'BTC-USD',
    open: 50000,
    high: 50100,
    low: 49900,
    close: 50050,
    volume: 100,
  };
  
  const result = validateCandle(candle);
  assert.strictEqual(result.valid, true);
});

test('validateCandle: rejects zero open', () => {
  const candle = {
    symbol: 'BTC-USD',
    open: 0,
    high: 50100,
    low: 49900,
    close: 50050,
    volume: 100,
  };
  
  const result = validateCandle(candle);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('open must be > 0'));
});

test('validateCandle: rejects negative open', () => {
  const candle = {
    symbol: 'BTC-USD',
    open: -100,
    high: 50100,
    low: 49900,
    close: 50050,
    volume: 100,
  };
  
  const result = validateCandle(candle);
  assert.strictEqual(result.valid, false);
});

test('validateCandle: rejects high below max(open,close)', () => {
  const candle = {
    symbol: 'BTC-USD',
    open: 50000,
    high: 50025,  // below close of 50050
    low: 49900,
    close: 50050,
    volume: 100,
  };
  
  const result = validateCandle(candle);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('high')));
});

test('validateCandle: rejects low above min(open,close)', () => {
  const candle = {
    symbol: 'BTC-USD',
    open: 50000,
    high: 50100,
    low: 50025,  // above close of 50050
    close: 50050,
    volume: 100,
  };
  
  const result = validateCandle(candle);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('low')));
});

test('validateCandle: rejects negative volume', () => {
  const candle = {
    symbol: 'BTC-USD',
    open: 50000,
    high: 50100,
    low: 49900,
    close: 50050,
    volume: -10,
  };
  
  const result = validateCandle(candle);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.includes('volume must be >= 0'));
});

test('validateCandleSequence: valid sequence passes', () => {
  const candles = [
    { start: '2026-06-27T12:00:00Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 100 },
    { start: '2026-06-27T12:01:00Z', open: 50050, high: 50100, low: 50000, close: 50075, volume: 100 },
    { start: '2026-06-27T12:02:00Z', open: 50075, high: 50150, low: 50050, close: 50100, volume: 100 },
  ];
  
  const result = validateCandleSequence(candles, 'BTC-USD', '1m');
  assert.strictEqual(result.valid, true);
});

test('validateCandleSequence: rejects non-monotonic timestamps', () => {
  const candles = [
    { start: '2026-06-27T12:02:00Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 100 },
    { start: '2026-06-27T12:01:00Z', open: 50050, high: 50100, low: 50000, close: 50075, volume: 100 },  // out of order
    { start: '2026-06-27T12:03:00Z', open: 50075, high: 50150, low: 50050, close: 50100, volume: 100 },
  ];
  
  const result = validateCandleSequence(candles, 'BTC-USD', '1m');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('timestamp not monotonic')));
});

test('validateCandleSequence: rejects duplicate timestamps', () => {
  const candles = [
    { start: '2026-06-27T12:00:00Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 100 },
    { start: '2026-06-27T12:00:00Z', open: 50050, high: 50100, low: 50000, close: 50075, volume: 100 },  // duplicate
  ];
  
  const result = validateCandleSequence(candles, 'BTC-USD', '1m');
  assert.strictEqual(result.valid, false);
});

test('validateCandleSequence: rejects decreasing timestamps', () => {
  const candles = [
    { start: '2026-06-27T12:03:00Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 100 },
    { start: '2026-06-27T12:02:00Z', open: 50050, high: 50100, low: 50000, close: 50075, volume: 100 },
  ];
  
  const result = validateCandleSequence(candles, 'BTC-USD', '1m');
  assert.strictEqual(result.valid, false);
});

test('computeStaleness: fresh data is not stale', () => {
  const now = Date.now();
  const candles = [
    { start: new Date(now - 30_000).toISOString() },  // 30s ago
  ];
  
  const result = computeStaleness(candles, '1m', now);
  assert.strictEqual(result.stale, false);
  assert.ok(result.staleness < 0.5);
});

test('computeStaleness: data older than 2x granularity is stale', () => {
  const now = Date.now();
  const candles = [
    { start: new Date(now - 180_000).toISOString() },  // 3min ago (> 2min threshold)
  ];
  
  const result = computeStaleness(candles, '1m', now);
  assert.strictEqual(result.stale, true);
});

test('computeStaleness: empty candles are fully stale', () => {
  const result = computeStaleness([], '1m', Date.now());
  assert.strictEqual(result.stale, true);
  assert.strictEqual(result.staleness, 1);
});

test('stalenessToCacheQuality: fresh = 1.0', () => {
  const quality = stalenessToCacheQuality(0);
  assert.strictEqual(quality, 1.0);
});

test('stalenessToCacheQuality: fully stale = 0.1', () => {
  const quality = stalenessToCacheQuality(1);
  assert.strictEqual(quality, 0.1);
});

test('stalenessToCacheQuality: partial staleness decays linearly', () => {
  const quality = stalenessToCacheQuality(0.5);
  assert.strictEqual(quality, 0.55);  // 1 - 0.5*0.9 = 0.55
});
