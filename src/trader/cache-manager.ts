import { granularityMs } from '../lib/time.ts';
import { computeStaleness, stalenessToCacheQuality } from './signals.ts';

export type CandleLike = Record<string, unknown> & {
  symbol?: string;
  granularity?: string;
  start: string;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume: number;
};

export type InterpolatedCandles = {
  result: CandleLike[];
  interpolated: CandleLike[];
};

export function interpolateCandleGaps(candles: readonly CandleLike[], granularity = '1m'): InterpolatedCandles {
  if (candles.length < 2) return { result: [...candles], interpolated: [] };

  const expectedMs = granularityMs(granularity);

  const sorted = [...candles].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const result: CandleLike[] = [];
  const interpolated: CandleLike[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i]!;
    result.push(current);

    const next = sorted[i + 1];
    if (!next) break;

    const tCurrent = Date.parse(current.start);
    const tNext = Date.parse(next.start);
    const gapMs = tNext - tCurrent;

    if (gapMs > expectedMs + 1000) {
      const missingCount = Math.floor(gapMs / expectedMs) - 1;
      for (let j = 1; j <= missingCount; j += 1) {
        const tInterp = tCurrent + (j * expectedMs);
        const ratio = (j * expectedMs) / gapMs;
        const currentPrice = aggregatePriceBasis(current);
        const nextPrice = aggregatePriceBasis(next);
        const interpMean = interpolateValue(currentPrice.mean, nextPrice.mean, ratio);
        const interpOpen = interpolateValue(currentPrice.close, nextPrice.close, ratio);
        const interpLow = interpolateValue(currentPrice.min, nextPrice.min, ratio);
        const interpHigh = interpolateValue(currentPrice.max, nextPrice.max, ratio);
        const interpVolume = current.volume + ratio * (next.volume - current.volume);
        const low = Math.min(interpLow, interpOpen, interpMean);
        const high = Math.max(interpHigh, interpOpen, interpMean);

        const newCandle: CandleLike = {
          symbol: current.symbol,
          granularity: current.granularity,
          start: new Date(tInterp).toISOString(),
          open: interpOpen,
          high,
          low,
          close: interpMean,
          volume: interpVolume,
        };

        result.push(newCandle);
        interpolated.push(newCandle);
      }
    }
  }

  const finalResult = result.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  return { result: finalResult, interpolated };
}

export function aggregatePriceBasis(candle: CandleLike): { open: number; close: number; min: number; max: number; mean: number } {
  const open = finitePrice(candle.open, candle.close);
  const close = finitePrice(candle.close, open);
  const min = finitePrice(candle.min, finitePrice(candle.priceMin, finitePrice(candle.low, Math.min(open, close))));
  const max = finitePrice(candle.max, finitePrice(candle.priceMax, finitePrice(candle.high, Math.max(open, close))));
  const mean = finitePrice(
    candle.mean,
    finitePrice(
      candle.priceMean,
      finitePrice(candle.vwap, (open + min + max + close) / 4),
    ),
  );

  return { open, close, min, max, mean };
}

function interpolateValue(start: number, end: number, ratio: number): number {
  return start + (ratio * (end - start));
}

function finitePrice(value: unknown, fallback: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback);
}

export class DrawThroughCacheManager {
  storage: any;
  freshnessMs: number;
  restClient: any | null;
  allowRestFetch: boolean;

  constructor({ storage, freshnessMs, restClient = null, allowRestFetch = false }: {
    storage: any;
    freshnessMs: number;
    restClient?: any | null;
    allowRestFetch?: boolean;
  }) {
    this.storage = storage;
    this.freshnessMs = freshnessMs;
    this.restClient = restClient;
    this.allowRestFetch = allowRestFetch;
  }

  async loadRecentCandles({ symbol, limit, eventTimestamp, buildCandle, granularity = '1m' }: {
    symbol: string;
    limit: number;
    eventTimestamp: string;
    buildCandle: () => CandleLike;
    granularity?: string;
  }): Promise<{ candles: CandleLike[]; cacheHit: boolean; gapCount: number }> {
    let rows = await this.storage.getRecentCandles({ symbol, limit, granularity }) as CandleLike[];

    // Auto-interpolate database gaps
    const { result: interpolatedRows, interpolated: newDbCandles } = interpolateCandleGaps(rows, granularity);
    if (newDbCandles.length > 0) {
      console.log(`[Cache] Interpolating ${newDbCandles.length} database gaps for ${symbol}...`);
      await this.storage.upsertCandles(newDbCandles);
      rows = interpolatedRows;
    }

    const latest = rows[0] ?? null;
    const latestTime = latest ? Date.parse(latest.start) : 0;
    const currentTime = Date.parse(eventTimestamp);
    const cacheHit = Boolean(latest && (currentTime - latestTime) <= this.freshnessMs);
    let gapCount = newDbCandles.length;

    // L5: Compute staleness and adjust cacheQuality
    const stalenessInfo = computeStaleness(rows as unknown as readonly import('./signals').CandleLike[], granularity);
    const adjustedCacheQuality = stalenessToCacheQuality(stalenessInfo.staleness);
    if (stalenessInfo.stale) {
      console.warn(`[Cache] Stale data for ${symbol}: age=${stalenessInfo.ageMs}ms, staleness=${stalenessInfo.staleness.toFixed(3)}, cacheQuality=${adjustedCacheQuality.toFixed(3)}`);
    }

    if (!cacheHit) {
      if (this.restClient && this.allowRestFetch) {
        try {
          const expectedMs = granularityMs(granularity);
          const start = new Date(currentTime - (limit * expectedMs)).toISOString();
          const end = new Date(currentTime).toISOString();

          console.log(`[Cache] Miss for ${symbol}. Fetching ${limit} candles from REST (${start} to ${end})...`);
          const fetched = await this.restClient.fetchCandles({ symbol, start, end, granularity }) as CandleLike[];
          if (fetched.length > 0) {
            await this.storage.upsertCandles(fetched);
            rows = await this.storage.getRecentCandles({ symbol, limit, granularity }) as CandleLike[];

            // Check for gaps in the newly fetched candles as well
            const { result: finalRows, interpolated: newFetchedGaps } = interpolateCandleGaps(rows, granularity);
            if (newFetchedGaps.length > 0) {
              await this.storage.upsertCandles(newFetchedGaps);
              rows = finalRows;
            }

            gapCount += newFetchedGaps.length + Math.max(0, limit - (fetched.length + newFetchedGaps.length));
            return {
              candles: rows,
              cacheHit: true,
              gapCount,
            };
          }
        } catch (error) {
          console.error(`[Cache] REST candle fetch failed, falling back to buildCandle:`, error);
        }
      }

      // Replay/simulation fallback
      const candle = buildCandle();
      await this.storage.upsertCandles([candle]);
      gapCount = latest ? 1 : 0;
      return {
        candles: [candle, ...rows].slice(0, limit),
        cacheHit,
        gapCount,
      };
    }

    return {
      candles: rows,
      cacheHit,
      gapCount,
    };
  }
}
