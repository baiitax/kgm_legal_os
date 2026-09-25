/**
 * BOTTOM NAV · §16, §17, §50
 *
 * Floating, rounded, pill-shaped, elevated. Five items. The design brief is
 * "advanced, highly user-driven, with a deep sense of elegance" — and in a
 * product whose §50 rule is that the visual system must never override the
 * authorization system, "advanced" cannot mean "clever". Every behaviour below
 * has to be one a member can predict, and none of them may widen what is
 * reachable.
 *
 * THE PERMISSION PROBLEM THIS SOLVES
 *   §16 names five fixed items, but §50 says the navigation must reflect what the
 *   member may actually reach. Those collide the moment a member lacks
 *   `tasks.read`: a fixed five-item bar would show a tab that 404s on tap.
 *
 *   So the FIVE SLOTS are fixed and their CONTENTS are not. Home and More are
 *   always present; the three middle slots are filled from the permission-
 *   filtered nav. The bar never changes shape; it changes meaning.
 *
 * WHAT "USER-DRIVEN" MEANS HERE, AND ITS ONE HARD LIMIT
 *   The three flexible slots rank themselves by what the member actually opens.
 *   A paralegal who lives in Hearings stops looking at a Documents tab they never
 *   touch. Usage is counted locally, per membership, in `localStorage`, and is
 *   never sent anywhere.
 *
 *   THE LIMIT: ranking can only REORDER the authorised candidate list. A module
 *   the member may not reach is not in that list, so it can never win a slot, and
 *   a stale `localStorage` entry naming one is simply ignored — the stored ids are
 *   intersected with the authorised set before ranking, not merged with it.
 *   Otherwise a shared device would hand the next member the previous one's
 *   modules. The bar bends to the person; the database still decides what there
 *   is to bend to.
 *
 * AND WHY THE RANKING IS FROZEN WHILE THE APP IS OPEN
 *   Counts are written on every navigation, so a live re-rank would move the tab
 *   the member is reaching for, under their thumb, on the fourth visit to a
 *   screen. The allocation is therefore computed once per authorised SET: it
 *   holds for the session and re-ranks on the next load, or immediately if the
 *   set itself changes (a tenant switch, a role change). Movement the member
 *   caused and cannot see is fine; movement under their finger is not.
 *
 * ELEGANCE, MADE CONCRETE
 *   · A single sliding lamp marks the active slot and travels between them,
 *     measured from the real layout so it survives a language switch, a font
 *     fallback and a viewport change. In RTL it measures from the inline-start
 *     edge, so it does not slide backwards.
 *   · The bar recedes while the member reads downward and returns on any upward
 *     scroll, on navigation, at the top of the page, or the moment it is focused
 *     — so it is never lost, only out of the way. Skipped entirely under
 *     `prefers-reduced-motion`.
 *   · Tapping the slot you are already on scrolls that screen back to the top,
 *     which is the gesture a thumb expects and the only thing a tab can usefully
 *     do when it is already current.
 *   · More lights up when the current screen lives inside it, so the bar always
 *     answers "where am I" — the one question a bottom bar is really for.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '@kgm/ui';
import { useFirmSession } from '../auth/FirmSession.js';
import type { NavLeaf } from '../app/nav.js';
import './shell.css';

interface BottomNavProps {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
  readonly onOpenMore: () => void;
  /** Unread counts, keyed by the badge source declared in nav.ts. */
  readonly badges?: Partial<Record<NonNullable<NavLeaf['badgeKey']>, number>>;
}

/**
 * Priority order for the three flexible slots.
 *
 * This is the DEFAULT, not the rule. It decides the bar for a member with no
 * history — which is every member on their first day, and every member whose
 * browser refuses `localStorage`. Matters and tasks lead because they are what a
 * lawyer opens a phone for; administration is last because a partner checking a
 * hearing time on the way to court is not there to manage users.
 */
const SLOT_PRIORITY: readonly string[] = [
  'matters', 'tasks', 'documents', 'hearings', 'deadlines', 'billing',
  'mywork', 'calendar', 'clients', 'notifications', 'messages',
  'contracts', 'poa', 'time', 'expenses', 'collections',
  'conflicts', 'licences', 'training', 'complaints',
  'users', 'teams', 'settings', 'audit',
];

const SLOT_COUNT = 3;
const HOME = '/';

/** Ranks a nav id by the default order; unknown ids sort last, stably. */
function rank(id: string): number {
  const i = SLOT_PRIORITY.indexOf(id);
  return i === -1 ? SLOT_PRIORITY.length : i;
}

/* --------------------------------------------------------------------------
   Local usage memory
   --------------------------------------------------------------------------
   Deliberately small and deliberately forgiving: it is a preference, not state.
   Every entry point swallows its own failure, because a browser in private mode
   throws on `localStorage` access and a navigation bar that crashes the shell
   when storage is unavailable is a far worse outcome than a bar that does not
   learn.
   -------------------------------------------------------------------------- */

const STORAGE_PREFIX = 'kgm.navuse.';

function usageKey(membershipId: string | null): string | null {
  // Unscoped usage would let one member's habits shape the next member's bar on
  // a shared device. Without an identity to key on, nothing is remembered.
  return membershipId ? `${STORAGE_PREFIX}${membershipId}` : null;
}

function readUsage(key: string | null): Record<string, number> {
  if (!key) return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [id, n] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[id] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function bumpUsage(key: string | null, id: string): void {
  if (!key) return;
  try {
    const usage = readUsage(key);
    // Capped rather than unbounded: a count that can grow forever eventually
    // pins a slot for good, and this is a preference, not a record.
    usage[id] = Math.min((usage[id] ?? 0) + 1, 999);
    window.localStorage.setItem(key, JSON.stringify(usage));
  } catch {
    /* storage full or refused — the default order stands */
  }
}

/* -------------------------------------------------------------------------- */

export function BottomNav({ path, onNavigate, onOpenMore, badges }: BottomNavProps) {
  const { t, lang } = useI18n();
  const { nav, member } = useFirmSession();

  /**
   * Flattens the filtered nav into candidates, ordered by SLOT_PRIORITY.
   *
   * Derived from `nav` — the same permission-filtered tree the rail renders — so
   * the bottom bar and the sidebar can never disagree about what is reachable.
   * This list is the WHOLE authorised set, and it is the only thing ranking is
   * ever allowed to choose from.
   */
  const candidates = useMemo(() => {
    const items: NavLeaf[] = [];
    for (const { group, leaves } of nav.groups) {
      // A childless group (matters, clients, messages) is itself the destination.
      if (group.to && leaves.length === 0) {
        items.push({
          id: group.id,
          to: group.to,
          labelKey: group.labelKey,
          icon: group.icon,
          permissions: group.permissions,
          planned: false,
        });
        continue;
      }
      for (const leaf of leaves) {
        if (leaf.planned) continue; // A planned module is not a destination.
        items.push(leaf);
      }
    }
    return items.filter((i) => i.id !== 'dashboard').sort((a, b) => rank(a.id) - rank(b.id));
  }, [nav]);

  const membershipId = member?.membershipId ?? null;
  const key = usageKey(membershipId);

  /**
   * The authorised set, as a stable string. The allocation below is memoised on
   * this rather than on `candidates`, which is a fresh array on every render of
   * the provider and would re-rank on each one.
   */
  const setSignature = candidates.map((c) => c.id).join('|');

  /**
   * The frozen ranking: which three ids hold the flexible slots.
   *
   * Keyed on the SET (so a permission or tenant change re-ranks at once) and on
   * `key` (so a different member's habits never leak in on a shared device) —
   * and deliberately not on the usage counts, which is what keeps the bar still
   * while the member is using it.
   */
  const rankedIds = useMemo(() => {
    const usage = readUsage(key);
    const ids = [...candidates].map((c) => c.id);
    ids.sort((a, b) => {
      const byUse = (usage[b] ?? 0) - (usage[a] ?? 0);
      if (byUse !== 0) return byUse;
      const byRank = rank(a) - rank(b);
      return byRank !== 0 ? byRank : a.localeCompare(b);
    });
    return ids.slice(0, SLOT_COUNT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSignature, key]);

  /** Resolved fresh on every render, so a slot always holds the live leaf. */
  const slots = useMemo(
    () => rankedIds.map((id) => candidates.find((c) => c.id === id)).filter((c): c is NavLeaf => !!c),
    [rankedIds, candidates],
  );

  const reachable = useMemo(() => new Set(candidates.map((c) => c.id)), [setSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  const isActive = (to: string) => (to === HOME ? path === HOME : path === to || path.startsWith(`${to}/`));

  /** True when the current screen is reachable but did not win a slot. */
  const currentLivesInMore =
    !isActive(HOME) && candidates.some((c) => isActive(c.to)) && !slots.some((s) => isActive(s.to));

  /* -- usage is written, never read, from the render path ---------------- */

  const lastCounted = useRef<string | null>(null);
  useEffect(() => {
    if (path === lastCounted.current) return;
    lastCounted.current = path;
    const hit = candidates.find((c) => (c.to === HOME ? path === HOME : path === c.to || path.startsWith(`${c.to}/`)));
    // Only ever counts a module the member is authorised to reach — the same
    // intersection that guards the read side.
    if (hit && reachable.has(hit.id)) bumpUsage(key, hit.id);
  }, [path, candidates, reachable, key]);

  /* -- the sliding lamp -------------------------------------------------- */

  const navRef = useRef<HTMLElement | null>(null);
  const [lamp, setLamp] = useState<{ start: number; width: number } | null>(null);

  useEffect(() => {
    const el = navRef.current;
    if (!el) return;

    const measure = () => {
      const active = el.querySelector<HTMLElement>('.kgm-bottomnav__item[data-active]');
      if (!active) {
        setLamp(null);
        return;
      }
      const navBox = el.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      // jsdom has no layout, and the bar is display:none above 900px: both give
      // a zero box. Leaving the lamp unset is correct — there is nothing to
      // point at — and it keeps this effect from needing a test-only branch.
      if (box.width === 0) {
        setLamp(null);
        return;
      }
      const rtl = window.getComputedStyle(el).direction === 'rtl';
      // Anchor to the INLINE-START edge in both directions, so the lamp travels
      // the same way the reading does.
      const start = rtl ? navBox.right - box.right : box.left - navBox.left;
      setLamp({ start, width: box.width });
    };

    measure();

    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    window.addEventListener('resize', measure);
    // A language switch flips `dir` on the document, which moves every edge.
    const mo = new MutationObserver(measure);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] });

    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      mo.disconnect();
    };
    // `lang` re-measures after a direction flip even where MutationObserver is
    // unavailable; `path` re-measures when the active slot changes.
  }, [path, slots, lang]);

  /* -- recede while reading downward ------------------------------------- */

  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    // A bar that slides is a bar that distracts. Where motion is unwelcome, the
    // bar simply stays put — this is a convenience, never the only route.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    let lastY = window.scrollY;
    let ticking = false;

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        ticking = false;
        const y = window.scrollY;
        const delta = y - lastY;
        // A dead zone: a two-pixel jitter from a trackpad or a rubber-banding
        // overscroll must not flip the bar on and off.
        if (Math.abs(delta) < 12) return;
        lastY = y;
        setHidden(y > 120 && delta > 0);
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    const onFocus = () => setHidden(false);
    // Keyboard focus can land inside the bar without a scroll event; the bar must
    // come back before the member reaches it.
    window.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('focusin', onFocus);
    };
  }, []);

  // Any navigation returns the bar, so the member is never left on a new screen
  // with the navigation missing.
  useEffect(() => setHidden(false), [path]);

  /* -- tapping the current tab goes to the top --------------------------- */

  const go = (to: string) => {
    if (isActive(to)) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    onNavigate(to);
  };

  const settle = () => setHidden(false);

  return (
    <nav
      ref={navRef}
      className="kgm-bottomnav"
      aria-label={t('nav.bottom')}
      data-receded={hidden || undefined}
    >
      {/* The lamp: one element that travels, rather than a background painted on
          five items. It is decoration, so it is hidden from assistive tech — the
          meaning is carried by `aria-current` on the item itself. */}
      {lamp && (
        <span
          className="kgm-bottomnav__lamp"
          aria-hidden="true"
          style={{ '--lamp-start': `${lamp.start}px`, '--lamp-width': `${lamp.width}px` } as CSSProperties}
        />
      )}

      <Slot
        label={t('mobile.home')}
        active={isActive(HOME)}
        onActivate={() => { settle(); go(HOME); }}
        glyph={<HomeGlyph />}
      />

      {slots.map((slot) => {
        const active = isActive(slot.to);
        const count = slot.badgeKey ? badges?.[slot.badgeKey] : undefined;
        const Icon = slot.icon;
        return (
          <Slot
            key={slot.id}
            label={t(slot.labelKey)}
            active={active}
            count={count}
            onActivate={() => { settle(); go(slot.to); }}
            glyph={<Icon size={20} />}
          />
        );
      })}

      {/* More is always last and always present: it is the only route to modules
          that did not win a slot, so removing it when the bar looks full would
          strand them. It takes the active state when the current screen is inside
          it — otherwise the bar would show nothing current at all, and a member
          deep in Settings would have no idea the bar was even relevant. */}
      <Slot
        label={t('mobile.more')}
        active={currentLivesInMore}
        onActivate={() => { settle(); onOpenMore(); }}
        glyph={<MoreGlyph />}
        haspopup
      />
    </nav>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * One slot.
 *
 * Extracted because the five are structurally identical and the accessible-name
 * logic — label, plus the badge count for a screen reader, exactly once — is the
 * part that must not be reimplemented per slot and drift.
 */
function Slot({
  label, active, count, glyph, onActivate, haspopup,
}: {
  label: string;
  active: boolean;
  count?: number;
  glyph: ReactNode;
  onActivate: () => void;
  haspopup?: boolean;
}) {
  const { t } = useI18n();
  const hasCount = !!count && count > 0;

  return (
    <button
      type="button"
      className="kgm-bottomnav__item"
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      aria-haspopup={haspopup ? 'dialog' : undefined}
      aria-label={hasCount ? `${label}, ${t('nav.badgeCount', { n: count })}` : undefined}
      onClick={onActivate}
    >
      <span className="kgm-bottomnav__icon" aria-hidden="true">
        {glyph}
        {hasCount && (
          <span className="kgm-badge kgm-badge--count" aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </span>
      <span className="kgm-bottomnav__label">{label}</span>
    </button>
  );
}

/* --------------------------------------------------------------------------
   Glyphs
   Two icons the shared set does not carry, drawn here rather than added to
   @kgm/ui: "home" and "more" are shell navigation concepts, not part of the
   product's icon vocabulary, and putting them in the shared set would invite
   their use inside content where they mean nothing.
   -------------------------------------------------------------------------- */

function HomeGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3.5 10.5 12 3.5l8.5 7v9a1 1 0 0 1-1 1h-4.75v-5.5h-5.5v5.5H4.5a1 1 0 0 1-1-1z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MoreGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="4.5" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="4.5" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="17" cy="17" r="1.3" fill="currentColor" />
      <circle cx="17" cy="17" r="3.4" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
