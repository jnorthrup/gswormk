import { clamp, downsideSemivariance, EPSILON, logistic, quantile, safeDivide, variance } from '../lib/math.ts';
import { granularityMs } from '../lib/time.ts';

type BookLevel = {
  price: number;
  size: number;
};

type KalmanState = {
  x: number;
  p: number;
};

type RsiHistoryRow = {
  updatedAt: string;
  rsi1d: number | null;
  rsi1h: number | null;
};

type Candle = {
  start: string;
  open: number;
  high: number;
  low: number;
  close: number | string;
  volume: number;
};

export type CandleLike = {
  start: string;
  close: number | string;
};

type TimescaleSample = {
  window: number;
  drift: number;
  totalReturn: number;
  downside: number;
  rewardRisk: number;
};

export type TimescaleAttention = {
  supportCount: number;
  preferredWindow: number | null;
  windowSigma: number | null;
  weightedDrift: number;
  weightedRewardRisk: number;
  attentionMultiplier: number;
  timeDilation: number;
  weights: number[];
  samples: TimescaleSample[];
  attentionScore: number;
  advantageProbability: number;
  denoisedRsi: number | null;
  triggerMultiplier: number;
  kellyMultiplier: number;
};

type ValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

export function computeObi(bids: readonly BookLevel[], asks: readonly BookLevel[], mid: number, shellBps = 5): number {
  const bidCutoff = mid * (1 - (shellBps / 10_000));
  const askCutoff = mid * (1 + (shellBps / 10_000));
  const bidVolume = bids.filter((level) => level.price >= bidCutoff).reduce((sum, level) => sum + level.size, 0);
  const askVolume = asks.filter((level) => level.price <= askCutoff).reduce((sum, level) => sum + level.size, 0);
  return safeDivide(bidVolume - askVolume, bidVolume + askVolume + EPSILON, 0);
}

export function kalmanStep({ x, p }: KalmanState, observedPrice: number, q: number, r: number): {
  state: KalmanState;
  innovation: number;
  innovationZ: number;
  innovationVariance: number;
} {
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

export function computeRsiSplatAndKalman({
  statsHistory,
  targetTimestamp,
  sigmaSeconds,
  kalmanState = { x: 50, p: 10 },
  q = 0.1,
  r = 1,
}: {
  statsHistory: readonly RsiHistoryRow[];
  targetTimestamp: string;
  sigmaSeconds: number;
  kalmanState?: KalmanState;
  q?: number;
  r?: number;
}): { rsi: number | null; state: KalmanState; innovation?: number; innovationZ?: number } {
  if (statsHistory.length === 0) return { rsi: null, state: kalmanState };

  const targetMs = Date.parse(targetTimestamp);
  const sigmaMs = sigmaSeconds * 1000;

  let weightSum = 0;
  let valueSum = 0;

  for (const row of statsHistory) {
    const rowMs = Date.parse(row.updatedAt);
    const diff = targetMs - rowMs;
    if (Math.abs(diff) <= 3 * sigmaMs) {
      const weight = Math.exp(-(diff * diff) / (2 * sigmaMs * sigmaMs));
      const rsiValue = row.rsi1d !== null ? row.rsi1d : row.rsi1h;
      if (rsiValue !== null && !Number.isNaN(rsiValue)) {
        valueSum += rsiValue * weight;
        weightSum += weight;
      }
    }
  }

  const splatRsi = weightSum > 0 ? valueSum / weightSum : null;

  if (splatRsi === null) {
    return { rsi: null, state: kalmanState };
  }

  const result = kalmanStep(kalmanState, splatRsi, q, r);
  return { rsi: result.state.x, state: result.state, innovation: result.innovation, innovationZ: result.innovationZ };
}

export function computeTimescaleAttention({
  candles,
  windows,
  preferredWindow,
  windowSigma,
  attentionStrength = 0.15,
}: {
  candles: readonly CandleLike[];
  windows: number[];
  preferredWindow: number | null;
  windowSigma: number | null;
  attentionStrength?: number;
}): TimescaleAttention {
  const samples: TimescaleSample[] = [];
  for (const window of windows) {
    if (candles.length < window + 1) continue;
    const slice = candles.slice(0, window + 1);
    const firstClose = Number(slice[0]!.close);
    const lastClose = Number(slice[window]!.close);
    if (!firstClose || !lastClose) continue;
    const totalReturn = (firstClose / lastClose) - 1;
    const returns: number[] = [];
    for (let i = 0; i < window; i++) {
      const prev = Number(slice[i]!.close);
      const next = Number(slice[i + 1]!.close);
      if (prev && next && next > 0) returns.push(prev / next - 1);
    }
    const downside = downsideSemivariance(returns);
    const rewardRisk = downside > 0 ? totalReturn / Math.sqrt(downside) : 0;
    samples.push({ window, drift: totalReturn, totalReturn, downside, rewardRisk });
  }

  const weights = samples.map((s, i) => {
    if (preferredWindow !== null && windowSigma !== null) {
      const dist = Math.abs(s.window - preferredWindow);
      return Math.exp(-0.5 * (dist / windowSigma) ** 2);
    }
    return 1 / (i + 1);
  });

  const weightSum = weights.reduce((a, b) => a + b, 0);
  const normalizedWeights = weightSum > 0 ? weights.map(w => w / weightSum) : weights;

  const weightedDrift = samples.reduce((sum, s, i) => sum + s.drift * (normalizedWeights[i] ?? 0), 0);
  const weightedRewardRisk = samples.reduce((sum, s, i) => sum + s.rewardRisk * (normalizedWeights[i] ?? 0), 0);

  const supportCount = samples.filter(s => s.drift > 0).length;
  const attentionMultiplier = 1 + attentionStrength * weightedRewardRisk;
  const timeDilation = 1 + attentionStrength * supportCount;

  return {
    supportCount,
    preferredWindow,
    windowSigma,
    weightedDrift,
    weightedRewardRisk,
    attentionMultiplier,
    timeDilation,
    weights: normalizedWeights,
    samples,
    attentionScore: weightedRewardRisk,
    advantageProbability: 0.5,
    denoisedRsi: null,
    triggerMultiplier: 1,
    kellyMultiplier: 1,
  };
}

export function computeConfidenceScalers(args: { candles: readonly CandleLike[]; windows: number[]; preferredWindow: number | null; windowSigma: number | null; attentionStrength?: number }): TimescaleAttention {
  return computeTimescaleAttention(args);
}

/**
 * Einstein attention: combines RSI regime detection with timescale attention
 * to tilt Kelly and trigger in the direction supported by denoised RSI
 */
export function computeEinsteinAttention(params: {
  effectiveDrift: number;
  dominantRegime: 'momentum' | 'meanReversion';
  rsiInnovationZ: number;
  timescaleAttention: TimescaleAttention;
  alignment: number;
  cacheQuality: number;
  denoisedRsi: number;
}): {
  advantageProbability: number;
  kellyMultiplier: number;
  triggerMultiplier: number;
} {
  const { effectiveDrift, dominantRegime, rsiInnovationZ, timescaleAttention, alignment, cacheQuality, denoisedRsi } = params;
  
  // Base probability from drift
  const baseProbability = effectiveDrift > 0 ? 0.6 : 0.4;
  
  // RSI overbought/oversold adjustment - more sensitive thresholds
  let rsiAdjustment = 0;
  if (denoisedRsi >= 60) {
    // Overbought - bearish for momentum
    rsiAdjustment = -0.2 * (denoisedRsi - 60) / 40;
  } else if (denoisedRsi <= 40) {
    // Oversold - bullish for mean reversion
    rsiAdjustment = 0.2 * (40 - denoisedRsi) / 40;
  }
  
  // Regime alignment: mean reversion prefers oversold, momentum prefers overbought
  let regimeAdjustment = 0;
  if (dominantRegime === 'meanReversion') {
    regimeAdjustment = denoisedRsi < 45 ? 0.15 : denoisedRsi > 55 ? -0.15 : 0;
  } else {
    regimeAdjustment = denoisedRsi > 55 ? 0.15 : denoisedRsi < 45 ? -0.15 : 0;
  }
  
  // Timescale attention boost
  const attentionBoost = Math.min(timescaleAttention.attentionMultiplier - 1, 0.2);
  
  // Cache quality penalty
  const cachePenalty = (1 - cacheQuality) * 0.1;
  
  // Final advantage probability
  const advantageProbability = Math.max(0.1, Math.min(0.9, baseProbability + rsiAdjustment + regimeAdjustment + attentionBoost - cachePenalty));
  
  // Kelly multiplier: higher when aligned, lower when misaligned
  const kellyMultiplier = advantageProbability > 0.5 ? 1 + (advantageProbability - 0.5) * 0.5 : 1 - (0.5 - advantageProbability) * 0.3;
  
  // Trigger multiplier: tighter (lower) when probability is high
  const triggerMultiplier = advantageProbability > 0.5 ? 1 - (advantageProbability - 0.5) * 0.3 : 1 + (0.5 - advantageProbability) * 0.5;
  
  return {
    advantageProbability,
    kellyMultiplier,
    triggerMultiplier,
  };
}

export function computeTailDependence(assetReturns: readonly number[], btcReturns: readonly number[], q = 0.05): number {
  if (assetReturns.length === 0 || btcReturns.length === 0) return 0;
  // Require minimum sample size per spec
  if (assetReturns.length < 20 || btcReturns.length < 20) return 0;
  const n = Math.min(assetReturns.length, btcReturns.length);
  const a = assetReturns.slice(-n);
  const b = btcReturns.slice(-n);
  const qA = quantile([...a].sort((x, y) => x - y), q);
  const qB = quantile([...b].sort((x, y) => x - y), q);
  let joint = 0;
  let bTail = 0;
  for (let i = 0; i < n; i++) {
    const bVal = b[i]!;
    const aVal = a[i]!;
    if (bVal <= qB) {
      bTail++;
      if (aVal <= qA) joint++;
    }
  }
  return bTail > 0 ? joint / bTail : 0;
}

export function computeDownsideSemivariance(returns: readonly number[]): number {
  return downsideSemivariance(returns);
}

export function computeEffectiveSpread(bestBid: number, bestAsk: number, feeRate = 0.0006, slippagePenalty = 0.0002): number {
  const mid = (bestBid + bestAsk) / 2;
  const spread = (bestAsk - bestBid) / mid;
  return spread / 2 + feeRate + slippagePenalty;
}

export function induceTrigger(transactionCost: number, downsideVariance: number): number {
  const eps = 1e-9;
  // Apply eps inside division only to avoid divide by zero, then floor result
  const result = Math.cbrt(transactionCost / (downsideVariance + eps));
  return Math.max(result, eps);
}

export function alignmentScore(live: { drift: number; rvDown: number; tail: number }, replay: { drift: number; rvDown: number; tail: number }): number {
  const alpha1 = 0.5;
  const alpha2 = 0.3;
  const alpha3 = 0.2;
  const eps = 1e-9;
  
  // Normalize deltas by replay values per spec formula
  const dDrift = Math.abs(live.drift - replay.drift) / (Math.abs(replay.drift) + eps);
  const dRv = Math.abs(live.rvDown - replay.rvDown) / (Math.abs(replay.rvDown) + eps);
  const dTail = Math.abs(live.tail - replay.tail) / (Math.abs(replay.tail) + eps);
  const d = alpha1 * dDrift + alpha2 * dRv + alpha3 * dTail;
  
  return Math.exp(-d);
}

export function quotaQuality({ cacheHit, gapCount }: { cacheHit: boolean; gapCount: number }): number {
  if (!cacheHit) return 0.3;
  return Math.max(0.1, 1 - gapCount * 0.1);
}

export function synthesizeDrift({ obi, innovationZ, alignment, cacheQuality }: { obi: number; innovationZ: number; alignment: number; cacheQuality: number }): number {
  return (obi + innovationZ) * alignment * cacheQuality;
}

export function induceKelly({ effectiveDrift, rvDown, tailDependence }: { effectiveDrift: number; rvDown: number; tailDependence: number }): number {
  const eps = 1e-9;
  const variance = rvDown + eps;
  const kelly = effectiveDrift / variance * (1 - tailDependence);
  // Allow negative Kelly for short positions, floor at -1
  return Math.max(-1, kelly);
}

/**
 * Uncertainty-aware Kelly with variance-floor guard.
 * Caps Kelly fraction based on uncertainty in drift estimate.
 */
export function uncertaintyAwareKelly(params: {
  effectiveDrift: number;
  rvDown: number;
  tailDependence: number;
  cacheQuality: number;
  confidenceScalers: number;
}): number {
  const { effectiveDrift, rvDown, tailDependence, cacheQuality, confidenceScalers } = params;
  
  // Variance floor: ensure minimum usable variance
  const minVariance = 1e-6;
  const varianceFloor = Math.max(rvDown, minVariance);
  
  // Base Kelly
  let kelly = effectiveDrift / varianceFloor * (1 - tailDependence);
  
  // Apply uncertainty penalty based on cache quality (data freshness)
  const uncertaintyPenalty = Math.max(0.1, cacheQuality);
  kelly *= uncertaintyPenalty;
  
  // Apply confidence scaler penalty (less confidence = smaller bet)
  const confidencePenalty = Math.max(0.1, Math.min(1, confidenceScalers));
  kelly *= confidencePenalty;
  
  // Floor at 0 (no negative Kelly)
  return Math.max(0, kelly);
}

/**
 * Compute portfolio-level correlation between positions.
 * Returns correlation matrix for risk management.
 */
export function computePortfolioCorrelation(positions: Array<{
  symbol: string;
  returns?: number[];
}>): Map<string, Map<string, number>> {
  const correlations = new Map<string, Map<string, number>>();
  const symbols = positions.map(p => p.symbol);
  
  for (const a of symbols) {
    correlations.set(a, new Map());
    for (const b of symbols) {
      const posA = positions.find(p => p.symbol === a);
      const posB = positions.find(p => p.symbol === b);
      
      if (!posA?.returns || !posB?.returns || posA.returns.length < 2) {
        correlations.get(a)!.set(b, 0);
        continue;
      }
      
      const corr = computeCorrelation(posA.returns, posB.returns);
      correlations.get(a)!.set(b, corr);
    }
  }
  
  return correlations;
}

/**
 * Tail risk rules: detect extreme correlation spikes.
 */
export function detectTailRisk(correlationMatrix: Map<string, Map<string, number>>): {
  isTailRisk: boolean;
  maxCorrelation: number;
  highRiskPairs: Array<[string, string]>;
} {
  let maxCorrelation = 0;
  const highRiskPairs: Array<[string, string]> = [];
  const threshold = 0.85;
  
  for (const [a, inner] of correlationMatrix) {
    for (const [b, corr] of inner) {
      if (a === b) continue;
      if (corr > maxCorrelation) maxCorrelation = corr;
      if (corr > threshold) {
        highRiskPairs.push([a, b]);
      }
    }
  }
  
  return {
    isTailRisk: maxCorrelation > 0.9,
    maxCorrelation,
    highRiskPairs,
  };
}

/**
 * Binomial gate: rolling 200-trade proof that strategy beats random (p=0.5).
 * Uses one-sided binomial test with alpha=0.05.
 */
export function binomialGate(wins: number, total: number = 200): {
  passed: boolean;
  pValue: number;
  expectedWins: number;
  actualWins: number;
} {
  const expectedWins = total * 0.5;
  const actualWins = wins;
  
  // One-sided binomial test: P(X >= wins) when X ~ Binomial(n=200, p=0.5)
  // Use normal approximation for large n
  const mean = total * 0.5;
  const stdDev = Math.sqrt(total * 0.5 * 0.5);
  const z = (actualWins - mean) / stdDev;
  
  // One-sided p-value: P(Z >= z)
  const pValue = 1 - normalCDF(z);
  
  return {
    passed: pValue < 0.05 && actualWins > expectedWins,
    pValue,
    expectedWins,
    actualWins,
  };
}

function normalCDF(z: number): number {
  // Approximation of standard normal CDF
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  
  return 0.5 * (1 + sign * y);
}

export function urgencyFromInnovation(innovationZ: number): number {
  return logistic(Math.abs(innovationZ));
}

export function rollingVolatility(returns: readonly number[]): number {
  return variance(returns);
}

export function validateCandle(candle: Candle): ValidationResult {
  const errors: string[] = [];

  if (!candle.open || candle.open <= 0) {
    errors.push('open must be > 0');
  }

  const high = candle.high;
  const low = candle.low;
  const open = candle.open;
  const close = Number(candle.close);

  if (high < Math.max(open, close)) {
    errors.push(`high ${high} must be >= max(open, close) ${Math.max(open, close)}`);
  }

  if (low > Math.min(open, close)) {
    errors.push(`low ${low} must be <= min(open, close) ${Math.min(open, close)}`);
  }

  if (candle.volume < 0) {
    errors.push('volume must be >= 0');
  }

  return errors.length === 0
    ? { valid: true }
    : { valid: false, errors };
}

export function validateCandleSequence(candles: readonly CandleLike[], symbol: string, granularity: string): ValidationResult {
  void symbol;
  void granularity;
  const errors: string[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1]!;
    const curr = candles[i]!;

    const prevTime = Date.parse(prev.start);
    const currTime = Date.parse(curr.start);

    if (currTime <= prevTime) {
      errors.push(`timestamp not monotonic at index ${i}: ${curr.start} <= ${prev.start}`);
    }
  }

  return errors.length === 0
    ? { valid: true }
    : { valid: false, errors };
}

export function computeStaleness(candles: readonly CandleLike[] | null | undefined, granularity: string, nowMs = Date.now()): {
  stale: boolean;
  staleness: number;
  latestTimestamp: number | null;
  ageMs: number;
} {
  if (!candles || candles.length === 0) {
    return { stale: true, staleness: 1, latestTimestamp: null, ageMs: Infinity };
  }

  const sorted = [...candles].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  const latestTimestamp = Date.parse(sorted[0]!.start);
  const ageMs = nowMs - latestTimestamp;

  const gMs = granularityMs(granularity);

  const staleThreshold = 2 * gMs;
  const stale = ageMs > staleThreshold;
  const staleness = Math.min(ageMs / staleThreshold, 1);

  return { stale, staleness, latestTimestamp, ageMs };
}

export function stalenessToCacheQuality(staleness: number): number {
  return Math.max(0.1, 1 - (staleness * 0.9));
}

/**
 * Classify trade archetype based on signal properties.
 * Archetypes:
 * - discount_reversion: mean reversion, buying dips, low RSI
 * - growth_momentum: momentum play, riding trends, high alignment
 * - volatility_defense: low volatility regime, risk-off positioning
 */
export function classifyTradeArchetype(params: {
  regimeMomentum: number;
  regimeMeanReversion: number;
  regimeVolatility: number;
  alignment: number;
  obi: number;
  rsi: number | null;
  tailDependence: number;
}): string {
  const { regimeMomentum, regimeMeanReversion, regimeVolatility, alignment, obi, rsi, tailDependence } = params;

  // Volatility defense: low volatility regime
  if (regimeVolatility < 0.2 && tailDependence < 0.1) {
    return 'volatility_defense';
  }

  // Discount reversion: mean reversion with oversold RSI
  if (regimeMeanReversion > regimeMomentum && (rsi !== null ? rsi < 45 : obi < -0.2)) {
    return 'discount_reversion';
  }

  // Growth momentum: momentum regime with positive alignment
  if (regimeMomentum > regimeMeanReversion && alignment > 0.3 && obi > 0.1) {
    return 'growth_momentum';
  }

  // Default: growth momentum for any positive trend
  if (alignment > 0.2 || obi > 0.3) {
    return 'growth_momentum';
  }

  // Default: discount reversion for any mean reversion
  if (regimeMeanReversion > 0.2 || obi < -0.2) {
    return 'discount_reversion';
  }

  return 'volatility_defense';
}

/**
 * Compute signal orthogonality matrix between archetypes.
 * Returns correlation matrix between different trade archetypes.
 */
export function computeSignalOrthogonality(signals: Array<{
  archetype?: string;
  regimeMomentum?: number;
  regimeMeanReversion?: number;
  alignment?: number;
  obi?: number;
}>): Map<string, Map<string, number>> {
  const archetypeSignals = new Map<string, number[]>();
  
  for (const sig of signals) {
    const archetype = sig.archetype ?? 'unknown';
    const value = sig.alignment ?? sig.obi ?? 0;
    if (!archetypeSignals.has(archetype)) {
      archetypeSignals.set(archetype, []);
    }
    archetypeSignals.get(archetype)!.push(value);
  }

  const correlations = new Map<string, Map<string, number>>();
  const archetypes = [...archetypeSignals.keys()];
  
  for (const a of archetypes) {
    correlations.set(a, new Map());
    for (const b of archetypes) {
      const aVals = archetypeSignals.get(a)!;
      const bVals = archetypeSignals.get(b)!;
      const corr = computeCorrelation(aVals, bVals);
      correlations.get(a)!.set(b, corr);
    }
  }
  
  return correlations;
}
 
function computeCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  
  const aSlice = a.slice(0, n);
  const bSlice = b.slice(0, n);
  
  const meanA = aSlice.reduce((s, v) => s + v, 0) / n;
  const meanB = bSlice.reduce((s, v) => s + v, 0) / n;
  
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = aSlice[i]! - meanA;
    const db = bSlice[i]! - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

/**
 * Calibrate raw advantage probability using historical hit rate.
 * Maps raw pAdv to calibrated probability based on prior signals.
 */
export function calibrateConfidence(params: {
  rawAdvantage: number;
  archetype?: string;
  regime?: string;
  historicalHitRate?: number;
}): number {
  const { rawAdvantage, historicalHitRate } = params;
  
  // Bayesian update: blend raw probability with historical hit rate
  const alpha = 0.7; // weight for raw probability
  const beta = 0.3;  // weight for historical
  
  if (historicalHitRate !== undefined && historicalHitRate > 0) {
    return alpha * rawAdvantage + beta * historicalHitRate;
  }
  
  // Default: use raw with slight pull toward 0.5 (uncertainty penalty)
  return 0.5 * 0.9 + rawAdvantage * 0.1;
}

export { variance };