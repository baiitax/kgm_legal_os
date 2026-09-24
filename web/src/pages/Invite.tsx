import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post, ApiError } from '../api/client';
import type { InvitePeek } from '../api/types';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { Button, ErrorAlert, Field, Icon, Input, KeyValue, PageLoader, PasswordStrength, assessPassword } from '../components/ui';

/**
 * Invitation acceptance (§3).
 *
 * The link carries a single-use, expiring token. `peek` returns only what the
 * recipient is entitled to see before authenticating — the address it was sent
 * to and the firm's name — and this screen never lets the visitor choose a
 * client entity, a role or a tenant: those come from the invitation row on the
 * server. Anything typed here that tries to claim otherwise is rejected with a
 * 403 and an audit entry (§46).
 */
export default function Invite() {
  const { t, fmt, lang, errorText } = useI18n();
  const { boot, refresh } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [peek, setPeek] = useState<InvitePeek | null>(null);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const policy = boot?.passwordPolicy;
  // The server rejects passwords containing the person's own identifiers, so the
  // meter is fed the same material and cannot promise something the API denies.
  const personal = useMemo(() => {
    if (!peek) return [];
    const local = peek.email.split('@')[0] ?? '';
    const parts = `${peek.displayName} ${peek.displayNameAr ?? ''}`.split(/[\s._-]+/).filter((w) => w.length > 2);
    return Array.from(new Set([local, ...parts].filter(Boolean)));
  }, [peek]);
  const strength = assessPassword(password, { minLength: policy?.minLength ?? 12, disallow: personal });

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!token) {
        if (alive) {
          setInvalid('invitation_invalid');
          setLoading(false);
        }
        return;
      }
      try {
        const res = await get<InvitePeek>(`/api/auth/invite/peek?token=${encodeURIComponent(token)}`);
        if (alive) setPeek(res);
      } catch (err) {
        if (alive) setInvalid(err instanceof ApiError ? err.code : 'network_error');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Only `token`, `password` and `confirmPassword` are sent. The server
      // derives tenant, client and role from the invitation itself.
      await post('/api/auth/invite/accept', { token, password, confirmPassword: confirm });
      await refresh();
      window.location.assign('/portal');
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
      setBusy(false);
    }
  };

  if (loading) return <PageLoader />;

  if (!peek || invalid) {
    return (
      <div className="auth">
        <div className="auth__card">
          <div className="auth__head">
            <div className="brand-mark" aria-hidden="true">
              <Icon name="mail" size={28} />
            </div>
            <h1>{t('invite.title')}</h1>
          </div>
          <div className="auth__body">
            <div className="alert alert--error" role="alert">
              <Icon name="alert" size={18} />
              <div className="alert__body">{errorText(invalid ?? 'invitation_invalid')}</div>
            </div>
            <p className="muted small">
              {invalid === 'invitation_expired' ? t('invite.expiredHelp') : t('invite.invalidHelp')}
            </p>
            <Link className="btn btn--ghost btn--block" to="/login">
              <Icon name="back" size={16} />
              {t('auth.backToSignIn')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const name = lang === 'ar' ? (peek.displayNameAr ?? peek.displayName) : peek.displayName;
  const firm = lang === 'ar' ? (peek.firmNameAr ?? peek.firmName) : peek.firmName;
  const mismatch = confirm.length > 0 && confirm !== password;

  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__head">
          <div className="brand-mark" aria-hidden="true">
            <Icon name="mail" size={28} />
          </div>
          <h1>{t('invite.title')}</h1>
          <p>{t('invite.subtitle')}</p>
        </div>

        <div className="auth__body">
          <KeyValue
            items={[
              [t('invite.firm'), firm],
              [t('invite.for'), name],
              [t('profile.email'), <span className="ltr" key="e">{peek.email}</span>],
              [
                t('invite.expires'),
                <span key="x">
                  {fmt.date(peek.expiresAt)} <span className="muted">({fmt.relative(peek.expiresAt)})</span>
                </span>,
              ],
            ]}
          />

          <form onSubmit={submit} noValidate style={{ marginBlockStart: 16 }}>
            <Field label={t('auth.newPassword')} htmlFor="password" hint={t('invite.passwordHint')}>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={policy?.minLength}
                autoFocus
              />
            </Field>
            <PasswordStrength value={password} minLength={policy?.minLength ?? 12} disallow={personal} />

            <Field label={t('auth.confirmPassword')} htmlFor="confirm" error={mismatch ? t('auth.passwordMismatch') : undefined}>
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

            <Button
              type="submit"
              variant="primary"
              block
              loading={busy}
              disabled={!strength.ok || mismatch}
            >
              <Icon name="check" size={16} />
              {t('invite.createAccount')}
            </Button>

            <p className="auth__foot">
              {t('invite.alreadyHave')}{' '}
              <Link className="auth__link" to="/login">
                {t('auth.signIn')}
              </Link>
            </p>
          </form>
        </div>

        <div className="auth__legal">
          <p>{t('invite.tokenSingleUse')}</p>
        </div>
      </div>
    </div>
  );
}
