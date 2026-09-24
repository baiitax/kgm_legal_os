/**
 * MATTER TABS · §22, §50
 *
 * Overview / Timeline / Team / Documents / Hearings / Deadlines / Contracts / POA
 * / Time / Expenses / Billing / Messages / Compliance.
 *
 * §22 lists thirteen tabs. §50 says the interface must reflect the member's
 * actual permissions. Both hold, and the resolution is the same one the rail
 * uses: the tab set is FILTERED, not fixed.
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
  IconBilling, IconCalendar, IconCompliance, IconContracts, IconDocuments,
  IconExpenses, IconMessages, IconMatters, IconPoa, IconTasks, IconTeams,
  IconTime, useI18n,
} from '@kgm/ui';
import type { MatterAccessLevel } from '../api/firm.js';
import '../shell/shell.css';

export type MatterTabId =
  | 'overview' | 'timeline' | 'team' | 'documents' | 'hearings' | 'deadlines'
  | 'contracts' | 'poa' | 'time' | 'expenses' | 'billing' | 'messages' | 'compliance';

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
  readonly planned?: boolean;
}

const TABS: readonly TabDef[] = [
  { id: 'overview',   labelKey: 'tab.overview',   icon: IconMatters,     permissions: [], accessLevels: [] },
  { id: 'timeline',   labelKey: 'tab.timeline',   icon: IconCalendar,    permissions: [], accessLevels: [], planned: true },
  { id: 'team',       labelKey: 'tab.team',       icon: IconTeams,       permissions: ['matters.assign', 'matters.read_all'], accessLevels: ['edit', 'operational'], planned: true },
  { id: 'documents',  labelKey: 'tab.documents',  icon: IconDocuments,   permissions: ['documents.read'], accessLevels: ['edit', 'operational'], planned: true },
  { id: 'hearings',   labelKey: 'tab.hearings',   icon: IconCalendar,    permissions: ['hearings.read', 'hearings.manage'], accessLevels: ['edit', 'operational'], planned: true },
  { id: 'deadlines',  labelKey: 'tab.deadlines',  icon: IconTasks,       permissions: ['deadlines.read', 'deadlines.manage'], accessLevels: ['edit', 'operational'], planned: true },
  { id: 'contracts',  labelKey: 'tab.contracts',  icon: IconContracts,   permissions: ['contracts.read', 'contracts.manage'], accessLevels: ['edit', 'operational'], planned: true },
  { id: 'poa',        labelKey: 'tab.poa',        icon: IconPoa,         permissions: ['poa.read', 'poa.manage'], accessLevels: ['edit', 'operational'], planned: true },
  { id: 'time',       labelKey: 'tab.time',       icon: IconTime,        permissions: ['time.read', 'time.create'], accessLevels: ['edit', 'operational', 'financial'], planned: true },
  { id: 'expenses',   labelKey: 'tab.expenses',   icon: IconExpenses,    permissions: ['expenses.read', 'expenses.create'], accessLevels: ['edit', 'operational', 'financial'], planned: true },
  { id: 'billing',    labelKey: 'tab.billing',    icon: IconBilling,     permissions: ['billing.read', 'billing.read_all'], accessLevels: ['edit', 'financial'], planned: true },
  { id: 'messages',   labelKey: 'tab.messages',   icon: IconMessages,    permissions: [], accessLevels: [], planned: true },
  { id: 'compliance', labelKey: 'tab.compliance', icon: IconCompliance,  permissions: ['compliance.read', 'compliance.review'], accessLevels: ['compliance', 'edit'], planned: true },
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
            data-disabled={tab.planned || undefined}
            aria-disabled={tab.planned || undefined}
            title={tab.planned ? t('nav.planned') : undefined}
            onClick={() => { if (!tab.planned) onChange(tab.id); }}
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
