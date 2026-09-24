import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, patch, post } from '../api/client';
import type { Notification, NotificationPreference } from '../api/types';
import { translate, useI18n } from '../i18n';
import { pick } from '../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  Check,
  Empty,
  ErrorAlert,
  Icon,
  PageLoader,
  useAsync,
} from '../components/ui';
import { PageHeader, Tabs } from '../components/page';

type TabId = 'all' | 'unread' | 'prefs';

/**
 * Notifications (§24).
 *
 * Marking read is the only write here, and it is scoped to the caller's own
 * notifications by the repository query — passing someone else's id returns a
 * 404 rather than silently succeeding.
 *
 * Channel preferences honour the `locked` flag: security and deadline alerts are
 * mandatory, so the control is disabled and the reason is stated rather than
 * leaving a toggle that appears to work and does not.
 */
export default function Notifications() {
  const { t, fmt, lang } = useI18n();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [savedNote, setSavedNote] = useState(false);

  const { data, error, loading, reload } = useAsync(
    () => get<{ notifications: Notification[]; unreadCount: number }>('/api/client/notifications'),
    [],
  );
  const prefs = useAsync(() => get<{ preferences: NotificationPreference[] }>('/api/client/notification-preferences'), []);

  const all = data?.notifications ?? [];
  const unread = useMemo(() => all.filter((n) => !n.read), [all]);
  const shown = tab === 'unread' ? unread : all;

  const markRead = async (id: string, link?: string | null) => {
    setBusyId(id);
    setActionError(null);
    try {
      await post(`/api/client/notifications/${encodeURIComponent(id)}/read`, {});
      reload();
      // Following the link happens after the write, so a notification is never
      // left unread because navigation unmounted the component mid-request.
      if (link) navigate(link);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusyId(null);
    }
  };

  const markAll = async () => {
    setBusyId('__all');
    setActionError(null);
    try {
      await post('/api/client/notifications/read-all', {});
      reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusyId(null);
    }
  };

  if (loading && !data) return <PageLoader />;

  return (
    <>
      <PageHeader
        title={t('notif.title')}
        subtitle={t('notif.subtitle')}
        actions={
          <>
            {unread.length > 0 && (
              <Button variant="ghost" size="sm" loading={busyId === '__all'} onClick={() => void markAll()}>
                <Icon name="check" size={15} />
                {t('notif.markAll')}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={reload}>
              <Icon name="refresh" size={15} />
              {t('common.retry')}
            </Button>
          </>
        }
      />

      {error ? <ErrorAlert error={error} onRetry={reload} /> : null}
      {actionError ? <ErrorAlert error={actionError} /> : null}
      {savedNote && <Alert tone="ok">{t('notif.saved')}</Alert>}

      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'all', label: t('common.all'), count: all.length },
          { id: 'unread', label: t('notif.unread'), count: unread.length },
          { id: 'prefs', label: t('notif.prefs') },
        ]}
      />

      {tab !== 'prefs' &&
        (shown.length === 0 ? (
          <Empty icon="bell" title={t('notif.empty')} />
        ) : (
          <ul className="list">
            {shown.map((n) => (
              <li key={n.id}>
                <div className={n.read ? 'list__item' : 'list__item list__item--unread'}>
                  <span className="list__icon" data-severity={n.severity}>
                    <Icon name={severityIcon(n.severity)} size={17} />
                  </span>
                  <span className="list__main">
                    <span className="list__title">{pick(lang, n.title, n.titleAr)}</span>
                    {n.body && <span className="list__summary">{pick(lang, n.body, n.bodyAr)}</span>}
                    <span className="list__meta">
                      <Badge tone="default">{categoryLabel(n.category)}</Badge>
                      <Badge tone={severityTone(n.severity)}>{severityLabel(n.severity)}</Badge>
                      <span>{fmt.relative(n.createdAt)}</span>
                    </span>
                  </span>
                  <span className="list__end">
                    {!n.read && <span className="tabbar__dot" aria-label={t('notif.unread')} />}
                    {n.link ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busyId === n.id}
                        onClick={() => void markRead(n.id, n.link)}
                      >
                        {t('common.viewAll')}
                        <Icon name="chevron" size={14} />
                      </Button>
                    ) : (
                      !n.read && (
                        <Button variant="ghost" size="sm" loading={busyId === n.id} onClick={() => void markRead(n.id)}>
                          <Icon name="check" size={14} />
                        </Button>
                      )
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ))}

      {tab === 'prefs' && (
        <Card title={t('notif.prefs')} hint={t('notif.prefsSub')}>
          {prefs.loading && <PageLoader />}
          {prefs.error ? <ErrorAlert error={prefs.error} onRetry={prefs.reload} /> : null}
          {prefs.data && prefs.data.preferences.length === 0 && <Empty icon="bell" title={t('common.none')} />}
          {prefs.data && prefs.data.preferences.length > 0 && (
            <div className="table-wrap">
              <table className="table table--plain">
                <thead>
                  <tr>
                    <th>{t('notif.category')}</th>
                    <th>{t('notif.inApp')}</th>
                    <th>{t('notif.emailChannel')}</th>
                  </tr>
                </thead>
                <tbody>
                  {prefs.data.preferences.map((p) => (
                    <tr key={p.category}>
                      <td>
                        <b>{categoryLabel(p.category)}</b>
                        {p.locked && (
                          <span className="small muted"> · {t('notif.locked')}</span>
                        )}
                      </td>
                      <td>
                        <ChannelToggle
                          category={p.category}
                          field="inApp"
                          value={p.inApp}
                          other={p.email}
                          locked={p.locked}
                          onSaved={() => {
                            prefs.reload();
                            setSavedNote(true);
                            window.setTimeout(() => setSavedNote(false), 2500);
                          }}
                          onError={setActionError}
                        />
                      </td>
                      <td>
                        <ChannelToggle
                          category={p.category}
                          field="email"
                          value={p.email}
                          other={p.inApp}
                          locked={p.locked}
                          onSaved={() => {
                            prefs.reload();
                            setSavedNote(true);
                            window.setTimeout(() => setSavedNote(false), 2500);
                          }}
                          onError={setActionError}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {prefs.data?.preferences.some((p) => p.locked) && (
            <p className="small muted" style={{ marginBlockStart: 10 }}>
              <Icon name="shield" size={13} /> {t('notif.lockedNote')}
            </p>
          )}
        </Card>
      )}
    </>
  );

  const categoryLabel = (category: string) => translate(lang, `notif.category.${category}`);
  const severityLabel = (severity: string) => translate(lang, `notif.severity.${severity}`);
}

function severityTone(severity: string): 'default' | 'ok' | 'warn' | 'danger' | 'info' {
  if (severity === 'urgent' || severity === 'security') return 'danger';
  if (severity === 'action_required') return 'warn';
  return 'info';
}

function severityIcon(severity: string): 'bell' | 'alert' | 'shield' | 'info' {
  if (severity === 'security') return 'shield';
  if (severity === 'urgent' || severity === 'action_required') return 'alert';
  return 'bell';
}

/**
 * One channel checkbox. The PATCH sends BOTH flags, because the endpoint takes a
 * pair — sending one field would silently reset the other.
 */
function ChannelToggle({
  category,
  field,
  value,
  other,
  locked,
  onSaved,
  onError,
}: {
  category: string;
  field: 'inApp' | 'email';
  value: boolean;
  other: boolean;
  locked: boolean;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (locked) return;
    setBusy(true);
    try {
      const next = !value;
      await patch(`/api/client/notification-preferences/${encodeURIComponent(category)}`, {
        inApp: field === 'inApp' ? next : other,
        email: field === 'email' ? next : other,
      });
      onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Check
      checked={value}
      disabled={locked || busy}
      onChange={() => void toggle()}
      label={locked ? t('notif.locked') : value ? t('common.yes') : t('common.no')}
    />
  );
}
