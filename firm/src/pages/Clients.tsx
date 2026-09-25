/**
 * CLIENTS · the firm's client list, derived from the matter scope.
 *
 * WHY THIS SCREEN DERIVES ITS DATA INSTEAD OF CALLING A CLIENTS ENDPOINT
 *   A separate `GET /api/firm/clients` would need its own scope rule, and two
 *   scope rules that are supposed to agree never quite do. The matters endpoint
 *   already answers the only question that matters here — which matters may this
 *   member see — and a client is nothing more than the set of their visible
 *   matters. Grouping the rows the server already authorized cannot widen the
 *   result: a client appears because a matter of theirs is in the list, and the
 *   list is the server's answer, not a filter applied here.
 *
 *   This is the same reasoning the billing endpoint uses when it derives its
 *   visible matter ids from the member's scope rather than re-deriving them. One
 *   rule, applied everywhere, is the only way the two stay in step.
 *
 * WHAT IT SHOWS THAT A MATTERS LIST DOES NOT
 *   The member's ACCESS to each client. A client with four matters where the
 *   member can act on one and merely read two is a different relationship from a
 *   client with four matters all open to them, and the count alone hides it — so
 *   a client whose only matters are restricted says so rather than looking like
 *   any other client with a small file.
 *
 *   The count is also stated as what it is: matters this member may see, not the
 *   client's matters. A partner scoped to litigation is not shown a firm-wide
 *   client total they are not entitled to.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AccessBadge, Button, Card, CardBody, EmptyState, IconClients, IconRestricted,
  PageSkeleton, useI18n,
} from '@kgm/ui';
import { FirmApiError, firmApi, type MatterListResponse, type MatterSummary } from '../api/firm.js';
import '../shell/shell.css';

interface ClientsProps {
  readonly onNavigate: (to: string) => void;
}

interface ClientGroup {
  readonly name: string;
  readonly nameAr: string | null;
  readonly matters: MatterSummary[];
  /** Matters the member can act on, rather than only read. */
  readonly actionable: number;
  readonly restricted: number;
}

/** Access levels at which a member can change something, as opposed to read it. */
const ACTIONABLE = new Set(['full', 'edit', 'operational']);

export function Clients({ onNavigate }: ClientsProps) {
  const { t, lang } = useI18n();
  const [data, setData] = useState<MatterListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FirmApiError | null>(null);

  const load = () => {
    setLoading(true);
    firmApi.matters()
      .then((res) => { setData(res); setError(null); })
      .catch((err) => {
        setData(null);
        setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable'));
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  /**
   * Grouped on the CLIENT NAME, not on a client id.
   *
   * The list projection carries the client's name and not their identifier, and
   * that is deliberate — the projection is what the member is entitled to see on
   * a list row. Names are unique within a firm's book in practice, and where two
   * genuinely collide the worst outcome is that they share a card, which is
   * visible and harmless. Inventing an id to group on would mean widening the
   * projection instead: the wrong trade.
   */
  const clients = useMemo<ClientGroup[]>(() => {
    const byName = new Map<string, MatterSummary[]>();
    for (const m of data?.matters ?? []) {
      const name = (lang === 'ar' ? m.clientNameAr : m.clientName) ?? m.clientName ?? m.clientNameAr;
      if (!name) continue;
      const list = byName.get(name);
      if (list) list.push(m);
      else byName.set(name, [m]);
    }
    return [...byName.entries()]
      .map(([name, matters]) => ({
        name,
        nameAr: matters[0]?.clientNameAr ?? null,
        matters,
        actionable: matters.filter((m) => ACTIONABLE.has(m.accessLevel)).length,
        restricted: matters.filter((m) => m.restricted).length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, lang === 'ar' ? 'ar' : 'en'));
  }, [data, lang]);

  if (loading) return <PageSkeleton />;

  if (error) {
    return (
      <div className="firm-page">
        <EmptyState
          kind="error"
          title={t('clients.error.title')}
          description={t('clients.error.body')}
          action={{ label: t('common.retry'), onClick: load }}
        />
      </div>
    );
  }

  return (
    <div className="firm-page">
      <header className="firm-pagehead">
        <div className="firm-pagehead__text">
          <p className="firm-pagehead__eyebrow">{t('nav.clients')}</p>
          <h1 className="firm-pagehead__title">{t('clients.title')}</h1>
          <p className="firm-pagehead__sub">
            {t('clients.subtitle', { n: clients.length })}
            {/* State the scope, in the same words the matters list uses, so a
                scoped count is never read as the firm's whole book. */}
            {data && !data.scope.firmWide && data.scope.practiceAreas.length > 0 && (
              <> · {data.scope.practiceAreas.join('، ')}</>
            )}
            {data?.scope.firmWide && <> · {t('profile.firmWide')}</>}
          </p>
        </div>
        <div className="firm-pagehead__actions">
          <Button variant="ghost" onClick={load}>{t('common.refresh')}</Button>
        </div>
      </header>

      {clients.length === 0 ? (
        <EmptyState
          kind="empty"
          title={t('clients.empty')}
          description={t('clients.emptyBody')}
        />
      ) : (
        <div className="firm-clientgrid">
          {clients.map((client) => (
            <Card key={client.name} as="article" className="firm-clientcard">
              <CardBody>
                <div className="firm-clientcard__head">
                  <span className="firm-clientcard__icon" aria-hidden="true">
                    <IconClients size={18} />
                  </span>
                  <div className="firm-clientcard__id">
                    <h2 className="firm-clientcard__name">{client.name}</h2>
                    {lang !== 'ar' && client.nameAr && (
                      <p className="firm-clientcard__namear" dir="rtl" lang="ar">{client.nameAr}</p>
                    )}
                  </div>
                </div>

                <p className="firm-clientcard__count">
                  {t('clients.matterCount', { n: client.matters.length })}
                  {client.actionable > 0 && ` · ${t('clients.actionable', { n: client.actionable })}`}
                </p>

                {client.restricted > 0 && (
                  <p className="firm-clientcard__flag">
                    <IconRestricted size={13} aria-hidden="true" />
                    {t('clients.restrictedCount', { n: client.restricted })}
                  </p>
                )}

                <ul className="firm-clientcard__matters">
                  {client.matters.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        className="firm-clientcard__matter"
                        onClick={() => onNavigate(`/matters/${encodeURIComponent(m.id)}`)}
                      >
                        <span className="firm-cellnum">{m.matterNumber ?? '—'}</span>
                        <span className="firm-clientcard__title">
                          {(lang === 'ar' ? m.titleAr : m.title) ?? m.title ?? ''}
                        </span>
                        <AccessBadge level={m.accessLevel} lang={lang} />
                      </button>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
