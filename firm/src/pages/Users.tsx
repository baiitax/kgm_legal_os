/**
 * MEMBERS & AUTHORITY · §49, §10, §72
 *
 * The tenant's membership directory, with each member's financial ceilings.
 *
 * THE TENANT BOUNDARY IS THE SERVER'S
 *   `/admin/members` lists one tenant's memberships and cannot be pointed at
 *   another. Nothing here sends a tenant id. The page renders what comes back.
 *
 * WHY CEILINGS ARE SHOWN AT ALL
 *   Because §10 authority is numeric and per-member, and an administrator
 *   assigning work needs to see it. But the number displayed is NEVER treated as
 *   authoritative by this page: every approval is re-checked against the database
 *   value at request time. Showing a stale ceiling here can mislead a human; it
 *   cannot widen an authorization.
 *
 * WHAT `null` MEANS, AND WHY IT IS NOT "UNLIMITED"
 *   `assertWithinAuthority` refuses outright when the ceiling is null —
 *   `ceiling_not_set`. So null means NO authority, and rendering it as "Uncapped"
 *   would state the exact opposite of the enforced behaviour on the one column
 *   that governs money. It renders as "no ceiling set — every amount refused".
 *
 * MUTATIONS ARE OFFERED, NOT GUARANTEED
 *   Suspend and assign-role are rendered from the permission codes, but the
 *   server independently enforces MFA-when-required, same-tenant target, and a
 *   self-change refusal. This page does not pre-empt those rules by disabling
 *   controls: a client-side guess about a server-side rule goes stale, and the
 *   member then learns that the interface does not tell the truth. The refusal is
 *   surfaced instead, with the reason.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Badge, Button, EmptyState, IconRefresh, PageSkeleton, Table, TextField,
  useFmt, useI18n, useToast, type BadgeTone, type Column, type SortState,
} from '@kgm/ui';
import { useFirmSession } from '../auth/FirmSession.js';
import {
  firmApi, FirmApiError, type FirmMemberRow, type FirmRoleRow,
} from '../api/firm.js';
import '../shell/shell.css';

interface MembersResponse {
  count: number;
  members: FirmMemberRow[];
  roles: FirmRoleRow[];
}

type MemberStatus = 'active' | 'suspended' | 'deactivated' | 'left';

const STATUSES: readonly MemberStatus[] = ['active', 'suspended', 'deactivated', 'left'];

export function Users() {
  const { t, lang, pick } = useI18n();
  const fmt = useFmt();
  const toast = useToast();
  const { can, member } = useFirmSession();

  const [data, setData] = useState<MembersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FirmApiError | null>(null);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sort, setSort] = useState<SortState | null>({ key: 'name', direction: 'asc' });
  /** The membership whose mutation is in flight, so one row can spin alone. */
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    firmApi.members()
      .then((res) => { setData(res); setError(null); })
      .catch((err) => {
        setData(null);
        setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable'));
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const canRead = can('users.read');
  const canChangeStatus = can('users.deactivate');
  const canAssignRole = can('users.assign_role');
  const ar = lang === 'ar' ? 'ar' : 'en';

  /**
   * Statuses present in the returned rows, not the full enum.
   *
   * Offering a filter value that matches nothing produces an empty screen that
   * reads as a bug. Deriving the options from the data also avoids asserting that
   * a status exists in this firm when it does not.
   */
  const statusesPresent = useMemo(
    () => STATUSES.filter((s) => (data?.members ?? []).some((m) => m.status === s)),
    [data],
  );

  const rows = useMemo(() => {
    let out = data?.members ?? [];
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter((m) =>
        [m.displayName, m.displayNameAr, m.email, m.jobTitle, m.jobTitleAr, m.internalRole]
          .some((v) => typeof v === 'string' && v.toLowerCase().includes(q)));
    }
    if (statusFilter) out = out.filter((m) => m.status === statusFilter);
    return out;
  }, [data, query, statusFilter]);

  const filtered = rows.length !== (data?.members.length ?? 0);

  /**
   * Renders a ceiling. Null is refused by the server, so it is labelled as
   * no authority — never as unlimited.
   */
  const renderCeiling = (value: number | null) => {
    if (value === null) {
      return <span className="firm-muted">{t('users.authority.notSet')}</span>;
    }
    return (
      <span className="firm-cellnum">
        {fmt.moneyLatin(value)}
        <span className="firm-currency"> {fmt.currencyCode()}</span>
      </span>
    );
  };

  const changeStatus = async (row: FirmMemberRow, status: MemberStatus) => {
    setBusyId(row.membershipId);
    try {
      await firmApi.setMemberStatus(row.membershipId, status);
      toast.success(t('users.mutation.done'), `${pick(row.displayName, row.displayNameAr)} → ${status}`);
      load();
    } catch (err) {
      /*
        The server's refusal is the answer, including for the self-change case.
        Surfacing its reason is more useful than having predicted it: the rule
        lives server-side, and a client-side guess would eventually disagree.
      */
      const e = err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable');
      toast.error(t('users.mutation.failed'), messageFor(e, t));
    } finally {
      setBusyId(null);
    }
  };

  const columns = useMemo<Array<Column<FirmMemberRow>>>(() => [
    {
      key: 'name',
      header: t('users.col.name'),
      sortable: true,
      compare: (a, b) => cmp(pick(a.displayName, a.displayNameAr), pick(b.displayName, b.displayNameAr)),
      cell: (m) => (
        <div className="firm-cellperson">
          <span className="firm-cellperson__name">{pick(m.displayName, m.displayNameAr)}</span>
          {m.internalRole && (
            <span className="firm-cellperson__role">{m.internalRole}</span>
          )}
        </div>
      ),
    },
    {
      key: 'email',
      header: t('users.col.email'),
      sortable: true,
      compare: (a, b) => cmp(a.email, b.email),
      cell: (m) => <span className="firm-cellmono" dir="ltr">{m.email}</span>,
      cardLabel: t('users.col.email'),
    },
    {
      key: 'jobTitle',
      header: t('users.col.jobTitle'),
      sortable: true,
      compare: (a, b) => cmp(a.jobTitle ?? '', b.jobTitle ?? ''),
      cell: (m) => pick(m.jobTitle, m.jobTitleAr) ?? <span className="firm-muted">—</span>,
      responsive: 'desktop',
      cardLabel: t('users.col.jobTitle'),
    },
    {
      key: 'status',
      header: t('users.col.status'),
      sortable: true,
      compare: (a, b) => cmp(a.status, b.status),
      cell: (m) => <Badge tone={toneForStatus(m.status)} dot={m.status === 'active'}>{m.status}</Badge>,
      cardLabel: t('users.col.status'),
    },
    {
      key: 'authority',
      header: t('users.col.authority'),
      align: 'end',
      numeric: true,
      sortable: true,
      // Null sorts LAST, not first: "no authority" is not the smallest number, it
      // is the absence of one, and treating it as 0 would bury the members who
      // cannot approve anything among those with tiny limits.
      compare: (a, b) => nullLast(a.ceilings.financialSar) - nullLast(b.ceilings.financialSar),
      cell: (m) => renderCeiling(m.ceilings.financialSar),
      cardLabel: t('users.col.authority'),
    },
    {
      key: 'clientVisible',
      header: t('users.col.clientVisible'),
      align: 'center',
      responsive: 'desktop',
      cell: (m) => (m.clientVisible ? t('users.clientVisible.yes') : t('users.clientVisible.no')),
      cardLabel: t('users.col.clientVisible'),
    },
    {
      key: 'actions',
      header: t('users.col.actions'),
      headerLabel: t('users.col.actions'),
      align: 'end',
      cell: (m) => {
        const isSelf = member?.membershipId === m.membershipId;
        if (!canChangeStatus) return <span className="firm-muted">—</span>;
        return (
          <div className="firm-rowactions">
            {isSelf ? (
              /*
                Shown as inert WITH an explanation rather than hidden. Hiding it
                leaves the admin wondering whether the control is missing or
                broken; the tooltip states the rule. The server refuses the change
                regardless — this is presentation, not enforcement.
              */
              <span className="firm-rowactions__self" title={t('users.selfNotice')}>
                {t('users.col.actions')}: —
              </span>
            ) : (
              <>
                {m.status === 'active' ? (
                  <Button
                    variant="ghost" size="xs" loading={busyId === m.membershipId}
                    onClick={() => void changeStatus(m, 'suspended')}
                  >
                    {t('users.action.suspend')}
                  </Button>
                ) : (
                  <Button
                    variant="ghost" size="xs" loading={busyId === m.membershipId}
                    onClick={() => void changeStatus(m, 'active')}
                  >
                    {t('users.action.activate')}
                  </Button>
                )}
                {canAssignRole && (
                  <Badge tone="neutral">{t('users.action.assignRole')}</Badge>
                )}
              </>
            )}
          </div>
        );
      },
      cardLabel: t('users.col.actions'),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, pick, fmt, ar, canChangeStatus, canAssignRole, member, busyId]);

  if (!canRead) {
    /*
      §50 on a whole screen. The rail hid this module for a member without
      users.read, so arriving here means they typed the URL. The answer is
      `denied`, never `empty`: an empty member list would claim the firm has no
      staff, which this member is not entitled to be told.
    */
    return (
      <div className="firm-page">
        <PageHead
          eyebrow={t('nav.admin')}
          title={t('users.title')}
          sub={t('users.sub')}
        />
        <EmptyState kind="denied" title={t('users.denied.title')} description={t('users.denied.body')} />
      </div>
    );
  }

  return (
    <div className="firm-page">
      <PageHead
        eyebrow={t('nav.admin')}
        title={t('users.title')}
        sub={data ? t('users.count', { n: fmt.numberLatin(data.count) }) : t('common.loading')}
        actions={
          <Button variant="ghost" size="sm" icon={<IconRefresh size={15} />} onClick={load} disabled={loading}>
            {t('common.refresh')}
          </Button>
        }
      />

      {loading ? (
        <PageSkeleton title={t('users.title')} hint={t('common.loading')} />
      ) : error ? (
        error.isForbidden || error.isNotVisible ? (
          <EmptyState kind="denied" title={t('users.denied.title')} description={t('users.denied.body')} />
        ) : (
          <EmptyState
            kind={error.status === 0 ? 'offline' : 'error'}
            title={t('users.error.title')}
            description={t('users.error.body')}
            action={{ label: t('common.retry'), onClick: load }}
          />
        )
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            kind="empty"
            title={t('users.emptyFiltered.title')}
            description={t('users.emptyFiltered.body')}
            action={{ label: t('matter.filter.clear'), onClick: () => { setQuery(''); setStatusFilter(''); } }}
          />
        ) : (
          <EmptyState kind="empty" title={t('users.empty.title')} description={t('users.empty.body')} />
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
              placeholder={t('users.search')}
              type="search"
              autoComplete="off"
            />
            <div className="firm-toolbar__filters">
              <select
                className="kgm-select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                aria-label={t('users.filter.status')}
              >
                <option value="">{t('users.filter.status')}: {t('common.all')}</option>
                {statusesPresent.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <Table
            columns={columns}
            rows={rows}
            rowKey={(m) => m.membershipId}
            label={t('users.title')}
            sort={sort}
            onSortChange={setSort}
            density="comfortable"
            striped
            empty={t('users.emptyFiltered.body')}
          />

          {data && data.roles.length > 0 && (
            <RoleCatalogue roles={data.roles} lang={ar} />
          )}
        </>
      )}
    </div>
  );
}

// ==========================================================================

/**
 * The tenant's role catalogue, shown beside the members it can be applied to.
 *
 * Rendered from the same response as the member list rather than a second call,
 * so the picker and the directory cannot disagree about what is assignable.
 */
function RoleCatalogue({ roles, lang }: { roles: readonly FirmRoleRow[]; lang: 'ar' | 'en' }) {
  const { t } = useI18n();
  const active = roles.filter((r) => r.isActive);
  const inactive = roles.filter((r) => !r.isActive);

  return (
    <section className="firm-subsection" aria-labelledby="firm-roles-heading">
      <header className="firm-subsection__head">
        <h2 id="firm-roles-heading" className="firm-subsection__title">{t('users.roles.title')}</h2>
        <p className="firm-subsection__sub">{t('users.roles.count', { n: String(active.length) })}</p>
      </header>
      <ul className="firm-rolelist">
        {active.map((r) => (
          <li key={r.id} className="firm-rolelist__item">
            <span className="firm-rolelist__code" dir="ltr">{r.code}</span>
            <span className="firm-rolelist__name">{lang === 'ar' ? r.nameAr : r.name}</span>
            {r.isSystem && <Badge tone="gold" size="xs">{t('users.roles.system')}</Badge>}
          </li>
        ))}
        {inactive.map((r) => (
          <li key={r.id} className="firm-rolelist__item" data-inactive="true">
            <span className="firm-rolelist__code" dir="ltr">{r.code}</span>
            <span className="firm-rolelist__name">{lang === 'ar' ? r.nameAr : r.name}</span>
            <Badge tone="neutral" size="xs">{t('users.roles.inactive')}</Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The page header shared by the three administration screens. */
export function PageHead({ eyebrow, title, sub, actions }: {
  readonly eyebrow: string;
  readonly title: string;
  readonly sub?: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="firm-pagehead">
      <div className="firm-pagehead__text">
        <p className="firm-pagehead__eyebrow">{eyebrow}</p>
        <h1 className="firm-pagehead__title">{title}</h1>
        {sub && <p className="firm-pagehead__sub">{sub}</p>}
      </div>
      {actions && <div className="firm-pagehead__actions">{actions}</div>}
    </header>
  );
}

// ==========================================================================
// helpers

function toneForStatus(status: string): BadgeTone {
  switch (status) {
    case 'active': return 'lime';
    case 'suspended': return 'warning';
    case 'deactivated':
    case 'left': return 'critical';
    default: return 'neutral';
  }
}

/** Sorts null ceilings last by standing in for +Infinity. */
function nullLast(value: number | null): number {
  return value === null ? Number.POSITIVE_INFINITY : value;
}

function cmp(a: string, b: string): number {
  return a.localeCompare(b, 'ar', { sensitivity: 'base' });
}

/** Turns an API error into something worth showing a person. */
function messageFor(e: FirmApiError, t: (k: string) => string): string {
  if (e.status === 0) return t('common.error.network');
  if (e.status === 403) return `${t('common.denied.title')} · ${e.code}`;
  if (e.status === 409) return e.message;
  return `${e.code}: ${e.message}`;
}
