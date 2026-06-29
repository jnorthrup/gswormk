import { GRANULARITIES as GRANULARITY_MAP } from '../lib/time.ts';
export { GRANULARITY_MAP };

type RestClientOptions = {
  baseUrl?: string;
  requestLogWindowMs?: number;
  requestTpsWarn?: number;
  requestTpmWarn?: number;
  maxCandlesPerRequest?: number;
};

type FetchCandlesInput = {
  symbol: string;
  start: string | number | Date;
  end: string | number | Date;
  granularity: string;
};

type FetchProductBookInput = {
  symbol: string;
  limit?: number;
};

type FetchTickerInput = {
  symbol: string;
};

type RecordRequestInput = {
  endpoint: string;
  symbol: string;
  now?: number;
};

export type Candle = {
  symbol: string;
  granularity: string;
  start: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type BookLevel = {
  price: number;
  size: number;
};

export type ProductBook = {
  bids: BookLevel[];
  asks: BookLevel[];
};

export type Ticker = {
  price: number;
  bestBid: number;
  bestAsk: number;
};

export type RequestQuotaEvidence = {
  requestCount: number;
  tps: number;
  tpm: number;
  pressure: 'high' | 'observed';
};

export class CoinbaseRest {
  private readonly baseUrl: string;
  private readonly requestLogWindowMs: number;
  private readonly requestTpsWarn: number;
  private readonly requestTpmWarn: number;
  private readonly maxCandlesPerRequest: number;
  private readonly requestTimestamps: number[];

  constructor({
    baseUrl = 'https://api.coinbase.com/api/v3/brokerage',
    requestLogWindowMs = 60000,
    requestTpsWarn = 8,
    requestTpmWarn = 250,
    maxCandlesPerRequest = 300,
  }: RestClientOptions = {}) {
    this.baseUrl = baseUrl;
    this.requestLogWindowMs = requestLogWindowMs;
    this.requestTpsWarn = requestTpsWarn;
    this.requestTpmWarn = requestTpmWarn;
    this.maxCandlesPerRequest = maxCandlesPerRequest;
    this.requestTimestamps = [];
  }

  async fetchCandles({ symbol, start, end, granularity }: FetchCandlesInput): Promise<Candle[]> {
    const config = GRANULARITY_MAP[granularity as keyof typeof GRANULARITY_MAP];
    if (!config) {
      throw new Error(`Unsupported granularity: ${granularity}`);
    }

    const startSeconds = Math.floor(new Date(start).getTime() / 1000);
    const endSeconds = Math.floor(new Date(end).getTime() / 1000);

    const chunkSeconds = this.maxCandlesPerRequest * config.seconds;
    const allCandles: Candle[] = [];
    const requestedSeconds = Math.max(0, endSeconds - startSeconds);
    const estimatedRequests = Math.max(1, Math.ceil(requestedSeconds / chunkSeconds));

    console.warn(`[REST][constraints] candles symbol=${symbol} granularity=${granularity} requestedSeconds=${requestedSeconds} maxCandlesPerRequest=${this.maxCandlesPerRequest} estimatedRequests=${estimatedRequests}`);

    let currentStart = startSeconds;
    while (currentStart < endSeconds) {
      const currentEnd = Math.min(currentStart + chunkSeconds, endSeconds);
      const url = `${this.baseUrl}/market/products/${symbol}/candles?start=${currentStart}&end=${currentEnd}&granularity=${config.enum}`;

      try {
        this.recordRequest({ endpoint: 'candles', symbol });
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP error ${response.status}: ${await response.text()}`);
        }

        const data = await response.json() as { candles?: Array<Record<string, string | number>> };
        if (data.candles && Array.isArray(data.candles)) {
          for (const raw of data.candles) {
            allCandles.push({
              symbol,
              granularity,
              start: new Date(Number(raw.start) * 1000).toISOString(),
              open: Number(raw.open),
              high: Number(raw.high),
              low: Number(raw.low),
              close: Number(raw.close),
              volume: Number(raw.volume),
            });
          }
        }
      } catch (error) {
        console.error(`[REST] Failed to fetch candles for ${symbol}:`, error);
        throw error;
      }

      currentStart = currentEnd;
    }

    // Sort ascending by start time
    return allCandles.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  async fetchProductBook({ symbol, limit = 50 }: FetchProductBookInput): Promise<ProductBook> {
    const url = `${this.baseUrl}/market/product_book?product_id=${symbol}&limit=${limit}`;
    try {
      this.recordRequest({ endpoint: 'product_book', symbol });
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as {
        pricebook?: {
          bids?: Array<Record<string, string | number>>;
          asks?: Array<Record<string, string | number>>;
        };
      };
      const book = data.pricebook || {};
      const bids = (book.bids || []).map((bid) => ({
        price: Number(bid.price),
        size: Number(bid.size),
      }));
      const asks = (book.asks || []).map((ask) => ({
        price: Number(ask.price),
        size: Number(ask.size),
      }));

      return { bids, asks };
    } catch (error) {
      console.error(`[REST] Failed to fetch product book for ${symbol}:`, error);
      throw error;
    }
  }

  async fetchTicker({ symbol }: FetchTickerInput): Promise<Ticker> {
    const url = `${this.baseUrl}/market/products/${symbol}/ticker`;
    try {
      this.recordRequest({ endpoint: 'ticker', symbol });
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as {
        trades?: Array<Record<string, string | number>>;
        price?: string | number;
        best_bid?: string | number;
        best_ask?: string | number;
      };
      const trades = data.trades || [];
      const lastTrade = trades[0] || {};

      return {
        price: Number(lastTrade.price || data.price || 0),
        bestBid: Number(data.best_bid || 0),
        bestAsk: Number(data.best_ask || 0),
      };
    } catch (error) {
      console.error(`[REST] Failed to fetch ticker for ${symbol}:`, error);
      throw error;
    }
  }

  recordRequest({ endpoint, symbol, now = Date.now() }: RecordRequestInput): RequestQuotaEvidence {
    this.requestTimestamps.push(now);
    const cutoff = now - this.requestLogWindowMs;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0]! < cutoff) {
      this.requestTimestamps.shift();
    }

    const oldest = this.requestTimestamps[0] ?? now;
    const requestCount = this.requestTimestamps.length;
    const elapsedMs = requestCount > 1
      ? Math.max(1, now - oldest)
      : this.requestLogWindowMs;
    const tps = requestCount / (elapsedMs / 1000);
    const tpm = requestCount / (elapsedMs / 60000);
    const pressure = tps >= this.requestTpsWarn || tpm >= this.requestTpmWarn ? 'high' : 'observed';

    console.warn(`[REST][quota] ${pressure} endpoint=${endpoint} symbol=${symbol} requests=${requestCount} tps=${tps.toFixed(2)} tpm=${tpm.toFixed(1)} windowMs=${elapsedMs} thresholds=${this.requestTpsWarn}tps/${this.requestTpmWarn}tpm`);

    return { requestCount, tps, tpm, pressure };
  }
}
