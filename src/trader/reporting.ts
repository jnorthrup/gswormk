import { round } from '../lib/math.ts';

type Align = 'l' | 'r' | 'c';
type TableRow = Array<string | number | boolean | null | undefined>;

type TableInput = {
  title: string;
  headers: string[];
  rows: TableRow[];
  align: Align[];
  termWidth: number;
};

type AssetRef = {
  symbol: string;
  assetName?: string | null;
  cmcMainPageUrl?: string | null;
  cmcRsiUrl?: string | null;
};

type AnyRecord = Record<string, any>;

export function renderSimulationReport(summary: AnyRecord): string {
  const lines: string[] = [];
  const assetMap = indexAssets(summary.spotMarketAssets ?? []);
  const termWidth = process.stdout.columns ?? 120;

  lines.push('══════════════════════════════════════════════════════════════════════════════════════════');
  lines.push('trader-console simulation report');
  lines.push('═══════════════════════════════════════════════════════════════════════════════════════════');

  // Portfolio summary - compact single line
  const p = summary.portfolio;
  lines.push(`NAV: $${round(p.nav, 2).toLocaleString()}  Cash: $${round(p.cash, 2).toLocaleString()}  Peak: $${round(p.peakNav, 2).toLocaleString()}  DD: ${round(p.drawdown * 100, 2)}%`);

  // Metrics
  const m = summary.metrics;
  const codec = m.codec;
  const codecStr = codec ? `  codec: guesses=${codec.guessCount} vPnL=$${round(codec.totalVirtualPnL, 2)} fills=${codec.filledLimitCount} expired=${codec.expiredLimitCount}` : '';
  lines.push(`orders: accepted=${m.ordersAccepted} rejected=${m.ordersRejected}  cacheHit=${round((m.cacheHitRatio ?? 0) * 100, 1)}% apiCalls=${m.apiCalls}${codecStr}`);

  // Positions table
  lines.push('');
  lines.push(renderTable({
    title: 'POSITIONS',
    headers: ['SYMBOL', 'ASSET', 'UNITS', 'PRICE', 'MKT VALUE', 'WEIGHT'],
    rows: (summary.positions ?? []).map((pos: AnyRecord) => {
      const asset = assetMap.get(pos.symbol);
      return [
        pos.symbol,
        asset?.assetName ?? '-',
        round(pos.units, 6).toLocaleString(),
        '$' + round(pos.price, 2).toLocaleString(),
        '$' + round(pos.marketValue, 2).toLocaleString(),
        round(pos.weight * 100, 2).toFixed(2) + '%',
      ];
    }),
    align: ['l', 'l', 'r', 'r', 'r', 'r'],
    termWidth,
  }));

  // Asset refs table
  if ((summary.spotMarketAssets ?? []).length > 0) {
    lines.push('');
    lines.push(renderTable({
      title: 'ASSET REFS',
      headers: ['SYMBOL', 'ASSET', 'REGIME CHART', 'RSI CHART'],
      rows: (summary.spotMarketAssets ?? []).map((asset: AssetRef) => [
        asset.symbol,
        asset.assetName ?? '-',
        truncate(asset.cmcMainPageUrl ?? '-', 40),
        truncate(asset.cmcRsiUrl ?? '-', 40),
      ]),
      align: ['l', 'l', 'l', 'l'],
      termWidth,
    }));
  }

  // Signals table
  lines.push('');
  lines.push(renderTable({
    title: 'LATEST SIGNALS',
    headers: ['SYMBOL', 'ASSET', 'REGIME', 'pAdv', 'RSI', 'OBI', 'INNOV_Z', 'TARGET', 'CURRENT', 'TRIGGER', 'RISK'],
    rows: (summary.latestSignals ?? []).map((signal: AnyRecord) => {
      const asset = assetMap.get(signal.symbol);
      return [
        signal.symbol,
        asset?.assetName ?? '-',
        signal.dominant_regime ?? '-',
        formatProbability(signal.advantage_probability),
        formatMaybe(signal.denoised_rsi, 2),
        round(signal.obi, 4).toFixed(4),
        round(signal.innovation_z, 4).toFixed(4),
        round(signal.target_weight, 4).toFixed(4),
        round(signal.current_weight, 4).toFixed(4),
        round(signal.trigger, 4).toFixed(4),
        signal.risk_state,
      ];
    }),
    align: ['l', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l'],
    termWidth,
  }));

  // Edge/archetype table for the latest signal rows. Kept separate so the core
  // signal table remains readable on normal terminal widths.
  lines.push('');
  lines.push('SIGNAL EDGE');
  lines.push(renderTable({
    title: 'SIGNAL EDGE',
    headers: ['SYMBOL', 'ARCHETYPE', 'GROSS_EDGE', 'COST', 'UNC', 'NET_EDGE'],
    rows: (summary.latestSignals ?? []).map((signal: AnyRecord) => [
      signal.symbol,
      signal.archetype ?? '-',
      formatBps(signal.gross_edge_bps),
      formatBps(signal.cost_bps),
      formatBps(signal.uncertainty_bps),
      formatBps(signal.net_edge_bps),
    ]),
    align: ['l', 'l', 'r', 'r', 'r', 'r'],
    termWidth,
  }));

  // Orders table
  lines.push('');
  lines.push('LATEST ORDERS');
  lines.push(renderTable({
    title: 'LATEST ORDERS',
    headers: ['SYMBOL', 'SIDE', 'QTY', 'PRICE', 'ARCHETYPE', 'GROSS_EDGE', 'COST', 'UNC', 'NET_EDGE'],
    rows: (summary.latestOrders ?? []).map((order: AnyRecord) => [
      order.symbol,
      order.side,
      formatMaybe(order.quantity, 6),
      '$' + formatBps(order.price),
      order.archetype ?? '-',
      formatBps(order.gross_edge_bps),
      formatBps(order.cost_bps),
      formatBps(order.uncertainty_bps),
      formatBps(order.net_edge_bps),
    ]),
    align: ['l', 'l', 'r', 'r', 'l', 'r', 'r', 'r', 'r'],
    termWidth,
  }));

  // Decisions table
  lines.push('');
  lines.push(renderTable({
    title: 'RECENT DECISIONS',
    headers: ['SYMBOL', 'TARGET', 'CURRENT', 'DEVIATION', 'TRADED', 'NOTIONAL', 'REASON'],
    rows: (summary.latestDecisions ?? []).map((decision: AnyRecord) => [
      decision.symbol,
      round(decision.target_weight, 4).toFixed(4),
      round(decision.current_weight, 4).toFixed(4),
      round(decision.deviation, 4).toFixed(4),
      decision.executed ? 'YES' : 'no',
      '$' + round(decision.notional_delta, 2).toLocaleString(),
      decision.reason,
    ]),
    align: ['l', 'r', 'r', 'r', 'l', 'r', 'l'],
    termWidth,
  }));

  return lines.join('\n');
}

export function renderStatusReport(snapshot: AnyRecord): string {
  const lines: string[] = [];
  lines.push('═══════════════════════════════════════════════════════════════════════════════════════════');
  lines.push('trader-console status');
  lines.push('═══════════════════════════════════════════════════════════════════════════════════════════');
  lines.push(`db=${snapshot.db.kind}:${snapshot.db.path}`);
  lines.push(`candles=${snapshot.counts.candleCount} signals=${snapshot.counts.signalCount} orders=${snapshot.counts.orderCount} decisions=${snapshot.counts.decisionCount} portfSnapshots=${snapshot.counts.portfolioSnapshotCount}`);
  lines.push(`latestNav=${round(snapshot.latestPortfolio?.nav ?? 0, 2).toLocaleString()} latestCash=${round(snapshot.latestPortfolio?.cash ?? 0, 2).toLocaleString()} latestDD=${round((snapshot.latestPortfolio?.drawdown ?? 0) * 100, 2)}%`);
  lines.push('');

  lines.push(renderSimulationReport({
    portfolio: {
      nav: snapshot.latestPortfolio?.nav ?? 0,
      cash: snapshot.latestPortfolio?.cash ?? 0,
      peakNav: snapshot.latestPortfolio?.peak_nav ?? 0,
      drawdown: snapshot.latestPortfolio?.drawdown ?? 0,
    },
    metrics: {
      ordersAccepted: snapshot.counts.orderCount ?? 0,
      ordersRejected: 0,
      cacheHitRatio: snapshot.latestQuotaSummary?.cacheHitRatio ?? 0,
      apiCalls: snapshot.latestQuotaSummary?.apiCalls ?? 0,
    },
    positions: (snapshot.latestPositions ?? []).map((position: AnyRecord) => ({
      symbol: position.symbol,
      units: position.units,
      price: position.price,
      marketValue: position.market_value,
      weight: position.weight,
    })),
    latestSignals: snapshot.latestSignals,
    latestOrders: snapshot.latestOrders,
    latestDecisions: snapshot.latestDecisions,
    spotMarketAssets: snapshot.spotMarketAssets ?? [],
  }));

  return lines.join('\n');
}

function renderTable({ title, headers, rows, align, termWidth }: TableInput): string {
  if (rows.length === 0) {
    return `┌${'─'.repeat(Math.min(termWidth - 2, 60))}┐\n│ ${title.padEnd(Math.min(termWidth - 4, 58))} │\n│ ${'(empty)'.padEnd(Math.min(termWidth - 4, 58))} │\n└${'─'.repeat(Math.min(termWidth - 2, 60))}┘`;
  }

  // Calculate column widths
  const colCount = headers.length;
  const minWidths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length)));
  const padding = 2; // space between columns
  const totalMinWidth = minWidths.reduce((a, b) => a + b, 0) + padding * (colCount - 1);
  const availableWidth = Math.min(termWidth - 4, 140); // leave margin for borders

  // Scale down if needed
  let widths = [...minWidths];
  if (totalMinWidth > availableWidth) {
    const scale = availableWidth / totalMinWidth;
    widths = minWidths.map((width) => Math.max(4, Math.floor(width * scale)));
  }

  // Truncate headers to widths
  const headerCells = headers.map((header, index) => alignCell(header, widths[index] ?? header.length, align[index] ?? 'l'));

  const headerLine = '│ ' + headerCells.join(' │ ') + ' │';
  const topBorder = '┌' + '─'.repeat(headerLine.length - 2) + '┐';
  const midBorder = '├' + '─'.repeat(headerLine.length - 2) + '┤';
  const bottomBorder = '└' + '─'.repeat(headerLine.length - 2) + '┘';

  const lines = [topBorder, headerLine, midBorder];

  for (const row of rows) {
    const cells = row.map((cell, index) => alignCell(truncate(String(cell ?? ''), widths[index] ?? 4), widths[index] ?? 4, align[index] ?? 'l'));
    lines.push('│ ' + cells.join(' │ ') + ' │');
  }

  lines.push(bottomBorder);
  return lines.join('\n');
}

function alignCell(text: string, width: number, alignment: Align): string {
  const truncated = truncate(text, width);
  if (alignment === 'r') return truncated.padStart(width, ' ');
  if (alignment === 'c') return truncated.padStart(Math.floor((width + truncated.length) / 2), ' ').padEnd(width, ' ');
  return truncated.padEnd(width, ' ');
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 3) return text.slice(0, maxLen);
  return text.slice(0, maxLen - 1) + '…';
}

function indexAssets(assets: AssetRef[]): Map<string, AssetRef> {
  return new Map(assets.map((asset) => [asset.symbol, asset]));
}

function formatMaybe(value: number, digits = 4): string | number {
  return Number.isFinite(value) ? round(value, digits) : '–';
}

function formatBps(value: number): string {
  return Number.isFinite(value) ? round(value, 2).toFixed(2) : '–';
}

function formatProbability(value: number): string {
  return Number.isFinite(value) ? round(value * 100, 1).toFixed(1) + '%' : '–';
}
