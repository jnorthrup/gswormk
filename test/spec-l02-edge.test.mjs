import test from 'node:test';
import assert from 'node:assert/strict';
import { computeEdgeDecomposition, bpsToFraction, fractionToBps } from '../src/trader/edge.ts';

// L2: Edge Decomposition (TODO item 2)
// Every order must persist: grossEdgeBps, costBps, uncertaintyBps, netEdgeBps.
// Gate: no order if netEdgeBps <= 0.

// ─────────────────────────────────────────────────────────────────────────────
// Unit conversion helpers
// ─────────────────────────────────────────────────────────────────────────────

test('fractionToBps: 1% = 100 bps', () => {
  assert.strictEqual(fractionToBps(0.01), 100);
  assert.strictEqual(fractionToBps(0.001), 10);
  assert.strictEqual(fractionToBps(1), 10_000);
  assert.strictEqual(fractionToBps(0), 0);
});

test('bpsToFraction: 100 bps = 1%', () => {
  assert.strictEqual(bpsToFraction(100), 0.01);
  assert.strictEqual(bpsToFraction(10), 0.001);
  assert.strictEqual(bpsToFraction(10_000), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge decomposition
// ─────────────────────────────────────────────────────────────────────────────

test('computeEdgeDecomposition: gross = drift in bps', () => {
  const edge = computeEdgeDecomposition({
    effectiveDrift: 0.005,  // 0.5% = 50 bps
    spread: 0.0002,         // 2 bps
    feeRate: 0.0006,        // 6 bps
    slippage: 0.0001,       // 1 bps
    kalmanUncertainty: 0.0001,
    signalDisagreement: 0,
    cacheQuality: 1,
  });
  
  assert.ok(Math.abs(edge.grossEdgeBps - 50) < 1e-9);
});

test('computeEdgeDecomposition: cost = spread + fee + slippage in bps', () => {
  const edge = computeEdgeDecomposition({
    effectiveDrift: 0,
    spread: 0.0002,    // 2 bps
    feeRate: 0.0006,   // 6 bps
    slippage: 0.0001,  // 1 bps
    kalmanUncertainty: 0,
    signalDisagreement: 0,
    cacheQuality: 1,
  });
  
  assert.ok(Math.abs(edge.costBps - 9) < 1e-9);
});

test('computeEdgeDecomposition: uncertainty grows when cacheQuality degrades', () => {
  const fresh = computeEdgeDecomposition({
    effectiveDrift: 0.01,
    spread: 0, feeRate: 0, slippage: 0,
    kalmanUncertainty: 0.0001,
    signalDisagreement: 0,
    cacheQuality: 1,
  });
  const stale = computeEdgeDecomposition({
    effectiveDrift: 0.01,
    spread: 0, feeRate: 0, slippage: 0,
    kalmanUncertainty: 0.0001,
    signalDisagreement: 0,
    cacheQuality: 0.35,
  });
  
  assert.ok(stale.uncertaintyBps > fresh.uncertaintyBps, 'stale cache must raise uncertainty');
});

test('computeEdgeDecomposition: net = gross - cost - uncertainty', () => {
  const edge = computeEdgeDecomposition({
    effectiveDrift: 0.005,  // 50 bps gross
    spread: 0.0002,
    feeRate: 0.0006,
    slippage: 0.0001,
    kalmanUncertainty: 0.0001,  // 1 bps
    signalDisagreement: 0,
    cacheQuality: 1,
  });
  
  assert.ok(Math.abs(edge.netEdgeBps - (edge.grossEdgeBps - edge.costBps - edge.uncertaintyBps)) < 1e-9);
});

test('computeEdgeDecomposition: positive net edge when drift >> costs', () => {
  const edge = computeEdgeDecomposition({
    effectiveDrift: 0.01,   // 100 bps
    spread: 0.0002,         // 2 bps
    feeRate: 0.0006,        // 6 bps
    slippage: 0.0001,       // 1 bps
    kalmanUncertainty: 0.0002, // 2 bps
    signalDisagreement: 0,
    cacheQuality: 1,
  });
  
  assert.ok(edge.netEdgeBps > 0);
  // 100 - 9 - (2 + cache penalty(0)) = 89 bps net
  assert.ok(edge.netEdgeBps > 80);
});

test('computeEdgeDecomposition: negative net edge when drift < costs', () => {
  const edge = computeEdgeDecomposition({
    effectiveDrift: 0.0005, // 5 bps gross
    spread: 0.0002,
    feeRate: 0.0006,
    slippage: 0.0001,
    kalmanUncertainty: 0,
    signalDisagreement: 0,
    cacheQuality: 1,
  });
  
  assert.ok(edge.netEdgeBps < 0);  // 5 - 9 = -4 bps
});

test('computeEdgeDecomposition: uncertainty sums kalman + disagreement + cache penalty', () => {
  const edge = computeEdgeDecomposition({
    effectiveDrift: 0,
    spread: 0, feeRate: 0, slippage: 0,
    kalmanUncertainty: 0.001,      // 10 bps
    signalDisagreement: 0.0005,    // 5 bps
    cacheQuality: 1,               // 0 penalty
  });
  
  // 10 + 5 + 0 = 15 bps
  assert.ok(Math.abs(edge.uncertaintyBps - 15) < 1e-9);
});

test('computeEdgeDecomposition: signal disagreement scales uncertainty', () => {
  const agree = computeEdgeDecomposition({
    effectiveDrift: 0.01,
    spread: 0, feeRate: 0, slippage: 0,
    kalmanUncertainty: 0,
    signalDisagreement: 0,
    cacheQuality: 1,
  });
  const disagree = computeEdgeDecomposition({
    effectiveDrift: 0.01,
    spread: 0, feeRate: 0, slippage: 0,
    kalmanUncertainty: 0,
    signalDisagreement: 0.002,  // 20 bps penalty
    cacheQuality: 1,
  });
  
  assert.ok(disagree.uncertaintyBps > agree.uncertaintyBps);
  assert.ok(disagree.netEdgeBps < agree.netEdgeBps);
});

// ─────────────────────────────────────────────────────────────────────────────
// Order gate
// ─────────────────────────────────────────────────────────────────────────────

test('computeEdgeDecomposition: passesGate true iff netEdgeBps > 0', () => {
  const pos = computeEdgeDecomposition({
    effectiveDrift: 0.01,
    spread: 0.0002, feeRate: 0.0006, slippage: 0.0001,
    kalmanUncertainty: 0.0001,
    signalDisagreement: 0,
    cacheQuality: 1,
  });
  const neg = computeEdgeDecomposition({
    effectiveDrift: 0.0001,
    spread: 0.0002, feeRate: 0.0006, slippage: 0.0001,
    kalmanUncertainty: 0.0001,
    signalDisagreement: 0,
    cacheQuality: 1,
  });
  
  assert.strictEqual(pos.passesGate, true);
  assert.strictEqual(neg.passesGate, false);
});

test('computeEdgeDecomposition: respects minEdgeBps override', () => {
  // net would be 80 bps but we demand 100
  const edge = computeEdgeDecomposition({
    effectiveDrift: 0.009,  // 90 bps
    spread: 0, feeRate: 0, slippage: 0,
    kalmanUncertainty: 0, signalDisagreement: 0,
    cacheQuality: 1,
    minEdgeBps: 100,
  });
  
  assert.ok(edge.netEdgeBps > 0);  // 90 bps is still positive
  assert.strictEqual(edge.passesGate, false);  // but below 100 minimum
});
