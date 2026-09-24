import { useEffect, useState, type FormEvent } from 'react';
import { get, patch, post, ApiError } from '../api/client';
import type { Calendar, Lang } from '../api/client';
import type { Profile as ProfileDto } from '../api/types';
import { useAuth } from '../auth';
import { translate, useI18n } from '../i18n';
import { pick } from '../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorAlert,
  Field,
  Icon,
  Input,
  KeyValue,
  PageLoader,
  Select,
  useAsync,
} from '../components/ui';
import { PageHeader } from '../components/page';

const COUNTRIES = ['SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'EG', 'JO', 'GB', 'US', 'OTHER'];

/**
 * Profile (§25, §28).
 *
 * Two kinds of field are shown side by side and deliberately look different:
 *  · writable — the person's own contact details and display name, saved with
 *    PATCH /profile against a server-side allowlist;
 *  · read-only — everything the firm owns (the client entity, its masked
 *    national identifier, its verification state). These are rendered masked,
 *    with no input, because the API refuses writes to them and §46 turns an
 *    attempted write into an audited 403 rather than a silent no-op.
 */
export default function Profile() {
  const { t, fmt, lang, setLang, setCalendar } = useI18n();
  const { session, refresh } = useAuth();
  const { data, error, loading, reload } = useAsync(() => get<ProfileDto>('/api/client/profile'), []);

  const [form, setForm] = useState({
    displayName: '',
    displayNameAr: '',
    jobTitle: '',
    phone: '',
    addressLine: '',
    city: '',
    country: 'SA',
  });
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setForm({
      displayName: data.displayName ?? '',
      displayNameAr: data.displayNameAr ?? '',
      jobTitle: data.jobTitle ?? '',
      phone: data.phone ?? '',
      addressLine: data.client.addressLine ?? '',
      city: data.client.city ?? '',
      country: data.client.country ?? 'SA',
    });
  }, [data]);

  if (loading && !data) return <PageLoader />;
  if (!data) return <ErrorAlert error={error} onRetry={reload} />;

  const p = data;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    try {
      // Only allowlisted keys are sent. Adding anything else — clientId, role,
      // email, nationalId — is a 403 field_not_writable with an audit entry.
      await patch('/api/client/profile', {
        displayName: form.displayName.trim(),
        displayNameAr: form.displayNameAr.trim() || null,
        jobTitle: form.jobTitle.trim() || null,
        phone: form.phone.trim() || null,
        addressLine: form.addressLine.trim() || null,
        city: form.city.trim() || null,
        country: form.country,
      });
      setSaved(true);
      reload();
      void refresh();
    } catch (err) {
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  };

  const savePreference = async (next: { language?: Lang; calendar?: Calendar }) => {
    setSaveError(null);
    try {
      await patch('/api/client/preferences', next);
      if (next.language) setLang(next.language);
      if (next.calendar) setCalendar(next.calendar);
      setSaved(true);
      reload();
      void refresh();
    } catch (err) {
      setSaveError(err);
    }
  };

  const sendVerification = async () => {
    setVerifying(true);
    setVerifyNote(null);
    try {
      await post('/api/auth/verify-email/send', {});
      setVerifyNote(t('profile.verifySent'));
    } catch (err) {
      setVerifyNote(err instanceof ApiError ? err.code : 'network_error');
    } finally {
      setVerifying(false);
    }
  };

  const name = pick(lang, p.displayName, p.displayNameAr);

  return (
    <>
      <PageHeader title={t('profile.title')} subtitle={t('profile.subtitle')} />

      {saveError ? <ErrorAlert error={saveError} /> : null}
      {saved && <Alert tone="ok">{t('profile.saved')}</Alert>}

      <div className="grid grid--2">
        <Card title={t('profile.personal')}>
          <form onSubmit={submit} noValidate>
            <div className="grid grid--2">
              <Field label={t('profile.displayName')} htmlFor="pf-name">
                <Input
                  id="pf-name"
                  value={form.displayName}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                  minLength={2}
                  maxLength={120}
                  required
                />
              </Field>
              <Field label={t('profile.displayNameAr')} htmlFor="pf-name-ar">
                <Input
                  id="pf-name-ar"
                  dir="rtl"
                  value={form.displayNameAr}
                  onChange={(e) => setForm({ ...form, displayNameAr: e.target.value })}
                  maxLength={120}
                />
              </Field>
            </div>

            <Field label={t('profile.jobTitle')} htmlFor="pf-job" hint={t('common.optional')}>
              <Input
                id="pf-job"
                value={form.jobTitle}
                onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
                maxLength={120}
              />
            </Field>

            <Field label={t('profile.email')} htmlFor="pf-email" hint={t('profile.readonlyNote')}>
              <Input id="pf-email" dir="ltr" value={p.emailMasked} readOnly disabled />
            </Field>

            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBlockEnd: 14 }}>
              {p.emailVerified ? (
                <Badge tone="ok">
                  <Icon name="check" size={12} />
                  {t('profile.emailVerified')}
                </Badge>
              ) : (
                <>
                  <Badge tone="warn">
                    <Icon name="alert" size={12} />
                    {t('profile.emailUnverified')}
                  </Badge>
                  <Button type="button" variant="ghost" size="sm" loading={verifying} onClick={() => void sendVerification()}>
                    <Icon name="mail" size={14} />
                    {t('profile.verifyNow')}
                  </Button>
                </>
              )}
              {verifyNote && (
                <span className="small muted">
                  {translate(lang, `err.${verifyNote}`)}
                </span>
              )}
            </div>

            <Field label={t('profile.phone')} htmlFor="pf-phone" hint={t('common.optional')}>
              <Input
                id="pf-phone"
                dir="ltr"
                inputMode="tel"
                autoComplete="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="+966 5X XXX XXXX"
                maxLength={20}
              />
            </Field>

            <Field label={t('profile.address')} htmlFor="pf-addr" hint={t('common.optional')}>
              <Input
                id="pf-addr"
                value={form.addressLine}
                onChange={(e) => setForm({ ...form, addressLine: e.target.value })}
                maxLength={200}
              />
            </Field>

            <div className="grid grid--2">
              <Field label={t('profile.city')} htmlFor="pf-city">
                <Input
                  id="pf-city"
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  maxLength={80}
                />
              </Field>
              <Field label={t('profile.country')} htmlFor="pf-country">
                <Select id="pf-country" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
                  {COUNTRIES.map((c) => (
                    <option key={c} value={c}>
                      {translate(lang, `country.${c}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Button type="submit" variant="primary" loading={busy} style={{ marginBlockStart: 6 }}>
              <Icon name="check" size={16} />
              {t('common.save')}
            </Button>
          </form>
        </Card>

        <div>
          <Card title={t('profile.entity')} hint={t('profile.maskedNote')}>
            <KeyValue
              items={[
                [t('profile.entityName'), <b key="n">{pick(lang, p.client.name, p.client.nameAr)}</b>],
                [
                  t('profile.entityType'),
                  translate(lang, `profile.type.${p.client.type}`),
                ],
                [
                  t('profile.nationalId'),
                  p.client.nationalIdMasked ? <span className="ltr mono" key="id">{p.client.nationalIdMasked}</span> : '—',
                ],
                [
                  t('profile.commercialReg'),
                  p.client.commercialRegMasked ? (
                    <span className="ltr mono" key="cr">{p.client.commercialRegMasked}</span>
                  ) : (
                    '—'
                  ),
                ],
                [
                  t('profile.identityVerified'),
                  p.client.identityVerified ? (
                    <Badge tone="ok" key="v">
                      <Icon name="check" size={12} />
                      {t('common.yes')}
                    </Badge>
                  ) : (
                    <Badge tone="warn" key="v">
                      {t('profile.identityUnverified')}
                    </Badge>
                  ),
                ],
                [t('profile.verificationNote'), p.client.verificationNote ?? '—'],
                [t('profile.firm'), pick(lang, p.firm.name, p.firm.nameAr)],
                [t('profile.memberSince'), p.memberSince ? fmt.date(p.memberSince) : '—'],
                [t('profile.lastLogin'), p.lastLoginAt ? fmt.dateTime(p.lastLoginAt) : '—'],
              ]}
            />
            <p className="small muted" style={{ marginBlockStart: 10 }}>
              <Icon name="lock" size={13} /> {t('profile.readonlyNote')}
            </p>
          </Card>

          <Card title={t('profile.prefs')}>
            <Field label={t('profile.language')} htmlFor="pf-lang">
              <Select
                id="pf-lang"
                value={p.preferredLanguage}
                onChange={(e) => void savePreference({ language: e.target.value as Lang })}
              >
                <option value="ar">العربية</option>
                <option value="en">English</option>
              </Select>
            </Field>
            <Field label={t('profile.calendar')} htmlFor="pf-cal">
              <Select
                id="pf-cal"
                value={p.preferredCalendar}
                onChange={(e) => void savePreference({ calendar: e.target.value as Calendar })}
              >
                <option value="islamic-umalqura">{t('profile.calendar.islamic-umalqura')}</option>
                <option value="gregory">{t('profile.calendar.gregory')}</option>
              </Select>
            </Field>
            <p className="small muted">
              <Icon name="info" size={13} /> {t('profile.prefsNote')} · {fmt.date(new Date().toISOString())}
            </p>
          </Card>

          {session.security && (
            <Card title={t('sec.title')}>
              <KeyValue
                items={[
                  [
                    t('sec.mfa'),
                    session.security.mfaEnabled ? (
                      <Badge tone="ok" key="m">{t('sec.mfaOn')}</Badge>
                    ) : (
                      <Badge tone="warn" key="m">{t('sec.mfaOff')}</Badge>
                    ),
                  ],
                  [
                    t('sec.emailVerified'),
                    session.security.emailVerified ? t('common.yes') : t('common.no'),
                  ],
                  [
                    t('sec.sessions'),
                    session.security.sessionExpiresAt ? fmt.relative(session.security.sessionExpiresAt) : '—',
                  ],
                ]}
              />
            </Card>
          )}
        </div>
      </div>

      <p className="small muted" style={{ marginBlockStart: 14 }}>
        {t('app.name')} · {name}
      </p>
    </>
  );
}
