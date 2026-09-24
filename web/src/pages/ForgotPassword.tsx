import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { post, ApiError } from '../api/client';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, Icon, Input } from '../components/ui';

/**
 * Password reset request (§12).
 *
 * The response is identical whether or not the address exists — the server says
 * so explicitly, and this screen renders one fixed message either way. That is
 * the point: a reset form must not become an account-enumeration oracle.
 */
export default function ForgotPassword() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/forgot-password', { email: email.trim() });
      // Always show success. Even a transport-level failure gets the neutral
      // message, because distinguishing it would leak whether the account exists.
      setSent(true);
    } catch (err) {
      setSent(true);
      if (err instanceof ApiError && err.code === 'rate_limited') setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__head">
          <div className="brand-mark" aria-hidden="true">
            <Icon name="mail" size={28} />
          </div>
          <h1>{t('auth.forgotTitle')}</h1>
          <p>{t('auth.forgotSub')}</p>
        </div>

        <div className="auth__body">
          {sent ? (
            <>
              <div className="alert alert--info" role="status">
                <Icon name="check" size={18} />
                <div className="alert__body">{t('auth.forgotSent')}</div>
              </div>
              {error ? <ErrorAlert error={error} /> : null}
              <Link className="btn btn--ghost btn--block" to="/login">
                <Icon name="back" size={16} />
                {t('auth.backToSignIn')}
              </Link>
            </>
          ) : (
            <form onSubmit={submit} noValidate>
              <Field label={t('auth.email')} htmlFor="email">
                <Input
                  id="email"
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

              {error ? <ErrorAlert error={error} /> : null}

              <Button type="submit" variant="primary" block loading={busy}>
                <Icon name="mail" size={16} />
                {t('auth.sendReset')}
              </Button>
              <Link className="btn btn--ghost btn--block" to="/login" style={{ marginBlockStart: 8 }}>
                <Icon name="back" size={16} />
                {t('auth.backToSignIn')}
              </Link>
            </form>
          )}
        </div>

        <div className="auth__legal">
          <p>{t('auth.resetExpires')}</p>
        </div>
      </div>
    </div>
  );
}
