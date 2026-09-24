import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api/client';
import type { Thread } from '../api/types';
import { useI18n } from '../i18n';
import { pick } from '../lib/format';
import { Button, Card, Empty, ErrorAlert, Icon, Input, PageLoader, StatusBadge, useAsync } from '../components/ui';
import { PageHeader } from '../components/page';

/**
 * Conversations (§22).
 *
 * Threads are opened by the firm and attached to a matter; the portal has no
 * "new conversation" action because a client-initiated thread would need a
 * routing and triage workflow the firm owns. Replies inside an existing thread
 * are the supported path.
 */
export default function Messages() {
  const { t, fmt, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(() => get<{ threads: Thread[] }>('/api/client/messages'), []);
  const [query, setQuery] = useState('');

  const threads = useMemo(() => {
    const all = [...(data?.threads ?? [])].sort((a, b) =>
      String(b.lastMessageAt ?? '').localeCompare(String(a.lastMessageAt ?? '')),
    );
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((th) =>
      [th.subject, th.subjectAr, th.matterTitle, th.matterTitleAr]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [data, query]);

  if (loading && !data) return <PageLoader />;

  return (
    <>
      <PageHeader title={t('msg.title')} subtitle={t('msg.subtitle')} />

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
        </div>
      </Card>

      {threads.length === 0 ? (
        <Empty icon="chat" title={t('msg.empty')}>
          <Button variant="ghost" size="sm" onClick={reload}>
            <Icon name="refresh" size={15} />
            {t('common.retry')}
          </Button>
        </Empty>
      ) : (
        <ul className="list" style={{ marginBlockStart: 16 }}>
          {threads.map((th) => (
            <li key={th.id}>
              <Link className="list__item list__item--link" to={`/portal/messages/${th.id}`}>
                <span className="list__icon">
                  <Icon name="chat" size={18} />
                </span>
                <span className="list__main">
                  <span className="list__title">{pick(lang, th.subject, th.subjectAr)}</span>
                  <span className="list__meta">
                    <Link to={`/portal/matters/${th.matterId}`} onClick={(e) => e.stopPropagation()}>
                      {pick(lang, th.matterTitle, th.matterTitleAr)}
                    </Link>
                    {th.lastMessageAt && <span>{fmt.relative(th.lastMessageAt)}</span>}
                  </span>
                </span>
                <span className="list__end">
                  <StatusBadge status={th.status} prefix="msg.status" />
                  {th.status === 'awaiting_client' && (
                    <span className="tabbar__dot" aria-label={t('dash.actionRequired')} />
                  )}
                  <Icon name="chevron" size={16} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="small muted" style={{ marginBlockStart: 14 }}>
        <Icon name="lock" size={13} /> {t('msg.secureNote')}
      </p>
    </>
  );
}
