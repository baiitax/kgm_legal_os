import { useState, type FormEvent } from 'react';
import { get, post } from '../api/client';
import type { MfaEnrollConfirm, MfaEnrollStart, SecurityOverview } from '../api/types';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  ErrorAlert,
  Field,
  Icon,
  Input,
  KeyValue,
  Modal,
  PageLoader,
  useAsync,
  useCopied,
} from '../components/ui';
import { PageHeader } from '../components/page';

/**
 * Security centre (§26).
 *
 * Every control here maps to an endpoint that re-authenticates or re-verifies
 * before it acts: changing a password needs the current one, disabling MFA needs
 * the password AND a valid code, revoking a session is scoped to the caller's own
 * rows. The screen can therefore be handed to a client without any of its
 * buttons becoming a privilege boundary — the boundary is the API.
 *
 * Recovery codes are shown exactly once, straight from the enroll response, and
 * are never re-fetchable: the server stores only their hashes.
 */
export default function Security() {
  const { t, fmt } = useI18n();
  const { refresh } = useAuth();
  const { data, error, loading, reload } = useAsync(() => get<SecurityOverview>('/api/client/security'), []);

  const [pwOpen, setPwOpen] = useState(false);
  const [enroll, setEnroll] = useState<MfaEnrollStart | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (loading && !data) return <PageLoader />;
  if (!data) return <ErrorAlert error={error} onRetry={reload} />;

  const sec = data;

  const act = async (id: string, fn: () => Promise<unknown>, then?: () => void) => {
    setBusyId(id);
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      reload();
      void refresh();
      then?.();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusyId(null);
    }
  };

  const startEnroll = () =>
    act('enroll-start', async () => {
      const res = await post<MfaEnrollStart>('/api/auth/mfa/enroll/start', {});
      setEnroll(res);
    });

  return (
    <>
      <PageHeader title={t('sec.title')} subtitle={t('sec.subtitle')} />

      {actionError ? <ErrorAlert error={actionError} /> : null}
      {notice && <Alert tone="ok">{notice}</Alert>}

      {!sec.emailVerified && (
        <Alert tone="warn" title={t('profile.emailUnverified')}>
          {t('sec.verifyPrompt')}
        </Alert>
      )}

      <div className="grid grid--2">
        <Card
          title={t('sec.password')}
          actions={
            <Button variant="ghost" size="sm" onClick={() => setPwOpen(true)}>
              <Icon name="key" size={15} />
              {t('sec.changePassword')}
            </Button>
          }
        >
          <KeyValue
            items={[
              [t('sec.lastChanged'), sec.password.lastChangedAt ? fmt.date(sec.password.lastChangedAt) : '—'],
              [
                t('sec.ageDays', { n: sec.password.ageDays ?? 0 }),
                sec.password.ageDays !== null ? t('common.yes') : '—',
              ],
              [t('auth.minPassword', { n: sec.password.minLength }), t('common.yes')],
              [t('sec.lastLogin'), sec.lastLoginAt ? fmt.dateTime(sec.lastLoginAt) : '—'],
            ]}
          />
          {sec.password.ageDays !== null && sec.password.ageDays > 365 && (
            <Alert tone="warn" title={t('sec.passwordOld')}>
              {t('sec.passwordOldBody')}
            </Alert>
          )}
        </Card>

        <Card
          title={t('sec.mfa')}
          actions={
            sec.mfa.enabled ? (
              <Button variant="ghost" size="sm" onClick={() => setDisableOpen(true)}>
                <Icon name="close" size={15} />
                {t('sec.mfaDisable')}
              </Button>
            ) : (
              <Button variant="primary" size="sm" loading={busyId === 'enroll-start'} onClick={() => void startEnroll()}>
                <Icon name="shield" size={15} />
                {t('sec.mfaEnable')}
              </Button>
            )
          }
        >
          <KeyValue
            items={[
              [
                t('sec.mfa'),
                sec.mfa.enabled ? (
                  <Badge tone="ok" key="s">
                    <Icon name="check" size={12} />
                    {t('sec.mfaOn')}
                  </Badge>
                ) : (
                  <Badge tone="warn" key="s">
                    {t('sec.mfaOff')}
                  </Badge>
                ),
              ],
              [
                t('sec.mfaMethod'),
                sec.mfa.method === 'totp'
                  ? t('sec.mfaTotp')
                  : sec.mfa.method === 'email_otp'
                    ? t('sec.mfaEmail')
                    : '—',
              ],
            ]}
          />
          <p className="small muted" style={{ marginBlockStart: 10 }}>
            <Icon name="info" size={13} />{' '}
            {t('sec.mfaPlanned')}: {sec.mfa.plannedMethods.join(', ') || '—'}
          </p>
        </Card>

        <Card
          title={t('sec.sessions')}
          hint={t('sec.sessionsSub')}
          actions={
            sec.sessions.length > 1 ? (
              <Button
                variant="ghost"
                size="sm"
                loading={busyId === 'revoke-all'}
                onClick={() =>
                  void act('revoke-all', () => post('/api/client/security/sessions/revoke-all-others', {}), () =>
                    setNotice(t('sec.revoked')),
                  )
                }
              >
                <Icon name="logout" size={15} />
                {t('sec.revokeAll')}
              </Button>
            ) : undefined
          }
        >
          {sec.sessions.length === 0 ? (
            <Empty icon="device" title={t('common.none')} />
          ) : (
            <ul className="list">
              {sec.sessions.map((s) => (
                <li key={s.id} className="list__item">
                  <span className="list__icon">
                    <Icon name={s.os.toLowerCase().includes('android') || s.os.toLowerCase().includes('ios') ? 'phone' : 'device'} size={17} />
                  </span>
                  <span className="list__main">
                    <span className="list__title">
                      {s.deviceLabel || s.browser}
                      {s.current && (
                        <Badge tone="info">
                          {t('sec.current')}
                        </Badge>
                      )}
                    </span>
                    <span className="list__meta">
                      <span>{s.browser}</span>
                      <span>{s.os}</span>
                      {s.ipCountry && <span className="ltr">{s.ipCountry}</span>}
                      <span>{fmt.relative(s.lastActivity)}</span>
                    </span>
                  </span>
                  <span className="list__end">
                    {!s.current && (
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busyId === s.id}
                        onClick={() =>
                          void act(s.id, () =>
                            post(`/api/client/security/sessions/${encodeURIComponent(s.id)}/revoke`, {}),
                          )
                        }
                      >
                        <Icon name="close" size={14} />
                        {t('sec.revoke')}
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div>
          <Card title={t('sec.devices')} hint={t('sec.noDevices')}>
            {sec.devices.length === 0 ? (
              <Empty icon="device" title={t('sec.noDevices')} />
            ) : (
              <ul className="list">
                {sec.devices.map((d) => (
                  <li key={d.id} className="list__item">
                    <span className="list__icon">
                      <Icon name="device" size={17} />
                    </span>
                    <span className="list__main">
                      <span className="list__title">{d.label}</span>
                      <span className="list__meta">
                        <span>{d.browser}</span>
                        <span>{d.os}</span>
                        {d.lastUsedAt && <span>{fmt.relative(d.lastUsedAt)}</span>}
                        {d.trustedUntil && <span>{t('sec.trustedUntil')}: {fmt.date(d.trustedUntil)}</span>}
                      </span>
                    </span>
                    <span className="list__end">
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busyId === d.id}
                        onClick={() =>
                          void act(d.id, () =>
                            post(`/api/client/security/devices/${encodeURIComponent(d.id)}/revoke`, {}),
                          )
                        }
                      >
                        <Icon name="close" size={14} />
                        {t('sec.revoke')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={t('sec.alerts')}>
            {sec.alerts.length === 0 ? (
              <Empty icon="shield" title={t('sec.noAlerts')} />
            ) : (
              <ul className="list">
                {sec.alerts.map((a) => (
                  <li key={a.id} className="list__item">
                    <span className="list__icon">
                      <Icon name="alert" size={16} />
                    </span>
                    <span className="list__main">
                      <span className="list__title">{a.message}</span>
                      <span className="list__meta">
                        <Badge tone={a.severity === 'high' || a.severity === 'critical' ? 'danger' : 'warn'}>
                          {a.kind.replace(/_/g, ' ')}
                        </Badge>
                        <span>{fmt.dateTime(a.createdAt)}</span>
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {pwOpen && (
        <PasswordModal
          onClose={() => setPwOpen(false)}
          onDone={() => setNotice(t('sec.passwordChanged'))}
        />
      )}

      {enroll && (
        <EnrollModal
          start={enroll}
          onClose={() => setEnroll(null)}
          onDone={(result) => {
            setEnroll(null);
            setCodes(result.recoveryCodes);
            reload();
            void refresh();
          }}
        />
      )}

      {codes && <RecoveryModal codes={codes} onClose={() => setCodes(null)} />}

      {disableOpen && (
        <DisableMfaModal
          onClose={() => setDisableOpen(false)}
          onDone={() => {
            setDisableOpen(false);
            setNotice(t('sec.mfaOff'));
            reload();
            void refresh();
          }}
        />
      )}
    </>
  );
}

function PasswordModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const { boot } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const minLength = boot?.passwordPolicy.minLength ?? 12;
  const mismatch = confirm.length > 0 && confirm !== next;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/password/change', {
        currentPassword: current,
        newPassword: next,
        confirmPassword: confirm,
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('sec.changePassword')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="pw-form" variant="primary" loading={busy} disabled={mismatch}>
            <Icon name="key" size={16} />
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="pw-form" onSubmit={submit} noValidate>
        <Field label={t('sec.currentPassword')} htmlFor="pw-cur">
          <Input
            id="pw-cur"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field label={t('auth.newPassword')} htmlFor="pw-new" hint={t('auth.minPassword', { n: minLength })}>
          <Input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={minLength}
          />
        </Field>
        <Field
          label={t('auth.confirmPassword')}
          htmlFor="pw-conf"
          error={mismatch ? t('auth.passwordMismatch') : undefined}
        >
          <Input
            id="pw-conf"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            invalid={mismatch}
          />
        </Field>
        {error ? <ErrorAlert error={error} /> : null}
        <p className="small muted" style={{ marginBlockStart: 10 }}>
          <Icon name="shield" size={13} /> {t('sec.passwordChangeNote')}
        </p>
      </form>
    </Modal>
  );
}

function EnrollModal({
  start,
  onClose,
  onDone,
}: {
  start: MfaEnrollStart;
  onClose: () => void;
  onDone: (result: MfaEnrollConfirm) => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { copied, copy } = useCopied();

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await post<MfaEnrollConfirm>('/api/auth/mfa/enroll/confirm', {
        challengeToken: start.challengeToken,
        code: code.trim(),
      });
      onDone(res);
    } catch (err) {
      setError(err);
      setCode('');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('sec.mfaEnable')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="mfa-form" variant="primary" loading={busy} disabled={code.trim().length < 6}>
            <Icon name="shield" size={16} />
            {t('auth.verify')}
          </Button>
        </>
      }
    >
      <form id="mfa-form" onSubmit={confirm} noValidate>
        <Alert tone="info" title={t('sec.mfaScan')}>
          {t('sec.enrollExpires', { n: start.expiresInMinutes })}
        </Alert>

        {/* The otpauth URI is offered as a link and as copyable text. A QR image
            is not rendered because the CSP allows no external image source and
            the portal ships no encoder; the manual key is the supported path. */}
        <div className="kv" style={{ marginBlockStart: 12 }}>
          <a className="btn btn--ghost btn--sm" href={start.otpauthUri}>
            <Icon name="external" size={14} />
            {t('sec.openAuthenticator')}
          </a>
        </div>

        <Field label={t('sec.mfaSecret')} htmlFor="mfa-secret">
          <div className="row" style={{ gap: 8 }}>
            <Input id="mfa-secret" dir="ltr" className="mono" readOnly value={start.secret} />
            <Button type="button" variant="ghost" onClick={() => void copy(start.secret)}>
              <Icon name={copied ? 'check' : 'copy'} size={15} />
              {copied ? t('common.copied') : t('common.copy')}
            </Button>
          </div>
        </Field>

        <Field label={t('sec.mfaConfirmCode')} htmlFor="mfa-code">
          <Input
            id="mfa-code"
            dir="ltr"
            className="code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="123456"
            required
            autoFocus
          />
        </Field>

        {error ? <ErrorAlert error={error} /> : null}
      </form>
    </Modal>
  );
}

function RecoveryModal({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const { t } = useI18n();
  const { copied, copy } = useCopied();

  return (
    <Modal
      open
      onClose={onClose}
      title={t('sec.recoveryCodes')}
      footer={
        <>
          <Button variant="ghost" onClick={() => void copy(codes.join('\n'))}>
            <Icon name={copied ? 'check' : 'copy'} size={15} />
            {copied ? t('common.copied') : t('common.copy')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <Alert tone="warn" title={t('sec.recoveryNote')}>
        {t('sec.recoveryOnce')}
      </Alert>
      <ul className="codes">
        {codes.map((c, i) => (
          <li key={i} className="ltr mono">
            {c}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function DisableMfaModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Both factors are required: password alone is not enough to weaken the
      // account, and a code alone is not enough either.
      await post('/api/auth/mfa/disable', { password, code: code.trim() });
      onDone();
    } catch (err) {
      setError(err);
      setCode('');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('sec.mfaDisable')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="mfa-off" variant="danger" loading={busy}>
            <Icon name="close" size={16} />
            {t('sec.mfaDisable')}
          </Button>
        </>
      }
    >
      <form id="mfa-off" onSubmit={submit} noValidate>
        <Alert tone="warn">{t('sec.mfaDisableWarn')}</Alert>
        <Field label={t('auth.password')} htmlFor="off-pw">
          <Input
            id="off-pw"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field label={t('auth.mfaCode')} htmlFor="off-code">
          <Input
            id="off-code"
            dir="ltr"
            className="code-input"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            required
          />
        </Field>
        {error ? <ErrorAlert error={error} /> : null}
      </form>
    </Modal>
  );
}
