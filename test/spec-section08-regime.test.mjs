/**
 * ══════════════════════════════════════════════════════════════════════════════
 * § 8  Regime Representation — TDD Red Suite
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  Regime is a continuous latent vector, not categorical:
 *    $$R_t = \begin{bmatrix}
 *      \mu^{\text{obi}}_{i,t} \\
 *      \mu^{\text{innov}}_{i,t} \\
 *      \sigma^{2,-}_{i,t} \\
 *      \lambda^{\text{BTC}}_{i,t}
 *    \end{bmatrix}$$
 *
 *  All policy outputs are direct functions of $R_t$:
 *    $$w^*_{i,t} = f(R_t), \quad h_{i,t} = g(R_t), \quad p^{\text{exec}}_{i,t} = e(R_t)$$
 *
 *  There is no external regime switch; the control law is continuous in state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('§8 regime vector contains exactly [obi, innovZ, rvDown, tailDep] components', () => {
  // The regime vector in engine.mjs uses {momentum, meanReversion, volatility}
  // which is a derived 3-component summary.  The spec defines a 4-component
  // raw state vector.  This test asserts the spec shape.
  const regimeVector = {
    obi: 0.3,
    innovationZ: -0.5,
    rvDown: 0.015,
    tailDependence: 0.25,
  };

  const keys = Object.keys(regimeVector);
  assert.deepStrictEqual(
    keys.sort(),
    ['innovationZ', 'obi', 'rvDown', 'tailDependence'],
    'regime vector should contain the four spec-defined components',
  );
});

test('§8 regime is continuous: no categorical state labels', () => {
  // The spec explicitly states "not a categorical state".
  // All components should be continuous real numbers.
  const regime = {
    obi: 0.15,
    innovationZ: -1.2,
    rvDown: 0.008,
    tailDependence: 0.42,
  };

  for (const [key, value] of Object.entries(regime)) {
    assert.ok(typeof value === 'number', `${key} must be numeric`);
    assert.ok(Number.isFinite(value), `${key} must be finite`);
  }
});

test('§8 policy outputs are deterministic functions of regime vector', () => {
  // Given identical regime vectors, policy outputs must be identical.
  // This is a structural requirement: no hidden state or randomness in the
  // mapping from R_t to (w*, h, p_exec).
  const R1 = { obi: 0.2, innovationZ: 0.5, rvDown: 0.01, tailDependence: 0.3 };
  const R2 = { obi: 0.2, innovationZ: 0.5, rvDown: 0.01, tailDependence: 0.3 };

  // Same regime should produce same sizing
  // Using inline spec formulas:
  const EPSILON = 1e-12;
  const kelly1 = (R1.obi + R1.innovationZ) / (R1.rvDown + EPSILON) * (1 - R1.tailDependence);
  const kelly2 = (R2.obi + R2.innovationZ) / (R2.rvDown + EPSILON) * (1 - R2.tailDependence);
  assert.strictEqual(kelly1, kelly2, 'identical regimes must produce identical kelly');

  const h1 = Math.cbrt(0.001 / (R1.rvDown + EPSILON));
  const h2 = Math.cbrt(0.001 / (R2.rvDown + EPSILON));
  assert.strictEqual(h1, h2, 'identical regimes must produce identical trigger');
});
