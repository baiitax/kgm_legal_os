import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type {
  Db, Param, Queryable, RequestContext, Row, RunResult, Scope,
} from './types.js';
import {
  judgeRole, judgeAssumedRoles, shouldRefuseToStart, EXPECTED_ROLE_HINT, FIRM_ROLE,
  type RoleFacts, type AssumedRoleFacts,
} from './role-guard.js';

/**
 * TLS, PINNED RATHER THAN DISABLED.
 *
 * Supabase signs its pooler with a private root — `*.pooler.supabase.com` <-
 * Supabase Intermediate 2021 CA <- Supabase Root 2021 CA — which is published but
 * absent from Node's bundled store (that store carries public roots only). So
 * `ssl: { rejectUnauthorized: true }` against a Supabase host fails the handshake
 * with SELF_SIGNED_CERT_IN_CHAIN, before any authentication happens.
 *
 * The common reaction is `rejectUnauthorized: false`, which is worse than it
 * looks: it stops verifying the certificate chain entirely, so the connection is
 * encrypted but anonymous, and any host presenting any certificate is accepted.
 * On a database holding privileged legal data that is a real exposure.
 *
 * Pinning the root keeps full verification. The certificate that ships here was
 * checked two ways before being trusted:
 *   - SHA-256 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:
 *     F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA, matching Supabase's published
 *     prod-ca-2021.crt and the copy the Supabase CLI embeds.
 *   - Byte-identical to the self-signed root the live session pooler presents in
 *     its own chain, so it is the certificate that actually signs these
 *     connections and not merely one that resembles it.
 *
 * Verification stays ON (`rejectUnauthorized: true`). If the CA file is missing
 * the process refuses to start rather than falling back to an unverified
 * connection — a missing file is a deployment error, and silently downgrading
 * transport security is the wrong way to report it.
 */
/**
 * Where the pinned root is looked for, when `PG_SSL_CA` names a path.
 *
 * Resolved from `process.cwd()` rather than from `import.meta.url`, because this
 * module is also bundled into a serverless function where `import.meta.url` does
 * not describe a real file location. The candidate list covers the two shapes the
 * repository is run in: the server package root (local, `npm start`) and the
 * repository root (a bundle, a container image, a function).
 */
function caPathCandidates(): string[] {
  const rel = ['server/certs/supabase-root-2021.crt', 'certs/supabase-root-2021.crt'];
  const roots = [process.cwd(), path.resolve(process.cwd(), '..'), path.resolve(process.cwd(), '..', '..')];
  const out: string[] = [];
  for (const r of roots) for (const f of rel) out.push(path.resolve(r, f));
  return out;
}

/**
 * Resolves the pinned CA from `PG_SSL_CA`, which may be EITHER a path to the
 * certificate OR its PEM contents.
 *
 * Accepting the PEM directly is what makes the pinned-CA approach usable on a
 * serverless host, where a `.crt` file sitting next to the source is not traced
 * into the function bundle and would be absent at runtime. Embedding the
 * certificate in an environment variable keeps verification ON — the alternative,
 * reached for too often, is `rejectUnauthorized: false`, which abandons
 * verification entirely.
 *
 * Detected by content, not by filename, so either form works under one name.
 */
function resolvePinnedCa(): string {
  const configured = process.env.PG_SSL_CA?.trim();
  if (configured && configured.includes('BEGIN CERTIFICATE')) return configured;

  const candidates = configured ? [configured, ...caPathCandidates()] : caPathCandidates();
  for (const candidate of candidates) {
    try {
      const text = fs.readFileSync(candidate, 'utf8');
      if (text.includes('BEGIN CERTIFICATE')) return text;
    } catch {
      /* try the next candidate */
    }
  }

  throw new Error(
    'FATAL: cannot find the pinned Supabase CA. Refusing to connect without ' +
      'certificate verification. Set PG_SSL_CA to the PEM contents of Supabase\'s ' +
      'root (or to a path containing it), or restore server/certs/supabase-root-2021.crt. ' +
      `Looked at: ${candidates.join(', ')}`,
  );
}

/** True for both `*.supabase.com` (pooler) and `*.supabase.co` (direct). */
function isSupabaseHost(connectionString: string): boolean {
  try {
    const h = new URL(connectionString).hostname;
    return h.endsWith('.supabase.com') || h.endsWith('.supabase.co') || h === 'supabase.com';
  } catch {
    return false;
  }
}

/**
 * Builds the pg SSL option for a connection string.
 *
 * `PG_SSL_CA` points at a different pinned root, for a self-hosted Postgres or a
 * Supabase project on a different CA. There is deliberately no
 * "disable verification" switch.
 */
function sslFor(connectionString: string): pg.PoolConfig['ssl'] {
  if (connectionString.includes('localhost') || connectionString.includes('127.0.0.1')) {
    return undefined;
  }
  if (!isSupabaseHost(connectionString)) {
    // A non-Supabase host: verify against Node's public roots.
    return { rejectUnauthorized: true };
  }

  return { rejectUnauthorized: true, ca: resolvePinnedCa() };
}

/**
 * Removes SSL parameters from a connection string.
 *
 * node-postgres parses the URL OVER the config object, so an `sslmode` in the
 * string silently replaces whatever `ssl` option the code passed. A Supabase
 * "copy connection string" includes `?sslmode=require`, which would therefore
 * discard the pinned CA and reintroduce SELF_SIGNED_CERT_IN_CHAIN — a failure
 * that looks like a certificate problem and is actually an option-precedence
 * problem. Stripping them makes the explicit option the one that applies.
 */
function withoutSslParams(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation']) {
      u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return connectionString;
  }
}

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
/**
 * `RoleFacts` with `assumedRoles` writable. The interface keeps it readonly so
 * callers cannot mutate the facts a verdict was derived from; the boot check
 * fills it in after the connection has already been judged.
 */
type MutableRoleFacts = Omit<RoleFacts, 'assumedRoles'> & { assumedRoles?: readonly AssumedRoleFacts[] };

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
      connectionString: withoutSslParams(connectionString),
      max,
      connectionTimeoutMillis: 8_000,
      idleTimeoutMillis: 60_000,
      allowExitOnIdle: false,
      ssl: sslFor(connectionString),
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

    const facts: MutableRoleFacts = {
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

    /*
      A clean `current_user` is not enough once requests can switch roles. The
      roles reachable by SET ROLE are enumerated and judged by the same rules —
      an unvetted `firm_api` would exempt the whole firm half of the product
      from RLS while the guard printed `ok` for the connection.
    */
    facts.assumedRoles = await this.setReachableRoles();

    const assumedVerdict = judgeAssumedRoles(facts);
    if (assumedVerdict && shouldRefuseToStart(assumedVerdict)) {
      throw new Error(
        `FATAL: refusing to start — ${assumedVerdict.detail}\n        ${EXPECTED_ROLE_HINT}`,
      );
    }

    console.log(`  db role    ${verdict.detail}`);
    const names = (facts.assumedRoles ?? []).map((r) => r.roleName).filter((n) => n !== facts.roleName);
    if (names.length) {
      console.log(`  db roles   may SET ROLE into ${names.map((n) => `"${n}"`).join(', ')} — checked, all safe`);
    }
  }

  /**
   * Every role this connection may `SET ROLE` into, with the same three flags the
   * connection itself is judged on.
   *
   * `pg_has_role(..., 'SET')` is the right predicate rather than membership:
   * membership can be granted WITH INHERIT FALSE, which is exactly the state
   * migration 0008 creates. Such a role grants no privileges until it is
   * explicitly assumed, so it is reachable — and therefore in scope here — even
   * though `has_table_privilege` reports nothing on the connection.
   */
  private async setReachableRoles(): Promise<AssumedRoleFacts[]> {
    const res = await this.pool.query<{
      rolname: string; rolsuper: boolean; rolbypassrls: boolean; owned_tables: string;
    }>(
      `select r.rolname,
              r.rolsuper,
              r.rolbypassrls,
              (select count(*)
                 from pg_class c
                 join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public'
                  and c.relkind = 'r'
                  and pg_get_userbyid(c.relowner) = r.rolname)::text as owned_tables
         from pg_roles r
        where pg_has_role(current_user, r.oid, 'SET')
        order by r.rolname`,
    );
    return res.rows.map((r) => ({
      roleName: r.rolname,
      isSuperuser: r.rolsuper,
      bypassesRls: r.rolbypassrls,
      ownedTables: Number.parseInt(r.owned_tables, 10) || 0,
    }));
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

        /*
          ROLE MATCHES AUDIENCE (§57, migration 0008).

          The connection authenticates as `portal_api` and does NOT inherit
          `firm_api` — that inheritance is what silently handed the portal
          table-level SELECT on 22 tables and defeated every column-level grant
          0004 wrote. A firm request therefore has to become firm_api for real.

          `SET ROLE` (not `SET LOCAL ROLE`): this is not inside a transaction.
          `SET LOCAL` outside a transaction block emits a warning and does
          nothing, which would leave firm requests running as portal_api and
          failing RLS closed — an empty firm OS with no error. The reset is in
          `scope.end()`, which the middleware already must call.

          Not switching roles for 'auth' keeps the pre-session window on the
          narrowest role there is: an unauthenticated request cannot reach a
          firm policy even if it could set the phase GUC, because it is not
          firm_api and inherits nothing from it.
        */
        if (ctx.phase === 'firm') {
          await client.query(`set role ${FIRM_ROLE}`);
        } else {
          await client.query('reset role');
        }
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
          /*
            RESET ROLE FIRST, and it is not optional.

            `RESET ALL` resets GUCs; it does NOT reset the role. A connection
            returned to the pool still holding `firm_api` would serve the next
            request — plausibly a client-portal request — with the firm role's
            policies and its unrestricted view of the internal columns. That is
            the §57 failure this whole change removes, reintroduced through the
            pool instead of through grants. RESET ROLE runs first so that even if
            RESET ALL throws, the privilege drop has already happened.
          */
          await client.query('RESET ROLE');
          // Wipe every GUC so the connection cannot leak identity back to the
          // pool.
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
