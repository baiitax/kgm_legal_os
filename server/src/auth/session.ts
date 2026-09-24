/**
 * Session management (§7).
 *
 *   - Opaque 256-bit token in an HttpOnly, SameSite=Lax cookie. No JWT is
 *     exposed to the browser, so there is no client-side token to tamper with
 *     and nothing to store in localStorage.
 *   - Only the SHA-256 hash of the token is persisted. A database leak yields
 *     no usable sessions.
 *   - Dual expiry: an ABSOLUTE ceiling that no amount of activity extends, and
 *     an IDLE timeout that activity refreshes. "Remember this device" extends
 *     the idle window only — never the absolute ceiling (§5).
 *   - The session freezes tenant_id/client_id at mint time. Authorization is
 *     re-resolved from client_users on every request, so removing a contact in
 *     the Internal Firm OS takes effect immediately without waiting for expiry.
 */
import type { Request, Response } from 'express';
import type { Repo } from '../db/repo.js';
import { config } from '../config.js';
import { hashToken, newId, randomToken } from '../lib/crypto.js';
import { clientIp, geoHint, parseUserAgent } from '../lib/http.js';
import { PortalError, unauthorized } from '../lib/errors.js';
import { issueCsrfToken, clearCsrfToken } from './csrf.js';
import { hashIp, deviceFingerprint } from '../lib/crypto.js';
import type { Row } from '../db/types.js';
import { toBool, toIso } from '../db/types.js';

export interface Principal {
  userId: string;
  email: string;
  sessionId: string;
  tenantId: string;
  /** Every client entity this user is authorized for, in this tenant. */
  clientIds: string[];
  primaryClientId: string;
  clientUser: {
    id: string;
    displayName: string;
    displayNameAr: string | null;
    jobTitle: string | null;
    phone: string | null;
    portalRole: string;
  };
  language: 'ar' | 'en';
  calendar: 'islamic-umalqura' | 'gregory';
  mfaEnabled: boolean;
  mfaVerified: boolean;
  emailVerified: boolean;
  sessionExpiresAt: string;
  remembered: boolean;
}

export interface LoginOptions {
  remember?: boolean;
  mfaVerified?: boolean;
  trustedDeviceId?: string | null;
}

export class SessionManager {
  constructor(private readonly repo: Repo) {}

  private cookieOptions(res: Response) {
    return {
      httpOnly: true,
      secure: config.session.secureCookie,
      sameSite: config.session.sameSite,
      path: '/',
      domain: config.session.domain,
    } as const;
  }

  async create(
    res: Response,
    req: Request,
    user: Row,
    binding: { tenantId: string; clientId: string },
    opts: LoginOptions = {},
  ): Promise<{ sessionId: string; token: string }> {
    const token = randomToken(32);
    const now = Date.now();
    const remember = opts.remember === true;
    const idleSeconds = remember
      ? config.session.rememberIdleTtlSeconds
      : config.session.idleTtlSeconds;

    const sessionId = newId();
    const ua = parseUserAgent(req.header('user-agent'));
    const ip = clientIp(req, Boolean(process.env.TRUST_PROXY));

    await this.repo.createSession({
      id: sessionId,
      user_id: String(user.id),
      // Frozen at mint time. A session can never be re-pointed at another
      // tenancy or client afterwards.
      tenant_id: binding.tenantId,
      client_id: binding.clientId,
      token_hash: hashToken(token),
      created_at: new Date(now).toISOString(),
      last_activity: new Date(now).toISOString(),
      // Absolute ceiling — activity never extends this.
      expires_at: new Date(now + config.session.absoluteTtlSeconds * 1000).toISOString(),
      idle_expires_at: new Date(now + idleSeconds * 1000).toISOString(),
      ip_hash: hashIp(ip),
      ip_country: geoHint(req),
      user_agent: (req.header('user-agent') || '').slice(0, 400) || null,
      device_label: ua.deviceLabel,
      browser: ua.browser,
      os: ua.os,
      mfa_verified_at: opts.mfaVerified ? new Date(now).toISOString() : null,
      trusted_device_id: opts.trustedDeviceId ?? null,
    });

    res.cookie(config.session.cookieName, token, {
      ...this.cookieOptions(res),
      maxAge: config.session.absoluteTtlSeconds * 1000,
    });

    // Mirror the cookie onto the request so `resolve()` can see the session we
    // just minted within the SAME request. Without this, the login handler
    // would have to duplicate the principal-resolution logic — and duplicated
    // authorization logic is exactly how the two paths drift apart.
    if (req.cookies && typeof req.cookies === 'object') {
      req.cookies[config.session.cookieName] = token;
    }

    return { sessionId, token };
  }

  /**
   * Resolves the caller's identity from the session cookie.
   *
   * Returns null for "no/invalid session" so that route guards can decide
   * between a redirect (page) and a 401 (API). Never throws on absence.
   */
  async resolve(req: Request, res: Response): Promise<Principal | null> {
    const token = req.cookies?.[config.session.cookieName];
    if (!token || typeof token !== 'string') return null;

    const session = await this.repo.getSessionByTokenHash(hashToken(token));
    if (!session) return null;
    if (session.revoked_at) return null;

    const now = Date.now();
    const absolute = new Date(String(session.expires_at)).getTime();
    const idle = new Date(String(session.idle_expires_at)).getTime();
    if (absolute <= now || idle <= now) {
      await this.repo.revokeSession(String(session.id), 'idle');
      this.clearCookies(res);
      return null;
    }

    const user = await this.repo.getUserById(String(session.user_id));
    if (!user || user.status !== 'active') {
      await this.repo.revokeSession(String(session.id), 'admin');
      this.clearCookies(res);
      return null;
    }

    // Re-resolve authorization from the join on EVERY request. If the firm
    // removed this contact, access ends immediately.
    const links = await this.repo.getClientUsersForUser(String(user.id));
    const tenantId = session.tenant_id ? String(session.tenant_id) : null;
    const active = links.filter((l) => !tenantId || String(l.tenant_id) === tenantId);
    if (!active.length || !tenantId) {
      await this.repo.revokeSession(String(session.id), 'admin');
      this.clearCookies(res);
      return null;
    }

    const primary =
      active.find((l) => String(l.client_id) === String(session.client_id)) ??
      active.find((l) => l.portal_role === 'client_primary') ??
      active[0];

    // Sliding idle refresh, capped by the absolute ceiling.
    // "Remembered" is derived from the size of the idle window that was
    // actually granted, so it is a fact about the session, not a guess.
    const lastActivityAt = new Date(String(session.last_activity)).getTime();
    const remembered =
      idle - lastActivityAt > config.session.idleTtlSeconds * 1000 + 60_000;
    const idleSeconds = remembered
      ? config.session.rememberIdleTtlSeconds
      : config.session.idleTtlSeconds;
    const nextIdle = Math.min(now + idleSeconds * 1000, absolute);
    // Throttle writes: at most one touch per 60 s of activity.
    if (now - new Date(String(session.last_activity)).getTime() > 60_000) {
      await this.repo.touchSession(
        String(session.id),
        new Date(now).toISOString(),
        new Date(nextIdle).toISOString(),
      );
    }

    const mfaEnabled = toBool(user.mfa_enabled);
    const mfaVerified =
      !mfaEnabled || Boolean(session.mfa_verified_at) || Boolean(session.trusted_device_id);

    return {
      userId: String(user.id),
      email: String(user.email),
      sessionId: String(session.id),
      tenantId,
      clientIds: active.map((l) => String(l.client_id)),
      primaryClientId: String(primary.client_id),
      clientUser: {
        id: String(primary.id),
        displayName: String(primary.display_name),
        displayNameAr: (primary.display_name_ar as string | null) ?? null,
        jobTitle: (primary.job_title as string | null) ?? null,
        phone: (primary.phone as string | null) ?? null,
        portalRole: String(primary.portal_role),
      },
      language: (user.preferred_language === 'en' ? 'en' : 'ar') as 'ar' | 'en',
      calendar: (user.preferred_calendar === 'gregory' ? 'gregory' : 'islamic-umalqura') as
        | 'islamic-umalqura'
        | 'gregory',
      mfaEnabled,
      mfaVerified,
      emailVerified: Boolean(user.email_verified_at),
      sessionExpiresAt: new Date(absolute).toISOString(),
      remembered,
    };
  }

  /** Throws unless a fully authorized, MFA-satisfied principal is present. */
  async require(req: Request, res: Response): Promise<Principal> {
    const p = await this.resolve(req, res);
    if (!p) throw unauthorized('unauthenticated', 'authentication required');
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
    return p;
  }

  clearCookies(res: Response): void {
    res.clearCookie(config.session.cookieName, this.cookieOptions(res) as never);
    clearCsrfToken(res);
  }

  /** Establishes the CSRF token bound to the freshly minted session. */
  bindCsrf(res: Response, sessionId: string): string {
    return issueCsrfToken(res, sessionId);
  }

  async destroy(req: Request, res: Response): Promise<void> {
    const token = req.cookies?.[config.session.cookieName];
    if (token && typeof token === 'string') {
      const session = await this.repo.getSessionByTokenHash(hashToken(token));
      if (session && !session.revoked_at) {
        await this.repo.revokeSession(String(session.id), 'logout');
      }
    }
    this.clearCookies(res);
  }

  async destroyAllOthers(userId: string, keepSessionId: string): Promise<number> {
    const res = await this.repo.revokeSessionsForUser(userId, 'all_others', keepSessionId);
    return res.changes;
  }

  async destroyBySessionId(userId: string, sessionId: string): Promise<boolean> {
    const s = await this.repo.getSessionForUser(userId, sessionId);
    if (!s || s.revoked_at) return false;
    await this.repo.revokeSession(sessionId, 'admin');
    return true;
  }

  async list(userId: string, currentSessionId: string) {
    const rows = await this.repo.listActiveSessions(userId);
    return rows.map((r) => ({
      id: String(r.id),
      current: String(r.id) === currentSessionId,
      deviceLabel: (r.device_label as string | null) ?? 'Unknown device',
      browser: (r.browser as string | null) ?? 'Unknown browser',
      os: (r.os as string | null) ?? null,
      ipCountry: (r.ip_country as string | null) ?? null,
      createdAt: toIso(r.created_at),
      lastActivity: toIso(r.last_activity),
      expiresAt: toIso(r.expires_at),
      mfaVerifiedAt: toIso(r.mfa_verified_at),
    }));
  }

  async markMfaVerified(sessionId: string): Promise<void> {
    await this.repo.markSessionMfaVerified(sessionId, new Date().toISOString());
  }

  /**
   * Device fingerprint used for MFA "trust this device" (§8). Time-boxed and
   * revocable — never permanent.
   */
  async registerDevice(req: Request, userId: string, trustForMfa: boolean) {
    const ua = parseUserAgent(req.header('user-agent'));
    const ip = clientIp(req, Boolean(process.env.TRUST_PROXY));
    const fp = deviceFingerprint(req.header('user-agent') || '', ip ? hashIp(ip) : null, ua.family);
    const now = new Date().toISOString();

    const existing = await this.repo.getDeviceByFingerprint(userId, fp);
    const id = existing ? String(existing.id) : newId();
    const trustedUntil = trustForMfa
      ? new Date(Date.now() + config.session.trustedDeviceTtlDays * 86_400_000).toISOString()
      : null;

    await this.repo.upsertDevice({
      id,
      user_id: userId,
      fingerprint_hash: fp,
      label: `${ua.deviceLabel} · ${ua.browser}`,
      trusted_until: trustedUntil,
      mfa_trusted: trustForMfa,
      last_seen_at: now,
      created_at: existing ? toIso(existing.created_at) : now,
    });

    return { id, fingerprintHash: fp, trustedUntil, ua };
  }

  async isDeviceMfaTrusted(req: Request, userId: string): Promise<string | null> {
    const ua = parseUserAgent(req.header('user-agent'));
    const ip = clientIp(req, Boolean(process.env.TRUST_PROXY));
    const fp = deviceFingerprint(req.header('user-agent') || '', ip ? hashIp(ip) : null, ua.family);
    const device = await this.repo.getDeviceByFingerprint(userId, fp);
    if (!device || device.revoked_at) return null;
    if (!toBool(device.mfa_trusted)) return null;
    const until = device.trusted_until ? new Date(String(device.trusted_until)).getTime() : 0;
    if (until <= Date.now()) return null;
    return String(device.id);
  }

  async listDevices(userId: string, currentFingerprint?: string) {
    const rows = await this.repo.listDevices(userId);
    return rows.map((r) => ({
      id: String(r.id),
      label: (r.label as string | null) ?? 'Device',
      current: currentFingerprint ? String(r.id) === currentFingerprint : false,
      mfaTrusted: toBool(r.mfa_trusted),
      trustedUntil: toIso(r.trusted_until),
      lastSeenAt: toIso(r.last_seen_at),
      revokedAt: toIso(r.revoked_at),
    }));
  }

  async revokeDevice(userId: string, deviceId: string): Promise<boolean> {
    const res = await this.repo.revokeDevice(userId, deviceId);
    return res.changes > 0;
  }
}
