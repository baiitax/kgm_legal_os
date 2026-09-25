import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  Db, Param, Queryable, RequestContext, Row, RunResult, Scope,
} from './types.js';
import { SQLITE_SCHEMA } from './schema.sqlite.js';
import { FIRM_RBAC_SCHEMA } from './schema.firm.sqlite.js';

/**
 * SQLite driver (demo / development / test).
 *
 * better-sqlite3 is synchronous; we expose the async Queryable interface so the
 * repository is driver-agnostic. Parameters are coerced: JS booleans become
 * 0/1 because better-sqlite3 rejects boolean binds.
 *
 * SQLite has no Row Level Security and no roles, so the auth/portal phase
 * distinction is inert here. The application-layer authorization in
 * server/src/domain is the enforcement point for the demo — and that is exactly
 * the layer tests/security exercises. Production gets RLS and column grants as
 * a second, independent line of defence.
 */
/**
 * better-sqlite3 is a *native* module, so it is loaded lazily, on first use.
 * Two reasons:
 *
 *   1. A Postgres deployment must not need a native SQLite binding to boot.
 *      Serverless bundlers trace static imports, which would put the .node
 *      binary on the critical path of every production request.
 *   2. Native addons are built by postinstall scripts, and some CI and
 *      serverless installers sandbox those scripts. Deferring the failure to
 *      the moment the SQLite driver is actually selected keeps it off the
 *      Postgres path entirely.
 */
let driver: typeof BetterSqlite3 | null = null;

function loadDriver(): typeof BetterSqlite3 {
  if (!driver) {
    // createRequire from the process working directory resolves the ordinary
    // node_modules layout and, unlike import.meta.url, survives bundling.
    const req = createRequire(path.join(process.cwd(), 'index.js'));
    driver = req('better-sqlite3') as typeof BetterSqlite3;
  }
  return driver;
}

export class SqliteDb implements Db {
  readonly driver = 'sqlite' as const;
  private readonly db: BetterSqlite3.Database;

  constructor(file: string) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }
    this.db = new (loadDriver())(file);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
  }

  static createInMemory(): SqliteDb {
    return new SqliteDb(':memory:');
  }

  migrate(): void {
    // Portal schema first: the Firm OS tables reference matters/staff/users, so
    // order matters. Applying them separately keeps the portal schema file
    // byte-identical to the version its 185 tests were written against.
    this.db.exec(SQLITE_SCHEMA);
    this.db.exec(FIRM_RBAC_SCHEMA);
    this.ensureColumns();
  }

  /**
   * Columns added to an EXISTING table after it shipped.
   *
   * SQLite has no `alter table ... add column if not exists`, and both schema
   * files are written with `create table if not exists` — so a new column in a
   * `create table` statement is applied to a fresh database and silently skipped
   * by one that already has the table. A developer with a working `data/`
   * directory would get a schema one column behind the code with no error saying
   * so, and the failure would surface as an opaque "no such column" hours later.
   *
   * So each such column is declared twice, deliberately: once in the schema file
   * as the definition, and once here as the migration. Postgres has the same
   * problem solved properly by `add column if not exists` in a numbered migration;
   * this is the equivalent for the demo driver, and it is the ONLY reason this
   * method exists.
   */
  private ensureColumns(): void {
    const add = (table: string, column: string, definition: string) => {
      const cols = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`alter table ${table} add column ${column} ${definition}`);
      }
    };

    // 0027 · the eligibility layer. Roles declare whether holding them means
    // practising law, so the licence requirement is data rather than a hardcoded
    // list of role codes in a function.
    add('roles', 'requires_practising_licence', 'integer not null default 0');
    this.db.exec(
      `update roles set requires_practising_licence = 1
        where code in ('MANAGING_PARTNER','PARTNER','ASSOCIATE','LAWYER')`,
    );
  }

  private coerce(params: Param[] = []): (string | number | null | Buffer)[] {
    return params.map((p) => {
      if (p === undefined || p === null) return null;
      if (typeof p === 'boolean') return p ? 1 : 0;
      if (p instanceof Date) return p.toISOString();
      return p as string | number | Buffer;
    });
  }

  async all<T = Row>(sql: string, params: Param[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...this.coerce(params)) as T[];
  }

  async get<T = Row>(sql: string, params: Param[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...this.coerce(params)) as T | undefined;
  }

  async run(sql: string, params: Param[] = []): Promise<RunResult> {
    const info = this.db.prepare(sql).run(...this.coerce(params));
    return { changes: Number(info.changes) };
  }

  async acquire(): Promise<Scope> {
    let depth = 0;
    const q: Queryable = {
      all: <T = Row>(sql: string, params: Param[] = []) => this.all<T>(sql, params),
      get: <T = Row>(sql: string, params: Param[] = []) => this.get<T>(sql, params),
      run: (sql: string, params: Param[] = []) => this.run(sql, params),
    };
    return {
      q,
      setContext: async (_ctx: RequestContext) => {
        /* no RLS in SQLite; authorization is enforced in the domain layer */
      },
      tx: async <T>(fn: () => Promise<T>): Promise<T> => {
        if (depth > 0) {
          depth++;
          try {
            return await fn();
          } finally {
            depth--;
          }
        }
        // Deferred: a read-only request never takes the write lock, so
        // concurrent reads are not serialized. Writes upgrade automatically.
        this.db.exec('BEGIN');
        depth = 1;
        try {
          const result = await fn();
          this.db.exec('COMMIT');
          return result;
        } catch (err) {
          try {
            this.db.exec('ROLLBACK');
          } catch {
            /* already unwound */
          }
          throw err;
        } finally {
          depth = 0;
        }
      },
      end: async () => {
        /* nothing to release: the connection is process-wide */
      },
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
