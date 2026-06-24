import { SeededRandom } from '../lib/random.mjs';

const BASE_PRICES = {
  'BTC-USD': 65000,
  'ETH-USD': 3200,
};

export class ReplayFeed {
  constructor({ symbols, seed, ticks }) {
    this.symbols = symbols;
    this.random = new SeededRandom(seed);
    this.ticks = ticks;
    this.cursor = 0;
    this.startTime = Date.now() - (ticks * 60_000);
    this.prices = Object.fromEntries(symbols.map((symbol) => [symbol, BASE_PRICES[symbol] ?? 100]));
  }

  async *stream() {
    while (this.cursor < this.ticks) {
      const timestamp = new Date(this.startTime + (this.cursor * 60_000)).toISOString();

      for (const symbol of this.symbols) {
        const drift = symbol === 'BTC-USD' ? 0.0002 : 0.00035;
        const shock = this.random.normal(0, symbol === 'BTC-USD' ? 0.008 : 0.011);
        const nextPrice = Math.max(1, this.prices[symbol] * (1 + drift + shock));
        this.prices[symbol] = nextPrice;

        const spreadBps = Math.max(2, 4 + this.random.normal(0, 0.8));
        const spread = nextPrice * (spreadBps / 10_000);
        const mid = nextPrice;
        const bestBid = mid - (spread / 2);
        const bestAsk = mid + (spread / 2);
        const imbalanceBias = this.random.normal(0, 0.2) + Math.sign(shock) * 0.25;

        const book = buildBook({
          bestBid,
          bestAsk,
          mid,
          random: this.random,
          imbalanceBias,
        });

        yield {
          type: 'market',
          symbol,
          timestamp,
          mid,
          last: nextPrice,
          bids: book.bids,
          asks: book.asks,
          volume: Math.max(0.1, Math.abs(this.random.normal(25, 7))),
        };
      }

      this.cursor += 1;
    }
  }
}

function buildBook({ bestBid, bestAsk, mid, random, imbalanceBias }) {
  const bids = [];
  const asks = [];

  for (let level = 0; level < 5; level += 1) {
    const distance = mid * (0.0001 * (level + 1));
    const bidPrice = bestBid - distance;
    const askPrice = bestAsk + distance;
    const baseSize = Math.max(0.01, random.normal(2.5, 0.7));
    const bidSize = Math.max(0.01, baseSize * (1 + imbalanceBias));
    const askSize = Math.max(0.01, baseSize * (1 - imbalanceBias));
    bids.push({ price: bidPrice, size: bidSize });
    asks.push({ price: askPrice, size: askSize });
  }

  return { bids, asks };
}