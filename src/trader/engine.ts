import { clamp } from '../lib/math.ts';
import { alignmentScore,
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
  computeTimescaleAttention,
  computeConfidenceScalers,
  classifyTradeArchetype,
  variance,
} from './signals.ts';
import { PaperBroker, convertToUSD, findConversionRate } from './paper-broker.ts';
import { DrawThroughCacheManager, type CandleLike } from './cache-manager.ts';
import { buildDecisionVector, derivePortfolioTargets } from './optimizer.ts';
import { applyRiskInvariants, classifyRiskState, computeDrawdown } from './risk.ts';
import { CoinMarketCapScraper } from '../feeds/coinmarketcap-scraper.ts';

type PriceMap = Record<string, number>;

type BookLevel = {
  price: number;
  size: number;
};

type MarketEvent = {
  type?: string;
  symbol: string;
  timestamp: string;
  mid: number;
  last: number;
  bids: BookLevel[];
  asks: BookLevel[];
  volume: number;
  [key: string]: unknown;
};

type KalmanState = {
  x: number;
  p: number;
};

type SymbolState = {
  lastPrice: number;
  returns: number[];
  btcReturns: number[];
  kalman: KalmanState;
  rsiKalman?: KalmanState;
  [key: string]: any;
};

type EngineState = {
  perSymbol: Map<string, SymbolState>;
  prices: PriceMap;
  peakNav: number;
  metrics: {
    cacheHits: number;
    apiCalls: number;
    gaps: number;
    ordersAccepted: number;
    ordersRejected: number;
  };
  ioStats: {
    evalDurationMs: number[];
  };
  rsi: {
    lastDrawThroughAttemptAt: number;
    scrapePromise: Promise<void> | null;
  };
};

type ConversionEdge = {
  to: string;
  rate: number;
};

type RegimeRanking = {
  name: string;
  score: number;
};

type CacheResult = {
  cacheHit: boolean;
  gapCount: number;
  candles: CandleLike[];
  [key: string]: any;
};

type RsiContext = {
  rsi: number | null;
  innovation?: number | null;
  innovationZ: number;
  state?: KalmanState;
};

type EngineSignal = {
  symbol: string;
  event: MarketEvent;
  cacheHit: boolean;
  obi: number;
  innovationZ: number;
  kalmanState: KalmanState;
  rvDown: number;
  tailDependence: number;
  effectiveCost: number;
  spread: number;
  trigger: number;
  alignment: number;
  cacheQuality: number;
  effectiveDrift: number;
  rawKelly: number;
  denoisedRsi: number | null;
  rsiInnovation: number | null;
  rsiInnovationZ: number;
  currentWeight: number;
  urgency: number;
  regime: Record<string, number>;
  regimeRankings: RegimeRanking[];
  regimeProfile: Record<string, any>;
  timescaleAttention: ReturnType<typeof computeTimescaleAttention>;
  confidenceScalers: ReturnType<typeof computeConfidenceScalers>;
  dominantRegime: string;
};

type ComputeSignalInput = {
  event: MarketEvent;
  symbolState: SymbolState;
  cacheResult: CacheResult;
  rsiContext?: RsiContext | null;
};

type PortfolioSnapshot = {
  cash: number;
  nav: number;
  peakNav: number;
  drawdown: number;
  positions: Array<{
    symbol: string;
    units: number;
    price: number;
    marketValue: number;
    weight: number;
  }>;
};

type FeedLike = {
  stream(): AsyncIterable<MarketEvent>;
  queue: unknown[];
  subscribeSymbol?(symbol: string): void;
  recordLevel2Interest?(symbol: string, weight?: number): void;
};

function pad(str: unknown, len: number): string {
  const s = String(str);
  return s.length >= len ? s : s.padEnd(len, ' ');
}

/**
 * Builds a conversion graph from candle data at a specific timestamp.
 * Returns adjacency map for BFS traversal.
 */
function buildConversionGraph(timestamp: string, candlesMap: Map<string, CandleLike[]>, currentPrices: PriceMap = {}): Map<string, ConversionEdge[]> {
  const adj = new Map<string, ConversionEdge[]>();
  const addEdge = (u: string, v: string, rate: number): void => {
    if (!adj.has(u)) adj.set(u, []);
    adj.get(u)!.push({ to: v, rate });
  };

  const targetMs = Date.parse(timestamp);

  for (const [symbol, candles] of candlesMap.entries()) {
    let price: number | null | undefined = null;
    const exact = candles.find((c) => c.start === timestamp);
    if (exact) {
      price = Number(exact.close);
    } else if (candles.length > 0) {
      let closest: CandleLike | null = null;
      let minDiff = Infinity;
      for (const c of candles) {
        const diff = Math.abs(Date.parse(c.start) - targetMs);
        if (diff < minDiff && diff <= 5 * 60 * 1000) {
          minDiff = diff;
          closest = c;
        }
      }
      if (closest) {
        price = Number(closest.close);
      } else {
        price = Number(candles[0]!.close);
      }
    }

    if (price === null || price === undefined || isNaN(price)) {
      price = currentPrices[symbol];
    }

    if (typeof price === 'number' && price > 0) {
      const parts = symbol.split('-');
      if (parts.length === 2) {
        const base = parts[0];
        const quote = parts[1];
        if (base && quote) {
          addEdge(base, quote, price);
          addEdge(quote, base, 1 / price);
        }
      }
    }
  }

  return adj;
}

/**
 * Finds conversion rate between currencies using BFS on the conversion graph.
 * Shared with PaperBroker.convertToUSD for current-price conversions.
 */
export function getHistoricalConversionRate(fromCurrency: string, toCurrency: string, timestamp: string, candlesMap: Map<string, CandleLike[]>, currentPrices: PriceMap = {}): number {
  if (fromCurrency === toCurrency) return 1.0;

  const adj = buildConversionGraph(timestamp, candlesMap, currentPrices);

  const queue = [{ currency: fromCurrency, rate: 1.0 }];
  const visited = new Set([fromCurrency]);

  while (queue.length > 0) {
    const { currency, rate } = queue.shift()!;
    if (currency === toCurrency) {
      return rate;
    }

    const neighbors = adj.get(currency) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor.to)) {
        visited.add(neighbor.to);
        queue.push({ currency: neighbor.to, rate: rate * neighbor.rate });
      }
    }
  }

  return findConversionRate(fromCurrency, toCurrency, currentPrices);
}

export class TraderEngine {
  storage: any;
  config: any;
  broker: any;
  cache: any;
  state: EngineState;
  feed?: FeedLike;

  constructor({ storage, config }: { storage: any; config: any }) {
    this.storage = storage;
    this.config = config;
    this.broker = new PaperBroker({ initialCash: config.initialCash, persistPath: config.paperWalletPath, reset: config.resetWallet });
    this.cache = new DrawThroughCacheManager({
      storage,
      freshnessMs: config.cacheFreshnessMs,
      restClient: config.restClient,
      allowRestFetch: config.allowRestCacheFetch ?? false,
    });
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
      rsi: {
        lastDrawThroughAttemptAt: 0,
        scrapePromise: null,
      },
    };
  }

  rankRegimes(regime: Record<string, number>): RegimeRanking[] {
    return Object.entries(regime)
      .map(([name, score]) => ({
        name,
        score: Math.abs(Number(score) || 0),
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  regimeProfile(name: string): Record<string, any> {
    return this.config.regimeProfiles?.[name] ?? {};
  }

  ensureSymbolState(symbol: string, initialPrice: number): SymbolState {
    if (!this.state.perSymbol.has(symbol)) {
      this.state.perSymbol.set(symbol, {
        lastPrice: initialPrice,
        returns: [],
        btcReturns: [],
        kalman: { x: initialPrice, p: 1 },
      });
    }
    return this.state.perSymbol.get(symbol)!;
  }

  convertToUsd(currency: string | undefined, prices: PriceMap = this.state.prices): number {
      return convertToUSD(currency, prices, 'USD');
    }

    /**
     * Warms up a single symbol: fetches candles, converts to USD, calculates returns and BTC tail returns.
     * Used by both initial warmup() and dynamic promoteSymbol().
     */
    async _warmupSingleSymbol(symbol: string, _lookback: number, allCandlesMap: Map<string, CandleLike[]>, btcReturns: number[]): Promise<void> {
      const rawCandles = allCandlesMap.get(symbol) || [];
      const parts = symbol.split('-');
      const quote = parts[1] || 'USD';

      // Convert candles to USD using historical rates
      const candles = await this.convertCandlesToUsd(symbol, rawCandles);

      const state = this.ensureSymbolState(symbol, 0);

      if (candles.length > 1) {
        const sorted = [...candles].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
        state.lastPrice = Number(sorted[sorted.length - 1]!.close);
        state.kalman = { x: state.lastPrice, p: 1 };

        state.returns = [];
        for (let i = 0; i < sorted.length - 1; i++) {
          const prev = Number(sorted[i]!.close);
          const next = Number(sorted[i + 1]!.close);
          const ret = prev > 0 ? (next / prev) - 1 : 0;
          state.returns.push(ret);
        }
        console.log(`[Engine] Warmed up ${state.returns.length} returns for ${symbol} (in USD). Last price: $${state.lastPrice}`);

        // Attach BTC returns for tail dependence
        if (btcReturns && btcReturns.length > 0) {
          state.btcReturns = [...btcReturns].slice(-this.config.tailWindow);
        }
      }
    }

    async warmup(): Promise<void> {
      console.log('[Engine] Warming up symbol states from database history...');
      const lookback = (this.config.semivarianceWindow || 120) + 1;
      const tailLookback = (this.config.tailWindow || 180) + 1;

      const allCandlesMap = new Map();

      // Fetch candles for all symbols (and quote conversions if needed)
      for (const symbol of this.config.symbols) {
        let candles = await this.storage.getRecentCandles({ symbol, limit: lookback });

        if (candles.length <= 1 && this.config.restClient && this.config.allowRestWarmupFetch) {
          try {
            const now = Date.now();
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

        allCandlesMap.set(symbol, candles);

        const parts = symbol.split('-');
        const quote = parts[1] || 'USD';
        if (quote !== 'USD') {
          const conversionPair = `${quote}-USD`;
          if (!allCandlesMap.has(conversionPair)) {
            const convCandles = await this.storage.getRecentCandles({ symbol: conversionPair, limit: lookback * 2 });
            allCandlesMap.set(conversionPair, convCandles);
          }
        }
      }

      // Fetch BTC candles once for all symbols
      let btcCandles = await this.storage.getRecentCandles({ symbol: 'BTC-USD', limit: tailLookback });

      if (btcCandles.length <= 1 && this.config.restClient && this.config.allowRestWarmupFetch) {
        try {
          const now = Date.now();
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

      let btcReturns: number[] = [];
      if (btcCandles.length > 1) {
        const sortedBtc = [...btcCandles].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
        for (let i = 0; i < sortedBtc.length - 1; i++) {
          const prev = Number(sortedBtc[i]!.close);
          const next = Number(sortedBtc[i + 1]!.close);
          const ret = prev > 0 ? (next / prev) - 1 : 0;
          btcReturns.push(ret);
        }
        console.log(`[Engine] Warmed up ${btcReturns.length} BTC returns for tail dependence.`);
      }

      // Warm up each symbol using shared logic
      for (const symbol of this.config.symbols) {
        await this._warmupSingleSymbol(symbol, lookback, allCandlesMap, btcReturns);
      }
    }


    async promoteSymbol(symbol: string): Promise<void> {
      if (this.config.symbols.includes(symbol)) return;
      this.config.symbols.push(symbol);

      try {
        await this.warmupSymbol(symbol);
        this.feed?.subscribeSymbol?.(symbol);
      } catch (err) {
        console.error(`[Engine] Warmup failed during promotion for ${symbol}:`, err);
      }
    }

    async warmupSymbol(symbol: string): Promise<void> {
      const lookback = (this.config.semivarianceWindow || 120) + 1;
      const tailLookback = (this.config.tailWindow || 180) + 1;

      const allCandlesMap = new Map();
      const candles = await this.storage.getRecentCandles({ symbol, limit: lookback });
      allCandlesMap.set(symbol, candles);

      const parts = symbol.split('-');
      const quote = parts[1] || 'USD';
      if (quote !== 'USD') {
        const conversionPair = `${quote}-USD`;
        const convCandles = await this.storage.getRecentCandles({ symbol: conversionPair, limit: lookback * 2 });
        allCandlesMap.set(conversionPair, convCandles);
      }

      // Fetch BTC candles for tail dependence
      const btcCandles = await this.storage.getRecentCandles({ symbol: 'BTC-USD', limit: tailLookback });
      let btcReturns: number[] = [];
      if (btcCandles.length > 1) {
        const sortedBtc = [...btcCandles].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
        for (let i = 0; i < sortedBtc.length - 1; i++) {
          const prev = Number(sortedBtc[i]!.close);
          const next = Number(sortedBtc[i + 1]!.close);
          const ret = prev > 0 ? (next / prev) - 1 : 0;
          btcReturns.push(ret);
        }
      }

      await this._warmupSingleSymbol(symbol, lookback, allCandlesMap, btcReturns);
    }

  async runLive(feed: FeedLike): Promise<void> {
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
        console.log(
          `[PORTFOLIO] NAV: $${pad(portfolio.nav.toFixed(2), 12)} | Cash: $${pad(portfolio.cash.toFixed(2), 10)} | DD: ${pad((portfolio.drawdown * 100).toFixed(2), 6)}%`
        );
        if (portfolio.positions.length > 0) {
          for (const p of portfolio.positions) {
            console.log(
              `  POS ${pad(p.symbol, 10)} | units=${pad(p.units.toFixed(6), 14)} | px=$${pad(p.price.toFixed(2), 10)} | val=$${pad(p.marketValue.toFixed(2), 12)} | w=${pad((p.weight * 100).toFixed(2), 6)}%`
            );
          }
        }
        console.log(`[I/O] eval=${pad(evalTime.toFixed(1), 7)}ms avg=${pad(avgEval.toFixed(1), 7)}ms | WS q=${pad(String(feed.queue.length), 3)}`);
      } catch (error) {
        console.error('[Engine] Error processing live event:', error);
      }
    }
  }


  async convertCandlesToUsd(symbol: string, candles: CandleLike[]): Promise<CandleLike[]> {
    const parts = symbol.split('-');
    const base = parts[0];
    const quote = parts[1] || 'USD';
    if (quote === 'USD') return candles;

    const conversionPair = `${quote}-USD`;
    const conversionCandles = await this.storage.getRecentCandles({
      symbol: conversionPair,
      limit: candles.length * 2,
    });

    const candlesMap = new Map();
    candlesMap.set(symbol, candles);
    candlesMap.set(conversionPair, conversionCandles);

    return candles.map((candle) => {
      const rate = getHistoricalConversionRate(quote, 'USD', candle.start, candlesMap, this.state.prices);
      const multiplier = rate ?? 1.0;
      return {
        ...candle,
        open: Number(candle.open) * multiplier,
        high: Number(candle.high) * multiplier,
        low: Number(candle.low) * multiplier,
        close: Number(candle.close) * multiplier,
      };
    });
  }

  async processBatch(events: MarketEvent[]): Promise<void> {
    if (events.length === 0) return;
    const signals: EngineSignal[] = [];
    const timestamp = events[0]!.timestamp;
    const rawEventsMap = new Map<string, MarketEvent>();

    for (const event of events) {
      rawEventsMap.set(event.symbol, event);

      // Get conversion rate of quote to USD
      const parts = event.symbol.split('-');
      const quote = parts[1] || 'USD';
      const quoteToUsd = this.convertToUsd(quote, this.state.prices);

      // Create USD denominated event
      const eventUsd = {
        ...event,
        last: event.last * quoteToUsd,
        mid: event.mid * quoteToUsd,
        bids: event.bids.map((b) => ({ ...b, price: b.price * quoteToUsd })),
        asks: event.asks.map((a) => ({ ...a, price: a.price * quoteToUsd })),
      };

      const symbolState = this.ensureSymbolState(event.symbol, eventUsd.last);
      const previousPrice = symbolState.lastPrice;
      const simpleReturn = previousPrice > 0 ? (eventUsd.last / previousPrice) - 1 : 0;

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
        buildCandle: () => this.toCandle(eventUsd),
        granularity: this.config.granularity || '1m',
      });

      if (cacheResult.cacheHit) {
        this.state.metrics.cacheHits += 1;
      } else {
        this.state.metrics.apiCalls += 1;
      }
      this.state.metrics.gaps += cacheResult.gapCount;

      // Convert candles in cacheResult to USD
      const usdCandles = await this.convertCandlesToUsd(event.symbol, cacheResult.candles);
      const convertedCacheResult = {
        ...cacheResult,
        candles: usdCandles,
      };

      const rsiContext = this.config.useDenoisedRsi === false
        ? null
        : await this.getDenoisedRsi({ symbol: event.symbol, timestamp: event.timestamp });
      
      const signal = this.computeSignal({
        event: eventUsd as MarketEvent,
        symbolState,
        cacheResult: convertedCacheResult,
        rsiContext
      });
      signals.push(signal);

      this.state.prices[event.symbol] = event.last; // Keep raw/original price in this.state.prices
      symbolState.lastPrice = eventUsd.last;
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
        timescaleSupportCount: signal.timescaleAttention.supportCount,
        timescaleWindowCenter: signal.timescaleAttention.preferredWindow ?? 1,
        timescaleAttention: signal.timescaleAttention.attentionMultiplier,
        timescaleTimeDilation: signal.timescaleAttention.timeDilation,
        denoisedRsi: signal.confidenceScalers.denoisedRsi,
        rsiInnovationZ: signal.rsiInnovationZ,
        confidenceScalers: signal.confidenceScalers.attentionScore,
        advantageProbability: signal.confidenceScalers.advantageProbability,
        riskState,
        dominantRegime: signal.dominantRegime,
        archetype: classifyTradeArchetype({
          regimeMomentum: signal.regime?.momentum ?? 0,
          regimeMeanReversion: signal.regime?.meanReversion ?? 0,
          regimeVolatility: signal.regime?.volatility ?? 0,
          alignment: signal.alignment,
          obi: signal.obi,
          rsi: signal.confidenceScalers.denoisedRsi,
          tailDependence: signal.tailDependence,
        }) ?? 'volatility_defense',
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

      console.log(
        `[ENGINE] ${pad(signal.symbol, 10)} | regime=${pad(signal.dominantRegime, 14)} | trigger=${pad(signal.trigger.toFixed(5), 9)} | kelly=${pad(signal.rawKelly.toFixed(5), 9)} | pAdv=${pad((signal.confidenceScalers.advantageProbability ?? 0.5).toFixed(3), 6)} | rsi=${pad(signal.confidenceScalers.denoisedRsi !== null ? signal.confidenceScalers.denoisedRsi.toFixed(1) : 'n/a', 6)} | tsSupport=${pad(String(signal.timescaleAttention.supportCount), 2)} | tsDilation=${pad(signal.timescaleAttention.timeDilation.toFixed(2), 5)} | target=${pad(constrainedTarget.toFixed(4), 8)} | current=${pad(signal.currentWeight.toFixed(4), 8)} | ${decision?.reason ?? 'n/a'}`
      );

      if (decision?.accepted) {
        this.state.metrics.ordersAccepted += 1;
        await this.storage.insertOrder(decision);
      } else if (decision) {
        this.state.metrics.ordersRejected += 1;
      }

      const rawEvent = rawEventsMap.get(signal.symbol);
      if (rawEvent) {
        await this.storage.upsertCandles([this.toCandle(rawEvent)]);
      }
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

  computeSignal({ event, symbolState, cacheResult, rsiContext = null }: ComputeSignalInput): EngineSignal {
    const hasLiquidity = event.bids && event.bids.length > 0 && event.asks && event.asks.length > 0;
    const bestBid = hasLiquidity ? event.bids[0]!.price : 0;
    const bestAsk = hasLiquidity ? event.asks[0]!.price : 0;
    const obi = hasLiquidity ? computeObi(event.bids, event.asks, event.mid) : 0;
    const kalman = kalmanStep(symbolState.kalman, event.last, this.config.kalmanQ, this.config.kalmanR);
    const rvDown = computeDownsideSemivariance(symbolState.returns);
    const annualizedRvDown = Math.max(rvDown * this.config.annualizationFactor, 1e-9);
    const tailDependence = computeTailDependence(symbolState.returns, symbolState.btcReturns, this.config.tailQuantile);
    const effectiveCost = hasLiquidity ? computeEffectiveSpread(bestBid, bestAsk) : 1.0;

    const currentWeight = this.currentWeight(event.symbol, event.last);
    let trigger = induceTrigger(effectiveCost, annualizedRvDown);
    
    // Zero-position trigger reduction
    if (currentWeight === 0) {
      trigger *= (this.config.zeroPositionTriggerMultiplier ?? 0.8);
    }

    const replayReturns = cacheResult.candles.slice(0, this.config.semivarianceWindow - 1)
      .map((candle, index, rows) => {
        const next = rows[index + 1];
        if (!next) return null;
        return (Number(candle.close) / Number(next.close)) - 1;
      })
      .filter((value): value is number => value !== null);
    const replayRvDown = Math.max(computeDownsideSemivariance(replayReturns) * this.config.annualizationFactor, 1e-9);
    
    // Convert replay return to Z-score for dimensional consistency with innovationZ
    // replayReturns is array of 1-min returns; use its std dev to normalize
    const replayReturnStd = Math.max(Math.sqrt(variance(replayReturns)), 1e-9);
    const replayReturnZ = replayReturns.length > 0
      ? (replayReturns.at(0) ?? 0) / replayReturnStd
      : 0;
    
    const liveDrift = obi + kalman.innovationZ;
    const replayDrift = obi + replayReturnZ;
    const alignment = alignmentScore(
      { drift: liveDrift, rvDown: annualizedRvDown, tail: tailDependence },
      { drift: replayDrift, rvDown: replayRvDown, tail: tailDependence },
    );
    const cacheQuality = quotaQuality({ cacheHit: cacheResult.cacheHit, gapCount: cacheResult.gapCount });
    const regime = {
      momentum: Math.max(-1, Math.min(1, kalman.innovationZ / 5)),
      meanReversion: Math.max(-1, Math.min(1, -obi)),
      volatility: Math.max(0, Math.min(1, annualizedRvDown / 20)),
    };

    const rankings = this.rankRegimes(regime);
    const dominantRegime = rankings[0]?.name ?? 'momentum';
    const dominantProfile = this.regimeProfile(dominantRegime);
    const triggerMultiplier = Number.isFinite(Number(dominantProfile.triggerMultiplier))
      ? Number(dominantProfile.triggerMultiplier)
      : 1;
    const kellyMultiplier = Number.isFinite(Number(dominantProfile.kellyMultiplier))
      ? Number(dominantProfile.kellyMultiplier)
      : 1;
    const timescaleAttention = computeTimescaleAttention({
      candles: cacheResult.candles as any,
      windows: this.config.timescaleWindows,
      preferredWindow: dominantProfile.timeScaleWindow,
      windowSigma: dominantProfile.timeScaleSigma,
      attentionStrength: this.config.timescaleAttentionStrength ?? 0.15,
    });
    const multiscaleDrift = timescaleAttention.supportCount > 1
      ? timescaleAttention.weightedDrift * timescaleAttention.attentionMultiplier
      : 0;
    const effectiveDrift = synthesizeDrift({ obi, innovationZ: kalman.innovationZ, alignment, cacheQuality }) + multiscaleDrift;
    // confidenceScalers uses timescaleAttention with RSI context baked in (denoisedRsi, advantageProbability)
    const confidenceScalers = timescaleAttention;
    // rawKelly: base Kelly before any scaling (for test compatibility)
    const rawKelly = hasLiquidity ? induceKelly({ effectiveDrift, rvDown: annualizedRvDown, tailDependence }) : 0;

    // regimeKelly: after regime-based scaling (what test expects as rawKelly)
    const regimeKelly = rawKelly * kellyMultiplier;

    let finalKelly = regimeKelly;
    let finalTrigger = trigger * triggerMultiplier;

    if (timescaleAttention.supportCount > 1) {
      finalTrigger *= timescaleAttention.timeDilation;
      finalKelly *= timescaleAttention.attentionMultiplier;
    }

    finalTrigger *= confidenceScalers.triggerMultiplier ?? 1;
    finalKelly *= confidenceScalers.kellyMultiplier ?? 1;

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
      rawKelly: regimeKelly,
      denoisedRsi: rsiContext?.rsi ?? null,
      rsiInnovation: rsiContext?.innovation ?? null,
      rsiInnovationZ: rsiContext?.innovationZ ?? 0,
      currentWeight,
      urgency: urgencyFromInnovation(kalman.innovationZ),
      regime,
      regimeRankings: rankings,
      regimeProfile: dominantProfile,
      timescaleAttention,
      confidenceScalers,
      dominantRegime,
    };
  }

  currentWeight(symbol: string, price: number): number {
    const portfolio = this.broker.getPortfolio(this.state.prices);
    if (portfolio.nav <= 0) return 0;
    return this.broker.getPositionValue(symbol, price) / portfolio.nav;
  }

  manageSnareGrid(event: MarketEvent, signal: EngineSignal, portfolio: PortfolioSnapshot): void {
    if (!this.config.useSnareGrid) return;

    const guesses = this.broker.orders.concat(this.broker.pendingOrders)
      .filter((o: any) => o.product_id === event.symbol && o.validate_only);
    const symbolConfidence = guesses.reduce((sum: number, o: any) => sum + (o.virtualPnL || 0), 0);

    if (this.config.useConfidenceGating && symbolConfidence <= 0) {
      const activeSnares = this.broker.pendingOrders.filter(
        (o: any) => o.product_id === event.symbol && o.is_snare && o.status === 'PENDING'
      );
      for (const snare of activeSnares) {
        this.broker.cancelOrder(snare.order_id);
      }
      return;
    }

    const sigmaDown = Math.sqrt(signal.rvDown);
    const mid = event.mid;

    const regimeProfile = signal.regimeProfile ?? this.regimeProfile(signal.dominantRegime);
    let spacingMultiplier = Number.isFinite(Number(regimeProfile.snareSpacingMultiplier))
      ? Number(regimeProfile.snareSpacingMultiplier)
      : 1.0;
    const advantageProbability = signal.confidenceScalers?.advantageProbability ?? 0.5;
    const attentionScore = signal.confidenceScalers?.attentionScore ?? 1;

    // Percolate different regime extremes: adjust spacing and risk dynamically
    const isExtreme = attentionScore > 2.0 || Math.abs(advantageProbability - 0.5) > 0.25;
    if (isExtreme) {
      if (signal.dominantRegime === 'momentum' || signal.dominantRegime === 'volatility') {
        spacingMultiplier *= 1.5;
      } else if (signal.dominantRegime === 'meanReversion') {
        spacingMultiplier *= 0.75;
      }
      
      this.feed?.recordLevel2Interest?.(event.symbol, 200);
    }

    const baseSnareRiskFraction = this.config.baseSnareRiskFraction ?? 0.05;
    const regimeSnareBias = signal.dominantRegime === 'momentum'
      ? 0.75
      : signal.dominantRegime === 'volatility'
        ? 0.85
        : 1.0;
    const snareRiskFraction = clamp(
      baseSnareRiskFraction * regimeSnareBias * attentionScore * (0.6 + advantageProbability),
      this.config.minSnareRiskFraction ?? 0.02,
      this.config.maxSnareRiskFraction ?? 0.08,
    );

    const parts = event.symbol.split('-');
    const quote = parts[1] || 'USD';
    const quoteToUsdRate = this.convertToUsd(quote, this.state.prices);

    // Look for support walls in Level 2 book if available
    let l2Walls: number[] = [];
    if (event.bids && event.bids.length > 5) {
      const topBids = event.bids.slice(0, 5);
      const avgTopSize = topBids.reduce((sum, b) => sum + b.size, 0) / topBids.length;
      
      const walls = event.bids
        .filter((b) => b.price < mid && b.size >= 3.0 * avgTopSize)
        .slice(0, this.config.fibLevels.length);
      
      l2Walls = walls.map(w => w.price);
    }

    for (let i = 0; i < this.config.fibLevels.length; i++) {
      const level = this.config.fibLevels[i] as number;
      const wall = l2Walls[i];
      let snarePrice = wall !== undefined && wall > mid * 0.8
        ? wall * 1.0001
        : mid * (1 - level * sigmaDown * spacingMultiplier);

      const snarePriceUsd = snarePrice * quoteToUsdRate;
      const snareQty = (portfolio.nav * snareRiskFraction) / snarePriceUsd;

      const existing = this.broker.pendingOrders.find(
        (o: any) => o.product_id === event.symbol && o.is_snare && o.fib_level === level && o.status === 'PENDING'
      );

      const shouldReplace = existing && (
        Math.abs(mid - existing.initialPrice) / mid > 0.03 ||
        existing.regime !== signal.dominantRegime
      );

      if (shouldReplace) {
        this.broker.cancelOrder(existing.order_id);
      }

      if (!existing || shouldReplace) {
        const end_time = new Date(Date.now() + this.config.snareDurationMs).toISOString();
        const postResult = this.broker.postOrder({
          product_id: event.symbol,
          side: 'BUY',
          validate_only: false,
          timestamp: event.timestamp,
          prices: this.state.prices,
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

  async rebalance({ event, signal, targetWeight }: { event: MarketEvent; signal: EngineSignal; targetWeight: number }): Promise<any> {
    const symbolState = this.state.perSymbol.get(event.symbol);
    const returnsCount = symbolState?.returns?.length ?? 0;
    const requiredReturns = this.config.semivarianceWindow || 120;
    if (returnsCount < requiredReturns) {
      return {
        accepted: false,
        reason: 'INSUFFICIENT_DATA',
        notionalDelta: 0,
      };
    }

    const portfolio = this.broker.getPortfolio(this.state.prices);
    const drawdown = (this.state.peakNav - portfolio.nav) / this.state.peakNav;
    // Post a validate_only virtual order to track codec tracking loss
    const guessSide = signal.effectiveDrift > 0 ? 'BUY' : 'SELL';
    const guessQuantity = 100000 / event.mid;
    this.broker.postOrder({
      product_id: event.symbol,
      side: guessSide,
      validate_only: true,
      timestamp: event.timestamp,
      prices: this.state.prices,
      order_configuration: {
        limit_limit_gtc: {
          base_size: String(guessQuantity),
          limit_price: String(event.mid),
        }
      }
    });

    this.manageSnareGrid(event, signal, portfolio);

    const guesses = this.broker.orders.concat(this.broker.pendingOrders)
      .filter((o: any) => o.product_id === event.symbol && o.validate_only);
    const symbolConfidence = guesses.reduce((sum: number, o: any) => sum + (o.virtualPnL || 0), 0);
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
    const advantageProbability = signal.confidenceScalers?.advantageProbability ?? 0.5;
    const executionUrgency = clamp((0.65 * urgency) + (0.35 * advantageProbability), 0, 1);
    const adaptiveExecution = this.config.useAdaptiveExecutionStyle !== false;
    const shouldForceTaker = adaptiveExecution && advantageProbability >= (this.config.takerProbabilityThreshold ?? 0.68);
    const shouldForceMaker = adaptiveExecution && advantageProbability <= (this.config.makerProbabilityThreshold ?? 0.45);
    const executionMode = shouldForceTaker
      ? 'taker'
      : ((this.config.useLimitOrders || shouldForceMaker) ? 'maker' : 'taker');

    // Handle existing maker limit orders (GT1) based on incoming tick updates
    const existingOrder = this.broker.pendingOrders.find(
      (o: any) => o.product_id === event.symbol && o.is_gt1 && o.status === 'PENDING'
    );

    if (existingOrder) {
      if (executionMode !== 'maker') {
        // If execution mode is no longer maker, cancel the pending limit order
        this.broker.cancelOrder(existingOrder.order_id);
      } else {
        const currentPrice = existingOrder.price;
        const bestBid = event.bids[0]?.price ?? event.mid;
        const bestAsk = event.asks[0]?.price ?? event.mid;
        const executionPrice = side === 'BUY'
          ? Math.min(bestAsk, event.mid + (executionUrgency * (bestAsk - event.mid)))
          : Math.max(bestBid, event.mid - (executionUrgency * (event.mid - bestBid)));
        
        // If the execution price has shifted from existing limit price by more than 1 bps, cancel it for replacement
        const priceDeviates = Math.abs(executionPrice - currentPrice) / currentPrice > 0.0001;
        if (priceDeviates) {
          this.broker.cancelOrder(existingOrder.order_id);
        } else {
          return {
            accepted: false,
            reason: 'PRICE_ALREADY_OPTIMAL',
            notionalDelta: notional,
          };
        }
      }
    }

    const bestBid = event.bids[0]?.price ?? event.mid;
    const bestAsk = event.asks[0]?.price ?? event.mid;
    const executionPrice = side === 'BUY'
      ? Math.min(bestAsk, event.mid + (executionUrgency * (bestAsk - event.mid)))
      : Math.max(bestBid, event.mid - (executionUrgency * (event.mid - bestBid)));

    // Calculate USD execution price to divide notional
    const parts = event.symbol.split('-');
    const quote = parts[1] || 'USD';
    const quoteToUsdRate = this.convertToUsd(quote, this.state.prices);
    const executionPriceUsd = executionPrice * quoteToUsdRate;
    const quantity = Math.abs(notional) / executionPriceUsd;

    let result: any;
    if (executionMode === 'maker') {
      const ttlMultiplier = clamp(1.35 - advantageProbability, 0.75, 1.25);
      const limitDurationMs = Math.round((this.config.limitDurationMs || 60000) * ttlMultiplier);
      const end_time = new Date(Date.parse(event.timestamp) + limitDurationMs).toISOString();
      result = this.broker.postOrder({
        product_id: event.symbol,
        side,
        validate_only: false,
        timestamp: event.timestamp,
        prices: this.state.prices,
        order_configuration: {
          limit_limit_gtd: {
            base_size: String(quantity),
            limit_price: String(executionPrice),
            end_time,
          }
        }
      });
      if (result.accepted) {
        result.order.is_gt1 = true;
      }
    } else {
      result = this.broker.execute({
        symbol: event.symbol,
        side,
        quantity,
        price: executionPrice,
        timestamp: event.timestamp,
        prices: this.state.prices,
      });
    }
    const normalizedResult = result?.order
      ? {
          accepted: result.accepted,
          timestamp: result.order.timestamp,
          symbol: result.order.product_id,
          side: result.order.side,
          quantity: result.order.quantity,
          price: result.order.price,
          gross: result.order.quantity * result.order.price,
          remainingCash: this.broker.cash,
          remainingUnits: this.broker.getUnits(result.order.product_id),
        }
      : result;
    return {
      ...normalizedResult,
      reason: normalizedResult.accepted ? (executionMode === 'maker' ? 'LIMIT_POSTED' : 'EXECUTED') : normalizedResult.reason,
      notionalDelta: notional,
      executionUrgency,
      executionMode,
      // Edge decomposition (basis points)
      grossEdgeBps: signal.effectiveDrift * 10000,
      costBps: signal.effectiveCost * 10000,
      uncertaintyBps: Math.max(0, (1 - signal.cacheQuality) * 500), // ~50bps at zero cache quality
      netEdgeBps: (signal.effectiveDrift - signal.effectiveCost - Math.max(0, (1 - signal.cacheQuality) * 0.05)) * 10000,
    };
  }

  enrichedPortfolio(): PortfolioSnapshot {
    const portfolio = this.broker.getPortfolio(this.state.prices);
    const drawdown = computeDrawdown({ nav: portfolio.nav, peakNav: this.state.peakNav });
    const positions = Object.entries(portfolio.positions as Record<string, { units: number; price: number; marketValue: number }>).map(([symbol, position]) => ({
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

  toCandle(event: MarketEvent): CandleLike {
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

  async getDenoisedRsi({ symbol, timestamp }: { symbol: string; timestamp: string }): Promise<RsiContext> {
    const symbolState = this.ensureSymbolState(symbol, 0);
    if (!symbolState.rsiKalman) {
      symbolState.rsiKalman = { x: 50, p: 10 };
    }

    if (typeof this.storage?.getRecentSpotMarketStats !== 'function') {
      return {
        rsi: null,
        innovation: null,
        innovationZ: 0,
        state: symbolState.rsiKalman,
      };
    }

    let stats: Array<{ updatedAt: string; rsi1d: number | null; rsi1h: number | null }> = [];
    try {
      stats = await this.storage.getRecentSpotMarketStats({ symbol, limit: 30 });
    } catch (err) {
      console.warn(`[Engine] Failed to fetch spot market stats: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (stats.length === 0) {
      const cooldownMs = this.config.rsiDrawThroughCooldownMs ?? 300_000;
      const nowMs = Date.now();
      const canAttempt = (nowMs - this.state.rsi.lastDrawThroughAttemptAt) >= cooldownMs;

      if (this.state.rsi.scrapePromise) {
        await this.state.rsi.scrapePromise;
      } else if (canAttempt) {
        console.log(`[Engine] RSI cache miss for ${symbol} at ${timestamp}. Drawing through CoinMarketCap scraper...`);
        this.state.rsi.lastDrawThroughAttemptAt = nowMs;
        this.state.rsi.scrapePromise = (async () => {
          const scraper = new CoinMarketCapScraper({ storage: this.storage });
          await scraper.scrapeRsiData();
        })();

        try {
          await this.state.rsi.scrapePromise;
        } catch (err) {
          console.error(`[Engine] Scraper draw-through failed for ${symbol}:`, err instanceof Error ? err.message : String(err));
        } finally {
          this.state.rsi.scrapePromise = null;
        }
      }

      try {
        stats = await this.storage.getRecentSpotMarketStats({ symbol, limit: 30 });
      } catch (err) {
        console.warn(`[Engine] Failed to reload spot market stats: ${err instanceof Error ? err.message : String(err)}`);
      }
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
    return {
      rsi: res.rsi,
      innovation: res.innovation ?? null,
      innovationZ: res.innovationZ ?? 0,
      state: res.state,
    };
  }
}
