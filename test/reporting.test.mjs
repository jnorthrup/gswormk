import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStatusReport } from '../src/trader/reporting.ts';

test('renderStatusReport includes asset names, CMC chart refs, and advantage fields', () => {
  const report = renderStatusReport({
    db: { kind: 'duckdb', path: ':memory:' },
    counts: {
      candleCount: 10,
      signalCount: 1,
      orderCount: 1,
      decisionCount: 1,
      portfolioSnapshotCount: 1,
    },
    latestPortfolio: {
      nav: 1000,
      cash: 800,
      peak_nav: 1200,
      drawdown: 0.1,
    },
    latestQuotaSummary: {
      cacheHitRatio: 0.9,
      apiCalls: 2,
    },
    latestPositions: [
      {
        symbol: 'BTC-USD',
        units: 0.01,
        price: 60000,
        market_value: 600,
        weight: 0.6,
      },
    ],
    latestSignals: [
      {
        symbol: 'BTC-USD',
        dominant_regime: 'momentum',
        advantage_probability: 0.725,
        denoised_rsi: 68.2,
        obi: 0.12,
        innovation_z: 1.4,
        target_weight: 0.3,
        current_weight: 0.2,
        trigger: 0.05,
        risk_state: 'OK',
      },
    ],
    latestDecisions: [
      {
        symbol: 'BTC-USD',
        target_weight: 0.3,
        current_weight: 0.2,
        deviation: 0.1,
        executed: 1,
        notional_delta: 100,
        reason: 'EXECUTED',
      },
    ],
    spotMarketAssets: [
      {
        symbol: 'BTC-USD',
        assetName: 'Bitcoin',
        cmcMainPageUrl: 'https://coinmarketcap.com/currencies/bitcoin/',
        cmcRsiUrl: 'https://coinmarketcap.com/charts/rsi/',
      },
    ],
  });

  assert.match(report, /Bitcoin/);
  assert.match(report, /72.5%/);
  assert.match(report, /68.2/);
  // URLs may be truncated in table, check for domain
  assert.match(report, /coinmarketcap\.com/);
});
