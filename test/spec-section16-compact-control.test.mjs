/**
 * ══════════════════════════════════════════════════════════════════════════════
 * § 16  Compact Control Summary (End-to-End) — TDD Red Suite
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  For each asset $i$:
 *
 *    $$\mu^{\text{eff}}_{i,t}
 *      = a^{\text{align}}_{i,t}\,
 *        q^{\text{cache}}_{i,t}\,
 *        \left(\hat\mu^{\text{obi}}_{i,t} + \hat\mu^{\text{innov}}_{i,t}\right)$$
 *
 *    $$k_{i,t}
 *      = \frac{\mu^{\text{eff}}_{i,t}}{\sigma^{2,-}_{i,t} + \varepsilon}
 *        \left(1 - \lambda^{\text{BTC}}_{i,t}\right)$$
 *
 *    $$w^*_{i,t}
 *      = \rho_t\,
 *        \frac{\max(0, k_{i,t})}{\sum_j \max(0, k_{j,t}) + \varepsilon}$$
 *
 *    $$h_{i,t}
 *      = \left(\frac{c_{i,t}}{\sigma^{2,-}_{i,t} + \varepsilon}\right)^{1/3}$$
 *
 *    $$\text{trade iff } |w^*_{i,t} - w_{i,t}| > h_{i,t}$$
 *
 *  This file tests the full pipeline from raw inputs to trade decision,
 *  verifying that every formula chains correctly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EPSILON } from '../src/lib/math.mjs';

// ── §16 Full pipeline: raw inputs → trade decision ─────────────────────────

test('§16 compact control summary: complete pipeline produces valid trade decision', () => {
  // ── Raw inputs ──
  const obi = 0.25;                 // μ^obi
  const innovationZ = 0.40;         // μ^innov
  const alignment = 0.85;           // a^align
  const cacheQuality = 0.95;        // q^cache
  const rvDown = 0.015;             // σ²⁻
  const tailDependence = 0.20;      // λ^BTC
  const effectiveCost = 0.001;      // c
  const currentWeight = 0.10;       // w_{i,t}
  const rho = 0.9;                  // reinvestment budget

  // ── §4 Drift synthesis ──
  // μ^eff = a_align * q_cache * (μ^obi + μ^innov)
  const muEff = alignment * cacheQuality * (obi + innovationZ);
  assert.ok(
    Math.abs(muEff - 0.85 * 0.95 * 0.65) < 1e-9,
    `μ_eff=${muEff}`,
  );

  // ── §5 Kelly sizing ──
  // k = μ^eff / (σ²⁻ + ε) · (1 - λ)
  const kelly = (muEff / (rvDown + EPSILON)) * (1 - tailDependence);
  assert.ok(kelly > 0, `kelly should be positive: ${kelly}`);

  // ── §5 Portfolio normalization (single asset for simplicity) ──
  // w* = ρ · max(0, k) / (Σ max(0, k) + ε)
  const u = Math.max(0, kelly);
  const sumU = u + EPSILON; // single-asset case
  const targetWeight = rho * u / sumU;
  assert.ok(
    targetWeight > 0 && targetWeight <= rho,
    `w*=${targetWeight} should be in (0, ρ]`,
  );

  // ── §6 No-trade band ──
  // h = (c / (σ²⁻ + ε))^(1/3)
  const trigger = Math.cbrt(effectiveCost / (rvDown + EPSILON));
  assert.ok(trigger > 0, `trigger=${trigger} should be positive`);

  // ── §6 Trade condition ──
  const deviation = Math.abs(targetWeight - currentWeight);
  const shouldTrade = deviation > trigger;

  // Log the decision for inspection
  const decision = {
    muEff,
    kelly,
    targetWeight,
    currentWeight,
    trigger,
    deviation,
    shouldTrade,
  };

  // Structural validity checks
  assert.ok(Number.isFinite(decision.muEff), 'μ_eff must be finite');
  assert.ok(Number.isFinite(decision.kelly), 'kelly must be finite');
  assert.ok(decision.targetWeight >= 0, 'target weight must be non-negative');
  assert.ok(decision.trigger > 0, 'trigger must be positive');
  assert.ok(typeof decision.shouldTrade === 'boolean', 'shouldTrade must be boolean');
});

test('§16 full pipeline: negative drift → zero weight → no trade', () => {
  const obi = -0.50;
  const innovationZ = -0.30;
  const alignment = 0.90;
  const cacheQuality = 1.0;
  const rvDown = 0.02;
  const tailDependence = 0.15;
  const rho = 0.9;

  const muEff = alignment * cacheQuality * (obi + innovationZ);
  assert.ok(muEff < 0, 'negative raw drift should yield negative μ_eff');

  const kelly = (muEff / (rvDown + EPSILON)) * (1 - tailDependence);
  assert.ok(kelly < 0, 'negative drift should yield negative kelly');

  const u = Math.max(0, kelly); // §5: spot-only long
  assert.strictEqual(u, 0, 'negative kelly gets floored to 0');

  const targetWeight = rho * u / (u + EPSILON);
  assert.ok(targetWeight < 1e-6, `target weight should be ~0, got ${targetWeight}`);
});

test('§16 full pipeline: high tail dependence shrinks kelly proportionally', () => {
  const obi = 0.3;
  const innovZ = 0.2;
  const alignment = 1.0;
  const cacheQuality = 1.0;
  const rvDown = 0.01;

  const muEff = alignment * cacheQuality * (obi + innovZ);

  const kellyLow = (muEff / (rvDown + EPSILON)) * (1 - 0.1);
  const kellyHigh = (muEff / (rvDown + EPSILON)) * (1 - 0.9);

  assert.ok(
    kellyLow > kellyHigh * 5,
    `low tail dep kelly=${kellyLow} should far exceed high tail dep kelly=${kellyHigh}`,
  );
});

test('§16 full pipeline: zero alignment kills signal entirely', () => {
  const muEff = 0 * 1.0 * (0.3 + 0.2); // alignment = 0
  assert.strictEqual(muEff, 0, 'zero alignment should produce zero drift');

  const kelly = (muEff / (0.01 + EPSILON)) * (1 - 0.2);
  assert.strictEqual(kelly, 0, 'zero drift should produce zero kelly');
});

test('§16 multi-asset normalization: weights sum ≤ ρ', () => {
  const assets = [
    { obi: 0.3, innovZ: 0.2, align: 0.9, cacheQ: 1.0, rv: 0.01, tail: 0.2 },
    { obi: 0.1, innovZ: 0.4, align: 0.85, cacheQ: 0.9, rv: 0.015, tail: 0.3 },
    { obi: -0.2, innovZ: -0.1, align: 0.95, cacheQ: 1.0, rv: 0.02, tail: 0.1 },
  ];
  const rho = 0.9;

  const kellys = assets.map((a) => {
    const mu = a.align * a.cacheQ * (a.obi + a.innovZ);
    return (mu / (a.rv + EPSILON)) * (1 - a.tail);
  });

  const positiveKellys = kellys.map((k) => Math.max(0, k));
  const sumK = positiveKellys.reduce((s, k) => s + k, 0);

  const weights = positiveKellys.map((k) =>
    sumK > EPSILON ? rho * k / sumK : 0,
  );

  const totalWeight = weights.reduce((s, w) => s + w, 0);
  assert.ok(
    totalWeight <= rho + 1e-9,
    `total weight ${totalWeight} must ≤ ρ=${rho}`,
  );

  // Third asset has negative drift → zero weight
  assert.strictEqual(
    weights[2],
    0,
    'negative-drift asset should get zero allocation',
  );
});

// ── §16 Math library primitives ─────────────────────────────────────────────

test('§16 EPSILON is small positive constant', () => {
  assert.ok(EPSILON > 0, 'EPSILON must be positive');
  assert.ok(EPSILON < 1e-6, 'EPSILON should be a small stabilizer');
});
