type CoinbaseWSOptions = {
  symbols?: string[];
  evaluateIntervalMs?: number;
  deviationLimitBps?: number;
  maxLevel2Subscriptions?: number;
  minLevel2Subscriptions?: number;
  initialLevel2Subscriptions?: number | null;
  trafficHighWatermark?: number;
  trafficLowWatermark?: number;
  quotaUtilizationTarget?: number;
  interestHalfLifeMs?: number;
  [key: string]: unknown;
};

type SubscriptionFunnels = {
  ticker: string[];
  level2: string[];
  tickerOnly: string[];
};

type BookLevel = {
  price: number;
  size: number;
};

type OrderBook = {
  bids: Map<number, number>;
  asks: Map<number, number>;
};

type TickerState = {
  price: number;
  bestBid: number;
  bestAsk: number;
  bestBidQty: number;
  bestAskQty: number;
  timestamp: string;
};

type MarketEvent = {
  type: 'market';
  symbol: string;
  timestamp: string;
  mid: number;
  last: number;
  bids: BookLevel[];
  asks: BookLevel[];
  volume: number;
};

type QuotaEvidence = {
  elapsedSeconds: number;
  messages: number;
  emittedEvents: number;
  messageTps: number;
  messageTpm: number;
  tickTps: number;
  tickTpm: number;
  channels: Record<string, number>;
  channelTps: Record<string, number>;
  channelTpm: Record<string, number>;
};

type QuotaEvidenceInput = {
  elapsed: number;
  messages: number;
  emittedEvents: number;
  channelCounts?: Map<string, number> | Record<string, number> | null;
};

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export class CoinbaseWS {
  symbols: string[];
  evaluateIntervalMs: number;
  deviationLimitBps: number;
  maxLevel2Subscriptions: number;
  minLevel2Subscriptions: number;
  targetLevel2Subscriptions: number;
  trafficHighWatermark: number;
  trafficLowWatermark: number;
  quotaUtilizationTarget: number;
  interestHalfLifeMs: number;
  ws: any | null;
  queue: MarketEvent[];
  resolveNext: (() => void) | null;
  books: Map<string, OrderBook>;
  lastTicker: Map<string, TickerState>;
  activeLevel2Symbols: Set<string>;
  level2Interest: Map<string, number>;
  level2InterestUpdatedAt: Map<string, number>;
  currentSubscriptionFunnels: SubscriptionFunnels;
  lastEmittedTime: Map<string, number>;
  lastEmittedPrice: Map<string, number>;
  messageCount: number;
  emittedEventCount: number;
  channelMessageCounts: Map<string, number>;
  lastQuotaEvidence: QuotaEvidence | null;
  lastRateCheck: number;
  trafficMonitor: ReturnType<typeof setInterval> | null;

  constructor({
    symbols,
    evaluateIntervalMs = 5000,
    deviationLimitBps = 10,
    maxLevel2Subscriptions = symbols?.length ?? 0,
    minLevel2Subscriptions = symbols?.length ? 1 : 0,
    initialLevel2Subscriptions = null,
    trafficHighWatermark = 100,
    trafficLowWatermark = 30,
    quotaUtilizationTarget = 0.85,
    interestHalfLifeMs = 5 * 60 * 1000,
  }: CoinbaseWSOptions = {}) {
    this.symbols = symbols ?? [];
    this.evaluateIntervalMs = evaluateIntervalMs;
    this.deviationLimitBps = deviationLimitBps;
    this.maxLevel2Subscriptions = Math.max(0, Math.min(this.symbols.length, maxLevel2Subscriptions));
    this.minLevel2Subscriptions = Math.max(0, Math.min(this.maxLevel2Subscriptions, minLevel2Subscriptions));
    this.targetLevel2Subscriptions = clampInt(
      initialLevel2Subscriptions ?? this.minLevel2Subscriptions,
      this.minLevel2Subscriptions,
      this.maxLevel2Subscriptions,
    );
    this.trafficHighWatermark = trafficHighWatermark;
    this.trafficLowWatermark = trafficLowWatermark;
    this.quotaUtilizationTarget = Math.max(0.1, Math.min(1, quotaUtilizationTarget));
    this.interestHalfLifeMs = Math.max(1, interestHalfLifeMs);

    this.ws = null;
    this.queue = [];
    this.resolveNext = null;
    this.books = new Map();
    this.lastTicker = new Map();
    this.activeLevel2Symbols = new Set();
    this.level2Interest = new Map();
    this.level2InterestUpdatedAt = new Map();
    this.currentSubscriptionFunnels = {
      ticker: [...this.symbols],
      level2: [],
      tickerOnly: [...this.symbols],
    };

    // Throttling state
    this.lastEmittedTime = new Map();
    this.lastEmittedPrice = new Map();

    // Traffic monitoring trims websocket depth subscriptions instead of polling REST.
    this.messageCount = 0;
    this.emittedEventCount = 0;
    this.channelMessageCounts = new Map();
    this.lastQuotaEvidence = null;
    this.lastRateCheck = Date.now();
    this.trafficMonitor = null;
  }

  connect(): void {
    console.log('[WS] Connecting to wss://advanced-trade-ws.coinbase.com...');
    this.ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');

    this.ws.onopen = () => {
      console.log('[WS] Connected. Subscribing to ticker channel...');
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: this.symbols,
        channel: 'ticker',
      }));

      this.activeLevel2Symbols.clear();
      this.books.clear();
      this.applySubscriptionFunnels({ reason: 'connect' });
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.messageCount += 1;
      try {
        const msg = JSON.parse(String(event.data));
        this.handleMessage(msg);
      } catch (error) {
        console.error('[WS] Error handling message:', error);
      }
    };

    this.ws.onerror = (error: unknown) => {
      console.error('[WS] Error:', error);
    };

    this.ws.onclose = (event: CloseEvent) => {
      console.log(`[WS] Connection closed (code: ${event.code}, reason: ${event.reason}). Reconnecting in 5s...`);
      setTimeout(() => this.connect(), 5000);
    };

    // Start traffic checking
    this.startTrafficMonitor();
  }

  startTrafficMonitor(): void {
    if (this.trafficMonitor) return;

    this.trafficMonitor = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - this.lastRateCheck) / 1000;
      const messages = this.messageCount;
      const emittedEvents = this.emittedEventCount;
      const channelCounts = new Map(this.channelMessageCounts);
      const evidence = this.quotaEvidence({ elapsed, messages, emittedEvents, channelCounts });
      this.messageCount = 0;
      this.emittedEventCount = 0;
      this.channelMessageCounts.clear();
      this.lastRateCheck = now;
      this.lastQuotaEvidence = evidence;

      console.warn(`[WS][quota] ${this.formatQuotaEvidence(evidence)} activeL2=${this.activeLevel2Symbols.size} targetL2=${this.targetLevel2Subscriptions} maxL2=${this.maxLevel2Subscriptions}`);
      this.adjustLevel2SubscriptionsForRate(evidence.messageTps, evidence);
    }, 10000);
  }

  quotaEvidence({ elapsed, messages, emittedEvents, channelCounts = null }: QuotaEvidenceInput): QuotaEvidence {
    const safeElapsed = Math.max(elapsed, 1e-9);
    const channels: Record<string, number> = {};
    const entries = channelCounts instanceof Map
      ? channelCounts.entries()
      : Object.entries(channelCounts ?? {});
    for (const [channel, count] of entries) {
      channels[channel] = Number(count);
    }

    const channelTps: Record<string, number> = {};
    const channelTpm: Record<string, number> = {};
    for (const [channel, count] of Object.entries(channels)) {
      channelTps[channel] = count / safeElapsed;
      channelTpm[channel] = (count / safeElapsed) * 60;
    }

    return {
      elapsedSeconds: safeElapsed,
      messages,
      emittedEvents,
      messageTps: messages / safeElapsed,
      messageTpm: (messages / safeElapsed) * 60,
      tickTps: emittedEvents / safeElapsed,
      tickTpm: (emittedEvents / safeElapsed) * 60,
      channels,
      channelTps,
      channelTpm,
    };
  }

  formatQuotaEvidence(evidence: QuotaEvidence): string {
    const channelRates = Object.entries(evidence.channelTps ?? {})
      .map(([channel, tps]) => `${channel}:${tps.toFixed(2)}tps`)
      .join(',');

    return [
      `messages=${evidence.messages}`,
      `ticks=${evidence.emittedEvents}`,
      `msgTps=${evidence.messageTps.toFixed(2)}`,
      `msgTpm=${evidence.messageTpm.toFixed(1)}`,
      `tickTps=${evidence.tickTps.toFixed(2)}`,
      `tickTpm=${evidence.tickTpm.toFixed(1)}`,
      `window=${evidence.elapsedSeconds.toFixed(1)}s`,
      channelRates ? `channels=${channelRates}` : null,
    ].filter(Boolean).join(' ');
  }

  adjustLevel2SubscriptionsForRate(rate: number, evidence: QuotaEvidence | null = null): 'reduced' | 'expanded' | 'unchanged' {
    const suffix = evidence ? ` ${this.formatQuotaEvidence(evidence)}` : '';
    const discoveredTarget = this.targetLevel2SubscriptionsFromEvidence(evidence);

    if (discoveredTarget !== null && discoveredTarget !== this.targetLevel2Subscriptions) {
      const previousTarget = this.targetLevel2Subscriptions;
      this.targetLevel2Subscriptions = discoveredTarget;
      const direction = discoveredTarget < previousTarget ? 'Reducing' : 'Increasing';
      console.warn(`[WS][quota] Discovered websocket budget. ${direction} level2 funnel to ${this.targetLevel2Subscriptions}.${suffix}`);
      this.applySubscriptionFunnels({ reason: 'quota-discovered', evidence });
      return discoveredTarget < previousTarget ? 'reduced' : 'expanded';
    }

    if (rate > this.trafficHighWatermark && this.targetLevel2Subscriptions > 1) {
      this.targetLevel2Subscriptions = Math.max(this.minLevel2Subscriptions, Math.floor(this.targetLevel2Subscriptions / 2));
      console.warn(`[WS][quota] Traffic spike. Reducing level2 websocket subscriptions to ${this.targetLevel2Subscriptions}.${suffix}`);
      this.applySubscriptionFunnels({ reason: 'traffic-spike', evidence });
      return 'reduced';
    }

    if (rate < this.trafficLowWatermark && this.targetLevel2Subscriptions < this.maxLevel2Subscriptions) {
      this.targetLevel2Subscriptions += 1;
      console.warn(`[WS][quota] Traffic budget available. Increasing level2 websocket subscriptions to ${this.targetLevel2Subscriptions}.${suffix}`);
      this.applySubscriptionFunnels({ reason: 'traffic-budget', evidence });
      return 'expanded';
    }

    return 'unchanged';
  }

  targetLevel2SubscriptionsFromEvidence(evidence: QuotaEvidence | null): number | null {
    if (!evidence || this.maxLevel2Subscriptions === 0 || this.activeLevel2Symbols.size === 0) {
      return null;
    }

    const level2Tps = Number(evidence.channelTps?.l2_data ?? evidence.channelTps?.level2 ?? 0);
    if (!Number.isFinite(level2Tps) || level2Tps <= 0) {
      return null;
    }

    const tickerTps = Number(evidence.channelTps?.ticker ?? 0);
    const level2TpsPerSubscription = level2Tps / this.activeLevel2Symbols.size;
    if (!Number.isFinite(level2TpsPerSubscription) || level2TpsPerSubscription <= 0) {
      return null;
    }

    const usableTps = Math.max(0, (this.trafficHighWatermark * this.quotaUtilizationTarget) - tickerTps);
    return clampInt(
      Math.floor(usableTps / level2TpsPerSubscription),
      this.minLevel2Subscriptions,
      this.maxLevel2Subscriptions,
    );
  }

  recordChannelMessage(channel: string | undefined): void {
    const key = channel || 'unknown';
    this.channelMessageCounts.set(key, (this.channelMessageCounts.get(key) ?? 0) + 1);
  }

  recordLevel2Interest(symbol: string, weight = 1, now = Date.now()): number {
    if (!this.symbols.includes(symbol)) return 0;
    const previous = this.level2Interest.get(symbol) ?? 0;
    const updatedAt = this.level2InterestUpdatedAt.get(symbol) ?? now;
    const ageMs = Math.max(0, now - updatedAt);
    const decay = Math.pow(0.5, ageMs / this.interestHalfLifeMs);
    const nextScore = (previous * decay) + Math.max(0, weight);
    this.level2Interest.set(symbol, nextScore);
    this.level2InterestUpdatedAt.set(symbol, now);
    return nextScore;
  }

  interestScore(symbol: string, now = Date.now()): number {
    const score = this.level2Interest.get(symbol) ?? 0;
    const updatedAt = this.level2InterestUpdatedAt.get(symbol);
    if (!updatedAt) return score;
    const ageMs = Math.max(0, now - updatedAt);
    return score * Math.pow(0.5, ageMs / this.interestHalfLifeMs);
  }

  preferredLevel2Symbols(limit: number): string[] {
    const cappedLimit = clampInt(limit, 0, this.maxLevel2Subscriptions);
    const now = Date.now();
    return [...this.symbols]
      .sort((a, b) => {
        const scoreDiff = this.interestScore(b, now) - this.interestScore(a, now);
        return scoreDiff !== 0 ? scoreDiff : this.symbols.indexOf(a) - this.symbols.indexOf(b);
      })
      .slice(0, cappedLimit);
  }

  subscriptionFunnels(limit = this.targetLevel2Subscriptions): SubscriptionFunnels {
    const level2 = this.preferredLevel2Symbols(limit);
    const depthSet = new Set(level2);
    return {
      ticker: [...this.symbols],
      level2,
      tickerOnly: this.symbols.filter((symbol) => !depthSet.has(symbol)),
    };
  }

  applySubscriptionFunnels({ reason = 'rebalance', evidence = null }: { reason?: string; evidence?: QuotaEvidence | null } = {}): SubscriptionFunnels {
    const funnels = this.subscriptionFunnels();
    this.currentSubscriptionFunnels = funnels;
    this.setLevel2Subscriptions(funnels.level2);

    const suffix = evidence ? ` ${this.formatQuotaEvidence(evidence)}` : '';
    console.warn(`[WS][quota] funnel reason=${reason} ticker=${funnels.ticker.length} level2=${funnels.level2.length} tickerOnly=${funnels.tickerOnly.length}${suffix}`);
    return funnels;
  }

  setLevel2Subscriptions(nextSymbols: string[]): void {
    const next = new Set(nextSymbols.filter((symbol) => this.symbols.includes(symbol)).slice(0, this.targetLevel2Subscriptions));
    const toRemove = [...this.activeLevel2Symbols].filter((symbol) => !next.has(symbol));
    const toAdd = [...next].filter((symbol) => !this.activeLevel2Symbols.has(symbol));

    if (toRemove.length > 0) {
      this.sendSubscription('unsubscribe', 'level2', toRemove);
      for (const symbol of toRemove) {
        this.activeLevel2Symbols.delete(symbol);
        this.books.delete(symbol);
      }
    }

    if (toAdd.length > 0) {
      this.sendSubscription('subscribe', 'level2', toAdd);
      for (const symbol of toAdd) {
        this.activeLevel2Symbols.add(symbol);
      }
    }
  }

  ensureLevel2Subscription(symbol: string): void {
    if (!this.symbols.includes(symbol) || this.targetLevel2Subscriptions <= 0) return;
    this.recordLevel2Interest(symbol, 100);
    if (this.activeLevel2Symbols.has(symbol)) return;

    this.applySubscriptionFunnels({ reason: `interest:${symbol}` });
  }

  subscribeSymbol(symbol: string): void {
    if (this.symbols.includes(symbol)) return;
    this.symbols.push(symbol);

    this.sendSubscription('subscribe', 'ticker', [symbol]);

    this.maxLevel2Subscriptions = this.symbols.length;
    this.applySubscriptionFunnels({ reason: `promote:${symbol}` });
  }

  sendSubscription(type: 'subscribe' | 'unsubscribe' | string, channel: string, productIds: string[]): void {
    if (productIds.length === 0) return;
    if (this.ws?.readyState !== 1) return;
    this.ws.send(JSON.stringify({
      type,
      product_ids: productIds,
      channel,
    }));
  }

  handleMessage(msg: any): void {
    this.recordChannelMessage(msg.channel);

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
        this.recordLevel2Interest(ticker.product_id, 0.05);
        this.checkAndEmit(ticker.product_id, 'ticker');
      }
    } else if (msg.channel === 'l2_data') {
      const event = msg.events?.[0];
      if (event) {
        const symbol = event.product_id;
        if (event.type === 'snapshot') {
          const bids = new Map<number, number>();
          const asks = new Map<number, number>();
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

  checkAndEmit(symbol: string, _triggerType: string): void {
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
      const interestWeight = deviationTrigger
        ? Math.max(5, priceDiffBps / Math.max(this.deviationLimitBps, 1))
        : 1;
      this.recordLevel2Interest(symbol, interestWeight, now);

      this.lastEmittedTime.set(symbol, now);
      this.lastEmittedPrice.set(symbol, price);

      const book = this.books.get(symbol);
      let bids: BookLevel[] = [];
      let asks: BookLevel[] = [];

      if (book) {
        bids = [...book.bids.entries()]
          .map(([p, s]) => ({ price: p, size: s }))
          .sort((a, b) => b.price - a.price);
        asks = [...book.asks.entries()]
          .map(([p, s]) => ({ price: p, size: s }))
          .sort((a, b) => a.price - b.price);
      } else {
        this.ensureLevel2Subscription(symbol);
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

  pushEvent(event: MarketEvent): void {
    this.emittedEventCount += 1;
    const existingIdx = this.queue.findIndex((e) => e.symbol === event.symbol);
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

  async *stream(): AsyncGenerator<MarketEvent> {
    this.connect();
    while (true) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.resolveNext = resolve;
        });
      }
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
    }
  }
}
