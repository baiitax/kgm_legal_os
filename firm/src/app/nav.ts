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
  IconAdmin, IconAudit, IconBell, IconBilling, IconCalendar, IconClients,
  IconCollections, IconComplaints, IconCompliance, IconConflicts, IconContracts,
  IconDashboard, IconDeadlines, IconDocuments, IconExpenses, IconHearings,
  IconLegal, IconLicences, IconMessages, IconMatters, IconMyWork, IconPoa,
  IconTasks, IconTeams, IconTime, IconTraining, IconUsers, IconWorkspace,
  type IconProps,
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
  /** Marks a leaf that is not built yet, so it renders disabled rather than
   *  routing to a blank page. Honest about state instead of shipping a stub. */
  readonly planned?: boolean;
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
      { id: 'tasks', to: '/tasks', labelKey: 'nav.tasks', icon: IconTasks, permissions: ['tasks.read', 'tasks.manage'], planned: true, badgeKey: 'tasks' },
      { id: 'calendar', to: '/calendar', labelKey: 'nav.calendar', icon: IconCalendar, permissions: ['hearings.read', 'deadlines.read', 'tasks.read'], planned: true },
      { id: 'notifications', to: '/notifications', labelKey: 'nav.notifications', icon: IconBell, permissions: [], planned: true, badgeKey: 'notifications' },
    ],
  },
  {
    id: 'clients',
    labelKey: 'nav.clients',
    icon: IconClients,
    to: '/clients',
    permissions: [],
    leaves: [],
  },
  {
    id: 'matters',
    labelKey: 'nav.matters',
    icon: IconMatters,
    to: '/matters',
    permissions: [],
    leaves: [],
  },
  {
    id: 'legal',
    labelKey: 'nav.legal',
    icon: IconLegal,
    permissions: [],
    leaves: [
      { id: 'hearings', to: '/hearings', labelKey: 'nav.hearings', icon: IconHearings, permissions: ['hearings.read', 'hearings.manage'], planned: true },
      { id: 'deadlines', to: '/deadlines', labelKey: 'nav.deadlines', icon: IconDeadlines, permissions: ['deadlines.read', 'deadlines.manage'], planned: true },
      { id: 'documents', to: '/documents', labelKey: 'nav.documents', icon: IconDocuments, permissions: ['documents.read'], planned: true },
      { id: 'contracts', to: '/contracts', labelKey: 'nav.contracts', icon: IconContracts, permissions: ['contracts.read', 'contracts.manage'], planned: true },
      { id: 'poa', to: '/poa', labelKey: 'nav.poa', icon: IconPoa, permissions: ['poa.read', 'poa.manage'], planned: true },
    ],
  },
  {
    id: 'finance',
    labelKey: 'nav.finance',
    icon: IconBilling,
    permissions: [],
    leaves: [
      { id: 'billing', to: '/billing', labelKey: 'nav.billing', icon: IconBilling, permissions: ['billing.read', 'billing.read_all'], planned: true },
      { id: 'time', to: '/time', labelKey: 'nav.time', icon: IconTime, permissions: ['time.read', 'time.create'], planned: true },
      { id: 'expenses', to: '/expenses', labelKey: 'nav.expenses', icon: IconExpenses, permissions: ['expenses.read', 'expenses.create'], planned: true },
      { id: 'collections', to: '/collections', labelKey: 'nav.collections', icon: IconCollections, permissions: ['billing.read', 'billing.read_all', 'billing.record_payment'], planned: true },
    ],
  },
  {
    id: 'compliance',
    labelKey: 'nav.compliance',
    icon: IconCompliance,
    permissions: [],
    leaves: [
      { id: 'conflicts', to: '/conflicts', labelKey: 'nav.conflicts', icon: IconConflicts, permissions: ['compliance.read', 'compliance.review'], planned: true },
      { id: 'licences', to: '/licences', labelKey: 'nav.licences', icon: IconLicences, permissions: ['compliance.licences'], planned: true },
      { id: 'training', to: '/training', labelKey: 'nav.training', icon: IconTraining, permissions: ['compliance.training'], planned: true },
      { id: 'complaints', to: '/complaints', labelKey: 'nav.complaints', icon: IconComplaints, permissions: ['compliance.complaints'], planned: true },
    ],
  },
  {
    id: 'communication',
    labelKey: 'nav.communication',
    icon: IconMessages,
    to: '/messages',
    permissions: [],
    leaves: [],
  },
  {
    id: 'admin',
    labelKey: 'nav.admin',
    icon: IconAdmin,
    permissions: [],
    leaves: [
      { id: 'users', to: '/admin/users', labelKey: 'nav.users', icon: IconUsers, permissions: ['users.read'], planned: true },
      { id: 'teams', to: '/admin/teams', labelKey: 'nav.teams', icon: IconTeams, permissions: ['departments.manage', 'roles.read'], planned: true },
      { id: 'settings', to: '/admin/settings', labelKey: 'nav.settings', icon: IconAdmin, permissions: ['settings.read', 'settings.manage'], planned: true },
      { id: 'audit', to: '/admin/audit', labelKey: 'nav.audit', icon: IconAudit, permissions: ['audit.read'], planned: true },
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
 * is a deliberate exception and it is small: the dashboard, my-work,
 * notifications, clients, matters and messages. Everything else names its codes.
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
