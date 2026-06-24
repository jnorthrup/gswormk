import { downsideSemivariance, EPSILON, logistic, quantile, safeDivide, variance } from '../lib/math.mjs';

export function computeObi(bids, asks, mid, shellBps = 5) {
  const bidCutoff = mid * (1 - (shellBps / 10_000));
  const askCutoff = mid * (1 + (shellBps / 10_000));
  const bidVolume = bids.filter((level) => level.price >= bidCutoff).reduce((sum, level) => sum + level.size, 0);
  const askVolume = asks.filter((level) => level.price <= askCutoff).reduce((sum, level) => sum + level.size, 0);
  return safeDivide(bidVolume - askVolume, bidVolume + askVolume + EPSILON, 0);
}

export function kalmanStep({ x, p }, observedPrice, q, r) {
  const predictedX = x;
  const predictedP = p + q;
  const innovation = observedPrice - predictedX;
  const innovationVariance = predictedP + r;
  const gain = predictedP / innovationVariance;
  const nextX = predictedX + (gain * innovation);
  const nextP = (1 - gain) * predictedP;

  return {
    state: { x: nextX, p: nextP },
    innovation,
    innovationZ: innovation / Math.sqrt(innovationVariance),
    innovationVariance,
  };
}

export function computeTailDependence(assetReturns, btcReturns, q = 0.05) {
  const count = Math.min(assetReturns.length, btcReturns.length);
  if (count < 20) return 0;

  const asset = assetReturns.slice(-count);
  const btc = btcReturns.slice(-count);
  const assetThreshold = quantile([...asset].sort((a, b) => a - b), q);
  const btcThreshold = quantile([...btc].sort((a, b) => a - b), q);

  let btcTailCount = 0;
  let coCrashCount = 0;
  for (let index = 0; index < count; index += 1) {
    if (btc[index] <= btcThreshold) {
      btcTailCount += 1;
      if (asset[index] <= assetThreshold) {
        coCrashCount += 1;
      }
    }
  }

  return safeDivide(coCrashCount, btcTailCount + EPSILON, 0);
}

export function computeDownsideSemivariance(returns) {
  return Math.max(downsideSemivariance(returns), 1e-9);
}

export function computeEffectiveSpread(bestBid, bestAsk, feeRate = 0.0006, slippagePenalty = 0.0002) {
  const mid = (bestBid + bestAsk) / 2;
  return ((bestAsk - bestBid) / mid) / 2 + feeRate + slippagePenalty;
}

export function induceTrigger(transactionCost, downsideVariance) {
  return Math.cbrt(transactionCost / Math.max(downsideVariance, 1e-9));
}

export function alignmentScore(live, replay) {
  const driftDelta = Math.abs(live.drift - replay.drift) / (Math.abs(replay.drift) + 1e-9);
  const varianceDelta = Math.abs(live.rvDown - replay.rvDown) / (Math.abs(replay.rvDown) + 1e-9);
  const tailDelta = Math.abs(live.tail - replay.tail) / (Math.abs(replay.tail) + 1e-9);
  const distance = (0.5 * driftDelta) + (0.3 * varianceDelta) + (0.2 * tailDelta);
  return Math.max(0.2, Math.exp(-Math.min(distance, 4)));
}

export function quotaQuality({ cacheHit, gapCount }) {
  if (!cacheHit) return 0.35;
  return gapCount === 0 ? 1 : 0.65;
}

export function synthesizeDrift({ obi, innovationZ, alignment, cacheQuality }) {
  return (obi + innovationZ) * alignment * cacheQuality;
}

export function induceKelly({ effectiveDrift, rvDown, tailDependence }) {
  return effectiveDrift / ((rvDown * (1 + tailDependence)) + EPSILON);
}

export function urgencyFromInnovation(innovationZ) {
  return logistic(Math.abs(innovationZ));
}

export function rollingVolatility(returns) {
  return variance(returns);
}