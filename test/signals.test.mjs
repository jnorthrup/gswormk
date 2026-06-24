import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeObi,
  computeTailDependence,
  induceKelly,
  induceTrigger,
  kalmanStep,
} from '../src/trader/signals.mjs';

test('computeObi stays inside [-1, 1]', () => {
  const obi = computeObi(
    [{ price: 100, size: 5 }, { price: 99.99, size: 2 }],
    [{ price: 100.01, size: 1 }, { price: 100.02, size: 1 }],
    100,
  );

  assert.ok(obi <= 1);
  assert.ok(obi >= -1);
});

test('kalmanStep produces finite innovation z-score', () => {
  const output = kalmanStep({ x: 100, p: 1 }, 101, 0.05, 4);
  assert.ok(Number.isFinite(output.innovationZ));
  assert.ok(output.state.p > 0);
});

test('tail dependence grows for co-crashing series', () => {
  const asset = [-0.1, -0.07, -0.02, 0.01, 0.02, -0.12, 0.03, 0.04, -0.09, 0.01, -0.11, 0.02, -0.08, 0.01, -0.13, 0.02, -0.09, 0.01, -0.14, 0.02];
  const btc = [-0.12, -0.08, -0.03, 0.01, 0.02, -0.15, 0.04, 0.02, -0.1, 0.01, -0.12, 0.02, -0.09, 0.01, -0.13, 0.02, -0.08, 0.01, -0.15, 0.02];
  const td = computeTailDependence(asset, btc, 0.1);
  assert.ok(td > 0.5);
});

test('trigger shrinks as downside variance rises', () => {
  const lowVariance = induceTrigger(0.001, 0.002);
  const highVariance = induceTrigger(0.001, 0.01);
  assert.ok(highVariance < lowVariance);
});

test('kelly increases with drift and decreases with tail dependence', () => {
  const loose = induceKelly({ effectiveDrift: 0.3, rvDown: 0.02, tailDependence: 0.1 });
  const stressed = induceKelly({ effectiveDrift: 0.3, rvDown: 0.02, tailDependence: 0.9 });
  assert.ok(loose > stressed);
});