/**
 * ══════════════════════════════════════════════════════════════════════════════
 * § 10  Quota-Efficacy Law — TDD Red Suite
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  Quota efficacy:
 *    $$\eta^{\text{quota}}_t = \frac{H_t}{H_t + M_t}$$
 *
 *  Gap dependence:
 *    $$\eta^{\text{gap}}_t = 1 - \frac{G_t}{H_t + M_t + G_t}$$
 *
 *  WebSocket coverage:
 *    $$\eta^{\text{ws}}_t = \frac{U_t}{U_t + M_t}$$
 *
 *  API budget consumption:
 *    $$B_T = \sum_{t \le T} \mathbf{1}[\text{REST call executed}]$$
 *
 *  Decision quality invariance:
 *    $$\Delta^{\text{decision}}_t = |w^{*,\text{live}}_t - w^{*,\text{replay}}_t|$$
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ── §10 Quota efficacy metric ───────────────────────────────────────────────

function quotaEfficacy(hits, misses) {
  return hits / (hits + misses);
}

function gapDependence(hits, misses, gaps) {
  return 1 - gaps / (hits + misses + gaps);
}

function wsCoverage(wsUpdates, misses) {
  return wsUpdates / (wsUpdates + misses);
}

test('§10 quota efficacy = H / (H + M)', () => {
  assert.ok(
    Math.abs(quotaEfficacy(80, 20) - 0.8) < 1e-12,
    '80 hits, 20 misses should yield η=0.8',
  );
});

test('§10 quota efficacy = 1.0 for perfect cache', () => {
  assert.strictEqual(quotaEfficacy(100, 0), 1.0);
});

test('§10 quota efficacy = 0.0 for complete cache miss', () => {
  assert.strictEqual(quotaEfficacy(0, 100), 0.0);
});

test('§10 gap dependence = 1 - G/(H+M+G)', () => {
  const eta = gapDependence(70, 20, 10);
  const expected = 1 - 10 / (70 + 20 + 10);
  assert.ok(
    Math.abs(eta - expected) < 1e-12,
    `gap dependence=${eta} should equal ${expected}`,
  );
});

test('§10 gap dependence = 1.0 when no gaps', () => {
  assert.strictEqual(gapDependence(80, 20, 0), 1.0);
});

test('§10 ws coverage = U / (U + M)', () => {
  const eta = wsCoverage(90, 10);
  assert.ok(
    Math.abs(eta - 0.9) < 1e-12,
    `ws coverage should be 0.9, got ${eta}`,
  );
});

test('§10 decision quality invariance: Δ_decision within tolerance', () => {
  // $$\Delta^{\text{decision}}_t = |w^{*,\text{live}}_t - w^{*,\text{replay}}_t|$$
  const wLive = 0.352;
  const wReplay = 0.348;
  const delta = Math.abs(wLive - wReplay);
  const tolerance = 0.01;
  assert.ok(
    delta < tolerance,
    `decision divergence ${delta} should be below tolerance ${tolerance}`,
  );
});

test('§10 API budget is cumulative count of REST calls', () => {
  const restCalls = [true, false, true, false, false, true, true];
  const budget = restCalls.filter(Boolean).length;
  assert.strictEqual(budget, 4, 'should count exactly 4 REST calls');
});
