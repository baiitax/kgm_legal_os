/**
 * ALERT · §31, §45
 *
 * Inline, severity-driven feedback that lives in the page rather than floating
 * over it. Distinct from Toast on purpose:
 *
 *   TOAST  — transient, self-dismissing, for an action that already completed.
 *            "Saved." It disappears because there is nothing left to do.
 *   ALERT  — persistent, in-flow, for a condition the user must reckon with
 *            before proceeding. A lockout, a withheld-fields notice, a ceiling
 *            refusal. It stays until the condition changes.
 *
 * An error rendered as a toast is an error the user can miss by looking away for
 * two seconds. That is why the login failures in §52 are Alerts.
 *
 * §31 · SEVERITY IS CARRIED THREE WAYS
 *   Colour alone is not enough (roughly 1 in 12 men has a colour vision
 *   deficiency, and red/green is the pair most affected — which is precisely the
 *   pair a "success vs error" system relies on). So each severity gets an icon, a
 *   text label, and a colour. Removing any one of the three still leaves the
 *   message legible.
 *
 *   The five levels are ordered and non-overlapping. `high` and `critical` are
 *   separate because §31 treats a deadline at risk differently from a security
 *   event, and collapsing them would leave no way to escalate.
 *
 * A11Y
 *   `role="alert"` for warning and above — those announce immediately, because
 *   they are the ones where a delayed announcement means the user has already
 *   acted on stale information. `info` and `notice` use `role="status"`, which
 *   waits for a natural pause; interrupting a screen-reader user to say "for your
 *   information" is not a service.
 */
import {
  IconClose, IconSeverityCritical, IconSeverityHigh, IconSeverityInfo,
  IconSeverityNotice, IconSeverityWarning,
} from '../icons/index.js';
import type { Severity } from './Badge.js';
import { IconButton } from './Button.js';
import type { CSSProperties, ReactNode } from 'react';

export type AlertTone = Severity;

export interface AlertProps {
  tone?: AlertTone;
  /** Bold first line. The body below carries the detail. */
  title?: ReactNode;
  children?: ReactNode;
  /** Trailing actions — "Retry", "Learn more". */
  action?: ReactNode;
  /** Shows a close button. Off by default: a condition worth stating is usually
   *  worth keeping on screen until it resolves. */
  dismissible?: boolean;
  onDismiss?: () => void;
  /** Renders the severity label as visible text. On by default per §31. */
  showSeverityLabel?: boolean;
  /** Compact single-line form, for inline notices under a field. */
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}

const ICONS: Record<AlertTone, typeof IconSeverityInfo> = {
  info: IconSeverityInfo,
  notice: IconSeverityNotice,
  warning: IconSeverityWarning,
  high: IconSeverityHigh,
  critical: IconSeverityCritical,
};

/** English fallback labels. Screens normally pass their own localized title, so
 *  this is only the visible severity word when `showSeverityLabel` is on. */
const LABELS: Record<AlertTone, { en: string; ar: string }> = {
  info:     { en: 'Info',     ar: 'معلومة' },
  notice:   { en: 'Notice',   ar: 'تنبيه' },
  warning:  { en: 'Warning',  ar: 'تحذير' },
  high:     { en: 'High',     ar: 'مرتفع' },
  critical: { en: 'Critical', ar: 'حرج' },
};

export function Alert({
  tone = 'info',
  title,
  children,
  action,
  dismissible = false,
  onDismiss,
  showSeverityLabel = false,
  compact = false,
  className = '',
  style,
  lang = 'en',
}: AlertProps & { lang?: 'ar' | 'en' }) {
  const Icon = ICONS[tone];
  // warning+ interrupts; info/notice wait for a pause. See the header note.
  const urgent = tone === 'warning' || tone === 'high' || tone === 'critical';
  const role = urgent ? 'alert' : 'status';

  return (
    <div
      className={`kgm-alert kgm-alert--${tone}${compact ? ' kgm-alert--compact' : ''} ${className}`.trim()}
      role={role}
      style={style}
    >
      <span className="kgm-alert__icon" aria-hidden="true"><Icon size={compact ? 15 : 18} /></span>

      <div className="kgm-alert__body">
        {showSeverityLabel && (
          <span className="kgm-alert__severity u-uppercase">{LABELS[tone][lang]}</span>
        )}
        {title ? <p className="kgm-alert__title">{title}</p> : null}
        {children ? <div className="kgm-alert__text">{children}</div> : null}
        {action ? <div className="kgm-alert__action">{action}</div> : null}
      </div>

      {dismissible && onDismiss ? (
        <IconButton
          label={lang === 'ar' ? 'إغلاق' : 'Dismiss'}
          icon={<IconClose size={14} />}
          variant="ghost"
          size="xs"
          onClick={onDismiss}
          className="kgm-alert__close"
        />
      ) : null}
    </div>
  );
}
