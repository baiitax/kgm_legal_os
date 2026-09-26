/**
 * THE RAIL · §10, §11, §12, §50
 *
 * 250–280px expanded, 72–84px collapsed, with a smooth toggler and a persisted
 * preference. The width lives in tokens (`--rail-w-expanded`, `--rail-w-collapsed`)
 * so the layout never hardcodes a number that could disagree with the CSS.
 *
 * THE PART THAT MATTERS
 *   The rail renders `nav.groups` — a tree already filtered by the member's
 *   permissions. It does NOT contain a module list. There is no array of sidebar
 *   entries in this file to keep in sync with anything, which is the only way to
 *   guarantee §50 holds: the navigation cannot show a module the authorization
 *   system withheld, because it never enumerated the modules in the first place.
 *
 * COLLAPSED STATE (§11)
 *   Collapsing hides labels but never hides an item. A member who can reach Audit
 *   expanded can reach it collapsed — the icon is still there with a tooltip. The
 *   alternative (dropping items that don't fit) would make the collapsed rail a
 *   different navigation surface, and different surfaces drift.
 *
 * MOBILE
 *   The rail is not rendered at all below `--bp-sidebar`; the bottom nav takes
 *   over. This is `display:none`, not a transform — a hidden-but-mounted sidebar
 *   keeps its focus stops reachable by Tab, which is how a keyboard user ends up
 *   tabbing into controls they cannot see.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  IconChevronBack, IconChevronForward, IconLock, Logo, Tooltip, useI18n,
} from '@kgm/ui';
import { useFirmSession } from '../auth/FirmSession.js';
import { isPathAllowed, type NavGroup, type NavLeaf } from '../app/nav.js';
import './shell.css';

const STORAGE_KEY = 'kgm.firm.rail';

export type RailState = 'expanded' | 'collapsed';

function readRailState(): RailState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'expanded' || raw === 'collapsed') return raw;
  } catch { /* unavailable */ }
  return 'expanded';
}

interface AppRailProps {
  /** Current path, used to mark the active item. */
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}

export function AppRail({ path, onNavigate }: AppRailProps) {
  const { t } = useI18n();
  const { nav } = useFirmSession();
  const [state, setState] = useState<RailState>(() => readRailState());
  const railRef = useRef<HTMLElement>(null);
  const toggleId = useId();

  // Persist the preference (§10) and keep the design token in step so the
  // topbar's offset and the content's inset follow without a re-render loop.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, state); } catch { /* non-fatal */ }
    document.documentElement.setAttribute('data-rail', state);
  }, [state]);

  const toggle = () => setState((s) => (s === 'expanded' ? 'collapsed' : 'expanded'));

  const collapsed = state === 'collapsed';
  const groupLabelId = (id: string) => `${toggleId}-grp-${id}`;

  return (
    <nav
      ref={railRef}
      className="kgm-rail"
      data-state={state}
      aria-label={t('nav.workspace')}
      // §42: the rail's inline-size changes with state, and the content beside it
      // follows. Announcing the state lets an AT user predict the layout.
      aria-expanded={!collapsed}
    >
      {/* ---- brand block ---- */}
      <div className="kgm-rail__brand">
        <a
          className="kgm-rail__brandlink"
          href="#/"
          onClick={(e) => { e.preventDefault(); onNavigate('/'); }}
          aria-label={t('nav.dashboard')}
        >
          <Logo size={collapsed ? 'sm' : 'md'} layout="inline" compact={collapsed} className="kgm-rail__logo" />
        </a>

        <button
          type="button"
          className="kgm-rail__toggle"
          id={toggleId}
          onClick={toggle}
          aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          aria-pressed={collapsed}
          title={collapsed ? t('nav.expand') : t('nav.collapse')}
        >
          {/* The chevron flips in CSS on direction, so this is one glyph. */}
          {collapsed ? <IconChevronForward size={16} /> : <IconChevronBack size={16} />}
        </button>
      </div>

      {/* ---- who, in what role, at which firm ---- */}
      {!collapsed && <RailIdentity />}

      {/* ---- module tree ---- */}
      <div className="kgm-rail__scroll">
        {nav.groups.length === 0 ? (
          // A member with no permissions at all. Not an empty sidebar — an
          // explanation, because a blank rail reads as a bug.
          <div className="kgm-rail__empty">
            <IconLock size={20} className="kgm-rail__emptyicon" />
            {!collapsed && (
              <>
                <p className="kgm-rail__emptytitle">{t('nav.noModules')}</p>
                <p className="kgm-rail__emptyhint">{t('nav.noModulesHint')}</p>
              </>
            )}
          </div>
        ) : (
          nav.groups.map(({ group, leaves }) => (
            <RailGroup
              key={group.id}
              group={group}
              leaves={leaves}
              collapsed={collapsed}
              path={path}
              labelId={groupLabelId(group.id)}
              onNavigate={onNavigate}
            />
          ))
        )}
      </div>

      {/* ---- footer ---- */}
      <div className="kgm-rail__foot">
        {!collapsed && (
          <p className="kgm-rail__note">
            <IconLock size={12} aria-hidden="true" />
            {t('auth.securityNote')}
          </p>
        )}
      </div>
    </nav>
  );
}

// ==========================================================================

/**
 * WHO IS SIGNED IN, AS WHAT, AT WHICH FIRM.
 *
 * The rail is the surface that decides what a member may reach, and until now
 * it never said whose reach it was describing. That is a real question in this
 * product, not a decoration:
 *
 *   - It is multi-tenant from day one. The same person holds a different role in
 *     each firm, and switching firm changes both their permissions and — for a
 *     lawyer — whether their ring is intact.
 *   - Roles are plural and scoped. A managing partner who is also head of
 *     litigation sees a union of two grants; the rail should not imply a single
 *     job title.
 *   - Departments decide the counterparty scope (§ partner scoping), so where
 *     the member sits is part of reading the tree beneath this block.
 *
 * Everything here comes from the session payload the server resolved. Nothing is
 * derived locally, and nothing is prettified into a capability — the chip says
 * what the membership says, and the tree below it says what that reaches.
 */
function RailIdentity() {
  const { t, lang } = useI18n();
  const { session } = useFirmSession();
  const member = session?.member;
  if (!member) return null;

  const name = lang === 'ar' ? (member.displayNameAr ?? member.displayName) : member.displayName;
  const roles = member.roles.length
    ? member.roles.map((r) => (lang === 'ar' ? (r.nameAr ?? r.name) : r.name))
    : [t('nav.roleNone')];
  /*
    Two roles are shown as two, rather than a job title and then one of them: a
    member who holds both finance and compliance holds both grants, and naming
    one would misdescribe what the tree below contains. The job title is the
    fallback for a membership with no role at all — free text, so it is only ever
    a label, never a capability.
  */
  const jobTitle = member.jobTitle
    ? (lang === 'ar' ? (member.jobTitleAr ?? member.jobTitle) : member.jobTitle)
    : null;
  const role = member.roles.length > 1
    ? roles.slice(0, 3).join(' · ')
    : [jobTitle, roles[0]].filter(Boolean).join(' · ');
  const department = member.departments[0];
  const deptName = department
    ? (lang === 'ar' ? (department.nameAr ?? department.name) : department.name)
    : null;
  const firm = session?.tenants.find((x) => x.tenantId === session.activeTenantId);
  const firmName = firm
    ? (lang === 'ar' ? (firm.tenantNameAr ?? firm.tenantName) : firm.tenantName)
    : null;

  return (
    <div className="kgm-rail__identity" role="group" aria-label={t('nav.identity')}>
      <span className="kgm-rail__identityname">{name}</span>
      <span className="kgm-rail__identityrole">{role}</span>
      {firmName && (
        <span className="kgm-rail__identityfirm">
          {department && <>{deptName} · </>}
          {t('nav.atFirm')} {firmName}
        </span>
      )}
    </div>
  );
}

// ==========================================================================

interface RailGroupProps {
  readonly group: NavGroup;
  readonly leaves: readonly NavLeaf[];
  readonly collapsed: boolean;
  readonly path: string;
  readonly labelId: string;
  readonly onNavigate: (to: string) => void;
}

function RailGroup({ group, leaves, collapsed, path, labelId, onNavigate }: RailGroupProps) {
  const { t } = useI18n();
  const Icon = group.icon;

  // A group with no children routes directly.
  if (group.to) {
    return (
      <div className="kgm-rail__group" role="group" aria-label={t(group.labelKey)}>
        <RailLink
          to={group.to}
          label={t(group.labelKey)}
          icon={<Icon size={18} />}
          active={isPathAllowed(new Set([group.to]), path)}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      </div>
    );
  }

  return (
    <div className="kgm-rail__group" role="group" aria-labelledby={labelId}>
      {/* The group heading is not a link: it has no destination of its own, and
          making a heading clickable invites a click that does nothing. */}
      <p className="kgm-rail__grouplabel" id={labelId}>
        {collapsed ? (
          // Collapsed: the group icon stands in for the label, and the tooltip
          // carries the name so the information is not lost, only moved.
          <Tooltip label={t(group.labelKey)}>
            <span className="kgm-rail__groupicon" aria-hidden="true"><Icon size={16} /></span>
          </Tooltip>
        ) : (
          <>
            <span aria-hidden="true"><Icon size={14} /></span>
            <span>{t(group.labelKey)}</span>
          </>
        )}
      </p>

      /*
        EVERY ROW IN THIS LIST IS A DESTINATION.

        There used to be a split here — the modules that work, a rule, then the
        ones that do not — because most of the tree was unbuilt and interleaving
        them made the rail read as a product that was mostly broken. The split is
        gone because its cause is gone: an unbuilt module is no longer listed. A
        rail that says "in development" seventeen times is not more honest than
        one that omits them; it is just longer, and it teaches the member that the
        four rows which do work are equally provisional.
      */
      <ul className="kgm-rail__list">
        {leaves.map((leaf) => (
          <li key={leaf.id}>
            <RailLink
              to={leaf.to}
              label={t(leaf.labelKey)}
              icon={<leaf.icon size={18} />}
              active={isPathAllowed(new Set([leaf.to]), path)}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface RailLinkProps {
  readonly to: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly active: boolean;
  readonly collapsed: boolean;
  readonly onNavigate: (to: string) => void;
}

function RailLink({ to, label, icon, active, collapsed, onNavigate }: RailLinkProps) {
  /*
    A LINK THAT ALWAYS ROUTES.

    There is no inert path left in this component: every row the rail renders has
    a screen behind it, because nav.ts only lists modules that are built. The
    `data-planned` / `aria-disabled` machinery that used to live here was correct
    for the object it described and is deleted rather than left dormant — an
    unused branch that renders a dead row is an invitation to reuse it.
  */
  const link = (
    <a
      className="kgm-rail__link"
      data-active={active || undefined}
      href={`#${to}`}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        onNavigate(to);
      }}
    >
      <span className="kgm-rail__linkicon" aria-hidden="true">{icon}</span>
      {!collapsed && <span className="kgm-rail__linklabel">{label}</span>}
    </a>
  );

  // Tooltip only when the label is hidden: an always-on tooltip on a visible
  // label is noise, and it would double-announce the name to screen readers.
  if (collapsed) return <Tooltip label={label}>{link}</Tooltip>;
  return link;
}

/** Re-exported so the topbar can align to the rail without duplicating the key. */
export { STORAGE_KEY as RAIL_STORAGE_KEY };
export type { NavGroup };
export { permissionsGuard };

/**
 * Small helper used by screens that need to re-check a path against the live
 * permission set (e.g. after a tenant switch invalidates the nav).
 */
function permissionsGuard(permissions: readonly string[], path: string, allowed: ReadonlySet<string>): boolean {
  void permissions;
  return isPathAllowed(allowed, path);
}
