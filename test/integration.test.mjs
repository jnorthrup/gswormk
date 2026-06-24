import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createStorage } from '../src/storage/index.mjs';
import { defaultConfig } from '../src/trader/config.mjs';
import { TraderEngine } from '../src/trader/engine.mjs';
import { ReplayFeed } from '../src/feeds/replay-feed.mjs';

test('simulation persists signals, candles, and quota metrics', async () => {
  const dbPath = resolve('./tmp-test.sqlite');
  rmSync(dbPath, { force: true });

  const storage = await createStorage({ kind: 'sqlite', path: dbPath });
  await storage.init();

  const config = defaultConfig({ ticks: 30, seed: 7, initialCash: 50000 });
  const engine = new TraderEngine({ storage, config });
  const feed = new ReplayFeed({ symbols: config.symbols, seed: config.seed, ticks: config.ticks });
  const result = await engine.run(feed);
  const snapshot = await storage.getStatusSnapshot();

  assert.ok(snapshot.counts.candleCount > 0);
  assert.ok(snapshot.counts.signalCount > 0);
  assert.ok(snapshot.latestQuota.length > 0);
  assert.ok(Number.isFinite(result.metrics.cacheHitRatio));

  await storage.close();
  rmSync(dbPath, { force: true });
});