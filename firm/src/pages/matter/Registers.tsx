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
import { Badge, Card, CardBody, CardHeader, IconLock, Table, useFmt, useI18n, type Column } from '@kgm/ui';
import { firmApi, type MatterConflictHitRow, type MatterPartyRow } from '../../api/firm.js';
import { PanelFrame, usePanel } from './Panels.js';

/* ---------------------------------------------------------------- parties -- */

export function MatterPartiesPanel({ matterId }: { matterId: string }) {
  const { t, pick } = useI18n();
  const state = usePanel(matterId, () => firmApi.matterParties(matterId));

  return (
    <PanelFrame
      state={state}
      title={t('tab.parties')}
      emptyTitle={t('panel.parties.empty')}
      emptyBody={t('panel.parties.emptyBody')}
      isEmpty={(d) => d.parties.length === 0}
    >
      {(d) => (
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
      )}
    </PanelFrame>
  );
}

/* -------------------------------------------------------------- conflicts -- */

export function MatterConflictsPanel({ matterId }: { matterId: string }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const state = usePanel(matterId, () => firmApi.matterConflicts(matterId));

  return (
    <PanelFrame
      state={state}
      title={t('tab.conflicts')}
      emptyTitle={t('panel.conflicts.empty')}
      emptyBody={t('panel.conflicts.emptyBody')}
      isEmpty={(d) => d.count === 0}
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

          <p className="firm-panel__note c-muted">
            {t('panel.conflicts.generated', { when: fmt.date(new Date().toISOString()) })}
          </p>
        </div>
      )}
    </PanelFrame>
  );
}

/* -------------------------------------------------------------- judgments -- */

interface JudgmentRow {
  id: string;
  operative?: boolean;
  [key: string]: unknown;
}

export function MatterJudgmentsPanel({ matterId }: { matterId: string }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const state = usePanel(matterId, () => firmApi.matterJudgments(matterId));

  return (
    <PanelFrame
      state={state}
      title={t('tab.judgments')}
      emptyTitle={t('panel.judgments.empty')}
      emptyBody={t('panel.judgments.emptyBody')}
      isEmpty={(d) => d.judgments.length === 0}
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
