import { interpolateCandleGaps } from '../trader/cache-manager.mjs';

export class CoinbaseSync {
  constructor({ storage, restClient, broker, granularities = ['1d', '1h'], throttleDelayMs = 1500 } = {}) {
    this.storage = storage;
    this.restClient = restClient;
    this.broker = broker;
    this.granularities = granularities;
    this.throttleDelayMs = throttleDelayMs;
    this.isSyncing = false;
    this.productRsis = new Map();
  }

  async fetchSpotProducts() {
    try {
      const url = `${this.restClient.baseUrl}/market/products`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} listing products`);
      }

      const data = await response.json();
      const rawProducts = data.products || [];
      const ignoredBases = ['USDC', 'USDT', 'DAI', 'EUR', 'GBP', 'JPY', 'CAD'];

      this.productMarketData = new Map();
      for (const p of rawProducts) {
        this.productMarketData.set(p.product_id, {
          price: Number(p.price || 0),
          change24h: Number(p.price_percentage_change_24h || 0),
        });
      }

      const symbols = rawProducts
        .filter((p) => {
          return (
            p.quote_currency_id === 'USD' &&
            p.product_type === 'SPOT' &&
            p.status === 'online' &&
            !p.is_disabled &&
            !ignoredBases.includes(p.base_currency_id)
          );
        })
        .map((p) => p.product_id);

      return [...new Set(symbols)];
    } catch (error) {
      console.error('[Sync] Failed to fetch spot products list:', error);
      return [];
    }
  }

  async syncPairCandles(symbol) {
    const limit = 400;
    const nowMs = Date.now();

    for (const gran of this.granularities) {
      try {
        // Fetch in two parts to bypass 300 candle limit
        const seconds = gran === '1d' ? 86400 : (gran === '1h' ? 3600 : (gran === '15m' ? 900 : (gran === '5m' ? 300 : 60)));
        const part1End = new Date(nowMs).toISOString();
        const part1Start = new Date(nowMs - (300 * seconds * 1000)).toISOString();

        const part2End = part1Start;
        const part2Start = new Date(nowMs - (limit * seconds * 1000)).toISOString();

        // Fetch segment 1
        const segment1 = await this.restClient.fetchCandles({
          symbol,
          start: part1Start,
          end: part1End,
          granularity: gran,
        });
        await this.sleep(this.throttleDelayMs);

        // Fetch segment 2
        const segment2 = await this.restClient.fetchCandles({
          symbol,
          start: part2Start,
          end: part2End,
          granularity: gran,
        });
        await this.sleep(this.throttleDelayMs);

        const merged = [...segment2, ...segment1];
        if (merged.length > 0) {
          // Remove duplicates
          const seenStarts = new Set();
          const unique = [];
          for (const c of merged) {
            if (!seenStarts.has(c.start)) {
              seenStarts.add(c.start);
              unique.push(c);
            }
          }

          // Interpolate gaps
          const { result: interpolated } = interpolateCandleGaps(unique, gran);

          // Save to storage
          await this.storage.upsertCandles(interpolated);
        }
      } catch (error) {
        console.error(`[Sync] Failed to sync ${gran} candles for ${symbol}:`, error.message);
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
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error(`[Sync] Failed to update spot stats for ${symbol}:`, error.message);
    }
  }

  stochasticNextSymbol(symbols) {
    if (!this.broker) {
      return symbols[Math.floor(Math.random() * symbols.length)];
    }

    const weights = symbols.map(symbol => {
      let weight = 1.0; // Base background weight
      
      // Boost weight if active position
      if (this.broker.getUnits(symbol) > 0) {
        weight += 10.0;
      }

      // Boost weight if guess orders are performing well
      const guesses = this.broker.orders.concat(this.broker.pendingOrders)
        .filter(o => o.product_id === symbol && o.validate_only);
      const symbolPnL = guesses.reduce((sum, o) => sum + (o.virtualPnL || 0), 0);
      if (symbolPnL > 0) {
        weight += 5.0;
      } else if (symbolPnL < 0) {
        weight += 0.2; // De-prioritize if losing
      }

      return weight;
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let r = Math.random() * totalWeight;
    for (let i = 0; i < symbols.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        return symbols[i];
      }
    }
    return symbols[0];
  }

  async startSyncLoop() {
    if (this.isSyncing) return;
    this.isSyncing = true;

    console.log('[Sync] Initializing background spot candle sync...');
    const symbols = await this.fetchSpotProducts();
    console.log(`[Sync] Found ${symbols.length} USD spot pairs to backfill.`);

    // Run indefinite background sync loop asynchronously
    (async () => {
      console.log('[Sync] Starting indefinite stochastic sync loop...');
      while (this.isSyncing) {
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

  stop() {
    this.isSyncing = false;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function computeRSI(candles, period = 14) {
  if (candles.length <= period) return null;
  const sorted = [...candles].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const closes = sorted.map((c) => Number(c.close));

  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
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

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}
