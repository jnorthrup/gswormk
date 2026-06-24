import { round } from '../lib/math.mjs';

export function renderSimulationReport(summary) {
  const lines = [];
  lines.push('=== trader-console simulation report ===');
  lines.push(`nav=${round(summary.portfolio.nav, 2)} cash=${round(summary.portfolio.cash, 2)} peakNav=${round(summary.portfolio.peakNav, 2)} drawdown=${round(summary.portfolio.drawdown * 100, 2)}%`);
  lines.push(`orders accepted=${summary.metrics.ordersAccepted} rejected=${summary.metrics.ordersRejected} cacheHitRatio=${round(summary.metrics.cacheHitRatio * 100, 2)}% apiCalls=${summary.metrics.apiCalls}`);
  lines.push('');
  lines.push('positions:');
  lines.push('symbol      units           price           marketValue     weight');
  for (const position of summary.positions) {
    lines.push(`${pad(position.symbol, 10)} ${pad(round(position.units, 6), 14)} ${pad(round(position.price, 2), 14)} ${pad(round(position.marketValue, 2), 14)} ${pad(`${round(position.weight * 100, 2)}%`, 8)}`);
  }
  if (summary.positions.length === 0) lines.push('(none)');
  lines.push('');
  lines.push('latest signals:');
  lines.push('symbol      obi        innovZ     rvDown     tailDep    align   cacheQ  target    current   trigger   risk');
  for (const signal of summary.latestSignals) {
    lines.push(`${pad(signal.symbol, 10)} ${pad(round(signal.obi, 4), 10)} ${pad(round(signal.innovation_z, 4), 10)} ${pad(round(signal.rv_down, 4), 10)} ${pad(round(signal.tail_dependence, 4), 10)} ${pad(round(signal.alignment, 4), 7)} ${pad(round(signal.cache_quality, 2), 7)} ${pad(round(signal.target_weight, 4), 9)} ${pad(round(signal.current_weight, 4), 9)} ${pad(round(signal.trigger, 4), 9)} ${signal.risk_state}`);
  }
  lines.push('');
  lines.push('recent decisions:');
  lines.push('symbol      target    current   deviation  traded   notional      reason');
  for (const decision of summary.latestDecisions) {
    lines.push(`${pad(decision.symbol, 10)} ${pad(round(decision.target_weight, 4), 9)} ${pad(round(decision.current_weight, 4), 9)} ${pad(round(decision.deviation, 4), 9)} ${pad(decision.executed ? 'yes' : 'no', 8)} ${pad(round(decision.notional_delta, 2), 13)} ${decision.reason}`);
  }
  return lines.join('\n');
}

export function renderStatusReport(snapshot) {
  const lines = [];
  lines.push('=== trader-console status ===');
  lines.push(`db=${snapshot.db.kind}:${snapshot.db.path}`);
  lines.push(`candles=${snapshot.counts.candleCount} signals=${snapshot.counts.signalCount} orders=${snapshot.counts.orderCount} decisions=${snapshot.counts.decisionCount} portfolioSnapshots=${snapshot.counts.portfolioSnapshotCount}`);
  lines.push(`latestNav=${round(snapshot.latestPortfolio?.nav ?? 0, 2)} latestCash=${round(snapshot.latestPortfolio?.cash ?? 0, 2)} latestDrawdown=${round((snapshot.latestPortfolio?.drawdown ?? 0) * 100, 2)}%`);
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
    positions: snapshot.latestPositions.map((position) => ({
      symbol: position.symbol,
      units: position.units,
      price: position.price,
      marketValue: position.market_value,
      weight: position.weight,
    })),
    latestSignals: snapshot.latestSignals,
    latestDecisions: snapshot.latestDecisions,
  }));
  return lines.join('\n');
}

function pad(value, length) {
  return String(value).padEnd(length, ' ');
}