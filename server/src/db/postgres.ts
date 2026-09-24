import pg from 'pg';
import type {
  Db, Param, Queryable, RequestContext, Row, RunResult, Scope,
} from './types.js';
import {
  judgeRole, shouldRefuseToStart, EXPECTED_ROLE_HINT, type RoleFacts,
} from './role-guard.js';

const { Pool } = pg;

/**
 * PostgreSQL driver — the production path.
 *
 * Connection identity matters more than anything else in this file: the pool
 * connects AS `portal_api`, a role that
 *   (a) has NO SELECT grant on internal columns (matters.risk_rating,
 *       matters.internal_notes, invoices.notes_internal,
 *       deadlines.assigned_staff_id, deadlines.internal_comment,
 *       hearings.internal_status, messages.internal_note, ...),
 *   (b) has NO grant whatsoever on internal_notes,
 *   (c) has INSERT-only access to audit_events,
 *   (d) cannot INSERT into client_users, and
 *   (e) is a plain non-owner role, so RLS and the column grants apply to it.
 *
 *   NOTE ON (e): the isolation comes from the ROLE, not from FORCE ROW LEVEL
 *   SECURITY — this repository enables RLS on 64 tables and forces it on none.
 *   The distinction matters because RLS does not constrain a superuser, a role
 *   with BYPASSRLS, or the table owner. `assertSafeRole()` below refuses to start
 *   if any of those is what actually connected, rather than trusting that it did
 *   not happen.
 *
 * So even a repository bug that selects too much, or forgets a WHERE clause,
 * fails closed at the database. That is the §49 guarantee: the browser is not
 * trusted — and neither, as it turns out, is the application.
 *
 * RLS context is injected per request with set_config() on a connection that is
 * dedicated to that request, then wiped with RESET ALL before the connection
 * returns to the pool. A pooled connection can never carry one caller's
 * identity into another's request.
 */
export class PostgresDb implements Db {
  readonly driver = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string, max = 10) {
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is required for the postgres driver. It must be the ' +
          'Supabase Postgres connection string for the portal_api role, e.g. ' +
          'postgres://portal_api:***@db.<ref>.supabase.co:5432/postgres',
      );
    }
    this.pool = new Pool({
      connectionString,
      max,
      connectionTimeoutMillis: 8_000,
      idleTimeoutMillis: 60_000,
      allowExitOnIdle: false,
      ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: true },
    });
    this.pool.on('error', (err) => {
      console.error('[db] idle client error', err.message);
    });
  }

  /**
   * Refuses to run when the connection can bypass Row Level Security.
   *
   * Called during boot, before the first request is served, so a dangerous
   * connection is a startup failure rather than a silent loss of the database
   * boundary. See role-guard.ts for why each condition matters.
   */
  async assertSafeRole(): Promise<void> {
    const res = await this.pool.query<{
      rolname: string; rolsuper: boolean; rolbypassrls: boolean; owned_tables: string;
    }>(
      `select current_user as rolname,
              r.rolsuper,
              r.rolbypassrls,
              (select count(*)
                 from pg_class c
                 join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public'
                  and c.relkind = 'r'
                  and pg_get_userbyid(c.relowner) = current_user)::text as owned_tables
         from pg_roles r
        where r.rolname = current_user`,
    );

    const row = res.rows[0];
    if (!row) {
      // Cannot establish the identity of the connection => cannot clear it.
      throw new Error(
        'FATAL: could not determine the database role identity. Refusing to start ' +
          'without confirming that Row Level Security applies.',
      );
    }

    const facts: RoleFacts = {
      roleName: row.rolname,
      isSuperuser: row.rolsuper,
      bypassesRls: row.rolbypassrls,
      ownedTables: Number.parseInt(row.owned_tables, 10) || 0,
    };

    const verdict = judgeRole(facts);
    if (shouldRefuseToStart(verdict)) {
      throw new Error(
        `FATAL: refusing to start — ${verdict.detail}\n        ${EXPECTED_ROLE_HINT}`,
      );
    }

    console.log(`  db role    ${verdict.detail}`);
  }

  /** Rewrites `?` placeholders to $1..$n, ignoring quoted literals. */
  private static toPg(sql: string): string {
    let i = 0;
    let out = '';
    let inSingle = false;
    let inDouble = false;
    for (let c = 0; c < sql.length; c++) {
      const ch = sql[c];
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      out += ch === '?' && !inSingle && !inDouble ? `$${++i}` : ch;
    }
    return out;
  }

  private static coerce(params: Param[] = []): unknown[] {
    return params.map((p) => {
      if (p === undefined) return null;
      if (p instanceof Date) return p.toISOString();
      return p;
    });
  }

  private static mapRow<T>(row: Row): T {
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = v instanceof Date ? v.toISOString() : v;
    }
    return out as T;
  }

  async all<T = Row>(sql: string, params: Param[] = []): Promise<T[]> {
    const res = await this.pool.query(PostgresDb.toPg(sql), PostgresDb.coerce(params));
    return res.rows.map((r) => PostgresDb.mapRow<T>(r as Row));
  }

  async get<T = Row>(sql: string, params: Param[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: Param[] = []): Promise<RunResult> {
    const res = await this.pool.query(PostgresDb.toPg(sql), PostgresDb.coerce(params));
    return { changes: res.rowCount ?? 0 };
  }

  async acquire(): Promise<Scope> {
    const client = await this.pool.connect();
    let txDepth = 0;
    let ended = false;

    const q: Queryable = {
      all: async <T = Row>(sql: string, params: Param[] = []) => {
        const res = await client.query(PostgresDb.toPg(sql), PostgresDb.coerce(params));
        return res.rows.map((r) => PostgresDb.mapRow<T>(r as Row));
      },
      get: async <T = Row>(sql: string, params: Param[] = []) => {
        const res = await client.query(PostgresDb.toPg(sql), PostgresDb.coerce(params));
        return res.rows.length ? PostgresDb.mapRow<T>(res.rows[0] as Row) : undefined;
      },
      run: async (sql: string, params: Param[] = []) => {
        const res = await client.query(PostgresDb.toPg(sql), PostgresDb.coerce(params));
        return { changes: res.rowCount ?? 0 };
      },
    };

    const scope: Scope = {
      q,

      async setContext(ctx: RequestContext) {
        // set_config with is_local=false scopes to this dedicated connection.
        // The values are bound as parameters, never interpolated.
        await client.query("select set_config('kgm.phase', $1, false)", [ctx.phase]);
        await client.query("select set_config('kgm.tenant_id', $1, false)", [ctx.tenantId ?? '']);
        await client.query("select set_config('kgm.user_id', $1, false)", [ctx.userId ?? '']);
        await client.query("select set_config('kgm.client_ids', $1, false)", [ctx.clientIds.join(',')]);
        // Firm OS scope (migration 0006). Empty string for a client request,
        // which makes kgm_membership() return null and closes every firm_*
        // table by RLS.
        await client.query("select set_config('kgm.membership_id', $1, false)", [ctx.membershipId ?? '']);
      },

      async tx<T>(fn: () => Promise<T>): Promise<T> {
        if (txDepth === 0) {
          await client.query('BEGIN');
          txDepth = 1;
          try {
            const result = await fn();
            await client.query('COMMIT');
            return result;
          } catch (err) {
            try {
              await client.query('ROLLBACK');
            } catch {
              /* connection already broken */
            }
            throw err;
          } finally {
            txDepth = 0;
          }
        }
        const sp = `sp_${txDepth}_${Date.now().toString(36)}`;
        txDepth++;
        await client.query(`SAVEPOINT ${sp}`);
        try {
          const result = await fn();
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          return result;
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          throw err;
        } finally {
          txDepth--;
        }
      },

      async end() {
        if (ended) return;
        ended = true;
        try {
          if (txDepth > 0) await client.query('ROLLBACK');
          // Wipe every GUC so the connection cannot leak identity back to the
          // pool. DISCARD ALL also resets prepared statements and search_path.
          await client.query('RESET ALL');
        } catch {
          /* the client is broken; release() will destroy it */
        } finally {
          client.release();
        }
      },
    };

    return scope;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
