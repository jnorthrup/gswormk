/**
 * ══════════════════════════════════════════════════════════════════════════════
 * § 5  Core Sizing Equation (Kelly) — TDD Red Suite
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  Per-asset asymmetric Kelly:
 *    $$k_{i,t} = \frac{\mu^{\text{eff}}_{i,t}}{\sigma^{2,-}_{i,t} + \varepsilon}
 *               \cdot \left(1 - \lambda^{\text{BTC}}_{i,t}\right)$$
 *
 *  Spot-only long allocation:
 *    $$u_{i,t} = \max(0, k_{i,t})$$
 *
 *  Portfolio normalization:
 *    $$w^*_{i,t} = \rho_t \cdot \frac{u_{i,t}}{\sum_j u_{j,t} + \varepsilon}$$
 *
 *  Hard cap:
 *    $$w^*_{i,t} \leftarrow \min(w^*_{i,t}, w_i^{\max})$$
 *
 *  NOTE: The current implementation in signals.mjs::induceKelly uses
 *    effectiveDrift / ((rvDown * (1 + tailDependence)) + EPSILON)
 *  which differs from the spec formula. The spec says (1 - λ) as a
 *  multiplicative discount, not (1 + λ) in the denominator.
 *  These tests assert the SPEC formula.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { induceKelly } from '../src/trader/signals.mjs';
import { derivePortfolioTargets } from '../src/trader/optimizer.mjs';
import { EPSILON } from '../src/lib/math.mjs';

// ── §5 Kelly formula ────────────────────────────────────────────────────────

test('§5 kelly = μ_eff / (σ²⁻ + ε) · (1 - λ_BTC) [SPEC FORMULA]', () => {
  const effectiveDrift = 0.5;
  const rvDown = 0.02;
  const tailDependence = 0.3;

  const actual = induceKelly({ effectiveDrift, rvDown, tailDependence });

  // Spec formula: k = μ_eff / (σ²⁻ + ε) · (1 - λ)
  const specExpected = (effectiveDrift / (rvDown + EPSILON)) * (1 - tailDependence);

  assert.ok(
    Math.abs(actual - specExpected) < 1e-6,
    `kelly=${actual} should match spec k = μ/(σ²⁻+ε)·(1-λ) = ${specExpected}`,
  );
});

test('§5 kelly → 0 as tail dependence → 1 (crash contagion extinction)', () => {
  const k = induceKelly({ effectiveDrift: 1.0, rvDown: 0.01, tailDependence: 0.999 });

  // Spec: k = μ/(σ²⁻+ε) · (1 - 0.999) → small
  const specExpected = (1.0 / (0.01 + EPSILON)) * (1 - 0.999);
  assert.ok(
    Math.abs(k - specExpected) < 1e-3,
    `kelly should vanish as λ→1: got ${k}, expected ~${specExpected}`,
  );
});

test('§5 kelly = 0 for zero drift', () => {
  const k = induceKelly({ effectiveDrift: 0, rvDown: 0.05, tailDependence: 0.2 });
  assert.strictEqual(k, 0, 'zero drift → zero kelly');
});

test('§5 kelly < 0 for negative drift (no long position)', () => {
  const k = induceKelly({ effectiveDrift: -0.3, rvDown: 0.05, tailDependence: 0.1 });
  assert.ok(k < 0, `negative drift should yield negative kelly, got ${k}`);
});

test('§5 kelly scales inversely with downside semivariance', () => {
  const kLow = induceKelly({ effectiveDrift: 0.5, rvDown: 0.01, tailDependence: 0.2 });
  const kHigh = induceKelly({ effectiveDrift: 0.5, rvDown: 0.10, tailDependence: 0.2 });
  assert.ok(
    kLow > kHigh,
    `lower semivariance should yield higher kelly: ${kLow} vs ${kHigh}`,
  );
});

// ── §5 Portfolio normalization ──────────────────────────────────────────────

test('§5 portfolio weights sum ≤ ρ (reinvestment budget)', () => {
  const signals = [
    { symbol: 'BTC-USD', rawKelly: 5.0, tailDependence: 0.2, regime: { momentum: 0.1 } },
    { symbol: 'ETH-USD', rawKelly: 3.0, tailDependence: 0.3, regime: { momentum: 0.05 } },
  ];
  const targets = derivePortfolioTargets({
    signals,
    reinvestPct: 0.9,
    maxPositionPct: 0.45,
  });

  let totalWeight = 0;
  for (const w of targets.values()) totalWeight += w;
  assert.ok(
    totalWeight <= 0.9 + 1e-9,
    `total weight ${totalWeight} should be ≤ ρ=0.9`,
  );
});

test('§5 negative kelly assets get zero weight (spot-only long)', () => {
  const signals = [
    { symbol: 'BTC-USD', rawKelly: -2.0, tailDependence: 0.1, regime: { momentum: 0 } },
    { symbol: 'ETH-USD', rawKelly: 1.0, tailDependence: 0.1, regime: { momentum: 0 } },
  ];
  const targets = derivePortfolioTargets({
    signals,
    reinvestPct: 0.9,
    maxPositionPct: 0.45,
  });

  assert.strictEqual(
    targets.get('BTC-USD'),
    0,
    'negative kelly should produce zero target weight',
  );
  assert.ok(
    targets.get('ETH-USD') > 0,
    'positive kelly should produce positive target weight',
  );
});

test('§5 hard cap: no single position exceeds w_max', () => {
  const signals = [
    { symbol: 'BTC-USD', rawKelly: 100.0, tailDependence: 0.0, regime: { momentum: 0 } },
    { symbol: 'ETH-USD', rawKelly: 0.01, tailDependence: 0.0, regime: { momentum: 0 } },
  ];
  const targets = derivePortfolioTargets({
    signals,
    reinvestPct: 0.9,
    maxPositionPct: 0.45,
  });

  assert.ok(
    targets.get('BTC-USD') <= 0.45 + 1e-9,
    `BTC weight ${targets.get('BTC-USD')} should not exceed maxPosition=0.45`,
  );
});

test('§5 all zero kelly yields all zero weights', () => {
  const signals = [
    { symbol: 'BTC-USD', rawKelly: 0, tailDependence: 0.5, regime: { momentum: 0 } },
    { symbol: 'ETH-USD', rawKelly: 0, tailDependence: 0.5, regime: { momentum: 0 } },
  ];
  const targets = derivePortfolioTargets({
    signals,
    reinvestPct: 0.9,
    maxPositionPct: 0.45,
  });

  for (const [symbol, w] of targets) {
    assert.strictEqual(w, 0, `${symbol} with zero kelly should get zero weight`);
  }
});

test('§5 spec portfolio normalization: w* = ρ · max(0,k) / Σmax(0,k)', () => {
  // The spec does NOT include regimeBoost or systemicPenalty in normalization.
  // This test asserts the pure spec formula.
  const signals = [
    { symbol: 'BTC-USD', rawKelly: 5.0, tailDependence: 0.2, regime: { momentum: 0 } },
    { symbol: 'ETH-USD', rawKelly: 3.0, tailDependence: 0.3, regime: { momentum: 0 } },
  ];
  const reinvestPct = 0.9;
  const maxPositionPct = 0.45;

  const targets = derivePortfolioTargets({ signals, reinvestPct, maxPositionPct });

  // Spec normalization (without regime/systemic modifiers):
  // u_BTC = max(0, 5.0) = 5.0
  // u_ETH = max(0, 3.0) = 3.0
  // sum = 8.0
  // w*_BTC = 0.9 * 5/8 = 0.5625 → capped at 0.45
  // w*_ETH = 0.9 * 3/8 = 0.3375
  const expectedBtc = Math.min(reinvestPct * 5.0 / 8.0, maxPositionPct);
  const expectedEth = Math.min(reinvestPct * 3.0 / 8.0, maxPositionPct);

  assert.ok(
    Math.abs(targets.get('BTC-USD') - expectedBtc) < 1e-6,
    `BTC weight=${targets.get('BTC-USD')} should match spec ${expectedBtc}`,
  );
  assert.ok(
    Math.abs(targets.get('ETH-USD') - expectedEth) < 1e-6,
    `ETH weight=${targets.get('ETH-USD')} should match spec ${expectedEth}`,
  );
});
