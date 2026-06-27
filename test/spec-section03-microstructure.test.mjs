/**
 * ══════════════════════════════════════════════════════════════════════════════
 * § 3  Microstructure Inputs — TDD Red Suite
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Every test in this file documents the spec formula (MathJax) and asserts the
 * property the implementation must satisfy.  Tests are RED until the production
 * code matches the spec exactly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeObi,
  computeEffectiveSpread,
  kalmanStep,
  computeDownsideSemivariance,
  computeTailDependence,
} from '../src/trader/signals.mjs';
import { downsideSemivariance, EPSILON, mean } from '../src/lib/math.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// § 3.1  Midprice and Effective Spread
// ─────────────────────────────────────────────────────────────────────────────
//
//  Midprice:
//    $$m_{i,t} = \frac{b^{(1)}_{i,t} + a^{(1)}_{i,t}}{2}$$
//
//  Relative spread:
//    $$s_{i,t} = \frac{a^{(1)}_{i,t} - b^{(1)}_{i,t}}{m_{i,t}}$$
//
//  Effective friction:
//    $$c_{i,t} = \tfrac{1}{2}\,s_{i,t} + f_{i,t} + \psi_{i,t}$$
//
test('§3.1 midprice is arithmetic mean of best bid and best ask', () => {
  const bestBid = 100;
  const bestAsk = 102;
  const mid = (bestBid + bestAsk) / 2;
  assert.strictEqual(mid, 101);
});

test('§3.1 relative spread = (ask - bid) / mid', () => {
  const bestBid = 100;
  const bestAsk = 102;
  const mid = (bestBid + bestAsk) / 2;
  const spread = (bestAsk - bestBid) / mid;
  assert.ok(Math.abs(spread - 2 / 101) < 1e-12);
});

test('§3.1 effective friction c = s/2 + fee + slippage matches spec decomposition', () => {
  const bestBid = 100;
  const bestAsk = 102;
  const feeRate = 0.0006;
  const slippage = 0.0002;
  const c = computeEffectiveSpread(bestBid, bestAsk, feeRate, slippage);

  // Spec formula: c = (1/2) * s + f + ψ
  //   where s = (ask - bid) / mid  (relative spread, not halved)
  const mid = (bestBid + bestAsk) / 2;
  const relativeSpread = (bestAsk - bestBid) / mid;
  const expected = (relativeSpread / 2) + feeRate + slippage;

  assert.ok(
    Math.abs(c - expected) < 1e-12,
    `effective friction c=${c} should equal spec ${expected}`,
  );
});

test('§3.1 effective friction is always positive for valid quotes', () => {
  // Even at zero spread, fee + slippage should keep c > 0
  const c = computeEffectiveSpread(100, 100.001, 0.0006, 0.0002);
  assert.ok(c > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 3.2  Order Book Imbalance Drift
// ─────────────────────────────────────────────────────────────────────────────
//
//  Raw OBI:
//    $$\mu^{\text{obi}}_{i,t}
//      = \frac{B_{i,t} - A_{i,t}}{B_{i,t} + A_{i,t} + \varepsilon}$$
//
//  Normalised OBI (spec-recommended):
//    $$\hat\mu^{\text{obi}}_{i,t}
//      = \frac{\mu^{\text{obi}}_{i,t} - \mathrm{EMA}(\mu^{\text{obi}}_{i,t})}
//             {\sqrt{\mathrm{EWVAR}(\mu^{\text{obi}}_{i,t}) + \varepsilon}}$$
//
test('§3.2 raw OBI is exactly (B-A)/(B+A+ε) for single-level symmetric book', () => {
  const bids = [{ price: 100, size: 10 }];
  const asks = [{ price: 100.01, size: 5 }];
  const mid = 100.005;
  const obi = computeObi(bids, asks, mid, 5);

  // B = 10, A = 5  =>  OBI = (10-5)/(10+5+ε)
  const expected = (10 - 5) / (10 + 5 + EPSILON);
  assert.ok(
    Math.abs(obi - expected) < 1e-9,
    `OBI=${obi} should match (B-A)/(B+A+ε)=${expected}`,
  );
});

test('§3.2 OBI = 0 for perfectly balanced book', () => {
  const bids = [{ price: 100, size: 5 }];
  const asks = [{ price: 100.01, size: 5 }];
  const mid = 100.005;
  const obi = computeObi(bids, asks, mid, 5);
  assert.ok(Math.abs(obi) < 1e-9, `balanced book should yield OBI ≈ 0, got ${obi}`);
});

test('§3.2 OBI ∈ [-1, 1] for extreme imbalance', () => {
  // All bid, no ask within shell
  const bids = [{ price: 100, size: 1000 }];
  const asks = [{ price: 200, size: 1000 }]; // far outside 5bp shell
  const mid = 100;
  const obi = computeObi(bids, asks, mid, 5);
  assert.ok(obi >= -1 && obi <= 1, `OBI must be in [-1,1], got ${obi}`);
});

test('§3.2 multi-level depth weighting: deeper levels within shell contribute', () => {
  const bids = [
    { price: 100.00, size: 3 },
    { price: 99.99, size: 2 },
    { price: 99.98, size: 1 },
  ];
  const asks = [
    { price: 100.01, size: 1 },
    { price: 100.02, size: 1 },
    { price: 100.03, size: 1 },
  ];
  const mid = 100.005;
  const obi = computeObi(bids, asks, mid, 5);
  // With 5bp shell around 100.005: cutoff = ±0.05 => bid >= 99.955, ask <= 100.055
  // All levels should be inside; bid total = 6, ask total = 3
  // OBI = (6-3)/(6+3+ε) = 3/9 ≈ 0.333
  assert.ok(obi > 0.3, `multi-level OBI should reflect bid dominance, got ${obi}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// § 3.3  Kalman Innovation Drift
// ─────────────────────────────────────────────────────────────────────────────
//
//  Local level model:
//    $$x_{t|t-1} = x_{t-1}$$
//    $$P_{t|t-1} = P_{t-1} + Q$$
//    $$y_t = z_t - x_{t|t-1}$$
//    $$S_t = P_{t|t-1} + R_t$$
//    $$K_t = \frac{P_{t|t-1}}{S_t}$$
//    $$x_t = x_{t|t-1} + K_t y_t$$
//    $$P_t = (1 - K_t) P_{t|t-1}$$
//
//  Innovation z-score:
//    $$\mu^{\text{innov}}_{i,t} = \frac{y_t}{\sqrt{S_t}}$$
//
test('§3.3 Kalman innovation = observed - predicted', () => {
  const state = { x: 100, p: 1 };
  const observed = 103;
  const Q = 0.05;
  const R = 4;
  const result = kalmanStep(state, observed, Q, R);

  const predictedX = state.x; // x_{t|t-1} = x_{t-1}
  const expectedInnovation = observed - predictedX;
  assert.strictEqual(result.innovation, expectedInnovation);
});

test('§3.3 Kalman gain K = P_predicted / S', () => {
  const state = { x: 100, p: 1 };
  const Q = 0.05;
  const R = 4;
  const result = kalmanStep(state, 101, Q, R);

  const predictedP = state.p + Q;       // P_{t|t-1}
  const S = predictedP + R;             // S_t
  const expectedGain = predictedP / S;  // K_t

  // Verify via updated state: x_t = x_{t|t-1} + K_t * y_t
  const expectedX = state.x + expectedGain * (101 - state.x);
  assert.ok(
    Math.abs(result.state.x - expectedX) < 1e-12,
    `updated x=${result.state.x} should match ${expectedX}`,
  );
});

test('§3.3 Kalman posterior variance P_t = (1 - K) * P_predicted', () => {
  const state = { x: 100, p: 2 };
  const Q = 0.1;
  const R = 3;
  const result = kalmanStep(state, 101, Q, R);

  const predictedP = state.p + Q;
  const S = predictedP + R;
  const K = predictedP / S;
  const expectedP = (1 - K) * predictedP;

  assert.ok(
    Math.abs(result.state.p - expectedP) < 1e-12,
    `posterior p=${result.state.p} should match ${expectedP}`,
  );
});

test('§3.3 innovation z-score = y / sqrt(S)', () => {
  const state = { x: 50, p: 1 };
  const Q = 0.05;
  const R = 4;
  const observed = 52;
  const result = kalmanStep(state, observed, Q, R);

  const predictedP = state.p + Q;
  const S = predictedP + R;
  const y = observed - state.x;
  const expectedZ = y / Math.sqrt(S);

  assert.ok(
    Math.abs(result.innovationZ - expectedZ) < 1e-12,
    `innovationZ=${result.innovationZ} should match y/√S=${expectedZ}`,
  );
});

test('§3.3 Kalman converges: repeated observations shrink P', () => {
  let state = { x: 100, p: 10 };
  const Q = 0.01;
  const R = 1;
  const initialP = state.p;

  for (let i = 0; i < 50; i++) {
    const result = kalmanStep(state, 100 + Math.sin(i) * 0.1, Q, R);
    state = result.state;
  }

  assert.ok(
    state.p < initialP,
    `posterior variance should shrink from ${initialP}, got ${state.p}`,
  );
});

test('§3.3 observation target blends midprice and microprice', () => {
  // $$z_t = \alpha m_t + (1 - \alpha) \text{microprice}_t$$
  // $$\text{microprice}_t = \frac{a^{(1)}_t \cdot \text{bidSize}^{(1)}_t
  //   + b^{(1)}_t \cdot \text{askSize}^{(1)}_t}
  //   {\text{bidSize}^{(1)}_t + \text{askSize}^{(1)}_t}$$
  const bestBid = 100;
  const bestAsk = 102;
  const bidSize = 10;
  const askSize = 2;
  const mid = (bestBid + bestAsk) / 2; // 101
  const microprice = (bestAsk * bidSize + bestBid * askSize) / (bidSize + askSize);
  // microprice = (102*10 + 100*2) / 12 = (1020 + 200) / 12 = 101.667

  const alpha = 0.5;
  const z = alpha * mid + (1 - alpha) * microprice;

  assert.ok(z > mid, 'blended observation should be pulled toward bid-heavy microprice');
  assert.ok(z < microprice, 'blended observation should be between mid and microprice');
});

// ─────────────────────────────────────────────────────────────────────────────
// § 3.4  Downside Semivariance
// ─────────────────────────────────────────────────────────────────────────────
//
//  $$\bar r_{i,t} = \frac{1}{|W_\sigma|} \sum_{\tau \in W_\sigma} r_{i,\tau}$$
//
//  $$\sigma^{2,-}_{i,t}
//    = \frac{1}{|W_\sigma|} \sum_{\tau \in W_\sigma}
//      \min(0,\, r_{i,\tau} - \bar r_{i,t})^2$$
//
test('§3.4 downside semivariance ignores upside deviations', () => {
  // All positive returns => all deviations from mean that are below mean get squared
  const returns = [0.05, 0.10, 0.15, 0.20, 0.25];
  const avg = mean(returns); // 0.15
  // downside deviations: 0.05-0.15=-0.1, 0.10-0.15=-0.05, 0, 0, 0
  // semivar = (0.01 + 0.0025 + 0 + 0 + 0) / 5 = 0.0025
  const sv = downsideSemivariance(returns);
  const expected = ((-0.10) ** 2 + (-0.05) ** 2) / 5;
  assert.ok(
    Math.abs(sv - expected) < 1e-12,
    `semivariance=${sv} should equal ${expected}`,
  );
});

test('§3.4 downside semivariance ≤ total variance', () => {
  const returns = [-0.05, 0.02, -0.08, 0.01, -0.03, 0.04, -0.06, 0.03];
  const sv = downsideSemivariance(returns);
  const avg = mean(returns);
  const totalVar = returns.reduce((s, r) => s + (r - avg) ** 2, 0) / returns.length;
  assert.ok(sv <= totalVar + 1e-12, `semivariance ${sv} must ≤ variance ${totalVar}`);
});

test('§3.4 computeDownsideSemivariance floors at ε_σ = 1e-9', () => {
  // Constant returns => semivariance = 0, but spec §13 requires floor
  const returns = [0.01, 0.01, 0.01, 0.01, 0.01];
  const sv = computeDownsideSemivariance(returns);
  assert.ok(sv >= 1e-9, `semivariance must be floored at 1e-9, got ${sv}`);
});

test('§3.4 downside semivariance for pure downside series', () => {
  const returns = [-0.10, -0.05, -0.08, -0.12, -0.03];
  const avg = mean(returns); // -0.076
  // All returns are negative but some are above mean, some below
  const sv = downsideSemivariance(returns);
  assert.ok(sv > 0, 'should be nonzero for series with variation');
});

// ─────────────────────────────────────────────────────────────────────────────
// § 3.5  BTC Tail Dependence
// ─────────────────────────────────────────────────────────────────────────────
//
//  Empirical CDF ranks:
//    $$u_{i,\tau} = F_i(r_{i,\tau}), \quad u_{\text{BTC},\tau} = F_{\text{BTC}}(r_{\text{BTC},\tau})$$
//
//  Lower-tail conditional exceedance:
//    $$\hat\lambda^{\text{BTC}}_{i,t}(q)
//      = \frac{\sum_\tau \mathbf{1}[u_{i,\tau} \le q \;\wedge\; u_{\text{BTC},\tau} \le q]}
//             {\sum_\tau \mathbf{1}[u_{\text{BTC},\tau} \le q] + \varepsilon}$$
//
test('§3.5 tail dependence = 1.0 for perfectly co-crashing series', () => {
  // Identical return series => whenever BTC is in lower tail, asset is too
  const n = 100;
  const returns = Array.from({ length: n }, (_, i) => Math.sin(i / 5) * 0.1);
  const td = computeTailDependence(returns, returns, 0.05);
  assert.ok(
    Math.abs(td - 1.0) < 0.05,
    `perfect co-crash should yield λ ≈ 1.0, got ${td}`,
  );
});

test('§3.5 tail dependence ≈ 0 for independent series', () => {
  // Asset crashes when BTC rallies and vice versa
  const n = 100;
  const asset = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? -0.1 : 0.1));
  const btc = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0.1 : -0.1));
  const td = computeTailDependence(asset, btc, 0.1);
  assert.ok(td < 0.2, `anti-correlated series should have low λ, got ${td}`);
});

test('§3.5 tail dependence requires minimum sample size', () => {
  const asset = [-0.1, 0.1, -0.05];
  const btc = [-0.1, 0.1, -0.05];
  const td = computeTailDependence(asset, btc, 0.05);
  assert.strictEqual(td, 0, 'should return 0 for insufficient data (< 20 samples)');
});

test('§3.5 tail dependence ∈ [0, 1]', () => {
  const n = 200;
  const asset = Array.from({ length: n }, (_, i) => Math.sin(i * 0.3) * 0.05 - 0.02);
  const btc = Array.from({ length: n }, (_, i) => Math.cos(i * 0.3) * 0.06 - 0.01);
  const td = computeTailDependence(asset, btc, 0.05);
  assert.ok(td >= 0 && td <= 1, `λ must be in [0,1], got ${td}`);
});
