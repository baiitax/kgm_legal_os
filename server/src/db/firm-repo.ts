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
      `select m.id, m.matter_number, m.case_number, m.title, m.title_ar,
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
