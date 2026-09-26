/**
 * NAVIGATION, GENERATED FROM PERMISSIONS · §12, §50
 *
 * §50 is the sentence this whole file exists to satisfy: "The visual system must
 * never override the authorization system." Navigation is the first place that
 * gets violated, because a sidebar is written once, early, by whoever is building
 * the layout — and it is written from the module list in the spec rather than from
 * what the signed-in member may actually do.
 *
 * THE RULE
 *   A module appears if and only if the member holds at least one of its
 *   `permissions`. Not "if they hold the read permission", not "if their role is
 *   in this list" — one of the codes, checked against the resolved set the server
 *   returned.
 *
 * WHY PERMISSIONS AND NOT ROLES
 *   Roles are how permissions are granted, not what they mean. Gating the nav on
 *   role codes would put the UI's idea of "who is a finance officer" in a second
 *   place, where it can drift from the server's. Gating on permission codes means
 *   there is exactly one authorization vocabulary, and the nav is a projection of
 *   it. When an admin grants a new role to a member, the sidebar changes on the
 *   next session resolve with no code edit here.
 *
 * WHAT DOES NOT APPEAR AT ALL
 *   A module the firm has no system behind is ABSENT, not greyed. This file used
 *   to carry seventeen `planned: true` leaves that rendered inert tiles, and on a
 *   real sign-in that is what most of the rail was: seventeen rows explaining
 *   what the product does not do. A member reads that as a product that does not
 *   work, and they stop trusting the four rows that do. Every entry below is a
 *   destination with a screen behind it and a server that will answer.
 *
 *   THAT IS A HARDER CONSTRAINT THAN IT LOOKS, and it is the right one: the rail
 *   is a promise about what this build can do for this member, and a promise
 *   costs nothing to make and everything to break. Modules that exist only INSIDE
 *   a matter — hearings, deadlines, documents, parties, conflicts, judgments,
 *   time, expenses, billing — are reached through the matter workspace's tabs,
 *   not from the rail, because that is the only place they are implemented.
 *
 * WHY HIDING IS NOT THE CONTROL
 *   Hiding a module is a courtesy, not a defense. Every route in this app is also
 *   guarded, and every guard re-checks against the same permission set — because
 *   the server enforces regardless and answers 403/404 to anyone who types the
 *   URL. A member who cannot read audit must not be SHOWN an audit tab, because a
 *   tab that 404s on click teaches people that the interface lies. But the tab
 *   being hidden is not what stops them.
 *
 * §12's module tree is reproduced below in its own order and grouping.
 */
import type { ComponentType } from 'react';
import {
  IconAdmin, IconAudit, IconClients, IconDashboard, IconMatters, IconMyWork,
  IconUsers, IconWorkspace, type IconProps,
} from '@kgm/ui';

export type Icon = ComponentType<IconProps>;

export interface NavLeaf {
  readonly id: string;
  /** Route path, relative to the app root. */
  readonly to: string;
  readonly labelKey: string;
  readonly icon: Icon;
  /**
   * Any one of these grants visibility. Empty means "always visible" — used only
   * for the dashboard, which every authenticated member has.
   */
  readonly permissions: readonly string[];
  /** Badge count source, wired later to a live endpoint. */
  readonly badgeKey?: 'notifications' | 'tasks' | 'messages';
}

export interface NavGroup {
  readonly id: string;
  readonly labelKey: string;
  readonly icon: Icon;
  readonly permissions: readonly string[];
  readonly leaves: readonly NavLeaf[];
  /** A group with no leaves is itself a leaf in the rail. */
  readonly to?: string;
}

/**
 * The §12 tree.
 *
 * Group permissions are the UNION of their leaves' permissions, computed below
 * rather than written by hand: a group that declares its own list can drift from
 * its children, and a group visible while every child is hidden is a dead end.
 */
/**
 * A group as authored below.
 *
 * `permissions` is optional here and REQUIRED on NavGroup: the tree computes each
 * group's permissions from its leaves, so a hand-written list on a group with
 * children would be a second source of truth that can silently disagree with the
 * first. Only childless groups (which have no leaves to derive from) may declare
 * their own.
 */
type NavGroupDef = Omit<NavGroup, 'permissions'> & { readonly permissions?: readonly string[] };

const GROUP_DEFS: ReadonlyArray<NavGroupDef> = [
  {
    id: 'dashboard',
    labelKey: 'nav.dashboard',
    icon: IconDashboard,
    to: '/',
    // Every authenticated member sees their own dashboard. What is ON it varies
    // by permission, which the dashboard resolves itself.
    permissions: [],
    leaves: [],
  },
  {
    id: 'workspace',
    labelKey: 'nav.workspace',
    icon: IconWorkspace,
    permissions: [],
    leaves: [
      { id: 'mywork', to: '/my-work', labelKey: 'nav.myWork', icon: IconMyWork, permissions: [] },
    ],
  },
  {
    id: 'clients',
    labelKey: 'nav.clients',
    icon: IconClients,
    to: '/clients',
    // A standalone group still needs a gate. `permissions: []` would mean every
    // authenticated member sees Clients, including one whose first click fires a
    // request the server refuses.
    permissions: ['clients.read'],
    leaves: [],
  },
  {
    id: 'matters',
    labelKey: 'nav.matters',
    icon: IconMatters,
    to: '/matters',
    // matters.read is practice-scoped; matters.read_all is firm-wide. Either
    // entitles the member to the list, and the server narrows the rows.
    permissions: ['matters.read', 'matters.read_all'],
    leaves: [],
  },
  /*
    ── WHAT IS NOT HERE, AND WHY ────────────────────────────────────────────────

    Three §12 groups are absent rather than empty: Legal, Finance and Compliance.

      LEGAL      hearings, deadlines and documents are implemented — inside a
                 matter, on its workspace tabs, which is where they belong.
                 Contracts and POA are implemented nowhere.
      FINANCE    billing, time and expenses are implemented on the matter's
                 Billing tab (P1: terms, unbilled totals, the blockers that
                 explain a refusal). There is no firm-wide billing screen.
      COMPLIANCE conflict checking is implemented (P0.1) and is reached from the
                 matter it belongs to. Licences, training and complaints have no
                 system behind them.

    An empty group is not neutral: a group with no leaves and no `to` renders as
    a rail row that routes nowhere, which is the same lie as a greyed tile. The
    route the member needs is on the matter they are working on, and the rail
    says so by not pretending otherwise.
  */
  {
    id: 'admin',
    labelKey: 'nav.admin',
    icon: IconAdmin,
    permissions: [],
    leaves: [
      { id: 'users', to: '/admin/users', labelKey: 'nav.users', icon: IconUsers, permissions: ['users.read'] },
      { id: 'settings', to: '/admin/settings', labelKey: 'nav.settings', icon: IconAdmin, permissions: ['settings.read', 'settings.manage'] },
      { id: 'audit', to: '/admin/audit', labelKey: 'nav.audit', icon: IconAudit, permissions: ['audit.read'] },
    ],
  },
];

/** Derives a group's permissions from its leaves, so the two cannot disagree. */
function unionPermissions(leaves: readonly NavLeaf[]): string[] {
  return [...new Set(leaves.flatMap((l) => l.permissions))];
}

/** The full tree, with group permissions computed once at module load. */
export const NAV_TREE: readonly NavGroup[] = GROUP_DEFS.map((g) => ({
  ...g,
  permissions: g.leaves.length > 0 ? unionPermissions(g.leaves) : (g.permissions ?? []),
}));

/**
 * Whether one nav item is visible to a permission set.
 *
 * An EMPTY `permissions` array means visible to every authenticated member. That
 * is a deliberate exception and it is small: the dashboard and my-work.
 * Everything else names its codes.
 */
export function canSee(permissions: ReadonlySet<string>, required: readonly string[]): boolean {
  if (required.length === 0) return true;
  return required.some((code) => permissions.has(code));
}

export interface VisibleNav {
  readonly groups: ReadonlyArray<{
    readonly group: NavGroup;
    readonly leaves: readonly NavLeaf[];
  }>;
  /** Every path the member may route to. Drives the route guard. */
  readonly allowedPaths: ReadonlySet<string>;
  /** True when nothing beyond the dashboard is visible — a member with no
   *  permissions at all, which is a configuration error worth surfacing. */
  readonly isEmpty: boolean;
}

/**
 * Filters the tree for one member.
 *
 * Returns the allowed PATH set alongside the visible tree so the router guard and
 * the sidebar are provably derived from one call. Two independently-filtered
 * lists — one for the menu, one for the routes — is how a hidden tab ends up
 * reachable by URL, or a visible tab ends up 404ing.
 */
export function visibleNav(permissions: readonly string[]): VisibleNav {
  const set = new Set(permissions);
  const allowed = new Set<string>();
  const groups: Array<{ group: NavGroup; leaves: readonly NavLeaf[] }> = [];

  for (const group of NAV_TREE) {
    const leaves = group.leaves.filter((leaf) => canSee(set, leaf.permissions));

    if (group.leaves.length === 0) {
      // A standalone entry (dashboard, clients, matters, messages).
      if (!canSee(set, group.permissions)) continue;
      if (group.to) allowed.add(group.to);
      groups.push({ group, leaves: [] });
      continue;
    }

    if (leaves.length === 0) continue;
    for (const leaf of leaves) allowed.add(leaf.to);
    groups.push({ group, leaves });
  }

  return {
    groups,
    allowedPaths: allowed,
    isEmpty: allowed.size <= 1,
  };
}

/**
 * Whether a path is permitted.
 *
 * Handles nested routes: `/matters/:id` is allowed because `/matters` is. A guard
 * that only matched exact strings would lock a member out of every detail page.
 */
export function isPathAllowed(allowed: ReadonlySet<string>, path: string): boolean {
  if (allowed.has(path)) return true;
  // Longest-prefix match, so /matters/abc is governed by /matters and not by
  // a coincidental /m prefix.
  for (const p of allowed) {
    if (p === '/') continue;
    if (path.startsWith(`${p}/`)) return true;
  }
  return false;
}

/** Flat list of every leaf, for the mobile More sheet (§17). */
export function allLeaves(nav: VisibleNav): ReadonlyArray<{ group: NavGroup; leaf: NavLeaf }> {
  return nav.groups.flatMap(({ group, leaves }) => leaves.map((leaf) => ({ group, leaf })));
}
