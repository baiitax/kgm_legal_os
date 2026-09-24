/**
 * BADGE / CHIP / STATUS · §21 matter status · §31 alert severity
 *
 * §31 requires severity to be carried by ICON AND LABEL in addition to colour,
 * and §44 requires WCAG-conscious contrast. Those two rules shape this whole
 * file: every tone is a tinted surface with a saturated FOREGROUND, never a
 * saturated fill with white text. A saturated fill looks stronger in a mockup
 * and fails contrast at 11px in production, which is the size these render at.
 *
 * §21's matter statuses are mapped explicitly rather than passed through, so a
 * new status value from the API cannot render as an unstyled default. Unknown
 * statuses fall through to `neutral` and log in dev — a silent default is how a
 * "Restricted" matter ends up looking identical to an "Active" one.
 */
import type { CSSProperties, ReactNode } from 'react';

export type BadgeTone =
  | 'neutral'
  | 'brand'
  | 'lime'
  | 'gold'
  | 'info'
  | 'notice'
  | 'warning'
  | 'high'
  | 'critical';

export type BadgeSize = 'xs' | 'sm' | 'md';

export interface BadgeProps {
  tone?: BadgeTone;
  size?: BadgeSize;
  /** Filled rather than tinted. Reserve for the one badge that must dominate. */
  solid?: boolean;
  /** Leading dot instead of an icon — for live/active state. */
  dot?: boolean;
  /** Pulses the dot. §02 allows lime for "active indicators"; keep it rare. */
  pulse?: boolean;
  icon?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function Badge({
  tone = 'neutral',
  size = 'sm',
  solid = false,
  dot = false,
  pulse = false,
  icon,
  className = '',
  style,
  children,
}: BadgeProps) {
  const classes = [
    'kgm-badge',
    `kgm-badge--${tone}`,
    `kgm-badge--${size}`,
    solid ? 'kgm-badge--solid' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <span className={classes} style={style}>
      {dot ? (
        <span className={`kgm-badge__dot${pulse ? ' kgm-badge__dot--pulse' : ''}`} aria-hidden="true" />
      ) : null}
      {icon ? <span className="kgm-badge__icon" aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}

/* ==========================================================================
   §31 · SEVERITY
   Five levels. Each pairs a tone with an icon and a label, because the brief
   asks for all three and because colour alone is not a channel everyone has.
   ========================================================================== */

export type Severity = 'info' | 'notice' | 'warning' | 'high' | 'critical';

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  info: 'info',
  notice: 'notice',
  warning: 'warning',
  high: 'high',
  critical: 'critical',
};

/** The visible label. Uppercase in Latin per §31's example; the token sheet
 *  suppresses text-transform under RTL, since caps are not an Arabic device. */
export const SEVERITY_LABEL: Record<Severity, { en: string; ar: string }> = {
  info:     { en: 'Info',     ar: 'معلومة' },
  notice:   { en: 'Notice',   ar: 'تنبيه' },
  warning:  { en: 'Warning',  ar: 'تحذير' },
  high:     { en: 'High',     ar: 'مرتفع' },
  critical: { en: 'Critical', ar: 'حرج' },
};

/** The glyph per level. Distinct silhouettes — see the icon module's note. */
export const SEVERITY_GLYPH: Record<Severity, string> = {
  info: 'ⓘ',
  notice: '◎',
  warning: '⚠',
  high: '⬢',
  critical: '▲',
};

export interface SeverityBadgeProps {
  severity: Severity;
  lang?: 'ar' | 'en';
  /** Show the glyph. On by default; §31 wants icon plus label plus colour. */
  icon?: boolean;
  size?: BadgeSize;
  className?: string;
}

export function SeverityBadge({ severity, lang = 'en', icon = true, size = 'sm', className }: SeverityBadgeProps) {
  return (
    <Badge tone={SEVERITY_TONE[severity]} size={size} className={className}>
      {icon ? <span aria-hidden="true">{SEVERITY_GLYPH[severity]}</span> : null}
      <span className="u-uppercase">{SEVERITY_LABEL[severity][lang]}</span>
    </Badge>
  );
}

/* ==========================================================================
   §21 · MATTER STATUS
   ========================================================================== */

export type MatterStatus =
  | 'active'
  | 'restricted'
  | 'judgment'
  | 'execution'
  | 'closed'
  | 'draft'
  | 'pending'
  | 'on_hold'
  | 'archived';

/**
 * Status → tone. Restricted is `critical`-adjacent but deliberately NOT red:
 * a restricted matter is a normal state in a firm with conflicts procedures, not
 * an emergency, and painting it red trains people to ignore red.
 */
const MATTER_STATUS_TONE: Record<MatterStatus, BadgeTone> = {
  active: 'lime',
  restricted: 'high',
  judgment: 'gold',
  execution: 'brand',
  closed: 'neutral',
  draft: 'neutral',
  pending: 'warning',
  on_hold: 'warning',
  archived: 'neutral',
};

export const MATTER_STATUS_LABEL: Record<MatterStatus, { en: string; ar: string }> = {
  active:     { en: 'Active',     ar: 'نشط' },
  restricted: { en: 'Restricted', ar: 'مقيّد' },
  judgment:   { en: 'Judgment',   ar: 'حكم' },
  execution:  { en: 'Execution',  ar: 'تنفيذ' },
  closed:     { en: 'Closed',     ar: 'مغلق' },
  draft:      { en: 'Draft',      ar: 'مسودة' },
  pending:    { en: 'Pending',    ar: 'قيد الانتظار' },
  on_hold:    { en: 'On hold',    ar: 'معلّق' },
  archived:   { en: 'Archived',   ar: 'مؤرشف' },
};

export interface StatusChipProps {
  /** Raw status from the API. Unknown values render neutral and warn in dev. */
  status: string;
  lang?: 'ar' | 'en';
  size?: BadgeSize;
  /** Shows the live dot on `active`. */
  dot?: boolean;
  className?: string;
}

/** Normalizes an API status string to a known key. */
function toMatterStatus(raw: string): MatterStatus | null {
  const key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_') as MatterStatus;
  return key in MATTER_STATUS_TONE ? key : null;
}

export function StatusChip({ status, lang = 'en', size = 'sm', dot = false, className }: StatusChipProps) {
  const known = toMatterStatus(status);

  if (!known && import.meta.env?.DEV) {
    // Loud in development, quiet in production. An unknown status must not crash
    // a matter list, but it also must not pass unnoticed by the person adding it.
    console.warn(`[kgm-ui] unmapped matter status "${status}" — rendering neutral`);
  }

  const tone = known ? MATTER_STATUS_TONE[known] : 'neutral';
  const label = known ? MATTER_STATUS_LABEL[known][lang] : status;

  return (
    <Badge tone={tone} size={size} dot={dot && known === 'active'} pulse={dot && known === 'active'} className={className}>
      {label}
    </Badge>
  );
}

/* ==========================================================================
   ACCESS LEVEL (§17) — the firm-only chip
   A client portal has no concept of these, which is precisely why it lives here
   and not in a shared vocabulary: it is internal by definition.
   ========================================================================== */

export type AccessLevelChip = 'full' | 'edit' | 'operational' | 'view' | 'financial' | 'compliance';

const ACCESS_TONE: Record<AccessLevelChip, BadgeTone> = {
  full: 'gold',
  edit: 'brand',
  operational: 'lime',
  view: 'neutral',
  financial: 'info',
  compliance: 'notice',
};

export const ACCESS_LABEL: Record<AccessLevelChip, { en: string; ar: string }> = {
  full:        { en: 'Full access',   ar: 'صلاحية كاملة' },
  edit:        { en: 'Edit',          ar: 'تحرير' },
  operational: { en: 'Operational',   ar: 'تشغيلي' },
  view:        { en: 'View only',     ar: 'اطلاع فقط' },
  financial:   { en: 'Financial',     ar: 'مالي' },
  compliance:  { en: 'Compliance',    ar: 'امتثال' },
};

export function AccessBadge({ level, lang = 'en', size = 'xs', className }: {
  level: string; lang?: 'ar' | 'en'; size?: BadgeSize; className?: string;
}) {
  const key = level as AccessLevelChip;
  const tone = ACCESS_TONE[key] ?? 'neutral';
  const label = ACCESS_LABEL[key] ? ACCESS_LABEL[key][lang] : level;
  return <Badge tone={tone} size={size} className={className}>{label}</Badge>;
}
