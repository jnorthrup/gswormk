import { migrations, schema } from './schema.ts';
import { validateCandle, validateCandleSequence, computeStaleness, stalenessToCacheQuality } from '../trader/signals.ts';

export class DuckDbStorage {
  path: string;
  db: any | null;
  connection: any | null;

  constructor({ path }: { path: string }) {
    this.path = path;
    this.db = null;
    this.connection = null;
  }

  async init(): Promise<void> {
    let duckdb: any;
    try {
      const packageName = 'duckdb';
      const mod = await import(packageName);
      duckdb = mod.default ?? mod;
    } catch {
      throw new Error('DuckDB backend requested but the "duckdb" package is not installed. Run: npm install duckdb');
    }

    this.db = new duckdb.Database(this.path);
    this.connection = this.db.connect();
    await this.exec(schema.candles);
    await this.exec(schema.signals);
    await this.exec(schema.orders);
    await this.exec(schema.quotaMetrics);
    await this.exec(schema.decisions);
    await this.exec(schema.portfolioSnapshots);
    await this.exec(schema.positions);
    await this.exec(schema.spotMarketStats);
    await this.exec(schema.spotMarketAssets);
    await this.exec(schema.backtestRuns);
    for (const statement of migrations.signalColumns) {
      try {
        await this.exec(statement);
      } catch (error) {
        const message = String((error as Error).message ?? error).toLowerCase();
        if (!message.includes('column with name') && !message.includes('duplicate')) {
          throw error;
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.connection) {
      await new Promise<void>((resolve, reject) => this.connection.close((error: unknown) => (error ? reject(error) : resolve())));
    }
  }

  // Parameterized wrappers - DuckDB supports positional ? placeholders
  async exec(sql: string, ...params: unknown[]): Promise<void> {
    await new Promise<void>((resolve, reject) => this.connection.run(sql, ...params, (error: unknown) => (error ? reject(error) : resolve())));
  }

  async all<T = any>(sql: string, ...params: unknown[]): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => this.connection.all(sql, ...params, (error: unknown, rows: T[]) => (error ? reject(error) : resolve(rows))));
  }
  async upsertCandles(candles: any[]): Promise<void> {
    // L5: Validate each candle before upsert
    for (const candle of candles) {
      const validation = validateCandle(candle as any);
      if (!validation.valid) {
        throw new Error(`Invalid candle for ${candle.symbol}@${candle.start}: ${validation.errors.join(', ')}`);
      }
    }

    // L5: Validate sequence monotonicity
    const seqValidation = validateCandleSequence(candles as any, candles[0]?.symbol ?? 'unknown', candles[0]?.granularity ?? '1m');
    if (!seqValidation.valid) {
      throw new Error(`Invalid candle sequence: ${seqValidation.errors.join(', ')}`);
    }

    for (const candle of candles) {
      await this.exec(
        `DELETE FROM candles WHERE symbol=? AND granularity=? AND start=?`,
        candle.symbol, candle.granularity, candle.start,
      );
      await this.exec(
        `INSERT INTO candles (symbol, granularity, start, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        candle.symbol, candle.granularity, candle.start, candle.open, candle.high, candle.low, candle.close, candle.volume,
      );
    }
  }

  async getRecentCandles({ symbol, limit, granularity }: { symbol: string; limit: number; granularity?: string }): Promise<any[]> {
    if (granularity) {
      return this.all(`SELECT * FROM candles WHERE symbol=? AND granularity=? ORDER BY start DESC LIMIT ?`, symbol, granularity, Number(limit));
    }
    return this.all(`SELECT * FROM candles WHERE symbol=? ORDER BY start DESC LIMIT ?`, symbol, Number(limit));
  }

  async getCandlesInRange({ symbol, start, end, granularity }: { symbol: string; start: string; end: string; granularity?: string }): Promise<any[]> {
    if (granularity) {
      return this.all(`SELECT * FROM candles WHERE symbol=? AND granularity=? AND start >= ? AND start < ? ORDER BY start ASC`, symbol, granularity, start, end);
    }
    return this.all(`SELECT * FROM candles WHERE symbol=? AND start >= ? AND start < ? ORDER BY start ASC`, symbol, start, end);
  }

  async insertSignal(signal: any): Promise<void> {
    await this.exec(
      `INSERT INTO signals (
        timestamp, symbol, mid, spread, effective_cost, obi, innovation_z, rv_down,
        tail_dependence, alignment, cache_quality, effective_drift, target_weight,
        current_weight, trigger, drawdown, quota_hit, regime_momentum,
        regime_mean_reversion, regime_volatility, timescale_support_count,
        timescale_window_center, timescale_attention, timescale_time_dilation,
        denoised_rsi, rsi_innovation_z, confidence_scalers, advantage_probability,
        risk_state, dominant_regime
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      signal.timestamp, signal.symbol, signal.mid, signal.spread, signal.effectiveCost, signal.obi,
      signal.innovationZ, signal.rvDown, signal.tailDependence, signal.alignment, signal.cacheQuality,
      signal.effectiveDrift, signal.targetWeight, signal.currentWeight, signal.trigger, signal.drawdown, signal.quotaHit,
      signal.regimeMomentum, signal.regimeMeanReversion, signal.regimeVolatility, signal.timescaleSupportCount ?? 0,
      signal.timescaleWindowCenter ?? 1, signal.timescaleAttention ?? 1, signal.timescaleTimeDilation ?? 1,
      signal.denoisedRsi !== null && signal.denoisedRsi !== undefined ? signal.denoisedRsi : null,
      signal.rsiInnovationZ ?? 0, signal.confidenceScalers ?? 1, signal.advantageProbability ?? 0.5,
      signal.riskState, signal.dominantRegime || 'meanReversion',
    );
  }

  async insertOrder(order: any): Promise<void> {
    await this.exec(
      `INSERT INTO orders (timestamp, symbol, side, quantity, price, gross, remaining_cash, remaining_units, gross_edge_bps, cost_bps, uncertainty_bps, net_edge_bps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      order.timestamp, order.symbol, order.side, order.quantity, order.price, order.gross, order.remainingCash, order.remainingUnits,
      order.grossEdgeBps ?? null, order.costBps ?? null, order.uncertaintyBps ?? null, order.netEdgeBps ?? null,
    );
  }

  async insertQuotaMetric(metric: any): Promise<void> {
    await this.exec(
      `INSERT INTO quota_metrics (timestamp, symbol, cache_hits, api_calls, gap_count, cache_hit_ratio) VALUES (?, ?, ?, ?, ?, ?)`,
      metric.timestamp, metric.symbol, metric.cacheHits, metric.apiCalls, metric.gapCount, metric.cacheHitRatio,
    );
  }

  async insertDecision(decision: any): Promise<void> {
    await this.exec(
      `INSERT INTO decisions (timestamp, symbol, target_weight, current_weight, deviation, trigger, notional_delta, executed, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      decision.timestamp, decision.symbol, decision.targetWeight, decision.currentWeight, decision.deviation, decision.trigger, decision.notionalDelta, decision.executed ? 1 : 0, decision.reason,
    );
  }

  async insertPortfolioSnapshot(snapshot: any): Promise<void> {
    await this.exec(
      `INSERT INTO portfolio_snapshots (timestamp, nav, cash, peak_nav, drawdown) VALUES (?, ?, ?, ?, ?)`,
      snapshot.timestamp, snapshot.nav, snapshot.cash, snapshot.peakNav, snapshot.drawdown,
    );
    await this.exec(`DELETE FROM positions WHERE timestamp=?`, snapshot.timestamp);
    for (const position of snapshot.positions) {
      await this.exec(
        `INSERT INTO positions (timestamp, symbol, units, price, market_value, weight) VALUES (?, ?, ?, ?, ?, ?)`,
        snapshot.timestamp, position.symbol, position.units, position.price, position.marketValue, position.weight,
      );
    }
  }

  async getRecentSignals({ limit }: { limit: number }): Promise<any[]> {
    return this.all(`SELECT * FROM signals ORDER BY id DESC LIMIT ?`, Number(limit));
  }

  async getRecentOrders({ limit }: { limit: number }): Promise<any[]> {
    return this.all(`SELECT * FROM orders ORDER BY id DESC LIMIT ?`, Number(limit));
  }

  async getRecentDecisions({ limit }: { limit: number }): Promise<any[]> {
    return this.all(`SELECT * FROM decisions ORDER BY id DESC LIMIT ?`, Number(limit));
  }

  async getLatestPortfolioSnapshot(): Promise<any | null> {
    return (await this.all('SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT 1'))[0] ?? null;
  }

  async getLatestPositions(): Promise<any[]> {
    const latest = await this.getLatestPortfolioSnapshot();
    if (!latest) return [];
    return this.all(`SELECT * FROM positions WHERE timestamp=? ORDER BY market_value DESC`, latest.timestamp);
  }

  async getLatestQuotaSummary(): Promise<any | null> {
    return (await this.all(`
      SELECT
        MAX(cache_hits) AS cacheHits,
        MAX(api_calls) AS apiCalls,
        MAX(gap_count) AS gapCount,
        MAX(cache_hit_ratio) AS cacheHitRatio
      FROM quota_metrics
    `))[0] ?? null;
  }

  async getStatusSnapshot(): Promise<any> {
    const candleCount = (await this.all<{ count: number }>('SELECT COUNT(*) AS count FROM candles'))[0]?.count ?? 0;
    const signalCount = (await this.all<{ count: number }>('SELECT COUNT(*) AS count FROM signals'))[0]?.count ?? 0;
    const orderCount = (await this.all<{ count: number }>('SELECT COUNT(*) AS count FROM orders'))[0]?.count ?? 0;
    const decisionCount = (await this.all<{ count: number }>('SELECT COUNT(*) AS count FROM decisions'))[0]?.count ?? 0;
    const portfolioSnapshotCount = (await this.all<{ count: number }>('SELECT COUNT(*) AS count FROM portfolio_snapshots'))[0]?.count ?? 0;
    const latestSignals = await this.getRecentSignals({ limit: 5 });
    const latestPositions = await this.getLatestPositions();
    const latestSymbols = [...new Set([
      ...latestSignals.map((signal) => signal.symbol),
      ...latestPositions.map((position) => position.symbol),
    ])];
    return {
      db: { kind: 'duckdb', path: this.path },
      counts: { candleCount, signalCount, orderCount, decisionCount, portfolioSnapshotCount },
      latestSignals,
      latestOrders: await this.getRecentOrders({ limit: 5 }),
      latestDecisions: await this.getRecentDecisions({ limit: 5 }),
      latestQuota: await this.all('SELECT * FROM quota_metrics ORDER BY id DESC LIMIT 5'),
      latestPortfolio: await this.getLatestPortfolioSnapshot(),
      latestPositions,
      latestQuotaSummary: await this.getLatestQuotaSummary(),
      spotMarketAssets: await this.getSpotMarketAssets({ symbols: latestSymbols }),
    };
  }

  async upsertSpotMarketStats(stat: any): Promise<void> {
    await this.exec(`DELETE FROM spot_market_stats WHERE symbol=?`, stat.symbol);
    await this.exec(
      `INSERT INTO spot_market_stats (symbol, price, change_24h, rsi_1d, rsi_1h, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      stat.symbol, stat.price, stat.change24h,
      stat.rsi1d !== null ? stat.rsi1d : null,
      stat.rsi1h !== null ? stat.rsi1h : null,
      stat.updatedAt,
    );
  }

  async upsertSpotMarketAsset(asset: any): Promise<void> {
    const existing = await this.getSpotMarketAsset({ symbol: asset?.symbol });

    // Preserve CMC data from existing record when incoming (Coinbase) doesn't have it
    const merged = {
      symbol: asset?.symbol ?? existing?.symbol ?? '',
      baseSymbol: asset?.baseSymbol ?? existing?.baseSymbol ?? asset?.base_symbol ?? existing?.base_symbol ?? '',
      quoteSymbol: asset?.quoteSymbol ?? existing?.quoteSymbol ?? asset?.quote_symbol ?? existing?.quote_symbol ?? '',
      assetName: existing?.assetName ?? asset?.assetName ?? asset?.asset_name ?? existing?.asset_name ?? null,
      baseName: existing?.baseName ?? asset?.baseName ?? asset?.base_name ?? existing?.base_name ?? null,
      quoteName: existing?.quoteName ?? asset?.quoteName ?? asset?.quote_name ?? existing?.quote_name ?? null,
      displayName: existing?.displayName ?? asset?.displayName ?? asset?.display_name ?? existing?.display_name ?? null,
      cmcAssetId: existing?.cmcAssetId ?? asset?.cmcAssetId ?? asset?.cmc_asset_id ?? existing?.cmc_asset_id ?? null,
      cmcSymbol: existing?.cmcSymbol ?? asset?.cmcSymbol ?? asset?.cmc_symbol ?? existing?.cmc_symbol ?? null,
      cmcName: existing?.cmcName ?? asset?.cmcName ?? asset?.cmc_name ?? existing?.cmc_name ?? null,
      cmcSlug: existing?.cmcSlug ?? asset?.cmcSlug ?? asset?.cmc_slug ?? existing?.cmc_slug ?? null,
      cmcRsiUrl: existing?.cmcRsiUrl ?? asset?.cmcRsiUrl ?? asset?.cmc_rsi_url ?? existing?.cmc_rsi_url ?? null,
      cmcMainPageUrl: existing?.cmcMainPageUrl ?? asset?.cmcMainPageUrl ?? asset?.cmc_main_page_url ?? existing?.cmc_main_page_url ?? null,
      updatedAt: asset?.updatedAt ?? existing?.updatedAt ?? new Date().toISOString(),
    };

    if (!merged.symbol) {
      throw new Error('spot market asset requires symbol');
    }
    if (!merged.baseSymbol || !merged.quoteSymbol) {
      throw new Error(`spot market asset requires base/quote symbols for ${merged.symbol}`);
    }

    await this.exec(`DELETE FROM spot_market_assets WHERE symbol=?`, merged.symbol);
    await this.exec(
      `INSERT INTO spot_market_assets (
        symbol, base_symbol, quote_symbol, asset_name, base_name, quote_name,
        display_name, cmc_asset_id, cmc_symbol, cmc_name, cmc_slug, cmc_rsi_url,
        cmc_main_page_url, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      merged.symbol,
      merged.baseSymbol,
      merged.quoteSymbol,
      merged.assetName,
      merged.baseName,
      merged.quoteName,
      merged.displayName,
      merged.cmcAssetId,
      merged.cmcSymbol,
      merged.cmcName,
      merged.cmcSlug,
      merged.cmcRsiUrl,
      merged.cmcMainPageUrl,
      merged.updatedAt,
    );
  }

  async getRecentSpotMarketStats({ symbol, limit }: { symbol: string; limit: number }): Promise<any[]> {
    const rows = await this.all<any>(
      `SELECT symbol, price, change_24h, rsi_1d, rsi_1h, updated_at FROM spot_market_stats WHERE symbol=? ORDER BY updated_at DESC LIMIT ?`,
      symbol, Number(limit),
    );
    return rows.map((r) => ({
      symbol: r.symbol,
      price: r.price,
      change24h: r.change_24h,
      rsi1d: r.rsi_1d,
      rsi1h: r.rsi_1h,
      updatedAt: r.updated_at,
    }));
  }

  async getSpotMarketAsset({ symbol }: { symbol: string }): Promise<any | null> {
    const rows = await this.all<any>(
      `SELECT symbol, base_symbol, quote_symbol, asset_name, base_name, quote_name,
        display_name, cmc_asset_id, cmc_symbol, cmc_name, cmc_slug, cmc_rsi_url,
        cmc_main_page_url, updated_at
      FROM spot_market_assets WHERE symbol=? LIMIT 1`,
      symbol,
    );
    return rows[0] ? mapSpotMarketAssetRow(rows[0]) : null;
  }

  async getSpotMarketStats(): Promise<any[]> {
    return this.all('SELECT * FROM spot_market_stats ORDER BY symbol ASC');
  }

  async getSpotMarketAssets({ symbols = null }: { symbols?: string[] | null } = {}): Promise<any[]> {
    if (Array.isArray(symbols) && symbols.length > 0) {
      const placeholders = symbols.map(() => '?').join(', ');
      const rows = await this.all<any>(
        `SELECT symbol, base_symbol, quote_symbol, asset_name, base_name, quote_name,
          display_name, cmc_asset_id, cmc_symbol, cmc_name, cmc_slug, cmc_rsi_url,
          cmc_main_page_url, updated_at
        FROM spot_market_assets WHERE symbol IN (${placeholders}) ORDER BY symbol ASC`,
        ...symbols,
      );
      return rows.map(mapSpotMarketAssetRow);
    }
    return this.all('SELECT * FROM spot_market_assets ORDER BY symbol ASC');
  }

  // Backtest persistence
  async insertBacktestRun(run: any): Promise<void> {
    await this.exec(
      `INSERT INTO backtest_runs (timestamp, strategy_name, period_start, period_end, sharpe_ratio, calmar_ratio, max_drawdown, total_return, hit_rate, num_trades, params, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.timestamp, run.strategyName, run.periodStart, run.periodEnd, run.sharpeRatio, run.calmarRatio,
      run.maxDrawdown, run.totalReturn, run.hitRate, run.numTrades, JSON.stringify(run.params), run.createdAt,
    );
  }

  async getBacktestRuns({ strategyName = null, limit = 100 }: { strategyName?: string | null; limit?: number } = {}): Promise<any[]> {
    if (strategyName) {
      return this.all(
        `SELECT * FROM backtest_runs WHERE strategy_name=? ORDER BY timestamp DESC LIMIT ?`,
        strategyName, Number(limit),
      );
    }
    return this.all(`SELECT * FROM backtest_runs ORDER BY timestamp DESC LIMIT ?`, Number(limit));
  }
}

function mapSpotMarketAssetRow(row: any): any {
  return {
    symbol: row.symbol,
    baseSymbol: row.base_symbol,
    quoteSymbol: row.quote_symbol,
    assetName: row.asset_name,
    baseName: row.base_name,
    quoteName: row.quote_name,
    displayName: row.display_name,
    cmcAssetId: row.cmc_asset_id,
    cmcSymbol: row.cmc_symbol,
    cmcName: row.cmc_name,
    cmcSlug: row.cmc_slug,
    cmcRsiUrl: row.cmc_rsi_url,
    cmcMainPageUrl: row.cmc_main_page_url,
    updatedAt: row.updated_at,
  };
}

function mergeSpotMarketAsset(existing: any, incoming: any): any {
  const merged = {
    symbol: incoming.symbol ?? existing?.symbol,
    baseSymbol: incoming.baseSymbol ?? existing?.baseSymbol,
    quoteSymbol: incoming.quoteSymbol ?? existing?.quoteSymbol,
    assetName: incoming.assetName ?? existing?.assetName ?? incoming.baseName ?? existing?.baseName ?? incoming.cmcName ?? existing?.cmcName ?? null,
    baseName: incoming.baseName ?? existing?.baseName ?? null,
    quoteName: incoming.quoteName ?? existing?.quoteName ?? null,
    displayName: incoming.displayName ?? existing?.displayName ?? null,
    cmcAssetId: incoming.cmcAssetId ?? existing?.cmcAssetId ?? null,
    cmcSymbol: incoming.cmcSymbol ?? existing?.cmcSymbol ?? null,
    cmcName: incoming.cmcName ?? existing?.cmcName ?? null,
    cmcSlug: incoming.cmcSlug ?? existing?.cmcSlug ?? null,
    cmcRsiUrl: incoming.cmcRsiUrl ?? existing?.cmcRsiUrl ?? null,
    cmcMainPageUrl: incoming.cmcMainPageUrl ?? existing?.cmcMainPageUrl ?? null,
    updatedAt: incoming.updatedAt ?? existing?.updatedAt ?? new Date().toISOString(),
  };

  if (!merged.symbol) {
    throw new Error('spot market asset requires symbol');
  }
  if (!merged.baseSymbol || !merged.quoteSymbol) {
    throw new Error(`spot market asset requires base/quote symbols for ${merged.symbol}`);
  }

  return merged;
}

void mergeSpotMarketAsset;
