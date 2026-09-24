/**
 * Shared helpers for the security suite.
 *
 * Every test gets a fully isolated stack: an in-memory database (fresh schema +
 * demo seed), a private temporary storage root, its own container and its own
 * Express app bound to an ephemeral port. Nothing leaks between tests, so rate
 * limits, sessions, tokens and audit rows are all deterministic.
 *
 * The client is a thin cookie jar over fetch with CSRF handling built in, which
 * is what makes the negative tests (§46) easy to write: a tampered field is just
 * an argument, not a hand-rolled request.
 */
import type { Express } from 'express';
import type { Db } from '../server/src/db/types.js';
import type { Container } from '../server/src/container.js';
import { createContainer } from '../server/src/container.js';
import { createApp } from '../server/src/app.js';
import { createTestDb } from '../server/src/db/index.js';
import { seedDemoData } from '../server/src/db/seed.js';
import { LocalStorage } from '../server/src/storage/service.js';
import { IDS, DEMO_FIRM_PASSWORD } from '../server/src/db/demo-data.js';
import { readOutbox, clearOutbox, type OutboundEmail } from '../server/src/auth/email.js';
import { resetAllLimits } from '../server/src/auth/ratelimit.js';

export interface Stack {
  app: Express;
  /** The DI container — reach into repo/audit/storage/sessions directly. */
  c: Container;
  container: Container;
  db: Db;
  agent: Agent;
  /** Ephemeral port the app is bound to, for raw fetch() assertions. */
  port: number;
  server: { close: () => Promise<void> };
  shutdown: () => Promise<void>;
}

let stackCounter = 0;

/**
 * A completely isolated stack: fresh in-memory schema + demo seed, a private
 * temporary storage root, its own container and Express app. Rate-limit
 * counters are module-level, so they are reset here rather than per test to
 * keep every stack starting from zero.
 */
export async function createTestStack(): Promise<{ c: Container; db: Db }> {
  stackCounter += 1;
  resetAllLimits();
  clearOutbox();

  const db = createTestDb();
  const storage = new LocalStorage(`/tmp/kgm-portal-test/${process.pid}-${stackCounter}`);
  const c = createContainer({ db, storage });
  // Storage is passed so the seeded document rows have real bytes behind them;
  // otherwise every download test would be asserting on a broken volume.
  await seedDemoData(db, { storage });
  return { c, db };
}

export interface PostOpts {
  /** send this exact byte sequence as the body (for malformed-JSON tests) */
  raw?: Buffer;
  contentType?: string;
  /** override the X-CSRF-Token header; pass a falsy value to omit it entirely */
  csrf?: string | null | false;
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

export interface Agent {
  get(url: string): Promise<ApiResponse>;
  post(url: string, body?: unknown, opts?: PostOpts): Promise<ApiResponse>;
  patch(url: string, body?: unknown, opts?: PostOpts): Promise<ApiResponse>;
  del(url: string, opts?: PostOpts): Promise<ApiResponse>;
  /** multipart/form-data upload, matching what the browser's FormData sends. */
  postMultipart(
    url: string,
    fields: Record<string, string | null | undefined>,
    file?: { name: string; type: string; data: Buffer },
  ): Promise<ApiResponse>;
  readonly cookies: Map<string, string>;
  csrf(): string | undefined;
  /** The Firm OS CSRF cookie. A different cookie from `csrf()` by design (§6). */
  firmCsrf(): string | undefined;
  clearCookies(): void;
}

export function createAgent(app: Express): Agent {
  const cookies = new Map<string, string>();

  const port = (): string => {
    const p = (app as unknown as { __port?: number }).__port;
    if (!p) throw new Error('agent used before listen(); call bootStack() first');
    return String(p);
  };

  const cookieHeader = () =>
    [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  function storeCookies(res: Response): void {
    const raw =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie') ?? ''];
    for (const c of raw) {
      if (!c) continue;
      const first = c.split(';')[0];
      const i = first.indexOf('=');
      if (i < 1) continue;
      const name = first.slice(0, i).trim();
      const value = first.slice(i + 1).trim();
      // An expired Max-Age means the server cleared the cookie.
      const expired = /max-age=0(;|$)/i.test(c) || /expires=Thu, 01 Jan 1970/i.test(c);
      if (expired) cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  /**
   * Which CSRF cookie belongs to which audience.
   *
   * The two products run on one origin with two CSRF cookies. Picking by URL
   * prefix is what lets the same agent drive both audiences in one test — which
   * is exactly what the cross-audience escalation checks need.
   */
  const csrfCookieFor = (url: string) =>
    url.startsWith('/api/firm') ? 'kgm_firm_csrf' : 'kgm_csrf';

  function headersFor(opts?: PostOpts, contentType?: string, url = ''): Record<string, string> {
    const headers: Record<string, string> = {};
    if (cookies.size) headers.cookie = cookieHeader();
    if (contentType) headers['content-type'] = contentType;
    const auto = cookies.get(csrfCookieFor(url));
    if (opts?.csrf !== undefined) {
      if (opts.csrf) headers['x-csrf-token'] = opts.csrf;
    } else if (auto) {
      headers['x-csrf-token'] = auto;
    }
    return headers;
  }

  async function send(
    method: string,
    url: string,
    init: { body?: BodyInit | null; headers?: Record<string, string> },
  ): Promise<ApiResponse> {
    const res = await fetch(`http://127.0.0.1:${port()}${url}`, { method, ...init });
    const text = await res.text();
    const headers: Record<string, string | string[] | undefined> = {};
    res.headers.forEach((v, k) => {
      headers[k] = k === 'set-cookie' && typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : v;
    });
    storeCookies(res);
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, headers, text };
  }

  /** JSON (or raw bytes) request. */
  function json(method: string, url: string, body?: unknown, opts?: PostOpts) {
    let payload: BodyInit | undefined;
    let ct: string | undefined;
    if (opts?.raw) {
      payload = new Uint8Array(opts.raw);
      ct = opts.contentType ?? 'application/json';
    } else if (typeof body === 'string') {
      // A string body is sent VERBATIM. Re-encoding it would turn a malformed
      // JSON fixture into a valid JSON string literal and quietly stop testing
      // what it claims to test.
      payload = body;
      ct = opts?.contentType ?? 'application/json';
    } else if (body !== undefined && body !== null) {
      payload = JSON.stringify(body);
      ct = opts?.contentType ?? 'application/json';
    }
    return send(method, url, { body: payload, headers: headersFor(opts, ct, url) });
  }

  const postMultipart: Agent['postMultipart'] = async (url, fields, file) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) form.append(k, v);
    }
    if (file) {
      form.append('file', new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
    }
    return send('POST', url, { body: form, headers: headersFor(undefined, undefined, url) });
  };

  return {
    cookies,
    csrf: () => cookies.get('kgm_csrf'),
    firmCsrf: () => cookies.get('kgm_firm_csrf'),
    clearCookies: () => cookies.clear(),
    get: (url) => send('GET', url, { headers: headersFor(undefined, undefined, url) }),
    post: (url, body, o) => json('POST', url, body, o),
    patch: (url, body, o) => json('PATCH', url, body, o),
    del: (url, o) => json('DELETE', url, undefined, o),
    postMultipart,
  };
}

/** Boots a stack and binds the app to an ephemeral port. */
export async function bootStack(): Promise<Stack> {
  const { c, db } = await createTestStack();
  // apiOnly: tests never serve the SPA bundle, so no filesystem dependency.
  const app = createApp(c, { apiOnly: true });
  const server = await listen(app);
  const agent = createAgent(app);
  return {
    app, c, container: c, db, agent,
    port: (app as unknown as { __port: number }).__port,
    server,
    shutdown: async () => {
      await server.close();
      await db.close().catch(() => undefined);
    },
  };
}

export async function listen(app: Express): Promise<{ close: () => Promise<void> }> {
  return await new Promise((resolve) => {
    const httpServer = app.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      (app as unknown as { __port?: number }).__port = p;
      resolve({
        close: () => new Promise<void>((r) => httpServer.close(() => r())),
      });
    });
  });
}

export async function loginAs(
  agent: Agent,
  email: string,
  password = 'Demo!Portal2026',
): Promise<ApiResponse> {
  await agent.get('/api/auth/bootstrap');
  return agent.post('/api/auth/login', { email, password });
}

/**
 * Signs in to the FIRM OS (§52).
 *
 * A different endpoint, a different password and a different cookie from
 * `loginAs`. The bootstrap GET mints the anonymous firm CSRF token so the login
 * POST can satisfy the double-submit check.
 */
export async function firmLoginAs(
  agent: Agent,
  email: string,
  password: string = DEMO_FIRM_PASSWORD,
): Promise<ApiResponse> {
  await agent.get('/api/firm/auth/csrf');
  return agent.post('/api/firm/auth/login', { email, password });
}

/** The five seeded firm operators, by role. */
export const FIRM = {
  managingPartner: 'noura@kgm.example.test',
  lawyer: 'faisal@kgm.example.test',
  paralegal: 'mariam@kgm.example.test',
  compliance: 'omar@kgm.example.test',
  finance: 'sara@kgm.example.test',
} as const;

export { DEMO_FIRM_PASSWORD };

/**
 * The mail outbox is a module-level capture (the same one the dev routes read),
 * so it spans stacks within a single test file. Every suite must clear it in
 * beforeEach to keep assertions about "the email that was just sent" honest.
 */
export { readOutbox, clearOutbox };
export type { OutboundEmail };

/** Most recent email sent to `address` whose subject/body matches `pattern`. */
export function lastEmail(address: string, pattern: RegExp = /.*/): OutboundEmail {
  const msg = readOutbox().find((m) => m.to === address && pattern.test(`${m.subject}\n${m.text}`));
  if (!msg) {
    throw new Error(`no ${pattern} email to ${address}; outbox has ${readOutbox().length} message(s)`);
  }
  return msg;
}

/** Pulls the one-time token out of a reset / invitation / verification link. */
export function tokenFromLink(msg: OutboundEmail, param = 'token'): string {
  if (!msg.link) throw new Error(`email has no link: ${JSON.stringify(msg).slice(0, 200)}`);
  const token = new URL(msg.link).searchParams.get(param);
  if (!token) throw new Error(`link has no "${param}" query param: ${msg.link}`);
  return token;
}

export { IDS };
