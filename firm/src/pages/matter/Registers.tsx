/**
 * THE MATTER'S LEGAL AND FINANCIAL REGISTERS
 *
 * Four tabs that already had endpoints on the server and no screen in front of
 * them: Parties, Conflicts, Judgments and Billing. The endpoints are P0.1, P0.4
 * and P1 work — the conflict engine, the judgments register with its execution
 * gate, and the Rule 12 billing answer — and until now a member could not read
 * any of it without a database client.
 *
 * THE RULE THESE PANELS FOLLOW: SHOW THE VERDICT AND THE REASON, NEVER THE RAW
 * ROWS WITH THE READER LEFT TO WORK IT OUT.
 *
 *   · Billing returns `billable` as a PRIMARY field and a `blockers` list derived
 *     from the same predicate — so the panel says "not billable, and here is what
 *     is missing" rather than rendering two lists and hoping the reader notices
 *     there is no signed engagement letter.
 *   · The judgments register returns the execution outcome and, per judgment, the
 *     appeal window and whether the service that starts it can be evidenced. A
 *     judgment is only enforceable when it has been SERVED, and a screen that
 *     shows a judgment without saying whether the clock has started is a screen
 *     that produces a missed appeal.
 *   · The conflict register returns the state the engine reached and the hits
 *     behind it, with their dispositions. A conflict check whose hits are hidden
 *     is indistinguishable from a check that found nothing.
 */
import { useEffect, useState } from 'react';
import {
  Badge, Button, Card, CardBody, CardHeader, Checkbox, IconLock, Modal,
  SelectField, Table, TextArea, TextField, useFmt, useI18n, useToast, type Column,
} from '@kgm/ui';
import { useCan } from '../../auth/FirmSession.js';
import {
  firmApi, FirmApiError,
  type JudgmentRow, type MatterConflictHitRow, type MatterPartyRole, type MatterPartyRow,
  type PartyRow,
} from '../../api/firm.js';
import { PanelFrame, usePanel } from './Panels.js';

/* ---------------------------------------------------------------- parties -- */

export function MatterPartiesPanel({ matterId }: { matterId: string }) {
  const { t, pick } = useI18n();
  const state = usePanel(matterId, () => firmApi.matterParties(matterId));

  const { can } = useCan();
  const [adding, setAdding] = useState(false);

  return (
    <PanelFrame
      state={state}
      title={t('tab.parties')}
      emptyTitle={t('panel.parties.empty')}
      emptyBody={t('panel.parties.emptyBody')}
      isEmpty={(d) => d.parties.length === 0}
      action={can('matters.update') ? (
        <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
          {t('panel.parties.add')}
        </Button>
      ) : undefined}
    >
      {(d) => (
        <>
        {adding && (
          <AttachPartyDialog
            matterId={matterId}
            onClose={() => setAdding(false)}
            onChanged={state.reload}
          />
        )}
        <ul className="firm-parties">
          {d.parties.map((x: MatterPartyRow) => (
            <li className="firm-party" key={x.id}>
              <span className="firm-party__kind" data-kind={x.kind} aria-hidden="true">
                {x.kind === 'entity' ? '◧' : '●'}
              </span>
              <span className="firm-party__main">
                <span className="firm-party__name">{pick(x.nameAr, x.name)}</span>
                <span className="firm-party__meta">
                  {x.kind.replace(/_/g, ' ')}
                  {x.status !== 'active' ? ` · ${x.status}` : ''}
                  {x.note ? ` · ${x.note}` : ''}
                </span>
              </span>
              {/*
                The ROLE on this matter, not the party's identity: the same entity
                is the plaintiff in one file and a counterparty in another, and the
                conflict engine is built on exactly that distinction.
              */}
              <Badge tone={x.role === 'our_client' ? 'lime' : 'neutral'} size="xs">
                {x.role.replace(/_/g, ' ')}
              </Badge>
            </li>
          ))}
        </ul>
        </>
      )}
    </PanelFrame>
  );
}

/* -------------------------------------------------------------- conflicts -- */

export function MatterConflictsPanel({ matterId }: { matterId: string }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const state = usePanel(matterId, () => firmApi.matterConflicts(matterId));

  const { can } = useCan();
  const toast = useToast();
  const [hit, setHit] = useState<{ row: MatterConflictHitRow; mode: 'dispose' | 'waive' } | null>(null);
  const [concluding, setConcluding] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  /** Run a fresh check. The engine decides nothing — it produces findings to disposition. */
  async function runCheck() {
    setRunning(true);
    try {
      await firmApi.runConflictCheck(matterId, 'recheck');
      toast.success(t('panel.conflicts.ran'));
      state.reload();
    } catch (err) {
      toast.error(t('panel.conflicts.runFailed'), why(err, t));
    } finally {
      setRunning(false);
    }
  }

  return (
    <PanelFrame
      state={state}
      title={t('tab.conflicts')}
      emptyTitle={t('panel.conflicts.empty')}
      emptyBody={t('panel.conflicts.emptyBody')}
      isEmpty={(d) => d.count === 0}
      action={can('compliance.create') ? (
        <Button size="sm" variant="secondary" loading={running} onClick={() => { void runCheck(); }}>
          {t('panel.conflicts.run')}
        </Button>
      ) : undefined}
    >
      {(d) => (
        <div className="firm-panel__sections">
          {/*
            The engine's own verdict, first — the same value the matter's
            `conflictCleared` flag came from. A member reading the register before
            a Rule 8 decision needs the conclusion, not the table.
          */}
          <p className="firm-panel__verdict">
            <Badge
              tone={d.state === 'cleared' ? 'lime' : d.state === 'blocked' ? 'critical' : 'warning'}
              size="sm"
            >
              {String(d.state).replace(/_/g, ' ')}
            </Badge>
            {d.waivers.length > 0 && (
              <Badge tone="gold" size="sm">
                {t('panel.conflicts.waivers', { n: d.waivers.length })}
              </Badge>
            )}
          </p>

          {d.checks.map((check) => {
            const hits = check.hits ?? [];
            return (
              <Card key={String(check.id)} variant="solid" className="firm-conflictcheck">
                <CardHeader
                  title={String((check as Record<string, unknown>).checked_at ?? check.id).slice(0, 10)}
                  icon={<IconLock size={15} />}
                />
                <CardBody>
                  {hits.length === 0 ? (
                    <p className="c-muted">{t('panel.conflicts.noHits')}</p>
                  ) : (
                    <ul className="firm-hits">
                      {hits.map((hit: MatterConflictHitRow) => {
                        const h = hit as Record<string, unknown>;
                        return (
                          <li className="firm-hit" key={String(h.id)}>
                            <span className="firm-hit__sev" data-sev={String(h.severity ?? 'info')} aria-hidden="true" />
                            <span className="firm-hit__main">
                              <span className="firm-hit__name">
                                {pick(String(h.matched_name_ar ?? ''), String(h.matched_name ?? ''))}
                              </span>
                              <span className="firm-hit__meta">
                                {[h.match_type, h.matched_on, h.matter_number, h.client_name]
                                  .filter(Boolean).map(String).join(' · ')}
                              </span>
                              {Boolean(h.reason) && <span className="firm-hit__why">{String(h.reason)}</span>}
                            </span>
                            <span className="firm-hit__tags">
                              {/* A hit with no disposition is an OPEN risk, and it is
                                  rendered as one: the engine refuses to call the matter
                                  cleared while one exists. */}
                              <Badge
                                tone={h.disposition ? 'neutral' : 'high'}
                                size="xs"
                              >
                                {String(h.disposition ?? t('panel.conflicts.undispositioned')).replace(/_/g, ' ')}
                              </Badge>
                              {/*
                                THE TWO ACTS THAT CURE A FINDING, on the finding itself.

                                · Disposition — the firm decides whether this is the same
                                  party; the engine's finding is a question, not a verdict.
                                · Waiver — where the rule permits, the CLIENT's written
                                  consent cures a confirmed conflict. Only offered on a
                                  CONFIRMED hit, because consent to a conflict nobody has
                                  confirmed is consent to nothing.
                              */}
                              {can('compliance.review') && !h.disposition && (
                                <Button size="xs" variant="ghost"
                                  onClick={() => setHit({ row: hit, mode: 'dispose' })}>
                                  {t('panel.conflicts.disposition')}
                                </Button>
                              )}
                              {can('compliance.review') && h.disposition === 'same_party' && (
                                <Button size="xs" variant="ghost"
                                  onClick={() => setHit({ row: hit, mode: 'waive' })}>
                                  {t('panel.conflicts.waive')}
                                </Button>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardBody>
              </Card>
            );
          })}

          {hit && hit.mode === 'dispose' && (
            <DispositionDialog hit={hit.row} matterId={matterId}
              onClose={() => setHit(null)} onChanged={state.reload} />
          )}
          {hit && hit.mode === 'waive' && (
            <WaiverDialog hit={hit.row} onClose={() => setHit(null)} onChanged={state.reload} />
          )}
          {concluding && (
            <ConcludeDialog matterId={matterId} checkId={concluding}
              onClose={() => setConcluding(null)} onChanged={state.reload} />
          )}

          <p className="firm-panel__note c-muted">
            {t('panel.conflicts.generated', { when: fmt.date(new Date().toISOString()) })}
          </p>
          {/*
            CONCLUDING THE CHECK — the write that lets the matter leave conflict_check
            (Rule 11). Offered on the LATEST check only, and only to a reviewer: the
            register has to show who concluded it, and a concluded check may not be
            restated.
          */}
          {can('compliance.review') && d.checks.length > 0 && (
            <Button size="sm" variant="secondary"
              onClick={() => setConcluding(String(d.checks[d.checks.length - 1].id))}>
              {t('panel.conflicts.conclude')}
            </Button>
          )}
        </div>
      )}
    </PanelFrame>
  );
}

/* -------------------------------------------------------------- judgments -- */

export function MatterJudgmentsPanel({ matterId }: { matterId: string }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const { can } = useCan();
  const state = usePanel(matterId, () => firmApi.matterJudgments(matterId));
  const [recording, setRecording] = useState(false);
  const [act, setAct] = useState<{ row: JudgmentRow; kind: 'service' | 'appeal' | 'stay' } | null>(null);

  return (
    <PanelFrame
      state={state}
      title={t('tab.judgments')}
      emptyTitle={t('panel.judgments.empty')}
      emptyBody={t('panel.judgments.emptyBody')}
      isEmpty={(d) => d.judgments.length === 0}
      action={can('judgments.record') ? (
        <Button size="sm" variant="secondary" onClick={() => setRecording(true)}>
          {t('panel.judgments.record')}
        </Button>
      ) : undefined}
    >
      {(d) => (
        <div className="firm-panel__sections">
          {/*
            THE EXECUTION GATE, IN ONE LINE. `executionOutcome` is the server's
            own verdict on whether anything here may be enforced — computed from
            service, finality and any stay — so the panel reports it instead of
            asking the reader to infer it from four columns.
          */}
          <p className="firm-panel__verdict">
            <Badge
              tone={String(d.matterExecution?.canEnforce) === 'true' ? 'lime' : 'warning'}
              size="sm"
            >
              {String(d.matterExecution?.code ?? d.matterExecution?.status ?? '').replace(/_/g, ' ')}
            </Badge>
            {Boolean(d.matterExecution?.detail) && (
              <span className="c-secondary">{String(d.matterExecution.detail)}</span>
            )}
          </p>

          <ul className="firm-judgments">
            {(d.judgments as JudgmentRow[]).map((j) => (
              <li className="firm-judgment" key={j.id} data-operative={j.operative || undefined}>
                <span className="firm-judgment__main">
                  <span className="firm-judgment__title">
                    {pick(String(j.summaryAr ?? ''), String(j.summary ?? '')) || String(j.judgmentKind ?? j.id)}
                  </span>
                  <span className="firm-judgment__meta">
                    {[
                      j.judgmentKind, j.court, j.deedNumber, j.circuit,
                      j.pronouncedAt ? fmt.date(String(j.pronouncedAt)) : null,
                    ].filter(Boolean).map(String).join(' · ')}
                  </span>
                </span>
                <span className="firm-judgment__tags">
                  {Boolean(j.operative) && <Badge tone="gold" size="xs">{t('panel.judgments.operative')}</Badge>}
                  <Badge
                    tone={j.verdictFor === 'client' ? 'lime' : j.verdictFor === 'against' ? 'critical' : 'neutral'}
                    size="xs"
                  >
                    {String(j.verdictFor ?? '—').replace(/_/g, ' ')}
                  </Badge>
                  {j.appealDeadlineAt ? (
                    <Badge tone="info" size="xs">
                      {t('panel.judgments.appealBy')} {fmt.date(String(j.appealDeadlineAt))}
                    </Badge>
                  ) : (
                    <Badge tone="neutral" size="xs">{t('panel.judgments.noAppealWindow')}</Badge>
                  )}
                  {Boolean(j.stayInForce) && (
                    <Badge tone="warning" size="xs">{t('panel.judgments.stayedBadge')}</Badge>
                  )}
                  {/*
                    THE THREE ACTS ON A JUDGMENT, each behind its own code:

                      · Service — `judgments.serve`. The act that STARTS the appeal clock,
                        which is why it is separable from recording the judgment: a
                        judgment pronounced is not a judgment the other side knows about.
                      · Appeal  — `judgments.manage`. Filing is a decision, and the
                        register records which kind (appeal / cassation / rehearing) and
                        whether a stay was requested with it.
                      · Stay    — `judgments.manage`. The one fact that turns an
                        enforceable judgment into one the firm may not collect on; the
                        execution gate reads it.
                  */}
                  {can('judgments.serve') && (
                    <Button size="xs" variant="ghost"
                      onClick={() => setAct({ row: j, kind: 'service' })}>
                      {t('panel.judgments.service')}
                    </Button>
                  )}
                  {can('judgments.manage') && (
                    <Button size="xs" variant="ghost"
                      onClick={() => setAct({ row: j, kind: 'appeal' })}>
                      {t('panel.judgments.appeal')}
                    </Button>
                  )}
                  {can('judgments.manage') && (
                    <Button size="xs" variant="ghost"
                      onClick={() => setAct({ row: j, kind: 'stay' })}>
                      {j.stayInForce ? t('panel.judgments.liftStay') : t('panel.judgments.stay')}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>

          {d.services.length > 0 && (
            <section>
              <h3 className="firm-panel__subhead">{t('panel.judgments.service')}</h3>
              <ul className="firm-list">
                {d.services.map((s) => (
                  <li className="firm-service" key={String(s.id)}>
                    <span className="firm-service__main">
                      <span>{String(s.method ?? '').replace(/_/g, ' ')}</span>
                      <span className="firm-service__meta">
                        {[s.servedOnName, s.noticeKind, s.servedAt ? fmt.date(String(s.servedAt)) : null]
                          .filter(Boolean).map(String).join(' · ')}
                      </span>
                    </span>
                    {/*
                      Evidence is the thing that decides whether the clock runs.
                      A service that happened and cannot be evidenced is reported
                      as exactly that, not as a completed step.
                    */}
                    <Badge tone={s.evidenced ? 'lime' : 'high'} size="xs">
                      {s.evidenced ? t('panel.judgments.evidenced') : t('panel.judgments.unevidenced')}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {recording && (
            <RecordJudgmentDialog matterId={matterId}
              onClose={() => setRecording(false)} onChanged={state.reload} />
          )}
          {act && act.kind === 'service' && (
            <ServiceDialog judgment={act.row}
              onClose={() => setAct(null)} onChanged={state.reload} />
          )}
          {act && act.kind === 'appeal' && (
            <AppealDialog judgment={act.row}
              onClose={() => setAct(null)} onChanged={state.reload} />
          )}
          {act && act.kind === 'stay' && (
            <StayDialog judgment={act.row}
              onClose={() => setAct(null)} onChanged={state.reload} />
          )}
        </div>
      )}
    </PanelFrame>
  );
}

/* ---------------------------------------------------------------- billing -- */

interface TimeRow { id: string; date: string; minutes: number; narrative: string; staffName: string; amount: number; status: string; billable: boolean; [k: string]: unknown }
interface ExpenseRow { id: string; incurredOn: string; category: string; description: string; total: number; status: string; [k: string]: unknown }

export function MatterBillingPanel({ matterId }: { matterId: string }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const state = usePanel(matterId, () => firmApi.matterBilling(matterId));

  const money = (n: number) => fmt.money(n, 'SAR');

  const timeColumns: ReadonlyArray<Column<TimeRow>> = [
    { key: 'date', header: t('common.updated'), responsive: 'card', cardLabel: t('common.updated'), width: '7rem', cell: (r) => <span className="num">{fmt.date(r.date)}</span>, compare: (a, b) => a.date.localeCompare(b.date) },
    { key: 'who', header: t('panel.billing.who'), responsive: 'card', cardLabel: t('panel.billing.who'), cell: (r) => r.staffName, compare: (a, b) => a.staffName.localeCompare(b.staffName) },
    { key: 'narrative', header: t('panel.billing.narrative'), responsive: 'card', cardLabel: t('panel.billing.narrative'), cell: (r) => pick(null, r.narrative), compare: (a, b) => a.narrative.localeCompare(b.narrative) },
    { key: 'minutes', header: t('panel.billing.minutes'), responsive: 'card', cardLabel: t('panel.billing.minutes'), width: '6rem', numeric: true, cell: (r) => <span className="num">{r.minutes}</span>, compare: (a, b) => a.minutes - b.minutes },
    { key: 'amount', header: t('panel.billing.amount'), responsive: 'card', cardLabel: t('panel.billing.amount'), width: '8rem', numeric: true, cell: (r) => <span className="num">{money(Number(r.amount))}</span>, compare: (a, b) => Number(a.amount) - Number(b.amount) },
    { key: 'status', header: t('panel.billing.status'), responsive: 'card', cardLabel: t('panel.billing.status'), width: '8rem', cell: (r) => <Badge tone={r.status === 'approved' ? 'lime' : 'neutral'} size="xs">{String(r.status)}</Badge>, compare: (a, b) => a.status.localeCompare(b.status) },
  ];

  const expenseColumns: ReadonlyArray<Column<ExpenseRow>> = [
    { key: 'date', header: t('common.updated'), responsive: 'card', cardLabel: t('common.updated'), width: '7rem', cell: (r) => <span className="num">{fmt.date(r.incurredOn)}</span>, compare: (a, b) => a.incurredOn.localeCompare(b.incurredOn) },
    { key: 'description', header: t('panel.billing.description'), responsive: 'card', cardLabel: t('panel.billing.description'), cell: (r) => r.description, compare: (a, b) => a.description.localeCompare(b.description) },
    { key: 'category', header: t('panel.billing.category'), responsive: 'card', cardLabel: t('panel.billing.category'), width: '9rem', cell: (r) => <Badge tone="neutral" size="xs">{String(r.category)}</Badge>, compare: (a, b) => a.category.localeCompare(b.category) },
    { key: 'total', header: t('panel.billing.amount'), responsive: 'card', cardLabel: t('panel.billing.amount'), width: '8rem', numeric: true, cell: (r) => <span className="num">{money(Number(r.total))}</span>, compare: (a, b) => Number(a.total) - Number(b.total) },
    { key: 'status', header: t('panel.billing.status'), responsive: 'card', cardLabel: t('panel.billing.status'), width: '8rem', cell: (r) => <Badge tone={r.status === 'approved' ? 'lime' : 'neutral'} size="xs">{String(r.status)}</Badge>, compare: (a, b) => a.status.localeCompare(b.status) },
  ];

  return (
    <PanelFrame state={state} title={t('tab.billing')} emptyTitle={t('panel.billing.empty')}
      isEmpty={(d) => !d.terms && d.time.length === 0 && d.expenses.length === 0}>
      {(d) => (
        <div className="firm-panel__sections">
          {/* The Rule 12 answer, first: can this be billed at all, and if not, why. */}
          <Card variant={d.billable ? 'default' : 'solid'} className="firm-billinghead">
            <CardBody>
              <div className="firm-billinghead__row">
                <Badge tone={d.billable ? 'lime' : 'warning'} size="sm">
                  {d.billable ? t('panel.billing.billable') : t('panel.billing.notBillable')}
                </Badge>
                {d.blockers.map((b) => (
                  <Badge key={b} tone="high" size="xs">{b.replace(/_/g, ' ')}</Badge>
                ))}
              </div>
              <dl className="firm-deflist firm-deflist--inline">
                <div className="firm-deflist__row">
                  <dt>{t('panel.billing.basis')}</dt>
                  <dd>{d.terms ? d.terms.basis.replace(/_/g, ' ') : <span className="c-muted">{t('common.none')}</span>}</dd>
                </div>
                <div className="firm-deflist__row">
                  <dt>{t('panel.billing.fee')}</dt>
                  <dd className="num">{d.terms?.feeAmountSar != null ? money(d.terms.feeAmountSar) : <span className="c-muted">—</span>}</dd>
                </div>
                <div className="firm-deflist__row">
                  <dt>{t('panel.billing.cap')}</dt>
                  <dd className="num">{d.terms?.capAmountSar != null ? money(d.terms.capAmountSar) : <span className="c-muted">—</span>}</dd>
                </div>
                <div className="firm-deflist__row">
                  <dt>{t('panel.billing.discount')}</dt>
                  <dd className="num">{d.terms ? `${d.terms.agreedDiscountPct}%` : <span className="c-muted">—</span>}</dd>
                </div>
                <div className="firm-deflist__row">
                  <dt>{t('panel.billing.unbilled')}</dt>
                  <dd className="num">{money(d.unbilled.total)}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <section>
            <h3 className="firm-panel__subhead">{t('panel.billing.time')} · {d.time.length}</h3>
            {d.time.length === 0
              ? <p className="c-muted firm-panel__note">{t('common.none')}</p>
              : <Table columns={timeColumns} rows={d.time as unknown as TimeRow[]} rowKey={(r) => r.id} label={t('panel.billing.time')} density="compact" />}
          </section>

          <section>
            <h3 className="firm-panel__subhead">{t('panel.billing.expenses')} · {d.expenses.length}</h3>
            {d.expenses.length === 0
              ? <p className="c-muted firm-panel__note">{t('common.none')}</p>
              : <Table columns={expenseColumns} rows={d.expenses as unknown as ExpenseRow[]} rowKey={(r) => r.id} label={t('panel.billing.expenses')} density="compact" />}
          </section>
        </div>
      )}
    </PanelFrame>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   THE REGISTERS BECOME WRITABLE · gap analysis III §2.3–§2.5
   ═══════════════════════════════════════════════════════════════════════════════

   Until this block, all three panels below were read-only: a member could see the
   parties, the conflict findings and the judgments and could not record any of them.
   Every route behind these controls has existed since P0.1/P0.4 and was reachable only
   with curl, which meant the firm's own registers were being filled in somewhere else.

   TWO RULES GOVERN EVERY DIALOG HERE

     1. THE CONTROL IS SHOWN ONLY WHERE THE ROUTE WOULD ALLOW IT — the same permission
        code the server checks, read through `useCan()`. §50 in one line: the screen may
        hide a control for a member who lacks the code, but it can never grant one.

     2. A REFUSAL IS RENDERED AS ITSELF. The conflict engine refuses a disposition on a
        finding that is already dispositioned (`already_dispositioned`), a confirmation
        without a severity (`validation_failed`), a waiver whose consent predates the
        finding. Each of those arrives with a code and each is shown, because a member
        who is told only "failed" will ask a colleague instead of reading the register.
   ═══════════════════════════════════════════════════════════════════════════════ */

/** The refusal, said in the screen's own words, with the server's message as a fallback. */
function why(err: unknown, t: (k: string) => string): string {
  const code = err instanceof FirmApiError ? err.code : 'network_error';
  const known: Record<string, string> = {
    already_dispositioned: t('panel.conflicts.alreadyDispositioned'),
    conflict_gate: t('panel.conflicts.gateHolds'),
    not_a_confirmed_conflict: t('panel.conflicts.notConfirmed'),
    no_affected_party: t('panel.conflicts.noAffectedParty'),
    written_consent_required: t('panel.conflicts.consentRequired'),
    permission_denied: t('panel.err.permission'),
    validation_failed: t('panel.err.validation'),
  };
  return known[code] ?? (err instanceof Error ? err.message : t('panel.err.other'));
}

/* ────────────────────────────────────────────────── parties: put one on the file ── */

export function AttachPartyDialog({
  matterId, onClose, onChanged,
}: {
  matterId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [parties, setParties] = useState<PartyRow[] | null>(null);
  const [partyId, setPartyId] = useState('');
  const [kind, setKind] = useState('company');
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [role, setRole] = useState<MatterPartyRole>('counterparty');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'existing') return;
    let alive = true;
    firmApi.parties()
      .then((r) => { if (alive) setParties(r.parties); })
      .catch(() => { if (alive) setParties([]); });
    return () => { alive = false; };
  }, [mode]);

  async function submit() {
    setBusy(true);
    try {
      if (mode === 'new') {
        /* ONE CALL, NOT TWO. `createIfMissing` exists for exactly this: intake knows the
           other side as a name, and a failed second call would leave a party in the
           register with no matter attached to it. The route validates the uuid shape
           before consulting it, so a fresh one is supplied here. */
        await firmApi.attachParty(matterId, {
          partyId: crypto.randomUUID(),
          role,
          note: note.trim() || null,
          createIfMissing: { kind: kind as 'company', name: name.trim(), nameAr: nameAr.trim() || null },
        });
      } else {
        await firmApi.attachParty(matterId, {
          partyId, role, note: note.trim() || null,
        });
      }
      toast.success(t('panel.parties.added'));
      onChanged();
      onClose();
    } catch (err) {
      toast.error(t('panel.parties.addFailed'), why(err, t));
      setBusy(false);
    }
  }

  const ready = role && (mode === 'new' ? name.trim().length >= 2 : partyId.length > 0);

  return (
    <Modal
      open
      onClose={onClose}
      title={t('panel.parties.add')}
      description={t('panel.parties.addBody')}
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => { void submit(); }}>
            {t('panel.parties.addAction')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <SelectField
          label={t('panel.parties.source')}
          value={mode}
          onChange={(e) => setMode(e.target.value as 'existing' | 'new')}
          options={[
            { value: 'new', label: t('panel.parties.sourceNew') },
            { value: 'existing', label: t('panel.parties.sourceExisting') },
          ]}
        />

        {mode === 'new' ? (
          <>
            <TextField
              label={t('panel.parties.name')}
              value={name}
              maxLength={300}
              onChange={(e) => setName(e.target.value)}
            />
            <TextField
              label={t('panel.parties.nameAr')}
              value={nameAr}
              maxLength={300}
              onChange={(e) => setNameAr(e.target.value)}
            />
            <SelectField
              label={t('panel.parties.kind')}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              options={['individual', 'company', 'government', 'nonprofit', 'other']
                .map((k) => ({ value: k, label: t(`party.kind.${k}`) }))}
            />
          </>
        ) : (
          <SelectField
            label={t('panel.parties.existing')}
            hint={parties === null ? t('common.loading') : undefined}
            value={partyId}
            disabled={parties === null}
            onChange={(e) => setPartyId(e.target.value)}
            options={[
              { value: '', label: t('panel.parties.pick') },
              ...(parties ?? []).map((p) => ({
                value: p.id,
                label: `${pick(p.nameAr, p.name)} · ${t(`party.kind.${p.kind}`)}`,
              })),
            ]}
          />
        )}

        <SelectField
          label={t('panel.parties.role')}
          hint={t('panel.parties.roleHint')}
          value={role}
          onChange={(e) => setRole(e.target.value as MatterPartyRole)}
          options={(['counterparty', 'adverse_party', 'related_entity', 'guarantor', 'witness', 'expert', 'interested_party', 'other'] as MatterPartyRole[])
            .map((r) => ({ value: r, label: t(`party.role.${r}`) }))}
        />
        <TextField
          label={t('panel.parties.note')}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
        />
        {/*
          THE CONSEQUENCE, STATED BEFORE THE ACT. Adding a counterparty can put the
          matter back into conflict_check — the server recomputes the state and says so
          in its response — and a member who is not told this will report the matter as
          "broken" the first time it happens.
        */}
        <p className="firm-panel__note c-muted">{t('panel.parties.consequence')}</p>
      </div>
    </Modal>
  );
}

/* ─────────────────────────────────────────────────────── conflicts: acting on it ── */

export function DispositionDialog({
  hit, matterId, onClose, onChanged,
}: {
  hit: MatterConflictHitRow;
  matterId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const h = hit as Record<string, unknown>;
  const [disposition, setDisposition] = useState<'different_party' | 'same_party'>('different_party');
  const [severity, setSeverity] = useState<'actual' | 'potential' | 'none'>('actual');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await firmApi.dispositionHit(String(h.id), {
        disposition,
        /* A ruled-out finding carries NO severity — the server refuses one, because
           severity is a judgement about an identity that was confirmed. Confirming a
           finding requires BOTH a severity and the affected party, and the affected
           party is the one whose written consent the rule will later require. */
        severity: disposition === 'same_party' ? severity : null,
        affectedPartyId: disposition === 'same_party'
          ? String(h.matched_party_id ?? h.party_id ?? '') || null
          : null,
        reason: reason.trim(),
      });
      toast.success(t('panel.conflicts.disposed'));
      onChanged();
      onClose();
    } catch (err) {
      toast.error(t('panel.conflicts.disposeFailed'), why(err, t));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('panel.conflicts.disposition')}
      description={String(h.matched_name ?? h.matched_name_ar ?? '')}
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={reason.trim().length < 5} onClick={() => { void submit(); }}>
            {t('panel.conflicts.dispose')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <SelectField
          label={t('panel.conflicts.verdict')}
          hint={t('panel.conflicts.verdictHint')}
          value={disposition}
          onChange={(e) => setDisposition(e.target.value as 'different_party' | 'same_party')}
          options={[
            { value: 'different_party', label: t('panel.conflicts.different') },
            { value: 'same_party', label: t('panel.conflicts.same') },
          ]}
        />
        {disposition === 'same_party' && (
          <SelectField
            label={t('panel.conflicts.severity')}
            hint={t('panel.conflicts.severityHint')}
            value={severity}
            onChange={(e) => setSeverity(e.target.value as 'actual' | 'potential' | 'none')}
            options={[
              { value: 'actual', label: t('panel.conflicts.actual') },
              { value: 'potential', label: t('panel.conflicts.potential') },
              { value: 'none', label: t('panel.conflicts.none') },
            ]}
          />
        )}
        <TextArea
          label={t('panel.conflicts.reason')}
          value={reason}
          rows={2}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
        {Number(matterId.length) > 0 && <input type="hidden" value={matterId} readOnly />}
      </div>
    </Modal>
  );
}

export function WaiverDialog({
  hit, onClose, onChanged,
}: {
  hit: MatterConflictHitRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const h = hit as Record<string, unknown>;
  const [signedOn, setSignedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [scope, setScope] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await firmApi.waiveHit(String(h.id), {
        consentSignedOn: signedOn,
        scope: scope.trim(),
        consentReference: reference.trim() || null,
      });
      toast.success(t('panel.conflicts.waived'));
      onChanged();
      onClose();
    } catch (err) {
      toast.error(t('panel.conflicts.waiveFailed'), why(err, t));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('panel.conflicts.waive')}
      description={t('panel.conflicts.waiveBody')}
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={scope.trim().length < 10} onClick={() => { void submit(); }}>
            {t('panel.conflicts.waiveAction')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        {/*
          THE CONSENT'S OWN DATE, NOT TODAY'S. A waiver dated the day it was typed is
          not evidence of anything: what the register has to show is when the client
          signed, because Rule 8's windows and the "was it informed" question both turn
          on it.
        */}
        <TextField
          label={t('panel.conflicts.signedOn')}
          hint={t('panel.conflicts.signedOnHint')}
          type="date"
          value={signedOn}
          onChange={(e) => setSignedOn(e.target.value)}
        />
        <TextArea
          label={t('panel.conflicts.scope')}
          hint={t('panel.conflicts.scopeHint')}
          value={scope}
          rows={3}
          maxLength={1000}
          onChange={(e) => setScope(e.target.value)}
        />
        <TextField
          label={t('panel.conflicts.reference')}
          hint={t('panel.conflicts.referenceHint')}
          value={reference}
          maxLength={200}
          onChange={(e) => setReference(e.target.value)}
        />
      </div>
    </Modal>
  );
}

export function ConcludeDialog({
  matterId, checkId, onClose, onChanged,
}: {
  matterId: string;
  checkId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [decision, setDecision] = useState<'clear' | 'not_accepted' | 'abandoned'>('clear');
  const [conclusion, setConclusion] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await firmApi.concludeConflicts(matterId, { checkId, decision, conclusion: conclusion.trim() });
      toast.success(t('panel.conflicts.concluded'));
      onChanged();
      onClose();
    } catch (err) {
      toast.error(t('panel.conflicts.concludeFailed'), why(err, t));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('panel.conflicts.conclude')}
      description={t('panel.conflicts.concludeBody')}
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={conclusion.trim().length < 5} onClick={() => { void submit(); }}>
            {t('panel.conflicts.concludeAction')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <SelectField
          label={t('panel.conflicts.decision')}
          value={decision}
          onChange={(e) => setDecision(e.target.value as 'clear' | 'not_accepted' | 'abandoned')}
          options={[
            { value: 'clear', label: t('panel.conflicts.clear') },
            { value: 'not_accepted', label: t('panel.conflicts.notAccepted') },
            { value: 'abandoned', label: t('panel.conflicts.abandoned') },
          ]}
        />
        <TextArea
          label={t('panel.conflicts.conclusionText')}
          value={conclusion}
          rows={3}
          maxLength={1000}
          onChange={(e) => setConclusion(e.target.value)}
        />
        {/* A concluded check may not be restated — the record has to show the decision,
            not the latest wording of it. Said before the act, not after the refusal. */}
        <p className="firm-panel__note c-muted">{t('panel.conflicts.concludeNote')}</p>
      </div>
    </Modal>
  );
}

/* ──────────────────────────────────────────── judgments: the register's own writes ── */

/**
 * RECORD A JUDGMENT.
 *
 * The register's five routes were all unreachable: a firm could not record the decision
 * that starts every clock in the file. The field that matters most is `pronouncedAt`,
 * because the appeal window (Civil Procedure Law Art. 187 — thirty days, ten for an
 * urgent matter) is computed FROM it, and a judgment entered with the wrong date is a
 * missed appeal with a correct-looking system behind it.
 */
export function RecordJudgmentDialog({
  matterId, onClose, onChanged,
}: {
  matterId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [deedNumber, setDeedNumber] = useState('');
  const [court, setCourt] = useState('');
  const [courtAr, setCourtAr] = useState('');
  const [kind, setKind] = useState<'first_instance' | 'appeal' | 'cassation'>('first_instance');
  const [pronouncedOn, setPronouncedOn] = useState(today);
  const [urgent, setUrgent] = useState(false);
  const [verdictFor, setVerdictFor] = useState<'client' | 'opponent' | 'split' | 'procedural'>('client');
  const [reliefKind, setReliefKind] = useState<'monetary' | 'non_monetary' | 'none'>('none');
  const [amount, setAmount] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await firmApi.recordJudgment(matterId, {
        deedNumber: deedNumber.trim(),
        court: court.trim(),
        courtAr: courtAr.trim() || court.trim(),
        judgmentKind: kind,
        /* The wire wants a datetime; the screen asks for the day it was pronounced,
           because that is the fact the register holds. Midnight UTC is the honest
           representation of "on this date" — and the appeal window is computed in days. */
        pronouncedAt: new Date(`${pronouncedOn}T00:00:00.000Z`).toISOString(),
        urgent,
        verdictFor,
        reliefKind,
        amountSar: reliefKind === 'monetary' && amount.trim() ? Number(amount) : null,
        summary: summary.trim() || null,
      });
      toast.success(t('panel.judgments.recorded'));
      onChanged();
      onClose();
    } catch (err) {
      toast.error(t('panel.judgments.recordFailed'), why(err, t));
      setBusy(false);
    }
  }

  const ready = deedNumber.trim().length > 0 && court.trim().length >= 2;

  return (
    <Modal
      open
      onClose={onClose}
      title={t('panel.judgments.record')}
      description={t('panel.judgments.recordBody')}
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => { void submit(); }}>
            {t('panel.judgments.recordAction')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField label={t('panel.judgments.deed')} value={deedNumber} maxLength={60}
          onChange={(e) => setDeedNumber(e.target.value)} />
        <TextField label={t('panel.judgments.court')} value={court} maxLength={200}
          onChange={(e) => setCourt(e.target.value)} />
        <TextField label={t('panel.judgments.courtAr')} value={courtAr} maxLength={200}
          onChange={(e) => setCourtAr(e.target.value)} />
        <SelectField
          label={t('panel.judgments.kind')}
          value={kind}
          onChange={(e) => setKind(e.target.value as 'first_instance')}
          options={[
            { value: 'first_instance', label: t('panel.judgments.firstInstance') },
            { value: 'appeal', label: t('panel.judgments.appealKind') },
            { value: 'cassation', label: t('panel.judgments.cassation') },
          ]}
        />
        <TextField
          label={t('panel.judgments.pronounced')}
          hint={t('panel.judgments.pronouncedHint')}
          type="date"
          value={pronouncedOn}
          onChange={(e) => setPronouncedOn(e.target.value)}
        />
        <SelectField
          label={t('panel.judgments.verdictFor')}
          value={verdictFor}
          onChange={(e) => setVerdictFor(e.target.value as 'client')}
          options={['client', 'opponent', 'split', 'procedural']
            .map((v) => ({ value: v, label: t(`panel.judgments.for.${v}`) }))}
        />
        <SelectField
          label={t('panel.judgments.relief')}
          value={reliefKind}
          onChange={(e) => setReliefKind(e.target.value as 'none')}
          options={['none', 'monetary', 'non_monetary']
            .map((v) => ({ value: v, label: t(`panel.judgments.relief.${v}`) }))}
        />
        {reliefKind === 'monetary' && (
          <TextField label={t('panel.judgments.amount')} inputMode="decimal" value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
        )}
        <TextArea label={t('panel.judgments.summary')} value={summary} rows={3} maxLength={4000}
          onChange={(e) => setSummary(e.target.value)} />
        {urgent && (
          <p className="firm-panel__note c-muted">{t('panel.judgments.urgentNote')}</p>
        )}
        <Checkbox checked={urgent} onChange={(e) => setUrgent(e.target.checked)}
          label={t('panel.judgments.urgent')} hint={t('panel.judgments.urgentHint')} />
      </div>
    </Modal>
  );
}

/**
 * SERVICE OF PROCESS — the act that starts the appeal clock.
 *
 * The register renders `evidenced` per service, because a service that happened and
 * cannot be evidenced is the exact situation in which a firm discovers, too late, that
 * it cannot prove the date its appeal ran from. The dialog therefore asks for the proof
 * by reference, and the screen makes it optional only because a service in court is
 * often evidenced by the minutes rather than by a document number.
 */
export function ServiceDialog({
  judgment, onClose, onChanged,
}: {
  judgment: JudgmentRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [method, setMethod] = useState('in_court');
  const [outcome, setOutcome] = useState('served');
  const [servedOnKind, setServedOnKind] = useState('opponent');
  const [servedOnName, setServedOnName] = useState('');
  const [servedOn, setServedOn] = useState(new Date().toISOString().slice(0, 10));
  const [proofReference, setProofReference] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await firmApi.recordJudgmentService(String(judgment.id), {
        noticeKind: 'judgment',
        method,
        outcome,
        servedOnKind,
        servedOnName: servedOnName.trim() || null,
        servedAt: outcome === 'served' ? new Date(`${servedOn}T00:00:00.000Z`).toISOString() : null,
        proofReference: proofReference.trim() || null,
      });
      toast.success(t('panel.judgments.served'));
      onChanged();
      onClose();
    } catch (err) {
      toast.error(t('panel.judgments.serviceFailed'), why(err, t));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('panel.judgments.service')}
      description={t('panel.judgments.serviceBody')}
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={() => { void submit(); }}>
            {t('panel.judgments.serviceAction')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <SelectField label={t('panel.judgments.method')} value={method}
          onChange={(e) => setMethod(e.target.value)}
          options={['in_court', 'personal', 'agent', 'registered_mail', 'electronic', 'publication', 'other']
            .map((m) => ({ value: m, label: t(`panel.judgments.method.${m}`) }))} />
        <SelectField label={t('panel.judgments.outcome')} value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          options={['served', 'pending', 'refused', 'unclaimed', 'untraceable', 'substituted']
            .map((o) => ({ value: o, label: t(`panel.judgments.outcome.${o}`) }))} />
        <SelectField label={t('panel.judgments.servedOnKind')} value={servedOnKind}
          onChange={(e) => setServedOnKind(e.target.value)}
          options={['opponent', 'client', 'representative', 'third_party']
            .map((s) => ({ value: s, label: t(`panel.judgments.servedOn.${s}`) }))} />
        <TextField label={t('panel.judgments.servedOnName')} value={servedOnName} maxLength={200}
          onChange={(e) => setServedOnName(e.target.value)} />
        {outcome === 'served' && (
          <TextField label={t('panel.judgments.servedOnDate')} type="date" value={servedOn}
            onChange={(e) => setServedOn(e.target.value)} />
        )}
        <TextField label={t('panel.judgments.proof')} hint={t('panel.judgments.proofHint')}
          value={proofReference} maxLength={200}
          onChange={(e) => setProofReference(e.target.value)} />
      </div>
    </Modal>
  );
}

export function AppealDialog({
  judgment, onClose, onChanged,
}: {
  judgment: JudgmentRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const j = judgment as Record<string, unknown>;
  const [appealKind, setAppealKind] = useState('appeal');
  const [filedOn, setFiledOn] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [stayRequested, setStayRequested] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await firmApi.recordAppeal(String(judgment.id), {
        appealKind,
        filedAt: new Date(`${filedOn}T00:00:00.000Z`).toISOString(),
        reference: reference.trim() || null,
        stayRequested,
      });
      toast.success(t('panel.judgments.appealFiled'));
      onChanged();
      onClose();
    } catch (err) {
      toast.error(t('panel.judgments.appealFailed'), why(err, t));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('panel.judgments.appeal')}
      description={String(j.deedNumber ?? '')}
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={() => { void submit(); }}>
            {t('panel.judgments.appealAction')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <SelectField label={t('panel.judgments.appealKind')} value={appealKind}
          onChange={(e) => setAppealKind(e.target.value)}
          options={[
            { value: 'appeal', label: t('panel.judgments.appealKind') },
            { value: 'cassation', label: t('panel.judgments.cassation') },
            { value: 'rehearing', label: t('panel.judgments.rehearing') },
          ]} />
        <TextField label={t('panel.judgments.filedOn')} type="date" value={filedOn}
          onChange={(e) => setFiledOn(e.target.value)} />
        <TextField label={t('panel.judgments.appealReference')} value={reference} maxLength={100}
          onChange={(e) => setReference(e.target.value)} />
        <Checkbox checked={stayRequested} onChange={(e) => setStayRequested(e.target.checked)}
          label={t('panel.judgments.stayRequested')} hint={t('panel.judgments.stayRequestedHint')} />
      </div>
    </Modal>
  );
}

export function StayDialog({
  judgment, onClose, onChanged,
}: {
  judgment: JudgmentRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const inForce = Boolean((judgment as Record<string, unknown>).stayInForce);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(next: boolean) {
    setBusy(true);
    try {
      await firmApi.recordStay(String(judgment.id), { inForce: next, reason: reason.trim() || null });
      toast.success(next ? t('panel.judgments.stayed') : t('panel.judgments.stayLifted'));
      onChanged();
      onClose();
    } catch (err) {
      toast.error(t('panel.judgments.stayFailed'), why(err, t));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={inForce ? t('panel.judgments.liftStay') : t('panel.judgments.stay')}
      description={t('panel.judgments.stayBody')}
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant={inForce ? 'secondary' : 'primary'} loading={busy}
            onClick={() => { void submit(!inForce); }}>
            {inForce ? t('panel.judgments.liftStay') : t('panel.judgments.stayAction')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextArea label={t('panel.judgments.stayReason')} value={reason} rows={2} maxLength={500}
          onChange={(e) => setReason(e.target.value)} />
        {/*
          WHY THIS MATTERS, IN THE DIALOG. A stay is the single fact that turns an
          otherwise enforceable judgment into one the firm may not collect on — the
          execution gate reads it. Saying so here is cheaper than a member discovering it
          by being refused.
        */}
        <p className="firm-panel__note c-muted">{t('panel.judgments.stayNote')}</p>
      </div>
    </Modal>
  );
}
