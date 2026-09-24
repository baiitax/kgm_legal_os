/**
 * ICON SET · §10–§12 navigation · §31 severity · §36 affordances
 *
 * One factory, one 24×24 grid, `currentColor` throughout, so an icon inherits
 * the colour of whatever state it is in — active pill, muted inactive, gold
 * accent — without a variant per colour. That is also what makes §45's "icon
 * subtly scales" possible without duplicating assets.
 *
 * Stroke width is a prop with a 1.6 default. At 16px in the collapsed rail a
 * 2px stroke closes the counters of small glyphs; at 24px in a page header 1.6
 * reads as refined rather than heavy. One weight for every size is the usual
 * reason an icon set looks inconsistent.
 *
 * §31 requires severity to be carried by ICON AND LABEL, not colour alone, so
 * the severity set is exported separately and is deliberately unambiguous in
 * silhouette: info is a circle, notice a bell, warning a triangle, high an
 * octagon-ish shield, critical a filled alert. They remain distinguishable in
 * monochrome and at small sizes.
 */
import type { SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  /** Rendered pixel size. Square only — these icons are not safe to stretch. */
  size?: number;
  strokeWidth?: number;
  /** Accessible name. Omit for decorative icons, which is the default. */
  label?: string;
}

function Svg({ size = 20, strokeWidth = 1.6, label, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* ==========================================================================
   NAVIGATION — §12 module list, one icon per entry
   ========================================================================== */

export const IconDashboard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7.5" height="8.5" rx="1.6" />
    <rect x="13.5" y="3" width="7.5" height="5" rx="1.6" />
    <rect x="3" y="14.5" width="7.5" height="6.5" rx="1.6" />
    <rect x="13.5" y="11" width="7.5" height="10" rx="1.6" />
  </Svg>
);

export const IconWorkspace = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5 12 4l9 4.5-9 4.5-9-4.5Z" />
    <path d="M3 12.5 12 17l9-4.5" />
    <path d="M3 16.5 12 21l9-4.5" />
  </Svg>
);

export const IconMyWork = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6.5" width="18" height="13" rx="2" />
    <path d="M8.5 6.5V5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5" />
    <path d="M3 12h18" />
    <path d="M10.5 12v1.5h3V12" />
  </Svg>
);

export const IconTasks = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3.5 6.5 2 2 3.5-3.5" />
    <path d="m3.5 14.5 2 2 3.5-3.5" />
    <path d="M13 7h8" />
    <path d="M13 15h8" />
  </Svg>
);

export const IconCalendar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18" />
    <path d="M8 3v4" />
    <path d="M16 3v4" />
    <path d="M7.5 14h2" />
    <path d="M14.5 14h2" />
    <path d="M7.5 17.5h2" />
  </Svg>
);

export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 9a6 6 0 1 0-12 0c0 4.5-1.5 6-1.5 6h15S18 13.5 18 9Z" />
    <path d="M10.3 19a2 2 0 0 0 3.4 0" />
  </Svg>
);

export const IconClients = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 21V8.5L9 4l6 4.5V21" />
    <path d="M15 21V11h6v10" />
    <path d="M6.5 11h2" />
    <path d="M6.5 14.5h2" />
    <path d="M10.5 21v-4h-4v4" />
    <path d="M18 14.5h1.5" />
  </Svg>
);

/** Matters — the scales of justice, the one legal symbol that stays legible at 16px. */
export const IconMatters = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5v17" />
    <path d="M6.5 20.5h11" />
    <path d="M4 8h16" />
    <path d="M7.5 8 4.5 14h6L7.5 8Z" />
    <path d="M16.5 8 13.5 14h6L16.5 8Z" />
    <circle cx="12" cy="5.4" r="1.4" />
  </Svg>
);

export const IconLegal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 20.5h14" />
    <path d="M6.5 20.5V9.5" />
    <path d="M17.5 20.5V9.5" />
    <path d="M12 20.5V9.5" />
    <path d="M4 9.5h16L12 3.5 4 9.5Z" />
  </Svg>
);

export const IconHearings = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 15 5-5" />
    <path d="M13.5 4.5 19.5 10.5" />
    <path d="m11 7 6 6" />
    <path d="M15.5 3.5 20.5 8.5" />
    <path d="M3 21h9" />
    <path d="M6.5 17.5 4 20" />
    <rect x="2.5" y="12.5" width="7" height="4.5" rx="1.4" transform="rotate(-45 2.5 12.5)" />
  </Svg>
);

export const IconDeadlines = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const IconDocuments = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" />
    <path d="M13.5 3v5.5H19" />
    <path d="M8.5 13h7" />
    <path d="M8.5 16.5h4.5" />
  </Svg>
);

export const IconContracts = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5" />
    <path d="m8.5 16.5 2-2 1.5 1.5 3-3.5" />
  </Svg>
);

/** Power of attorney — a sealed document. */
export const IconPoa = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 3H7a2 2 0 0 0-2 2v9" />
    <path d="M19 10.5V8.5L13.5 3H13" />
    <path d="M13.5 3v5.5H19" />
    <circle cx="12" cy="16.5" r="4" />
    <path d="m10.5 16.5 1.2 1.2 2.3-2.4" />
  </Svg>
);

export const IconFinance = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="6" width="19" height="12.5" rx="2" />
    <path d="M2.5 10h19" />
    <path d="M6 14.5h3" />
    <path d="M16.5 14.5h1.5" />
  </Svg>
);

export const IconTime = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4l2.5 1.8" />
    <path d="M9 2.5h6" />
    <path d="M12 2.5V5" />
  </Svg>
);

export const IconExpenses = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20V6.5A1.5 1.5 0 0 1 5.5 5H16l4 4v11a1 1 0 0 1-1 1H5" />
    <path d="M16 5v4h4" />
    <path d="M8 13h8" />
    <path d="M8 16.5h5" />
  </Svg>
);

export const IconBilling = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 3.5h14v17l-2.3-1.6-2.4 1.6-2.3-1.6-2.4 1.6L7.3 19 5 20.5v-17Z" />
    <path d="M9 8.5h6" />
    <path d="M9 12h6" />
    <path d="M9 15.5h3.5" />
  </Svg>
);

export const IconCollections = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 1 3 6.5" />
    <path d="M3.5 19.5v-4h4" />
    <path d="M12 8v8" />
    <path d="M14.5 9.5c-.5-.8-1.5-1.2-2.5-1.2-1.4 0-2.5.7-2.5 1.9 0 2.6 5.2 1.3 5.2 4 0 1.3-1.2 2-2.7 2-1.1 0-2.2-.4-2.7-1.3" />
  </Svg>
);

export const IconCompliance = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 4.5 6v6c0 4.4 3.1 7.9 7.5 9 4.4-1.1 7.5-4.6 7.5-9V6L12 3Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
);

export const IconConflicts = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8.5" cy="8" r="3" />
    <circle cx="16.5" cy="9.5" r="2.5" />
    <path d="M3 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
    <path d="M14.5 15.5c1-.6 2-.9 3-.9 2 0 3.5 1.4 3.5 3.4" />
    <path d="m10.5 11.5 3 1.5" />
  </Svg>
);

export const IconLicences = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="12" rx="2" />
    <circle cx="8.5" cy="10.5" r="2" />
    <path d="M13 9h5" />
    <path d="M13 12h3.5" />
    <path d="m7 16.5 1.5 4 1.8-1.6 1.7 1.6 1.5-4" />
  </Svg>
);

export const IconTraining = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4 2.5 8.5 12 13l9.5-4.5L12 4Z" />
    <path d="M6 10.7v4.8c0 1.6 2.7 2.9 6 2.9s6-1.3 6-2.9v-4.8" />
    <path d="M21.5 8.5v5.5" />
  </Svg>
);

export const IconComplaints = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.5 12.5c0 4-3.8 7.2-8.5 7.2-1 0-2-.15-2.9-.42L4 21l1.3-3.5C4.2 16.2 3.5 14.4 3.5 12.5c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2Z" />
    <path d="M12 8.8v4" />
    <path d="M12 15.8h.01" />
  </Svg>
);

export const IconMessages = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.5 11.5c0 4-3.8 7.2-8.5 7.2-.9 0-1.8-.1-2.6-.3L4 20.5l1.4-3.4C4.2 15.8 3.5 13.7 3.5 11.5c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2Z" />
    <path d="M8.5 11.5h7" />
    <path d="M8.5 8.8h4.5" />
  </Svg>
);

export const IconAdmin = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 14.5a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9.1 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9.1a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
  </Svg>
);

export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.4" />
    <path d="M2.8 20c0-3.4 2.8-6 6.2-6s6.2 2.6 6.2 6" />
    <path d="M16 5.2a3.4 3.4 0 0 1 0 6.6" />
    <path d="M17.6 14.4c2.1.7 3.6 2.6 3.6 5" />
  </Svg>
);

export const IconTeams = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="2.6" />
    <circle cx="17" cy="7" r="2.6" />
    <circle cx="12" cy="16.5" r="2.6" />
    <path d="M9.2 8.6 10.8 14" />
    <path d="M14.8 8.6 13.2 14" />
    <path d="M9.6 7h4.8" />
  </Svg>
);

export const IconSettings = IconAdmin;

export const IconAudit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" />
    <path d="M13.5 3v5.5H19" />
    <path d="M9 12.5h1.5" />
    <path d="M9 16h5" />
    <circle cx="14.8" cy="12.6" r="1.6" />
  </Svg>
);

/* ==========================================================================
   UI AFFORDANCES — §13 topbar, §24 tables, §36 buttons, §45 micro-interactions
   ========================================================================== */

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.8" cy="10.8" r="6.8" />
    <path d="m20 20-4.4-4.4" />
  </Svg>
);

export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.8" />
    <path d="M3.4 12h17.2" />
    <path d="M12 3.2c2.4 2.4 3.6 5.4 3.6 8.8s-1.2 6.4-3.6 8.8c-2.4-2.4-3.6-5.4-3.6-8.8S9.6 5.6 12 3.2Z" />
  </Svg>
);

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
  </Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.6 8.6 0 1 0 20 14.2Z" />
  </Svg>
);

export const IconMonitor = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.8" y="4" width="18.4" height="12.5" rx="2" />
    <path d="M8.5 20.5h7" />
    <path d="M12 16.5v4" />
  </Svg>
);

export const IconHelp = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.8" />
    <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.4" />
    <path d="M12 17.2h.01" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}><path d="m6 9.5 6 6 6-6" /></Svg>
);
export const IconChevronUp = (p: IconProps) => (
  <Svg {...p}><path d="m6 14.5 6-6 6 6" /></Svg>
);
export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}><path d="m14.5 6-6 6 6 6" /></Svg>
);
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}><path d="m9.5 6 6 6-6 6" /></Svg>
);
/**
 * Direction-aware chevron. Under RTL a "forward" chevron must point left, so
 * navigation uses this rather than Left/Right directly. Flipping it in CSS
 * rather than swapping components keeps one glyph in the bundle.
 */
export const IconChevronForward = (p: IconProps) => (
  <Svg {...p} className={`kgm-chevron-fwd${p.className ? ` ${p.className}` : ''}`}>
    <path d="m9.5 6 6 6-6 6" />
  </Svg>
);
export const IconChevronBack = (p: IconProps) => (
  <Svg {...p} className={`kgm-chevron-back${p.className ? ` ${p.className}` : ''}`}>
    <path d="m14.5 6-6 6 6 6" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}><path d="M6 6 18 18M18 6 6 18" /></Svg>
);

export const IconMenu = (p: IconProps) => (
  <Svg {...p}><path d="M3.5 7h17M3.5 12h17M3.5 17h17" /></Svg>
);

/** §10 — the rail toggler. Two panels, one collapsing. */
export const IconPanel = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9.5 4v16" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
);
export const IconMinus = (p: IconProps) => (
  <Svg {...p}><path d="M5 12h14" /></Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}><path d="m4.5 12.5 5 5 10-11" /></Svg>
);

export const IconFilter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 5.5h17l-6.6 7.6v5.6l-3.8 2v-7.6L3.5 5.5Z" />
  </Svg>
);

export const IconSort = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4v16" />
    <path d="m3.5 16.5 3.5 3.5 3.5-3.5" />
    <path d="M13.5 7h7" />
    <path d="M13.5 12h5" />
    <path d="M13.5 17h3" />
  </Svg>
);

export const IconColumns = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16M15 4v16" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5v11" />
    <path d="m7.5 10 4.5 4.5 4.5-4.5" />
    <path d="M4 19.5h16" />
  </Svg>
);

export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15V4" />
    <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
    <path d="M4 19.5h16" />
  </Svg>
);

export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
    <path d="m14.5 5.5 3 3" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.5h16" />
    <path d="M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
    <path d="M6.5 6.5 7.4 20a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3l.9-13.5" />
    <path d="M10.5 10.5v6.5M13.5 10.5v6.5" />
  </Svg>
);

export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h6v6" />
    <path d="m20 4-8.5 8.5" />
    <path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
    <path d="M20.5 4v5h-5" />
  </Svg>
);

export const IconMoreH = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5.5" cy="12" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="18.5" cy="12" r="1.4" />
  </Svg>
);

export const IconMoreV = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="5.5" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="12" cy="18.5" r="1.4" />
  </Svg>
);

export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.8" />
    <path d="M4.5 20.5c0-4 3.4-6.8 7.5-6.8s7.5 2.8 7.5 6.8" />
  </Svg>
);

export const IconLogout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 4.5H6.8A1.8 1.8 0 0 0 5 6.3v11.4a1.8 1.8 0 0 0 1.8 1.8h7.7" />
    <path d="M17 8.5 20.5 12 17 15.5" />
    <path d="M10.5 12h10" />
  </Svg>
);

/** §57 — the field lock. Shown where a classified field was withheld. */
export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
    <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
    <path d="M12 14.5v2.5" />
  </Svg>
);

export const IconUnlock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
    <path d="M8 10.5V7.8a4 4 0 0 1 7.6-1.7" />
    <path d="M12 14.5v2.5" />
  </Svg>
);

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 4.5 6v6c0 4.4 3.1 7.9 7.5 9 4.4-1.1 7.5-4.6 7.5-9V6L12 3Z" />
  </Svg>
);

export const IconShieldCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 4.5 6v6c0 4.4 3.1 7.9 7.5 9 4.4-1.1 7.5-4.6 7.5-9V6L12 3Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
);

export const IconKey = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="12" r="4.2" />
    <path d="M12.2 12H21" />
    <path d="M17.5 12v3" />
    <path d="M20 12v2.2" />
  </Svg>
);

export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

export const IconEyeOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.9 5.9A9.9 9.9 0 0 1 12 5.8c6 0 9.5 6.2 9.5 6.2a17 17 0 0 1-3.2 4" />
    <path d="M6.2 7.7A16.7 16.7 0 0 0 2.5 12S6 18.2 12 18.2a9.7 9.7 0 0 0 4-.85" />
    <path d="m10 10a2.9 2.9 0 0 0 4 4" />
    <path d="m3.5 3.5 17 17" />
  </Svg>
);

/* ==========================================================================
   §31 · SEVERITY
   Distinct in SILHOUETTE, not only in colour. §44 requires that, and §31
   requires an icon and a label alongside the colour.
   ========================================================================== */

export const IconSeverityInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.8" />
    <path d="M12 11v5.5" />
    <path d="M12 7.8h.01" />
  </Svg>
);

export const IconSeverityNotice = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 9a6 6 0 1 0-12 0c0 4.5-1.5 6-1.5 6h15S18 13.5 18 9Z" />
    <path d="M10.3 19a2 2 0 0 0 3.4 0" />
  </Svg>
);

export const IconSeverityWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4.5" />
    <path d="M12 17h.01" />
  </Svg>
);

export const IconSeverityHigh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2L8.2 3Z" />
    <path d="M12 7.5v5.5" />
    <path d="M12 16.4h.01" />
  </Svg>
);

export const IconSeverityCritical = (p: IconProps) => (
  <Svg {...p} strokeWidth={p.strokeWidth ?? 1.8}>
    <path d="M12 2.8 21.2 19H2.8L12 2.8Z" fill="currentColor" fillOpacity="0.16" />
    <path d="M12 2.8 21.2 19H2.8L12 2.8Z" />
    <path d="M12 8.6v4.6" />
    <path d="M12 16.2h.01" />
  </Svg>
);

/* ==========================================================================
   §21 / §22 · MATTER STATUS + TREND
   ========================================================================== */

export const IconTrendUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 16.5 9.5 10l4 4 7-7.5" />
    <path d="M15 6.5h5.5V12" />
  </Svg>
);

export const IconTrendDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7.5 9.5 14l4-4 7 7.5" />
    <path d="M15 17.5h5.5V12" />
  </Svg>
);

export const IconFlag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 21V3.8" />
    <path d="M5.5 4.8h11l-1.8 3.6 1.8 3.6h-11" />
  </Svg>
);

export const IconRestricted = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.8" />
    <path d="m6 18 12-12" />
  </Svg>
);

export const IconGavel = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3.5 20.5 7-7" />
    <path d="m9.5 8.5 6 6" />
    <path d="m13 5 6 6" />
    <path d="m11.2 6.8 6 6" />
    <path d="M15.5 3.5 21 9" />
  </Svg>
);

export const IconInbox = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 13.5h4l1.5 3h6l1.5-3h4" />
    <path d="M5.6 4.8h12.8l2.1 8.7v4.2a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8v-4.2L5.6 4.8Z" />
  </Svg>
);

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7.2A1.7 1.7 0 0 1 5.2 5.5h3.6l2 2.4h8a1.7 1.7 0 0 1 1.7 1.7v8.2a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7V7.2Z" />
  </Svg>
);

export const IconPaperclip = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11.5 12.4 19a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3.1 3.1 0 0 1 4.4 4.4l-7.7 7.8a1.6 1.6 0 0 1-2.2-2.2l7-7" />
  </Svg>
);

export const IconComment = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.5 12c0 4-3.8 7.2-8.5 7.2-.9 0-1.8-.1-2.6-.3L4 20.5l1.4-3.4C4.2 15.8 3.5 13.7 3.5 12c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2Z" />
  </Svg>
);

export const IconCommand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 3.5A3 3 0 1 0 9.5 6.5v11a3 3 0 1 0 3-3h-11a3 3 0 1 1 3-3v11a3 3 0 1 1-3-3h11a3 3 0 1 0-3 3" />
  </Svg>
);

/* --------------------------------------------------------------------------
   ARROWS
   Distinct from the chevrons on purpose: a chevron means "this expands", an
   arrow means "this goes there". Using one for the other is the kind of small
   ambiguity that makes an interface feel untrustworthy without anyone being
   able to say why.

   These do NOT flip in RTL. `IconArrowRight` points right in both directions,
   because it is used for absolute movement (a trend, a "go to end" control)
   rather than for "forward". Directional navigation uses IconChevronForward /
   IconChevronBack, which do flip.
   -------------------------------------------------------------------------- */

export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12h15" />
    <path d="m13.5 6.5 6 5.5-6 5.5" />
  </Svg>
);

export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12H5" />
    <path d="m10.5 6.5-6 5.5 6 5.5" />
  </Svg>
);

export const IconArrowUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20V5" />
    <path d="m6.5 10.5 5.5-6 5.5 6" />
  </Svg>
);

export const IconArrowDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v15" />
    <path d="m6.5 13.5 5.5 6 5.5-6" />
  </Svg>
);

/** "Forward" and "back" in the READING direction — these flip in RTL via the
 *  .kgm-chevron-fwd / .kgm-chevron-back classes in base.css. */
export const IconArrowForward = (p: IconProps) => (
  <span className="kgm-chevron-fwd" style={{ display: 'inline-flex' }}>
    <IconArrowRight {...p} />
  </span>
);
