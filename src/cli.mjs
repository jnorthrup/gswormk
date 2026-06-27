#!/usr/bin/env node

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { createStorage } from './storage/index.mjs';
import { TraderEngine } from './trader/engine.mjs';
import { ReplayFeed } from './feeds/replay-feed.mjs';
import { defaultConfig } from './trader/config.mjs';
import { renderSimulationReport, renderStatusReport } from './trader/reporting.mjs';
import { CoinbaseRest } from './feeds/coinbase-rest.mjs';
import { CoinbaseWS } from './feeds/coinbase-ws.mjs';
import { CoinbaseSync } from './feeds/coinbase-sync.mjs';
import { CoinMarketCapScraper } from './feeds/coinmarketcap-scraper.mjs';

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
    console.log(renderSimulationReport(summary));
    console.log('\n--- json ---');
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === 'status') {
    const snapshot = await storage.getStatusSnapshot();
    console.log(renderStatusReport(snapshot));
    console.log('\n--- json ---');
    console.log(JSON.stringify(snapshot, null, 2));
  } else if (command === 'trade') {
    const config = defaultConfig({
      symbols: String(args.symbols ?? 'BTC-USD,ETH-USD').split(',').map((item) => item.trim()).filter(Boolean),
      initialCash: Number(args['initial-cash'] ?? 10000),
      reinvestPct: Number(args['reinvest-pct'] ?? 0.8),
      maxPositionPct: Number(args['max-position-pct'] ?? 0.50),
      maxDrawdownPct: Number(args['max-drawdown-pct'] ?? 0.15),
      paperWalletPath: resolve(args['paper-wallet-path'] ?? './data/paper-wallet-state.json'),
      evaluateIntervalMs: Number(args['evaluate-interval-ms'] ?? 5000),
      deviationLimitBps: Number(args['deviation-limit-bps'] ?? 10),
    });

    mkdirSync(dirname(config.paperWalletPath), { recursive: true });

    const restClient = new CoinbaseRest();
    config.restClient = restClient;

    const feed = new CoinbaseWS({
      symbols: config.symbols,
      restClient,
      evaluateIntervalMs: config.evaluateIntervalMs,
      deviationLimitBps: config.deviationLimitBps,
    });

    const engine = new TraderEngine({ storage, config });
    const sync = new CoinbaseSync({ storage, restClient, broker: engine.broker });
    sync.startSyncLoop(); // starts background sync

    await engine.runLive(feed);
  } else if (command === 'scrape-rsi') {
    const scraper = new CoinMarketCapScraper({ storage });
    await scraper.scrapeRsiData();
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