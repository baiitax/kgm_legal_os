/**
 * THE MATTER WORKSPACE'S TAB BODIES
 *
 * A tab strip is a promise: every tab is a destination with something behind it.
 * Until this phase twelve of the thirteen were decoration — the strip rendered a
 * place-holder card reading "in development", which is honest and useless.
 *
 * Each panel here is a real read against a real endpoint, and each one renders
 * four states honestly rather than collapsing them:
 *
 *   LOADING  a skeleton of the shape the data will take, so the page does not
 *            jump when it lands.
 *   REFUSED  the member's access level does not carry this material. NOT an empty
 *            list — an empty list says "there is nothing here", and the truth is
 *            "this is not yours to read". The panel says which, because §57's
 *            whole discipline is that those two absences mean different things.
 *   EMPTY    the member may read it and there is genuinely nothing yet.
 *   DATA     the record.
 *
 * WHY THE FETCH LIVES IN THE PANEL AND NOT IN THE WORKSPACE
 *   The workspace already loads the matter itself. Loading every tab's data with
 *   it would make opening a matter send the firm's entire file — hearings,
 *   deadlines, documents, conflicts — so that twelve panels nobody opened can sit
 *   in memory. Each panel asks for its own rows when it is the one on screen, and
 *   keeps them until the matter changes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Card, CardBody, CardHeader, EmptyState, IconLock,
  Skeleton, StatusChip, Table, useFmt, useI18n,
  type Column,
} from '@kgm/ui';
import { firmApi, FirmApiError, type MatterDeadlineRow, type MatterDocumentRow, type MatterHearingRow, type MatterTimelineRow, type MatterTeamRow } from '../../api/firm.js';

/* -------------------------------------------------------------- panel kit -- */

type PanelState<T> =
  | { status: 'loading' }
  | { status: 'denied' }
  | { status: 'error'; error: FirmApiError }
  | { status: 'ready'; data: T };

/**
 * One read, one panel.
 *
 * `key` is the matter id: moving to another matter must not show the previous
 * matter's hearings for a frame, which is the kind of wrongness a reader notices
 * instantly and never fully trusts again.
 */
function usePanel<T>(key: string, load: () => Promise<T>): PanelState<T> & { reload: () => void } {
  const [state, setState] = useState<PanelState<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    setState({ status: 'loading' });
    load()
      .then((data) => { if (alive.current) setState({ status: 'ready', data }); })
      .catch((err: unknown) => {
        if (!alive.current) return;
        const apiErr = err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable');
        /*
          A refusal is a state, not a failure. `isForbidden` / `isNotVisible` mean
          the member's access level does not carry this material, and the panel
          renders that as a decision the firm made rather than an error it hit.
        */
        setState(apiErr.isForbidden || apiErr.isNotVisible
          ? { status: 'denied' }
          : { status: 'error', error: apiErr });
      });
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

function PanelLoading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="firm-panel__loading" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={44} variant="rect" />
      ))}
    </div>
  );
}

/**
 * The four endings, in one place so every tab behaves identically.
 *
 * `denied` deliberately says ACCESS, not absence. A member who cannot open a
 * matter's documents should be told their access level is why — otherwise they
 * conclude the firm files nothing.
 */
function PanelFrame<T>({
  state, title, icon, isEmpty, emptyTitle, emptyBody, children,
}: {
  state: PanelState<T> & { reload: () => void };
  title: string;
  icon?: React.ReactNode;
  isEmpty?: (data: T) => boolean;
  emptyTitle: string;
  emptyBody?: string;
  children: (data: T) => React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Card variant="default" className="firm-panel">
      <CardHeader title={title} icon={icon} />
      <CardBody>
        {state.status === 'loading' && <PanelLoading />}
        {state.status === 'denied' && (
          <EmptyState
            kind="denied"
            branded={false}
            compact
            icon={<IconLock size={20} />}
            title={t('panel.denied.title')}
            description={t('panel.denied.body')}
          />
        )}
        {state.status === 'error' && (
          <EmptyState
            kind="error"
            branded={false}
            compact
            title={t('panel.error.title')}
            description={t('panel.error.body')}
            action={{ label: t('common.retry'), onClick: state.reload }}
          />
        )}
        {state.status === 'ready' && (isEmpty?.(state.data) ?? false) && (
          <EmptyState kind="empty" branded={false} compact title={emptyTitle} description={emptyBody} />
        )}
        {state.status === 'ready' && !(isEmpty?.(state.data) ?? false) && children(state.data)}
      </CardBody>
    </Card>
  );
}

/* --------------------------------------------------------------- timeline -- */

export function MatterTimelinePanel({ matterId }: { matterId: string }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const state = usePanel(matterId, () => firmApi.matterTimeline(matterId));

  return (
    <PanelFrame
      state={state}
      title={t('tab.timeline')}
      emptyTitle={t('timeline.empty')}
      emptyBody={t('timeline.emptyBody')}
      isEmpty={(d) => d.timeline.length === 0}
    >
      {(d) => (
        <ol className="firm-timeline">
          {d.timeline.map((e: MatterTimelineRow) => (
            <li className="firm-timeline__item" key={e.id}>
              <span className={`firm-timeline__dot firm-timeline__dot--${e.status}`} aria-hidden="true" />
              <div className="firm-timeline__body">
                <div className="firm-timeline__head">
                  <span className="firm-timeline__title">{pick(e.titleAr, e.title)}</span>
                  <Badge tone="neutral" size="xs">{e.eventType.replace(/_/g, ' ')}</Badge>
                  {!e.clientVisible && (
                    <Badge tone="gold" size="xs" icon={<IconLock size={10} />}>
                      {t('panel.internalOnly')}
                    </Badge>
                  )}
                </div>
                {(pick(e.descriptionAr, e.description) || '') && (
                  <p className="firm-timeline__text">{pick(e.descriptionAr, e.description)}</p>
                )}
                <span className="firm-timeline__when">
                  {fmt.dateTime(e.occurredAt)} · {fmt.relative(e.occurredAt)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </PanelFrame>
  );
}

/* ------------------------------------------------------------------- team -- */

export function MatterTeamPanel({ matterId }: { matterId: string }) {
  const { t, pick } = useI18n();
  const state = usePanel(matterId, () => firmApi.matterTeam(matterId));

  return (
    <PanelFrame
      state={state}
      title={t('tab.team')}
      emptyTitle={t('panel.team.empty')}
      isEmpty={(d) => d.team.length === 0}
    >
      {(d) => (
        <ul className="firm-teamlists">
          {d.team.map((m: MatterTeamRow) => (
            <li className="firm-teammember" key={m.id}>
              <span className="firm-teammember__avatar" aria-hidden="true">
                {initials(pick(m.nameAr, m.name))}
              </span>
              <span className="firm-teammember__main">
                <span className="firm-teammember__name">{pick(m.nameAr, m.name)}</span>
                <span className="firm-teammember__meta">
                  {m.matterRole.replace(/_/g, ' ')}
                  {m.barNumber ? ` · ${t('panel.bar')} ${m.barNumber}` : ''}
                </span>
              </span>
              <span className="firm-teammember__tags">
                {/*
                  The client-facing label is shown beside the internal role because
                  the two are different columns on purpose: what the firm calls a
                  person and what the client is told are not the same sentence.
                */}
                {m.clientVisible && m.clientRoleLabel && (
                  <Badge tone="neutral" size="xs">{pick(m.clientRoleLabelAr, m.clientRoleLabel)}</Badge>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PanelFrame>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

/* -------------------------------------------------------------- documents -- */

export function MatterDocumentsPanel({ matterId }: { matterId: string }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const state = usePanel(matterId, () => firmApi.matterDocuments(matterId));

  /*
    `responsive: 'card'` is what makes this table work on a phone: below the
    breakpoint the Table primitive renders each row as a labelled definition list
    rather than a horizontally scrolling grid that hides its own row identity.
  */
  const columns = useMemo<ReadonlyArray<Column<MatterDocumentRow>>>(() => [
    {
      key: 'title',
      header: t('panel.doc.name'),
      cardLabel: t('panel.doc.name'),
      responsive: 'card',
      cell: (d) => (
        <span className="firm-cellstack">
          <span className="firm-cellstack__main">{pick(d.titleAr, d.title)}</span>
          <span className="firm-cellstack__sub">{d.documentType.replace(/_/g, ' ')}</span>
        </span>
      ),
      compare: (a, b) => pick(a.titleAr, a.title).localeCompare(pick(b.titleAr, b.title)),
    },
    {
      key: 'privilege',
      header: t('cls.privilege'),
      cardLabel: t('cls.privilege'),
      responsive: 'card',
      width: '9rem',
      cell: (d) => d.privilegeClass === 'none'
        ? <span className="c-muted">{t('common.none')}</span>
        : <Badge tone="gold" size="xs" icon={<IconLock size={10} />}>{d.privilegeClass.replace(/_/g, ' ')}</Badge>,
      compare: (a, b) => a.privilegeClass.localeCompare(b.privilegeClass),
    },
    {
      key: 'visibility',
      header: t('panel.doc.visibility'),
      cardLabel: t('panel.doc.visibility'),
      responsive: 'card',
      width: '10rem',
      cell: (d) => (
        <Badge tone={d.clientVisibility === 'visible' ? 'lime' : 'neutral'} size="xs">
          {d.clientVisibility.replace(/_/g, ' ')}
        </Badge>
      ),
      compare: (a, b) => a.clientVisibility.localeCompare(b.clientVisibility),
    },
    {
      key: 'size',
      header: t('panel.doc.size'),
      cardLabel: t('panel.doc.size'),
      responsive: 'card',
      width: '6rem',
      numeric: true,
      cell: (d) => <span className="num c-secondary">{humanBytes(d.sizeBytes)}</span>,
      compare: (a, b) => a.sizeBytes - b.sizeBytes,
    },
    {
      key: 'created',
      header: t('common.updated'),
      cardLabel: t('common.updated'),
      responsive: 'card',
      width: '9rem',
      cell: (d) => <span className="num c-secondary">{fmt.date(d.createdAt)}</span>,
      compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
    },
  ], [t, fmt, pick]);

  return (
    <PanelFrame
      state={state}
      title={t('tab.documents')}
      emptyTitle={t('panel.doc.empty')}
      isEmpty={(d) => d.documents.length === 0}
    >
      {(d) => (
        <>
          {/*
            WITHHELD MATERIAL IS COUNTED, NOT ERASED. If the ring withheld a
            privileged document, the member is told how many and why — the same
            rule the matter's own fields follow. A silently shorter list is how a
            reader concludes the firm lost a file.
          */}
          {d.withheldCount > 0 && (
            <p className="firm-panel__note">
              <IconLock size={13} aria-hidden="true" />{' '}
              {t('panel.doc.withheld', { n: d.withheldCount, reason: d.privilege.reason.replace(/_/g, ' ') })}
            </p>
          )}
          <Table
            columns={columns}
            rows={d.documents}
            rowKey={(row) => row.id}
            label={t('tab.documents')}
            density="compact"
            striped={false}
            empty={t('panel.doc.empty')}
          />
        </>
      )}
    </PanelFrame>
  );
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* --------------------------------------------------------------- hearings -- */

export function MatterHearingsPanel({ matterId }: { matterId: string }) {
  const { t, lang, pick } = useI18n();
  const fmt = useFmt();
  const state = usePanel(matterId, () => firmApi.matterHearings(matterId));

  const row = (h: MatterHearingRow) => (
    <li className="firm-hearing" key={h.id}>
      <span className="firm-hearing__when">
        <b className="num">{fmt.date(h.scheduledAt)}</b>
        <span className="num c-secondary">{fmt.time(h.scheduledAt)}</span>
      </span>
      <span className="firm-hearing__main">
        <span className="firm-hearing__court">{pick(h.courtAr, h.court)}</span>
        <span className="firm-hearing__meta">
          {h.hearingType.replace(/_/g, ' ')}
          {pick(h.locationAr, h.location) ? ` · ${pick(h.locationAr, h.location)}` : ''}
          {h.isRemote && h.remotePlatform ? ` · ${h.remotePlatform}` : ''}
        </span>
        {(pick(h.instructionsAr, h.instructions) || '') && (
          <span className="firm-hearing__note">{pick(h.instructionsAr, h.instructions)}</span>
        )}
      </span>
      <span className="firm-hearing__tags">
        <StatusChip status={h.internalStatus} lang={lang === 'ar' ? 'ar' : 'en'} />
        {!h.clientVisible && <Badge tone="gold" size="xs">{t('panel.internalOnly')}</Badge>}
      </span>
    </li>
  );

  return (
    <PanelFrame
      state={state}
      title={t('tab.hearings')}
      emptyTitle={t('panel.hearings.empty')}
      isEmpty={(d) => d.count === 0}
    >
      {(d) => (
        <div className="firm-panel__sections">
          <section>
            <h3 className="firm-panel__subhead">{t('panel.hearings.upcoming')} · {d.upcoming.length}</h3>
            {d.upcoming.length === 0
              ? <p className="c-muted firm-panel__note">{t('panel.hearings.noneUpcoming')}</p>
              : <ul className="firm-list">{d.upcoming.map(row)}</ul>}
          </section>
          {d.past.length > 0 && (
            <section>
              <h3 className="firm-panel__subhead">{t('panel.hearings.past')} · {d.past.length}</h3>
              <ul className="firm-list firm-list--past">{d.past.map(row)}</ul>
            </section>
          )}
        </div>
      )}
    </PanelFrame>
  );
}

/* -------------------------------------------------------------- deadlines -- */

export function MatterDeadlinesPanel({ matterId }: { matterId: string }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const state = usePanel(matterId, () => firmApi.matterDeadlines(matterId));

  return (
    <PanelFrame
      state={state}
      title={t('tab.deadlines')}
      emptyTitle={t('panel.deadlines.empty')}
      isEmpty={(d) => d.deadlines.length === 0}
    >
      {(d) => (
        <ul className="firm-deadlines">
          {d.deadlines.map((x: MatterDeadlineRow) => (
            <li className="firm-deadline" key={x.id} data-overdue={x.overdue || undefined}>
              <span className="firm-deadline__due">
                <b className="num">{fmt.date(x.dueAt)}</b>
                <span className="c-secondary">{fmt.relative(x.dueAt)}</span>
              </span>
              <span className="firm-deadline__main">
                <span className="firm-deadline__title">{pick(x.titleAr, x.title)}</span>
                {(pick(x.descriptionAr, x.description) || '') && (
                  <span className="firm-deadline__text">{pick(x.descriptionAr, x.description)}</span>
                )}
                {/*
                  A statutory deadline states its rule. P0.4's appeal windows are
                  computed from one, and a deadline that cannot say which rule it
                  came from is a date somebody typed.
                */}
                {x.ruleCited && (
                  <span className="firm-deadline__rule">
                    {x.ruleCode ? `${x.ruleCode} · ` : ''}{x.ruleCited}
                    {x.ruleDays ? ` · ${x.ruleDays}d` : ''}
                  </span>
                )}
              </span>
              <span className="firm-deadline__tags">
                {x.overdue && <Badge tone="critical" size="xs">{t('panel.deadlines.overdue')}</Badge>}
                <Badge tone={x.kind === 'client_action' ? 'info' : 'neutral'} size="xs">
                  {x.kind.replace(/_/g, ' ')}
                </Badge>
                <Badge
                  tone={x.priority === 'urgent' || x.priority === 'high' ? 'high' : 'neutral'}
                  size="xs"
                >
                  {x.priority}
                </Badge>
                {!x.clientVisible && <Badge tone="gold" size="xs">{t('panel.internalOnly')}</Badge>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PanelFrame>
  );
}

export { usePanel, PanelFrame, PanelLoading };
export type { PanelState };
