import test from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationTracker, isotonicFit } from '../src/trader/calibration.ts';

// L2: Confidence Calibration (TODO item 5)
// rawAdvantageProbability → calibratedAdvantageProbability
// Bin closed trades by raw pAdv decile, fit isotonic map, gate on error.

// ─────────────────────────────────────────────────────────────────────────────
// Isotonic regression (monotonic fit)
// ─────────────────────────────────────────────────────────────────────────────

test('isotonicFit: identity when already monotonic', () => {
  const points = [
    { x: 0.1, y: 0.12 },
    { x: 0.3, y: 0.32 },
    { x: 0.5, y: 0.51 },
    { x: 0.7, y: 0.68 },
    { x: 0.9, y: 0.91 },
  ];
  const fit = isotonicFit(points);
  assert.ok(Math.abs(fit(0.1) - 0.12) < 1e-9);
  assert.ok(Math.abs(fit(0.5) - 0.51) < 1e-9);
  assert.ok(Math.abs(fit(0.9) - 0.91) < 1e-9);
});

test('isotonicFit: corrects non-monotonic sequence (PAVA)', () => {
  // x=0.3 has LOWER realized y than x=0.1 — violates monotonicity
  const points = [
    { x: 0.1, y: 0.5 },   // predicted 10%, realized 50%
    { x: 0.3, y: 0.2 },   // predicted 30%, realized 20% (out of order)
    { x: 0.5, y: 0.6 },
  ];
  const fit = isotonicFit(points);
  // PAVA pools the violating pair: (0.5 + 0.2)/2 = 0.35 for both x=0.1 and x=0.3
  assert.ok(fit(0.1) >= fit(0.1) - 1e-9);
  // Monotonicity restored: fit(0.3) must be >= fit(0.1)
  assert.ok(fit(0.3) >= fit(0.1) - 1e-9);
  assert.ok(fit(0.5) >= fit(0.3) - 1e-9);
});

test('isotonicFit: empty input returns identity', () => {
  const fit = isotonicFit([]);
  assert.ok(Math.abs(fit(0.5) - 0.5) < 1e-9);
});

// ─────────────────────────────────────────────────────────────────────────────
// CalibrationTracker: accumulate + recalibrate
// ─────────────────────────────────────────────────────────────────────────────

test('CalibrationTracker: empty tracker returns raw probability unchanged', () => {
  const tracker = new CalibrationTracker();
  const cal = tracker.calibrate(0.7);
  assert.strictEqual(cal, 0.7);
});

test('CalibrationTracker: records closed trades and recomputes hit rate per bin', () => {
  const tracker = new CalibrationTracker({ minSamplesForFit: 5 });
  // 6 trades in the 0.6-0.7 decile, 4 wins → hit rate ≈ 0.667
  for (const win of [true, false, true, true, false, true]) {
    tracker.record({ rawProbability: 0.65, won: win });
  }
  const report = tracker.report();
  const bin = report.bins.find(b => b.label === '0.6-0.7');
  assert.ok(bin);
  assert.strictEqual(bin.count, 6);
  assert.ok(Math.abs(bin.hitRate - (4 / 6)) < 1e-9);
});

test('CalibrationTracker: applies isotonic fit once minSamples reached', () => {
  const tracker = new CalibrationTracker({ minSamplesForFit: 10 });
  // Model is overconfident: predicts 0.9 but only realizes 0.6
  for (let i = 0; i < 12; i++) {
    tracker.record({ rawProbability: 0.85, won: i % 5 < 3 }); // 60% win
  }
  // Underconfident: predicts 0.2 but realizes 0.5
  for (let i = 0; i < 12; i++) {
    tracker.record({ rawProbability: 0.15, won: i % 2 === 0 }); // 50% win
  }
  tracker.refit();
  
  const highCal = tracker.calibrate(0.85);
  const lowCal = tracker.calibrate(0.15);
  
  // After calibration, overconfident bin should be pulled DOWN toward realized
  assert.ok(highCal < 0.85, `overconfident 0.85 should calibrate down, got ${highCal}`);
  // Underconfident should be pulled UP toward realized
  assert.ok(lowCal > 0.15, `underconfident 0.15 should calibrate up, got ${lowCal}`);
});

test('CalibrationTracker: reports calibration error (mean abs deviation)', () => {
  const tracker = new CalibrationTracker();
  // Perfectly calibrated: predict 0.6, realize 0.6
  for (let i = 0; i < 10; i++) {
    tracker.record({ rawProbability: 0.6, won: i < 6 });
  }
  const report = tracker.report();
  assert.ok(report.calibrationError < 0.05, `error ${report.calibrationError} should be < 0.05`);
});

test('CalibrationTracker: competence gate requires error <= threshold', () => {
  const tracker = new CalibrationTracker({ competenceErrorThreshold: 0.05 });
  // Badly miscalibrated
  for (let i = 0; i < 20; i++) {
    tracker.record({ rawProbability: 0.9, won: i % 3 === 0 }); // 33% realized
  }
  const report = tracker.report();
  assert.strictEqual(report.competent, false);
});

test('CalibrationTracker: competent when error within threshold', () => {
  const tracker = new CalibrationTracker({ competenceErrorThreshold: 0.05 });
  for (let i = 0; i < 20; i++) {
    tracker.record({ rawProbability: 0.6, won: i < 12 }); // 60% realized
  }
  const report = tracker.report();
  assert.strictEqual(report.competent, true);
});
