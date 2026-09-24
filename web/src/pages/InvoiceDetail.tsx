import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../api/client';
import type { InvoiceDetail as InvoiceDto } from '../api/types';
import { useAuth } from '../auth';
import { translate, useI18n } from '../i18n';
import { pick } from '../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  ErrorAlert,
  Icon,
  KeyValue,
  Modal,
  PageLoader,
  StatusBadge,
  useAsync,
} from '../components/ui';
import { Crumbs, PageHeader } from '../components/page';

interface PaymentIntent {
  paymentId: string;
  invoiceId: string;
  amount: string;
  currency: string;
  provider: string;
  clientSecret: string;
  webhookUrl: string;
  expiresInMinutes: number;
  demoMode: boolean;
}

/**
 * Invoice detail and payment (§20, §21, §39).
 *
 * The money path, stated plainly because it is the part most often got wrong:
 *
 *   browser ──POST /invoices/:id/payment──▶ server creates an INTENT
 *   provider ──signed webhook──▶ server marks the payment and the invoice PAID
 *
 * This screen can only do the first step. There is no field, button or request
 * body here that can set `status`, `amountPaid`, `paid_at` or `approved_by`;
 * those columns are not writable from the client role at the database level
 * either. What the screen shows after an intent is created is the intent, not a
 * paid invoice — the invoice only changes when the webhook lands.
 */
export default function InvoiceDetail() {
  const { id = '' } = useParams();
  const { t, fmt, lang } = useI18n();
  const { boot } = useAuth();
  const { data, error, loading, reload } = useAsync(
    () => get<InvoiceDto>(`/api/client/invoices/${encodeURIComponent(id)}`),
    [id],
  );

  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (loading && !data) return <PageLoader />;

  if (error || !data) {
    return (
      <>
        <Crumbs items={[{ to: '/portal/invoices', label: t('inv.title') }, { label: t('inv.notFound') }]} />
        <ErrorAlert error={error} onRetry={reload} />
      </>
    );
  }

  const inv = data;
  const payable = inv.payable && Number(inv.balanceDue) > 0;
  const providerLabel = (provider: string) => translate(lang, `inv.${provider}`);

  const createIntent = async () => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await post<PaymentIntent>(`/api/client/invoices/${encodeURIComponent(inv.id)}/payment`, {});
      setIntent(res);
      setConfirmOpen(false);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Development only. With the mock provider there is no external service to
   * call back, so this button performs the two steps the provider would: ask the
   * dev endpoint to sign an event with the server's webhook secret, then deliver
   * it. It is rendered only when the server itself reports demo mode, and it is
   * disabled entirely in a production build where /api/dev is not mounted.
   */
  const simulateProvider = async () => {
    if (!intent) return;
    setBusy(true);
    setActionError(null);
    try {
      const signed = await post<{ payload: Record<string, unknown>; signature: string }>('/api/dev/webhook/simulate', {
        paymentId: intent.paymentId,
        status: 'succeeded',
        amount: intent.amount,
      });
      await fetch(intent.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': signed.signature },
        body: JSON.stringify(signed.payload),
        credentials: 'same-origin',
      });
      setNotice(t('inv.simulateDone'));
      setIntent(null);
      reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Crumbs
        items={[
          { to: '/portal', label: t('nav.dashboard') },
          { to: '/portal/invoices', label: t('inv.title') },
          { label: inv.number },
        ]}
      />

      <PageHeader
        title={<span className="ltr mono">{inv.number}</span>}
        subtitle={
          <Link to={`/portal/matters/${inv.matterId}`}>{pick(lang, inv.matterTitle, inv.matterTitleAr)}</Link>
        }
        actions={<StatusBadge status={inv.status} prefix="inv.status" />}
      />

      {actionError ? <ErrorAlert error={actionError} /> : null}
      {notice && (
        <Alert tone="ok" title={t('inv.intentCreated')}>
          {notice}
        </Alert>
      )}

      <div className="grid grid--2">
        <Card title={t('inv.lines')}>
          {inv.lines.length === 0 ? (
            <Empty icon="invoice" title={t('common.none')} />
          ) : (
            <div className="table-wrap">
              <table className="table table--plain">
                <thead>
                  <tr>
                    <th>{t('inv.lineDescription')}</th>
                    <th className="table__num">{t('inv.qty')}</th>
                    <th className="table__num">{t('inv.unitPrice')}</th>
                    <th className="table__num">{t('inv.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.lines.map((line, i) => (
                    <tr key={i}>
                      <td>{pick(lang, line.description, line.descriptionAr)}</td>
                      <td className="table__num">{fmt.number(line.quantity)}</td>
                      <td className="table__num">{fmt.money(line.unitPrice, inv.currency)}</td>
                      <td className="table__num">{fmt.money(line.amount, inv.currency)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>{t('inv.subtotal')}</td>
                    <td className="table__num">{fmt.money(inv.subtotal, inv.currency)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3}>
                      {t('inv.vat', { rate: `${fmt.number(Math.round(inv.vatRate * 100))}%` })}
                    </td>
                    <td className="table__num">{fmt.money(inv.vatAmount, inv.currency)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3}>
                      <b>{t('inv.total')}</b>
                    </td>
                    <td className="table__num">
                      <b>{fmt.money(inv.total, inv.currency)}</b>
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={3}>{t('inv.paid')}</td>
                    <td className="table__num">{fmt.money(inv.amountPaid, inv.currency)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3}>
                      <b>{t('inv.balance')}</b>
                    </td>
                    <td className="table__num">
                      <b data-tone={Number(inv.balanceDue) > 0 ? 'alert' : undefined}>
                        {fmt.money(inv.balanceDue, inv.currency)}
                      </b>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>

        <div>
          <Card title={t('inv.issue')}>
            <KeyValue
              items={[
                [t('inv.number'), <span className="ltr mono" key="n">{inv.number}</span>],
                [t('matter.title'), <Link key="m" to={`/portal/matters/${inv.matterId}`}>{pick(lang, inv.matterTitle, inv.matterTitleAr)}</Link>],
                [t('inv.issue'), fmt.date(inv.issueDate)],
                [t('inv.due'), fmt.date(inv.dueDate)],
                [t('inv.status'), <StatusBadge key="s" status={inv.status} prefix="inv.status" />],
                [t('inv.balance'), <b key="b">{fmt.money(inv.balanceDue, inv.currency)}</b>],
              ]}
            />

            {payable ? (
              <Button variant="primary" block style={{ marginBlockStart: 14 }} onClick={() => setConfirmOpen(true)}>
                <Icon name="money" size={16} />
                {t('inv.pay')} · {fmt.money(inv.balanceDue, inv.currency)}
              </Button>
            ) : (
              <Alert tone={Number(inv.balanceDue) === 0 ? 'ok' : 'info'}>
                {Number(inv.balanceDue) === 0 ? t('inv.settled') : t('inv.notPayable')}
              </Alert>
            )}

            <p className="small muted" style={{ marginBlockStart: 10 }}>
              <Icon name="lock" size={13} /> {t('inv.payNote')}
            </p>
          </Card>

          <Card title={t('inv.payments')}>
            {inv.payments.length === 0 ? (
              <Empty icon="money" title={t('inv.noPayments')} />
            ) : (
              <ul className="list">
                {inv.payments.map((p) => (
                  <li key={p.id} className="list__item">
                    <span className="list__icon">
                      <Icon name="money" size={16} />
                    </span>
                    <span className="list__main">
                      <span className="list__title">{fmt.money(p.amount, p.currency)}</span>
                      <span className="list__meta">
                        <span>{providerLabel(p.provider)}</span>
                        {p.completedAt && <span>{fmt.dateTime(p.completedAt)}</span>}
                        {p.receiptNumber && <span className="ltr mono">{p.receiptNumber}</span>}
                      </span>
                    </span>
                    <span className="list__end">
                      <Badge tone={p.status === 'succeeded' ? 'ok' : p.status === 'failed' ? 'danger' : 'default'}>
                        {p.status.replace(/_/g, ' ')}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {inv.receipt && (
            <Card
              title={t('inv.receipt')}
              actions={
                <Button variant="ghost" size="sm" onClick={() => window.print()}>
                  <Icon name="print" size={15} />
                  {t('common.print')}
                </Button>
              }
            >
              <KeyValue
                items={[
                  [t('inv.receiptNumber'), <span className="ltr mono" key="r">{inv.receipt.number}</span>],
                  [t('inv.amount'), fmt.money(inv.receipt.amount, inv.receipt.currency)],
                  [t('inv.issue'), inv.receipt.issuedAt ? fmt.dateTime(inv.receipt.issuedAt) : '—'],
                ]}
              />
            </Card>
          )}
        </div>
      </div>

      {intent && (
        <Card title={t('inv.awaitingProvider')} hint={t('inv.expiresIn', { n: intent.expiresInMinutes })}>
          <KeyValue
            items={[
              [t('inv.method'), providerLabel(intent.provider)],
              [t('inv.amount'), fmt.money(intent.amount, intent.currency)],
              [t('inv.paymentRef'), <span className="ltr mono small" key="p">{intent.paymentId}</span>],
            ]}
          />
          <Alert tone="info" title={t('inv.awaitingProvider')}>
            {t('inv.awaitingBody')}
          </Alert>
          {intent.demoMode && boot?.demoMode && (
            <>
              <div className="alert alert--warn" style={{ marginBlockStart: 10 }}>
                <Icon name="alert" size={16} />
                <div className="alert__body">
                  <div className="alert__title">{t('inv.demoProvider')}</div>
                  <div>{t('inv.demoProviderBody')}</div>
                </div>
              </div>
              <Button variant="ghost" block loading={busy} onClick={() => void simulateProvider()} style={{ marginBlockStart: 10 }}>
                <Icon name="refresh" size={15} />
                {t('inv.simulate')}
              </Button>
            </>
          )}
          <Button variant="ghost" block onClick={() => setIntent(null)} style={{ marginBlockStart: 8 }}>
            {t('common.close')}
          </Button>
        </Card>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t('inv.payTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void createIntent()}>
              <Icon name="money" size={16} />
              {t('inv.confirmPay')}
            </Button>
          </>
        }
      >
        <KeyValue
          items={[
            [t('inv.number'), <span className="ltr mono" key="n">{inv.number}</span>],
            [t('inv.amount'), <b key="a">{fmt.money(inv.balanceDue, inv.currency)}</b>],
            [t('inv.vat'), fmt.money(inv.vatAmount, inv.currency)],
          ]}
        />
        <Alert tone="info" title={t('inv.payNote')}>
          {t('inv.intentOnly')}
        </Alert>
      </Modal>
    </>
  );

}
