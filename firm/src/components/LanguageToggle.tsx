/**
 * LANGUAGE TOGGLE · §Arabic-first, §40
 *
 * An explicit two-option switch between العربية and English, available before
 * authentication as well as inside the shell.
 *
 * WHY THE LABELS ARE ENDONYMS AND NOT DICTIONARY KEYS
 *   Each option is written in its own language — "العربية" and "English" — and
 *   those two strings are deliberately NOT routed through `t()`. A language
 *   switcher whose labels are translated is unusable in precisely the situation
 *   it exists for: a member who cannot read the current interface language cannot
 *   find their own language inside it. Translating the label would render
 *   "English" as "الإنجليزية" while the UI is in Arabic, which defeats the control.
 *
 *   The `lang` attribute on each button is pinned for the same reason, so a screen
 *   reader pronounces "English" in English even when the document language is ar.
 *
 * WHY EXPLICIT OPTIONS RATHER THAN A GLOBE ICON
 *   An icon-only toggle states that a second language exists without saying which
 *   is active or which a press selects. Two labelled options answer both, and make
 *   the control a destination rather than a cycle — you can see where you are going.
 *
 * DIRECTION FOLLOWS THE CHOICE
 *   `setLang` persists the preference and the i18n runtime writes `<html dir>` and
 *   `<html lang>`, so RTL layout follows automatically. Nothing here touches the
 *   document: a second mechanism for direction would eventually disagree with the
 *   first.
 */
import { useI18n } from '@kgm/ui';

/**
 * The two supported interface languages.
 *
 * A closed list, not a loop over a dictionary: the product is Arabic-first with
 * English as its peer (§Arabic-first), and a third language would need more than a
 * label — number formatting, Hijri handling and legal terminology all differ.
 */
const OPTIONS = [
  { lang: 'ar', label: 'العربية', short: 'ع', dir: 'rtl' },
  { lang: 'en', label: 'English', short: 'EN', dir: 'ltr' },
] as const;

export interface LanguageToggleProps {
  /**
   * `segmented` shows both full endonyms — the default, and the right choice
   * wherever there is room. `compact` shows the short forms, for the topbar's
   * icon cluster and other tight rows.
   */
  readonly variant?: 'segmented' | 'compact';
  readonly className?: string;
}

export function LanguageToggle({ variant = 'segmented', className = '' }: LanguageToggleProps) {
  const { lang, setLang, t } = useI18n();

  return (
    <div
      className={`kgm-langtoggle kgm-langtoggle--${variant}${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={t('topbar.language')}
    >
      {OPTIONS.map((option) => {
        const active = lang === option.lang;
        return (
          <button
            key={option.lang}
            type="button"
            className="kgm-langtoggle__opt"
            aria-pressed={active}
            /*
              Each option keeps its own direction and language regardless of the
              document's. Without `dir` the Arabic label inherits RTL from an
              Arabic document but flips to LTR in an English one, which changes
              its glyph joining context and makes the two states look like
              different words.
            */
            dir={option.dir}
            lang={option.lang}
            onClick={() => {
              // Guarded so a press on the active option is a no-op rather than a
              // redundant write to storage and a re-render of the whole tree.
              if (!active) setLang(option.lang);
            }}
          >
            {variant === 'compact' ? option.short : option.label}
          </button>
        );
      })}
    </div>
  );
}
