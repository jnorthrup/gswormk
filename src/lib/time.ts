// Single source of truth for time units and candle granularity.
// All other modules import from here — no inline 60_000 / 3_600_000 / granularity tables.

export const MS = {
  SECOND: 1_000,
  MINUTE: 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000,
  WEEK: 7 * 86_400_000,
} as const;

/**
 * Canonical granularity definitions.
 * `seconds` is the source value; ms/minutes derive from it to avoid drift.
 * `enum` is the Coinbase Advanced Trade API string.
 */
export const GRANULARITIES = {
  '1m': { enum: 'ONE_MINUTE', seconds: 60 },
  '5m': { enum: 'FIVE_MINUTE', seconds: 300 },
  '15m': { enum: 'FIFTEEN_MINUTE', seconds: 900 },
  '30m': { enum: 'THIRTY_MINUTE', seconds: 1_800 },
  '1h': { enum: 'ONE_HOUR', seconds: 3_600 },
  '2h': { enum: 'TWO_HOUR', seconds: 7_200 },
  '6h': { enum: 'SIX_HOUR', seconds: 21_600 },
  '1d': { enum: 'ONE_DAY', seconds: 86_400 },
} as const;

export type Granularity = keyof typeof GRANULARITIES;
export type GranularityDefinition = (typeof GRANULARITIES)[Granularity];

const GRANULARITY_LOOKUP: Record<string, GranularityDefinition | undefined> = GRANULARITIES;

/** Throws on unknown granularity. */
export function requireGranularity(granularity: string): GranularityDefinition {
  const definition = GRANULARITY_LOOKUP[granularity];
  if (!definition) throw new Error(`Unknown granularity: ${granularity}`);
  return definition;
}

/** Granularity duration in milliseconds. */
export function granularityMs(granularity: string): number {
  return requireGranularity(granularity).seconds * MS.SECOND;
}

/** Granularity duration in minutes (integer). */
export function granularityMinutes(granularity: string): number {
  return requireGranularity(granularity).seconds / 60;
}

/** Coinbase API enum string for a granularity. */
export function granularityEnum(granularity: string): string {
  return requireGranularity(granularity).enum;
}

/**
 * Number of candles that fit between two epoch-ms timestamps (exclusive end).
 * Returns 0 if the span is shorter than one granularity period.
 */
export function candleCountBetween(granularity: string, fromMs: number, toMs: number): number {
  const spanMs = toMs - fromMs;
  if (spanMs <= 0) return 0;
  return Math.floor(spanMs / granularityMs(granularity));
}
