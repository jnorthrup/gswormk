import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { TraderEngine } from '../src/trader/engine.ts';
import { defaultConfig } from '../src/trader/config.ts';
import { PaperBroker } from '../src/trader/paper-broker.ts';
import { createStorage } from '../src/storage/index.ts';

class MockStorage {
  async getRecentSpotMarketStats() { return []; }
}

function makeEngine() {
  const storage = new MockStorage();
  const config = defaultConfig({
    symbols: ['BTC-USD'],
    initialCash: 10_000,
    semivarianceWindow: 4,
    useSnareGrid: false,
    useConfidenceGating: false,
    useAdaptiveExecutionStyle: false,
    minActionUsd: 1,
    maxDrawdownPct: 0.5,
  });
  const engine = new TraderEngine({ storage, config });
  const broker = new PaperBroker({ initialCash: 10_000 });
  engine.broker = broker;
  engine.state.prices['BTC-USD'] = 100;
  engine.state.peakNav = 10_000;
  const state = engine.ensureSymbolState('BTC-USD', 100);
  state.returns = [0.01, -0.01, 0.02, -0.02];
  state.btcReturns = [0.01, -0.01, 0.02, -0.02];
  return { engine, broker };
}

function baseEvent() {
  return {
    type: 'market',
    symbol: 'BTC-USD',
    timestamp: '2026-06-27T12:00:00Z',
    mid: 100,
    last: 100,
    bids: [{ price: 99.99, size: 10 }],
    asks: [{ price: 100.01, size: 10 }],
    volume: 10,
  };
}

function baseSignal(overrides = {}) {
  return {
    symbol: 'BTC-USD',
    event: baseEvent(),
    cacheHit: true,
    obi: 0,
    innovationZ: 0,
    kalmanState: { x: 100, p: 1 },
    rvDown: 0.05,
    tailDependence: 0.05,
    effectiveCost: 0.0009,
    spread: 0.0001,
    trigger: 0.001,
    alignment: 1,
    cacheQuality: 1,
    effectiveDrift: 0.01,
    rawKelly: 1,
    denoisedRsi: 50,
    rsiInnovation: null,
    rsiInnovationZ: 0,
    currentWeight: 0,
    urgency: 0.5,
    regime: { momentum: 0, meanReversion: 0, volatility: 0 },
    regimeRankings: [],
    regimeProfile: {},
    timescaleAttention: {
      supportCount: 0,
      preferredWindow: null,
      windowSigma: null,
      weightedDrift: 0,
      weightedRewardRisk: 0,
      attentionMultiplier: 1,
      timeDilation: 1,
      weights: [],
      samples: [],
      attentionScore: 0,
      advantageProbability: 0.5,
      denoisedRsi: null,
      triggerMultiplier: 1,
      kellyMultiplier: 1,
    },
    confidenceScalers: {
      supportCount: 0,
      preferredWindow: null,
      windowSigma: null,
      weightedDrift: 0,
      weightedRewardRisk: 0,
      attentionMultiplier: 1,
      timeDilation: 1,
      weights: [],
      samples: [],
      attentionScore: 0,
      advantageProbability: 0.5,
      denoisedRsi: null,
      triggerMultiplier: 1,
      kellyMultiplier: 1,
    },
    dominantRegime: 'momentum',
    ...overrides,
  };
}

test('rebalance rejects no_edge before broker side effects', async () => {
  const { engine, broker } = makeEngine();
  const event = baseEvent();
  const signal = baseSignal({ event, innovationZ: 0.1, obi: 0, denoisedRsi: 50, tailDependence: 0.05, rvDown: 0.05 });

  const result = await engine.rebalance({ event, signal, targetWeight: 0.2 });

  assert.strictEqual(result.accepted, false);
  assert.strictEqual(result.reason, 'NO_ARCHETYPE_EDGE');
  assert.strictEqual(result.archetype, 'no_edge');
  assert.strictEqual(broker.orders.length, 0);
  assert.strictEqual(broker.pendingOrders.length, 0);
});

test('rebalance rejects positive archetype when net edge is below zero before broker side effects', async () => {
  const { engine, broker } = makeEngine();
  const event = baseEvent();
  const signal = baseSignal({
    event,
    innovationZ: 2.5,
    obi: 0.3,
    denoisedRsi: 65,
    tailDependence: 0.05,
    rvDown: 0.05,
    timescaleAttention: { ...baseSignal().timescaleAttention, supportCount: 3 },
    confidenceScalers: { ...baseSignal().confidenceScalers, advantageProbability: 0.7 },
    effectiveDrift: 0.0001,
    effectiveCost: 0.01,
    spread: 0.0092,
  });

  const result = await engine.rebalance({ event, signal, targetWeight: 0.2 });

  assert.strictEqual(result.accepted, false);
  assert.strictEqual(result.reason, 'NET_EDGE_TOO_LOW');
  assert.strictEqual(result.archetype, 'growth_momentum');
  assert.ok(result.netEdgeBps <= 0);
  assert.strictEqual(broker.orders.length, 0);
  assert.strictEqual(broker.pendingOrders.length, 0);
});

test('DuckDB storage persists signal/order archetype and order edge bps', async () => {
  const dbPath = resolve('./tmp-engine-gating.duckdb');
  rmSync(dbPath, { force: true });
  const storage = await createStorage({ kind: 'duckdb', path: dbPath });
  await storage.init();

  await storage.insertSignal({
    timestamp: '2026-06-27T12:00:00Z',
    symbol: 'BTC-USD',
    mid: 100,
    spread: 0.0001,
    effectiveCost: 0.0009,
    obi: 0.3,
    innovationZ: 2.5,
    rvDown: 0.05,
    tailDependence: 0.05,
    alignment: 1,
    cacheQuality: 1,
    effectiveDrift: 0.01,
    targetWeight: 0.2,
    currentWeight: 0,
    trigger: 0.001,
    drawdown: 0,
    quotaHit: 1,
    regimeMomentum: 1,
    regimeMeanReversion: 0,
    regimeVolatility: 0,
    timescaleSupportCount: 3,
    timescaleWindowCenter: 15,
    timescaleAttention: 1,
    timescaleTimeDilation: 1,
    denoisedRsi: 65,
    rsiInnovationZ: 0,
    confidenceScalers: 1,
    advantageProbability: 0.7,
    riskState: 'normal',
    dominantRegime: 'momentum',
    archetype: 'growth_momentum',
  });

  await storage.insertOrder({
    timestamp: '2026-06-27T12:00:00Z',
    symbol: 'BTC-USD',
    side: 'BUY',
    quantity: 1,
    price: 100,
    gross: 100,
    remainingCash: 9900,
    remainingUnits: 1,
    archetype: 'growth_momentum',
    grossEdgeBps: 100,
    costBps: 9,
    uncertaintyBps: 0,
    netEdgeBps: 91,
  });

  const [signal] = await storage.getRecentSignals({ limit: 1 });
  const [order] = await storage.getRecentOrders({ limit: 1 });
  assert.strictEqual(signal.archetype, 'growth_momentum');
  assert.strictEqual(order.archetype, 'growth_momentum');
  assert.strictEqual(order.net_edge_bps, 91);

  await storage.close();
  rmSync(dbPath, { force: true });
});
