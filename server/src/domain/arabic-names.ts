/**
 * ARABIC-AWARE IDENTITY MATCHING
 *
 * The conflict engine is only as good as its ability to decide whether two names
 * refer to the same person or company. Everywhere else in this system a string
 * comparison is a string comparison; here it decides whether the firm is
 * disqualified from acting, so it gets its own module, its own tests, and a
 * stated confidence rather than a boolean.
 *
 * WHY THIS IS NOT `lower(name) = lower(name)`
 *   Arabic orthography is not standardised in practice, and the same company is
 *   written differently by different clerks on different days:
 *
 *     شركة الأفق للتجارة          مؤسسة الأفق التجارية        الافق للتجار
 *     مؤسسة عبد الله السالم        عبدالله سالم                عبد الله بن سالم
 *     Gulf Horizon Trading Co.    GULF HORIZON TRADING        Gulf Horizon Tr. Co. L.L.C.
 *
 *   They differ in hamza form (أ إ آ ٱ ا), in ta marbuta (ة / ه), in alef maqsura
 *   (ى / ي), in tatweel and diacritics, in the definite article, in the legal
 *   form word (شركة / مؤسسة / Co. / LLC), in Arabic-Indic versus ASCII digits,
 *   and in spacing. None of those differences changes WHO the party is.
 *
 * THE DESIGN DECISION THAT MATTERS
 *   Nothing here returns a boolean "match". Every comparison returns a STRENGTH,
 *   and the caller decides what each strength means:
 *
 *     'exact'      — the normalised names are equal, or the token multisets are
 *                    equal once legal-form words are removed. Also returned for
 *                    an identifier match, whatever the names say.
 *     'strong'     — equal once the definite article is also removed, so
 *                    «الأفق للتجارة» and «أفق للتجارة» are the same name.
 *     'candidate'  — one name's tokens are contained in the other's, or the family
 *                    names and at least one given name agree for an individual.
 *                    This is a POSSIBILITY, not a finding.
 *     'none'       — nothing in common.
 *
 *   A conflict system that returned a boolean would have to choose between
 *   flooding the lawyer with false positives (so they stop reading it) and missing
 *   the one hit that matters. The strength lets the register say "these two are
 *   certainly the same party, and here are four you should look at", which is what
 *   a competent paralegal would give you.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 *   Transliteration between scripts. «شركة الأفق» and «Gulf Horizon» are the same
 *   company and no string algorithm will know that; only a human or an identifier
 *   can. That is what `commercial_registration` and `vat_number` are for, and why
 *   an identifier match outranks every name match. Claiming to bridge scripts with
 *   a lookup table would produce confident wrong answers, which is the one outcome
 *   a conflict check cannot afford.
 */

/** Confidence that two names denote the same party. Ordered, least to most certain. */
export type MatchStrength = 'none' | 'candidate' | 'strong' | 'exact';

const STRENGTH_ORDER: Record<MatchStrength, number> = { none: 0, candidate: 1, strong: 2, exact: 3 };

/** Returns the stronger of two strengths — used when names and tokens disagree. */
export function strongest(a: MatchStrength, b: MatchStrength): MatchStrength {
  return STRENGTH_ORDER[a] >= STRENGTH_ORDER[b] ? a : b;
}

/*
  ── character classes ────────────────────────────────────────────────────────

  Written as explicit code-point ranges rather than \p{...} properties because the
  ranges are the thing being documented: each line is a decision about which
  variations of the same letter are the same letter.
*/
const DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const TATWEEL = /\u0640/g;
/** Arabic-Indic ٠-٩ and the Extended (Persian) ۰-۹ forms. */
const ARABIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;
/** Everything that is not a letter, a digit, or whitespace — in either script. */
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;

const ARABIC_DIGIT_ZERO = 0x0660;
const EXTENDED_DIGIT_ZERO = 0x06F0;

/**
 * Folds one string to its comparison form.
 *
 * Order matters: NFKC first (so presentation forms become their canonical
 * letters), then marks, then letters, then digits, then punctuation. Running the
 * digit mapping before punctuation removal would be harmless, but running
 * punctuation removal first would delete the Arabic decimal separator that
 * appears inside some commercial registration numbers.
 */
export function normalizeArabicName(input: string): string {
  if (!input) return '';
  let s = input.normalize('NFKC');

  // Latin diacritics: «Al-Fārābī» and «Al-Farabi» are the same name. Done by
  // decomposing and dropping combining marks rather than by a substitution table,
  // so it covers every Latin script this firm is likely to see.
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');

  s = s.replace(DIACRITICS, '');
  s = s.replace(TATWEEL, '');

  // Hamza carriers. ء is elided rather than mapped: «مسؤول» / «مسوول» / «مسئول»
  // are one word, and mapping the carrier to a letter would keep them apart.
  s = s.replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627'); // آ أ إ ٱ → ا
  s = s.replace(/\u0624/g, '\u0648'); // ؤ → و
  s = s.replace(/\u0626/g, '\u064A'); // ئ → ي
  s = s.replace(/\u0621/g, ''); // ء → (removed)
  s = s.replace(/\u0629/g, '\u0647'); // ة → ه
  s = s.replace(/\u0649/g, '\u064A'); // ى → ي

  s = s.replace(ARABIC_DIGITS, (d) => {
    const cp = d.codePointAt(0)!;
    const base = cp >= EXTENDED_DIGIT_ZERO ? EXTENDED_DIGIT_ZERO : ARABIC_DIGIT_ZERO;
    return String(cp - base);
  });

  s = s.replace(PUNCTUATION, ' ');
  s = s.toLowerCase();
  return s.replace(/\s+/g, ' ').trim();
}

/*
  ── tokens ───────────────────────────────────────────────────────────────────

  Legal-form words carry no identity. «شركة الأفق» and «مؤسسة الأفق» may or may not
  be the same entity — the legal form is exactly the part that a clerk gets wrong,
  and it is never the part that identifies.

  Deliberately absent from this list: للتجارة / التجارية / trading / group. Those
  DO carry identity — «الأفق للتجارة» and «الأفق للمقاولات» are different companies
  — and dropping them would collapse a trading company into its construction
  sister. The line is: a word that says what the entity IS as a legal vehicle is
  droppable; a word that says what it DOES is not.
*/
const LEGAL_FORM_TOKENS = new Set([
  // Arabic
  'شركه', 'مؤسسه', 'شخص', 'ذمم', 'شذمم', 'مم', 'ش.ذ.م.م', 'تضامن', 'مساهمه',
  // Latin, post-normalisation
  'co', 'company', 'llc', 'l.l.c', 'ltd', 'limited', 'inc', 'incorporated',
  'corp', 'corporation', 'est', 'establishment', 'plc', 'gmbh', 'wll',
]);

/** Bound in loops only. */
const ARTICLES = ['ال', 'لل', 'بال', 'كال', 'فال', 'وال'];

/**
 * Splits a normalised name into comparable tokens.
 *
 * `keepArticles` is the difference between 'exact' and 'strong': with articles
 * kept, «الأفق للتجارة» and «أفق للتجارة» differ; with them stripped, they agree.
 * Both are computed so the caller can report which level of certainty it reached.
 */
export function nameTokens(normalized: string, keepArticles = true): string[] {
  const raw = normalized.split(' ').filter(Boolean).filter((t) => !LEGAL_FORM_TOKENS.has(t));
  if (keepArticles) return raw;
  return raw.map(stripArticle).filter((t) => t.length >= 2);
}

function stripArticle(token: string): string {
  for (const a of ARTICLES) {
    if (token.startsWith(a) && token.length - a.length >= 3) return token.slice(a.length);
  }
  return token;
}

/** Sorted, so word order does not decide identity — «الأفق شركة» equals «شركة الأفق». */
function multiset(tokens: string[]): string {
  return [...tokens].sort().join(' ');
}

/** A single-token name is too weak to compare by containment: «سالم» is not «سالم للتجارة». */
function comparable(a: string, b: string): boolean {
  return a.length >= 3 && b.length >= 3;
}

/**
 * Compares two party names and returns how strongly they agree.
 *
 * Pure and total: no I/O, no database, no locale. Every caller — the engine, the
 * tests, an import from a spreadsheet — gets the same answer.
 */
export function matchPartyNames(a: string, b: string): MatchStrength {
  const na = normalizeArabicName(a);
  const nb = normalizeArabicName(b);
  if (!na || !nb) return 'none';
  if (na === nb) return 'exact';

  const ta = nameTokens(na);
  const tb = nameTokens(nb);
  if (ta.length && tb.length) {
    if (multiset(ta) === multiset(tb)) return 'exact';

    const sa = nameTokens(na, false);
    const sb = nameTokens(nb, false);
    if (sa.length && sb.length && multiset(sa) === multiset(sb)) return 'strong';

    /*
      Containment. «الأفق للتجارة» inside «شركة الأفق للتجارة القابضة» means the
      shorter name is a prefix of the longer one and may well be the same company
      with a trading name — or a subsidiary. It is a candidate for a human, never a
      finding, which is why it is ranked below 'strong' and never auto-confirmed.
    */
    if (sa.length && sb.length) {
      const setA = new Set(sa);
      const setB = new Set(sb);
      const shared = [...setA].filter((t) => setB.has(t));
      const smaller = setA.size <= setB.size ? setA : setB;
      if (shared.length === smaller.size && shared.every((t) => comparable(t, t))) return 'candidate';
      // Any overlap at all is still worth surfacing for a firm with few matters:
      // two unrelated names sharing a distinctive token is rare enough.
      if (shared.length >= 1 && shared.some((t) => t.length >= 5)) return 'candidate';
    }
  }
  return 'none';
}

/**
 * Normalises a commercial registration, VAT number, or national ID for storage and
 * comparison.
 *
 * Digits only, and only the ASCII ones after folding: a CR number written
 * «١٠١٠٣٤٥٦٧٨» in one place and «1010345678» in another is the same registration,
 * and a number written with spaces or dashes is the same registration again. Unlike
 * names, identifiers admit no judgement — either the digits are equal or they are
 * not, which is why an identifier match is decisive and a name match is not.
 */
export function normalizeIdentifier(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = normalizeArabicName(input).replace(/\D/g, '');
  return digits.length >= 4 ? digits : null;
}

/**
 * The strongest conclusion available for a pair of parties, combining names with
 * any identifiers they share.
 *
 * An identifier match short-circuits to 'exact': two parties with the same
 * commercial registration are the same company however differently their names
 * are spelled, and no name comparison should be allowed to downgrade that. A
 * conflicting identifier is NOT a veto in the other direction — a CR recorded
 * wrongly should not hide a party with an identical name — so a name match stands
 * on its own.
 */
export function matchParties(
  a: { nameAr: string | null; name: string | null; aliases?: string[];
       commercialRegistration?: string | null; vatNumber?: string | null; nationalIdHash?: string | null },
  b: { nameAr: string | null; name: string | null; aliases?: string[];
       commercialRegistration?: string | null; vatNumber?: string | null; nationalIdHash?: string | null },
): MatchStrength {
  const ids = (p: typeof a): Array<string | null> => [
    normalizeIdentifier(p.commercialRegistration),
    normalizeIdentifier(p.vatNumber),
    p.nationalIdHash ?? null,
  ];
  const ai = ids(a);
  const bi = ids(b);
  for (let i = 0; i < ai.length; i += 1) {
    if (ai[i] && bi[i] && ai[i] === bi[i]) return 'exact';
  }

  let best: MatchStrength = 'none';
  const aNames = [a.nameAr, a.name, ...(a.aliases ?? [])].filter(Boolean) as string[];
  const bNames = [b.nameAr, b.name, ...(b.aliases ?? [])].filter(Boolean) as string[];
  for (const x of aNames) {
    for (const y of bNames) best = strongest(best, matchPartyNames(x, y));
  }
  return best;
}

/**
 * The three-year and five-year windows of Rule 8, as data.
 *
 * Rule 8/4 — acting against a FORMER CLIENT is not a conflict once three years
 * have passed since the relationship ended or since the last work done for them.
 * Rule 8/3 — the same for a FORMER EMPLOYER after five years.
 *
 * They are exported as named constants rather than written as literals at the call
 * site because the numbers are legal provisions: a change to either is a change to
 * the firm's exposure, and it should be impossible to make one by editing a
 * subtraction.
 */
export const FORMER_CLIENT_CONFLICT_YEARS = 3;
export const FORMER_EMPLOYER_CONFLICT_YEARS = 5;

/**
 * Adds whole years, clamping to the last day of the target month.
 *
 * 29 February 2020 plus five years is 28 February 2025, not 1 March. The naive
 * `setFullYear` produces 1 March, which would extend a restriction by a day in
 * three years out of four — the kind of error that is invisible until a date is
 * relied on in a hearing.
 */
export function addYears(isoDate: string, years: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const targetYear = y + years;
  const lastDay = new Date(Date.UTC(targetYear, m, 0)).getUTCDate();
  return `${targetYear}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

export type WindowState = {
  /** The date the restriction lifts, or null when the relationship has not ended. */
  liftsOn: string | null;
  /** True while the rule still bites. */
  withinWindow: boolean;
  years: number;
};

/**
 * Whether a relationship that ended on `endedOn` is still inside a Rule 8 window.
 *
 * A relationship that has NOT ended is always inside the window: the rules measure
 * from the end of the relationship, so a current client is not "three years ago" no
 * matter how old the file is. Returning `liftsOn: null` in that case is deliberate —
 * it is not an unknown, it is an absence, and a null date renders as "current"
 * rather than as a blank a reader might fill in with a guess.
 */
export function restrictionWindow(
  endedOn: string | null | undefined, years: number, today = new Date(),
): WindowState {
  if (!endedOn) return { liftsOn: null, withinWindow: true, years };
  const liftsOn = addYears(endedOn.slice(0, 10), years);
  return { liftsOn, withinWindow: liftsOn > today.toISOString().slice(0, 10), years };
}
