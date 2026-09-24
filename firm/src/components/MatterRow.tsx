/**
 * MATTER ROW
 *
 * One matter, rendered as a compact row. Shared between the dashboard and the
 * matters list so the two cannot disagree about what a matter looks like — which
 * matters more here than it usually would, because this row carries the §17
 * authorization indicators.
 *
 * THE TWO THINGS THIS ROW ALWAYS SHOWS
 *   `restricted` and `accessLevel` are rendered unconditionally. They are not
 *   classified fields under §57 — they are facts about the VIEWER, returned for
 *   every member who can see the matter at all. Showing them is what makes the
 *   workspace's field locks legible: a member arrives at a matter already knowing
 *   they hold `view` access, so a locked risk-rating field reads as expected
 *   behaviour rather than a broken page.
 *
 *   A matter list that hid the access level would let a member click into a
 *   record and discover the restriction only by finding things missing. Telling
 *   them at the row is both kinder and more honest.
 *
 * LANGUAGE
 *   Titles and client names come as Arabic/Latin pairs and are picked by the
 *   interface language, not by which one happens to be populated. Falling back to
 *   the other language when the preferred one is null is correct; preferring
 *   whichever exists would make the list's language depend on data-entry habits.
 */
import { AccessBadge, IconRestricted, StatusChip, Tooltip, useFmt, useI18n } from '@kgm/ui';
import type { MatterSummary } from '../api/firm.js';

interface MatterRowProps {
  readonly matter: MatterSummary;
  readonly onNavigate: (to: string) => void;
  /** Renders the access badge. Off in dense lists where the column carries it. */
  readonly showAccess?: boolean;
}

export function MatterRow({ matter, onNavigate, showAccess = true }: MatterRowProps) {
  const { t, lang, pick } = useI18n();
  const fmt = useFmt();

  const title = pick(matter.titleAr, matter.title) || matter.matterNumber || t('common.none');
  const client = pick(matter.clientNameAr, matter.clientName);

  const meta = [
    client,
    matter.practiceArea ? pick(matter.practiceAreaAr, matter.practiceArea) : null,
    matter.openedAt ? fmt.day(matter.openedAt) : null,
  ].filter(Boolean).join(' · ');

  return (
    <li>
      <a
        className="firm-matterrow"
        href={`#/matters/${matter.id}`}
        onClick={(e) => { e.preventDefault(); onNavigate(`/matters/${matter.id}`); }}
      >
        <span className="firm-matterrow__num">{matter.matterNumber ?? '—'}</span>

        <span className="firm-matterrow__body">
          <span className="firm-matterrow__title">
            {matter.restricted && (
              <Tooltip label={t('matter.restrictedNote')}>
                <IconRestricted size={13} className="firm-matterrow__lock" />
              </Tooltip>
            )}
            {title}
          </span>
          <span className="firm-matterrow__meta">{meta || t('common.none')}</span>
        </span>

        <span className="firm-matterrow__side">
          {matter.clientStatus && (
            <StatusChip status={matter.clientStatus} lang={lang === 'ar' ? 'ar' : 'en'} />
          )}
          {showAccess && (
            <AccessBadge level={matter.accessLevel} lang={lang === 'ar' ? 'ar' : 'en'} />
          )}
        </span>
      </a>
    </li>
  );
}

/** The lock glyph's spacing, kept next to the component that uses it. */
export const MATTER_ROW_LOCK_CLASS = 'firm-matterrow__lock';
