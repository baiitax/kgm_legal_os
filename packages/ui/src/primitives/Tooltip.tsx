/**
 * TOOLTIP · §10
 *
 * A CSS-only tooltip. The label lives in a `data-tip` attribute and the bubble is
 * a `::after` pseudo-element, so there is no positioning code, no portal and no
 * reflow measurement.
 *
 * WHY CSS-ONLY IS THE RIGHT CALL HERE
 *   The one place this is used is the collapsed rail (§10), where the tooltip has
 *   to appear on the correct side in RTL and LTR without anyone computing which
 *   side that is. A `[dir='rtl']` selector in CSS does it declaratively; a JS
 *   tooltip would need to read the direction, the viewport and the trigger rect,
 *   and would get it wrong on the first paint after a language switch.
 *
 * THE ACCESSIBILITY CATCH, AND HOW IT IS HANDLED
 *   `::after` content is not reliably exposed to assistive technology, and a
 *   tooltip that carries the ONLY name for an icon button is an unnamed button to
 *   a screen-reader user. So this component requires the child to already be
 *   labelled — `aria-label` on a button, visible text otherwise — and the tooltip
 *   is treated as a visual duplicate for sighted pointer users, never as the
 *   accessible name.
 *
 *   That is why `label` is not applied as `aria-label` here. Doing so would be
 *   convenient and would silently override whatever more precise label the child
 *   carries.
 *
 *   `role="tooltip"` is not used either: without `aria-describedby` wiring it
 *   would announce a tooltip that AT cannot see the contents of. The honest
 *   structure is a labelled control plus a decorative hint.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

export interface TooltipProps {
  /** The hint text. Must duplicate a label the child already exposes. */
  readonly label: string;
  readonly children: ReactNode;
  /** Extra class on the wrapper. The wrapper is what carries `position`. */
  readonly className?: string;
  /**
   * Render without the wrapper element, attaching `data-tip` straight to the
   * child. Prefer this when the child is a single element that can be positioned
   * — it avoids an extra box in a flex row, which is what the collapsed rail is.
   */
  readonly inline?: boolean;
}

export function Tooltip({ label, children, className, inline = true }: TooltipProps) {
  // Fast path: a single element we can decorate directly.
  if (inline && isValidElement(children)) {
    const child = children as ReactElement<Record<string, unknown>>;
    return cloneElement(child, {
      className: joinClass('kgm-tip', child.props.className as string | undefined, className),
      'data-tip': label,
    });
  }

  // Fallback: wrap. Used when children is text, a fragment, or several nodes.
  return (
    <span className={joinClass('kgm-tip', className)} data-tip={label}>
      {children}
    </span>
  );
}

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
