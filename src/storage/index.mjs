import { SQLiteStorage } from './sqlite-storage.mjs';
import { DuckDbStorage } from './duckdb-storage.mjs';

export async function createStorage({ kind, path }) {
  if (kind === 'sqlite') return new SQLiteStorage({ path });
  if (kind === 'duckdb') return new DuckDbStorage({ path });
  throw new Error(`Unsupported storage backend: ${kind}`);
}