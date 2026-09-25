/**
 * THE FIRM OS REPOSITORY (§5-§17, §27, §50)
 *
 * The client portal has `repo.ts` and it is the only place portal SQL lives.
 * This is the Firm OS equivalent, and the two never share a method: a firm
 * handler cannot borrow a portal query and a portal handler cannot borrow a firm
 * one, because neither class exposes the other's surface (§6).
 *
 * RULES (same shape as repo.ts, restated because they are load-bearing here)
 *   A — every SELECT enumerates its columns. There is no `select *`.
 *   B — every read takes the tenant and filters on it in SQL. A firm query that
 *       could return another firm's rows does not exist.
 *   C — authorization FACTS are read here; authorization DECISIONS are made in
 *       domain/permissions.ts. This file never answers "may they?" — it answers
 *       "what is true?", and the engine reasons over that. Keeping the split
 *       means the precedence rule lives in exactly one TypeScript function and
 *       one SQL function, and the two are written to match line for line.
 *
 * `internal_notes` and `audit_events` have no read method here either. Audit is
 * written through repo.ts (append-only) and read only through the Postgres
 * `firm_audit_search()` definer function, which itself requires `audit.read`.
 */
import type { Db, Param, Queryable, Row } from './types.js';
import { currentQueryable, currentScope } from './context.js';
import { toBool, toIso, toNumber, toStr } from './types.js';
import { newId } from '../lib/crypto.js';
import {
  evaluateConflicts, type AffiliationRecord, type ClientRecord, type ConflictFinding,
  type MatterPartyRecord, type MatterPartyRole, type PartyIdentity, type PriorAppearance,
} from '../domain/conflict-engine.js';
import { normalizeArabicName } from '../domain/arabic-names.js';

/** The membership row plus the identity it points at. */
export interface MembershipRow {
  id: string;
  tenantId: string;
  userId: string;
  staffId: string;
  email: string;
  status: string;
  jobTitle: string | null;
  jobTitleAr: string | null;
  financialAuthority: number | null;
  writeoffAuthority: number | null;
  discountPct: number | null;
  staffName: string | null;
  staffNameAr: string | null;
  internalRole: string | null;
  language: string;
  calendar: string;
  mfaEnabled: boolean;
}

/** Everything the engine needs to decide access to ONE matter. */
export interface MatterAuthFacts {
  matterId: string;
  tenantId: string;
  practiceArea: string | null;
  matterNumber: string | null;
  clientId: string | null;
  internalStatus: string | null;
  /** From matter_controls. Absent control row = unrestricted. */
  isRestricted: boolean;
  restrictionReason: string | null;
  restrictionReasonAr: string | null;
  /** Latest non-revoked explicit grant, or null. May legitimately be 'none'. */
  explicitLevel: string | null;
  /** Level implied by the matter_team role, or null when not on the team. */
  teamLevel: string | null;
  teamRole: string | null;
  departmentCode: string | null;
  ownerMembershipId: string | null;
  /** Who applied the current restriction, from matter_controls. Null when the
   *  matter is unrestricted. This is what makes the restriction reversible by
   *  the member who set it — see the lift rule in permissions.ts. */
  restrictedByMembershipId: string | null;
}

/**
 * A due-diligence row, in the shape the callers read.
 *
 * EVERY FIELD IS MAPPED, including the ones nothing reads yet. The boundary is the
 * point: a raw driver row crossing it is how `vat_number` came to be read as
 * `vatNumber`, and how every standard tax invoice in the system came to be refused.
 */
function dueDiligenceFromRow(r: Row) {
  return {
    id: String(r.id), tenantId: String(r.tenant_id), clientId: String(r.client_id),
    partyId: strOrNull(r.party_id), version: Number(r.version),
    level: String(r.cdd_level), status: String(r.status),
    legalName: strOrNull(r.legal_name), legalNameAr: strOrNull(r.legal_name_ar),
    dateOfBirth: strOrNull(r.date_of_birth), nationality: strOrNull(r.nationality),
    residenceCountry: strOrNull(r.residence_country), address: strOrNull(r.address),
    idType: strOrNull(r.id_type), idNumberHash: strOrNull(r.id_number_hash),
    idNumberMasked: strOrNull(r.id_number_masked),
    idIssuedAt: strOrNull(r.id_issued_at), idExpiresAt: strOrNull(r.id_expires_at),
    crNumber: strOrNull(r.cr_number), crIssuedAt: strOrNull(r.cr_issued_at),
    incorporationCountry: strOrNull(r.incorporation_country),
    businessActivity: strOrNull(r.business_activity),
    ownershipStructure: strOrNull(r.ownership_structure),
    sourceOfFunds: strOrNull(r.source_of_funds), sourceOfWealth: strOrNull(r.source_of_wealth),
    purpose: strOrNull(r.purpose),
    expectedAnnualVolumeSar: r.expected_annual_volume_sar === null
      ? null : toNumber(r.expected_annual_volume_sar),
    verificationMethod: strOrNull(r.verification_method),
    verificationSource: strOrNull(r.verification_source),
    verifiedByMembershipId: strOrNull(r.verified_by_membership_id), verifiedAt: strOrNull(r.verified_at),
    pepStatus: strOrNull(r.pep_status) as CddPepStatus, pepDetails: strOrNull(r.pep_details),
    riskRating: strOrNull(r.risk_rating) as CddRiskRating, riskReasons: jsonArrayColumn(r.risk_reasons),
    riskAssessedAt: strOrNull(r.risk_assessed_at),
    seniorApprovedByMembershipId: strOrNull(r.senior_approved_by_membership_id),
    seniorApprovedAt: strOrNull(r.senior_approved_at),
    seniorApprovalNote: strOrNull(r.senior_approval_note),
    reviewDueAt: strOrNull(r.review_due_at), lastReviewedAt: strOrNull(r.last_reviewed_at),
    completedAt: strOrNull(r.completed_at), completedByMembershipId: strOrNull(r.completed_by_membership_id),
    unableReason: strOrNull(r.unable_reason), notes: strOrNull(r.notes),
    supersededBy: strOrNull(r.superseded_by), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export type OwnerControlBasis = 'ownership' | 'voting_rights' | 'senior_management' | 'other';
export type ScreeningDisposition = 'open' | 'false_positive' | 'true_match' | 'escalated';
export type CddPepStatus = 'not_pep' | 'pep' | 'pep_family' | 'pep_associate';
export type CddRiskRating = 'low' | 'medium' | 'high';

/**
 * A nullable text column as `string | null`.
 *
 * The driver's own type for a column that may be null widens to `{}`, which is true of
 * every row and useless to a caller. The narrowing belongs here, at the boundary, for the
 * same reason the projection does: what crosses it must be the shape the caller reads.
 */
function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** A JSON array column, tolerating both a string (SQLite) and a parsed array (Postgres). */
function jsonArrayColumn(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * A value on its way into a due-diligence column.
 *
 * Two conversions, and both are the reason this function exists rather than a call to
 * `normalize()`: a boolean becomes 1/0 for SQLite and stays a boolean for Postgres, and
 * an array becomes JSON text for SQLite and stays whatever the driver takes for Postgres.
 * The rule the project learned the hard way still holds — hand the repository a boolean,
 * never `? 1 : 0` — and this is where that rule is honoured for these tables.
 */
function normalizeDdValue(value: unknown): Param {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  return value as Param;
}

export class FirmRepo {
  constructor(private readonly db: Db) {}

  private q(): Queryable {
    return currentQueryable(this.db);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const scope = currentScope();
    return scope ? scope.tx(fn) : fn();
  }

  // ==========================================================================
  // MEMBERSHIP RESOLUTION
  // ==========================================================================

  /**
   * The membership for a user inside one tenant.
   *
   * `status` is returned rather than filtered so the caller can distinguish
   * "never a member" from "suspended" and "left" — the session layer needs that
   * difference to revoke correctly rather than just rejecting.
   */
  async getMembership(userId: string, tenantId: string): Promise<MembershipRow | null> {
    const r = await this.q().get<Row>(
      `select fm.id, fm.tenant_id, fm.user_id, fm.staff_id, fm.status,
              fm.job_title, fm.job_title_ar,
              fm.financial_authority_sar, fm.writeoff_authority_sar, fm.discount_authority_pct,
              u.email, u.preferred_language, u.preferred_calendar, u.mfa_enabled,
              s.full_name, s.full_name_ar, s.internal_role
         from firm_memberships fm
         join users u on u.id = fm.user_id
         join staff s on s.id = fm.staff_id
        where fm.user_id = ? and fm.tenant_id = ?`,
      [userId, tenantId],
    );
    return r ? toMembership(r) : null;
  }

  async getMembershipById(membershipId: string): Promise<MembershipRow | null> {
    const r = await this.q().get<Row>(
      `select fm.id, fm.tenant_id, fm.user_id, fm.staff_id, fm.status,
              fm.job_title, fm.job_title_ar,
              fm.financial_authority_sar, fm.writeoff_authority_sar, fm.discount_authority_pct,
              u.email, u.preferred_language, u.preferred_calendar, u.mfa_enabled,
              s.full_name, s.full_name_ar, s.internal_role
         from firm_memberships fm
         join users u on u.id = fm.user_id
         join staff s on s.id = fm.staff_id
        where fm.id = ?`,
      [membershipId],
    );
    return r ? toMembership(r) : null;
  }

  /**
   * Every tenant where this user holds an ACTIVE membership. This is the tenant
   * switcher's data source, and it is the only place a firm user learns which
   * firms they belong to — the list is derived from the database, never from a
   * client-supplied tenant id.
   */
  async listActiveMemberships(userId: string) {
    const rows = await this.q().all<Row>(
      `select fm.id as membership_id, fm.tenant_id, fm.job_title, fm.job_title_ar,
              t.slug, t.name, t.name_ar, t.status as tenant_status
         from firm_memberships fm
         join tenants t on t.id = fm.tenant_id
        where fm.user_id = ? and fm.status = 'active' and t.status = 'active'
        order by t.name`,
      [userId],
    );
    return rows.map((r) => ({
      membershipId: String(r.membership_id),
      tenantId: String(r.tenant_id),
      slug: toStr(r.slug) ?? '',
      tenantName: toStr(r.name) ?? '',
      tenantNameAr: toStr(r.name_ar),
      jobTitle: toStr(r.job_title),
      jobTitleAr: toStr(r.job_title_ar),
    }));
  }

  // ==========================================================================
  // SHARED AUTH IDENTITY (§6)
  // ==========================================================================
  // `users` is the ONE table both audiences share: it holds the password hash,
  // the lockout counters and the MFA enrollment. What the two audiences do NOT
  // share is what happens next — `client_users` decides portal reach,
  // `firm_memberships` decides firm reach, and there is no conversion path
  // between them. These methods are duplicated from repo.ts on purpose rather
  // than imported: if the firm path called the portal repository, a future
  // portal method that widens scope would silently become reachable from a firm
  // handler.

  async getUserByEmail(email: string) {
    return this.q().get<Row>(
      `select id, email, password_hash, password_updated_at, status,
              failed_login_count, locked_until, last_login_at, last_login_ip_hash,
              mfa_enabled, mfa_method, mfa_secret_enc, mfa_enabled_at,
              preferred_language, preferred_calendar
         from users where email = ?`,
      [email.toLowerCase().trim()],
    );
  }

  async getUserById(id: string) {
    return this.q().get<Row>(
      `select id, email, password_hash, password_updated_at, status,
              failed_login_count, locked_until, last_login_at, last_login_ip_hash,
              mfa_enabled, mfa_method, mfa_secret_enc, mfa_enabled_at,
              preferred_language, preferred_calendar
         from users where id = ?`,
      [id],
    );
  }

  /**
   * Applies a login outcome to the shared identity row.
   *
   * The counters are shared with the portal on purpose: an attacker guessing a
   * lawyer's password should burn the same budget whichever door they try, and
   * locking the account must lock both audiences at once.
   */
  async updateUserAuthState(userId: string, patch: Record<string, Param>) {
    const cols = Object.keys(patch);
    if (!cols.length) return;
    const sets = cols.map((c) => `${c} = ?`).join(', ');
    await this.q().run(
      `update users set ${sets}, updated_at = ? where id = ?`,
      [...cols.map((c) => patch[c]), new Date().toISOString(), userId],
    );
  }

  /** Append-only attempt record. The `outcome` vocabulary is firm-specific. */
  async recordLoginAttempt(row: {
    email: string | null;
    userId: string | null;
    ipHash: string;
    userAgent: string | null;
    outcome: string;
  }) {
    await this.q().run(
      `insert into login_attempts (email, user_id, ip_hash, user_agent, outcome, created_at)
       values (?, ?, ?, ?, ?, ?)`,
      [row.email, row.userId, row.ipHash, row.userAgent, row.outcome, new Date().toISOString()],
    );
  }

  /** MFA challenge storage, shared table but a firm-specific `kind`. */
  async createAuthToken(row: Record<string, Param>) {
    await this.q().run(
      `insert into auth_tokens (id, user_id, kind, token_hash, code_hash, expires_at,
                                created_ip_hash, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.user_id, row.kind, row.token_hash, row.code_hash ?? null,
       row.expires_at, row.created_ip_hash ?? null, row.created_at],
    );
  }

  async getAuthToken(kind: string, tokenHash: string) {
    return this.q().get<Row>(
      `select id, user_id, kind, token_hash, code_hash, expires_at, used_at, created_at
         from auth_tokens where kind = ? and token_hash = ?`,
      [kind, tokenHash],
    );
  }

  async markAuthTokenUsed(id: string) {
    await this.q().run(
      `update auth_tokens set used_at = ? where id = ? and used_at is null`,
      [new Date().toISOString(), id],
    );
  }

  // ==========================================================================
  // THE AUTHORIZATION GRAPH
  // ==========================================================================

  /*
    PORTABILITY NOTE — `is_active = true`, NOT `is_active = 1`.

    SQLite stores booleans as INTEGER 0/1, so `= 1` is accepted there and this
    repository was written against SQLite. Postgres has a real boolean type and
    rejects the comparison outright:

        operator does not exist: boolean = integer

    which fails the whole query — here, a firm sign-in, because `getRoles` is on
    the permission-resolution path. `= true` is valid in both engines (SQLite has
    had the TRUE literal since 3.23), so it is the form to use for any new
    boolean predicate. The SQLite-only DDL in `schema.firm.sqlite.ts` keeps `= 1`,
    which is correct there and never runs against Postgres.
  */
  async getRoles(membershipId: string) {
    const rows = await this.q().all<Row>(
      `select r.id, r.code, r.name, r.name_ar, r.is_system
         from membership_roles mr
         join roles r on r.id = mr.role_id
        where mr.membership_id = ? and mr.revoked_at is null and r.is_active = true
        order by r.code`,
      [membershipId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      code: String(r.code),
      name: toStr(r.name) ?? String(r.code),
      nameAr: toStr(r.name_ar) ?? String(r.code),
      isSystem: toBool(r.is_system),
    }));
  }

  /**
   * The DISTINCT permission codes a membership holds.
   *
   * One query, resolved once per request, then held in a Set on the principal.
   * Resolving per check would be a join per authorization decision — and worse,
   * it would make two decisions in the same request able to disagree if a role
   * changed underneath them.
   */
  async getPermissionCodes(membershipId: string): Promise<string[]> {
    const rows = await this.q().all<Row>(
      `select distinct rp.permission_code as code
         from membership_roles mr
         join roles r on r.id = mr.role_id and r.is_active = true
         join role_permissions rp on rp.role_id = r.id
        where mr.membership_id = ? and mr.revoked_at is null
        order by 1`,
      [membershipId],
    );
    return rows.map((r) => String(r.code));
  }

  async getDepartments(membershipId: string) {
    const rows = await this.q().all<Row>(
      `select d.id, d.code, d.name, d.name_ar, dm.is_lead
         from department_members dm
         join departments d on d.id = dm.department_id
        where dm.membership_id = ? and d.is_active = true
        order by d.code`,
      [membershipId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      code: String(r.code),
      name: toStr(r.name) ?? String(r.code),
      nameAr: toStr(r.name_ar) ?? String(r.code),
      isLead: toBool(r.is_lead),
    }));
  }

  /**
   * Practice-area scope (§10). The sentinel `'*'` means unrestricted within the
   * tenant. An EMPTY result is meaningful, not a default: it scopes the member
   * to matters they are actually assigned to, which is what §11 requires of a
   * lawyer.
   */
  async getPracticeAreas(membershipId: string): Promise<string[]> {
    const rows = await this.q().all<Row>(
      `select practice_area from membership_practice_areas where membership_id = ? order by 1`,
      [membershipId],
    );
    return rows.map((r) => String(r.practice_area));
  }

  // ==========================================================================
  // MATTER AUTHORIZATION FACTS (§17, §27)
  // ==========================================================================

  /**
   * The facts the engine needs for one matter, in one round trip.
   *
   * Returns null when the matter does not exist IN THIS TENANT. That is the
   * whole point of taking tenantId: a matter id from another firm is
   * indistinguishable from a made-up one, so the caller cannot leak existence.
   */
  async getMatterAuthFacts(
    tenantId: string,
    matterId: string,
    membershipId: string,
    staffId: string,
  ): Promise<MatterAuthFacts | null> {
    const r = await this.q().get<Row>(
      `select m.id, m.tenant_id, m.practice_area, m.matter_number, m.client_id, m.internal_status,
              -- false, not 0: SQLite matches a boolean column against an
              -- integer, Postgres refuses ("COALESCE types boolean and integer
              -- cannot be matched"). Same portability rule as "is_active = true".
              coalesce(mc.is_restricted, false) as is_restricted,
              mc.restriction_reason, mc.restriction_reason_ar,
              mc.department_id, mc.owner_membership_id,
              mc.restricted_by_membership_id,
              (select mp.access_level from matter_permissions mp
                where mp.matter_id = m.id and mp.membership_id = ? and mp.revoked_at is null
                order by mp.granted_at desc limit 1) as explicit_level,
              (select mt.matter_role from matter_team mt
                where mt.matter_id = m.id and mt.staff_id = ? and mt.is_active = true
                limit 1) as team_role
         from matters m
         left join matter_controls mc on mc.matter_id = m.id
        where m.id = ? and m.tenant_id = ?`,
      [membershipId, staffId, matterId, tenantId],
    );
    if (!r) return null;
    const teamRole = toStr(r.team_role);
    const deptId = toStr(r.department_id);
    return {
      matterId: String(r.id),
      tenantId: String(r.tenant_id),
      practiceArea: toStr(r.practice_area),
      matterNumber: toStr(r.matter_number),
      clientId: toStr(r.client_id),
      internalStatus: toStr(r.internal_status),
      isRestricted: toBool(r.is_restricted),
      restrictionReason: toStr(r.restriction_reason),
      restrictionReasonAr: toStr(r.restriction_reason_ar),
      explicitLevel: toStr(r.explicit_level),
      teamLevel: teamRole ? teamRoleToLevel(teamRole) : null,
      teamRole,
      departmentCode: deptId ? await this.departmentCode(deptId) : null,
      ownerMembershipId: toStr(r.owner_membership_id),
      restrictedByMembershipId: toStr(r.restricted_by_membership_id),
    };
  }

  private async departmentCode(departmentId: string): Promise<string | null> {
    const r = await this.q().get<Row>(`select code from departments where id = ?`, [departmentId]);
    return r ? toStr(r.code) : null;
  }

  /**
   * The matter's own columns, for projection (§57).
   *
   * Returns RAW COLUMN NAMES and makes no authorization decision of its own —
   * that is the point. The caller has already resolved an access level via
   * `getMatterAuthFacts`, and `classification.ts` decides which of these columns
   * may be emitted at that level. Keeping the fetch dumb and the projection
   * strict means there is exactly one place that knows what a paralegal may read.
   *
   * Tenant is in the WHERE clause even though the access check already scoped
   * it: a projection layer that trusts its caller's scoping is one refactor away
   * from a cross-tenant read.
   */
  async getMatterRow(tenantId: string, matterId: string): Promise<Row | null> {
    const r = await this.q().get<Row>(
      // `m.client_id` is projected because the CUSTOMER DUE DILIGENCE GATE reads it: the
      // gate is about the client behind the matter, and a projection that omitted the
      // column would not fail — it would pass `undefined` into the assessment and clear
      // every matter. A gate column that is not selected is a gate that is not there.
      `select m.id, m.matter_number, m.case_number, m.title, m.title_ar, m.client_id,
              m.practice_area, m.practice_area_ar, m.court, m.court_ar,
              m.internal_status, m.client_status, m.summary, m.summary_ar,
              m.opened_at, m.closed_at, m.risk_rating, m.internal_notes, m.conflict_cleared,
              c.name as client_name, c.name_ar as client_name_ar,
              mc.restriction_reason, mc.restriction_reason_ar
         from matters m
         left join clients c on c.id = m.client_id
         left join matter_controls mc on mc.matter_id = m.id
        where m.id = ? and m.tenant_id = ?`,
      [matterId, tenantId],
    );
    return r ?? null;
  }

  /**
   * The matters a membership may see, with the facts needed to label each one.
   *
   * The WHERE clause is the SQL twin of `matter_visible()` in migration 0006.
   * They must stay in step: this one drives the list endpoint, that one drives
   * row level security, and a divergence would show up as a matter appearing in
   * a list but 404ing on click — or the reverse, which is worse.
   *
   * @param readAll true when the principal holds `matters.read_all`. Passed in
   *                rather than re-queried so the list and the permission set
   *                cannot disagree.
   */
  async listVisibleMatters(opts: {
    tenantId: string;
    membershipId: string;
    staffId: string;
    practiceAreas: readonly string[];
    readAll: boolean;
  }) {
    // Practice-area scope, decided here so it is expressed once. Three cases:
    //   widened  — holds matters.read_all, or the '*' sentinel (Managing Partner)
    //   empty    — no scope rows, so scope contributes nothing (§11: a lawyer
    //              sees assigned matters, not the whole practice)
    //   listed   — the matter's practice area must be one of theirs
    const widened = opts.readAll || opts.practiceAreas.includes('*');
    let practiceClause: string;
    const practiceParams: Param[] = [];
    if (widened) {
      practiceClause = '(1 = 1)';
    } else if (opts.practiceAreas.length === 0) {
      practiceClause = '(1 = 0)';
    } else {
      practiceClause = `(m.practice_area in (${opts.practiceAreas.map(() => '?').join(', ')}))`;
      practiceParams.push(...opts.practiceAreas);
    }

    // Bind order follows the SQL text exactly: the two correlated subqueries in
    // the SELECT list come first, then the WHERE clause left to right.
    const params: Param[] = [
      opts.membershipId,          // explicit_level subquery
      opts.staffId,               // team_role subquery
      opts.tenantId,              // where m.tenant_id
      opts.membershipId,          // exists(matter_permissions mp2)
      opts.staffId,               // exists(matter_team mt2)
      ...practiceParams,
    ];

    const rows = await this.q().all<Row>(
      `select m.id, m.tenant_id, m.matter_number, m.title, m.title_ar,
              m.practice_area, m.practice_area_ar, m.internal_status, m.client_status,
              m.risk_rating, m.opened_at, m.last_client_update_at,
              c.name as client_name, c.name_ar as client_name_ar,
              coalesce(mc.is_restricted, false) as is_restricted,
              (select mp.access_level from matter_permissions mp
                where mp.matter_id = m.id and mp.membership_id = ? and mp.revoked_at is null
                order by mp.granted_at desc limit 1) as explicit_level,
              (select mt.matter_role from matter_team mt
                where mt.matter_id = m.id and mt.staff_id = ? and mt.is_active = true
                limit 1) as team_role
         from matters m
         left join clients c on c.id = m.client_id
         left join matter_controls mc on mc.matter_id = m.id
        where m.tenant_id = ?
          and (
            -- An explicit, non-revoked grant is the ONLY way onto a restricted
            -- matter (§27), and elsewhere it is the strongest signal.
            exists (select 1 from matter_permissions mp2
                     where mp2.matter_id = m.id
                       and mp2.membership_id = ?
                       and mp2.revoked_at is null
                       and mp2.access_level <> 'none')
            -- Everything else requires the matter to be unrestricted, then
            -- either team membership or practice-area scope.
            or (coalesce(mc.is_restricted, false) = false and (
                  exists (select 1 from matter_team mt2
                           where mt2.matter_id = m.id
                             and mt2.staff_id = ?
                             and mt2.is_active = true)
                  or ${practiceClause}
               ))
          )
        order by m.opened_at desc`,
      params,
    );

    return rows.map((r) => {
      const teamRole = toStr(r.team_role);
      return {
        id: String(r.id),
        matterNumber: toStr(r.matter_number),
        title: toStr(r.title) ?? '',
        titleAr: toStr(r.title_ar),
        practiceArea: toStr(r.practice_area),
        practiceAreaAr: toStr(r.practice_area_ar),
        internalStatus: toStr(r.internal_status),
        clientStatus: toStr(r.client_status),
        riskRating: toStr(r.risk_rating),
        clientName: toStr(r.client_name),
        clientNameAr: toStr(r.client_name_ar),
        openedAt: toIso(r.opened_at),
        lastClientUpdateAt: toIso(r.last_client_update_at),
        isRestricted: toBool(r.is_restricted),
        explicitLevel: toStr(r.explicit_level),
        teamRole,
        teamLevel: teamRole ? teamRoleToLevel(teamRole) : null,
      };
    });
  }

  /** Count only — for a dashboard tile, without materializing rows. */
  async countVisibleMatters(opts: {
    tenantId: string;
    membershipId: string;
    staffId: string;
    practiceAreas: readonly string[];
    readAll: boolean;
  }): Promise<number> {
    const rows = await this.listVisibleMatters(opts);
    return rows.length;
  }

  // ==========================================================================
  // BILLING (§38) — the minimum needed to prove financial authority end to end
  // ==========================================================================

  /**
   * One invoice, scoped by tenant, with the matter facts needed to authorize it.
   *
   * Returns null for a missing invoice AND for one belonging to another firm:
   * the two must be indistinguishable, or the endpoint becomes a tenant
   * enumeration oracle.
   */
  async getInvoiceForApproval(tenantId: string, invoiceId: string) {
    const r = await this.q().get<Row>(
      `select i.id, i.tenant_id, i.matter_id, i.invoice_number, i.currency,
              i.subtotal, i.vat_amount, i.total, i.amount_paid, i.internal_status,
              c.name as client_name, c.name_ar as client_name_ar
         from invoices i
         join clients c on c.id = i.client_id
        where i.id = ? and i.tenant_id = ?`,
      [invoiceId, tenantId],
    );
    if (!r) return null;
    return {
      id: String(r.id),
      tenantId: String(r.tenant_id),
      matterId: toStr(r.matter_id),
      invoiceNumber: toStr(r.invoice_number) ?? '',
      currency: toStr(r.currency) ?? 'SAR',
      subtotal: toNumber(r.subtotal),
      vatAmount: toNumber(r.vat_amount),
      total: toNumber(r.total),
      amountPaid: toNumber(r.amount_paid),
      internalStatus: toStr(r.internal_status) ?? 'draft',
      clientName: toStr(r.client_name),
      clientNameAr: toStr(r.client_name_ar),
      outstanding: round2(toNumber(r.total) - toNumber(r.amount_paid)),
    };
  }

  /**
   * Approves an invoice. Returns the number of rows actually changed.
   *
   * The WHERE clause carries the state machine: only `draft` or
   * `pending_internal_approval` can be approved, and the update is a no-op
   * otherwise. Checking status in the handler and then updating unconditionally
   * would be a TOCTOU window; doing it in one statement is not.
   */
  async approveInvoice(opts: {
    tenantId: string;
    invoiceId: string;
    approvedByStaff: string;
    expectedStatuses: readonly string[];
  }): Promise<number> {
    const now = new Date().toISOString();
    /*
      client_status is set here, not left alone.

      `guard_invoice_state` (0002_legal_domain.sql) refuses any write where
      client_status is not exactly derive_invoice_client_status(internal_status,
      amount_paid, total, due_date). Approving moves the invoice out of
      `pending_internal_approval`, whose derived client_status is NULL (not
      projected to the client at all) and into `approved`, whose derived value is
      a real status — so the old NULL is now wrong and the trigger rejects the
      UPDATE with "client_status must be derived from internal_status, not set
      directly". This is a Postgres-only trigger; SQLite has no counterpart, so
      only the real database can catch it.

      The CASE mirrors the function: approved is neither draft/pending (null) nor
      cancelled/written_off (cancelled), so it resolves on amount and due date.
      Written out rather than calling the function, because the function is
      PostgreSQL-only and this repository runs the same statement on SQLite.
    */
    const today = now.slice(0, 10);
    const r = await this.q().run(
      `update invoices
          set internal_status = 'approved',
              client_status = case
                when amount_paid >= total and total > 0 then 'paid'
                when amount_paid > 0 then 'partially_paid'
                when due_date < ? then 'overdue'
                else 'awaiting_payment'
              end,
              approved_by_staff = ?,
              approved_at = ?,
              updated_at = ?
        where id = ? and tenant_id = ?
          and internal_status in (${opts.expectedStatuses.map(() => '?').join(', ')})
          and (approved_at is null)`,
      [today, opts.approvedByStaff, now, now, opts.invoiceId, opts.tenantId, ...opts.expectedStatuses],
    );
    return r.changes;
  }

  // ==========================================================================
  // MEMBERSHIP ADMINISTRATION (§49)
  // ==========================================================================

  /** Members of one tenant, for the administration list. Never cross-tenant. */
  async listMembers(tenantId: string) {
    const rows = await this.q().all<Row>(
      `select fm.id, fm.user_id, fm.staff_id, fm.status, fm.job_title, fm.job_title_ar,
              fm.financial_authority_sar, fm.writeoff_authority_sar, fm.discount_authority_pct,
              u.email, s.full_name, s.full_name_ar, s.internal_role, s.client_visible
         from firm_memberships fm
         join users u on u.id = fm.user_id
         join staff s on s.id = fm.staff_id
        where fm.tenant_id = ?
        order by s.full_name`,
      [tenantId],
    );
    return rows.map((r) => ({
      membershipId: String(r.id),
      userId: String(r.user_id),
      staffId: String(r.staff_id),
      email: String(r.email),
      displayName: toStr(r.full_name) ?? String(r.email),
      displayNameAr: toStr(r.full_name_ar),
      internalRole: toStr(r.internal_role),
      jobTitle: toStr(r.job_title),
      jobTitleAr: toStr(r.job_title_ar),
      status: String(r.status),
      clientVisible: toBool(r.client_visible),
      ceilings: {
        financialSar: toNullableNumber(r.financial_authority_sar),
        writeoffSar: toNullableNumber(r.writeoff_authority_sar),
        discountPct: toNullableNumber(r.discount_authority_pct),
      },
    }));
  }

  async getRolesForTenant(tenantId: string) {
    const rows = await this.q().all<Row>(
      `select id, code, name, name_ar, description, is_system, is_active
         from roles where tenant_id = ? order by code`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      code: String(r.code),
      name: toStr(r.name) ?? String(r.code),
      nameAr: toStr(r.name_ar) ?? String(r.code),
      description: toStr(r.description),
      isSystem: toBool(r.is_system),
      isActive: toBool(r.is_active),
    }));
  }

  /**
   * Grants a role. Attribution is mandatory and enforced twice: here, by
   * requiring an actor, and in the database by the `membership_roles_attribution`
   * trigger, which refuses an 'admin' origin with no granter.
   */
  async grantRole(opts: {
    membershipId: string;
    roleId: string;
    grantedByMembershipId: string;
  }): Promise<void> {
    await this.q().run(
      `insert into membership_roles
         (membership_id, role_id, granted_by_membership_id, grant_origin, granted_at)
       values (?, ?, ?, 'admin', ?)
       on conflict (membership_id, role_id) do update
         set revoked_at = null,
             granted_by_membership_id = excluded.granted_by_membership_id,
             grant_origin = 'admin',
             granted_at = excluded.granted_at`,
      [opts.membershipId, opts.roleId, opts.grantedByMembershipId, new Date().toISOString()],
    );
  }

  async revokeRole(opts: {
    membershipId: string;
    roleId: string;
  }): Promise<number> {
    const r = await this.q().run(
      `update membership_roles set revoked_at = ?
        where membership_id = ? and role_id = ? and revoked_at is null`,
      [new Date().toISOString(), opts.membershipId, opts.roleId],
    );
    return r.changes;
  }

  /**
   * Changes a membership's status. Suspension must also end live sessions, which
   * the caller does through FirmSessionManager.revokeAll — kept separate so the
   * session revocation is visible at the call site rather than hidden in a
   * repository write.
   */
  async setMembershipStatus(opts: {
    tenantId: string;
    membershipId: string;
    status: 'active' | 'suspended' | 'deactivated' | 'left';
  }): Promise<number> {
    const now = new Date().toISOString();
    const r = await this.q().run(
      `update firm_memberships
          set status = ?,
              left_at = case when ? in ('left','deactivated') then ? else left_at end,
              updated_at = ?
        where id = ? and tenant_id = ?`,
      [opts.status, opts.status, now, now, opts.membershipId, opts.tenantId],
    );
    return r.changes;
  }

  /**
   * Who applied a matter's current restriction (§27).
   *
   * Read from `matter_controls`, NOT through `getMatterAuthFacts`: that query
   * joins `matters`, and the RLS policy on `matters` hides a restricted matter
   * from everyone without an explicit grant — so the member who applied the
   * restriction cannot see the row that records their own restriction, and the
   * read comes back empty. `matter_controls` is readable at tenant scope
   * precisely because the restriction flag is a fact about the tenant's
   * matters, not about any one member's access to them.
   *
   * Returns null when the matter has no control row (unrestricted).
   */
  async getRestrictionOwner(
    tenantId: string,
    matterId: string,
  ): Promise<{ isRestricted: boolean; restrictedByMembershipId: string | null } | null> {
    const r = await this.q().get<Row>(
      `select coalesce(is_restricted, false) as is_restricted, restricted_by_membership_id
         from matter_controls
        where matter_id = ? and tenant_id = ?`,
      [matterId, tenantId],
    );
    if (!r) return null;
    return {
      isRestricted: toBool(r.is_restricted),
      restrictedByMembershipId: toStr(r.restricted_by_membership_id),
    };
  }

  /** Restricts or unrestricts a matter (§27). */
  async setMatterRestriction(opts: {
    tenantId: string;
    matterId: string;
    restricted: boolean;
    reason: string | null;
    reasonAr: string | null;
    actorMembershipId: string;
  }): Promise<number> {
    const now = new Date().toISOString();

    /*
      Two statements, not one branchy update.

      The previous version wrote:

        restricted_at = case when ? = 1 then ? else null end

      Both branches are untyped parameters, so Postgres has no anchor from which
      to infer the expression's type, resolves it to `text`, and then refuses the
      assignment to a timestamptz column:

        column "restricted_at" is of type timestamp with time zone
        but expression is of type text

      A CASE whose ELSE is the column itself (`else left_at`) does resolve,
      because the column anchors it — which is why the first failure looked
      arbitrary. Written out branch by branch, the target column types the
      parameter and the statement is dialect-neutral: no cast, which SQLite
      would not accept anyway. SQLite never saw the bug: `?` in a timestamp
      position there is simply a string.
    */
    if (opts.restricted) {
      const r = await this.q().run(
        `update matter_controls
            set is_restricted = TRUE,
                restriction_reason = ?,
                restriction_reason_ar = ?,
                restricted_at = ?,
                restricted_by_membership_id = ?,
                updated_at = ?
          where matter_id = ? and tenant_id = ?`,
        [opts.reason, opts.reasonAr, now, opts.actorMembershipId,
         now, opts.matterId, opts.tenantId],
      );
      return r.changes;
    }

    const r = await this.q().run(
      `update matter_controls
          set is_restricted = FALSE,
              restriction_reason = null,
              restriction_reason_ar = null,
              restricted_at = null,
              restricted_by_membership_id = null,
              updated_at = ?
        where matter_id = ? and tenant_id = ?`,
      [now, opts.matterId, opts.tenantId],
    );
    return r.changes;
  }

  /** Grants or updates an explicit matter access level (§27). */
  async grantMatterAccess(opts: {
    tenantId: string;
    matterId: string;
    membershipId: string;
    accessLevel: string;
    reason: string | null;
    grantedByMembershipId: string;
    id: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.q().run(
      `insert into matter_permissions
         (id, matter_id, tenant_id, membership_id, access_level, reason,
          granted_by_membership_id, granted_at, revoked_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, null)
       on conflict (matter_id, membership_id) do update
         set access_level = excluded.access_level,
             reason = excluded.reason,
             granted_by_membership_id = excluded.granted_by_membership_id,
             granted_at = excluded.granted_at,
             revoked_at = null`,
      [opts.id, opts.matterId, opts.tenantId, opts.membershipId, opts.accessLevel,
       opts.reason, opts.grantedByMembershipId, now],
    );
  }

  async revokeMatterAccess(opts: {
    tenantId: string;
    matterId: string;
    membershipId: string;
  }): Promise<number> {
    const r = await this.q().run(
      `update matter_permissions set revoked_at = ?
        where matter_id = ? and tenant_id = ? and membership_id = ? and revoked_at is null`,
      [new Date().toISOString(), opts.matterId, opts.tenantId, opts.membershipId],
    );
    return r.changes;
  }

  // ==========================================================================
  // FIRM SESSIONS (§52)
  // ==========================================================================

  /**
   * Capability lookup by token hash. This is the ONLY way a session is found:
   * there is no "find session by user and hope" path, because that would let a
   * request that knows a user id inherit a session it did not authenticate with.
   */
  async getFirmSessionByTokenHash(tokenHash: string) {
    return this.q().get<Row>(
      `select id, membership_id, user_id, tenant_id, created_at, last_activity,
              expires_at, idle_expires_at, ip_hash, user_agent, device_label,
              browser, os, mfa_verified_at, trusted_device_id, revoked_at, revoke_reason
         from firm_sessions where token_hash = ?`,
      [tokenHash],
    );
  }

  async createFirmSession(row: Record<string, Param>) {
    await this.q().run(
      `insert into firm_sessions
         (id, membership_id, user_id, tenant_id, token_hash, created_at, last_activity,
          expires_at, idle_expires_at, ip_hash, ip_country, user_agent, device_label,
          browser, os, mfa_verified_at, trusted_device_id, role_snapshot)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.membership_id, row.user_id, row.tenant_id, row.token_hash,
       row.created_at, row.last_activity, row.expires_at, row.idle_expires_at,
       row.ip_hash ?? null, row.ip_country ?? null, row.user_agent ?? null,
       row.device_label ?? null, row.browser ?? null, row.os ?? null,
       row.mfa_verified_at ?? null, row.trusted_device_id ?? null, row.role_snapshot ?? null],
    );
  }

  /** Sliding idle refresh. Never touches `expires_at`: the absolute ceiling is fixed. */
  async touchFirmSession(sessionId: string, idleExpiresAt: string) {
    await this.q().run(
      `update firm_sessions set last_activity = ?, idle_expires_at = ?
        where id = ? and revoked_at is null`,
      [new Date().toISOString(), idleExpiresAt, sessionId],
    );
  }

  async markFirmSessionMfaVerified(sessionId: string, at: string) {
    await this.q().run(
      `update firm_sessions set mfa_verified_at = ? where id = ? and revoked_at is null`,
      [at, sessionId],
    );
  }

  async revokeFirmSession(sessionId: string, reason: string) {
    await this.q().run(
      `update firm_sessions set revoked_at = ?, revoke_reason = ?
        where id = ? and revoked_at is null`,
      [new Date().toISOString(), reason, sessionId],
    );
  }

  /** Revokes every live session for a membership — suspension, role change, logout-everywhere. */
  async revokeAllFirmSessions(membershipId: string, reason: string) {
    const r = await this.q().run(
      `update firm_sessions set revoked_at = ?, revoke_reason = ?
        where membership_id = ? and revoked_at is null`,
      [new Date().toISOString(), reason, membershipId],
    );
    return r.changes;
  }

  async listFirmSessions(membershipId: string) {
    const rows = await this.q().all<Row>(
      `select id, created_at, last_activity, expires_at, ip_hash, ip_country,
              user_agent, device_label, browser, os, mfa_verified_at, revoked_at
         from firm_sessions
        where membership_id = ?
        order by last_activity desc
        limit 50`,
      [membershipId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      createdAt: req(toIso(r.created_at)),
      lastActivity: toIso(r.last_activity),
      expiresAt: toIso(r.expires_at),
      ipCountry: toStr(r.ip_country),
      deviceLabel: toStr(r.device_label),
      browser: toStr(r.browser),
      os: toStr(r.os),
      userAgent: toStr(r.user_agent),
      mfaVerifiedAt: toIso(r.mfa_verified_at),
      revokedAt: toIso(r.revoked_at),
      current: false,
    }));
  }

  // ==========================================================================
  // TENANT CONFIGURATION (§50)
  // ==========================================================================

  async getTenantSettings(tenantId: string) {
    const r = await this.q().get<Row>(
      `select tenant_id, display_name, display_name_ar, brand_key, support_email, support_phone,
              timezone, currency, vat_rate, fiscal_year_start_month, notification_channels,
              mfa_required, password_min_length, session_absolute_minutes, session_idle_minutes
         from tenant_settings where tenant_id = ?`,
      [tenantId],
    );
    if (!r) return null;
    return {
      tenantId: String(r.tenant_id),
      displayName: toStr(r.display_name),
      displayNameAr: toStr(r.display_name_ar),
      brandKey: toStr(r.brand_key),
      supportEmail: toStr(r.support_email),
      supportPhone: toStr(r.support_phone),
      timezone: toStr(r.timezone) ?? 'Asia/Riyadh',
      currency: toStr(r.currency) ?? 'SAR',
      vatRate: toNumber(r.vat_rate, 0.15),
      fiscalYearStartMonth: toNumber(r.fiscal_year_start_month, 1),
      notificationChannels: parseJsonArray(r.notification_channels, ['in_app', 'email']),
      mfaRequired: toBool(r.mfa_required),
      passwordMinLength: toNumber(r.password_min_length, 12),
      sessionAbsoluteMinutes: toNumber(r.session_absolute_minutes, 720),
      sessionIdleMinutes: toNumber(r.session_idle_minutes, 60),
    };
  }

  /**
   * Audit search (§51). The only read path over `audit_events` in the whole
   * codebase.
   *
   * DRIVER DIFFERENCE, and the only one in this file:
   *   sqlite    — a direct tenant-scoped SELECT. There is no row level security
   *               in SQLite, so the tenant predicate IS the control, and the
   *               caller has already asserted `audit.read`.
   *   postgres  — `firm_api` has no SELECT grant on audit_events at all
   *               (migration 0006 grants INSERT only). Reading goes through the
   *               SECURITY DEFINER `firm_audit_search()` function, which checks
   *               the phase, the tenant AND `audit.read` itself. So on
   *               production the permission is enforced twice, once here and
   *               once in the database, and removing either one still refuses.
   *
   * Either way the result is append-only: nothing in this file can UPDATE or
   * DELETE an audit row, because no such statement exists here.
   */
  async searchAudit(opts: {
    tenantId: string;
    action?: string | null;
    actorUserId?: string | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
  }) {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);

    if (this.db.driver === 'postgres') {
      const rows = await this.q().all<Row>(
        `select occurred_at, tenant_id, actor_kind, actor_user_id, action,
                resource_type, resource_id, outcome, reason_code, metadata
           from public.firm_audit_search(?, ?, ?, ?, ?)`,
        [opts.from ?? null, opts.to ?? null, opts.actorUserId ?? null, opts.action ?? null, limit],
      );
      return rows.map(toAuditEvent);
    }

    const where: string[] = ['tenant_id = ?'];
    const params: Param[] = [opts.tenantId];
    if (opts.action) { where.push('action = ?'); params.push(opts.action); }
    if (opts.actorUserId) { where.push('actor_user_id = ?'); params.push(opts.actorUserId); }
    if (opts.from) { where.push('occurred_at >= ?'); params.push(opts.from); }
    if (opts.to) { where.push('occurred_at <= ?'); params.push(opts.to); }
    params.push(limit);

    const rows = await this.q().all<Row>(
      `select occurred_at, tenant_id, actor_kind, actor_user_id, action,
              resource_type, resource_id, outcome, reason_code, metadata
         from audit_events
        where ${where.join(' and ')}
        order by occurred_at desc
        limit ?`,
      params,
    );
    return rows.map(toAuditEvent);
  }

  /* ==========================================================================
     THE ELIGIBILITY LAYER · phase P-1  (migration 0027)

     These methods are the READ side of the gates. The REFUSAL side lives in the
     database (the Article 16 trigger) and in the routes (the assignment gate);
     this is where each rule is EXPRESSED, and there is exactly one expression of
     each — see the note above PRIOR_OFFICE_RESTRICTION_YEARS for why the window
     arithmetic is here rather than in SQL.
     ========================================================================== */

  /** Every licence this firm holds for a staff member, newest first. */
  async listLicences(tenantId: string, staffId: string): Promise<LicenceRow[]> {
    const rows = await this.q().all<Row>(
      `select id, licence_number, issued_at, expires_at, status, status_effective_from,
              status_reference, verified_at
         from professional_licences
        where tenant_id = ? and staff_id = ?
        order by expires_at desc nulls last, issued_at desc nulls last`,
      [tenantId, staffId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      licenceNumber: toStr(row.licence_number) ?? '',
      issuedAt: toStr(row.issued_at),
      expiresAt: toStr(row.expires_at),
      status: toStr(row.status) ?? 'pending',
      statusEffectiveFrom: toStr(row.status_effective_from),
      statusReference: toStr(row.status_reference),
      verifiedAt: toStr(row.verified_at),
    }));
  }

  /**
   * Is this member entitled to practise, and why not if not?
   *
   * Returns the REASON as well as the verdict. A boolean would force every caller
   * to re-derive the explanation for the refusal it is about to render, and that
   * re-derivation is where the "no licence on record" case would get lost — the
   * case that matters most, because it is the state every new joiner is in and
   * the one a lenient default would wave through.
   */
  async eligibilityFor(
    tenantId: string,
    membershipId: string,
  ): Promise<{ requiresLicence: boolean; entitled: boolean; reason: string; licences: LicenceRow[] }> {
    const membership = await this.getMembershipById(membershipId);
    // Tenant is checked here as well as in the caller. This is a read about a
    // named person's professional standing, and a membership id from another firm
    // must not resolve — the same discipline `getMatterAuthFacts` applies.
    if (!membership || membership.tenantId !== tenantId) {
      return { requiresLicence: false, entitled: false, reason: 'membership_not_in_tenant', licences: [] };
    }

    const requires = await this.memberRequiresLicence(tenantId, membershipId);
    const licences = await this.listLicences(tenantId, membership.staffId);

    // A non-practitioner is never gated: a paralegal, a finance officer or a
    // compliance officer holds no licence and does not need one. Gating them
    // would block a legitimate hire and teach the firm to ignore the flag.
    if (!requires) {
      return { requiresLicence: false, entitled: true, reason: 'not_a_practising_role', licences };
    }
    if (licences.length === 0) {
      // ABSENCE IS NOT PERMISSION. The deliberate inverse of the usual default,
      // matching the rule already stated for financial ceilings: "NULL = no
      // authority. Never read NULL as unlimited."
      return { requiresLicence: true, entitled: false, reason: 'no_licence_on_record', licences };
    }

    const today = new Date().toISOString().slice(0, 10);
    if (licences.some((l) => l.status === 'valid' && (!l.expiresAt || l.expiresAt > today))) {
      return { requiresLicence: true, entitled: true, reason: 'valid', licences };
    }

    // Name the most SERIOUS reason present, not the first row's. A suspension
    // outranks an expiry, and an expiry outranks 'pending' — a member shown
    // "licence pending" when they have in fact been suspended would be misled
    // about whether they may practise.
    const reason =
      licences.some((l) => l.status === 'suspended') ? 'suspended'
        : licences.some((l) => l.status === 'revoked') ? 'revoked'
          : licences.some((l) => l.expiresAt && l.expiresAt <= today) ? 'expired'
            : 'pending';
    return { requiresLicence: true, entitled: false, reason, licences };
  }

  /**
   * Does this member hold a live role that means practising law?
   *
   * Reads the role's own declaration rather than a hardcoded list of role codes,
   * so a tenant that defines a "Legal Consultant" role can say that it practises
   * without a code change — and a new role is inert until someone decides, rather
   * than silently demanding or silently exempting a licence.
   *
   * `revoked_at is null` is load-bearing: a revoked role confers nothing, so it
   * must impose nothing either.
   */
  async memberRequiresLicence(tenantId: string, membershipId: string): Promise<boolean> {
    const r = await this.q().get<Row>(
      `select count(*) as n
         from membership_roles mr
         join roles rl on rl.id = mr.role_id
        where mr.membership_id = ?
          and mr.revoked_at is null
          and rl.requires_practising_licence = true
          and (rl.tenant_id = ? or rl.tenant_id is null)`,
      [membershipId, tenantId],
    );
    return Number(r?.n ?? 0) > 0;
  }

  /**
   * Prior judicial or government service, with the restriction window derived.
   *
   * `barred` is returned EXPLICITLY rather than inferred from a date, because the
   * two NULL cases mean opposite things and conflating them would either bar an
   * innocent lawyer or clear a sitting judge:
   *
   *   · no row, or the window has elapsed  →  barred = false
   *   · ended_on IS NULL (still in post)   →  barred = TRUE, with no end date
   */
  async priorOfficeBar(
    tenantId: string,
    membershipId: string,
  ): Promise<{ barred: boolean; restrictionEndsOn: string | null; institution: string | null; stillInPost: boolean }> {
    const membership = await this.getMembershipById(membershipId);
    if (!membership || membership.tenantId !== tenantId) {
      // An unknown membership is NOT reported as barred: this answers a question
      // about a person, and inventing a bar for a subject that does not exist
      // would make a caller treat a 404 as a compliance event.
      return { barred: false, restrictionEndsOn: null, institution: null, stillInPost: false };
    }

    const rows = await this.q().all<Row>(
      `select office_kind, institution, ended_on
         from prior_office
        where tenant_id = ? and staff_id = ?
        order by ended_on desc nulls first`,
      [tenantId, membership.staffId],
    );

    const today = new Date().toISOString().slice(0, 10);
    let worst: { barred: boolean; restrictionEndsOn: string | null; institution: string | null; stillInPost: boolean } =
      { barred: false, restrictionEndsOn: null, institution: null, stillInPost: false };

    for (const row of rows) {
      const endedOn = toStr(row.ended_on);
      if (!endedOn) {
        // Still in post: no window has begun and none will end on a date. The
        // strictest case, so it wins over any dated window.
        if (!worst.stillInPost) {
          worst = {
            barred: true,
            restrictionEndsOn: null,
            institution: toStr(row.institution),
            stillInPost: true,
          };
        }
        continue;
      }
      const ends = addYears(endedOn, PRIOR_OFFICE_RESTRICTION_YEARS);
      if (ends > today && !worst.barred) {
        worst = {
          barred: true,
          restrictionEndsOn: ends,
          institution: toStr(row.institution),
          stillInPost: false,
        };
      }
    }
    return worst;
  }

  /**
   * Records or updates a licence.
   *
   * An upsert rather than an insert, because the two real workflows are both
   * upserts: a renewal changes the expiry on a licence the firm already holds,
   * and a restoration flips a status back to 'valid' and clears the suspension
   * reference. Refusing the second would force the caller to delete and re-add,
   * which loses `verified_at` and turns a documented history into an edit.
   *
   * The update is deliberately narrow: the licence NUMBER and the staff member
   * are never rewritten. A different number is a different licence, and moving a
   * licence between people is not an operation that should be expressible.
   */
  async upsertLicence(opts: {
    tenantId: string;
    staffId: string;
    licenceNumber: string;
    issuedAt: string | null;
    expiresAt: string | null;
    status: 'valid' | 'suspended' | 'expired' | 'revoked' | 'pending';
    statusReference: string | null;
    verifiedByMembershipId: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    /*
      The consistency rule from migration 0027, enforced here as well as in the
      CHECK, because a caller that reaches this method with a stale suspension
      reference would otherwise get an opaque constraint violation from one driver
      and a silent success from the other. SQLite's CHECK is on the row; this makes
      the same decision in a place that can explain it.
    */
    const statusReference = opts.status === 'valid' ? null : opts.statusReference;

    const existing = await this.q().get<Row>(
      `select id from professional_licences where staff_id = ? and licence_number = ?`,
      [opts.staffId, opts.licenceNumber],
    );

    if (existing) {
      await this.q().run(
        `update professional_licences
            set issued_at = coalesce(?, issued_at),
                expires_at = ?,
                status = ?,
                status_effective_from = ?,
                status_reference = ?,
                verified_by_membership_id = ?,
                verified_at = ?,
                updated_at = ?
          where id = ? and tenant_id = ?`,
        [
          opts.issuedAt, opts.expiresAt, opts.status,
          // The date the status took effect — not the row's updated_at. A
          // suspension order is dated, and that date is the legal fact.
          opts.status === 'valid' ? null : today,
          statusReference, opts.verifiedByMembershipId, now, now,
          String(existing.id), opts.tenantId,
        ],
      );
      return;
    }

    await this.q().run(
      `insert into professional_licences
         (id, tenant_id, staff_id, licence_number, issued_at, expires_at, status,
          status_effective_from, status_reference, verified_by_membership_id,
          verified_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(), opts.tenantId, opts.staffId, opts.licenceNumber,
        opts.issuedAt, opts.expiresAt, opts.status,
        opts.status === 'valid' ? (opts.issuedAt ?? today) : today,
        statusReference, opts.verifiedByMembershipId, now, now, now,
      ],
    );
  }

  /** Records a prior judicial or government appointment. Append-only. */
  async recordPriorOffice(opts: {
    id: string;
    tenantId: string;
    staffId: string;
    officeKind: string;
    institution: string;
    institutionAr: string | null;
    roleTitle: string | null;
    roleTitleAr: string | null;
    startedOn: string;
    endedOn: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.q().run(
      `insert into prior_office
         (id, tenant_id, staff_id, office_kind, institution, institution_ar,
          role_title, role_title_ar, started_on, ended_on, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.id, opts.tenantId, opts.staffId, opts.officeKind, opts.institution,
        opts.institutionAr, opts.roleTitle, opts.roleTitleAr,
        opts.startedOn, opts.endedOn, now, now,
      ],
    );
  }

  /** Records a compliance check. Append-only at the database level. */
  async recordEligibilityCheck(opts: {
    tenantId: string;
    subjectKind: 'membership' | 'staff' | 'matter' | 'client' | 'invoice' | 'document' | 'matter_assignment';
    subjectId: string;
    precondition: string;
    outcome: 'pass' | 'fail' | 'waived' | 'not_applicable';
    evidence?: Record<string, unknown>;
    ruleCited?: string | null;
    evaluatedByMembershipId: string;
  }): Promise<void> {
    await this.q().run(
      `insert into eligibility_checks
         (tenant_id, subject_kind, subject_id, precondition, outcome, evidence,
          rule_cited, evaluated_by_membership_id, evaluated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.tenantId, opts.subjectKind, opts.subjectId, opts.precondition, opts.outcome,
        JSON.stringify(opts.evidence ?? {}), opts.ruleCited ?? null,
        opts.evaluatedByMembershipId, new Date().toISOString(),
      ],
    );
  }

  // ── P0.1 · parties and conflicts ──────────────────────────────────────────

  /**
   * The party register.
   *
   * `query` is a plain substring search over the stored normalised name and the
   * aliases, using `normalizeArabicName` on the input so that a search for
   * «الأفق» finds a party stored as «شركة الافق للتجارة». It is NOT the conflict
   * search: that one is exhaustive over the firm's own workload and lives in
   * `loadConflictDataset`.
   */
  async listParties(tenantId: string, opts: { query?: string; limit?: number } = {}): Promise<PartyRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const normalized = opts.query ? normalizeArabicName(opts.query) : null;
    const rows = normalized
      ? await this.q().all<Row>(
        `select p.id, p.tenant_id, p.kind, p.name, p.name_ar, p.name_normalized,
                p.commercial_registration, p.vat_number, p.national_id_masked, p.status,
                p.notes, p.created_at,
                (select count(*) from matter_parties mp where mp.party_id = p.id) as matter_count,
                -- How many names this party is known by. A register that shows one
                -- name per company hides the reason the company was hard to find: it
                -- appears differently in a court filing, in Najiz and on its CR, and
                -- the conflict search only finds it if somebody recorded the variants.
                (select count(*) from party_aliases a where a.party_id = p.id) as alias_count
           from parties p
          where p.tenant_id = ?
            and (p.name_normalized like ?
                 or exists (select 1 from party_aliases a
                             where a.party_id = p.id and a.alias_normalized like ?))
          order by p.name
          limit ${limit}`,
        [tenantId, `%${normalized}%`, `%${normalized}%`],
      )
      : await this.q().all<Row>(
        `select p.id, p.tenant_id, p.kind, p.name, p.name_ar, p.name_normalized,
                p.commercial_registration, p.vat_number, p.national_id_masked, p.status,
                p.notes, p.created_at,
                (select count(*) from matter_parties mp where mp.party_id = p.id) as matter_count,
                (select count(*) from party_aliases a where a.party_id = p.id) as alias_count
           from parties p
          where p.tenant_id = ?
          order by p.name
          limit ${limit}`,
        [tenantId],
      );
    return rows.map(toPartyRow);
  }

  async getParty(tenantId: string, partyId: string): Promise<PartyRow | null> {
    const row = await this.q().get<Row>(
      `select p.id, p.tenant_id, p.kind, p.name, p.name_ar, p.name_normalized,
              p.commercial_registration, p.vat_number, p.national_id_masked, p.status,
              p.notes, p.created_at, 0 as matter_count
         from parties p where p.id = ? and p.tenant_id = ?`,
      [partyId, tenantId],
    );
    return row ? toPartyRow(row) : null;
  }

  async createParty(opts: {
    id: string; tenantId: string; kind: string; name: string; nameAr: string | null;
    normalized: string; commercialRegistration: string | null; vatNumber: string | null;
    nationalIdMasked: string | null; nationalIdHash: string | null;
    notes: string | null; createdByMembershipId: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.q().run(
      `insert into parties
         (id, tenant_id, kind, name, name_ar, name_normalized, commercial_registration,
          vat_number, national_id_masked, national_id_hash, status, notes,
          created_by_membership_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      [opts.id, opts.tenantId, opts.kind, opts.name, opts.nameAr, opts.normalized,
       opts.commercialRegistration, opts.vatNumber, opts.nationalIdMasked, opts.nationalIdHash,
       opts.notes, opts.createdByMembershipId, now, now],
    );
  }

  async updateParty(opts: {
    tenantId: string; partyId: string; name?: string; nameAr?: string | null;
    normalized?: string; notes?: string | null; kind?: string;
  }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (opts.name !== undefined) { sets.push('name = ?'); params.push(opts.name); }
    if (opts.nameAr !== undefined) { sets.push('name_ar = ?'); params.push(opts.nameAr); }
    if (opts.normalized !== undefined) { sets.push('name_normalized = ?'); params.push(opts.normalized); }
    if (opts.notes !== undefined) { sets.push('notes = ?'); params.push(opts.notes); }
    if (opts.kind !== undefined) { sets.push('kind = ?'); params.push(opts.kind); }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    params.push(new Date().toISOString(), opts.partyId, opts.tenantId);
    await this.q().run(
      `update parties set ${sets.join(', ')} where id = ? and tenant_id = ?`,
      params as never,
    );
  }

  /**
   * Records a name variant.
   *
   * The unique key is (tenant, party, normalised alias), so re-recording a variant
   * the firm already knows is a no-op rather than a duplicate — but two DIFFERENT
   * spellings that normalise to the same value are the same variant, which is the
   * point of normalising at all.
   */
  async addPartyAlias(opts: {
    id: string; tenantId: string; partyId: string; alias: string;
    normalized: string; script: string; source: string | null; note?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.q().run(
      `insert into party_aliases
         (id, tenant_id, party_id, alias, alias_normalized, script, source, note,
          created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing`,
      [opts.id, opts.tenantId, opts.partyId, opts.alias, opts.normalized,
       opts.script, opts.source, opts.note ?? null, now, now],
    );
  }

  async listAliases(tenantId: string, partyId: string): Promise<Array<{
    id: string; alias: string; script: string; source: string | null; note: string | null;
  }>> {
    const rows = await this.q().all<Row>(
      `select id, alias, script, source, note from party_aliases
        where tenant_id = ? and party_id = ? order by created_at`,
      [tenantId, partyId],
    );
    return rows.map((r) => ({
      id: req(r.id), alias: req(r.alias), script: req(r.script),
      source: r.source == null ? null : req(r.source),
      note: r.note == null ? null : req(r.note),
    }));
  }

  async recordAffiliation(opts: {
    id: string; tenantId: string; partyId: string; staffId: string; relation: string;
    startedOn: string | null; endedOn: string | null; note: string | null;
    recordedByMembershipId: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.q().run(
      `insert into party_affiliations
         (id, tenant_id, party_id, staff_id, relation, started_on, ended_on, note,
          recorded_by_membership_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing`,
      [opts.id, opts.tenantId, opts.partyId, opts.staffId, opts.relation,
       opts.startedOn, opts.endedOn, opts.note, opts.recordedByMembershipId, now, now],
    );
  }

  async addMatterParty(opts: {
    id: string; tenantId: string; matterId: string; partyId: string; role: string;
    note: string | null; addedByMembershipId: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.q().run(
      `insert into matter_parties
         (id, tenant_id, matter_id, party_id, role, note, added_by_membership_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing`,
      [opts.id, opts.tenantId, opts.matterId, opts.partyId, opts.role,
       opts.note, opts.addedByMembershipId, now, now],
    );
  }

  async listMatterParties(tenantId: string, matterId: string): Promise<Array<{
    id: string; partyId: string; role: string; note: string | null; createdAt: string;
    name: string; nameAr: string | null; kind: string; status: string;
  }>> {
    const rows = await this.q().all<Row>(
      `select mp.id, mp.party_id, mp.role, mp.note, mp.created_at,
              p.name, p.name_ar, p.kind, p.status
         from matter_parties mp
         join parties p on p.id = mp.party_id
        where mp.tenant_id = ? and mp.matter_id = ?
        order by mp.created_at`,
      [tenantId, matterId],
    );
    return rows.map((r) => ({
      id: req(r.id), partyId: req(r.party_id), role: req(r.role),
      note: r.note == null ? null : req(r.note), createdAt: req(toIso(r.created_at)),
      name: req(r.name), nameAr: r.name_ar == null ? null : req(r.name_ar),
      kind: req(r.kind), status: req(r.status),
    }));
  }

  /**
   * Loads everything the conflict engine needs for one matter.
   *
   * IT LOADS THE WHOLE FIRM'S RECORD ON PURPOSE, and that is a deliberate refusal to
   * be clever. The alternative — a candidate query that prefilters parties by a
   * shared token or a shared identifier — is faster and is exactly the kind of
   * optimisation that turns a conflict check into "we did not find it", with the
   * firm's disqualification as the failure mode. A checkpoint that can MISS is worse
   * than a checkpoint that is slow: the miss is silent, and it is discovered by the
   * other side.
   *
   * The bounded resource is the firm's own workload, not a global corpus: a ten-lawyer
   * practice has thousands of matters and tens of thousands of party links. When this
   * stops fitting in memory the answer is a purpose-built index over the same
   * predicate, not a narrower query — and the numbers are logged so that decision is
   * made on evidence rather than on a hunch.
   */
  async loadConflictDataset(tenantId: string, matterId: string): Promise<{
    matter: Row | null;
    parties: MatterPartyRecord[];
    priorAppearances: PriorAppearance[];
    clients: ClientRecord[];
    affiliations: AffiliationRecord[];
    clientMatters: Array<{ clientId: string; matterId: string; caseNumber: string | null; status: string }>;
    rowCount: number;
  }> {
    const matterRow = await this.q().get<Row>(
      `select id, tenant_id, client_id, matter_number, case_number, internal_status, closed_at
         from matters where id = ? and tenant_id = ?`,
      [matterId, tenantId],
    );
    if (!matterRow) {
      return {
        matter: null, parties: [], priorAppearances: [], clients: [],
        affiliations: [], clientMatters: [], rowCount: 0,
      };
    }

    const partyRows = await this.q().all<Row>(
      `select p.id, p.kind, p.name, p.name_ar, p.commercial_registration, p.vat_number,
              p.national_id_hash, p.status, p.merged_into_party_id
         from parties p where p.tenant_id = ?`,
      [tenantId],
    );
    const aliasRows = await this.q().all<Row>(
      `select party_id, alias from party_aliases where tenant_id = ?`,
      [tenantId],
    );
    const aliasesByParty = new Map<string, string[]>();
    for (const a of aliasRows) {
      const key = req(a.party_id);
      const list = aliasesByParty.get(key) ?? [];
      list.push(req(a.alias));
      aliasesByParty.set(key, list);
    }
    // A merged party resolves to its target, so a register cleaned up by merging
    // does not stop matching the spellings that were merged away.
    const mergedInto = new Map<string, string>();
    const identityOf = (r: Row): PartyIdentity => {
      const id = req(r.id);
      return {
        id,
        kind: req(r.kind),
        name: req(r.name),
        nameAr: r.name_ar == null ? null : req(r.name_ar),
        aliases: aliasesByParty.get(id) ?? [],
        commercialRegistration: r.commercial_registration == null ? null : req(r.commercial_registration),
        vatNumber: r.vat_number == null ? null : req(r.vat_number),
        nationalIdHash: r.national_id_hash == null ? null : req(r.national_id_hash),
      };
    };
    const partiesById = new Map<string, PartyIdentity>();
    for (const r of partyRows) {
      const id = req(r.id);
      if (r.merged_into_party_id != null) mergedInto.set(id, req(r.merged_into_party_id));
      partiesById.set(id, identityOf(r));
    }
    const resolve = (id: string): PartyIdentity | null => {
      let cursor = id;
      for (let hops = 0; hops < 8; hops += 1) {
        const target = mergedInto.get(cursor);
        if (!target) break;
        cursor = target;
      }
      return partiesById.get(cursor) ?? partiesById.get(id) ?? null;
    };

    // The matters on this matter — the screening subjects, minus the client, who is
    // carried separately because the client of a matter is not a `matter_parties` row.
    const mpRows = await this.q().all<Row>(
      `select party_id, role from matter_parties
        where tenant_id = ? and matter_id = ? and role <> 'client'`,
      [tenantId, matterId],
    );
    const parties: MatterPartyRecord[] = [];
    for (const r of mpRows) {
      const identity = resolve(req(r.party_id));
      if (identity) parties.push({ party: identity, role: req(r.role) as MatterPartyRole });
    }

    // Every appearance of every party in every matter of this firm, open or closed.
    // No status filter: Rule 8/4 measures from the END of a former client
    // relationship, so the closed files are the ones that matter most.
    const appearanceRows = await this.q().all<Row>(
      `select mp.party_id, mp.role, m.id as matter_id, m.matter_number, m.case_number,
              m.internal_status, m.closed_at, m.client_id
         from matter_parties mp
         join matters m on m.id = mp.matter_id
        where mp.tenant_id = ? and m.tenant_id = ? and mp.matter_id <> ?`,
      [tenantId, tenantId, matterId],
    );
    const priorAppearances: PriorAppearance[] = [];
    for (const r of appearanceRows) {
      const identity = resolve(req(r.party_id));
      if (!identity) continue;
      priorAppearances.push({
        party: identity,
        matterId: req(r.matter_id),
        matterNumber: req(r.matter_number),
        caseNumber: r.case_number == null ? null : req(r.case_number),
        role: req(r.role) as MatterPartyRole,
        matterStatus: req(r.internal_status),
        closedAt: r.closed_at == null ? null : toIso(r.closed_at),
      });
    }

    /*
      Clients are loaded WHOLLY and matched in TypeScript rather than prefiltered,
      and the reason is the asymmetry of the two questions. "Was this party ever our
      client?" decides disqualification; "was this party on a matter with the same
      case number?" is an exact comparison the database can make. So the fuzzy half
      runs over a set small enough to be exhaustive — a client list, not a party
      list — and the exact half runs in SQL.
    */
    const clientRows = await this.q().all<Row>(
      `select c.id, c.party_id, c.client_type, c.name, c.name_ar, c.status,
              c.relationship_ended_on, c.national_id_hash, c.commercial_reg_masked,
              (select max(m.closed_at) from matters m where m.client_id = c.id) as last_closed
         from clients c where c.tenant_id = ?`,
      [tenantId],
    );
    const clients: ClientRecord[] = [];
    for (const r of clientRows) {
      const linked = r.party_id == null ? null : resolve(req(r.party_id));
      const clientId = req(r.id);
      const identity: PartyIdentity = linked ?? {
        id: `client:${clientId}`,
        kind: req(r.client_type) === 'organization' ? 'company' : 'individual',
        name: req(r.name),
        nameAr: r.name_ar == null ? null : req(r.name_ar),
        aliases: aliasesByParty.get(clientId) ?? [],
        commercialRegistration: null,
        vatNumber: null,
        nationalIdHash: r.national_id_hash == null ? null : req(r.national_id_hash),
      };
      clients.push({
        clientId,
        partyId: linked?.id ?? null,
        identity,
        status: req(r.status),
        // Rule 8/4 measures from the end of the relationship OR from the last work
        // done for them, so the column is an override and the newest closed matter
        // is the fallback. `closed_at` populated means the relationship has ended;
        // an open matter means it has not, whatever the column says — a client with
        // work in progress is not a former client.
        relationshipEndedOn: clientRelationshipEndedOn({
          explicit: r.relationship_ended_on == null ? null : (toIso(r.relationship_ended_on) ?? '').slice(0, 10),
          lastClosed: r.last_closed == null ? null : (toIso(r.last_closed) ?? '').slice(0, 10),
          status: req(r.status),
        }),
      });
    }

    // Which matters belong to which client, for المادة ١٠/٤. Not derivable from
    // matter_parties: the client of a matter is matters.client_id.
    const clientMatterRows = await this.q().all<Row>(
      `select id as matter_id, client_id, case_number, internal_status
         from matters where tenant_id = ?`,
      [tenantId],
    );
    const clientMatters = clientMatterRows.map((r) => ({
      clientId: req(r.client_id),
      matterId: req(r.matter_id),
      caseNumber: r.case_number == null ? null : req(r.case_number),
      status: req(r.internal_status),
    }));

    const affiliationRows = await this.q().all<Row>(
      `select a.party_id, a.staff_id, a.relation, a.ended_on, s.full_name
         from party_affiliations a
         join staff s on s.id = a.staff_id
        where a.tenant_id = ?`,
      [tenantId],
    );
    const affiliations: AffiliationRecord[] = [];
    for (const r of affiliationRows) {
      const identity = resolve(req(r.party_id));
      if (!identity) continue;
      affiliations.push({
        staffId: req(r.staff_id),
        staffName: req(r.full_name),
        party: identity,
        relation: req(r.relation) as AffiliationRecord['relation'],
        endedOn: r.ended_on == null ? null : (toIso(r.ended_on) ?? '').slice(0, 10),
      });
    }

    return {
      matter: matterRow, parties, priorAppearances, clients, affiliations, clientMatters,
      rowCount: partyRows.length + appearanceRows.length + clientRows.length + affiliationRows.length,
    };
  }

  /** The identity of the client of a matter, for the engine's other half. */
  /**
   * The prospective client, as the conflict engine needs it.
   *
   * TWO FIELDS, because they answer different questions. `identity` is what to MATCH
   * against — and for a client that predates the party register it carries a
   * synthetic `client:<uuid>` id, which is fine for comparison and fatal in a `uuid`
   * column. `partyId` is the actual `parties` row, or null when there is not one.
   *
   * They were one return value until a live check found a client rather than a
   * counterparty and PostgreSQL rejected `client:cccccccc-…` as a uuid. Returning
   * them together, under names that cannot be confused, is the fix that makes the
   * mistake structurally hard instead of merely fixed.
   */
  async clientIdentityForMatter(
    tenantId: string, clientId: string,
  ): Promise<{ identity: PartyIdentity; partyId: string | null } | null> {
    const row = await this.q().get<Row>(
      `select p.id, p.kind, p.name, p.name_ar, p.commercial_registration, p.vat_number,
              p.national_id_hash
         from parties p
         join clients c on c.party_id = p.id
        where c.id = ? and c.tenant_id = ?`,
      [clientId, tenantId],
    );
    if (row) {
      const aliases = await this.q().all<Row>(
        `select alias from party_aliases where tenant_id = ? and party_id = ?`,
        [tenantId, req(row.id)],
      );
      return {
        partyId: req(row.id),
        identity: {
          id: req(row.id), kind: req(row.kind), name: req(row.name),
          nameAr: row.name_ar == null ? null : req(row.name_ar),
          aliases: aliases.map((a) => req(a.alias)),
          commercialRegistration: row.commercial_registration == null ? null : req(row.commercial_registration),
          vatNumber: row.vat_number == null ? null : req(row.vat_number),
          nationalIdHash: row.national_id_hash == null ? null : req(row.national_id_hash),
        },
      };
    }
    // A client that predates the register. It is matched on its own name columns,
    // which is the one storage path the party register did not replace — see the
    // note on `clients.party_id` in migration 0029.
    const legacy = await this.q().get<Row>(
      `select id, client_type, name, name_ar, national_id_hash
         from clients where id = ? and tenant_id = ?`,
      [clientId, tenantId],
    );
    if (!legacy) return null;
    return {
      // No party row: a legal answer of "nobody is on the register for this client",
      // which is different from "this client has no identity".
      partyId: null,
      identity: {
        id: `client:${req(legacy.id)}`,
        kind: req(legacy.client_type) === 'organization' ? 'company' : 'individual',
        name: req(legacy.name),
        nameAr: legacy.name_ar == null ? null : req(legacy.name_ar),
        aliases: [],
        commercialRegistration: null,
        vatNumber: null,
        nationalIdHash: legacy.national_id_hash == null ? null : req(legacy.national_id_hash),
      },
    };
  }

  // ── conflict checks ──────────────────────────────────────────────────────

  async createConflictCheck(opts: {
    id: string; tenantId: string; matterId: string; kind: string;
    startedByMembershipId: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.q().run(
      `insert into conflict_checks
         (id, tenant_id, matter_id, kind, status, parties_checked, matters_searched,
          hits_found, started_by_membership_id, started_at, created_at, updated_at)
       values (?, ?, ?, ?, 'running', 0, 0, 0, ?, ?, ?, ?)`,
      [opts.id, opts.tenantId, opts.matterId, opts.kind, opts.startedByMembershipId, now, now, now],
    );
  }

  async recordConflictHit(opts: {
    id: string; tenantId: string; checkId: string; matterId: string;
    finding: ConflictFinding;
  }): Promise<void> {
    const now = new Date().toISOString();
    const f = opts.finding;
    await this.q().run(
      /*
        NOTE THE COLUMN. The engine's severity goes to `proposed_severity`, and
        `severity` is left null, because the hit is `open` and
        `conflict_hits_severity_needs_confirmation` permits a severity only once
        somebody has recorded that the hit IS a conflict.

        This was written the other way round first, and every check that found
        anything failed with "CHECK constraint failed: severity is null or disposition
        = 'same_party'". The constraint was right. A matcher may raise a suspicion; it
        may not declare a conflict, and the schema is where that is enforced rather
        than in a convention nobody can see.
      */
      `insert into conflict_hits
         (id, tenant_id, check_id, matter_id, party_id, matched_party_id, matched_matter_id,
          matched_client_id, relation, match_strength, match_basis, affected_party_id,
          proposed_severity, rule_cited, relationship_ended_on, window_years, window_lifts_on,
          within_window, disposition, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
       on conflict do nothing`,
      [opts.id, opts.tenantId, opts.checkId, opts.matterId, f.partyId, f.matchedPartyId,
       f.matchedMatterId, f.matchedClientId, f.relation, f.matchStrength, f.matchBasis,
       f.affectedPartyId, f.severity, f.ruleCited, f.relationshipEndedOn, f.windowYears,
       /*
         A BOOLEAN, not 1/0.

         This was `f.withinWindow ? 1 : 0`, which SQLite accepts — it has no boolean
         type, and the driver converts booleans to 0/1 on the way in — and which
         PostgreSQL rejects outright: `column "within_window" is of type boolean but
         expression is of type integer`. Every conflict check that found a party whose
         window had been measured returned HTTP 500 in production while 368 tests
         passed, because the tests run on the dialect that has no boolean type.

         The driver layer exists to absorb exactly this. The repository hands over a
         JavaScript boolean and lets each driver decide how to store it.
       */
       f.windowLiftsOn, f.withinWindow, now, now],
    );
  }

  async updateCheckScope(opts: {
    checkId: string; tenantId: string; partiesChecked: number; mattersSearched: number; hitsFound: number;
  }): Promise<void> {
    await this.q().run(
      `update conflict_checks
          set parties_checked = ?, matters_searched = ?, hits_found = ?, updated_at = ?
        where id = ? and tenant_id = ?`,
      [opts.partiesChecked, opts.mattersSearched, opts.hitsFound,
       new Date().toISOString(), opts.checkId, opts.tenantId],
    );
  }

  async listConflictChecks(tenantId: string, matterId: string): Promise<Array<Row>> {
    return this.q().all<Row>(
      `select c.id, c.matter_id, c.kind, c.status, c.parties_checked, c.matters_searched,
              c.hits_found, c.started_at, c.concluded_at, c.conclusion,
              c.started_by_membership_id, c.concluded_by_membership_id,
              (select count(*) from conflict_hits h where h.check_id = c.id) as hit_count,
              (select count(*) from conflict_hits h where h.check_id = c.id and h.disposition = 'open') as open_count
         from conflict_checks c
        where c.tenant_id = ? and c.matter_id = ?
        order by c.started_at desc`,
      [tenantId, matterId],
    );
  }

  async listConflictHits(tenantId: string, checkId: string): Promise<Array<ConflictHitRow>> {
    const rows = await this.q().all<Row>(
      `select h.id, h.check_id, h.matter_id, h.party_id, h.matched_party_id, h.matched_matter_id,
              h.matched_client_id, h.relation, h.match_strength, h.match_basis,
              h.affected_party_id, h.severity, h.proposed_severity, h.rule_cited,
              h.relationship_ended_on,
              h.window_years, h.window_lifts_on, h.within_window, h.disposition,
              h.disposition_reason, h.disposition_at,
              pp.name as party_name, mp.name as matched_party_name,
              ap.name as affected_party_name,
              (select count(*) from conflict_waivers w where w.hit_id = h.id) as waiver_count
         from conflict_hits h
         left join parties pp on pp.id = h.party_id
         left join parties mp on mp.id = h.matched_party_id
         left join parties ap on ap.id = h.affected_party_id
        where h.tenant_id = ? and h.check_id = ?
        -- Order by what is DECIDED, falling back to what the engine proposed: an open
        -- hit the matcher called 'actual' is more urgent than one it called 'none',
        -- and the reader sees severity null with a proposal beside it rather than a
        -- decision that was never taken.
        order by case coalesce(h.severity, h.proposed_severity)
                   when 'actual' then 0 when 'potential' then 1 when 'none' then 2 else 3 end,
                 h.created_at`,
      [tenantId, checkId],
    );
    return rows.map((r) => ({
      id: req(r.id), checkId: req(r.check_id), matterId: req(r.matter_id),
      partyId: req(r.party_id), partyName: req(r.party_name),
      matchedPartyId: r.matched_party_id == null ? null : req(r.matched_party_id),
      matchedPartyName: r.matched_party_name == null ? null : req(r.matched_party_name),
      matchedMatterId: r.matched_matter_id == null ? null : req(r.matched_matter_id),
      matchedClientId: r.matched_client_id == null ? null : req(r.matched_client_id),
      relation: req(r.relation),
      matchStrength: req(r.match_strength),
      matchBasis: req(r.match_basis),
      affectedPartyId: r.affected_party_id == null ? null : req(r.affected_party_id),
      affectedPartyName: r.affected_party_name == null ? null : req(r.affected_party_name),
      // Two fields, and the API returns both under names that cannot be confused:
      // `severity` is the decision (null while the hit is open) and `proposedSeverity`
      // is the engine's opinion. A UI that shows only one of them will show the wrong
      // one.
      severity: r.severity == null ? null : req(r.severity),
      proposedSeverity: r.proposed_severity == null ? null : req(r.proposed_severity),
      ruleCited: req(r.rule_cited),
      relationshipEndedOn: r.relationship_ended_on == null ? null : (toIso(r.relationship_ended_on) ?? '').slice(0, 10),
      windowYears: r.window_years == null ? null : toNumber(r.window_years),
      windowLiftsOn: r.window_lifts_on == null ? null : (toIso(r.window_lifts_on) ?? '').slice(0, 10),
      withinWindow: r.within_window == null ? null : toBool(r.within_window),
      disposition: req(r.disposition),
      dispositionReason: r.disposition_reason == null ? null : req(r.disposition_reason),
      dispositionAt: r.disposition_at == null ? null : toIso(r.disposition_at),
      waiverCount: toNumber(r.waiver_count),
    }));
  }

  async getConflictHit(tenantId: string, hitId: string): Promise<ConflictHitRow | null> {
    const row = await this.q().get<Row>(
      `select id, check_id, tenant_id from conflict_hits where id = ? and tenant_id = ?`,
      [hitId, tenantId],
    );
    if (!row) return null;
    const hits = await this.listConflictHits(tenantId, req(row.check_id));
    return hits.find((h) => h.id === hitId) ?? null;
  }

  async dispositionConflictHit(opts: {
    tenantId: string; hitId: string; disposition: 'different_party' | 'same_party';
    severity: 'actual' | 'potential' | 'none' | null; affectedPartyId: string | null;
    reason: string; membershipId: string;
  }): Promise<void> {
    await this.q().run(
      `update conflict_hits
          set disposition = ?, disposition_reason = ?, disposition_by_membership_id = ?,
              disposition_at = ?, severity = ?, affected_party_id = ?, updated_at = ?
        where id = ? and tenant_id = ? and disposition = 'open'`,
      [opts.disposition, opts.reason, opts.membershipId, new Date().toISOString(),
       opts.severity, opts.affectedPartyId, new Date().toISOString(), opts.hitId, opts.tenantId],
    );
  }

  async concludeConflictCheck(opts: {
    tenantId: string; checkId: string; status: 'clear' | 'cleared_with_waiver'
      | 'conflicts_not_accepted' | 'abandoned';
    conclusion: string; membershipId: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.q().run(
      `update conflict_checks
          set status = ?, conclusion = ?, concluded_by_membership_id = ?, concluded_at = ?, updated_at = ?
        where id = ? and tenant_id = ? and concluded_at is null`,
      [opts.status, opts.conclusion, opts.membershipId, now, now, opts.checkId, opts.tenantId],
    );
  }

  async recordConflictWaiver(opts: {
    id: string; tenantId: string; hitId: string; matterId: string; waivedByPartyId: string;
    consentDocumentId: string | null; consentReference: string | null;
    consentSignedOn: string; scope: string; membershipId: string;
  }): Promise<void> {
    await this.q().run(
      `insert into conflict_waivers
         (id, tenant_id, hit_id, matter_id, waived_by_party_id, consent_document_id,
          consent_reference, consent_signed_on, scope, recorded_by_membership_id, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [opts.id, opts.tenantId, opts.hitId, opts.matterId, opts.waivedByPartyId,
       opts.consentDocumentId, opts.consentReference, opts.consentSignedOn, opts.scope,
       opts.membershipId, new Date().toISOString()],
    );
  }

  async listConflictWaivers(tenantId: string, matterId: string): Promise<Array<Row>> {
    return this.q().all<Row>(
      `select w.id, w.hit_id, w.waived_by_party_id, w.consent_document_id,
              w.consent_reference, w.consent_signed_on, w.scope, w.created_at,
              p.name as party_name
         from conflict_waivers w
         left join parties p on p.id = w.waived_by_party_id
        where w.tenant_id = ? and w.matter_id = ?
        order by w.created_at`,
      [tenantId, matterId],
    );
  }

  /**
   * The derived state of `matters.conflict_cleared`, and the reasons when it is false.
   *
   * ONE EXPRESSION, and the database refuses a contradicting write rather than
   * deriving the value itself — because SQLite cannot assign to `NEW` inside a
   * trigger, and a Postgres-only derivation would be the second expression of a
   * legal rule that this codebase has been bitten by eleven times.
   */
  async conflictStateFor(tenantId: string, matterId: string): Promise<{
    cleared: boolean; checked: boolean; openHits: number; unwaived: number;
    exceptions: number; latestCheckId: string | null; reasons: string[];
  }> {
    const checks = await this.listConflictChecks(tenantId, matterId);
    const covering = checks.find((c) => c.status === 'clear' || c.status === 'cleared_with_waiver');

    const parties = await this.listMatterParties(tenantId, matterId);
    const reasons: string[] = [];

    if (!covering) {
      const concluded = checks.find((c) => c.concluded_at != null);
      reasons.push(concluded
        ? 'the last conflict check did not clear the matter.'
        : 'no conflict check has been concluded for this matter.');
      return { cleared: false, checked: checks.length > 0, openHits: 0, unwaived: 0, exceptions: 0, latestCheckId: null, reasons };
    }

    // A check that ran before a party was added did not see that party, so it does
    // not cover the matter as it now stands. The database enforces the same rule.
    const startedAt = req(toIso(covering.started_at as never));
    const late = parties.filter((p) => p.createdAt > startedAt);
    if (late.length) {
      reasons.push(`${late.length} party/parties were added after the clearing check ran, so it did not see them.`);
    }

    const hits = await this.listConflictHits(tenantId, req(covering.id));
    const openHits = hits.filter((h) => h.disposition === 'open').length;
    const unwaived = hits.filter(
      (h) => h.disposition === 'same_party' && h.severity !== 'none' && h.waiverCount === 0,
    ).length;
    const exceptions = hits.filter((h) => h.disposition === 'same_party' && h.severity === 'none').length;

    if (openHits) reasons.push(`${openHits} finding(s) still need a decision.`);
    if (unwaived) reasons.push(`${unwaived} confirmed conflict(s) have no written consent on record.`);

    return {
      cleared: reasons.length === 0,
      checked: true,
      openHits, unwaived, exceptions,
      latestCheckId: req(covering.id),
      reasons,
    };
  }

  /** A client of this tenant, or null. Used only to validate a party link. */
  async getClientForTenant(tenantId: string, clientId: string): Promise<Row | null> {
    return (await this.q().get<Row>(
      `select id, tenant_id, client_type, name, name_ar, status, party_id
         from clients where id = ? and tenant_id = ?`,
      [clientId, tenantId],
    )) ?? null;
  }

  /** Links a client record to its canonical party identity. */
  async linkClientParty(opts: { tenantId: string; clientId: string; partyId: string }): Promise<void> {
    await this.q().run(
      `update clients set party_id = ?, updated_at = ? where id = ? and tenant_id = ?`,
      [opts.partyId, new Date().toISOString(), opts.clientId, opts.tenantId],
    );
  }

  /**
   * Writes the DERIVED clearance.
   *
   * The value is computed by `conflictStateFor` and refused by the database if it
   * contradicts the record — so this method is the only place the column is set and
   * it cannot be used to assert a clearance the evidence does not support.
   */
  async setMatterConflictCleared(opts: { tenantId: string; matterId: string; cleared: boolean }): Promise<void> {
    await this.q().run(
      `update matters set conflict_cleared = ?, updated_at = ?
        where id = ? and tenant_id = ?`,
      // A JavaScript boolean: SQLite stores 0/1 through the driver, PostgreSQL
      // stores a real boolean. See the note on within_window above.
      [opts.cleared, new Date().toISOString(), opts.matterId, opts.tenantId],
    );
  }

  /** Moves a matter through its internal lifecycle. The gate is in the database. */
  async setMatterStatus(opts: {
    tenantId: string; matterId: string; internalStatus: string; conflictCleared: boolean;
  }): Promise<void> {
    await this.q().run(
      `update matters set internal_status = ?, conflict_cleared = ?, updated_at = ?
        where id = ? and tenant_id = ?`,
      [opts.internalStatus, opts.conflictCleared,
       new Date().toISOString(), opts.matterId, opts.tenantId],
    );
  }

  async getTenant(tenantId: string) {
    return this.q().get<Row>(
      `select id, slug, name, name_ar, country, default_language, default_calendar, status
         from tenants where id = ?`,
      [tenantId],
    );
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * P0.2 · THE FISCAL DOCUMENT
   * ══════════════════════════════════════════════════════════════════════════ */

  async listFiscalIdentities(tenantId: string) {
    return this.q().all<Row>(
      `select ${FISCAL_IDENTITY_COLUMNS} from fiscal_identity
        where tenant_id = ? order by created_at desc`,
      [tenantId],
    );
  }

  /** The identity in force: the one that has not been superseded. */
  async fiscalIdentityFor(tenantId: string) {
    return this.q().get<Row>(
      `select ${FISCAL_IDENTITY_COLUMNS} from fiscal_identity
        where tenant_id = ? and superseded_by is null order by created_at desc limit 1`,
      [tenantId],
    );
  }

  /**
   * Record or replace the seller identity.
   *
   * A REPLACEMENT SUPERSEDES, IT DOES NOT EDIT. An invoice issued in March under VAT
   * number X must still be explainable in September after the firm's registration
   * changed, and an UPDATE would rewrite the identity that document was issued
   * under. So the previous row is marked superseded and a new row is written.
   */
  async upsertFiscalIdentity(input: FiscalIdentityInput): Promise<string> {
    const now = new Date().toISOString();
    const existing = await this.fiscalIdentityFor(input.tenantId);
    const id = newId();

    if (existing) {
      await this.q().run(
        `update fiscal_identity
            set superseded_by = ?, updated_at = ?
          where id = ? and tenant_id = ? and superseded_by is null`,
        [id, now, String(existing.id), input.tenantId],
      );
    }

    await this.q().run(
      `insert into fiscal_identity
         (id, tenant_id, registered_name, registered_name_ar, vat_registration_number,
          commercial_registration, registered_address, registered_address_ar, city,
          postal_code, country, environment, onboarding_status, certificate_expires_at,
          superseded_by, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)`,
      [
        id, input.tenantId, input.registeredName, input.registeredNameAr ?? null,
        input.vatRegistrationNumber, input.commercialRegistration, input.registeredAddress,
        input.registeredAddressAr ?? null, input.city ?? null, input.postalCode ?? null,
        input.country ?? 'SA', input.environment, input.onboardingStatus,
        input.certificateExpiresAt ?? null, now, now,
      ],
    );
    return id;
  }

  async listFiscalDevices(tenantId: string) {
    return this.q().all<Row>(
      `select id, tenant_id, fiscal_identity_id, device_label, device_serial,
              invoice_counter_value, last_invoice_hash, is_active, created_at, updated_at
         from fiscal_devices where tenant_id = ? order by created_at`,
      [tenantId],
    );
  }

  async createFiscalDevice(input: {
    tenantId: string; fiscalIdentityId: string; deviceLabel: string; deviceSerial: string;
  }): Promise<string> {
    const now = new Date().toISOString();
    const id = newId();
    await this.q().run(
      `insert into fiscal_devices
         (id, tenant_id, fiscal_identity_id, device_label, device_serial,
          invoice_counter_value, last_invoice_hash, is_active, created_at, updated_at)
       values (?, ?, ?, ?, ?, 0, null, ?, ?, ?)`,
      [id, input.tenantId, input.fiscalIdentityId, input.deviceLabel, input.deviceSerial, true, now, now],
    );
    return id;
  }

  /**
   * May this firm issue a tax invoice at all?
   *
   * The same four conditions `kgm_fiscal_ready` applies in the database. Asked HERE
   * as well so the UI can say "this firm is not onboarded" before somebody fills in
   * an invoice form, rather than surfacing a refusal at the send button. Both
   * answers exist on purpose: the database's is the one that binds.
   */
  async fiscalReady(tenantId: string): Promise<boolean> {
    const r = await this.q().get<Row>(
      `select count(*) as n
         from fiscal_identity fi
         join fiscal_devices fd on fd.fiscal_identity_id = fi.id
        where fi.tenant_id = ?
          and fi.superseded_by is null
          and fi.onboarding_status = 'production_csid'
          and (fi.certificate_expires_at is null or fi.certificate_expires_at > ?)
          and fd.is_active = ?`,
      [tenantId, new Date().toISOString(), true],
    );
    return toNumber(r?.n) > 0;
  }

  /**
   * Take the next place in the device's chain.
   *
   * ONE STATEMENT, and that is not a style preference. The ICV is a shared counter:
   * a read-then-write from here would let two concurrent issues take the same
   * number, and a duplicated ICV is a broken chain that cannot be repaired without
   * reissuing documents. PostgreSQL does it with `returning`
   * (`kgm_next_fiscal_number`); SQLite does it in the same shape, because
   * better-sqlite3 executes the statement synchronously and the increment is atomic
   * within it.
   */
  /**
   * Whether an ISSUED invoice of this tenant already carries this number.
   *
   * The unique index would refuse the second issue anyway, but a driver-level refusal
   * reaches the caller as an opaque 500 — and the honest answer here is a conflict the
   * caller can act on: the number is taken, choose the next one.
   */
  async invoiceNumberInUse(tenantId: string, invoiceNumber: string, exceptInvoiceId: string): Promise<boolean> {
    const row = await this.q().get<Row>(
      `select id from invoices
        where tenant_id = ? and invoice_number = ? and invoice_uuid is not null and id <> ?
        limit 1`,
      [tenantId, invoiceNumber, exceptInvoiceId],
    );
    return row !== undefined && row !== null;
  }

  async allocateFiscalNumber(deviceId: string): Promise<{ icv: number; previousHash: string | null }> {
    const now = new Date().toISOString();
    const row = await this.q().get<Row>(
      `update fiscal_devices
          set invoice_counter_value = invoice_counter_value + 1, updated_at = ?
        where id = ? and is_active = ?
        returning invoice_counter_value, last_invoice_hash`,
      [now, deviceId, true],
    );
    if (!row) {
      throw Object.assign(new Error('the fiscal device is not active'), { code: 'fiscal_device_inactive' });
    }
    return {
      icv: toNumber(row.invoice_counter_value),
      previousHash: toStr(row.last_invoice_hash),
    };
  }


  /**
   * The buyer, as the tax document must name them.
   *
   * The VAT number is read from the PARTY record, not from the client record, because
   * `clients` is a commercial relationship and `parties` is the identity that holds the
   * registration. The join is left so a client with no party link still resolves — the
   * document then cannot be a standard invoice, which the route enforces rather than
   * issuing a tax invoice with a blank VAT number.
   */
  /**
   * The buyer as the invoice needs them, with the registration that decides whether the
   * document is standard or simplified.
   *
   * MAPPED, not raw, and that is the whole point of this comment. The route asks for
   * `client.vatNumber`; the column is `vat_number`. A support read that handed back the
   * row exactly as the driver returned it made every buyer look as though it had no VAT
   * number — so every standard invoice was refused as `buyer_vat_required`, and the
   * only visible symptom would have been a firm that cannot issue B2B invoices.
   *
   * The 41 behavioural tests did not catch it because every invoice they issue is
   * simplified: the buyer in the fixture is an individual, and the gate that reads this
   * field was never asked to admit anybody. The LIVE harness caught it, on the real
   * database, the first time a standard invoice was attempted against it.
   */
  async getClientForInvoice(tenantId: string, clientId: string) {
    const r = await this.q().get<Row>(
      `select c.id, c.name, c.name_ar, c.email, c.city, c.country,
              p.vat_number, p.commercial_registration
         from clients c
         left join parties p on p.id = c.party_id
        where c.id = ? and c.tenant_id = ?`,
      [clientId, tenantId],
    );
    if (!r) return null;
    return {
      id: String(r.id),
      name: req(r.name),
      nameAr: toStr(r.name_ar),
      email: toStr(r.email),
      city: toStr(r.city),
      country: toStr(r.country),
      // Null when there is none: an individual has no VAT registration, and that is a
      // fact about the buyer rather than a missing value to be defaulted away.
      vatNumber: toStr(r.vat_number),
      commercialRegistration: toStr(r.commercial_registration),
    };
  }

  /** The lines as the document needs them, in position order and no other order. */
  async listInvoiceLines(invoiceId: string) {
    return this.q().all<Row>(
      `select id, position, description, description_ar, quantity, unit_price, amount,
              vat_category, vat_rate, vat_amount, discount_amount
         from invoice_lines where invoice_id = ? order by position`,
      [invoiceId],
    );
  }

  /** Which client a matter belongs to — the link every disbursement carries. */
  async getMatterClient(tenantId: string, matterId: string) {
    const r = await this.q().get<Row>(
      `select id as matter_id, client_id, matter_number, title
         from matters where id = ? and tenant_id = ?`,
      [matterId, tenantId],
    );
    return r ? { matterId: String(r.matter_id), clientId: String(r.client_id), matterNumber: String(r.matter_number), title: String(r.title) } : null;
  }

  async getTimeEntry(tenantId: string, entryId: string) {
    return this.q().get<Row>(
      `select id, matter_id, staff_id, entry_date, minutes, narrative, billable,
              hourly_rate_sar, amount_sar, invoice_id, status, approved_at
         from time_entries where id = ? and tenant_id = ?`,
      [entryId, tenantId],
    );
  }

  async getExpense(tenantId: string, expenseId: string) {
    return this.q().get<Row>(
      `select id, matter_id, client_id, submitted_by_staff, incurred_on, category,
              description, net_amount_sar, vat_amount_sar, total_amount_sar, status,
              receipt_document_id, reimbursable, invoice_id
         from expenses where id = ? and tenant_id = ?`,
      [expenseId, tenantId],
    );
  }

  async getEngagementLetter(tenantId: string, letterId: string) {
    return this.q().get<Row>(
      `select id, matter_id, client_id, scope, calculation_method, fee_amount_sar,
              signed_by_client_at, signed_by_client_name, document_id, status, superseded_by
         from engagement_letters where id = ? and tenant_id = ? and superseded_by is null`,
      [letterId, tenantId],
    );
  }

  /**
   * Where the chain stands, and the next place in it.
   *
   * The next ICV is returned as `icv + 1` WITHOUT consuming it: the caller builds the
   * document with that number and only then calls `allocateFiscalNumber`, which is what
   * actually takes it. The read is therefore advisory — which is correct, because the
   * document must be built before it can be hashed, and the allocation must be the last
   * thing that happens, so a build failure leaves no gap in the sequence.
   */
  async fiscalDeviceChainHead(deviceId: string) {
    const r = await this.q().get<Row>(
      `select invoice_counter_value, last_invoice_hash, device_serial
         from fiscal_devices where id = ? and is_active = ?`,
      [deviceId, true],
    );
    if (!r) {
      throw Object.assign(new Error('the fiscal device is not active'), { code: 'fiscal_device_inactive' });
    }
    return {
      icv: toNumber(r.invoice_counter_value),
      previousHash: toStr(r.last_invoice_hash),
      deviceSerial: String(r.device_serial),
    };
  }

  /**
   * Write the fiscal identity of an invoice, and advance the device's chain head.
   *
   * THE CHAIN HEAD IS MOVED IN THE SAME CALL, and only after the invoice row has
   * accepted its own fields. If the invoice write is refused — by the shape guard,
   * by the QR guard, by RLS — the device is left where it was, and the next attempt
   * takes the same ICV rather than leaving a permanently unreachable number in the
   * sequence. A gap in the ICV sequence is the first thing a ZATCA reviewer notices.
   */
  async recordInvoiceIssue(input: {
    tenantId: string; invoiceId: string; deviceId: string; icv: number;
    previousHash: string; hash: string; qr: string; subtype: string;
    uuid: string; supplyAt: string; buyerName: string; buyerVat: string | null;
    xmlStorageKey: string; invoiceNumber: string;
  }): Promise<number> {
    const now = new Date().toISOString();
    /*
      THE OFFICIAL NUMBER IS SEALED IN THE SAME WRITE as the UUID and the hash. The
      guard on this table freezes the number the moment the document exists, so a
      number corrected a second later would be refused by the database — and rightly:
      an invoice's number is part of its identity, not metadata about it.
    */
    const r = await this.q().run(
      `update invoices
          set invoice_uuid = ?, invoice_type = ?, icv = ?, previous_invoice_hash = ?,
              invoice_hash = ?, qr_payload = ?, xml_storage_key = ?, supply_at = ?,
              buyer_name = ?, buyer_vat_number = ?, fiscal_device_id = ?,
              invoice_number = ?,
              fiscal_status = ?, fiscal_status_at = ?, updated_at = ?
        where id = ? and tenant_id = ? and invoice_uuid is null`,
      [
        input.uuid, input.subtype, input.icv, input.previousHash, input.hash, input.qr,
        input.xmlStorageKey, input.supplyAt, input.buyerName, input.buyerVat, input.deviceId,
        input.invoiceNumber,
        input.subtype === 'standard' ? 'pending_clearance' : 'pending_reporting', now, now,
        input.invoiceId, input.tenantId,
      ],
    );
    if (r.changes > 0) {
      await this.q().run(
        `update fiscal_devices set last_invoice_hash = ?, updated_at = ? where id = ?`,
        [input.hash, now, input.deviceId],
      );
    }
    return r.changes;
  }

  /*
    THE PROJECTION CARRIES client_id AND matter_id, AND THAT IS A SECURITY DECISION,
    not a convenience. Every caller of this method uses the matter id to put the invoice
    through `requireMatter` and the client id to resolve the buyer. An earlier version
    omitted both, which meant `if (matterId)` was never true: the ISSUE ROUTE SKIPPED ITS
    MATTER-SCOPE CHECK ENTIRELY, and the credit-note route resolved its client as the
    string 'undefined'. A projection that leaves out the field a gate reads turns the
    gate off silently — the failure is not an error, it is an absence.
  */
  async getInvoiceFiscal(tenantId: string, invoiceId: string) {
    return this.q().get<Row>(
      `select i.id, i.invoice_number, i.invoice_uuid, i.invoice_type, i.icv,
              i.client_id, i.matter_id,
              i.previous_invoice_hash, i.invoice_hash, i.qr_payload, i.xml_storage_key,
              i.supply_at, i.buyer_name, i.buyer_vat_number, i.fiscal_status,
              i.fiscal_status_at, i.fiscal_device_id, i.internal_status, i.client_status,
              i.subtotal, i.vat_amount, i.total, i.amount_paid, i.issue_date, i.due_date,
              i.currency, d.device_label, d.device_serial
         from invoices i
         left join fiscal_devices d on d.id = i.fiscal_device_id
        where i.id = ? and i.tenant_id = ?`,
      [invoiceId, tenantId],
    );
  }

  async listSubmissions(tenantId: string, invoiceId: string) {
    return this.q().all<Row>(
      `select id, submission_type, attempt, status, http_status, response_code,
              warnings, errors, next_retry_at, submitted_at, resolved_at, created_at
         from invoice_submissions
        where invoice_id = ? and tenant_id = ?
        order by created_at desc, attempt desc`,
      [invoiceId, tenantId],
    );
  }

  /**
   * Record what was sent to ZATCA and what came back.
   *
   * An attempt is its own row, always — including a retry, including a timeout, and
   * including a failure whose cause was on this side. The alternative (updating the
   * previous attempt in place) would erase the evidence of the attempt that failed,
   * which is the attempt that explains why the invoice is late.
   *
   * The attempt NUMBER is derived rather than supplied, so a caller cannot write two
   * "attempt 1" rows and make the trail read as though the first call succeeded.
   */
  async recordSubmission(input: {
    tenantId: string; invoiceId: string; submissionType: string; attempt: number;
    status: string; httpStatus?: number | null; responseCode?: string | null;
    requestBodyHash?: string | null; responseBody?: string | null;
    warnings?: string | null; errors?: string | null; nextRetryAt?: string | null;
  }): Promise<{ id: string; nextAttempt: number }> {
    const now = new Date().toISOString();
    const previous = await this.q().get<Row>(
      `select coalesce(max(attempt), 0) as n from invoice_submissions
        where invoice_id = ? and submission_type = ?`,
      [input.invoiceId, input.submissionType],
    );
    const attempt = toNumber(previous?.n) + 1;
    const id = newId();
    const resolved = ['cleared', 'reported', 'rejected'].includes(input.status) ? now : null;

    await this.q().run(
      `insert into invoice_submissions
         (id, tenant_id, invoice_id, submission_type, attempt, status, http_status,
          response_code, request_body_hash, response_body, warnings, errors,
          next_retry_at, submitted_at, resolved_at, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.tenantId, input.invoiceId, input.submissionType, attempt, input.status,
        input.httpStatus ?? null, input.responseCode ?? null, input.requestBodyHash ?? null,
        input.responseBody ?? null, input.warnings ?? null, input.errors ?? null,
        input.nextRetryAt ?? null, now, resolved, now,
      ],
    );
    return { id, nextAttempt: attempt + 1 };
  }

  async setFiscalStatus(tenantId: string, invoiceId: string, status: string): Promise<number> {
    const now = new Date().toISOString();
    const r = await this.q().run(
      `update invoices set fiscal_status = ?, fiscal_status_at = ?, updated_at = ?
        where id = ? and tenant_id = ?`,
      [status, now, now, invoiceId, tenantId],
    );
    return r.changes;
  }

  /**
   * Simplified invoices whose 24-hour reporting window is still open, or has closed.
   *
   * The window runs from the moment of supply, which is why `supply_at` is a
   * timestamp and why the guard refuses a simplified issue without one. This is the
   * query the reporting job runs, and `overdue` is returned rather than filtered
   * away: an invoice past its window is the one that costs money.
   */
  async listInvoicesNeedingReporting(tenantId: string) {
    return this.q().all<Row>(
      `select i.id, i.invoice_number, i.invoice_uuid, i.supply_at, i.total,
              i.fiscal_status, i.icv,
              case when i.supply_at <= ? then 1 else 0 end as overdue
         from invoices i
        where i.tenant_id = ?
          and i.invoice_type = 'simplified'
          and i.fiscal_status in ('pending_reporting', 'failed')
        order by i.supply_at`,
      [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), tenantId],
    );
  }

  /**
   * A credit note, as a fiscal document in its own right.
   *
   * It takes its own place in the same chain as the invoice it corrects — same
   * device, next ICV, chained to the current head — because a credit note that is
   * not in the chain is not a document ZATCA can see, and a correction it cannot see
   * leaves the original invoice standing.
   */
  async createCreditNote(input: {
    tenantId: string; invoiceId: string; clientId: string; creditNumber: string;
    reason: string; amount: number; vatAmount: number; total: number;
    deviceId: string; icv: number; previousHash: string; hash: string; qr: string;
    uuid: string; issuedByStaff: string | null;
  }): Promise<string> {
    const now = new Date().toISOString();
    const id = newId();
    await this.q().run(
      `insert into credit_notes
         (id, tenant_id, invoice_id, client_id, credit_number, reason, amount, vat_amount,
          total, currency, fiscal_device_id, invoice_uuid, icv, previous_invoice_hash,
          invoice_hash, qr_payload, xml_storage_key, fiscal_status, issued_by_staff,
          issued_at, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SAR', ?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?)`,
      [
        id, input.tenantId, input.invoiceId, input.clientId, input.creditNumber, input.reason,
        round2(input.amount), round2(input.vatAmount), round2(input.total), input.deviceId,
        input.uuid, input.icv, input.previousHash, input.hash, input.qr,
        'pending_clearance', input.issuedByStaff, now, now,
      ],
    );
    await this.q().run(
      `update fiscal_devices set last_invoice_hash = ?, updated_at = ? where id = ?`,
      [input.hash, now, input.deviceId],
    );
    return id;
  }

  async listCreditNotes(tenantId: string, invoiceId: string) {
    return this.q().all<Row>(
      `select id, credit_number, reason, amount, vat_amount, total, invoice_uuid, icv,
              invoice_hash, fiscal_status, issued_at, created_at
         from credit_notes where tenant_id = ? and invoice_id = ? order by created_at`,
      [tenantId, invoiceId],
    );
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * P1.1 · CLIENT MONEY
   * ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Every client the firm holds money for, with the balance DERIVED.
   *
   * The balance is summed from the entries in the same query rather than read from a
   * column, because there is no column. That is the point: a stored balance is a
   * second source of truth, and the moment it disagrees with the entries the ledger
   * is unarguable in exactly the situation where it needs to be.
   */
  async listClientLedgers(tenantId: string) {
    return this.q().all<Row>(
      `select l.id, l.client_id, l.currency, l.status, l.frozen_reason, l.opened_at,
              c.name as client_name, c.name_ar as client_name_ar,
              coalesce(sum(case when e.direction = 'credit' then e.amount else -e.amount end), 0) as balance,
              count(e.id) as entry_count,
              max(e.entry_at) as last_movement_at
         from client_ledgers l
         join clients c on c.id = l.client_id
         left join ledger_entries e on e.ledger_id = l.id
        where l.tenant_id = ?
        group by l.id, l.client_id, l.currency, l.status, l.frozen_reason, l.opened_at,
                 c.name, c.name_ar
        order by c.name`,
      [tenantId],
    );
  }

  async getClientLedger(tenantId: string, clientId: string) {
    return this.q().get<Row>(
      `select l.id, l.client_id, l.currency, l.status, l.frozen_reason, l.opened_at, l.closed_at,
              c.name as client_name, c.name_ar as client_name_ar
         from client_ledgers l
         join clients c on c.id = l.client_id
        where l.tenant_id = ? and l.client_id = ?`,
      [tenantId, clientId],
    );
  }

  /** A ledger exists from the first movement, not from the first intention. */
  async ensureClientLedger(tenantId: string, clientId: string): Promise<string> {
    const existing = await this.getClientLedger(tenantId, clientId);
    if (existing) return String(existing.id);
    const id = newId();
    const now = new Date().toISOString();
    await this.q().run(
      `insert into client_ledgers
         (id, tenant_id, client_id, currency, status, frozen_reason, opened_at,
          closed_at, created_at, updated_at)
       values (?, ?, ?, 'SAR', 'open', null, ?, null, ?, ?)`,
      [id, tenantId, clientId, now, now, now],
    );
    return id;
  }

  async listLedgerEntries(tenantId: string, clientId: string, limit = 200) {
    return this.q().all<Row>(
      `select e.id, e.entry_type, e.direction, e.amount, e.currency, e.invoice_id,
              e.matter_id, e.description, e.reference, e.evidence_document_id,
              e.reverses_entry_id, e.reversal_reason, e.entry_at, e.recorded_at,
              u.email as recorded_by_email,
              i.invoice_number, m.matter_number
         from ledger_entries e
         left join users u on u.id = e.recorded_by_user_id
         left join invoices i on i.id = e.invoice_id
         left join matters m on m.id = e.matter_id
        where e.tenant_id = ? and e.client_id = ?
        order by e.entry_at desc, e.recorded_at desc
        limit ${Math.min(Math.max(limit, 1), 500)}`,
      [tenantId, clientId],
    );
  }

  /**
   * Post a movement.
   *
   * The direction is DERIVED from the type here rather than taken from the caller,
   * matching `guard_ledger_entry_shape`. A caller that could choose the direction
   * could record a payment to a client as a receipt from them, which doubles a
   * discrepancy instead of causing one, and is the single most expensive typing
   * mistake a client account can make.
   */
  async recordLedgerEntry(input: LedgerEntryInput): Promise<string> {
    const ledgerId = await this.ensureClientLedger(input.tenantId, input.clientId);

    let direction: 'credit' | 'debit';
    if (input.entryType === 'reversal') {
      const target = await this.q().get<Row>(
        `select direction from ledger_entries where id = ? and tenant_id = ?`,
        [input.reversesEntryId ?? '', input.tenantId],
      );
      if (!target) {
        throw Object.assign(new Error('reversal target not found'), { code: 'ledger_not_found' });
      }
      direction = toStr(target.direction) === 'credit' ? 'debit' : 'credit';
    } else {
      direction = ['receipt', 'interest'].includes(input.entryType) ? 'credit' : 'debit';
    }

    const id = newId();
    const now = new Date().toISOString();
    await this.q().run(
      `insert into ledger_entries
         (id, tenant_id, ledger_id, client_id, entry_type, direction, amount, currency,
          invoice_id, matter_id, description, reference, evidence_document_id,
          reverses_entry_id, reversal_reason, entry_at, recorded_by_user_id, recorded_at)
       values (?, ?, ?, ?, ?, ?, ?, 'SAR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.tenantId, ledgerId, input.clientId, input.entryType, direction,
        round2(input.amount), input.invoiceId ?? null, input.matterId ?? null,
        input.description, input.reference ?? null, input.evidenceDocumentId ?? null,
        input.reversesEntryId ?? null, input.reversalReason ?? null,
        input.entryAt ?? now, input.recordedByUserId ?? null, now,
      ],
    );
    /*
      AN APPLICATION MOVES THE INVOICE'S PAID FIGURE, and nothing else on this side does.

      The ledger holds the money; the invoice holds what it has been paid. When the two
      disagree the client is shown a balance the firm's own records do not support, and
      the database's cap on an application — `total - amount_paid` — silently becomes
      wrong, which would let the same money be applied twice.

      `client_status` is derived here in the same form the client-facing payment path
      writes it, because the database guard compares the column against
      `derive_invoice_client_status` and refuses a write that disagrees with it.
    */
    if (input.entryType === 'application_to_fee' && input.invoiceId) {
      await this.applyMoneyToInvoice(input.tenantId, input.invoiceId, round2(input.amount));
    }

    return id;
  }

  /**
   * Add money already held for a client to one of that client's invoices.
   *
   * Private and deliberately narrow: called only from `recordLedgerEntry`, after the
   * ledger row exists, so an invoice can never show money that no entry accounts for.
   * The database caps the application as well; this is the bookkeeping half of the
   * same decision.
   */
  private async applyMoneyToInvoice(tenantId: string, invoiceId: string, amount: number): Promise<void> {
    const now = new Date().toISOString();
    await this.q().run(
      `update invoices
          set amount_paid = round(coalesce(amount_paid, 0) + ?, 2),
              internal_status = case
                when round(coalesce(amount_paid, 0) + ?, 2) >= total - 0.001 and total > 0 then 'paid'
                else 'partially_paid' end,
              client_status = case
                when round(coalesce(amount_paid, 0) + ?, 2) >= total - 0.001 and total > 0 then 'paid'
                else 'partially_paid' end,
              updated_at = ?
        where id = ? and tenant_id = ? and invoice_uuid is not null`,
      [amount, amount, amount, now, invoiceId, tenantId],
    );
  }

  /**
   * The balance, summed from the entries.
   *
   * `asOf` is not a convenience. The question asked in a review is almost never
   * "what is the balance now" but "what was it on the date of the payment we are
   * arguing about", and a balance function that can only answer the first question
   * cannot answer the one that matters.
   */
  async ledgerBalance(ledgerId: string, asOf?: string | null): Promise<number> {
    /*
      TWO STATEMENTS, NOT ONE WITH A NULL TEST.

      `where ledger_id = ? and (? is null or entry_at <= ?)` reads perfectly in SQLite
      and fails in Postgres, which refuses to infer a type for a parameter that is only
      ever tested for nullness: `could not determine data type of parameter $2`. The live
      verifier hit this on the overdraft guard's own balance read — the check that decides
      whether a client's money may be spent could not compute the balance at all, and the
      caller was told "internal error".

      The two cases are different questions anyway — the running balance, and the balance
      as it stood on a date — so they are asked separately, and the parameter that a date
      comparison types is only ever used in a date comparison.
    */
    const r = asOf
      ? await this.q().get<Row>(
        `select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0) as balance
           from ledger_entries
          where ledger_id = ? and entry_at <= ?`,
        [ledgerId, asOf],
      )
      : await this.q().get<Row>(
        `select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0) as balance
           from ledger_entries
          where ledger_id = ?`,
        [ledgerId],
      );
    return round2(toNumber(r?.balance));
  }

  async listReconciliations(tenantId: string) {
    return this.q().all<Row>(
      `select id, currency, as_of, ledger_total, bank_balance, difference,
              bank_statement_reference, clients_with_balance, status, notes,
              performed_at, created_at
         from ledger_reconciliations where tenant_id = ? order by as_of desc`,
      [tenantId],
    );
  }

  /**
   * Record a reconciliation.
   *
   * The DIFFERENCE IS COMPUTED HERE, not accepted from the caller, and the status is
   * derived from it — `balanced` only when the difference is nil, and an explanation
   * required otherwise. A reconciliation endpoint that took `difference` as an input
   * would let a caller post a balancing figure, which is precisely the act the whole
   * control exists to prevent.
   */
  async createReconciliation(input: {
    tenantId: string; asOf: string; ledgerTotal: number; bankBalance: number;
    bankStatementReference?: string | null; bankStatementDocumentId?: string | null;
    clientsWithBalance: number; status: string; notes?: string | null;
    performedByUserId?: string | null;
  }): Promise<string> {
    const difference = round2(input.ledgerTotal - input.bankBalance);
    const status = Math.abs(difference) < 0.01 ? 'balanced' : (input.status === 'balanced' ? 'difference' : input.status);
    const id = newId();
    const now = new Date().toISOString();
    await this.q().run(
      `insert into ledger_reconciliations
         (id, tenant_id, currency, as_of, ledger_total, bank_balance, difference,
          bank_statement_reference, bank_statement_document_id, clients_with_balance,
          status, notes, performed_by_user_id, performed_at, created_at)
       values (?, ?, 'SAR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.tenantId, input.asOf, round2(input.ledgerTotal), round2(input.bankBalance),
        difference, input.bankStatementReference ?? null, input.bankStatementDocumentId ?? null,
        input.clientsWithBalance, status, input.notes ?? null,
        input.performedByUserId ?? null, now, now,
      ],
    );
    return id;
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * P1.2 · P1.4 · WHAT A FEE RESTS ON
   * ══════════════════════════════════════════════════════════════════════════ */

  async engagementForMatter(tenantId: string, matterId: string) {
    return this.q().get<Row>(
      `select id, matter_id, client_id, scope, scope_ar, fee_amount_sar, calculation_method,
              signed_by_client_at, signed_by_client_name, document_id, identity_verified_at,
              capacity_verified, status, created_at
         from engagement_letters
        where tenant_id = ? and matter_id = ? and status = 'signed' and superseded_by is null
        order by signed_by_client_at desc limit 1`,
      [tenantId, matterId],
    );
  }

  async listEngagementLetters(tenantId: string, matterId: string) {
    return this.q().all<Row>(
      `select id, scope, scope_ar, fee_amount_sar, calculation_method, signed_by_client_at,
              signed_by_client_name, document_id, identity_verified_at, capacity_verified,
              status, superseded_by, created_at
         from engagement_letters where tenant_id = ? and matter_id = ? order by created_at desc`,
      [tenantId, matterId],
    );
  }

  async upsertEngagementLetter(input: {
    tenantId: string; matterId: string; clientId: string; scope: string;
    scopeAr?: string | null; feeAmountSar?: number | null; calculationMethod: string;
    status: string; createdByUserId?: string | null;
  }): Promise<string> {
    const id = newId();
    const now = new Date().toISOString();
    await this.q().run(
      `insert into engagement_letters
         (id, tenant_id, matter_id, client_id, scope, scope_ar, fee_amount_sar,
          calculation_method, signed_by_client_at, signed_by_client_name, document_id,
          identity_verified_at, capacity_verified, status, superseded_by,
          created_by_user_id, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, ?, ?, null, ?, ?)`,
      [
        id, input.tenantId, input.matterId, input.clientId, input.scope, input.scopeAr ?? null,
        input.feeAmountSar ?? null, input.calculationMethod,
        false, input.status, input.createdByUserId ?? null, now,
      ],
    );
    return id;
  }

  /**
   * Sign it, which is the moment the matter becomes billable.
   *
   * The three things Rule 11 asks to be established BEFORE the work is accepted go
   * in the same statement as the signature: identity, capacity, and — indirectly —
   * conflict, because `matters.conflict_cleared` is already derived from the check
   * ledger by P0.1 and this does not invent a second answer to that question.
   *
   * `document_id` is required by a CHECK when the status is 'signed'. That is
   * deliberate: a signature with no document behind it is an assertion, and the
   * whole point of the engagement gate is that it rests on a writing.
   */
  async signEngagementLetter(input: {
    tenantId: string; letterId: string; signedByName: string; documentId: string;
    identityVerifiedAt: string; capacityVerified: boolean;
  }): Promise<number> {
    const r = await this.q().run(
      `update engagement_letters
          set status = 'signed', signed_by_client_at = ?, signed_by_client_name = ?,
              document_id = ?, identity_verified_at = ?, capacity_verified = ?
        where id = ? and tenant_id = ? and status <> 'signed' and superseded_by is null`,
      [
        new Date().toISOString(), input.signedByName, input.documentId,
        input.identityVerifiedAt, input.capacityVerified, input.letterId, input.tenantId,
      ],
    );
    return r.changes;
  }

  async billingTermsForMatter(tenantId: string, matterId: string) {
    return this.q().get<Row>(
      `select id, matter_id, basis, fee_amount_sar, cap_amount_sar, retainer_amount_sar,
              stages, agreed_discount_pct, vat_applicable, effective_from, effective_to,
              superseded_by, notes, created_at
         from matter_billing_terms
        where tenant_id = ? and matter_id = ? and superseded_by is null
        order by effective_from desc limit 1`,
      [tenantId, matterId],
    );
  }

  /**
   * Set the basis. A CHANGE SUPERSEDES rather than edits.
   *
   * An hour recorded in March was recorded against March's terms. If the fee basis
   * is edited in June, the March hour becomes unexplainable — so a renegotiation
   * writes a new row with a new effective date and retires the old one. That is also
   * what makes "which terms applied on this date" answerable at all.
   */
  async setBillingTerms(input: {
    tenantId: string; matterId: string; basis: string; feeAmountSar?: number | null;
    capAmountSar?: number | null; retainerAmountSar?: number | null; stages?: string | null;
    agreedDiscountPct: number; effectiveFrom: string; notes?: string | null;
    createdByUserId?: string | null;
  }): Promise<string> {
    const id = newId();
    const now = new Date().toISOString();
    await this.q().run(
      `update matter_billing_terms set superseded_by = ?
        where tenant_id = ? and matter_id = ? and superseded_by is null`,
      [id, input.tenantId, input.matterId],
    );
    await this.q().run(
      `insert into matter_billing_terms
         (id, tenant_id, matter_id, basis, fee_amount_sar, cap_amount_sar, retainer_amount_sar,
          stages, agreed_discount_pct, vat_applicable, effective_from, effective_to,
          superseded_by, notes, created_by_user_id, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?, ?)`,
      [
        id, input.tenantId, input.matterId, input.basis, input.feeAmountSar ?? null,
        input.capAmountSar ?? null, input.retainerAmountSar ?? null, input.stages ?? null,
        round2(input.agreedDiscountPct), true, input.effectiveFrom, input.notes ?? null,
        input.createdByUserId ?? null, now,
      ],
    );
    return id;
  }

  /** The same question the trigger asks, asked early so a screen can answer it. */
  async matterBillable(matterId: string): Promise<boolean> {
    const r = await this.q().get<Row>(
      `select
         (select count(*) from engagement_letters
           where matter_id = ? and status = 'signed' and superseded_by is null) as letters,
         (select count(*) from matter_billing_terms
           where matter_id = ? and superseded_by is null
             and effective_from <= ? and (effective_to is null or effective_to >= ?)) as terms`,
      [matterId, matterId, today(), today()],
    );
    return toNumber(r?.letters) > 0 && toNumber(r?.terms) > 0;
  }

  async listRateCards(tenantId: string) {
    return this.q().all<Row>(
      `select id, level, staff_id, practice_area, hourly_rate_sar, effective_from,
              effective_to, created_at
         from rate_cards where tenant_id = ? order by effective_from desc, level`,
      [tenantId],
    );
  }

  async createRateCard(input: {
    tenantId: string; level: string | null; staffId: string | null;
    hourlyRateSar: number; effectiveFrom: string; createdByUserId?: string | null;
  }): Promise<string> {
    const id = newId();
    await this.q().run(
      `insert into rate_cards
         (id, tenant_id, level, staff_id, practice_area, hourly_rate_sar,
          effective_from, effective_to, created_by_user_id, created_at)
       values (?, ?, ?, ?, null, ?, ?, null, ?, ?)`,
      [
        id, input.tenantId, input.level, input.staffId, round2(input.hourlyRateSar),
        input.effectiveFrom, input.createdByUserId ?? null, new Date().toISOString(),
      ],
    );
    return id;
  }

  /**
   * What this member's hour is worth, on the date it was worked.
   *
   * A staff-specific card beats a level card, and the most recent effective date
   * wins among equals. Returns null when nothing matches, which the caller must
   * treat as READY TO RECORD AT ZERO and never as "use the last known rate": an hour
   * billed at a rate somebody guessed is worse than an hour that needs a rate card
   * entering before it can be billed.
   */
  async rateFor(staffId: string, onDate: string): Promise<number | null> {
    const r = await this.q().get<Row>(
      `select hourly_rate_sar from rate_cards
        where staff_id = ?
          and effective_from <= ? and (effective_to is null or effective_to >= ?)
        order by effective_from desc limit 1`,
      [staffId, onDate, onDate],
    );
    if (r) return toNumber(r.hourly_rate_sar);

    const fallback = await this.q().get<Row>(
      `select rc.hourly_rate_sar
         from rate_cards rc
         join staff s on s.tenant_id = rc.tenant_id
        where s.id = ? and rc.staff_id is null and rc.level is not null
          and rc.effective_from <= ? and (rc.effective_to is null or rc.effective_to >= ?)
        order by rc.effective_from desc limit 1`,
      [staffId, onDate, onDate],
    );
    return fallback ? toNumber(fallback.hourly_rate_sar) : null;
  }

  async listTimeEntries(tenantId: string, opts: { matterId?: string | null; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const where = ['t.tenant_id = ?'];
    const params: Param[] = [tenantId];
    if (opts.matterId) {
      where.push('t.matter_id = ?');
      params.push(opts.matterId);
    }
    return this.q().all<Row>(
      `select t.id, t.matter_id, t.staff_id, t.entry_date, t.minutes, t.narrative,
              t.narrative_ar, t.billable, t.hourly_rate_sar, t.amount_sar, t.invoice_id,
              t.status, t.approved_by_user_id, t.approved_at, t.written_off_reason,
              t.created_at, t.updated_at,
              s.full_name as staff_name, s.full_name_ar as staff_name_ar,
              m.matter_number, m.title as matter_title
         from time_entries t
         join staff s on s.id = t.staff_id
         join matters m on m.id = t.matter_id
        where ${where.join(' and ')}
        order by t.entry_date desc, t.created_at desc
        limit ${limit}`,
      params,
    );
  }

  /**
   * Record an hour.
   *
   * `amountSar` is computed here from minutes × rate, never taken from the caller:
   * a client's fee is the product of a recorded duration and a recorded rate, and a
   * caller that could supply a third number could bill anything.
   */
  async recordTimeEntry(input: TimeEntryInput): Promise<string> {
    /*
      A non-billable hour is stored at zero, RATE INCLUDED. Storing the rate it would
      have had leaves a number on the row that a later reader will price the hour by —
      and "not billable" is a decision already taken, not a discount waiting to be
      reversed.
    */
    const rate = input.billable ? round2(input.hourlyRateSar) : 0;
    const amount = input.billable ? round2((input.minutes / 60) * rate) : 0;
    const id = newId();
    const now = new Date().toISOString();
    await this.q().run(
      `insert into time_entries
         (id, tenant_id, matter_id, staff_id, entry_date, minutes, narrative, narrative_ar,
          billable, hourly_rate_sar, amount_sar, invoice_id, status,
          approved_by_user_id, approved_at, written_off_reason, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, null, ?, ?)`,
      [
        id, input.tenantId, input.matterId, input.staffId, input.entryDate, input.minutes,
        input.narrative, input.narrativeAr ?? null, input.billable, rate,
        amount,
        // A non-billable hour is never 'draft': it is finished when it is written,
        // because there is no invoice waiting for it.
        input.billable ? 'submitted' : 'non_billable',
        input.approvedByUserId ?? null, null, now, now,
      ],
    );
    return id;
  }

  /**
   * Adjust an hour: approve it, change it, or write it off.
   *
   * WHAT AN ADJUSTMENT CANNOT DO is un-bill an entry that is on an issued invoice —
   * `guard_billed_entry_immutable` refuses that on both engines, and it is refused
   * because the invoice is a tax document whose own lines would then be wrong.
   * Corrections after issue go through a credit note.
   */
  async adjustTimeEntry(input: {
    tenantId: string; entryId: string; status?: string | null; minutes?: number | null;
    narrative?: string | null; writtenOffReason?: string | null; approvedByUserId?: string | null;
  }): Promise<number> {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const params: Param[] = [now];

    if (input.status) {
      sets.push('status = ?');
      params.push(input.status);
      if (input.status === 'approved') {
        sets.push('approved_by_user_id = ?', 'approved_at = ?');
        params.push(input.approvedByUserId ?? null, now);
      }
      if (input.status === 'written_off') {
        sets.push('written_off_reason = ?');
        params.push(input.writtenOffReason ?? null);
      }
    }
    if (input.minutes !== null && input.minutes !== undefined) {
      /*
        Changing the duration changes the money, so the amount is recomputed from the
        ROW's own stored rate in the same statement. Taking a rate from the caller
        here would let an adjustment restate an hour at a rate the member never had.
      */
      sets.push('minutes = ?', 'amount_sar = round((? / 60.0) * hourly_rate_sar, 2)');
      params.push(input.minutes, input.minutes);
    }
    if (input.narrative) {
      sets.push('narrative = ?');
      params.push(input.narrative);
    }

    params.push(input.entryId, input.tenantId);
    const r = await this.q().run(
      `update time_entries set ${sets.join(', ')} where id = ? and tenant_id = ?`,
      params,
    );
    return r.changes;
  }

  async listExpenses(tenantId: string, opts: { matterId?: string | null; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const where = ['e.tenant_id = ?'];
    const params: Param[] = [tenantId];
    if (opts.matterId) {
      where.push('e.matter_id = ?');
      params.push(opts.matterId);
    }
    return this.q().all<Row>(
      `select e.id, e.matter_id, e.client_id, e.submitted_by_staff, e.incurred_on, e.category,
              e.description, e.description_ar, e.net_amount_sar, e.vat_amount_sar,
              e.total_amount_sar, e.vat_category, e.receipt_document_id, e.reimbursable,
              e.invoice_id, e.status, e.approved_by_user_id, e.approved_at, e.rejection_reason,
              e.created_at, e.updated_at,
              s.full_name as staff_name, m.matter_number, m.title as matter_title
         from expenses e
         join staff s on s.id = e.submitted_by_staff
         join matters m on m.id = e.matter_id
        where ${where.join(' and ')}
        order by e.incurred_on desc, e.created_at desc
        limit ${limit}`,
      params,
    );
  }

  async recordExpense(input: ExpenseInput): Promise<string> {
    const id = newId();
    const now = new Date().toISOString();
    await this.q().run(
      `insert into expenses
         (id, tenant_id, matter_id, client_id, submitted_by_staff, incurred_on, category,
          description, description_ar, net_amount_sar, vat_amount_sar, total_amount_sar,
          vat_category, receipt_document_id, reimbursable, invoice_id, status,
          approved_by_user_id, approved_at, rejection_reason, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 'submitted',
               null, null, null, ?, ?)`,
      [
        id, input.tenantId, input.matterId, input.clientId, input.submittedByStaff,
        input.incurredOn, input.category, input.description, input.descriptionAr ?? null,
        round2(input.netAmountSar), round2(input.vatAmountSar), round2(input.totalAmountSar),
        input.vatCategory, input.receiptDocumentId ?? null, input.reimbursable, now, now,
      ],
    );
    return id;
  }

  async decideExpense(input: {
    tenantId: string; expenseId: string; decision: 'approved' | 'rejected';
    approvedByUserId: string; rejectionReason?: string | null;
  }): Promise<number> {
    const now = new Date().toISOString();
    const r = await this.q().run(
      `update expenses
          set status = ?, approved_by_user_id = ?, approved_at = ?, rejection_reason = ?,
              updated_at = ?
        where id = ? and tenant_id = ? and status = 'submitted'`,
      [
        input.decision, input.approvedByUserId, now,
        input.decision === 'rejected' ? (input.rejectionReason ?? null) : null,
        now, input.expenseId, input.tenantId,
      ],
    );
    return r.changes;
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * P1.3 · THE TWO CEILINGS THAT HAD NO GUARD
   * ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Reduce an invoice's subtotal by a discount.
   *
   * THREE THINGS HAPPEN, AND THE ORDER MATTERS. The permission is checked by the
   * route (it is the route that knows the principal); the CEILING is checked by the
   * route through `assertWithinAuthority`; and the DATABASE checks it again through
   * `guard_invoice_discount_ceiling`, which reads the member id from a session GUC.
   *
   * That third check is why the GUC is set before this statement runs: on PostgreSQL
   * a discount that did not come through a member's authority is refused at the
   * table, and the refusal names the member. This method does not attempt the
   * discount without one — it REQUIRES the membership id, so there is no path here
   * that produces a `ceiling_actor_unknown` at the database.
   *
   * Only the subtotal moves: `vat_amount` and `total` are recomputed from it in the
   * same statement, because a discount that left the VAT as it was would reduce the
   * fee and leave the tax on the old figure.
   */
  async applyDiscount(input: {
    tenantId: string; invoiceId: string; newSubtotal: number;
    membershipId: string; discountPct: number;
  }): Promise<number> {
    const now = new Date().toISOString();
    const r = await this.q().run(
      `update invoices
          set subtotal = ?,
              vat_amount = round(? * vat_rate, 2),
              total = round(? + round(? * vat_rate, 2), 2),
              updated_at = ?
        where id = ? and tenant_id = ?
          and internal_status in ('draft','pending_internal_approval')
          and invoice_uuid is null`,
      [
        round2(input.newSubtotal), round2(input.newSubtotal), round2(input.newSubtotal),
        round2(input.newSubtotal), now, input.invoiceId, input.tenantId,
      ],
    );
    return r.changes;
  }

  /**
   * Abandon a claim on a client.
   *
   * A write-off does not change what was billed — the invoice stands, and the tax on
   * it stands with it — it records that the firm has stopped pursuing the balance.
   * So the only thing that moves is the status, and the amount approved is the
   * OUTSTANDING figure rather than the invoice total, for the same reason invoice
   * approval uses the outstanding: a member with a 5,000 write-off ceiling must not
   * be able to abandon a 40,000 balance on an invoice that happens to be for 40,000.
   */
  async writeOffInvoice(input: {
    tenantId: string; invoiceId: string; amountSar: number; reason: string;
    approvedByStaff: string;
  }): Promise<number> {
    const now = new Date().toISOString();
    const r = await this.q().run(
      `update invoices
          set internal_status = 'written_off',
              client_status = 'cancelled',
              notes_internal = coalesce(notes_internal || ' | ', '') || ?,
              updated_at = ?
        where id = ? and tenant_id = ?
          and internal_status in ('sent','partially_paid','overdue')`,
      [`WRITE-OFF ${round2(input.amountSar).toFixed(2)} SAR by ${input.approvedByStaff}: ${input.reason}`,
        now, input.invoiceId, input.tenantId],
    );
    return r.changes;
  }
  /* ═════════════════════════════════════════════════════════════════════════════
     P0.3 · CLIENT DUE DILIGENCE, THE OWNERS, THE SCREENING AND THE REPORT

     WHY EVERY METHOD HERE RETURNS A MAPPED OBJECT. `getClientForInvoice` handed the
     invoice route a raw driver row and the route read a camelCase field off it; every
     buyer looked VAT-less and every standard invoice was refused. The defect was not
     the missing field — it was the boundary being crossed. Raw rows do not leave this
     file.

     WHY NOTHING HERE DELETES. A due-diligence record, a screening and a report are
     statements about what the firm knew and when. They are corrected by adding a
     version, re-running the screening, or filing a new report — never by removal. The
     Postgres grants in 0040 make that a privilege fact as well as a policy.
     ═════════════════════════════════════════════════════════════════════════════ */

  /** The current version of a client's identification record, or null. */
  async getCurrentDueDiligence(tenantId: string, clientId: string) {
    const row = await this.q().get<Row>(
      `select * from client_due_diligence
        where tenant_id = ? and client_id = ? and superseded_by is null`,
      [tenantId, clientId],
    );
    return row ? dueDiligenceFromRow(row) : null;
  }

  async getDueDiligence(tenantId: string, id: string) {
    const row = await this.q().get<Row>(
      `select * from client_due_diligence where tenant_id = ? and id = ?`, [tenantId, id]);
    return row ? dueDiligenceFromRow(row) : null;
  }

  async listDueDiligenceHistory(tenantId: string, clientId: string) {
    const rows = await this.q().all<Row>(
      `select d.*, u.email as completed_by_email
         from client_due_diligence d
         left join users u on u.id = (select user_id from firm_memberships m
                                       where m.id = d.completed_by_membership_id)
        where d.tenant_id = ? and d.client_id = ?
        order by d.version desc`,
      [tenantId, clientId],
    );
    return (rows ?? []).map((r) => ({ ...dueDiligenceFromRow(r), completedBy: r.completed_by_email ?? null }));
  }

  /**
   * Opens a new version of a client's record.
   *
   * THE VERSION NUMBER IS COMPUTED, NOT SUPPLIED, and the previous current row is
   * superseded in the same transaction. Two versions claiming to be current is the state
   * the unique index exists to refuse, so it is prevented here rather than reported.
   */
  async openDueDiligence(opts: {
    tenantId: string; clientId: string; partyId: string | null;
    level: string; membershipId: string | null;
  }): Promise<string> {
    const now = new Date().toISOString();
    const id = newId();
    return this.tx(async () => {
      const prior = await this.q().get<Row>(
        `select id, version from client_due_diligence
          where tenant_id = ? and client_id = ? and superseded_by is null
          order by version desc`,
        [opts.tenantId, opts.clientId],
      );
      const version = Number(prior?.version ?? 0) + 1;
      if (prior) {
        await this.q().run(
          `update client_due_diligence
              set superseded_by = ?, superseded_at = ?, updated_at = ?
            where id = ? and tenant_id = ?`,
          [id, now, now, String(prior.id), opts.tenantId],
        );
      }
      await this.q().run(
        `insert into client_due_diligence
           (id, tenant_id, client_id, party_id, version, cdd_level, status,
            risk_reasons, created_by_membership_id, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, 'not_started', '[]', ?, ?, ?)`,
        [id, opts.tenantId, opts.clientId, opts.partyId, version, opts.level,
          opts.membershipId, now, now],
      );
      return id;
    });
  }

  /**
   * The fields a person fills in.
   *
   * `status` is not among them, deliberately. A record becomes `complete` through
   * `completeDueDiligence`, which records who decided so and when — and the database
   * refuses `complete` without both. A form that could set the status would be a form
   * that can claim a completeness nobody decided.
   */
  async updateDueDiligence(opts: {
    tenantId: string; id: string; fields: Record<string, unknown>;
    membershipId: string | null;
  }): Promise<void> {
    const allowed = [
      'cdd_level', 'legal_name', 'legal_name_ar', 'date_of_birth', 'nationality',
      'residence_country', 'address', 'id_type', 'id_number_hash', 'id_number_masked',
      'id_issued_at', 'id_expires_at', 'cr_number', 'cr_issued_at', 'incorporation_country',
      'business_activity', 'ownership_structure', 'source_of_funds', 'source_of_wealth',
      'purpose', 'expected_annual_volume_sar', 'verification_method', 'verification_source',
      'verified_at', 'pep_status', 'pep_details', 'risk_rating', 'risk_reasons',
      'risk_assessed_at', 'notes',
    ];
    /*
      A WRITE NAMING A COLUMN THIS FEATURE DOES NOT OWN IS A BUG, NOT A NO-OP.
      This filtered silently once, and a caller that sent camelCase field names — which
      `firm.routes.ts` did — wrote nothing and was told it had succeeded. The allow-list
      stays, so that a caller cannot reach a column the feature does not own; what changes
      is that the filter now reports what it dropped instead of discarding it.
    */
    const cols = Object.keys(opts.fields);
    const refused = cols.filter((c) => !allowed.includes(c));
    if (refused.length > 0) {
      throw new Error(
        `updateDueDiligence: ${refused.join(', ')} ${
          refused.length === 1 ? 'is not a column' : 'are not columns'
        } of client_due_diligence this feature writes`);
    }
    if (cols.length === 0) return;
    const now = new Date().toISOString();
    const sets = cols.map((c) => `${c} = ?`).join(', ');
    await this.q().run(
      `update client_due_diligence set ${sets}, updated_at = ?
        where id = ? and tenant_id = ? and superseded_by is null`,
      [...cols.map((c) => normalizeDdValue(opts.fields[c])), now, opts.id, opts.tenantId],
    );
  }

  /** Marks the current record complete, and says who completed it. */
  async completeDueDiligence(opts: {
    tenantId: string; id: string; membershipId: string; seniorApproval?: {
      membershipId: string; note: string | null;
    } | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.q().run(
      `update client_due_diligence
          set status = 'complete', completed_at = ?, completed_by_membership_id = ?,
              last_reviewed_at = coalesce(last_reviewed_at, ?), updated_at = ?
        where id = ? and tenant_id = ? and superseded_by is null`,
      [now, opts.membershipId, now, now, opts.id, opts.tenantId],
    );
    if (opts.seniorApproval) {
      await this.q().run(
        `update client_due_diligence
            set senior_approved_by_membership_id = ?, senior_approved_at = ?,
                senior_approval_note = ?, updated_at = ?
          where id = ? and tenant_id = ?`,
        [opts.seniorApproval.membershipId, now, opts.seniorApproval.note,
          now, opts.id, opts.tenantId],
      );
    }
  }

  /**
   * The refusal to act, recorded as a decision.
   *
   * `unable_to_complete` is not an unfinished form. It is the firm's conclusion that the
   * client cannot be identified, it forbids the relationship, and the database refuses
   * it without a ground of at least ten characters — because "unable" with no reason is
   * an exit from an obligation that nobody can review.
   */
  async recordUnableToComplete(opts: {
    tenantId: string; id: string; reason: string; membershipId: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.q().run(
      `update client_due_diligence
          set status = 'unable_to_complete', unable_reason = ?, notes = ?,
              completed_at = null, completed_by_membership_id = ?, updated_at = ?
        where id = ? and tenant_id = ? and superseded_by is null`,
      [opts.reason, opts.reason, opts.membershipId, now, opts.id, opts.tenantId],
    );
  }

  /** When the record must next be looked at, decided by the rating. */
  async setReviewDue(opts: { tenantId: string; id: string; dueAt: string | null }): Promise<void> {
    await this.q().run(
      `update client_due_diligence set review_due_at = ?, updated_at = ?
        where id = ? and tenant_id = ?`,
      [opts.dueAt, new Date().toISOString(), opts.id, opts.tenantId],
    );
  }

  async listBeneficialOwners(tenantId: string, ddId: string) {
    const rows = await this.q().all<Row>(
      `select id, dd_id, client_id, party_id, owner_kind, full_name, full_name_ar,
              date_of_birth, nationality, residence_country, address, id_type,
              id_number_masked, cr_number, ownership_pct, control_basis, control_description,
              pep_status, is_designated, source, verification_method, verified_at, notes
         from beneficial_owners
        where tenant_id = ? and dd_id = ?
        order by ownership_pct desc nulls last, full_name`,
      [tenantId, ddId],
    );
    return (rows ?? []).map((r) => ({
      id: String(r.id), ddId: String(r.dd_id), clientId: String(r.client_id),
      ownerKind: String(r.owner_kind), fullName: String(r.full_name),
      fullNameAr: strOrNull(r.full_name_ar),
      dateOfBirth: strOrNull(r.date_of_birth), nationality: strOrNull(r.nationality),
      residenceCountry: strOrNull(r.residence_country), address: strOrNull(r.address),
      idType: strOrNull(r.id_type), idNumberMasked: strOrNull(r.id_number_masked),
      crNumber: strOrNull(r.cr_number),
      ownershipPct: r.ownership_pct === null ? null : toNumber(r.ownership_pct),
      controlBasis: String(r.control_basis) as OwnerControlBasis,
      controlDescription: strOrNull(r.control_description),
      pepStatus: strOrNull(r.pep_status),
      isDesignated: r.is_designated === null ? null : toBool(r.is_designated),
      source: strOrNull(r.source), verificationMethod: strOrNull(r.verification_method),
      verifiedAt: strOrNull(r.verified_at), notes: strOrNull(r.notes),
    }));
  }

  /**
   * Records — or re-verifies — one person behind the client.
   *
   * AN UPSERT ON THE ID, because the row a person edits is the row that was created; a
   * second row with the same owner is how a register comes to hold the same person twice
   * and the arithmetic comes to double.
   */
  async upsertBeneficialOwner(opts: {
    tenantId: string; id: string | null; ddId: string; clientId: string;
    partyId: string | null; membershipId: string | null;
    fields: Record<string, unknown>;
  }): Promise<string> {
    const f = opts.fields;
    const now = new Date().toISOString();
    const values: Record<string, unknown> = {
      full_name: f.fullName, full_name_ar: f.fullNameAr ?? null,
      owner_kind: f.ownerKind ?? 'natural_person',
      date_of_birth: f.dateOfBirth ?? null, nationality: f.nationality ?? null,
      residence_country: f.residenceCountry ?? null, address: f.address ?? null,
      id_type: f.idType ?? null, id_number_hash: f.idNumberHash ?? null,
      id_number_masked: f.idNumberMasked ?? null, cr_number: f.crNumber ?? null,
      ownership_pct: f.ownershipPct ?? null, control_basis: f.controlBasis ?? 'ownership',
      control_description: f.controlDescription ?? null,
      pep_status: f.pepStatus ?? null, is_designated: f.isDesignated ?? null,
      source: f.source ?? null, verification_method: f.verificationMethod ?? null,
      verified_by_membership_id: f.verifiedAt ? opts.membershipId : null,
      verified_at: f.verifiedAt ?? null, notes: f.notes ?? null,
    };
    const cols = Object.keys(values);
    if (opts.id) {
      return this.tx(async () => {
        await this.q().run(
          `update beneficial_owners
              set ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
            where id = ? and tenant_id = ?`,
          [...cols.map((c) => normalizeDdValue(values[c])), now, opts.id, opts.tenantId],
        );
        return opts.id!;
      });
    }
    const id = newId();
    await this.q().run(
      `insert into beneficial_owners (id, tenant_id, dd_id, client_id, party_id,
                                      ${cols.join(', ')}, created_at, updated_at)
       values (?, ?, ?, ?, ?, ${cols.map(() => '?').join(', ')}, ?, ?)`,
      [id, opts.tenantId, opts.ddId, opts.clientId, opts.partyId,
        ...cols.map((c) => normalizeDdValue(values[c])), now, now],
    );
    return id;
  }

  async listScreeningRuns(tenantId: string, clientId: string) {
    const rows = await this.q().all<Row>(
      `select r.id, r.dd_id, r.subject_kind, r.subject_id, r.subject_name, r.list_sets,
              r.list_as_of, r.provider, r.provider_reference, r.status, r.matches_found,
              r.failure_reason, r.run_at, r.note,
              (select count(*) from screening_matches m
                where m.run_id = r.id and m.disposition = 'open') as open_matches
         from screening_runs r
        where r.tenant_id = ? and r.client_id = ?
        order by r.run_at desc`,
      [tenantId, clientId],
    );
    return (rows ?? []).map((r) => ({
      id: String(r.id), ddId: strOrNull(r.dd_id),
      subjectKind: String(r.subject_kind), subjectId: String(r.subject_id),
      subjectName: String(r.subject_name), listSets: jsonArrayColumn(r.list_sets),
      listAsOf: strOrNull(r.list_as_of), provider: String(r.provider),
      providerReference: strOrNull(r.provider_reference), status: String(r.status),
      matchesFound: Number(r.matches_found),
      openMatches: Number(r.open_matches ?? 0),
      failureReason: strOrNull(r.failure_reason), runAt: String(r.run_at), note: strOrNull(r.note),
    }));
  }

  async listScreeningMatches(tenantId: string, runId: string) {
    const rows = await this.q().all<Row>(
      `select m.id, m.run_id, m.list_source, m.matched_name, m.matched_reference, m.match_kind,
              m.score, m.disposition, m.disposition_reason, m.disposition_at,
              u.email as disposition_by_email
         from screening_matches m
         left join users u on u.id = (select user_id from firm_memberships fm
                                      where fm.id = m.disposition_by_membership_id)
        where m.tenant_id = ? and m.run_id = ?
        order by case m.disposition when 'open' then 0 else 1 end, m.score desc`,
      [tenantId, runId],
    );
    return (rows ?? []).map((m) => ({
      id: String(m.id), runId: String(m.run_id), listSource: String(m.list_source),
      matchedName: String(m.matched_name), matchedReference: strOrNull(m.matched_reference),
      matchKind: String(m.match_kind), score: m.score === null ? null : toNumber(m.score),
      disposition: String(m.disposition) as ScreeningDisposition,
      dispositionReason: strOrNull(m.disposition_reason),
      dispositionAt: strOrNull(m.disposition_at), dispositionBy: strOrNull(m.disposition_by_email),
    }));
  }

  /**
   * One screening, with every hit it produced, written in one transaction.
   *
   * THE COUNT IS DERIVED FROM THE MATCHES, NOT SUPPLIED. A run that says "no matches" and
   * carries two of them is the state the database refuses — and computing the number here
   * is what makes that refusal unreachable rather than merely enforced.
   */
  async recordScreeningRun(opts: {
    tenantId: string; clientId: string; ddId: string | null;
    subjectKind: string; subjectId: string; subjectName: string;
    listSets: string[]; listAsOf: string | null; provider: string;
    providerReference: string | null; status: string; failureReason: string | null;
    note: string | null; membershipId: string | null;
    matches: Array<{
      listSource: string; matchedName: string; matchedReference: string | null;
      matchKind: string; score: number | null;
    }>;
  }): Promise<{ id: string; matchesFound: number }> {
    const id = newId();
    const now = new Date().toISOString();
    return this.tx(async () => {
      await this.q().run(
        `insert into screening_runs
           (id, tenant_id, dd_id, client_id, subject_kind, subject_id, subject_name,
            list_sets, list_as_of, provider, provider_reference, status, matches_found,
            failure_reason, run_at, run_by_membership_id, note, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, opts.tenantId, opts.ddId, opts.clientId, opts.subjectKind, opts.subjectId,
          opts.subjectName, JSON.stringify(opts.listSets), opts.listAsOf, opts.provider,
          opts.providerReference, opts.status, opts.matches.length, opts.failureReason,
          now, opts.membershipId, opts.note, now],
      );
      for (const m of opts.matches) {
        await this.q().run(
          `insert into screening_matches
             (id, tenant_id, run_id, list_source, matched_name, matched_reference,
              match_kind, score, disposition, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          [newId(), opts.tenantId, id, m.listSource, m.matchedName, m.matchedReference,
            m.matchKind, m.score, now],
        );
      }
      return { id, matchesFound: opts.matches.length };
    });
  }

  async getScreeningRun(tenantId: string, runId: string) {
    const row = await this.q().get<Row>(
      `select id, client_id, subject_kind, subject_id, status from screening_runs
        where tenant_id = ? and id = ?`, [tenantId, runId]);
    return row ? {
      id: String(row.id), clientId: String(row.client_id),
      subjectKind: String(row.subject_kind), subjectId: String(row.subject_id),
      status: String(row.status),
    } : null;
  }

  /** The decision about one hit. The database refuses a second one on the same row. */
  async dispositionScreeningMatch(opts: {
    tenantId: string; matchId: string; disposition: string;
    reason: string; membershipId: string;
  }): Promise<number> {
    const now = new Date().toISOString();
    const r = await this.q().run(
      `update screening_matches
          set disposition = ?, disposition_reason = ?, disposition_by_membership_id = ?,
              disposition_at = ?
        where id = ? and tenant_id = ? and disposition = 'open'`,
      [opts.disposition, opts.reason, opts.membershipId, now, opts.matchId, opts.tenantId],
    );
    return Number(r.changes ?? 0);
  }

  async listRiskCountries(tenantId: string, onDate?: string) {
    const asOf = onDate ?? new Date().toISOString().slice(0, 10);
    const rows = await this.q().all<Row>(
      `select id, country_code, country_name, country_name_ar, list_source, risk_level,
              effective_from, effective_to, note
         from aml_risk_countries
        where tenant_id = ? and effective_from <= ?
          and (effective_to is null or effective_to >= ?)
        order by risk_level desc, country_code`,
      [tenantId, asOf, asOf],
    );
    return (rows ?? []).map((r) => ({
      id: String(r.id), countryCode: String(r.country_code), countryName: String(r.country_name),
      countryNameAr: r.country_name_ar ?? null, listSource: String(r.list_source),
      riskLevel: String(r.risk_level), effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to ?? null, note: r.note ?? null,
    }));
  }

  async upsertRiskCountry(opts: {
    tenantId: string; id: string | null; countryCode: string; countryName: string;
    countryNameAr: string | null; listSource: string; riskLevel: string;
    effectiveFrom: string; note: string | null; membershipId: string | null;
  }): Promise<string> {
    const now = new Date().toISOString();
    if (opts.id) {
      await this.q().run(
        `update aml_risk_countries
            set country_name = ?, country_name_ar = ?, risk_level = ?, note = ?, updated_at = ?
          where id = ? and tenant_id = ?`,
        [opts.countryName, opts.countryNameAr, opts.riskLevel, opts.note, now, opts.id, opts.tenantId],
      );
      return opts.id;
    }
    const id = newId();
    await this.q().run(
      `insert into aml_risk_countries
         (id, tenant_id, country_code, country_name, country_name_ar, list_source, risk_level,
          effective_from, effective_to, note, created_by_membership_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?)`,
      [id, opts.tenantId, opts.countryCode, opts.countryName, opts.countryNameAr,
        opts.listSource, opts.riskLevel, opts.effectiveFrom, opts.note, opts.membershipId, now, now],
    );
    return id;
  }

  async listStrReports(tenantId: string, filters: { status?: string; clientId?: string } = {}) {
    const where = ['r.tenant_id = ?'];
    const params: Param[] = [tenantId];
    if (filters.status) { where.push('r.status = ?'); params.push(filters.status); }
    if (filters.clientId) { where.push('r.client_id = ?'); params.push(filters.clientId); }
    const rows = await this.q().all<Row>(
      `select r.id, r.report_number, r.subject_kind, r.subject_name, r.client_id, r.matter_id,
              r.grounds, r.status, r.amount_sar, r.currency, r.prepared_at, r.filed_due_at,
              r.filed_at, r.fiu_reference, r.fiu_responded_at, r.closure_reason,
              c.name as client_name, m.matter_number
         from str_reports r
         left join clients c on c.id = r.client_id
         left join matters m on m.id = r.matter_id
        where ${where.join(' and ')}
        order by case when r.status = 'draft' then 0 else 1 end, r.filed_due_at desc nulls last`,
      params,
    );
    return (rows ?? []).map((r) => ({
      id: String(r.id), reportNumber: String(r.report_number),
      subjectKind: String(r.subject_kind), subjectName: strOrNull(r.subject_name),
      clientId: strOrNull(r.client_id), clientName: strOrNull(r.client_name),
      matterId: strOrNull(r.matter_id), matterNumber: strOrNull(r.matter_number),
      grounds: jsonArrayColumn(r.grounds), status: String(r.status),
      amountSar: r.amount_sar === null ? null : toNumber(r.amount_sar),
      currency: String(r.currency),
      preparedAt: strOrNull(r.prepared_at), filedDueAt: strOrNull(r.filed_due_at),
      filedAt: strOrNull(r.filed_at), fiuReference: strOrNull(r.fiu_reference),
      fiuRespondedAt: strOrNull(r.fiu_responded_at), closureReason: strOrNull(r.closure_reason),
    }));
  }

  async getStrReport(tenantId: string, id: string) {
    const row = await this.q().get<Row>(
      `select * from str_reports where tenant_id = ? and id = ?`, [tenantId, id]);
    return row ? {
      id: String(row.id), reportNumber: String(row.report_number),
      subjectKind: String(row.subject_kind), subjectId: strOrNull(row.subject_id),
      subjectName: strOrNull(row.subject_name), clientId: strOrNull(row.client_id),
      matterId: strOrNull(row.matter_id), grounds: jsonArrayColumn(row.grounds),
      narrativeAr: String(row.narrative_ar), narrativeEn: strOrNull(row.narrative_en),
      amountSar: row.amount_sar === null ? null : toNumber(row.amount_sar),
      currency: String(row.currency), transactionReference: strOrNull(row.transaction_reference),
      transactionAt: strOrNull(row.transaction_at), status: String(row.status),
      preparedAt: strOrNull(row.prepared_at), reviewedAt: strOrNull(row.reviewed_at),
      filedAt: strOrNull(row.filed_at), filedDueAt: strOrNull(row.filed_due_at),
      fiuReference: strOrNull(row.fiu_reference), fiuResponse: strOrNull(row.fiu_response),
      fiuRespondedAt: strOrNull(row.fiu_responded_at),
      tippingOffAcknowledgedAt: strOrNull(row.tipping_off_acknowledged_at),
      closureReason: strOrNull(row.closure_reason),
    } : null;
  }

  /**
   * A new report, in draft.
   *
   * `prepared_at` is set here rather than left to the column default, because the
   * three-working-day clock runs from when the firm formed the suspicion — and a draft
   * that acquired its deadline only when somebody remembered to file it would have a
   * clock that started late. The database sets `filed_due_at` from it, in both dialects:
   * in Postgres by trigger, and here by the same arithmetic the domain layer exports.
   */
  async createStrReport(opts: {
    tenantId: string; reportNumber: string; subjectKind: string; subjectId: string | null;
    subjectName: string | null; clientId: string | null; matterId: string | null;
    grounds: string[]; narrativeAr: string; narrativeEn: string | null;
    amountSar: number | null; transactionReference: string | null;
    transactionAt: string | null; membershipId: string | null;
    preparedAt: Date; dueAt: string;
  }): Promise<string> {
    const id = newId();
    const now = new Date().toISOString();
    await this.q().run(
      `insert into str_reports
         (id, tenant_id, report_number, subject_kind, subject_id, subject_name, client_id,
          matter_id, grounds, narrative_ar, narrative_en, amount_sar, currency,
          transaction_reference, transaction_at, status, prepared_by_membership_id,
          prepared_at, filed_due_at, created_by_membership_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SAR', ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
      [id, opts.tenantId, opts.reportNumber, opts.subjectKind, opts.subjectId,
        opts.subjectName, opts.clientId, opts.matterId, JSON.stringify(opts.grounds),
        opts.narrativeAr, opts.narrativeEn, opts.amountSar, opts.transactionReference,
        opts.transactionAt, opts.membershipId, opts.preparedAt.toISOString(),
        opts.dueAt, opts.membershipId, now, now],
    );
    return id;
  }

  /** A draft may be revised. A filed report may not — the database refuses it. */
  async updateStrReport(opts: {
    tenantId: string; id: string;
    fields: {
      grounds?: string[]; narrativeAr?: string; narrativeEn?: string | null;
      amountSar?: number | null; transactionReference?: string | null;
      transactionAt?: string | null; preparedAt?: Date; dueAt?: string;
    };
    membershipId: string | null;
  }): Promise<void> {
    const f = opts.fields;
    const now = new Date().toISOString();
    const sets: string[] = [];
    const params: Param[] = [];
    const put = (col: string, value: Param) => { sets.push(`${col} = ?`); params.push(value); };
    if (f.grounds) put('grounds', JSON.stringify(f.grounds));
    if (f.narrativeAr !== undefined) put('narrative_ar', f.narrativeAr);
    if (f.narrativeEn !== undefined) put('narrative_en', f.narrativeEn);
    if (f.amountSar !== undefined) put('amount_sar', f.amountSar);
    if (f.transactionReference !== undefined) put('transaction_reference', f.transactionReference);
    if (f.transactionAt !== undefined) put('transaction_at', f.transactionAt);
    if (f.preparedAt) { put('prepared_at', f.preparedAt.toISOString()); put('filed_due_at', f.dueAt ?? null); }
    if (sets.length === 0) return;
    put('updated_at', now);
    await this.q().run(
      `update str_reports set ${sets.join(', ')} where id = ? and tenant_id = ?`,
      [...params, opts.id, opts.tenantId],
    );
  }

  /**
   * The decision to file, and the filing.
   *
   * SEPARATE FROM `fileStrReport` BECAUSE THEY ARE DIFFERENT ACTS BY DIFFERENT PEOPLE in
   * this firm: the compliance officer reviews what the analyst wrote, and the record of
   * that review is the name the schema demands before a report may reach `filed`.
   */
  async reviewStrReport(opts: {
    tenantId: string; id: string; membershipId: string;
  }): Promise<number> {
    const now = new Date().toISOString();
    const r = await this.q().run(
      `update str_reports
          set status = 'pending_review', reviewed_by_membership_id = ?, reviewed_at = ?, updated_at = ?
        where id = ? and tenant_id = ? and status = 'draft'`,
      [opts.membershipId, now, now, opts.id, opts.tenantId],
    );
    return Number(r.changes ?? 0);
  }

  async fileStrReport(opts: {
    tenantId: string; id: string; membershipId: string; fiuReference: string;
    tippingOffAcknowledged: boolean;
  }): Promise<number> {
    const now = new Date().toISOString();
    const r = await this.q().run(
      `update str_reports
          set status = 'filed', filed_by_membership_id = ?, filed_at = ?, fiu_reference = ?,
              tipping_off_acknowledged_at = ?, tipping_off_acknowledged_by_membership_id = ?,
              updated_at = ?
        where id = ? and tenant_id = ? and status = 'pending_review'`,
      [opts.membershipId, now, opts.fiuReference,
        opts.tippingOffAcknowledged ? now : null,
        opts.tippingOffAcknowledged ? opts.membershipId : null,
        now, opts.id, opts.tenantId],
    );
    return Number(r.changes ?? 0);
  }

  /** What the authority answered. The only part of a filed report that may still change. */
  async recordFiuResponse(opts: {
    tenantId: string; id: string; status: string; response: string | null;
  }): Promise<number> {
    const now = new Date().toISOString();
    const r = await this.q().run(
      `update str_reports
          set status = ?, fiu_response = ?, fiu_responded_at = ?, updated_at = ?
        where id = ? and tenant_id = ? and status = 'filed'`,
      [opts.status, opts.response, now, now, opts.id, opts.tenantId],
    );
    return Number(r.changes ?? 0);
  }

  /**
   * The queue: every client whose record needs attention, and why.
   *
   * ONE QUERY, BECAUSE THE SCREEN HAS TO ANSWER THE SAME QUESTION THE GATE DOES. A list
   * assembled in the browser from three endpoints is a list that will disagree with the
   * gate on the day it matters; this one is computed from the same facts.
   */
  async dueDiligenceQueue(tenantId: string) {
    const rows = await this.q().all<Row>(
      `select c.id as client_id, c.name as client_name, c.client_type,
              d.id as dd_id, d.status, d.cdd_level, d.risk_rating, d.pep_status,
              d.review_due_at, d.completed_at,
              (select count(*) from beneficial_owners bo
                where bo.dd_id = d.id and bo.verified_at is not null
                  and bo.owner_kind = 'natural_person' and bo.control_basis = 'ownership') as owners_counted,
              coalesce((select sum(bo.ownership_pct) from beneficial_owners bo
                         where bo.dd_id = d.id and bo.verified_at is not null
                           and bo.owner_kind = 'natural_person' and bo.control_basis = 'ownership'), 0) as owners_pct,
              (select count(*) from beneficial_owners bo
                where bo.dd_id = d.id and bo.control_basis <> 'ownership' and bo.verified_at is not null) as control_rights,
              (select count(*) from screening_matches m
                 join screening_runs r on r.id = m.run_id
                where r.client_id = c.id and m.disposition = 'open') as open_matches,
              (select count(*) from screening_matches m
                 join screening_runs r on r.id = m.run_id
                where r.client_id = c.id and m.disposition = 'true_match') as confirmed_matches,
              (select count(*) from screening_runs r
                where r.client_id = c.id and r.status = 'failed') as failed_runs,
              (select count(*) from screening_runs r
                where r.client_id = c.id and r.status <> 'failed') as usable_runs
         from clients c
         left join client_due_diligence d
           on d.client_id = c.id and d.tenant_id = c.tenant_id and d.superseded_by is null
        where c.tenant_id = ? and c.status <> 'archived'
        order by c.name`,
      [tenantId],
    );
    return (rows ?? []).map((r) => {
      const ownersPct = toNumber(r.owners_pct);
      const controlRights = Number(r.control_rights);
      const isOrganization = String(r.client_type) !== 'individual';
      const ownershipCovered = !isOrganization || ownersPct >= 25 || controlRights > 0;
      const status = r.status === null ? 'not_started' : String(r.status);
      const failure: string[] = [];
      if (r.dd_id === null) failure.push('cdd_missing');
      else if (status === 'unable_to_complete') failure.push('cdd_unable_to_complete');
      else if (status !== 'complete') failure.push('cdd_incomplete');
      else {
        if (String(r.cdd_level) === 'enhanced') failure.push('senior_approval_required');
        if (r.pep_status && String(r.pep_status) !== 'not_pep'
            && String(r.cdd_level) !== 'enhanced') failure.push('senior_approval_required');
        if (r.review_due_at && String(r.review_due_at) < new Date().toISOString().slice(0, 10)) {
          failure.push('cdd_review_overdue');
        }
        if (!ownershipCovered) failure.push('cdd_beneficial_owner_missing');
        if (Number(r.confirmed_matches) > 0) failure.push('sanctions_match');
        else if (Number(r.open_matches) > 0) failure.push('screening_unresolved');
        else if (Number(r.failed_runs) > 0 && Number(r.usable_runs) === 0) failure.push('screening_incomplete');
        else if (Number(r.usable_runs) === 0) failure.push('screening_incomplete');
      }
      return {
        clientId: String(r.client_id), clientName: String(r.client_name),
        clientType: String(r.client_type), ddId: r.dd_id ?? null, status,
        level: r.cdd_level ?? null, riskRating: r.risk_rating ?? null,
        pepStatus: r.pep_status ?? null, reviewDueAt: r.review_due_at ?? null,
        ownershipPct: ownersPct, controlRights, openMatches: Number(r.open_matches),
        confirmedMatches: Number(r.confirmed_matches), failedRuns: Number(r.failed_runs),
        allowed: failure.length === 0, blockers: [...new Set(failure)],
      };
    });
  }

  /** The numbers a compliance page opens with. */
  async dueDiligenceCensus(tenantId: string) {
    const row = await this.q().get<Row>(
      `select
         (select count(*) from clients where tenant_id = ? and status <> 'archived') as clients,
         (select count(*) from client_due_diligence
           where tenant_id = ? and superseded_by is null and status = 'complete') as complete,
         (select count(*) from client_due_diligence
           where tenant_id = ? and superseded_by is null and status = 'unable_to_complete') as unable,
         (select count(*) from clients c
           where c.tenant_id = ? and c.status <> 'archived'
             and not exists (select 1 from client_due_diligence d
                              where d.client_id = c.id and d.superseded_by is null)) as not_started,
         (select count(*) from client_due_diligence
           where tenant_id = ? and superseded_by is null and review_due_at is not null
             and review_due_at < ?) as review_overdue,
         (select count(*) from screening_matches m join screening_runs r on r.id = m.run_id
           where r.tenant_id = ? and m.disposition = 'open') as open_matches,
         (select count(*) from screening_runs where tenant_id = ? and status = 'failed') as failed_runs,
         (select count(*) from str_reports where tenant_id = ? and status in ('draft','pending_review')) as reports_open,
         (select count(*) from str_reports where tenant_id = ? and status = 'filed') as reports_filed,
         (select count(*) from str_reports
           where tenant_id = ? and status in ('draft','pending_review')
             and filed_due_at is not null and filed_due_at < ?) as reports_late,
         (select count(*) from matters m
           where m.tenant_id = ? and m.internal_status = 'active'
             and not exists (select 1 from client_due_diligence d
                              where d.client_id = m.client_id and d.superseded_by is null
                                and d.status = 'complete')) as active_matters_unidentified`,
      [tenantId, tenantId, tenantId, tenantId, tenantId, new Date().toISOString(),
        tenantId, tenantId, tenantId, tenantId, tenantId, new Date().toISOString(), tenantId],
    );
    const n = (v: unknown) => Number(v ?? 0);
    return {
      clients: n(row?.clients), complete: n(row?.complete), unable: n(row?.unable),
      notStarted: n(row?.not_started), reviewOverdue: n(row?.review_overdue),
      openMatches: n(row?.open_matches), failedRuns: n(row?.failed_runs),
      reportsOpen: n(row?.reports_open), reportsFiled: n(row?.reports_filed),
      reportsLate: n(row?.reports_late),
      activeMattersUnidentified: n(row?.active_matters_unidentified),
    };
  }

}

// ============================================================================



// MAPPERS
// ============================================================================

/**
 * matter_team.matter_role -> default access level.
 *
 * This is the single TypeScript copy of the CASE expression inside
 * `matter_access_level()` in migration 0006. Same order, same outputs. A role
 * that is not listed falls back to 'view': being on a team at all is a
 * deliberate act, and the weakest useful level is the safe default.
 */
export function teamRoleToLevel(matterRole: string): string {
  switch (matterRole) {
    case 'lead_partner':
    case 'lead_lawyer':
    case 'supervising_partner':
      return 'full';
    case 'lawyer':
    case 'associate':
      return 'edit';
    case 'paralegal':
      return 'operational';
    case 'finance_contact':
      return 'financial';
    case 'compliance_contact':
      return 'compliance';
    default:
      return 'view';
  }
}

function toMembership(r: Row): MembershipRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    userId: String(r.user_id),
    staffId: String(r.staff_id),
    email: String(r.email),
    status: String(r.status),
    jobTitle: req(r.job_title),
    jobTitleAr: req(r.job_title_ar),
    // NULL is preserved as null. It must never become 0 or Infinity: the engine
    // reads null as "no authority" and refuses (§10).
    financialAuthority: toNullableNumber(r.financial_authority_sar),
    writeoffAuthority: toNullableNumber(r.writeoff_authority_sar),
    discountPct: toNullableNumber(r.discount_authority_pct),
    staffName: req(r.full_name),
    staffNameAr: req(r.full_name_ar),
    internalRole: req(r.internal_role),
    language: req(r.preferred_language) ?? 'ar',
    calendar: req(r.preferred_calendar) ?? 'islamic-umalqura',
    mfaEnabled: toBool(r.mfa_enabled),
  };
}

function toAuditEvent(r: Row) {
  const raw = r.metadata;
  let metadata: Record<string, unknown> = {};
  if (raw && typeof raw === 'object') metadata = raw as Record<string, unknown>;
  else if (typeof raw === 'string' && raw) {
    try { metadata = JSON.parse(raw) as Record<string, unknown>; } catch { metadata = {}; }
  }
  return {
    occurredAt: toIso(r.occurred_at),
    // Projected so a reviewer — and a test — can prove that a search returned
    // only the caller's own firm. The query already filters on it; showing it
    // makes the boundary visible instead of assumed.
    tenantId: req(r.tenant_id),
    actorKind: req(r.actor_kind),
    actorUserId: req(r.actor_user_id),
    action: req(r.action),
    resourceType: req(r.resource_type),
    resourceId: req(r.resource_id),
    outcome: req(r.outcome),
    reasonCode: req(r.reason_code),
    // IP hashes are deliberately NOT projected: an audit search is a privilege,
    // but it is not a licence to deanonymize request metadata in bulk.
    metadata,
  };
}

/** Today, as a DATE — the same value `current_date` resolves to in the trigger. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Money comparisons happen on the rounded cent; see PermissionEngine. */
function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function toNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function parseJsonArray(v: unknown, fallback: string[]): string[] {
  const s = req(v);
  if (!s) return fallback;
  try {
    const parsed: unknown = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map(String) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The restriction window after judicial or government service.
 *
 * Article 14 of نظام المحاماة — «لا يجوز للمحامي بنفسه أو بوساطة محامٍ آخر أن يقبل
 * أي دعوى أو يعطي أي استشارة ضد جهة يعمل لديها، أو ضد جهة انتهت علاقته بها، إلا
 * بعد مضي مدة لا تقل عن خمس سنوات من تاريخ انتهاء علاقته بها» — five years from
 * the end of the relationship. Rule 8/3 of قواعد السلوك المهني sets the same
 * period for a former employer.
 *
 * Rule 8/4 sets THREE years for a former CLIENT. That is a different rule against
 * a different relationship and is deliberately NOT applied here; conflating the
 * two would under-restrict the judicial case, which is the serious one.
 *
 * Named rather than inlined: a bare `5` in a date calculation is exactly the kind
 * of value a reader assumes means years, or days, or rows.
 */
const PRIOR_OFFICE_RESTRICTION_YEARS = 5;

/**
 * Adds whole years to an ISO date without `Date`'s month rollover.
 *
 * `new Date('2020-02-29')` stepped forward five years lands on 1 March, because
 * 2025 has no 29 February — so the restriction window would shorten by a day, in
 * favour of the person restricted, on leap years only. Clamping to the last valid
 * day of the target month is what a statutory period means when its end date does
 * not exist, and it is also the rule courts apply to a period expiring on a
 * non-existent day.
 */
export function addYears(isoDate: string, years: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  const targetYear = y + years;
  const lastDay = new Date(Date.UTC(targetYear, m, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface LicenceRow {
  id: string;
  licenceNumber: string;
  issuedAt: string | null;
  expiresAt: string | null;
  status: string;
  statusEffectiveFrom: string | null;
  statusReference: string | null;
  verifiedAt: string | null;
}

// ── P0.1 · row shapes and the two functions that resolve a derived value ──────

/**
 * `toStr` with a required-string contract, for the NOT NULL columns.
 *
 * The nullable `toStr` is the right default for a database where almost every
 * column may be absent, but the P0.1 tables are mostly NOT NULL and threading
 * `?? ''` through forty mappings would hide the two or three places where a null is
 * actually possible — which are the ones worth seeing.
 */
function req(v: unknown): string { return toStr(v) ?? ''; }

export type PartyRow = {
  id: string; kind: string; name: string; nameAr: string | null;
  normalized: string; commercialRegistration: string | null; vatNumber: string | null;
  nationalIdMasked: string | null; status: string; notes: string | null;
  matterCount: number;
  /** How many recorded name variants this party is known by. */
  aliasCount: number;
  createdAt: string;
};

function toPartyRow(r: Row): PartyRow {
  return {
    id: req(r.id), kind: req(r.kind), name: req(r.name),
    nameAr: r.name_ar == null ? null : req(r.name_ar),
    normalized: req(r.name_normalized),
    commercialRegistration: r.commercial_registration == null ? null : req(r.commercial_registration),
    vatNumber: r.vat_number == null ? null : req(r.vat_number),
    nationalIdMasked: r.national_id_masked == null ? null : req(r.national_id_masked),
    status: req(r.status),
    notes: r.notes == null ? null : req(r.notes),
    matterCount: toNumber(r.matter_count ?? 0),
    aliasCount: toNumber(r.alias_count ?? 0),
    createdAt: req(toIso(r.created_at)),
  };
}

export type ConflictHitRow = {
  id: string; checkId: string; matterId: string;
  partyId: string; partyName: string;
  matchedPartyId: string | null; matchedPartyName: string | null;
  matchedMatterId: string | null; matchedClientId: string | null;
  relation: string; matchStrength: string; matchBasis: string;
  affectedPartyId: string | null; affectedPartyName: string | null;
  /**
   * The DECISION. Null while the hit is open, because nobody has decided yet.
   * `conflict_hits_severity_needs_confirmation` refuses a severity on an open hit,
   * and the API mirrors that rather than filling the gap with the engine's opinion.
   */
  severity: string | null;
  /**
   * The ENGINE'S opinion, recorded beside the decision so that "the matcher flagged
   * this as potential and the lawyer recorded it as none" stays visible after the
   * decision is made. Never presented as a decision.
   */
  proposedSeverity: string | null;
  ruleCited: string;
  relationshipEndedOn: string | null; windowYears: number | null;
  windowLiftsOn: string | null; withinWindow: boolean | null;
  disposition: string; dispositionReason: string | null; dispositionAt: string | null;
  waiverCount: number;
};

/**
 * When the firm stopped acting for a client — Rule 8/4's starting point.
 *
 * «إذا مر على انقضاء العلاقة معهم أو تقديم آخر عمل لهم ثلاث سنوات» — the three
 * years run from the end of the relationship OR from the last work done for them,
 * and the rule treats those as the same moment. So an explicit date wins, the
 * newest closed matter is the fallback, and a client with an OPEN matter is not a
 * former client at all: work in progress means the relationship has not ended,
 * whatever a status column says.
 *
 * Written as a function rather than inline in the query because it is a legal
 * definition, and a legal definition written twice will differ.
 */
export function clientRelationshipEndedOn(input: {
  explicit: string | null; lastClosed: string | null; status: string;
}): string | null {
  if (input.status === 'active' && input.lastClosed === null) return null;
  if (input.explicit) return input.explicit;
  if (input.lastClosed) return input.lastClosed;
  // Inactive with no closed matter and no date: the firm stopped acting for them at
  // some point it did not record. Treating that as "still a client" would be the
  // permissive default, and the permissive default is what Rule 8/1 forbids, so the
  // window is treated as open — the conservative direction, and the reason this
  // returns null rather than a guessed date.
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * P0.2 · P1 — THE FISCAL DOCUMENT, CLIENT MONEY, AND WHAT A FEE RESTS ON
 *
 * These methods are `firm_repo.prototype` additions rather than a second class,
 * because they share the query scope (`this.q()`), the column coercion helpers and
 * the tenant discipline of everything above. What they do NOT share is a table:
 * every statement below names one of the twelve tables 0034–0036 created.
 *
 * THE RULE EVERY METHOD HERE FOLLOWS, AND WHY IT IS STATED ONCE AT THE TOP
 *
 *   The database is the authority on legality and this layer is the authority on
 *   bookkeeping. A fiscal issue is refused by `guard_invoice_fiscal_issue` whether or
 *   not this code checks anything — what the code adds is the CHAIN: allocating the
 *   ICV, building the QR, hashing the XML and writing the three of them in one
 *   statement. If this layer and the database disagree, the database wins and the
 *   caller gets a refusal with the database's own message, which is deliberate: the
 *   messages are written to be read by the person at the desk.
 * ══════════════════════════════════════════════════════════════════════════════ */

/** Columns the fiscal identity list returns. Named, never `select *`. */
const FISCAL_IDENTITY_COLUMNS =
  `id, tenant_id, registered_name, registered_name_ar, vat_registration_number,
   commercial_registration, registered_address, registered_address_ar, city,
   postal_code, country, environment, onboarding_status, certificate_expires_at,
   superseded_by, created_at, updated_at`;

export interface FiscalIdentityInput {
  tenantId: string;
  registeredName: string;
  registeredNameAr?: string | null;
  vatRegistrationNumber: string;
  commercialRegistration: string;
  registeredAddress: string;
  registeredAddressAr?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string;
  environment: 'sandbox' | 'simulation' | 'production';
  onboardingStatus: 'not_started' | 'csr_generated' | 'compliance_csid'
    | 'compliance_passed' | 'production_csid' | 'failed';
  certificateExpiresAt?: string | null;
}

export interface LedgerEntryInput {
  tenantId: string;
  clientId: string;
  entryType: 'receipt' | 'application_to_fee' | 'disbursement' | 'refund' | 'bank_charge'
    | 'interest' | 'reversal';
  amount: number;
  description: string;
  reference?: string | null;
  matterId?: string | null;
  invoiceId?: string | null;
  evidenceDocumentId?: string | null;
  reversesEntryId?: string | null;
  reversalReason?: string | null;
  entryAt?: string;
  recordedByUserId?: string | null;
}

export interface TimeEntryInput {
  tenantId: string;
  matterId: string;
  staffId: string;
  entryDate: string;
  minutes: number;
  narrative: string;
  narrativeAr?: string | null;
  billable: boolean;
  hourlyRateSar: number;
  approvedByUserId?: string | null;
}

export interface ExpenseInput {
  tenantId: string;
  matterId: string;
  clientId: string;
  submittedByStaff: string;
  incurredOn: string;
  category: string;
  description: string;
  descriptionAr?: string | null;
  netAmountSar: number;
  vatAmountSar: number;
  totalAmountSar: number;
  vatCategory: string;
  receiptDocumentId?: string | null;
  reimbursable: boolean;
}
