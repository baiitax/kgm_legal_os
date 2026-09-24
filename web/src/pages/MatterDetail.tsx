import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, openDocument } from '../api/client';
import type { MatterDetail as MatterDto } from '../api/types';
import { translate, useI18n } from '../i18n';
import { pick } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorAlert,
  Icon,
  KeyValue,
  PageLoader,
  StatusBadge,
  useAsync,
} from '../components/ui';
import { Crumbs, PageHeader, Tabs } from '../components/page';
import { HearingRow, useDueLabel } from './Dashboard';

type TabId = 'overview' | 'hearings' | 'deadlines' | 'documents' | 'invoices' | 'messages';

/**
 * Matter workspace (§14).
 *
 * One route, six tabs, one request. The response is a single projection the
 * server assembled for this client and this matter; requesting a tab does not
 * fetch anything extra, so switching tabs cannot be used to probe for data that
 * was deliberately left out (internal notes, risk flags, conflict work, other
 * clients' documents).
 *
 * If the id in the URL is not one of the client's matters, the server answers
 * 404 — not 403 — so the portal never confirms that a matter exists.
 */
export default function MatterDetail() {
  const { id = '' } = useParams();
  const { t, fmt, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(
    () => get<MatterDto>(`/api/client/matters/${encodeURIComponent(id)}`),
    [id],
  );
  const [tab, setTab] = useState<TabId>('overview');

  if (loading && !data) return <PageLoader />;

  if (error || !data) {
    return (
      <>
        <Crumbs items={[{ to: '/portal/matters', label: t('matter.title') }, { label: t('matter.notFound') }]} />
        <ErrorAlert error={error} onRetry={reload} />
        <Link to="/portal/matters">
          <Button variant="ghost" size="sm">
            <Icon name="back" size={15} />
            {t('matter.title')}
          </Button>
        </Link>
      </>
    );
  }

  const m = data;
  const currentStage = m.lifecycle.indexOf(m.status);

  return (
    <>
      <Crumbs items={[{ to: '/portal', label: t('nav.dashboard') }, { to: '/portal/matters', label: t('matter.title') }, { label: m.matterNumber }]} />

      <PageHeader
        title={pick(lang, m.title, m.titleAr)}
        subtitle={
          <>
            <span className="ltr mono">{m.matterNumber}</span>
            {m.caseNumber && <> · {t('matter.caseNumber')} <span className="ltr mono">{m.caseNumber}</span></>}
            {' · '}
            {pick(lang, m.practiceArea, m.practiceAreaAr)}
          </>
        }
        actions={<StatusBadge status={m.status} />}
      />

      {/* Lifecycle: rendered from the server's own stage list, so the portal can
          never show a stage the matter has not actually reached. */}
      {m.lifecycle.length > 0 && (
        <ol className="steps" aria-label={t('matter.lifecycle')}>
          {m.lifecycle.map((stage, i) => (
            <li
              key={stage}
              className={i < currentStage ? 'steps__item steps__item--done' : i === currentStage ? 'steps__item steps__item--on' : 'steps__item'}
              aria-current={i === currentStage ? 'step' : undefined}
            >
              <span className="steps__dot" aria-hidden="true">{i < currentStage ? '✓' : i + 1}</span>
              <span>{translate(lang, `status.${stage}`)}</span>
            </li>
          ))}
        </ol>
      )}

      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: t('matter.summary') },
          { id: 'hearings', label: t('matter.hearings'), count: m.hearings.length },
          { id: 'deadlines', label: t('matter.deadlines'), count: m.deadlines.length },
          { id: 'documents', label: t('matter.documents'), count: m.documents.length },
          { id: 'invoices', label: t('matter.invoices'), count: m.invoices.length },
          { id: 'messages', label: t('matter.messages'), count: m.threads.length },
        ]}
      />

      {tab === 'overview' && (
        <div className="grid grid--2">
          <Card title={t('matter.summary')}>
            {m.summary ? (
              <p>{pick(lang, m.summary, m.summaryAr)}</p>
            ) : (
              <p className="muted">{t('common.none')}</p>
            )}
            <KeyValue
              items={[
                [t('matter.status'), <StatusBadge key="s" status={m.status} />],
                [t('matter.court'), m.court ? pick(lang, m.court, m.courtAr) : '—'],
                [t('matter.area'), pick(lang, m.practiceArea, m.practiceAreaAr)],
                [t('matter.opened'), m.openedAt ? fmt.date(m.openedAt) : '—'],
                [t('matter.lastUpdate'), m.lastUpdated ? fmt.relative(m.lastUpdated) : '—'],
                [
                  t('dash.nextHearing'),
                  m.nextHearing ? fmt.dateTime(m.nextHearing) : t('dash.noHearing'),
                ],
              ]}
            />
          </Card>

          <Card title={t('matter.team')} hint={t('matter.teamNote')}>
            {m.legalTeam.length === 0 ? (
              <Empty icon="user" title={t('common.none')} />
            ) : (
              <ul className="list">
                {m.legalTeam.map((p) => (
                  <li key={`${p.name}-${p.role}`} className="list__item">
                    <span className="list__icon">
                      <Icon name="user" size={16} />
                    </span>
                    <span className="list__main">
                      <span className="list__title">{pick(lang, p.name, p.nameAr)}</span>
                      <span className="list__meta">{pick(lang, p.role, p.roleAr)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="small muted" style={{ marginBlockStart: 10 }}>
              <Icon name="info" size={13} /> {t('matter.teamNote')}
            </p>
          </Card>

          <Card title={t('matter.timeline')} as="section">
            {m.timeline.length === 0 ? (
              <Empty icon="history" title={t('common.none')} />
            ) : (
              <ol className="timeline">
                {m.timeline.map((e) => (
                  <li key={e.id} className="timeline__item">
                    <span className="timeline__dot" aria-hidden="true" />
                    <div className="timeline__body">
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <b>{pick(lang, e.title, e.titleAr)}</b>
                        <Badge tone="default">{e.eventType.replace(/_/g, ' ')}</Badge>
                      </div>
                      {e.description && <p className="small">{pick(lang, e.description, e.descriptionAr)}</p>}
                      <span className="small muted">
                        {fmt.dateTime(e.occurredAt)} · {fmt.relative(e.occurredAt)}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      )}

      {tab === 'hearings' && (
        <Card title={t('matter.hearings')}>
          {m.hearings.length === 0 ? (
            <Empty icon="gavel" title={t('hearing.empty')} />
          ) : (
            m.hearings.map((h) => <HearingRow key={h.id} hearing={h} />)
          )}
        </Card>
      )}

      {tab === 'deadlines' && <DeadlineList deadlines={m.deadlines} onChanged={reload} />}

      {tab === 'documents' && (
        <Card title={t('matter.documents')} hint={t('doc.linkExpiry')}>
          {m.documents.length === 0 ? (
            <Empty icon="doc" title={t('doc.empty')}>
              <Link to="/portal/documents">
                <Button variant="ghost" size="sm">
                  <Icon name="upload" size={15} />
                  {t('doc.upload')}
                </Button>
              </Link>
            </Empty>
          ) : (
            <ul className="list">
              {m.documents.map((d) => (
                <li key={d.id} className="list__item">
                  <span className="list__icon">
                    <Icon name="doc" size={17} />
                  </span>
                  <span className="list__main">
                    <span className="list__title">{pick(lang, d.title, d.titleAr)}</span>
                    <span className="list__meta">
                      <span>{d.documentType.replace(/_/g, ' ')}</span>
                      <span>{fmt.bytes(d.sizeBytes)}</span>
                      <span>{t('doc.version', { n: d.version })}</span>
                      <span>{d.origin === 'firm' ? t('doc.fromFirm') : t('doc.fromYou')}</span>
                      {d.createdAt && <span>{fmt.date(d.createdAt)}</span>}
                    </span>
                  </span>
                  <span className="list__end">
                    <StatusBadge status={d.status} />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!d.available}
                      onClick={() => void openDocument(d.id, 'inline')}
                      title={d.available ? t('doc.view') : t('doc.notReady')}
                    >
                      <Icon name="eye" size={15} />
                      {t('doc.view')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!d.available}
                      onClick={() => void openDocument(d.id, 'attachment')}
                    >
                      <Icon name="download" size={15} />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'invoices' && (
        <Card title={t('matter.invoices')}>
          {m.invoices.length === 0 ? (
            <Empty icon="invoice" title={t('inv.empty')} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('inv.number')}</th>
                    <th>{t('inv.issue')}</th>
                    <th>{t('inv.due')}</th>
                    <th className="table__num">{t('inv.total')}</th>
                    <th className="table__num">{t('inv.balance')}</th>
                    <th>{t('inv.status')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {m.invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td className="ltr mono">{inv.number}</td>
                      <td>{fmt.date(inv.issueDate)}</td>
                      <td>{fmt.date(inv.dueDate)}</td>
                      <td className="table__num">{fmt.money(inv.total, inv.currency)}</td>
                      <td className="table__num">{fmt.money(inv.balanceDue, inv.currency)}</td>
                      <td>
                        <StatusBadge status={inv.status} prefix="inv.status" />
                      </td>
                      <td>
                        <Link to={`/portal/invoices/${inv.id}`}>
                          <Button variant="ghost" size="sm">
                            {t('common.viewAll')}
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'messages' && (
        <Card title={t('matter.messages')}>
          {m.threads.length === 0 ? (
            <Empty icon="chat" title={t('msg.empty')} />
          ) : (
            <ul className="list">
              {m.threads.map((th) => (
                <li key={th.id}>
                  <Link className="list__item list__item--link" to={`/portal/messages/${th.id}`}>
                    <span className="list__icon">
                      <Icon name="chat" size={17} />
                    </span>
                    <span className="list__main">
                      <span className="list__title">{pick(lang, th.subject, th.subjectAr)}</span>
                      <span className="list__meta">
                        <StatusBadge status={th.status} prefix="msg.status" />
                        {th.lastMessageAt && <span>{fmt.relative(th.lastMessageAt)}</span>}
                      </span>
                    </span>
                    <span className="list__aside">
                      <Icon name="chevron" size={16} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}

/** Deadlines with the one action a client is allowed to take: acknowledge. */
export function DeadlineList({
  deadlines,
  onChanged,
}: {
  deadlines: Array<{
    id: string;
    matterId: string;
    matterTitle: string;
    matterTitleAr: string;
    title: string;
    titleAr: string;
    description: string | null;
    descriptionAr: string | null;
    dueAt: string;
    priority: string;
    status: string;
    overdue: boolean;
    daysRemaining: number | null;
  }>;
  onChanged: () => void;
}) {
  const { t, fmt, lang } = useI18n();
  const dueLabel = useDueLabel();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<unknown>(null);

  /**
   * The only statuses a client may set are the three the domain allows:
   * in_progress, submitted and completed. Anything else is refused server-side,
   * so the UI offers exactly these and nothing more.
   */
  const setStatus = async (id: string, next: 'in_progress' | 'completed') => {
    setBusy(id);
    setFailed(null);
    try {
      const { patch } = await import('../api/client');
      await patch(`/api/client/deadlines/${encodeURIComponent(id)}`, { status: next });
      onChanged();
    } catch (err) {
      setFailed(err);
    } finally {
      setBusy(null);
    }
  };

  if (deadlines.length === 0) {
    return (
      <Card title={t('deadline.title')}>
        <Empty icon="check" title={t('deadline.empty')} />
      </Card>
    );
  }

  const sorted = [...deadlines].sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  return (
    <Card title={t('deadline.title')}>
      {failed ? <ErrorAlert error={failed} /> : null}
      <ul className="list">
        {sorted.map((d) => (
          <li key={d.id} className="list__item">
            <span className="list__icon">
              <Icon name={d.overdue ? 'alert' : 'clock'} size={17} />
            </span>
            <span className="list__main">
              <span className="list__title">
                <Link to={`/portal/matters/${d.matterId}`}>{pick(lang, d.title, d.titleAr)}</Link>
              </span>
              <span className="list__meta">
                <span>{pick(lang, d.matterTitle, d.matterTitleAr)}</span>
                <span>{fmt.dateTime(d.dueAt)}</span>
                {d.description && <span>{pick(lang, d.description, d.descriptionAr)}</span>}
              </span>
            </span>
            <span className="list__end">
              <StatusBadge status={d.priority} prefix="deadline.priority" />
              {d.overdue ? (
                <Badge tone="danger">{t('deadline.overdue')}</Badge>
              ) : (
                <Badge tone={d.daysRemaining !== null && d.daysRemaining <= 7 ? 'warn' : 'default'}>
                  {dueLabel(d.daysRemaining)}
                </Badge>
              )}
              {d.status === 'open' && (
                <Button variant="ghost" size="sm" loading={busy === d.id} onClick={() => void setStatus(d.id, 'in_progress')}>
                  <Icon name="check" size={14} />
                  {t('deadline.markAck')}
                </Button>
              )}
              {d.status === 'in_progress' && (
                <Button variant="primary" size="sm" loading={busy === d.id} onClick={() => void setStatus(d.id, 'completed')}>
                  <Icon name="check" size={14} />
                  {t('deadline.markDone')}
                </Button>
              )}
              <StatusBadge status={d.status} />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
