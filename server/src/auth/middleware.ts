/**
 * HTTP MIDDLEWARE — the enforcement boundary (§2, §35, §36).
 *
 * Layer order on every request:
 *   1. request id + timing
 *   2. security headers / CSP
 *   3. INTERNAL ROUTE DENIAL — before any handler, before any auth. A portal
 *      process has no business serving /admin, /audit, /firm-settings...
 *      These return a uniform 404 and are audited as attempts.
 *   4. body parsing with hard size limits
 *   5. session resolution → Principal (never from a body/header/cookie claim)
 *   6. per-session API rate limiting
 *   7. route handler
 *   8. error handler — the only place that serializes an error, and it can only
 *      emit {code, message, details}. No stack, no SQL, no provider text.
 */
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { SessionManager, Principal } from './session.js';
import type { AuditLogger } from '../audit/logger.js';
import { PortalError, toPortalError, unauthorized, notFoundOrForbidden, forbidden } from '../lib/errors.js';
import { FORBIDDEN_FIELDS, normalizeFieldKey } from '../domain/protected-fields.js';
import type { Container } from '../container.js';
import { fail, newRequestId } from '../lib/http.js';
import { requestInfo } from '../audit/logger.js';
import { limit, keys } from './ratelimit.js';
import { runInContext, setContextInStore } from '../db/context.js';
import { assertCsrf } from './csrf.js';
import { AUTH_PHASE } from '../db/types.js';
import type { Db, Scope } from '../db/types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id?: string;
      principal?: Principal;
      startedAt?: number;
      scope?: Scope;
    }
  }
}

export interface MiddlewareDeps {
  db: Db;
  repo: Repo;
  sessions: SessionManager;
  audit: AuditLogger;
  trustProxy: boolean;
}

/** Upper bound on how long a request may hold a pooled connection. */
const SCOPE_MAX_MS = 60_000;

export function requestId(deps: MiddlewareDeps): RequestHandler {
  return (req, res, next) => {
    req.id = (req.header('x-request-id') || newRequestId()).slice(0, 64);
    req.startedAt = Date.now();
    res.setHeader('x-request-id', req.id);
    // Never advertise the stack.
    res.removeHeader('x-powered-by');
    void deps;
    next();
  };
}

/**
 * §2 — INTERNAL ROUTE DENIAL.
 *
 * The Client Portal is a separate application. It does not merely hide internal
 * navigation; the internal surface is not mounted, and any attempt to reach it
 * is refused here, before authentication is even considered, and audited.
 *
 * The response is a uniform 404 rather than a 403: confirming that /audit
 * exists would itself be information disclosure.
 */
export function denyInternalRoutes(deps: MiddlewareDeps): RequestHandler {
  const prefixes = config.security.forbiddenPathPrefixes;
  // `/api/firm` is NOT in this list any more. It used to be, back when the Firm
  // OS was a route prefix that had to be refused outright. It is now a real
  // product surface with its own authentication, so the refusal has moved to a
  // guard that understands BOTH audiences (auth/firm-middleware.ts): a
  // client-portal session still gets a uniform 404 from `/api/firm/*`, and the
  // attempt is audited as an escalation. What changed is who decides, not what a
  // portal caller sees.
  const apiInternal = ['/api/internal', '/api/admin', '/api/staff', '/api/audit'];

  return (req, res, next) => {
    const p = req.path.toLowerCase();
    const hit =
      prefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`)) ||
      apiInternal.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));

    if (!hit) return next();

    // Fire and forget: an audit failure must not turn a denial into a 500.
    void (async () => {
      const ctx = requestInfo(req, deps.trustProxy);
      const principal = await deps.sessions.resolve(req, res).catch(() => null);
      await deps.audit.tryWrite(
        {
          action: 'INTERNAL_RESOURCE_ACCESS_ATTEMPT',
          actor: principal
            ? { kind: 'client_user', userId: principal.userId, tenantId: principal.tenantId, clientId: principal.primaryClientId }
            : { kind: 'anonymous' },
          outcome: 'denied',
          reasonCode: 'internal_route',
          resourceType: 'route',
          resourceId: p.slice(0, 200),
          metadata: { method: req.method },
        },
        ctx,
      );
    })();

    res.status(404).json({
      ok: false,
      error: { code: 'not_found', message: 'not found' },
    });
  };
}

/**
 * Resolves the session into `req.principal` and opens the request-scoped
 * database context so every downstream query is phase- and tenant-scoped
 * (§9, §36).
 *
 * Two phases, both chosen by the server:
 *
 *   AUTH    before we know who is calling. Only capability-based lookups are
 *           permitted (session token, invitation token, email). No domain
 *           table is readable in this phase — there is no RLS policy for one.
 *   PORTAL  after the principal is resolved. Scoped to that principal's
 *           tenant_id and the exact set of client_ids in client_users.
 *
 * A handler cannot move itself back to AUTH: `setContext` is only called here.
 */
export function attachPrincipal(deps: MiddlewareDeps): RequestHandler {
  return async (req, res, next) => {
    let scope: Scope;
    try {
      scope = await deps.db.acquire();
    } catch (err) {
      return next(err);
    }
    req.scope = scope;

    let ended = false;
    const endScope = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      void scope.end().catch(() => {
        /* the driver already logged this; the pool will recycle the client */
      });
    };
    const timer = setTimeout(endScope, SCOPE_MAX_MS);
    if (typeof timer.unref === 'function') timer.unref();
    res.once('finish', endScope);
    res.once('close', endScope);

    runInContext(scope, AUTH_PHASE, () => {
      void (async () => {
        try {
          await scope.setContext(AUTH_PHASE);
          const principal = await deps.sessions.resolve(req, res);
          req.principal = principal ?? undefined;

          const ctx = principal
            ? {
                phase: 'portal' as const,
                tenantId: principal.tenantId,
                userId: principal.userId,
                clientIds: principal.clientIds,
              }
            : AUTH_PHASE;
          await scope.setContext(ctx);
          setContextInStore(ctx);
          next();
        } catch (err) {
          endScope();
          next(err);
        }
      })();
    });
  };
}

/**
 * Requires a valid session and a satisfied MFA step, but does NOT require email
 * verification. Used for the handful of endpoints that must work for an
 * unverified account — sending the verification email chief among them. Without
 * this, an unverified user is locked out of the only route that can unlock them.
 */
export function requireSession(): RequestHandler {
  return (req, _res, next) => {
    try {
      if (!req.principal) throw unauthorized('unauthenticated', 'authentication required');
      const p = req.principal;
      if (p.mfaEnabled && !p.mfaVerified) {
        throw new PortalError(401, 'mfa_required', 'multi-factor verification required', {
          details: { step: 'mfa' },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Requires a fully authorized principal; otherwise 401. */
export function requireClient(deps: MiddlewareDeps): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (!req.principal) throw unauthorized('unauthenticated', 'authentication required');
      const p = req.principal;
      if (p.mfaEnabled && !p.mfaVerified) {
        throw new PortalError(401, 'mfa_required', 'multi-factor verification required', {
          details: { step: 'mfa' },
        });
      }
      if (!p.emailVerified) {
        throw new PortalError(403, 'email_not_verified', 'email verification required', {
          details: { step: 'verify_email' },
        });
      }
      if (!p.clientIds.length) {
        await deps.audit.tryWrite(
          { action: 'AUTHZ_DENIED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId },
            outcome: 'denied', reasonCode: 'no_client_scope' },
          requestInfo(req, deps.trustProxy),
        );
        throw notFoundOrForbidden('resource');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * CSRF gate for state-changing requests (§7).
 * The token must be bound to the current session id.
 */
export function csrfGuard(opts: { acceptAnonymous?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    try {
      assertCsrf(req, req.principal?.sessionId ?? null, opts);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Coarse per-session API budget. Abuse signal, not a security control. */
export function apiRateLimit(deps: MiddlewareDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      const p = req.principal;
      const key = p ? keys.api(p.sessionId) : keys.api(`anon:${req.ip ?? 'unknown'}`);
      const r = limit(key, config.rateLimit.apiMaxPerSession, config.rateLimit.apiWindowSeconds);
      res.setHeader('x-ratelimit-limit', String(config.rateLimit.apiMaxPerSession));
      res.setHeader('x-ratelimit-remaining', String(r.remaining));
      if (r.limited) {
        res.setHeader('retry-after', String(r.retryAfterSeconds));
        if (p) {
          await deps.audit.tryWrite(
            { action: 'RATE_LIMITED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId },
              outcome: 'denied', reasonCode: 'api_budget', resourceType: 'route', resourceId: req.path },
            requestInfo(req, deps.trustProxy),
          );
        }
        throw new PortalError(429, 'rate_limited', 'too many requests', {
          details: { retryAfterSeconds: r.retryAfterSeconds },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Tighter budget for uploads and other expensive operations. */
export function uploadRateLimit(deps: MiddlewareDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw unauthorized('unauthenticated', 'authentication required');
      const r = limit(keys.upload(p.sessionId), config.rateLimit.uploadMaxPerSession, config.rateLimit.uploadWindowSeconds);
      if (r.limited) {
        res.setHeader('retry-after', String(r.retryAfterSeconds));
        await deps.audit.tryWrite(
          { action: 'RATE_LIMITED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId },
            outcome: 'denied', reasonCode: 'upload_budget' }, requestInfo(req, deps.trustProxy));
        throw new PortalError(429, 'rate_limited', 'upload limit reached', {
          details: { retryAfterSeconds: r.retryAfterSeconds },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Per-user budget for sensitive mutations (password, MFA, deletion requests). */
export function sensitiveRateLimit(op: string, max?: number): RequestHandler {
  return (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw unauthorized('unauthenticated', 'authentication required');
      const r = limit(
        keys.sensitive(p.userId, op),
        max ?? config.rateLimit.sensitiveMaxPerUser,
        config.rateLimit.sensitiveWindowSeconds,
      );
      if (r.limited) {
        res.setHeader('retry-after', String(r.retryAfterSeconds));
        throw new PortalError(429, 'rate_limited', 'too many attempts', {
          details: { retryAfterSeconds: r.retryAfterSeconds },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Async wrapper so thrown errors reach the error handler. */
export function ah(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * §32 — THE ONLY ERROR SERIALIZER.
 *
 * A PortalError emits its code and safe details. Anything else is logged with
 * the request id and reduced to a generic 500. Stack traces, SQL text, driver
 * messages and provider payloads never leave the process.
 */
export function errorHandler(deps: MiddlewareDeps): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const pe = toPortalError(err);
    const ctx = requestInfo(req, deps.trustProxy);

    if (pe.status >= 500) {
      console.error(
        `[${req.id ?? '-'}] ${req.method} ${req.path} → ${pe.status} ${pe.code}`,
        pe.internalCause instanceof Error
          ? `\n  cause: ${pe.internalCause.message}\n${pe.internalCause.stack}`
          : pe.internalCause ?? '',
      );
    } else if (pe.code === 'internal_resource' || pe.auditReason) {
      console.warn(`[${req.id ?? '-'}] ${req.method} ${req.path} → ${pe.status} ${pe.code} (${pe.auditReason ?? ''})`);
    }

    if (!res.headersSent) {
      fail(res, pe);
    }

    // Genuine authorization failures are always audited. Transport-level
    // refusals (CSRF, rate limit, missing session) are not authorization events
    // and must not pollute the trail with AUTHZ_DENIED noise.
    const AUTHZ_CODES = new Set([
      'forbidden', 'not_found', 'mutation_denied', 'field_not_writable',
      'internal_resource', 'tenant_mismatch', 'client_mismatch',
      'resource_not_accessible',
    ]);
    // `alreadyAudited` means the guard that refused the request wrote the event
    // itself, with a more specific reason code than the generic one derivable
    // from the HTTP error. Writing a second row would double-count the attempt.
    if (AUTHZ_CODES.has(pe.code) && !pe.alreadyAudited) {
      const p = req.principal;
      void deps.audit.tryWrite(
        {
          action: pe.code === 'field_not_writable' ? 'FIELD_TAMPER_ATTEMPT'
            : pe.code === 'mutation_denied' ? 'MUTATION_DENIED'
            : 'AUTHZ_DENIED',
          actor: p
            ? { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId }
            : { kind: 'anonymous' },
          outcome: 'denied',
          reasonCode: pe.auditReason ?? pe.code,
          // Prefer the entity the error names; fall back to the route so every
          // denial still records where it happened.
          resourceType: pe.resource?.type ?? 'route',
          resourceId: (pe.resource?.id ?? `${req.method} ${req.path}`).slice(0, 200),
        },
        ctx,
      );
    }
  };
}

/**
 * §46 · uniform tamper refusal, applied to EVERY state-changing client route.
 *
 * zod strips unknown keys, which is safe but silent: an attacker probing for
 * mass assignment gets a 200, and the firm's security reviewer sees nothing.
 * This guard runs before the schema, refuses the request outright, and writes a
 * FIELD_TAMPER_ATTEMPT event naming the fields that were offered.
 *
 * Nested objects and arrays are scanned too — `{ "profile": { "tenant_id": … } }`
 * is the same attack with an extra layer of wrapping, and a route that accepts a
 * list must not become a smuggling channel.
 *
 * @param exempt field names this route legitimately owns (e.g. a deadline's
 *               own `status`, which the client is expected to update).
 */
export function tamperGuard(c: Container, exempt: string[] = []) {
  const allow = new Set(exempt.map((k) => normalizeFieldKey(k)));

  const collect = (value: unknown, depth: number, into: Set<string>): void => {
    if (depth > 4 || value === null || typeof value !== 'object') return;
    const entries = Array.isArray(value)
      ? value.slice(0, 100).map((v, i) => [String(i), v] as [string, unknown])
      : Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries) {
      const norm = normalizeFieldKey(k);
      if (FORBIDDEN_FIELDS.has(norm) && !allow.has(norm)) into.add(k);
      if (v && typeof v === 'object') collect(v, depth + 1, into);
    }
  };

  return (req: Parameters<typeof requestInfo>[0], _res: unknown, next: (e?: unknown) => void) => {
    try {
      const body = (req as { body?: unknown }).body;
      if (!body || typeof body !== 'object') return next();

      const hits = new Set<string>();
      collect(body, 0, hits);
      if (!hits.size) return next();

      const p = (req as { principal?: import('../auth/session.js').Principal | null }).principal;
      void c.audit.tryWrite(
        {
          action: 'FIELD_TAMPER_ATTEMPT',
          actor: p
            ? { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId }
            : { kind: 'anonymous' },
          outcome: 'denied',
          reasonCode: 'protected_field_in_payload',
          resourceType: 'route',
          resourceId: `${req.method} ${req.path}`.slice(0, 200),
          metadata: { fields: [...hits].slice(0, 20) },
        },
        requestInfo(req, c.trustProxy),
      );
      throw forbidden('field_not_writable', 'this field cannot be set from the client portal',
        'protected_field_in_payload', { alreadyAudited: true });
    } catch (err) {
      next(err);
    }
  };
}

export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    res.status(404).json({ ok: false, error: { code: 'not_found', message: 'not found' } });
  };
}
