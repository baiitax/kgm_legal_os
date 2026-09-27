/**
 * THE LIFE OF A TAX INVOICE · recommendation 6 of the audit, the billing half
 *
 * WHAT THIS PANEL CLOSES. The money console could draft an invoice, approve it, send it
 * and take the money for it — and there it stopped. The four acts that make the document
 * a TAX document were all built on the server and reachable from no screen:
 *
 *   issue        allocates the next counter, links the hash chain, builds the QR and the
 *                UBL XML, stamps the UUID. Without it an invoice is a quotation with a
 *                number on it.
 *   submissions  records what the authority answered — clearance for a standard invoice
 *                (before it may go to the client) or reporting within 24 hours for a
 *                simplified one.
 *   credit note  the ONLY correction an issued invoice admits. The document is immutable:
 *                its ICV and its hash are already in a chain.
 *   write-off    stops the firm collecting, and deliberately does NOT touch the tax.
 *
 * WHY THESE ARE FOUR CONTROLS AND NOT ONE. Each is a separate deliberate act by a
 * different competence — issuing needs approval of the amount, a discount needs authority
 * over a percentage, a write-off needs authority over the sum being abandoned — and the
 * server checks each. A single "finish invoice" button would hide four decisions behind
 * one click and would teach the member that the rules are a formality.
 *
 * WHAT IT REFUSES TO PRETEND. Nothing here talks to the authority. `recordSubmission` is
 * a record of an answer that arrived elsewhere, and it says so on the form. The audit's
 * central finding was that documents LOOKED issued while nothing had been sent; a panel
 * that implied otherwise would be rebuilding the same lie one layer up.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, Card, CardBody, EmptyState, IconCheck, IconDownload,
  IconExternal, IconShieldCheck, IconTrash, Modal, SelectField, Table, TextField,
  useI18n, useToast, type Column,
} from '@kgm/ui';
import {
  FirmApiError, firmApi, type FiscalDevice, type InvoiceFiscalResponse,
  type FiscalSubmission, type FirmInvoiceDetail,
} from '../api/firm.js';
import { useFirmSession } from '../auth/FirmSession.js';

const SUBMISSION_TONE: Record<string, 'lime' | 'warning' | 'high' | 'neutral'> = {
  cleared: 'lime',
  reported: 'lime',
  pending: 'warning',
  submitted: 'warning',
  failed: 'high',
  rejected: 'high',
  timed_out: 'high',
};

interface Props {
  readonly invoice: FirmInvoiceDetail;
  /** Called after anything that changes the document, so the console reloads it. */
  readonly onChanged: () => void;
}

export function InvoiceFiscalPanel({ invoice, onChanged }: Props) {
  const { t } = useI18n();
  const { can } = useFirmSession();
  const toast = useToast();

  const [fiscal, setFiscal] = useState<InvoiceFiscalResponse | null>(null);
  const [devices, setDevices] = useState<FiscalDevice[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const [discounting, setDiscounting] = useState(false);
  const [writingOff, setWritingOff] = useState(false);

  const reload = useCallback(() => {
    if (!invoice.issued) {
      /* Nothing is issued yet, so there is no fiscal identity to read — only the devices
         that could issue one, which is what the issue form needs. */
      firmApi.fiscalIdentity()
        .then((r) => { setDevices(r.devices.filter((d) => d.isActive)); setLoadError(null); })
        .catch(() => setDevices([]));
      return;
    }
    firmApi.invoiceFiscal(invoice.id)
      .then((r) => { setFiscal(r); setLoadError(null); })
      .catch((err) => setLoadError(err instanceof FirmApiError ? err.message : String(err)));
  }, [invoice.id, invoice.issued]);

  useEffect(reload, [reload]);

  /* ── the four acts ─────────────────────────────────────────────────────────── */

  async function issue(body: { subtype: 'standard' | 'simplified'; deviceId?: string; supplyAt?: string }) {
    setBusy(true);
    try {
      const issued = await firmApi.issueInvoice(invoice.id, body);
      toast.success(
        t('fiscal2.issued'),
        t('fiscal2.issuedBody', { number: issued.invoiceNumber, icv: String(issued.icv) }),
      );
      setIssuing(false);
      reload();
      onChanged();
    } catch (err) {
      toast.error(t('fiscal2.issueFailed'), err instanceof FirmApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function creditNote(body: { reason: string; amount: number; vatAmount: number; creditNumber: string; deviceId?: string }) {
    setBusy(true);
    try {
      const note = await firmApi.creditNote(invoice.id, body);
      toast.success(t('fiscal2.credited'), t('fiscal2.creditedBody', { number: body.creditNumber, icv: String(note.icv) }));
      setCrediting(false);
      reload();
      onChanged();
    } catch (err) {
      toast.error(t('fiscal2.creditFailed'), err instanceof FirmApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function writeOff(reason: string) {
    setBusy(true);
    try {
      await firmApi.writeOff(invoice.id, reason);
      toast.success(t('fiscal2.writtenOff'), t('fiscal2.writtenOffBody'));
      setWritingOff(false);
      reload();
      onChanged();
    } catch (err) {
      toast.error(t('fiscal2.writeOffFailed'), err instanceof FirmApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function discount(newSubtotal: number, reason: string) {
    setBusy(true);
    try {
      await firmApi.applyDiscount(invoice.id, { newSubtotal, reason });
      toast.success(t('fiscal2.discounted'), t('fiscal2.discountedBody'));
      setDiscounting(false);
      reload();
      onChanged();
    } catch (err) {
      toast.error(t('fiscal2.discountFailed'), err instanceof FirmApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const submissionColumns: ReadonlyArray<Column<FiscalSubmission>> = [
    {
      key: 'when', header: t('fiscal2.sub.when'), width: '11rem', responsive: 'card',
      cardLabel: t('fiscal2.sub.when'),
      cell: (s) => <span className="num">{(s.submittedAt ?? '').slice(0, 16).replace('T', ' ') || '—'}</span>,
    },
    {
      key: 'what', header: t('fiscal2.sub.what'), responsive: 'card', cardLabel: t('fiscal2.sub.what'),
      cell: (s) => <span>{t(`fiscal2.sub.type.${s.type}`)} · {t('fiscal2.sub.attempt', { n: String(s.attempt) })}</span>,
    },
    {
      key: 'status', header: t('fiscal2.sub.status'), width: '10rem', responsive: 'card',
      cardLabel: t('fiscal2.sub.status'),
      cell: (s) => <Badge tone={SUBMISSION_TONE[s.status] ?? 'neutral'} size="sm">{t(`fiscal2.sub.state.${s.status}`)}</Badge>,
    },
    {
      key: 'code', header: t('fiscal2.sub.code'), width: '9rem', responsive: 'card',
      cardLabel: t('fiscal2.sub.code'),
      cell: (s) => (
        <span className="num c-muted">
          {s.httpStatus ? `${s.httpStatus}${s.responseCode ? ` / ${s.responseCode}` : ''}` : '—'}
        </span>
      ),
    },
    {
      /* The warning text is the authority's own wording, kept verbatim: paraphrasing a
         regulator's warning is how a real obligation gets lost in translation. */
      key: 'said', header: t('fiscal2.sub.said'), responsive: 'card', cardLabel: t('fiscal2.sub.said'),
      cell: (s) => (
        <span className="firm-fiscal__said">
          {s.errors ? <span className="firm-fiscal__errtxt">{s.errors}</span> : null}
          {s.warnings ? <span className="c-muted">{s.warnings}</span> : null}
          {!s.errors && !s.warnings ? <span className="c-muted">—</span> : null}
        </span>
      ),
    },
  ];

  const canIssue = can('billing.approve');
  const status = fiscal?.fiscal.status ?? (invoice.invoiceType ? 'pending' : 'not_issued');

  return (
    <Card variant="default" className="firm-fiscal__panel">
      <CardBody>
        <div className="firm-fiscal__sectionHead">
          <h3 className="firm-panel__subhead">{t('fiscal2.title')}</h3>
          <Badge tone={invoice.issued ? 'lime' : 'neutral'} size="sm">
            {invoice.issued ? t(`money.status.${invoice.internalStatus}` as never) : t('fiscal2.draft')}
          </Badge>
        </div>

        {loadError ? <p className="firm-panel__note">{loadError}</p> : null}

        {/* ── NOT ISSUED: the gate, and the way through it ───────────────────── */}
        {!invoice.issued ? (
          <>
            <p className="firm-panel__note">{t('fiscal2.draftBody')}</p>
            <div className="firm-fiscal__actions">
              {canIssue ? (
                <Button variant="primary" icon={<IconShieldCheck size={16} />} onClick={() => setIssuing(true)}>
                  {t('fiscal2.issue')}
                </Button>
              ) : (
                /* A member who may draft but not approve is told WHY the button is absent,
                   rather than left wondering whether the screen is broken. */
                <span className="c-muted firm-fiscal__hint">{t('fiscal2.needApprove')}</span>
              )}
              {can('billing.discount') && invoice.internalStatus === 'draft' ? (
                <Button variant="ghost" onClick={() => setDiscounting(true)}>{t('fiscal2.discount')}</Button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <dl className="firm-deflist firm-deflist--inline">
              <div className="firm-deflist__row"><dt>{t('fiscal2.uuid')}</dt>
                <dd className="num firm-money__num">{fiscal?.fiscal.uuid ?? invoice.invoiceUuid ?? '—'}</dd></div>
              <div className="firm-deflist__row"><dt>{t('money.panel.icv')}</dt>
                <dd className="num">{fiscal?.fiscal.icv ?? invoice.icv ?? '—'}</dd></div>
              <div className="firm-deflist__row"><dt>{t('fiscal2.subtype')}</dt>
                <dd>{fiscal?.fiscal.subtype ? t(`fiscal2.type.${fiscal.fiscal.subtype}`) : '—'}</dd></div>
              <div className="firm-deflist__row"><dt>{t('fiscal2.supplyAt')}</dt>
                <dd className="num">{fiscal?.fiscal.supplyAt ? String(fiscal.fiscal.supplyAt).slice(0, 16).replace('T', ' ') : '—'}</dd></div>
              <div className="firm-deflist__row"><dt>{t('fiscal2.device')}</dt>
                <dd>{fiscal?.fiscal.device ? `${fiscal.fiscal.device.label} · ${fiscal.fiscal.device.serial}` : '—'}</dd></div>
              <div className="firm-deflist__row"><dt>{t('fiscal2.fiscalStatus')}</dt>
                <dd><Badge tone={status === 'cleared' || status === 'reported' ? 'lime' : 'warning'} size="sm">
                  {t(`fiscal2.state.${status}` as never)}
                </Badge></dd></div>
            </dl>

            {fiscal?.fiscal.hash ? (
              <p className="firm-fiscal__hash">
                <span className="c-muted">{t('fiscal2.hash')}</span>
                <code>{fiscal.fiscal.hash}</code>
                {/* The previous hash is what makes this a CHAIN rather than a checksum:
                    it is the evidence that the invoice before this one still exists. */}
                <span className="c-muted">{t('fiscal2.prevHash')} {fiscal.fiscal.previousHash?.slice(0, 16) ?? '—'}…</span>
              </p>
            ) : null}

            <div className="firm-fiscal__actions">
              {canIssue ? (
                <Button variant="secondary" icon={<IconCheck size={16} />} onClick={() => setRecording(true)}>
                  {t('fiscal2.recordSubmission')}
                </Button>
              ) : null}
              {fiscal?.fiscal.qrPayload ? (
                <Button
                  variant="ghost"
                  icon={<IconDownload size={16} />}
                  onClick={() => { void copy(t('fiscal2.copiedQr'), fiscal.fiscal.qrPayload ?? '', toast); }}
                >
                  {t('fiscal2.copyQr')}
                </Button>
              ) : null}
              {can('billing.discount') && invoice.outstanding > 0 ? (
                <Button variant="ghost" onClick={() => setCrediting(true)}>{t('fiscal2.creditNote')}</Button>
              ) : null}
              {can('billing.writeoff') && invoice.outstanding > 0 ? (
                <Button variant="ghost" icon={<IconTrash size={16} />} onClick={() => setWritingOff(true)}>
                  {t('fiscal2.writeOff')}
                </Button>
              ) : null}
            </div>

            <h4 className="firm-fiscal__h4">{t('fiscal2.submissions')}</h4>
            <Table
              columns={submissionColumns}
              rows={fiscal?.submissions ?? []}
              rowKey={(s) => s.id}
              label={t('fiscal2.submissions')}
              density="compact"
              empty={(
                <EmptyState
                  kind="empty"
                  compact
                  icon={<IconExternal />}
                  title={t('fiscal2.sub.empty')}
                  /* The truthful sentence: issued here, and NOT yet answered for. */
                  description={t('fiscal2.sub.emptyBody')}
                />
              )}
            />

            {(fiscal?.creditNotes.length ?? 0) > 0 ? (
              <>
                <h4 className="firm-fiscal__h4">{t('fiscal2.creditNotes')}</h4>
                <ul className="firm-fiscal__notes">
                  {fiscal!.creditNotes.map((cn) => (
                    <li key={cn.id}>
                      <span className="num firm-money__num">{cn.number}</span>
                      <span>{cn.reason}</span>
                      <span className="num">{cn.total.toFixed(2)}</span>
                      <Badge tone={cn.status === 'cleared' || cn.status === 'reported' ? 'lime' : 'warning'} size="xs">
                        {t(`fiscal2.state.${cn.status ?? 'pending'}` as never)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        )}
      </CardBody>

      {issuing ? (
        <IssueDialog
          devices={devices}
          total={invoice.total}
          busy={busy}
          onClose={() => setIssuing(false)}
          onIssue={(body) => { void issue(body); }}
        />
      ) : null}

      {recording ? (
        <SubmissionDialog
          busy={busy}
          suggested={fiscal?.fiscal.subtype === 'standard' ? 'clearance' : 'reporting'}
          nextAttempt={(fiscal?.submissions.length ?? 0) + 1}
          onClose={() => setRecording(false)}
          onSubmit={async (body) => {
            setBusy(true);
            try {
              const r = await firmApi.submitInvoice(invoice.id, body);
              toast.success(t('fiscal2.sub.recorded'), t('fiscal2.sub.recordedBody', { status: r.fiscalStatus }));
              setRecording(false);
              reload();
              onChanged();
            } catch (err) {
              toast.error(t('fiscal2.sub.recordFailed'), err instanceof FirmApiError ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {crediting ? (
        <CreditNoteDialog
          outstanding={invoice.outstanding}
          total={invoice.total}
          vatAmount={invoice.vatAmount}
          invoiceNumber={invoice.invoiceNumber}
          busy={busy}
          onClose={() => setCrediting(false)}
          onCredit={(body) => { void creditNote(body); }}
        />
      ) : null}

      {discounting ? (
        <DiscountDialog
          subtotal={invoice.subtotal}
          busy={busy}
          onClose={() => setDiscounting(false)}
          onApply={(newSubtotal, reason) => { void discount(newSubtotal, reason); }}
        />
      ) : null}

      {writingOff ? (
        <WriteOffDialog
          outstanding={invoice.outstanding}
          invoiceNumber={invoice.invoiceNumber}
          busy={busy}
          onClose={() => setWritingOff(false)}
          onWriteOff={(reason) => { void writeOff(reason); }}
        />
      ) : null}
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
 * THE DIALOGS
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * ISSUE — and it says, on the form, that it cannot be undone.
 *
 * The subtype decides the whole subsequent life of the document: a standard invoice must
 * be CLEARED by the authority before it may be sent to the client, a simplified one may
 * be sent at once and reported within 24 hours. Getting that wrong is not a cosmetic
 * error, so the consequence is spelled out under the choice rather than in documentation.
 */
function IssueDialog({
  devices, total, busy, onClose, onIssue,
}: {
  devices: readonly FiscalDevice[];
  total: number;
  busy: boolean;
  onClose: () => void;
  onIssue: (body: { subtype: 'standard' | 'simplified'; deviceId?: string; supplyAt?: string }) => void;
}) {
  const { t } = useI18n();
  const [subtype, setSubtype] = useState<'standard' | 'simplified'>('simplified');
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? '');
  const [supplyAt, setSupplyAt] = useState(() => localDateTime(new Date()));
  const [confirmed, setConfirmed] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('fiscal2.issue')}
      description={t('fiscal2.issueBody', { total: total.toFixed(2) })}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!confirmed || (subtype === 'standard' && devices.length > 0 && !deviceId)}
            onClick={() => onIssue({
              subtype,
              ...(deviceId ? { deviceId } : {}),
              // The time of supply drives the 24-hour reporting window. Sent as an instant.
              ...(supplyAt ? { supplyAt: new Date(supplyAt).toISOString() } : {}),
            })}
          >
            {t('fiscal2.issueConfirm')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <SelectField
          label={t('fiscal2.subtype')}
          value={subtype}
          onChange={(e) => setSubtype(e.target.value as 'standard' | 'simplified')}
          options={[
            { value: 'simplified', label: t('fiscal2.type.simplified') },
            { value: 'standard', label: t('fiscal2.type.standard') },
          ]}
          hint={t(subtype === 'standard' ? 'fiscal2.type.standardHint' : 'fiscal2.type.simplifiedHint')}
        />
        {devices.length > 0 ? (
          <SelectField
            label={t('fiscal2.device')}
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            options={devices.map((d) => ({ value: d.id, label: `${d.label} · ${d.serial}` }))}
            hint={t('fiscal2.deviceHint')}
          />
        ) : (
          /* No active device: the issue will be refused by the server, and the form says
             so before the member fills anything else in. */
          <p className="firm-fiscal__note firm-fiscal__note--warn">{t('fiscal2.noDevice')}</p>
        )}
        <TextField
          label={t('fiscal2.supplyAt')}
          type="datetime-local"
          value={supplyAt}
          onChange={(e) => setSupplyAt(e.target.value)}
          hint={t('fiscal2.supplyAtHint')}
        />
        <label className="firm-fiscal__check">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>{t('fiscal2.issueIrreversible')}</span>
        </label>
      </div>
    </Modal>
  );
}

/**
 * RECORD WHAT THE AUTHORITY SAID.
 *
 * The words "record", "what it said" and "the response body is kept as evidence" are
 * chosen deliberately: this form does not send anything, and a member who believed it did
 * would stop chasing the real submission. The attempt number is shown because a refusal
 * that is retried is a different row, not an edit.
 */
function SubmissionDialog({
  busy, suggested, nextAttempt, onClose, onSubmit,
}: {
  busy: boolean;
  suggested: 'clearance' | 'reporting';
  nextAttempt: number;
  onClose: () => void;
  onSubmit: (body: {
    submissionType: 'clearance' | 'reporting' | 'compliance';
    status: 'pending' | 'submitted' | 'cleared' | 'reported' | 'rejected' | 'failed' | 'timed_out';
    httpStatus?: number | null;
    responseCode?: string | null;
    responseBody?: string | null;
    warnings?: string | null;
    errors?: string | null;
  }) => void;
}) {
  const { t } = useI18n();
  const [type, setType] = useState<'clearance' | 'reporting' | 'compliance'>(suggested);
  const [status, setStatus] = useState<'cleared' | 'reported' | 'rejected' | 'failed' | 'timed_out' | 'submitted'>('cleared');
  const [httpStatus, setHttpStatus] = useState('');
  const [code, setCode] = useState('');
  const [warnings, setWarnings] = useState('');
  const [errors, setErrors] = useState('');
  const [body, setBody] = useState('');

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('fiscal2.recordSubmission')}
      description={t('fiscal2.recordSubmissionBody', { n: String(nextAttempt) })}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => onSubmit({
              submissionType: type,
              status,
              httpStatus: httpStatus ? Number(httpStatus) : null,
              responseCode: code.trim() || null,
              responseBody: body.trim() || null,
              warnings: warnings.trim() || null,
              errors: errors.trim() || null,
            })}
          >
            {t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <SelectField
          label={t('fiscal2.sub.what')}
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
          options={[
            { value: 'clearance', label: t('fiscal2.sub.type.clearance') },
            { value: 'reporting', label: t('fiscal2.sub.type.reporting') },
            { value: 'compliance', label: t('fiscal2.sub.type.compliance') },
          ]}
        />
        <SelectField
          label={t('fiscal2.sub.status')}
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          options={['cleared', 'reported', 'rejected', 'failed', 'timed_out', 'submitted']
            .map((v) => ({ value: v, label: t(`fiscal2.sub.state.${v}`) }))}
          hint={t('fiscal2.sub.statusHint')}
        />
        <TextField label={t('fiscal2.sub.http')} value={httpStatus} onChange={(e) => setHttpStatus(e.target.value.replace(/\D/g, ''))} />
        <TextField label={t('fiscal2.sub.code')} value={code} onChange={(e) => setCode(e.target.value)} hint={t('fiscal2.sub.codeHint')} />
        <TextField label={t('fiscal2.sub.warnings')} value={warnings} onChange={(e) => setWarnings(e.target.value)} />
        <TextField label={t('fiscal2.sub.errors')} value={errors} onChange={(e) => setErrors(e.target.value)} />
        <TextField label={t('fiscal2.sub.body')} value={body} onChange={(e) => setBody(e.target.value)} hint={t('fiscal2.sub.bodyHint')} />
        <p className="firm-fiscal__note firm-fiscal__note--warn">{t('fiscal2.sub.manual')}</p>
      </div>
    </Modal>
  );
}

/**
 * THE CREDIT NOTE.
 *
 * Offered only against an issued invoice, because it is the correction and not the
 * cancellation: the original keeps its number, its counter and its place in the chain, and
 * this second document points back at it. The amount is capped at what is outstanding —
 * the server enforces it, and the form refuses before the request is wasted.
 *
 * The VAT default is the invoice's own proportion, because a refund of a VAT invoice that
 * refunded no VAT would leave the return wrong by exactly the tax.
 */
function CreditNoteDialog({
  outstanding, total, vatAmount, invoiceNumber, busy, onClose, onCredit,
}: {
  outstanding: number;
  total: number;
  vatAmount: number;
  invoiceNumber: string;
  busy: boolean;
  onClose: () => void;
  onCredit: (body: { reason: string; amount: number; vatAmount: number; creditNumber: string; deviceId?: string }) => void;
}) {
  const { t } = useI18n();
  const vatRate = total > 0 ? vatAmount / total : 0;
  const [amount, setAmount] = useState(String(outstanding.toFixed(2)));
  const [vat, setVat] = useState(String((outstanding * vatRate).toFixed(2)));
  const [reason, setReason] = useState('');
  const [number, setNumber] = useState(`${invoiceNumber}-CN1`);

  const amountNum = Number(amount) || 0;
  const vatNum = Number(vat) || 0;
  const valid = reason.trim().length >= 5 && amountNum > 0 && amountNum <= outstanding + 0.001
    && vatNum >= 0 && vatNum <= amountNum && number.trim().length >= 2;

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('fiscal2.creditNote')}
      description={t('fiscal2.creditNoteBody', { number: invoiceNumber })}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid}
            onClick={() => onCredit({
              reason: reason.trim(),
              amount: Number(amountNum.toFixed(2)),
              vatAmount: Number(vatNum.toFixed(2)),
              creditNumber: number.trim(),
            })}
          >
            {t('fiscal2.creditConfirm')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField
          label={t('fiscal2.credit.number')}
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          required
          hint={t('fiscal2.credit.numberHint')}
        />
        <TextField
          label={t('fiscal2.credit.amount')}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          {...(amountNum > outstanding + 0.001 ? { error: t('fiscal2.credit.cap', { max: outstanding.toFixed(2) }) } : {})}
          hint={t('fiscal2.credit.beforeVat')}
        />
        <TextField
          label={t('fiscal2.credit.vat')}
          value={vat}
          onChange={(e) => setVat(e.target.value)}
          hint={t('fiscal2.credit.vatHint', { pct: (vatRate * 100).toFixed(0) })}
        />
        <TextField
          label={t('fiscal2.credit.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          hint={t('fiscal2.credit.reasonHint')}
        />
        <p className="firm-fiscal__note">{t('fiscal2.credit.immutable')}</p>
      </div>
    </Modal>
  );
}

/** A DISCOUNT ON AN UNAPPROVED DOCUMENT — a fee decision, not a tax correction. */
function DiscountDialog({
  subtotal, busy, onClose, onApply,
}: {
  subtotal: number;
  busy: boolean;
  onClose: () => void;
  onApply: (newSubtotal: number, reason: string) => void;
}) {
  const { t } = useI18n();
  const [newSubtotal, setNewSubtotal] = useState(String(subtotal.toFixed(2)));
  const [reason, setReason] = useState('');
  const value = Number(newSubtotal) || 0;
  /* The percentage is computed HERE for display only and never sent: the server derives it
     from the two subtotals, because a caller who could state the percentage could state a
     smaller one than the discount they asked for. */
  const pct = subtotal > 0 ? ((subtotal - value) / subtotal) * 100 : 0;
  const valid = reason.trim().length >= 5 && value < subtotal && value >= 0;

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('fiscal2.discount')}
      description={t('fiscal2.discountBody', { subtotal: subtotal.toFixed(2) })}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => onApply(Number(value.toFixed(2)), reason.trim())}>
            {t('fiscal2.discountConfirm', { pct: pct.toFixed(1) })}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField
          label={t('fiscal2.discount.newSubtotal')}
          value={newSubtotal}
          onChange={(e) => setNewSubtotal(e.target.value)}
          required
          {...(value >= subtotal ? { error: t('fiscal2.discount.mustReduce') } : {})}
          hint={pct > 0 ? t('fiscal2.discount.pct', { pct: pct.toFixed(1) }) : undefined}
        />
        <TextField
          label={t('common.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          hint={t('fiscal2.discount.reasonHint')}
        />
      </div>
    </Modal>
  );
}

/**
 * THE WRITE-OFF.
 *
 * The dialog's whole job is to make one distinction legible: the firm stops trying to
 * collect, and the tax on what was supplied is UNAFFECTED — `taxAdjusted: false` comes
 * back from the server, and saying it here prevents the commonest error in the whole
 * area, treating an abandoned receivable as a reduced sale.
 */
function WriteOffDialog({
  outstanding, invoiceNumber, busy, onClose, onWriteOff,
}: {
  outstanding: number;
  invoiceNumber: string;
  busy: boolean;
  onClose: () => void;
  onWriteOff: (reason: string) => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('fiscal2.writeOff')}
      description={t('fiscal2.writeOffBody', { number: invoiceNumber, amount: outstanding.toFixed(2) })}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={reason.trim().length < 10} onClick={() => onWriteOff(reason.trim())}>
            {t('fiscal2.writeOffConfirm')}
          </Button>
        </>
      )}
    >
      <div className="firm-doc__form">
        <TextField
          label={t('common.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          hint={t('fiscal2.writeOffReasonHint')}
        />
        <p className="firm-fiscal__note firm-fiscal__note--warn">{t('fiscal2.writeOffTax')}</p>
      </div>
    </Modal>
  );
}

/* ── small helpers ─────────────────────────────────────────────────────────── */

function localDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function copy(label: string, text: string, toast: { success: (t: string, b?: string) => unknown }) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch {
    /* A clipboard refusal is not worth an error dialog; the payload is on screen for a
       reader who wants to select it by hand. */
  }
}
