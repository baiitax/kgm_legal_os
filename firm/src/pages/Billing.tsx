/**
 * THE MONEY CONSOLE · P2.3
 *
 * WHAT THIS SCREEN IS FOR, in one sentence: until now the firm could not bill from its
 * own system. Every invoice in this product was written by the seed fixture — the
 * console could approve, discount, write off, issue, report and cancel a document, and
 * had no way to create one, send one, or take the money it asked for. The three
 * permission codes that should have driven those writes (`billing.create`,
 * `billing.send`, `billing.record_payment`) were granted by the catalogue to four roles
 * and consulted by nothing at all.
 *
 * So this is not a new report over existing data. It is the entry point of the firm's
 * revenue: draft from unbilled work, release to the client, record what arrives.
 *
 * FOUR DECISIONS WORTH READING BEFORE CHANGING ANYTHING HERE
 *
 *   1 · THE LIST IS THE SERVER'S SCOPE, NOT A FILTER APPLIED HERE. `GET /billing/invoices`
 *       returns the rows for the matters this member may bill, computed from their own
 *       access levels. Nothing on this page narrows it, and nothing on this page could
 *       widen it: the screen never receives a row the member is not entitled to.
 *
 *   2 · INTERNAL STATE AND CLIENT STATE ARE TWO COLUMNS, NOT ONE. `internal_status` is
 *       what the firm has done to the document; `client_status` is whether the client can
 *       see it AT ALL, and it is null until the invoice is sent. Collapsing them into one
 *       "status" would either present a draft as visible, or hide a sent invoice's
 *       progress — and the second mistake is the one that costs money, because a firm
 *       chases a client for an invoice the client never received.
 *
 *   3 · THE THREE WRITES ARE GATED ON THE SAME CODES THE SERVER CHECKS. §50 has one rule:
 *       a screen may hide a control from a member who lacks the code, and can never grant
 *       one. Each button below reads its permission through `useCan()` — and if the
 *       permission set changes mid-session, the server still refuses.
 *
 *   4 · A REFUSAL IS RENDERED AS ITSELF. `engagement_gate` (Rule 12: no signed letter, no
 *       fee), `invoice_not_issued` (a draft has no fiscal identity to send),
 *       `overpayment` (money exceeding what is owed), `invoice_number_taken`,
 *       `already_billed` — each arrives with a code and each is shown in the screen's own
 *       words. A member told only "failed" asks a colleague instead of reading the file.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO
 *   It does not issue the invoice and it does not approve it. Both are on the matter's
 *   billing panel, where the fiscal identity, the device and the hash chain live, and
 *   both need `billing.approve` plus a financial ceiling — a partner's decision on a
 *   document, not a finance clerk's. This console ends at "sent" and "paid"; the
 *   invoice's own page picks up from there.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Card, CardBody, EmptyState, IconBilling, IconCheck, IconExpenses, IconArrowForward, IconPlus,
  IconRefresh, IconSearch, IconTime, IconTrash, Modal, PageSkeleton, SelectField, Table,
  TextArea, TextField, useI18n, useToast, type Column,
} from '@kgm/ui';
import {
  FirmApiError, firmApi, type CreatedInvoice, type FirmInvoiceDetail, type FirmInvoiceLine,
  type FirmInvoicePayment, type FirmInvoiceRow, type MatterBillingResponse,
} from '../api/firm.js';
import { useFirmSession } from '../auth/FirmSession.js';
import { InvoiceFiscalPanel } from './InvoiceFiscalPanel.js';
import '../shell/shell.css';

interface BillingProps {
  readonly onNavigate: (to: string) => void;
}

/** The internal states a member can filter by, in the order the money moves. */
const STATUS_FILTERS = [
  'all', 'draft', 'pending_internal_approval', 'approved', 'sent',
  'partially_paid', 'paid', 'overdue', 'written_off',
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number];

/** Tone per internal state. Anything the firm still has to act on is not green. */
const STATUS_TONE: Record<string, 'lime' | 'neutral' | 'warning' | 'high' | 'info'> = {
  draft: 'neutral',
  pending_internal_approval: 'warning',
  approved: 'info',
  sent: 'info',
  partially_paid: 'warning',
  paid: 'lime',
  overdue: 'high',
  cancelled: 'neutral',
  written_off: 'high',
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A refusal, said in this screen's words.
 *
 * The server's own message is the fallback and is used verbatim, because it is written
 * for a person — "a draft invoice cannot take a payment — issue it first, or record the
 * money in the client ledger" is more useful than any sentence this map could invent.
 */
function why(err: unknown, t: (k: string) => string): string {
  const code = err instanceof FirmApiError ? err.code : 'network_error';
  const known: Record<string, string> = {
    engagement_gate: t('money.err.engagementGate'),
    invoice_not_issued: t('money.err.notIssued'),
    invoice_number_taken: t('money.err.numberTaken'),
    overpayment: t('money.err.overpayment'),
    entry_already_billed: t('money.err.alreadyBilled'),
    not_billable: t('money.err.notBillable'),
    forbidden: t('money.err.permission'),
    validation_failed: t('money.err.validation'),
    network_error: t('money.err.network'),
  };
  return known[code] ?? (err instanceof Error ? err.message : t('money.err.other'));
}

export function Billing({ onNavigate }: BillingProps) {
  const { t, pick } = useI18n();
  const { can } = useFirmSession();

  const [rows, setRows] = useState<FirmInvoiceRow[] | null>(null);
  const [matterIds, setMatterIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FirmApiError | null>(null);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);

  const load = () => {
    setLoading(true);
    firmApi.invoices(status === 'all' ? {} : { status })
      .then((r) => { setRows(r.invoices); setMatterIds(r.matterIds); setError(null); })
      .catch((err) => {
        setRows(null);
        setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable'));
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [status]);

  /*
    THE TOTALS ARE COMPUTED FROM THE ROWS ON SCREEN, and they say so: a filter is a
    question, and the answer to "how much is outstanding" changes when the question does.
    A headline figure that ignored the filter would be a number nobody could reconcile
    with the table underneath it.
  */
  const totals = useMemo(() => {
    const list = rows ?? [];
    const outstanding = list.filter((r) => !['cancelled', 'written_off'].includes(r.internalStatus))
      .reduce((a, r) => a + r.outstanding, 0);
    const paid = list.reduce((a, r) => a + r.amountPaid, 0);
    return {
      count: list.length,
      outstanding,
      paid,
      awaitingRelease: list.filter((r) => ['draft', 'pending_internal_approval', 'approved'].includes(r.internalStatus)).length,
      unseenByClient: list.filter((r) => r.clientStatus === null && r.internalStatus !== 'draft').length,
    };
  }, [rows]);

  const visible = useMemo(() => {
    const list = rows ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) =>
      `${r.invoiceNumber} ${r.clientName ?? ''} ${r.clientNameAr ?? ''} ${r.matterNumber ?? ''}`
        .toLowerCase()
        .includes(q));
  }, [rows, query]);

  const columns: ReadonlyArray<Column<FirmInvoiceRow>> = [
    {
      key: 'number', header: t('money.col.number'), responsive: 'card', cardLabel: t('money.col.number'),
      width: '11rem',
      cell: (r) => <span className="num firm-money__num">{r.invoiceNumber}</span>,
      compare: (a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber),
    },
    {
      key: 'client', header: t('money.col.client'), responsive: 'card', cardLabel: t('money.col.client'),
      cell: (r) => {
        /* ARABIC FIRST, English as the fallback — the same `pick` convention the matters
           list uses, so a client with only one of the two names still reads. */
        const name = pick(r.clientNameAr, r.clientName);
        return (
          <span className="firm-money__who">
            <span>{name}</span>
            {r.matterNumber ? <span className="c-muted firm-money__matter">{r.matterNumber}</span> : null}
          </span>
        );
      },
      compare: (a, b) => (a.clientName ?? '').localeCompare(b.clientName ?? ''),
    },
    {
      key: 'issued', header: t('money.col.issued'), responsive: 'card', cardLabel: t('money.col.issued'),
      width: '7.5rem',
      /* The dot is not decoration: an unissued invoice has no UUID and no hash, and the
         client's copy does not exist yet. The list says so at a glance because the row is
         the only place a member will look before pressing Send. */
      cell: (r) => (
        <span className="firm-money__issued">
          {r.issued
            ? <Badge tone="info" size="xs">{t('money.issued')}</Badge>
            : <Badge tone="neutral" size="xs">{t('money.unissued')}</Badge>}
        </span>
      ),
      compare: (a, b) => Number(a.issued) - Number(b.issued),
    },
    {
      key: 'due', header: t('money.col.due'), responsive: 'card', cardLabel: t('money.col.due'),
      width: '7.5rem',
      cell: (r) => <span className="num">{r.dueDate}</span>,
      compare: (a, b) => a.dueDate.localeCompare(b.dueDate),
    },
    {
      key: 'total', header: t('money.col.total'), responsive: 'card', cardLabel: t('money.col.total'),
      width: '8.5rem', numeric: true,
      cell: (r) => <span className="num">{r.total.toFixed(2)}</span>,
      compare: (a, b) => a.total - b.total,
    },
    {
      key: 'outstanding', header: t('money.col.outstanding'), responsive: 'card', cardLabel: t('money.col.outstanding'),
      width: '8.5rem', numeric: true,
      cell: (r) => (
        <span className={r.outstanding > 0 ? 'num firm-money__owed' : 'num c-muted'}>
          {r.outstanding.toFixed(2)}
        </span>
      ),
      compare: (a, b) => a.outstanding - b.outstanding,
    },
    {
      key: 'status', header: t('money.col.status'), responsive: 'card', cardLabel: t('money.col.status'),
      width: '13rem',
      cell: (r) => (
        <span className="firm-money__status">
          <Badge tone={STATUS_TONE[r.internalStatus] ?? 'neutral'} size="xs">
            {t(`money.status.${r.internalStatus}` as never)}
          </Badge>
          {/* THE SECOND COLUMN THAT MATTERS. Null client status means the client cannot
              see this invoice at all — said out loud, because "approved" beside a document
              nobody has received looks like progress. */}
          <span className="c-muted firm-money__vis">
            {r.clientStatus === null ? t('money.notVisible') : t(`money.client.${r.clientStatus}` as never)}
          </span>
        </span>
      ),
      compare: (a, b) => a.internalStatus.localeCompare(b.internalStatus),
    },
  ];

  if (loading && rows === null) return <PageSkeleton />;

  if (error) {
    return (
      <div className="firm-page">
        <EmptyState
          kind="error"
          title={t('money.error.title')}
          description={t('money.error.body')}
          action={{ label: t('common.retry'), onClick: load }}
        />
      </div>
    );
  }

  return (
    <div className="firm-page">
      <header className="firm-pagehead">
        <div className="firm-pagehead__text">
          <p className="firm-pagehead__eyebrow">{t('nav.finance')}</p>
          <h1 className="firm-pagehead__title">{t('money.title')}</h1>
          <p className="firm-pagehead__sub">{t('money.subtitle', { n: matterIds.length })}</p>
        </div>
        <div className="firm-pagehead__actions">
          <Button variant="ghost" onClick={load}>
            <IconRefresh size={16} /> <span className="firm-btn__label">{t('common.refresh')}</span>
          </Button>
          {can('billing.create') ? (
            <Button variant="primary" onClick={() => setDrafting(true)}>
              <IconPlus size={16} /> <span className="firm-btn__label">{t('money.new')}</span>
            </Button>
          ) : null}
        </div>
      </header>

      <div className="firm-money__totals">
        <Card className="firm-money__stat">
          <CardBody>
            <span className="firm-money__statlabel">{t('money.stat.outstanding')}</span>
            <span className="num firm-money__statvalue">{totals.outstanding.toFixed(2)}</span>
            <span className="c-muted firm-money__statfoot">{t('money.stat.outstandingFoot')}</span>
          </CardBody>
        </Card>
        <Card className="firm-money__stat">
          <CardBody>
            <span className="firm-money__statlabel">{t('money.stat.received')}</span>
            <span className="num firm-money__statvalue">{totals.paid.toFixed(2)}</span>
            <span className="c-muted firm-money__statfoot">{t('money.stat.receivedFoot')}</span>
          </CardBody>
        </Card>
        <Card className="firm-money__stat">
          <CardBody>
            <span className="firm-money__statlabel">{t('money.stat.held')}</span>
            <span className="num firm-money__statvalue">{totals.awaitingRelease}</span>
            {/* The count that costs money when it is not watched: invoices the firm has
                approved or sent internally and not released to the client. */}
            <span className="c-muted firm-money__statfoot">{t('money.stat.heldFoot')}</span>
          </CardBody>
        </Card>
      </div>

      <div className="firm-money__filters" role="tablist" aria-label={t('money.filter')}>
        {STATUS_FILTERS.map((s) => (
          <Button
            key={s}
            variant={status === s ? 'primary' : 'ghost'}
            size="sm"
            role="tab"
            aria-selected={status === s}
            onClick={() => setStatus(s)}
          >
            {t(`money.filter.${s}` as never)}
          </Button>
        ))}
      </div>

      <Table
        columns={columns}
        rows={visible}
        rowKey={(r) => r.id}
        label={t('money.title')}
        density="compact"
        loading={loading}
        empty={(
          <EmptyState
            kind="empty"
            title={t('money.empty.title')}
            description={matterIds.length === 0 ? t('money.empty.noScope') : t('money.empty.body')}
            action={can('billing.create') ? { label: t('money.new'), onClick: () => setDrafting(true) } : undefined}
          />
        )}
        onRowClick={(r) => setOpenId(r.id)}
        toolbarStart={(
          <TextField
            type="search"
            label={t('money.search')}
            labelClassName="sr-only"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('money.search')}
            leadingIcon={<IconSearch size={16} />}
          />
        )}
      />

      {openId ? (
        <InvoicePanel
          invoiceId={openId}
          onClose={() => setOpenId(null)}
          onChanged={load}
          onOpenMatter={onNavigate}
        />
      ) : null}

      {drafting ? (
        <NewInvoiceDialog
          onClose={() => setDrafting(false)}
          onCreated={(created) => { setDrafting(false); load(); setOpenId(created.id); }}
        />
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ONE INVOICE · what it bills, what has been paid, and the two writes left
   ═══════════════════════════════════════════════════════════════════════════════ */

function InvoicePanel({
  invoiceId, onClose, onChanged, onOpenMatter,
}: {
  invoiceId: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenMatter: (to: string) => void;
}) {
  const { t, pick } = useI18n();
  const { can } = useFirmSession();
  const toast = useToast();
  const [detail, setDetail] = useState<FirmInvoiceDetail | null>(null);
  const [error, setError] = useState<FirmApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = () => {
    firmApi.invoice(invoiceId)
      .then((d) => { setDetail(d); setError(null); })
      .catch((err) => setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable')));
  };

  useEffect(load, [invoiceId]);

  async function send() {
    setBusy(true);
    try {
      await firmApi.sendInvoice(invoiceId);
      toast.success(t('money.sent'), t('money.sentBody'));
      load();
      onChanged();
    } catch (err) {
      toast.error(t('money.sendFailed'), why(err, t));
    } finally {
      setBusy(false);
    }
  }

  const lineColumns: ReadonlyArray<Column<FirmInvoiceLine>> = [
    {
      key: 'description', header: t('money.line.description'), responsive: 'card', cardLabel: t('money.line.description'),
      cell: (l) => (
        <span className="firm-money__line">
          <span>{pick(l.descriptionAr, l.description)}</span>
          {/* WHERE THE LINE CAME FROM. `time:<id>` is a recorded hour and `expense:<id>` is
              a disbursement being passed on; a manual line has no source and says so. The
              source is also what makes the same hour impossible to bill twice. */}
          <span className="c-muted firm-money__src">
            {l.billingSourceKey
              ? `${t(l.billingSourceKey.startsWith('time:') ? 'money.src.time' : 'money.src.expense')}`
              : t('money.src.manual')}
          </span>
        </span>
      ),
    },
    { key: 'qty', header: t('money.line.qty'), width: '5rem', numeric: true, responsive: 'card', cardLabel: t('money.line.qty'), cell: (l) => <span className="num">{l.quantity}</span> },
    { key: 'rate', header: t('money.line.rate'), width: '7rem', numeric: true, responsive: 'card', cardLabel: t('money.line.rate'), cell: (l) => <span className="num">{l.unitPrice.toFixed(2)}</span> },
    {
      key: 'vat', header: t('money.line.vat'), width: '6rem', numeric: true, responsive: 'card', cardLabel: t('money.line.vat'),
      /* A line's VAT is per line, not per invoice: a file with a zero-rated export and a
         standard-rated consultation cannot be expressed with one rate. */
      cell: (l) => <span className="num c-muted">{Math.round(l.vatRate * 100)}%</span>,
    },
    { key: 'amount', header: t('money.line.amount'), width: '8rem', numeric: true, responsive: 'card', cardLabel: t('money.line.amount'), cell: (l) => <span className="num">{l.amount.toFixed(2)}</span> },
  ];

  const paymentColumns: ReadonlyArray<Column<FirmInvoicePayment>> = [
    { key: 'when', header: t('money.pay.when'), width: '9rem', responsive: 'card', cardLabel: t('money.pay.when'), cell: (p) => <span className="num">{p.createdAt.slice(0, 10)}</span> },
    { key: 'how', header: t('money.pay.how'), width: '9rem', responsive: 'card', cardLabel: t('money.pay.how'), cell: (p) => <Badge tone="neutral" size="xs">{p.provider.replace(/_/g, ' ')}</Badge> },
    {
      key: 'ref', header: t('money.pay.ref'), responsive: 'card', cardLabel: t('money.pay.ref'),
      /* A receipt with no reference is a cash payment, not a missing value. Shown as
         such, because a blank cell in a reconciliation looks like a bug. */
      cell: (p) => p.receiptNumber
        ? <span className="num firm-money__num">{p.receiptNumber}</span>
        : <span className="c-muted">{t('money.pay.noRef')}</span>,
    },
    { key: 'amount', header: t('money.pay.amount'), width: '9rem', numeric: true, responsive: 'card', cardLabel: t('money.pay.amount'), cell: (p) => <span className="num firm-money__paid">{p.amount.toFixed(2)}</span> },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={detail ? detail.invoiceNumber : t('money.loading')}
      description={detail ? (detail.matterTitle ?? undefined) : undefined}
      footer={(
        <>
          {detail?.matterId ? (
            <Button variant="ghost" onClick={() => onOpenMatter(`/matters/${encodeURIComponent(detail.matterId as string)}`)}>
              {t('money.openMatter')}
            </Button>
          ) : null}
          <span className="firm-money__spacer" />
          {detail && can('billing.record_payment') && detail.outstanding > 0 && detail.issued ? (
            <Button variant="ghost" onClick={() => setPaying(true)}>
              <IconCheck size={16} /> <span className="firm-btn__label">{t('money.recordPayment')}</span>
            </Button>
          ) : null}
          {detail && can('billing.send') && detail.issued && detail.internalStatus === 'approved' ? (
            <Button variant="primary" loading={busy} onClick={() => { void send(); }}>
              <IconArrowForward size={16} /> <span className="firm-btn__label">{t('money.send')}</span>
            </Button>
          ) : null}
          {/*
            THE WAY OUT OF A MISTAKE. Offered only where the server would allow it: a
            draft that has not been issued, to a member who may draft. An issued invoice
            gets nothing here — its remedy is a credit note, and a button that produced a
            409 would teach the member that the screen does not know the rules.
          */}
          {detail && can('billing.create') && !detail.issued
            && ['draft', 'pending_internal_approval'].includes(detail.internalStatus) ? (
            <Button variant="ghost" onClick={() => setCancelling(true)}>
              <IconTrash size={16} /> <span className="firm-btn__label">{t('money.cancel')}</span>
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        </>
      )}
    >
      {error ? (
        <EmptyState kind="error" title={t('money.error.title')} description={why(error, t)} action={{ label: t('common.retry'), onClick: load }} />
      ) : !detail ? (
        <PageSkeleton />
      ) : (
        <div className="firm-panel__sections">
          <Card variant="default" className="firm-billinghead">
            <CardBody>
              <div className="firm-billinghead__row">
                <Badge tone={STATUS_TONE[detail.internalStatus] ?? 'neutral'} size="sm">
                  {t(`money.status.${detail.internalStatus}` as never)}
                </Badge>
                {detail.issued
                  ? <Badge tone="info" size="xs">{t('money.issued')}</Badge>
                  : <Badge tone="warning" size="xs">{t('money.notIssuedWhy')}</Badge>}
                {detail.clientStatus === null
                  ? <Badge tone="neutral" size="xs">{t('money.notVisible')}</Badge>
                  : <Badge tone="lime" size="xs">{t(`money.client.${detail.clientStatus}` as never)}</Badge>}
              </div>

              <dl className="firm-deflist firm-deflist--inline">
                <div className="firm-deflist__row"><dt>{t('money.col.client')}</dt>
                  <dd>{pick(detail.clientNameAr, detail.clientName)}</dd></div>
                <div className="firm-deflist__row"><dt>{t('money.col.issued')}</dt>
                  <dd className="num">{detail.issueDate}</dd></div>
                <div className="firm-deflist__row"><dt>{t('money.col.due')}</dt>
                  <dd className="num">{detail.dueDate}</dd></div>
                <div className="firm-deflist__row"><dt>{t('money.panel.subtotal')}</dt>
                  <dd className="num">{detail.subtotal.toFixed(2)}</dd></div>
                <div className="firm-deflist__row"><dt>{t('money.panel.vat')}</dt>
                  <dd className="num">{detail.vatAmount.toFixed(2)}</dd></div>
                <div className="firm-deflist__row"><dt>{t('money.col.total')}</dt>
                  <dd className="num">{detail.total.toFixed(2)}</dd></div>
                <div className="firm-deflist__row"><dt>{t('money.panel.paid')}</dt>
                  <dd className="num">{detail.amountPaid.toFixed(2)}</dd></div>
                <div className="firm-deflist__row"><dt>{t('money.col.outstanding')}</dt>
                  <dd className="num firm-money__owed">{detail.outstanding.toFixed(2)}</dd></div>
                {detail.icv !== null ? (
                  <div className="firm-deflist__row"><dt>{t('money.panel.icv')}</dt>
                    <dd className="num">{detail.icv}</dd></div>
                ) : null}
                {detail.invoiceUuid ? (
                  <div className="firm-deflist__row"><dt>{t('money.panel.uuid')}</dt>
                    <dd className="num firm-money__num">{detail.invoiceUuid}</dd></div>
                ) : null}
                {detail.clientVatNumber ? (
                  <div className="firm-deflist__row"><dt>{t('money.panel.buyerVat')}</dt>
                    <dd className="num">{detail.clientVatNumber}</dd></div>
                ) : null}
              </dl>

              {detail.notesInternal ? (
                <p className="firm-panel__note">
                  <strong>{t('money.panel.internal')}</strong> {detail.notesInternal}
                </p>
              ) : null}
            </CardBody>
          </Card>

          {/*
            THE FISCAL LIFECYCLE, between the header and the lines.

            Placed high on purpose: an invoice that is approved but NOT ISSUED is the
            commonest stuck state in this console, and the reader's question ("can I send
            this?") is answered by the panel above the arithmetic, not below it.
          */}
          <InvoiceFiscalPanel
            invoice={detail}
            /* Reload THIS invoice and the list behind it: issuing changes the row's
               fiscal identity, and the list's "issued / not issued" badge is how a member
               finds the documents still waiting on this panel. */
            onChanged={() => { load(); onChanged(); }}
          />

          <section>
            <h3 className="firm-panel__subhead">{t('money.panel.lines')} · {detail.lines.length}</h3>
            <Table
              columns={lineColumns}
              rows={detail.lines}
              rowKey={(l) => l.id}
              label={t('money.panel.lines')}
              density="compact"
            />
          </section>

          <section>
            <h3 className="firm-panel__subhead">{t('money.panel.receipts')} · {detail.payments.length}</h3>
            {detail.payments.length === 0 ? (
              <p className="c-muted firm-panel__note">{t('money.panel.noReceipts')}</p>
            ) : (
              <Table
                columns={paymentColumns}
                rows={detail.payments}
                rowKey={(p) => p.id}
                label={t('money.panel.receipts')}
                density="compact"
              />
            )}
          </section>
        </div>
      )}

      {cancelling && detail ? (
        <CancelDraftDialog
          invoice={detail}
          onClose={() => setCancelling(false)}
          onCancelled={() => { setCancelling(false); onClose(); onChanged(); }}
        />
      ) : null}

      {paying && detail ? (
        <RecordPaymentDialog
          invoice={detail}
          onClose={() => setPaying(false)}
          onRecorded={() => { setPaying(false); load(); onChanged(); }}
        />
      ) : null}
    </Modal>
  );
}

/**
 * CANCEL A DRAFT.
 *
 * The reason is required, and that is the whole design of this dialog. Cancelling is the
 * only trace left of an invoice that was drafted and taken back — the row stays, the lines
 * stay, and the reason is what explains them a year later when somebody asks why a number
 * in the firm's series has a hole in it.
 */
function CancelDraftDialog({
  invoice, onClose, onCancelled,
}: {
  invoice: FirmInvoiceDetail;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const sourced = invoice.lines.filter((l) => l.billingSourceKey !== null).length;

  async function submit() {
    setBusy(true);
    try {
      const res = await firmApi.cancelInvoice(invoice.id, reason.trim());
      /* WHAT CAME BACK IS SAID OUT LOUD. The member's next question is whether the hour
         they mistakenly billed is usable again, and the answer is a number. */
      toast.success(t('money.cancelled'), t('money.cancelledBody', {
        time: res.releasedTime, expenses: res.releasedExpenses,
      }));
      onCancelled();
    } catch (err) {
      toast.error(t('money.cancelFailed'), why(err, t));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('money.cancel')}
      description={t('money.cancelBody', { number: invoice.invoiceNumber })}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={reason.trim().length < 5}
            onClick={() => { void submit(); }}
          >
            {t('money.cancelAction')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField
          label={t('money.cancelReason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint={t('money.cancelReasonHint')}
        />
        {sourced > 0 ? (
          <p className="firm-panel__note">{t('money.cancelReturns', { n: sourced })}</p>
        ) : null}
      </div>
    </Modal>
  );
}

function RecordPaymentDialog({
  invoice, onClose, onRecorded,
}: {
  invoice: FirmInvoiceDetail;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [amount, setAmount] = useState(invoice.outstanding.toFixed(2));
  const [provider, setProvider] = useState<'bank_transfer' | 'sadad' | 'manual'>('bank_transfer');
  const [reference, setReference] = useState('');
  const [receivedOn, setReceivedOn] = useState(today());
  const [busy, setBusy] = useState(false);

  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed > 0 && parsed <= invoice.outstanding + 0.005;

  async function submit() {
    setBusy(true);
    try {
      const res = await firmApi.recordInvoicePayment(invoice.id, {
        amount: parsed,
        provider,
        reference: reference.trim() || null,
        receivedOn,
      });
      toast.success(t('money.paymentRecorded'), t('money.paymentRecordedBody', {
        paid: res.amountPaid.toFixed(2), left: res.outstanding.toFixed(2),
      }));
      onRecorded();
    } catch (err) {
      toast.error(t('money.paymentFailed'), why(err, t));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('money.recordPayment')}
      description={t('money.recordPaymentBody', { n: invoice.outstanding.toFixed(2) })}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => { void submit(); }}>
            {t('money.recordPayment')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField
          label={t('money.pay.amount')}
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
          hint={t('money.pay.amountHint')}
        />
        <SelectField
          label={t('money.pay.how')}
          value={provider}
          onChange={(e) => setProvider(e.target.value as 'bank_transfer' | 'sadad' | 'manual')}
          options={[
            { value: 'bank_transfer', label: t('money.provider.bank') },
            { value: 'sadad', label: t('money.provider.sadad') },
            { value: 'manual', label: t('money.provider.manual') },
          ]}
        />
        <TextField
          label={t('money.pay.ref')}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          hint={t('money.pay.refHint')}
        />
        <TextField
          label={t('money.pay.when')}
          type="date"
          value={receivedOn}
          onChange={(e) => setReceivedOn(e.target.value)}
        />
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   NEW INVOICE · the write the firm did not have
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * THE DRAFT DIALOG, AND THE ONE THING IT MUST GET RIGHT.
 *
 * An invoice is built from RECORDED WORK or from a FEE, and both are allowed at once. The
 * dialog therefore asks for the matter first and then loads that matter's billing panel —
 * the same payload the matter's own Billing tab renders — because the two questions a
 * member has at this moment are already answered there: can this matter be billed at all
 * (a signed engagement letter and terms in force, Rule 12), and what is recorded and
 * unbilled. Loading it again here would be a second reading of the same rows, and the two
 * would eventually disagree about which hour is available.
 *
 * The totals shown are the SERVER'S once the invoice exists; before that they are computed
 * here from the selection so the member can see what they are about to charge. The server
 * recomputes from the lines regardless — the number that reaches the client is never the
 * one the browser sent.
 */
function NewInvoiceDialog({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (created: CreatedInvoice) => void;
}) {
  const { t, pick } = useI18n();
  const toast = useToast();

  const [matters, setMatters] = useState<Array<{ id: string; matterNumber: string | null; title: string | null; clientName: string | null }>>([]);
  const [matterId, setMatterId] = useState('');
  const [billing, setBilling] = useState<MatterBillingResponse | null>(null);
  const [loadingBilling, setLoadingBilling] = useState(false);
  const [timeIds, setTimeIds] = useState<Set<string>>(new Set());
  const [expenseIds, setExpenseIds] = useState<Set<string>>(new Set());
  const [fees, setFees] = useState<Array<{ description: string; quantity: string; unitPrice: string }>>([]);
  const [notes, setNotes] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    firmApi.matters()
      .then((r) => {
        if (!alive) return;
        setMatters(r.matters.map((m) => ({
          id: m.id, matterNumber: m.matterNumber, title: m.title, clientName: m.clientName,
        })));
      })
      .catch(() => { if (alive) setMatters([]); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!matterId) { setBilling(null); return; }
    let alive = true;
    setLoadingBilling(true);
    setTimeIds(new Set());
    setExpenseIds(new Set());
    firmApi.matterBilling(matterId)
      .then((d) => { if (alive) setBilling(d); })
      .catch(() => { if (alive) setBilling(null); })
      .finally(() => { if (alive) setLoadingBilling(false); });
    return () => { alive = false; };
  }, [matterId]);

  /** Unbilled hours and approved disbursements, as the matter's own panel projects them. */
  const timeRows = useMemo(() => (billing?.time ?? []).filter((r) => {
    const s = String(r.status ?? '');
    return (s === 'submitted' || s === 'approved') && r.billable !== false;
  }), [billing]);

  const expenseRows = useMemo(
    () => (billing?.expenses ?? []).filter((r) => String(r.status ?? '') === 'approved'),
    [billing]);

  const preview = useMemo(() => {
    let net = 0;
    let vat = 0;
    for (const id of timeIds) {
      const r = timeRows.find((x) => String(x.id) === id);
      if (!r) continue;
      const amount = Number(r.amount ?? 0);
      net += amount;
      vat += amount * 0.15;
    }
    for (const id of expenseIds) {
      const r = expenseRows.find((x) => String(x.id) === id);
      if (!r) continue;
      /* A disbursement is billed at its NET — the VAT the firm already paid on it is
         carried as the line's own treatment, not charged again. */
      const n = Number(r.netAmountSar ?? 0);
      net += n;
      vat += n * Number(r.vatRate ?? 0);
    }
    for (const f of fees) {
      const qty = Number(f.quantity);
      const rate = Number(f.unitPrice);
      if (!Number.isFinite(qty) || !Number.isFinite(rate)) continue;
      const amount = qty * rate;
      net += amount;
      vat += amount * 0.15;
    }
    return { net, vat, total: net + vat };
  }, [timeIds, expenseIds, fees, timeRows, expenseRows]);

  const ready = matterId !== '' &&
    (timeIds.size > 0 || expenseIds.size > 0 || fees.some((f) => f.description.trim().length >= 3 && Number(f.unitPrice) > 0));

  async function submit() {
    setBusy(true);
    try {
      const created = await firmApi.createInvoice({
        matterId,
        timeEntryIds: [...timeIds],
        expenseIds: [...expenseIds],
        lines: fees
          .filter((f) => f.description.trim().length >= 3 && Number(f.unitPrice) > 0)
          .map((f) => ({
            description: f.description.trim(),
            quantity: Number(f.quantity) || 1,
            unitPrice: Number(f.unitPrice),
          })),
        notesInternal: notes.trim() || null,
        dueDate: dueDate || undefined,
      });

      /* THE SHORTFALL IS ANNOUNCED, NOT SWALLOWED. If another draft took one of the
         selected hours between the read and the write, the invoice is smaller than the
         member asked for — and they must be told, because the alternative is a firm that
         quietly bills less than it did. */
      if (created.shortfall > 0) {
        toast.info(t('money.createdPartial'), t('money.createdPartialBody', {
          number: created.invoiceNumber, n: created.shortfall,
        }));
      } else {
        toast.success(t('money.created'), t('money.createdBody', {
          number: created.invoiceNumber, total: created.total.toFixed(2),
        }));
      }
      onCreated(created);
    } catch (err) {
      toast.error(t('money.createFailed'), why(err, t));
      setBusy(false);
    }
  }

  const toggle = (set: Set<string>, id: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    apply(next);
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('money.new')}
      description={t('money.newBody')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => { void submit(); }}>
            {t('money.newAction')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <SelectField
          label={t('money.form.matter')}
          value={matterId}
          onChange={(e) => setMatterId(e.target.value)}
          options={[
            { value: '', label: t('money.form.matterPick') },
            ...matters.map((m) => ({
              value: m.id,
              label: `${m.matterNumber ?? ''} · ${pick(null, m.title)}${m.clientName ? ` — ${m.clientName}` : ''}`,
            })),
          ]}
        />

        {/* ── THE RULE 12 ANSWER, BEFORE ANYTHING CAN BE SELECTED ── */}
        {matterId && billing ? (
          billing.billable ? (
            <p className="firm-panel__note">
              <Badge tone="lime" size="xs">{t('panel.billing.billable')}</Badge>{' '}
              {billing.terms ? `${billing.terms.basis.replace(/_/g, ' ')} · ${billing.unbilled.total.toFixed(2)}` : ''}
            </p>
          ) : (
            <div className="firm-money__blocker" role="status">
              <Badge tone="warning" size="xs">{t('panel.billing.notBillable')}</Badge>
              <span>
                {billing.blockers.map((b) => t(`money.blocker.${b}` as never)).join(' · ')}
              </span>
            </div>
          )
        ) : null}

        {loadingBilling ? <PageSkeleton /> : null}

        {matterId && billing && billing.billable ? (
          <>
            <section>
              <h3 className="firm-panel__subhead">
                <IconTime size={14} /> {t('money.form.time')} · {timeRows.length}
              </h3>
              {timeRows.length === 0 ? (
                <p className="c-muted firm-panel__note">{t('money.form.noTime')}</p>
              ) : (
                <ul className="firm-money__pick">
                  {timeRows.map((r) => {
                    const id = String(r.id);
                    return (
                      <li key={id}>
                        <label className="firm-money__option">
                          <input
                            type="checkbox"
                            checked={timeIds.has(id)}
                            onChange={() => toggle(timeIds, id, setTimeIds)}
                          />
                          <span className="firm-money__optionmain">
                            <span className="num">{String(r.date)}</span> · {String(r.staffName)} · {pick((r.narrativeAr as string | null) ?? null, String(r.narrative))}
                          </span>
                          <span className="num firm-money__optionamt">{Number(r.amount).toFixed(2)}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section>
              <h3 className="firm-panel__subhead">
                <IconExpenses size={14} /> {t('money.form.expenses')} · {expenseRows.length}
              </h3>
              {expenseRows.length === 0 ? (
                <p className="c-muted firm-panel__note">{t('money.form.noExpenses')}</p>
              ) : (
                <ul className="firm-money__pick">
                  {expenseRows.map((r) => {
                    const id = String(r.id);
                    return (
                      <li key={id}>
                        <label className="firm-money__option">
                          <input
                            type="checkbox"
                            checked={expenseIds.has(id)}
                            onChange={() => toggle(expenseIds, id, setExpenseIds)}
                          />
                          <span className="firm-money__optionmain">
                            <span className="num">{String(r.incurredOn)}</span> · {String(r.category).replace(/_/g, ' ')} · {pick((r.descriptionAr as string | null) ?? null, String(r.description))}
                          </span>
                          <span className="num firm-money__optionamt">{Number(r.netAmountSar).toFixed(2)}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        ) : null}

        {/* ── A FEE THAT IS NOT MADE OF HOURS: a fixed fee, a stage payment ── */}
        {matterId ? (
          <section>
            <h3 className="firm-panel__subhead">
              <IconBilling size={14} /> {t('money.form.fees')}
            </h3>
            {fees.map((f, i) => (
              <div className="firm-money__feerow" key={i}>
                <TextField
                  label={t('money.form.feeDesc')}
                  value={f.description}
                  onChange={(e) => setFees(fees.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                />
                <TextField
                  label={t('money.form.feeQty')}
                  value={f.quantity}
                  inputMode="decimal"
                  onChange={(e) => setFees(fees.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                />
                <TextField
                  label={t('money.form.feeRate')}
                  value={f.unitPrice}
                  inputMode="decimal"
                  onChange={(e) => setFees(fees.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))}
                />
                <Button variant="ghost" size="sm" onClick={() => setFees(fees.filter((_, j) => j !== i))}>
                  {t('common.remove')}
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFees([...fees, { description: '', quantity: '1', unitPrice: '' }])}
            >
              <IconPlus size={14} /> {t('money.form.addFee')}
            </Button>
          </section>
        ) : null}

        {matterId ? (
          <>
            <TextField
              label={t('money.form.dueDate')}
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              hint={t('money.form.dueHint')}
            />
            <TextArea
              label={t('money.form.notes')}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              hint={t('money.form.notesHint')}
            />

            {/* WHAT THE CLIENT WILL BE ASKED FOR. Computed here so the member sees the
                figure before committing; recomputed by the server from the lines, which
                is the number that counts. */}
            <dl className="firm-deflist firm-deflist--inline firm-money__preview">
              <div className="firm-deflist__row"><dt>{t('money.panel.subtotal')}</dt>
                <dd className="num">{preview.net.toFixed(2)}</dd></div>
              <div className="firm-deflist__row"><dt>{t('money.panel.vat')}</dt>
                <dd className="num">{preview.vat.toFixed(2)}</dd></div>
              <div className="firm-deflist__row"><dt>{t('money.col.total')}</dt>
                <dd className="num firm-money__total">{preview.total.toFixed(2)}</dd></div>
            </dl>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
