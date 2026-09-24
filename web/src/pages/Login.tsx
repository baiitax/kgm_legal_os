import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { Button, Check, ErrorAlert, Field, Icon, Input } from '../components/ui';

/**
 * Sign-in. Two screens in one component because the server decides which one is
 * shown: credentials first, then a second factor when the account has one.
 *
 * Every message here is written to be safe to show publicly. The server already
 * refuses to say whether an address exists (§43), so "wrong password" and
 * "unknown account" render identically.
 */
export default function Login() {
  const { t, errorText } = useI18n();
  const { signIn, submitMfa, resendMfa, cancelMfa, mfa, boot } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const firstField = useRef<HTMLInputElement | null>(null);

  const from = location.state?.from ?? '/portal';

  useEffect(() => {
    if (mfa) {
      setNotice(null);
      setError(null);
      firstField.current?.focus();
    }
  }, [mfa]);

  // Countdown on the MFA resend button, so the UI does not invite a request the
  // server is going to rate-limit anyway.
  useEffect(() => {
    if (resendAt === null) return;
    const tick = () => {
      if (Date.now() >= resendAt) setResendAt(null);
    };
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [resendAt]);

  const onCredentials = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setAttemptsLeft(null);
    try {
      const res = await signIn(email.trim(), password, remember);
      if (res.step === 'authenticated') navigate(from, { replace: true });
      setPassword('');
    } catch (err) {
      const api = err instanceof ApiError ? err : null;
      setError(api);
      // Retry metadata travels in `details`; the server never puts a
      // human-readable reason on the error itself.
      const d = (api?.details ?? {}) as { retryAfterSeconds?: number; attemptsRemaining?: number };
      if (api?.code === 'lockout_active' && d.retryAfterSeconds) {
        setNotice(t('auth.locked', { minutes: Math.max(1, Math.ceil(d.retryAfterSeconds / 60)) }));
      } else if (api?.code === 'rate_limited' && d.retryAfterSeconds) {
        setNotice(t('common.retryIn', { seconds: d.retryAfterSeconds }));
      } else if (typeof d.attemptsRemaining === 'number') {
        setAttemptsLeft(d.attemptsRemaining);
      }
    } finally {
      setBusy(false);
    }
  };

  const onSecondFactor = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await submitMfa(code.trim(), useRecovery);
      if (res.step === 'authenticated') navigate(from, { replace: true });
      setCode('');
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
      const d = ((err instanceof ApiError ? err.details : {}) ?? {}) as { attemptsRemaining?: number };
      if (typeof d.attemptsRemaining === 'number') setAttemptsLeft(d.attemptsRemaining);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const onResend = async () => {
    try {
      await resendMfa();
      setNotice(t('auth.mfaResent'));
      setResendAt(Date.now() + 30_000);
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
      if (!(err instanceof ApiError)) setNotice(errorText('unknown'));
    }
  };

  const resendSeconds = resendAt ? Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)) : 0;
  const isEmailOtp = (mfa?.method ?? '') === 'email_otp';

  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__head">
          <div className="brand-mark" aria-hidden="true">
            <Icon name="scale" size={28} />
          </div>
          <h1>{t('auth.title')}</h1>
          <p>{t('auth.subtitle', { firm: boot?.product.name ?? 'KGM LEGAL OS' })}</p>
        </div>

        <div className="auth__body">
          {!mfa && (
            <form onSubmit={onCredentials} noValidate>
              <Field label={t('auth.email')} htmlFor="email">
                <Input
                  id="email"
                  ref={firstField}
                  type="email"
                  dir="ltr"
                  autoComplete="username"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  required
                  autoFocus
                />
              </Field>

              <Field label={t('auth.password')} htmlFor="password">
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>

              <div className="row row--between" style={{ marginBlockEnd: 14 }}>
                <Check
                  id="remember"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  label={t('auth.remember')}
                />
                <Link className="auth__link" to="/forgot-password">
                  {t('auth.forgot')}
                </Link>
              </div>

              {error && !notice ? <ErrorAlert error={error} /> : null}
              {notice && (
                <div className="alert alert--warn" role="alert">
                  <Icon name="alert" size={18} />
                  <div className="alert__body">{notice}</div>
                </div>
              )}
              {attemptsLeft !== null && (
                <div className="alert alert--warn">
                  <Icon name="alert" size={18} />
                  <div className="alert__body">{t('auth.attemptsLeft', { n: attemptsLeft })}</div>
                </div>
              )}

              <Button type="submit" variant="primary" block loading={busy}>
                <Icon name="lock" size={16} />
                {t('auth.signIn')}
              </Button>

              <p className="auth__foot">
                {t('auth.haveInvite')}{' '}
                <Link className="auth__link" to="/invite/accept">
                  {t('auth.acceptInvite')}
                </Link>
              </p>
            </form>
          )}

          {mfa && (
            <form onSubmit={onSecondFactor} noValidate>
              <div className="auth__step">
                <Icon name="shield" size={20} />
                <div>
                  <b>{useRecovery ? t('auth.mfaRecoveryTitle') : t('auth.mfaTitle')}</b>
                  <p>
                    {isEmailOtp
                      ? t('auth.mfaSent', { to: mfa.maskedDestination ?? '' })
                      : useRecovery
                        ? t('auth.mfaRecoveryHelp')
                        : t('auth.mfaPrompt')}
                  </p>
                </div>
              </div>

              <Field label={useRecovery ? t('auth.recoveryCode') : t('auth.mfaCode')} htmlFor="code">
                <Input
                  id="code"
                  ref={firstField}
                  dir="ltr"
                  className="code-input"
                  inputMode={useRecovery ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  maxLength={useRecovery ? 30 : 8}
                  value={code}
                  onChange={(e) =>
                    setCode(useRecovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  placeholder={useRecovery ? 'XXXXXX-XXXXXX' : '123456'}
                  required
                  autoFocus
                />
              </Field>

              <div className="row row--between" style={{ marginBlockEnd: 14 }}>
                <Check
                  id="useRecovery"
                  checked={useRecovery}
                  onChange={(e) => {
                    setUseRecovery(e.target.checked);
                    setCode('');
                    setError(null);
                  }}
                  label={t('auth.useRecovery')}
                />
                {isEmailOtp && (
                  <button
                    type="button"
                    className="auth__link"
                    onClick={() => void onResend()}
                    disabled={resendAt !== null}
                  >
                    {resendAt ? t('common.retryIn', { seconds: resendSeconds }) : t('auth.resend')}
                  </button>
                )}
              </div>

              {error ? <ErrorAlert error={error} /> : null}
              {notice && (
                <div className="alert alert--info">
                  <Icon name="info" size={18} />
                  <div className="alert__body">{notice}</div>
                </div>
              )}
              {attemptsLeft !== null && (
                <div className="alert alert--warn">
                  <Icon name="alert" size={18} />
                  <div className="alert__body">{t('auth.mfaAttempts', { n: attemptsLeft })}</div>
                </div>
              )}

              <Button type="submit" variant="primary" block loading={busy} disabled={code.length < 6}>
                <Icon name="check" size={16} />
                {t('auth.verify')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                block
                onClick={() => {
                  // Cancelling discards the pending challenge locally only; the
                  // server-side challenge expires on its own and stays single-use.
                  cancelMfa();
                  setCode('');
                  setUseRecovery(false);
                  setError(null);
                  setAttemptsLeft(null);
                }}
                style={{ marginBlockStart: 8 }}
              >
                <Icon name="back" size={16} />
                {t('auth.back')}
              </Button>
            </form>
          )}
        </div>

        <div className="auth__legal">
          {boot && (
            <p>
              {t('auth.invitationOnly')} · {t('auth.minPassword', { n: boot.passwordPolicy.minLength })}
            </p>
          )}
          {boot?.demoMode && (
            <p className="auth__demo">
              {t('auth.demoNote')} <code className="ltr">ahmed.alsaud@example.test</code> ·{' '}
              <code className="ltr">Demo!Portal2026</code>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
