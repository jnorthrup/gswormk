export function defaultConfig(overrides = {}) {
  return {
    symbols: overrides.symbols ?? ['BTC-USD', 'ETH-USD'],
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
    kalmanQ: 0.05,
    kalmanR: 4,
    cacheFreshnessMs: 2 * 60_000,
    ...overrides,
  };
}