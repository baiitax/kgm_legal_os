import { useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post, ApiError } from '../api/client';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, Icon, Input, PasswordStrength, assessPassword } from '../components/ui';

/**
 * Password reset completion (§12).
 *
 * The token arrives in the link the server emailed; it is single-use, short
 * lived and hashed at rest. Completing the reset revokes every other session
 * server-side, which is why the confirmation copy says so plainly.
 */
export default function ResetPassword() {
  const { t } = useI18n();
  const { boot } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const minLength = boot?.passwordPolicy.minLength ?? 12;
  const personal = useMemo(
    () => (email.includes('@') ? [email.split('@')[0] ?? ''] : []),
    [email],
  );
  const strength = assessPassword(password, { minLength, disallow: personal });
  const mismatch = confirm.length > 0 && confirm !== password;

  if (!token) {
    return (
      <div className="auth">
        <div className="auth__card">
          <div className="auth__head">
            <div className="brand-mark" aria-hidden="true">
              <Icon name="lock" size={28} />
            </div>
            <h1>{t('auth.resetTitle')}</h1>
          </div>
          <div className="auth__body">
            <div className="alert alert--error" role="alert">
              <Icon name="alert" size={18} />
              <div className="alert__body">{t('err.token_invalid')}</div>
            </div>
            <p className="muted small">{t('auth.resetMissingToken')}</p>
            <Link className="btn btn--ghost btn--block" to="/login">
              <Icon name="back" size={16} />
              {t('auth.backToSignIn')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/reset-password', { token, password, confirmPassword: confirm });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="auth">
        <div className="auth__card">
          <div className="auth__head">
            <div className="brand-mark" aria-hidden="true">
              <Icon name="check" size={28} />
            </div>
            <h1>{t('auth.resetTitle')}</h1>
          </div>
          <div className="auth__body">
            <div className="alert alert--success" role="status">
              <Icon name="check" size={18} />
              <div className="alert__body">{t('auth.resetDone')}</div>
            </div>
            <p className="muted small">{t('auth.resetSignedOut')}</p>
            <Link className="btn btn--primary btn--block" to="/login">
              <Icon name="lock" size={16} />
              {t('auth.signIn')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__head">
          <div className="brand-mark" aria-hidden="true">
            <Icon name="lock" size={28} />
          </div>
          <h1>{t('auth.resetTitle')}</h1>
          <p>{t('auth.resetSub')}</p>
        </div>

        <div className="auth__body">
          <form onSubmit={submit} noValidate>
            <Field label={t('auth.email')} htmlFor="email" hint={t('auth.resetEmailHint')}>
              <Input
                id="email"
                type="email"
                dir="ltr"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
              />
            </Field>

            <Field label={t('auth.newPassword')} htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={minLength}
                autoFocus
              />
            </Field>
            <PasswordStrength value={password} minLength={minLength} disallow={personal} />

            <Field
              label={t('auth.confirmPassword')}
              htmlFor="confirm"
              error={mismatch ? t('auth.passwordMismatch') : undefined}
            >
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                invalid={mismatch}
              />
            </Field>

            {error ? <ErrorAlert error={error} /> : null}

            <Button type="submit" variant="primary" block loading={busy} disabled={!strength.ok || mismatch}>
              <Icon name="check" size={16} />
              {t('auth.savePassword')}
            </Button>
            <Link className="btn btn--ghost btn--block" to="/login" style={{ marginBlockStart: 8 }}>
              <Icon name="back" size={16} />
              {t('auth.backToSignIn')}
            </Link>
          </form>
        </div>
      </div>
    </div>
  );
}
