// L2: Edge Decomposition (TODO item 2)
// Every order must persist: grossEdgeBps, costBps, uncertaintyBps, netEdgeBps.
// Gate: no order if netEdgeBps <= 0 (or below minEdgeBps override).

import { EPSILON } from '../lib/math.ts';

export type EdgeDecompositionInput = {
  effectiveDrift?: number;
  spread?: number;
  feeRate?: number;
  slippage?: number;
  kalmanUncertainty?: number;
  signalDisagreement?: number;
  cacheQuality?: number;
  minEdgeBps?: number;
};

export type EdgeDecomposition = {
  grossEdgeBps: number;
  costBps: number;
  uncertaintyBps: number;
  netEdgeBps: number;
  passesGate: boolean;
};

/** Fraction (0.01 = 1%) → basis points (100). */
export function fractionToBps(fraction: number): number {
  return fraction * 10_000;
}

/** Basis points (100) → fraction (0.01 = 1%). */
export function bpsToFraction(bps: number): number {
  return bps / 10_000;
}

/**
 * Cache quality → bps penalty. Perfect cache (1.0) = 0 penalty.
 * Degrades linearly to a floor at cacheQuality=0.1 (≈ 0.9 * 10 bps penalty).
 */
function cacheQualityPenaltyBps(cacheQuality: number): number {
  if (!Number.isFinite(cacheQuality)) return 9;
  const q = Math.min(1, Math.max(0.1, cacheQuality));
  return (1 - q) * 10;
}

/**
 * Computes the full edge stack for a candidate order.
 *
 *   grossEdgeBps    = |effectiveDrift| expressed in bps
 *   costBps         = spread + fee + slippage (each in fraction → bps)
 *   uncertaintyBps  = kalmanUncertainty + signalDisagreement + cachePenalty
 *   netEdgeBps      = grossEdgeBps - costBps - uncertaintyBps
 *
 * `effectiveDrift` is signed; gross edge uses magnitude because both
 * long (positive drift) and short-via-reversion (negative drift) carry
 * expected PnL — direction is resolved upstream by the archetype layer.
 *
 * passesGate is true iff netEdgeBps > 0 (or >= minEdgeBps when supplied).
 */
export function computeEdgeDecomposition({
  effectiveDrift = 0,
  spread = 0,
  feeRate = 0,
  slippage = 0,
  kalmanUncertainty = 0,
  signalDisagreement = 0,
  cacheQuality = 1,
  minEdgeBps = 0,
}: EdgeDecompositionInput): EdgeDecomposition {
  const grossEdgeBps = Math.abs(fractionToBps(effectiveDrift));
  const costBps = fractionToBps(spread) + fractionToBps(feeRate) + fractionToBps(slippage);
  const uncertaintyBps =
    fractionToBps(Math.abs(kalmanUncertainty)) +
    fractionToBps(Math.abs(signalDisagreement)) +
    cacheQualityPenaltyBps(cacheQuality);

  const netEdgeBps = grossEdgeBps - costBps - uncertaintyBps;
  const passesGate = netEdgeBps > (minEdgeBps - EPSILON);

  return {
    grossEdgeBps,
    costBps,
    uncertaintyBps,
    netEdgeBps,
    passesGate,
  };
}
