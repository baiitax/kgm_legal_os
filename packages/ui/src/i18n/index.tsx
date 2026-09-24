/**
 * i18n RUNTIME · §42
 *
 * This is the MECHANISM: a provider, a lookup hook, direction handling, and the
 * plumbing that keeps `<html dir>` and `<html lang>` in step with the active
 * language. It is shared.
 *
 * The DICTIONARIES are not shared. Each application supplies its own, because
 * the two products do not mean the same things by the same words. A portal user's
 * "matter" is a case they are a party to; a firm member's "matter" is a
 * portfolio item with an access level, a risk rating and a billing arrangement.
 * One dictionary serving both would force one product's vocabulary onto the
 * other, and the first compromise would be a firm-only concept leaking into
 * client-facing copy.
 *
 * §42 REQUIREMENTS THIS MEETS
 *   - Switching language updates DIRECTION, not merely text. `dir` and `lang` are
 *     written to the document element, so every logical property in the design
 *     system flips with it.
 *   - Dates and numbers follow the language through the formatter, which takes
 *     `lang` from this same context. There is one source of truth for both.
 *   - Typography adapts: the token sheet raises body size and leading under
 *     `[dir=rtl]`, because Arabic at Latin body size is cramped.
 *
 * ARABIC IS THE DEFAULT. §"Arabic-first" is not a translation exercise — the
 * Arabic string is the source of truth and English is the peer. `t()` therefore
 * resolves against `ar` first and falls back to `en` only for a genuinely
 * missing key, and a missing key renders visibly rather than silently blank.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import { createFormatter, directionFor, type Calendar, type Direction, type Fmt, type Lang } from '../format/index.js';

/** A flat dictionary. Keys are dotted paths; values are the strings. */
export type Dictionary = Readonly<Record<string, string>>;

export interface I18nBundle {
  readonly ar: Dictionary;
  readonly en: Dictionary;
}

/** Interpolation values. Numbers are formatted with the active locale. */
export type TParams = Readonly<Record<string, string | number>>;

interface I18nValue {
  readonly lang: Lang;
  readonly dir: Direction;
  readonly calendar: Calendar;
  readonly fmt: Fmt;
  /** Translate a key against the active bundle. */
  t(key: string, params?: TParams): string;
  /** The string in a SPECIFIC language, for bilingual display side by side. */
  tin(lang: Lang, key: string, params?: TParams): string;
  /** Localized value with a language-agnostic fallback. Used for name pairs. */
  pick(primary: string | null | undefined, secondary: string | null | undefined): string;
  setLang(lang: Lang): void;
  setCalendar(calendar: Calendar): void;
  setPreference(lang: Lang, calendar: Calendar): void;
  /** True while the bundle has unresolved keys — surfaced in dev only. */
  readonly missing: readonly string[];
}

const I18nContext = createContext<I18nValue | null>(null);

const STORAGE_KEY = 'kgm.firm.i18n';

/** Reads a persisted preference. Malformed storage must not break the app. */
function readStored(): { lang: Lang; calendar: Calendar } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { lang?: string; calendar?: string };
    const lang = parsed.lang === 'en' || parsed.lang === 'ar' ? parsed.lang : null;
    const calendar = parsed.calendar === 'gregory' || parsed.calendar === 'islamic-umalqura'
      ? parsed.calendar : null;
    if (!lang && !calendar) return null;
    return {
      lang: lang ?? 'ar',
      calendar: calendar ?? 'islamic-umalqura',
    };
  } catch {
    return null;
  }
}

function writeStored(lang: Lang, calendar: Calendar): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ lang, calendar }));
  } catch {
    /* Private mode or a full quota. The app still works; the preference simply
       does not survive a reload. Failing loudly here would be worse. */
  }
}

/** Detects the browser's preference on first run. Arabic wins ties (§ Arabic-first). */
function detectInitial(): { lang: Lang; calendar: Calendar } {
  const stored = readStored();
  if (stored) return stored;
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'ar';
  return { lang: nav.toLowerCase().startsWith('ar') ? 'ar' : 'en', calendar: 'islamic-umalqura' };
}

function interpolate(template: string, params: TParams | undefined, fmt: Fmt): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = params[name];
    if (v === undefined) return match;
    return typeof v === 'number' ? fmt.numberLatin(v) : String(v);
  });
}

export interface I18nProviderProps {
  readonly bundle: I18nBundle;
  /** Initial language. Defaults to stored preference, then navigator, then `ar`. */
  readonly initialLang?: Lang;
  readonly initialCalendar?: Calendar;
  /** Writes `dir`/`lang` to <html>. Disable when a parent shell owns the document. */
  readonly manageDocument?: boolean;
  readonly children: ReactNode;
}

export function I18nProvider({
  bundle,
  initialLang,
  initialCalendar,
  manageDocument = true,
  children,
}: I18nProviderProps) {
  const detected = useMemo(detectInitial, []);
  const [lang, setLangState] = useState<Lang>(initialLang ?? detected.lang);
  const [calendar, setCalendarState] = useState<Calendar>(initialCalendar ?? detected.calendar);
  const [missing, setMissing] = useState<string[]>([]);

  const dir = directionFor(lang);
  const fmt = useMemo(() => createFormatter(lang, calendar), [lang, calendar]);

  // §42 — direction and language live on the document element so that CSS
  // logical properties, the token sheet's RTL adjustments and screen readers all
  // follow the same switch. Setting `dir` on a wrapper div instead would leave
  // `position: fixed` overlays and the document title outside the flip.
  useEffect(() => {
    if (!manageDocument) return;
    const el = document.documentElement;
    el.setAttribute('dir', dir);
    el.setAttribute('lang', lang);
  }, [dir, lang, manageDocument]);

  const t = useCallback((key: string, params?: TParams): string => {
    const dict = lang === 'ar' ? bundle.ar : bundle.en;
    const fallback = lang === 'ar' ? bundle.en : bundle.ar;
    const raw = dict[key] ?? fallback[key];
    if (raw === undefined) {
      // A missing key is a defect, and a silent blank is how a defect survives to
      // production. Render the key so it is visible in review, and record it.
      if (import.meta.env?.DEV) {
        setMissing((prev) => (prev.includes(key) ? prev : [...prev, key]));
      }
      return key;
    }
    return interpolate(raw, params, fmt);
  }, [bundle, lang, fmt]);

  const tin = useCallback((which: Lang, key: string, params?: TParams): string => {
    const dict = which === 'ar' ? bundle.ar : bundle.en;
    const raw = dict[key] ?? (which === 'ar' ? bundle.en : bundle.ar)[key];
    return raw === undefined ? key : interpolate(raw, params, fmt);
  }, [bundle, fmt]);

  /**
   * Chooses between a localized pair.
   *
   * Falls back across languages rather than returning blank: a record with only
   * an Arabic name should still display for an English session. What it must
   * never do is invent a translation — showing the stored Arabic is honest,
   * showing a machine guess in a legal document is not.
   */
  const pick = useCallback((primary: string | null | undefined, secondary: string | null | undefined): string => {
    if (primary && primary.trim()) return primary;
    if (secondary && secondary.trim()) return secondary;
    return '—';
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    writeStored(next, calendar);
  }, [calendar]);

  const setCalendar = useCallback((next: Calendar) => {
    setCalendarState(next);
    writeStored(lang, next);
  }, [lang]);

  const setPreference = useCallback((nextLang: Lang, nextCalendar: Calendar) => {
    setLangState(nextLang);
    setCalendarState(nextCalendar);
    writeStored(nextLang, nextCalendar);
  }, []);

  const value = useMemo<I18nValue>(() => ({
    lang, dir, calendar, fmt, t, tin, pick, setLang, setCalendar, setPreference, missing,
  }), [lang, dir, calendar, fmt, t, tin, pick, setLang, setCalendar, setPreference, missing]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Access the runtime. Throws outside a provider — a silent default would let a
 *  screen render in the wrong language with no error to find. */
export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n() must be used inside <I18nProvider>');
  return ctx;
}

/** Convenience: the formatter alone, for modules that only need dates/numbers. */
export function useFmt(): Fmt {
  return useI18n().fmt;
}

/** Convenience: the translate function alone. */
export function useT(): (key: string, params?: TParams) => string {
  return useI18n().t;
}

export type { Lang, Calendar, Direction, Fmt };
