import { config } from '../config.js';
import { SqliteDb } from './sqlite.js';
import { PostgresDb } from './postgres.js';
import type { Db } from './types.js';

export * from './types.js';

let instance: Db | null = null;

/**
 * Returns the process-wide database handle.
 *
 * The driver is chosen by DB_DRIVER:
 *   sqlite   → better-sqlite3 file (demo/dev/test)
 *   postgres → Supabase Postgres as the restricted portal_api role (production)
 */
export function getDb(): Db {
  if (instance) return instance;

  if (config.db.driver === 'postgres') {
    instance = new PostgresDb(config.db.pgUrl, config.db.pgPoolMax);
  } else {
    const sqlite = new SqliteDb(config.db.sqliteFile);
    sqlite.migrate();
    instance = sqlite;
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}

/** Test helper: a fresh, isolated in-memory database. */
export function createTestDb(): SqliteDb {
  const db = SqliteDb.createInMemory();
  db.migrate();
  return db;
}
