/**
 * TABLE · §24
 *
 * Requirements from the brief: search, filter, sort, pagination, column control,
 * saved views, export, bulk actions, glass header, soft row separators, hover
 * state, sticky header, and "avoid heavy borders".
 *
 * TWO DECISIONS WORTH EXPLAINING
 *
 * 1. THIS IS PRESENTATIONAL. Sorting and pagination are implemented here because
 *    they are interaction, but the DATA is passed in and the callbacks are handed
 *    back. A table that fetches is a table that knows an endpoint, and §3 forbids
 *    that in this package. Server-side sorting therefore works by lifting
 *    `sort` and `onSortChange` to the caller; client-side works by leaving them
 *    unset and passing the already-sorted array.
 *
 * 2. IT IS A REAL <table>, NOT A GRID OF DIVS.
 *    §44 requires screen-reader support. A div grid with `role="table"` bolted on
 *    is a reimplementation of table semantics that will be wrong in some browser
 *    and nobody will notice until an accessibility audit. The cost is that a real
 *    table cannot use CSS grid for column sizing, so column widths are set with
 *    `<col>` and sticky headers use `position: sticky` on `<th>`, which works.
 *
 * MOBILE (§43)
 *    A dense enterprise table does not fit a phone and the brief says so —
 *    "mobile-friendly tables". Rather than a horizontally scrolling table that
 *    hides its own row identity, `cardColumns` lets a caller declare which cells
 *    become a stacked card on small screens. The table is still a table above the
 *    breakpoint; below it, each row is a labelled definition list.
 */
import {
  useCallback, useMemo,
  type CSSProperties, type ReactNode,
} from 'react';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: string;
  direction: SortDirection;
}

export interface Column<T> {
  /** Stable key. Used for sorting, column visibility and saved views. */
  key: string;
  header: ReactNode;
  /** Accessible header text when `header` is a node. Required for icon headers. */
  headerLabel?: string;
  cell: (row: T, index: number) => ReactNode;
  /** Sortable when a comparator or a server sort key is provided. */
  sortable?: boolean;
  /** Comparator for client-side sorting. Omit when the server sorts. */
  compare?: (a: T, b: T) => number;
  align?: 'start' | 'end' | 'center';
  /** Relative width hint, applied via <col>. */
  width?: string;
  /** Hides the column below this breakpoint. `card` columns survive into the
   *  mobile card view; `hide` columns do not. */
  responsive?: 'always' | 'tablet' | 'desktop' | 'card' | 'hide';
  /** Numeric columns get tabular alignment (§29). */
  numeric?: boolean;
  /** Rendered in the mobile card view as a labelled pair. */
  cardLabel?: string;
}

export interface TableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  /** Unique id per row, for keys and selection. */
  rowKey: (row: T) => string;
  /** Accessible name for the table. Required — an unnamed table is a nameless region. */
  label: string;
  caption?: ReactNode;

  empty?: ReactNode;
  loading?: boolean;

  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;

  /** Enables row selection and bulk actions (§24). */
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onSelectedChange?: (next: Set<string>) => void;

  onRowClick?: (row: T) => void;

  /** Sticky header. On by default; disable inside a scrolling card. */
  stickyHeader?: boolean;
  /** Row density. `compact` for finance and audit (§29: precise, not decorative). */
  density?: 'comfortable' | 'compact';
  /** Zebra striping. Off by default — soft separators read as more premium. */
  striped?: boolean;

  /** Toolbar slots. The table does not own search or filter STATE (§25) because
   *  those are page concerns; it provides the slots so layout stays consistent. */
  toolbarStart?: ReactNode;
  toolbarEnd?: ReactNode;

  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    onChange: (page: number) => void;
  };

  className?: string;
  style?: CSSProperties;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  label,
  caption,
  empty,
  loading = false,
  sort = null,
  onSortChange,
  selectable = false,
  selected,
  onSelectedChange,
  onRowClick,
  stickyHeader = true,
  density = 'comfortable',
  striped = false,
  toolbarStart,
  toolbarEnd,
  pagination,
  className = '',
  style,
}: TableProps<T>) {
  const selectedSet = useMemo(() => selected ?? new Set<string>(), [selected]);
  const allSelected = rows.length > 0 && rows.every((r) => selectedSet.has(rowKey(r)));
  const someSelected = rows.some((r) => selectedSet.has(rowKey(r)));

  const toggleAll = useCallback(() => {
    if (!onSelectedChange) return;
    if (allSelected) onSelectedChange(new Set());
    else onSelectedChange(new Set(rows.map(rowKey)));
  }, [allSelected, onSelectedChange, rows, rowKey]);

  const toggleOne = useCallback((key: string) => {
    if (!onSelectedChange) return;
    const next = new Set(selectedSet);
    if (next.has(key)) next.delete(key); else next.add(key);
    onSelectedChange(next);
  }, [onSelectedChange, selectedSet]);

  const requestSort = useCallback((col: Column<T>) => {
    if (!col.sortable || !onSortChange) return;
    if (!sort || sort.key !== col.key) { onSortChange({ key: col.key, direction: 'asc' }); return; }
    if (sort.direction === 'asc') { onSortChange({ key: col.key, direction: 'desc' }); return; }
    // Third click clears. A sort the user cannot remove is a sort they cannot
    // get back to the table's natural order.
    onSortChange(null);
  }, [onSortChange, sort]);

  // Client-side sorting when the column supplies a comparator and the caller has
  // not taken over via onSortChange.
  const sortedRows = useMemo(() => {
    if (!sort || onSortChange) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.compare) return rows;
    const copy = [...rows];
    copy.sort(col.compare);
    return sort.direction === 'desc' ? copy.reverse() : copy;
  }, [rows, sort, onSortChange, columns]);

  const hasToolbar = !!(toolbarStart || toolbarEnd || (selectable && someSelected));

  return (
    <div className={`kgm-tablewrap ${className}`} style={style}>
      {hasToolbar ? (
        <div className="kgm-tablewrap__toolbar">
          <div className="kgm-tablewrap__toolbar-start">{toolbarStart}</div>
          {selectable && someSelected ? (
            <div className="kgm-tablewrap__bulk" role="status">
              <span className="t-meta num">{selectedSet.size}</span>
            </div>
          ) : null}
          <div className="kgm-tablewrap__toolbar-end">{toolbarEnd}</div>
        </div>
      ) : null}

      <div className={`kgm-tablescroll${stickyHeader ? ' kgm-tablescroll--sticky' : ''}`}>
        <table
          className={[
            'kgm-table',
            `kgm-table--${density}`,
            striped ? 'kgm-table--striped' : '',
            selectable ? 'kgm-table--selectable' : '',
            onRowClick ? 'kgm-table--clickable' : '',
          ].filter(Boolean).join(' ')}
          aria-label={label}
          aria-busy={loading || undefined}
        >
          {caption ? <caption className="sr-only">{caption}</caption> : null}

          <colgroup>
            {selectable ? <col style={{ inlineSize: '40px' }} /> : null}
            {columns.map((c) => (
              <col key={c.key} style={c.width ? { inlineSize: c.width } : undefined} />
            ))}
          </colgroup>

          <thead>
            <tr>
              {selectable ? (
                <th scope="col" className="kgm-table__check" data-responsive="always">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    // Indeterminate cannot be set as an attribute; the ref below
                    // handles it. Without this a partial selection looks unselected.
                    ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
                    onChange={toggleAll}
                    aria-label={allSelected ? 'Clear selection' : 'Select all rows'}
                  />
                </th>
              ) : null}
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={[
                      'kgm-table__th',
                      c.align ? `kgm-table__th--${c.align}` : '',
                      c.numeric ? 'num' : '',
                      c.sortable ? 'kgm-table__th--sortable' : '',
                      active ? 'kgm-table__th--sorted' : '',
                      c.responsive && c.responsive !== 'always' ? `kgm-hide-${c.responsive}` : '',
                    ].filter(Boolean).join(' ')}
                    aria-sort={active ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : (c.sortable ? 'none' : undefined)}
                  >
                    {c.sortable ? (
                      <button type="button" className="kgm-table__sortbtn" onClick={() => requestSort(c)}>
                        <span>{c.header}</span>
                        <span className="kgm-table__sortmark" aria-hidden="true">
                          {active ? (sort!.direction === 'asc' ? '↑' : '↓') : '↕'}
                        </span>
                        <span className="sr-only">{c.headerLabel ?? (typeof c.header === 'string' ? c.header : '')}</span>
                      </button>
                    ) : (
                      <>
                        {c.header}
                        {!c.headerLabel && typeof c.header !== 'string' ? null : null}
                      </>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {sortedRows.map((row, i) => {
              const key = rowKey(row);
              const isSel = selectedSet.has(key);
              return (
                <tr
                  key={key}
                  className={isSel ? 'kgm-table__row kgm-table__row--selected' : 'kgm-table__row'}
                  // A clickable row is also keyboard-reachable. Without tabIndex
                  // and a key handler the row is mouse-only, which fails §44.
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); }
                  } : undefined}
                  aria-selected={selectable ? isSel : undefined}
                >
                  {selectable ? (
                    <td className="kgm-table__check" data-responsive="always">
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggleOne(key)}
                        // Stop the row's own click handler from firing twice.
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select row ${i + 1}`}
                      />
                    </td>
                  ) : null}
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={[
                        'kgm-table__td',
                        c.align ? `kgm-table__td--${c.align}` : '',
                        c.numeric ? 'num' : '',
                        c.responsive && c.responsive !== 'always' ? `kgm-hide-${c.responsive}` : '',
                        c.responsive === 'card' ? 'kgm-card-cell' : '',
                      ].filter(Boolean).join(' ')}
                      data-label={c.cardLabel ?? (typeof c.header === 'string' ? c.header : undefined)}
                    >
                      {c.cell(row, i)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>

        {!loading && sortedRows.length === 0 ? (
          <div className="kgm-table__empty">
            {empty ?? <span className="t-body c-muted">—</span>}
          </div>
        ) : null}
      </div>

      {pagination ? <TablePagination {...pagination} /> : null}
    </div>
  );
}

export function TablePagination({ page, pageSize, total, onChange }: {
  page: number; pageSize: number; total: number; onChange: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <nav className="kgm-pagination" aria-label="Pagination">
      <span className="kgm-pagination__count t-meta c-muted num">
        {from}–{to} / {total}
      </span>
      <div className="kgm-pagination__controls">
        <button
          type="button"
          className="kgm-pagination__btn"
          onClick={() => onChange(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >‹</button>
        <span className="kgm-pagination__page t-meta num" aria-live="polite">
          {page} / {pages}
        </span>
        <button
          type="button"
          className="kgm-pagination__btn"
          onClick={() => onChange(page + 1)}
          disabled={page >= pages}
          aria-label="Next page"
        >›</button>
      </div>
    </nav>
  );
}
