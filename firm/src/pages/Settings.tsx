/**
 * FIRM SETTINGS · §49, §52
 *
 * The tenant's policy, read-only.
 *
 * WHY READ-ONLY IS THE HONEST STATE, NOT A SHORTCUT
 *   There is no `PUT /admin/settings` endpoint. Rendering editable inputs
 *   against a server that cannot accept them would produce the worst failure
 *   available: a form that appears to save, discards the change, and shows no
 *   error. Every field here is presented as a value, with the read-only state
 *   stated once at the top rather than implied by disabled controls.
 *
 *   A `settings.manage` holder still sees the same view. The permission gates
 *   the WRITE, which does not exist yet — so claiming it would be a lie in the
 *   other direction.
 *
 * THESE VALUES ARE ENFORCED SERVER-SIDE
 *   `mfaRequired`, `passwordMinLength`, `sessionIdleMinutes` and
 *   `sessionAbsoluteMinutes` are read by the server on every relevant request.
 *   This page displays them; it does not implement them. That distinction is
 *   stated on the page, because an administrator reading "idle timeout 60 min"
 *   needs to know it is a fact about the server and not a preference stored in
 *   their browser.
 *
 * VAT IS A FRACTION
 *   `0.15`, not `15`. Rendered through the percentage formatter. Displaying the
 *   raw value would read as "0.15%" — a 100× error on a tax figure.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, IconRefresh,
  PageSkeleton, useFmt, useI18n,
} from '@kgm/ui';
import { useFirmSession } from '../auth/FirmSession.js';
import { firmApi, FirmApiError, type TenantSettings } from '../api/firm.js';
import { PageHead } from './Users.js';
import '../shell/shell.css';

export function Settings() {
  const { t, lang, pick } = useI18n();
  const fmt = useFmt();
  const { canAny } = useFirmSession();

  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FirmApiError | null>(null);

  const load = () => {
    setLoading(true);
    firmApi.settings()
      .then((res) => { setSettings(res); setError(null); })
      .catch((err) => {
        setSettings(null);
        setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable'));
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const canRead = canAny(['settings.read', 'settings.manage']);

  if (!canRead) {
    return (
      <div className="firm-page">
        <PageHead eyebrow={t('nav.admin')} title={t('settings.title')} sub={t('settings.sub')} />
        <EmptyState kind="denied" title={t('settings.denied.title')} description={t('settings.denied.body')} />
      </div>
    );
  }

  return (
    <div className="firm-page">
      <PageHead
        eyebrow={t('nav.admin')}
        title={t('settings.title')}
        sub={settings
          ? pick(settings.displayName, settings.displayNameAr) ?? t('settings.title')
          : t('common.loading')}
        actions={
          <Button variant="ghost" size="sm" icon={<IconRefresh size={15} />} onClick={load} disabled={loading}>
            {t('common.refresh')}
          </Button>
        }
      />

      <Alert tone="info">{t('settings.readonlyNotice')}</Alert>

      {loading ? (
        <PageSkeleton title={t('settings.title')} hint={t('common.loading')} />
      ) : error ? (
        error.isForbidden || error.isNotVisible ? (
          <EmptyState kind="denied" title={t('settings.denied.title')} description={t('settings.denied.body')} />
        ) : (
          <EmptyState
            kind={error.status === 0 ? 'offline' : 'error'}
            title={t('settings.error.title')}
            description={t('settings.error.body')}
            action={{ label: t('common.retry'), onClick: load }}
          />
        )
      ) : !settings ? (
        <EmptyState kind="empty" title={t('settings.error.title')} description={t('settings.error.body')} />
      ) : (
        <div className="firm-settingsgrid">
          <Card variant="default" sheen>
            <CardHeader title={t('settings.group.identity')} />
            <CardBody>
              <dl className="firm-deflist">
                <Row label={t('settings.displayName')} value={settings.displayName} />
                <Row label={t('settings.displayNameAr')} value={settings.displayNameAr} dir="rtl" />
                <Row label={t('settings.brandKey')} value={settings.brandKey} mono />
                <Row
                  label={t('settings.notificationChannels')}
                  value={settings.notificationChannels.length > 0
                    ? settings.notificationChannels.join(', ')
                    : null}
                  mono
                />
              </dl>
            </CardBody>
          </Card>

          <Card variant="default" sheen>
            <CardHeader title={t('settings.group.localisation')} />
            <CardBody>
              <dl className="firm-deflist">
                <Row label={t('settings.timezone')} value={settings.timezone} mono />
                <Row label={t('settings.currency')} value={settings.currency} />
                <Row
                  label={t('settings.fiscalYear')}
                  value={monthName(settings.fiscalYearStartMonth, lang)}
                />
              </dl>
            </CardBody>
          </Card>

          <Card variant="default" sheen accent="gold">
            <CardHeader title={t('settings.group.finance')} />
            <CardBody>
              <dl className="firm-deflist">
                <Row
                  label={t('settings.vatRate')}
                  /* A fraction (0.15). Rendered as a percentage — showing the raw
                     value would read as 0.15%, a 100× error on a tax figure. */
                  value={fmt.percent(settings.vatRate, 2)}
                  strong
                />
                <Row label={t('settings.currency')} value={fmt.currencyCode(settings.currency)} />
              </dl>
            </CardBody>
          </Card>

          <Card variant="default" sheen>
            <CardHeader title={t('settings.group.security')} />
            <CardBody>
              <dl className="firm-deflist">
                <div className="firm-deflist__row">
                  <dt className="firm-deflist__label">{t('settings.mfaRequired')}</dt>
                  <dd className="firm-deflist__value">
                    <Badge tone={settings.mfaRequired ? 'lime' : 'neutral'} dot={settings.mfaRequired}>
                      {settings.mfaRequired ? t('settings.enabled') : t('settings.disabled')}
                    </Badge>
                  </dd>
                </div>
                <Row
                  label={t('settings.passwordMinLength')}
                  value={t('settings.characters', { n: fmt.numberLatin(settings.passwordMinLength) })}
                />
                <Row
                  label={t('settings.sessionIdle')}
                  value={t('settings.minutes', { n: fmt.numberLatin(settings.sessionIdleMinutes) })}
                />
                <Row
                  label={t('settings.sessionAbsolute')}
                  value={t('settings.hours', {
                    n: fmt.numberLatin(Math.round(settings.sessionAbsoluteMinutes / 60)),
                  })}
                />
              </dl>
            </CardBody>
          </Card>

          {(settings.supportEmail || settings.supportPhone) && (
            <Card variant="default" sheen>
              <CardHeader title={t('settings.group.contact')} />
              <CardBody>
                <dl className="firm-deflist">
                  <Row label={t('settings.supportEmail')} value={settings.supportEmail} mono dir="ltr" />
                  <Row label={t('settings.supportPhone')} value={settings.supportPhone} mono dir="ltr" />
                </dl>
              </CardBody>
            </Card>
          )}

          {settings.mfaRequired && (
            /*
              Stated because it changes what the administrator should expect from
              the Users screen: role assignment and suspension will demand a
              verified second factor. Not a warning — a consequence of a policy
              this page is reporting.
            */
            <Alert tone="notice">{t('settings.mfaNotice')}</Alert>
          )}
        </div>
      )}
    </div>
  );
}

// ==========================================================================

/** One labelled value. An em dash for null: a blank is indistinguishable from a load failure. */
function Row({ label, value, mono, strong, dir }: {
  readonly label: string;
  readonly value: string | null | undefined;
  readonly mono?: boolean;
  readonly strong?: boolean;
  readonly dir?: 'ltr' | 'rtl';
}) {
  return (
    <div className="firm-deflist__row">
      <dt className="firm-deflist__label">{label}</dt>
      <dd className="firm-deflist__value">
        {value === null || value === undefined || value === ''
          ? <span className="firm-muted">—</span>
          : (
            <span
              className={[
                mono ? 'firm-cellmono' : '',
                strong ? 'firm-cellstrong' : '',
              ].filter(Boolean).join(' ') || undefined}
              dir={dir}
            >
              {value}
            </span>
          )}
      </dd>
    </div>
  );
}

/** Fiscal year start as a month name. The wire value is 1-12. */
function monthName(month: number, lang: 'ar' | 'en'): string {
  const idx = Math.min(Math.max(month, 1), 12) - 1;
  try {
    // A date whose day is pinned to the 1st, so no timezone shift can move the month.
    const d = new Date(Date.UTC(2001, idx, 1));
    return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA-u-ca-gregory' : 'en-GB', {
      month: 'long', timeZone: 'UTC',
    }).format(d);
  } catch {
    return String(month);
  }
}
