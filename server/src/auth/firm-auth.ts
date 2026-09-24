/**
 * FIRM OS AUTHENTICATION (§52)
 *
 * The portal has `service.ts`. This is the firm equivalent.
 *
 * WHAT IS SHARED, AND WHY THAT IS SAFE
 *   The `users` row: password hash, failed-attempt counters, `locked_until`, and
 *   MFA enrollment. Sharing the credential is correct — a lawyer has one
 *   password, and burning the same lockout budget at both doors is a feature,
 *   not a leak. What is NOT shared is anything that decides what they may do:
 *   the portal reads `client_users`, this reads `firm_memberships`, and there is
 *   no code path that converts one into the other.
 *
 * THE ENUMERATION INVARIANT (same as the portal)
 *   unknown email, wrong password, disabled account and "correct password but no
 *   firm membership" all produce responses that do not reveal which happened.
 *   A dummy scrypt runs on every failure path so timing is uniform too.
 *
 * TENANT SELECTION IS NOT CLIENT INPUT
 *   A member of several firms signs into one deterministic tenant (the earliest
 *   joined) and receives the list of the others. Switching mints a NEW session
 *   after re-checking the membership against the database. There is no request
 *   shape in which a caller names a tenant and is believed.
 */
import type { Request, Response } from 'express';
import type { FirmRepo } from '../db/firm-repo.js';
import type { FirmSessionManager, FirmSession } from './firm-session.js';
import type { PermissionEngine, FirmPrincipal } from '../domain/permissions.js';
import type { AuditLogger, RequestContextInfo } from '../audit/logger.js';
import { config } from '../config.js';
import {
  decryptSecret, generateOtp, hashToken, newId, randomToken, verifyPassword, verifyTotp,
  hashPassword, needsRehash, maskEmail,
} from '../lib/crypto.js';
import { PortalError, forbidden, unauthorized } from '../lib/errors.js';
import {
  counters, evaluateLockout, keys, limit, nextLockoutTimestamp, progressiveDelayMs,
  resetLimit, sleep,
} from './ratelimit.js';
import { sendEmail, templates } from './email.js';
import { toBool } from '../db/types.js';
import type { Param } from '../db/types.js';

export type FirmLoginResult =
  | { kind: 'session'; session: FirmSession; csrfToken: string }
  | { kind: 'mfa_required'; method: 'totp' | 'email_otp'; maskedDestination: string | null };

/** The firm MFA challenge cookie. Path-scoped so the portal never sees it. */
export const FIRM_MFA_COOKIE = 'kgm_firm_mfa_challenge';
const FIRM_MFA_COOKIE_PATH = '/api/firm/auth';

export class FirmAuthService {
  constructor(
    private readonly firm: FirmRepo,
    private readonly sessions: FirmSessionManager,
    private readonly engine: PermissionEngine,
    private readonly audit: AuditLogger,
  ) {}

  // ==========================================================================
  // LOGIN
  // ==========================================================================
  async login(
    req: Request,
    res: Response,
    ctx: RequestContextInfo,
    input: { email: string; password: string; remember?: boolean },
  ): Promise<FirmLoginResult> {
    const email = (input.email || '').toLowerCase().trim();
    const ip = ctx.ipHash ?? 'unknown';

    // ---- Budgets BEFORE any account lookup, so an unknown address is rate
    // ---- limited exactly like a known one.
    const emailLimit = limit(keys.firmLoginEmail(email), config.rateLimit.loginMaxPerEmail, config.rateLimit.loginWindowSeconds);
    if (emailLimit.limited) {
      await this.audit.tryWrite(
        { action: 'RATE_LIMITED', actor: { kind: 'anonymous' }, outcome: 'denied',
          reasonCode: 'firm_login_email_budget', metadata: { scope: 'email', audience: 'firm' } }, ctx);
      throw this.rateLimited(emailLimit.retryAfterSeconds);
    }
    const ipLimit = limit(keys.firmLoginIp(ip), config.rateLimit.loginMaxPerIp, config.rateLimit.loginWindowSeconds);
    if (ipLimit.limited) {
      await this.audit.tryWrite(
        { action: 'RATE_LIMITED', actor: { kind: 'anonymous' }, outcome: 'denied',
          reasonCode: 'firm_login_ip_budget', metadata: { scope: 'ip', audience: 'firm' } }, ctx);
      throw this.rateLimited(ipLimit.retryAfterSeconds);
    }

    const user = email ? await this.firm.getUserByEmail(email) : undefined;

    // ---- Durable lockout. Shared with the portal by design.
    if (user) {
      const lock = evaluateLockout(
        Number(user.failed_login_count ?? 0),
        user.locked_until ? String(user.locked_until) : null,
      );
      if (lock.locked) {
        await this.record(ctx, 'firm_locked', email, String(user.id));
        throw this.rateLimited(lock.retryAfterSeconds);
      }
    }

    // ---- Exactly one scrypt on every path.
    const passwordMatches = verifyPassword(
      input.password ?? '',
      user?.password_hash ? String(user.password_hash) : null,
    );

    if (!user || !user.password_hash || user.status === 'disabled'
        || user.status === 'deletion_requested' || !passwordMatches) {
      const outcome = !user ? 'firm_unknown_account'
        : user.status === 'disabled' ? 'firm_disabled' : 'firm_bad_password';
      const failedCount = user ? Number(user.failed_login_count ?? 0) + 1 : 0;

      if (user) {
        const lockUntil = nextLockoutTimestamp(failedCount);
        await this.firm.updateUserAuthState(String(user.id), {
          failed_login_count: failedCount,
          ...(lockUntil ? { locked_until: lockUntil, status: 'locked' } : {}),
        });
        if (lockUntil) {
          await this.audit.tryWrite(
            { action: 'ACCOUNT_LOCKED', actor: { kind: 'firm_member', userId: String(user.id) },
              outcome: 'failure', reasonCode: 'max_failed_attempts',
              metadata: { failedCount, audience: 'firm' } }, ctx);
        }
      }

      await this.record(ctx, outcome, email, user ? String(user.id) : null);
      await this.audit.tryWrite(
        { action: 'FIRM_LOGIN_FAILED', actor: { kind: 'anonymous', userId: user ? String(user.id) : null },
          outcome: 'failure', reasonCode: outcome }, ctx);

      await sleep(progressiveDelayMs(failedCount));
      throw unauthorized('invalid_credentials', 'invalid email or password');
    }

    const userId = String(user.id);
    resetLimit(keys.firmLoginEmail(email), keys.firmLoginIp(ip));
    counters.reset(keys.firmLoginEmail(email));

    // ---- Success on the credential. Now the AUDIENCE check: an active firm
    // ---- membership must exist. This is the line that keeps a client user out.
    const memberships = await this.firm.listActiveMemberships(userId);
    if (!memberships.length) {
      await this.record(ctx, 'firm_no_membership', email, userId);
      await this.audit.tryWrite(
        { action: 'FIRM_LOGIN_FAILED', actor: { kind: 'anonymous', userId },
          outcome: 'denied', reasonCode: 'no_active_membership' }, ctx);
      // The password was correct. Saying so would confirm that this address is a
      // client of the firm, so the response stays identical to a bad password —
      // only the audit row knows the difference.
      throw unauthorized('invalid_credentials', 'invalid email or password');
    }

    const patch: Record<string, Param> = {
      failed_login_count: 0,
      locked_until: null,
      status: user.status === 'locked' ? 'active' : String(user.status),
      last_login_at: new Date().toISOString(),
      last_login_ip_hash: ctx.ipHash,
    };
    if (needsRehash(String(user.password_hash))) {
      patch.password_hash = hashPassword(input.password);
      patch.password_updated_at = new Date().toISOString();
    }
    await this.firm.updateUserAuthState(userId, patch);
    await this.record(ctx, 'firm_success', email, userId);

    // Deterministic tenant: the first active membership. `listActiveMemberships`
    // orders by tenant name, so this is stable across requests.
    const target = memberships[0];
    const principal = await this.engine.resolve(userId, target.tenantId);
    if (!principal) {
      // Race: the membership was suspended between the two reads. Refuse.
      await this.audit.tryWrite(
        { action: 'FIRM_LOGIN_FAILED', actor: { kind: 'anonymous', userId },
          outcome: 'denied', reasonCode: 'membership_inactive_at_resolve' }, ctx);
      throw unauthorized('invalid_credentials', 'invalid email or password');
    }

    // ---- MFA gate (§52). Tenant policy can make it mandatory for a role even
    // ---- when the member has not enrolled; that case is refused rather than
    // ---- silently downgraded to password-only.
    const settings = await this.firm.getTenantSettings(principal.tenantId);
    const roleRequiresMfa = (settings?.mfaRequired ?? false)
      && principal.roles.some((r) => r.code === 'MANAGING_PARTNER' || r.code === 'ADMIN');

    if (toBool(user.mfa_enabled)) {
      return this.startMfaChallenge(req, res, ctx, user, principal, roleRequiresMfa);
    }
    if (roleRequiresMfa) {
      await this.audit.tryWrite(
        { action: 'FIRM_LOGIN_FAILED', actor: { kind: 'firm_member', userId, tenantId: principal.tenantId },
          outcome: 'denied', reasonCode: 'mfa_enrollment_required',
          metadata: { membershipId: principal.membershipId } }, ctx);
      throw new PortalError(403, 'mfa_required',
        'multi-factor authentication must be enrolled before signing in to the Firm OS', {
          details: { step: 'enroll_mfa' },
        });
    }

    return this.completeLogin(req, res, ctx, principal, {
      remember: Boolean(input.remember),
    });
  }

  /**
   * Completes a login once the password (and MFA, when enrolled) is proven.
   * Split out so the plain-password path and the MFA path mint sessions through
   * exactly one piece of code.
   */
  private async completeLogin(
    req: Request,
    res: Response,
    ctx: RequestContextInfo,
    principal: FirmPrincipal,
    opts: { remember: boolean; mfaVerified?: boolean; trustedDeviceId?: string | null },
  ): Promise<FirmLoginResult> {
    const { sessionId } = await this.sessions.create(req, res, principal, {
      remember: opts.remember,
      mfaVerified: opts.mfaVerified ?? false,
      trustedDeviceId: opts.trustedDeviceId ?? null,
    });
    const csrfToken = this.sessions.bindCsrf(res, sessionId);

    await this.audit.write(
      { action: 'FIRM_LOGIN',
        actor: { kind: 'firm_member', userId: principal.userId, tenantId: principal.tenantId },
        resourceType: 'firm_session', resourceId: sessionId,
        metadata: {
          membershipId: principal.membershipId,
          roles: principal.roles.map((r) => r.code),
          mfa: opts.mfaVerified ? 'verified' : 'none',
          remember: opts.remember,
        } }, ctx);

    // Re-read through the session manager so the returned object is the same one
    // the next request will resolve — no second copy of the principal shape.
    const session = await this.sessions.resolve(req, res);
    if (!session) throw unauthorized('unauthenticated', 'firm session could not be established');
    return { kind: 'session', session, csrfToken };
  }

  // ==========================================================================
  // MFA
  // ==========================================================================
  private async startMfaChallenge(
    req: Request,
    res: Response,
    ctx: RequestContextInfo,
    user: Record<string, unknown>,
    principal: FirmPrincipal,
    roleRequiresMfa: boolean,
  ): Promise<FirmLoginResult> {
    const method = (user.mfa_method === 'email_otp' ? 'email_otp' : 'totp') as 'totp' | 'email_otp';
    const challenge = randomToken(32);
    const challengeId = newId();
    let codeHash: string | null = null;
    let masked: string | null = null;

    if (method === 'email_otp') {
      const code = generateOtp(6);
      codeHash = hashToken(code);
      masked = maskEmail(String(user.email));
      const t = templates.otp(code,
        'رمز التحقق لتسجيل الدخول إلى نظام المكتب القانوني',
        'Verification code for your Firm OS sign-in');
      await sendEmail({ to: String(user.email), kind: 'firm_login_otp', ...t });
    }

    await this.firm.createAuthToken({
      id: challengeId, user_id: principal.userId, kind: 'firm_mfa_challenge',
      token_hash: hashToken(challenge), code_hash: codeHash,
      expires_at: new Date(Date.now() + config.auth.otpTtlMinutes * 60_000).toISOString(),
      created_ip_hash: ctx.ipHash, created_at: new Date().toISOString(),
    });

    // HttpOnly, path-scoped to the firm auth routes. The browser cannot read it
    // and the portal's own MFA cookie cannot be substituted for it.
    res.cookie(FIRM_MFA_COOKIE, challenge, {
      httpOnly: true, secure: config.firmSession.secureCookie,
      sameSite: config.firmSession.sameSite, path: FIRM_MFA_COOKIE_PATH,
      maxAge: config.auth.otpTtlMinutes * 60_000,
    });

    // The pending tenant is NOT sent to the browser. On verify it is re-derived
    // from the user's own active memberships, so a challenge cannot be replayed
    // into a different firm by editing a request body.
    void roleRequiresMfa;
    await this.record(ctx, 'firm_mfa_required', principal.email, principal.userId);
    return { kind: 'mfa_required', method, maskedDestination: masked };
  }

  async verifyMfa(
    req: Request,
    res: Response,
    ctx: RequestContextInfo,
    input: { code: string; remember?: boolean },
  ): Promise<FirmLoginResult> {
    const challenge = req.cookies?.[FIRM_MFA_COOKIE];
    if (!challenge || typeof challenge !== 'string') {
      throw unauthorized('mfa_required', 'no pending verification');
    }

    const budget = limit(`rl:firmmfa:${hashToken(challenge)}`,
      config.auth.otpMaxAttempts, config.auth.otpTtlMinutes * 60);
    if (budget.limited) throw this.rateLimited(budget.retryAfterSeconds);

    const row = await this.firm.getAuthToken('firm_mfa_challenge', hashToken(challenge));
    if (!row || row.used_at) {
      throw unauthorized('mfa_invalid', 'verification challenge is no longer valid');
    }
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
      throw unauthorized('mfa_invalid', 'verification challenge expired');
    }

    const userId = String(row.user_id);
    const user = await this.firm.getUserById(userId);
    if (!user || user.status === 'disabled') {
      throw unauthorized('mfa_invalid', 'verification failed');
    }

    const method = user.mfa_method === 'email_otp' ? 'email_otp' : 'totp';
    let valid = false;
    if (method === 'totp') {
      const secret = user.mfa_secret_enc ? safeDecrypt(String(user.mfa_secret_enc)) : null;
      valid = Boolean(secret) && verifyTotp(secret as string, String(input.code || '').trim());
    } else {
      const codeHash = row.code_hash ? String(row.code_hash) : null;
      valid = Boolean(codeHash) && codeHash === hashToken(String(input.code || '').trim());
    }

    if (!valid) {
      await this.audit.tryWrite(
        { action: 'FIRM_MFA_FAILED', actor: { kind: 'firm_member', userId },
          outcome: 'failure', reasonCode: 'invalid_code', metadata: { method } }, ctx);
      await sleep(progressiveDelayMs(2));
      throw unauthorized('mfa_invalid', 'verification failed');
    }

    await this.firm.markAuthTokenUsed(String(row.id));
    res.clearCookie(FIRM_MFA_COOKIE, { path: FIRM_MFA_COOKIE_PATH });

    const memberships = await this.firm.listActiveMemberships(userId);
    if (!memberships.length) {
      throw unauthorized('invalid_credentials', 'invalid email or password');
    }
    const principal = await this.engine.resolve(userId, memberships[0].tenantId);
    if (!principal) throw unauthorized('invalid_credentials', 'invalid email or password');

    await this.audit.tryWrite(
      { action: 'FIRM_MFA_VERIFIED', actor: { kind: 'firm_member', userId, tenantId: principal.tenantId },
        outcome: 'success', reasonCode: method, metadata: { membershipId: principal.membershipId } }, ctx);

    return this.completeLogin(req, res, ctx, principal, {
      remember: Boolean(input.remember),
      mfaVerified: true,
    });
  }

  // ==========================================================================
  // TENANT SWITCHING (multi-firm SaaS)
  // ==========================================================================
  /**
   * Switches the active tenant by minting a NEW session and revoking the old one.
   *
   * The requested tenant is checked against the member's own active memberships.
   * Naming a tenant you do not belong to is refused AND audited: it is the
   * multi-firm equivalent of a privilege-escalation attempt (§72).
   */
  async switchTenant(
    req: Request,
    res: Response,
    ctx: RequestContextInfo,
    current: FirmSession,
    input: { tenantId: string },
  ): Promise<FirmLoginResult> {
    const wanted = String(input.tenantId || '');
    const allowed = current.tenants.find((t) => t.tenantId === wanted);
    if (!allowed) {
      await this.audit.tryWrite(
        { action: 'ESCALATION_ATTEMPT',
          actor: { kind: 'firm_member', userId: current.principal.userId, tenantId: current.principal.tenantId },
          outcome: 'denied', reasonCode: 'tenant_switch_not_member',
          metadata: { membershipId: current.principal.membershipId, requestedTenant: wanted.slice(0, 64) } }, ctx);
      throw forbidden('forbidden', 'you are not a member of that firm');
    }

    const principal = await this.engine.resolve(current.principal.userId, allowed.tenantId);
    if (!principal) {
      throw forbidden('forbidden', 'you are not a member of that firm');
    }

    // Revoke first, so a failed mint cannot leave two live sessions behind.
    await this.sessions.revokeAll(current.principal.membershipId, 'tenant_switch');
    this.sessions.clearCookies(res);

    return this.completeLogin(req, res, ctx, principal, {
      remember: current.remembered,
      mfaVerified: current.mfaVerified,
    });
  }

  // ==========================================================================
  // LOGOUT
  // ==========================================================================
  async logout(req: Request, res: Response, ctx: RequestContextInfo, current: FirmSession | null) {
    if (current) {
      await this.audit.tryWrite(
        { action: 'FIRM_LOGOUT',
          actor: { kind: 'firm_member', userId: current.principal.userId, tenantId: current.principal.tenantId },
          resourceType: 'firm_session', resourceId: current.sessionId,
          metadata: { membershipId: current.principal.membershipId } }, ctx);
    }
    await this.sessions.destroy(req, res);
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================
  private rateLimited(retryAfterSeconds: number): PortalError {
    return new PortalError(429, 'rate_limited', 'too many attempts, please try again later', {
      details: { retryAfterSeconds },
    });
  }

  private async record(
    ctx: RequestContextInfo,
    outcome: string,
    email: string,
    userId: string | null,
  ): Promise<void> {
    await this.firm.recordLoginAttempt({
      email: email || null,
      userId,
      ipHash: ctx.ipHash ?? 'unknown',
      userAgent: ctx.userAgent,
      outcome,
    });
  }
}

/**
 * A decryption failure must not become a 500 that reveals the MFA secret is
 * malformed — or, worse, a stack trace in a response body. Treat it as "no
 * secret", which simply fails the verification like any other wrong code.
 */
function safeDecrypt(payload: string): string | null {
  try {
    return decryptSecret(payload);
  } catch {
    return null;
  }
}
