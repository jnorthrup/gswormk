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
  synthesizeDrift,
  urgencyFromInnovation,
} from './signals.mjs';
import { PaperBroker } from './paper-broker.mjs';
import { DrawThroughCacheManager } from './cache-manager.mjs';
import { buildDecisionVector, derivePortfolioTargets } from './optimizer.mjs';
import { applyRiskInvariants, classifyRiskState, computeDrawdown } from './risk.mjs';

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
    for await (const batch of this.batchFeed(feed.stream())) {
      await this.processBatch(batch);
    }

    const portfolio = this.enrichedPortfolio();
    const recentSignals = await this.storage.getRecentSignals({ limit: 5 });
    const recentOrders = await this.storage.getRecentOrders({ limit: 5 });
    const recentDecisions = await this.storage.getRecentDecisions({ limit: 5 });

    return {
      portfolio,
      positions: portfolio.positions,
      metrics: {
        ...this.state.metrics,
        cacheHitRatio: round(this.state.metrics.cacheHits / Math.max(1, this.state.metrics.cacheHits + this.state.metrics.apiCalls), 4),
      },
      latestSignals: recentSignals,
      latestOrders: recentOrders,
      latestDecisions: recentDecisions,
    };
  }

  async *batchFeed(stream) {
    let buffer = [];
    let currentTimestamp = null;
    for await (const event of stream) {
      if (currentTimestamp === null || currentTimestamp === event.timestamp) {
        currentTimestamp = event.timestamp;
        buffer.push(event);
        continue;
      }
      yield buffer;
      buffer = [event];
      currentTimestamp = event.timestamp;
    }
    if (buffer.length > 0) yield buffer;
  }

  async processBatch(events) {
    const signals = [];
    const timestamp = events[0].timestamp;

    for (const event of events) {
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
      signals.push(signal);

      this.state.prices[event.symbol] = event.last;
      symbolState.lastPrice = event.last;
      symbolState.kalman = signal.kalmanState;
    }

    const targets = derivePortfolioTargets({
      signals,
      reinvestPct: this.config.reinvestPct,
      maxPositionPct: this.config.maxPositionPct,
    });

    const portfolioBefore = this.enrichedPortfolio();
    const drawdownBefore = computeDrawdown({ nav: portfolioBefore.nav, peakNav: this.state.peakNav });
    const riskEnvelope = applyRiskInvariants({
      targets,
      drawdown: drawdownBefore,
      maxDrawdownPct: this.config.maxDrawdownPct,
      maxPositionPct: this.config.maxPositionPct,
    });

    for (const signal of signals) {
      const constrainedTarget = riskEnvelope.constrained.get(signal.symbol) ?? 0;
      const decision = await this.rebalance({
        event: signal.event,
        signal,
        targetWeight: constrainedTarget,
      });

      const portfolio = this.enrichedPortfolio();
      this.state.peakNav = Math.max(this.state.peakNav, portfolio.nav);
      const drawdown = computeDrawdown({ nav: portfolio.nav, peakNav: this.state.peakNav });
      const riskState = classifyRiskState({
        drawdown,
        maxDrawdownPct: this.config.maxDrawdownPct,
        currentWeight: this.currentWeight(signal.symbol, signal.event.last),
        maxPositionPct: this.config.maxPositionPct,
      });

      await this.storage.insertSignal({
        timestamp,
        symbol: signal.symbol,
        mid: signal.event.mid,
        spread: signal.spread,
        effectiveCost: signal.effectiveCost,
        obi: signal.obi,
        innovationZ: signal.innovationZ,
        rvDown: signal.rvDown,
        tailDependence: signal.tailDependence,
        alignment: signal.alignment,
        cacheQuality: signal.cacheQuality,
        effectiveDrift: signal.effectiveDrift,
        targetWeight: constrainedTarget,
        currentWeight: signal.currentWeight,
        trigger: signal.trigger,
        drawdown,
        quotaHit: signal.cacheHit ? 1 : 0,
        regimeMomentum: signal.regime.momentum,
        regimeMeanReversion: signal.regime.meanReversion,
        regimeVolatility: signal.regime.volatility,
        riskState,
      });

      await this.storage.insertQuotaMetric({
        timestamp,
        symbol: signal.symbol,
        cacheHits: this.state.metrics.cacheHits,
        apiCalls: this.state.metrics.apiCalls,
        gapCount: this.state.metrics.gaps,
        cacheHitRatio: this.state.metrics.cacheHits / Math.max(1, this.state.metrics.cacheHits + this.state.metrics.apiCalls),
      });

      const decisionVector = buildDecisionVector({
        signal,
        targetWeight: constrainedTarget,
        currentWeight: signal.currentWeight,
      });
      await this.storage.insertDecision({
        timestamp,
        symbol: signal.symbol,
        targetWeight: constrainedTarget,
        currentWeight: signal.currentWeight,
        deviation: decisionVector.deviation,
        trigger: signal.trigger,
        notionalDelta: decision?.notionalDelta ?? decisionVector.deviation * portfolio.nav,
        executed: Boolean(decision?.accepted),
        reason: decision?.reason ?? (decisionVector.shouldTrade ? 'ORDER_REJECTED' : 'INSIDE_NO_TRADE_BAND'),
      });

      if (decision?.accepted) {
        this.state.metrics.ordersAccepted += 1;
        await this.storage.insertOrder(decision);
      } else if (decision) {
        this.state.metrics.ordersRejected += 1;
      }

      await this.storage.upsertCandles([this.toCandle(signal.event)]);
    }

    const portfolioAfter = this.enrichedPortfolio();
    await this.storage.insertPortfolioSnapshot({
      timestamp,
      nav: portfolioAfter.nav,
      cash: portfolioAfter.cash,
      peakNav: this.state.peakNav,
      drawdown: portfolioAfter.drawdown,
      positions: portfolioAfter.positions,
    });
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
    const regime = {
      momentum: Math.max(-1, Math.min(1, kalman.innovationZ / 5)),
      meanReversion: Math.max(-1, Math.min(1, -obi)),
      volatility: Math.max(0, Math.min(1, annualizedRvDown / 20)),
    };

    return {
      symbol: event.symbol,
      event,
      cacheHit: cacheResult.cacheHit,
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
      urgency: urgencyFromInnovation(kalman.innovationZ),
      regime,
    };
  }

  currentWeight(symbol, price) {
    const portfolio = this.broker.getPortfolio(this.state.prices);
    if (portfolio.nav <= 0) return 0;
    return this.broker.getPositionValue(symbol, price) / portfolio.nav;
  }

  async rebalance({ event, signal, targetWeight }) {
    const portfolio = this.broker.getPortfolio({ ...this.state.prices, [event.symbol]: event.last });
    const drawdown = (this.state.peakNav - portfolio.nav) / this.state.peakNav;
    if (drawdown > this.config.maxDrawdownPct) {
      return {
        accepted: false,
        reason: 'DRAWDOWN_HALT',
        notionalDelta: 0,
      };
    }

    const deltaWeight = targetWeight - signal.currentWeight;
    if (Math.abs(deltaWeight) <= signal.trigger) {
      return {
        accepted: false,
        reason: 'INSIDE_NO_TRADE_BAND',
        notionalDelta: deltaWeight * portfolio.nav,
      };
    }

    const notional = deltaWeight * portfolio.nav;
    if (Math.abs(notional) < this.config.minActionUsd) {
      return {
        accepted: false,
        reason: 'MIN_NOTIONAL',
        notionalDelta: notional,
      };
    }

    const side = notional > 0 ? 'BUY' : 'SELL';
    const urgency = signal.urgency;
    const bestBid = event.bids[0].price;
    const bestAsk = event.asks[0].price;
    const executionPrice = side === 'BUY'
      ? Math.min(bestAsk, event.mid + (urgency * (bestAsk - event.mid)))
      : Math.max(bestBid, event.mid - (urgency * (event.mid - bestBid)));
    const quantity = Math.abs(notional) / executionPrice;

    const result = this.broker.execute({
      symbol: event.symbol,
      side,
      quantity,
      price: executionPrice,
      timestamp: event.timestamp,
    });
    return {
      ...result,
      reason: result.accepted ? 'EXECUTED' : result.reason,
      notionalDelta: notional,
    };
  }

  enrichedPortfolio() {
    const portfolio = this.broker.getPortfolio(this.state.prices);
    const drawdown = computeDrawdown({ nav: portfolio.nav, peakNav: this.state.peakNav });
    const positions = Object.entries(portfolio.positions).map(([symbol, position]) => ({
      symbol,
      units: position.units,
      price: position.price,
      marketValue: position.marketValue,
      weight: portfolio.nav > 0 ? position.marketValue / portfolio.nav : 0,
    })).filter((position) => Math.abs(position.units) > 1e-9);
    return {
      cash: portfolio.cash,
      nav: portfolio.nav,
      peakNav: this.state.peakNav,
      drawdown,
      positions,
    };
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