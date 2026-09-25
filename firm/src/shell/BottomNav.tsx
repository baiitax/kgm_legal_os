/**
 * BOTTOM NAV · §16, §17
 *
 * Floating, rounded, pill-shaped, elevated. Home / Matters / Tasks / Documents /
 * More.
 *
 * THE PERMISSION PROBLEM THIS SOLVES
 *   §16 names five fixed items, but §50 says the navigation must reflect what the
 *   member may actually reach. Those two requirements collide the moment a member
 *   lacks `tasks.read` or `documents.read`: a fixed five-item bar would show them
 *   a tab that 404s on tap.
 *
 *   The resolution is that the FIVE SLOTS are fixed and their CONTENTS are not.
 *   Home and More are always present (every member has a dashboard, and More is
 *   the escape hatch to everything else). The three middle slots are filled from
 *   the permission-filtered nav in a stable priority order, so a member without
 *   documents sees their next-most-relevant module in that slot instead of a dead
 *   link. The bar never changes shape; it changes meaning.
 *
 *   That keeps §16's visual promise and §50's authorization promise at once,
 *   which a hardcoded bar cannot.
 */
import { useMemo } from 'react';
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
 * Matters and tasks come first because they are what a lawyer opens a phone for;
 * documents next; then the operational and financial modules. Administration is
 * deliberately last — a partner checking a hearing time on the way to court is
 * not there to manage users, and giving admin a slot would cost a more useful one.
 */
const SLOT_PRIORITY: readonly string[] = [
  'matters', 'tasks', 'documents', 'hearings', 'deadlines', 'billing',
  'mywork', 'calendar', 'clients', 'notifications', 'messages',
  'contracts', 'poa', 'time', 'expenses', 'collections',
  'conflicts', 'licences', 'training', 'complaints',
  'users', 'teams', 'settings', 'audit',
];

export function BottomNav({ path, onNavigate, onOpenMore, badges }: BottomNavProps) {
  const { t } = useI18n();
  const { nav } = useFirmSession();

  /**
   * Flattens the filtered nav into candidates, ordered by SLOT_PRIORITY.
   *
   * Derived from `nav` — the same permission-filtered tree the rail renders — so
   * the bottom bar and the sidebar can never disagree about what is reachable.
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
    const rank = (id: string) => {
      const i = SLOT_PRIORITY.indexOf(id);
      return i === -1 ? SLOT_PRIORITY.length : i;
    };
    return items.sort((a, b) => rank(a.id) - rank(b.id));
  }, [nav]);

  // Home is always first and always present.
  const slots = candidates.filter((c) => c.id !== 'dashboard').slice(0, 3);

  const isActive = (to: string) => path === to || path.startsWith(`${to}/`);

  return (
    <nav className="kgm-bottomnav" aria-label={t('app.tagline')}>
      <button
        type="button"
        className="kgm-bottomnav__item"
        data-active={isActive('/') || undefined}
        aria-current={isActive('/') ? 'page' : undefined}
        onClick={() => onNavigate('/')}
      >
        <span className="kgm-bottomnav__icon" aria-hidden="true">
          <HomeGlyph />
        </span>
        <span className="kgm-bottomnav__label">{t('mobile.home')}</span>
      </button>

      {slots.map((slot) => {
        const active = isActive(slot.to);
        const count = slot.badgeKey ? badges?.[slot.badgeKey] : undefined;
        const Icon = slot.icon;
        return (
          <button
            key={slot.id}
            type="button"
            className="kgm-bottomnav__item"
            data-active={active || undefined}
            aria-current={active ? 'page' : undefined}
            onClick={() => onNavigate(slot.to)}
          >
            <span className="kgm-bottomnav__icon" aria-hidden="true">
              <Icon size={20} />
              {/* The count badge is visual only; the accessible name below
                  carries it, so a screen-reader user is not told twice. */}
              {!!count && count > 0 && (
                <span className="kgm-badge kgm-badge--count" aria-hidden="true">
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </span>
            <span className="kgm-bottomnav__label">{t(slot.labelKey)}</span>
            {!!count && count > 0 && (
              <span className="u-sr-only">{t('common.selected', { n: count })}</span>
            )}
          </button>
        );
      })}

      {/* More is always last and always present: it is the only route to modules
          that did not win a slot, so removing it when the bar looks full would
          strand them. */}
      <button
        type="button"
        className="kgm-bottomnav__item"
        onClick={onOpenMore}
        aria-haspopup="dialog"
      >
        <span className="kgm-bottomnav__icon" aria-hidden="true">
          <MoreGlyph />
        </span>
        <span className="kgm-bottomnav__label">{t('mobile.more')}</span>
      </button>
    </nav>
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
