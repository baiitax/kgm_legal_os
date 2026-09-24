/**
 * CSRF protection (§7).
 *
 * Model: signed double-submit cookie.
 *
 *   - The server sets a readable (NOT httpOnly) cookie containing a signed
 *     token bound to the current session id and an expiry.
 *   - The SPA reads that cookie and echoes it in the `X-CSRF-Token` header on
 *     every state-changing request.
 *   - The server verifies the HMAC, the expiry, and — critically — that the
 *     token's embedded session id matches the authenticated session.
 *
 * Why bind to the session id:
 *   An attacker can read a cross-origin victim's cookie only via XSS, but they
 *   CAN cause a browser to *send* it. Binding the token to the session means a
 *   token minted before login cannot be replayed after login, which closes the
 *   login-CSRF / session-fixation variant.
 *
 * The signing key is the server master key, so tokens cannot be forged by a
 * party that can set cookies but cannot read server secrets.
 */
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config, masterKey } from '../config.js';
import { timingSafeEqualStr } from '../lib/crypto.js';
import { PortalError } from '../lib/errors.js';

const b64u = (b: Buffer) => b.toString('base64url');

/**
 * Which product a CSRF token belongs to.
 *
 * The Firm OS and the client portal run on the same origin, so a shared CSRF
 * cookie would be a shared authorization surface: a token minted for a client
 * session would be presentable to a firm endpoint. Separate cookie names already
 * prevent the accidental case; embedding the audience in the signed payload
 * prevents the deliberate one (an attacker who can set cookies cannot forge the
 * HMAC, so they cannot relabel a portal token as a firm token).
 */
export type CsrfAudience = 'portal' | 'firm';

interface AudienceSettings {
  readonly csrfCookieName: string;
  readonly csrfHeader: string;
  readonly ttlSeconds: number;
  readonly secureCookie: boolean;
  readonly sameSite: 'lax' | 'strict' | 'none';
  readonly domain: string | undefined;
}

function settingsFor(audience: CsrfAudience): AudienceSettings {
  return audience === 'firm'
    ? {
        csrfCookieName: config.firmSession.csrfCookieName,
        csrfHeader: config.firmSession.csrfHeader,
        ttlSeconds: config.firmSession.absoluteTtlSeconds,
        secureCookie: config.firmSession.secureCookie,
        sameSite: config.firmSession.sameSite,
        domain: config.firmSession.domain,
      }
    : {
        csrfCookieName: config.session.csrfCookieName,
        csrfHeader: config.session.csrfHeader,
        ttlSeconds: config.session.absoluteTtlSeconds,
        secureCookie: config.session.secureCookie,
        sameSite: config.session.sameSite,
        domain: config.session.domain,
      };
}

interface CsrfPayload {
  /** null for a pre-authentication token. */
  sid: string | null;
  exp: number;
  /** Random nonce so two tokens for the same session differ. */
  n: string;
  /** Absent on tokens minted before the Firm OS existed; treated as 'portal'. */
  aud?: CsrfAudience;
}

function sign(payload: CsrfPayload): string {
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = crypto.createHmac('sha256', masterKey).update(body).digest();
  return `${body}.${b64u(mac)}`;
}

function verify(token: string): CsrfPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expected = crypto.createHmac('sha256', masterKey).update(body).digest();
  if (!timingSafeEqualStr(b64u(expected), mac)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CsrfPayload;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function issueCsrfToken(
  res: Response,
  sessionId: string | null,
  audience: CsrfAudience = 'portal',
): string {
  const cfg = settingsFor(audience);
  const token = sign({
    sid: sessionId,
    exp: Math.floor(Date.now() / 1000) + cfg.ttlSeconds,
    n: crypto.randomBytes(8).toString('base64url'),
    aud: audience,
  });
  res.cookie(cfg.csrfCookieName, token, {
    httpOnly: false, // the SPA must be able to read it
    secure: cfg.secureCookie,
    sameSite: cfg.sameSite,
    path: '/',
    domain: cfg.domain,
    maxAge: cfg.ttlSeconds * 1000,
  });
  return token;
}

export function clearCsrfToken(res: Response, audience: CsrfAudience = 'portal'): void {
  const cfg = settingsFor(audience);
  res.clearCookie(cfg.csrfCookieName, {
    path: '/',
    secure: cfg.secureCookie,
    sameSite: cfg.sameSite,
    domain: cfg.domain,
  });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Validates the CSRF token for a state-changing request.
 *
 * @param sessionId the authenticated session id, or null when unauthenticated
 * @param opts.acceptAnonymous  allow a token bound to `sid=null`. Used only on
 *   the flows that ESTABLISH a session (login, invitation acceptance, password
 *   reset). A browser that is already signed in holds a session-bound token,
 *   and re-signing-in must not fail because of it — but an authenticated
 *   endpoint never accepts an anonymous token.
 * @throws PortalError(403, 'csrf_failed')
 */
export function assertCsrf(
  req: Request,
  sessionId: string | null,
  opts: { acceptAnonymous?: boolean; audience?: CsrfAudience } = {},
): void {
  if (SAFE_METHODS.has(req.method)) return;

  const audience = opts.audience ?? 'portal';
  const cfg = settingsFor(audience);
  const headerToken = req.header(cfg.csrfHeader);
  const cookieToken = req.cookies?.[cfg.csrfCookieName];

  // Both must be present AND equal — the double-submit check. Then the signed
  // payload must verify and be bound to the right session.
  if (!headerToken || !cookieToken) {
    throw new PortalError(403, 'csrf_failed', 'missing csrf token');
  }
  if (!timingSafeEqualStr(headerToken, cookieToken)) {
    throw new PortalError(403, 'csrf_failed', 'csrf token mismatch');
  }

  const payload = verify(headerToken);
  if (!payload) {
    throw new PortalError(403, 'csrf_failed', 'csrf token invalid or expired');
  }
  // Cross-audience replay: a portal token presented to a firm endpoint. The
  // cookie names differ, so reaching this branch means the token was obtained
  // some other way — which is precisely when it must be refused.
  if ((payload.aud ?? 'portal') !== audience) {
    throw new PortalError(403, 'csrf_failed', 'csrf token audience mismatch');
  }
  const tokenSid = payload.sid ?? null;
  if (tokenSid === sessionId) return;
  if (opts.acceptAnonymous && tokenSid === null) return;
  // A pre-login token presented to an authenticated endpoint (or a token from a
  // different session) is refused.
  throw new PortalError(403, 'csrf_failed', 'csrf token not bound to session');
}

/**
 * Middleware for unauthenticated, state-changing endpoints (login, password
 * reset, invitation acceptance). Ensures a pre-session token exists.
 */
export function ensureAnonymousCsrf(
  req: Request,
  res: Response,
  next: () => void,
  audience: CsrfAudience = 'portal',
): void {
  const cfg = settingsFor(audience);
  const existing = req.cookies?.[cfg.csrfCookieName];
  const parsed = existing ? verify(existing) : null;
  const valid = parsed && (parsed.aud ?? 'portal') === audience ? parsed : null;
  // Only mint a token when there is no usable one. Overwriting a valid
  // session-bound token would break re-authentication for a browser that is
  // already signed in. A token bound to a session that no longer resolves
  // (revoked by a password change, expired, signed out) is stale and IS
  // replaced, otherwise the browser is left holding a token it can never use.
  if (!valid || (valid.sid !== null && !req.principal)) issueCsrfToken(res, null, audience);
  next();
}

/** Firm OS variant of `ensureAnonymousCsrf`. */
export function ensureAnonymousFirmCsrf(req: Request, res: Response, next: () => void): void {
  ensureAnonymousCsrf(req, res, next, 'firm');
}
