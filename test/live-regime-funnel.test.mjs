import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperBroker } from '../src/trader/paper-broker.ts';
import { TraderEngine } from '../src/trader/engine.ts';
import { defaultConfig } from '../src/trader/config.ts';
import { induceKelly, induceTrigger } from '../src/trader/signals.ts';

class MockStorage {
  constructor() {
    this.candles = [];
    this.signals = [];
    this.orders = [];
    this.decisions = [];
    this.quotaMetrics = [];
    this.portfolioSnapshots = [];
    this.spotStats = new Map();
  }

  async upsertCandles(candles) {
    this.candles.push(...candles);
  }

  async insertSignal(signal) {
    this.signals.push(signal);
  }

  async insertQuotaMetric(metric) {
    this.quotaMetrics.push(metric);
  }

  async insertDecision(decision) {
    this.decisions.push(decision);
  }

  async insertOrder(order) {
    this.orders.push(order);
  }

  async insertPortfolioSnapshot(snapshot) {
    this.portfolioSnapshots.push(snapshot);
  }

  async getRecentSpotMarketStats({ symbol, limit }) {
    return (this.spotStats.get(symbol) || []).slice(0, limit);
  }
}

function makeEngine(overrides = {}) {
  const storage = new MockStorage();
  const config = defaultConfig({
    symbols: ['BTC-USD'],
    initialCash: 100000,
    annualizationFactor: 1,
    semivarianceWindow: 4,
    tailWindow: 4,
    useSnareGrid: overrides.useSnareGrid ?? false,
    useConfidenceGating: overrides.useConfidenceGating ?? false,
    useDenoisedRsi: overrides.useDenoisedRsi ?? false,
    fibLevels: [0.382, 0.618],
    profitTargetPct: 0.02,
    stopLossPct: 0.01,
    maxDrawdownPct: 0.5,
    ...overrides,
  });

  const engine = new TraderEngine({ storage, config });
  const broker = new PaperBroker({ initialCash: 100000 });
  engine.broker = broker;
  engine.state.prices['BTC-USD'] = 100;
  broker.positions.set('BTC-USD', 1);

  return { storage, config, engine, broker };
}

function makeCandlesFromReturns({ symbol, returns, latestClose = 100, timestamp = '2026-06-27T12:00:00Z' }) {
  const closes = [latestClose];
  for (const ret of returns) {
    closes.push(closes[closes.length - 1] / (1 + ret));
  }

  return closes.map((close, index) => ({
    symbol,
    granularity: '1m',
    start: new Date(Date.parse(timestamp) - (index * 60_000)).toISOString(),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
}

function makeSignalScenario({
  returns,
  desiredInnovationZ,
  obi,
  latestClose = 100,
  timestamp = '2026-06-27T12:00:00Z',
}) {
  const symbol = 'BTC-USD';
  const sigma = Math.sqrt(1 + 0.05 + 4);
  const kalmanX = latestClose - (desiredInnovationZ * sigma);
  const bidSize = (1 + obi) * 10;
  const askSize = (1 - obi) * 10;

  return {
    event: {
      symbol,
      mid: latestClose,
      last: latestClose,
      bids: [{ price: latestClose - 0.01, size: bidSize }],
      asks: [{ price: latestClose + 0.01, size: askSize }],
      timestamp,
    },
    symbolState: {
      kalman: { x: kalmanX, p: 1 },
      returns: [...returns],
      btcReturns: [...returns],
      lastPrice: latestClose,
    },
    cacheResult: {
      candles: makeCandlesFromReturns({ symbol, returns, latestClose, timestamp }),
      cacheHit: true,
      gapCount: 0,
    },
  };
}

test('TraderEngine: regime profiles override scaling multipliers without changing ranking logic', () => {
  const { engine } = makeEngine({
    regimeProfiles: {
      momentum: {
        triggerMultiplier: 0.4,
        kellyMultiplier: 1.6,
        snareSpacingMultiplier: 4.0,
      },
    },
  });

  const scenario = makeSignalScenario({
    returns: [2, 0.02, 0.02, 0.02],
    desiredInnovationZ: 2,
    obi: 0.1,
  });

  const signal = engine.computeSignal(scenario);
  const baseTrigger = induceTrigger(signal.effectiveCost, signal.rvDown);
  const baseKelly = induceKelly({
    effectiveDrift: signal.effectiveDrift,
    rvDown: signal.rvDown,
    tailDependence: signal.tailDependence,
  });

  assert.strictEqual(signal.dominantRegime, 'momentum');
  assert.strictEqual(signal.regimeProfile.snareSpacingMultiplier, 4);
  assert.ok(Math.abs((signal.trigger / baseTrigger) - 0.4) < 1e-9);
  assert.ok(Math.abs((signal.rawKelly / baseKelly) - 1.6) < 1e-9);
});

test('TraderEngine: multiscale attention activates on longer candle history and persists to storage', async () => {
  const { engine, storage, broker } = makeEngine({ useConfidenceGating: true });
  const returns = Array.from({ length: 64 }, (_, index) => (index % 2 === 0 ? 0.03 : -0.025));
  const scenario = makeSignalScenario({
    returns,
    desiredInnovationZ: 0.2,
    obi: 0.05,
    latestClose: 100,
  });

  const state = engine.ensureSymbolState('BTC-USD', 100);
  state.kalman = scenario.symbolState.kalman;
  state.returns = [...scenario.symbolState.returns];
  state.btcReturns = [...scenario.symbolState.btcReturns];
  state.lastPrice = scenario.symbolState.lastPrice;
  engine.state.prices['BTC-USD'] = 100;
  broker.positions.set('BTC-USD', 1);

  engine.cache.loadRecentCandles = async () => scenario.cacheResult;

  await engine.processBatch([scenario.event]);

  assert.strictEqual(storage.signals.length, 1);
  assert.ok(storage.signals[0].timescaleSupportCount >= 3);
  assert.ok(storage.signals[0].timescaleWindowCenter >= 5);
  assert.ok(storage.signals[0].timescaleTimeDilation > 1);
  assert.ok(Number.isFinite(storage.signals[0].timescaleAttention));
  const baseTrigger = induceTrigger(storage.signals[0].effectiveCost, storage.signals[0].rvDown);
  assert.ok(storage.signals[0].trigger > baseTrigger * 1.5, 'multiscale attention should further widen the volatility trigger band');
});

test('TraderEngine: manageSnareGrid widens snare spacing by dominant regime', () => {
  const event = {
    symbol: 'BTC-USD',
    mid: 100,
    last: 100,
    bids: [{ price: 99.99, size: 10 }],
    asks: [{ price: 100.01, size: 10 }],
    timestamp: '2026-06-27T12:00:00Z',
  };

  const expectedPrices = {
    meanReversion: [99.24, 98.76],
    volatility: [99.01, 98.39],
    momentum: [98.47, 97.53],
  };

  for (const [dominantRegime, prices] of Object.entries(expectedPrices)) {
    const { engine, broker } = makeEngine({ useSnareGrid: true });
    const portfolio = broker.getPortfolio({ 'BTC-USD': 100 });

    engine.manageSnareGrid(event, { rvDown: 0.0004, dominantRegime }, portfolio);

    const snares = broker.pendingOrders.filter((order) => order.is_snare);
    assert.strictEqual(snares.length, 2, `${dominantRegime} should keep the two Fib snare levels active`);
    assert.deepStrictEqual(
      snares.map((order) => order.price).sort((a, b) => a - b),
      [...prices].sort((a, b) => a - b),
      `${dominantRegime} should place regime-specific snare prices`,
    );
    assert.ok(snares.every((order) => order.regime === dominantRegime));
  }
});

test('TraderEngine: processBatch persists dominantRegime and adjusted trigger to storage logs', async () => {
  const { engine, storage, broker } = makeEngine({ useConfidenceGating: true });
  const scenario = makeSignalScenario({
    returns: [2, 0.02, 0.02, 0],
    desiredInnovationZ: 2,
    obi: 0.1,
  });

  const state = engine.ensureSymbolState('BTC-USD', 100);
  state.kalman = scenario.symbolState.kalman;
  state.returns = [...scenario.symbolState.returns];
  state.btcReturns = [...scenario.symbolState.btcReturns];
  state.lastPrice = scenario.symbolState.lastPrice;
  engine.state.prices['BTC-USD'] = 100;
  broker.positions.set('BTC-USD', 1);

  engine.cache.loadRecentCandles = async () => scenario.cacheResult;

  await engine.processBatch([scenario.event]);

  assert.strictEqual(storage.signals.length, 1);
  assert.strictEqual(storage.signals[0].dominantRegime, 'momentum');

  const baseTrigger = induceTrigger(storage.signals[0].effectiveCost, storage.signals[0].rvDown);
  assert.ok(storage.signals[0].trigger < baseTrigger, 'momentum should narrow the trigger band');
  assert.ok(storage.signals[0].targetWeight > 0, 'adjusted Kelly sizing should still produce a positive target');
  assert.strictEqual(storage.decisions.length, 1);
  assert.strictEqual(storage.decisions[0].trigger, storage.signals[0].trigger);
});
