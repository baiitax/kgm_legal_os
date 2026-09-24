/**
 * BUTTON · §36
 *
 * Four intents, and the brief is specific about each:
 *
 *   primary    KGM Green, white text, soft rounded corners, subtle glow
 *   secondary  glass, green border, green text
 *   premium    Saudi Gold, DARK text — gold is light enough that white on it
 *              fails contrast, and §44 requires WCAG-conscious contrast
 *   danger     "a restrained warning treatment"
 *
 * ON DANGER
 *   §36 says never to use red everywhere simply because an action is destructive,
 *   and that instruction is load-bearing rather than aesthetic. If every
 *   destructive button is red, red stops signalling anything, and the one action
 *   that is genuinely irreversible looks like the one that deletes a draft. So
 *   `danger` is a muted warning tone by default and there is a separate
 *   `destructive` for the small number of actions that are irreversible and
 *   should look it. The naming makes the author choose which they mean.
 *
 * SIZES
 *   `sm` still clears the 44px touch target on coarse pointers (§44) via a media
 *   query, rather than being a fixed 32px that is unusable on a phone. A smaller
 *   visual height on touch is a common way design systems fail accessibility
 *   review after passing it on a desktop screenshot.
 */
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'premium'
  | 'ghost'
  | 'danger'
  | 'destructive';

export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon before the label. */
  icon?: ReactNode;
  /** Icon after the label — a chevron, an external-link mark. */
  trailingIcon?: ReactNode;
  /** Replaces the label with a centred spinner and disables the button. */
  loading?: boolean;
  /** Full inline width. Mobile sticky action bars (§18). */
  block?: boolean;
  type?: 'button' | 'submit' | 'reset';
  children?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  trailingIcon,
  loading = false,
  block = false,
  disabled,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    'kgm-btn',
    `kgm-btn--${variant}`,
    `kgm-btn--${size}`,
    block ? 'kgm-btn--block' : '',
    loading ? 'kgm-btn--loading' : '',
    // An icon-only button is square and needs its own padding rules.
    !children && (icon || trailingIcon) ? 'kgm-btn--icon-only' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      // A loading button is not merely disabled — it is busy. aria-busy lets a
      // screen reader announce the state instead of reading a dead control.
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {!loading && icon ? <span className="kgm-btn__icon" aria-hidden="true">{icon}</span> : null}
      {children ? <span className="kgm-btn__label">{children}</span> : null}
      {!loading && trailingIcon ? (
        <span className="kgm-btn__icon kgm-btn__icon--trailing" aria-hidden="true">{trailingIcon}</span>
      ) : null}
    </button>
  );
}

/** A minimal spinner. No asset, no animation library — a rotating arc. */
export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`kgm-spinner ${className}`}
      style={{ inlineSize: size, blockSize: size } as CSSProperties}
      role="status"
      aria-label="Loading"
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  type?: 'button' | 'submit' | 'reset';
  /** REQUIRED. An icon button with no accessible name is an unnamed control. */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows `label` as a tooltip on hover. §10 requires this in the collapsed rail. */
  tooltip?: boolean;
  /** Marks the button as the current page/section, for nav and toggles. */
  active?: boolean;
  /** Unread indicator dot — notifications, messages. */
  dot?: boolean;
  children?: ReactNode;
}

export function IconButton({
  label, icon, variant = 'ghost', size = 'md', tooltip = true,
  active = false, dot = false, className = '', children, type = 'button', ...rest
}: IconButtonProps) {
  const classes = [
    'kgm-btn',
    'kgm-btn--icon-only',
    `kgm-btn--${variant}`,
    `kgm-btn--${size}`,
    active ? 'kgm-btn--active' : '',
    dot ? 'kgm-btn--dot' : '',
    tooltip ? 'kgm-tip' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      type={type}
      className={classes}
      // aria-label, never title alone: title is not reliably announced and is
      // invisible to touch users. The tooltip below is the visual counterpart.
      aria-label={label}
      aria-current={active ? 'true' : undefined}
      data-tip={tooltip ? label : undefined}
      {...rest}
    >
      <span className="kgm-btn__icon" aria-hidden="true">{icon}</span>
      {dot ? <span className="kgm-btn__dot" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
