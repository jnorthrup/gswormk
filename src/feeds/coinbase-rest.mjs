export const GRANULARITY_MAP = {
  '1m': { enum: 'ONE_MINUTE', seconds: 60 },
  '5m': { enum: 'FIVE_MINUTE', seconds: 300 },
  '15m': { enum: 'FIFTEEN_MINUTE', seconds: 900 },
  '30m': { enum: 'THIRTY_MINUTE', seconds: 1800 },
  '1h': { enum: 'ONE_HOUR', seconds: 3600 },
  '2h': { enum: 'TWO_HOUR', seconds: 7200 },
  '6h': { enum: 'SIX_HOUR', seconds: 21600 },
  '1d': { enum: 'ONE_DAY', seconds: 86400 },
};

export class CoinbaseRest {
  constructor({ baseUrl = 'https://api.coinbase.com/api/v3/brokerage' } = {}) {
    this.baseUrl = baseUrl;
  }

  async fetchCandles({ symbol, start, end, granularity }) {
    const config = GRANULARITY_MAP[granularity];
    if (!config) {
      throw new Error(`Unsupported granularity: ${granularity}`);
    }

    const startSeconds = Math.floor(new Date(start).getTime() / 1000);
    const endSeconds = Math.floor(new Date(end).getTime() / 1000);

    const maxCandlesPerRequest = 300;
    const chunkSeconds = maxCandlesPerRequest * config.seconds;
    const allCandles = [];

    let currentStart = startSeconds;
    while (currentStart < endSeconds) {
      const currentEnd = Math.min(currentStart + chunkSeconds, endSeconds);
      const url = `${this.baseUrl}/market/products/${symbol}/candles?start=${currentStart}&end=${currentEnd}&granularity=${config.enum}`;

      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP error ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
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

  async fetchProductBook({ symbol, limit = 50 }) {
    const url = `${this.baseUrl}/market/product_book?product_id=${symbol}&limit=${limit}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      const book = data.pricebook || {};
      const bids = (book.bids || []).map((b) => ({
        price: Number(b.price),
        size: Number(b.size),
      }));
      const asks = (book.asks || []).map((a) => ({
        price: Number(a.price),
        size: Number(a.size),
      }));

      return { bids, asks };
    } catch (error) {
      console.error(`[REST] Failed to fetch product book for ${symbol}:`, error);
      throw error;
    }
  }

  async fetchTicker({ symbol }) {
    const url = `${this.baseUrl}/market/products/${symbol}/ticker`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
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
}
