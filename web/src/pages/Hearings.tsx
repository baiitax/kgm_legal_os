import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api/client';
import type { Hearing } from '../api/types';
import { useI18n } from '../i18n';
import { pick } from '../lib/format';
import { Button, Card, Empty, ErrorAlert, Icon, PageLoader, useAsync } from '../components/ui';
import { PageHeader } from '../components/page';

/**
 * Hearings (§15).
 *
 * Upcoming and past are split in the browser purely for reading order — the
 * server returns only the hearings attached to this client's matters, so there
 * is nothing here to widen.
 */
export default function Hearings() {
  const { t, fmt } = useI18n();
  const { data, error, loading, reload } = useAsync(() => get<{ hearings: Hearing[] }>('/api/client/hearings'), []);

  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const all = [...(data?.hearings ?? [])].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    return {
      upcoming: all.filter((h) => new Date(h.scheduledAt).getTime() >= now),
      past: all.filter((h) => new Date(h.scheduledAt).getTime() < now).reverse(),
    };
  }, [data]);

  if (loading && !data) return <PageLoader />;

  return (
    <>
      <PageHeader
        title={t('hearing.title')}
        subtitle={t('hearing.subtitle')}
        actions={
          <Button variant="ghost" size="sm" onClick={reload}>
            <Icon name="refresh" size={15} />
            {t('common.retry')}
          </Button>
        }
      />

      {error ? <ErrorAlert error={error} onRetry={reload} /> : null}

      {upcoming.length === 0 && past.length === 0 ? (
        <Empty icon="gavel" title={t('hearing.empty')} />
      ) : (
        <>
          <Card title={t('hearing.upcoming')} hint={String(upcoming.length)}>
            {upcoming.length === 0 ? (
              <Empty icon="gavel" title={t('hearing.empty')} />
            ) : (
              upcoming.map((h) => <HearingCard key={h.id} hearing={h} />)
            )}
          </Card>

          {past.length > 0 && (
            <Card title={t('hearing.past')} hint={String(past.length)}>
              {past.map((h) => (
                <HearingCard key={h.id} hearing={h} muted />
              ))}
            </Card>
          )}
        </>
      )}

      <p className="small muted" style={{ marginBlockStart: 14 }}>
        <Icon name="info" size={13} /> {fmt.dateTime(new Date().toISOString())}
      </p>
    </>
  );
}

function HearingCard({ hearing, muted }: { hearing: Hearing; muted?: boolean }) {
  const { t, fmt, lang } = useI18n();
  return (
    <div className="hearing" data-muted={muted ? 'true' : undefined}>
      <div className="hearing__when">
        <b>{fmt.day(hearing.scheduledAt)}</b>
        <span className="ltr">{fmt.time(hearing.scheduledAt)}</span>
        {hearing.endsAt && <span className="small muted ltr">– {fmt.time(hearing.endsAt)}</span>}
      </div>
      <div className="hearing__body">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <b>
            <Link to={`/portal/matters/${hearing.matterId}`}>{pick(lang, hearing.matterTitle, hearing.matterTitleAr)}</Link>
          </b>
          {hearing.caseNumber && <span className="ltr mono small muted">{hearing.caseNumber}</span>}
        </div>

        <dl className="kv" style={{ marginBlockStart: 8 }}>
          <div style={{ display: 'contents' }}>
            <dt>{t('hearing.court')}</dt>
            <dd>{pick(lang, hearing.court, hearing.courtAr)}</dd>
          </div>
          {hearing.hearingType && (
            <div style={{ display: 'contents' }}>
              <dt>{t('hearing.type')}</dt>
              <dd>{hearing.hearingType.replace(/_/g, ' ')}</dd>
            </div>
          )}
          <div style={{ display: 'contents' }}>
            <dt>{t('hearing.location')}</dt>
            <dd>
              {hearing.isRemote ? (
                <>
                  <Icon name="video" size={13} /> {hearing.remotePlatform ?? t('hearing.remote')}
                </>
              ) : (
                <>
                  <Icon name="pin" size={13} /> {pick(lang, hearing.location, hearing.locationAr) || t('hearing.inPerson')}
                </>
              )}
            </dd>
          </div>
        </dl>

        {hearing.instructions && (
          <div className="alert alert--info" style={{ marginBlockStart: 10 }}>
            <Icon name="info" size={16} />
            <div className="alert__body">
              <div className="alert__title">{t('hearing.instructions')}</div>
              <div>{pick(lang, hearing.instructions, hearing.instructionsAr)}</div>
            </div>
          </div>
        )}

        <div className="row" style={{ gap: 8, marginBlockStart: 10, flexWrap: 'wrap' }}>
          {hearing.isRemote && hearing.remoteLink && (
            <a className="btn btn--primary btn--sm" href={hearing.remoteLink} target="_blank" rel="noreferrer noopener">
              <Icon name="external" size={14} />
              {t('hearing.join')}
            </a>
          )}
          {!muted && (
            <a className="btn btn--ghost btn--sm" href={icsHref(hearing)} download={`${hearing.caseNumber ?? 'hearing'}.ics`}>
              <Icon name="calendar" size={14} />
              {t('hearing.addToCalendar')}
            </a>
          )}
          <Link className="btn btn--ghost btn--sm" to={`/portal/matters/${hearing.matterId}`}>
            {t('matter.detail')}
            <Icon name="chevron" size={14} />
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Builds an .ics as a data URL. Generated locally rather than served by the API:
 * a calendar file is not privileged data, and keeping it off the server means no
 * extra endpoint, no extra storage object and nothing to authorize.
 */
function icsHref(h: Hearing): string {
  const dt = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const esc = (v: string) => v.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KGM LEGAL OS//Client Portal//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${h.id}@kgm-legal-os`,
    `DTSTAMP:${dt(new Date().toISOString())}`,
    `DTSTART:${dt(h.scheduledAt)}`,
    h.endsAt ? `DTEND:${dt(h.endsAt)}` : '',
    `SUMMARY:${esc(h.court || 'Hearing')}`,
    `DESCRIPTION:${esc([h.matterTitle, h.caseNumber, h.hearingType, h.instructions].filter(Boolean).join(' · '))}`,
    h.location ? `LOCATION:${esc(h.location)}` : '',
    h.remoteLink ? `URL:${h.remoteLink}` : '',
    'BEGIN:VALARM',
    'TRIGGER:-P1D',
    'ACTION:DISPLAY',
    'DESCRIPTION:Hearing tomorrow',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join('\r\n'))}`;
}
