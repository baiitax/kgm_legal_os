import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { enterFirmApp, firmSignIn, firmSubmitMfa } from '../api/firmDoor';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { Button, Check, ErrorAlert, Field, Icon, Input } from '../components/ui';
import { accountsFor, passwordFor, SHOW_DEMO_ACCOUNTS, type Audience } from '../lib/demoAccounts';

/**
 * THE CENTRAL SIGN-IN · one screen, both audiences.
 *
 * The product has two doors — the client portal and the internal firm OS — and
 * they stay two doors on the server: separate endpoints, separate session
 * cookies, separate audiences, and a refusal at the wrong door that is
 * indistinguishable from a wrong password. What is unified here is only the
 * place you go to sign in.
 *
 * WHY THE AUDIENCE IS A CONTROL AND NOT A GUESS
 *   The tempting design is to work it out — try one door, and on refusal try the
 *   other. That would reconstruct, on the client, exactly the account-existence
 *   oracle the server doors were fixed to remove: the page would behave
 *   differently for a real member than for an invented address. So the reader
 *   DECLARES which door they are at, and nothing about the screen changes
 *   according to whether the address turns out to be real.
 *
 *   It also happens to be the more useful screen. A person knows whether they
 *   are a client or a member of staff. They do not know which of two URLs the
 *   product expected them to use, and being told is not a security problem — it
 *   was only ever the *response to a credential* that had to stay uniform.
 *
 * The second factor is handled for both audiences. They are different
 * implementations on the server (the portal's challenge object lives in the auth
 * context; the firm's is returned by the login call) and are deliberately not
 * merged here.
 */
export default function Login() {
  const { t } = useI18n();
  const { signIn, submitMfa, resendMfa, cancelMfa, mfa, boot } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };

  // `?as=firm` lets the firm OS send a signed-out member here directly, which is
  // what makes this the single sign-in rather than one of two. `?next=` carries
  // the firm-app hash they were trying to reach, so a deep link survives.
  const params = new URLSearchParams(window.location.search);
  const [audience, setAudience] = useState<Audience>(() =>
    params.get('as') === 'firm' ? 'firm' : 'client',
  );
  const firmNext = params.get('next');

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

  /** The firm door's pending challenge, when it issued one. */
  const [firmChallenge, setFirmChallenge] = useState<{ maskedDestination?: string; expiresInMinutes?: number } | null>(null);

  const firstField = useRef<HTMLInputElement | null>(null);
  const from = location.state?.from ?? '/portal';
  const isFirm = audience === 'firm';

  /*
    The server decides which of the two steps is shown for a portal account.
    `Boolean(mfa)` rather than `mfa !== null`: the auth hook always supplies a
    value, but a caller that does not would otherwise make `undefined !== null`
    true and render the second-factor step in place of the credentials form.
  */
  const clientAtSecondFactor = !isFirm && Boolean(mfa);
  const atSecondFactor = isFirm ? firmChallenge !== null : clientAtSecondFactor;

  useEffect(() => {
    if (clientAtSecondFactor) {
      setNotice(null);
      setError(null);
      firstField.current?.focus();
    }
  }, [clientAtSecondFactor]);

  // Countdown on the resend button, so the UI does not invite a request the
  // server is going to rate-limit anyway.
  useEffect(() => {
    if (resendAt === null) return;
    const id = window.setInterval(() => {
      if (Date.now() >= resendAt) setResendAt(null);
    }, 1000);
    return () => window.clearInterval(id);
  }, [resendAt]);

  /** Applies the retry metadata the server sends in `details`, for either door. */
  const absorbRetryDetails = useCallback(
    (api: ApiError | null) => {
      const d = (api?.details ?? {}) as { retryAfterSeconds?: number; attemptsRemaining?: number };
      if ((api?.code === 'lockout_active' || api?.code === 'account_locked') && d.retryAfterSeconds) {
        setNotice(t('auth.locked', { minutes: Math.max(1, Math.ceil(d.retryAfterSeconds / 60)) }));
      } else if (api?.code === 'rate_limited' && d.retryAfterSeconds) {
        setNotice(t('common.retryIn', { seconds: d.retryAfterSeconds }));
      } else if (typeof d.attemptsRemaining === 'number') {
        setAttemptsLeft(d.attemptsRemaining);
      }
    },
    [t],
  );

  const resetFeedback = () => {
    setError(null);
    setNotice(null);
    setAttemptsLeft(null);
  };

  /**
   * Switching doors.
   *
   * The password is cleared — it belongs to a different credential — and every
   * message is cleared with it, because a refusal earned at one door has nothing
   * to say about the other. The email is kept: it was typed at this screen, not
   * answered by the server, so keeping it discloses nothing and saves the reader
   * retyping it.
   */
  const switchAudience = (next: Audience) => {
    if (next === audience) return;
    setAudience(next);
    setPassword('');
    setCode('');
    setUseRecovery(false);
    setFirmChallenge(null);
    cancelMfa();
    resetFeedback();
  };

  const onCredentials = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    resetFeedback();
    try {
      if (isFirm) {
        const res = await firmSignIn(email.trim(), password, remember);
        if (res.mfaRequired) {
          setFirmChallenge({ maskedDestination: res.maskedDestination, expiresInMinutes: res.expiresInMinutes });
        } else {
          enterFirmApp(firmNext);
        }
      } else {
        const res = await signIn(email.trim(), password, remember);
        if (res.step === 'authenticated') navigate(from, { replace: true });
      }
      setPassword('');
    } catch (err) {
      const api = err instanceof ApiError ? err : null;
      setError(api);
      absorbRetryDetails(api);
    } finally {
      setBusy(false);
    }
  };

  const onSecondFactor = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    resetFeedback();
    try {
      if (isFirm) {
        await firmSubmitMfa(code.trim(), remember);
        enterFirmApp(firmNext);
      } else {
        const res = await submitMfa(code.trim(), useRecovery);
        if (res.step === 'authenticated') navigate(from, { replace: true });
      }
      setCode('');
    } catch (err) {
      const api = err instanceof ApiError ? err : null;
      setError(api);
      absorbRetryDetails(api);
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
    }
  };

  const resendSeconds = resendAt ? Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)) : 0;
  const clientIsEmailOtp = (mfa?.method ?? '') === 'email_otp';
  const firmMasked = firmChallenge?.maskedDestination;

  const audienceLabel = t(isFirm ? 'auth.audienceFirm' : 'auth.audienceClient');

  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__head">
          <div className="brand-mark" aria-hidden="true">
            <Icon name="scale" size={28} />
          </div>
          <h1>{t('auth.title')}</h1>
          <p>
            {isFirm
              ? t('auth.subtitleFirm', { firm: boot?.product.name ?? 'KGM LEGAL OS' })
              : t('auth.subtitle', { firm: boot?.product.name ?? 'KGM LEGAL OS' })}
          </p>
        </div>

        <div className="auth__body">
          {!atSecondFactor && (
            <form onSubmit={onCredentials} noValidate>
              {/*
                The audience switch. Radios rather than buttons with roles: a
                radio group is one control with two options to a screen reader,
                arrow keys move between them without any JavaScript, and there is
                no way to reach a state where neither is selected.
              */}
              <fieldset className="audience">
                <legend className="audience__legend">{t('auth.audience')}</legend>
                <div className="audience__track">
                  {(['client', 'firm'] as const).map((option) => (
                    <label
                      key={option}
                      className="audience__opt"
                      data-active={audience === option || undefined}
                    >
                      <input
                        type="radio"
                        name="audience"
                        value={option}
                        checked={audience === option}
                        onChange={() => switchAudience(option)}
                        className="sr-only"
                      />
                      <span className="audience__label">
                        {t(option === 'firm' ? 'auth.audienceFirm' : 'auth.audienceClient')}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="audience__hint">
                  {t(isFirm ? 'auth.audienceFirmHint' : 'auth.audienceClientHint')}
                </p>
              </fieldset>

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
                />
              </Field>

              <Field label={t('auth.password')} htmlFor="password">
                <Input
                  id="password"
                  type="password"
                  dir="ltr"
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
                {/* Password reset is a portal flow; the firm's members are
                    administered from inside the firm OS, so offering the link
                    here would promise a screen that does not exist. */}
                {!isFirm && (
                  <Link className="auth__link" to="/forgot-password">
                    {t('auth.forgot')}
                  </Link>
                )}
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
            </form>
          )}

          {atSecondFactor && (
            <form onSubmit={onSecondFactor} noValidate>
              <div className="auth__step">
                <Icon name="shield" size={20} />
                <div>
                  <b>{useRecovery ? t('auth.mfaRecoveryTitle') : t('auth.mfaTitle')}</b>
                  <p>
                    {isFirm
                      ? firmMasked
                        ? t('auth.mfaSent', { to: firmMasked })
                        : t('auth.mfaPrompt')
                      : clientIsEmailOtp
                        ? t('auth.mfaSent', { to: mfa?.maskedDestination ?? '' })
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
                {/* Resending is a portal capability; the firm's challenge is
                    re-issued by signing in again. */}
                {!isFirm && clientIsEmailOtp && (
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
                  setFirmChallenge(null);
                  setCode('');
                  setUseRecovery(false);
                  resetFeedback();
                }}
              >
                {t('common.cancel')}
              </Button>
            </form>
          )}
        </div>

        {/*
          The demo credentials. Rendered only in a build that sets
          VITE_SHOW_DEMO_ACCOUNTS; a real deployment shows a plain sign-in form.
        */}
        {SHOW_DEMO_ACCOUNTS && !atSecondFactor && (
          <div className="auth__demo">
            <p className="auth__demohead">
              {t('auth.credentialsFor', { audience: audienceLabel })} · <code>{passwordFor(audience)}</code>
            </p>
            <ul className="auth__demolist">
              {accountsFor(audience).map((account) => (
                <li key={account.email}>
                  <button
                    type="button"
                    className="auth__demobtn"
                    onClick={() => {
                      setEmail(account.email);
                      setPassword(passwordFor(account.audience));
                      resetFeedback();
                      firstField.current?.focus();
                    }}
                  >
                    <span className="auth__demorole">{t(account.roleKey)}</span>
                    <span className="auth__demoemail" dir="ltr">{account.email}</span>
                    <span className="auth__demoscope">{account.scope}</span>
                    <span className="auth__demouse">{t('auth.demoUse')}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="auth__demonote">{t('auth.credentialsNote')}</p>
          </div>
        )}

        {!atSecondFactor && (
          <div className="auth__foot">
            {/* Invitations are a portal concept: a firm member is created by an
                administrator, not by accepting an invitation. */}
            {!isFirm && (
              <p>
                {t('auth.haveInvite')}{' '}
                <Link className="auth__link" to="/invite/accept">
                  {t('auth.acceptInvite')}
                </Link>
              </p>
            )}
            <p>
              <a className="auth__link" href={isFirm ? '/' : '/firm'}>
                {t(isFirm ? 'auth.enterPortal' : 'auth.enterFirm')}
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
