/**
 * MATTER ROLES — ONE VOCABULARY, AND THE RULE ABOUT WHICH OF THEM THE CLIENT SEES.
 *
 * WHY THIS FILE EXISTS AT ALL. The same six role names are written down in three
 * places that cannot see each other:
 *
 *   1. the CHECK constraint on `matter_team.matter_role`
 *      (supabase/migrations/0002_legal_domain.sql, and its SQLite mirror);
 *   2. the CASE expression in `matter_access_level()` (0006) that turns a role into
 *      an access level;
 *   3. `teamRoleToLevel()` in `db/firm-repo.ts`, the TypeScript copy of that CASE.
 *
 * That is the shape of the defect this project has already paid for twice: one rule,
 * several copies, drifted (the 25% UBO rule lived in the domain, in the SQLite
 * trigger and in the Postgres trigger, and only the SQLite copy required
 * `owner_kind = 'natural_person'`). Intake is where a role is CHOSEN, so it is the
 * one place that would have quietly invented a seventh name — `lawyer`, say, which
 * `teamRoleToLevel` accepts and the CHECK constraint refuses, giving a 500 on
 * Postgres and a green test on SQLite.
 *
 * So the list lives here, the API validates against it, and the SQL CHECK remains
 * the arbiter underneath. Adding a role means changing this file, the CHECK in both
 * dialects, and the CASE in 0006 — deliberately, in one change.
 */

/**
 * The six roles a person may hold on a matter. Mirrors the CHECK constraint
 * exactly; `supervising_partner` is deliberately ABSENT because the CHECK does not
 * admit it, and it must not be added here until it is.
 */
export const MATTER_TEAM_ROLES = [
  'lead_partner', 'lead_lawyer', 'associate', 'paralegal',
  'finance_contact', 'compliance_contact',
] as const;

export type MatterTeamRole = (typeof MATTER_TEAM_ROLES)[number];

/**
 * THE ROLES THAT ARE ON THE FILE AND NOT SHOWN TO THE CLIENT — §11.
 *
 * The finance and compliance contacts are firm-side actors: one works the money for
 * a matter, the other is the AML officer answerable for the client's own file. A
 * client who can see "Compliance" on their matter can infer that something about
 * them was screened, and the portal is not where that conversation should start.
 *
 * The rule is enforced in THREE places on purpose, because each one catches a
 * different caller:
 *   · here — when the API assigns a role, the flag is FORCED rather than trusted;
 *   · the CHECK constraint added by 0058 — so no other writer can flip it back;
 *   · the portal's projection — so a client never receives the row at all.
 */
export const HIDDEN_MATTER_ROLES: readonly string[] = ['finance_contact', 'compliance_contact'];

/**
 * The client-facing label for each role, in both languages.
 *
 * Arabic is the source of truth. These are shown to the CLIENT when
 * `client_visible` is true — "Senior Associate" is firm-internal vocabulary and the
 * client is told what the person does on their file, which is why the label is not
 * derived from the role name.
 */
export const MATTER_TEAM_LABELS: Record<string, { en: string; ar: string }> = {
  lead_partner: { en: 'Lead Partner', ar: 'الشريك المسؤول' },
  lead_lawyer: { en: 'Lead Lawyer', ar: 'المحامي المسؤول' },
  associate: { en: 'Associate', ar: 'محامٍ مشارك' },
  paralegal: { en: 'Paralegal', ar: 'مساعدة قانونية' },
  finance_contact: { en: 'Finance', ar: 'المالية' },
  compliance_contact: { en: 'Compliance', ar: 'الامتثال' },
};

/** The two lead roles: exactly one active holder each, per the index 0058 adds. */
export const LEAD_MATTER_ROLES: readonly string[] = ['lead_partner', 'lead_lawyer'];
