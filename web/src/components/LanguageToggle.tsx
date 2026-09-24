/**
 * LANGUAGE TOGGLE · the client portal's half of §Arabic-first
 *
 * An explicit two-option switch between العربية and English, available before
 * authentication as well as inside the portal shell.
 *
 * WHY THIS DUPLICATES THE FIRM OS COMPONENT INSTEAD OF IMPORTING IT
 *   The two products share presentational primitives through `packages/ui` and
 *   nothing else — no auth context, no API client, no route table. This control
 *   reaches into `useAuth` to persist the choice to the client's own
 *   preferences, so sharing the firm's copy would mean sharing that dependency.
 *   The markup is the same on purpose; the coupling is not.
 *
 * WHY THE LABELS ARE ENDONYMS AND NOT DICTIONARY KEYS
 *   Each option is written in its own language — "العربية" and "English" — and
 *   neither string goes through `t()`. A language switcher whose labels are
 *   translated is unusable in exactly the situation it exists for: someone who
 *   cannot read the current interface language cannot find their own language
 *   listed inside it. Translating the label would render "English" as
 *   "الإنجليزية" while the UI is in Arabic, which defeats the control.
 *
 * WHY BOTH LANGUAGES ARE ALWAYS VISIBLE
 *   The previous control here showed "ع" and "EN". Two abbreviations in an
 *   unfamiliar script are not a choice a reader can act on — and the one thing a
 *   language switcher must never require is literacy in the current language.
 *   The `compact` variant keeps the short forms for the topbar's icon cluster,
 *   where the labels are adjacent to enough context to be unambiguous.
 *
 * DIRECTION FOLLOWS THE CHOICE
 *   `setLang` updates state, and I18nProvider writes `<html dir>` and
 *   `<html lang>`, so the layout flips with no navigation and no second
 *   mechanism for direction. This component deliberately does NOT reload the
 *   page: a reload would discard whatever the reader was in the middle of.
 *
 * PRESSED STATE, NOT A CYCLE
 *   `aria-pressed` marks the active option and each button states its own
 *   `lang` and `dir`, so a screen reader pronounces "English" in English while
 *   the document is in Arabic — and the Arabic label keeps its joining context
 *   in an English document instead of rendering as different-looking glyphs.
 */
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import type { Lang } from '../api/client';
import { patch } from '../api/client';

const OPTIONS = [
  { lang: 'ar', label: 'العربية', short: 'ع', dir: 'rtl' },
  { lang: 'en', label: 'English', short: 'EN', dir: 'ltr' },
] as const;

export interface LanguageToggleProps {
  /** `segmented` shows both endonyms in full; `compact` shortens them. */
  readonly variant?: 'segmented' | 'compact';
  readonly className?: string;
}

export function LanguageToggle({ variant = 'segmented', className = '' }: LanguageToggleProps) {
  const { lang, setLang, t } = useI18n();
  const { session } = useAuth();

  const apply = (next: Lang) => {
    if (next === lang) return;
    setLang(next);
    /*
      Persisting is best-effort and deliberately not awaited before the switch:
      the interface changes on the spot, and a signed-out visitor simply gets a
      local preference that lasts for the session. Preferences are per-user
      server state (§29), so the write only exists when there is a user.
    */
    if (session.authenticated) {
      void patch('/api/client/preferences', { language: next }).catch(() => undefined);
    }
  };

  return (
    <div
      className={`lang-toggle lang-toggle--${variant}${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={t('a11y.langSwitch')}
    >
      {OPTIONS.map((option) => {
        const active = lang === option.lang;
        return (
          <button
            key={option.lang}
            type="button"
            aria-pressed={active}
            dir={option.dir}
            lang={option.lang}
            onClick={() => apply(option.lang)}
          >
            {variant === 'compact' ? option.short : option.label}
          </button>
        );
      })}
    </div>
  );
}
