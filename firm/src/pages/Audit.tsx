/**
 * AUDIT LOG · §51, §50
 *
 * The append-only record of who did what, including what was refused.
 *
 * SEARCHING THE LOG IS ITSELF A PRIVILEGE
 *   `/admin/audit` 404s for a member without `audit.read`. That is deliberate: a
 *   403 would confirm that a log search exists and that the caller lacks it,
 *   which is information about the firm's tooling. This screen therefore treats
 *   404 and 403 identically and renders `denied`.
 *
 * THE DENIALS ARE THE POINT
 *   An audit log that recorded only successes would be a activity feed. The rows
 *   that matter most are `denied` and `failure` — an ESCALATION_ATTEMPT, a
 *   CEILING_EXCEEDED, a cross-audience probe. Outcome is a first-class, sortable,
 *   filterable column here, and denials are visually distinct rather than
 *   uniform with successes.
 *
 * THE TENANT BOUNDARY IS IN THE QUERY
 *   Every row carries `tenantId`, and the server filters on it. The boundary is
 *   stated on the page rather than assumed, because an audit screen is exactly
 *   where a reviewer needs to know which firm's events they are looking at.
 *
 * IP HASHES ARE NOT SHOWN
 *   The server deliberately does not project them. An audit search is a
 *   privilege, but it is not a licence to deanonymize request metadata in bulk.
 *   This page says so, rather than leaving a conspicuously empty column.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Badge, Button, EmptyState, IconRefresh, PageSkeleton, Table, TextField,
  useFmt, useI18n, type BadgeTone, type Column, type SortState,
} from '@kgm/ui';
import { useFirmSession } from '../auth/FirmSession.js';
import { firmApi, FirmApiError, type AuditEvent } from '../api/firm.js';
import { PageHead } from './Users.js';
import '../shell/shell.css';

const PAGE_SIZE = 50;
const FETCH_LIMIT = 200;

export function Audit() {
  const { t } = useI18n();
  const fmt = useFmt();
  const { can, activeTenantId } = useFirmSession();

  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FirmApiError | null>(null);

  const [query, setQuery] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [sort, setSort] = useState<SortState | null>({ key: 'occurredAt', direction: 'desc' });
  const [page, setPage] = useState(1);

  const load = () => {
    setLoading(true);
    firmApi.audit({ limit: FETCH_LIMIT })
      .then((res) => { setEvents(res.events); setError(null); })
      .catch((err) => {
        setEvents(null);
        setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'unreachable'));
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const canRead = can('audit.read');

  /**
   * Action values present in the returned rows.
   *
   * Derived from the data for the same reason as on the member list: an option
   * that matches nothing yields an empty screen that reads as a defect, and a
   * static enum would advertise actions this firm has never recorded.
   */
  const actionsPresent = useMemo(() => {
    const set = new Set((events ?? []).map((e) => e.action).filter(Boolean));
    return [...set].sort();
  }, [events]);

  const outcomesPresent = useMemo(() => {
    const set = new Set((events ?? []).map((e) => e.outcome).filter(Boolean));
    return [...set].sort();
  }, [events]);

  const rows = useMemo(() => {
    let out = events ?? [];
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter((e) =>
        [e.action, e.resourceType, e.resourceId, e.reasonCode, e.actorUserId, e.actorKind]
          .some((v) => typeof v === 'string' && v.toLowerCase().includes(q)));
    }
    if (actionFilter) out = out.filter((e) => e.action === actionFilter);
    if (outcomeFilter) out = out.filter((e) => e.outcome === outcomeFilter);
    return out;
  }, [events, query, actionFilter, outcomeFilter]);

  useEffect(() => { setPage(1); }, [query, actionFilter, outcomeFilter]);

  const filtered = rows.length !== (events?.length ?? 0);
  const denials = rows.filter((e) => e.outcome !== 'success').length;

  const columns = useMemo<Array<Column<AuditEvent>>>(() => [
    {
      key: 'occurredAt',
      header: t('audit.col.occurredAt'),
      sortable: true,
      compare: (a, b) => cmpTime(a.occurredAt, b.occurredAt),
      width: '190px',
      cell: (e) => (
        <span className="firm-celltime">
          <span className="firm-celltime__abs">{fmt.dateTime(e.occurredAt)}</span>
          <span className="firm-celltime__rel">{fmt.relative(e.occurredAt)}</span>
        </span>
      ),
      cardLabel: t('audit.col.occurredAt'),
    },
    {
      key: 'action',
      header: t('audit.col.action'),
      sortable: true,
      compare: (a, b) => cmp(a.action ?? '', b.action ?? ''),
      cell: (e) => <span className="firm-cellmono" dir="ltr">{e.action ?? '—'}</span>,
      cardLabel: t('audit.col.action'),
    },
    {
      key: 'actor',
      header: t('audit.col.actor'),
      sortable: true,
      compare: (a, b) => cmp(a.actorKind ?? '', b.actorKind ?? ''),
      cell: (e) => (
        <div className="firm-cellperson">
          <span className="firm-cellperson__name">{actorLabel(e.actorKind, t)}</span>
          {e.actorUserId && (
            <span className="firm-cellperson__role" dir="ltr">{shortId(e.actorUserId)}</span>
          )}
        </div>
      ),
      responsive: 'desktop',
      cardLabel: t('audit.col.actor'),
    },
    {
      key: 'resource',
      header: t('audit.col.resource'),
      sortable: true,
      compare: (a, b) => cmp(a.resourceType ?? '', b.resourceType ?? ''),
      cell: (e) => (
        e.resourceType
          ? (
            <span className="firm-cellresource">
              {e.resourceType}
              {e.resourceId && <span className="firm-cellresource__id" dir="ltr">{shortId(e.resourceId)}</span>}
            </span>
          )
          : <span className="firm-muted">—</span>
      ),
      responsive: 'desktop',
      cardLabel: t('audit.col.resource'),
    },
    {
      key: 'outcome',
      header: t('audit.col.outcome'),
      sortable: true,
      compare: (a, b) => cmp(a.outcome ?? '', b.outcome ?? ''),
      cell: (e) => <Badge tone={toneForOutcome(e.outcome)} size="xs">{outcomeLabel(e.outcome, t)}</Badge>,
      cardLabel: t('audit.col.outcome'),
    },
    {
      key: 'reason',
      header: t('audit.col.reason'),
      sortable: true,
      compare: (a, b) => cmp(a.reasonCode ?? '', b.reasonCode ?? ''),
      cell: (e) => (
        e.reasonCode
          ? <span className="firm-cellmono" dir="ltr">{e.reasonCode}</span>
          : <span className="firm-muted">—</span>
      ),
      responsive: 'desktop',
      cardLabel: t('audit.col.reason'),
    },
  ], [t, fmt]);

  if (!canRead) {
    return (
      <div className="firm-page">
        <PageHead eyebrow={t('nav.admin')} title={t('audit.title')} sub={t('audit.sub')} />
        <EmptyState kind="denied" title={t('audit.denied.title')} description={t('audit.denied.body')} />
      </div>
    );
  }

  return (
    <div className="firm-page">
      <PageHead
        eyebrow={t('nav.admin')}
        title={t('audit.title')}
        sub={events
          ? t('audit.count', { n: fmt.numberLatin(events.length) })
          : t('common.loading')}
        actions={
          <Button variant="ghost" size="sm" icon={<IconRefresh size={15} />} onClick={load} disabled={loading}>
            {t('common.refresh')}
          </Button>
        }
      />

      {/*
        The tenant boundary, stated. An auditor looking at events needs to know
        whose events these are; the server enforces it, and saying so is what
        makes the enforcement visible rather than assumed.
      */}
      {activeTenantId && !loading && !error && (
        <Alert tone="info">
          {t('audit.tenantBoundary', { id: activeTenantId })}
        </Alert>
      )}

      {loading ? (
        <PageSkeleton title={t('audit.title')} hint={t('common.loading')} />
      ) : error ? (
        /*
          404 and 403 both mean "you may not search this log". The endpoint 404s
          for non-holders precisely so that its existence is not confirmed, and
          the UI must not undo that by explaining the difference.
        */
        error.isForbidden || error.isNotVisible ? (
          <EmptyState kind="denied" title={t('audit.denied.title')} description={t('audit.denied.body')} />
        ) : (
          <EmptyState
            kind={error.status === 0 ? 'offline' : 'error'}
            title={t('audit.error.title')}
            description={t('audit.error.body')}
            action={{ label: t('common.retry'), onClick: load }}
          />
        )
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            kind="empty"
            title={t('audit.emptyFiltered.title')}
            description={t('audit.emptyFiltered.body')}
            action={{
              label: t('matter.filter.clear'),
              onClick: () => { setQuery(''); setActionFilter(''); setOutcomeFilter(''); },
            }}
          />
        ) : (
          <EmptyState kind="empty" title={t('audit.empty.title')} description={t('audit.empty.body')} />
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
              placeholder={t('audit.search')}
              type="search"
              autoComplete="off"
            />
            <div className="firm-toolbar__filters">
              <select
                className="kgm-select"
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                aria-label={t('audit.filter.action')}
              >
                <option value="">{t('audit.filter.action')}: {t('common.all')}</option>
                {actionsPresent.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>

              <select
                className="kgm-select"
                value={outcomeFilter}
                onChange={(e) => setOutcomeFilter(e.target.value)}
                aria-label={t('audit.col.outcome')}
              >
                <option value="">{t('audit.col.outcome')}: {t('common.all')}</option>
                {outcomesPresent.map((o) => <option key={o} value={o}>{outcomeLabel(o, t)}</option>)}
              </select>

              {/* The denial count is the number an auditor actually wants. */}
              <span className="firm-toolbar__stat">
                {fmt.numberLatin(denials)} / {fmt.numberLatin(rows.length)}
              </span>

              {filtered && (
                <Button
                  variant="ghost" size="xs"
                  onClick={() => { setQuery(''); setActionFilter(''); setOutcomeFilter(''); }}
                >
                  {t('matter.filter.clear')}
                </Button>
              )}
            </div>
          </div>

          <Table
            columns={columns}
            rows={rows}
            rowKey={(e) => `${e.occurredAt}-${e.action}-${e.resourceId ?? ''}`}
            label={t('audit.title')}
            sort={sort}
            onSortChange={setSort}
            pagination={{ page, pageSize: PAGE_SIZE, total: rows.length, onChange: setPage }}
            density="compact"
            striped
            empty={t('audit.emptyFiltered.body')}
          />

          <p className="firm-footnote">{t('audit.limit', { n: fmt.numberLatin(FETCH_LIMIT) })}</p>
          <p className="firm-footnote">{t('audit.ipWithheld')}</p>
        </>
      )}
    </div>
  );
}

// ==========================================================================
// helpers

function toneForOutcome(outcome: string | null): BadgeTone {
  switch (outcome) {
    case 'success': return 'lime';
    case 'denied': return 'critical';
    case 'failure': return 'warning';
    default: return 'neutral';
  }
}

function outcomeLabel(outcome: string | null, t: (k: string) => string): string {
  switch (outcome) {
    case 'success': return t('audit.outcome.success');
    case 'denied': return t('audit.outcome.denied');
    case 'failure': return t('audit.outcome.failure');
    default: return outcome ?? '—';
  }
}

function actorLabel(kind: string | null, t: (k: string) => string): string {
  switch (kind) {
    case 'firm_member': return t('audit.actor.firm_member');
    case 'client_user': return t('audit.actor.client_user');
    case 'system': return t('audit.actor.system');
    default: return kind ?? '—';
  }
}

/** A UUID prefix. The full value is noise in a dense table and appears in detail views. */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function cmp(a: string, b: string): number {
  return a.localeCompare(b, 'ar', { sensitivity: 'base' });
}

/** Newest first by default, so this compares as instants rather than strings. */
function cmpTime(a: string | null, b: string | null): number {
  const ta = a ? Date.parse(a) : 0;
  const tb = b ? Date.parse(b) : 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return ta - tb;
}
