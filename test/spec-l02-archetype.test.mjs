import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyArchetype, ARCHETYPES } from '../src/trader/archetype.ts';

// L2: Trade Archetypes (TODO item 1)
// discount_reversion | growth_momentum | volatility_defense | no_edge
// Each archetype has independent evidence checks.

// ─────────────────────────────────────────────────────────────────────────────
// Classification: discount_reversion
// ─────────────────────────────────────────────────────────────────────────────

test('classifyArchetype: deep oversold + OBI support → discount_reversion', () => {
  const result = classifyArchetype({
    innovationZ: -2.5,      // strong negative innovation
    obi: 0.3,               // bid-side support (positive OBI = more bids)
    rsiDisplacement: -1.2,  // oversold
    tailDependence: 0.1,    // low crash contagion
    annualizedRvDown: 0.05, // downside variance not exploding
  });
  assert.strictEqual(result.archetype, ARCHETYPES.DISCOUNT_REVERSION);
  assert.strictEqual(result.archetype, 'discount_reversion');
});

test('classifyArchetype: discount fails when OBI confirms continued sell pressure', () => {
  const result = classifyArchetype({
    innovationZ: -2.5,
    obi: -0.4,              // ask-side pressure: negative OBI
    rsiDisplacement: -1.2,
    tailDependence: 0.1,
    annualizedRvDown: 0.05,
  });
  // No bid support → not a valid discount
  assert.notStrictEqual(result.archetype, ARCHETYPES.DISCOUNT_REVERSION);
});

test('classifyArchetype: discount blocked when BTC tailDependence elevated', () => {
  const result = classifyArchetype({
    innovationZ: -2.5,
    obi: 0.3,
    rsiDisplacement: -1.2,
    tailDependence: 0.5,    // crash contagion high
    annualizedRvDown: 0.05,
  });
  assert.notStrictEqual(result.archetype, ARCHETYPES.DISCOUNT_REVERSION);
});

// ─────────────────────────────────────────────────────────.edge_region────
// Classification: growth_momentum
// ─────────────────────────────────────────────────────────────────────────────

test('classifyArchetype: positive innovationZ + OBI + timescale agreement → growth_momentum', () => {
  const result = classifyArchetype({
    innovationZ: 2.5,
    obi: 0.3,
    rsiDisplacement: 0.8,   // directional but not overextended
    tailDependence: 0.1,
    annualizedRvDown: 0.05,
    timescaleAgreement: 3,  // 3 of 4 windows agree
  });
  assert.strictEqual(result.archetype, ARCHETYPES.GROWTH_MOMENTUM);
});

test('classifyArchetype: growth fails when timescales disagree', () => {
  const result = classifyArchetype({
    innovationZ: 2.5,
    obi: 0.3,
    rsiDisplacement: 0.8,
    tailDependence: 0.1,
    annualizedRvDown: 0.05,
    timescaleAgreement: 1,  // only 1 window
  });
  assert.notStrictEqual(result.archetype, ARCHETYPES.GROWTH_MOMENTUM);
});

test('classifyArchetype: growth fails when RSI overextended', () => {
  const result = classifyArchetype({
    innovationZ: 2.5,
    obi: 0.3,
    rsiDisplacement: 1.8,   // overextended (RSI >> 70)
    tailDependence: 0.1,
    annualizedRvDown: 0.05,
    timescaleAgreement: 3,
  });
  assert.notStrictEqual(result.archetype, ARCHETYPES.GROWTH_MOMENTUM);
});

// ─────────────────────────────────────────────────────────────────────────────
// Classification: volatility_defense
// ─────────────────────────────────────────────────────────────────────────────

test('classifyArchetype: elevated tail + rvDown → volatility_defense', () => {
  const result = classifyArchetype({
    innovationZ: 0,
    obi: 0,
    rsiDisplacement: 0,
    tailDependence: 0.6,    // elevated
    annualizedRvDown: 0.4,  // high downside variance
  });
  assert.strictEqual(result.archetype, ARCHETYPES.VOLATILITY_DEFENSE);
});

// ─────────────────────────────────────────────────────────────────────────────
// Classification: no_edge
// ─────────────────────────────────────────────────────────────────────────────

test('classifyArchetype: weak signals everywhere → no_edge', () => {
  const result = classifyArchetype({
    innovationZ: 0.1,
    obi: 0.05,
    rsiDisplacement: 0.1,
    tailDependence: 0.05,
    annualizedRvDown: 0.05,
    timescaleAgreement: 0,
  });
  assert.strictEqual(result.archetype, ARCHETYPES.NO_EDGE);
});

test('classifyArchetype: returns archetype + reason string + passed checks', () => {
  const result = classifyArchetype({
    innovationZ: -2.5,
    obi: 0.3,
    rsiDisplacement: -1.2,
    tailDependence: 0.1,
    annualizedRvDown: 0.05,
  });
  
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  assert.ok(Array.isArray(result.checks));
  assert.ok(result.checks.length > 0);
});
