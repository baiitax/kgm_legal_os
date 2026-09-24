import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api/client';
import type { Dashboard as DashboardDto } from '../api/types';
import { useI18n } from '../i18n';
import { pick } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorAlert,
  Icon,
  PageLoader,
  Stat,
  StatusBadge,
  useAsync,
} from '../components/ui';
import { PageHeader } from '../components/page';

/**
 * "today" / "tomorrow" / "n days" using the dictionary's own deadline
 * vocabulary. Returned as a function from a hook so the label re-renders in the
 * active language without every call site threading `t` through.
 */
export function useDueLabel(): (days: number | null) => string {
  const { t } = useI18n();
  return useCallback(
    (days: number | null) => {
      if (days === null) return t('deadline.daysLeft');
      if (days <= 0) return t('deadline.today');
      if (days === 1) return t('deadline.tomorrow');
      return t('deadline.days', { n: days });
    },
    [t],
  );
}

/**
 * Portal home (§11).
 *
 * Everything here is a projection the server already decided the client may see:
 * counts, the next hearing, open deadlines and a short matter list. There is no
 * internal state, no staffing detail beyond names and roles the firm chose to
 * publish, and no financial figure other than what the client owes.
 */
export default function Dashboard() {
  const { t, fmt, lang } = useI18n();
  const dueLabel = useDueLabel();
  const { data, error, loading, reload } = useAsync(() => get<DashboardDto>('/api/client/dashboard'), []);

  if (loading && !data) return <PageLoader />;
  if (error) {
    return (
      <>
        <PageHeader title={t('dash.greeting')} />
        <ErrorAlert error={error} onRetry={reload} />
      </>
    );
  }
  if (!data) return null;

  const name = pick(lang, data.greeting.displayName, data.greeting.displayNameAr);
  const firm = pick(lang, data.greeting.firmName, data.greeting.firmNameAr);
  const next = data.upcomingHearings[0];
  const urgent = data.deadlines.filter((d) => d.overdue || (d.daysRemaining ?? 99) <= 7);

  return (
    <>
      <PageHeader
        title={`${t('dash.greeting')}، ${name}`}
        subtitle={t('dash.subtitle', { firm: firm || t('app.name') })}
        actions={
          <Link to="/portal/matters">
            <Button variant="ghost" size="sm">
              <Icon name="folder" size={15} />
              {t('common.viewAll')}
            </Button>
          </Link>
        }
      />

      <div className="grid grid--3" style={{ marginBlockEnd: 16 }}>
        <Link to="/portal/matters" className="stat-link">
          <Stat label={t('dash.activeMatters')} value={fmt.number(data.counts.activeMatters)} />
        </Link>
        <Link to="/portal/hearings" className="stat-link">
          <Stat
            label={t('dash.upcomingHearings')}
            value={fmt.number(data.counts.upcomingHearings)}
            sub={next ? `${fmt.day(next.scheduledAt)} · ${fmt.time(next.scheduledAt)}` : t('dash.noHearing')}
          />
        </Link>
        <Link to="/portal/deadlines" className="stat-link">
          <Stat
            label={t('dash.openDeadlines')}
            value={fmt.number(data.counts.openDeadlines)}
            tone={data.counts.openDeadlines > 0 ? 'alert' : undefined}
            sub={urgent.length > 0 ? t('dash.actionRequired') : undefined}
          />
        </Link>
        <Link to="/portal/invoices" className="stat-link">
          <Stat
            label={t('dash.unpaidInvoices')}
            value={fmt.number(data.counts.unpaidInvoices)}
            tone={data.counts.unpaidInvoices > 0 ? 'alert' : undefined}
          />
        </Link>
        <div className="stat">
          <div className="stat__label">{t('dash.outstanding')}</div>
          <div className="stat__value" data-tone="money">
            {fmt.money(data.outstandingBalance.amount, data.outstandingBalance.currency)}
          </div>
          <div className="stat__sub">{t('dash.outstandingSub')}</div>
        </div>
        <Link to="/portal/notifications" className="stat-link">
          <Stat label={t('notif.unread')} value={fmt.number(data.counts.unreadNotifications)} />
        </Link>
      </div>

      {next && (
        <Card
          title={t('dash.nextHearing')}
          hint={fmt.relative(next.scheduledAt)}
          actions={
            <Link to={`/portal/matters/${next.matterId}`}>
              <Button variant="ghost" size="sm">
                {t('common.viewAll')}
                <Icon name="chevron" size={15} />
              </Button>
            </Link>
          }
        >
          <HearingRow hearing={next} />
        </Card>
      )}

      <div className="grid grid--2">
        <Card
          title={t('dash.yourMatters')}
          hint={t('matter.subtitle')}
          actions={
            <Link to="/portal/matters">
              <Button variant="ghost" size="sm">
                {t('common.viewAll')}
              </Button>
            </Link>
          }
        >
          {data.matters.length === 0 ? (
            <Empty icon="folder" title={t('matter.empty')} />
          ) : (
            <ul className="list">
              {data.matters.slice(0, 5).map((m) => (
                <li key={m.id}>
                  <Link className="list__item list__item--link" to={`/portal/matters/${m.id}`}>
                    <span className="list__main">
                      <span className="list__title">{pick(lang, m.title, m.titleAr)}</span>
                      <span className="list__meta">
                        <span className="ltr">{m.matterNumber}</span>
                        {m.caseNumber && <span className="ltr">{m.caseNumber}</span>}
                        <span>{pick(lang, m.practiceArea, m.practiceAreaAr)}</span>
                      </span>
                    </span>
                    <span className="list__aside">
                      <StatusBadge status={m.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={t('deadline.title')}
          actions={
            <Link to="/portal/deadlines">
              <Button variant="ghost" size="sm">
                {t('common.viewAll')}
              </Button>
            </Link>
          }
        >
          {data.deadlines.length === 0 ? (
            <Empty icon="check" title={t('deadline.empty')} />
          ) : (
            <ul className="list">
              {data.deadlines.slice(0, 5).map((d) => (
                <li key={d.id}>
                  <Link className="list__item list__item--link" to={`/portal/matters/${d.matterId}`}>
                    <span className="list__main">
                      <span className="list__title">{pick(lang, d.title, d.titleAr)}</span>
                      <span className="list__meta">
                        <span>{pick(lang, d.matterTitle, d.matterTitleAr)}</span>
                        <span>{fmt.date(d.dueAt)}</span>
                      </span>
                    </span>
                    <span className="list__aside">
                      {d.overdue ? (
                        <Badge tone="danger">{t('deadline.overdue')}</Badge>
                      ) : (
                        <Badge tone={(d.daysRemaining ?? 99) <= 7 ? 'warn' : 'default'}>
                          {dueLabel(d.daysRemaining)}
                        </Badge>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <p className="small muted" style={{ marginBlockStart: 18 }}>
        <Icon name="clock" size={13} /> {t('dash.serverTime')}: {fmt.dateTime(data.serverTime)}
      </p>
    </>
  );
}

/** One hearing, rendered identically on the dashboard and the hearings screen. */
export function HearingRow({ hearing }: { hearing: DashboardDto['upcomingHearings'][number] }) {
  const { t, fmt, lang } = useI18n();
  return (
    <div className="hearing">
      <div className="hearing__when">
        <b>{fmt.day(hearing.scheduledAt)}</b>
        <span className="ltr">{fmt.time(hearing.scheduledAt)}</span>
        <span className="small muted">{fmt.relative(hearing.scheduledAt)}</span>
      </div>
      <div className="hearing__body">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <b>{pick(lang, hearing.matterTitle, hearing.matterTitleAr)}</b>
          {hearing.caseNumber && <span className="ltr small muted">{hearing.caseNumber}</span>}
          <StatusBadge status={hearing.status} prefix="appt.status" />
        </div>
        <div className="small muted" style={{ marginBlockStart: 4 }}>
          {pick(lang, hearing.court, hearing.courtAr)}
          {hearing.location && <> · {pick(lang, hearing.location, hearing.locationAr)}</>}
        </div>
        {hearing.isRemote && (
          <div className="row" style={{ gap: 8, marginBlockStart: 8, flexWrap: 'wrap' }}>
            <Badge tone="info">
              <Icon name="video" size={13} />
              {hearing.remotePlatform ?? t('hearing.remote')}
            </Badge>
            {hearing.remoteLink && (
              <a className="btn btn--sm btn--ghost" href={hearing.remoteLink} target="_blank" rel="noreferrer noopener">
                <Icon name="external" size={14} />
                {t('hearing.join')}
              </a>
            )}
          </div>
        )}
        {hearing.instructions && (
          <p className="small" style={{ marginBlockStart: 8 }}>
            {pick(lang, hearing.instructions, hearing.instructionsAr)}
          </p>
        )}
      </div>
    </div>
  );
}
