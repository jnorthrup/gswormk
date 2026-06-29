import { defaultConfig } from './config.ts';
import { TraderEngine } from './engine.ts';

type CandleLike = {
  symbol: string;
  granularity?: string;
  start: string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume?: number | string;
};

type ReplayStorage = Record<string, any>;

type WalkForwardReplayInput = {
  storage: ReplayStorage;
  symbols: string[];
  granularity: string;
  trainStart: string;
  trainEnd: string;
  testEnd: string;
  initialCash?: number;
  semivarianceWindow?: number;
  annualizationFactor?: number;
};

type RollingWalkForwardReplayInput = {
  storage: ReplayStorage;
  symbols: string[];
  granularity: string;
  start: string;
  end: string;
  lookbackHours: number;
  stepHours: number;
  initialCash?: number;
  semivarianceWindow?: number;
  annualizationFactor?: number;
};

type WalkForwardFold = {
  symbols: string[];
  trainStart: string;
  trainEnd: string;
  testEnd: string;
  trainCandles: number;
  testCandles: number;
  signals: number;
  decisions: number;
  ordersAccepted: number;
  ordersRejected: number;
  avgNetEdgeBps: number;
  totalReturnPct: number;
  reasons: Record<string, number>;
};

type WalkForwardReplayResult = {
  folds: WalkForwardFold[];
  totals: {
    folds: number;
    trainCandles: number;
    testCandles: number;
    signals: number;
    decisions: number;
    ordersAccepted: number;
    ordersRejected: number;
    avgNetEdgeBps: number;
    totalReturnPct: number;
  };
};

type Recorder = {
  signals: any[];
  orders: any[];
  decisions: any[];
  portfolioSnapshots: any[];
};

export async function runWalkForwardReplay(input: WalkForwardReplayInput): Promise<WalkForwardReplayResult> {
  if (input.symbols.length === 0) {
    throw new Error('walk-forward replay requires at least one symbol');
  }
  if (!input.storage?.getCandlesInRange) {
    throw new Error('walk-forward replay requires storage.getCandlesInRange');
  }

  const trainBySymbol = new Map<string, CandleLike[]>();
  const testBySymbol = new Map<string, CandleLike[]>();
  let trainCandles = 0;
  let testCandles = 0;

  for (const symbol of input.symbols) {
    const train = sortCandles(await input.storage.getCandlesInRange({
      symbol,
      granularity: input.granularity,
      start: input.trainStart,
      end: input.trainEnd,
    }));
    const test = sortCandles(await input.storage.getCandlesInRange({
      symbol,
      granularity: input.granularity,
      start: input.trainEnd,
      end: input.testEnd,
    }));

    trainBySymbol.set(symbol, train);
    testBySymbol.set(symbol, test);
    trainCandles += train.length;
    testCandles += test.length;
  }

  const recorder: Recorder = { signals: [], orders: [], decisions: [], portfolioSnapshots: [] };
  const recordingStorage = recordingStorageProxy(input.storage, recorder);
  const semivarianceWindow = input.semivarianceWindow ?? Math.max(4, Math.min(24, smallestTrainingReturnCount(trainBySymbol)));
  const initialCash = input.initialCash ?? 10_000;
  const config = defaultConfig({
    symbols: input.symbols,
    initialCash,
    ticks: testCandles,
    seed: 42,
    granularity: input.granularity,
    semivarianceWindow,
    tailWindow: semivarianceWindow,
    annualizationFactor: input.annualizationFactor ?? 1,
    useDenoisedRsi: false,
    useSnareGrid: false,
    useConfidenceGating: false,
    useAdaptiveExecutionStyle: false,
    minActionUsd: 1,
    maxDrawdownPct: 0.5,
    allowRestCacheFetch: false,
    allowRestWarmupFetch: false,
  });
  const engine = new TraderEngine({ storage: recordingStorage, config });

  warmEngineFromTraining(engine, trainBySymbol, semivarianceWindow);

  const allCandlesBySymbol = new Map<string, CandleLike[]>();
  for (const symbol of input.symbols) {
    allCandlesBySymbol.set(symbol, sortCandles([
      ...(trainBySymbol.get(symbol) ?? []),
      ...(testBySymbol.get(symbol) ?? []),
    ]));
  }

  engine.cache.loadRecentCandles = async ({ symbol, limit, eventTimestamp }: { symbol: string; limit: number; eventTimestamp: string }) => {
    const cutoff = Date.parse(eventTimestamp);
    const candles = (allCandlesBySymbol.get(symbol) ?? [])
      .filter((candle) => Date.parse(candle.start) <= cutoff)
      .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
      .slice(0, limit);
    return {
      candles,
      cacheHit: candles.length > 0,
      gapCount: 0,
    };
  };

  const events = input.symbols.flatMap((symbol) => (testBySymbol.get(symbol) ?? []).map((candle) => candleToEvent(candle)));
  const groups = groupEventsByTimestamp(events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)));
  for (const group of groups) {
    await engine.processBatch(group);
  }

  const netEdges = recorder.signals
    .map((signal) => Number(signal.netEdgeBps))
    .filter((value) => Number.isFinite(value));
  const decisions = recorder.decisions.length;
  const ordersAccepted = recorder.decisions.filter((decision) => Boolean(decision.executed)).length;
  const finalNav = Number(recorder.portfolioSnapshots.at(-1)?.nav ?? initialCash);
  const fold: WalkForwardFold = {
    symbols: input.symbols,
    trainStart: input.trainStart,
    trainEnd: input.trainEnd,
    testEnd: input.testEnd,
    trainCandles,
    testCandles,
    signals: recorder.signals.length,
    decisions,
    ordersAccepted,
    ordersRejected: decisions - ordersAccepted,
    avgNetEdgeBps: average(netEdges),
    totalReturnPct: initialCash > 0 ? ((finalNav / initialCash) - 1) * 100 : 0,
    reasons: countBy(recorder.decisions.map((decision) => String(decision.reason ?? 'UNKNOWN'))),
  };

  return {
    folds: [fold],
    totals: {
      folds: 1,
      trainCandles: fold.trainCandles,
      testCandles: fold.testCandles,
      signals: fold.signals,
      decisions: fold.decisions,
      ordersAccepted: fold.ordersAccepted,
      ordersRejected: fold.ordersRejected,
      avgNetEdgeBps: fold.avgNetEdgeBps,
      totalReturnPct: fold.totalReturnPct,
    },
  };
}

export async function runRollingWalkForwardReplay(input: RollingWalkForwardReplayInput): Promise<WalkForwardReplayResult> {
  const startMs = Date.parse(input.start);
  const endMs = Date.parse(input.end);
  const lookbackMs = input.lookbackHours * 3_600_000;
  const stepMs = input.stepHours * 3_600_000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('rolling walk-forward requires a valid start/end range');
  }
  if (lookbackMs <= 0 || stepMs <= 0) {
    throw new Error('rolling walk-forward requires lookbackHours and stepHours > 0');
  }

  const folds: WalkForwardFold[] = [];
  for (let trainStartMs = startMs; trainStartMs + lookbackMs + stepMs <= endMs; trainStartMs += stepMs) {
    const trainEndMs = trainStartMs + lookbackMs;
    const testEndMs = trainEndMs + stepMs;
    const replay = await runWalkForwardReplay({
      storage: input.storage,
      symbols: input.symbols,
      granularity: input.granularity,
      trainStart: new Date(trainStartMs).toISOString(),
      trainEnd: new Date(trainEndMs).toISOString(),
      testEnd: new Date(testEndMs).toISOString(),
      initialCash: input.initialCash,
      semivarianceWindow: input.semivarianceWindow,
      annualizationFactor: input.annualizationFactor,
    });
    folds.push(...replay.folds);
  }

  if (folds.length === 0) {
    throw new Error('rolling walk-forward range produced zero folds');
  }

  return {
    folds,
    totals: summarizeFolds(folds),
  };
}

export function renderWalkForwardReport(result: WalkForwardReplayResult): string {
  const totals = result.totals;
  const lines = [
    `[CLI] Walk-forward replay complete: folds=${totals.folds} trainCandles=${totals.trainCandles} testCandles=${totals.testCandles} signals=${totals.signals} decisions=${totals.decisions} accepted=${totals.ordersAccepted} rejected=${totals.ordersRejected} avgNetEdgeBps=${formatNumber(totals.avgNetEdgeBps)} totalReturnPct=${formatNumber(totals.totalReturnPct)}`,
  ];
  const visibleFolds = result.folds.slice(0, 10);
  for (const [index, fold] of visibleFolds.entries()) {
    lines.push(`[CLI] Fold ${index + 1}: symbols=${fold.symbols.join(',')} period=${fold.trainEnd}..${fold.testEnd} decisions=${fold.decisions} accepted=${fold.ordersAccepted} rejected=${fold.ordersRejected} avgNetEdgeBps=${formatNumber(fold.avgNetEdgeBps)} reasons=${formatReasons(fold.reasons)}`);
  }
  if (result.folds.length > visibleFolds.length) {
    lines.push(`[CLI] ... ${result.folds.length - visibleFolds.length} more folds omitted from console report`);
  }
  return lines.join('\n');
}

function summarizeFolds(folds: WalkForwardFold[]): WalkForwardReplayResult['totals'] {
  const signals = folds.reduce((sum, fold) => sum + fold.signals, 0);
  const edgeNumerator = folds.reduce((sum, fold) => sum + (fold.avgNetEdgeBps * fold.signals), 0);
  return {
    folds: folds.length,
    trainCandles: folds.reduce((sum, fold) => sum + fold.trainCandles, 0),
    testCandles: folds.reduce((sum, fold) => sum + fold.testCandles, 0),
    signals,
    decisions: folds.reduce((sum, fold) => sum + fold.decisions, 0),
    ordersAccepted: folds.reduce((sum, fold) => sum + fold.ordersAccepted, 0),
    ordersRejected: folds.reduce((sum, fold) => sum + fold.ordersRejected, 0),
    avgNetEdgeBps: signals > 0 ? edgeNumerator / signals : 0,
    totalReturnPct: average(folds.map((fold) => fold.totalReturnPct)),
  };
}

function recordingStorageProxy(storage: ReplayStorage, recorder: Recorder): ReplayStorage {
  return new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop === 'insertSignal') {
        return async (signal: any) => {
          recorder.signals.push(signal);
          return target.insertSignal?.call(target, signal);
        };
      }
      if (prop === 'insertOrder') {
        return async (order: any) => {
          recorder.orders.push(order);
          return target.insertOrder?.call(target, order);
        };
      }
      if (prop === 'insertDecision') {
        return async (decision: any) => {
          recorder.decisions.push(decision);
          return target.insertDecision?.call(target, decision);
        };
      }
      if (prop === 'insertPortfolioSnapshot') {
        return async (snapshot: any) => {
          recorder.portfolioSnapshots.push(snapshot);
          return target.insertPortfolioSnapshot?.call(target, snapshot);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function warmEngineFromTraining(engine: TraderEngine, trainBySymbol: Map<string, CandleLike[]>, semivarianceWindow: number): void {
  const btcReturns = returnsFor(sortCandles(trainBySymbol.get('BTC-USD') ?? [])).slice(-semivarianceWindow);
  for (const [symbol, candles] of trainBySymbol) {
    const sorted = sortCandles(candles);
    if (sorted.length === 0) continue;
    const lastPrice = Number(sorted.at(-1)!.close);
    const state = engine.ensureSymbolState(symbol, lastPrice);
    state.lastPrice = lastPrice;
    state.kalman = { x: lastPrice, p: 1 };
    state.returns = returnsFor(sorted).slice(-semivarianceWindow);
    state.btcReturns = (symbol === 'BTC-USD' ? state.returns : btcReturns).slice(-semivarianceWindow);
    engine.state.prices[symbol] = lastPrice;
  }
}

function candleToEvent(candle: CandleLike): any {
  const open = Number(candle.open);
  const close = Number(candle.close);
  const mid = close;
  const bullish = close >= open;
  const bidSize = bullish ? 12 : 8;
  const askSize = bullish ? 8 : 12;
  return {
    type: 'market',
    symbol: candle.symbol,
    timestamp: candle.start,
    mid,
    last: close,
    bids: [{ price: mid * 0.9999, size: bidSize }],
    asks: [{ price: mid * 1.0001, size: askSize }],
    volume: Number(candle.volume ?? 0),
  };
}

function groupEventsByTimestamp(events: any[]): any[][] {
  const groups: any[][] = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last && last[0]?.timestamp === event.timestamp) {
      last.push(event);
    } else {
      groups.push([event]);
    }
  }
  return groups;
}

function sortCandles(candles: CandleLike[]): CandleLike[] {
  return [...candles].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

function returnsFor(candles: CandleLike[]): number[] {
  const returns: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const prev = Number(candles[index - 1]!.close);
    const next = Number(candles[index]!.close);
    returns.push(prev > 0 ? (next / prev) - 1 : 0);
  }
  return returns;
}

function smallestTrainingReturnCount(trainBySymbol: Map<string, CandleLike[]>): number {
  const counts = [...trainBySymbol.values()].map((candles) => Math.max(0, candles.length - 1));
  return counts.length === 0 ? 4 : Math.max(4, Math.min(...counts));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countBy(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

function formatReasons(reasons: Record<string, number>): string {
  const entries = Object.entries(reasons);
  if (entries.length === 0) return 'none';
  return entries.map(([reason, count]) => `${reason}:${count}`).join(',');
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}
