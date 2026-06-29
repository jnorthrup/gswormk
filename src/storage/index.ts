import { DuckDbStorage } from './duckdb-storage.ts';

export type StorageKind = 'duckdb';

export type CreateStorageOptions = {
  kind: StorageKind | string;
  path: string;
};

export async function createStorage({ kind, path }: CreateStorageOptions): Promise<any> {
  if (kind === 'duckdb') return new DuckDbStorage({ path });
  throw new Error(`Unsupported storage backend: ${kind}`);
}
