/**
 * FIRM OS SESSIONS (§52)
 *
 * The client portal has `session.ts`. This is the firm equivalent and the two
 * share nothing but the crypto helpers: different cookie, different table,
 * different principal type, different TTLs, different SameSite default.
 *
 * WHY A SEPARATE SESSION IS A SECURITY PROPERTY, NOT A CONVENIENCE
 *   A lawyer at this firm may also be a client of it. If both audiences shared a
 *   session, then a CSRF token minted for the client portal would be presentable
 *   to a firm endpoint, and a bug in one audience's guard would become a bug in
 *   the other's. Two sessions means two independent authorization surfaces, and
 *   the only thing they share is the `users` row that proves the password.
 *
 * WHAT IS RE-RESOLVED ON EVERY REQUEST
 *   Membership status, roles, permissions, departments, practice areas and
 *   financial ceilings all come from the database on every request. The session
 *   row stores a `role_snapshot` for display and forensics only — it is never
 *   consulted for an authorization decision. Suspending a member or revoking a
 *   role therefore takes effect on their next request, not at session expiry.
 *
 * WHAT IS FROZEN AT MINT TIME
 *   tenant_id and membership_id. A firm session cannot be re-pointed at another
 *   firm; switching tenants means authenticating again and minting a new
 *   session. That is what makes the multi-firm switcher safe.
 */
import type { Request, Response } from 'express';
import type { FirmRepo } from '../db/firm-repo.js';
import { config } from '../config.js';
import { hashToken, newId, randomToken, hashIp } from '../lib/crypto.js';
import { clientIp, geoHint, parseUserAgent } from '../lib/http.js';
import { PortalError, unauthorized } from '../lib/errors.js';
import { issueCsrfToken, clearCsrfToken } from './csrf.js';
import { PermissionEngine, type FirmPrincipal } from '../domain/permissions.js';
import type { Row, Scope } from '../db/types.js';

/** The firm principal as the request layer sees it: principal + session facts. */
export interface FirmSession {
  readonly principal: FirmPrincipal;
  readonly sessionId: string;
  readonly sessionExpiresAt: string;
  readonly remembered: boolean;
  readonly mfaVerified: boolean;
  /** Every tenant where this user holds an active membership (the switcher). */
  readonly tenants: readonly {
    membershipId: string;
    tenantId: string;
    slug: string;
    tenantName: string;
    tenantNameAr: string | null;
    jobTitle: string | null;
    jobTitleAr: string | null;
  }[];
}

export interface FirmLoginOptions {
  remember?: boolean;
  mfaVerified?: boolean;
  trustedDeviceId?: string | null;
}

export class FirmSessionManager {
  constructor(
    private readonly firm: FirmRepo,
    private readonly engine: PermissionEngine,
  ) {}

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: config.firmSession.secureCookie,
      sameSite: config.firmSession.sameSite,
      path: '/',
      domain: config.firmSession.domain,
    } as const;
  }

  /**
   * Mints a session for an already-authenticated membership.
   *
   * Takes the principal rather than a user row: the caller has already proved
   * the password AND that an active membership exists in the target tenant.
   * This method does not re-check the password and must never be reachable from
   * a handler that has not done both.
   */
  async create(
    req: Request,
    res: Response,
    principal: FirmPrincipal,
    opts: FirmLoginOptions = {},
  ): Promise<{ sessionId: string; token: string }> {
    const token = randomToken(32);
    const now = Date.now();
    const remember = opts.remember === true;
    const idleSeconds = remember
      ? config.firmSession.rememberIdleTtlSeconds
      : config.firmSession.idleTtlSeconds;

    const sessionId = newId();
    const ua = parseUserAgent(req.header('user-agent'));
    const ip = clientIp(req, Boolean(process.env.TRUST_PROXY));

    // The snapshot records what the member held AT MINT TIME. It is written for
    // the audit trail ("they were a PARALEGAL when this session started") and is
    // deliberately not read back for any decision.
    const roleSnapshot = JSON.stringify({
      roles: principal.roles.map((r) => r.code),
      permissions: principal.permissions.size,
      practiceAreas: [...principal.practiceAreas],
      ceilings: principal.ceilings,
    });

    await this.firm.createFirmSession({
      id: sessionId,
      membership_id: principal.membershipId,
      user_id: principal.userId,
      // Frozen. A session can never be re-pointed at another firm.
      tenant_id: principal.tenantId,
      token_hash: hashToken(token),
      created_at: new Date(now).toISOString(),
      last_activity: new Date(now).toISOString(),
      expires_at: new Date(now + config.firmSession.absoluteTtlSeconds * 1000).toISOString(),
      idle_expires_at: new Date(now + idleSeconds * 1000).toISOString(),
      ip_hash: hashIp(ip),
      ip_country: geoHint(req),
      user_agent: (req.header('user-agent') || '').slice(0, 400) || null,
      device_label: ua.deviceLabel,
      browser: ua.browser,
      os: ua.os,
      mfa_verified_at: opts.mfaVerified ? new Date(now).toISOString() : null,
      trusted_device_id: opts.trustedDeviceId ?? null,
      role_snapshot: roleSnapshot,
    });

    res.cookie(config.firmSession.cookieName, token, {
      ...this.cookieOptions(),
      maxAge: config.firmSession.absoluteTtlSeconds * 1000,
    });

    // Mirror onto the request so `resolve()` sees the session we just minted,
    // rather than forcing the login handler to duplicate this logic.
    if (req.cookies && typeof req.cookies === 'object') {
      req.cookies[config.firmSession.cookieName] = token;
    }

    return { sessionId, token };
  }

  /**
   * Resolves the firm session cookie into a FirmSession, or null.
   *
   * Null means "no usable firm session" for ANY reason — absent cookie, unknown
   * token, revoked, expired, membership suspended, membership gone. Callers must
   * not be able to distinguish those, because the distinction is an oracle.
   */
  async resolve(req: Request, res: Response): Promise<FirmSession | null> {
    const token = req.cookies?.[config.firmSession.cookieName];
    if (!token || typeof token !== 'string') return null;

    const session = await this.firm.getFirmSessionByTokenHash(hashToken(token));
    if (!session || session.revoked_at) return null;

    const now = Date.now();
    const absolute = new Date(String(session.expires_at)).getTime();
    const idle = new Date(String(session.idle_expires_at)).getTime();
    if (!Number.isFinite(absolute) || !Number.isFinite(idle) || absolute <= now || idle <= now) {
      await this.firm.revokeFirmSession(String(session.id), 'expired');
      this.clearCookies(res);
      return null;
    }

    /*
      SWITCH TO THE FIRM ROLE BEFORE RE-RESOLVING THE GRAPH.

      `resolveByMembershipId` reads `firm_memberships` — including the §73
      authority ceilings — plus roles, permissions and practice areas. Those are
      `firm_api`'s tables, and until this point the connection is `portal_api`,
      which holds only the seven narrow columns the LOGIN lookup needs (0011).

      The right moment to switch is here rather than by widening the auth-phase
      grant, because here the identity is no longer in question: the caller
      presented the 256-bit session token, it hashed to a live, unrevoked,
      unexpired row, and that row names the membership and tenant. Nothing is
      inferred. Moving the switch any earlier is impossible (the token has not been
      checked yet); moving it later means the graph is read by the wrong role.

      Widening `portal_api` at the auth phase instead would have handed an
      unauthenticated read path the firm's financial-authority ceilings — the least
      appropriate columns in the schema for that path, and the exact trade this
      avoids.
    */
    const scope = (req as { scope?: Scope }).scope;
    if (scope) {
      await scope.setContext({
        phase: 'firm',
        tenantId: String(session.tenant_id),
        userId: String(session.user_id),
        clientIds: [],
        membershipId: String(session.membership_id),
      });
    }

    // Re-resolve the whole authorization graph. This is the line that makes
    // "revoke a role and it takes effect immediately" true.
    const principal = await this.engine.resolveByMembershipId(String(session.membership_id));
    if (!principal) {
      await this.firm.revokeFirmSession(String(session.id), 'membership_inactive');
      this.clearCookies(res);
      return null;
    }

    // The session's frozen tenant must still be the membership's tenant. It
    // always is unless someone edited the row by hand, but checking costs one
    // comparison and closes a tampering path.
    if (principal.tenantId !== String(session.tenant_id)) {
      await this.firm.revokeFirmSession(String(session.id), 'tenant_mismatch');
      this.clearCookies(res);
      return null;
    }

    const lastActivityAt = new Date(String(session.last_activity)).getTime();
    const remembered =
      idle - lastActivityAt > config.firmSession.idleTtlSeconds * 1000 + 60_000;
    const idleSeconds = remembered
      ? config.firmSession.rememberIdleTtlSeconds
      : config.firmSession.idleTtlSeconds;
    const nextIdle = Math.min(now + idleSeconds * 1000, absolute);
    // Throttle: at most one write per 60 s of activity.
    if (now - lastActivityAt > 60_000) {
      await this.firm.touchFirmSession(String(session.id), new Date(nextIdle).toISOString());
    }

    const mfaVerified =
      !principal.mfaEnabled || Boolean(session.mfa_verified_at) || Boolean(session.trusted_device_id);

    const tenants = await this.firm.listActiveMemberships(principal.userId);

    return {
      principal: this.engine.withMfaVerified(principal, mfaVerified),
      sessionId: String(session.id),
      sessionExpiresAt: new Date(absolute).toISOString(),
      remembered,
      mfaVerified,
      tenants,
    };
  }

  /** Throws 401 unless a fully resolved firm session is present. */
  async require(req: Request, res: Response): Promise<FirmSession> {
    const s = await this.resolve(req, res);
    if (!s) throw unauthorized('unauthenticated', 'firm authentication required');
    return s;
  }

  clearCookies(res: Response): void {
    res.clearCookie(config.firmSession.cookieName, this.cookieOptions() as never);
    clearCsrfToken(res, 'firm');
  }

  /** Binds the firm CSRF token to the freshly minted firm session. */
  bindCsrf(res: Response, sessionId: string): string {
    return issueCsrfToken(res, sessionId, 'firm');
  }

  async destroy(req: Request, res: Response): Promise<void> {
    const token = req.cookies?.[config.firmSession.cookieName];
    if (token && typeof token === 'string') {
      const session = await this.firm.getFirmSessionByTokenHash(hashToken(token));
      if (session && !session.revoked_at) {
        await this.firm.revokeFirmSession(String(session.id), 'logout');
      }
    }
    this.clearCookies(res);
  }

  /**
   * Ends every live session for a membership. Called on suspension, on role
   * change and on "sign out everywhere" — a privilege change must not leave an
   * old session running with the previous authority cached in a browser tab.
   */
  async revokeAll(membershipId: string, reason: string): Promise<number> {
    return this.firm.revokeAllFirmSessions(membershipId, reason);
  }
}

/** Express augmentation, kept next to the manager that fills it. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      firm?: FirmSession;
    }
  }
}

export type { Row };

/**
 * Guard for firm routes. Distinct from `requireSession` because the refusal must
 * not look like the portal's: a caller with no firm session gets a 401 that
 * names nothing about the firm's structure.
 */
export function requireFirmSession(): (req: Request, res: Response, next: (e?: unknown) => void) => void {
  return (req, _res, next) => {
    try {
      if (!req.firm) throw unauthorized('unauthenticated', 'firm authentication required');
      const s = req.firm;
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
