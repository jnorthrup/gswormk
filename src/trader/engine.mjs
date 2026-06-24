import { round } from '../lib/math.mjs';
import {
  alignmentScore,
  computeDownsideSemivariance,
  computeEffectiveSpread,
  computeObi,
  computeTailDependence,
  induceKelly,
  induceTrigger,
  kalmanStep,
  quotaQuality,
  rollingVolatility,
  synthesizeDrift,
  urgencyFromInnovation,
} from './signals.mjs';
import { PaperBroker } from './paper-broker.mjs';
import { DrawThroughCacheManager } from './cache-manager.mjs';

export class TraderEngine {
  constructor({ storage, config }) {
    this.storage = storage;
    this.config = config;
    this.broker = new PaperBroker({ initialCash: config.initialCash });
    this.cache = new DrawThroughCacheManager({ storage, freshnessMs: config.cacheFreshnessMs });
    this.state = {
      perSymbol: new Map(),
      prices: {},
      peakNav: config.initialCash,
      metrics: {
        cacheHits: 0,
        apiCalls: 0,
        gaps: 0,
        ordersAccepted: 0,
        ordersRejected: 0,
      },
    };
  }

  ensureSymbolState(symbol, initialPrice) {
    if (!this.state.perSymbol.has(symbol)) {
      this.state.perSymbol.set(symbol, {
        lastPrice: initialPrice,
        returns: [],
        btcReturns: [],
        kalman: { x: initialPrice, p: 1 },
      });
    }
    return this.state.perSymbol.get(symbol);
  }

  async run(feed) {
    for await (const event of feed.stream()) {
      await this.processEvent(event);
    }

    const portfolio = this.broker.getPortfolio(this.state.prices);
    const recentSignals = await this.storage.getRecentSignals({ limit: 5 });
    const recentOrders = await this.storage.getRecentOrders({ limit: 5 });

    return {
      portfolio,
      metrics: {
        ...this.state.metrics,
        cacheHitRatio: round(this.state.metrics.cacheHits / Math.max(1, this.state.metrics.cacheHits + this.state.metrics.apiCalls), 4),
      },
      recentSignals,
      recentOrders,
    };
  }

  async processEvent(event) {
    const symbolState = this.ensureSymbolState(event.symbol, event.last);
    const previousPrice = symbolState.lastPrice;
    const simpleReturn = previousPrice > 0 ? (event.last / previousPrice) - 1 : 0;

    symbolState.returns.push(simpleReturn);
    if (symbolState.returns.length > this.config.semivarianceWindow) {
      symbolState.returns.shift();
    }

    if (event.symbol === 'BTC-USD') {
      for (const state of this.state.perSymbol.values()) {
        state.btcReturns.push(simpleReturn);
        if (state.btcReturns.length > this.config.tailWindow) {
          state.btcReturns.shift();
        }
      }
    }

    const cacheResult = await this.cache.loadRecentCandles({
      symbol: event.symbol,
      limit: 120,
      eventTimestamp: event.timestamp,
      buildCandle: () => this.toCandle(event),
    });

    if (cacheResult.cacheHit) {
      this.state.metrics.cacheHits += 1;
    } else {
      this.state.metrics.apiCalls += 1;
    }
    this.state.metrics.gaps += cacheResult.gapCount;

    const signal = this.computeSignal({ event, symbolState, cacheResult });
    const order = this.rebalance({ event, signal });

    this.state.prices[event.symbol] = event.last;
    symbolState.lastPrice = event.last;
    symbolState.kalman = signal.kalmanState;

    const portfolio = this.broker.getPortfolio(this.state.prices);
    this.state.peakNav = Math.max(this.state.peakNav, portfolio.nav);
    const drawdown = (this.state.peakNav - portfolio.nav) / this.state.peakNav;

    await this.storage.insertSignal({
      timestamp: event.timestamp,
      symbol: event.symbol,
      mid: event.mid,
      spread: signal.spread,
      effectiveCost: signal.effectiveCost,
      obi: signal.obi,
      innovationZ: signal.innovationZ,
      rvDown: signal.rvDown,
      tailDependence: signal.tailDependence,
      alignment: signal.alignment,
      cacheQuality: signal.cacheQuality,
      effectiveDrift: signal.effectiveDrift,
      targetWeight: signal.targetWeight,
      currentWeight: signal.currentWeight,
      trigger: signal.trigger,
      drawdown,
      quotaHit: cacheResult.cacheHit ? 1 : 0,
    });

    await this.storage.insertQuotaMetric({
      timestamp: event.timestamp,
      symbol: event.symbol,
      cacheHits: this.state.metrics.cacheHits,
      apiCalls: this.state.metrics.apiCalls,
      gapCount: this.state.metrics.gaps,
      cacheHitRatio: this.state.metrics.cacheHits / Math.max(1, this.state.metrics.cacheHits + this.state.metrics.apiCalls),
    });

    if (order?.accepted) {
      this.state.metrics.ordersAccepted += 1;
      await this.storage.insertOrder(order);
    } else if (order && !order.accepted) {
      this.state.metrics.ordersRejected += 1;
    }

    await this.storage.upsertCandles([this.toCandle(event)]);
  }

  computeSignal({ event, symbolState, cacheResult }) {
    const bestBid = event.bids[0].price;
    const bestAsk = event.asks[0].price;
    const obi = computeObi(event.bids, event.asks, event.mid);
    const kalman = kalmanStep(symbolState.kalman, event.last, this.config.kalmanQ, this.config.kalmanR);
    const rvDown = computeDownsideSemivariance(symbolState.returns);
    const annualizedRvDown = Math.max(rvDown * this.config.annualizationFactor, 1e-9);
    const tailDependence = computeTailDependence(symbolState.returns, symbolState.btcReturns, this.config.tailQuantile);
    const effectiveCost = computeEffectiveSpread(bestBid, bestAsk);
    const trigger = induceTrigger(effectiveCost, annualizedRvDown);

    const replayReturns = cacheResult.candles.slice(0, this.config.semivarianceWindow - 1)
      .map((candle, index, rows) => {
        const next = rows[index + 1];
        if (!next) return null;
        return (Number(candle.close) / Number(next.close)) - 1;
      })
      .filter((value) => value !== null);
    const replayRvDown = Math.max(computeDownsideSemivariance(replayReturns) * this.config.annualizationFactor, 1e-9);
    const liveDrift = obi + kalman.innovationZ;
    const replayDrift = obi + (replayReturns.at(0) ?? 0);
    const alignment = alignmentScore(
      { drift: liveDrift, rvDown: annualizedRvDown, tail: tailDependence },
      { drift: replayDrift, rvDown: replayRvDown, tail: tailDependence },
    );
    const cacheQuality = quotaQuality({ cacheHit: cacheResult.cacheHit, gapCount: cacheResult.gapCount });
    const effectiveDrift = synthesizeDrift({ obi, innovationZ: kalman.innovationZ, alignment, cacheQuality });
    const rawKelly = induceKelly({ effectiveDrift, rvDown: annualizedRvDown, tailDependence });
    const currentWeight = this.currentWeight(event.symbol, event.last);
    const targetWeight = this.targetWeight(rawKelly, event.symbol);

    return {
      obi,
      innovationZ: kalman.innovationZ,
      kalmanState: kalman.state,
      rvDown: annualizedRvDown,
      tailDependence,
      effectiveCost,
      spread: (bestAsk - bestBid) / event.mid,
      trigger,
      alignment,
      cacheQuality,
      effectiveDrift,
      rawKelly,
      currentWeight,
      targetWeight,
      urgency: urgencyFromInnovation(kalman.innovationZ),
    };
  }

  currentWeight(symbol, price) {
    const portfolio = this.broker.getPortfolio(this.state.prices);
    if (portfolio.nav <= 0) return 0;
    return this.broker.getPositionValue(symbol, price) / portfolio.nav;
  }

  targetWeight(rawKelly, symbol) {
    const positiveKelly = Math.max(0, rawKelly);
    const all = [...this.state.perSymbol.entries()].map(([entrySymbol, state]) => {
      if (entrySymbol === symbol) return positiveKelly;
      const price = this.state.prices[entrySymbol] ?? state.lastPrice;
      const effectiveDrift = price > 0 ? ((price / state.lastPrice) - 1) : 0;
      return Math.max(0, effectiveDrift * this.config.reinvestPct * 10);
    });
    const denominator = Math.max(1e-9, all.reduce((sum, value) => sum + value, 0));
    return Math.min(this.config.maxPositionPct, this.config.reinvestPct * (positiveKelly / denominator));
  }

  rebalance({ event, signal }) {
    const portfolio = this.broker.getPortfolio({ ...this.state.prices, [event.symbol]: event.last });
    const drawdown = (this.state.peakNav - portfolio.nav) / this.state.peakNav;
    if (drawdown > this.config.maxDrawdownPct) {
      return null;
    }

    const deltaWeight = signal.targetWeight - signal.currentWeight;
    if (Math.abs(deltaWeight) <= signal.trigger) {
      return null;
    }

    const notional = deltaWeight * portfolio.nav;
    if (Math.abs(notional) < this.config.minActionUsd) {
      return null;
    }

    const side = notional > 0 ? 'BUY' : 'SELL';
    const urgency = signal.urgency;
    const bestBid = event.bids[0].price;
    const bestAsk = event.asks[0].price;
    const executionPrice = side === 'BUY'
      ? Math.min(bestAsk, event.mid + (urgency * (bestAsk - event.mid)))
      : Math.max(bestBid, event.mid - (urgency * (event.mid - bestBid)));
    const quantity = Math.abs(notional) / executionPrice;

    return this.broker.execute({
      symbol: event.symbol,
      side,
      quantity,
      price: executionPrice,
      timestamp: event.timestamp,
    });
  }

  toCandle(event) {
    return {
      symbol: event.symbol,
      granularity: '1m',
      start: event.timestamp,
      open: event.last,
      high: event.last,
      low: event.last,
      close: event.last,
      volume: event.volume,
    };
  }
}