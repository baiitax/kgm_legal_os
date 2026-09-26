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
  AccessBadge, Button, Card, CardBody, EmptyState, IconClients, IconMatters, IconPlus,
  IconRefresh, IconRestricted, PageSkeleton, useI18n,
} from '@kgm/ui';
import {
  FirmApiError, firmApi, type FirmClientRow, type MatterListResponse, type MatterSummary,
} from '../api/firm.js';
import { useFirmSession } from '../auth/FirmSession.js';
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
  const { can } = useFirmSession();
  const [data, setData] = useState<MatterListResponse | null>(null);
  /*
    THE REGISTER, BESIDE THE DERIVED LIST — for the one case the derivation cannot see.

    A client the firm added thirty seconds ago has no matters, so nothing in the matter
    list can produce them and they are invisible exactly when somebody needs to find them.
    The register (GET /clients) is the only place they appear, and the section below says
    what they are: on the firm's books, not yet on a file. The primary list keeps its
    derived scope rule — the two are answers to different questions, not two rules for one.
  */
  const [register, setRegister] = useState<FirmClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FirmApiError | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([firmApi.matters(), firmApi.clients().catch(() => ({ count: 0, clients: [] }))])
      .then(([matters, clients]) => { setData(matters); setRegister(clients.clients); setError(null); })
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

  /*
    CLIENTS ON THE REGISTER WITH NO MATTER AT ALL. Filtered by NAME against the grouped
    list rather than by id, for the same reason the grouping is by name: the matter list's
    client projection carries no id. A name that appears in both is a client with a file,
    so it belongs to the derived section and is not repeated here.
  */
  const unfiled = useMemo(() => {
    const withMatters = new Set(clients.map((c) => c.name));
    return register
      .filter((c) => c.matterCount === 0
        && !withMatters.has(c.name) && !withMatters.has(c.nameAr ?? ''))
      .sort((a, b) => a.name.localeCompare(b.name, lang === 'ar' ? 'ar' : 'en'));
    // `clients` is derived from `data` and the language, so it is a stable dependency.
  }, [register, clients, lang]);


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
          <Button variant="ghost" size="sm" icon={<IconRefresh size={15} />} onClick={load}
            disabled={loading}>
            {t('common.refresh')}
          </Button>
          {/*
            ADD CLIENT, and ADD THE CASE — the two intake stages, reachable from the
            screen a member is looking at when they learn they need them. Both are
            gated by the same permissions the API checks; the buttons are a courtesy,
            never the control.
          */}
          {can('clients.create') && (
            <Button
              variant="secondary" size="sm" icon={<IconPlus size={15} />}
              onClick={() => onNavigate('/clients/new')}
            >
              {t('client.new')}
            </Button>
          )}
          {can('matters.create') && (
            <Button
              variant="primary" size="sm" icon={<IconMatters size={15} />}
              onClick={() => onNavigate('/matters/new')}
            >
              {t('matter.new')}
            </Button>
          )}
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

      {/*
        THE CLIENTS WITH NO FILE — the intake output, findable afterwards.

        Only rendered when there are any: a firm that files every client immediately should
        not carry a permanent empty heading. Each row's action is the next step for that
        client (open their case), because a client sitting on the register unfiled is a
        decision somebody has already made and not yet acted on.
      */}
      {unfiled.length > 0 && (
        <Card className="firm-unfiled">
          <CardBody>
            <h2 className="firm-subsection__title">{t('clients.unfiled.title')}</h2>
            <p className="firm-panel__note">{t('clients.unfiled.sub', { n: unfiled.length })}</p>
            <ul className="firm-clientcard__matters firm-unfiled__list">
              {unfiled.map((c) => (
                <li key={c.id}>
                  <span className="firm-unfiled__name">
                    {(lang === 'ar' ? c.nameAr : c.name) ?? c.name}
                    {c.city && <span className="firm-unfiled__city">{c.city}</span>}
                  </span>
                  {can('matters.create') && (
                    <button
                      type="button"
                      className="firm-clientcard__matter"
                      onClick={() => onNavigate(`/matters/new?client=${encodeURIComponent(c.id)}`)}
                    >
                      <span className="firm-clientcard__title">{t('clients.unfiled.open')}</span>
                      <IconMatters size={14} aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
