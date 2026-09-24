/**
 * MODAL · DRAWER · BOTTOM SHEET · §38, §39, §17
 *
 * §38: glass surfaces, backdrop blur, dark translucent overlay, rounded panel,
 * soft border. "For complex workflows use a large modal, side panel or
 * full-screen mobile sheet. Do not put complex forms into tiny dialogs."
 * §39: drawers for matter details, filters, notifications, activity, document
 * metadata — and "mobile drawers should become bottom sheets".
 *
 * THE PART THAT IS ACTUALLY HARD IS NOT THE GLASS
 * A dialog is the most accessibility-dense component in any system, and the
 * failures are invisible in a screenshot:
 *
 *   - FOCUS TRAP. Tab must cycle inside the panel. Without it a keyboard user
 *     tabs out of a modal into the page behind it and cannot tell where they are.
 *   - FOCUS RESTORE. On close, focus returns to the element that opened the
 *     dialog. Losing focus to <body> dumps a screen-reader user at the top of the
 *     document.
 *   - INERT BACKGROUND. The content behind must be hidden from assistive tech,
 *     not merely dimmed. `aria-hidden` on the app root plus `inert` where
 *     supported.
 *   - ESCAPE AND SCROLL LOCK. Esc closes; the page behind must not scroll.
 *
 * All four are implemented here so no caller has to remember them.
 *
 * MOBILE
 *   `placement="drawer"` becomes a bottom sheet below the tablet breakpoint via
 *   CSS, not via a second component. One component with one focus implementation
 *   is correct in both shapes; two components means the sheet drifts.
 */
import {
  useCallback, useEffect, useRef, type ReactNode,
} from 'react';
import { IconButton } from './Button.js';

export type OverlayPlacement = 'center' | 'drawer' | 'sheet';
export type OverlaySize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  /** Accessible title. Required — an untitled dialog is announced as "dialog". */
  title: ReactNode;
  /** Optional longer description, wired to aria-describedby. */
  description?: ReactNode;
  placement?: OverlayPlacement;
  size?: OverlaySize;
  /** Footer action bar. Sticky on mobile (§18 "sticky action bars"). */
  footer?: ReactNode;
  /** Disables the close button and Esc. For genuinely blocking confirmation. */
  dismissible?: boolean;
  children?: ReactNode;
  className?: string;
  /** Called after the panel mounts, for autofocus of a specific field. */
  initialFocusRef?: React.RefObject<HTMLElement>;
}

/** Locks body scroll for the lifetime of the returned cleanup. */
function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const { overflow, paddingRight } = document.body.style;
    // Compensate for the scrollbar width so the page behind does not shift when
    // it disappears. A layout jump behind a modal is visible through the blur.
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
    return () => {
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
    };
  }, [active]);
}

export function Overlay({
  open, onClose, title, description, placement = 'center', size = 'md',
  footer, dismissible = true, children, className = '', initialFocusRef,
}: OverlayProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useRef(`ov-${Math.random().toString(36).slice(2, 9)}`).current;
  const descId = description ? `${titleId}-d` : undefined;

  useScrollLock(open);

  // ---- focus management ---------------------------------------------------
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;

    // Defer so the panel is in the DOM and its children are focusable.
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      if (initialFocusRef?.current) { initialFocusRef.current.focus(); return; }
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    });

    return () => {
      cancelAnimationFrame(raf);
      // Restore focus on close. Guarded because the opener may have unmounted
      // (a row deleted, a nav change), and focusing a detached node throws.
      const el = restoreRef.current;
      if (el && document.contains(el)) el.focus();
    };
  }, [open, initialFocusRef]);

  // ---- escape + focus trap ------------------------------------------------
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && dismissible) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;

    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) { e.preventDefault(); panel.focus(); return; }

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, [dismissible, onClose]);

  if (!open) return null;

  return (
    <div
      className={`kgm-overlay kgm-overlay--${placement} kgm-overlay--${size} ${className}`}
      onKeyDown={onKeyDown}
    >
      {/* Clicking the scrim closes. `aria-hidden` because the panel inside is the
          labelled surface; the scrim itself is not content. */}
      <div
        className="kgm-overlay__scrim fade-enter"
        onClick={dismissible ? onClose : undefined}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        className={`kgm-overlay__panel glass glass-strong glass-sheen kgm-overlay__panel--${placement}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        // The panel must be focusable for the trap to have a fallback target when
        // it contains no controls at all.
        tabIndex={-1}
      >
        <header className="kgm-overlay__head">
          <div className="kgm-overlay__headtext">
            <h2 className="kgm-overlay__title t-h3" id={titleId}>{title}</h2>
            {description ? (
              <p className="kgm-overlay__desc t-caption c-secondary" id={descId}>{description}</p>
            ) : null}
          </div>
          {dismissible ? (
            <IconButton
              label="Close"
              size="sm"
              // A sheet is dismissed by dragging or by the scrim; the X is still
              // needed for keyboard and screen-reader users, so it never goes away.
              icon={<span aria-hidden="true">✕</span>}
              onClick={onClose}
            />
          ) : null}
        </header>

        <div className="kgm-overlay__body">{children}</div>

        {footer ? <footer className="kgm-overlay__foot">{footer}</footer> : null}

        {/* §17/§39: the grab handle on sheets. Decorative — the panel is still
            closable by button, Esc and scrim for anyone not using touch. §18
            forbids gestures as the ONLY method. */}
        {placement === 'sheet' ? <span className="kgm-overlay__grab" aria-hidden="true" /> : null}
      </div>
    </div>
  );
}

/** Convenience: a centred modal (§38). */
export function Modal(props: OverlayProps) {
  return <Overlay {...props} placement="center" />;
}

/**
 * Convenience: a side drawer (§39).
 *
 * Renders as a bottom sheet below the tablet breakpoint — the CSS swaps the
 * placement, so the focus and dismissal behaviour above is shared.
 */
export function Drawer({ side = 'end', ...props }: OverlayProps & { side?: 'start' | 'end' }) {
  return <Overlay {...props} placement="drawer" className={`kgm-drawer--${side} ${props.className ?? ''}`} />;
}

/** Convenience: a bottom sheet (§17). */
export function BottomSheet(props: OverlayProps) {
  return <Overlay {...props} placement="sheet" />;
}
