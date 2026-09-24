/**
 * FORMATTING · §29 · §42
 *
 * Every date, number and amount in both applications goes through this module.
 * Nothing hand-rolls a month name, a currency symbol or a Hijri conversion.
 *
 * WHY Intl AND NOT A CONVERSION TABLE
 *   The Umm al-Qura calendar is rule-based but published as an official
 *   determination, and hand-rolled tabular conversions drift from it by a day at
 *   month boundaries. For a legal practice, a hearing date rendered one day off
 *   is not a cosmetic bug. `Intl` with `islamic-umalqura` is the platform's own
 *   implementation of the same determination the courts use.
 *
 * DIGITS
 *   `ar-SA` produces Arabic-Indic digits by default (١٢٣). That is correct for
 *   prose and dates. For FINANCIAL figures the firm needs Latin digits, because
 *   accountants reconcile against bank statements and ledgers printed in Latin
 *   numerals, and a SAR amount that cannot be read at a glance against a
 *   statement is a SAR amount that gets mis-keyed. `moneyLatin()` exists for
 *   exactly that, and the finance screens use it.
 *
 * DUAL CALENDAR
 *   Saudi court scheduling runs on both calendars simultaneously — a filing
 *   deadline may be set in Hijri while the engagement letter is Gregorian.
 *   `datePair()` renders both, which no single-locale formatter can do.
 *
 * This module is PURE. It knows nothing about sessions, permissions or the
 * network, which is why it is safe to share between the two products (§3).
 */

export type Lang = 'ar' | 'en';
export type Calendar = 'islamic-umalqura' | 'gregory';
export type Direction = 'rtl' | 'ltr';

/** `ar-SA` renders Hijri by default; the `-u-ca-gregory` extension forces Gregorian. */
function locale(lang: Lang, calendar: Calendar): string {
  const base = lang === 'ar' ? 'ar-SA' : 'en-GB';
  return calendar === 'gregory' ? `${base}-u-ca-gregory` : base;
}

/** Direction implied by the language. §42: switching language switches direction. */
export function directionFor(lang: Lang): Direction {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

export interface Fmt {
  readonly lang: Lang;
  readonly calendar: Calendar;
  readonly dir: Direction;

  /** 15 October 2026 / ١٥ أكتوبر ٢٠٢٦, or the Hijri equivalent. */
  date(iso: string | null | undefined): string;
  /** Date + time. Hearings, appointments, audit rows. */
  dateTime(iso: string | null | undefined): string;
  /** Clock time only. */
  time(iso: string | null | undefined): string;
  /** Short form for dense tables and the timeline rail (§23). */
  day(value: string | null | undefined): string;
  /** "in 3 days" / "قبل يومين". */
  relative(iso: string | null | undefined): string;
  weekday(iso: string | null | undefined): string;
  /** Both calendars at once, for court scheduling. Gregorian first in LTR. */
  datePair(iso: string | null | undefined): { primary: string; secondary: string };

  /** Localized digits. Correct for prose. */
  money(amount: string | number, currency?: string): string;
  /**
   * Latin digits with grouping, for finance screens (§29). The currency code is
   * rendered separately so a column of amounts aligns on the decimal point
   * rather than on a symbol of varying width.
   */
  moneyLatin(amount: string | number, currency?: string): string;
  /** The numeric part only, for table cells that put SAR in a column header. */
  amount(amount: string | number): string;
  /** The currency code, localized — ر.س. in Arabic, SAR in English. */
  currencyCode(currency?: string): string;
  number(value: number): string;
  /** Latin digits regardless of locale. For counts, IDs and metrics. */
  numberLatin(value: number): string;
  percent(value: number, digits?: number): string;
  bytes(n: number): string;
  /** A duration in hours and minutes, for time entries (§36 finance). */
  duration(minutes: number): string;
}

/** An em dash, not an empty string. A blank cell is indistinguishable from a
 *  cell that failed to load; a dash says "no value", which is different. */
const EMPTY = '—';

function toDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = typeof value === 'number' ? new Date(value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toFinite(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function createFormatter(lang: Lang, calendar: Calendar): Fmt {
  const loc = locale(lang, calendar);
  const dir = directionFor(lang);
  // The opposite calendar, for datePair.
  const otherCal: Calendar = calendar === 'gregory' ? 'islamic-umalqura' : 'gregory';
  const otherLoc = locale(lang, otherCal);

  const ca = calendar === 'gregory' ? 'gregory' : 'islamic-umalqura';

  const dateFmt = new Intl.DateTimeFormat(loc, { year: 'numeric', month: 'long', day: 'numeric', calendar: ca });
  const dateTimeFmt = new Intl.DateTimeFormat(loc, {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', calendar: ca,
  });
  const timeFmt = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit' });
  const weekdayFmt = new Intl.DateTimeFormat(loc, { weekday: 'long' });
  const dayFmt = new Intl.DateTimeFormat(loc, { year: 'numeric', month: 'short', day: 'numeric', calendar: ca });

  const otherDateFmt = new Intl.DateTimeFormat(otherLoc, {
    year: 'numeric', month: 'long', day: 'numeric',
    calendar: otherCal === 'gregory' ? 'gregory' : 'islamic-umalqura',
  });

  const relFmt = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' });

  // `latn` forces Latin digits even under ar-SA.
  const moneyFmt = new Intl.NumberFormat(loc, { style: 'currency', currency: 'SAR', minimumFractionDigits: 2 });
  const moneyLatinFmt = new Intl.NumberFormat('en-US-u-nu-latn', {
    style: 'currency', currency: 'SAR', minimumFractionDigits: 2,
  });
  const amountFmt = new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const amountLatinFmt = new Intl.NumberFormat('en-US-u-nu-latn', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const numFmt = new Intl.NumberFormat(loc);
  const numLatinFmt = new Intl.NumberFormat('en-US-u-nu-latn');

  /** Relative time in the largest sensible unit. */
  function relative(iso: string | null | undefined): string {
    const d = toDate(iso);
    if (!d) return EMPTY;
    const diffMs = d.getTime() - Date.now();
    const abs = Math.abs(diffMs);
    const min = 60_000, hour = 3_600_000, day = 86_400_000;
    const sign = diffMs < 0 ? -1 : 1;

    if (abs < min) return relFmt.format(0, 'second');
    if (abs < hour) return relFmt.format(sign * Math.round(abs / min), 'minute');
    if (abs < day) return relFmt.format(sign * Math.round(abs / hour), 'hour');
    if (abs < day * 30) return relFmt.format(sign * Math.round(abs / day), 'day');
    if (abs < day * 365) return relFmt.format(sign * Math.round(abs / (day * 30)), 'month');
    return relFmt.format(sign * Math.round(abs / (day * 365)), 'year');
  }

  // Extracting just the currency symbol from Intl is awkward and locale-shaped;
  // these are the two the product actually uses.
  const currencyCode = (c = 'SAR') => (lang === 'ar' && c === 'SAR' ? 'ر.س.' : c);

  return {
    lang,
    calendar,
    dir,

    date: (iso) => { const d = toDate(iso); return d ? dateFmt.format(d) : EMPTY; },
    dateTime: (iso) => { const d = toDate(iso); return d ? dateTimeFmt.format(d) : EMPTY; },
    time: (iso) => { const d = toDate(iso); return d ? timeFmt.format(d) : EMPTY; },
    day: (v) => { const d = toDate(v); return d ? dayFmt.format(d) : EMPTY; },
    weekday: (iso) => { const d = toDate(iso); return d ? weekdayFmt.format(d) : EMPTY; },
    relative,

    datePair: (iso) => {
      const d = toDate(iso);
      if (!d) return { primary: EMPTY, secondary: EMPTY };
      const primary = dateFmt.format(d);
      const secondary = otherDateFmt.format(d);
      return { primary, secondary };
    },

    money: (amount, currency) => {
      const n = toFinite(amount);
      if (n === null) return EMPTY;
      if (currency && currency !== 'SAR') {
        return new Intl.NumberFormat(loc, { style: 'currency', currency, minimumFractionDigits: 2 }).format(n);
      }
      return moneyFmt.format(n);
    },

    moneyLatin: (amount, currency) => {
      const n = toFinite(amount);
      if (n === null) return EMPTY;
      if (currency && currency !== 'SAR') {
        return new Intl.NumberFormat('en-US-u-nu-latn', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n);
      }
      return moneyLatinFmt.format(n);
    },

    amount: (amount) => {
      const n = toFinite(amount);
      return n === null ? EMPTY : amountFmt.format(n);
    },

    currencyCode,

    number: (v) => (Number.isFinite(v) ? numFmt.format(v) : EMPTY),
    numberLatin: (v) => (Number.isFinite(v) ? numLatinFmt.format(v) : EMPTY),

    percent: (v, digits = 1) =>
      Number.isFinite(v)
        ? new Intl.NumberFormat(loc, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v / 100)
        : EMPTY,

    bytes: (n) => {
      if (!Number.isFinite(n) || n < 0) return EMPTY;
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      if (n < 1024) return `${numLatinFmt.format(n)} ${units[0]}`;
      const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
      const v = n / 1024 ** i;
      return `${amountLatinFmt.format(v).replace(/\.00$/, '')} ${units[i]}`;
    },

    duration: (minutes) => {
      if (!Number.isFinite(minutes) || minutes < 0) return EMPTY;
      const h = Math.floor(minutes / 60);
      const m = Math.round(minutes % 60);
      if (h === 0) return lang === 'ar' ? `${numLatinFmt.format(m)} د` : `${numLatinFmt.format(m)}m`;
      if (m === 0) return lang === 'ar' ? `${numLatinFmt.format(h)} س` : `${numLatinFmt.format(h)}h`;
      return lang === 'ar'
        ? `${numLatinFmt.format(h)} س ${numLatinFmt.format(m)} د`
        : `${numLatinFmt.format(h)}h ${numLatinFmt.format(m)}m`;
    },
  };
}

/**
 * Days between now and a date, signed. Positive = future.
 *
 * Used by §30 (licence expiry, "expires in 18 days") and §31 (deadline alerts).
 * Deliberately NOT part of Fmt: it returns a number, and a number is the same in
 * both languages. Callers format it themselves so the threshold logic stays
 * locale-independent — "18 days" and "١٨ يوماً" must trip the same warning.
 */
export function daysFromNow(iso: string | null | undefined, from = Date.now()): number | null {
  const d = toDate(iso);
  if (!d) return null;
  const startOfDay = (t: number) => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  return Math.round((startOfDay(d.getTime()) - startOfDay(from)) / 86_400_000);
}

/**
 * Normalizes a name for search.
 *
 * Arabic search has two normalizations that matter and are easy to miss:
 *   - diacritics (tashkeel) must be stripped, because a user types without them
 *     while stored data may carry them
 *   - the alef variants أ إ آ ا must fold to ا, and ى to ي, or "أحمد" will not
 *     match a search for "احمد"
 *
 * Without this an Arabic-first search field silently fails on the most common
 * names in the system, which reads as "search is broken" rather than as a
 * normalization bug.
 */
export function normalizeArabic(input: string): string {
  return input
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')   // harakat, superscript alef, tatweel
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // alef variants → alef
    .replace(/\u0649/g, '\u064A')                   // alef maqsura → yeh
    .replace(/\u0629/g, '\u0647')                   // teh marbuta → heh
    .toLowerCase()
    .trim();
}

/** Case- and script-insensitive substring match, for client-side filtering. */
export function matches(query: string, ...values: (string | null | undefined)[]): boolean {
  const q = normalizeArabic(query);
  if (!q) return true;
  return values.some((v) => (v ? normalizeArabic(v).includes(q) : false));
}

/** The currency-symbol-only form, for a table header that states the unit once. */
export function currencyLabel(lang: Lang, currency = 'SAR'): string {
  if (currency !== 'SAR') return currency;
  return lang === 'ar' ? 'ر.س.' : 'SAR';
}

export function moneyCompact(value: number, lang: Lang, calendar: Calendar = 'gregory'): string {
  const f = createFormatter(lang, calendar);
  if (!Number.isFinite(value)) return EMPTY;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${f.numberLatin(Math.round((value / 1_000_000) * 10) / 10)}M`;
  if (abs >= 1_000) return `${f.numberLatin(Math.round(value / 1_000))}K`;
  return f.amount(value);
}
