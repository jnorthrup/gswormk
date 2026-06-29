/**
 * ══════════════════════════════════════════════════════════════════════════════
 * § 6  Core Trigger Equation — TDD Red Suite
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  No-trade band from transaction-cost-optimal cubic law:
 *    $$h_{i,t} = \left(\frac{c_{i,t}}{\sigma^{2,-}_{i,t} + \varepsilon}\right)^{1/3}$$
 *
 *  Trade condition:
 *    $$|w^*_{i,t} - w_{i,t}| > h_{i,t}$$
 *
 *  Minimum actionable notional:
 *    $$|N_{i,t}| \ge N^{\min}_t$$
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { induceTrigger } from '../src/trader/signals.ts';
import { buildDecisionVector } from '../src/trader/optimizer.ts';

test('§6 no-trade band h = (c / (σ²⁻ + ε))^(1/3)', () => {
  const c = 0.001;
  const rvDown = 0.008;
  const h = induceTrigger(c, rvDown);
  const expected = Math.cbrt(c / Math.max(rvDown, 1e-9));
  assert.ok(
    Math.abs(h - expected) < 1e-12,
    `trigger=${h} should match cbrt(c/σ²⁻)=${expected}`,
  );
});

test('§6 trigger shrinks as volatility increases', () => {
  const c = 0.001;
  const hLowVol = induceTrigger(c, 0.002);
  const hHighVol = induceTrigger(c, 0.02);
  assert.ok(
    hHighVol < hLowVol,
    `higher vol should narrow band: h(lowVol)=${hLowVol} > h(highVol)=${hHighVol}`,
  );
});

test('§6 trigger grows with transaction cost', () => {
  const rv = 0.01;
  const hLowCost = induceTrigger(0.0005, rv);
  const hHighCost = induceTrigger(0.005, rv);
  assert.ok(
    hHighCost > hLowCost,
    `higher cost should widen band: h(highCost)=${hHighCost} > h(lowCost)=${hLowCost}`,
  );
});

test('§6 trigger is finite even for near-zero volatility (ε floor)', () => {
  const h = induceTrigger(0.001, 0);
  assert.ok(Number.isFinite(h), `trigger should be finite even at zero vol, got ${h}`);
  assert.ok(h > 0, `trigger should be positive, got ${h}`);
});

test('§6 trade condition: |w* - w| > h triggers rebalance', () => {
  const signal = { symbol: 'BTC-USD', trigger: 0.05 };
  const decision = buildDecisionVector({
    signal,
    targetWeight: 0.40,
    currentWeight: 0.30,
  });
  assert.ok(decision.shouldTrade, 'deviation 0.10 > trigger 0.05 should trade');
});

test('§6 trade condition: |w* - w| ≤ h suppresses rebalance', () => {
  const signal = { symbol: 'BTC-USD', trigger: 0.15 };
  const decision = buildDecisionVector({
    signal,
    targetWeight: 0.35,
    currentWeight: 0.30,
  });
  assert.ok(!decision.shouldTrade, 'deviation 0.05 ≤ trigger 0.15 should not trade');
});

test('§6 decision vector captures notional direction', () => {
  const signal = { symbol: 'ETH-USD', trigger: 0.01 };

  const buyDecision = buildDecisionVector({
    signal,
    targetWeight: 0.30,
    currentWeight: 0.10,
  });
  assert.ok(buyDecision.deviation > 0, 'buy direction should have positive deviation');

  const sellDecision = buildDecisionVector({
    signal,
    targetWeight: 0.05,
    currentWeight: 0.30,
  });
  assert.ok(sellDecision.deviation < 0, 'sell direction should have negative deviation');
});
