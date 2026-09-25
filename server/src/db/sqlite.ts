import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  Db, Param, Queryable, RequestContext, Row, RunResult, Scope,
} from './types.js';
import { SQLITE_SCHEMA } from './schema.sqlite.js';
import { FIRM_RBAC_SCHEMA, FISCAL_TRUST_BILLING_SCHEMA,
  CLIENT_DUE_DILIGENCE_SCHEMA, JUDGMENTS_SERVICE_SCHEMA,
} from './schema.firm.sqlite.js';

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
    /*
      0034-0036 · the fiscal document, client money and the billing basis. A third
      literal rather than more lines in the second, because the second is the RBAC
      mirror and this is a different phase of the schema; keeping them separate makes
      it obvious which migration a table came from when one of them fails to apply.
      It must run AFTER FIRM_RBAC_SCHEMA: `time_entries` references `staff`, and
      `expenses` references `documents`.
    */
    this.db.exec(FISCAL_TRUST_BILLING_SCHEMA);
    /*
      P0.3 · client due diligence and the AML gates. A fourth literal, and it must run
      after the third: `beneficial_owners` and `screening_runs` reference
      `client_due_diligence`, and the screening gate on `matters` reads all three.
    */
    this.db.exec(CLIENT_DUE_DILIGENCE_SCHEMA);
    /*
      COLUMNS FIRST, THEN THE WIDENED RULE, THEN THE PHASE THAT NEEDS BOTH.

      `ensureColumns` used to run last. It now runs before the fifth literal because that
      literal's triggers read `deadlines.rule_cited` — SQLite validates a trigger body against
      the columns that exist when it is created, so a trigger referring to a column added a
      line later does not exist. The order is the dependency, not a preference.
    */
    this.ensureColumns();
    /*
      THE `deadlines.kind` CHECK, WIDENED — a migration, in the method that exists for exactly
      this. The PORTAL literal creates the table with `kind in ('client_action','internal_task')`
      and SQLite cannot alter a CHECK constraint, so a fresh database gets the old rule from
      `create table if not exists` and every P0.4 deadline is refused by the demo engine while
      Postgres accepts it (0045 widened the same CHECK). That divergence is defect (o) — one
      rule, two dialects, and only one of them right — so it is closed here rather than by
      editing the portal literal, which several hundred portal tests were written against.
    */
    this.widenDeadlineKinds();
    /*
      P0.4 · judgments, service and the enforcement gate. A fifth literal, run last because
      `judgments` references `matters` and `documents` and the gate reads `deadlines`, which
      the PORTAL literal owns.
    */
    this.db.exec(JUDGMENTS_SERVICE_SCHEMA);
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
    // 0029 · the party link and the relationship end date, both on the PORTAL
    // schema's clients table — the conflict engine reads them, but the portal owns
    // the table, which is exactly the kind of split that gets missed.
    add('clients', 'party_id', 'text');
    // 0034 · the fiscal document. Added to an existing `invoices` table here rather
    // than only in the schema file, for the reason above: a database created before
    // this migration keeps its old column set unless the column is added explicitly.
    add('invoices', 'fiscal_device_id', 'text');
    add('invoices', 'invoice_uuid', 'text');
    add('invoices', 'invoice_type', 'text');
    add('invoices', 'icv', 'integer');
    add('invoices', 'previous_invoice_hash', 'text');
    add('invoices', 'invoice_hash', 'text');
    add('invoices', 'qr_payload', 'text');
    add('invoices', 'xml_storage_key', 'text');
    add('invoices', 'supply_at', 'text');
    add('invoices', 'buyer_vat_number', 'text');
    add('invoices', 'buyer_name', 'text');
    add('invoices', 'buyer_address', 'text');
    add('invoices', 'buyer_address_ar', 'text');
    add('invoices', 'fiscal_status', 'text');
    add('invoices', 'fiscal_status_at', 'text');
    add('invoice_lines', 'vat_category', "text not null default 'standard'");
    add('invoice_lines', 'vat_rate', 'real not null default 0.15');
    add('invoice_lines', 'vat_amount', 'real not null default 0');
    add('invoice_lines', 'discount_amount', 'real not null default 0');
    add('clients', 'relationship_ended_on', 'text');
    /*
      0045 · THE PROCEDURAL DEADLINE. `deadlines` is created by the PORTAL literal, so a
      database made before this phase has none of these columns and — because SQLite skips
      a `create table if not exists` for a table that exists — would never get them. The
      failure would surface as "no such column: rule_cited" in the middle of recording a
      service, which is exactly the class of bug this method exists to prevent.
    */
    add('deadlines', 'rule_code', 'text');
    add('deadlines', 'rule_cited', 'text');
    add('deadlines', 'rule_days', 'integer');
    add('deadlines', 'trigger_event', 'text');
    add('deadlines', 'source_kind', 'text');
    add('deadlines', 'source_id', 'text');
    this.db.exec(
      `update roles set requires_practising_licence = 1
        where code in ('MANAGING_PARTNER','PARTNER','ASSOCIATE','LAWYER')`,
    );
  }

  /**
   * Widens `deadlines.kind` to the P0.4 vocabulary, rebuilding the table once.
   *
   * WHY A REBUILD. SQLite has no `alter table ... drop constraint`, and a CHECK constraint is
   * compiled into the table definition — so the only way to widen it is to create the table
   * again with the new rule, move the rows, and rename. This is the documented SQLite
   * procedure and it is why the method is a migration rather than a line in a schema file:
   *
   *   · it runs ONLY when the old constraint is still in force, read from `sqlite_master`,
   *     so a database created after this phase is never touched;
   *   · it runs in a TRANSACTION, so a failure leaves the old table and the old rule;
   *   · it recreates the index and the portal's own lane guards, which dropping the table
   *     takes with it — a rebuild that silently removed the `internal_task` guard would make
   *     an internal deadline client-visible in the demo and nowhere else.
   *
   * The columns added by 0045 are part of the new definition. `ensureColumns` has already
   * added them to the old table, so the copy carries them across.
   */
  private widenDeadlineKinds(): void {
    const def = this.db.prepare(
      `select sql from sqlite_master where type = 'table' and name = 'deadlines'`,
    ).get() as { sql?: string } | undefined;
    if (!def?.sql || def.sql.includes("'appeal'")) return;

    this.db.exec(`
      begin;
      create table deadlines_widened (
        id text primary key,
        matter_id text not null references matters(id) on delete cascade,
        tenant_id text not null references tenants(id),
        client_id text not null references clients(id),
        kind text not null check (kind in ('client_action','internal_task','appeal',
                                           'cassation','reconsideration','limitation')),
        title text not null,
        title_ar text not null,
        description text,
        description_ar text,
        due_at text not null,
        priority text not null default 'normal',
        internal_status text not null default 'open',
        client_status text not null default 'open',
        /* THE FOREIGN KEY POSTGRES HAS AND THIS MIRROR DID NOT.
           deadlines.assigned_staff_id references staff in the deployed schema; the portal
           literal declares the column bare. The divergence survived three phases and cost a
           500 in P0.4: the route passed a MEMBERSHIP id into a STAFF column, PostgreSQL raised
           a foreign key violation, and the demo engine accepted the row without a word — so
           the suite was green and the deployment was broken. A mirror that does not enforce
           what the real schema enforces is a mirror that teaches the wrong lesson. */
        assigned_staff_id text references staff(id) on delete set null,
        internal_comment text,
        client_visible integer not null default 0,
        rule_code text,
        rule_cited text,
        rule_days integer,
        trigger_event text,
        source_kind text,
        source_id text,
        created_at text not null,
        updated_at text not null
      );
      insert into deadlines_widened
        (id, matter_id, tenant_id, client_id, kind, title, title_ar, description, description_ar,
         due_at, priority, internal_status, client_status, assigned_staff_id, internal_comment,
         client_visible, rule_code, rule_cited, rule_days, trigger_event, source_kind, source_id,
         created_at, updated_at)
      select id, matter_id, tenant_id, client_id, kind, title, title_ar, description, description_ar,
             due_at, priority, internal_status, client_status, assigned_staff_id, internal_comment,
             client_visible, rule_code, rule_cited, rule_days, trigger_event, source_kind, source_id,
             created_at, updated_at
        from deadlines;
      drop table deadlines;
      alter table deadlines_widened rename to deadlines;
      create index if not exists deadlines_client_idx on deadlines(client_id, due_at);
      create trigger if not exists deadline_lane_guard
        before insert on deadlines
        when new.kind = 'internal_task' and new.client_visible = 1
        begin select raise(ABORT, 'internal_task deadlines cannot be client_visible'); end;
      create trigger if not exists deadline_lane_guard_upd
        before update on deadlines
        when new.kind = 'internal_task' and new.client_visible = 1
        begin select raise(ABORT, 'internal_task deadlines cannot be client_visible'); end;
      commit;
    `);
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
