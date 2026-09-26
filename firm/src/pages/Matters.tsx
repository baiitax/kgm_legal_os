/**
 * MATTERS LIST · §21, §24
 *
 * The firm's portfolio, scoped to what the member may see.
 *
 * THE SCOPE IS THE SERVER'S, NOT A FILTER
 *   This screen renders `GET /api/firm/matters`, already narrowed by RLS and by
 *   the member's practice-area scope. Nothing here widens it. The search box and
 *   the filters operate on the returned rows — they can narrow further, never
 *   further-out. That is the difference between a filter and a projection, and it
 *   is why the count shown is the count the member is entitled to rather than the
 *   count that exists.
 *
 *   `scope` comes back alongside the rows and is displayed. A partner scoped to
 *   two practice areas who sees "14 matters" should be able to see that the number
 *   is scoped, or they will read it as the firm's total.
 *
 * SORTING IS CLIENT-SIDE AND DELIBERATELY SO
 *   The comparators run over rows the server already authorized. Sorting
 *   server-side would mean sending a sort key to an endpoint that would then have
 *   to re-derive scope — more surface for no gain, since a firm's visible matter
 *   list is small enough to sort in the browser. The comparators live on the
 *   columns, which is where §24 puts them.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AccessBadge, Badge, Button, EmptyState, IconFilter, IconPlus, IconRefresh, IconRestricted,
  PageSkeleton, StatusChip, Table, TextField, useFmt, useI18n,
  type Column, type SortState,
} from '@kgm/ui';
import { useFirmSession } from '../auth/FirmSession.js';
import { firmApi, FirmApiError, type MatterListResponse, type MatterSummary } from '../api/firm.js';
import '../shell/shell.css';

interface MattersProps {
  readonly onNavigate: (to: string) => void;
}

const PAGE_SIZE = 25;

export function Matters({ onNavigate }: MattersProps) {
  const { t, lang, pick } = useI18n();
  const fmt = useFmt();
  const { can, canAny } = useFirmSession();

  const [data, setData] = useState<MatterListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FirmApiError | null>(null);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [areaFilter, setAreaFilter] = useState('');
  const [restrictedOnly, setRestrictedOnly] = useState(false);
  const [sort, setSort] = useState<SortState | null>({ key: 'openedAt', direction: 'desc' });
  const [page, setPage] = useState(1);

  const load = () => {
    setLoading(true);
    firmApi.matters()
      .then((res) => { setData(res); setError(null); })
      .catch((err) => {
        setData(null);
        setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable'));
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  /**
   * Distinct statuses and areas present in the AUTHORIZED rows.
   *
   * Building the options from the response means a filter cannot offer a value
   * that would return nothing, and cannot reveal a status or practice area that
   * exists only outside the member's scope. Deriving them from a static list
   * would do both.
   */
  const statuses = useMemo(
    () => [...new Set((data?.matters ?? []).map((m) => m.clientStatus).filter(Boolean))] as string[],
    [data],
  );
  const areas = useMemo(
    () => [...new Set((data?.matters ?? []).map((m) => m.practiceArea).filter(Boolean))] as string[],
    [data],
  );

  const rows = useMemo(() => {
    let out = data?.matters ?? [];
    const q = query.trim().toLowerCase();
    if (q) out = out.filter((m) => matches(m, q));
    if (statusFilter) out = out.filter((m) => m.clientStatus === statusFilter);
    if (areaFilter) out = out.filter((m) => m.practiceArea === areaFilter);
    if (restrictedOnly) out = out.filter((m) => m.restricted);
    return out;
  }, [data, query, statusFilter, areaFilter, restrictedOnly]);

  // Any filter change invalidates the page position; staying on page 4 of a
  // 2-row result is an empty screen that looks like a bug.
  useEffect(() => { setPage(1); }, [query, statusFilter, areaFilter, restrictedOnly]);

  const filtered = rows.length !== (data?.matters.length ?? 0);
  const ar = lang === 'ar' ? 'ar' : 'en';

  const clearFilters = () => {
    setQuery(''); setStatusFilter(''); setAreaFilter(''); setRestrictedOnly(false);
  };

  const columns = useMemo<Array<Column<MatterSummary>>>(() => [
    {
      key: 'matterNumber',
      header: t('matter.matterNumber'),
      sortable: true,
      compare: (a, b) => cmp((a.matterNumber ?? '').toLowerCase(), (b.matterNumber ?? '').toLowerCase()),
      width: '112px',
      cell: (m) => <span className="firm-cellnum">{m.matterNumber ?? '—'}</span>,
      cardLabel: t('matter.matterNumber'),
    },
    {
      key: 'title',
      header: t('matter.title'),
      sortable: true,
      compare: (a, b) => cmp(pick(a.titleAr, a.title).toLowerCase(), pick(b.titleAr, b.title).toLowerCase()),
      cell: (m) => (
        <span className="firm-celltitle">
          {m.restricted && (
            // The lock is announced by text, not colour or shape alone (§30).
            <IconRestricted size={13} className="firm-celltitle__lock" label={t('matter.restricted')} />
          )}
          {pick(m.titleAr, m.title) || '—'}
        </span>
      ),
      cardLabel: t('matter.title'),
    },
    {
      key: 'clientName',
      header: t('matter.client'),
      sortable: true,
      compare: (a, b) => cmp(pick(a.clientNameAr, a.clientName).toLowerCase(), pick(b.clientNameAr, b.clientName).toLowerCase()),
      responsive: 'card',
      cell: (m) => pick(m.clientNameAr, m.clientName) || '—',
      cardLabel: t('matter.client'),
    },
    {
      key: 'practiceArea',
      header: t('matter.practiceArea'),
      sortable: true,
      compare: (a, b) => cmp((a.practiceArea ?? '').toLowerCase(), (b.practiceArea ?? '').toLowerCase()),
      responsive: 'tablet',
      cell: (m) => (m.practiceArea
        ? <Badge tone="neutral" size="xs">{pick(m.practiceAreaAr, m.practiceArea)}</Badge>
        : <span className="c-muted">{t('common.none')}</span>),
      cardLabel: t('matter.practiceArea'),
    },
    {
      key: 'openedAt',
      header: t('matter.openedAt'),
      sortable: true,
      compare: (a, b) => cmp(a.openedAt ?? '', b.openedAt ?? ''),
      align: 'end',
      numeric: true,
      responsive: 'tablet',
      width: '112px',
      cell: (m) => (m.openedAt ? fmt.day(m.openedAt) : '—'),
      cardLabel: t('matter.openedAt'),
    },
    {
      key: 'clientStatus',
      header: t('matter.status'),
      responsive: 'card',
      width: '124px',
      cell: (m) => (m.clientStatus ? <StatusChip status={m.clientStatus} lang={ar} /> : <span className="c-muted">{t('common.none')}</span>),
      cardLabel: t('matter.status'),
    },
    {
      // The access level is a column rather than a footnote: it is the fact that
      // explains every field lock the member will meet inside the workspace.
      key: 'accessLevel',
      header: t('matter.accessLevel'),
      sortable: true,
      compare: (a, b) => cmp(a.accessLevel, b.accessLevel),
      responsive: 'card',
      width: '132px',
      cell: (m) => <AccessBadge level={m.accessLevel} lang={ar} />,
      cardLabel: t('matter.accessLevel'),
    },
  ], [t, pick, fmt, ar]);

  const canRead = canAny(['matters.read', 'matters.read_all']);

  return (
    <div className="firm-page">
      <header className="firm-pagehead">
        <div className="firm-pagehead__text">
          <p className="firm-pagehead__eyebrow">{t('nav.matters')}</p>
          <h1 className="firm-pagehead__title">{t('matter.title')}</h1>
          <p className="firm-pagehead__sub">
            {data ? t('matter.count', { n: fmt.numberLatin(data.count) }) : t('common.loading')}
            {/* State the scope so a scoped count is not read as a total. */}
            {data && !data.scope.firmWide && data.scope.practiceAreas.length > 0 && (
              <> · {data.scope.practiceAreas.join('، ')}</>
            )}
            {data?.scope.firmWide && <> · {t('profile.firmWide')}</>}
          </p>
        </div>

        <div className="firm-pagehead__actions">
          <Button variant="ghost" size="sm" icon={<IconRefresh size={15} />} onClick={load} disabled={loading}>
            {t('common.refresh')}
          </Button>
          {/*
            ADD THE CASE. The button used to navigate to `/matters?new=1`, a query the
            matters screen never read — so the primary action on the firm's most-used
            screen did nothing at all. It now opens the intake screen, which is the
            only place a matter is created.
          */}
          {can('matters.create') && (
            <Button
              variant="primary" size="sm" icon={<IconPlus size={15} />}
              onClick={() => onNavigate('/matters/new')}
            >
              {t('matter.new')}
            </Button>
          )}
        </div>
      </header>

      {!canRead ? (
        /*
          §50 applied to a whole screen. A member without matters.read never
          reached this route through the nav — the rail hid it — so arriving here
          means they typed the URL. The answer is `denied`, not `empty`: an empty
          state would claim the firm has no matters, which is a statement this
          member is not entitled to be told.
        */
        <EmptyState kind="denied" title={t('common.denied.title')} description={t('common.denied.body')} />
      ) : loading ? (
        <PageSkeleton title={t('matter.title')} hint={t('common.loading')} />
      ) : error ? (
        error.isForbidden || error.isNotVisible ? (
          <EmptyState kind="denied" title={t('matter.denied.title')} description={t('matter.denied.body')} />
        ) : (
          <EmptyState
            kind={error.status === 0 ? 'offline' : 'error'}
            title={t('matter.error.title')}
            description={t('matter.error.body')}
            action={{ label: t('matter.retry'), onClick: load }}
          />
        )
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            kind="empty"
            title={t('matter.emptyFiltered.title')}
            description={t('matter.emptyFiltered.body')}
            action={{ label: t('matter.filter.clear'), onClick: clearFilters }}
          />
        ) : (
          <EmptyState kind="empty" title={t('matter.empty.title')} description={t('matter.empty.body')} />
        )
      ) : (
        <>
          <div className="firm-toolbar">
            <TextField
              className="firm-toolbar__search"
              label={t('common.search')}
              labelClassName="sr-only"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('matter.search')}
              type="search"
              autoComplete="off"
            />

            <div className="firm-toolbar__filters">
              <span className="firm-toolbar__filtericon" aria-hidden="true"><IconFilter size={15} /></span>

              <select
                className="kgm-select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                aria-label={t('matter.filter.status')}
              >
                <option value="">{t('matter.filter.status')}: {t('common.all')}</option>
                {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>

              <select
                className="kgm-select"
                value={areaFilter}
                onChange={(e) => setAreaFilter(e.target.value)}
                aria-label={t('matter.filter.practiceArea')}
              >
                <option value="">{t('matter.filter.practiceArea')}: {t('common.all')}</option>
                {areas.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>

              <label className="firm-toolbar__check">
                <input
                  type="checkbox"
                  checked={restrictedOnly}
                  onChange={(e) => setRestrictedOnly(e.target.checked)}
                />
                <IconRestricted size={13} aria-hidden="true" />
                {t('matter.filter.restricted')}
              </label>

              {filtered && (
                <Button variant="ghost" size="xs" onClick={clearFilters}>
                  {t('matter.filter.clear')}
                </Button>
              )}
            </div>
          </div>

          <Table
            columns={columns}
            rows={rows}
            rowKey={(m) => m.id}
            label={t('matter.title')}
            sort={sort}
            onSortChange={setSort}
            onRowClick={(m) => onNavigate(`/matters/${m.id}`)}
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total: rows.length,
              onChange: setPage,
            }}
            density="comfortable"
            striped
            empty={t('matter.emptyFiltered.body')}
          />
        </>
      )}
    </div>
  );
}

// ==========================================================================

/** String compare with empties last in both directions, so a partial record
 *  does not bubble to the top of an ascending sort because its field is null. */
function cmp(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  return a < b ? -1 : 1;
}

/**
 * Search matching.
 *
 * Tolerant of the ways a practitioner actually types: a bare number, a hyphenated
 * one, Arabic or Latin digits, and either language's title. A search that demands
 * the exact stored form is a search people stop using.
 */
function matches(m: MatterSummary, q: string): boolean {
  const hay = [
    m.title, m.titleAr, m.clientName, m.clientNameAr,
    m.practiceArea, m.practiceAreaAr, m.matterNumber,
  ].filter(Boolean).join(' ').toLowerCase();

  if (hay.includes(q)) return true;

  // Trailing-segment match: "178" finds "KGM-2025-178". Digits are normalized so
  // Arabic-Indic input matches a Latin-digit stored number.
  const digits = toLatinDigits(q.replace(/[^0-9٠-٩]/g, ''));
  if (!digits) return false;
  const num = (m.matterNumber ?? '').toLowerCase();
  if (num === digits) return true;
  const tail = num.split(/[-/]/).pop() ?? '';
  return tail.length > 0 && tail === digits;
}

function toLatinDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}
