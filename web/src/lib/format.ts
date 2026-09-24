/**
 * Formatting (§29 · Hijri/Gregorian + SAR via Intl).
 *
 * Every date, number and amount in the portal goes through this module. Nothing
 * hand-rolls a month name or a currency symbol, and nothing assumes a calendar:
 * the user's preference selects between the Umm al-Qura Hijri calendar and the
 * Gregorian one, and `Intl` does the rest — including the Arabic-Indic digits
 * that `ar-SA` produces by default.
 */
import type { Calendar, Lang } from '../api/client';

/** `ar-SA` renders Hijri by default; `ar-SA-u-ca-gregory` forces Gregorian. */
function locale(lang: Lang, calendar: Calendar): string {
  const base = lang === 'ar' ? 'ar-SA' : 'en-GB';
  return calendar === 'gregory' ? `${base}-u-ca-gregory` : base;
}

export interface Fmt {
  lang: Lang;
  calendar: Calendar;
  dir: 'rtl' | 'ltr';
  /** 15 October 2026 / ١٥ أكتوبر ٢٠٢٦ (or the Hijri equivalent). */
  date(iso: string | null | undefined): string;
  /** Date + time, for hearings and appointments. */
  dateTime(iso: string | null | undefined): string;
  /** Clock time only. */
  time(iso: string | null | undefined): string;
  /** "in 3 days" / "قبل يومين" — relative, for lists. */
  relative(iso: string | null | undefined): string;
  /** A date-only string such as a due date already in YYYY-MM-DD form. */
  day(value: string | null | undefined): string;
  money(amount: string | number, currency?: string): string;
  number(value: number): string;
  bytes(n: number): string;
  /** The weekday name, used in hearing cards. */
  weekday(iso: string | null | undefined): string;
}

const EMPTY = '—';

function toDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function createFormatter(lang: Lang, calendar: Calendar): Fmt {
  const loc = locale(lang, calendar);
  const dir: 'rtl' | 'ltr' = lang === 'ar' ? 'rtl' : 'ltr';

  const dateFmt = new Intl.DateTimeFormat(loc, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    calendar: calendar === 'gregory' ? 'gregory' : 'islamic-umalqura',
  });
  const dateTimeFmt = new Intl.DateTimeFormat(loc, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    calendar: calendar === 'gregory' ? 'gregory' : 'islamic-umalqura',
  });
  const timeFmt = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit' });
  const weekdayFmt = new Intl.DateTimeFormat(loc, { weekday: 'long' });
  const dayFmt = new Intl.DateTimeFormat(loc, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    calendar: calendar === 'gregory' ? 'gregory' : 'islamic-umalqura',
  });
  const relFmt = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' });
  const numFmt = new Intl.NumberFormat(loc);

  const moneyCache = new Map<string, Intl.NumberFormat>();
  const moneyFmt = (currency: string) => {
    let f = moneyCache.get(currency);
    if (!f) {
      f = new Intl.NumberFormat(loc, {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      moneyCache.set(currency, f);
    }
    return f;
  };

  return {
    lang,
    calendar,
    dir,

    date(iso) {
      const d = toDate(iso);
      return d ? dateFmt.format(d) : EMPTY;
    },
    dateTime(iso) {
      const d = toDate(iso);
      return d ? dateTimeFmt.format(d) : EMPTY;
    },
    time(iso) {
      const d = toDate(iso);
      return d ? timeFmt.format(d) : EMPTY;
    },
    weekday(iso) {
      const d = toDate(iso);
      return d ? weekdayFmt.format(d) : EMPTY;
    },
    day(value) {
      const d = toDate(value);
      return d ? dayFmt.format(d) : EMPTY;
    },
    relative(iso) {
      const d = toDate(iso);
      if (!d) return EMPTY;
      const diffMs = d.getTime() - Date.now();
      const abs = Math.abs(diffMs);
      const mins = Math.round(diffMs / 60000);
      const hours = Math.round(diffMs / 3600000);
      const days = Math.round(diffMs / 86400000);
      if (abs < 3600_000) return relFmt.format(mins, 'minute');
      if (abs < 86400_000) return relFmt.format(hours, 'hour');
      if (abs < 30 * 86400_000) return relFmt.format(days, 'day');
      return dateFmt.format(d);
    },
    money(amount, currency = 'SAR') {
      const n = typeof amount === 'number' ? amount : Number.parseFloat(String(amount));
      if (!Number.isFinite(n)) return EMPTY;
      return moneyFmt(currency).format(n);
    },
    number(value) {
      return Number.isFinite(value) ? numFmt.format(value) : EMPTY;
    },
    bytes(n) {
      if (!Number.isFinite(n) || n <= 0) return EMPTY;
      const units = lang === 'ar'
        ? ['بايت', 'ك.ب', 'م.ب', 'ج.ب']
        : ['B', 'KB', 'MB', 'GB'];
      let v = n;
      let i = 0;
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
      }
      const rounded = i === 0 ? v : Math.round(v * 10) / 10;
      // Digits stay Latin inside a file size: they sit next to a unit symbol and
      // mixing systems there is harder to read, not easier.
      return `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(rounded)} ${units[i]}`;
    },
  };
}

/**
 * Picks the right string for the active language, falling back to the other one
 * rather than to an empty cell. Most portal entities carry both `x` and `xAr`.
 */
export function pick<T>(lang: Lang, en: T | null | undefined, ar: T | null | undefined): T | string {
  const primary = lang === 'ar' ? ar : en;
  const fallback = lang === 'ar' ? en : ar;
  if (primary !== null && primary !== undefined && primary !== '') return primary;
  if (fallback !== null && fallback !== undefined && fallback !== '') return fallback;
  return EMPTY;
}
