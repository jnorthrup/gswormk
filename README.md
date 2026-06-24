# trader-console

Standalone Node.js console app that implements the quant trader architecture discussed earlier:

- microstructure-driven drift from order book imbalance
- Kalman innovation drift
- downside semivariance risk
- BTC tail-dependence discount
- cubic no-trade band from transaction friction vs downside variance
- draw-through candle cache
- model-alignment gating between live incremental state and cache replay state
- continuous regime vector: momentum, mean reversion, volatility
- portfolio optimizer across the full symbol set
- risk invariants, portfolio snapshots, decision log, position ledger
- paper broker execution
- pluggable storage backend: SQLite by default, DuckDB when installed

## Requirements

- Node.js 24+
- No package install required for SQLite mode
- Optional for DuckDB mode:

```bash
npm install duckdb
```

## Quick start

Run a deterministic simulation with SQLite:

```bash
node src/cli.mjs simulate --ticks 500 --db sqlite --db-path ./data/trader.sqlite
```

Inspect latest persisted state:

```bash
node src/cli.mjs status --db sqlite --db-path ./data/trader.sqlite
```

Run tests:

```bash
npm test
```

## DuckDB mode

DuckDB mode uses the same schema and storage adapter contract. Enable it only if the `duckdb` package is installed:

```bash
node src/cli.mjs simulate --db duckdb --db-path ./data/trader.duckdb
```

## What it does

The app simulates an event-time trading loop:

1. Generates market and book events for BTC-USD and ETH-USD
2. Updates canonical candle cache through a draw-through cache manager
3. Computes signal state
4. Builds regime vector and alignment/cache confidence
5. Optimizes portfolio weights jointly across symbols
6. Applies drawdown and concentration risk invariants
7. Routes paper orders through a simulated broker
8. Persists candles, signal snapshots, decisions, fills, position ledger, portfolio snapshots, and quota metrics

## Commands

### simulate

```bash
node src/cli.mjs simulate [options]
```

Options:

- `--ticks <n>`: number of replay events, default `300`
- `--db <sqlite|duckdb>`: storage backend, default `sqlite`
- `--db-path <path>`: database path, default `./data/trader.sqlite`
- `--symbols <csv>`: symbols, default `BTC-USD,ETH-USD`
- `--seed <n>`: deterministic RNG seed, default `42`
- `--initial-cash <n>`: default `100000`
- `--reinvest-pct <n>`: default `0.9`
- `--max-position-pct <n>`: default `0.45`
- `--max-drawdown-pct <n>`: default `0.15`

### status

```bash
node src/cli.mjs status [options]
```

Prints:

- current portfolio state
- recent signals
- recent orders
- quota efficacy metrics
