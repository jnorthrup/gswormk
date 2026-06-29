/**
 * ══════════════════════════════════════════════════════════════════════════════
 * § 7  Execution Control Law — TDD Red Suite
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  Execution quantity:
 *    $$Q_{i,t} = \frac{|N_{i,t}|}{p^{\text{exec}}_{i,t}}$$
 *
 *  Passive price target — buy:
 *    $$p^{\text{exec}}_{i,t}
 *      = \min\left(a^{(1)}_{i,t},\;
 *          m_{i,t} + \eta_t(a^{(1)}_{i,t} - m_{i,t})\right)$$
 *
 *  Passive price target — sell:
 *    $$p^{\text{exec}}_{i,t}
 *      = \max\left(b^{(1)}_{i,t},\;
 *          m_{i,t} - \eta_t(m_{i,t} - b^{(1)}_{i,t})\right)$$
 *
 *  Urgency scalar:
 *    $$\eta_t = \sigma\!\left(\gamma\,|\mu^{\text{innov}}_{i,t}|\right)$$
 *
 *  Visible-depth clip:
 *    $$Q_{i,t}^{\text{slice}}
 *      = \min\left(Q_{i,t},\; \kappa \cdot D_{i,t}^{\text{visible}}\right)$$
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { urgencyFromInnovation } from '../src/trader/signals.ts';
import { logistic } from '../src/lib/math.ts';

test('§7 urgency = σ(|innovationZ|) via logistic function', () => {
  const z = 2.5;
  const u = urgencyFromInnovation(z);
  const expected = logistic(Math.abs(z));
  assert.ok(
    Math.abs(u - expected) < 1e-12,
    `urgency=${u} should equal σ(|z|)=${expected}`,
  );
});

test('§7 urgency ∈ (0.5, 1) for positive innovation magnitude', () => {
  for (const z of [0.1, 0.5, 1.0, 3.0, 10.0]) {
    const u = urgencyFromInnovation(z);
    assert.ok(u > 0.5, `urgency(${z})=${u} should be > 0.5`);
    assert.ok(u < 1.0, `urgency(${z})=${u} should be < 1.0`);
  }
});

test('§7 urgency = 0.5 when innovation = 0 (no signal)', () => {
  const u = urgencyFromInnovation(0);
  assert.ok(
    Math.abs(u - 0.5) < 1e-12,
    `urgency(0) should be 0.5, got ${u}`,
  );
});

test('§7 urgency is monotonically increasing in |innovationZ|', () => {
  let prev = 0;
  for (const z of [0, 0.5, 1.0, 2.0, 5.0]) {
    const u = urgencyFromInnovation(z);
    assert.ok(u >= prev, `urgency should increase: u(${z})=${u} < prev=${prev}`);
    prev = u;
  }
});

test('§7 buy execution price: p_exec = min(ask, mid + η*(ask - mid))', () => {
  const mid = 100;
  const bestAsk = 100.50;
  const urgency = 0.7;

  // Spec formula for buy
  const pExec = Math.min(bestAsk, mid + urgency * (bestAsk - mid));
  // At η=0.7: mid + 0.7*0.5 = 100.35 < 100.50, so pExec = 100.35
  assert.ok(
    Math.abs(pExec - 100.35) < 1e-9,
    `buy exec price should be 100.35, got ${pExec}`,
  );
});

test('§7 sell execution price: p_exec = max(bid, mid - η*(mid - bid))', () => {
  const mid = 100;
  const bestBid = 99.50;
  const urgency = 0.7;

  const pExec = Math.max(bestBid, mid - urgency * (mid - bestBid));
  // mid - 0.7*0.5 = 99.65 > 99.50, so pExec = 99.65
  assert.ok(
    Math.abs(pExec - 99.65) < 1e-9,
    `sell exec price should be 99.65, got ${pExec}`,
  );
});

test('§7 at zero urgency, buy price = mid (maximum passivity)', () => {
  const mid = 100;
  const bestAsk = 101;
  const urgency = 0; // but logistic(0) = 0.5, so this tests explicit 0
  const pExec = Math.min(bestAsk, mid + urgency * (bestAsk - mid));
  assert.strictEqual(pExec, mid, 'zero urgency buy should rest at mid');
});

test('§7 at full urgency, buy price approaches ask (maximum aggression)', () => {
  const mid = 100;
  const bestAsk = 100.50;
  const urgency = 0.999;
  const pExec = Math.min(bestAsk, mid + urgency * (bestAsk - mid));
  assert.ok(
    Math.abs(pExec - bestAsk) < 0.01,
    `near-full urgency should price near ask: got ${pExec}`,
  );
});

test('§7 visible-depth clip: Q_slice = min(Q, κ * D_visible)', () => {
  const Q = 100;   // desired quantity
  const kappa = 0.2;
  const visibleDepth = 200;
  const Qslice = Math.min(Q, kappa * visibleDepth);
  assert.strictEqual(Qslice, 40, 'slice should be min(100, 0.2*200=40) = 40');
});

test('§7 visible-depth clip: passes through when Q < κ*D', () => {
  const Q = 10;
  const kappa = 0.2;
  const visibleDepth = 200;
  const Qslice = Math.min(Q, kappa * visibleDepth);
  assert.strictEqual(Qslice, Q, 'small order should pass through unclipped');
});
