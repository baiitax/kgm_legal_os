import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api/client';
import type { Invoice } from '../api/types';
import { useI18n } from '../i18n';
import { pick } from '../lib/format';
import { Button, Card, Empty, ErrorAlert, Icon, PageLoader, Stat, StatusBadge, useAsync } from '../components/ui';
import { PageHeader, Tabs } from '../components/page';

type TabId = 'all' | 'unpaid' | 'paid';

/**
 * Invoices (§20).
 *
 * The list is read-only. Paying happens on the detail screen, and even there the
 * browser can only create a payment INTENT — the invoice state changes when the
 * provider's signature-verified webhook arrives (§39).
 */
export default function Invoices() {
  const { t, fmt, lang } = useI18n();
  const { data, error, loading, reload } = useAsync(() => get<{ invoices: Invoice[] }>('/api/client/invoices'), []);
  const [tab, setTab] = useState<TabId>('all');

  const all = data?.invoices ?? [];
  const totals = useMemo(() => {
    const sum = (xs: Invoice[], f: (i: Invoice) => string) =>
      xs.reduce((acc, i) => acc + Number(f(i) || 0), 0);
    const unpaid = all.filter((i) => Number(i.balanceDue) > 0);
    return {
      billed: sum(all, (i) => i.total),
      paid: sum(all, (i) => i.amountPaid),
      outstanding: sum(unpaid, (i) => i.balanceDue),
      overdue: sum(
        unpaid.filter((i) => i.status === 'overdue'),
        (i) => i.balanceDue,
      ),
      unpaidCount: unpaid.length,
    };
  }, [all]);

  const shown = useMemo(() => {
    if (tab === 'unpaid') return all.filter((i) => Number(i.balanceDue) > 0);
    if (tab === 'paid') return all.filter((i) => Number(i.balanceDue) === 0);
    return all;
  }, [all, tab]);

  if (loading && !data) return <PageLoader />;

  return (
    <>
      <PageHeader
        title={t('inv.title')}
        subtitle={t('inv.subtitle')}
        actions={
          <Link to="/portal/receipts">
            <Button variant="ghost" size="sm">
              <Icon name="receipt" size={15} />
              {t('inv.receiptsTitle')}
            </Button>
          </Link>
        }
      />

      {error ? <ErrorAlert error={error} onRetry={reload} /> : null}

      <div className="grid grid--3" style={{ marginBlockEnd: 16 }}>
        <Stat label={t('inv.total')} value={fmt.money(totals.billed, 'SAR')} tone="money" />
        <Stat label={t('inv.paid')} value={fmt.money(totals.paid, 'SAR')} tone="money" />
        <div className="stat">
          <div className="stat__label">{t('inv.balance')}</div>
          <div className="stat__value" data-tone={totals.outstanding > 0 ? 'alert' : 'money'}>
            {fmt.money(totals.outstanding, 'SAR')}
          </div>
          <div className="stat__sub">
            {totals.unpaidCount > 0
              ? t('dash.unpaidInvoices') + ': ' + fmt.number(totals.unpaidCount)
              : t('inv.allSettled')}
            {totals.overdue > 0 && <> · {t('inv.status.overdue')}: {fmt.money(totals.overdue, 'SAR')}</>}
          </div>
        </div>
      </div>

      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'all', label: t('common.all'), count: all.length },
          { id: 'unpaid', label: t('inv.balance'), count: all.filter((i) => Number(i.balanceDue) > 0).length },
          { id: 'paid', label: t('inv.status.paid'), count: all.filter((i) => Number(i.balanceDue) === 0).length },
        ]}
      />

      {shown.length === 0 ? (
        <Empty icon="invoice" title={t('inv.empty')} />
      ) : (
        <Card tight={false}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('inv.number')}</th>
                  <th>{t('matter.title')}</th>
                  <th>{t('inv.issue')}</th>
                  <th>{t('inv.due')}</th>
                  <th className="table__num">{t('inv.total')}</th>
                  <th className="table__num">{t('inv.paid')}</th>
                  <th className="table__num">{t('inv.balance')}</th>
                  <th>{t('matter.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((inv) => (
                  <tr key={inv.id}>
                    <td className="ltr mono">{inv.number}</td>
                    <td>
                      <Link to={`/portal/matters/${inv.matterId}`}>{pick(lang, inv.matterTitle, inv.matterTitleAr)}</Link>
                    </td>
                    <td>{fmt.date(inv.issueDate)}</td>
                    <td>{fmt.date(inv.dueDate)}</td>
                    <td className="table__num">{fmt.money(inv.total, inv.currency)}</td>
                    <td className="table__num">{fmt.money(inv.amountPaid, inv.currency)}</td>
                    <td className="table__num">
                      <b>{fmt.money(inv.balanceDue, inv.currency)}</b>
                    </td>
                    <td>
                      <StatusBadge status={inv.status} prefix="inv.status" />
                    </td>
                    <td>
                      <Link to={`/portal/invoices/${inv.id}`}>
                        <Button variant="ghost" size="sm">
                          {t('common.viewAll')}
                          <Icon name="chevron" size={14} />
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>
                    <b>{t('common.all')}</b>
                  </td>
                  <td className="table__num">{fmt.money(totals.billed, 'SAR')}</td>
                  <td className="table__num">{fmt.money(totals.paid, 'SAR')}</td>
                  <td className="table__num">{fmt.money(totals.outstanding, 'SAR')}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}

      <p className="small muted" style={{ marginBlockStart: 14 }}>
        <Icon name="lock" size={13} /> {t('inv.readonly')}
      </p>
    </>
  );
}
