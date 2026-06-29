type RegimeProfile = {
  triggerMultiplier: number;
  kellyMultiplier: number;
  snareSpacingMultiplier: number;
  timeScaleWindow: number;
  timeScaleSigma: number;
};

export type TraderConfigOverrides = Record<string, any> & {
  regimeProfiles?: Record<string, Partial<RegimeProfile>>;
  symbols?: string[];
};

export type TraderConfig = Record<string, any> & {
  symbols: string[];
  ticks: number;
  seed: number;
  initialCash: number;
  reinvestPct: number;
  maxPositionPct: number;
  maxDrawdownPct: number;
  regimeProfiles: Record<string, RegimeProfile | Partial<RegimeProfile>>;
};

const DEFAULT_REGIME_PROFILES: Record<string, RegimeProfile> = {
  volatility: {
    triggerMultiplier: 1.5,
    kellyMultiplier: 0.5,
    snareSpacingMultiplier: 1.3,
    timeScaleWindow: 15,
    timeScaleSigma: 8,
  },
  momentum: {
    triggerMultiplier: 0.7,
    kellyMultiplier: 1.2,
    snareSpacingMultiplier: 2.0,
    timeScaleWindow: 1,
    timeScaleSigma: 2,
  },
  meanReversion: {
    triggerMultiplier: 1.0,
    kellyMultiplier: 1.0,
    snareSpacingMultiplier: 1.0,
    timeScaleWindow: 5,
    timeScaleSigma: 4,
  },
};

export function defaultConfig(overrides: TraderConfigOverrides = {}): TraderConfig {
  const { regimeProfiles: overrideRegimeProfiles, ...rest } = overrides;

  return {
    symbols: overrides.symbols ?? [],
    ticks: overrides.ticks ?? 300,
    seed: overrides.seed ?? 42,
    initialCash: overrides.initialCash ?? 100000,
    reinvestPct: overrides.reinvestPct ?? 0.9,
    maxPositionPct: overrides.maxPositionPct ?? 0.45,
    maxDrawdownPct: overrides.maxDrawdownPct ?? 0.15,
    minActionUsd: 25,
    annualizationFactor: 365 * 24 * 60,
    semivarianceWindow: 120,
    tailWindow: 180,
    tailQuantile: 0.05,
    cacheFreshnessMs: overrides.cacheFreshnessMs ?? 120000,
    allowRestCacheFetch: overrides.allowRestCacheFetch ?? false,
    allowRestWarmupFetch: overrides.allowRestWarmupFetch ?? false,
    kalmanQ: 0.05,
    kalmanR: 4,
    useSnareGrid: overrides.useSnareGrid ?? false,
    useConfidenceGating: overrides.useConfidenceGating ?? false,
    useAdaptiveExecutionStyle: overrides.useAdaptiveExecutionStyle ?? true,
    takerProbabilityThreshold: overrides.takerProbabilityThreshold ?? 0.68,
    makerProbabilityThreshold: overrides.makerProbabilityThreshold ?? 0.45,
    fibLevels: overrides.fibLevels ?? [0.382, 0.500, 0.618],
    timescaleWindows: overrides.timescaleWindows ?? [1, 5, 15, 60],
    timescaleAttentionStrength: overrides.timescaleAttentionStrength ?? 0.15,
    useDenoisedRsi: overrides.useDenoisedRsi ?? true,
    rsiDrawThroughCooldownMs: overrides.rsiDrawThroughCooldownMs ?? 300000,
    baseSnareRiskFraction: overrides.baseSnareRiskFraction ?? 0.05,
    minSnareRiskFraction: overrides.minSnareRiskFraction ?? 0.02,
    maxSnareRiskFraction: overrides.maxSnareRiskFraction ?? 0.08,
    profitTargetPct: overrides.profitTargetPct ?? 0.02,
    stopLossPct: overrides.stopLossPct ?? 0.015,
    stopDurationMs: overrides.stopDurationMs ?? 900000,
    snareDurationMs: overrides.snareDurationMs ?? 900000,
    resetWallet: overrides.resetWallet ?? false,
    regimeProfiles: {
      ...DEFAULT_REGIME_PROFILES,
      ...(overrideRegimeProfiles ?? {}),
    },
    ...rest,
  };
}
