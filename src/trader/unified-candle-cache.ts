import { granularityMs } from '../lib/time.ts';
import { interpolateCandleGaps, type CandleLike } from './cache-manager.ts';

type TickLike = {
  timestamp?: string;
  price?: unknown;
  last?: unknown;
  mid?: unknown;
  volume?: unknown;
  size?: unknown;
};

type RealtimeCandle = CandleLike & {
  symbol: string;
  granularity: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
  tickCount: number;
  firstTickTime: number;
  lastTickTime: number;
};

type CandleBuilder = {
  granularity: string;
  current: RealtimeCandle | null;
  pending: RealtimeCandle[];
};

export class UnifiedCandleCache {
  storage: any;
  freshnessMs: number;
  restClient: any | null;
  allowRestFetch: boolean;
  pendingTicks: Map<string, { ticks: TickLike[]; currentCandle: RealtimeCandle | null }>;
  candleBuilders: Map<string, CandleBuilder>;

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

    // Per-symbol state for realtime merging
    this.pendingTicks = new Map(); // symbol -> { ticks: [], currentCandle: null }
    this.candleBuilders = new Map(); // symbol -> { granularity, current: {}, pending: [] }
  }

  /**
   * Process a realtime tick and update the current forming candle.
   * Returns { candle, isComplete, isNew } if a candle was completed.
   */
  processTick(symbol: string, tick: TickLike, granularity = '1m'): { candle: RealtimeCandle | null; isComplete: boolean; isNew: boolean } {
    const key = `${symbol}:${granularity}`;
    let builder = this.candleBuilders.get(key);

    if (!builder) {
      builder = {
        granularity,
        current: null,
        pending: [],
      };
      this.candleBuilders.set(key, builder);
    }

    const intervalMs = granularityMs(granularity);
    const tickTime = Date.parse(tick.timestamp ?? '') || Date.now();
    const candleStartMs = Math.floor(tickTime / intervalMs) * intervalMs;
    const candleStart = new Date(candleStartMs).toISOString();

    const price = Number(tick.price || tick.last || tick.mid);
    const volume = Number(tick.volume || tick.size || 0);

    if (!builder.current || builder.current.start !== candleStart) {
      // New candle boundary crossed
      if (builder.current) {
        // Finalize previous candle
        const completed = this._finalizeCandle(builder.current);
        builder.pending.push(completed);
        builder.current = this._initCandle(symbol, granularity, candleStart, price, volume);
        return { candle: completed, isComplete: true, isNew: true };
      }
      builder.current = this._initCandle(symbol, granularity, candleStart, price, volume);
    } else {
      // Update current forming candle
      this._updateCandle(builder.current, price, volume, tick);
    }

    return { candle: null, isComplete: false, isNew: false };
  }

  _initCandle(symbol: string, granularity: string, start: string, price: number, volume: number): RealtimeCandle {
    return {
      symbol,
      granularity,
      start,
      open: price,
      high: price,
      low: price,
      close: price,
      volume,
      vwap: price,
      tickCount: 1,
      firstTickTime: Date.parse(start),
      lastTickTime: Date.parse(start),
    };
  }

  _updateCandle(candle: RealtimeCandle, price: number, volume: number, tick: TickLike): void {
    candle.high = Math.max(candle.high, price);
    candle.low = Math.min(candle.low, price);
    candle.close = price;
    candle.volume += volume;
    candle.tickCount += 1;
    candle.lastTickTime = Date.parse(tick.timestamp ?? '') || Date.now();
    // VWAP update
    candle.vwap = (candle.vwap * (candle.tickCount - 1) + price) / candle.tickCount;
  }

  _finalizeCandle(candle: RealtimeCandle): RealtimeCandle {
    return {
      ...candle,
      volume: Number(candle.volume.toFixed(8)),
      vwap: Number(candle.vwap.toFixed(8)),
    };
  }

  /**
   * Get completed candles ready for persistence (nanosecond-ordered by arrival)
   */
  drainCompleted(symbol: string, granularity = '1m'): RealtimeCandle[] {
    const key = `${symbol}:${granularity}`;
    const builder = this.candleBuilders.get(key);
    if (!builder || builder.pending.length === 0) return [];

    const completed = builder.pending.splice(0, builder.pending.length);
    // Sort by firstTickTime (arrival order), then by start (event time)
    completed.sort((a, b) => {
      const timeDiff = a.firstTickTime - b.firstTickTime;
      return timeDiff !== 0 ? timeDiff : Date.parse(a.start) - Date.parse(b.start);
    });
    return completed;
  }

  /**
   * Get current forming candle (incomplete)
   */
  getCurrentCandle(symbol: string, granularity = '1m'): RealtimeCandle | null {
    const key = `${symbol}:${granularity}`;
    const builder = this.candleBuilders.get(key);
    return builder?.current ? { ...builder.current } : null;
  }

  /**
   * Load historical candles from storage, interpolate gaps,
   * and merge with any pending realtime candles.
   * Returns unified timeline: [historical..., pending..., current?]
   */
  async loadUnified({ symbol, limit, eventTimestamp, granularity = '1m' }: {
    symbol: string;
    limit: number;
    eventTimestamp: string;
    granularity?: string;
  }): Promise<{ candles: CandleLike[]; cacheHit: boolean; gapCount: number; hasForming: boolean }> {
    let rows = await this.storage.getRecentCandles({ symbol, limit, granularity }) as CandleLike[];

    // Auto-interpolate database gaps
    const { result: interpolatedRows, interpolated: newDbCandles } = interpolateCandleGaps(rows, granularity);
    if (newDbCandles.length > 0) {
      console.log(`[UnifiedCache] Interpolating ${newDbCandles.length} database gaps for ${symbol}...`);
      await this.storage.upsertCandles(newDbCandles);
      rows = interpolatedRows;
    }

    // Get pending realtime candles (completed but not yet persisted)
    const pending = this.drainCompleted(symbol, granularity);
    if (pending.length > 0) {
      await this.storage.upsertCandles(pending);
    }

    // Get current forming candle
    const current = this.getCurrentCandle(symbol, granularity);

    // Build unified timeline: historical (sorted desc) + pending (arrival order) + current
    const historical = rows.map((r) => ({ ...r, source: 'historical' }));
    const pendingCandles = pending.map((p) => ({ ...p, source: 'realtime' }));
    const currentCandle = current ? [{ ...current, source: 'forming' }] : [];

    // Sort: historical by start desc, then pending by arrival, then current
    const unified = [...historical, ...pendingCandles, ...currentCandle];

    const latest = unified[0] ?? null;
    const latestTime = latest ? Date.parse(latest.start) : 0;
    const currentTime = Date.parse(eventTimestamp);
    const cacheHit = Boolean(latest && (currentTime - latestTime) <= this.freshnessMs);
    const gapCount = newDbCandles.length;

    return {
      candles: unified,
      cacheHit,
      gapCount,
      hasForming: Boolean(current),
    };
  }

  /**
   * Force-flush current forming candle (e.g., on shutdown or interval)
   */
  flushCurrent(symbol: string, granularity = '1m'): RealtimeCandle | null {
    const key = `${symbol}:${granularity}`;
    const builder = this.candleBuilders.get(key);
    if (!builder?.current) return null;

    const completed = this._finalizeCandle(builder.current);
    builder.pending.push(completed);
    builder.current = null;
    return completed;
  }

  /**
   * Sync state with storage (for engine compatibility)
   */
  async syncState(): Promise<void> {
    // Flush all current candles
    for (const [key, builder] of this.candleBuilders) {
      if (builder.current) {
        const [symbol, granularity = '1m'] = key.split(':');
        if (symbol) this.flushCurrent(symbol, granularity);
      }
    }
    // Drain all pending
    for (const [, builder] of this.candleBuilders) {
      if (builder.pending.length > 0) {
        const pending = builder.pending.splice(0, builder.pending.length);
        await this.storage.upsertCandles(pending);
      }
    }
  }
}

export default UnifiedCandleCache;
