/**
 * CARD · §20 metric cards · §21 matter cards · §03 glass
 *
 * One glass surface, several intents. The variants exist because §03 asks for
 * "cards that float slightly above the background" while §29 asks finance to be
 * "more precise and less decorative" — those are different surfaces, and a single
 * card style cannot satisfy both.
 *
 *   default    glass, subtle border, 2px hover lift
 *   metric     §20 — icon, large figure, trend. Emphasizes the NUMBER
 *   executive  gold-accented, for high-value indicators (§20: "Saudi Gold may be
 *              used for high-value executive indicators")
 *   solid      opaque, for finance and compliance where decoration costs clarity
 *   document   white even in dark mode (§27 — the legal editor canvas)
 */
import type { CSSProperties, ElementType, ReactNode } from 'react';

export type CardVariant = 'default' | 'metric' | 'executive' | 'solid' | 'document' | 'interactive';

export interface CardProps {
  variant?: CardVariant;
  /** Adds the top-edge highlight (§03 "soft highlights"). */
  sheen?: boolean;
  /** Adds the 2px hover lift and border brightening (§45). */
  interactive?: boolean;
  /** Gold accent treatment for executive metrics (§20). */
  accent?: 'none' | 'gold' | 'lime' | 'brand';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  /** Render as another element — a `button` or `article` where semantics need it. */
  as?: ElementType;
  onClick?: () => void;
}

export function Card({
  variant = 'default',
  sheen = false,
  interactive = false,
  accent = 'none',
  padding = 'md',
  className = '',
  style,
  children,
  as,
  onClick,
}: CardProps) {
  const Tag = (as ?? (onClick ? 'button' : 'div')) as ElementType;
  const classes = [
    'kgm-card',
    `kgm-card--${variant}`,
    `kgm-card--pad-${padding}`,
    sheen ? 'glass-sheen' : '',
    interactive || onClick ? 'lift' : '',
    accent !== 'none' ? `kgm-card--accent-${accent}` : '',
    onClick ? 'kgm-card--clickable' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <Tag
      className={classes}
      style={style}
      onClick={onClick}
      // A clickable card is a control and must be reachable and labelled like one.
      type={Tag === 'button' ? 'button' : undefined}
    >
      {children}
    </Tag>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  /** Secondary line under the title — a matter number, a client name. */
  subtitle?: ReactNode;
  /** Right-hand (inline-end) slot: an icon, a badge, a menu. */
  action?: ReactNode;
  /** Leading icon in a tinted well (§20's "small icon"). */
  icon?: ReactNode;
  className?: string;
}

export function CardHeader({ title, subtitle, action, icon, className = '' }: CardHeaderProps) {
  return (
    <div className={`kgm-card__head ${className}`}>
      {icon ? <span className="kgm-card__icon">{icon}</span> : null}
      <div className="kgm-card__headtext">
        <div className="kgm-card__title t-section">{title}</div>
        {subtitle ? <div className="kgm-card__subtitle t-meta c-muted">{subtitle}</div> : null}
      </div>
      {action ? <div className="kgm-card__action">{action}</div> : null}
    </div>
  );
}

export function CardBody({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`kgm-card__body ${className}`}>{children}</div>;
}

export function CardFooter({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`kgm-card__foot ${className}`}>{children}</div>;
}

/* ==========================================================================
   §20 · METRIC CARD
   icon + large number + trend. The figure is the loudest element on the card.
   ========================================================================== */

export type TrendDirection = 'up' | 'down' | 'flat';

export interface MetricCardProps {
  label: ReactNode;
  value: ReactNode;
  /** Small unit rendered beside the figure — "SAR", "%", a count noun. */
  unit?: ReactNode;
  icon?: ReactNode;
  trend?: { direction: TrendDirection; label: ReactNode };
  /** §20: gold for high-value executive indicators. Use sparingly. */
  executive?: boolean;
  /** A footnote under the trend, e.g. "as of 15 Oct". */
  note?: ReactNode;
  /** Renders a subtle progress bar under the figure, for utilization/aging. */
  progress?: number;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  /** Animation delay index for the grid stagger (§34). */
  index?: number;
}

export function MetricCard({
  label, value, unit, icon, trend, executive = false, note, progress,
  className = '', style, onClick, index,
}: MetricCardProps) {
  const stagger = index !== undefined ? { ...style, '--i': index } as CSSProperties : style;
  return (
    <Card
      variant={executive ? 'executive' : 'metric'}
      sheen
      interactive={!!onClick}
      accent={executive ? 'gold' : 'none'}
      padding="md"
      className={`stagger-enter ${className}`}
      style={stagger}
      onClick={onClick}
      as={onClick ? 'button' : 'div'}
    >
      <div className="kgm-metric">
        <div className="kgm-metric__top">
          <span className="kgm-metric__label t-meta u-uppercase c-muted">{label}</span>
          {icon ? <span className="kgm-metric__icon" aria-hidden="true">{icon}</span> : null}
        </div>

        <div className="kgm-metric__figure">
          <span className="kgm-metric__value t-figure num">{value}</span>
          {unit ? <span className="kgm-metric__unit t-caption c-muted">{unit}</span> : null}
        </div>

        {typeof progress === 'number' ? (
          <div
            className="kgm-metric__bar"
            role="progressbar"
            aria-valuenow={Math.round(progress)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={typeof label === 'string' ? label : undefined}
          >
            <span
              className={`kgm-metric__bar-fill${executive ? ' kgm-metric__bar-fill--gold' : ''}`}
              style={{ inlineSize: `${Math.max(0, Math.min(100, progress))}%` }}
            />
          </div>
        ) : null}

        {trend ? (
          <div className={`kgm-metric__trend kgm-metric__trend--${trend.direction}`}>
            {/* §31/§44: direction is carried by an arrow glyph AND by the label
                text, never by colour alone. */}
            <span className="kgm-metric__arrow" aria-hidden="true">
              {trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '→'}
            </span>
            <span className="t-meta num">{trend.label}</span>
          </div>
        ) : null}

        {note ? <div className="kgm-metric__note t-meta c-muted">{note}</div> : null}
      </div>
    </Card>
  );
}
