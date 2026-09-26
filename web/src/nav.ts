/**
 * THE PORTAL'S NAVIGATION MODEL · one list, three surfaces
 *
 * Every surface in the client portal that navigates — the desktop sidebar, the
 * topbar's orientation line, the mobile tab bar and its More sheet, and the
 * route table itself — reads THIS file. That is the whole point: the portal used
 * to hold two literals, a `NAV_GROUPS` array in `App.tsx` and a `<Routes>` block
 * four hundred lines below it, and nothing kept them in step. A screen could
 * ship with no way to reach it (nine of fourteen were unreachable on a phone),
 * and a nav entry could ship with no screen.
 *
 * ── THE CAPABILITY MODEL ────────────────────────────────────────────────────
 *
 * A capability is what a person may DO with the account, and it is derived from
 * `client_users.portal_role`, which the server has resolved into every session
 * since the portal was built and which the portal then ignored:
 *
 *   client_primary  the account holder. Everything, including the money and the
 *                   say over who else at the client can sign in.
 *   client_contact  a colleague the holder has given access to the WORK — the
 *                   matters, the documents, the messages, the diary. Not to the
 *                   invoices, and not to the account's administration.
 *
 * It is "authority over the account", not seniority. A general counsel at the
 * client is a perfectly senior person and is a `contact` if the finance director
 * holds the account.
 *
 * ── AND IT IS NOT A UI TRICK ────────────────────────────────────────────────
 *
 * Filtering a menu is not a control. This project's rule is that a rule is
 * stated at every layer that can be reached without the one above it, so the
 * four account surfaces a contact may not open are ALSO refused by the server
 * (`requireAccountHolder()` in `server/src/api/client.routes.ts`, 403, audited).
 * A nav that hid an invoice the API would hand over would be a lie with extra
 * steps — and the earlier phase that rejected "hide functionality" as a security
 * posture rejected it for exactly this reason.
 *
 * ── WHAT THE PORTAL DOES NOT DO ─────────────────────────────────────────────
 *
 * There is no per-client or per-matter grant, because the server has none: a
 * client user is authorized for a set of client entities (`principal.clientIds`)
 * and every route narrows by that. Inventing finer capabilities here would
 * promise access control that does not exist.
 */

/** What a member may do with the account, as the portal needs to know it. */
export type Capability =
  /** Matters, hearings, deadlines, documents, messages, appointments, notifications. */
  | 'work'
  /** Invoices, receipts, recording a payment. The account holder's alone. */
  | 'billing'
  /** Administering who else at the client may sign in. Reserved; no route yet. */
  | 'account_admin'
  /** One's own profile, sessions and devices. */
  | 'self'
  /** One's own data, consents and deletion requests. */
  | 'privacy';

export type PortalRole = 'client_primary' | 'client_contact';

/**
 * The capability sets, in one table.
 *
 * Written as a record so a THIRD role is one entry rather than a new boolean
 * threaded through the tree — which is what makes the rejected alternative
 * ("a finance contact who sees invoices but not advice") cheap to add later,
 * when somebody actually needs it.
 */
export const CAPABILITIES: Readonly<Record<PortalRole, readonly Capability[]>> = Object.freeze({
  client_primary: ['work', 'billing', 'account_admin', 'self', 'privacy'],
  client_contact: ['work', 'self', 'privacy'],
});

/**
 * The capabilities for a session's role.
 *
 * An UNKNOWN role resolves to the contact set, never the primary set. The
 * server's CHECK constraint makes this unreachable today (`portal_role in
 * ('client_primary','client_contact')`), and it is written this way anyway: a
 * default that widens access is the one default that must never be chosen, and
 * a role added to the database without being added here would otherwise
 * silently become an account holder.
 */
export function capabilitiesFor(role: string | null | undefined): ReadonlySet<Capability> {
  const known = Object.prototype.hasOwnProperty.call(CAPABILITIES, role ?? '')
    ? (role as PortalRole)
    : 'client_contact';
  return new Set(CAPABILITIES[known]);
}

import type { IconName } from './components/ui';
import type { MessageKey } from './i18n';
export type { IconName };

export interface NavItem {
  readonly id: string;
  readonly to: string;
  readonly labelKey: MessageKey;
  readonly icon: IconName;
  /** The capability that opens it. A portal destination has exactly one. */
  readonly capability: Capability;
  /** Where the count comes from, when there is one. Only notifications, today. */
  readonly badgeKey?: 'notifications';
  /**
   * True for a destination the portal opens with a parameter — a matter, an
   * invoice, a thread.
   *
   * It is never a nav entry and never a tab slot. It exists so the ROUTE TABLE
   * can be built from this same list rather than from a second literal, which
   * is the drift that made nine of fourteen screens unreachable on a phone.
   *
   * A deep path therefore resolves — for a title, a breadcrumb or a guard — to
   * its SECTION (`/portal/matters/<id>` is `matters`), because that is the
   * question the chrome is asking. A parameterised path is not a section.
   */
  readonly detail?: boolean;
}

export interface NavGroup {
  readonly id: string;
  readonly labelKey: MessageKey;
  readonly items: readonly NavItem[];
}

/**
 * The portal's information architecture.
 *
 * Ordered by what the reader came for: today's work first, then the record, then
 * the diary, then the money, then the account. Within a group the order is the
 * order of the sidebar — it is the only order, and there is no second list.
 */
export const PORTAL_NAV: readonly NavGroup[] = [
  {
    id: 'today',
    labelKey: 'nav.group.today',
    items: [
      { id: 'dashboard', to: '/portal', labelKey: 'nav.dashboard', icon: 'home', capability: 'work' },
      { id: 'notifications', to: '/portal/notifications', labelKey: 'nav.notifications', icon: 'bell', capability: 'work', badgeKey: 'notifications' },
      { id: 'messages', to: '/portal/messages', labelKey: 'nav.messages', icon: 'chat', capability: 'work' },
    ],
  },
  {
    id: 'matters',
    labelKey: 'nav.group.matters',
    items: [
      { id: 'matters', to: '/portal/matters', labelKey: 'nav.matters', icon: 'folder', capability: 'work' },
      { id: 'matter', to: '/portal/matters/:id', labelKey: 'nav.matters', icon: 'folder', capability: 'work', detail: true },
      { id: 'thread', to: '/portal/messages/:id', labelKey: 'nav.messages', icon: 'chat', capability: 'work', detail: true },
      { id: 'documents', to: '/portal/documents', labelKey: 'nav.documents', icon: 'doc', capability: 'work' },
    ],
  },
  {
    id: 'diary',
    labelKey: 'nav.group.diary',
    items: [
      { id: 'hearings', to: '/portal/hearings', labelKey: 'nav.hearings', icon: 'gavel', capability: 'work' },
      { id: 'deadlines', to: '/portal/deadlines', labelKey: 'nav.deadlines', icon: 'clock', capability: 'work' },
      { id: 'appointments', to: '/portal/appointments', labelKey: 'nav.appointments', icon: 'calendar', capability: 'work' },
    ],
  },
  {
    id: 'account_billing',
    labelKey: 'nav.group.finance',
    items: [
      { id: 'invoices', to: '/portal/invoices', labelKey: 'nav.invoices', icon: 'invoice', capability: 'billing' },
      { id: 'invoice', to: '/portal/invoices/:id', labelKey: 'nav.invoices', icon: 'invoice', capability: 'billing', detail: true },
      { id: 'receipts', to: '/portal/receipts', labelKey: 'nav.receipts', icon: 'receipt', capability: 'billing' },
    ],
  },
  {
    id: 'account',
    labelKey: 'nav.group.account',
    items: [
      { id: 'profile', to: '/portal/profile', labelKey: 'nav.profile', icon: 'user', capability: 'self' },
      { id: 'security', to: '/portal/security', labelKey: 'nav.security', icon: 'shield', capability: 'self' },
      { id: 'privacy', to: '/portal/privacy', labelKey: 'nav.privacy', icon: 'lock', capability: 'privacy' },
    ],
  },
];

/** Every destination, in nav order, including the parameterised ones. */
export const ALL_ITEMS: readonly NavItem[] = PORTAL_NAV.flatMap((g) => g.items);

/** The destinations that are their own screen (no parameter). */
export const DESTINATIONS: readonly NavItem[] = ALL_ITEMS.filter((i) => !i.detail);

/**
 * The parameterised destinations — a matter, a thread, an invoice.
 *
 * They are never sidebar entries and never tab slots; they exist because the
 * route table has to be built from the same list the nav is, or the two drift
 * again. `capability` is inherited from the list they hang off.
 */
export const DETAIL_ITEMS: readonly NavItem[] = ALL_ITEMS.filter((i) => i.detail);

export interface VisibleNav {
  readonly groups: ReadonlyArray<{ group: NavGroup; items: readonly NavItem[] }>;
  readonly capabilities: ReadonlySet<Capability>;
  /** Every nav path the member may route to. Drives the topbar and the tab bar. */
  readonly allowedPaths: ReadonlySet<string>;
}

/**
 * The nav for one role.
 *
 * A group with nothing visible in it disappears — a heading over an empty list
 * is how a menu tells a reader it is broken.
 */
export function visibleNav(role: string | null | undefined): VisibleNav {
  const capabilities = capabilitiesFor(role);
  const groups: Array<{ group: NavGroup; items: readonly NavItem[] }> = [];
  const allowed = new Set<string>();

  for (const group of PORTAL_NAV) {
    const items = group.items.filter((item) => capabilities.has(item.capability));
    if (items.length === 0) continue;
    for (const item of items) if (!item.detail) allowed.add(item.to);
    groups.push({ group, items });
  }

  return { groups, capabilities, allowedPaths: allowed };
}

/**
 * Whether a capability set may open a path.
 *
 * Longest-prefix so `/portal/matters/abc` is governed by `/portal/matters` — the
 * same rule the Firm OS guard uses, and the reason a detail URL is never a nav
 * entry. `/portal` is the root and is matched exactly, or every path would be
 * allowed by it.
 */
export function canOpen(
  nav: Pick<VisibleNav, 'capabilities'>,
  to: string,
): boolean {
  const item = findItem(to);
  if (!item) return false;
  return nav.capabilities.has(item.capability);
}

/** The nav item that governs a path, detail paths included. */
export function findItem(path: string): NavItem | undefined {
  const exact = ALL_ITEMS.find((i) => i.to === path);
  if (exact) return exact;
  /*
    Longest match wins: `/portal/matters/abc` must resolve to `matters` and not
    to `/portal`, which is also a prefix of it.
  */
  return [...ALL_ITEMS]
    .filter((i) => i.to !== '/portal' && path.startsWith(`${i.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0];
}

/** The group a path belongs to, for the topbar's orientation line. */
export function groupFor(path: string): NavGroup | undefined {
  const item = findItem(path);
  if (!item) return undefined;
  return PORTAL_NAV.find((g) => g.items.some((i) => i.id === item.id));
}

/**
 * The three flexible slots of the mobile bar, by capability-filtered priority.
 *
 * Home and More are fixed; these fill what is left. The order is by persona
 * weight — what the capability holder opens a phone for — and it is a DEFAULT:
 * nothing here is reachable that the capability set does not already allow, and
 * a contact can never be handed the Invoices slot because Invoices is not in
 * their candidate list.
 *
 * Matter-first for everyone: the portal IS the file. Afterwards the two roles
 * diverge, which is the only place in the product where their bars differ.
 */
export const SLOT_PRIORITY: readonly string[] = [
  // Both roles: the work.
  'matters', 'documents', 'messages', 'appointments', 'hearings', 'deadlines',
  'notifications', 'dashboard',
  // The account holder's, which a contact never reaches.
  'invoices', 'receipts',
  // Own account.
  'profile', 'security', 'privacy',
];

/** The set the tab bar may choose from: every visible destination but the root. */
export function slotCandidates(nav: VisibleNav): NavItem[] {
  const candidates = nav.groups
    .flatMap(({ items }) => items)
    .filter((i) => !i.detail && i.to !== '/portal' && nav.allowedPaths.has(i.to));
  const seen = new Set<string>();
  return candidates
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .sort((a, b) => {
      const ai = SLOT_PRIORITY.indexOf(a.id);
      const bi = SLOT_PRIORITY.indexOf(b.id);
      return (ai === -1 ? SLOT_PRIORITY.length : ai) - (bi === -1 ? SLOT_PRIORITY.length : bi);
    });
}

export const SLOT_COUNT = 3;
export const HOME_PATH = '/portal';
/** The nav id of the root screen — the bar's fixed first slot. */
export const HOME_ID = 'dashboard';
/** The nav id of the bar's last slot, which is a control rather than a screen. */
export const MORE_ID = '__more';

/** True when a nav path is the current one, including its detail pages. */
export function isCurrent(to: string, path: string): boolean {
  if (to === HOME_PATH) return path === HOME_PATH;
  return path === to || path.startsWith(`${to}/`);
}
