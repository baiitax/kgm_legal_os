/**
 * MATTER TABS · §22, §50
 *
 * Overview / Timeline / Team / Documents / Hearings / Deadlines / PARTIES /
 * CONFLICTS / JUDGMENTS / Time / Expenses / Billing.
 *
 * §22 lists thirteen tabs and twelve of them were not built. This strip carries
 * twelve that are. The three §22 modules the firm has no system behind —
 * Contracts, POA, Messages — are ABSENT rather than inert: the brief for this
 * phase is that a destination the member cannot open must not be offered, and a
 * tab that opens onto "in development" is exactly that.
 *
 * §50 says the interface must reflect the member's actual permissions. The
 * resolution is the same one the rail uses: the tab set is FILTERED, not fixed.
 *
 *   A finance-only member on a matter sees Overview, Billing and Time. They do not
 *   see Hearings. Showing a Hearings tab that renders "not authorized" would be a
 *   tab that lies about being a destination.
 *
 * WHY OVERVIEW IS ALWAYS PRESENT
 *   Every member who can open the matter at all can see its public fields — that
 *   is what `accessLevel` grants. A matter workspace with no Overview tab is a
 *   window into a room with nothing in it.
 *
 * ACCESS LEVEL vs PERMISSION
 *   These are two different gates and both apply. `permissions` is global — does
 *   this member read billing anywhere? `accessLevel` is per-matter — may they read
 *   billing on THIS one? A finance officer with `billing.read` who holds `view`
 *   access on a litigation matter still does not get the Billing tab. Checking
 *   only the permission would widen a matter-level restriction into a global one,
 *   which is exactly the escalation §72's matrix tests for.
 */
import { useEffect, useRef, useState } from 'react';
import {
  IconBilling, IconCalendar, IconClients, IconConflicts, IconDocuments,
  IconExpenses, IconGavel, IconMatters, IconTasks, IconTeams,
  IconTime, useI18n,
} from '@kgm/ui';
import type { MatterAccessLevel } from '../api/firm.js';
import '../shell/shell.css';

export type MatterTabId =
  | 'overview' | 'timeline' | 'team' | 'documents' | 'hearings' | 'deadlines'
  | 'parties' | 'conflicts' | 'judgments'
  | 'time' | 'expenses' | 'billing';

interface TabDef {
  readonly id: MatterTabId;
  readonly labelKey: string;
  readonly icon: typeof IconMatters;
  /** Global permissions, any of which is required. Empty = always allowed. */
  readonly permissions: readonly string[];
  /**
   * Access levels on THIS matter that may open the tab.
   * `full` always passes, so it is not listed.
   */
  readonly accessLevels: readonly MatterAccessLevel[];
}

/**
 * THIRTEEN TABS, AND EVERY ONE OF THEM IS A DESTINATION.
 *
 * Twelve of these rendered a card reading "in development": honest, and useless.
 * A strip in which nothing opens teaches a member that the product does not
 * work, and the modules that DO work stop being trusted along with it. Each tab
 * below now has an endpoint behind it and a panel in front of it.
 *
 * WHAT REPLACED `planned` IS NOT A WIDER GATE. A tab is still filtered by
 * permission AND by this matter's access level; what changed is that a member
 * passing both gates gets the record instead of a promise. Three tabs changed
 * their gates to match the routes behind them, because a tab that is offered and
 * then refused is the same defect wearing a different hat:
 *
 *   team       `matters.read` — the team list is part of the matter's own record,
 *              and the per-matter `matter_role` gate is already the access level.
 *   parties    `matters.read`, for the same reason: the parties register is what
 *              the conflict engine is built on and is not itself a compliance
 *              record.
 *   conflicts  unchanged — `compliance.read` ∩ matter compliance/full.
 */
const TABS: readonly TabDef[] = [
  { id: 'overview',   labelKey: 'tab.overview',   icon: IconMatters,     permissions: [], accessLevels: [] },
  { id: 'timeline',   labelKey: 'tab.timeline',   icon: IconCalendar,    permissions: [], accessLevels: [] },
  { id: 'team',       labelKey: 'tab.team',       icon: IconTeams,       permissions: ['matters.read'], accessLevels: ['edit', 'operational'] },
  { id: 'documents',  labelKey: 'tab.documents',  icon: IconDocuments,   permissions: ['documents.read'], accessLevels: ['edit', 'operational'] },
  { id: 'hearings',   labelKey: 'tab.hearings',   icon: IconCalendar,    permissions: ['hearings.read', 'hearings.manage'], accessLevels: ['edit', 'operational'] },
  { id: 'deadlines',  labelKey: 'tab.deadlines',  icon: IconTasks,       permissions: ['deadlines.read', 'deadlines.manage'], accessLevels: ['edit', 'operational'] },
  { id: 'parties',    labelKey: 'tab.parties',    icon: IconClients,     permissions: ['matters.read'], accessLevels: ['edit', 'operational', 'compliance'] },
  { id: 'conflicts',  labelKey: 'tab.conflicts',  icon: IconConflicts,   permissions: ['compliance.read', 'compliance.review'], accessLevels: ['compliance', 'edit'] },
  { id: 'judgments',  labelKey: 'tab.judgments',  icon: IconGavel,       permissions: ['judgments.read'], accessLevels: ['edit', 'operational'] },
  { id: 'time',       labelKey: 'tab.time',       icon: IconTime,        permissions: ['time.read', 'time.create'], accessLevels: ['edit', 'operational', 'financial'] },
  { id: 'expenses',   labelKey: 'tab.expenses',   icon: IconExpenses,    permissions: ['expenses.read', 'expenses.create'], accessLevels: ['edit', 'operational', 'financial'] },
  { id: 'billing',    labelKey: 'tab.billing',    icon: IconBilling,     permissions: ['billing.read', 'billing.read_all'], accessLevels: ['edit', 'financial'] },
];

interface MatterTabsProps {
  readonly active: MatterTabId;
  readonly onChange: (tab: MatterTabId) => void;
  readonly accessLevel: MatterAccessLevel;
  readonly permissions: ReadonlySet<string>;
}

export function MatterTabs({ active, onChange, accessLevel, permissions }: MatterTabsProps) {
  const { t } = useI18n();
  const stripRef = useRef<HTMLDivElement>(null);
  // Drives the trailing fade: it should only appear when the strip actually
  // overflows, or a short tab list looks scrollable when it is not.
  const [overflow, setOverflow] = useState(false);

  const visible = TABS.filter((tab) => tabAllowed(tab, accessLevel, permissions));

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible.length]);

  // If the active tab stops being allowed — after a tenant switch or an access
  // change — move to the first allowed one rather than rendering a body for a
  // tab that is no longer in the strip.
  useEffect(() => {
    if (visible.length === 0) return;
    if (!visible.some((v) => v.id === active)) onChange(visible[0].id);
  }, [visible, active, onChange]);

  /**
   * Arrow-key navigation along the strip.
   *
   * Implemented here rather than left to the browser because the tabs are
   * `button`s in a scrollable row: without this, Tab walks every one of them
   * before reaching the content, which is thirteen stops on a full-access matter.
   * Roving tabindex would be the strict WAI-ARIA pattern; arrow keys plus a real
   * tablist role gets the same keyboard experience.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = visible.findIndex((v) => v.id === active);
    if (idx < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(visible[(idx + 1) % visible.length].id);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(visible[(idx - 1 + visible.length) % visible.length].id);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(visible[0].id);
    } else if (e.key === 'End') {
      e.preventDefault();
      onChange(visible[visible.length - 1].id);
    }
  };

  return (
    <div
      className="firm-tabs"
      data-overflow={overflow ? 'true' : 'false'}
      ref={stripRef}
      role="tablist"
      aria-label={t('matter.title')}
      onKeyDown={onKeyDown}
    >
      {visible.map((tab) => {
        const isActive = tab.id === active;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`mattertab-${tab.id}`}
            aria-selected={isActive}
            aria-controls={`matterpanel-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            className="firm-tab"
            data-active={isActive || undefined}
            onClick={() => onChange(tab.id)}
          >
            <Icon size={15} aria-hidden="true" />
            {t(tab.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

/** Both gates: the global permission AND this matter's access level. */
function tabAllowed(
  tab: TabDef,
  accessLevel: MatterAccessLevel,
  permissions: ReadonlySet<string>,
): boolean {
  if (tab.permissions.length > 0 && !tab.permissions.some((p) => permissions.has(p))) return false;
  // `full` access implies every tab the permission gate allows.
  if (accessLevel === 'full') return true;
  if (tab.accessLevels.length === 0) return true;
  return tab.accessLevels.includes(accessLevel);
}

/** The allowed tab ids, for callers that need to validate a deep link. */
export function allowedTabs(
  accessLevel: MatterAccessLevel,
  permissions: ReadonlySet<string>,
): MatterTabId[] {
  return TABS.filter((t) => tabAllowed(t, accessLevel, permissions)).map((t) => t.id);
}
