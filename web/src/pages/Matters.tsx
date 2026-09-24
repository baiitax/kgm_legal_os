import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api/client';
import type { MatterSummary } from '../api/types';
import { useI18n } from '../i18n';
import { pick } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorAlert, Icon, Input, PageLoader, StatusBadge, useAsync } from '../components/ui';
import { PageHeader } from '../components/page';

/**
 * Matter directory (§13).
 *
 * The list arrives already scoped to the signed-in client's entity, so the
 * search box filters what the server chose to send — it never widens it. A query
 * typed here cannot reach matters belonging to another client, because those
 * rows were never in the response.
 */
export default function Matters() {
  const { t, fmt, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(() => get<{ matters: MatterSummary[] }>('/api/client/matters'), []);

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');

  const matters = data?.matters ?? [];
  const statuses = useMemo(
    () => Array.from(new Set(matters.map((m) => m.status))).sort(),
    [matters],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return matters.filter((m) => {
      if (status !== 'all' && m.status !== status) return false;
      if (!q) return true;
      // Matching runs over the projected fields only. Nothing here can be used
      // to probe for records the client is not entitled to.
      return [m.title, m.titleAr, m.matterNumber, m.caseNumber, m.practiceArea, m.practiceAreaAr, m.court, m.courtAr]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [matters, query, status]);

  if (loading && !data) return <PageLoader />;

  return (
    <>
      <PageHeader
        title={t('matter.title')}
        subtitle={t('matter.subtitle')}
        actions={
          <Button variant="ghost" size="sm" onClick={reload}>
            <Icon name="refresh" size={15} />
            {t('common.refresh')}
          </Button>
        }
      />

      {error ? <ErrorAlert error={error} onRetry={reload} /> : null}

      <Card tight>
        <div className="filterbar">
          <div className="filterbar__search">
            <Icon name="search" size={16} />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('common.search')}
              aria-label={t('common.search')}
            />
          </div>
          <div className="chips" role="group" aria-label={t('matter.status')}>
            <button
              type="button"
              className={status === 'all' ? 'chip chip--on' : 'chip'}
              onClick={() => setStatus('all')}
            >
              {t('common.all')}
              <span className="chip__n">{matters.length}</span>
            </button>
            {statuses.map((s) => (
              <button
                key={s}
                type="button"
                className={status === s ? 'chip chip--on' : 'chip'}
                onClick={() => setStatus(s)}
              >
                <StatusBadge status={s} plain />
                <span className="chip__n">{matters.filter((m) => m.status === s).length}</span>
              </button>
            ))}
          </div>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Empty icon="folder" title={matters.length === 0 ? t('matter.empty') : t('common.none')}>
          {t('matter.empty')}
        </Empty>
      ) : (
        <ul className="list" style={{ marginBlockStart: 16 }}>
          {filtered.map((m) => (
            <li key={m.id}>
              <Link className="list__item list__item--link" to={`/portal/matters/${m.id}`}>
                <span className="list__icon">
                  <Icon name="folder" size={18} />
                </span>
                <span className="list__main">
                  <span className="list__title">{pick(lang, m.title, m.titleAr)}</span>
                  <span className="list__meta">
                    <span className="ltr mono">{m.matterNumber}</span>
                    {m.caseNumber && (
                      <span className="ltr mono">
                        {t('matter.caseNumber')}: {m.caseNumber}
                      </span>
                    )}
                    <span>{pick(lang, m.practiceArea, m.practiceAreaAr)}</span>
                    {m.court && <span>{pick(lang, m.court, m.courtAr)}</span>}
                  </span>
                  {m.summary && (
                    <span className="list__summary">{pick(lang, m.summary, m.summaryAr)}</span>
                  )}
                </span>
                <span className="list__aside">
                  <StatusBadge status={m.status} />
                  {m.nextHearing && (
                    <Badge tone="info">
                      <Icon name="gavel" size={12} />
                      {fmt.date(m.nextHearing)}
                    </Badge>
                  )}
                  <span className="small muted">{fmt.relative(m.lastUpdated ?? m.openedAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
