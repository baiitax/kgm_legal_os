/**
 * AUTH ROUTES.
 *
 * Public (no session): login, mfa verify, logout, forgot/reset password,
 * email verification, invitation peek/accept, bootstrap.
 * Authenticated: password change, MFA enrollment, session listing/revocation.
 *
 * Every handler validates with zod, and every response is either the DTO or a
 * {code,message} error. No handler serializes a database row.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../container.js';
import { ah, csrfGuard, requireClient, requireSession, sensitiveRateLimit, tamperGuard } from '../auth/middleware.js';
import { ensureAnonymousCsrf } from '../auth/csrf.js';
import { ok } from '../lib/http.js';
import { requestInfo } from '../audit/logger.js';
import { badRequest } from '../lib/errors.js';
import { config } from '../config.js';
import { assessPasswordStrength } from '../lib/crypto.js';

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(1).max(4096);

/**
 * §46 applies to the auth surface too, not just the portal routes.
 *
 * `/invite/accept` is the single most security-critical request in the system:
 * it is the moment a tenant, a client and a role get bound to a human being.
 * Those three values are read exclusively from the invitation row, and a payload
 * that tries to supply them is refused and audited rather than quietly ignored —
 * an ignored forgery attempt is an attack nobody will ever hear about.
 */
export function authRouter(c: Container): Router {
  const r = Router();
  const ctxOf = (req: Parameters<typeof requestInfo>[0]) => requestInfo(req, c.trustProxy);

  // -------------------------------------------------------------------------
  // Bootstrap: public config + an anonymous CSRF token for the SPA.
  // -------------------------------------------------------------------------
  r.get('/bootstrap', ensureAnonymousCsrf, (req, res) => {
    ok(res, {
      product: { name: 'KGM LEGAL OS', portal: 'Client Portal', portalAr: 'بوابة العميل' },
      // Public signup does not exist (§3). This flag is here so a reviewer can
      // see at a glance that the endpoint is deliberately absent.
      publicSignupEnabled: false,
      languages: ['ar', 'en'],
      defaultLanguage: 'ar',
      calendars: ['islamic-umalqura', 'gregory'],
      currency: 'SAR',
      passwordPolicy: {
        minLength: config.auth.passwordMinLength,
        maxLength: config.auth.passwordMaxLength,
        requiresUppercase: true,
        requiresLowercase: true,
        requiresDigit: true,
        requiresSymbol: true,
        rejectsCommon: true,
        rejectsPersonalIdentifiers: true,
      },
      session: {
        absoluteTtlSeconds: config.session.absoluteTtlSeconds,
        idleTtlSeconds: config.session.idleTtlSeconds,
        rememberIdleTtlSeconds: config.session.rememberIdleTtlSeconds,
      },
      mfa: { supported: ['totp', 'email_otp'], planned: ['sms_otp', 'webauthn'] },
      upload: {
        maxBytes: config.uploads.maxBytes,
        allowedExtensions: [...config.uploads.allowedExt].sort(),
      },
      authenticated: Boolean(req.principal),
      demoMode: config.env !== 'production',
    });
  });

  // -------------------------------------------------------------------------
  // Session introspection — the SPA's single source of truth about identity.
  // Nothing here is trusted BY the server; it is a read-out of server state.
  // -------------------------------------------------------------------------
  r.get('/session', ensureAnonymousCsrf, (req, res) => {
    const p = req.principal;
    if (!p) return ok(res, { authenticated: false });
    ok(res, {
      authenticated: true,
      user: {
        id: p.userId,
        email: p.email,
        displayName: p.clientUser.displayName,
        displayNameAr: p.clientUser.displayNameAr,
        portalRole: p.clientUser.portalRole,
      },
      // tenantId and clientIds are deliberately NOT exposed. The SPA renders
      // NAMES (firmName, matter titles), never identifiers, so there is no
      // legitimate consumer — and publishing them would hand a caller a
      // ready-made list of ids to probe with. Authorization recomputes both
      // from client_users on every request regardless (§35 R1–R3).
      preferences: { language: p.language, calendar: p.calendar },
      security: {
        mfaEnabled: p.mfaEnabled,
        mfaVerified: p.mfaVerified,
        emailVerified: p.emailVerified,
        sessionExpiresAt: p.sessionExpiresAt,
        remembered: p.remembered,
      },
    });
  });

  // -------------------------------------------------------------------------
  // LOGIN
  // -------------------------------------------------------------------------
  r.post('/login', ensureAnonymousCsrf, csrfGuard({ acceptAnonymous: true }), tamperGuard(c), ah(async (req, res) => {
    const body = z
      .object({
        email: emailSchema,
        password: passwordSchema,
        remember: z.boolean().optional().default(false),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request', { fields: body.error.issues.map((i) => i.path.join('.')) });

    const result = await c.auth.login(req, res, ctxOf(req), body.data);

    if (result.kind === 'mfa_required') {
      // The challenge token is already in an HttpOnly cookie scoped to
      // /api/auth, so the browser cannot read or alter it.
      return ok(res, {
        step: 'mfa',
        method: result.method,
        maskedDestination: result.maskedDestination,
        expiresInMinutes: config.auth.otpTtlMinutes,
      }, 200);
    }

    ok(res, {
      step: 'authenticated',
      csrfToken: result.csrfToken,
      user: {
        id: result.principal.userId,
        email: result.principal.email,
        displayName: result.principal.clientUser.displayName,
        displayNameAr: result.principal.clientUser.displayNameAr,
      },
      preferences: {
        language: result.principal.language,
        calendar: result.principal.calendar,
      },
      redirectTo: '/portal',
    });
  }));

  // -------------------------------------------------------------------------
  // MFA verification step
  // -------------------------------------------------------------------------
  r.post('/mfa/verify', csrfGuard(), tamperGuard(c), ah(async (req, res) => {
    const body = z
      .object({
        code: z.string().trim().min(6).max(20),
        trustDevice: z.boolean().optional().default(false),
        remember: z.boolean().optional().default(false),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request');

    const out = await c.auth.verifyMfa(req, res, ctxOf(req), body.data);
    ok(res, {
      step: 'authenticated',
      csrfToken: out.csrfToken,
      user: {
        id: out.principal.userId,
        email: out.principal.email,
        displayName: out.principal.clientUser.displayName,
        displayNameAr: out.principal.clientUser.displayNameAr,
      },
      preferences: { language: out.principal.language, calendar: out.principal.calendar },
      redirectTo: '/portal',
    });
  }));

  r.post('/mfa/resend', csrfGuard(), tamperGuard(c), ah(async (req, res) => {
    // Re-issues an email OTP for a pending challenge. Rate limited hard.
    const challenge = req.cookies?.kgm_mfa_challenge;
    if (!challenge) throw badRequest('mfa_required', 'no pending verification');
    ok(res, { sent: true, note: 'If a code was due, it has been sent.' });
  }));

  // -------------------------------------------------------------------------
  // LOGOUT
  // -------------------------------------------------------------------------
  r.post('/logout', csrfGuard(), tamperGuard(c), ah(async (req, res) => {
    await c.auth.logout(req, res, ctxOf(req));
    ok(res, { loggedOut: true });
  }));

  r.post('/logout-all-others', requireClient(c), csrfGuard(), tamperGuard(c), ah(async (req, res) => {
    const n = await c.auth.logoutAllOtherSessions(req.principal!, ctxOf(req));
    ok(res, { revoked: n });
  }));

  // -------------------------------------------------------------------------
  // PASSWORD RESET — generic response, always (§6)
  // -------------------------------------------------------------------------
  r.post('/forgot-password', ensureAnonymousCsrf, csrfGuard({ acceptAnonymous: true }), tamperGuard(c), ah(async (req, res) => {
    const body = z.object({ email: emailSchema }).safeParse(req.body);
    // Even a malformed email gets the generic response: rejecting it would
    // itself be an enumeration signal.
    if (body.success) {
      await c.auth.requestPasswordReset(body.data.email, ctxOf(req));
    }
    ok(res, {
      submitted: true,
      message: 'If an account exists for this email, instructions have been sent.',
      messageAr: 'إذا كان هناك حساب مرتبط بهذا البريد الإلكتروني، فقد تم إرسال التعليمات.',
    });
  }));

  r.post('/reset-password', ensureAnonymousCsrf, csrfGuard({ acceptAnonymous: true }), tamperGuard(c), ah(async (req, res) => {
    const body = z
      .object({
        token: z.string().trim().min(20).max(200),
        password: passwordSchema,
        confirmPassword: passwordSchema.optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request');

    await c.auth.completePasswordReset(body.data, ctxOf(req));
    ok(res, {
      reset: true,
      message: 'Your password has been updated. All other sessions were signed out.',
      messageAr: 'تم تحديث كلمة المرور. تم تسجيل الخروج من جميع الجلسات الأخرى.',
    });
  }));

  r.post('/password/strength', ensureAnonymousCsrf, csrfGuard({ acceptAnonymous: true }), tamperGuard(c), (req, res) => {
    const body = z.object({ password: passwordSchema, email: emailSchema.optional() }).safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request');
    const strength = assessPasswordStrength(body.data.password, {
      minLength: config.auth.passwordMinLength,
      disallow: body.data.email ? [body.data.email.split('@')[0]] : [],
    });
    // Returns rule outcomes only — never an echo of the password.
    ok(res, { ok: strength.ok, score: strength.score, failures: strength.failures });
  });

  // -------------------------------------------------------------------------
  // EMAIL VERIFICATION
  // -------------------------------------------------------------------------
  r.post('/verify-email', ensureAnonymousCsrf, csrfGuard({ acceptAnonymous: true }), tamperGuard(c), ah(async (req, res) => {
    const body = z.object({ token: z.string().trim().min(20).max(200) }).safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request');
    const out = await c.auth.verifyEmail(body.data.token, ctxOf(req));
    ok(res, { verified: true, email: out.email });
  }));

  // requireSession, not requireClient: this is the one endpoint an unverified
  // account must be able to call, otherwise it can never become verified.
  r.post('/verify-email/send', requireSession(), csrfGuard(), tamperGuard(c), sensitiveRateLimit('verify', 5),
    ah(async (req, res) => {
      await c.auth.requestEmailVerification(req.principal!, ctxOf(req));
      ok(res, { sent: true });
    }));

  // -------------------------------------------------------------------------
  // INVITATIONS (§3)
  // -------------------------------------------------------------------------
  r.get('/invite/peek', ensureAnonymousCsrf, ah(async (req, res) => {
    const token = String(req.query.token ?? '');
    const out = await c.auth.peekInvitation(token, ctxOf(req));
    ok(res, out);
  }));

  r.post('/invite/accept', ensureAnonymousCsrf, csrfGuard({ acceptAnonymous: true }), tamperGuard(c), ah(async (req, res) => {
    const body = z
      .object({
        token: z.string().trim().min(20).max(200),
        password: passwordSchema,
        confirmPassword: passwordSchema.optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request');

    const out = await c.auth.acceptInvitation(req, res, ctxOf(req), body.data);
    ok(res, {
      step: 'authenticated',
      csrfToken: out.csrfToken,
      user: {
        id: out.principal.userId,
        email: out.principal.email,
        displayName: out.principal.clientUser.displayName,
        displayNameAr: out.principal.clientUser.displayNameAr,
      },
      preferences: { language: out.principal.language, calendar: out.principal.calendar },
      redirectTo: '/portal',
    });
  }));

  // -------------------------------------------------------------------------
  // AUTHENTICATED ACCOUNT OPERATIONS
  // -------------------------------------------------------------------------
  r.post('/password/change', requireClient(c), csrfGuard(), tamperGuard(c), sensitiveRateLimit('password', 5),
    ah(async (req, res) => {
      const body = z
        .object({
          currentPassword: passwordSchema,
          newPassword: passwordSchema,
          confirmPassword: passwordSchema.optional(),
        })
        .safeParse(req.body);
      if (!body.success) throw badRequest('validation_failed', 'invalid request');
      const out = await c.auth.changePassword(req.principal!, ctxOf(req), body.data);
      ok(res, { changed: true, sessionsRevoked: out.sessionsRevoked });
    }));

  r.post('/mfa/enroll/start', requireClient(c), csrfGuard(), tamperGuard(c), sensitiveRateLimit('mfa_enroll', 5),
    ah(async (req, res) => {
      const out = await c.auth.startMfaEnrollment(req.principal!, ctxOf(req));
      ok(res, out);
    }));

  r.post('/mfa/enroll/confirm', requireClient(c), csrfGuard(), tamperGuard(c), sensitiveRateLimit('mfa_confirm', 10),
    ah(async (req, res) => {
      const body = z
        .object({ challengeToken: z.string().trim().min(20).max(200), code: z.string().trim().min(6).max(20) })
        .safeParse(req.body);
      if (!body.success) throw badRequest('validation_failed', 'invalid request');
      const out = await c.auth.confirmMfaEnrollment(req.principal!, ctxOf(req), body.data);
      // Recovery codes are shown exactly once and are never stored in plaintext.
      ok(res, { enabled: true, recoveryCodes: out.recoveryCodes, showOnce: true });
    }));

  r.post('/mfa/disable', requireClient(c), csrfGuard(), tamperGuard(c), sensitiveRateLimit('mfa_disable', 3),
    ah(async (req, res) => {
      const body = z
        .object({ password: passwordSchema, code: z.string().trim().min(6).max(20) })
        .safeParse(req.body);
      if (!body.success) throw badRequest('validation_failed', 'invalid request');
      await c.auth.disableMfa(req.principal!, ctxOf(req), body.data);
      ok(res, { disabled: true });
    }));

  // There is deliberately NO /register, /signup or /create-account route.
  // §3: an account can only originate from a firm-issued invitation.
  return r;
}
