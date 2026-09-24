/**
 * TOAST · §40
 *
 * "Elegant lightweight notifications. Do not block the screen."
 *
 * The blocking part is a real constraint rather than a style note: a toast that
 * covers a primary action, or that stacks into the middle of the viewport, turns a
 * confirmation into an interruption. These are anchored to a corner, capped at
 * three visible, and never modal.
 *
 * ACCESSIBILITY
 *   Toasts are the classic silent-failure component. A confirmation that appears
 *   and disappears visually tells a screen-reader user nothing, so the region is
 *   `aria-live="polite"` for successes and `assertive` for errors — an error the
 *   user must act on should interrupt, a "matter created" should not.
 *
 *   §31's rule applies here too: tone is carried by an icon and a label, not by
 *   colour alone.
 *
 *   Auto-dismiss is DISABLED for error and critical toasts. A message that
 *   vanishes before it can be read is a message that was never delivered, and for
 *   a failure the user has to act on that is the difference between a retry and a
 *   lost form.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';

export type ToastTone = 'success' | 'info' | 'warning' | 'error' | 'critical';

export interface ToastItem {
  id: string;
  tone: ToastTone;
  title: ReactNode;
  description?: ReactNode;
  /** Milliseconds. 0 or omitted on error/critical means it persists. */
  duration?: number;
  action?: { label: ReactNode; onClick: () => void };
}

export type ToastAnchor =
  | 'top-end' | 'top-start' | 'top-center'
  | 'bottom-end' | 'bottom-start' | 'bottom-center';

interface ToastApi {
  push(toast: Omit<ToastItem, 'id'> & { id?: string }): string;
  success(title: ReactNode, description?: ReactNode, duration?: number): string;
  info(title: ReactNode, description?: ReactNode, duration?: number): string;
  warning(title: ReactNode, description?: ReactNode, duration?: number): string;
  /** Persists until dismissed. */
  error(title: ReactNode, description?: ReactNode): string;
  /** Persists until dismissed. */
  critical(title: ReactNode, description?: ReactNode): string;
  dismiss(id: string): void;
  dismissAll(): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const GLYPH: Record<ToastTone, string> = {
  success: '✓',
  info: 'ⓘ',
  warning: '⚠',
  error: '✕',
  critical: '▲',
};

const DEFAULT_DURATION: Record<ToastTone, number> = {
  success: 3600,
  info: 4200,
  warning: 6000,
  // 0 = persist. See the module note.
  error: 0,
  critical: 0,
};

const MAX_VISIBLE = 3;

let seq = 0;
const nextId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export interface ToastProviderProps {
  anchor?: ToastAnchor;
  children: ReactNode;
}

export function ToastProvider({ anchor = 'bottom-end', children }: ToastProviderProps) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle) { window.clearTimeout(handle); timers.current.delete(id); }
  }, []);

  const dismissAll = useCallback(() => {
    timers.current.forEach((h) => window.clearTimeout(h));
    timers.current.clear();
    setItems([]);
  }, []);

  const push = useCallback((toast: Omit<ToastItem, 'id'> & { id?: string }): string => {
    const id = toast.id ?? nextId();
    const item: ToastItem = { ...toast, id };
    setItems((prev) => {
      const next = [...prev.filter((t) => t.id !== id), item];
      // Oldest first out. Dropping the NEWEST toast would hide the thing the user
      // just did, which is the one they are looking for.
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
    });

    const duration = toast.duration ?? DEFAULT_DURATION[toast.tone];
    if (duration > 0) {
      const handle = window.setTimeout(() => dismiss(id), duration);
      timers.current.set(id, handle);
    }
    return id;
  }, [dismiss]);

  // Clean up pending timers on unmount.
  useEffect(() => () => { timers.current.forEach((h) => window.clearTimeout(h)); }, []);

  const api = useMemo<ToastApi>(() => ({
    push,
    dismiss,
    dismissAll,
    success: (title, description, duration) => push({ tone: 'success', title, description, duration }),
    info: (title, description, duration) => push({ tone: 'info', title, description, duration }),
    warning: (title, description, duration) => push({ tone: 'warning', title, description, duration }),
    error: (title, description) => push({ tone: 'error', title, description, duration: 0 }),
    critical: (title, description) => push({ tone: 'critical', title, description, duration: 0 }),
  }), [push, dismiss, dismissAll]);

  // Errors and successes are announced at different urgency; splitting the live
  // regions means a success cannot be dropped because an error is mid-announcement.
  const urgent = items.filter((t) => t.tone === 'error' || t.tone === 'critical');
  const polite = items.filter((t) => t.tone !== 'error' && t.tone !== 'critical');

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={`kgm-toasts kgm-toasts--${anchor}`}>
        <div className="kgm-toasts__region" role="status" aria-live="polite" aria-atomic="false">
          {polite.map((t) => <ToastRow key={t.id} toast={t} onDismiss={dismiss} />)}
        </div>
        <div className="kgm-toasts__region" role="alert" aria-live="assertive" aria-atomic="false">
          {urgent.map((t) => <ToastRow key={t.id} toast={t} onDismiss={dismiss} />)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastRow({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  return (
    <div className={`kgm-toast kgm-toast--${toast.tone} glass glass-strong`}>
      <span className="kgm-toast__glyph" aria-hidden="true">{GLYPH[toast.tone]}</span>
      <div className="kgm-toast__text">
        <div className="kgm-toast__title t-section">{toast.title}</div>
        {toast.description ? (
          <div className="kgm-toast__desc t-caption c-secondary">{toast.description}</div>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            className="kgm-toast__action t-caption"
            onClick={() => { toast.action?.onClick(); onDismiss(toast.id); }}
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="kgm-toast__close"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}

/** Access the toast API. Throws outside a provider, like useI18n. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast() must be used inside <ToastProvider>');
  return ctx;
}
