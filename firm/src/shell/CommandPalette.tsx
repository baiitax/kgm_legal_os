/**
 * COMMAND PALETTE / GLOBAL SEARCH · §14
 *
 * ⌘K opens it. Results are grouped by record type — clients, matters, documents,
 * invoices, hearings, users — and ONLY authorized records appear.
 *
 * HOW "ONLY AUTHORIZED" IS ACHIEVED
 *   Not by filtering client-side. The palette queries the same endpoints the
 *   screens use, and those endpoints are already scoped by RLS and by the
 *   resolver. A palette that fetched everything and filtered in the browser would
 *   be a client-side projection of a server-side decision — which is exactly the
 *   pattern §72's tests exist to catch.
 *
 *   The practical consequence is that the palette's result groups are a function
 *   of what the member can reach, and a group with no results is omitted rather
 *   than shown empty. An empty "Invoices" group tells a member that invoices
 *   exist and they cannot see them; omitting it does not.
 *
 *   The footer states the scope explicitly. A search that returns nothing is
 *   ambiguous — no matches, or no access — and §27's discipline is that the UI
 *   never implies the wrong one.
 *
 * KEYBOARD
 *   Arrow keys move, Enter opens, Escape closes. The active option is tracked in
 *   state and reflected through `aria-activedescendant` rather than by moving DOM
 *   focus, because moving focus into a listbox on every keystroke breaks typing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EmptyState, Modal, Spinner, useI18n, useFmt,
  IconBilling, IconClients, IconDocuments, IconHearings, IconMatters, IconSearch, IconUsers,
} from '@kgm/ui';
import { useFirmSession } from '../auth/FirmSession.js';
import { firmApi, FirmApiError, type MatterSummary } from '../api/firm.js';
import './shell.css';

interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onNavigate: (to: string) => void;
}

type ResultKind = 'matter' | 'client' | 'document' | 'invoice' | 'hearing' | 'user' | 'nav';

interface Result {
  readonly id: string;
  readonly kind: ResultKind;
  readonly title: string;
  readonly meta: string;
  readonly to: string;
}

const KIND_ICON: Record<ResultKind, typeof IconMatters> = {
  matter: IconMatters,
  client: IconClients,
  document: IconDocuments,
  invoice: IconBilling,
  hearing: IconHearings,
  user: IconUsers,
  nav: IconSearch,
};

const KIND_LABEL: Record<ResultKind, string> = {
  matter: 'nav.matters',
  client: 'nav.clients',
  document: 'nav.documents',
  invoice: 'nav.billing',
  hearing: 'nav.hearings',
  user: 'nav.users',
  nav: 'nav.workspace',
};

/** Group display order. Matters first: it is the object the firm runs on. */
const KIND_ORDER: ResultKind[] = ['nav', 'matter', 'client', 'hearing', 'document', 'invoice', 'user'];

export function CommandPalette({ open, onClose, onNavigate }: CommandPaletteProps) {
  const { t, lang } = useI18n();
  const fmt = useFmt();
  const { nav, can } = useFirmSession();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Bumps on each keystroke so an in-flight response for a stale query cannot
  // overwrite the results for the current one.
  const reqSeq = useRef(0);

  // Reset on open so a second invocation does not show the previous query's
  // results for a frame.
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setActive(0);
      setErrored(false);
      // Focus after the overlay has mounted and trapped focus.
      const id = window.setTimeout(() => inputRef.current?.focus(), 40);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  /**
   * Navigation targets the member may reach.
   *
   * Built from the SAME filtered nav the rail renders, so the palette cannot
   * offer a destination the sidebar hid. This is the §50 rule applied to search:
   * a shortcut that bypasses the permission-filtered navigation is a bypass.
   */
  const navResults = useMemo<Result[]>(() => {
    const out: Result[] = [];
    for (const { group, leaves } of nav.groups) {
      if (group.to) {
        out.push({ id: `nav:${group.id}`, kind: 'nav', title: t(group.labelKey), meta: '', to: group.to });
      }
      for (const leaf of leaves) {
        out.push({ id: `nav:${leaf.id}`, kind: 'nav', title: t(leaf.labelKey), meta: t(group.labelKey), to: leaf.to });
      }
    }
    return out;
  }, [nav, t]);

  /** Runs the search. Debounced by the caller's effect. */
  const run = useCallback(async (q: string) => {
    const seq = ++reqSeq.current;
    const term = q.trim();

    if (term.length === 0) {
      setResults(navResults.slice(0, 8));
      setLoading(false);
      setErrored(false);
      return;
    }

    setLoading(true);
    setErrored(false);

    const local = matchLocal(term, navResults);
    const found: Result[] = [...local];

    // Matters are the only server-backed group wired at present. Each additional
    // group must come from its own authorized endpoint — not from a wider fetch
    // filtered here.
    try {
      const list = await firmApi.matters();
      if (seq !== reqSeq.current) return;
      const hits = list.matters
        .filter((m) => matterMatches(m, term, lang))
        .slice(0, 6)
        .map((m): Result => ({
          id: `matter:${m.id}`,
          kind: 'matter',
          title: pickLang(m.titleAr, m.title, lang) ?? m.matterNumber ?? '—',
          meta: [
            m.matterNumber,
            pickLang(m.clientNameAr, m.clientName, lang),
            m.practiceArea ?? null,
          ].filter(Boolean).join(' · '),
          to: `/matters/${m.id}`,
        }));
      found.push(...hits);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      // A 403/404 here means the member cannot search matters at all, which is a
      // scope fact rather than a failure — the palette still works for nav.
      if (!(err instanceof FirmApiError) || (err.status !== 403 && err.status !== 404)) {
        setErrored(true);
      }
    }

    if (seq !== reqSeq.current) return;
    setResults(found);
    setActive(0);
    setLoading(false);
  }, [navResults, lang, fmt]);

  // Debounce. 180ms is short enough to feel immediate and long enough that
  // typing a matter number does not fire a request per keystroke.
  useEffect(() => {
    if (!open) return undefined;
    const id = window.setTimeout(() => { void run(query); }, query.trim() ? 180 : 0);
    return () => window.clearTimeout(id);
  }, [query, open, run]);

  /** Grouped for display, in KIND_ORDER, dropping empty groups. */
  const grouped = useMemo(() => {
    const byKind = new Map<ResultKind, Result[]>();
    for (const r of results) {
      const arr = byKind.get(r.kind);
      if (arr) arr.push(r); else byKind.set(r.kind, [r]);
    }
    return KIND_ORDER
      .filter((k) => byKind.has(k))
      .map((k) => ({ kind: k, items: byKind.get(k)! }));
  }, [results]);

  /** Flat list for keyboard indexing, in display order. */
  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  const open_ = (r: Result) => { onNavigate(r.to); onClose(); };

  const onListKeydown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (flat.length ? (a + 1) % flat.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = flat[active];
      if (r) open_(r);
    }
  };

  // Keep the active row in view as arrows move it.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const listId = 'kgm-palette-list';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('topbar.commandPalette')}
      size="lg"
      className="kgm-palette"
      // The dialog needs an accessible title. The visible search field is the
      // real heading, so this one is visually hidden rather than duplicated.
    >
      <input
        ref={inputRef}
        className="kgm-palette__input"
        type="search"
        value={query}
        placeholder={t('topbar.search')}
        aria-label={t('topbar.search')}
        aria-controls={listId}
        aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        role="combobox"
        aria-expanded={flat.length > 0}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onListKeydown}
      />

      <div className="kgm-palette__body" id={listId} role="listbox" aria-label={t('topbar.search')} ref={listRef}>
        {loading && flat.length === 0 ? (
          <div className="kgm-palette__loading"><Spinner size={16} />{t('common.loading')}</div>
        ) : flat.length === 0 ? (
          errored ? (
            <EmptyState kind="error" title={t('common.error.title')} description={t('common.error.network')} compact />
          ) : (
            <EmptyState
              kind="empty"
              title={t('common.notFound.title')}
              // The wording matters: "no results" would claim the record does
              // not exist. The honest statement is that nothing AUTHORIZED matched.
              description={t('common.denied.body')}
              compact
            />
          )
        ) : (
          grouped.map((g) => (
            <div className="kgm-palette__group" key={g.kind}>
              <p className="kgm-palette__grouplabel">{t(KIND_LABEL[g.kind])}</p>
              {g.items.map((r) => {
                const idx = flat.indexOf(r);
                const Icon = KIND_ICON[r.kind];
                return (
                  <button
                    key={r.id}
                    type="button"
                    className="kgm-palette__item"
                    role="option"
                    id={`${listId}-${idx}`}
                    data-idx={idx}
                    aria-selected={idx === active}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => open_(r)}
                  >
                    <span className="kgm-palette__itemicon" aria-hidden="true"><Icon size={16} /></span>
                    <span className="kgm-palette__itembody">
                      <span className="kgm-palette__itemtitle">{r.title}</span>
                      {r.meta && <span className="kgm-palette__itemmeta">{r.meta}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div className="kgm-palette__foot">
        <span className="kgm-palette__hint"><kbd className="kbd">↑↓</kbd> {t('common.search')}</span>
        <span className="kgm-palette__hint"><kbd className="kbd">↵</kbd> {t('common.confirm')}</span>
        <span className="kgm-palette__hint"><kbd className="kbd">esc</kbd> {t('common.close')}</span>
        {/* §14's scope statement. Also the reason `can` is referenced here: the
            palette adapts its own footnote to what the member may search. */}
        <span className="kgm-palette__scope">
          {can('matters.read') || can('matters.read_all')
            ? t('dash.scopeNotice')
            : t('common.denied.body')}
        </span>
      </div>
    </Modal>
  );
}

// ==========================================================================

function pickLang(ar: string | null | undefined, en: string | null | undefined, lang: string): string | null {
  if (lang === 'ar') return ar ?? en ?? null;
  return en ?? ar ?? null;
}

/** Local (navigation) matching, language-agnostic. */
function matchLocal(term: string, navResults: Result[]): Result[] {
  const lower = term.toLowerCase();
  return navResults.filter((r) =>
    r.title.toLowerCase().includes(lower) || r.meta.toLowerCase().includes(lower),
  ).slice(0, 5);
}

/**
 * Matter matching.
 *
 * Deliberately tolerant of the ways a practitioner actually types a reference:
 * a bare number ("178"), a hyphenated one ("KGM-2025-178"), Arabic or Latin
 * digits. §14's search is only useful if it meets people where they type.
 */
function matterMatches(m: MatterSummary, term: string, lang: string): boolean {
  const lower = term.toLowerCase();
  const title = pickLang(m.titleAr, m.title, lang)?.toLowerCase() ?? '';
  const client = pickLang(m.clientNameAr, m.clientName, lang)?.toLowerCase() ?? '';
  const num = (m.matterNumber ?? '').toLowerCase();
  const practice = (m.practiceAreaAr ?? '').toLowerCase() + ' ' + (m.practiceArea ?? '').toLowerCase();

  if (title.includes(lower) || client.includes(lower) || practice.includes(lower)) return true;
  if (num === lower) return true;
  // Trailing-segment match: "178" finds "KGM-2025-178".
  const tail = num.split(/[-/]/).pop() ?? '';
  return tail.length > 0 && tail === lower.replace(/[^0-9٠-٩]/g, '');
}
