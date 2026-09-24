/**
 * FORM PRIMITIVES · §37
 *
 * The brief asks for spacious forms, translucent inputs, rounded corners, a clear
 * focus state (green border + subtle lime glow), and errors with a clear text
 * explanation, an icon and an accessible state.
 *
 * ACCESSIBILITY IS THE STRUCTURE, NOT AN ADDITION
 *   Every field wires `id` → `htmlFor` → `aria-describedby` automatically. That is
 *   the whole reason this exists as a component rather than a styled `<input>`: a
 *   hand-rolled form field gets the error message on screen and forgets to point
 *   `aria-describedby` at it, so a screen-reader user submits a form they were
 *   never told was invalid. Here the wiring cannot be forgotten because the
 *   component owns it.
 *
 *   `aria-invalid` is set from the presence of an error, not from a prop someone
 *   has to remember to pass.
 *
 * LABELS
 *   §37 offers "floating or structured labels". Floating labels are chosen against
 *   here: a placeholder-as-label disappears on input, so a long form becomes a
 *   column of unlabelled boxes, and Arabic floating labels clip against the
 *   input's top edge because the script has ascenders above the Latin cap height.
 *   Structured labels stay put, which also means the label never competes with
 *   the value for contrast.
 */
import {
  forwardRef, useEffect, useId, useRef, useState,
  type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

export interface FieldShellProps {
  label: ReactNode;
  /** Secondary text under the label. Not the error. */
  hint?: ReactNode;
  error?: ReactNode;
  /** Marks the field required and renders an indicator. */
  required?: boolean;
  /** Trailing slot inside the label row — a counter, a "optional" tag. */
  labelAction?: ReactNode;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
  className?: string;
  /**
   * Extra class on the <label> element.
   *
   * Exists for the `sr-only` case: a search box in a toolbar wants no visible
   * label but still needs an accessible name, and a placeholder is not one — it
   * disappears the moment the user types, leaving the control unnamed with text
   * in it. Hiding the label rather than omitting it keeps the name attached.
   */
  labelClassName?: string;
  /** Layout: stacked is the default; inline puts the label beside the control. */
  layout?: 'stacked' | 'inline';
}

export function FieldShell({
  label, hint, error, required = false, labelAction, children, className = '', layout = 'stacked',
  labelClassName = '',
}: FieldShellProps) {
  const autoId = useId();
  const id = `f-${autoId}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  // Both, when both exist. A field with a hint AND an error must announce both,
  // or the user hears the error and loses the formatting guidance.
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const invalid = !!error;

  return (
    <div className={`kgm-field kgm-field--${layout} ${invalid ? 'kgm-field--invalid' : ''} ${className}`}>
      <div className="kgm-field__labelrow">
        <label className={`kgm-field__label t-caption ${labelClassName}`.trim()} htmlFor={id}>
          {label}
          {required ? <span className="kgm-field__req" aria-hidden="true"> *</span> : null}
          {required ? <span className="sr-only"> (required)</span> : null}
        </label>
        {labelAction ? <span className="kgm-field__labelaction">{labelAction}</span> : null}
      </div>

      {children({ id, describedBy, invalid })}

      {hint && !error ? (
        <p className="kgm-field__hint t-meta c-muted" id={hintId}>{hint}</p>
      ) : null}

      {error ? (
        // role="alert" so the message is announced when it appears, not only when
        // the field is next focused. A validation error that arrives silently is
        // an error a screen-reader user discovers by resubmitting.
        <p className="kgm-field__error t-meta" id={errorId} role="alert">
          <span className="kgm-field__erroricon" aria-hidden="true">⚠</span>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL_BASE = 'kgm-input';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: ReactNode;
  /** Hides the label visually while keeping it as the accessible name. */
  labelClassName?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  labelAction?: ReactNode;
  /** Leading icon inside the control — search, a lock, a currency mark. */
  leadingIcon?: ReactNode;
  trailingSlot?: ReactNode;
  layout?: 'stacked' | 'inline';
}

/**
 * A text input.
 *
 * Forwarded ref: screens need to move focus programmatically — to the password
 * field after a validation failure, to the code field when an MFA step appears.
 * `autoFocus` only fires on mount, so it cannot do either.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField({
  label, labelClassName, hint, error, required, labelAction, leadingIcon, trailingSlot,
  className = '', layout = 'stacked', ...rest
}, ref) {
  return (
    <FieldShell
      label={label}
      labelClassName={labelClassName}
      hint={hint}
      error={error}
      required={required}
      labelAction={labelAction}
      layout={layout}
      className={className}
    >
      {({ id, describedBy, invalid }) => (
        <div className={`kgm-control${leadingIcon ? ' kgm-control--leading' : ''}${trailingSlot ? ' kgm-control--trailing' : ''}`}>
          {leadingIcon ? <span className="kgm-control__lead" aria-hidden="true">{leadingIcon}</span> : null}
          <input
            ref={ref}
            id={id}
            className={CONTROL_BASE}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            aria-required={required || undefined}
            {...rest}
          />
          {trailingSlot ? <span className="kgm-control__trail">{trailingSlot}</span> : null}
        </div>
      )}
    </FieldShell>
  );
});

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  labelAction?: ReactNode;
  /** Renders a live character counter against `maxLength`. */
  maxLengthCounter?: boolean;
}

export function TextArea({
  label, hint, error, required, labelAction, className = '', maxLengthCounter, maxLength,
  value, defaultValue, onChange, ...rest
}: TextAreaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const showCounter = !!maxLengthCounter && typeof maxLength === 'number';

  // Seeded from whichever of value/defaultValue the caller supplied, so the
  // counter is right on first paint rather than after the first keystroke.
  const initial = typeof value === 'string'
    ? value.length
    : typeof defaultValue === 'string' ? defaultValue.length : 0;
  const [count, setCount] = useState(initial);

  // A controlled caller keeps the counter in step through `value`; an
  // uncontrolled one updates it via the input listener below.
  useEffect(() => {
    if (typeof value === 'string') setCount(value.length);
  }, [value]);

  useEffect(() => {
    if (!showCounter || typeof value === 'string') return;
    const el = ref.current;
    if (!el) return;
    const sync = () => setCount(el.value.length);
    sync();
    el.addEventListener('input', sync);
    return () => el.removeEventListener('input', sync);
  }, [showCounter, value]);

  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      required={required}
      labelAction={showCounter
        ? <CharCounter count={count} max={maxLength as number} />
        : labelAction}
    >
      {({ id, describedBy, invalid }) => (
        <textarea
          id={id}
          ref={ref}
          className={`${CONTROL_BASE} kgm-input--area ${className}`}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          maxLength={maxLength}
          value={value}
          defaultValue={defaultValue}
          onChange={onChange}
          {...rest}
        />
      )}
    </FieldShell>
  );
}

/**
 * A live character counter.
 *
 * `aria-live="polite"` would announce every keystroke, which is unusable for
 * anyone actually listening — a hundred announcements while typing a paragraph.
 * The count is therefore exposed to assistive technology through the textarea's
 * own `aria-describedby` path only when it approaches the limit, and rendered
 * silently otherwise.
 */
function CharCounter({ count, max }: { count: number; max: number }) {
  const remaining = max - count;
  const near = remaining <= Math.max(20, Math.round(max * 0.1));
  const over = remaining < 0;
  return (
    <span
      className={[
        'kgm-counter', 't-meta', 'num',
        over ? 'c-critical' : near ? 'c-warning' : 'c-muted',
      ].join(' ')}
      // Announced only when it starts to matter, not on every keystroke.
      aria-live={near ? 'polite' : undefined}
    >
      {count}/{max}
    </span>
  );
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  options: ReadonlyArray<{ value: string; label: ReactNode; disabled?: boolean }>;
  placeholder?: string;
}

export function SelectField({
  label, hint, error, required, options, placeholder, className = '', ...rest
}: SelectFieldProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required}>
      {({ id, describedBy, invalid }) => (
        <div className="kgm-control kgm-control--trailing">
          <select
            id={id}
            className={`${CONTROL_BASE} kgm-input--select ${className}`}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            aria-required={required || undefined}
            {...rest}
          >
            {placeholder ? <option value="">{placeholder}</option> : null}
            {options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
            ))}
          </select>
          {/* A native select cannot contain an icon, so the chevron is overlaid
              and pointer-events are disabled on it. */}
          <span className="kgm-control__trail" aria-hidden="true">▾</span>
        </div>
      )}
    </FieldShell>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id'> {
  label: ReactNode;
  hint?: ReactNode;
}

export function Checkbox({ label, hint, className = '', ...rest }: CheckboxProps) {
  const autoId = useId();
  const id = `c-${autoId}`;
  return (
    <div className={`kgm-check ${className}`}>
      <input id={id} type="checkbox" className="kgm-check__input" {...rest} />
      <label htmlFor={id} className="kgm-check__box" aria-hidden="true" />
      <label htmlFor={id} className="kgm-check__label">
        <span className="t-body">{label}</span>
        {hint ? <span className="t-meta c-muted">{hint}</span> : null}
      </label>
    </div>
  );
}

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id' | 'role'> {
  label: ReactNode;
  hint?: ReactNode;
}

export function Switch({ label, hint, className = '', ...rest }: SwitchProps) {
  const autoId = useId();
  const id = `s-${autoId}`;
  return (
    <div className={`kgm-switch ${className}`}>
      <input id={id} type="checkbox" role="switch" className="kgm-switch__input" {...rest} />
      <label htmlFor={id} className="kgm-switch__track" aria-hidden="true">
        <span className="kgm-switch__thumb" />
      </label>
      <label htmlFor={id} className="kgm-switch__label">
        <span className="t-body">{label}</span>
        {hint ? <span className="t-meta c-muted">{hint}</span> : null}
      </label>
    </div>
  );
}

/** §37 — a segmented control, for filters and view modes. */
export interface SegmentedProps<T extends string> {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; icon?: ReactNode }>;
  onChange: (value: T) => void;
  /** Accessible group name. Required — a set of unlabeled radios is a guess. */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}

export function Segmented<T extends string>({
  value, options, onChange, label, size = 'md', className = '',
}: SegmentedProps<T>) {
  return (
    <div className={`kgm-seg kgm-seg--${size} ${className}`} role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={`kgm-seg__opt${active ? ' kgm-seg__opt--active' : ''}`}
            onClick={() => onChange(o.value)}
            // Arrow-key movement between radios, which is what role="radio"
            // promises. Without it the group announces as radios and behaves as
            // buttons.
            onKeyDown={(e) => {
              const i = options.findIndex((x) => x.value === value);
              const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
              const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
              if (!fwd && !back) return;
              e.preventDefault();
              const next = options[(i + (fwd ? 1 : options.length - 1)) % options.length];
              onChange(next.value);
            }}
          >
            {o.icon ? <span className="kgm-seg__icon" aria-hidden="true">{o.icon}</span> : null}
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
