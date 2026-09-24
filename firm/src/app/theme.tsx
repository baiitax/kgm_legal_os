/**
 * THEME · §41, §05, §06
 *
 * Dark / Light / System, persisted. §41 requires that every component be tested
 * in both modes; the mechanism that makes that tractable is that NO component
 * knows which mode is active. They read tokens, and this file decides which token
 * sheet is in force.
 *
 * `system` is a real third option rather than a default, and it listens to the
 * media query: an operator whose OS switches to dark at sunset should see the app
 * follow without a reload. §06 makes dark the premium default, so a browser with
 * no preference resolves to dark.
 *
 * THE FLASH PROBLEM
 *   A theme applied in a React effect paints dark, then light, then dark again for
 *   a light-mode user — a visible flash on every load. The initial value is
 *   therefore read synchronously during the first render AND an inline script in
 *   index.html sets `data-theme` before first paint. This provider then owns it
 *   from there. Without that pairing the preloader (§32) would appear in the wrong
 *   theme for a frame.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';

export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'kgm.firm.theme';

interface ThemeValue {
  readonly mode: ThemeMode;
  /** The theme actually in force, after resolving `system`. */
  readonly resolved: ResolvedTheme;
  readonly isSystem: boolean;
  setMode(mode: ThemeMode): void;
  /** Cycles dark → light → system. Used by the topbar's single control. */
  cycle(): void;
}

const Ctx = createContext<ThemeValue | null>(null);

function readStored(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'dark' || raw === 'light' || raw === 'system') return raw;
  } catch { /* unavailable; fall through to the default */ }
  // §06: dark is the premium default.
  return 'dark';
}

function writeStored(mode: ThemeMode): void {
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* non-fatal */ }
}

function systemPrefersLight(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: light)').matches;
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  return systemPrefersLight() ? 'light' : 'dark';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStored());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readStored()));

  // Apply to the document element, not a wrapper: fixed-position overlays
  // (modals, toasts, the bottom nav) live outside any app wrapper and would
  // otherwise keep the wrong tokens.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#041915' : '#f4f7f5');
  }, [resolved]);

  // Follow OS changes while in `system` mode.
  useEffect(() => {
    if (mode !== 'system' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setResolved(mq.matches ? 'light' : 'dark');
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    setResolved(resolve(next));
    writeStored(next);
  }, []);

  const cycle = useCallback(() => {
    const order: ThemeMode[] = ['dark', 'light', 'system'];
    setMode(order[(order.indexOf(mode) + 1) % order.length]);
  }, [mode, setMode]);

  const value = useMemo<ThemeValue>(
    () => ({ mode, resolved, isSystem: mode === 'system', setMode, cycle }),
    [mode, resolved, setMode, cycle],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme() must be used inside <ThemeProvider>');
  return ctx;
}
