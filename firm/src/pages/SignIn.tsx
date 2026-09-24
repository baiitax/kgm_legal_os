/**
 * SIGN IN · §52, §08
 *
 * The firm's staff entrance. Invitation-only, so this screen does not offer
 * self-registration: there is no "create account" link, and its absence is the
 * point. A portal and a firm workspace that both accept self-service sign-up
 * differ only by which checkbox you tick.
 *
 * WHAT THIS SCREEN DOES NOT DO
 *   It does not decide whether you are allowed in. It posts credentials and
 *   renders whatever the server says — `authenticated`, `mfa`, or an error code.
 *   Every branch below is a rendering of a server answer, not a client-side
 *   judgment. That is why the error copy is keyed off `FirmApiError.code` rather
 *   off a local validation result: the server is the only thing that knows
 *   whether an account is locked.
 *
 * LOCKOUT MESSAGING (§52)
 *   `account_locked` renders as a distinct message from `invalid_credentials`.
 *   Collapsing them into one generic "incorrect email or password" would be the
 *   safer-sounding choice and the worse one: a legitimate user who has been
 *   locked out needs to know to stop trying and wait, and a generic message
 *   invites them to keep going until the lockout window resets.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Alert, Badge, Button, Checkbox, IconArrowRight, IconCheck, IconLock, IconShield,
  Logo, TextField, useI18n,
} from '@kgm/ui';
import { bootstrapCsrf, firmApi } from '../api/firm.js';
import { useFirmSession } from '../auth/FirmSession.js';
import '../shell/shell.css';

/**
 * Synthetic demo accounts.
 *
 * These are the seeded fixtures, and every one of them is fake. Showing them is
 * a development affordance gated on `import.meta.env.DEV` so the list cannot
 * reach a production build, where it would be a set of real-looking credentials
 * printed on the sign-in page.
 */
/**
 * The seeded fixtures, transcribed from server/src/db/demo-data.ts.
 *
 * These five are chosen to demonstrate §50 rather than merely to log in: each
 * holds a DIFFERENT permission set, so signing in as one and then another shows
 * the navigation, the dashboard metrics and the matter field locks changing in
 * response to authorization and nothing else. Noura sees everything; Sara sees
 * finance and no matters team tab; Mariam sees one practice area.
 *
 * If this list drifts from the seed the buttons still work but the demonstration
 * stops being accurate, so the source file is named here rather than left to be
 * found.
 */
const DEMO_ACCOUNTS = [
  { email: 'noura@kgm.example.test',  roleKey: 'auth.demoPartner',    scope: 'all practice areas · 500k SAR ceiling' },
  { email: 'faisal@kgm.example.test', roleKey: 'auth.demoLawyer',     scope: 'litigation, real estate · no financial authority' },
  { email: 'mariam@kgm.example.test', roleKey: 'auth.demoParalegal',  scope: 'commercial litigation only' },
  { email: 'omar@kgm.example.test',   roleKey: 'auth.demoCompliance', scope: 'compliance · assigned matters only' },
  { email: 'sara@kgm.example.test',   roleKey: 'auth.demoFinance',    scope: 'billing.read_all · 25k SAR ceiling' },
] as const;

const DEMO_PASSWORD = 'Demo!Firm2026';

/** Whether the sign-in screen offers the synthetic demo accounts. */
const SHOW_DEMO_ACCOUNTS = import.meta.env.VITE_SHOW_DEMO_ACCOUNTS === '1';

export function SignIn() {
  const { t, lang } = useI18n();
  const { signIn, submitMfa, mfaChallenge, error, clearError, status } = useFirmSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; code?: string }>({});

  const emailRef = useRef<HTMLInputElement>(null);
  const mfaRef = useRef<HTMLInputElement>(null);

  const inMfa = mfaChallenge !== null;

  // A fresh CSRF token on mount: the one in the browser may predate a restart,
  // and a login attempt that fails on `csrf_failed` looks like a bad password.
  useEffect(() => { void bootstrapCsrf().catch(() => undefined); }, []);

  // Focus the code field when the MFA step appears.
  useEffect(() => {
    if (inMfa) window.setTimeout(() => mfaRef.current?.focus(), 60);
  }, [inMfa]);

  // Any change to the credentials invalidates a stale error banner.
  useEffect(() => { clearError(); }, [email, password, mfaCode, clearError]);

  /** Maps a server error code to the copy that explains it. */
  const banner = useMemo(() => {
    if (!error) return null;
    if (error.status === 0) return { tone: 'critical' as const, title: t('auth.err.network'), body: error.message };
    switch (error.code) {
      case 'invalid_credentials':
        return { tone: 'warning' as const, title: t('auth.err.invalid'), body: null };
      case 'account_locked':
      case 'login_locked':
      case 'rate_limited':
        return { tone: 'critical' as const, title: t('auth.err.locked'), body: null };
      case 'no_membership':
      case 'membership_inactive':
        return { tone: 'warning' as const, title: t('auth.err.noMembership'), body: null };
      case 'mfa_invalid':
      case 'mfa_expired':
        return { tone: 'warning' as const, title: t('auth.mfaTitle'), body: error.message };
      default:
        return { tone: 'critical' as const, title: t('auth.err.generic'), body: error.message };
    }
  }, [error, t]);

  const validateCredentials = (): boolean => {
    const next: typeof fieldErrors = {};
    if (!email.trim()) next.email = t('auth.err.required');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = t('auth.err.emailFormat');
    if (!password) next.password = t('auth.err.required');
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  };

  const onSubmitCredentials = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !validateCredentials()) return;
    setBusy(true);
    try {
      await signIn(email, password, remember);
      // On success the router replaces this screen; nothing to do here.
    } catch {
      // The error is already in context and rendered as the banner above.
      // Catching keeps the unhandled rejection out of the console without
      // swallowing anything the user needs to see.
    } finally {
      setBusy(false);
    }
  };

  const onSubmitMfa = async (e: FormEvent) => {
    e.preventDefault();
    const code = mfaCode.trim();
    if (busy) return;
    if (!code) { setFieldErrors({ code: t('auth.err.required') }); return; }
    setBusy(true);
    try {
      await submitMfa(code, remember);
    } catch {
      setMfaCode('');
      mfaRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const useDemo = (demoEmail: string) => {
    setEmail(demoEmail);
    setPassword(DEMO_PASSWORD);
    setFieldErrors({});
    clearError();
    emailRef.current?.focus();
  };

  return (
    <div className="firm-auth">
      {/* ---- brand side ---- */}
      <aside className="firm-auth__brand">
        <div className="firm-auth__brandinner">
          <Logo size="lg" layout="inline" />

          <h1 className="firm-auth__headline">
            {lang === 'ar'
              ? <>إدارة المكتب القانوني<br /><em>بضوابط صارمة</em></>
              : <>Run the firm<br /><em>under strict control</em></>}
          </h1>

          <p className="firm-auth__lede">
            {lang === 'ar'
              ? 'مساحة عمل داخلية موحّدة للدعاوى والمستندات والمالية والامتثال — مع صلاحيات دقيقة على مستوى الحقل، وسجل تدقيق غير قابل للتعديل.'
              : 'One internal workspace for matters, documents, finance and compliance — with field-level permissions and an append-only audit trail.'}
          </p>

          <ul className="firm-auth__points">
            <Point icon={<IconShield size={14} />}>
              {lang === 'ar' ? 'صلاحيات على مستوى الدور والدعوى والحقل' : 'Permissions by role, by matter and by field'}
            </Point>
            <Point icon={<IconLock size={14} />}>
              {lang === 'ar' ? 'الدعاوى المقيّدة بتصريح صريح فقط' : 'Restricted matters open only by explicit grant'}
            </Point>
            <Point icon={<IconCheck size={14} />}>
              {lang === 'ar' ? 'كل إجراء مسجّل ومدقّق' : 'Every action logged and auditable'}
            </Point>
          </ul>
        </div>

        <div className="firm-auth__foot">
          <span>{t('app.name')}</span>
          <span>{new Date().getFullYear()}</span>
        </div>
      </aside>

      {/* ---- form side ---- */}
      <main className="firm-auth__form">
        <div className="firm-auth__card">
          <div className="firm-auth__cardhead">
            <h2 className="firm-auth__cardtitle">{inMfa ? t('auth.mfaTitle') : t('auth.signInTitle')}</h2>
            <p className="firm-auth__cardsub">
              {inMfa ? t('auth.mfaSubtitle') : t('auth.signInSubtitle')}
            </p>
          </div>

          {banner && (
            <div className="firm-auth__error">
              <Alert tone={banner.tone} title={banner.title} onDismiss={clearError}>
                {banner.body}
              </Alert>
            </div>
          )}

          {inMfa ? (
            <form className="firm-auth__fields" onSubmit={onSubmitMfa} noValidate>
              {mfaChallenge?.maskedDestination && (
                <div>
                  <p className="firm-auth__mfadest">
                    {t('auth.mfaDest')}: <strong>{mfaChallenge.maskedDestination}</strong>
                  </p>
                  {typeof mfaChallenge.expiresInMinutes === 'number' && (
                    <p className="firm-auth__mfaexpire">
                      {t('auth.mfaExpires', { n: mfaChallenge.expiresInMinutes })}
                    </p>
                  )}
                </div>
              )}

              <div className="firm-auth__mfacode">
                <TextField
                  ref={mfaRef}
                  label={t('auth.mfaCode')}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  error={fieldErrors.code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  autoFocus
                  required
                />
              </div>

              <Checkbox
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                label={t('auth.remember')}
              />

              <Button type="submit" variant="primary" size="lg" block loading={busy} className="firm-auth__submit">
                {t('auth.mfaVerify')}
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                block
                onClick={() => { setMfaCode(''); clearError(); }}
                disabled={busy}
              >
                {t('auth.mfaBack')}
              </Button>
            </form>
          ) : (
            <form className="firm-auth__fields" onSubmit={onSubmitCredentials} noValidate>
              <TextField
                ref={emailRef}
                label={t('auth.email')}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                error={fieldErrors.email}
                autoComplete="username"
                dir="ltr"
                required
                autoFocus
              />

              <TextField
                label={t('auth.password')}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={fieldErrors.password}
                autoComplete="current-password"
                dir="ltr"
                required
              />

              <div className="firm-auth__remember">
                <Checkbox
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  label={t('auth.remember')}
                />
                <p className="firm-auth__rememberhint">{t('auth.rememberHint')}</p>
              </div>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                block
                loading={busy}
                disabled={status === 'loading'}
                className="firm-auth__submit"
                trailingIcon={<IconArrowRight size={16} />}
              >
                {busy ? t('auth.signingIn') : t('auth.submit')}
              </Button>
            </form>
          )}

          {/*
            The demo list is gated on an explicit build flag, not on DEV — see
            src/vite-env.d.ts for why `import.meta.env.DEV` is always false in a
            built bundle. With the flag unset this branch is dead code and Rollup
            removes it, credentials included.
          */}
          {SHOW_DEMO_ACCOUNTS && !inMfa && (
            <>
              <div className="firm-auth__divider">{t('auth.demoHint')}</div>
              <div className="firm-auth__demo">
                <ul className="firm-auth__demolist">
                  {DEMO_ACCOUNTS.map((d) => (
                    <li key={d.email} className="firm-auth__demoitem">
                      <span className="firm-auth__demowho">
                        <span className="firm-auth__demoname">
                          {t(d.roleKey)} <Badge tone="neutral" size="xs">{d.scope}</Badge>
                        </span>
                        <span className="firm-auth__demoemail">{d.email}</span>
                      </span>
                      <Button size="xs" variant="secondary" onClick={() => useDemo(d.email)}>
                        {t('auth.demoUse')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}

          <p className="firm-auth__portalnote">
            <IconLock size={13} aria-hidden="true" />
            {t('auth.clientPortalNote')}
            <a href="/portal" className="kgm-link">{t('auth.clientPortalLink')}</a>
          </p>
        </div>
      </main>
    </div>
  );
}

function Point({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="firm-auth__point">
      <span className="firm-auth__pointicon" aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

/** Re-exported so the router can gate on it without importing the API layer. */
export { firmApi };
