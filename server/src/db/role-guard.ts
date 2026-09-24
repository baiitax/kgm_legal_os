/**
 * DATABASE ROLE ISOLATION CHECK · §49, §71
 *
 * Refuses to start when the database connection can bypass Row Level Security.
 *
 * WHY THIS EXISTS
 *   The entire §49 guarantee rests on ONE property of the connection: it must be a
 *   role that RLS actually applies to. The migrations `ENABLE ROW LEVEL SECURITY`
 *   on 64 tables and grant `portal_api` column-level SELECT — but none of that
 *   constrains a caller that is a SUPERUSER, has BYPASSRLS, or OWNS the tables.
 *   PostgreSQL exempts all three, and no SQL in this repository can change that.
 *
 *   Those three cases are not hypothetical. Supabase hands out `postgres` — a
 *   superuser — as the default connection identity, and the pooler connection
 *   string in the Supabase dashboard uses it. Pointing DATABASE_URL at that
 *   string produces a server that starts cleanly, serves every request
 *   successfully, and has silently lost its entire database-level defence. There
 *   is no error, no warning, and no symptom until an application-layer bug that
 *   RLS was supposed to catch turns into a cross-tenant leak.
 *
 *   So the check is fail-closed: a dangerous role is a startup failure, not a log
 *   line. A server that will not boot gets fixed in minutes. A server that boots
 *   without its backstop gets discovered during an incident.
 *
 * KEPT SEPARATE FROM THE QUERY
 *   `judgeRole` is a pure function so the decision can be tested against every
 *   combination of flags without a live PostgreSQL. The policy is the part worth
 *   testing; the `pg_roles` query gathering the flags is not.
 */

export interface RoleFacts {
  /** `current_user` — the role the connection actually authenticated as. */
  readonly roleName: string;
  /** `pg_roles.rolsuper` — exempt from RLS, grants and ownership checks. */
  readonly isSuperuser: boolean;
  /** `pg_roles.rolbypassrls` — explicit, deliberate exemption. */
  readonly bypassesRls: boolean;
  /** Count of public-schema tables this role owns. Owners bypass RLS unless the
   *  table has FORCE ROW LEVEL SECURITY, which no migration in this repo applies. */
  readonly ownedTables: number;
}

export interface RoleVerdict {
  readonly safe: boolean;
  /** Stable code for logs and tests. */
  readonly code:
    | 'ok'
    | 'role_is_superuser'
    | 'role_bypasses_rls'
    | 'role_owns_tables';
  /** One line naming the consequence, not the rule. */
  readonly detail: string;
}

const SAFE_ROLE = 'portal_api';

export function judgeRole(facts: RoleFacts): RoleVerdict {
  /*
    Superuser first: it is the strictest and the most common. Supabase's default
    connection string is `postgres`, which is exactly this.
  */
  if (facts.isSuperuser) {
    return {
      safe: false,
      code: 'role_is_superuser',
      detail:
        `connected as "${facts.roleName}", which is a SUPERUSER. Row Level Security ` +
        'and every column-level GRANT are bypassed entirely for superusers, so the ' +
        'database is no longer a security boundary — it is a passthrough.',
    };
  }

  if (facts.bypassesRls) {
    return {
      safe: false,
      code: 'role_bypasses_rls',
      detail:
        `connected as "${facts.roleName}", which has the BYPASSRLS attribute. ` +
        'Every row-security policy in migrations 0004 and 0006 is inert.',
    };
  }

  /*
    Table ownership: RLS does not apply to a table's owner unless the table has
    FORCE ROW LEVEL SECURITY. This repository enables RLS on 64 tables and forces
    it on none — so an owner connection reads and writes every row in every
    tenant, with the policies still present and looking correct.
  */
  if (facts.ownedTables > 0) {
    return {
      safe: false,
      code: 'role_owns_tables',
      detail:
        `connected as "${facts.roleName}", which OWNS ${facts.ownedTables} table(s) in ` +
        'the public schema. RLS does not apply to a table owner, and no migration ' +
        'here applies FORCE ROW LEVEL SECURITY, so those policies are inert for ' +
        'this connection.',
    };
  }

  return {
    safe: true,
    code: 'ok',
    detail: `connected as "${facts.roleName}" — not a superuser, no BYPASSRLS, owns no tables. RLS applies.`,
  };
}

/**
 * Whether an unsafe role should stop the process.
 *
 * Always, in every environment. A development stack that tolerates a bypassing
 * connection is how the misconfiguration reaches production: the guard is
 * exercised only in the environment where nobody is watching, and is first
 * genuinely tested on the day it matters. There is no lower-stakes version of
 * "row security is off".
 */
export function shouldRefuseToStart(verdict: RoleVerdict): boolean {
  return !verdict.safe;
}

/** The connection hint printed alongside a refusal. */
export const EXPECTED_ROLE_HINT =
  `Set DATABASE_URL to the restricted "${SAFE_ROLE}" login (see ` +
  'supabase/ops/create_api_login.sql), not the Supabase `postgres` superuser ' +
  'connection string and not the service-role key.';
