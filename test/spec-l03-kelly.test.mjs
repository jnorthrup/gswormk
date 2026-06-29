import test from 'node:test';
import assert from 'node:assert/strict';
import { induceKellySafe } from '../src/trader/kelly.ts';

// L3: Kelly variance-floor guard (TODO item 3)
// kelly = netEdge / (downsideVariance + modelVariance + parameterVariance)
// Gate: if rvDown is floor-derived AND samples thin → treat as unknown risk.

test('induceKellySafe: normal variance + positive edge → positive kelly', () => {
  const kelly = induceKellySafe({
    netEdge: 0.01,        // 100 bps net edge
    rvDown: 0.04,         // healthy variance (above floor)
    sampleCount: 200,
    minRiskSamples: 50,
    varianceFloor: 1e-9,
  });
  assert.ok(kelly > 0);
  assert.ok(Number.isFinite(kelly));
});

test('induceKellySafe: floored variance + thin samples → kelly zeroed (unknown risk)', () => {
  const kelly = induceKellySafe({
    netEdge: 0.01,
    rvDown: 1e-9,         // at floor
    sampleCount: 5,       // thin
    minRiskSamples: 50,
    varianceFloor: 1e-9,
  });
  assert.strictEqual(kelly, 0);  // unknown risk → no bet
});

test('induceKellySafe: floored variance + sufficient samples → still discounted', () => {
  const kelly = induceKellySafe({
    netEdge: 0.01,
    rvDown: 1e-9,
    sampleCount: 200,     // sufficient
    minRiskSamples: 50,
    varianceFloor: 1e-9,
  });
  // Not zeroed, but capped — variance floor should not produce explosive kelly
  assert.ok(kelly > 0);
  assert.ok(kelly <= 1, 'kelly must be capped, not explosive');
});

test('induceKellySafe: zero net edge → zero kelly', () => {
  const kelly = induceKellySafe({
    netEdge: 0,
    rvDown: 0.04,
    sampleCount: 200,
    minRiskSamples: 50,
    varianceFloor: 1e-9,
  });
  assert.strictEqual(kelly, 0);
});

test('induceKellySafe: negative net edge → zero kelly (never short via kelly)', () => {
  const kelly = induceKellySafe({
    netEdge: -0.01,
    rvDown: 0.04,
    sampleCount: 200,
    minRiskSamples: 50,
    varianceFloor: 1e-9,
  });
  assert.strictEqual(kelly, 0);
});

test('induceKellySafe: respects maxKellyFraction hard cap', () => {
  // Huge edge, tiny (but real) variance → raw kelly would be massive
  const kelly = induceKellySafe({
    netEdge: 0.5,
    rvDown: 0.001,
    sampleCount: 200,
    minRiskSamples: 50,
    varianceFloor: 1e-9,
    maxKellyFraction: 0.25,
  });
  assert.ok(kelly <= 0.25);
});

test('induceKellySafe: model + parameter variance added to denominator', () => {
  const baseline = induceKellySafe({
    netEdge: 0.01,
    rvDown: 0.04,
    modelVariance: 0,
    parameterVariance: 0,
    sampleCount: 200,
    minRiskSamples: 50,
    varianceFloor: 1e-9,
  });
  const withUncertainty = induceKellySafe({
    netEdge: 0.01,
    rvDown: 0.04,
    modelVariance: 0.02,
    parameterVariance: 0.01,
    sampleCount: 200,
    minRiskSamples: 50,
    varianceFloor: 1e-9,
  });
  assert.ok(withUncertainty < baseline, 'added variance must shrink kelly');
});

test('induceKellySafe: tailDependence scales kelly down', () => {
  const lowTail = induceKellySafe({
    netEdge: 0.01,
    rvDown: 0.04,
    tailDependence: 0.1,
    sampleCount: 200,
    minRiskSamples: 50,
    varianceFloor: 1e-9,
  });
  const highTail = induceKellySafe({
    netEdge: 0.01,
    rvDown: 0.04,
    tailDependence: 0.5,
    sampleCount: 200,
    minRiskSamples: 50,
    varianceFloor: 1e-9,
  });
  assert.ok(highTail < lowTail);
});

test('induceKellySafe: tailDependence = 1 → kelly zeroed', () => {
  const kelly = induceKellySafe({
    netEdge: 0.01,
    rvDown: 0.04,
    tailDependence: 1,
    sampleCount: 200,
    minRiskSamples: 50,
    varianceFloor: 1e-9,
  });
  assert.strictEqual(kelly, 0);
});
