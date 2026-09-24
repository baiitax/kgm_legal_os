/**
 * §46 / §47 · THE KGM MARK.
 *
 * §47 sets the hierarchy: KGM → LEGAL → OS. The lockup reads in that order and
 * the weights carry it — KGM heaviest, LEGAL lighter and letterspaced, OS
 * lightest and accented. The system should read as proprietary infrastructure,
 * not a SaaS template, and typography hierarchy is most of what sells that.
 *
 * §46 requires correct aspect ratio and clear space, and forbids redrawing or
 * distorting the mark. Both are handled structurally rather than by convention:
 *
 *   - The mark is drawn on a fixed 48×48 grid and every variant scales that grid
 *     uniformly. There is no prop that can stretch one axis, so "maintain aspect
 *     ratio" is not something a caller has to remember.
 *   - Clear space is padding on the lockup container, expressed as a fraction of
 *     the mark's own height. It scales with the logo instead of being a fixed
 *     pixel value that becomes wrong at large sizes.
 *
 * COLOUR
 *   The mark takes its greens and gold from design tokens, not hardcoded hex, so
 *   it inverts correctly in light mode (§05). A logo that stays dark-green on a
 *   white card is the most common way a themed design system fails review.
 *
 * THE MARK ITSELF
 *   A geometric K on an institutional tile. The lower arm carries the Saudi gold
 *   accent — restrained, per §02, which warns against anything metallic or
 *   decorative. One gold stroke on a green field reads as an institution; a gold
 *   gradient fill reads as a trophy.
 */
import type { CSSProperties } from 'react';

/** Sizes the lockup is offered at. Named for use, not for pixels. */
export type LogoSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const MARK_PX: Record<LogoSize, number> = {
  xs: 20,
  sm: 26,
  md: 32,
  lg: 44,
  xl: 64,
};

export interface LogoMarkProps {
  size?: LogoSize | number;
  /** Pixel size override. Wins over `size`. */
  px?: number;
  /** Drop the tile so the mark sits directly on a surface. */
  bare?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

/**
 * The mark alone — no wordmark.
 *
 * Used in the collapsed rail (§10), the preloader (§32), the mobile header (§15)
 * and the favicon. `bare` removes the tile for contexts that already supply a
 * surface, such as an active nav pill.
 */
export function LogoMark({ size = 'md', px, bare = false, className, style, title }: LogoMarkProps) {
  // `size` accepts a raw number as well as a named step, so the lookup has to
  // tolerate both. A numeric size is used verbatim — the mark is drawn on a
  // square viewBox and scales uniformly, which is what keeps §46's aspect-ratio
  // requirement true for a caller who passes a pixel value.
  const n = px ?? (typeof size === 'number' ? size : MARK_PX[size]);
  return (
    <svg
      width={n}
      height={n}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      style={style}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}

      {!bare && (
        <>
          {/* Institutional tile. Rounded, not circular: a squircle reads as
              enterprise infrastructure, a circle reads as a consumer app icon. */}
          <rect x="1.5" y="1.5" width="45" height="45" rx="13" fill="url(#kgm-tile)" />
          <rect
            x="1.5" y="1.5" width="45" height="45" rx="13"
            stroke="var(--kgm-logo-tile-stroke, rgba(255,255,255,0.16))"
            strokeWidth="1"
          />
          {/* §03: one controlled highlight along the top edge. */}
          <path
            d="M14.5 2.2h19"
            stroke="rgba(255,255,255,0.30)"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </>
      )}

      {/* The K. Stem and upper arm in white/green-50; lower arm in Saudi gold. */}
      <g
        stroke="var(--kgm-logo-stem, #ffffff)"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <path d="M17 13.5v21" />
        <path d="M17.6 25.4 31 13.5" />
      </g>
      <path
        d="M19.4 27.4 32.5 35.5"
        stroke="var(--kgm-logo-accent, #d3b469)"
        strokeWidth="4.2"
        strokeLinecap="round"
        fill="none"
      />

      <defs>
        <linearGradient id="kgm-tile" x1="4" y1="2" x2="44" y2="46" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--kgm-logo-tile-1, #14654e)" />
          <stop offset="1" stopColor="var(--kgm-logo-tile-2, #072821)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export interface LogoProps {
  size?: LogoSize;
  /**
   * `stacked` puts the wordmark under the mark, for the preloader and login.
   * `inline` puts it beside the mark, for the rail and mobile header.
   */
  layout?: 'inline' | 'stacked';
  /** Show only KGM, dropping LEGAL OS. For the collapsed rail and tight spaces. */
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * The full lockup.
 *
 * §47's hierarchy is rendered as three separately-weighted runs rather than one
 * string with a gradient or a colour change mid-word. Weight and spacing carry
 * the order; colour is used once, on OS, and only in gold.
 */
export function Logo({ size = 'md', layout = 'inline', compact = false, className, style }: LogoProps) {
  const stacked = layout === 'stacked';
  return (
    <span
      className={`kgm-logo kgm-logo--${size} kgm-logo--${layout}${compact ? ' kgm-logo--compact' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      <LogoMark size={size} />
      <span className="kgm-logo__type">
        <span className="kgm-logo__kgm">KGM</span>
        {!compact && (
          <>
            <span className="kgm-logo__legal">LEGAL</span>
            <span className="kgm-logo__os">OS</span>
          </>
        )}
      </span>
      {/* Stacked layout reads down the hierarchy; inline reads across it. */}
      {stacked && !compact && <span className="kgm-logo__sub">Secure legal workspace</span>}
    </span>
  );
}
