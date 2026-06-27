const GRANULARITY_SECONDS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '6h': 21600,
  '1d': 86400,
};

export function interpolateCandleGaps(candles, granularity = '1m') {
  if (candles.length < 2) return { result: candles, interpolated: [] };

  const seconds = GRANULARITY_SECONDS[granularity] || 60;
  const expectedMs = seconds * 1000;
  
  const sorted = [...candles].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const result = [];
  const interpolated = [];

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    result.push(current);

    const next = sorted[i + 1];
    if (!next) break;

    const tCurrent = Date.parse(current.start);
    const tNext = Date.parse(next.start);
    const gapMs = tNext - tCurrent;

    if (gapMs > expectedMs + 1000) {
      const missingCount = Math.floor(gapMs / expectedMs) - 1;
      for (let j = 1; j <= missingCount; j++) {
        const tInterp = tCurrent + (j * expectedMs);
        const ratio = (j * expectedMs) / gapMs;
        const interpPrice = current.close + ratio * (next.close - current.close);
        const interpVolume = current.volume + ratio * (next.volume - current.volume);

        const newCandle = {
          symbol: current.symbol,
          granularity: current.granularity,
          start: new Date(tInterp).toISOString(),
          open: interpPrice,
          high: Math.max(current.high, next.high),
          low: Math.min(current.low, next.low),
          close: interpPrice,
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

export class DrawThroughCacheManager {
  constructor({ storage, freshnessMs, restClient = null }) {
    this.storage = storage;
    this.freshnessMs = freshnessMs;
    this.restClient = restClient;
  }

  async loadRecentCandles({ symbol, limit, eventTimestamp, buildCandle, granularity = '1m' }) {
    let rows = await this.storage.getRecentCandles({ symbol, limit, granularity });
    
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

    if (!cacheHit) {
      if (this.restClient) {
        try {
          const seconds = GRANULARITY_SECONDS[granularity] || 60;
          const start = new Date(currentTime - (limit * seconds * 1000)).toISOString();
          const end = new Date(currentTime).toISOString();

          console.log(`[Cache] Miss for ${symbol}. Fetching ${limit} candles from REST (${start} to ${end})...`);
          const fetched = await this.restClient.fetchCandles({ symbol, start, end, granularity });
          if (fetched.length > 0) {
            await this.storage.upsertCandles(fetched);
            rows = await this.storage.getRecentCandles({ symbol, limit, granularity });
            
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