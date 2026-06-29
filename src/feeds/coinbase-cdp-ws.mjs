import { generateJwt } from '@coinbase/cdp-sdk/auth';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export class CoinbaseCDPWS {
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
    cdpApiKeyPath = resolve(process.env.HOME, '.cdp/cdp_api_key.json'),
    requestHost = 'api.coinbase.com',
    useUserEndpoint = false,
  } = {}) {
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
    this.requestHost = requestHost;
    this.useUserEndpoint = useUserEndpoint;

    // Load CDP API key
    try {
      const raw = readFileSync(cdpApiKeyPath, 'utf8');
      this.keyData = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Failed to load CDP key from ${cdpApiKeyPath}: ${e.message}`);
    }

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

    this.lastEmittedTime = new Map();
    this.lastEmittedPrice = new Map();

    this.messageCount = 0;
    this.emittedEventCount = 0;
    this.channelMessageCounts = new Map();
    this.lastQuotaEvidence = null;
    this.lastRateCheck = Date.now();
    this.trafficMonitor = null;
    this.jwtRefreshTimer = null;
    this.currentJwt = null;
    this.jwtExpiry = 0;
  }

  get wsUrl() {
    return this.useUserEndpoint
      ? 'wss://advanced-trade-ws-user.coinbase.com'
      : 'wss://advanced-trade-ws.coinbase.com';
  }

  async generateJwt() {
    const now = Math.floor(Date.now() / 1000);
    if (this.currentJwt && now < this.jwtExpiry - 10) {
      return this.currentJwt;
    }
    const apiKeyId = this.keyData.name || this.keyData.id;
    if (!apiKeyId) {
      throw new Error('Key name/id is required');
    }
    const token = await generateJwt({
      apiKeyId,
      apiKeySecret: this.keyData.privateKey,
      requestMethod: 'GET',
      requestHost: this.requestHost,
      requestPath: '/api/v3/brokerage/accounts',
      expiresIn: 120,
    });
    this.currentJwt = token;
    this.jwtExpiry = now + 120;
    return token;
  }

  startJwtRefresh() {
    if (this.jwtRefreshTimer) return;
    this.jwtRefreshTimer = setInterval(async () => {
      try {
        await this.generateJwt();
        // Resubscribe to private channels with new JWT
        if (this.useUserEndpoint && this.ws?.readyState === 1) {
          await this.resubscribePrivateChannels();
        }
      } catch (err) {
        console.error('[CDP-WS] JWT refresh failed:', err.message);
      }
    }, 110 * 1000); // Refresh every 110s (JWT valid 120s)
  }

  stopJwtRefresh() {
    if (this.jwtRefreshTimer) {
      clearInterval(this.jwtRefreshTimer);
      this.jwtRefreshTimer = null;
    }
  }

  async resubscribePrivateChannels() {
    const jwt = await this.generateJwt();
    for (const symbol of this.activeLevel2Symbols) {
      this.sendSubscription('subscribe', 'user', [symbol], jwt);
    }
  }

  connect() {
    console.log(`[CDP-WS] Connecting to ${this.wsUrl}...`);
    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
      console.log('[CDP-WS] Connected. Subscribing to channels...');
      this.activeLevel2Symbols.clear();
      this.books.clear();
      // Subscribe to ticker for ALL symbols
      this.sendSubscription('subscribe', 'ticker', this.symbols);
      this.applySubscriptionFunnels({ reason: 'connect' });
      this.startTrafficMonitor();
      if (this.useUserEndpoint) {
        this.startJwtRefresh();
      }
    };

    this.ws.onmessage = (event) => {
      this.messageCount += 1;
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (error) {
        console.error('[CDP-WS] Error handling message:', error);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[CDP-WS] Error:', error);
    };

    this.ws.onclose = (event) => {
      console.log(`[CDP-WS] Connection closed (code: ${event.code}, reason: ${event.reason}). Reconnecting in 5s...`);
      this.stopJwtRefresh();
      if (this.trafficMonitor) {
        clearInterval(this.trafficMonitor);
        this.trafficMonitor = null;
      }
      setTimeout(() => this.connect(), 5000);
    };
  }

  startTrafficMonitor() {
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

      console.warn(`[CDP-WS][quota] ${this.formatQuotaEvidence(evidence)} activeL2=${this.activeLevel2Symbols.size} targetL2=${this.targetLevel2Subscriptions} maxL2=${this.maxLevel2Subscriptions}`);
      this.adjustLevel2SubscriptionsForRate(evidence.messageTps, evidence);
    }, 10000);
  }

  quotaEvidence({ elapsed, messages, emittedEvents, channelCounts = null }) {
    const safeElapsed = Math.max(elapsed, 1e-9);
    const channels = {};
    const entries = channelCounts instanceof Map
      ? channelCounts.entries()
      : Object.entries(channelCounts ?? {});
    for (const [channel, count] of entries) {
      channels[channel] = count;
    }

    const channelTps = {};
    const channelTpm = {};
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

  formatQuotaEvidence(evidence) {
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

  adjustLevel2SubscriptionsForRate(rate, evidence = null) {
    const suffix = evidence ? ` ${this.formatQuotaEvidence(evidence)}` : '';
    const discoveredTarget = this.targetLevel2SubscriptionsFromEvidence(evidence);

    if (discoveredTarget !== null && discoveredTarget !== this.targetLevel2Subscriptions) {
      const previousTarget = this.targetLevel2Subscriptions;
      this.targetLevel2Subscriptions = discoveredTarget;
      const direction = discoveredTarget < previousTarget ? 'Reducing' : 'Increasing';
      console.warn(`[CDP-WS][quota] Discovered websocket budget. ${direction} level2 funnel to ${this.targetLevel2Subscriptions}.${suffix}`);
      this.applySubscriptionFunnels({ reason: 'quota-discovered', evidence });
      return discoveredTarget < previousTarget ? 'reduced' : 'expanded';
    }

    if (rate > this.trafficHighWatermark && this.targetLevel2Subscriptions > 1) {
      this.targetLevel2Subscriptions = Math.max(this.minLevel2Subscriptions, Math.floor(this.targetLevel2Subscriptions / 2));
      console.warn(`[CDP-WS][quota] Traffic spike. Reducing level2 websocket subscriptions to ${this.targetLevel2Subscriptions}.${suffix}`);
      this.applySubscriptionFunnels({ reason: 'traffic-spike', evidence });
      return 'reduced';
    }

    if (rate < this.trafficLowWatermark && this.targetLevel2Subscriptions < this.maxLevel2Subscriptions) {
      this.targetLevel2Subscriptions += 1;
      console.warn(`[CDP-WS][quota] Traffic budget available. Increasing level2 websocket subscriptions to ${this.targetLevel2Subscriptions}.${suffix}`);
      this.applySubscriptionFunnels({ reason: 'traffic-budget', evidence });
      return 'expanded';
    }

    return 'unchanged';
  }

  targetLevel2SubscriptionsFromEvidence(evidence) {
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

  recordChannelMessage(channel) {
    const key = channel || 'unknown';
    this.channelMessageCounts.set(key, (this.channelMessageCounts.get(key) ?? 0) + 1);
  }

  recordLevel2Interest(symbol, weight = 1, now = Date.now()) {
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

  interestScore(symbol, now = Date.now()) {
    const score = this.level2Interest.get(symbol) ?? 0;
    const updatedAt = this.level2InterestUpdatedAt.get(symbol);
    if (!updatedAt) return score;
    const ageMs = Math.max(0, now - updatedAt);
    return score * Math.pow(0.5, ageMs / this.interestHalfLifeMs);
  }

  preferredLevel2Symbols(limit) {
    const cappedLimit = clampInt(limit, 0, this.maxLevel2Subscriptions);
    const now = Date.now();
    return [...this.symbols]
      .sort((a, b) => {
        const scoreDiff = this.interestScore(b, now) - this.interestScore(a, now);
        return scoreDiff !== 0 ? scoreDiff : this.symbols.indexOf(a) - this.symbols.indexOf(b);
      })
      .slice(0, cappedLimit);
  }

  subscriptionFunnels(limit = this.targetLevel2Subscriptions) {
    const level2 = this.preferredLevel2Symbols(limit);
    const depthSet = new Set(level2);
    return {
      ticker: [...this.symbols],
      level2,
      tickerOnly: this.symbols.filter((symbol) => !depthSet.has(symbol)),
    };
  }

  async applySubscriptionFunnels({ reason = 'rebalance', evidence = null } = {}) {
    const funnels = this.subscriptionFunnels();
    this.currentSubscriptionFunnels = funnels;
    await this.setLevel2Subscriptions(funnels.level2);

    const suffix = evidence ? ` ${this.formatQuotaEvidence(evidence)}` : '';
    console.warn(`[CDP-WS][quota] funnel reason=${reason} ticker=${funnels.ticker.length} level2=${funnels.level2.length} tickerOnly=${funnels.tickerOnly.length}${suffix}`);
    return funnels;
  }

  async setLevel2Subscriptions(nextSymbols) {
    const next = new Set(nextSymbols.filter((symbol) => this.symbols.includes(symbol)).slice(0, this.targetLevel2Subscriptions));
    const toRemove = [...this.activeLevel2Symbols].filter((symbol) => !next.has(symbol));
    const toAdd = [...next].filter((symbol) => !this.activeLevel2Symbols.has(symbol));

    if (toRemove.length > 0) {
      await this.sendSubscription('unsubscribe', 'level2', toRemove);
      for (const symbol of toRemove) {
        this.activeLevel2Symbols.delete(symbol);
        this.books.delete(symbol);
      }
    }

    if (toAdd.length > 0) {
      await this.sendSubscription('subscribe', 'level2', toAdd);
      for (const symbol of toAdd) {
        this.activeLevel2Symbols.add(symbol);
      }
    }
  }

  async ensureLevel2Subscription(symbol) {
    if (!this.symbols.includes(symbol) || this.targetLevel2Subscriptions <= 0) return;
    this.recordLevel2Interest(symbol, 100);
    if (this.activeLevel2Symbols.has(symbol)) return;
    await this.applySubscriptionFunnels({ reason: `interest:${symbol}` });
  }

  subscribeSymbol(symbol) {
    if (this.symbols.includes(symbol)) return;
    this.symbols.push(symbol);
    this.maxLevel2Subscriptions = this.symbols.length;
    this.currentSubscriptionFunnels.ticker.push(symbol);
    this.currentSubscriptionFunnels.tickerOnly.push(symbol);
    this.sendSubscription('subscribe', 'ticker', [symbol]);
    this.applySubscriptionFunnels({ reason: `promote:${symbol}` });
  }

  async sendSubscription(type, channel, productIds, jwt = null) {
    if (productIds.length === 0) return;
    if (this.ws?.readyState !== 1) return;

    const message = { type, product_ids: productIds, channel };
    if (jwt) {
      message.jwt = jwt;
    }

    this.ws.send(JSON.stringify(message));
  }

  handleMessage(msg) {
    this.recordChannelMessage(msg.channel);

    if (msg.channel === 'ticker' || msg.channel === 'ticker_batch') {
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
    } else if (msg.channel === 'l2_data' || msg.channel === 'level2') {
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
    } else if (msg.channel === 'user') {
      // User order updates - handle if needed
      console.log('[CDP-WS] User channel message:', JSON.stringify(msg).slice(0, 200));
    } else if (msg.channel === 'heartbeats') {
      // Heartbeat received - connection alive
    } else if (msg.channel === 'market_trades') {
      // Trade data - could be used for additional signals
    } else if (msg.channel === 'candles') {
      // Candle data
    } else if (msg.type === 'error') {
      console.error('[CDP-WS] Server error:', msg.message);
    }
  }

  checkAndEmit(symbol, triggerType) {
    const ticker = this.lastTicker.get(symbol);
    if (!ticker) return;

    const price = ticker.price;
    const now = Date.now();

    const lastTime = this.lastEmittedTime.get(symbol) || 0;
    const lastPrice = this.lastEmittedPrice.get(symbol) || 0;

    const timeDiff = now - lastTime;
    const priceDiffPct = lastPrice > 0 ? Math.abs(price - lastPrice) / lastPrice : 1.0;
    const priceDiffBps = priceDiffPct * 10000;

    const timeTrigger = timeDiff >= this.evaluateIntervalMs;
    const deviationTrigger = priceDiffBps >= this.deviationLimitBps;

    if (timeTrigger || deviationTrigger) {
      const interestWeight = deviationTrigger
        ? Math.max(5, priceDiffBps / Math.max(this.deviationLimitBps, 1))
        : 1;
      this.recordLevel2Interest(symbol, interestWeight, now);

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
      } else {
        this.ensureLevel2Subscription(symbol);
      }

      if (bids.length === 0) {
        bids = [{ price: ticker.bestBid, size: ticker.bestBidQty || 1 }];
        asks = [{ price: ticker.bestAsk, size: ticker.bestAskQty || 1 }];
      }

      this.pushEvent({
        type: 'market',
        symbol,
        timestamp: ticker.timestamp,
        mid: (ticker.bestBid + ticker.bestAsk) / 2 || price,
        last: price,
        bids,
        asks,
        volume: ticker.bestBidQty || 1,
      });
    }
  }

  pushEvent(event) {
    this.emittedEventCount += 1;
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

  close() {
    this.stopJwtRefresh();
    if (this.trafficMonitor) {
      clearInterval(this.trafficMonitor);
      this.trafficMonitor = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}