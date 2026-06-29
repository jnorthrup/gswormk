import { GRANULARITY_MAP, type Candle } from './coinbase-rest.ts';
import { interpolateCandleGaps } from '../trader/cache-manager.ts';
import { CoinMarketCapScraper } from './coinmarketcap-scraper.ts';

const DEFAULT_HOT_GRANULARITIES = ['1m'];
const DEFAULT_DEFERRED_GRANULARITIES = ['5m', '15m', '1h', '1d'];
const DEFAULT_LIMITS: Record<string, number> = {
  '1m': 240,
  '5m': 288,
  '15m': 192,
  '1h': 168,
  '1d': 60,
};
const DEFAULT_REFRESH_CYCLES: Record<string, number> = {
  '5m': 3,
  '15m': 6,
  '1h': 12,
  '1d': 48,
};

type SyncPlanItem = {
  granularity: string;
  tier: 'explicit' | 'hot' | 'deferred';
  limit: number;
};

type SegmentEvidence = {
  hotGranularities: string[];
  deferredGranularities: string[];
  estimatedRequests: number;
  estimatedCandles: number;
};

type CoinbaseSyncOptions = {
  storage?: any;
  restClient?: any;
  broker?: any;
  granularities?: string[] | null;
  hotGranularities?: string[];
  deferredGranularities?: string[];
  candleLimits?: Record<string, number>;
  deferredRefreshCycles?: Record<string, number>;
  throttleDelayMs?: number;
  maxDeferredGranularitiesPerSegment?: number;
  rotationIntervalMs?: number;
  rsiScraper?: any;
  engine?: any;
};

export class CoinbaseSync {
  storage: any;
  restClient: any;
  broker: any;
  engine: any;
  granularities: string[] | null;
  hotGranularities: string[];
  deferredGranularities: string[];
  candleLimits: Record<string, number>;
  deferredRefreshCycles: Record<string, number>;
  throttleDelayMs: number;
  maxDeferredGranularitiesPerSegment: number;
  rotationIntervalMs: number;
  rsiScraper: any;
  isSyncing: boolean;
  productRsis: Map<string, unknown>;
  productMarketData: Map<string, any>;
  syncCycle: number;
  deferredCursor: number;
  lastSpotRotationAt: number | null;
  lastRsiRotationAt: number | null;
  lastCmcQuotaInfo: any;
  lastCmcRsiCount: number;

  constructor({
    storage,
    restClient,
    broker,
    granularities = null,
    hotGranularities = DEFAULT_HOT_GRANULARITIES,
    deferredGranularities = DEFAULT_DEFERRED_GRANULARITIES,
    candleLimits = DEFAULT_LIMITS,
    deferredRefreshCycles = DEFAULT_REFRESH_CYCLES,
    throttleDelayMs = 1500,
    maxDeferredGranularitiesPerSegment = 1,
    rotationIntervalMs = 15 * 60 * 1000,
    rsiScraper = null,
    engine = null,
  }: CoinbaseSyncOptions = {}) {
    this.storage = storage;
    this.restClient = restClient;
    this.broker = broker;
    this.engine = engine;
    this.granularities = granularities;
    this.hotGranularities = hotGranularities;
    this.deferredGranularities = deferredGranularities;
    this.candleLimits = candleLimits;
    this.deferredRefreshCycles = deferredRefreshCycles;
    this.throttleDelayMs = throttleDelayMs;
    this.maxDeferredGranularitiesPerSegment = maxDeferredGranularitiesPerSegment;
    this.rotationIntervalMs = rotationIntervalMs;
    this.rsiScraper = rsiScraper ?? (storage ? new CoinMarketCapScraper({ storage }) : null);
    this.isSyncing = false;
    this.productRsis = new Map();
    this.productMarketData = new Map();
    this.syncCycle = 0;
    this.deferredCursor = 0;
    this.lastSpotRotationAt = null;
    this.lastRsiRotationAt = null;
    this.lastCmcQuotaInfo = null;
    this.lastCmcRsiCount = 0;
  }

  async fetchSpotProducts(): Promise<string[]> {
    try {
      const url = `${this.restClient.baseUrl}/market/products`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} listing products`);
      }

      const data = await response.json() as any;
      const rawProducts = data.products || [];
      const updatedAt = new Date().toISOString();

      this.productMarketData = new Map();
      for (const p of rawProducts) {
        this.productMarketData.set(p.product_id, {
          price: Number(p.price || 0),
          change24h: Number(p.price_percentage_change_24h || 0),
          baseSymbol: p.base_currency_id || null,
          quoteSymbol: p.quote_currency_id || null,
          baseName: p.base_name || null,
          quoteName: p.quote_name || null,
          displayName: p.display_name || p.product_id,
        });
        if (this.storage?.upsertSpotMarketAsset) {
          await this.storage.upsertSpotMarketAsset(buildCoinbaseAssetRef(p, updatedAt));
        }
      }

      const symbols: string[] = rawProducts
        .filter((p: any) => {
          return (
            p.quote_currency_id === 'USD' &&
            p.product_type === 'SPOT' &&
            p.status === 'online' &&
            !p.is_disabled
          );
        })
        .map((p: any) => p.product_id as string);

      return [...new Set<string>(symbols)];
    } catch (error) {
      console.error('[Sync] Failed to fetch spot products list:', error);
      return [];
    }
  }

  async syncPairCandles(symbol: string): Promise<void> {
    const nowMs = Date.now();
    const segmentPlan = this.buildSyncPlan({ cycle: this.syncCycle });
    this.syncCycle += 1;
    const evidence = this.segmentEvidence(segmentPlan);

    console.warn(`[Sync][quota] segment symbol=${symbol} cycle=${this.syncCycle} hot=${evidence.hotGranularities.join(',') || 'none'} deferred=${evidence.deferredGranularities.join(',') || 'none'} estimatedRequests=${evidence.estimatedRequests} estimatedCandles=${evidence.estimatedCandles} throttleMs=${this.throttleDelayMs}`);

    for (const item of segmentPlan) {
      const gran = item.granularity;
      const limit = item.limit;
      try {
        const merged = await this.fetchCandleWindow({ symbol, granularity: gran, limit, nowMs });
        if (merged.length > 0) {
          const unique = dedupeCandles(merged);

          const { result: interpolated } = interpolateCandleGaps(unique, gran);
          await this.storage.upsertCandles(interpolated);
        }
      } catch (error) {
        console.error(`[Sync] Failed to sync ${gran} candles for ${symbol}:`, (error as Error).message);
      }
    }

    try {
      const candles1d = await this.storage.getRecentCandles({ symbol, limit: 30, granularity: '1d' });
      const candles1h = await this.storage.getRecentCandles({ symbol, limit: 30, granularity: '1h' });

      const rsi1d = computeRSI(candles1d, 14);
      const rsi1h = computeRSI(candles1h, 14);

      const market = this.productMarketData?.get(symbol) || { price: 0, change24h: 0 };

      await this.storage.upsertSpotMarketStats({
        symbol,
        price: market.price,
        change24h: market.change24h,
        rsi1d,
        rsi1h,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(`[Sync] Failed to update spot stats for ${symbol}:`, (error as Error).message);
    }

    if (this.engine && !this.engine.config.symbols.includes(symbol)) {
      const lookback = (this.engine.config.semivarianceWindow || 120) + 1;
      const candles = await this.storage.getRecentCandles({ symbol, limit: lookback, granularity: '1m' });
      if (candles.length >= lookback) {
        console.log(`[Sync] Promoted ${symbol} to active trading universe (database has ${candles.length} warmed up candles)`);
        await this.engine.promoteSymbol(symbol);
      }
    }
  }

  buildSyncPlan({ cycle = 0 }: { cycle?: number } = {}): SyncPlanItem[] {
    if (Array.isArray(this.granularities) && this.granularities.length > 0) {
      return this.granularities.map((granularity) => this.planItem(granularity, 'explicit'));
    }

    const plan = this.hotGranularities.map((granularity) => this.planItem(granularity, 'hot'));
    const dueDeferred: SyncPlanItem[] = [];
    for (let offset = 0; offset < this.deferredGranularities.length; offset += 1) {
      const index = (this.deferredCursor + offset) % this.deferredGranularities.length;
      const granularity = this.deferredGranularities[index]!;
      const refreshEvery = this.deferredRefreshCycles[granularity] ?? 1;
      if (cycle % refreshEvery === 0) {
        dueDeferred.push(this.planItem(granularity, 'deferred'));
        this.deferredCursor = (index + 1) % this.deferredGranularities.length;
      }
      if (dueDeferred.length >= this.maxDeferredGranularitiesPerSegment) break;
    }

    return [...plan, ...dueDeferred];
  }

  planItem(granularity: string, tier: SyncPlanItem['tier']): SyncPlanItem {
    const limit = this.candleLimits[granularity] ?? 300;
    return { granularity, tier, limit };
  }

  segmentEvidence(plan: readonly SyncPlanItem[]): SegmentEvidence {
    const estimatedRequests = plan.reduce((sum, item) => sum + Math.ceil(item.limit / 300), 0);
    return {
      hotGranularities: plan.filter((item) => item.tier === 'hot').map((item) => item.granularity),
      deferredGranularities: plan.filter((item) => item.tier === 'deferred').map((item) => item.granularity),
      estimatedRequests,
      estimatedCandles: plan.reduce((sum, item) => sum + item.limit, 0),
    };
  }

  async fetchCandleWindow({ symbol, granularity, limit, nowMs }: { symbol: string; granularity: string; limit: number; nowMs: number }): Promise<Candle[]> {
    const config = GRANULARITY_MAP[granularity as keyof typeof GRANULARITY_MAP];
    if (!config) {
      throw new Error(`Unsupported granularity: ${granularity}`);
    }

    const candles: Candle[] = [];
    let remaining = limit;
    let endMs = nowMs;

    while (remaining > 0) {
      const chunkCandles = Math.min(remaining, 300);
      const startMs = endMs - (chunkCandles * config.seconds * 1000);
      const fetched = await this.restClient.fetchCandles({
        symbol,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        granularity,
      });
      candles.push(...fetched);
      remaining -= chunkCandles;
      endMs = startMs;

      if (remaining > 0) {
        await this.sleep(this.throttleDelayMs);
      }
    }

    await this.sleep(this.throttleDelayMs);
    return candles;
  }

  stochasticNextSymbol(symbols: string[]): string {
    if (symbols.length === 0) return '';
    if (!this.broker) {
      return symbols[Math.floor(Math.random() * symbols.length)] ?? '';
    }

    const weights = symbols.map((symbol) => {
      let weight = 1.0; // Base background weight

      // Boost weight if active position
      if (this.broker.getUnits(symbol) > 0) {
        weight += 10.0;
      }

      // Boost weight if guess orders are performing well
      const guesses = this.broker.orders.concat(this.broker.pendingOrders)
        .filter((o: any) => o.product_id === symbol && o.validate_only);
      const symbolPnL = guesses.reduce((sum: number, o: any) => sum + (o.virtualPnL || 0), 0);
      if (symbolPnL > 0) {
        weight += 5.0;
      } else if (symbolPnL < 0) {
        weight += 0.2; // De-prioritize if losing
      }

      return weight;
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let r = Math.random() * totalWeight;
    for (let i = 0; i < symbols.length; i += 1) {
      r -= weights[i] ?? 0;
      if (r <= 0) {
        return symbols[i] ?? '';
      }
    }
    return symbols[0] ?? '';
  }

  async runQuarterHourRotation({ symbols = [], nowMs = Date.now() }: { symbols?: string[]; nowMs?: number } = {}): Promise<string[]> {
    let nextSymbols = Array.isArray(symbols) ? symbols : [];
    const needsUniverseRefresh = this.lastSpotRotationAt === null || (nowMs - this.lastSpotRotationAt) >= this.rotationIntervalMs || nextSymbols.length === 0;
    if (needsUniverseRefresh) {
      const refreshedSymbols = await this.fetchSpotProducts();
      if (refreshedSymbols.length > 0) {
        nextSymbols = refreshedSymbols;
      }
      this.lastSpotRotationAt = nowMs;
      console.warn(`[Sync][rotation] refreshed spot universe symbols=${nextSymbols.length} intervalMs=${this.rotationIntervalMs}`);
    }

    const needsRsiRefresh = this.rsiScraper && (this.lastRsiRotationAt === null || (nowMs - this.lastRsiRotationAt) >= this.rotationIntervalMs);
    if (needsRsiRefresh) {
      this.lastRsiRotationAt = nowMs;
      try {
        const count = await this.rsiScraper.scrapeRsiData();
        this.lastCmcRsiCount = count;
        let quotaSuffix = '';
        if (typeof this.rsiScraper.fetchQuotaInfo === 'function') {
          try {
            this.lastCmcQuotaInfo = await this.rsiScraper.fetchQuotaInfo();
          } catch (error) {
            console.warn(`[Sync][rotation] failed CMC quota inspection: ${(error as Error).message}`);
          }
        }
        if (this.lastCmcQuotaInfo) {
          quotaSuffix =
            ` proMinute=${this.lastCmcQuotaInfo.minuteRequestsMade}/${this.lastCmcQuotaInfo.minuteLimit}` +
            ` proMinuteLeft=${this.lastCmcQuotaInfo.minuteRequestsLeft}` +
            ` proMonthUsed=${this.lastCmcQuotaInfo.monthlyCreditsUsed}/${this.lastCmcQuotaInfo.monthlyCreditLimit}` +
            ` proMonthLeft=${this.lastCmcQuotaInfo.monthlyCreditsLeft}`;
        }
        console.warn(`[Sync][rotation] refreshed CMC charts/stats count=${count} intervalMs=${this.rotationIntervalMs}${quotaSuffix}`);
      } catch (error) {
        console.error('[Sync] Failed quarter-hour CMC chart rotation:', (error as Error).message);
      }
    }

    return nextSymbols;
  }

  async startSyncLoop(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;

    console.log('[Sync] Initializing background spot candle sync...');
    let symbols = await this.runQuarterHourRotation({ symbols: [], nowMs: Date.now() });
    console.log(`[Sync] Found ${symbols.length} USD spot pairs to backfill.`);

    // Run indefinite background sync loop asynchronously
    (async () => {
      console.log('[Sync] Starting indefinite stochastic sync loop...');
      while (this.isSyncing) {
        symbols = await this.runQuarterHourRotation({ symbols, nowMs: Date.now() });
        if (symbols.length === 0) {
          await this.sleep(this.throttleDelayMs);
          continue;
        }
        const symbol = this.stochasticNextSymbol(symbols);
        console.log(`[Sync] Stochastically selected ${symbol} for candle sync...`);
        await this.syncPairCandles(symbol);

        // Add random jitter to delay to distribute requests naturally (throttleDelayMs +- 30%)
        const delay = this.throttleDelayMs * (0.7 + Math.random() * 0.6);
        await this.sleep(delay);
      }
      console.log('[Sync] Background spot candle sync loop stopped.');
    })().catch((err) => {
      console.error('[Sync] Fatal error in sync loop:', err);
      this.isSyncing = false;
    });
  }

  stop(): void {
    this.isSyncing = false;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function buildCoinbaseAssetRef(product: any, updatedAt: string): any {
  return {
    symbol: product.product_id,
    baseSymbol: product.base_currency_id || symbolBase(product.product_id),
    quoteSymbol: product.quote_currency_id || symbolQuote(product.product_id),
    assetName: product.base_name || null,
    baseName: product.base_name || null,
    quoteName: product.quote_name || null,
    displayName: product.display_name || product.product_id,
    cmcAssetId: null,
    cmcSymbol: null,
    cmcName: null,
    cmcSlug: null,
    cmcRsiUrl: null,
    cmcMainPageUrl: null,
    updatedAt,
  };
}

function symbolBase(symbol: string): string | null {
  return String(symbol || '').split('-')[0] || null;
}

function symbolQuote(symbol: string): string | null {
  return String(symbol || '').split('-')[1] || null;
}

function dedupeCandles(candles: Candle[]): Candle[] {
  const seenStarts = new Set<string>();
  const unique: Candle[] = [];
  for (const candle of candles) {
    if (!seenStarts.has(candle.start)) {
      seenStarts.add(candle.start);
      unique.push(candle);
    }
  }
  return unique;
}

export function computeRSI(candles: readonly { start: string; close: number | string }[], period = 14): number | null {
  if (candles.length <= period) return null;
  const sorted = [...candles].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const closes = sorted.map((c) => Number(c.close));

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff > 0) {
      gains.push(diff);
      losses.push(0);
    } else {
      gains.push(0);
      losses.push(-diff);
    }
  }

  if (gains.length < period) return null;

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < gains.length; i += 1) {
    avgGain = (avgGain * (period - 1) + (gains[i] ?? 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (losses[i] ?? 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}
