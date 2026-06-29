import { clamp } from '../lib/math.ts';

export type DrawdownInput = {
  nav: number;
  peakNav: number;
};

export type RiskInvariantInput = {
  targets: Map<string, number>;
  drawdown: number;
  maxDrawdownPct: number;
  maxPositionPct: number;
};

export type RiskInvariantResult = {
  halted: boolean;
  constrained: Map<string, number>;
};

export type RiskStateInput = {
  drawdown: number;
  maxDrawdownPct: number;
  currentWeight: number;
  maxPositionPct: number;
};

export type RiskState = 'HALT' | 'TRIM' | 'OK';

export function computeDrawdown({ nav, peakNav }: DrawdownInput): number {
  if (peakNav <= 0) return 0;
  return Math.max(0, (peakNav - nav) / peakNav);
}

export function applyRiskInvariants({ targets, drawdown, maxDrawdownPct, maxPositionPct }: RiskInvariantInput): RiskInvariantResult {
  const constrained = new Map<string, number>();
  const halted = drawdown >= maxDrawdownPct;

  for (const [symbol, targetWeight] of targets.entries()) {
    constrained.set(symbol, halted ? 0 : clamp(targetWeight, 0, maxPositionPct));
  }

  return {
    halted,
    constrained,
  };
}

export function classifyRiskState({ drawdown, maxDrawdownPct, currentWeight, maxPositionPct }: RiskStateInput): RiskState {
  if (drawdown >= maxDrawdownPct) return 'HALT';
  if (currentWeight >= maxPositionPct) return 'TRIM';
  return 'OK';
}
