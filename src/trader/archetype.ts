// L2: Trade Archetypes (TODO item 1)
// Classifies every candidate signal as one of:
//   discount_reversion | growth_momentum | volatility_defense | no_edge
// Each archetype has independent evidence checks that must ALL pass.

export const ARCHETYPES = Object.freeze({
  DISCOUNT_REVERSION: 'discount_reversion',
  GROWTH_MOMENTUM: 'growth_momentum',
  VOLATILITY_DEFENSE: 'volatility_defense',
  NO_EDGE: 'no_edge',
} as const);

export type Archetype = (typeof ARCHETYPES)[keyof typeof ARCHETYPES];

export type ArchetypeSignal = {
  innovationZ: number;
  obi: number;
  rsiDisplacement: number;
  tailDependence: number;
  annualizedRvDown: number;
  timescaleAgreement?: number;
};

export type ArchetypeCheck = {
  archetype: Archetype;
  passed: boolean;
  reason: string;
};

export type ArchetypeResult = {
  archetype: Archetype;
  reason: string;
  checks: ArchetypeCheck[];
};

// Evidence thresholds. Tunable but fixed defaults encode the spec.
const THRESHOLDS = Object.freeze({
  // discount_reversion
  DISCOUNT_INNOVATION_Z: -1.5,
  DISCOUNT_RSI_DISPLACEMENT: -0.8,
  DISCOUNT_MIN_OBI: 0.05,          // bid-side support required
  DISCOUNT_MAX_TAIL: 0.3,          // BTC contagion must be low
  DISCOUNT_MAX_RVDOWN: 0.15,       // downside variance not exploding

  // growth_momentum
  GROWTH_INNOVATION_Z: 1.5,
  GROWTH_MIN_OBI: 0.05,
  GROWTH_RSI_MIN: 0.3,             // directional support
  GROWTH_RSI_MAX: 1.5,             // not overextended
  GROWTH_MIN_TIMESCALE: 2,         // at least 2 of N windows agree

  // volatility_defense
  DEFENSE_MIN_TAIL: 0.4,
  DEFENSE_MIN_RVDOWN: 0.2,
} as const);

/**
 * Classify signal evidence as one of the trade archetypes.
 */
export function classifyArchetype(signal: ArchetypeSignal): ArchetypeResult {
  const checks: ArchetypeCheck[] = [];

  // volatility_defense has priority: a crash-regime signal overrides
  // archetype-specific entries because the correct action is reduce/hold.
  const defense = checkVolatilityDefense(signal);
  if (defense) {
    checks.push({ archetype: ARCHETYPES.VOLATILITY_DEFENSE, passed: true, reason: defense });
    return result(ARCHETYPES.VOLATILITY_DEFENSE, defense, checks);
  }

  const discount = checkDiscountReversion(signal);
  if (discount) {
    checks.push({ archetype: ARCHETYPES.DISCOUNT_REVERSION, passed: true, reason: discount });
    return result(ARCHETYPES.DISCOUNT_REVERSION, discount, checks);
  }

  const growth = checkGrowthMomentum(signal);
  if (growth) {
    checks.push({ archetype: ARCHETYPES.GROWTH_MOMENTUM, passed: true, reason: growth });
    return result(ARCHETYPES.GROWTH_MOMENTUM, growth, checks);
  }

  const reason = 'no archetype evidence threshold met';
  checks.push({ archetype: ARCHETYPES.NO_EDGE, passed: false, reason });
  return result(ARCHETYPES.NO_EDGE, reason, checks);
}

function result(archetype: Archetype, reason: string, checks: ArchetypeCheck[]): ArchetypeResult {
  return { archetype, reason, checks };
}

function checkVolatilityDefense(signal: ArchetypeSignal): string | null {
  const elevatedTail = signal.tailDependence >= THRESHOLDS.DEFENSE_MIN_TAIL;
  const elevatedRv = signal.annualizedRvDown >= THRESHOLDS.DEFENSE_MIN_RVDOWN;
  if (elevatedTail && elevatedRv) {
    return `volatility defense: tail=${signal.tailDependence.toFixed(2)} rvDown=${signal.annualizedRvDown.toFixed(2)}`;
  }
  return null;
}

function checkDiscountReversion(signal: ArchetypeSignal): string | null {
  const dislocated = signal.innovationZ <= THRESHOLDS.DISCOUNT_INNOVATION_Z
    || signal.rsiDisplacement <= THRESHOLDS.DISCOUNT_RSI_DISPLACEMENT;
  const bookSupport = signal.obi >= THRESHOLDS.DISCOUNT_MIN_OBI;
  const safeTail = signal.tailDependence <= THRESHOLDS.DISCOUNT_MAX_TAIL;
  const containedVariance = signal.annualizedRvDown <= THRESHOLDS.DISCOUNT_MAX_RVDOWN;

  if (dislocated && bookSupport && safeTail && containedVariance) {
    return `discount reversion: innovationZ=${signal.innovationZ.toFixed(2)} obi=${signal.obi.toFixed(2)} rsiDisp=${signal.rsiDisplacement.toFixed(2)}`;
  }
  return null;
}

function checkGrowthMomentum(signal: ArchetypeSignal): string | null {
  const positiveInnovation = signal.innovationZ >= THRESHOLDS.GROWTH_INNOVATION_Z;
  const bookSupport = signal.obi >= THRESHOLDS.GROWTH_MIN_OBI;
  const directionalRsi = signal.rsiDisplacement >= THRESHOLDS.GROWTH_RSI_MIN
    && signal.rsiDisplacement <= THRESHOLDS.GROWTH_RSI_MAX;
  const timescaleAgreement = (signal.timescaleAgreement ?? 0) >= THRESHOLDS.GROWTH_MIN_TIMESCALE;

  if (positiveInnovation && bookSupport && directionalRsi && timescaleAgreement) {
    return `growth momentum: innovationZ=${signal.innovationZ.toFixed(2)} obi=${signal.obi.toFixed(2)} timescales=${signal.timescaleAgreement}`;
  }
  return null;
}
