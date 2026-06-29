import { parseArgs as parseNodeArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createStorage } from './storage/index.ts';
import { defaultConfig } from './trader/config.ts';
import { TraderEngine } from './trader/engine.ts';
import { CoinbaseCDPRest } from './feeds/coinbase-cdp.ts';
import { CoinbaseCDPWS } from './feeds/coinbase-cdp-ws.mjs';
import { CoinbaseSync } from './feeds/coinbase-sync.ts';
import { CoinMarketCapScraper } from './feeds/coinmarketcap-scraper.ts';
import { renderStatusReport } from './trader/reporting.ts';
import { runRollingWalkForwardReplay, renderWalkForwardReport } from './trader/walkforward.ts';
import { granularityMinutes } from './lib/time.ts';

type CliValue = string | boolean | undefined;
type CliValues = Record<string, CliValue>;

type SpotMarketAsset = {
  symbol: string;
  cmcSymbol?: string | null;
  cmcAssetId?: string | number | null;
};

type SpotMarketStat = {
  symbol: string;
  updated_at: string | number;
  change_24h?: string | number | null;
};

function stringOption(values: CliValues, key: string, fallback: string): string {
  const value = values[key];
  return typeof value === 'string' ? value : fallback;
}

function numberOption(values: CliValues, key: string, fallback: number): number {
  const value = values[key];
  return typeof value === 'string' ? Number(value) : fallback;
}

function booleanOption(values: CliValues, key: string): boolean {
  const value = values[key];
  return value === true || value === 'true';
}

function splitSymbols(value: CliValue): string[] {
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const parsed = parseNodeArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      db: { type: 'string', short: 'd' },
      'db-path': { type: 'string' },
      symbols: { type: 'string' },
      'initial-cash': { type: 'string' },
      'reinvest-pct': { type: 'string' },
      'max-position-pct': { type: 'string' },
      'max-drawdown-pct': { type: 'string' },
      'min-action-usd': { type: 'string' },
      'paper-wallet-path': { type: 'string' },
      'reset-wallet': { type: 'boolean' },
      'evaluate-interval-ms': { type: 'string' },
      'deviation-limit-bps': { type: 'string' },
      'first-tier-limit': { type: 'string' },
      'rotation-interval-ms': { type: 'string' },
      granularity: { type: 'string' },
      limit: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      lookback: { type: 'string' },
      step: { type: 'string' },
    },
  });

  const values = parsed.values as CliValues;
  const command = parsed.positionals[0] ?? 'simulate';
  const dbKind = stringOption(values, 'db', 'duckdb');
  const dbPath = resolve(stringOption(values, 'db-path', './data/trader.duckdb'));

  mkdirSync(dirname(dbPath), { recursive: true });

  const storage = await createStorage({ kind: dbKind, path: dbPath });
  await storage.init();

  if (command === 'status') {
    const snapshot = await storage.getStatusSnapshot();
    console.log(renderStatusReport(snapshot));
    console.log('\n--- json ---');
    console.log(JSON.stringify(snapshot, (_key, value) => typeof value === 'bigint' ? Number(value) : value, 2));
  } else if (command === 'trade') {
    const cdpRestClient = new CoinbaseCDPRest();

    let symbols = splitSymbols(values.symbols);
    if (symbols.length === 0) {
      let assets = await storage.getSpotMarketAssets() as SpotMarketAsset[];
      if (assets.length === 0) {
        console.log('[CLI] Empty database. Scraping CoinMarketCap to populate initial asset list...');
        const scraper = new CoinMarketCapScraper({ storage });
        try {
          await scraper.scrapeRsiData();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[CLI] Failed to scrape CMC data:', message);
        }

        const tempSync = new CoinbaseSync({ storage, restClient: cdpRestClient });
        await tempSync.fetchSpotProducts();

        assets = await storage.getSpotMarketAssets() as SpotMarketAsset[];
      }

      const cmcSymbols = new Set<string>(
        assets
          .filter((asset) => asset.cmcSymbol !== null && asset.cmcSymbol !== undefined)
          .map((asset) => asset.symbol),
      );

      const stats = await storage.getSpotMarketStats() as SpotMarketStat[];
      const latestStats = new Map<string, SpotMarketStat>();
      for (const stat of stats) {
        const current = latestStats.get(stat.symbol);
        if (!current || stat.updated_at > current.updated_at) {
          latestStats.set(stat.symbol, stat);
        }
      }

      symbols = [...cmcSymbols].sort((left, right) => {
        const changeLeft = Math.abs(Number(latestStats.get(left)?.change_24h ?? 0));
        const changeRight = Math.abs(Number(latestStats.get(right)?.change_24h ?? 0));
        return changeRight - changeLeft;
      });

      const coreLiquid = symbols.filter((symbol) => {
        const cmcAsset = assets.find((asset) => asset.symbol === symbol);
        const rank = cmcAsset?.cmcAssetId ? Number(cmcAsset.cmcAssetId) : Infinity;
        return rank <= 10;
      });

      const breakout = symbols.filter((symbol) => {
        const stat = latestStats.get(symbol);
        return Math.abs(Number(stat?.change_24h ?? 0)) > 5 && !coreLiquid.includes(symbol);
      });

      const initialCash = numberOption(values, 'initial-cash', 10_000);
      const firstTierLimit = numberOption(values, 'first-tier-limit', initialCash < 500 ? 5 : 20);
      console.log(`[CLI] Core liquid (CMC top 10): ${coreLiquid.join(', ') || 'none'}`);
      console.log(`[CLI] Breakout (>5p movers (>5%): ${breakout.join(', ') || 'none'}`);

      const selected = [...new Set([...coreLiquid, ...breakout])].slice(0, firstTierLimit);
      console.log(`[CLI] Selected first tier of ${selected.length} symbols: ${selected.join(', ')}`);
      symbols = selected;
    }

    const initialCash = numberOption(values, 'initial-cash', 10_000);
    const config = defaultConfig({
      symbols,
      initialCash,
      reinvestPct: numberOption(values, 'reinvest-pct', 0.8),
      maxPositionPct: numberOption(values, 'max-position-pct', 0.50),
      maxDrawdownPct: numberOption(values, 'max-drawdown-pct', 0.15),
      minActionUsd: numberOption(values, 'min-action-usd', initialCash < 500 ? 5 : 25),
      paperWalletPath: resolve(stringOption(values, 'paper-wallet-path', './data/paper-wallet-state.json')),
      resetWallet: booleanOption(values, 'reset-wallet'),
      evaluateIntervalMs: numberOption(values, 'evaluate-interval-ms', 5_000),
      deviationLimitBps: numberOption(values, 'deviation-limit-bps', 10),
    });

    mkdirSync(dirname(config.paperWalletPath), { recursive: true });

    const feed = new CoinbaseCDPWS({
      symbols: config.symbols,
      evaluateIntervalMs: config.evaluateIntervalMs,
      deviationLimitBps: config.deviationLimitBps,
    });

    const engine = new TraderEngine({ storage, config });
    engine.feed = feed;

    const sync = new CoinbaseSync({
      storage,
      restClient: cdpRestClient,
      broker: engine.broker,
      engine,
      rotationIntervalMs: numberOption(values, 'rotation-interval-ms', 15 * 60 * 1_000),
    });
    sync.startSyncLoop();

    await engine.runLive(feed);
  } else if (command === 'scrape-rsi') {
    const scraper = new CoinMarketCapScraper({ storage });
    await scraper.scrapeRsiData();
  } else if (command === 'backfill') {
    const symbols = splitSymbols(values.symbols);
    if (symbols.length === 0) {
      console.error('[CLI] --symbols required for backfill (comma-separated)');
      process.exitCode = 1;
      await storage.close();
      return;
    }
    const granularity = stringOption(values, 'granularity', '1h');
    const limit = numberOption(values, 'limit', 300);
    const restClient = new CoinbaseCDPRest();
    const sync = new CoinbaseSync({ storage, restClient });

    console.log(`[CLI] Backfilling ${symbols.length} symbols at ${granularity} (limit=${limit})`);

    for (const symbol of symbols) {
      try {
        const candles = await sync.fetchCandleWindow({
          symbol,
          granularity,
          limit,
          nowMs: Date.now(),
        });
        if (candles.length > 0) {
          // Sort ascending for validation (newest last)
          const sorted = [...candles].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
          const { result } = (await import('./trader/cache-manager.ts')).interpolateCandleGaps(sorted, granularity);
          // interpolateCandleGaps returns descending; re-sort to ascending for validation
          const ascending = [...result].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
          await storage.upsertCandles(ascending);
          console.log(`[CLI] ${symbol}: ${ascending.length} candles upserted`);
        } else {
          console.log(`[CLI] ${symbol}: no candles fetched`);
        }
      } catch (error) {
        console.error(`[CLI] ${symbol} failed:`, (error as Error).message);
      }
    }
  } else if (command === 'walkforward') {
    const symbols = splitSymbols(values.symbols);
    if (symbols.length === 0) {
      console.error('[CLI] --symbols required for walkforward (comma-separated)');
      process.exitCode = 1;
      await storage.close();
      return;
    }
    const granularity = stringOption(values, 'granularity', '1h');
    const lookback = numberOption(values, 'lookback', 168); // 7 days in hours
    // Parse step - handle both numeric (24) and string with suffix (24h, 1h)
    const stepRaw = values['step'];
    const step = typeof stepRaw === 'string' ? parseInt(stepRaw.replace(/h$/, ''), 10) : 24;
    const startDate = stringOption(values, 'start', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
    const endDate = stringOption(values, 'end', new Date().toISOString().slice(0, 10));

    console.log(`[CLI] Walk-forward backtest: ${symbols.join(', ')}`);
    console.log(`  granularity=${granularity} lookback=${lookback}h step=${step}h`);
    console.log(`  period: ${startDate} to ${endDate}`);

    // Walk-forward: train on [t-lookback, t), test on [t, t+step)
    const trainStart = new Date(startDate);
    const rangeEnd = new Date(endDate);
    const trainEnd = new Date(trainStart.getTime() + lookback * 3600000);
    const testEnd = new Date(trainEnd.getTime() + step * 3600000);

    if (testEnd > rangeEnd) {
      console.error('[CLI] Lookback too large for date range');
      process.exitCode = 1;
      await storage.close();
      return;
    }

    // Fetch the full replay window so rolling folds can advance through the entire period.
    console.log(`[CLI] Training period: ${trainStart.toISOString().slice(0, 19)} to ${trainEnd.toISOString().slice(0, 19)}`);
    console.log(`[CLI] Rolling test period: ${trainEnd.toISOString().slice(0, 19)} to ${rangeEnd.toISOString().slice(0, 19)}`);
    const restClient = new CoinbaseCDPRest();
    const sync = new CoinbaseSync({ storage, restClient });
    const minutesPerCandle = granularityMinutes(granularity);
    const replayLimit = Math.ceil(((rangeEnd.getTime() - trainStart.getTime()) / 60000) / minutesPerCandle) + 1;
    const trainCandleCount = Math.ceil((lookback * 60) / minutesPerCandle);
    const { interpolateCandleGaps } = await import('./trader/cache-manager.ts');

    for (const symbol of symbols) {
      try {
        const replayCandles = await sync.fetchCandleWindow({
          symbol,
          granularity,
          limit: replayLimit,
          nowMs: rangeEnd.getTime(),
        });
        if (replayCandles.length > 0) {
          const sorted = [...replayCandles].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
          const { result } = interpolateCandleGaps(sorted, granularity);
          const ascending = [...result].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
          await storage.upsertCandles(ascending);
          console.log(`[CLI] ${symbol}: ${ascending.length} replay candles loaded`);
        }
      } catch (error) {
        console.error(`[CLI] ${symbol} replay fetch failed:`, (error as Error).message);
      }
    }

    console.log(`[CLI] Running walk-forward replay...`);
    const replay = await runRollingWalkForwardReplay({
      storage,
      symbols,
      granularity,
      start: trainStart.toISOString(),
      end: rangeEnd.toISOString(),
      lookbackHours: lookback,
      stepHours: step,
      initialCash: numberOption(values, 'initial-cash', 10_000),
      semivarianceWindow: Math.max(4, Math.min(120, trainCandleCount - 1)),
    });
    console.log(renderWalkForwardReport(replay));
  } else {
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
  }

  await storage.close();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
