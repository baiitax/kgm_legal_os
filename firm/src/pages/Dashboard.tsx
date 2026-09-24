/**
 * DASHBOARD · §19, §20
 *
 * An executive command centre: glass metric cards, a matters list, and the
 * things that need attention today.
 *
 * THE §50 PROBLEM THIS SCREEN HAS TO SOLVE
 *   A dashboard is the easiest place in an application to leak scope. It is built
 *   first, it is shown to everyone, and its natural implementation is "fetch the
 *   numbers, render four cards". The moment a paralegal who cannot read finance
 *   sees an "Outstanding SAR" card, the dashboard has published a figure they
 *   were not authorized for — and if the number is there, the authorization
 *   failed somewhere, because the UI does not get to decide.
 *
 *   So each metric here declares the permission that entitles the member to see
 *   it, and cards the member is not entitled to are NOT RENDERED AT ALL. Not
 *   zeroed, not masked, not shown as "—": absent. A zeroed finance card tells a
 *   member that the firm has no outstanding money, which is a false statement
 *   made by an interface that was not allowed to make it.
 *
 *   The grid then reflows. Four cards become three become two, and §20's "four
 *   primary cards" is honoured as a maximum rather than a fixed count — the
 *   layout promise is about hierarchy, not about always filling four slots.
 *
 * WHY THE SCOPE NOTICE IS ALWAYS THERE
 *   When a member sees three cards instead of four, they need to know that is
 *   scope and not a data outage. The notice says so once, at the top.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Card, CardBody, CardHeader, EmptyState, IconArrowForward,
  IconBilling, IconCalendar, IconDeadlines, IconDocuments, IconLock, IconMatters,
  IconRestricted, MetricCard, MetricSkeleton, PageSkeleton, useFmt, useI18n,
} from '@kgm/ui';
import { useFirmSession } from '../auth/FirmSession.js';
import { firmApi, FirmApiError, type MatterListResponse } from '../api/firm.js';
import { MatterRow } from '../components/MatterRow.js';
import '../shell/shell.css';

interface DashboardProps {
  readonly onNavigate: (to: string) => void;
}

export function Dashboard({ onNavigate }: DashboardProps) {
  const { t, lang } = useI18n();
  const fmt = useFmt();
  const {
    can, canAny, displayName, displayNameAr, practiceAreas, firmWideScope,
    member, mfaEnabled,
  } = useFirmSession();

  const [data, setData] = useState<MatterListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FirmApiError | null>(null);

  const name = lang === 'ar' && displayNameAr ? displayNameAr : displayName;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await firmApi.matters();
        if (!cancelled) { setData(res); setError(null); }
      } catch (err) {
        // A 403/404 here means the member cannot list matters at all. That is a
        // legitimate state — a finance-only member has no matters scope — and it
        // must not render as a broken dashboard.
        if (!cancelled) {
          setData(null);
          setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const matters = data?.matters ?? [];
  const mattersVisible = canAny(['matters.read', 'matters.read_all']);

  /** Counts derived from the authorized list only. Nothing here reaches past
   *  what the server already scoped, which is the point: the dashboard cannot
   *  invent a number the member was not entitled to. */
  const stats = useMemo(() => {
    const active = matters.filter((m) => m.clientStatus !== 'closed' && m.clientStatus !== 'archived');
    const restricted = matters.filter((m) => m.restricted);
    return {
      total: matters.length,
      active: active.length,
      restricted: restricted.length,
      areas: new Set(matters.map((m) => m.practiceArea).filter(Boolean)).size,
    };
  }, [matters]);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return t('dash.greeting.morning');
    if (h < 17) return t('dash.greeting.afternoon');
    if (h < 21) return t('dash.greeting.evening');
    return t('dash.greeting.night');
  }, [t]);

  return (
    <div className="firm-page">
      <header className="firm-pagehead">
        <div className="firm-pagehead__text">
          <p className="firm-pagehead__eyebrow">{greeting}</p>
          <h1 className="firm-pagehead__title">{name}</h1>
          <p className="firm-pagehead__sub">
            {firmWideScope ? t('dash.subtitle') : t('dash.subtitleScoped')}
          </p>
        </div>

        <div className="firm-pagehead__actions">
          {mattersVisible && (
            <Button
              variant="secondary"
              size="sm"
              icon={<IconMatters size={15} />}
              onClick={() => onNavigate('/matters')}
            >
              {t('nav.matters')}
            </Button>
          )}
          {can('matters.create') && (
            <Button variant="primary" size="sm" onClick={() => onNavigate('/matters?new=1')}>
              {t('nav.matters')}
            </Button>
          )}
        </div>
      </header>

      {/*
        Scope notice. Always rendered, because a member who sees fewer cards than
        a colleague needs to know that is by design.
      */}
      <div className="firm-scopenotice">
        <span className="firm-scopenotice__icon" aria-hidden="true"><IconLock size={15} /></span>
        <span>
          {t('dash.scopeNotice')}
          {!firmWideScope && practiceAreas.length > 0 && (
            <> · {practiceAreas.join('، ')}</>
          )}
        </span>
      </div>

      {/* ---- metric cards ---- */}
      {loading ? (
        <div className="firm-metrics">
          <MetricSkeleton /><MetricSkeleton /><MetricSkeleton /><MetricSkeleton />
        </div>
      ) : (
        <div className="firm-metrics">
          {/*
            Each card is gated. The permission list is the SAME set the nav uses,
            so a module hidden from the sidebar cannot reappear here as a metric.
          */}
          {mattersVisible && (
            <MetricCard
              index={0}
              label={t('dash.activeMatters')}
              value={fmt.numberLatin(stats.active)}
              icon={<IconMatters size={18} />}
              note={t('matter.count', { n: fmt.numberLatin(stats.total) })}
              onClick={() => onNavigate('/matters')}
            />
          )}

          {canAny(['hearings.read', 'hearings.manage']) && (
            <MetricCard
              index={1}
              label={t('dash.pendingHearings')}
              // No hearings endpoint is wired yet, so this renders the count the
              // member is authorized to see rather than a fabricated number.
              value="—"
              icon={<IconCalendar size={18} />}
              note={t('nav.planned')}
            />
          )}

          {canAny(['billing.read', 'billing.read_all']) && (
            <MetricCard
              index={2}
              label={t('dash.outstanding')}
              value="—"
              unit={fmt.currencyCode()}
              icon={<IconBilling size={18} />}
              note={t('nav.planned')}
              executive
            />
          )}

          {canAny(['deadlines.read', 'deadlines.manage']) && (
            <MetricCard
              index={3}
              label={t('dash.deadlinesThisWeek')}
              value="—"
              icon={<IconDeadlines size={18} />}
              note={t('nav.planned')}
            />
          )}

          {can('documents.read') && (
            <MetricCard
              index={4}
              label={t('dash.documentsPending')}
              value="—"
              icon={<IconDocuments size={18} />}
              note={t('nav.planned')}
            />
          )}

          {/* A member with no metric permissions at all gets an explanation
              rather than an empty grid. An empty dashboard reads as a bug. */}
          {!mattersVisible && !canAny([
            'hearings.read', 'hearings.manage', 'billing.read', 'billing.read_all',
            'deadlines.read', 'deadlines.manage', 'documents.read',
          ]) && (
            <div className="firm-metrics__none">
              <EmptyState
                kind="denied"
                title={t('dash.noMetrics')}
                description={t('nav.noModulesHint')}
                compact
              />
            </div>
          )}
        </div>
      )}

      {/* ---- restricted notice ---- */}
      {stats.restricted > 0 && (
        <div className="firm-restrictedbanner">
          <span className="firm-restrictedbanner__icon" aria-hidden="true"><IconRestricted size={16} /></span>
          <span className="firm-restrictedbanner__body">
            <span className="firm-restrictedbanner__title">{t('matter.restricted')}</span>
            <span className="firm-restrictedbanner__text">
              {t('matter.restrictedNote')} · {fmt.numberLatin(stats.restricted)}
            </span>
          </span>
        </div>
      )}

      {/* ---- main grid ---- */}
      <div className="firm-dashgrid">
        <div className="firm-dashcol">
          <Card variant="default">
            <CardHeader
              title={t('dash.yourMatters')}
              subtitle={t('dash.yourMattersHint')}
              action={mattersVisible ? (
                <Button variant="ghost" size="xs" trailingIcon={<IconArrowForward size={14} />} onClick={() => onNavigate('/matters')}>
                  {t('dash.viewAll')}
                </Button>
              ) : undefined}
            />
            <CardBody>
              {!mattersVisible ? (
                <EmptyState
                  kind="denied"
                  title={t('common.denied.title')}
                  description={t('common.denied.body')}
                  compact
                />
              ) : loading ? (
                <PageSkeleton title={t('dash.yourMatters')} />
              ) : error ? (
                error.isForbidden || error.isNotVisible ? (
                  <EmptyState kind="denied" title={t('common.denied.title')} description={t('matter.denied.body')} compact />
                ) : (
                  <EmptyState
                    kind={error.status === 0 ? 'offline' : 'error'}
                    title={t('common.error.title')}
                    description={t('common.error.network')}
                    compact
                    action={{ label: t('matter.retry'), onClick: () => window.location.reload() }}
                  />
                )
              ) : matters.length === 0 ? (
                <EmptyState
                  kind="empty"
                  title={t('matter.empty.title')}
                  description={t('matter.empty.body')}
                  compact
                />
              ) : (
                <ul className="firm-matterlist">
                  {matters.slice(0, 6).map((m) => (
                    <MatterRow key={m.id} matter={m} onNavigate={onNavigate} />
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="firm-dashcol">
          {/* Access summary. A member should be able to see the SHAPE of their
              own authorization without asking an admin — that is what makes the
              field locks on a matter legible rather than arbitrary. */}
          <Card variant="default">
            <CardHeader title={t('profile.title')} />
            <CardBody>
              <dl className="firm-deflist">
                <div className="firm-deflist__row">
                  <dt>{t('profile.role')}</dt>
                  <dd>
                    {(member?.roles ?? []).map((r) => (
                      <Badge key={r.code} tone="brand" size="xs">
                        {lang === 'ar' && r.nameAr ? r.nameAr : r.name}
                      </Badge>
                    ))}
                  </dd>
                </div>
                <div className="firm-deflist__row">
                  <dt>{t('profile.practiceAreas')}</dt>
                  <dd>
                    {firmWideScope
                      ? <Badge tone="gold" size="xs">{t('profile.firmWide')}</Badge>
                      : (practiceAreas.length
                        ? practiceAreas.map((pa) => <Badge key={pa} tone="info" size="xs">{pa}</Badge>)
                        : <span className="c-muted">{t('common.none')}</span>)}
                  </dd>
                </div>
                <div className="firm-deflist__row">
                  <dt>{t('profile.authority')}</dt>
                  <dd>
                    {member?.ceilings.financialSar == null
                      ? <span className="c-muted">{t('profile.noAuthority')}</span>
                      : <strong>{fmt.money(member.ceilings.financialSar)}</strong>}
                  </dd>
                </div>
                <div className="firm-deflist__row">
                  <dt>{t('profile.mfa')}</dt>
                  <dd>
                    <Badge tone={mfaEnabled ? 'lime' : 'warning'} size="xs">
                      {mfaEnabled ? t('profile.mfaEnabled') : t('profile.mfaDisabled')}
                    </Badge>
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          {stats.areas > 0 && (
            <Card variant="solid">
              <CardHeader title={t('matter.filter.practiceArea')} />
              <CardBody>
                <div className="kgm-profile__chips">
                  {[...new Set(matters.map((m) => m.practiceArea).filter(Boolean))].map((pa) => (
                    <Badge key={pa} tone="neutral" size="sm">{pa}</Badge>
                  ))}
                </div>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
