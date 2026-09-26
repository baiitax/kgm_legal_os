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
  Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, IconLock, Modal,
  SelectField, Skeleton, StatusChip, Table, TextField, useFmt, useI18n, useToast,
  type Column,
} from '@kgm/ui';
import { useCan } from '../../auth/FirmSession.js';
import {
  firmApi, FirmApiError,
  type DocumentChainResponse, type MatterDeadlineRow, type MatterDocumentRow,
  type MatterHearingRow, type MatterTeamRow, type MatterTimelineRow,
} from '../../api/firm.js';

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
  state, title, icon, isEmpty, emptyTitle, emptyBody, action, children,
}: {
  state: PanelState<T> & { reload: () => void };
  title: string;
  icon?: React.ReactNode;
  isEmpty?: (data: T) => boolean;
  emptyTitle: string;
  emptyBody?: string;
  /**
   * A WRITE CONTROL FOR THE PANEL, in the card header.
   *
   * Every register on this workspace became writable in one phase (gap analysis III
   * §2.3–§2.5), and each of those writes belongs next to the list it changes rather
   * than in a toolbar somewhere else. The header slot is where a control that acts on
   * the whole list goes; a control that acts on ONE row stays on the row.
   *
   * It is rendered only when the caller says so — which is to say, only for a member
   * holding the permission code the ROUTE checks. The panel does not decide; it is told.
   */
  action?: React.ReactNode;
  children: (data: T) => React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Card variant="default" className="firm-panel">
      <CardHeader title={title} icon={icon} action={action} />
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

/**
 * THE TEAM — who answers for the file, and the one control that changes it.
 *
 * WHY THE ASSIGNMENT IS HERE AND NOT IN A SETTINGS SCREEN. Assigning a matter is the
 * second stage of intake and it happens while somebody is looking at the file: the
 * partner reads the team, sees nobody carrying it, and puts a name on it. A control
 * one screen away is a control that gets skipped, and a matter with no lead is the
 * defect this whole phase is about.
 *
 * THE PICKER IS FED BY THE SAME RESPONSE AS THE LIST. `assignable` arrives with the
 * team, resolved by the server at the same access level that will accept the write —
 * so the options a member sees and the assignments they may make cannot disagree.
 * When the member may not assign, the control is absent and `mayAssign` is false.
 *
 * `replaceLead` IS SHOWN, NOT HIDDEN. The database holds one active lead per role
 * (0058). Rather than let a member discover that as a refusal, the box appears exactly
 * when it applies — a lead role already held by somebody else — and taking the file
 * over is then one action instead of two.
 */
/** 0002's CHECK, in order. A seventh name here would be refused by the database. */
const MATTER_ROLE_CODES = [
  'lead_lawyer', 'lead_partner', 'associate', 'paralegal',
  'finance_contact', 'compliance_contact',
] as const;

export function MatterTeamPanel({ matterId }: { matterId: string }) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const state = usePanel(matterId, () => firmApi.matterTeam(matterId));
  const [staffId, setStaffId] = useState('');
  const [matterRole, setMatterRole] = useState('associate');
  const [replaceLead, setReplaceLead] = useState(false);
  const [busy, setBusy] = useState(false);

  const isLead = matterRole === 'lead_partner' || matterRole === 'lead_lawyer';

  async function assign(incumbent: { staffId: string; name: string } | null) {
    if (!staffId) return;
    setBusy(true);
    try {
      const out = await firmApi.assignMatterMember(matterId, {
        staffId, matterRole, replaceLead: replaceLead || (!!incumbent && isLead),
      });
      toast.success(
        t('panel.assign.done'),
        out.clientVisibleForced ? t('matter.hiddenRole') : undefined,
      );
      setStaffId('');
      setReplaceLead(false);
      state.reload();
    } catch (err) {
      const e = err as FirmApiError;
      toast.error(t('panel.assign.failed'), e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(member: MatterTeamRow) {
    setBusy(true);
    try {
      await firmApi.removeMatterMember(matterId, member.staffId, 'removed');
      toast.success(t('panel.remove.done'), pick(member.nameAr, member.name));
      state.reload();
    } catch (err) {
      toast.error(t('panel.remove.failed'), (err as FirmApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelFrame
      state={state}
      title={t('tab.team')}
      emptyTitle={t('panel.team.empty')}
      isEmpty={(d) => d.team.length === 0}
    >
      {(d) => {
        const options = d.assignable.filter((s) => !s.onThisMatter);
        const incumbent = isLead
          ? d.team.find((m) => m.matterRole === matterRole) ?? null
          : null;

        return (
          <>
            <ul className="firm-teamlists">
              {d.team.map((m: MatterTeamRow) => (
                <li className="firm-teammember" key={m.id}>
                  <span className="firm-teammember__avatar" aria-hidden="true">
                    {initials(pick(m.nameAr, m.name))}
                  </span>
                  <span className="firm-teammember__main">
                    <span className="firm-teammember__name">{pick(m.nameAr, m.name)}</span>
                    <span className="firm-teammember__meta">
                      {t(`role.matterRole.${m.matterRole}` as never)}
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
                    {!m.clientVisible && (
                      <Badge tone="gold" size="xs">{t('matter.hiddenRole.badge')}</Badge>
                    )}
                    {d.mayAssign && (
                      <Button
                        variant="ghost" size="xs" disabled={busy}
                        onClick={() => void remove(m)}
                      >
                        {t('panel.remove')}
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>

            {d.mayAssign && (
              <div className="firm-assign">
                <h3 className="firm-panel__subhead">{t('panel.assign')}</h3>
                <div className="firm-formgrid">
                  <SelectField
                    label={t('panel.assign.who')}
                    value={staffId}
                    onChange={(e) => setStaffId(e.target.value)}
                    placeholder={t('intake.lead.none')}
                    options={options.map((s) => ({
                      value: s.staffId,
                      label: `${pick(s.nameAr, s.name)} · ${pick(s.jobTitleAr, s.jobTitle) || s.role}`
                        + (s.activeMatters ? ` (${t('intake.lead.load', { n: String(s.activeMatters) })})` : ''),
                    }))}
                  />
                  <SelectField
                    label={t('panel.assign.role')}
                    value={matterRole}
                    onChange={(e) => { setMatterRole(e.target.value); setReplaceLead(false); }}
                    options={MATTER_ROLE_CODES.map((r) => ({
                      value: r,
                      label: t(`role.matterRole.${r}` as never),
                    }))}
                  />
                </div>

                {incumbent && incumbent.staffId !== staffId && (
                  <Checkbox
                    label={t('panel.assign.replace', { name: pick(incumbent.nameAr, incumbent.name) })}
                    hint={t('panel.assign.replace.hint')}
                    checked={replaceLead}
                    onChange={(e) => setReplaceLead(e.target.checked)}
                  />
                )}

                <Button
                  variant="primary" size="sm"
                  disabled={busy || !staffId || (!!incumbent && incumbent.staffId !== staffId && !replaceLead)}
                  onClick={() => void assign(incumbent)}
                >
                  {busy ? t('common.saving') : t('panel.assign.submit')}
                </Button>
              </div>
            )}
          </>
        );
      }}
    </PanelFrame>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

/* -------------------------------------------------------------- documents -- */

/**
 * THE DOCUMENT TYPES A FIRM MAY FILE — the same list the server enforces.
 *
 * `client_upload` is absent because it is the PORTAL's: a document the client uploaded is
 * not a document the firm filed, and offering it here would let the firm write a row that
 * claims the client sent it. `invoice` and `receipt` are absent for a different reason —
 * they will arrive with P2.3, written by the invoice path rather than by a person with a
 * file picker.
 */
const FILING_TYPES = [
  'firm_letter', 'court_document', 'signed_document', 'contract',
  'evidence', 'correspondence', 'identity', 'other',
] as const;

/** The provenance categories `documents_category_check` admits (and 0064 stopped faking). */
const FILING_CATEGORIES = ['from_firm', 'signed', 'court', 'financial', 'requested', 'uploaded'] as const;

/** The privilege classes 0054 defines. */
const FILING_PRIVILEGES = ['none', 'advice', 'work_product', 'litigation'] as const;

/**
 * A CLOSED VOCABULARY, RENDERED HONESTLY.
 *
 * The enum words are the server's and are kept verbatim in the value; the label is the
 * same word with its underscores replaced, which is what every other surface in this app
 * does with these values. Translating them properly is a dictionary pass of its own —
 * inventing a half-Arabic half-English set here would be worse than the consistent
 * English enum the rest of the screen already shows.
 */
const humanise = (v: string): string => v.replace(/_/g, ' ');

export function MatterDocumentsPanel({ matterId }: { matterId: string }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const toast = useToast();
  const { can } = useCan();
  const state = usePanel(matterId, () => firmApi.matterDocuments(matterId));

  /*
    THE PANEL'S OWN COPY OF THE LIST, so a filing can be shown without re-fetching the
    whole tab. The alternative — reload after every write — makes the panel flash its
    skeleton each time, which reads as though the upload reset the page.
  */
  const [rows, setRows] = useState<MatterDocumentRow[] | null>(null);
  const documents = rows ?? (state.status === 'ready' ? state.data.documents : []);
  const inRing = state.status === 'ready' ? state.data.privilege.inRing : false;

  const [filing, setFiling] = useState(false);
  const [versionOf, setVersionOf] = useState<MatterDocumentRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [chainFor, setChainFor] = useState<string | null>(null);
  const [chain, setChain] = useState<DocumentChainResponse | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<MatterDocumentRow | null>(null);

  const mayFile = can('documents.create');
  const mayRelease = can('documents.release');
  const mayArchive = can('documents.delete');
  const mayRead = can('documents.read');

  const merge = useCallback((filed: MatterDocumentRow) => {
    setRows((prev) => {
      const base = prev ?? (state.status === 'ready' ? state.data.documents : []);
      return [filed, ...base.filter((d) => d.id !== filed.id)];
    });
  }, [state]);

  /* ── the three writes, each guarded by its OWN permission ────────────────── */

  const file = useCallback(async (file: File, fields: {
    documentType: string; title?: string; category?: string;
    privilegeClass: string; release: boolean;
  }) => {
    const created = await firmApi.fileMatterDocument(matterId, file, fields);
    merge(created as unknown as MatterDocumentRow);
    toast.success(t('panel.doc.filed'), pick(created.titleAr, created.title));
    return created;
  }, [matterId, merge, toast, t, pick]);

  const fileVersion = useCallback(async (target: MatterDocumentRow, file: File, title?: string) => {
    const created = await firmApi.fileMatterDocumentVersion(matterId, target.id, file, { title });
    merge(created as unknown as MatterDocumentRow);
    toast.success(t('panel.doc.versioned'), `${pick(created.titleAr, created.title)} · v${created.version}`);
    return created;
  }, [matterId, merge, toast, t, pick]);

  const patch = useCallback(async (
    target: MatterDocumentRow,
    body: Parameters<typeof firmApi.updateMatterDocument>[2],
    done: string,
  ) => {
    setBusyId(target.id);
    try {
      await firmApi.updateMatterDocument(matterId, target.id, body);
      /* PATCH the local row rather than re-reading: the response is deliberately thin
         (it reports what changed, not the whole record), so the row is updated from the
         request the member just made and the server remains the authority on the next read. */
      setRows((prev) => {
        const base = prev ?? (state.status === 'ready' ? state.data.documents : []);
        return base.map((d) => (d.id === target.id ? { ...d, ...body } as MatterDocumentRow : d));
      });
      toast.success(done);
    } catch (err) {
      const e = err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable');
      /* The three refusals a member can actually hit, each with the reason it happened.
         A generic "failed" here would leave a partner guessing whether they lack the
         permission, the ring, or the document's state. */
      const why = e.code === 'privileged_needs_a_ground' ? t('panel.doc.privilegedLocked')
        : e.code === 'document_archived' ? t('panel.doc.archivedLocked')
          : e.code === 'forbidden' ? t('panel.doc.needsRelease')
            : e.message;
      toast.error(t('panel.doc.failed'), why);
    } finally {
      setBusyId(null);
    }
  }, [matterId, state, toast, t]);

  const openChain = useCallback(async (target: MatterDocumentRow) => {
    if (chainFor === target.id) { setChainFor(null); setChain(null); return; }
    setChainFor(target.id);
    setChain(null);
    try {
      setChain(await firmApi.matterDocumentVersions(matterId, target.id));
    } catch (err) {
      setChainFor(null);
      toast.error(t('panel.doc.failed'), (err as FirmApiError).message);
    }
  }, [chainFor, matterId, toast, t]);


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
          {/*
            THE TITLE IS THE DOOR TO THE BYTES. Reading it is `documents.read`; the panel
            does not offer the link to a member who does not hold it, and the route refuses
            them anyway — the two gates are the same rule stated twice on purpose (§50).
          */}
          {mayRead ? (
            <a
              className="firm-cellstack__main firm-doc__open"
              href={firmApi.matterDocumentContentUrl(matterId, d.id)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {pick(d.titleAr, d.title)}
            </a>
          ) : (
            <span className="firm-cellstack__main">{pick(d.titleAr, d.title)}</span>
          )}
          <span className="firm-cellstack__sub">
            {humanise(d.documentType)}
            {d.version > 1 && <> · <b className="num">v{d.version}</b></>}
            {' · '}{humanise(d.origin)}
          </span>
        </span>
      ),
      compare: (a, b) => pick(a.titleAr, a.title).localeCompare(pick(b.titleAr, b.title)),
    },
    {
      key: 'chain',
      header: t('panel.doc.chain'),
      cardLabel: t('panel.doc.chain'),
      responsive: 'card',
      width: '6rem',
      cell: (d) => (
        <span className="firm-doc__chain">
          <Badge tone="neutral" size="xs">
            <span className="num">v{d.version}</span>
          </Badge>
          <button
            type="button"
            className="firm-doc__link"
            onClick={() => { void openChain(d); }}
            aria-expanded={chainFor === d.id}
          >
            {chainFor === d.id ? t('common.hide') : t('common.show')}
          </button>
        </span>
      ),
      compare: (a, b) => a.version - b.version,
    },
    {
      key: 'actions',
      header: t('common.actions'),
      cardLabel: t('common.actions'),
      responsive: 'card',
      width: '13rem',
      /* No sorting: this is the column of verbs, and a sorted list of buttons is noise. */
      cell: (d) => (
        <span className="firm-doc__actions">
          {mayRead && (
            <a
              className="firm-doc__action"
              href={firmApi.matterDocumentContentUrl(matterId, d.id, 'attachment')}
            >
              {t('panel.doc.download')}
            </a>
          )}
          {/*
            RELEASE IS A PERMISSION, NOT A SETTING. Drawn only for a member who holds
            `documents.release` — and for a privileged document the server refuses the
            transition outright regardless of who asks, which is why the control is not
            merely hidden but absent for the whole privilege class.
          */}
          {mayRelease && d.privilegeClass === 'none' && d.status !== 'archived' && (
            <button
              type="button"
              className="firm-doc__action"
              disabled={busyId === d.id}
              onClick={() => { void patch(d,
                { clientVisibility: d.clientVisibility === 'visible' ? 'internal' : 'visible' },
                d.clientVisibility === 'visible' ? t('panel.doc.restricted') : t('panel.doc.released')); }}
            >
              {d.clientVisibility === 'visible' ? t('panel.doc.restrict') : t('panel.doc.release')}
            </button>
          )}
          {mayFile && d.status !== 'archived' && (
            <button
              type="button"
              className="firm-doc__action"
              disabled={busyId === d.id}
              onClick={() => setVersionOf(d)}
            >
              {t('panel.doc.newVersion')}
            </button>
          )}
          {mayArchive && d.status !== 'archived' && (
            <button
              type="button"
              className="firm-doc__action firm-doc__action--danger"
              disabled={busyId === d.id}
              onClick={() => setConfirmArchive(d)}
            >
              {t('panel.doc.archive')}
            </button>
          )}
          {d.status === 'archived' && (
            <Badge tone="neutral" size="xs">{t('panel.doc.archived')}</Badge>
          )}
        </span>
      ),
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
  ], [t, fmt, pick, matterId, mayRead, mayRelease, mayFile, mayArchive, busyId, chainFor, openChain, patch]);

  return (
    <>
      <PanelFrame
        state={state}
        title={t('tab.documents')}
        emptyTitle={t('panel.doc.empty')}
        isEmpty={(d) => (rows ?? d.documents).length === 0}
      >
        {(d) => (
          <>
            {/*
              THE FILE BUTTON IS THE POINT OF THIS PHASE. Until it existed the tab was a
              list with no way to put anything in it: the conflict waiver had no
              attachment, the engagement letter had no home, and "the current signed
              contract" was unanswerable. It is drawn only for a member who holds
              `documents.create`, and the route refuses anyone else.
            */}
            {mayFile && (
              <div className="firm-panel__bar">
                <Button size="sm" variant="primary" onClick={() => setFiling(true)}>
                  {t('panel.doc.file')}
                </Button>
                {!inRing && (
                  <span className="firm-panel__note firm-panel__note--inline">
                    <IconLock size={13} aria-hidden="true" />{' '}
                    {t('panel.doc.outsideRing', { reason: d.privilege.reason.replace(/_/g, ' ') })}
                  </span>
                )}
              </div>
            )}

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

            {/*
              THE CHAIN, IN PLACE. A version chain is a property of one document, so it
              belongs under its row rather than in a dialog that hides the list the reader
              was comparing it against. `withheldCount` appears here too: a member outside
              the ring sees that versions exist and not what is in them.
            */}
            {chainFor && (
              <div className="firm-doc__chainpanel">
                {chain === null && <Skeleton lines={2} />}
                {chain !== null && (
                  <>
                    <h4 className="firm-doc__chaintitle">
                      {t('panel.doc.chainTitle', { n: chain.count })}
                      {chain.withheldCount > 0 && (
                        <> · <span className="c-muted">{t('panel.doc.chainWithheld', { n: chain.withheldCount })}</span></>
                      )}
                    </h4>
                    <ol className="firm-doc__chainlist">
                      {chain.versions.map((v) => (
                        <li key={v.id} className={v.isHead ? 'is-head' : ''}>
                          <span className="num">v{v.version}</span>
                          <span className="firm-doc__chainname">{pick(v.titleAr, v.title)}</span>
                          <Badge tone={v.clientVisibility === 'visible' ? 'lime' : 'neutral'} size="xs">
                            {humanise(v.clientVisibility)}
                          </Badge>
                          <span className="num c-secondary">{fmt.date(v.createdAt)}</span>
                          {v.isHead && <Badge tone="lime" size="xs">{t('panel.doc.head')}</Badge>}
                          {v.privilegeClass !== 'none' && (
                            <Badge tone="gold" size="xs" icon={<IconLock size={10} />}>{humanise(v.privilegeClass)}</Badge>
                          )}
                        </li>
                      ))}
                    </ol>
                    {/*
                      THE QUESTION A READER ACTUALLY HAS: "which one did the client get?"
                      The chain answers it by showing each version's own visibility, and
                      this line names the oldest released one — because a released v1 that
                      the firm has since replaced is still what the client holds.
                    */}
                    <p className="firm-panel__note">
                      {chain.versions.some((v) => v.clientVisibility === 'visible')
                        ? t('panel.doc.chainClientHas')
                        : t('panel.doc.chainClientHasNone')}
                    </p>
                  </>
                )}
              </div>
            )}

            <Table
              columns={columns}
              rows={documents}
              rowKey={(row) => row.id}
              label={t('tab.documents')}
              density="compact"
              striped={false}
              empty={t('panel.doc.empty')}
            />
          </>
        )}
      </PanelFrame>

      {filing && (
        <FileDocumentDialog
          inRing={inRing}
          mayRelease={mayRelease}
          onClose={() => setFiling(false)}
          onFile={file}
        />
      )}

      {versionOf && (
        <NewVersionDialog
          document={versionOf}
          onClose={() => setVersionOf(null)}
          onFile={fileVersion}
        />
      )}

      {confirmArchive && (
        <Modal
          open
          onClose={() => setConfirmArchive(null)}
          title={t('panel.doc.archiveTitle')}
          description={t('panel.doc.archiveBody')}
          size="sm"
          footer={(
            <>
              <Button variant="ghost" onClick={() => setConfirmArchive(null)}>{t('common.cancel')}</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const target = confirmArchive;
                  setConfirmArchive(null);
                  void patch(target, { status: 'archived' }, t('panel.doc.archivedDone'));
                }}
              >
                {t('panel.doc.archive')}
              </Button>
            </>
          )}
        >
          <p className="firm-doc__confirm">{pick(confirmArchive.titleAr, confirmArchive.title)}</p>
          <p className="firm-panel__note">{t('panel.doc.archiveNever')}</p>
        </Modal>
      )}
    </>
  );
}

/* ─────────────────────────────────────────────────── the filing dialog -- */

/**
 * FILE A DOCUMENT.
 *
 * Two decisions live in this dialog and each is drawn only when the member can actually
 * make it: the privilege class (only inside the ring — outside it the server refuses a
 * privileged filing, so the control would be a trap) and "release to the client" (only
 * with `documents.release`, and never for privileged material, which the server will not
 * release to a client at all).
 */
function FileDocumentDialog({
  inRing, mayRelease, onClose, onFile,
}: {
  inRing: boolean;
  mayRelease: boolean;
  onClose: () => void;
  onFile: (file: File, fields: {
    documentType: string; title?: string; category?: string;
    privilegeClass: string; release: boolean;
  }) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState<string>('firm_letter');
  const [category, setCategory] = useState<string>('from_firm');
  const [privilegeClass, setPrivilegeClass] = useState<string>('none');
  const [title, setTitle] = useState('');
  const [release, setRelease] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!picked) { toast.error(t('panel.doc.noFile')); return; }
    setBusy(true);
    try {
      await onFile(picked, {
        documentType, category, privilegeClass,
        title: title.trim() || undefined,
        /* Release is a SECOND act on the server, not a flag on the filing — but the
           member's intent is one gesture, so it is one checkbox here. */
        release: mayRelease && privilegeClass === 'none' && release,
      });
      onClose();
    } catch (err) {
      toast.error(t('panel.doc.failed'), (err as FirmApiError).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('panel.doc.file')}
      description={t('panel.doc.fileBody')}
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!picked} onClick={() => { void submit(); }}>
            {t('panel.doc.fileAction')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        {/*
          A NATIVE FILE INPUT, VISIBLY LABELLED. A drag-and-drop zone that also has to
          work on a phone, in RTL, with a screen reader, is a component of its own; the
          button-and-filename pair is honest on every device and names the file it holds.
        */}
        <div className="firm-doc__pick">
          <input
            ref={input}
            type="file"
            className="firm-doc__fileinput"
            onChange={(e) => setPicked(e.target.files?.[0] ?? null)}
            aria-label={t('panel.doc.chooseFile')}
          />
          <Button size="sm" variant="secondary" onClick={() => input.current?.click()}>
            {t('panel.doc.chooseFile')}
          </Button>
          <span className="firm-doc__filename">
            {picked ? `${picked.name} · ${Math.max(1, Math.round(picked.size / 1024))} KB` : t('panel.doc.noChosen')}
          </span>
        </div>

        <SelectField
          label={t('panel.doc.type')}
          value={documentType}
          onChange={(e) => setDocumentType(e.target.value)}
          options={FILING_TYPES.map((v) => ({ value: v, label: humanise(v) }))}
        />
        <SelectField
          label={t('panel.doc.category')}
          hint={t('panel.doc.categoryHint')}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          options={FILING_CATEGORIES.map((v) => ({ value: v, label: humanise(v) }))}
        />
        <TextField
          label={t('panel.doc.titleField')}
          hint={t('panel.doc.titleHint')}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />

        {inRing ? (
          <SelectField
            label={t('panel.doc.privilege')}
            hint={t('panel.doc.privilegeHint')}
            value={privilegeClass}
            onChange={(e) => {
              setPrivilegeClass(e.target.value);
              /* A privileged document cannot be released to the client — the server
                 refuses it outright — so the checkbox is cleared rather than left
                 ticked and then refused. */
              if (e.target.value !== 'none') setRelease(false);
            }}
            options={FILING_PRIVILEGES.map((v) => ({ value: v, label: humanise(v) }))}
          />
        ) : (
          <p className="firm-panel__note">
            <IconLock size={13} aria-hidden="true" /> {t('panel.doc.privilegeOutsideRing')}
          </p>
        )}

        {mayRelease && privilegeClass === 'none' && (
          <Checkbox
            checked={release}
            onChange={(e) => setRelease(e.target.checked)}
            label={t('panel.doc.releaseNow')}
            hint={t('panel.doc.releaseNowHint')}
          />
        )}
      </div>
    </Modal>
  );
}

/** A NEW VERSION of an existing document (P2.6). */
function NewVersionDialog({
  document: target, onClose, onFile,
}: {
  document: MatterDocumentRow;
  onClose: () => void;
  onFile: (target: MatterDocumentRow, file: File, title?: string) => Promise<unknown>;
}) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!picked) { toast.error(t('panel.doc.noFile')); return; }
    setBusy(true);
    try {
      await onFile(target, picked);
      onClose();
    } catch (err) {
      toast.error(t('panel.doc.failed'), (err as FirmApiError).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('panel.doc.newVersion')}
      description={t('panel.doc.versionBody')}
      size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!picked} onClick={() => { void submit(); }}>
            {t('panel.doc.versionAction')}
          </Button>
        </>
      )}
    >
      <p className="firm-doc__confirm">
        <b>{pick(target.titleAr, target.title)}</b> · <span className="num">v{target.version}</span>
      </p>
      {/*
        SAID OUT LOUD, BECAUSE IT IS THE WHOLE POINT OF A CHAIN: the old bytes stay where
        they are. If the previous version was released, the client keeps it — publishing a
        replacement tells them nothing and changes nothing they hold. The member should
        know that before they upload, not after.
      */}
      <p className="firm-panel__note">{t('panel.doc.versionKeepsOld')}</p>
      <div className="firm-doc__pick">
        <input
          ref={input}
          type="file"
          className="firm-doc__fileinput"
          onChange={(e) => setPicked(e.target.files?.[0] ?? null)}
          aria-label={t('panel.doc.chooseFile')}
        />
        <Button size="sm" variant="secondary" onClick={() => input.current?.click()}>
          {t('panel.doc.chooseFile')}
        </Button>
        <span className="firm-doc__filename">
          {picked ? `${picked.name} · ${Math.max(1, Math.round(picked.size / 1024))} KB` : t('panel.doc.noChosen')}
        </span>
      </div>
    </Modal>
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
