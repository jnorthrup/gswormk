import { clamp, EPSILON } from '../lib/math.ts';

export type PortfolioSignal = {
  symbol: string;
  rawKelly: number;
  trigger: number;
};

export type DerivePortfolioTargetsInput = {
  signals: PortfolioSignal[];
  reinvestPct: number;
  maxPositionPct: number;
};

export type DecisionVectorInput = {
  signal: PortfolioSignal;
  targetWeight: number;
  currentWeight: number;
};

export type DecisionVector = {
  symbol: string;
  currentWeight: number;
  targetWeight: number;
  deviation: number;
  trigger: number;
  shouldTrade: boolean;
};

type ScoredSignal = {
  symbol: string;
  score: number;
};

export function derivePortfolioTargets({ signals, reinvestPct, maxPositionPct }: DerivePortfolioTargetsInput): Map<string, number> {
  const scored = signals.map((signal) => {
    const positiveKelly = Math.max(0, signal.rawKelly);
    const score = positiveKelly;
    return {
      symbol: signal.symbol,
      score: Math.max(0, score),
    };
  });

  const totalScore = scored.reduce((sum, item) => sum + item.score, 0);

  if (totalScore <= EPSILON || scored.length === 0) {
    return new Map<string, number>();
  }

  // Waterfilling algorithm with redistribution
  // 1. Start with proportional allocation
  // 2. Cap at maxPositionPct
  // 3. Redistribute excess to uncapped items
  // 4. Repeat until convergence

  const weights = new Map<string, number>();

  // Initial proportional allocation
  for (const item of scored) {
    const normalized = item.score / totalScore;
    const bounded = clamp(reinvestPct * normalized, 0, maxPositionPct);
    weights.set(item.symbol, bounded);
  }

  // Iterative waterfilling with redistribution
  let changed = true;
  let iterations = 0;
  const maxIterations = scored.length * 2;

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations += 1;

    // Find capped items and calculate excess
    let excess = 0;
    const uncappedSymbols: string[] = [];

    for (const [symbol, weight] of weights) {
      if (weight >= maxPositionPct - EPSILON) {
        const item = scored.find((candidate) => candidate.symbol === symbol);
        if (item) {
          const normalized = item.score / totalScore;
          const proportionalWeight = reinvestPct * normalized;
          if (proportionalWeight > maxPositionPct) {
            excess += proportionalWeight - maxPositionPct;
          }
        }
      } else {
        uncappedSymbols.push(symbol);
      }
    }

    // If there's excess and uncapped symbols, redistribute
    if (excess > EPSILON && uncappedSymbols.length > 0) {
      changed = true;

      // Calculate total score of uncapped symbols
      let uncappedTotalScore = 0;
      for (const symbol of uncappedSymbols) {
        const item = scored.find((candidate) => candidate.symbol === symbol);
        if (item) uncappedTotalScore += item.score;
      }

      // Redistribute excess proportionally among uncapped
      for (const symbol of uncappedSymbols) {
        const item = scored.find((candidate) => candidate.symbol === symbol);
        if (item && uncappedTotalScore > EPSILON) {
          const extraShare = (item.score / uncappedTotalScore) * excess;
          weights.set(symbol, (weights.get(symbol) ?? 0) + extraShare);
        }
      }

      // Cap any newly over-max items
      for (const symbol of uncappedSymbols) {
        const weight = weights.get(symbol) ?? 0;
        if (weight > maxPositionPct) {
          excess += weight - maxPositionPct;
          weights.set(symbol, maxPositionPct);
        }
      }

      // Renormalize to ensure total doesn't exceed reinvestPct
      const totalWeight = Array.from(weights.values()).reduce((a, b) => a + b, 0);
      if (totalWeight > reinvestPct + EPSILON) {
        // Scale down proportionally
        const scale = reinvestPct / totalWeight;
        for (const [symbol, weight] of weights) {
          weights.set(symbol, weight * scale);
        }
      }
    }
  }

  // Final safety: cap at maxPositionPct and renormalize
  for (const [symbol, weight] of weights) {
    if (weight > maxPositionPct) {
      weights.set(symbol, maxPositionPct);
    }
  }

  // Ensure total doesn't exceed reinvestPct
  const totalWeight = Array.from(weights.values()).reduce((a, b) => a + b, 0);
  if (totalWeight > reinvestPct + EPSILON) {
    const scale = reinvestPct / totalWeight;
    for (const [symbol, weight] of weights) {
      weights.set(symbol, weight * scale);
    }
  }

  return weights;
}

export function buildDecisionVector({ signal, targetWeight, currentWeight }: DecisionVectorInput): DecisionVector {
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
