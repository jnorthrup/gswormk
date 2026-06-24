#!/usr/bin/env node

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { createStorage } from './storage/index.mjs';
import { TraderEngine } from './trader/engine.mjs';
import { ReplayFeed } from './feeds/replay-feed.mjs';
import { defaultConfig } from './trader/config.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'simulate';
  const dbKind = args.db ?? 'sqlite';
  const dbPath = resolve(args['db-path'] ?? (dbKind === 'duckdb' ? './data/trader.duckdb' : './data/trader.sqlite'));

  mkdirSync(dirname(dbPath), { recursive: true });

  const storage = await createStorage({ kind: dbKind, path: dbPath });
  await storage.init();

  if (command === 'simulate') {
    const config = defaultConfig({
      symbols: String(args.symbols ?? 'BTC-USD,ETH-USD').split(',').map((item) => item.trim()).filter(Boolean),
      ticks: Number(args.ticks ?? 300),
      seed: Number(args.seed ?? 42),
      initialCash: Number(args['initial-cash'] ?? 100000),
      reinvestPct: Number(args['reinvest-pct'] ?? 0.9),
      maxPositionPct: Number(args['max-position-pct'] ?? 0.45),
      maxDrawdownPct: Number(args['max-drawdown-pct'] ?? 0.15),
    });

    const feed = new ReplayFeed({
      symbols: config.symbols,
      seed: config.seed,
      ticks: config.ticks,
    });

    const engine = new TraderEngine({ storage, config });
    const summary = await engine.run(feed);
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === 'status') {
    const snapshot = await storage.getStatusSnapshot();
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
  }

  await storage.close();
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});