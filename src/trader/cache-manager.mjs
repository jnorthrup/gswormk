export class DrawThroughCacheManager {
  constructor({ storage, freshnessMs }) {
    this.storage = storage;
    this.freshnessMs = freshnessMs;
  }

  async loadRecentCandles({ symbol, limit, eventTimestamp, buildCandle }) {
    const rows = await this.storage.getRecentCandles({ symbol, limit });
    const latest = rows[0] ?? null;
    const latestTime = latest ? Date.parse(latest.start) : 0;
    const currentTime = Date.parse(eventTimestamp);
    const cacheHit = Boolean(latest && (currentTime - latestTime) <= this.freshnessMs);
    let gapCount = 0;

    if (!cacheHit) {
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