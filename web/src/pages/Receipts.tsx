import { get } from '../api/client';
import type { Receipt } from '../api/types';
import { useI18n } from '../i18n';
import { Button, Card, Empty, ErrorAlert, Icon, PageLoader, useAsync } from '../components/ui';
import { PageHeader } from '../components/page';

/**
 * Receipts (§21).
 *
 * A receipt exists only after a payment has been confirmed by the provider's
 * webhook and written in the same transaction as the invoice state change. There
 * is therefore no "generate receipt" action anywhere in the portal — the list is
 * a record of what already happened, not a document the client can produce.
 */
export default function Receipts() {
  const { t, fmt } = useI18n();
  const { data, error, loading, reload } = useAsync(() => get<{ receipts: Receipt[] }>('/api/client/receipts'), []);

  if (loading && !data) return <PageLoader />;
  const receipts = data?.receipts ?? [];

  return (
    <>
      <PageHeader
        title={t('inv.receiptsTitle')}
        subtitle={t('inv.receiptsSub')}
        actions={
          <Button variant="ghost" size="sm" onClick={() => window.print()}>
            <Icon name="print" size={15} />
            {t('common.print')}
          </Button>
        }
      />

      {error ? <ErrorAlert error={error} onRetry={reload} /> : null}

      {receipts.length === 0 ? (
        <Empty icon="receipt" title={t('inv.noReceipts')} />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="table table--plain">
              <thead>
                <tr>
                  <th>{t('inv.receiptNumber')}</th>
                  <th>{t('inv.issue')}</th>
                  <th className="table__num">{t('inv.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td className="ltr mono">{r.number}</td>
                    <td>{r.issuedAt ? fmt.dateTime(r.issuedAt) : '—'}</td>
                    <td className="table__num">
                      <b>{fmt.money(r.amount, r.currency)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="small muted" style={{ marginBlockStart: 14 }}>
        <Icon name="shield" size={13} /> {t('inv.receiptIntegrity')}
      </p>
    </>
  );
}
