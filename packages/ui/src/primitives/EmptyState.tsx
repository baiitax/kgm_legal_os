/**
 * EMPTY & ERROR STATES · §46
 *
 * §46 lists empty states and error states among the places the logo appears, which
 * is a branding instruction with a UX consequence: an empty screen that carries the
 * mark reads as "nothing here yet" rather than "this failed to load". That
 * distinction is the whole job of this component.
 *
 * THREE STATES THAT MUST NOT LOOK ALIKE
 *
 *   empty      Nothing matches. Normal. Offer the next action.
 *   denied     Something may exist and you may not see it (§57, §27). This must
 *              NOT say "no results" — a paralegal told a restricted matter does
 *              not exist learns the wrong thing about the firm's data, and a
 *              paralegal told it is restricted learns that it exists. The 404
 *              discipline the API enforces has to survive into the copy.
 *   error      The request failed. Say so, and offer a retry.
 *
 * Conflating denied with empty is a disclosure bug rendered in pixels. The API
 * returns 404 for both "not yours" and "not real"; the UI is the only layer that
 * can tell the member which situation they are likely in, and it does that with
 * neutral wording rather than by guessing.
 */
import type { ReactNode } from 'react';
import { LogoMark } from '../brand/Logo.js';
import { Button } from './Button.js';

export type EmptyStateKind = 'empty' | 'denied' | 'error' | 'loading' | 'offline';

export interface EmptyStateProps {
  kind?: EmptyStateKind;
  title: ReactNode;
  description?: ReactNode;
  /** Primary next action. Omit for `denied` — there is usually nothing to do. */
  action?: { label: ReactNode; onClick: () => void };
  secondaryAction?: { label: ReactNode; onClick: () => void };
  /** Overrides the logo mark with a contextual icon. */
  icon?: ReactNode;
  /** Shows the brand mark. On by default per §46. */
  branded?: boolean;
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  kind = 'empty',
  title,
  description,
  action,
  secondaryAction,
  icon,
  branded = true,
  compact = false,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={[
        'kgm-empty',
        `kgm-empty--${kind}`,
        compact ? 'kgm-empty--compact' : '',
        className,
      ].filter(Boolean).join(' ')}
      // `error` is a status change the user needs told about; `empty` is not.
      role={kind === 'error' || kind === 'offline' ? 'alert' : undefined}
    >
      <div className="kgm-empty__mark" aria-hidden="true">
        {icon ?? (branded ? <LogoMark size={compact ? 'sm' : 'lg'} bare={!compact} /> : null)}
      </div>

      <h3 className={`kgm-empty__title ${compact ? 't-section' : 't-h3'}`}>{title}</h3>

      {description ? (
        <p className={`kgm-empty__desc ${compact ? 't-meta' : 't-caption'} c-secondary`}>
          {description}
        </p>
      ) : null}

      {action || secondaryAction ? (
        <div className="kgm-empty__actions">
          {action ? (
            <Button variant="primary" size={compact ? 'sm' : 'md'} onClick={action.onClick}>
              {action.label}
            </Button>
          ) : null}
          {secondaryAction ? (
            <Button variant="ghost" size={compact ? 'sm' : 'md'} onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
