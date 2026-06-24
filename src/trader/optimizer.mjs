import { clamp, EPSILON } from '../lib/math.mjs';

export function derivePortfolioTargets({ signals, reinvestPct, maxPositionPct }) {
  const scored = signals.map((signal) => {
    const positiveKelly = Math.max(0, signal.rawKelly);
    const systemicPenalty = 1 - Math.min(0.99, signal.tailDependence);
    const regimeBoost = 1 + Math.max(-0.5, Math.min(0.5, signal.regime.momentum * 0.15));
    const score = positiveKelly * systemicPenalty * regimeBoost;
    return {
      symbol: signal.symbol,
      score: Math.max(0, score),
    };
  });

  const totalScore = scored.reduce((sum, item) => sum + item.score, 0);
  const weights = new Map();

  for (const item of scored) {
    const normalized = totalScore > EPSILON ? item.score / totalScore : 0;
    const bounded = clamp(reinvestPct * normalized, 0, maxPositionPct);
    weights.set(item.symbol, bounded);
  }

  return weights;
}

export function buildDecisionVector({ signal, targetWeight, currentWeight }) {
  const deviation = targetWeight - currentWeight;
  return {
    symbol: signal.symbol,
    currentWeight,
    targetWeight,
    deviation,
    trigger: signal.trigger,
    shouldTrade: Math.abs(deviation) > signal.trigger,
  };
}