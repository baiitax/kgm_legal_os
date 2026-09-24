import { useMemo, useState } from 'react';
import { get } from '../api/client';
import type { Deadline } from '../api/types';
import { useI18n } from '../i18n';
import { Button, Card, Empty, ErrorAlert, Icon, PageLoader, useAsync } from '../components/ui';
import { PageHeader, Tabs } from '../components/page';
import { DeadlineList } from './MatterDetail';

type TabId = 'all' | 'overdue' | 'soon' | 'later' | 'done';

/**
 * Deadlines (§16).
 *
 * Grouping is presentational. The two statuses a client may set — in_progress
 * and completed — are the only mutations offered, and both go through the same
 * server-validated transition the matter screen uses.
 */
export default function Deadlines() {
  const { t, fmt } = useI18n();
  const { data, error, loading, reload } = useAsync(() => get<{ deadlines: Deadline[] }>('/api/client/deadlines'), []);
  const [tab, setTab] = useState<TabId>('all');

  const all = data?.deadlines ?? [];
  const groups = useMemo(() => {
    const now = Date.now();
    const open = all.filter((d) => d.status === 'open' || d.status === 'in_progress');
    return {
      all,
      overdue: open.filter((d) => d.overdue || new Date(d.dueAt).getTime() < now),
      soon: open.filter((d) => !d.overdue && new Date(d.dueAt).getTime() >= now && (d.daysRemaining ?? 99) <= 7),
      later: open.filter((d) => !d.overdue && new Date(d.dueAt).getTime() >= now && (d.daysRemaining ?? 99) > 7),
      done: all.filter((d) => d.status === 'completed' || d.status === 'submitted'),
    };
  }, [all]);

  if (loading && !data) return <PageLoader />;

  const shown = groups[tab];

  return (
    <>
      <PageHeader
        title={t('deadline.title')}
        subtitle={t('deadline.subtitle')}
        actions={
          <Button variant="ghost" size="sm" onClick={reload}>
            <Icon name="refresh" size={15} />
            {t('common.retry')}
          </Button>
        }
      />

      {error ? <ErrorAlert error={error} onRetry={reload} /> : null}

      {all.length === 0 ? (
        <Empty icon="check" title={t('deadline.empty')} />
      ) : (
        <>
          <Tabs<TabId>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'all', label: t('common.all'), count: groups.all.length },
              { id: 'overdue', label: t('deadline.overdue'), count: groups.overdue.length },
              { id: 'soon', label: t('deadline.daysLeft'), count: groups.soon.length },
              { id: 'later', label: t('deadline.due'), count: groups.later.length },
              { id: 'done', label: t('deadline.done'), count: groups.done.length },
            ]}
          />

          {shown.length === 0 ? (
            <Card title={t('deadline.title')}>
              <Empty icon="check" title={t('deadline.empty')} />
            </Card>
          ) : (
            <DeadlineList deadlines={shown} onChanged={reload} />
          )}

          <p className="small muted" style={{ marginBlockStart: 14 }}>
            <Icon name="clock" size={13} /> {fmt.dateTime(new Date().toISOString())}
          </p>
        </>
      )}
    </>
  );
}
