/**
 * VERCEL SERVERLESS ENTRY POINT
 *
 * One deployment, one origin: the client portal, the Firm OS and this API are all
 * served from the same Vercel project, so the browser sees a single origin and the
 * httpOnly session cookies work without any CORS relaxation. That is a hard
 * requirement, not a convenience — `web/src/api/client.ts` calls relative paths
 * with `credentials: 'same-origin'`, and the firm cookie is `SameSite=strict`,
 * which is never sent cross-site. A session cookie crossing origins would be a
 * CSRF surface, so the deployment shape is dictated by the security model.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `index.ts`
 *   `index.ts` binds a port and owns process lifetime: it seeds, installs
 *   signal handlers, and starts an hourly timer. None of that is meaningful in a
 *   serverless function, and `app.listen` would fail outright. This module exports
 *   the same Express app as a request handler instead, so the ROUTES, the
 *   middleware order and every authorization check are literally the same code
 *   that runs on an always-on host.
 *
 * WHAT IS DIFFERENT ON SERVERLESS, STATED PLAINLY
 *   1. RATE LIMITING IS WEAKER. `RATE_LIMIT_STORE` is in-process memory, so each
 *      warm function instance keeps its own counters. Under fan-out the effective
 *      limit is (configured limit x running instances). It still stops a single
 *      client hammering one instance, and it is not the primary control — the
 *      durable ones are the account lockout counters in `users` and the append-only
 *      `login_attempts` table, which are shared across every instance because they
 *      live in Postgres. Moving the limiter to a durable store is the follow-up.
 *   2. THE SEED DOES NOT RUN. `index.ts` seeds only for SQLite and only when
 *      SEED_ON_BOOT is set; here it never runs, which is the correct production
 *      behaviour — a restart must not insert demo logins into a live database.
 *   3. THE CONNECTION POOL IS SMALL AND PER-INSTANCE. `PG_POOL_MAX` stays low
 *      because instances multiply, and the SESSION pooler (port 5432) has a fixed
 *      pool size. Session pooling is mandatory: the request context is injected
 *      with `set_config` and wiped with `RESET ALL` on a pinned connection
 *      (`db/context.ts`), which transaction pooling would scatter.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createContainer } from './container.js';
import { createApp } from './app.js';
import { getDb } from './db/index.js';
import { PostgresDb } from './db/postgres.js';
import { isTransientConnectionError } from './db/transient.js';

const db = getDb();
const container = createContainer({ db });
const app = createApp(container);

/**
 * The isolation check, run once per cold start and before the first response.
 *
 * `assertSafeRole` is what refuses to serve from a connection that can bypass Row
 * Level Security — a SUPERUSER, BYPASSRLS, or the table owner. On an always-on
 * host this is a boot gate; here it is a first-request gate, and the failure is
 * deliberately propagated rather than caught: a deployment wired to the wrong
 * database identity must return 500 for every request, not quietly serve with the
 * database boundary switched off.
 *
 * The promise is memoised so a warm instance does not re-run the query per
 * request, and so concurrent requests during a cold start all await ONE check.
 */
/**
 * Restores the real request path before Express sees it.
 *
 * Vercel reaches this function through a dynamic-segment route, and its router
 * hands the matched segments to the launcher as a `path` query parameter
 * (`/api/[...path]?path=client/matters`). Whether the launcher then rebuilds
 * `req.url` or leaves the mount path in place is an implementation detail of the
 * runtime build, so it is not assumed: when the mount path survives, it is
 * replaced here — once, explicitly — instead of every route being made to
 * tolerate it.
 *
 * The repair is inert on an always-on host and on any request whose URL is
 * already correct, and it announces itself with a response header so a
 * deployment can be checked with a single curl instead of guessed at.
 */
function normalizeRequestUrl(req: IncomingMessage, res: ServerResponse): void {
  const raw = req.url;
  if (!raw) return;

  const url = new URL(raw, 'http://vercel.internal');
  // Compared against the decoded pathname, so a percent-encoded mount path
  // (`%5B...path%5D`) is recognised just the same.
  if (!url.pathname.includes('[...path]')) return;

  const rest = (url.searchParams.get('path') ?? '').replace(/^\/+/, '');
  url.searchParams.delete('path');
  const query = url.searchParams.toString();

  req.url = `/api/${rest}${query ? `?${query}` : ''}`;
  res.setHeader('x-kgm-url-repaired', '1');
}

let ready: Promise<void> | null = null;
function ensureSafe(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      if (db instanceof PostgresDb) await db.assertSafeRole();
    })().catch((err) => {
      // Do not memoise a failure as success: a transient database error should be
      // retried on the next request rather than permanently poisoning the instance.
      ready = null;
      throw err;
    });
  }
  return ready;
}

/**
 * A BOOT GATE THAT CANNOT GET A CONNECTION IS NOT A BROKEN DEPLOYMENT.
 *
 * `ensureSafe()` fails for two entirely different reasons, and the first version of this
 * handler treated them the same way — by letting the error escape, which on this platform
 * means the instance never reaches the request handler and the caller receives
 * `FUNCTION_INVOCATION_FAILED` instead of anything this application wrote. A pooler at its
 * client limit therefore did not look like congestion; it looked like the product was
 * down, on every request, until the warm instances holding the sessions expired.
 *
 * So the two are separated:
 *   · a TRANSIENT failure to connect is answered with this API's own 503 envelope —
 *     retryable, with the request id — and the check is tried again on the next request;
 *   · a VERDICT (this connection can bypass Row Level Security) still throws, because a
 *     deployment wired to the wrong database identity must not quietly serve.
 */
function answerNotReady(res: ServerResponse, requestId: string | null): void {
  res.statusCode = 503;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('retry-after', '2');
  res.setHeader('cache-control', 'no-store');
  if (requestId) res.setHeader('x-request-id', requestId);
  res.end(JSON.stringify({
    ok: false,
    error: {
      code: 'service_unavailable',
      message: 'the database is temporarily unavailable',
      retryable: true,
    },
  }));
}

/**
 * GIVE THE SESSION BACK BEFORE THIS INSTANCE IS SUSPENDED.
 *
 * The pooler this API connects through publishes fifteen sessions for the whole fleet, and
 * a suspended container does not run timers — so an idle timeout cannot return one. The
 * only dependable moment is here, inside the invocation, once the response has actually
 * been flushed: close the pool and let the next request on this container build a new one.
 * Without it, fifteen warm instances hold all fifteen sessions while doing nothing and the
 * sixteenth request cannot connect at all.
 */
async function handBackSessions(): Promise<void> {
  try {
    const db = getDb() as unknown as { drain?: () => Promise<void> };
    if (typeof db?.drain === 'function') await db.drain();
  } catch (err) {
    /* Failing to close a connection must not fail a request that already succeeded. */
    console.error('[db] could not drain the pool:', (err as Error).message);
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  normalizeRequestUrl(req, res);
  const requestId = (res.getHeader('x-request-id') as string | undefined) ?? null;
  try {
    try {
      await ensureSafe();
    } catch (err) {
      if (isTransientConnectionError(err)) {
        console.warn('[boot] the role check could not reach the database; answering 503');
        answerNotReady(res, requestId);
        return;
      }
      throw err;
    }
  /*
    `req.url` arrives intact (`/api/client/matters` and friends) because the
    function is mounted at `/api` without a path-rewriting rule, so Express routes
    on the same paths it does locally. If a rewrite ever prefixes or strips the
    path, every route 404s at once — which is why the deployment is verified with
    `supabase/ops/verify_live_pages.mjs` rather than assumed from a 200 on `/`.
  */
    (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
  } finally {
    await flushed(res);
    await handBackSessions();
  }
}

/**
 * Resolves when the response has been FLUSHED — on the same event the auth middleware
 * releases its scope on, so the drain is ordered after that scope is closed.
 *
 * `stream.finished()` from `node:stream/promises` was the first attempt, and it does not
 * work here: a ServerResponse is both readable and writable, and `finished()` also waits
 * for the readable side to end — which for an HTTP response may only happen when the
 * socket closes. The handler parked in `await finished(res)` with its session still open,
 * the runtime froze the container, and the drain never ran at all. 'finish' is the event
 * the rest of this application already relies on, from the middleware to the tests.
 */
function flushed(res: ServerResponse): Promise<void> {
  if (res.writableEnded) return Promise.resolve();
  return new Promise<void>((resolve) => {
    res.once('finish', resolve);
    res.once('close', resolve);
  });
}
