import { clamp } from '../lib/math.mjs';

export function computeDrawdown({ nav, peakNav }) {
  if (peakNav <= 0) return 0;
  return Math.max(0, (peakNav - nav) / peakNav);
}

export function applyRiskInvariants({ targets, drawdown, maxDrawdownPct, maxPositionPct }) {
  const constrained = new Map();
  const halted = drawdown >= maxDrawdownPct;

  for (const [symbol, targetWeight] of targets.entries()) {
    constrained.set(symbol, halted ? 0 : clamp(targetWeight, 0, maxPositionPct));
  }

  return {
    halted,
    constrained,
  };
}

export function classifyRiskState({ drawdown, maxDrawdownPct, currentWeight, maxPositionPct }) {
  if (drawdown >= maxDrawdownPct) return 'HALT';
  if (currentWeight >= maxPositionPct) return 'TRIM';
  return 'OK';
}