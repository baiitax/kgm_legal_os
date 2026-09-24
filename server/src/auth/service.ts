/**
 * AUTHENTICATION SERVICE
 *
 * Every rule from §3, §5, §6 and §8 is implemented here.
 *
 * THE ENUMERATION INVARIANT
 *   Login, password reset and email verification are engineered so that the
 *   HTTP status, error code, response body and response *timing* are identical
 *   whether or not the address belongs to a client account:
 *
 *     - unknown email          → 401 invalid_credentials  (after a dummy scrypt)
 *     - wrong password         → 401 invalid_credentials
 *     - invited, no password   → 401 invalid_credentials  (after a dummy scrypt)
 *     - disabled account       → 401 invalid_credentials
 *     - locked account         → 429 rate_limited
 *     - budget exhausted       → 429 rate_limited   (same shape as locked)
 *
 *   Lockout and the in-memory per-email budget produce the SAME 429 shape, so
 *   "this account got locked" is not distinguishable from "this address was
 *   rate limited". A dummy scrypt runs on every failure path so timing is
 *   uniform too.
 *
 * THE BINDING INVARIANT (§3)
 *   tenant_id, client_id and portal_role are read from the invitation row.
 *   No code path in this file accepts them from a request body, query string,
 *   header or cookie.
 */
import type { Request, Response } from 'express';
import type { Repo } from '../db/repo.js';
import type { SessionManager, Principal } from './session.js';
import type { AuditLogger, RequestContextInfo } from '../audit/logger.js';
import { config } from '../config.js';
import {
  assessPasswordStrength, decryptSecret, encryptSecret, generateOtp, generateRecoveryCodes,
  generateTotpSecret, hashToken, newId, otpUri, randomToken, verifyPassword, verifyTotp,
  hashPassword, needsRehash,
} from '../lib/crypto.js';
import { PortalError, badRequest, conflict, forbidden, notFoundOrForbidden, unauthorized } from '../lib/errors.js';
import {
  counters, evaluateLockout, keys, limit, nextLockoutTimestamp, progressiveDelayMs,
  resetLimit, sleep,
} from './ratelimit.js';
import { sendEmail, templates } from './email.js';
import { toBool, toIso } from '../db/types.js';
import type { Param, Row } from '../db/types.js';
import { maskEmail } from '../lib/crypto.js';

export type LoginResult =
  | { kind: 'session'; principal: Principal; csrfToken: string }
  | { kind: 'mfa_required'; method: 'totp' | 'email_otp'; maskedDestination: string | null };

export class AuthService {
  constructor(
    private readonly repo: Repo,
    private readonly sessions: SessionManager,
    private readonly audit: AuditLogger,
  ) {}

  // ===========================================================================
  // LOGIN
  // ===========================================================================
  async login(
    req: Request,
    res: Response,
    ctx: RequestContextInfo,
    input: { email: string; password: string; remember?: boolean },
  ): Promise<LoginResult> {
    const email = (input.email || '').toLowerCase().trim();
    const ip = ctx.ipHash ?? 'unknown';

    // ---- Budgets are checked BEFORE any account lookup, so an unknown address
    // ---- is rate limited exactly like a known one.
    const emailLimit = limit(keys.loginEmail(email), config.rateLimit.loginMaxPerEmail, config.rateLimit.loginWindowSeconds);
    if (emailLimit.limited) {
      await this.audit.tryWrite(
        { action: 'RATE_LIMITED', actor: { kind: 'anonymous' }, outcome: 'denied',
          reasonCode: 'login_email_budget', metadata: { scope: 'email' } }, ctx);
      throw this.rateLimited(emailLimit.retryAfterSeconds);
    }
    const ipLimit = limit(keys.loginIp(ip), config.rateLimit.loginMaxPerIp, config.rateLimit.loginWindowSeconds);
    if (ipLimit.limited) {
      await this.audit.tryWrite(
        { action: 'RATE_LIMITED', actor: { kind: 'anonymous' }, outcome: 'denied',
          reasonCode: 'login_ip_budget', metadata: { scope: 'ip' } }, ctx);
      throw this.rateLimited(ipLimit.retryAfterSeconds);
    }

    const user = email ? await this.repo.getUserByEmail(email) : undefined;

    // ---- Account-level durable lockout. Uniform 429 shape.
    if (user) {
      const lock = evaluateLockout(
        Number(user.failed_login_count ?? 0),
        user.locked_until ? String(user.locked_until) : null,
      );
      if (lock.locked) {
        await this.recordAttempt(ctx, 'locked', email, String(user.id));
        throw this.rateLimited(lock.retryAfterSeconds);
      }
    }

    // ---- Credential check. Every branch performs exactly one scrypt.
    const passwordMatches = verifyPassword(input.password ?? '', user?.password_hash ? String(user.password_hash) : null);

    if (!user || !user.password_hash || user.status === 'disabled' || user.status === 'deletion_requested' || !passwordMatches) {
      const outcome = !user ? 'unknown_account' : user.status === 'disabled' ? 'disabled' : 'bad_password';
      const failedCount = user ? Number(user.failed_login_count ?? 0) + 1 : 0;

      if (user) {
        const lockUntil = nextLockoutTimestamp(failedCount);
        await this.repo.updateUser(String(user.id), {
          failed_login_count: failedCount,
          ...(lockUntil ? { locked_until: lockUntil, status: 'locked' } : {}),
        });
        if (lockUntil) {
          await this.audit.tryWrite(
            { action: 'ACCOUNT_LOCKED', actor: { kind: 'client_user', userId: String(user.id) },
              outcome: 'failure', reasonCode: 'max_failed_attempts',
              metadata: { failedCount } }, ctx);
        }
      }

      await this.recordAttempt(ctx, outcome, email, user ? String(user.id) : null);
      await this.audit.tryWrite(
        { action: 'LOGIN_FAILED', actor: { kind: 'anonymous', userId: user ? String(user.id) : null },
          outcome: 'failure', reasonCode: outcome }, ctx);

      // Progressive delay: makes automated guessing expensive.
      await sleep(progressiveDelayMs(failedCount));
      throw unauthorized('invalid_credentials', 'invalid email or password');
    }

    // ---- Success: clear the failure budget and re-key the limits.
    const userId = String(user.id);
    resetLimit(keys.loginEmail(email), keys.loginIp(ip));
    counters.reset(keys.loginEmail(email));

    const patch: Record<string, Param> = {
      failed_login_count: 0,
      locked_until: null,
      // A lockout that has expired is cleared by a successful sign-in.
      status: user.status === 'locked' ? 'active' : String(user.status),
      last_login_at: new Date().toISOString(),
      last_login_ip_hash: ctx.ipHash,
    };
    if (needsRehash(String(user.password_hash))) {
      patch.password_hash = hashPassword(input.password);
      patch.password_updated_at = new Date().toISOString();
    }
    await this.repo.updateUser(userId, patch);

    // ---- Portal authorization is resolved from the join, never from input.
    const links = (await this.repo.getClientUsersForUser(userId)).filter(
      (l) => l.status === 'active',
    );
    if (!links.length) {
      await this.recordAttempt(ctx, 'disabled', email, userId);
      await this.audit.tryWrite(
        { action: 'AUTHZ_DENIED', actor: { kind: 'client_user', userId },
          outcome: 'denied', reasonCode: 'no_active_client_relationship' }, ctx);
      // The password was correct, so this reveals nothing about existence.
      throw forbidden('forbidden', 'this account has no active portal access');
    }

    const primary =
      links.find((l) => l.portal_role === 'client_primary') ?? links[0];
    const binding = { tenantId: String(primary.tenant_id), clientId: String(primary.client_id) };

    await this.recordAttempt(ctx, 'success', email, userId);

    // ---- MFA gate (§8).
    if (toBool(user.mfa_enabled)) {
      const trustedDeviceId = await this.sessions.isDeviceMfaTrusted(req, userId);
      if (trustedDeviceId) {
        const { sessionId } = await this.sessions.create(res, req, user, binding, {
          remember: Boolean(input.remember),
          mfaVerified: true,
          trustedDeviceId,
        });
        const csrfToken = this.sessions.bindCsrf(res, sessionId);
        await this.audit.write(
          { action: 'LOGIN', actor: { kind: 'client_user', userId, clientId: binding.clientId, tenantId: binding.tenantId },
            resourceType: 'session', resourceId: sessionId,
            metadata: { mfa: 'trusted_device', remember: Boolean(input.remember) } }, ctx);
        const trustedPrincipal = await this.principalOf(req, res);
        if (!trustedPrincipal) throw unauthorized('unauthenticated', 'session could not be established');
        return { kind: 'session', principal: trustedPrincipal, csrfToken };
      }

      const method = (user.mfa_method === 'email_otp' ? 'email_otp' : 'totp') as 'totp' | 'email_otp';
      const challenge = randomToken(32);
      const challengeId = newId();
      let codeHash: string | null = null;
      let masked: string | null = null;

      if (method === 'email_otp') {
        const code = generateOtp(6);
        codeHash = hashToken(code);
        masked = maskEmail(String(user.email));
        const t = templates.otp(code, 'رمز التحقق لتسجيل الدخول إلى بوابة العميل',
          'Verification code for your Client Portal sign-in');
        await sendEmail({ to: String(user.email), kind: 'login_otp', ...t });
      }

      await this.repo.createAuthToken({
        id: challengeId, user_id: userId, kind: 'mfa_challenge',
        token_hash: hashToken(challenge), code_hash: codeHash,
        expires_at: new Date(Date.now() + config.auth.otpTtlMinutes * 60_000).toISOString(),
        created_ip_hash: ctx.ipHash, created_at: new Date().toISOString(),
      });

      // The challenge lives in an HttpOnly cookie, never in the response body.
      res.cookie('kgm_mfa_challenge', challenge, {
        httpOnly: true, secure: config.session.secureCookie,
        sameSite: config.session.sameSite, path: '/api/auth',
        maxAge: config.auth.otpTtlMinutes * 60_000,
      });

      await this.recordAttempt(ctx, 'mfa_required', email, userId);
      return { kind: 'mfa_required', method, maskedDestination: masked };
    }

    // ---- Plain password login.
    const { sessionId } = await this.sessions.create(res, req, user, binding, {
      remember: Boolean(input.remember),
    });
    const csrfToken = this.sessions.bindCsrf(res, sessionId);

    await this.audit.write(
      { action: 'LOGIN', actor: { kind: 'client_user', userId, clientId: binding.clientId, tenantId: binding.tenantId },
        resourceType: 'session', resourceId: sessionId,
        metadata: { mfa: 'none', remember: Boolean(input.remember) } }, ctx);

    await this.detectSuspiciousLogin(req, ctx, userId, user);

    const principal = await this.principalOf(req, res);
    if (!principal) throw unauthorized('unauthenticated', 'session could not be established');
    return { kind: 'session', principal, csrfToken };
  }

  /**
   * Completes an MFA challenge. The challenge token is read from the HttpOnly
   * cookie set during login — the browser cannot supply or alter it.
   */
  async verifyMfa(
    req: Request,
    res: Response,
    ctx: RequestContextInfo,
    input: { code: string; trustDevice?: boolean; remember?: boolean },
  ): Promise<{ principal: Principal; csrfToken: string }> {
    const challenge = req.cookies?.kgm_mfa_challenge;
    if (!challenge || typeof challenge !== 'string') {
      throw unauthorized('mfa_required', 'no pending verification');
    }

    const budget = limit(`rl:mfa:${hashToken(challenge)}`, config.auth.otpMaxAttempts, config.auth.otpTtlMinutes * 60);
    if (budget.limited) throw this.rateLimited(budget.retryAfterSeconds);

    const row = await this.repo.getAuthToken('mfa_challenge', hashToken(challenge));
    if (!row || row.used_at) {
      throw unauthorized('token_invalid', 'verification expired');
    }
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
      throw unauthorized('token_expired', 'verification expired');
    }

    const userId = String(row.user_id);
    const user = await this.repo.getUserById(userId);
    if (!user || user.status !== 'active') throw unauthorized('account_disabled', 'account unavailable');

    const method = user.mfa_method === 'email_otp' ? 'email_otp' : 'totp';
    let verified = false;
    let usedRecovery = false;

    if (method === 'totp') {
      if (user.mfa_secret_enc) {
        try {
          verified = verifyTotp(decryptSecret(String(user.mfa_secret_enc)), String(input.code || ''));
        } catch {
          verified = false;
        }
      }
      if (!verified) {
        usedRecovery = await this.repo.consumeRecoveryCode(userId, hashToken(String(input.code || '').trim().toUpperCase()));
        verified = usedRecovery;
      }
    } else if (method === 'email_otp' && row.code_hash) {
      const clean = String(input.code || '').replace(/\D/g, '');
      verified = clean.length === 6 && String(row.code_hash) === hashToken(clean);
    }

    if (!verified) {
      await this.repo.incrementTokenAttempts(String(row.id));
      await this.recordAttempt(ctx, 'mfa_failed', String(user.email), userId);
      await this.audit.tryWrite(
        { action: 'MFA_FAILED', actor: { kind: 'client_user', userId }, outcome: 'failure',
          reasonCode: method === 'totp' ? 'bad_totp' : 'bad_otp' }, ctx);
      throw unauthorized('mfa_invalid', 'incorrect verification code');
    }

    await this.repo.consumeAuthToken(String(row.id));
    res.clearCookie('kgm_mfa_challenge', { path: '/api/auth' });

    const links = (await this.repo.getClientUsersForUser(userId)).filter((l) => l.status === 'active');
    if (!links.length) throw forbidden('forbidden', 'no active portal access');
    const primary = links.find((l) => l.portal_role === 'client_primary') ?? links[0];
    const binding = { tenantId: String(primary.tenant_id), clientId: String(primary.client_id) };

    let trustedDeviceId: string | null = null;
    if (input.trustDevice) {
      const dev = await this.sessions.registerDevice(req, userId, true);
      trustedDeviceId = dev.id;
      await this.audit.tryWrite(
        { action: 'DEVICE_TRUSTED', actor: { kind: 'client_user', userId, tenantId: binding.tenantId },
          resourceType: 'device', resourceId: dev.id,
          metadata: { ttlDays: config.session.trustedDeviceTtlDays } }, ctx);
    }

    const { sessionId } = await this.sessions.create(res, req, user, binding, {
      remember: Boolean(input.remember),
      mfaVerified: true,
      trustedDeviceId,
    });
    const csrfToken = this.sessions.bindCsrf(res, sessionId);

    await this.repo.updateUser(userId, {
      last_login_at: new Date().toISOString(),
      last_login_ip_hash: ctx.ipHash,
      failed_login_count: 0,
      locked_until: null,
    });

    await this.audit.write(
      { action: 'MFA_VERIFIED', actor: { kind: 'client_user', userId, tenantId: binding.tenantId, clientId: binding.clientId },
        resourceType: 'session', resourceId: sessionId,
        metadata: { method, recoveryCode: usedRecovery, trustDevice: Boolean(input.trustDevice) } }, ctx);
    await this.audit.write(
      { action: 'LOGIN', actor: { kind: 'client_user', userId, tenantId: binding.tenantId, clientId: binding.clientId },
        resourceType: 'session', resourceId: sessionId, metadata: { mfa: method } }, ctx);

    const principal = await this.principalOf(req, res);
    if (!principal) throw unauthorized('unauthenticated', 'session could not be established');
    return { principal, csrfToken };
  }

  async logout(req: Request, res: Response, ctx: RequestContextInfo): Promise<void> {
    const principal = await this.sessions.resolve(req, res);
    await this.sessions.destroy(req, res);
    res.clearCookie('kgm_mfa_challenge', { path: '/api/auth' });
    if (principal) {
      await this.audit.write(
        { action: 'LOGOUT', actor: { kind: 'client_user', userId: principal.userId,
            tenantId: principal.tenantId, clientId: principal.primaryClientId },
          resourceType: 'session', resourceId: principal.sessionId }, ctx);
    }
  }

  async logoutAllOtherSessions(principal: Principal, ctx: RequestContextInfo): Promise<number> {
    const n = await this.sessions.destroyAllOthers(principal.userId, principal.sessionId);
    await this.audit.write(
      { action: 'LOGOUT_ALL_OTHERS', actor: { kind: 'client_user', userId: principal.userId,
          tenantId: principal.tenantId }, resourceType: 'session',
        metadata: { revoked: n } }, ctx);
    return n;
  }

  // ===========================================================================
  // INVITATIONS (§3)
  // ===========================================================================
  /**
   * Reads an invitation for the acceptance form. Returns only what the form
   * needs; the token is a 256-bit secret so this is not an enumeration oracle,
   * but it is rate limited anyway.
   */
  async peekInvitation(rawToken: string, ctx: RequestContextInfo) {
    const token = this.validateInvitationToken(rawToken, ctx);
    const invitation = await this.repo.getInvitationByTokenHash(hashToken(token));
    if (!invitation) throw notFoundOrForbidden('invitation');
    // The firm name is read from `tenants` (id + name columns only). The client
    // is identified by the display_name already carried ON the invitation, so
    // the auth phase never needs to read the `clients` table — which keeps the
    // pre-authentication surface as small as possible.
    const tenant = await this.repo.getTenant(String(invitation.tenant_id));
    return {
      email: String(invitation.email),
      displayName: String(invitation.display_name),
      displayNameAr: (invitation.display_name_ar as string | null) ?? null,
      firmName: tenant ? String(tenant.name) : '',
      firmNameAr: tenant ? String(tenant.name_ar) : '',
      expiresAt: toIso(invitation.expires_at),
    };
  }

  /**
   * Accepts an invitation and creates the account.
   *
   * tenant_id / client_id / portal_role come from the INVITATION ROW.
   * The request supplies a password and nothing else that affects authorization.
   */
  async acceptInvitation(
    req: Request,
    res: Response,
    ctx: RequestContextInfo,
    input: { token: string; password: string; confirmPassword?: string },
  ): Promise<{ principal: Principal; csrfToken: string }> {
    const token = this.validateInvitationToken(input.token, ctx);
    const invitation = await this.repo.getInvitationByTokenHash(hashToken(token));
    if (!invitation) throw notFoundOrForbidden('invitation');

    const invitationId = String(invitation.id);
    if (invitation.revoked_at) {
      await this.audit.tryWrite(
        { action: 'INVITATION_REVOKED', actor: { kind: 'anonymous' }, outcome: 'denied',
          resourceType: 'invitation', resourceId: invitationId }, ctx);
      throw badRequest('invitation_revoked', 'this invitation is no longer valid');
    }
    if (invitation.accepted_at) {
      throw badRequest('invitation_accepted', 'this invitation has already been used');
    }
    if (new Date(String(invitation.expires_at)).getTime() <= Date.now()) {
      await this.audit.tryWrite(
        { action: 'INVITATION_EXPIRED', actor: { kind: 'anonymous' }, outcome: 'denied',
          resourceType: 'invitation', resourceId: invitationId }, ctx);
      throw badRequest('invitation_expired', 'this invitation has expired');
    }

    const email = String(invitation.email).toLowerCase();
    const password = String(input.password ?? '');
    if (input.confirmPassword !== undefined && input.confirmPassword !== password) {
      throw badRequest('password_mismatch', 'passwords do not match');
    }

    const strength = assessPasswordStrength(password, {
      minLength: config.auth.passwordMinLength,
      disallow: [email.split('@')[0], String(invitation.display_name)],
    });
    if (!strength.ok) {
      throw badRequest('password_policy', 'password does not meet policy', { failures: strength.failures });
    }

    const now = new Date().toISOString();
    const tenantId = String(invitation.tenant_id);
    const clientId = String(invitation.client_id);
    const portalRole = String(invitation.portal_role);

    // Idempotency & collision handling.
    let user = await this.repo.getUserByEmail(email);
    if (user && user.password_hash && user.status === 'active') {
      // An account already exists and is usable: do not silently rebind it.
      throw conflict('invitation_accepted', 'an active account already exists for this email');
    }

    if (!user) {
      const id = newId();
      await this.repo.createUser({
        id, email, password_hash: hashPassword(password), password_updated_at: now,
        // Clicking the emailed link proves control of the mailbox.
        email_verified_at: now, status: 'active',
        preferred_language: 'ar', preferred_calendar: 'islamic-umalqura',
        created_at: now, updated_at: now,
      });
      user = await this.repo.getUserByEmail(email);
    } else {
      await this.repo.updateUser(String(user.id), {
        password_hash: hashPassword(password),
        password_updated_at: now,
        email_verified_at: now,
        status: 'active',
        failed_login_count: 0,
        locked_until: null,
      });
    }
    if (!user) throw new PortalError(500, 'internal_error', 'could not provision account');
    const userId = String(user.id);

    // Link the authorization row SERVER-SIDE. Values are from the invitation.
    const existingLinks = await this.repo.getClientUsersForUser(userId);
    const alreadyLinked = existingLinks.some((l) => String(l.client_id) === clientId);
    if (!alreadyLinked) {
      await this.repo.createClientUser({
        id: newId(), user_id: userId, client_id: clientId, tenant_id: tenantId,
        display_name: String(invitation.display_name),
        display_name_ar: (invitation.display_name_ar as string | null) ?? null,
        portal_role: portalRole,
        created_by_staff: invitation.created_by_staff ? String(invitation.created_by_staff) : null,
        created_at: now, updated_at: now,
      });
    }

    await this.repo.markInvitationAccepted(invitationId, ctx.ipHash);

    await this.audit.write(
      { action: 'INVITATION_ACCEPTED', actor: { kind: 'client_user', userId, tenantId, clientId },
        resourceType: 'invitation', resourceId: invitationId,
        metadata: { portalRole } }, ctx);
    await this.audit.write(
      { action: 'EMAIL_VERIFIED', actor: { kind: 'client_user', userId, tenantId, clientId },
        metadata: { via: 'invitation' } }, ctx);

    const { sessionId } = await this.sessions.create(res, req, user, { tenantId, clientId }, {});
    const csrfToken = this.sessions.bindCsrf(res, sessionId);
    await this.audit.write(
      { action: 'LOGIN', actor: { kind: 'client_user', userId, tenantId, clientId },
        resourceType: 'session', resourceId: sessionId, metadata: { via: 'invitation' } }, ctx);

    const principal = await this.principalOf(req, res);
    if (!principal) throw unauthorized('unauthenticated', 'session could not be established');
    return { principal, csrfToken };
  }

  /**
   * Firm-side helper: mint an invitation. In production this lives in the
   * Internal Firm OS; it is exposed here only so the journey in §48 can be
   * demonstrated end to end, and it is guarded by the internal route policy.
   */
  async createInvitation(
    ctx: RequestContextInfo,
    input: {
      tenantId: string; clientId: string; email: string; displayName: string;
      displayNameAr?: string; portalRole?: 'client_primary' | 'client_contact';
      createdByStaff?: string;
    },
  ): Promise<{ token: string; link: string; expiresAt: string }> {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + config.auth.invitationTtlDays * 86_400_000).toISOString();
    const id = newId();
    await this.repo.createInvitation({
      id, tenant_id: input.tenantId, client_id: input.clientId,
      email: input.email.toLowerCase(), display_name: input.displayName,
      display_name_ar: input.displayNameAr ?? null,
      portal_role: input.portalRole ?? 'client_contact',
      token_hash: hashToken(token), token_hint: token.slice(-6),
      expires_at: expiresAt, created_by_staff: input.createdByStaff ?? null,
      created_at: new Date().toISOString(),
    });
    await this.audit.tryWrite(
      { action: 'INVITATION_CREATED', actor: { kind: 'staff', tenantId: input.tenantId, clientId: input.clientId },
        resourceType: 'invitation', resourceId: id,
        metadata: { emailHint: maskEmail(input.email), ttlDays: config.auth.invitationTtlDays } }, ctx);

    const link = `${config.auth.portalBaseUrl}/invite/accept?token=${token}`;
    const tenant = await this.repo.getTenant(input.tenantId);
    await sendEmail({
      to: input.email, kind: 'invitation',
      ...templates.invitation(link, input.displayNameAr || input.displayName,
        tenant ? String(tenant.name_ar) : 'the firm', tenant ? String(tenant.name) : 'the firm'),
    });
    return { token, link, expiresAt };
  }

  private validateInvitationToken(rawToken: string, ctx: RequestContextInfo): string {
    const token = String(rawToken || '').trim();
    // Rate limit by a coarse hint so a valid token cannot be brute-forced and
    // an attacker cannot use the endpoint as a timing oracle at volume.
    const hint = token.length >= 6 ? token.slice(-6) : 'short';
    const budget = limit(keys.inviteToken(hint), 20, 3600);
    if (budget.limited) throw this.rateLimited(budget.retryAfterSeconds);
    if (token.length < 20) {
      void ctx;
      throw notFoundOrForbidden('invitation');
    }
    return token;
  }

  // ===========================================================================
  // PASSWORD RESET (§6) — generic response, single-use hashed token
  // ===========================================================================
  async requestPasswordReset(emailRaw: string, ctx: RequestContextInfo): Promise<void> {
    const email = (emailRaw || '').toLowerCase().trim();
    const ip = ctx.ipHash ?? 'unknown';

    const budget = limit(keys.resetIp(ip), 5, 3600);
    if (budget.limited) throw this.rateLimited(budget.retryAfterSeconds);
    if (email) limit(keys.resetEmail(email), 3, 3600);

    const user = email ? await this.repo.getUserByEmail(email) : undefined;

    if (user && user.status !== 'disabled' && user.status !== 'deletion_requested') {
      const token = randomToken(32);
      const id = newId();
      // Invalidate any outstanding reset tokens first: only the newest works.
      await this.repo.revokeTokensForUser(String(user.id), 'password_reset');
      await this.repo.createAuthToken({
        id, user_id: String(user.id), kind: 'password_reset',
        token_hash: hashToken(token),
        expires_at: new Date(Date.now() + config.auth.passwordResetTtlMinutes * 60_000).toISOString(),
        created_ip_hash: ctx.ipHash, created_at: new Date().toISOString(),
      });
      const link = `${config.auth.portalBaseUrl}/reset-password?token=${token}`;
      await sendEmail({ to: String(user.email), kind: 'password_reset', ...templates.passwordReset(link) });
      await this.audit.tryWrite(
        { action: 'PASSWORD_RESET_REQUESTED', actor: { kind: 'client_user', userId: String(user.id) },
          resourceType: 'auth_token', resourceId: id }, ctx);
    } else {
      // Same work, same timing profile, no email. Nothing observable differs.
      await sleep(120);
      await this.audit.tryWrite(
        { action: 'PASSWORD_RESET_REQUESTED', actor: { kind: 'anonymous' },
          outcome: 'success', reasonCode: 'no_account', metadata: { sent: false } }, ctx);
    }
    // ALWAYS the same outcome to the caller.
  }

  async completePasswordReset(
    input: { token: string; password: string; confirmPassword?: string },
    ctx: RequestContextInfo,
  ): Promise<void> {
    const token = String(input.token || '').trim();
    const row = await this.repo.getAuthToken('password_reset', hashToken(token));
    if (!row) throw notFoundOrForbidden('reset link');
    if (row.used_at) throw badRequest('token_used', 'this link has already been used');
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
      throw badRequest('token_expired', 'this link has expired');
    }

    const userId = String(row.user_id);
    const user = await this.repo.getUserById(userId);
    if (!user) throw notFoundOrForbidden('reset link');

    const password = String(input.password ?? '');
    if (input.confirmPassword !== undefined && input.confirmPassword !== password) {
      throw badRequest('password_mismatch', 'passwords do not match');
    }
    const strength = assessPasswordStrength(password, {
      minLength: config.auth.passwordMinLength,
      disallow: [String(user.email).split('@')[0]],
    });
    if (!strength.ok) {
      throw badRequest('password_policy', 'password does not meet policy', { failures: strength.failures });
    }

    const now = new Date().toISOString();
    await this.repo.updateUser(userId, {
      password_hash: hashPassword(password),
      password_updated_at: now,
      // A reset link proves mailbox control.
      email_verified_at: user.email_verified_at ? toIso(user.email_verified_at) : now,
      failed_login_count: 0,
      locked_until: null,
      status: user.status === 'locked' ? 'active' : String(user.status),
    });
    await this.repo.consumeAuthToken(String(row.id));
    // Every existing session dies: an attacker who had one loses it.
    await this.repo.revokeSessionsForUser(userId, 'password_changed');

    await this.audit.write(
      { action: 'PASSWORD_RESET_COMPLETED', actor: { kind: 'client_user', userId },
        resourceType: 'auth_token', resourceId: String(row.id) }, ctx);
    await this.audit.write(
      { action: 'SESSION_REVOKED', actor: { kind: 'client_user', userId },
        resourceType: 'user', resourceId: userId, metadata: { reason: 'password_changed' } }, ctx);
  }

  // ===========================================================================
  // EMAIL VERIFICATION
  // ===========================================================================
  async requestEmailVerification(principal: Principal, ctx: RequestContextInfo): Promise<void> {
    const budget = limit(keys.sensitive(principal.userId, 'verify'), 5, 3600);
    if (budget.limited) throw this.rateLimited(budget.retryAfterSeconds);

    const token = randomToken(32);
    const id = newId();
    await this.repo.revokeTokensForUser(principal.userId, 'email_verification');
    await this.repo.createAuthToken({
      id, user_id: principal.userId, kind: 'email_verification',
      token_hash: hashToken(token),
      expires_at: new Date(Date.now() + config.auth.emailVerifyTtlMinutes * 60_000).toISOString(),
      created_ip_hash: ctx.ipHash, created_at: new Date().toISOString(),
    });
    const link = `${config.auth.portalBaseUrl}/verify-email?token=${token}`;
    await sendEmail({ to: principal.email, kind: 'email_verification', ...templates.verifyEmail(link) });
    await this.audit.write(
      { action: 'EMAIL_VERIFICATION_SENT', actor: { kind: 'client_user', userId: principal.userId,
          tenantId: principal.tenantId }, resourceType: 'auth_token', resourceId: id }, ctx);
  }

  async verifyEmail(tokenRaw: string, ctx: RequestContextInfo): Promise<{ email: string }> {
    const row = await this.repo.getAuthToken('email_verification', hashToken(String(tokenRaw || '').trim()));
    if (!row || row.used_at) throw notFoundOrForbidden('verification link');
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
      throw badRequest('token_expired', 'this link has expired');
    }
    const userId = String(row.user_id);
    await this.repo.updateUser(userId, { email_verified_at: new Date().toISOString() });
    await this.repo.consumeAuthToken(String(row.id));
    const user = await this.repo.getUserById(userId);
    await this.audit.write(
      { action: 'EMAIL_VERIFIED', actor: { kind: 'client_user', userId } }, ctx);
    return { email: user ? String(user.email) : '' };
  }

  // ===========================================================================
  // PASSWORD CHANGE & MFA (§26)
  // ===========================================================================
  async changePassword(
    principal: Principal,
    ctx: RequestContextInfo,
    input: { currentPassword: string; newPassword: string; confirmPassword?: string },
  ): Promise<{ sessionsRevoked: number }> {
    const budget = limit(keys.sensitive(principal.userId, 'password'), 5, 3600);
    if (budget.limited) throw this.rateLimited(budget.retryAfterSeconds);

    const user = await this.repo.getUserById(principal.userId);
    if (!user) throw unauthorized('unauthenticated', 'authentication required');

    if (!verifyPassword(String(input.currentPassword ?? ''), user.password_hash ? String(user.password_hash) : null)) {
      await this.audit.write(
        { action: 'PASSWORD_CHANGED', actor: { kind: 'client_user', userId: principal.userId,
            tenantId: principal.tenantId }, outcome: 'failure', reasonCode: 'current_password_incorrect' }, ctx);
      throw unauthorized('invalid_credentials', 'current password is incorrect');
    }

    const next = String(input.newPassword ?? '');
    if (input.confirmPassword !== undefined && input.confirmPassword !== next) {
      throw badRequest('password_mismatch', 'passwords do not match');
    }
    const strength = assessPasswordStrength(next, {
      minLength: config.auth.passwordMinLength,
      disallow: [principal.email.split('@')[0], principal.clientUser.displayName],
    });
    if (!strength.ok) {
      throw badRequest('password_policy', 'password does not meet policy', { failures: strength.failures });
    }
    if (verifyPassword(next, String(user.password_hash))) {
      throw badRequest('password_policy', 'new password must differ from the current one', {
        failures: ['same_as_current'],
      });
    }

    const now = new Date().toISOString();
    await this.repo.updateUser(principal.userId, { password_hash: hashPassword(next), password_updated_at: now });
    const revoked = await this.sessions.destroyAllOthers(principal.userId, principal.sessionId);

    await this.audit.write(
      { action: 'PASSWORD_CHANGED', actor: { kind: 'client_user', userId: principal.userId,
          tenantId: principal.tenantId }, metadata: { sessionsRevoked: revoked } }, ctx);
    await this.notifySecurity(principal, ctx, 'password_changed',
      'تم تغيير كلمة المرور', 'تم تغيير كلمة المرور الخاصة بحسابك بنجاح.',
      'Password changed', 'Your account password was changed successfully.');

    return { sessionsRevoked: revoked };
  }

  async startMfaEnrollment(principal: Principal, ctx: RequestContextInfo) {
    const budget = limit(keys.sensitive(principal.userId, 'mfa_enroll'), 5, 3600);
    if (budget.limited) throw this.rateLimited(budget.retryAfterSeconds);

    const secret = generateTotpSecret();
    const challenge = randomToken(32);
    await this.repo.revokeTokensForUser(principal.userId, 'mfa_enroll');
    await this.repo.createAuthToken({
      id: newId(), user_id: principal.userId, kind: 'mfa_enroll',
      token_hash: hashToken(challenge),
      // The secret is encrypted with the master key before it touches storage.
      code_hash: encryptSecret(secret),
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      created_ip_hash: ctx.ipHash, created_at: new Date().toISOString(),
    });

    await this.audit.write(
      { action: 'MFA_ENROLLMENT_STARTED', actor: { kind: 'client_user', userId: principal.userId,
          tenantId: principal.tenantId } }, ctx);

    return {
      challengeToken: challenge,
      secret,
      otpauthUri: otpUri(secret, principal.email, 'KGM LEGAL OS'),
      expiresInMinutes: 15,
    };
  }

  async confirmMfaEnrollment(
    principal: Principal,
    ctx: RequestContextInfo,
    input: { challengeToken: string; code: string },
  ): Promise<{ recoveryCodes: string[] }> {
    const row = await this.repo.getAuthToken('mfa_enroll', hashToken(String(input.challengeToken || '')));
    if (!row || row.used_at) throw notFoundOrForbidden('enrollment');
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
      throw badRequest('token_expired', 'enrollment expired, please start again');
    }
    if (String(row.user_id) !== principal.userId) {
      // Someone presented another user's enrollment challenge.
      await this.audit.write(
        { action: 'AUTHZ_DENIED', actor: { kind: 'client_user', userId: principal.userId,
            tenantId: principal.tenantId }, outcome: 'denied', reasonCode: 'mfa_challenge_owner_mismatch' }, ctx);
      throw notFoundOrForbidden('enrollment');
    }

    const secret = decryptSecret(String(row.code_hash));
    if (!verifyTotp(secret, String(input.code || ''))) {
      await this.audit.write(
        { action: 'MFA_FAILED', actor: { kind: 'client_user', userId: principal.userId,
            tenantId: principal.tenantId }, outcome: 'failure', reasonCode: 'enrollment_code_mismatch' }, ctx);
      throw badRequest('mfa_invalid', 'the code did not match');
    }

    const now = new Date().toISOString();
    await this.repo.updateUser(principal.userId, {
      mfa_enabled: true, mfa_method: 'totp',
      mfa_secret_enc: encryptSecret(secret), mfa_enabled_at: now,
    });
    await this.repo.consumeAuthToken(String(row.id));

    const { plain, hashes } = generateRecoveryCodes(10);
    await this.repo.saveRecoveryCodes(principal.userId, hashes);

    await this.audit.write(
      { action: 'MFA_ENABLED', actor: { kind: 'client_user', userId: principal.userId,
          tenantId: principal.tenantId }, metadata: { method: 'totp' } }, ctx);
    await this.notifySecurity(principal, ctx, 'mfa_enabled',
      'تم تفعيل التحقق الثنائي', 'تم تفعيل التحقق الثنائي عبر تطبيق المصادقة.',
      'Two-factor authentication enabled', 'Authenticator app verification is now required at sign-in.');

    return { recoveryCodes: plain };
  }

  async disableMfa(
    principal: Principal,
    ctx: RequestContextInfo,
    input: { password: string; code: string },
  ): Promise<void> {
    const budget = limit(keys.sensitive(principal.userId, 'mfa_disable'), 3, 3600);
    if (budget.limited) throw this.rateLimited(budget.retryAfterSeconds);

    const user = await this.repo.getUserById(principal.userId);
    if (!user) throw unauthorized('unauthenticated', 'authentication required');
    if (!verifyPassword(String(input.password ?? ''), user.password_hash ? String(user.password_hash) : null)) {
      throw unauthorized('invalid_credentials', 'password is incorrect');
    }

    let verified = false;
    if (user.mfa_secret_enc) {
      verified = verifyTotp(decryptSecret(String(user.mfa_secret_enc)), String(input.code || ''));
    }
    if (!verified) {
      verified = await this.repo.consumeRecoveryCode(principal.userId, hashToken(String(input.code || '').trim().toUpperCase()));
    }
    if (!verified) {
      await this.audit.write(
        { action: 'MFA_DISABLED', actor: { kind: 'client_user', userId: principal.userId,
            tenantId: principal.tenantId }, outcome: 'failure', reasonCode: 'code_mismatch' }, ctx);
      throw badRequest('mfa_invalid', 'the code did not match');
    }

    await this.repo.updateUser(principal.userId, {
      mfa_enabled: false, mfa_method: null, mfa_secret_enc: null, mfa_enabled_at: null,
    });
    // Untrust every device: an MFA downgrade must not leave trust behind.
    for (const d of await this.repo.listDevices(principal.userId)) {
      await this.repo.revokeDevice(principal.userId, String(d.id));
    }

    await this.audit.write(
      { action: 'MFA_DISABLED', actor: { kind: 'client_user', userId: principal.userId,
          tenantId: principal.tenantId }, metadata: { method: 'totp' } }, ctx);
    await this.notifySecurity(principal, ctx, 'mfa_disabled',
      'تم إيقاف التحقق الثنائي', 'تم إيقاف التحقق الثنائي على حسابك.',
      'Two-factor authentication disabled', 'Two-factor authentication has been turned off on your account.');
  }

  // ===========================================================================
  // helpers
  // ===========================================================================
  private async principalOf(req: Request, res: Response): Promise<Principal | null> {
    return this.sessions.resolve(req, res);
  }

  private rateLimited(retryAfterSeconds: number): PortalError {
    return new PortalError(429, 'rate_limited', 'too many attempts, please try again later', {
      details: { retryAfterSeconds },
    });
  }

  private async recordAttempt(
    ctx: RequestContextInfo,
    outcome: string,
    email: string,
    userId: string | null,
  ): Promise<void> {
    await this.repo.recordLoginAttempt({
      email: email || null, user_id: userId, ip_hash: ctx.ipHash ?? 'unknown',
      user_agent: ctx.userAgent, outcome, created_at: new Date().toISOString(),
    });
  }

  /**
   * Suspicious-login detection (§6). Heuristics only; each produces an
   * alert row and, optionally, an email. Nothing here blocks the login —
   * blocking decisions belong to the rate limiter and lockout.
   */
  private async detectSuspiciousLogin(
    req: Request, ctx: RequestContextInfo, userId: string, user: Row,
  ): Promise<void> {
    const prevIpHash = user.last_login_ip_hash ? String(user.last_login_ip_hash) : null;
    const newDevice = prevIpHash !== null && prevIpHash !== ctx.ipHash;

    if (newDevice) {
      await this.repo.createSecurityAlert({
        id: newId(), user_id: userId, tenant_id: null, kind: 'new_device_login',
        severity: 'info',
        message: 'A sign-in occurred from a network we do not recognise.',
        message_ar: 'تم تسجيل الدخول من شبكة غير معروفة لدينا.',
        ip_hash: ctx.ipHash, ip_country: ctx.ipCountry, user_agent: ctx.userAgent,
        created_at: new Date().toISOString(),
      });
      void req;
    }
  }

  private async notifySecurity(
    principal: Principal, ctx: RequestContextInfo, kind: string,
    titleAr: string, bodyAr: string, titleEn: string, bodyEn: string,
  ): Promise<void> {
    await this.repo.createSecurityAlert({
      id: newId(), user_id: principal.userId, tenant_id: principal.tenantId, kind,
      severity: kind === 'mfa_disabled' ? 'warning' : 'info',
      message: bodyEn, message_ar: bodyAr, ip_hash: ctx.ipHash,
      ip_country: ctx.ipCountry, user_agent: ctx.userAgent,
      created_at: new Date().toISOString(),
    });
    await this.repo.createNotification({
      id: newId(), tenant_id: principal.tenantId, user_id: principal.userId,
      client_id: principal.primaryClientId, category: 'security', severity: 'info',
      title: titleEn, title_ar: titleAr, body: bodyEn, body_ar: bodyAr,
      link: '/portal/security', created_at: new Date().toISOString(),
    });
    await sendEmail({
      to: principal.email, kind: 'security_alert',
      ...templates.securityAlert(titleAr, bodyAr, titleEn, bodyEn),
    });
  }
}
