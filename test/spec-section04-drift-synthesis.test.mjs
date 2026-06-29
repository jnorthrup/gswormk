/**
 * ══════════════════════════════════════════════════════════════════════════════
 * § 4  Drift Synthesis — TDD Red Suite
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  Composite drift:
 *    $$\mu^{\text{adj}}_{i,t}
 *      = \hat\mu_{i,t}^{\text{obi}} + \hat\mu_{i,t}^{\text{innov}}$$
 *
 *  Confidence-weighted composite drift:
 *    $$\mu^{\text{eff}}_{i,t}
 *      = a^{\text{align}}_{i,t}\;
 *        q^{\text{cache}}_{i,t}\;
 *        \mu^{\text{adj}}_{i,t}$$
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeDrift } from '../src/trader/signals.ts';

test('§4 drift synthesis = (obi + innovZ) * alignment * cacheQuality', () => {
  const obi = 0.3;
  const innovationZ = 0.5;
  const alignment = 0.8;
  const cacheQuality = 0.9;

  const result = synthesizeDrift({ obi, innovationZ, alignment, cacheQuality });
  const expected = (obi + innovationZ) * alignment * cacheQuality;

  assert.ok(
    Math.abs(result - expected) < 1e-12,
    `μ_eff=${result} should equal (${obi}+${innovationZ})*${alignment}*${cacheQuality}=${expected}`,
  );
});

test('§4 drift synthesis = 0 when alignment = 0', () => {
  const result = synthesizeDrift({
    obi: 0.5,
    innovationZ: 1.2,
    alignment: 0,
    cacheQuality: 1.0,
  });
  assert.strictEqual(result, 0, 'zero alignment should kill drift');
});

test('§4 drift synthesis = 0 when cacheQuality = 0', () => {
  const result = synthesizeDrift({
    obi: 0.5,
    innovationZ: 1.2,
    alignment: 1.0,
    cacheQuality: 0,
  });
  assert.strictEqual(result, 0, 'zero cache quality should kill drift');
});

test('§4 drift synthesis preserves sign of raw drift', () => {
  const positive = synthesizeDrift({
    obi: 0.3,
    innovationZ: 0.2,
    alignment: 0.9,
    cacheQuality: 0.8,
  });
  const negative = synthesizeDrift({
    obi: -0.4,
    innovationZ: -0.3,
    alignment: 0.9,
    cacheQuality: 0.8,
  });
  assert.ok(positive > 0, 'positive raw drift should yield positive effective drift');
  assert.ok(negative < 0, 'negative raw drift should yield negative effective drift');
});

test('§4 drift synthesis is linear in raw drift components', () => {
  const alignment = 0.7;
  const cacheQuality = 0.85;

  const d1 = synthesizeDrift({ obi: 0.1, innovationZ: 0.2, alignment, cacheQuality });
  const d2 = synthesizeDrift({ obi: 0.2, innovationZ: 0.4, alignment, cacheQuality });

  // Doubling both OBI and innovationZ should double the drift
  assert.ok(
    Math.abs(d2 - 2 * d1) < 1e-12,
    `drift should scale linearly: 2*${d1} vs ${d2}`,
  );
});
