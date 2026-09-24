import pg from 'pg';
import type {
  Db, Param, Queryable, RequestContext, Row, RunResult, Scope,
} from './types.js';

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
 *   (e) is subject to FORCED Row Level Security.
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
