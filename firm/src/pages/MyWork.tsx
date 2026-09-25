/**
 * MY WORK · the matters this member can act on, grouped by what they may do.
 *
 * WHY "MY WORK" IS NOT "MATTERS, FILTERED BY ME"
 *   There is no `assigned to me` column in the list projection, and adding one
 *   would be a filing detail masquerading as the answer. In this product the
 *   question a member is actually asking when they open "my work" is "what can I
 *   DO" — and the server answers that with `accessLevel` on every row, already
 *   reconciled against the permission catalogue, the practice-area scope, the
 *   matter team and the explicit grants.
 *
 *   So this screen groups by that answer rather than re-deriving it: matters I
 *   can work on, matters I approve spending on, matters I can read, matters I am
 *   merely named on. Grouping by access rather than by client or by date is what
 *   makes the screen a worklist instead of a second matters list — and it shows,
 *   without saying so, that authorization is what decides the shape of a
 *   member's day here.
 *
 * THE GROUPS ARE ORDERED BY HOW MUCH THEY LET YOU DO
 *   Descending from full access to view-only. A member opening this screen wants
 *   the things they can change at the top; a group that is empty is omitted
 *   rather than shown with a zero, because an empty group on a worklist is a
 *   heading with nothing under it.
 */
import { useEffect, useMemo, useState } from 'react';
import { AccessBadge, Badge, Button, Card, CardBody, EmptyState, IconRestricted, PageSkeleton, useI18n } from '@kgm/ui';
import { FirmApiError, firmApi, type MatterAccessLevel, type MatterListResponse, type MatterSummary } from '../api/firm.js';
import '../shell/shell.css';

interface MyWorkProps {
  readonly onNavigate: (to: string) => void;
}

/**
 * The groups, in the order a member works through them.
 *
 * `full`, `edit` and `operational` are separated from `view` because the first
 * three are permissions to change something and the last is not — merging them
 * would put a matter the member can close next to one they can only read.
 * `financial` and `compliance` stand alone: they are real access levels with
 * their own meaning, and folding either into "view" would tell a finance member
 * their approval queue is a reading list.
 */
const GROUPS: ReadonlyArray<{
  readonly id: MatterAccessLevel;
  readonly titleKey: string;
  readonly bodyKey: string;
}> = [
  { id: 'full', titleKey: 'mywork.group.full', bodyKey: 'mywork.group.full.body' },
  { id: 'edit', titleKey: 'mywork.group.edit', bodyKey: 'mywork.group.edit.body' },
  { id: 'operational', titleKey: 'mywork.group.operational', bodyKey: 'mywork.group.operational.body' },
  { id: 'financial', titleKey: 'mywork.group.financial', bodyKey: 'mywork.group.financial.body' },
  { id: 'compliance', titleKey: 'mywork.group.compliance', bodyKey: 'mywork.group.compliance.body' },
  { id: 'view', titleKey: 'mywork.group.view', bodyKey: 'mywork.group.view.body' },
];

export function MyWork({ onNavigate }: MyWorkProps) {
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

  const grouped = useMemo(() => {
    const matters = data?.matters ?? [];
    return GROUPS
      .map((group) => ({ ...group, items: matters.filter((m) => m.accessLevel === group.id) }))
      .filter((group) => group.items.length > 0);
  }, [data]);

  const total = data?.matters.length ?? 0;

  if (loading) return <PageSkeleton />;

  if (error) {
    return (
      <div className="firm-page">
        <EmptyState
          kind="error"
          title={t('mywork.error.title')}
          description={t('mywork.error.body')}
          action={{ label: t('common.retry'), onClick: load }}
        />
      </div>
    );
  }

  return (
    <div className="firm-page">
      <header className="firm-pagehead">
        <div className="firm-pagehead__text">
          <p className="firm-pagehead__eyebrow">{t('nav.workspace')}</p>
          <h1 className="firm-pagehead__title">{t('mywork.title')}</h1>
          <p className="firm-pagehead__sub">{t('mywork.subtitle', { n: total })}</p>
        </div>
        <div className="firm-pagehead__actions">
          <Button variant="ghost" onClick={load}>{t('common.refresh')}</Button>
        </div>
      </header>

      {total === 0 ? (
        <EmptyState kind="empty" title={t('mywork.empty')} description={t('mywork.emptyBody')} />
      ) : (
        grouped.map((group) => (
          <section key={group.id} className="firm-workgroup">
            <div className="firm-workgroup__head">
              <AccessBadge level={group.id} lang={lang} />
              <h2 className="firm-workgroup__title">{t(group.titleKey as never)}</h2>
              <span className="firm-workgroup__count">{group.items.length}</span>
            </div>
            <p className="firm-workgroup__body">{t(group.bodyKey as never)}</p>

            <div className="firm-workgrid">
              {group.items.map((m: MatterSummary) => (
                <Card key={m.id} as="article" className="firm-workcard">
                  <CardBody>
                    <button
                      type="button"
                      className="firm-workcard__btn"
                      onClick={() => onNavigate(`/matters/${encodeURIComponent(m.id)}`)}
                    >
                      <span className="firm-workcard__num">{m.matterNumber ?? '—'}</span>
                      <span className="firm-workcard__title">
                        {(lang === 'ar' ? m.titleAr : m.title) ?? m.title ?? ''}
                      </span>
                      <span className="firm-workcard__client">
                        {(lang === 'ar' ? m.clientNameAr : m.clientName) ?? m.clientName ?? ''}
                      </span>
                      <span className="firm-workcard__tags">
                        {m.practiceArea && (
                          <Badge tone="neutral" size="xs">
                            {(lang === 'ar' ? m.practiceAreaAr : m.practiceArea) ?? m.practiceArea}
                          </Badge>
                        )}
                        {m.restricted && (
                          <Badge tone="warning" size="xs">
                            <IconRestricted size={11} aria-hidden="true" />
                            {t('matter.restricted')}
                          </Badge>
                        )}
                      </span>
                    </button>
                  </CardBody>
                </Card>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
