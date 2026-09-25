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

import { isTransientConnectionError } from './transient.js';

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
/**
 * How long a request scope may be open before a drain treats it as a corpse rather than a
 * request in flight. Comfortably longer than any request this API serves (the connect
 * ladder alone is ten seconds) and far shorter than a container's life.
 */
const ABANDONED_MS = 20_000;

type MutableRoleFacts = Omit<RoleFacts, 'assumedRoles'> & { assumedRoles?: readonly AssumedRoleFacts[] };

export class PostgresDb implements Db {
  readonly driver = 'postgres' as const;

  /**
   * THE POOL IS REBUILDABLE, NOT READONLY, AND THAT IS THE POINT OF `drain()` BELOW.
   *
   * A serverless runtime suspends an instance the moment its response is flushed, and a
   * suspended instance runs no timers — so an idle-timeout, however short, cannot be the
   * thing that returns a session pooler connection to the pool. The only reliable moment
   * to close a session is *inside* the invocation that opened it, before the freeze.
   * Hence: build lazily, close explicitly, and build a fresh pool when the next request
   * arrives on the same container.
   */
  private currentPool: pg.Pool | undefined;
  /** A pool handed in by a test. Not ours to close: see `drain()`. */
  private readonly injectedPool: pg.Pool | undefined;
  private readonly connectionString: string;
  private readonly max: number;

  /** The pool in use, built on first use and rebuilt after a `drain()`. */
  private get pool(): pg.Pool {
    this.currentPool ??= this.buildPool();
    return this.currentPool;
  }

  /**
   * The pool, once any drain that is in flight has finished.
   *
   * A drain and the next request can overlap for a few milliseconds, and both are
   * asynchronous: without this, that request would meet a pool that is closing and get
   * "Cannot use a pool after calling end on the pool" — the same class of transient
   * connection failure this file exists to stop reporting as a bug.
   */
  private async readyPool(): Promise<pg.Pool> {
    if (this.draining) await this.draining;
    return this.pool;
  }
  private draining: Promise<void> | undefined;

  /**
   * HOW MANY REQUEST SCOPES THIS INSTANCE HAS HANDED OUT AND NOT GOT BACK.
   *
   * The response is finished long before the last thing a request does with its
   * connection. The auth middleware releases its scope from a `res.once('finish')`
   * handler — deliberately, so that a response is never held up by two RESET round
   * trips — which means that at the moment the handler above is told the response is
   * done, the scope is still open and `client.release()` has not run yet.
   *
   * The first version of `drain()` looked at the pool's counts at exactly that instant,
   * saw a client checked out, and (correctly, for its own rules) skipped the drain. The
   * session then stayed open until the container froze, which is the outage again with
   * better manners. So the driver counts its own scopes and waits for them.
   */
  private outstanding = 0;
  private idleWaiters: (() => void)[] = [];

  /**
   * THE SCOPES THAT ARE STILL OPEN, AND WHEN THEY OPENED.
   *
   * A request that is KILLED mid-flight — the function budget runs out, the platform
   * recycles the instance — never reaches the code that hands its connection back. The
   * socket stays attached to the pooler for the life of the container, and the container
   * is warm: it will serve the next request while still holding a session that no code
   * path will ever release. Fifteen of those and the whole fleet is refused, which is
   * exactly the state measured after a storm of concurrent sign-ins:
   *
   *     portal_api backends: 15     a new client from anywhere: EMAXCONNSESSION
   *
   * The age is recorded so that only genuine corpses are force-closed: a request that is
   * merely slow is still running, and closing its connection under it would be its own
   * kind of bug.
   */
  private readonly scopes = new Map<pg.PoolClient, number>();

  private releaseScope(): void {
    this.outstanding = Math.max(0, this.outstanding - 1);
    if (this.outstanding === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const wake of waiters) wake();
    }
  }

  /** Resolves as soon as no scope is open, or when `ms` elapses. */
  private async awaitScopes(ms: number): Promise<boolean> {
    if (this.outstanding === 0) return true;
    let waited: Promise<boolean>;
    const idle = new Promise<true>((resolve) => {
      this.idleWaiters.push(() => resolve(true));
    });
    waited = Promise.race([
      idle,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
    const free = await waited;
    return free;
  }

  /**
   * @param pool a pool to use instead of building one. A TEST SEAM, and nothing else:
   *   the connection discipline this class promises — one statement at a time per
   *   connection, a bounded connect retry, reads retried and writes not — can only be
   *   verified against a pool that can be made to fail on purpose.
   */
  constructor(connectionString: string, max = 10, pool?: pg.Pool) {
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is required for the postgres driver. It must be the ' +
          'Supabase Postgres connection string for the portal_api role, e.g. ' +
          'postgres://portal_api:***@db.<ref>.supabase.co:5432/postgres',
      );
    }
    this.injectedPool = pool;
    this.connectionString = connectionString;
    this.max = max;
    this.currentPool = pool ?? this.buildPool();
  }

  private buildPool(): pg.Pool {
    const built = new Pool({
      connectionString: withoutSslParams(this.connectionString),
      max: this.max,
      /*
        WAITING FOR A SESSION IS NORMAL; FAILING BECAUSE OF ONE IS NOT.

        8 s was already here. On a saturated pooler a request that cannot get a
        connection is better off waiting than failing — the wait ends as soon as any
        other request finishes — so this is generous, and the 30 s function budget is
        the ceiling that keeps it honest.
      */
      connectionTimeoutMillis: 15_000,
      /*
        AND A WARM INSTANCE MUST NOT SIT ON A SESSION IT IS NOT USING.

        This is the defect that took the deployment down, and it is worth stating
        exactly: the Supabase session pooler publishes ONE pool for the role —
        `pool_size: 15` — and a session is a connection, because `SET ROLE` and session
        `set_config()` do not survive transaction pooling and the RLS model depends on
        both. With `idleTimeoutMillis: 60_000` every instance that had ever served a
        request kept its connection for a minute; a burst of thirty sign-ins warmed
        fifteen instances, the budget was gone, and every instance that started after
        that could not connect at all. The symptom was not slowness. It was
        `FUNCTION_INVOCATION_FAILED` on every request, because the cold-start role check
        is the first thing to need a connection.

        One second of idle is long enough to reuse a connection across the several
        requests a page makes and short enough that the fleet's footprint returns to
        "the instances currently answering a request".
      */
      idleTimeoutMillis: 1_000,
      allowExitOnIdle: true,
      ssl: sslFor(this.connectionString),
    });
    built.on('error', (err) => {
      console.error('[db] idle client error', err.message);
    });
    return built;
  }

  /**
   * HAND THE SESSIONS BACK BEFORE THE RUNTIME FREEZES THIS INSTANCE.
   *
   * This is the fix for the outage, and it is deliberately not a timeout. Measured on the
   * deployed system, with `idleTimeoutMillis` already down to one second:
   *
   *     portal_api sessions: 15, state=idle, untouched for 120s
   *
   * Fifteen of the pooler's fifteen slots, held by fifteen containers that had finished
   * their requests two minutes earlier and were merely suspended. Their event loops were
   * frozen, so no timer ever fired; the sockets stayed open, and every instance that
   * started afterwards could not get a session at all. Terminating the sessions by hand
   * restored the service instantly.
   *
   * So the close is explicit and it happens on the request that owns the session: after
   * the response is flushed, the pool is ended and discarded. The next request on this
   * container builds a new one. The cost is a handshake per request; the alternative is a
   * fleet that spends a shared budget of fifteen sessions on instances doing nothing.
   *
   * A test-supplied pool is left alone — closing it would break the test, not the bug.
   */
  async drain(): Promise<void> {
    if (this.injectedPool) return;
    if (this.draining) return this.draining;
    const pool = this.currentPool;
    if (!pool) return;
    this.draining = this.closeIfIdle(pool).finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  /**
   * Closes connections whose request is gone for good.
   *
   * Only scopes older than `ABANDONED_MS` are touched. Two seconds of waiting is enough
   * for the ordinary case — the auth middleware releases its scope a tick after the
   * response is flushed — so anything still open after twenty seconds is not a request
   * that is about to finish; it is a request that was killed. Its socket is closed here
   * and the pool is thrown away, because the alternative is a container that holds a
   * session until it is reaped, and a fleet that has to be rescued by hand.
   */
  private closeAbandoned(pool: pg.Pool): void {
    const cutoff = Date.now() - ABANDONED_MS;
    let closed = 0;
    for (const [client, openedAt] of this.scopes) {
      if (openedAt > cutoff) continue;
      this.scopes.delete(client);
      this.outstanding = Math.max(0, this.outstanding - 1);
      closed += 1;
      void client.end().catch(() => {
        /* already gone */
      });
    }
    if (!closed) return;
    console.warn(
      `[db] closed ${closed} abandoned connection(s): a request was killed before it could `
      + 'hand its session back. Rebuilding the pool.',
    );
    this.currentPool = undefined;
    void pool.end().catch(() => {
      /* the pool is being abandoned on purpose */
    });
  }

  /** The body of a drain, once one is in flight. */
  private async closeIfIdle(pool: pg.Pool): Promise<void> {
    /*
      ONLY WHEN NOTHING IS CHECKED OUT. One container can be answering more than one
      request at a time, and a pool that is closed under a running request would fail it
      for no reason. If somebody else is mid-request, the drain is simply skipped: that
      request will drain when it finishes, and the last one out closes the door.
    */
    /*
      THE SCOPE IS STILL CLOSING AT THIS POINT. `res.once('finish')` is where the auth
      middleware releases it, and that fires on the same tick the response is flushed —
      so wait for the count to reach zero before asking the pool anything. It is
      microseconds in practice; the ceiling is here so a leaked scope cannot pin a
      function open.
    */
    if (!(await this.awaitScopes(2_000))) {
      this.closeAbandoned(pool);
      return;
    }
    if (this.currentPool !== pool) return;
    if (pool.idleCount !== pool.totalCount || pool.waitingCount > 0) return;
    this.currentPool = undefined;
    /* `end()` waits for a checked-out client to come back. Everything should have been
       released by now; the ceiling is here so that a leak cannot pin a function open. */
    const ended = pool.end().then(() => true);
    const closed = await Promise.race([
      ended,
      new Promise<false>((r) => setTimeout(() => r(false), 2_000)),
    ]);
    if (!closed) console.warn('[db] drain did not complete within 2s; a client is still checked out');
  }

  /**
   * Refuses to run when the connection can bypass Row Level Security.
   *
   * Called during boot, before the first request is served, so a dangerous
   * connection is a startup failure rather than a silent loss of the database
   * boundary. See role-guard.ts for why each condition matters.
   */
  async assertSafeRole(): Promise<void> {
    /*
      THE BOOT GATE USES THE SAME LADDER AS EVERYTHING ELSE.

      This query is the first thing a cold instance runs, so it is the first thing to
      meet a pooler that is momentarily full — and its failure is fatal by design: the
      function never reaches the request handler, and the caller gets the platform's
      generic crash page. That is correct for a connection which can bypass RLS and
      wrong for a connection that simply has not been granted a slot yet. The retry
      draws that line: a transient failure is waited out, and the verdict itself is
      never softened.
    */
    const client = await this.connect();
    let res: pg.QueryResult<{
      rolname: string; rolsuper: boolean; rolbypassrls: boolean; owned_tables: string;
    }>;
    try {
      res = await client.query<{
        rolname: string; rolsuper: boolean; rolbypassrls: boolean; owned_tables: string;
      }>(`select current_user as rolname,
              r.rolsuper,
              r.rolbypassrls,
              (select count(*)
                 from pg_class c
                 join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public'
                  and c.relkind = 'r'
                  and pg_get_userbyid(c.relowner) = current_user)::text as owned_tables
         from pg_roles r
        where r.rolname = current_user`);
    } finally {
      client.release();
    }

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
    const res = await (await this.readyPool()).query<{
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

  /**
   * A connection, with a bounded retry while the failure is about connecting.
   *
   * Safe for reads AND writes: nothing has been sent when this throws, so the second
   * attempt cannot apply a statement twice. Three attempts, because the two defects that
   * produce this failure in production are a pooler at its client limit and an instance
   * that has just started — both of which clear in milliseconds — and because a request
   * that waits 8 s three times is already past its function budget.
   */
  private async connect(): Promise<pg.PoolClient> {
    /*
      THE LADDER. Seven attempts over roughly ten seconds: a pooler that is at
      its client limit frees slots as other requests finish, so the correct behaviour is
      to wait for one rather than to report a failure the reader can do nothing about. A
      permanent failure (a bad password, a missing database) fails on the first attempt —
      retrying it would only delay the answer.
    */
    const backoffMs = [250, 500, 1_000, 2_000, 3_000, 3_000];
    let lastError: unknown;
    for (let attempt = 1; attempt <= backoffMs.length + 1; attempt++) {
      try {
        return await (await this.readyPool()).connect();
      } catch (err) {
        lastError = err;
        if (!isTransientConnectionError(err)) throw err;
        if (attempt > backoffMs.length) break;
        const wait = backoffMs[attempt - 1];
        console.warn(`[db] connect attempt ${attempt} failed (${(err as Error).message}); `
          + `retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastError;
  }

  /**
   * A read, retried once if the CONNECTION died mid-statement.
   *
   * Reads are idempotent, so repeating one costs nothing but the milliseconds. A write
   * deliberately does not get this: the connection can fail after the server has applied
   * the statement and before the client hears about it, and a retry there is how a
   * payment is recorded twice.
   */
  private async read<T extends pg.QueryResultRow = Row>(
    sql: string, params: Param[],
  ): Promise<pg.QueryResult<T>> {
    const client = await this.connect();
    try {
      return await client.query<T>(PostgresDb.toPg(sql), PostgresDb.coerce(params) as never);
    } catch (err) {
      if (!isTransientConnectionError(err)) throw err;
      console.warn(`[db] read failed on a dead connection (${(err as Error).message}); retrying once`);
      const second = await this.connect();
      try {
        return await second.query<T>(PostgresDb.toPg(sql), PostgresDb.coerce(params) as never);
      } finally {
        second.release();
      }
    } finally {
      client.release();
    }
  }

  async all<T = Row>(sql: string, params: Param[] = []): Promise<T[]> {
    const res = await this.read(sql, params);
    return res.rows.map((r) => PostgresDb.mapRow<T>(r as Row));
  }

  async get<T = Row>(sql: string, params: Param[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: Param[] = []): Promise<RunResult> {
    const client = await this.connect();
    try {
      const res = await client.query(PostgresDb.toPg(sql), PostgresDb.coerce(params) as never);
      return { changes: res.rowCount ?? 0 };
    } finally {
      client.release();
    }
  }

  async acquire(): Promise<Scope> {
    const client = await this.connect();
    this.outstanding += 1;
    this.scopes.set(client, Date.now());
    /* Captured because `scope.end()` below is a method on a different object. */
    const scopeClosed = () => {
      this.scopes.delete(client);
      this.releaseScope();
    };
    let txDepth = 0;
    let ended = false;

    /*
      ONE CONNECTION, ONE STATEMENT AT A TIME.

      A scope is one connection held for one request, and it is also the ONLY connection
      the RLS context (`kgm.*`) and the role (`firm_api`) live on — that is why the request
      is scoped to it at all. Everything the request reads therefore has to go through it.

      But the repository does not always read one thing at a time. `Promise.all` is used
      wherever several independent facts are wanted for one screen — the authorization
      facts are the ones that matter, because a firm sign-in resolves roles, permission
      codes, departments and practice areas at once — and node-postgres answers a second
      query on a busy client with a deprecation warning today and undefined behaviour
      later:

          Calling client.query() when the client is already executing a query is
          deprecated and will be removed in pg@9.0.

      It is worse than a warning. Two statements interleaved on one connection inside a
      transaction can land outside the savepoint that was supposed to contain them, and
      the failure appears at whichever unrelated request happens to be in flight.

      So the scope serializes: every statement — including BEGIN/COMMIT/SAVEPOINT and the
      RESET ALL in `end()` — is queued behind the one before it and issued alone. The
      callers keep their `Promise.all`; the order they asked for is the order they get,
      and nothing overlaps.
    */
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const settled = chain.then(fn, fn);
      chain = settled.then(() => undefined, () => undefined);
      return settled;
    };
    const query = (sql: string, params: Param[] = []) =>
      serial(() => client.query(PostgresDb.toPg(sql), PostgresDb.coerce(params) as never));

    const q: Queryable = {
      all: async <T = Row>(sql: string, params: Param[] = []) => {
        const res = await query(sql, params);
        return res.rows.map((r) => PostgresDb.mapRow<T>(r as Row));
      },
      get: async <T = Row>(sql: string, params: Param[] = []) => {
        const res = await query(sql, params);
        return res.rows.length ? PostgresDb.mapRow<T>(res.rows[0] as Row) : undefined;
      },
      run: async (sql: string, params: Param[] = []) => {
        const res = await query(sql, params);
        return { changes: res.rowCount ?? 0 };
      },
    };

    const scope: Scope = {
      q,

      async setContext(ctx: RequestContext) {
        // set_config with is_local=false scopes to this dedicated connection.
        // The values are bound as parameters, never interpolated.
        await query("select set_config('kgm.phase', $1, false)", [ctx.phase]);
        await query("select set_config('kgm.tenant_id', $1, false)", [ctx.tenantId ?? '']);
        await query("select set_config('kgm.user_id', $1, false)", [ctx.userId ?? '']);
        await query("select set_config('kgm.client_ids', $1, false)", [ctx.clientIds.join(',')]);
        // Firm OS scope (migration 0006). Empty string for a client request,
        // which makes kgm_membership() return null and closes every firm_*
        // table by RLS.
        await query("select set_config('kgm.membership_id', $1, false)", [ctx.membershipId ?? '']);

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
          await query(`set role ${FIRM_ROLE}`);
        } else {
          await query('reset role');
        }
      },

      async tx<T>(fn: () => Promise<T>): Promise<T> {
        if (txDepth === 0) {
          await query('BEGIN');
          txDepth = 1;
          try {
            const result = await fn();
            await query('COMMIT');
            return result;
          } catch (err) {
            try {
              await query('ROLLBACK');
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
        await query(`SAVEPOINT ${sp}`);
        try {
          const result = await fn();
          await query(`RELEASE SAVEPOINT ${sp}`);
          return result;
        } catch (err) {
          await query(`ROLLBACK TO SAVEPOINT ${sp}`);
          throw err;
        } finally {
          txDepth--;
        }
      },

      async end() {
        if (ended) return;
        ended = true;
        try {
          if (txDepth > 0) await query('ROLLBACK');
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
          await query('RESET ROLE');
          // Wipe every GUC so the connection cannot leak identity back to the
          // pool.
          await query('RESET ALL');
        } catch {
          /* the client is broken; release() will destroy it */
        } finally {
          client.release();
          scopeClosed();
        }
      },
    };

    return scope;
  }

  async close(): Promise<void> {
    const pool = this.currentPool;
    this.currentPool = undefined;
    await pool?.end();
  }
}
