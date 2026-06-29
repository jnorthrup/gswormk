import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createStorage } from '../src/storage/index.ts';
import { defaultConfig } from '../src/trader/config.ts';
import { TraderEngine } from '../src/trader/engine.ts';

test('simulation persists signals, candles, and quota metrics', async () => {
  const dbPath = resolve('./tmp-test.duckdb');
  rmSync(dbPath, { force: true });

  const storage = await createStorage({ kind: 'duckdb', path: dbPath });
  await storage.init();
  await storage.upsertSpotMarketAsset({
    symbol: 'BTC-USD',
    baseSymbol: 'BTC',
    quoteSymbol: 'USD',
    base_symbol: 'BTC',
    quote_symbol: 'USD',
    assetName: 'Bitcoin',
    asset_name: 'Bitcoin',
    cmcSlug: 'bitcoin',
    cmc_slug: 'bitcoin',
    cmcMainPageUrl: 'https://coinmarketcap.com/currencies/bitcoin/',
    cmc_main_page_url: 'https://coinmarketcap.com/currencies/bitcoin/',
    cmcRsiUrl: 'https://coinmarketcap.com/charts/rsi/',
    cmc_rsi_url: 'https://coinmarketcap.com/charts/rsi/',
    updatedAt: '2026-06-27T12:00:00Z',
    updated_at: '2026-06-27T12:00:00Z',
  });
  await storage.upsertSpotMarketAsset({
    symbol: 'ETH-USD',
    baseSymbol: 'ETH',
    quoteSymbol: 'USD',
    base_symbol: 'ETH',
    quote_symbol: 'USD',
    assetName: 'Ethereum',
    asset_name: 'Ethereum',
    cmcSlug: 'ethereum',
    cmc_slug: 'ethereum',
    cmcMainPageUrl: 'https://coinmarketcap.com/currencies/ethereum/',
    cmc_main_page_url: 'https://coinmarketcap.com/currencies/ethereum/',
    cmcRsiUrl: 'https://coinmarketcap.com/charts/rsi/',
    cmc_rsi_url: 'https://coinmarketcap.com/charts/rsi/',
    updatedAt: '2026-06-27T12:00:00Z',
    updated_at: '2026-06-27T12:00:00Z',
  });
  const statsNow = new Date();
  const statsEarlier = new Date(statsNow.getTime() - (30 * 60 * 1000));
  for (const [symbol, baseRsi] of [['BTC-USD', 42], ['ETH-USD', 44]]) {
    await storage.upsertSpotMarketStats({
      symbol,
      price: symbol === 'BTC-USD' ? 60000 : 3000,
      change24h: 1.5,
      rsi1d: baseRsi,
      rsi1h: baseRsi - 2,
      updatedAt: statsEarlier.toISOString(),
    });
    await storage.upsertSpotMarketStats({
      symbol,
      price: symbol === 'BTC-USD' ? 60200 : 3010,
      change24h: 1.7,
      rsi1d: baseRsi + 1,
      rsi1h: baseRsi - 1,
      updatedAt: statsNow.toISOString(),
    });
  }

  const config = defaultConfig({ ticks: 30, seed: 7, initialCash: 50000 });
  const engine = new TraderEngine({ storage, config });
  await engine.warmup();

  const timestamp = new Date().toISOString();
  await engine.processBatch([
    {
      type: 'market',
      symbol: 'BTC-USD',
      timestamp,
      mid: 60200,
      last: 60200,
      bids: [{ price: 60190, size: 1.5 }],
      asks: [{ price: 60210, size: 1.5 }],
      volume: 10,
    },
    {
      type: 'market',
      symbol: 'ETH-USD',
      timestamp,
      mid: 3010,
      last: 3010,
      bids: [{ price: 3008, size: 10 }],
      asks: [{ price: 3012, size: 10 }],
      volume: 100,
    }
  ]);

  const snapshot = await storage.getStatusSnapshot();

  assert.ok(snapshot.counts.candleCount > 0);
  assert.ok(snapshot.counts.signalCount > 0);
  assert.ok(snapshot.counts.decisionCount > 0);
  assert.ok(snapshot.counts.portfolioSnapshotCount > 0);
  assert.ok(snapshot.latestQuota.length > 0);
  assert.ok(snapshot.latestSignals[0].risk_state);
  assert.ok(snapshot.latestDecisions.length > 0);
  const cacheHitRatio = engine.state.metrics.cacheHits / Math.max(1, engine.state.metrics.cacheHits + engine.state.metrics.apiCalls);
  assert.ok(Number.isFinite(cacheHitRatio));
  const spotMarketAssets = await storage.getSpotMarketAssets({ symbols: ['BTC-USD', 'ETH-USD'] });
  assert.ok(spotMarketAssets.some((asset) => asset.symbol === 'BTC-USD'));

  await storage.close();
  rmSync(dbPath, { force: true });
});
