export class CoinbaseWS {
  constructor({ symbols, restClient, evaluateIntervalMs = 5000, deviationLimitBps = 10 } = {}) {
    this.symbols = symbols;
    this.restClient = restClient;
    this.evaluateIntervalMs = evaluateIntervalMs;
    this.deviationLimitBps = deviationLimitBps;

    this.ws = null;
    this.queue = [];
    this.resolveNext = null;
    this.books = new Map();
    this.lastTicker = new Map();

    // Throttling state
    this.lastEmittedTime = new Map();
    this.lastEmittedPrice = new Map();

    // Traffic monitoring for REST fallback
    this.messageCount = 0;
    this.lastRateCheck = Date.now();
    this.isSubscribedL2 = true;
    this.useRestFallback = false;
    this.restInterval = null;
  }

  connect() {
    console.log('[WS] Connecting to wss://advanced-trade-ws.coinbase.com...');
    this.ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');

    this.ws.onopen = () => {
      console.log('[WS] Connected. Subscribing to ticker channel...');
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: this.symbols,
        channel: 'ticker',
      }));

      if (!this.useRestFallback) {
        console.log('[WS] Subscribing to level2 channel...');
        this.ws.send(JSON.stringify({
          type: 'subscribe',
          product_ids: this.symbols,
          channel: 'level2',
        }));
        this.isSubscribedL2 = true;
      }
    };

    this.ws.onmessage = (event) => {
      this.messageCount += 1;
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (error) {
        console.error('[WS] Error handling message:', error);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[WS] Error:', error);
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Connection closed (code: ${event.code}, reason: ${event.reason}). Reconnecting in 5s...`);
      setTimeout(() => this.connect(), 5000);
    };

    // Start traffic checking
    this.startTrafficMonitor();
  }

  startTrafficMonitor() {
    setInterval(async () => {
      const now = Date.now();
      const elapsed = (now - this.lastRateCheck) / 1000;
      const rate = this.messageCount / elapsed;
      this.messageCount = 0;
      this.lastRateCheck = now;

      console.log(`[WS] Bandwidth Monitor: ${rate.toFixed(1)} messages/second`);

      // If rate is too high and we are subscribed to level2, switch to REST fallback
      if (rate > 100 && this.isSubscribedL2) {
        console.warn(`[WS] Traffic spike (${rate.toFixed(1)} msgs/s) exceeds 100 msgs/s. Unsubscribing from level2, falling back to REST.`);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'unsubscribe',
            product_ids: this.symbols,
            channel: 'level2',
          }));
        }
        this.isSubscribedL2 = false;
        this.useRestFallback = true;
        this.startRestPolling();
      }

      // If rate is low, we can restore websocket level2 subscription
      if (rate < 30 && this.useRestFallback) {
        console.log(`[WS] Traffic normal (${rate.toFixed(1)} msgs/s). Resubscribing to level2, disabling REST fallback.`);
        this.stopRestPolling();
        this.useRestFallback = false;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'subscribe',
            product_ids: this.symbols,
            channel: 'level2',
          }));
          this.isSubscribedL2 = true;
        }
      }
    }, 10000);
  }

  startRestPolling() {
    if (this.restInterval) return;
    console.log('[WS] Starting REST fallback polling for product books (every 10s)...');
    this.restInterval = setInterval(async () => {
      for (const symbol of this.symbols) {
        try {
          const book = await this.restClient.fetchProductBook({ symbol });
          const bidsMap = new Map(book.bids.map((b) => [b.price, b.size]));
          const asksMap = new Map(book.asks.map((a) => [a.price, a.size]));
          this.books.set(symbol, { bids: bidsMap, asks: asksMap });

          // Emit a virtual event
          this.checkAndEmit(symbol, 'rest_poll');
        } catch (error) {
          console.error(`[WS] REST fallback book fetch failed for ${symbol}:`, error);
        }
      }
    }, 10000);
  }

  stopRestPolling() {
    if (this.restInterval) {
      clearInterval(this.restInterval);
      this.restInterval = null;
    }
  }

  handleMessage(msg) {
    if (msg.channel === 'ticker') {
      const ticker = msg.events?.[0]?.tickers?.[0];
      if (ticker) {
        this.lastTicker.set(ticker.product_id, {
          price: Number(ticker.price),
          bestBid: Number(ticker.best_bid),
          bestAsk: Number(ticker.best_ask),
          bestBidQty: Number(ticker.best_bid_quantity),
          bestAskQty: Number(ticker.best_ask_quantity),
          timestamp: msg.timestamp || new Date().toISOString(),
        });
        this.checkAndEmit(ticker.product_id, 'ticker');
      }
    } else if (msg.channel === 'l2_data') {
      const event = msg.events?.[0];
      if (event) {
        const symbol = event.product_id;
        if (event.type === 'snapshot') {
          const bids = new Map();
          const asks = new Map();
          for (const u of event.updates || []) {
            const price = Number(u.price_level);
            const size = Number(u.new_quantity);
            if (u.side === 'bid') {
              bids.set(price, size);
            } else {
              asks.set(price, size);
            }
          }
          this.books.set(symbol, { bids, asks });
        } else if (event.type === 'update') {
          const book = this.books.get(symbol);
          if (book) {
            for (const u of event.updates || []) {
              const price = Number(u.price_level);
              const size = Number(u.new_quantity);
              const map = u.side === 'bid' ? book.bids : book.asks;
              if (size === 0) {
                map.delete(price);
              } else {
                map.set(price, size);
              }
            }
          }
        }
        this.checkAndEmit(symbol, 'l2');
      }
    }
  }

  checkAndEmit(symbol, triggerType) {
    const ticker = this.lastTicker.get(symbol);
    if (!ticker) return; // Need price to evaluate

    const price = ticker.price;
    const now = Date.now();

    const lastTime = this.lastEmittedTime.get(symbol) || 0;
    const lastPrice = this.lastEmittedPrice.get(symbol) || 0;

    const timeDiff = now - lastTime;
    const priceDiffPct = lastPrice > 0 ? Math.abs(price - lastPrice) / lastPrice : 1.0;
    const priceDiffBps = priceDiffPct * 10000;

    const timeTrigger = timeDiff >= this.evaluateIntervalMs;
    const deviationTrigger = priceDiffBps >= this.deviationLimitBps;

    // Disinterest Band: Emit if time throttle passed OR price broke out of the band
    if (timeTrigger || deviationTrigger) {
      this.lastEmittedTime.set(symbol, now);
      this.lastEmittedPrice.set(symbol, price);

      const book = this.books.get(symbol);
      let bids = [];
      let asks = [];

      if (book) {
        bids = [...book.bids.entries()]
          .map(([p, s]) => ({ price: p, size: s }))
          .sort((a, b) => b.price - a.price);
        asks = [...book.asks.entries()]
          .map(([p, s]) => ({ price: p, size: s }))
          .sort((a, b) => a.price - b.price);
      }

      // Fallback to top-of-book if L2 is empty (e.g. at startup)
      if (bids.length === 0) {
        bids = [{ price: ticker.bestBid, size: ticker.bestBidQty || 1 }];
        asks = [{ price: ticker.bestAsk, size: ticker.bestAskQty || 1 }];
      }

      // Yield market event format expected by the engine
      this.pushEvent({
        type: 'market',
        symbol,
        timestamp: ticker.timestamp,
        mid: (ticker.bestBid + ticker.bestAsk) / 2 || price,
        last: price,
        bids,
        asks,
        volume: ticker.bestBidQty || 1, // volume approximation
      });
    }
  }

  pushEvent(event) {
    const existingIdx = this.queue.findIndex(e => e.symbol === event.symbol);
    if (existingIdx >= 0) {
      this.queue[existingIdx] = event;
    } else {
      this.queue.push(event);
    }
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve();
    }
  }

  async *stream() {
    this.connect();
    while (true) {
      if (this.queue.length === 0) {
        await new Promise((resolve) => {
          this.resolveNext = resolve;
        });
      }
      while (this.queue.length > 0) {
        yield this.queue.shift();
      }
    }
  }
}
