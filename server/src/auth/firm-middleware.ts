/**
 * FIRM OS HTTP BOUNDARY (§6, §52, §72)
 *
 * The portal has `middleware.ts`. This is the firm equivalent, and the two are
 * deliberately not merged: a shared guard would be a shared authorization
 * surface, which is the one thing §6 forbids.
 *
 * THE CROSS-AUDIENCE RULE
 *   A request to `/api/firm/*` is answered differently depending on what
 *   credential it presents, and the difference is chosen to leak nothing:
 *
 *     presents a firm cookie (valid)     → resolved, proceeds
 *     presents a firm cookie (invalid)   → 401  — they already knew the door was
 *                                                 there; expiring a session must
 *                                                 not look like a missing route
 *     presents only a client cookie      → 404  — a portal user learns nothing
 *                                                 about the firm API, and the
 *                                                 attempt is audited as an
 *                                                 escalation
 *     presents no cookie at all          → 404, except on the auth endpoints
 *
 *   The 404-for-client rule is what keeps the portal's existing guarantee intact:
 *   from a client session's point of view, the firm API still does not exist.
 *   What changed is that the refusal now comes from a guard that understands both
 *   audiences, rather than from a blanket path prefix.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Container } from '../container.js';
import { config } from '../config.js';
import { PortalError, unauthorized } from '../lib/errors.js';
import { fail } from '../lib/http.js';
import { requestInfo } from '../audit/logger.js';
import { setContextInStore } from '../db/context.js';
import { assertCsrf, ensureAnonymousCsrf } from './csrf.js';
import type { FirmSession } from './firm-session.js';

/** Paths under /api/firm that answer without a firm session. */
const FIRM_PUBLIC_PATHS = new Set([
  '/api/firm/auth/login',
  '/api/firm/auth/csrf',
  '/api/firm/auth/health',
]);

function uniform404(res: Response): void {
  // Byte-identical to the portal's not-found shape, so a client session cannot
  // distinguish "firm route refused" from "no such route".
  res.status(404).json({ ok: false, error: { code: 'not_found', message: 'not found' } });
}

/**
 * Resolves the firm session and switches the request's database context to the
 * firm phase.
 *
 * Runs AFTER `attachPrincipal` (which opened the scope) and re-sets the context
 * on the same scope. `setContext` is explicitly allowed to be called more than
 * once; what is not allowed is a handler calling it, and none can — this is the
 * only firm-side call site.
 */
export function attachFirmPrincipal(c: Container): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      try {
        const scope = req.scope;
        if (!scope) return next();

        const session: FirmSession | null = await c.firmSessions.resolve(req, res);
        req.firm = session ?? undefined;

        if (session) {
          const ctx = {
            phase: 'firm' as const,
            tenantId: session.principal.tenantId,
            userId: session.principal.userId,
            // A firm principal has no client scope. Leaving this empty is what
            // makes every portal-side RLS policy false for them, so a firm
            // session cannot accidentally read through a client policy.
            clientIds: [],
            membershipId: session.principal.membershipId,
          };
          await scope.setContext(ctx);
          setContextInStore(ctx);
        }
        next();
      } catch (err) {
        next(err);
      }
    })();
  };
}

/**
 * The audience gate described at the top of this file.
 */
export function requireFirm(c: Container): RequestHandler {
  return (req, res, next) => {
    const path = req.originalUrl.split('?')[0].toLowerCase();
    const isPublic = FIRM_PUBLIC_PATHS.has(path);

    if (req.firm) return next();

    const hasFirmCookie = Boolean(req.cookies?.[config.firmSession.cookieName]);
    const hasClientSession = Boolean(req.principal);

    // A client-portal caller probing the firm API. Refused as "does not exist"
    // and recorded: this is the row a §72 review looks for.
    //
    // THE WRITE IS AWAITED, DELIBERATELY. It used to be fire-and-forget — the
    // response went out and the escalation row was left to land on its own. On a
    // serverless platform the invocation can be frozen or reclaimed the moment the
    // response is written, so the row that a privilege-escalation review exists to
    // find would be present or absent depending on scheduling. An audit trail with
    // a hole nobody can see is worse than no trail, because the review reads it as
    // complete. `tryWrite` cannot throw, so awaiting it cannot turn a refusal into
    // a 500; it only delays a refusal that is already going to be refused.
    if (hasClientSession) {
      void (async () => {
        await c.audit.tryWrite(
          {
            action: 'ESCALATION_ATTEMPT',
            actor: {
              kind: 'client_user',
              userId: req.principal?.userId ?? null,
              tenantId: req.principal?.tenantId ?? null,
              clientId: req.principal?.primaryClientId ?? null,
            },
            outcome: 'denied',
            reasonCode: 'cross_audience',
            resourceType: 'route',
            resourceId: path.slice(0, 200),
            metadata: { method: req.method, audience: 'firm' },
          },
          requestInfo(req, c.trustProxy),
        );
        uniform404(res);
      })();
      return;
    }

    // Presented a firm credential that did not resolve. They already know the
    // surface exists, so a 401 is honest here and lets the firm SPA react.
    if (hasFirmCookie) {
      return next(unauthorized('unauthenticated', 'firm authentication required'));
    }

    // Nothing at all. Public endpoints continue; everything else does not exist.
    if (isPublic) return next();
    return uniform404(res);
  };
}

/** CSRF for the firm audience. Separate cookie, separate signed audience. */
export function firmCsrfGuard(opts: { acceptAnonymous?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    try {
      assertCsrf(req, req.firm?.sessionId ?? null, {
        acceptAnonymous: opts.acceptAnonymous,
        audience: 'firm',
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Mints an anonymous firm CSRF token so the login form can post. */
export function ensureFirmCsrf(req: Request, res: Response, next: NextFunction): void {
  ensureAnonymousCsrf(req, res, next, 'firm');
}

/**
 * Requires a verified second factor before a critical action (§52).
 *
 * Separate from the permission check because it depends on session state, not on
 * the authorization graph: a Managing Partner who has not completed MFA on this
 * session is refused here even though they hold every permission.
 */
export function requireFirmMfa(): RequestHandler {
  return (req, _res, next) => {
    try {
      const s = req.firm;
      if (!s) throw unauthorized('unauthenticated', 'firm authentication required');
      if (s.principal.mfaEnabled && !s.mfaVerified) {
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

/** Uniform JSON failure for firm routes. Mirrors the portal's `fail`. */
export { fail };
