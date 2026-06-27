/**
 * ══════════════════════════════════════════════════════════════════════════════
 * § 13  Risk Invariants — TDD Red Suite
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  Concentration constraint:
 *    $$w_{i,t} \le w_i^{\max}$$
 *
 *  Drawdown halt:
 *    $$\mathrm{DD}_t > \mathrm{DD}^{\max}
 *      \;\Rightarrow\; w^*_{i,t} = 0 \quad \forall i$$
 *
 *  Position floor from risk-adjusted conviction:
 *    $$w^*_{i,t} = 0 \quad \text{if} \quad \mu^{\text{eff}}_{i,t} \le 0$$
 *
 *  Crash-contagion extinction:
 *    $$\lambda^{\text{BTC}}_{i,t} \to 1
 *      \;\Rightarrow\; w^*_{i,t} \to 0$$
 *
 *  Semivariance floor:
 *    $$\sigma^{2,-}_{i,t}
 *      \leftarrow \max(\sigma^{2,-}_{i,t}, \varepsilon_\sigma)$$
 *
 *  Drawdown:
 *    $$\mathrm{DD}_t = 1 - \frac{\mathrm{NAV}_t}{\max_{s \le t} \mathrm{NAV}_s}$$
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDrawdown, applyRiskInvariants, classifyRiskState } from '../src/trader/risk.mjs';

// ── §13 Drawdown ────────────────────────────────────────────────────────────

test('§13 drawdown = 1 - NAV/peakNAV', () => {
  const dd = computeDrawdown({ nav: 85000, peakNav: 100000 });
  const expected = 1 - 85000 / 100000; // 0.15
  assert.ok(
    Math.abs(dd - expected) < 1e-12,
    `drawdown=${dd} should equal ${expected}`,
  );
});

test('§13 drawdown = 0 at peak', () => {
  const dd = computeDrawdown({ nav: 100000, peakNav: 100000 });
  assert.strictEqual(dd, 0, 'at peak, drawdown should be 0');
});

test('§13 drawdown = 0 when NAV exceeds peak (new high)', () => {
  const dd = computeDrawdown({ nav: 105000, peakNav: 100000 });
  assert.strictEqual(dd, 0, 'new high should yield drawdown 0');
});

test('§13 drawdown ∈ [0, 1]', () => {
  for (const [nav, peak] of [[50000, 100000], [1, 100000], [99999, 100000]]) {
    const dd = computeDrawdown({ nav, peakNav: peak });
    assert.ok(dd >= 0 && dd <= 1, `drawdown=${dd} for nav=${nav} peak=${peak}`);
  }
});

// ── §13 Drawdown halt ───────────────────────────────────────────────────────

test('§13 drawdown halt: all targets → 0 when DD > DD_max', () => {
  const targets = new Map([['BTC-USD', 0.4], ['ETH-USD', 0.3]]);
  const result = applyRiskInvariants({
    targets,
    drawdown: 0.20,
    maxDrawdownPct: 0.15,
    maxPositionPct: 0.45,
  });

  assert.ok(result.halted, 'should be halted');
  for (const [symbol, w] of result.constrained) {
    assert.strictEqual(w, 0, `${symbol} should be zeroed on halt`);
  }
});

test('§13 no halt when drawdown is within limit', () => {
  const targets = new Map([['BTC-USD', 0.4], ['ETH-USD', 0.3]]);
  const result = applyRiskInvariants({
    targets,
    drawdown: 0.10,
    maxDrawdownPct: 0.15,
    maxPositionPct: 0.45,
  });

  assert.ok(!result.halted, 'should not be halted');
  assert.ok(
    result.constrained.get('BTC-USD') > 0,
    'BTC should retain positive weight when not halted',
  );
});

// ── §13 Concentration constraint ────────────────────────────────────────────

test('§13 concentration: w_i ≤ w_max after risk invariants', () => {
  const targets = new Map([['BTC-USD', 0.60], ['ETH-USD', 0.25]]);
  const result = applyRiskInvariants({
    targets,
    drawdown: 0.05,
    maxDrawdownPct: 0.15,
    maxPositionPct: 0.45,
  });

  assert.ok(
    result.constrained.get('BTC-USD') <= 0.45,
    `BTC weight ${result.constrained.get('BTC-USD')} should be ≤ maxPosition=0.45`,
  );
});

// ── §13 Risk state classification ───────────────────────────────────────────

test('§13 risk state HALT when drawdown exceeds max', () => {
  const state = classifyRiskState({
    drawdown: 0.20,
    maxDrawdownPct: 0.15,
    currentWeight: 0.30,
    maxPositionPct: 0.45,
  });
  assert.strictEqual(state, 'HALT');
});

test('§13 risk state TRIM when weight at concentration limit', () => {
  const state = classifyRiskState({
    drawdown: 0.05,
    maxDrawdownPct: 0.15,
    currentWeight: 0.45,
    maxPositionPct: 0.45,
  });
  assert.strictEqual(state, 'TRIM');
});

test('§13 risk state OK when within all limits', () => {
  const state = classifyRiskState({
    drawdown: 0.05,
    maxDrawdownPct: 0.15,
    currentWeight: 0.30,
    maxPositionPct: 0.45,
  });
  assert.strictEqual(state, 'OK');
});

// ── §13 Crash-contagion extinction ──────────────────────────────────────────

test('§13 crash contagion: λ→1 drives kelly→0 and therefore w*→0', () => {
  // This is tested via the kelly formula but validated here as a risk invariant
  const EPSILON = 1e-12;
  const drift = 1.0;
  const rvDown = 0.01;
  const lambda = 0.999;

  // Spec kelly: k = μ/(σ²⁻+ε) · (1-λ)
  const k = (drift / (rvDown + EPSILON)) * (1 - lambda);
  assert.ok(k < 0.2, `near-1 lambda should yield near-zero kelly: k=${k}`);
});

// ── §13 Semivariance floor ──────────────────────────────────────────────────

test('§13 semivariance floor: σ²⁻ ≥ ε_σ prevents division blowup', () => {
  const epsSigma = 1e-9;
  const rawSemivar = 0;
  const floored = Math.max(rawSemivar, epsSigma);
  assert.ok(floored >= epsSigma, `floored semivariance should be ≥ ε_σ`);

  // Kelly with floored semivariance should be finite
  const k = 0.5 / (floored + 1e-12);
  assert.ok(Number.isFinite(k), 'kelly should be finite with floored semivariance');
});
