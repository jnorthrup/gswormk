/**
 * ══════════════════════════════════════════════════════════════════════════════
 * § 11  Model-Alignment Law — TDD Red Suite
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  Weighted distance:
 *    $$d_{i,t}
 *      = \alpha_1 \frac{|\mu^{\text{adj,live}}_{i,t} - \mu^{\text{adj,replay}}_{i,t}|}
 *                      {|\mu^{\text{adj,replay}}_{i,t}| + \varepsilon}
 *      + \alpha_2 \frac{|\sigma^{2,-,\text{live}}_{i,t} - \sigma^{2,-,\text{replay}}_{i,t}|}
 *                      {\sigma^{2,-,\text{replay}}_{i,t} + \varepsilon}
 *      + \alpha_3 \frac{|\lambda^{\text{live}}_{i,t} - \lambda^{\text{replay}}_{i,t}|}
 *                      {\lambda^{\text{replay}}_{i,t} + \varepsilon}$$
 *
 *  with $\alpha_1 = 0.5, \alpha_2 = 0.3, \alpha_3 = 0.2$.
 *
 *  Alignment confidence:
 *    $$a^{\text{align}}_{i,t} = e^{-d_{i,t}}$$
 *
 *  Decision gating:
 *    $$w^*_{i,t} \leftarrow a^{\text{align}}_{i,t}\, w^*_{i,t}$$
 *
 *  NOTE: Current implementation clamps alignment to max(0.2, exp(-min(d,4))).
 *  The spec formula is pure exp(-d) without floor or distance cap.
 *  These tests assert the spec formula.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { alignmentScore } from '../src/trader/signals.mjs';

test('§11 perfect alignment: identical live and replay → a = 1.0', () => {
  const live = { drift: 0.5, rvDown: 0.02, tail: 0.3 };
  const replay = { drift: 0.5, rvDown: 0.02, tail: 0.3 };
  const a = alignmentScore(live, replay);
  assert.ok(
    Math.abs(a - 1.0) < 1e-6,
    `perfect alignment should yield a=1.0, got ${a}`,
  );
});

test('§11 alignment = exp(-d) with α₁=0.5 α₂=0.3 α₃=0.2 [SPEC FORMULA]', () => {
  const live = { drift: 0.6, rvDown: 0.025, tail: 0.35 };
  const replay = { drift: 0.5, rvDown: 0.02, tail: 0.3 };

  const eps = 1e-9;
  const driftDelta = Math.abs(live.drift - replay.drift) / (Math.abs(replay.drift) + eps);
  const rvDelta = Math.abs(live.rvDown - replay.rvDown) / (Math.abs(replay.rvDown) + eps);
  const tailDelta = Math.abs(live.tail - replay.tail) / (Math.abs(replay.tail) + eps);
  const d = 0.5 * driftDelta + 0.3 * rvDelta + 0.2 * tailDelta;
  const specExpected = Math.exp(-d);

  const actual = alignmentScore(live, replay);
  assert.ok(
    Math.abs(actual - specExpected) < 1e-6,
    `alignment=${actual} should match exp(-d)=${specExpected} (d=${d})`,
  );
});

test('§11 alignment decreases with increasing live-replay divergence', () => {
  const replay = { drift: 0.5, rvDown: 0.02, tail: 0.3 };

  const small = alignmentScore({ drift: 0.51, rvDown: 0.021, tail: 0.31 }, replay);
  const large = alignmentScore({ drift: 1.0, rvDown: 0.06, tail: 0.8 }, replay);

  assert.ok(
    small > large,
    `small divergence a=${small} should exceed large divergence a=${large}`,
  );
});

test('§11 alignment can go below 0.2 for extreme divergence [SPEC: no floor]', () => {
  // The spec formula is pure exp(-d). The current implementation clamps at 0.2.
  // This test asserts the SPEC behavior: no floor.
  const live = { drift: 100.0, rvDown: 5.0, tail: 0.99 };
  const replay = { drift: 0.01, rvDown: 0.001, tail: 0.01 };

  const eps = 1e-9;
  const d = 0.5 * Math.abs(100 - 0.01) / (0.01 + eps)
    + 0.3 * Math.abs(5 - 0.001) / (0.001 + eps)
    + 0.2 * Math.abs(0.99 - 0.01) / (0.01 + eps);
  const specExpected = Math.exp(-d);

  // spec expects this to be essentially 0
  assert.ok(
    specExpected < 0.01,
    `extreme divergence should yield near-zero alignment (spec exp(-d)=${specExpected})`,
  );

  const actual = alignmentScore(live, replay);
  assert.ok(
    actual < 0.2,
    `alignment=${actual} should go below 0.2 floor per spec (no floor in spec)`,
  );
});

test('§11 alignment ∈ (0, 1]', () => {
  const cases = [
    [{ drift: 0.5, rvDown: 0.02, tail: 0.3 }, { drift: 0.5, rvDown: 0.02, tail: 0.3 }],
    [{ drift: 1.0, rvDown: 0.05, tail: 0.8 }, { drift: 0.1, rvDown: 0.01, tail: 0.1 }],
    [{ drift: 0.0, rvDown: 0.0, tail: 0.0 }, { drift: 0.0, rvDown: 0.0, tail: 0.0 }],
  ];

  for (const [live, replay] of cases) {
    const a = alignmentScore(live, replay);
    assert.ok(a > 0, `alignment must be > 0, got ${a}`);
    assert.ok(a <= 1.0, `alignment must be ≤ 1.0, got ${a}`);
  }
});

test('§11 decision gating: w* ← a_align * w*', () => {
  const alignment = 0.7;
  const rawWeight = 0.40;
  const gatedWeight = alignment * rawWeight;
  assert.ok(
    Math.abs(gatedWeight - 0.28) < 1e-12,
    `gated weight should be 0.7*0.4=0.28, got ${gatedWeight}`,
  );
});

test('§11 decision gating is multiplicative, not additive', () => {
  const a1 = 0.8;
  const a2 = 0.6;
  const w = 0.5;
  // Two sequential gatings
  const result = a1 * a2 * w;
  const sequential = a2 * (a1 * w);
  assert.ok(
    Math.abs(result - sequential) < 1e-12,
    'gating should be associative under multiplication',
  );
});
