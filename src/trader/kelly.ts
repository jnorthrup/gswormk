// L3: Uncertainty-aware Kelly with variance-floor guard (TODO item 3)
//
//   kelly = netEdge / (downsideVariance + modelVariance + parameterVariance)
//
// Critical rule: if rvDown is floor-derived because there is insufficient
// negative-return evidence, do NOT treat as low risk — treat as unknown risk.
//
// Gate: if rvDown <= varianceFloor && sampleCount < minRiskSamples → kelly = 0.

import { EPSILON } from '../lib/math.ts';

type KellyDefaults = {
  varianceFloor: number;
  minRiskSamples: number;
  maxKellyFraction: number;
  modelVariance: number;
  parameterVariance: number;
  tailDependence: number;
  sampleCount: number;
};

export type KellySafeInput = Partial<KellyDefaults> & {
  netEdge: number;
  rvDown: number;
};

const DEFAULTS: KellyDefaults = Object.freeze({
  varianceFloor: 1e-9,
  minRiskSamples: 50,
  maxKellyFraction: 1,
  modelVariance: 0,
  parameterVariance: 0,
  tailDependence: 0,
  sampleCount: 0,
});

/**
 * @param args.netEdge             signed net edge fraction (e.g. 0.01 = 100bps)
 * @param args.rvDown              realized downside semivariance (annualized)
 * @param args.modelVariance       Kalman / signal model uncertainty
 * @param args.parameterVariance   walk-forward fold variance
 * @param args.tailDependence      BTC crash co-dependence 0..1
 * @param args.sampleCount         negative-return sample count
 * @param args.minRiskSamples      minimum samples to trust rvDown
 * @param args.varianceFloor       absolute floor for rvDown
 * @param args.maxKellyFraction    hard cap
 */
export function induceKellySafe(args: KellySafeInput): number {
  const {
    netEdge,
    rvDown,
    modelVariance,
    parameterVariance,
    tailDependence,
    sampleCount,
    minRiskSamples,
    varianceFloor,
    maxKellyFraction,
  } = { ...DEFAULTS, ...args };

  // Never short via kelly, never bet on non-positive edge.
  if (!(netEdge > 0)) return 0;

  // Unknown-risk guard: floored variance + thin samples → refuse to size.
  const atFloor = rvDown <= varianceFloor + EPSILON;
  const thin = sampleCount < minRiskSamples;
  if (atFloor && thin) return 0;

  // Crash-contagion kills sizing entirely at λ=1.
  const td = clamp01(tailDependence);
  if (td >= 1 - EPSILON) return 0;

  const denominator = Math.max(
    varianceFloor,
    rvDown + modelVariance + parameterVariance,
  );

  const raw = netEdge / denominator;
  const tailScaled = raw * (1 - td);

  return Math.min(tailScaled, maxKellyFraction);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
