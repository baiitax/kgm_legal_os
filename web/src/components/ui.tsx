/**
 * Shared UI primitives.
 *
 * Every icon is an inline SVG: the CSP allows `script-src 'self'` and
 * `img-src 'self' data: blob:`, so there is no icon font, no CDN and no
 * third-party script anywhere in this bundle.
 *
 * Components are written against logical properties and `currentColor`, so they
 * inherit direction and theme without any conditional styling.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ApiError } from '../api/client';
import { hasMessage, useI18n, type MessageKey } from '../i18n';

/* ------------------------------------------------------------------ icons -- */
export type IconName =
  | 'home' | 'folder' | 'gavel' | 'clock' | 'doc' | 'invoice' | 'chat'
  | 'calendar' | 'bell' | 'shield' | 'user' | 'lock' | 'logout' | 'download'
  | 'upload' | 'plus' | 'check' | 'close' | 'alert' | 'info' | 'chevron'
  | 'globe' | 'money' | 'receipt' | 'eye' | 'search' | 'print' | 'refresh'
  | 'scale' | 'building' | 'phone' | 'video' | 'pin' | 'key' | 'device'
  | 'mail' | 'back' | 'send' | 'copy' | 'trash' | 'external' | 'link'
  | 'history' | 'filter' | 'edit' | 'star' | 'flag' | 'layers' | 'archive';

const PATHS: Record<IconName, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  gavel: <><path d="m14 4 6 6-3 3-6-6z" /><path d="m9 9 6 6-4 4a3 3 0 0 1-4-4z" /><path d="M3 21h9" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  doc: <><path d="M6 2h8l4 4v16H6z" /><path d="M14 2v4h4" /><path d="M9 12h6M9 16h6" /></>,
  invoice: <><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
  chat: <path d="M4 4h16v12H8l-4 4z" />,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></>,
  bell: <><path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
  shield: <path d="M12 2 4 5v7c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V5z" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  logout: <><path d="M15 3h4a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-4" /><path d="M10 17l-5-5 5-5M5 12h11" /></>,
  download: <><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M4 21h16" /></>,
  upload: <><path d="M12 21V9" /><path d="m7 13 5-5 5 5" /><path d="M4 3h16" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m4 12 6 6L20 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  alert: <><path d="M12 3 2 20h20z" /><path d="M12 9v5M12 17.5v.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14 0 18-3-4-3-14.5 0-18" /></>,
  money: <><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="3" /></>,
  receipt: <><path d="M6 2h12v20l-2.5-1.5L13 22l-2.5-1.5L8 22l-2-1.5z" /><path d="M9 7h6M9 11h6M9 15h4" /></>,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12" /><circle cx="12" cy="12" r="3" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  print: <><path d="M7 9V3h10v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M7 15h10v6H7z" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v5h-5" /></>,
  scale: <><path d="M12 3v18M7 21h10" /><path d="M4 8h16" /><path d="M4 8 1.5 14h5zM20 8l-2.5 6h5z" /></>,
  building: <><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2" /></>,
  phone: <path d="M5 3h4l2 5-3 2a12 12 0 0 0 6 6l2-3 5 2v4a1 1 0 0 1-1 1A17 17 0 0 1 4 4a1 1 0 0 1 1-1" />,
  video: <><rect x="2" y="6" width="13" height="12" rx="2" /><path d="m15 11 7-4v10l-7-4z" /></>,
  pin: <><path d="M12 22s7-6.3 7-12A7 7 0 0 0 5 10c0 5.7 7 12 7 12" /><circle cx="12" cy="10" r="2.5" /></>,
  key: <><circle cx="8" cy="14" r="4" /><path d="m11 11 8-8 2 2-2 2 2 2-3 3-2-2-2 2" /></>,
  device: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
  // "back" is drawn pointing left; the RTL stylesheet mirrors it, so the same
  // glyph reads correctly in both directions.
  back: <path d="M19 12H5m0 0 6-6m-6 6 6 6" />,
  send: <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14" /><path d="M10 11v6M14 11v6" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 14v6H4V6h6" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>,
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
  edit: <><path d="M4 20h4L20 8l-4-4L4 16z" /><path d="m14 6 4 4" /></>,
  star: <path d="m12 3 2.9 6 6.1.9-4.5 4.3 1.1 6.3L12 17.8 6.4 20.5l1.1-6.3L3 9.9 9.1 9z" />,
  flag: <><path d="M5 21V4" /><path d="M5 5h11l-2 3.5L16 12H5z" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>,
  archive: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v12h14V8" /><path d="M10 12h4" /></>,
};

export function Icon({
  name,
  size = 20,
  className,
  filled = false,
}: {
  name: IconName;
  size?: number;
  className?: string;
  filled?: boolean;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/* ------------------------------------------------------------------ card -- */
export function Card({
  title,
  hint,
  actions,
  children,
  footer,
  tight,
  as = 'section',
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  tight?: boolean;
  as?: 'section' | 'div' | 'aside';
}) {
  const Tag = as;
  return (
    <Tag className="card">
      {(title || actions) && (
        <header className="card__head">
          {title && <h2>{title}</h2>}
          {hint && <span className="card__head__hint">{hint}</span>}
          {actions && <div className="row" style={{ gap: 8 }}>{actions}</div>}
        </header>
      )}
      <div className={tight ? 'card__body card__body--tight' : 'card__body'}>{children}</div>
      {footer && <div className="card__foot">{footer}</div>}
    </Tag>
  );
}

/* ---------------------------------------------------------------- button -- */
type Variant = 'primary' | 'gold' | 'danger' | 'ghost' | 'default';

export function Button({
  variant = 'default',
  size,
  icon,
  loading,
  block,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm';
  icon?: IconName;
  loading?: boolean;
  block?: boolean;
}) {
  const cls = ['btn'];
  if (variant !== 'default') cls.push(`btn--${variant}`);
  if (size) cls.push(`btn--${size}`);
  if (block) cls.push('btn--block');
  return (
    <button className={cls.join(' ')} disabled={disabled || loading} {...rest}>
      {loading ? <span className="btn__spin" aria-hidden="true" /> : icon && <Icon name={icon} size={size ? 15 : 17} />}
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------- badge -- */
export type Tone = 'default' | 'ok' | 'warn' | 'danger' | 'info' | 'gold' | 'muted';

export function Badge({ tone = 'default', children, plain }: { tone?: Tone; children: ReactNode; plain?: boolean }) {
  const cls = ['badge'];
  if (tone !== 'default') cls.push(`badge--${tone}`);
  if (plain) cls.push('badge--plain');
  return <span className={cls.join(' ')}>{children}</span>;
}

/** Maps a server-supplied status string to a tone. Unknown values stay neutral. */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'paid':
    case 'done':
    case 'confirmed':
    case 'completed':
    case 'clean':
    case 'available':
      return 'ok';
    case 'overdue':
    case 'critical':
    case 'urgent':
    case 'cancelled':
      return 'danger';
    case 'awaiting_payment':
    case 'partially_paid':
    case 'requested':
    case 'pending_confirmation':
    case 'action_required':
    case 'high':
    case 'open':
      return 'warn';
    case 'hearings':
    case 'judgment':
    case 'execution':
    case 'under_review':
    case 'awaiting_client':
    case 'awaiting_firm':
    case 'security':
    case 'medium':
      return 'info';
    default:
      return 'muted';
  }
}

/**
 * Renders a status through the dictionary when a translation exists, and as
 * readable text otherwise — so a status the server adds tomorrow degrades to
 * "under review"-style prose instead of a bare key or an empty pill.
 * `plain` drops the pill, for filter chips that supply their own background.
 */
export function StatusBadge({
  status,
  prefix,
  tone,
  plain,
}: {
  status: string;
  prefix?: string;
  tone?: Tone;
  plain?: boolean;
}) {
  const { t } = useI18n();
  const key = `${prefix ?? 'status'}.${status}`;
  const label = hasMessage(key) ? t(key) : status.replace(/_/g, ' ');
  return (
    <Badge tone={tone ?? statusTone(status)} plain={plain}>
      {label}
    </Badge>
  );
}

/* ----------------------------------------------------------------- alert -- */
export function Alert({
  tone = 'info',
  title,
  children,
  icon,
}: {
  tone?: 'error' | 'ok' | 'info' | 'warn';
  title?: ReactNode;
  children?: ReactNode;
  icon?: IconName;
}) {
  const glyph: IconName = icon ?? (tone === 'error' ? 'alert' : tone === 'ok' ? 'check' : tone === 'warn' ? 'alert' : 'info');
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={glyph} size={18} />
      <div className="alert__body">
        {title && <div className="alert__title">{title}</div>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

/**
 * The single place an API failure becomes text. The server's `code` is mapped
 * through the dictionary; the server's message is never rendered verbatim, so a
 * change in wording server-side cannot leak internals into the UI.
 */
export function ErrorAlert({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, errorText, errorTitle } = useI18n();
  if (!error) return null;

  const api = error instanceof ApiError ? error : null;
  const code = api?.code ?? 'network_error';
  const details = api?.details as { retryAfterSeconds?: number; failures?: string[] } | undefined;

  // The heading comes from the code too: a refused sign-in is headed
  // "Sign-in failed", not "The request could not be completed", which would
  // describe a fault where there is none.
  return (
    <Alert tone="error" title={errorTitle(code)}>
      <div>{errorText(code)}</div>
      {typeof details?.retryAfterSeconds === 'number' && (
        <div className="small">{t('err.lockedRetry', { n: details.retryAfterSeconds })}</div>
      )}
      {Array.isArray(details?.failures) && details!.failures!.length > 0 && (
        <ul className="requirements" style={{ marginBlockStart: 6 }}>
          {details!.failures!.map((f) => (
            <li key={f}>• {f}</li>
          ))}
        </ul>
      )}
      {api?.requestId && (
        <div className="small faint" style={{ marginBlockStart: 6 }}>
          {t('common.requestId')}: <span className="mono">{api.requestId}</span>
        </div>
      )}
      {onRetry && (
        <div style={{ marginBlockStart: 10 }}>
          <Button size="sm" icon="refresh" onClick={onRetry}>{t('common.retry')}</Button>
        </div>
      )}
    </Alert>
  );
}

/* ------------------------------------------------------------------ form -- */
export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field__label">{label}</span>
      {children}
      {error ? (
        <span className="field__hint" style={{ color: 'var(--danger)' }}>{error}</span>
      ) : hint ? (
        <span className="field__hint">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * Form controls forward their refs: several screens need to move focus
 * imperatively (into the code field when the second factor appears, into the
 * reply box when a thread opens) without resorting to `document.getElementById`.
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ invalid, ...rest }, ref) {
    return <input ref={ref} className={invalid ? 'input input--invalid' : 'input'} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select(props, ref) {
    return <select ref={ref} className="select" {...props} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea(props, ref) {
    return <textarea ref={ref} className="textarea" {...props} />;
  },
);

export function Check({
  label,
  hint,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" {...rest} />
      <span>
        <span>{label}</span>
        {hint && <span className="field__hint">{hint}</span>}
      </span>
    </label>
  );
}

/* ------------------------------------------------------- password strength -- */
export interface StrengthResult {
  score: 0 | 1 | 2 | 3 | 4 | 5;
  ok: boolean;
  failures: string[];
}

/**
 * Client-side strength feedback only. The server re-runs the same assessment
 * against scrypt-derived rules and refuses a weak password regardless of what
 * this component says — the meter is a convenience, never a gate.
 */
export function assessPassword(
  value: string,
  opts: { minLength?: number; disallow?: string[] } = {},
): StrengthResult {
  const minLength = opts.minLength ?? 12;
  const disallow = (opts.disallow ?? []).map((d) => d.toLowerCase()).filter(Boolean);
  const lower = value.toLowerCase();

  const checks: Array<[boolean, MessageKey]> = [
    [value.length >= minLength, 'pw.minLength'],
    [/[A-Z]/.test(value), 'pw.upper'],
    [/[a-z]/.test(value), 'pw.lower'],
    [/\d/.test(value), 'pw.digit'],
    [/[^\w\s]/.test(value), 'pw.symbol'],
  ];
  const failures = checks.filter(([ok]) => !ok).map(([, key]) => key as unknown as string);

  const COMMON = ['password', 'qwerty', '123456', 'letmein', 'welcome', 'admin', 'iloveyou', 'password1'];
  const isCommon = COMMON.some((c) => lower.includes(c));
  const isPersonal = disallow.some((d) => d.length > 2 && lower.includes(d));
  if (isCommon) failures.push('pw.notCommon');
  if (isPersonal) failures.push('pw.notPersonal');

  const passed = checks.filter(([ok]) => ok).length;
  let score = passed as 0 | 1 | 2 | 3 | 4 | 5;
  if (isCommon || isPersonal) score = Math.min(score, 1) as 0 | 1;
  if (value.length >= 16 && passed === 5 && !isCommon && !isPersonal) score = 5;

  return { score: score as 0 | 1 | 2 | 3 | 4 | 5, ok: failures.length === 0, failures };
}

export function PasswordStrength({ value, minLength, disallow }: { value: string; minLength?: number; disallow?: string[] }) {
  const { t } = useI18n();
  const result = assessPassword(value, { minLength, disallow });
  const checks: Array<[boolean, MessageKey]> = [
    [value.length >= (minLength ?? 12), 'pw.minLength'],
    [/[A-Z]/.test(value), 'pw.upper'],
    [/[a-z]/.test(value), 'pw.lower'],
    [/\d/.test(value), 'pw.digit'],
    [/[^\w\s]/.test(value), 'pw.symbol'],
    [!result.failures.includes('pw.notCommon'), 'pw.notCommon'],
    [!result.failures.includes('pw.notPersonal'), 'pw.notPersonal'],
  ];

  return (
    <div>
      <div className="meter" role="img" aria-label={`${t('pw.strength')}: ${t(`pw.score.${result.score}` as MessageKey)}`}>
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={i <= result.score ? 'meter__seg meter__seg--on' : 'meter__seg'}
            data-level={i}
          />
        ))}
      </div>
      <div className="small muted" style={{ marginBlockStart: 4 }}>
        {t('pw.strength')}: <b>{t(`pw.score.${result.score}` as MessageKey)}</b>
      </div>
      <ul className="requirements">
        {checks.map(([ok, key]) => (
          <li key={key} data-met={ok}>
            <Icon name={ok ? 'check' : 'close'} size={13} />
            {t(key)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ misc -- */
export function Empty({ icon = 'info', title, children }: { icon?: IconName; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__icon"><Icon name={icon} size={22} /></div>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {children && <div className="small muted" style={{ marginBlockStart: 6 }}>{children}</div>}
    </div>
  );
}

export function PageLoader() {
  const { t } = useI18n();
  return (
    <div className="spinner-page">
      <div className="spinner" />
      <span className="small muted">{t('common.loading')}</span>
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'money' | 'alert';
}) {
  const cls = ['stat'];
  if (tone) cls.push(`stat--${tone}`);
  return (
    <div className={cls.join(' ')}>
      <span className="stat__label">{label}</span>
      <div className="stat__value">{value}</div>
      {sub && <div className="stat__sub">{sub}</div>}
    </div>
  );
}

export function KeyValue({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="kv">
      {items.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Escape closes, and focus is trapped inside while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const nodes = ref.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
        );
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal__head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('a11y.close')}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- useAsync -- */
interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch-on-mount with abort-on-unmount and an explicit reload.
 *
 * A 401 does not need local handling: the API client notifies the auth provider,
 * which redirects to sign-in. Every other failure is surfaced to the caller so
 * the page can render a retry rather than a blank screen.
 */
export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setLoading(true);
    loaderRef.current(controller.signal)
      .then((result) => {
        if (!alive) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (!alive || err?.name === 'AbortError') return;
        setError(err);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

/** Copy-to-clipboard with a transient "copied" state, for secrets and codes. */
export function useCopied(timeout = 1600) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), timeout);
    } catch {
      setCopied(false);
    }
  }, [timeout]);
  return { copied, copy };
}
