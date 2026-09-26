/**
 * MATTER WORKSPACE · §22, §57
 *
 * Sticky header, tabbed body, and the field locks that make §57 visible.
 *
 * THE §57 RULE, STATED PLAINLY
 *   The server returns a matter with some fields ABSENT and a `withheld` array
 *   naming them. Absent is not null. `riskRating: null` means "no rating
 *   recorded"; a missing `riskRating` means "not for you". Rendering both as an
 *   empty cell would make the classification system invisible — the member would
 *   see a blank and conclude the data is missing, when the truth is that they are
 *   not cleared for it.
 *
 *   So every classified field renders through `ClassifiedField`, which checks
 *   `withheld` and draws a LOCK when the field was held back. The lock names the
 *   field and explains why it is hidden. A member learns the field exists and that
 *   their access level is the reason — which is both more useful and more honest
 *   than a gap.
 *
 * WHY THE LOCK IS A FEATURE AND NOT A LEAK
 *   There is a real argument for hiding withheld fields entirely: don't confirm
 *   what exists. That argument loses here, because the field NAMES are already
 *   part of the shared vocabulary — every member knows matters have risk ratings,
 *   and the §57 classification table is firm policy, not a secret. What must not
 *   leak is the VALUE, and it does not. A lock on "Risk rating" discloses nothing
 *   the member did not already know; a blank cell there teaches them the system is
 *   unreliable.
 *
 *   The one exception is handled separately: `restrictionReason` is itself
 *   classified, so a member without `matters.restrict` sees that the matter is
 *   restricted (an authorization fact, always returned) but not why.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AccessBadge, Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState,
  IconChevronBack, IconEdit, IconLock, IconRestricted, IconTime, PageSkeleton,
  Skeleton, StatusChip, useFmt, useI18n,
} from '@kgm/ui';
import { useFirmSession } from '../auth/FirmSession.js';
import { firmApi, FirmApiError, type MatterDetail } from '../api/firm.js';
import { FieldLock, WithheldStrip } from '../components/FieldLock.js';

/**
 * Mirror of the server's `never` tier, for matter projections.
 *
 * These are excluded from the withheld COUNT because they are not classified
 * fields — no caller at any level ever sees them, so reporting them as "withheld
 * from you" would be a category error. The server remains the authority on what
 * is emitted; this set only decides what the UI counts as a classification event.
 */
const NEVER_ON_THE_WIRE: ReadonlySet<string> = new Set([
  'tenantId', 'storageKey', 'storageBucket', 'storedFilename',
]);
import { MatterTabs, type MatterTabId } from '../components/MatterTabs.js';
import {
  MatterDeadlinesPanel, MatterDocumentsPanel, MatterHearingsPanel,
  MatterTeamPanel, MatterTimelinePanel,
} from './matter/Panels.js';
import {
  MatterBillingPanel, MatterConflictsPanel, MatterJudgmentsPanel, MatterPartiesPanel,
} from './matter/Registers.js';
import { ReportEditor } from './matter/ReportEditor.js';
import type { MatterTimelineRow } from '../api/firm.js';
import '../shell/shell.css';

interface MatterWorkspaceProps {
  readonly matterId: string;
  readonly onNavigate: (to: string) => void;
}

export function MatterWorkspace({ matterId, onNavigate }: MatterWorkspaceProps) {
  const { t, lang, pick } = useI18n();
  const fmt = useFmt();
  // Both hooks are called unconditionally at the top. `permissions` is needed by
  // the tabs, which render below three early returns — calling useFirmSession()
  // down there would change the hook count between renders.
  const { can, permissions } = useFirmSession();

  const [matter, setMatter] = useState<MatterDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FirmApiError | null>(null);
  const [tab, setTab] = useState<MatterTabId>('overview');
  /*
    The report editor is opened from the header and rendered inside the Overview
    column, so a member who opened it from the top of the page sees it appear in the
    column they are already reading rather than in a modal that hides the case.
  */
  const [reportOpen, setReportOpen] = useState(false);

  /*
    ONE LOADER, SO A WRITE CAN RE-READ. The report editor saves through its own route
    and then needs the header, the identity card and the withheld list to reflect what
    it just wrote — a save that leaves the screen showing the previous values is a save
    nobody believes happened.
  */
  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMatter(null);
    void firmApi.matter(matterId)
      .then((res) => { if (!cancelled) setMatter(res); })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [matterId]);

  useEffect(() => load(), [load]);

  // Reset to the first tab when moving between matters, so a tab that exists for
  // one matter's access level is not left selected on another's.
  useEffect(() => { setTab('overview'); }, [matterId]);

  /**
   * Fields withheld by CLASSIFICATION, as opposed to fields that have no wire
   * format at all.
   *
   * `tenantId` is level `never` in the server registry: it is excluded from every
   * projection for every caller, including a Managing Partner holding `full`
   * access, and the projector still lists it in `withheld` because the projector
   * reports names rather than making claims about who could have seen them.
   *
   * Counting it here would tell a full-access partner that one field is being
   * hidden from them. That is false in the sense that matters — it is not a field
   * being classified away, it is a structural column with no API representation.
   * Filtering it keeps the §57 count meaning "classified fields you may not read".
   */
  const withheld = useMemo(
    () => (matter?.withheld ?? []).filter((f) => !NEVER_ON_THE_WIRE.has(f)),
    [matter],
  );
  const isWithheld = (field: string) => withheld.includes(field);

  const title = matter ? (pick(matter.titleAr, matter.title) || matter.matterNumber || t('common.none')) : '';

  if (loading) {
    return <PageSkeleton title={t('matter.title')} hint={t('common.loading')} />;
  }

  if (error) {
    /*
      §57 404 discipline. The API answers 404 for both "not yours" and "does not
      exist", deliberately: distinguishing them would confirm the existence of a
      matter the member cannot see. The UI must therefore NOT say "no results" —
      it says "not available to you, or not present", which is the honest union of
      the two and leaks neither.
    */
    if (error.isNotVisible || error.isForbidden) {
      return (
        <div className="firm-guard">
          <div className="firm-guard__inner">
            <EmptyState
              kind="denied"
              title={t('matter.denied.title')}
              description={t('matter.denied.body')}
              action={{ label: t('common.back'), onClick: () => onNavigate('/matters') }}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="firm-guard">
        <div className="firm-guard__inner">
          <EmptyState
            kind={error.status === 0 ? 'offline' : 'error'}
            title={t('matter.error.title')}
            description={error.status === 0 ? t('common.error.network') : t('matter.error.body')}
            action={{ label: t('matter.retry'), onClick: () => window.location.reload() }}
            secondaryAction={{ label: t('common.back'), onClick: () => onNavigate('/matters') }}
          />
        </div>
      </div>
    );
  }

  if (!matter) return null;

  const ar = lang === 'ar' ? 'ar' : 'en';

  return (
    <div className="firm-page">
      {/* ---- sticky header (§22) ---- */}
      <header className="firm-matterhead">
        <div className="firm-matterhead__id">
          <div className="firm-matterhead__num">
            <Button
              variant="ghost"
              size="xs"
              icon={<IconChevronBack size={14} />}
              onClick={() => onNavigate('/matters')}
            >
              {t('nav.matters')}
            </Button>
            {matter.matterNumber && (
              <span className="firm-matterhead__numtext">{matter.matterNumber}</span>
            )}
            {matter.restricted && (
              <Badge tone="gold" size="xs" icon={<IconRestricted size={11} />}>
                {t('matter.restricted')}
              </Badge>
            )}
          </div>

          <h1 className="firm-matterhead__title">{title}</h1>

          <div className="firm-matterhead__meta">
            {matter.clientStatus && <StatusChip status={matter.clientStatus} lang={ar} />}
            {matter.practiceArea && (
              <Badge tone="neutral" size="xs">{pick(matter.practiceAreaAr, matter.practiceArea)}</Badge>
            )}
            {matter.clientName && (
              <span>{pick(matter.clientNameAr, matter.clientName)}</span>
            )}
            {/* The viewer's own access level, always shown. It is the fact that
                explains every lock on this page. */}
            <AccessBadge level={matter.accessLevel} lang={ar} />
          </div>
        </div>

        <div className="firm-matterhead__actions">
          {/*
            UPDATE THE CASE REPORT.

            This button used to read "Save" and do nothing at all — it was a `<Button>`
            with no handler, on the busiest screen in the product, which is the one
            defect a reader is certain to find. It now opens the report editor, which is
            the write the header was promising: what the file is called, what it is
            about, and what the client is told.

            Shown only to a member who may actually make the change: `matters.update`
            plus an editing access level on THIS matter. The route checks the same pair,
            so the button and the refusal cannot disagree.
          */}
          {can('matters.update') && matter.accessLevel !== 'view' && (
            <Button
              variant="secondary" size="sm" icon={<IconEdit size={15} />}
              onClick={() => setReportOpen(true)}
            >
              {t('report.edit')}
            </Button>
          )}
        </div>
      </header>

      {/* ---- restricted banner ---- */}
      {matter.restricted && (
        <div className="firm-restrictedbanner">
          <span className="firm-restrictedbanner__icon" aria-hidden="true"><IconRestricted size={16} /></span>
          <span className="firm-restrictedbanner__body">
            <span className="firm-restrictedbanner__title">{t('matter.restricted')}</span>
            <span className="firm-restrictedbanner__text">
              {t('matter.restrictedNote')}
              {/*
                The reason is itself classified. A member without matters.restrict
                sees that the matter is restricted but not why — and the absence
                is explained rather than left as a gap.
              */}
              {isWithheld('restrictionReason') ? (
                <> · <FieldLock field="restrictionReason" label={t('matter.restrictionReason')} inline /></>
              ) : matter.restrictionReason ? (
                <> · {pick(matter.restrictionReasonAr, matter.restrictionReason)}</>
              ) : null}
            </span>
          </span>
        </div>
      )}

      {/* ---- withheld strip (§57) ---- */}
      <WithheldStrip
        count={withheld.length}
        label={t('cls.withheldCount', { n: withheld.length })}
        accessLevel={matter.accessLevel}
        explainer={t('cls.accessExplainer', { level: accessLabel(matter.accessLevel, lang) })}
      />

      {/* ---- tabs (§22) ---- */}
      <MatterTabs
        active={tab}
        onChange={setTab}
        accessLevel={matter.accessLevel}
        permissions={permissions}
      />

      {/* ---- tab body ---- */}
      {tab === 'overview' && (
        <div className="firm-mattergrid">
          <div className="firm-dashcol">
            {/*
              THE REPORT EDITOR, IN THE COLUMN, WHEN ASKED FOR. Rendered above the
              identity card rather than in a modal: a drawer would cover the very facts
              the lawyer is updating the report FROM.
            */}
            {reportOpen && (
              <ReportEditor
                matterId={matterId}
                onClose={() => setReportOpen(false)}
                onSaved={load}
              />
            )}
            <Card variant="default">
              <CardHeader title={t('tab.overview')} />
              <CardBody>
                <div className="firm-fieldgrid">
                  <ClassifiedField
                    field="titleAr"
                    label={t('matter.title')}
                    withheld={isWithheld('titleAr')}
                    value={pick(matter.titleAr, matter.title)}
                  />
                  <ClassifiedField
                    field="caseNumber"
                    label={t('matter.caseNumber')}
                    withheld={isWithheld('caseNumber')}
                    value={matter.caseNumber}
                    numeric
                  />
                  <ClassifiedField
                    field="clientName"
                    label={t('matter.client')}
                    withheld={isWithheld('clientName')}
                    value={pick(matter.clientNameAr, matter.clientName)}
                  />
                  <ClassifiedField
                    field="court"
                    label={t('matter.court')}
                    withheld={isWithheld('court')}
                    value={pick(matter.courtAr, matter.court)}
                  />
                  <ClassifiedField
                    field="openedAt"
                    label={t('matter.openedAt')}
                    withheld={isWithheld('openedAt')}
                    value={matter.openedAt ? fmt.date(matter.openedAt) : null}
                  />
                  <ClassifiedField
                    field="internalStatus"
                    label={t('cls.internalStatus')}
                    withheld={isWithheld('internalStatus')}
                    value={matter.internalStatus}
                    render={(v) => <StatusChip status={String(v)} lang={ar} />}
                  />
                  <ClassifiedField
                    field="riskRating"
                    label={t('cls.riskRating')}
                    withheld={isWithheld('riskRating')}
                    value={matter.riskRating}
                    render={(v) => <Badge tone={riskTone(String(v))} size="sm">{String(v)}</Badge>}
                  />
                  <ClassifiedField
                    field="conflictCleared"
                    label={t('cls.conflictCleared')}
                    withheld={isWithheld('conflictCleared')}
                    value={matter.conflictCleared}
                    render={(v) => (
                      <Badge tone={v ? 'lime' : 'warning'} size="sm">
                        {v ? t('common.yes') : t('common.no')}
                      </Badge>
                    )}
                  />
                  <ClassifiedField
                    field="closedAt"
                    label={t('status.closed')}
                    withheld={isWithheld('closedAt')}
                    value={matter.closedAt ? fmt.date(matter.closedAt) : null}
                  />
                </div>

                {/* Summary is internal-classified: visible to the team, withheld
                    from a view-only or financial access level. */}
                <div className="firm-field" style={{ marginTop: 'var(--sp-4)' }}>
                  <ClassifiedField
                    field="summary"
                    label={t('cls.summary')}
                    withheld={isWithheld('summary')}
                    value={pick(matter.summaryAr, matter.summary)}
                    block
                  />
                </div>

                <div className="firm-field" style={{ marginTop: 'var(--sp-4)' }}>
                  <ClassifiedField
                    field="internalNotes"
                    label={t('cls.internalNotes')}
                    withheld={isWithheld('internalNotes')}
                    value={matter.internalNotes}
                    block
                  />
                </div>
              </CardBody>
            </Card>
          </div>

          <div className="firm-dashcol">
            {/* Authorization card. This is not classified data — it is the
                member's own standing on this matter, which they are always
                entitled to see, and which explains the locks beside it. */}
            <Card variant="solid">
              <CardHeader title={t('matter.accessLevel')} icon={<IconLock size={15} />} />
              <CardBody>
                <dl className="firm-deflist">
                  <div className="firm-deflist__row">
                    <dt>{t('matter.accessLevel')}</dt>
                    <dd><AccessBadge level={matter.accessLevel} lang={ar} size="sm" /></dd>
                  </div>
                  <div className="firm-deflist__row">
                    <dt>{t('matter.teamRole')}</dt>
                    <dd>{matter.teamRole ?? <span className="c-muted">{t('common.none')}</span>}</dd>
                  </div>
                  <div className="firm-deflist__row">
                    <dt>{t('matter.department')}</dt>
                    <dd>{matter.department ?? <span className="c-muted">{t('common.none')}</span>}</dd>
                  </div>
                  <div className="firm-deflist__row">
                    <dt>{t('matter.restricted')}</dt>
                    <dd>
                      <Badge tone={matter.restricted ? 'gold' : 'neutral'} size="xs">
                        {matter.restricted ? t('common.yes') : t('common.no')}
                      </Badge>
                    </dd>
                  </div>
                </dl>

                {withheld.length > 0 && (
                  <Alert tone="notice" compact className="firm-accessalert">
                    {t('cls.withheldHint')}
                  </Alert>
                )}
              </CardBody>
            </Card>

            {/*
              THE OVERVIEW'S TIMELINE CARD SHOWS THE LAST FEW ENTRIES AND POINTS AT
              THE TAB. It used to render an empty state on the theory that the
              timeline was not built; it is built now, and an overview that shows
              "nothing here" while a populated Timeline tab sits one click away is
              the exact defect this phase removes.
            */}
            <Card variant="default">
              <CardHeader
                title={t('timeline.title')}
                icon={<IconTime size={15} />}
                action={<Badge tone="neutral" size="xs">{t('common.recent')}</Badge>}
              />
              <CardBody>
                <OverviewTimeline matterId={matterId} onOpenAll={() => setTab('timeline')} />
              </CardBody>
            </Card>
          </div>
        </div>
      )}

      {/*
        ── THE TAB BODIES ───────────────────────────────────────────────────────

        One panel per tab, mounted only while its tab is the active one. The tab
        strip has already filtered by permission ∩ access level, so reaching this
        switch means this member may open this material; the panel's own endpoint
        checks that again on the server, because the strip is a courtesy and the
        server is the rule (§50).
      */}
      {tab === 'timeline' && <MatterTimelinePanel matterId={matterId} />}
      {tab === 'team' && <MatterTeamPanel matterId={matterId} />}
      {tab === 'documents' && <MatterDocumentsPanel matterId={matterId} />}
      {tab === 'hearings' && <MatterHearingsPanel matterId={matterId} />}
      {tab === 'deadlines' && <MatterDeadlinesPanel matterId={matterId} />}
      {tab === 'parties' && <MatterPartiesPanel matterId={matterId} />}
      {tab === 'conflicts' && <MatterConflictsPanel matterId={matterId} />}
      {tab === 'judgments' && <MatterJudgmentsPanel matterId={matterId} />}
      {tab === 'billing' && <MatterBillingPanel matterId={matterId} />}
      {(tab === 'time' || tab === 'expenses') && (
        <MatterBillingPanel matterId={matterId} />
      )}
    </div>
  );
}

/**
 * The overview's three most recent entries.
 *
 * A small, separately-loading read: if it fails the overview is still a usable
 * screen, which is why a failure here renders a quiet line and not a panel-wide
 * error state.
 */
function OverviewTimeline({ matterId, onOpenAll }: { matterId: string; onOpenAll: () => void }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const [rows, setRows] = useState<MatterTimelineRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    firmApi.matterTimeline(matterId)
      .then((d) => { if (alive) setRows(d.timeline.slice(0, 3)); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [matterId]);

  if (rows === null) return <Skeleton height={54} variant="rect" />;
  if (rows.length === 0) {
    return <EmptyState kind="empty" title={t('timeline.empty')} compact branded={false} />;
  }
  return (
    <ul className="firm-list firm-list--compact">
      {rows.map((e) => (
        <li className="firm-timeline__item" key={e.id}>
          <span className={`firm-timeline__dot firm-timeline__dot--${e.status}`} aria-hidden="true" />
          <span className="firm-timeline__body">
            <span className="firm-timeline__title">{pick(e.titleAr, e.title)}</span>
            <span className="firm-timeline__when">{fmt.dateTime(e.occurredAt)}</span>
          </span>
        </li>
      ))}
      <li className="firm-list__more">
        <button type="button" className="kgm-linkbtn" onClick={onOpenAll}>
          {t('panel.seeAll')}
        </button>
      </li>
    </ul>
  );
}

// ==========================================================================
// CLASSIFIED FIELD
// ==========================================================================

interface ClassifiedFieldProps {
  /** The WIRE name, matching the server's `withheld` entries. */
  readonly field: string;
  readonly label: string;
  readonly withheld: boolean;
  readonly value: string | number | boolean | null | undefined;
  readonly numeric?: boolean;
  readonly block?: boolean;
  readonly render?: (value: NonNullable<ClassifiedFieldProps['value']>) => React.ReactNode;
}

/**
 * One classified field.
 *
 * The withheld branch and the empty branch render DIFFERENTLY, and that
 * difference is the entire mechanism:
 *
 *   withheld  → a lock, naming the field and explaining the rule
 *   null      → an em dash, meaning "no value recorded"
 *   value     → the value
 *
 * Collapsing the first two is the failure mode §57 exists to prevent.
 */
function ClassifiedField({ field, label, withheld, value, numeric, block, render }: ClassifiedFieldProps) {
  const { t } = useI18n();

  if (withheld) {
    return (
      <div className={`firm-field${block ? ' firm-field--block' : ''}`}>
        <span className="firm-field__label">{label}</span>
        <FieldLock field={field} label={label} />
      </div>
    );
  }

  const empty = value === null || value === undefined || value === '';

  return (
    <div className={`firm-field${block ? ' firm-field--block' : ''}`}>
      <span className="firm-field__label">{label}</span>
      {empty ? (
        <span className="firm-field__value c-muted" title={t('common.none')}>—</span>
      ) : (
        <span className="firm-field__value" data-numeric={numeric || undefined}>
          {render ? render(value as NonNullable<ClassifiedFieldProps['value']>) : String(value)}
        </span>
      )}
    </div>
  );
}

// ==========================================================================

function accessLabel(level: string, lang: string): string {
  const map: Record<string, { ar: string; en: string }> = {
    full: { ar: 'صلاحية كاملة', en: 'Full access' },
    edit: { ar: 'تحرير', en: 'Edit' },
    operational: { ar: 'تشغيلي', en: 'Operational' },
    view: { ar: 'اطلاع فقط', en: 'View only' },
    financial: { ar: 'مالي', en: 'Financial' },
    compliance: { ar: 'امتثال', en: 'Compliance' },
  };
  const entry = map[level];
  if (!entry) return level;
  return lang === 'ar' ? entry.ar : entry.en;
}

function riskTone(rating: string): 'lime' | 'info' | 'warning' | 'high' | 'critical' | 'neutral' {
  const r = rating.toLowerCase();
  if (r.includes('low') || r.includes('منخفض')) return 'lime';
  if (r.includes('medium') || r.includes('متوسط')) return 'warning';
  if (r.includes('high') || r.includes('مرتفع')) return 'high';
  if (r.includes('critical') || r.includes('حرج')) return 'critical';
  return 'neutral';
}
