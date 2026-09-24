/**
 * FIELD LOCK · §57
 *
 * The visible half of the classification system.
 *
 * When the server withholds a field, the response omits it and names it in
 * `withheld`. This component turns that omission into something a person can
 * read: a small gold lock with the field's name, and an explanation on hover or
 * focus.
 *
 * WHY A LOCK AND NOT A BLANK
 *   A blank cell is ambiguous. It could mean "no value", "not loaded yet", "the
 *   system dropped it", or "you may not see it" — and the member has no way to
 *   tell which. Three of those four read as bugs, so a blank cell in a classified
 *   field teaches people that the interface is unreliable. The lock removes the
 *   ambiguity in one glyph.
 *
 * WHY GOLD AND NOT RED
 *   §02 reserves gold for "executive/premium accents" and red-family tones for
 *   severity. A withheld field is not an error and not a danger — it is policy
 *   working correctly. Rendering it in the error colour would train members to
 *   treat a normal access boundary as a fault, and to escalate it as one. Gold
 *   says "governed", which is what it is.
 *
 *   The same reasoning puts it in a DASHED border rather than a solid one: a
 *   solid box reads as a filled-in value, a dashed one reads as a placeholder
 *   with a reason.
 *
 * ACCESSIBILITY
 *   The lock is a real element with text, not an icon with a title attribute.
 *   `title` is unreliable for keyboard and touch users and is not consistently
 *   exposed to AT, so the explanation is carried by `aria-describedby` pointing at
 *   visually-hidden text that is always in the accessibility tree.
 */
import { useId } from 'react';
import { IconLock, useI18n } from '@kgm/ui';

interface FieldLockProps {
  /** The wire name from the server's `withheld` array. Used as the id fragment. */
  readonly field: string;
  /** The human label, so the lock names the field rather than pointing at it. */
  readonly label: string;
  /** Renders inline within a sentence — used for the restriction reason. */
  readonly inline?: boolean;
  readonly className?: string;
}

export function FieldLock({ field, label, inline = false, className = '' }: FieldLockProps) {
  const { t } = useI18n();
  const uid = useId();
  const hintId = `${uid}-lock-${field.replace(/[^a-z0-9]/gi, '-')}`;

  return (
    <span
      className={`firm-fieldlock${inline ? ' firm-fieldlock--inline' : ''} ${className}`.trim()}
      aria-describedby={hintId}
    >
      <span className="firm-fieldlock__icon" aria-hidden="true"><IconLock size={12} /></span>
      <span className="firm-fieldlock__label">{label}</span>
      <span className="firm-fieldlock__tag">{t('cls.withheld')}</span>
      {/* The explanation lives in the accessibility tree always, and is what the
          visual tooltip duplicates for pointer users. */}
      <span id={hintId} className="sr-only">{t('cls.withheldHint')}</span>
    </span>
  );
}

/**
 * The withheld-fields strip.
 *
 * Sits under the matter header on every classified record, so a member sees the
 * SHAPE of what they are not getting before they read any individual field. One
 * lock explains one field; the strip explains the access level that produced all
 * of them.
 *
 * Rendered only when something was actually withheld. An always-visible strip
 * saying "0 fields withheld" would be noise, and would train people to ignore the
 * one that matters.
 */
interface WithheldStripProps {
  readonly count: number;
  readonly label: string;
  readonly accessLevel: string;
  readonly explainer: string;
  readonly className?: string;
}

export function WithheldStrip({ count, label, accessLevel, explainer, className = '' }: WithheldStripProps) {
  const { t } = useI18n();
  if (count <= 0) return null;

  return (
    <div className={`firm-withheldstrip ${className}`.trim()}>
      <span className="firm-withheldstrip__icon" aria-hidden="true"><IconLock size={16} /></span>
      <span className="firm-withheldstrip__body">
        <span className="firm-withheldstrip__title">{label}</span>
        <span className="firm-withheldstrip__hint">{explainer}</span>
      </span>
      {/* The access level is the member's own standing, always disclosed. */}
      <span className="firm-withheldstrip__level">
        <span className="sr-only">{t('matter.accessLevel')}: </span>
        {accessLevel}
      </span>
    </div>
  );
}
