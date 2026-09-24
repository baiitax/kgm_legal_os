/**
 * SKELETON · §35
 *
 * The brief asks for branded skeletons with a green-tinted shimmer rather than
 * generic gray. That is not decoration — a gray skeleton in a green glass app
 * reads as a broken component, and operators learn to squint at the difference
 * between "loading" and "failed". A skeleton that is visibly part of the design
 * system communicates "working" without the user having to interpret it.
 *
 * The shimmer is a single gradient sweep on a pseudo-element, not an animated
 * background-position on every block. One composited layer per skeleton keeps a
 * page with forty blocks from costing forty repaints, which matters because
 * skeleton-heavy pages are exactly the pages that are already busy fetching.
 *
 * §44 reduced-motion disables the sweep entirely and leaves a static tinted
 * block. A pulsing skeleton is a common vestibular trigger and the fallback is
 * still legible as "placeholder".
 *
 * SHAPE PARITY
 *   Every skeleton variant matches the real component's dimensions. A skeleton
 *   that is a different height from what replaces it makes the page jump on
 *   arrival, and cumulative layout shift on a dashboard someone is trying to read
 *   is worse than the loading state it was meant to improve.
 */
import type { CSSProperties, ReactNode } from 'react';

export interface SkeletonProps {
  /** Rendered width. Strings pass through, so `100%` and `8rem` both work. */
  width?: number | string;
  height?: number | string;
  variant?: 'text' | 'title' | 'circle' | 'rect' | 'chip' | 'figure';
  /** Number of text lines to render as a block. */
  lines?: number;
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ width, height, variant = 'text', lines, className = '', style }: SkeletonProps) {
  if (lines && lines > 1) {
    // A multi-line block staggers the last line's width, because real paragraphs
    // rarely end flush and a uniform block reads as a rendering error.
    return (
      <span className={`kgm-skel-group ${className}`} style={style} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span
            key={i}
            className="kgm-skel kgm-skel--text"
            style={{ inlineSize: i === lines - 1 ? '62%' : (width ?? '100%') }}
          />
        ))}
      </span>
    );
  }

  const dim: CSSProperties = {
    ...(width !== undefined ? { inlineSize: typeof width === 'number' ? `${width}px` : width } : {}),
    ...(height !== undefined ? { blockSize: typeof height === 'number' ? `${height}px` : height } : {}),
    ...style,
  };

  return (
    <span
      className={`kgm-skel kgm-skel--${variant} ${className}`}
      style={dim}
      // The skeleton is always decorative: the surrounding live region announces
      // the loading state, so a screen reader should not enumerate placeholders.
      aria-hidden="true"
    />
  );
}

/* ==========================================================================
   COMPOSED SKELETONS
   Per-module shapes, so a page skeleton matches the page (§35).
   ========================================================================== */

/** §20 metric card placeholder. Matches MetricCard's real height. */
export function MetricSkeleton({ index }: { index?: number }) {
  return (
    <div
      className="kgm-card kgm-card--metric kgm-card--pad-md kgm-skel-card"
      style={index !== undefined ? ({ '--i': index } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      <div className="kgm-metric">
        <div className="kgm-metric__top">
          <Skeleton variant="chip" width={92} height={10} />
          <Skeleton variant="circle" width={28} height={28} />
        </div>
        <div className="kgm-metric__figure">
          <Skeleton variant="figure" width={104} height={34} />
        </div>
        <Skeleton variant="text" width={120} height={10} />
      </div>
    </div>
  );
}

/** §21 matter card placeholder. */
export function MatterCardSkeleton({ index }: { index?: number }) {
  return (
    <div
      className="kgm-card kgm-card--default kgm-card--pad-md kgm-skel-card"
      style={index !== undefined ? ({ '--i': index } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      <div className="kgm-skel-matter">
        <div className="kgm-skel-matter__head">
          <Skeleton variant="chip" width={104} height={18} />
          <Skeleton variant="circle" width={22} height={22} />
        </div>
        <Skeleton variant="title" width="82%" />
        <Skeleton variant="text" width="58%" />
        <div className="kgm-skel-matter__row">
          <Skeleton variant="text" width={70} height={10} />
          <Skeleton variant="text" width={92} height={10} />
        </div>
        <div className="kgm-skel-matter__foot">
          <Skeleton variant="chip" width={64} height={20} />
          <Skeleton variant="circle" width={26} height={26} />
        </div>
      </div>
    </div>
  );
}

/** §24 table placeholder: header plus N rows. */
export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="kgm-skel-table" aria-hidden="true">
      <div className="kgm-skel-table__head">
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={i} variant="chip" height={10} width={i === 0 ? 140 : 84} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div className="kgm-skel-table__row" key={r}>
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} variant="text" height={12} width={c === 0 ? '70%' : `${48 + ((r * 7 + c * 13) % 40)}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A full-page loading state with a branded message rather than a bare spinner. */
export function PageSkeleton({
  title,
  hint,
  children,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="kgm-page-skel">
      {(title || hint) && (
        <header className="kgm-page-skel__head">
          {title ? <Skeleton variant="title" width={220} height={22} /> : null}
          {hint ? <Skeleton variant="text" width={160} height={11} /> : null}
        </header>
      )}
      {children}
    </div>
  );
}
