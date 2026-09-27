/**
 * THE COMPLIANCE CONSOLE · recommendation 6, the largest group of routes with no screen
 *
 * WHAT THIS CLOSES. Nineteen firm routes were reachable by an engineer and by nothing else:
 * the AML record, the sanctions screening and its dispositions, the suspicious-transaction
 * report with its three-day clock, the risk-country register, and the register of who may
 * practise. The audit's own count put compliance at the top of the list, and the reason it
 * matters more than the rest of the list is that these are not conveniences: the firm is a
 * DNFBP under the Anti-Money Laundering Law (Royal Decree M/20 of 2017), and the obligations
 * behind these routes are ones it can be prosecuted for.
 *
 * FOUR TABS, AND WHY THE FIRST ONE IS NOT A TABLE
 *
 *   1 · THE READINESS VIEW leads with the clients the firm MAY NOT ACT FOR. A gate that
 *       silently refuses work is worse than no gate, because the member concludes the
 *       software is broken and stops asking for the reason. `refused` is the same gate,
 *       said out loud, with each blocker in words: no identification, an uncompleted
 *       identification, an unresolved screening hit, or enhanced diligence that needs a
 *       partner's signature.
 *   2 · THE RECORDS — every client's identification queue, with the review clock. The
 *       review cycle is not a habit here: it is 24, 12 or 6 months by risk rating, and the
 *       server computes the due date from it.
 *   3 · THE REPORTS — the STR register, where the interesting number is not the count but
 *       the DEADLINE. A report that is drafted and not filed is a report that is late, and
 *       lateness is its own offence.
 *   4 · WHO MAY PRACTISE — licences and the former-office bar. Article 14 of the Law of
 *       Practice bars a former judge or prosecutor for five years, and the bar attaches to
 *       the firm: staffing a matter with someone still inside the window is the firm acting
 *       through a person who may not act.
 *
 * WHAT IT REFUSES TO DO. No tab offers a control the server would refuse. Where a member
 * lacks the code — `compliance.review` for a disposition, `compliance.approve` for filing —
 * the screen says which code is missing rather than showing a button that produces a 403.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, Card, CardBody, EmptyState, IconCompliance, IconRefresh, IconSearch,
  IconShieldCheck, Modal, PageSkeleton, SelectField, Table,
  TextArea, TextField, useI18n, useToast, type Column,
} from '@kgm/ui';
import {
  FirmApiError, firmApi, type ClientDueDiligenceResponse, type ComplianceConsoleResponse,
  type DueDiligenceRow, type EligibilityMember, type StrReport,
} from '../api/firm.js';
import { useFirmSession } from '../auth/FirmSession.js';
import '../shell/shell.css';

type Tab = 'readiness' | 'records' | 'reports' | 'standing';

/**
 * THE BLOCKERS, IN WORDS. Each of these is a refusal the intake gate makes, and each is
 * written as the action that clears it rather than as a fault code — a compliance officer
 * reading "cdd_beneficial_owner_missing" learns nothing about what to do next.
 */
const BLOCKER_COPY: Record<string, string> = {
  cdd_missing: 'compliance.blocker.cdd_missing',
  cdd_incomplete: 'compliance.blocker.cdd_incomplete',
  cdd_unable_to_complete: 'compliance.blocker.unable',
  cdd_beneficial_owner_missing: 'compliance.blocker.owners',
  screening_unresolved: 'compliance.blocker.screening',
  screening_failed: 'compliance.blocker.screeningFailed',
  senior_approval_required: 'compliance.blocker.senior',
  review_overdue: 'compliance.blocker.reviewOverdue',
};

const RISK_TONE: Record<string, 'lime' | 'warning' | 'high' | 'critical' | 'neutral'> = {
  low: 'lime', medium: 'warning', high: 'high', critical: 'critical',
};

const DD_TONE: Record<string, 'lime' | 'warning' | 'high' | 'neutral'> = {
  complete: 'lime', in_progress: 'warning', unable_to_complete: 'high', not_started: 'neutral',
};

export function Compliance() {
  const { t, lang } = useI18n();
  const { can } = useFirmSession();

  const [tab, setTab] = useState<Tab>('readiness');
  const [console_, setConsole] = useState<ComplianceConsoleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FirmApiError | null>(null);
  const [openClient, setOpenClient] = useState<DueDiligenceRow | null>(null);
  const [reporting, setReporting] = useState(false);
  const [addingCountry, setAddingCountry] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    firmApi.complianceConsole()
      .then((d) => { setConsole(d); setError(null); })
      .catch((err) => {
        setConsole(null);
        setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable'));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const byLang = (ar: string | null | undefined, en: string | null | undefined): string => {
    const first = lang === 'ar' ? ar : en;
    const second = lang === 'ar' ? en : ar;
    if (first && first.trim()) return first;
    if (second && second.trim()) return second;
    return '—';
  };

  if (loading && !console_) return <PageSkeleton title={t('compliance.title')} />;

  if (error) {
    return (
      <div className="firm-page">
        <EmptyState
          kind="error"
          icon={<IconCompliance />}
          title={t('compliance.unavailable')}
          description={error.code === 'forbidden' ? t('compliance.forbidden') : error.message}
          action={{ label: t('common.retry'), onClick: load }}
        />
      </div>
    );
  }

  const census = console_!.census;
  const refused = console_!.refused;
  const queue = console_!.queue;

  return (
    <div className="firm-page firm-comp">
      <header className="firm-page__head">
        <div>
          <h1 className="firm-page__title">{t('compliance.title')}</h1>
          <p className="firm-page__sub">{t('compliance.subtitle')}</p>
        </div>
        <div className="firm-page__actions">
          <Button variant="ghost" icon={<IconRefresh size={16} />} onClick={load}>{t('common.refresh')}</Button>
        </div>
      </header>

      <nav className="firm-comp__tabs" aria-label={t('compliance.title')}>
        {(['readiness', 'records', 'reports', 'standing'] as Tab[]).map((id) => (
          <button
            key={id}
            type="button"
            className={`firm-comp__tab${tab === id ? ' firm-comp__tab--on' : ''}`}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id)}
          >
            {t(`compliance.tab.${id}`)}
            {id === 'reports' && census.reportsOpen > 0 ? <Badge tone="warning" size="xs">{census.reportsOpen}</Badge> : null}
            {id === 'readiness' && refused.length > 0 ? <Badge tone="high" size="xs">{refused.length}</Badge> : null}
          </button>
        ))}
      </nav>

      {/* ══ 1 · READINESS ═══════════════════════════════════════════════════════ */}
      {tab === 'readiness' ? (
        <>
          <div className="firm-comp__metrics">
            <Metric label={t('compliance.metric.clients')} value={census.clients} tone="neutral" />
            <Metric label={t('compliance.metric.identified')} value={census.complete} tone="lime" />
            <Metric label={t('compliance.metric.notStarted')} value={census.notStarted} tone={census.notStarted ? 'warning' : 'neutral'} />
            <Metric label={t('compliance.metric.unable')} value={census.unable} tone={census.unable ? 'high' : 'neutral'} />
            <Metric label={t('compliance.metric.reviewOverdue')} value={census.reviewOverdue} tone={census.reviewOverdue ? 'high' : 'neutral'} />
            <Metric label={t('compliance.metric.openMatches')} value={census.openMatches} tone={census.openMatches ? 'warning' : 'neutral'} />
            <Metric label={t('compliance.metric.reportsOpen')} value={census.reportsOpen} tone={census.reportsOpen ? 'warning' : 'neutral'} />
            <Metric label={t('compliance.metric.reportsLate')} value={census.reportsLate} tone={census.reportsLate ? 'critical' : 'neutral'} />
          </div>

          {/*
            THE REFUSALS, FIRST AND LARGEST. This is the list the audit argued the firm had
            been missing: work that the system will not let it take on, and the reason.
          */}
          <Card>
            <CardBody>
              <div className="firm-comp__sectionHead">
                <h2 className="firm-comp__h2">{t('compliance.refused.title')}</h2>
                {refused.length > 0 ? <Badge tone="high">{refused.length}</Badge> : <Badge tone="lime" size="sm">{t('compliance.refused.none')}</Badge>}
              </div>
              <p className="firm-comp__note">{t('compliance.refused.note')}</p>
              {refused.length === 0 ? (
                <EmptyState kind="empty" compact icon={<IconShieldCheck />} title={t('compliance.refused.none')} description={t('compliance.refused.noneBody')} />
              ) : (
                <ul className="firm-comp__refused">
                  {refused.map((r) => (
                    <li key={r.clientId}>
                      <span className="firm-comp__refusedName">{r.clientName}</span>
                      <span className="firm-comp__refusedWhy">
                        {r.blockers.map((b) => t(BLOCKER_COPY[b] ?? 'compliance.blocker.unknown')).join(' · ')}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => {
                        const row = queue.find((q) => q.clientId === r.clientId);
                        if (row) { setTab('records'); setOpenClient(row); }
                      }}>
                        {t('compliance.refused.open')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div className="firm-comp__sectionHead">
                <h2 className="firm-comp__h2">{t('compliance.countries.title')}</h2>
                {can('compliance.approve') ? (
                  <Button variant="secondary" onClick={() => setAddingCountry(true)}>{t('compliance.countries.add')}</Button>
                ) : null}
              </div>
              <p className="firm-comp__note">{t('compliance.countries.noteIntro')}</p>
              <ul className="firm-comp__countries">
                {console_!.countries.map((c) => (
                  <li key={c.id}>
                    <Badge tone={c.riskLevel === 'prohibited' ? 'critical' : 'high'} size="xs">
                      {t(`compliance.level.${c.riskLevel}`)}
                    </Badge>
                    <span className="num">{c.countryCode}</span>
                    <span>{byLang(c.countryNameAr, c.countryName)}</span>
                    <span className="c-muted">{t(`compliance.source.${c.listSource}`)}</span>
                    <span className="num c-muted">{c.effectiveFrom.slice(0, 10)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </>
      ) : null}

      {/* ══ 2 · THE RECORDS ═════════════════════════════════════════════════════ */}
      {tab === 'records' ? (
        <Card>
          <CardBody>
            <div className="firm-comp__sectionHead">
              <h2 className="firm-comp__h2">{t('compliance.records.title')}</h2>
              <span className="c-muted firm-comp__note">{t('compliance.records.threshold', { pct: String(console_!.thresholdPct), months: String(console_!.reviewMonths.high ?? 6) })}</span>
            </div>
            <Table
              columns={recordColumns(t)}
              rows={queue}
              rowKey={(r) => r.clientId}
              label={t('compliance.records.title')}
              density="compact"
              onRowClick={(r) => setOpenClient(r)}
              empty={<EmptyState kind="empty" title={t('compliance.records.empty')} description={t('compliance.records.emptyBody')} />}
            />
          </CardBody>
        </Card>
      ) : null}

      {/* ══ 3 · THE REPORTS ═════════════════════════════════════════════════════ */}
      {tab === 'reports' ? (
        <ReportsTab canCreate={can('compliance.create')} canApprove={can('compliance.approve')}
          onNew={() => setReporting(true)} />
      ) : null}

      {/* ══ 4 · WHO MAY PRACTISE ════════════════════════════════════════════════ */}
      {tab === 'standing' ? <StandingTab canManage={can('compliance.approve') || can('compliance.licences')} /> : null}

      {openClient ? (
        <ClientRecordDrawer
          row={openClient}
          canReview={can('compliance.review')}
          canCreate={can('compliance.create')}
          onClose={() => setOpenClient(null)}
          onChanged={load}
        />
      ) : null}

      {reporting ? (
        <NewReportDialog
          onClose={() => setReporting(false)}
          onCreated={() => { setReporting(false); setTab('reports'); }}
        />
      ) : null}

      {addingCountry ? (
        <RiskCountryDialog onClose={() => setAddingCountry(false)} onSaved={() => { setAddingCountry(false); load(); }} />
      ) : null}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
 * THE RECORDS TABLE
 * ══════════════════════════════════════════════════════════════════════════════ */

function recordColumns(t: (k: never) => string): ReadonlyArray<Column<DueDiligenceRow>> {
  const T = t as unknown as (k: string, vars?: Record<string, string>) => string;
  return [
    {
      key: 'client', header: T('compliance.col.client'), responsive: 'card', cardLabel: T('compliance.col.client'),
      cell: (r) => <span className="firm-comp__client">{r.clientName}</span>,
    },
    {
      key: 'status', header: T('compliance.col.status'), width: '11rem', responsive: 'card',
      cardLabel: T('compliance.col.status'),
      cell: (r) => (
        <Badge tone={DD_TONE[r.status ?? 'not_started'] ?? 'neutral'} size="sm">
          {T(`compliance.dd.${r.status ?? 'not_started'}`)}
        </Badge>
      ),
    },
    {
      key: 'risk', header: T('compliance.col.risk'), width: '8rem', responsive: 'card',
      cardLabel: T('compliance.col.risk'),
      cell: (r) => (r.riskRating
        ? <Badge tone={RISK_TONE[r.riskRating] ?? 'neutral'} size="sm">{T(`compliance.risk.${r.riskRating}`)}</Badge>
        : <span className="c-muted">—</span>),
    },
    {
      key: 'pep', header: T('compliance.col.pep'), width: '7rem', responsive: 'card',
      cardLabel: T('compliance.col.pep'),
      cell: (r) => (r.pepStatus && r.pepStatus !== 'not_pep'
        ? <Badge tone="warning" size="xs">{T(`compliance.pep.${r.pepStatus}`)}</Badge>
        : <span className="c-muted">—</span>),
    },
    {
      key: 'banks', header: T('compliance.col.screening'), width: '9rem', responsive: 'card',
      cardLabel: T('compliance.col.screening'),
      cell: (r) => (
        <span className="num">
          {r.openMatches > 0
            ? <Badge tone="warning" size="xs">{T('compliance.matches.open', { n: String(r.openMatches) })}</Badge>
            : r.failedRuns > 0
              ? <Badge tone="high" size="xs">{T('compliance.matches.failed')}</Badge>
              : <span className="c-muted">{T('compliance.matches.none')}</span>}
        </span>
      ),
    },
    {
      key: 'review', header: T('compliance.col.review'), width: '10rem', responsive: 'card',
      cardLabel: T('compliance.col.review'), numeric: true,
      cell: (r) => (r.reviewDueAt
        ? <span className="num">{String(r.reviewDueAt).slice(0, 10)}</span>
        : <span className="c-muted">—</span>),
    },
    {
      key: 'allowed', header: T('compliance.col.allowed'), width: '9rem', responsive: 'card',
      cardLabel: T('compliance.col.allowed'),
      cell: (r) => (r.allowed
        ? <Badge tone="lime" size="xs">{T('compliance.allowed.yes')}</Badge>
        : <Badge tone="high" size="xs">{T('compliance.allowed.no')}</Badge>),
    },
  ];
}

/* ══════════════════════════════════════════════════════════════════════════════
 * THE REPORT REGISTER
 * ══════════════════════════════════════════════════════════════════════════════ */

function ReportsTab({ canCreate, canApprove, onNew }: {
  canCreate: boolean; canApprove: boolean; onNew: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<{ reports: StrReport[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filing, setFiling] = useState<StrReport | null>(null);
  const [responding, setResponding] = useState<StrReport | null>(null);

  const load = useCallback(() => {
    firmApi.strReports().then(setData).catch(() => setData({ reports: [] }));
  }, []);
  useEffect(load, [load]);

  async function act(id: string, fn: () => Promise<unknown>, okTitle: string, okBody: string) {
    setBusy(id);
    try {
      await fn();
      toast.success(okTitle, okBody);
      load();
    } catch (err) {
      toast.error(t('compliance.str.failed'), err instanceof FirmApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const columns: ReadonlyArray<Column<StrReport>> = [
    {
      key: 'number', header: t('compliance.str.number'), width: '10rem', responsive: 'card',
      cardLabel: t('compliance.str.number'),
      cell: (r) => <span className="num firm-money__num">{r.reportNumber}</span>,
    },
    {
      key: 'subject', header: t('compliance.str.subject'), responsive: 'card', cardLabel: t('compliance.str.subject'),
      cell: (r) => (
        <span className="firm-comp__client">
          {r.clientName ?? r.subjectName ?? '—'}
          <span className="c-muted firm-comp__sub">{t(`compliance.subject.${r.subjectKind}`)}{r.matterNumber ? ` · ${r.matterNumber}` : ''}</span>
        </span>
      ),
    },
    {
      key: 'status', header: t('compliance.str.status'), width: '10rem', responsive: 'card',
      cardLabel: t('compliance.str.status'),
      cell: (r) => (
        <span className="firm-comp__stack">
          <Badge tone={r.status === 'filed' ? 'lime' : r.status === 'submitted' ? 'lime' : 'warning'} size="sm">
            {t(`compliance.str.state.${r.status}`)}
          </Badge>
          {/* LATE IS THE NUMBER THAT MATTERS. Everything else on this row is reference. */}
          {r.late ? <Badge tone="critical" size="xs">{t('compliance.str.late')}</Badge> : null}
        </span>
      ),
    },
    {
      key: 'due', header: t('compliance.str.due'), width: '10rem', responsive: 'card',
      cardLabel: t('compliance.str.due'), numeric: true,
      cell: (r) => <span className="num">{r.filedDueAt ? String(r.filedDueAt).slice(0, 10) : '—'}</span>,
    },
    {
      key: 'filed', header: t('compliance.str.filedAt'), width: '11rem', responsive: 'card',
      cardLabel: t('compliance.str.filedAt'), numeric: true,
      cell: (r) => (r.filedAt
        ? <span className="num">{String(r.filedAt).slice(0, 10)}<span className="c-muted firm-comp__sub">{r.fiuReference ?? ''}</span></span>
        : <span className="c-muted">—</span>),
    },
    {
      key: 'amount', header: t('compliance.str.amount'), width: '9rem', responsive: 'card',
      cardLabel: t('compliance.str.amount'), numeric: true,
      cell: (r) => <span className="num">{r.amountSar !== null ? r.amountSar.toFixed(2) : '—'}</span>,
    },
    {
      key: 'actions', header: '', width: '1rem', responsive: 'hide',
      cell: (r) => (
        <span className="firm-comp__rowactions" onClick={(e) => e.stopPropagation()}>
          {r.status === 'draft' && canApprove ? (
            <Button variant="ghost" size="sm" loading={busy === r.id}
              onClick={() => { void act(r.id, () => firmApi.reviewStrReport(r.id), t('compliance.str.sent'), t('compliance.str.sentBody')); }}>
              {t('compliance.str.send')}
            </Button>
          ) : null}
          {r.status === 'pending_review' && canApprove ? (
            <Button variant="secondary" size="sm" onClick={() => setFiling(r)}>{t('compliance.str.file')}</Button>
          ) : null}
          {r.status === 'filed' && canApprove ? (
            <Button variant="ghost" size="sm" onClick={() => setResponding(r)}>{t('compliance.str.response')}</Button>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <Card>
        <CardBody>
          <div className="firm-comp__sectionHead">
            <h2 className="firm-comp__h2">{t('compliance.str.title')}</h2>
            {canCreate ? <Button variant="secondary" onClick={onNew}>{t('compliance.str.new')}</Button> : null}
          </div>
          <p className="firm-comp__note">{t('compliance.str.note')}</p>
          <Table
            columns={columns}
            rows={data?.reports ?? []}
            rowKey={(r) => r.id}
            label={t('compliance.str.title')}
            density="compact"
            loading={data === null}
            empty={<EmptyState kind="empty" title={t('compliance.str.empty')} description={t('compliance.str.emptyBody')} />}
          />
        </CardBody>
      </Card>

      {filing ? (
        <FileReportDialog report={filing} onClose={() => setFiling(null)}
          onFiled={() => { setFiling(null); load(); }} />
      ) : null}
      {responding ? (
        <ResponseDialog report={responding} onClose={() => setResponding(null)}
          onDone={() => { setResponding(null); load(); }} />
      ) : null}
    </>
  );
}

/**
 * FILING WITH SAFIU — and the acknowledgement that is not boilerplate.
 *
 * The Anti-Money Laundering Law criminalises tipping off: telling the client that a report
 * has been made is an offence in its own right. The server requires this to be explicitly
 * true, so the form states the offence rather than making the member tick a box whose text
 * they skimmed.
 */
function FileReportDialog({ report, onClose, onFiled }: { report: StrReport; onClose: () => void; onFiled: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [ref, setRef] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await firmApi.fileStrReport(report.id, { fiuReference: ref.trim(), tippingOffAcknowledged: true });
      toast.success(t('compliance.str.filed'), t('compliance.str.filedBody', { ref: ref.trim() }));
      onFiled();
    } catch (err) {
      toast.error(t('compliance.str.failed'), err instanceof FirmApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="md"
      title={t('compliance.str.file')}
      description={t('compliance.str.fileBody', { number: report.reportNumber })}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!ack || ref.trim().length < 3} onClick={() => { void submit(); }}>
            {t('compliance.str.fileConfirm')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField label={t('compliance.str.fiuRef')} value={ref} onChange={(e) => setRef(e.target.value)} required
          hint={t('compliance.str.fiuRefHint', { due: report.filedDueAt ? String(report.filedDueAt).slice(0, 10) : '—', })} />
        <label className="firm-fiscal__check">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>{t('compliance.str.tippingOff')}</span>
        </label>
      </div>
    </Modal>
  );
}

function ResponseDialog({ report, onClose, onDone }: { report: StrReport; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [status, setStatus] = useState<'acknowledged' | 'rejected_by_fiu'>('acknowledged');
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await firmApi.strReportResponse(report.id, { status, response: response.trim() || null });
      toast.success(t('compliance.str.responded'), t('compliance.str.respondedBody'));
      onDone();
    } catch (err) {
      toast.error(t('compliance.str.failed'), err instanceof FirmApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="md"
      title={t('compliance.str.response')}
      description={t('compliance.str.responseBody', { number: report.reportNumber })}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={() => { void submit(); }}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <SelectField
          label={t('compliance.str.answer')}
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          options={[
            { value: 'acknowledged', label: t('compliance.str.state.acknowledged') },
            { value: 'rejected_by_fiu', label: t('compliance.str.state.rejected_by_fiu') },
          ]}
        />
        <TextField label={t('compliance.str.answerText')} value={response} onChange={(e) => setResponse(e.target.value)} />
      </div>
    </Modal>
  );
}

function NewReportDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [indicators, setIndicators] = useState<Array<{ code: string; label: string; labelAr: string }>>([]);
  const [form, setForm] = useState({ number: '', subjectKind: 'client' as const, subjectName: '', grounds: [] as string[], narrativeAr: '', amountSar: '' });

  useEffect(() => {
    firmApi.strReports().then((d) => setIndicators(d.indicators)).catch(() => setIndicators([]));
  }, []);

  const valid = form.number.trim().length >= 3 && form.narrativeAr.trim().length >= 40 && form.grounds.length > 0;

  async function submit() {
    setBusy(true);
    try {
      await firmApi.createStrReport({
        reportNumber: form.number.trim(),
        subjectKind: form.subjectKind,
        subjectName: form.subjectName.trim() || null,
        grounds: form.grounds,
        narrativeAr: form.narrativeAr.trim(),
        amountSar: form.amountSar ? Number(form.amountSar) : null,
      });
      toast.success(t('compliance.str.created'), t('compliance.str.createdBody', { number: form.number.trim() }));
      onCreated();
    } catch (err) {
      toast.error(t('compliance.str.failed'), err instanceof FirmApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="lg"
      title={t('compliance.str.new')}
      description={t('compliance.str.newBody')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => { void submit(); }}>
            {t('compliance.str.createConfirm')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField label={t('compliance.str.number')} value={form.number}
          onChange={(e) => setForm({ ...form, number: e.target.value })} required />
        <SelectField label={t('compliance.str.subjectKind')} value={form.subjectKind}
          onChange={(e) => setForm({ ...form, subjectKind: e.target.value as typeof form.subjectKind })}
          options={['client', 'party', 'beneficial_owner', 'staff', 'transaction'].map((v) => ({ value: v, label: t(`compliance.subject.${v}`) }))} />
        <TextField label={t('compliance.str.subjectName')} value={form.subjectName}
          onChange={(e) => setForm({ ...form, subjectName: e.target.value })} />
        <TextField label={t('compliance.str.amount')} value={form.amountSar}
          onChange={(e) => setForm({ ...form, amountSar: e.target.value.replace(/[^\d.]/g, '') })} />
        <fieldset className="firm-comp__grounds">
          <legend>{t('compliance.str.grounds')}</legend>
          <p className="firm-comp__note">{t('compliance.str.groundsNote')}</p>
          <div className="firm-comp__chips">
            {indicators.map((i) => {
              const on = form.grounds.includes(i.code);
              return (
                <label key={i.code} className={`firm-comp__chip${on ? ' firm-comp__chip--on' : ''}`}>
                  {/* The indicators are the law's own list, transcribed in server/src/domain/aml.ts —
                      a free-text reason field would produce reports SAFIU cannot tally. */}
                  <input type="checkbox" checked={on} onChange={() => setForm({
                    ...form,
                    grounds: on ? form.grounds.filter((g) => g !== i.code) : [...form.grounds, i.code],
                  })} />
                  <span>{lang === 'ar' ? i.labelAr : i.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="firm-comp__narrative">
          <TextArea
            label={t('compliance.str.narrativeAr')}
            value={form.narrativeAr}
            rows={6}
            maxLength={20_000}
            onChange={(e) => setForm({ ...form, narrativeAr: e.target.value })}
          />
          <span className="c-muted firm-comp__note">{t('compliance.str.narrativeHint', { n: String(Math.max(0, 40 - form.narrativeAr.trim().length)) })}</span>
        </div>
      </div>
    </Modal>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
 * ONE CLIENT'S RECORD
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * THE DRAWER: identification, owners, screening history, and the four acts.
 *
 * The order is the order of the obligation: identify the client, identify who owns it,
 * screen all of them, decide the hits. Every act here is a separate permission on the
 * server, and the ones this member lacks are named rather than hidden behind a dead button.
 */
function ClientRecordDrawer({ row, canReview, canCreate, onClose, onChanged }: {
  row: DueDiligenceRow;
  canReview: boolean;
  canCreate: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<ClientDueDiligenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingOwner, setAddingOwner] = useState(false);
  const [unable, setUnable] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [screening, setScreening] = useState(false);
  const [dispositionMatch, setDispositionMatch] = useState<{ id: string; listName: string } | null>(null);

  const load = useCallback(() => {
    firmApi.clientDueDiligence(row.clientId)
      .then((d) => { setData(d); setError(null); })
      .catch((err) => setError(err instanceof FirmApiError ? err.message : String(err)));
  }, [row.clientId]);
  useEffect(load, [load]);

  const dd = data?.dd ?? null;
  const ddTone = DD_TONE[dd?.status ?? 'not_started'] ?? 'neutral';

  async function run(fn: () => Promise<unknown>, okTitle: string, okBody: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(okTitle, okBody);
      load(); onChanged();
    } catch (err) {
      toast.error(t('compliance.record.failed'), err instanceof FirmApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={row.clientName}
      description={t('compliance.record.body')}
      footer={(
        <>
          <span className="firm-money__spacer" />
          {dd && dd.status !== 'complete' && dd.status !== 'unable_to_complete' && canReview ? (
            <>
              <Button variant="ghost" onClick={() => setUnable(true)}>{t('compliance.record.unable')}</Button>
              <Button variant="primary" loading={busy} onClick={() => setCompleting(true)}>{t('compliance.record.complete')}</Button>
            </>
          ) : null}
          {!dd && canCreate ? (
            <Button variant="primary" loading={busy}
              onClick={() => { void run(
                () => firmApi.createClientDueDiligence(row.clientId, { level: 'standard' }),
                t('compliance.record.opened'), t('compliance.record.openedBody')); }}>
              {t('compliance.record.open')}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        </>
      )}
    >
      {error ? <p className="firm-comp__note">{error}</p> : null}

      <div className="firm-panel__sections">
        <Card>
          <CardBody>
            <div className="firm-comp__sectionHead">
              <h3 className="firm-comp__h2">{t('compliance.record.identification')}</h3>
              <Badge tone={ddTone} size="sm">{t(`compliance.dd.${dd?.status ?? 'not_started'}`)}</Badge>
            </div>
            <dl className="firm-deflist firm-deflist--inline">
              <div className="firm-deflist__row"><dt>{t('compliance.record.level')}</dt>
                <dd>{dd ? t(`compliance.level2.${dd.level}`) : '—'}</dd></div>
              <div className="firm-deflist__row"><dt>{t('compliance.record.risk')}</dt>
                <dd>{dd ? t(`compliance.risk.${dd.riskRating}`) : '—'}</dd></div>
              <div className="firm-deflist__row"><dt>{t('compliance.record.review')}</dt>
                <dd className="num">{dd?.reviewDueAt ? String(dd.reviewDueAt).slice(0, 10) : '—'}</dd></div>
              <div className="firm-deflist__row"><dt>{t('compliance.record.pep')}</dt>
                <dd>{dd ? t(`compliance.pep.${dd.pepStatus}`) : '—'}</dd></div>
              <div className="firm-deflist__row"><dt>{t('compliance.record.purpose')}</dt>
                <dd>{dd?.purposeOfRelationship ?? '—'}</dd></div>
              <div className="firm-deflist__row"><dt>{t('compliance.record.funds')}</dt>
                <dd>{dd?.sourceOfFunds ?? '—'}</dd></div>
              {dd?.unableReason ? (
                <div className="firm-deflist__row"><dt>{t('compliance.record.unableWhy')}</dt>
                  <dd className="firm-comp__err">{dd.unableReason}</dd></div>
              ) : null}
            </dl>
          </CardBody>
        </Card>

        <section>
          <div className="firm-comp__sectionHead">
            <h3 className="firm-panel__subhead">
              {t('compliance.record.owners')} · {data?.owners.length ?? 0}
            </h3>
            {dd && canCreate ? (
              <Button variant="secondary" size="sm" onClick={() => setAddingOwner(true)}>{t('compliance.record.addOwner')}</Button>
            ) : null}
          </div>
          {/*
            WHO OWNS IT, over the threshold the law sets. Shown as a proportion rather than
            a tick: 24.9% is not a beneficial owner and 25% is, and the figure is what the
            decision is made on — so the figure is what the screen shows.
          */}
          {(data?.owners.length ?? 0) === 0 ? (
            <EmptyState kind="empty" compact title={t('compliance.record.noOwners')}
              description={t('compliance.record.noOwnersBody', { pct: '25' })} />
          ) : (
            <ul className="firm-comp__owners">
              {data!.owners.map((o) => (
                <li key={o.id}>
                  <span>{lang === 'ar' ? (o.fullNameAr ?? o.fullName) : o.fullName}</span>
                  <span className="num firm-comp__pct">{o.ownershipPct.toFixed(2)}%</span>
                  {o.controlRights > 0 ? <span className="c-muted">{t('compliance.record.control')} {o.controlRights.toFixed(0)}%</span> : null}
                  {o.isPep ? <Badge tone="warning" size="xs">{t('compliance.record.pepOwner')}</Badge> : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="firm-comp__sectionHead">
            <h3 className="firm-panel__subhead">{t('compliance.record.screening')}</h3>
            {canCreate ? (
              <Button variant="secondary" size="sm" onClick={() => setScreening(true)}>{t('compliance.record.runScreening')}</Button>
            ) : null}
          </div>
          {(data?.screening.length ?? 0) === 0 ? (
            <EmptyState kind="empty" compact icon={<IconSearch />} title={t('compliance.record.noScreening')}
              description={t('compliance.record.noScreeningBody')} />
          ) : (
            <ul className="firm-comp__runs">
              {data!.screening.map((run) => (
                <li key={run.id}>
                  <div className="firm-comp__runHead">
                    <Badge tone={run.status === 'clear' ? 'lime' : run.status === 'failed' ? 'high' : 'warning'} size="xs">
                      {t(`compliance.run.${run.status}`)}
                    </Badge>
                    <span>{t(`compliance.subject.${run.subjectKind}`)} · {run.subjectName}</span>
                    <span className="c-muted num">{run.runAt.slice(0, 10)}</span>
                    {/* Which version of the list was checked. Without it a screening is
                        an assertion about an unknown document. */}
                    <span className="c-muted num">{t('compliance.record.listAsOf')} {run.listAsOf ? run.listAsOf.slice(0, 10) : '—'}</span>
                  </div>
                  {run.matches.length > 0 ? (
                    <ul className="firm-comp__matches">
                      {run.matches.map((m) => (
                        <li key={m.id}>
                          <span className="num firm-comp__score">{Math.round(m.matchScore * 100)}%</span>
                          <span>{m.listName}</span>
                          {/*
                            `open` IS A DISPOSITION, NOT A NULL. A match row is created
                            with disposition = 'open' and decided later, so the first
                            version of this branch — which tested for the ABSENCE of a
                            value — would have shown an undecided hit as a decided one,
                            under a missing translation key, with no way to decide it. The
                            state is named, and the control appears for that state.
                          */}
                          {m.disposition && m.disposition !== 'open' ? (
                            <Badge tone={m.disposition === 'false_positive' ? 'neutral' : 'high'} size="xs">
                              {t(`compliance.disposition.${m.disposition}`)}
                            </Badge>
                          ) : canReview ? (
                            <Button variant="ghost" size="sm"
                              onClick={() => setDispositionMatch({ id: m.id, listName: m.listName })}>
                              {t('compliance.record.decide')}
                            </Button>
                          ) : (
                            <span className="c-muted">{t('compliance.record.needsReview')}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {addingOwner && dd ? (
        <AddOwnerDialog ddId={dd.id} onClose={() => setAddingOwner(false)}
          onSaved={() => { setAddingOwner(false); load(); onChanged(); }} />
      ) : null}

      {unable ? (
        <ReasonDialog
          title={t('compliance.record.unable')}
          body={t('compliance.record.unableBody')}
          minLength={20}
          confirmLabel={t('compliance.record.unableConfirm')}
          busy={busy}
          onClose={() => setUnable(false)}
          onConfirm={(reason) => {
            setUnable(false);
            void run(() => firmApi.unableToCompleteDueDiligence(dd!.id, reason),
              t('compliance.record.markedUnable'), t('compliance.record.markedUnableBody'));
          }}
        />
      ) : null}

      {/*
        COMPLETION, WHICH IS WHERE THE SENIOR SIGNATURE LIVES. Enhanced due diligence
        cannot be completed by the person who did the work: a partner accepts the risk, by
        name, and the server refuses the completion without it.
      */}
      {completing && dd ? (
        <CompleteDialog
          enhanced={dd.level === 'enhanced'}
          busy={busy}
          onClose={() => setCompleting(false)}
          onConfirm={(body) => {
            setCompleting(false);
            void run(() => firmApi.completeDueDiligence(dd.id, body),
              t('compliance.record.completed'), t('compliance.record.completedBody'));
          }}
        />
      ) : null}

      {screening ? (
        <ScreeningDialog
          clientId={row.clientId}
          clientName={row.clientName}
          onClose={() => setScreening(false)}
          onSaved={() => { setScreening(false); load(); onChanged(); }}
        />
      ) : null}

      {dispositionMatch ? (
        <DispositionDialog
          matchId={dispositionMatch.id}
          listName={dispositionMatch.listName}
          onClose={() => setDispositionMatch(null)}
          onSaved={() => { setDispositionMatch(null); load(); onChanged(); }}
        />
      ) : null}
    </Modal>
  );
}

function AddOwnerDialog({ ddId, onClose, onSaved }: { ddId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    fullName: '', fullNameAr: '', nationality: '', residenceCountry: '',
    ownershipPct: '', controlRights: '', isPep: false,
  });
  const pct = Number(form.ownershipPct) || 0;
  const valid = form.fullName.trim().length >= 3 && pct >= 0 && pct <= 100;

  async function submit() {
    setBusy(true);
    try {
      await firmApi.addBeneficialOwner(ddId, {
        ownerKind: 'natural_person',
        fullName: form.fullName.trim(),
        fullNameAr: form.fullNameAr.trim() || null,
        nationality: form.nationality.trim().toUpperCase() || null,
        residenceCountry: form.residenceCountry.trim().toUpperCase() || null,
        ownershipPct: pct,
        controlRights: Number(form.controlRights) || 0,
        isPep: form.isPep,
      });
      toast.success(t('compliance.owner.saved'), t('compliance.owner.savedBody'));
      onSaved();
    } catch (err) {
      toast.error(t('compliance.owner.failed'), err instanceof FirmApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="md"
      title={t('compliance.record.addOwner')}
      description={t('compliance.owner.body')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => { void submit(); }}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField label={t('compliance.owner.name')} value={form.fullName}
          onChange={(e) => setForm({ ...form, fullName: e.target.value })} required />
        <TextField label={t('compliance.owner.nameAr')} value={form.fullNameAr}
          onChange={(e) => setForm({ ...form, fullNameAr: e.target.value })} />
        <TextField label={t('compliance.owner.nationality')} value={form.nationality}
          onChange={(e) => setForm({ ...form, nationality: e.target.value.toUpperCase().slice(0, 2) })}
          hint={t('compliance.owner.iso')} />
        <TextField label={t('compliance.owner.residence')} value={form.residenceCountry}
          onChange={(e) => setForm({ ...form, residenceCountry: e.target.value.toUpperCase().slice(0, 2) })} />
        <TextField label={t('compliance.owner.pct')} value={form.ownershipPct}
          onChange={(e) => setForm({ ...form, ownershipPct: e.target.value.replace(/[^\d.]/g, '') })}
          hint={t('compliance.owner.pctHint')} />
        <TextField label={t('compliance.owner.control')} value={form.controlRights}
          onChange={(e) => setForm({ ...form, controlRights: e.target.value.replace(/[^\d.]/g, '') })} />
        <label className="firm-fiscal__check">
          <input type="checkbox" checked={form.isPep} onChange={(e) => setForm({ ...form, isPep: e.target.checked })} />
          <span>{t('compliance.owner.isPep')}</span>
        </label>
        {/* The threshold, at the moment the figure is typed: 24.9 and 25 are the same list
            on the screen but not in the law. */}
        {pct >= 25 ? <p className="firm-comp__note--warn">{t('compliance.owner.overThreshold', { pct: '25' })}</p>
          : pct > 0 ? <p className="firm-comp__note">{t('compliance.owner.underThreshold', { pct: '25' })}</p> : null}
      </div>
    </Modal>
  );
}

function ScreeningDialog({ clientId, clientName, onClose, onSaved }: {
  clientId: string; clientName: string; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<'internal_register' | 'manual_review' | 'external_provider' | 'regulator_feed'>('internal_register');
  const [lists, setLists] = useState<string[]>(['un_consolidated']);
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));

  async function submit() {
    setBusy(true);
    try {
      const result = await firmApi.runScreening(clientId, {
        subjectKind: 'client', subjectId: clientId, subjectName: clientName,
        listSets: lists as never, listAsOf: asOf || null, provider,
      });
      toast.success(t('compliance.screen.done'), t('compliance.screen.doneBody', { n: String(result.matches ?? 0) }));
      onSaved();
    } catch (err) {
      toast.error(t('compliance.screen.failed'), err instanceof FirmApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="md"
      title={t('compliance.record.runScreening')}
      description={t('compliance.screen.body')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={lists.length === 0} onClick={() => { void submit(); }}>
            {t('compliance.screen.run')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <SelectField label={t('compliance.screen.provider')} value={provider}
          onChange={(e) => setProvider(e.target.value as typeof provider)}
          options={['internal_register', 'manual_review', 'external_provider', 'regulator_feed']
            .map((v) => ({ value: v, label: t(`compliance.provider.${v}`) }))}
          hint={t('compliance.screen.providerHint')} />
        <TextField label={t('compliance.screen.asOf')} type="date" value={asOf}
          onChange={(e) => setAsOf(e.target.value)} hint={t('compliance.screen.asOfHint')} />
        <fieldset className="firm-comp__grounds">
          <legend>{t('compliance.screen.lists')}</legend>
          <div className="firm-comp__chips">
            {['un_consolidated', 'eu_consolidated', 'sama_designations', 'ofac_sdn', 'internal_register'].map((code) => {
              const on = lists.includes(code);
              return (
                <label key={code} className={`firm-comp__chip${on ? ' firm-comp__chip--on' : ''}`}>
                  <input type="checkbox" checked={on}
                    onChange={() => setLists(on ? lists.filter((l) => l !== code) : [...lists, code])} />
                  <span>{t(`compliance.list.${code}`)}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

/**
 * DECIDING A HIT, ONCE.
 *
 * The server refuses a second disposition, and the dialog says why: re-deciding a match
 * would erase the first decision's audit trail, and the question "who cleared this name
 * and on what basis" is the one a regulator asks. The reason is required and long enough
 * to be a reason.
 */
function DispositionDialog({ matchId, listName, onClose, onSaved }: {
  matchId: string; listName: string; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [disposition, setDisposition] = useState<'false_positive' | 'true_match' | 'escalated'>('false_positive');
  const [reason, setReason] = useState('');

  async function submit() {
    setBusy(true);
    try {
      await firmApi.dispositionScreeningMatch(matchId, { disposition, reason: reason.trim() });
      toast.success(t('compliance.disposition.saved'), t('compliance.disposition.savedBody'));
      onSaved();
    } catch (err) {
      toast.error(t('compliance.disposition.failed'), err instanceof FirmApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="md"
      title={t('compliance.record.decide')}
      description={t('compliance.disposition.body', { list: listName })}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={reason.trim().length < 10} onClick={() => { void submit(); }}>
            {t('compliance.disposition.confirm')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <SelectField label={t('compliance.disposition.label')} value={disposition}
          onChange={(e) => setDisposition(e.target.value as typeof disposition)}
          options={['false_positive', 'true_match', 'escalated'].map((v) => ({ value: v, label: t(`compliance.disposition.${v}`) }))}
          hint={t(`compliance.disposition.hint.${disposition}`)} />
        <TextField label={t('common.reason')} value={reason}
          onChange={(e) => setReason(e.target.value)} required
          hint={t('compliance.disposition.reasonHint')} />
        <p className="firm-comp__note">{t('compliance.disposition.once')}</p>
      </div>
    </Modal>
  );
}

function CompleteDialog({ enhanced, busy, onClose, onConfirm }: {
  enhanced: boolean; busy: boolean;
  onClose: () => void;
  onConfirm: (body: { seniorApprovedByMembershipId?: string | null; seniorApprovalNote?: string | null }) => void;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [approvedBy, setApprovedBy] = useState('');

  return (
    <Modal open onClose={onClose} size="md"
      title={t('compliance.record.complete')}
      description={enhanced ? t('compliance.record.completeEnhanced') : t('compliance.record.completeBody')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={() => onConfirm({
            seniorApprovedByMembershipId: approvedBy.trim() || null,
            seniorApprovalNote: note.trim() || null,
          })}>
            {t('compliance.record.completeConfirm')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        {enhanced ? (
          <>
            <TextField label={t('compliance.record.senior')} value={approvedBy}
              onChange={(e) => setApprovedBy(e.target.value)}
              hint={t('compliance.record.seniorHint')} required />
            <p className="firm-comp__note--warn">{t('compliance.record.seniorWhy')}</p>
          </>
        ) : null}
        <TextField label={t('compliance.record.note')} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

function ReasonDialog({ title, body, minLength, confirmLabel, busy, onClose, onConfirm }: {
  title: string; body: string; minLength: number; confirmLabel: string; busy: boolean;
  onClose: () => void; onConfirm: (reason: string) => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  return (
    <Modal open onClose={onClose} size="md" title={title} description={body}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={reason.trim().length < minLength}
            onClick={() => onConfirm(reason.trim())}>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField label={t('common.reason')} value={reason} onChange={(e) => setReason(e.target.value)} required
          hint={t('compliance.reason.minChars', { n: String(minLength), left: String(Math.max(0, minLength - reason.trim().length)) })} />
      </div>
    </Modal>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
 * WHO MAY PRACTISE
 * ══════════════════════════════════════════════════════════════════════════════ */

function StandingTab({ canManage }: { canManage: boolean }) {
  const { t, lang } = useI18n();
  const [members, setMembers] = useState<EligibilityMember[] | null>(null);
  const [adding, setAdding] = useState<EligibilityMember | null>(null);
  const [addingOffice, setAddingOffice] = useState<EligibilityMember | null>(null);

  const load = useCallback(() => {
    firmApi.eligibility().then((d) => setMembers(d.members)).catch(() => setMembers([]));
  }, []);
  useEffect(load, [load]);

  const columns: ReadonlyArray<Column<EligibilityMember>> = [
    {
      key: 'member', header: t('compliance.standing.member'), responsive: 'card', cardLabel: t('compliance.standing.member'),
      cell: (m) => (
        <span className="firm-comp__client">
          {lang === 'ar' ? (m.displayNameAr ?? m.displayName) : m.displayName}
          <span className="c-muted firm-comp__sub">{m.email ?? ''}</span>
        </span>
      ),
    },
    {
      key: 'licence', header: t('compliance.standing.licence'), width: '14rem', responsive: 'card',
      cardLabel: t('compliance.standing.licence'),
      cell: (m) => {
        const current = m.licences[0];
        if (!m.requiresLicence) return <span className="c-muted">{t('compliance.standing.noLicenceNeeded')}</span>;
        if (!current) return <Badge tone="high" size="xs">{t('compliance.standing.noLicence')}</Badge>;
        return (
          <span className="firm-comp__stack">
            <span className="num">{current.licenceNumber}</span>
            <span className={`num firm-comp__sub${current.status === 'valid' ? '' : ' firm-comp__err'}`}>
              {t(`compliance.licence.${current.status}`)}
              {current.expiresAt ? ` · ${String(current.expiresAt).slice(0, 10)}` : ''}
            </span>
          </span>
        );
      },
    },
    {
      key: 'office', header: t('compliance.standing.office'), responsive: 'card',
      cardLabel: t('compliance.standing.office'),
      cell: (m) => (m.priorOffice.stillInPost || m.priorOffice.restrictionEndsOn
        ? (
          <span className="firm-comp__stack">
            {m.priorOffice.barred
              ? <Badge tone="critical" size="xs">{t('compliance.bar.barred')}</Badge>
              : <Badge tone="warning" size="xs">{t('compliance.bar.recorded')}</Badge>}
            <span className="c-muted firm-comp__sub">
              {m.priorOffice.institution ?? ''}{m.priorOffice.restrictionEndsOn ? ` · ${t('compliance.bar.until')} ${String(m.priorOffice.restrictionEndsOn).slice(0, 10)}` : ''}
            </span>
          </span>
        ) : <span className="c-muted">—</span>),
    },
    {
      key: 'entitled', header: t('compliance.standing.entitled'), width: '10rem', responsive: 'card',
      cardLabel: t('compliance.standing.entitled'),
      cell: (m) => (m.entitled
        ? <Badge tone="lime" size="xs">{t('compliance.allowed.yes')}</Badge>
        : <Badge tone="high" size="xs">{t(`compliance.reason.${m.reason}`)}</Badge>),
    },
    {
      key: 'actions', header: '', width: '1rem', responsive: 'hide',
      cell: (m) => (canManage ? (
        <span className="firm-comp__rowactions" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" onClick={() => setAdding(m)}>{t('compliance.standing.addLicence')}</Button>
          <Button variant="ghost" size="sm" onClick={() => setAddingOffice(m)}>{t('compliance.standing.addOffice')}</Button>
        </span>
      ) : null),
    },
  ];

  return (
    <>
      <Card>
        <CardBody>
          <div className="firm-comp__sectionHead">
            <h2 className="firm-comp__h2">{t('compliance.standing.title')}</h2>
          </div>
          <p className="firm-comp__note">{t('compliance.standing.note')}</p>
          <Table
            columns={columns}
            rows={members ?? []}
            rowKey={(m) => m.membershipId}
            label={t('compliance.standing.title')}
            density="compact"
            loading={members === null}
            empty={<EmptyState kind="empty" title={t('compliance.standing.empty')} description={t('compliance.standing.emptyBody')} />}
          />
        </CardBody>
      </Card>

      {adding ? (
        <LicenceDialog member={adding} onClose={() => setAdding(null)}
          onSaved={() => { setAdding(null); load(); }} />
      ) : null}
      {addingOffice ? (
        <PriorOfficeDialog member={addingOffice} onClose={() => setAddingOffice(null)}
          onSaved={() => { setAddingOffice(null); load(); }} />
      ) : null}
    </>
  );
}

function LicenceDialog({ member, onClose, onSaved }: { member: EligibilityMember; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ licenceNumber: '', issuedAt: '', expiresAt: '', status: 'valid' as 'valid' | 'suspended' | 'expired' | 'revoked' | 'pending' });

  async function submit() {
    setBusy(true);
    try {
      await firmApi.addLicence(member.membershipId, {
        licenceNumber: form.licenceNumber.trim(),
        issuedAt: form.issuedAt || null,
        expiresAt: form.expiresAt || null,
        status: form.status,
      });
      toast.success(t('compliance.licence.saved'), t('compliance.licence.savedBody'));
      onSaved();
    } catch (err) {
      toast.error(t('compliance.licence.failed'), err instanceof FirmApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="md"
      title={t('compliance.standing.addLicence')}
      description={t('compliance.licence.body', { name: member.displayName })}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={form.licenceNumber.trim().length < 3} onClick={() => { void submit(); }}>
            {t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField label={t('compliance.licence.number')} value={form.licenceNumber}
          onChange={(e) => setForm({ ...form, licenceNumber: e.target.value })} required
          hint={t('compliance.licence.numberHint')} />
        <TextField label={t('compliance.licence.issued')} type="date" value={form.issuedAt}
          onChange={(e) => setForm({ ...form, issuedAt: e.target.value })} />
        <TextField label={t('compliance.licence.expires')} type="date" value={form.expiresAt}
          onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} required
          hint={t('compliance.licence.expiresHint')} />
        <SelectField label={t('compliance.licence.status')} value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value as typeof form.status })}
          options={['valid', 'suspended', 'expired', 'revoked', 'pending'].map((v) => ({ value: v, label: t(`compliance.licence.${v}`) }))} />
      </div>
    </Modal>
  );
}

function PriorOfficeDialog({ member, onClose, onSaved }: { member: EligibilityMember; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    officeKind: 'judiciary' as const, institution: '', roleTitle: '', startedOn: '', endedOn: '',
  });

  /**
   * THE FIVE YEARS, COMPUTED ON SCREEN SO THE MEMBER SEES IT BEFORE SAVING.
   *
   * Article 14 of the Law of Practice bars practice for five years after leaving the bench
   * or the prosecution. The server computes the restriction from the dates it is given; the
   * form shows the same arithmetic, because "when may this person act again" is the only
   * question anyone asks of this form and it should not require a calculator.
   */
  const barEnds = (() => {
    if (!form.endedOn) return null;
    const d = new Date(form.endedOn);
    if (Number.isNaN(d.getTime())) return null;
    d.setFullYear(d.getFullYear() + 5);
    return d.toISOString().slice(0, 10);
  })();

  async function submit() {
    setBusy(true);
    try {
      await firmApi.addPriorOffice(member.membershipId, {
        officeKind: form.officeKind,
        institution: form.institution.trim(),
        roleTitle: form.roleTitle.trim() || null,
        startedOn: form.startedOn,
        endedOn: form.endedOn || null,
      });
      toast.success(t('compliance.office.saved'), t('compliance.office.savedBody'));
      onSaved();
    } catch (err) {
      toast.error(t('compliance.office.failed'), err instanceof FirmApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="md"
      title={t('compliance.standing.addOffice')}
      description={t('compliance.office.body', { name: member.displayName })}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy}
            disabled={form.institution.trim().length < 2 || !form.startedOn}
            onClick={() => { void submit(); }}>
            {t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <SelectField label={t('compliance.office.kind')} value={form.officeKind}
          onChange={(e) => setForm({ ...form, officeKind: e.target.value as typeof form.officeKind })}
          options={['judiciary', 'public_prosecution', 'bog', 'committee', 'government_body', 'court_administration', 'foreign_judiciary']
            .map((v) => ({ value: v, label: t(`compliance.office.${v}`) }))} />
        <TextField label={t('compliance.office.institution')} value={form.institution}
          onChange={(e) => setForm({ ...form, institution: e.target.value })} required />
        <TextField label={t('compliance.office.role')} value={form.roleTitle}
          onChange={(e) => setForm({ ...form, roleTitle: e.target.value })} />
        <TextField label={t('compliance.office.started')} type="date" value={form.startedOn}
          onChange={(e) => setForm({ ...form, startedOn: e.target.value })} required />
        <TextField label={t('compliance.office.ended')} type="date" value={form.endedOn}
          onChange={(e) => setForm({ ...form, endedOn: e.target.value })}
          hint={t('compliance.office.endedHint')} />
        {barEnds ? (
          <p className="firm-comp__note--warn">
            {t('compliance.office.bar', { until: barEnds })}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function RiskCountryDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    countryCode: '', countryName: '', countryNameAr: '',
    listSource: 'internal' as 'fatf_call_for_action' | 'fatf_grey' | 'un_sanctions' | 'eu_consolidated' | 'sama_circular' | 'internal',
    riskLevel: 'high' as 'high' | 'prohibited',
    effectiveFrom: new Date().toISOString().slice(0, 10),
    note: '',
  });

  async function submit() {
    setBusy(true);
    try {
      await firmApi.upsertRiskCountry({
        countryCode: form.countryCode.trim().toUpperCase().slice(0, 2),
        countryName: form.countryName.trim(),
        countryNameAr: form.countryNameAr.trim() || null,
        listSource: form.listSource,
        riskLevel: form.riskLevel,
        effectiveFrom: form.effectiveFrom,
        note: form.note.trim() || null,
      });
      toast.success(t('compliance.countries.saved'), t('compliance.countries.savedBody'));
      onSaved();
    } catch (err) {
      toast.error(t('compliance.countries.failed'), err instanceof FirmApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="md"
      title={t('compliance.countries.add')}
      description={t('compliance.countries.dialogBody')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy}
            disabled={form.countryCode.trim().length !== 2 || form.countryName.trim().length < 3}
            onClick={() => { void submit(); }}>
            {t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField label={t('compliance.countries.code')} value={form.countryCode}
          onChange={(e) => setForm({ ...form, countryCode: e.target.value.toUpperCase().slice(0, 2) })}
          required hint={t('compliance.countries.codeHint')} />
        <TextField label={t('compliance.countries.name')} value={form.countryName}
          onChange={(e) => setForm({ ...form, countryName: e.target.value })} required />
        <TextField label={t('compliance.countries.nameAr')} value={form.countryNameAr}
          onChange={(e) => setForm({ ...form, countryNameAr: e.target.value })} />
        <SelectField label={t('compliance.countries.source')} value={form.listSource}
          onChange={(e) => setForm({ ...form, listSource: e.target.value as typeof form.listSource })}
          options={['fatf_call_for_action', 'fatf_grey', 'un_sanctions', 'eu_consolidated', 'sama_circular', 'internal']
            .map((v) => ({ value: v, label: t(`compliance.source.${v}`) }))} />
        <SelectField label={t('compliance.countries.level')} value={form.riskLevel}
          onChange={(e) => setForm({ ...form, riskLevel: e.target.value as typeof form.riskLevel })}
          options={[
            { value: 'high', label: t('compliance.level.high') },
            { value: 'prohibited', label: t('compliance.level.prohibited') },
          ]}
          hint={t('compliance.countries.levelHint')} />
        <TextField label={t('compliance.countries.from')} type="date" value={form.effectiveFrom}
          onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} required />
        <TextField label={t('compliance.countries.note')} value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </div>
    </Modal>
  );
}

/* ── the metric tile ───────────────────────────────────────────────────────── */

function Metric({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'lime' | 'warning' | 'high' | 'critical' }) {
  /*
    ZERO IS NOT ALWAYS GOOD AND THE COLOUR KNOWS IT. `unable`, `reviewOverdue`, `openMatches`
    and `reportsLate` are neutral at zero and alarming above it; `complete` is the reverse.
    The caller decides which, because only the caller knows what the number means.
  */
  return (
    <div className={`firm-comp__metric firm-comp__metric--${tone}`}>
      <span className="firm-comp__metricValue num">{value}</span>
      <span className="firm-comp__metricLabel">{label}</span>
    </div>
  );
}
