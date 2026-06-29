import test from 'node:test';
import assert from 'node:assert/strict';
import { pearsonCorrelation, OrthogonalityAudit } from '../src/trader/orthogonality.ts';

// L2: Signal Orthogonality Audit (TODO item 4)
// Rolling pairwise correlation matrix, flag |ρ| > 0.7, residualize redundant signals.

// ─────────────────────────────────────────────────────────────────────────────
// Pearson correlation
// ─────────────────────────────────────────────────────────────────────────────

test('pearsonCorrelation: perfect positive = 1', () => {
  const r = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  assert.ok(Math.abs(r - 1) < 1e-9);
});

test('pearsonCorrelation: perfect negative = -1', () => {
  const r = pearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
  assert.ok(Math.abs(r - (-1)) < 1e-9);
});

test('pearsonCorrelation: uncorrelated ≈ 0', () => {
  const r = pearsonCorrelation([1, -1, 1, -1, 1], [1, 1, -1, -1, 1]);
  assert.ok(Math.abs(r) < 0.5);
});

test('pearsonCorrelation: mismatched lengths returns null', () => {
  const r = pearsonCorrelation([1, 2, 3], [1, 2]);
  assert.strictEqual(r, null);
});

test('pearsonCorrelation: constant series returns null (undefined correlation)', () => {
  const r = pearsonCorrelation([5, 5, 5, 5], [1, 2, 3, 4]);
  assert.strictEqual(r, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// OrthogonalityAudit: rolling correlation matrix + redundancy flags
// ─────────────────────────────────────────────────────────────────────────────

test('OrthogonalityAudit: empty audit returns no correlations', () => {
  const audit = new OrthogonalityAudit({ windowSize: 50, redundancyThreshold: 0.7 });
  const report = audit.report();
  assert.strictEqual(report.correlations.length, 0);
  assert.strictEqual(report.redundantPairs.length, 0);
});

test('OrthogonalityAudit: records signal components and computes pairwise correlations', () => {
  const audit = new OrthogonalityAudit({ windowSize: 50, redundancyThreshold: 0.7 });
  for (let i = 0; i < 20; i++) {
    audit.record({
      obi: i * 0.1,
      innovationZ: i * 0.2,   // perfectly correlated with obi
    });
  }
  const report = audit.report();
  const corr = report.correlations.find(c => c.pair.includes('obi') && c.pair.includes('innovationZ'));
  assert.ok(corr);
  assert.ok(Math.abs(corr.rho - 1) < 1e-9);
});

test('OrthogonalityAudit: flags pairs above redundancy threshold', () => {
  const audit = new OrthogonalityAudit({ windowSize: 50, redundancyThreshold: 0.7 });
  for (let i = 0; i < 20; i++) {
    audit.record({
      obi: i,
      innovationZ: i * 2,     // ρ = 1, redundant
      tailDependence: (i % 3), // uncorrelated
    });
  }
  const report = audit.report();
  assert.ok(report.redundantPairs.some(p => p.pair.includes('obi') && p.pair.includes('innovationZ')));
  assert.ok(!report.redundantPairs.some(p => p.pair.includes('tailDependence')));
});

test('OrthogonalityAudit: rolling window evicts oldest records', () => {
  const audit = new OrthogonalityAudit({ windowSize: 10, redundancyThreshold: 0.7 });
  // First 10: obi and innovationZ perfectly correlated
  for (let i = 0; i < 10; i++) {
    audit.record({ obi: i, innovationZ: i });
  }
  // Next 10: anti-correlated
  for (let i = 0; i < 10; i++) {
    audit.record({ obi: i, innovationZ: 10 - i });
  }
  const report = audit.report();
  const corr = report.correlations.find(c => c.pair.includes('obi') && c.pair.includes('innovationZ'));
  // Only the last 10 (anti-correlated) should count → negative rho
  assert.ok(corr.rho < 0, `expected negative after window eviction, got ${corr.rho}`);
});

test('OrthogonalityAudit: residualize removes linear dependence', () => {
  const audit = new OrthogonalityAudit({ windowSize: 50, redundancyThreshold: 0.7 });
  // innovationZ = 2 * obi + small noise → strong linear dependence
  for (let i = 0; i < 30; i++) {
    audit.record({ obi: i, innovationZ: 2 * i + 0.001 * (i % 3) });
  }
  const residual = audit.residualize({ target: 'innovationZ', against: 'obi' });
  assert.ok(residual.beta > 1.5 && residual.beta < 2.5, `beta ≈ 2, got ${residual.beta}`);
  
  // Correlation of residual with obi should be ~0
  const corr = pearsonCorrelation(residual.residuals, audit._series('obi').slice(-residual.residuals.length));
  assert.ok(Math.abs(corr) < 0.3, `residual should be decorrelated, got ρ=${corr}`);
});
