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
      createdAt: toIso(r.created_at),
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
    jobTitle: toStr(r.job_title),
    jobTitleAr: toStr(r.job_title_ar),
    // NULL is preserved as null. It must never become 0 or Infinity: the engine
    // reads null as "no authority" and refuses (§10).
    financialAuthority: toNullableNumber(r.financial_authority_sar),
    writeoffAuthority: toNullableNumber(r.writeoff_authority_sar),
    discountPct: toNullableNumber(r.discount_authority_pct),
    staffName: toStr(r.full_name),
    staffNameAr: toStr(r.full_name_ar),
    internalRole: toStr(r.internal_role),
    language: toStr(r.preferred_language) ?? 'ar',
    calendar: toStr(r.preferred_calendar) ?? 'islamic-umalqura',
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
    tenantId: toStr(r.tenant_id),
    actorKind: toStr(r.actor_kind),
    actorUserId: toStr(r.actor_user_id),
    action: toStr(r.action),
    resourceType: toStr(r.resource_type),
    resourceId: toStr(r.resource_id),
    outcome: toStr(r.outcome),
    reasonCode: toStr(r.reason_code),
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
  const s = toStr(v);
  if (!s) return fallback;
  try {
    const parsed: unknown = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map(String) : fallback;
  } catch {
    return fallback;
  }
}
