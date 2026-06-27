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
  computeRsiSplatAndKalman,
} from './signals.mjs';
import { PaperBroker } from './paper-broker.mjs';
import { DrawThroughCacheManager } from './cache-manager.mjs';
import { buildDecisionVector, derivePortfolioTargets } from './optimizer.mjs';
import { applyRiskInvariants, classifyRiskState, computeDrawdown } from './risk.mjs';
import { CoinMarketCapScraper } from '../feeds/coinmarketcap-scraper.mjs';

export class TraderEngine {
  constructor({ storage, config }) {
    this.storage = storage;
    this.config = config;
    this.broker = new PaperBroker({ initialCash: config.initialCash, persistPath: config.paperWalletPath });
    this.cache = new DrawThroughCacheManager({ storage, freshnessMs: config.cacheFreshnessMs, restClient: config.restClient });
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
      ioStats: {
        evalDurationMs: [],
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

  async warmup() {
    console.log('[Engine] Warming up symbol states from database history...');
    const lookback = (this.config.semivarianceWindow || 120) + 1;
    const tailLookback = (this.config.tailWindow || 180) + 1;

    for (const symbol of this.config.symbols) {
      let candles = await this.storage.getRecentCandles({ symbol, limit: lookback });
      
      if (candles.length <= 1 && this.config.restClient) {
        try {
          const now = Date.now();
          const seconds = 60;
          const start = new Date(now - (lookback * seconds * 1000)).toISOString();
          const end = new Date(now).toISOString();
          console.log(`[Engine] Cache cold for warmup on ${symbol}. Seeding from REST...`);
          
          await this.cache.loadRecentCandles({
            symbol,
            limit: lookback,
            eventTimestamp: end,
            buildCandle: () => ({}),
            granularity: '1m',
          });
          
          candles = await this.storage.getRecentCandles({ symbol, limit: lookback });
        } catch (error) {
          console.error(`[Engine] Warmup candle seeding failed for ${symbol}:`, error);
        }
      }

      const state = this.ensureSymbolState(symbol, 0);

      if (candles.length > 1) {
        const sorted = [...candles].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
        state.lastPrice = Number(sorted[sorted.length - 1].close);
        state.kalman = { x: state.lastPrice, p: 1 };

        state.returns = [];
        for (let i = 0; i < sorted.length - 1; i++) {
          const prev = Number(sorted[i].close);
          const next = Number(sorted[i + 1].close);
          const ret = prev > 0 ? (next / prev) - 1 : 0;
          state.returns.push(ret);
        }
        console.log(`[Engine] Warmed up ${state.returns.length} returns for ${symbol}. Last price: $${state.lastPrice}`);
      }
    }

    let btcCandles = await this.storage.getRecentCandles({ symbol: 'BTC-USD', limit: tailLookback });
    
    if (btcCandles.length <= 1 && this.config.restClient) {
      try {
        const now = Date.now();
        const seconds = 60;
        const start = new Date(now - (tailLookback * seconds * 1000)).toISOString();
        const end = new Date(now).toISOString();
        console.log(`[Engine] Seeding BTC-USD tail candles for warmup...`);
        await this.cache.loadRecentCandles({
          symbol: 'BTC-USD',
          limit: tailLookback,
          eventTimestamp: end,
          buildCandle: () => ({}),
          granularity: '1m',
        });
        btcCandles = await this.storage.getRecentCandles({ symbol: 'BTC-USD', limit: tailLookback });
      } catch (error) {
        console.error(`[Engine] Seeding BTC-USD tail candles failed:`, error);
      }
    }

    if (btcCandles.length > 1) {
      const sortedBtc = [...btcCandles].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      const btcReturns = [];
      for (let i = 0; i < sortedBtc.length - 1; i++) {
        const prev = Number(sortedBtc[i].close);
        const next = Number(sortedBtc[i + 1].close);
        const ret = prev > 0 ? (next / prev) - 1 : 0;
        btcReturns.push(ret);
      }

      for (const symbol of this.config.symbols) {
        const state = this.ensureSymbolState(symbol, 0);
        state.btcReturns = [...btcReturns].slice(-this.config.tailWindow);
      }
      console.log(`[Engine] Warmed up ${btcReturns.length} BTC returns for tail dependence.`);
    }
  }

  async run(feed) {
    await this.warmup();
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
        codec: this.broker.getCodecMetrics(),
      },
      latestSignals: recentSignals,
      latestOrders: recentOrders,
      latestDecisions: recentDecisions,
    };
  }

  async runLive(feed) {
    await this.warmup();
    console.log('[Engine] Starting live trading loop...');
    for await (const event of feed.stream()) {
      console.log(`[Engine] Processing live event for ${event.symbol} at price $${event.last}`);
      try {
        const tStart = performance.now();
        await this.processBatch([event]);
        const tEnd = performance.now();
        const evalTime = tEnd - tStart;

        this.state.ioStats.evalDurationMs.push(evalTime);
        if (this.state.ioStats.evalDurationMs.length > 50) {
          this.state.ioStats.evalDurationMs.shift();
        }

        const avgEval = this.state.ioStats.evalDurationMs.reduce((a, b) => a + b, 0) / this.state.ioStats.evalDurationMs.length;

        const portfolio = this.enrichedPortfolio();
        console.log(`[Portfolio] NAV: $${portfolio.nav.toFixed(2)} | Cash: $${portfolio.cash.toFixed(2)} | Drawdown: ${(portfolio.drawdown * 100).toFixed(2)}%`);
        if (portfolio.positions.length > 0) {
          console.log('            Positions:', portfolio.positions.map(p => `${p.symbol}: ${p.units.toFixed(4)} (@$${p.price.toFixed(2)})`).join(', '));
        }
        console.log(`[I/O Stats] Process Time: ${evalTime.toFixed(1)}ms (Avg: ${avgEval.toFixed(1)}ms) | WS Queue Depth: ${feed.queue.length}`);
      } catch (error) {
        console.error('[Engine] Error processing live event:', error);
      }
    }
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
        granularity: this.config.granularity || '1m',
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

    const fills = this.broker.updatePendingOrders(this.state.prices, timestamp);
    for (const fill of fills) {
      if (!fill.validate_only) {
        this.state.metrics.ordersAccepted += 1;
        await this.storage.insertOrder(fill);
      }
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
    const hasLiquidity = event.bids && event.bids.length > 0 && event.asks && event.asks.length > 0;
    const bestBid = hasLiquidity ? event.bids[0].price : 0;
    const bestAsk = hasLiquidity ? event.asks[0].price : 0;
    const obi = hasLiquidity ? computeObi(event.bids, event.asks, event.mid) : 0;
    const kalman = kalmanStep(symbolState.kalman, event.last, this.config.kalmanQ, this.config.kalmanR);
    const rvDown = computeDownsideSemivariance(symbolState.returns);
    const annualizedRvDown = Math.max(rvDown * this.config.annualizationFactor, 1e-9);
    const tailDependence = computeTailDependence(symbolState.returns, symbolState.btcReturns, this.config.tailQuantile);
    const effectiveCost = hasLiquidity ? computeEffectiveSpread(bestBid, bestAsk) : 1.0;

    const currentWeight = this.currentWeight(event.symbol, event.last);
    let trigger = induceTrigger(effectiveCost, annualizedRvDown);
    if (currentWeight === 0) {
      trigger *= (this.config.zeroPositionTriggerMultiplier ?? 0.8);
    }

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
    const rawKelly = hasLiquidity ? induceKelly({ effectiveDrift, rvDown: annualizedRvDown, tailDependence }) : 0;
    const regime = {
      momentum: Math.max(-1, Math.min(1, kalman.innovationZ / 5)),
      meanReversion: Math.max(-1, Math.min(1, -obi)),
      volatility: Math.max(0, Math.min(1, annualizedRvDown / 20)),
    };

    const s_vol = regime.volatility;
    const s_mom = Math.abs(regime.momentum);
    const s_mr = Math.abs(regime.meanReversion);

    const rankings = [
      { name: 'volatility', score: s_vol },
      { name: 'momentum', score: s_mom },
      { name: 'meanReversion', score: s_mr }
    ].sort((a, b) => b.score - a.score);

    const dominantRegime = rankings[0].name;

    let finalKelly = rawKelly;
    let finalTrigger = trigger;

    if (dominantRegime === 'volatility') {
      finalTrigger *= 1.5;
      finalKelly *= 0.5;
    } else if (dominantRegime === 'momentum') {
      finalTrigger *= 0.7;
      finalKelly *= 1.2;
    }

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
      trigger: finalTrigger,
      alignment,
      cacheQuality,
      effectiveDrift,
      rawKelly: finalKelly,
      currentWeight,
      urgency: urgencyFromInnovation(kalman.innovationZ),
      regime,
      dominantRegime,
    };
  }

  currentWeight(symbol, price) {
    const portfolio = this.broker.getPortfolio(this.state.prices);
    if (portfolio.nav <= 0) return 0;
    return this.broker.getPositionValue(symbol, price) / portfolio.nav;
  }

  manageSnareGrid(event, signal, portfolio) {
    if (!this.config.useSnareGrid) return;

    const guesses = this.broker.orders.concat(this.broker.pendingOrders)
      .filter(o => o.product_id === event.symbol && o.validate_only);
    const symbolConfidence = guesses.reduce((sum, o) => sum + (o.virtualPnL || 0), 0);

    if (this.config.useConfidenceGating && symbolConfidence <= 0) {
      const activeSnares = this.broker.pendingOrders.filter(
        o => o.product_id === event.symbol && o.is_snare && o.status === 'PENDING'
      );
      for (const snare of activeSnares) {
        this.broker.cancelOrder(snare.order_id);
      }
      return;
    }

    const sigmaDown = Math.sqrt(signal.rvDown);
    const mid = event.mid;

    let spacingMultiplier = 1.0;
    if (signal.dominantRegime === 'volatility') {
      spacingMultiplier = 1.3;
    } else if (signal.dominantRegime === 'momentum') {
      spacingMultiplier = 2.0;
    }

    for (const level of this.config.fibLevels) {
      const snarePrice = mid * (1 - level * sigmaDown * spacingMultiplier);
      const snareQty = (portfolio.nav * 0.05) / snarePrice;

      const existing = this.broker.pendingOrders.find(
        o => o.product_id === event.symbol && o.is_snare && o.fib_level === level && o.status === 'PENDING'
      );

      if (!existing) {
        const end_time = new Date(Date.now() + this.config.snareDurationMs).toISOString();
        const postResult = this.broker.postOrder({
          product_id: event.symbol,
          side: 'BUY',
          validate_only: false,
          timestamp: event.timestamp,
          order_configuration: {
            limit_limit_gtd: {
              base_size: String(snareQty),
              limit_price: String(snarePrice),
              end_time,
            },
            auto_hedge: {
              profit_target_pct: this.config.profitTargetPct,
              stop_loss_pct: this.config.stopLossPct,
              stop_duration_ms: this.config.stopDurationMs,
            }
          }
        });
        if (postResult.accepted) {
          postResult.order.is_snare = true;
          postResult.order.fib_level = level;
          postResult.order.regime = signal.dominantRegime;
        }
      } else {
        const drift = Math.abs(mid - existing.initialPrice) / mid;
        const regimeChanged = existing.regime !== signal.dominantRegime;
        if (drift > 0.03 || regimeChanged) {
          this.broker.cancelOrder(existing.order_id);
          const end_time = new Date(Date.now() + this.config.snareDurationMs).toISOString();
          const postResult = this.broker.postOrder({
            product_id: event.symbol,
            side: 'BUY',
            validate_only: false,
            timestamp: event.timestamp,
            order_configuration: {
              limit_limit_gtd: {
                base_size: String(snareQty),
                limit_price: String(snarePrice),
                end_time,
              },
              auto_hedge: {
                profit_target_pct: this.config.profitTargetPct,
                stop_loss_pct: this.config.stopLossPct,
                stop_duration_ms: this.config.stopDurationMs,
              }
            }
          });
          if (postResult.accepted) {
            postResult.order.is_snare = true;
            postResult.order.fib_level = level;
            postResult.order.regime = signal.dominantRegime;
          }
        }
      }
    }
  }

  async rebalance({ event, signal, targetWeight }) {
    const portfolio = this.broker.getPortfolio({ ...this.state.prices, [event.symbol]: event.last });
    const drawdown = (this.state.peakNav - portfolio.nav) / this.state.peakNav;
    // Post a validate_only virtual order to track codec tracking loss
    const guessSide = signal.effectiveDrift > 0 ? 'BUY' : 'SELL';
    const guessQuantity = 1000 / event.mid;
    this.broker.postOrder({
      product_id: event.symbol,
      side: guessSide,
      validate_only: true,
      timestamp: event.timestamp,
      order_configuration: {
        limit_limit_gtc: {
          base_size: String(guessQuantity),
          limit_price: String(event.mid),
        }
      }
    });

    this.manageSnareGrid(event, signal, portfolio);

    const guesses = this.broker.orders.concat(this.broker.pendingOrders)
      .filter(o => o.product_id === event.symbol && o.validate_only);
    const symbolConfidence = guesses.reduce((sum, o) => sum + (o.virtualPnL || 0), 0);
    const currentUnits = this.broker.getUnits(event.symbol);
    const isLiquidation = (targetWeight === 0 && currentUnits > 0);
    const isConfidenceGated = this.config.useConfidenceGating && (symbolConfidence <= 0 && !isLiquidation);

    if (isConfidenceGated) {
      return {
        accepted: false,
        reason: 'CONFIDENCE_GATE_BLOCKED',
        notionalDelta: 0,
      };
    }

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

    let result;
    if (this.config.useLimitOrders) {
      const end_time = new Date(Date.parse(event.timestamp) + (this.config.limitDurationMs || 60000)).toISOString();
      result = this.broker.postOrder({
        product_id: event.symbol,
        side,
        validate_only: false,
        timestamp: event.timestamp,
        order_configuration: {
          limit_limit_gtd: {
            base_size: String(quantity),
            limit_price: String(executionPrice),
            end_time,
          }
        }
      });
    } else {
      result = this.broker.execute({
        symbol: event.symbol,
        side,
        quantity,
        price: executionPrice,
        timestamp: event.timestamp,
      });
    }
    return {
      ...result,
      reason: result.accepted ? (this.config.useLimitOrders ? 'LIMIT_POSTED' : 'EXECUTED') : result.reason,
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

  async getDenoisedRsi({ symbol, timestamp }) {
    let stats = [];
    try {
      stats = await this.storage.getRecentSpotMarketStats({ symbol, limit: 30 });
    } catch (err) {
      console.warn(`[Engine] Failed to fetch spot market stats: ${err.message}`);
    }

    if (stats.length === 0) {
      console.log(`[Engine] RSI cache miss for ${symbol} at ${timestamp}. Drawing through CoinMarketCap scraper...`);
      try {
        const scraper = new CoinMarketCapScraper({ storage: this.storage });
        await scraper.scrapeRsiData();
        stats = await this.storage.getRecentSpotMarketStats({ symbol, limit: 30 });
      } catch (err) {
        console.error(`[Engine] Scraper draw-through failed for ${symbol}:`, err.message);
      }
    }

    const symbolState = this.ensureSymbolState(symbol, 0);
    if (!symbolState.rsiKalman) {
      symbolState.rsiKalman = { x: 50, p: 10 };
    }

    const res = computeRsiSplatAndKalman({
      statsHistory: stats,
      targetTimestamp: timestamp,
      sigmaSeconds: 3600 * 2,
      kalmanState: symbolState.rsiKalman,
      q: 0.1,
      r: 1.0,
    });

    if (res.rsi !== null) {
      symbolState.rsiKalman = res.state;
    }
    return res;
  }
}