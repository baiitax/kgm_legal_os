/**
 * THE PROJECTION REPOSITORY (§36, §37)
 *
 * This file is the only place in the portal that issues SQL. Two rules make it
 * the enforcement point for the projection boundary:
 *
 *   RULE A — every SELECT enumerates its columns explicitly. There is no
 *            `select *` anywhere in this file. A column is client-safe only if
 *            it is named here. The Postgres column grants in migration 0004
 *            enforce the same list a second time, at the database.
 *
 *   RULE B — every read that returns domain data takes `clientIds` and filters
 *            on it in SQL. There is no repository method that can return
 *            another client's rows, because none exists.
 *
 * `internal_notes` has NO method here. That is intentional and is the
 * structural guarantee behind §11/§22.
 */
import type { Db, Param, Queryable, Row } from './types.js';
import { currentQueryable, currentScope } from './context.js';
import { toBool, toIso, toMoney, toNumber, toStr } from './types.js';

/** Shape of an audit insert. metadata stays structured; it is serialized here. */
export interface AuditRow {
  occurred_at: string;
  tenant_id?: string | null;
  actor_kind: string;
  actor_user_id?: string | null;
  actor_client_id?: string | null;
  action: string;
  resource_type?: string | null;
  resource_id?: string | null;
  outcome?: string;
  reason_code?: string | null;
  ip_hash?: string | null;
  ip_country?: string | null;
  user_agent?: string | null;
  request_id?: string | null;
  metadata?: Record<string, unknown>;
}

export class Repo {
  constructor(private readonly db: Db) {}

  private q(): Queryable {
    return currentQueryable(this.db);
  }

  /**
   * Runs `fn` inside a transaction on the request's connection so a mutation
   * and its audit event commit or roll back together (§38). Outside a request
   * scope (seeding, tests) the work simply runs directly.
   */
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const scope = currentScope();
    return scope ? scope.tx(fn) : fn();
  }

  /**
   * Restricted SQL passthrough, used ONLY by the payment webhook path.
   *
   * That path runs as the `payments_service` Postgres role — the only role with
   * UPDATE on invoices — and is reached exclusively through a signature-verified
   * webhook. Keeping it separate from the projection methods above means a
   * client-facing handler can never borrow it: the portal role has no invoice
   * write grant at all (migration 0004), so even misuse fails at the database.
   */
  readonly raw = {
    all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      this.q().all<T>(sql, params as never),
    get: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      this.q().get<T>(sql, params as never),
    run: (sql: string, params: unknown[] = []) =>
      this.q().run(sql, params as never),
  };

  // =========================================================================
  // IDENTITY
  // =========================================================================
  async getUserByEmail(email: string) {
    return this.q().get<Row>(
      `select id, email, password_hash, password_updated_at, email_verified_at, status,
              failed_login_count, locked_until, last_login_at, last_login_ip_hash,
              mfa_enabled, mfa_method, mfa_secret_enc, mfa_enabled_at,
              preferred_language, preferred_calendar, created_at
         from users where email = ?`,
      [email.toLowerCase().trim()],
    );
  }

  async getUserById(id: string) {
    return this.q().get<Row>(
      `select id, email, password_hash, password_updated_at, email_verified_at, status,
              failed_login_count, locked_until, last_login_at, last_login_ip_hash,
              mfa_enabled, mfa_method, mfa_secret_enc, mfa_enabled_at,
              preferred_language, preferred_calendar, created_at
         from users where id = ?`,
      [id],
    );
  }

  async createUser(row: Record<string, Param>) {
    await this.q().run(
      /*
        `mfa_enabled` is written as the literal FALSE, not 0.

        SQLite stores booleans as integers and accepts either; Postgres has a real
        boolean type and refuses `0` for it outright:

          column "mfa_enabled" is of type boolean but expression is of type integer

        This is the same class as `is_active = 1` and `coalesce(bool, 0)`, and the
        reason the repository's SQL conventions say booleans are written as the
        literals TRUE/FALSE. It surfaced on the invitation flow, because accepting
        an invitation is the one path that CREATES a user — every other flow reads
        an existing row, so a fresh account could not be provisioned at all.
      */
      `insert into users (id, email, password_hash, password_updated_at, email_verified_at,
                          status, failed_login_count, mfa_enabled, preferred_language,
                          preferred_calendar, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, 0, FALSE, ?, ?, ?, ?)`,
      [row.id, row.email, row.password_hash ?? null, row.password_updated_at ?? null,
       row.email_verified_at ?? null, row.status ?? 'invited', row.preferred_language ?? 'ar',
       row.preferred_calendar ?? 'islamic-umalqura', row.created_at, row.updated_at],
    );
  }

  async updateUser(id: string, patch: Record<string, Param>) {
    const allowed = new Set([
      'password_hash', 'password_updated_at', 'email_verified_at', 'status',
      'failed_login_count', 'locked_until', 'last_login_at', 'last_login_ip_hash',
      'mfa_enabled', 'mfa_method', 'mfa_secret_enc', 'mfa_enabled_at',
      'preferred_language', 'preferred_calendar', 'updated_at',
    ]);
    const keys = Object.keys(patch).filter((k) => allowed.has(k));
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    await this.q().run(
      `update users set ${sets} where id = ?`,
      [...keys.map((k) => patch[k]), id],
    );
  }

  /**
   * The authorization join. This is the ONLY source of tenant/client identity
   * for a request — never a value from the request body, query or headers.
   */
  async getClientUsersForUser(userId: string) {
    /*
      NO JOIN TO `clients` HERE, and the reason is not style.

      This query runs while the session is being RESOLVED — the AUTH phase, before
      the request has a tenant or a client scope. `clients` has no policy for that
      phase, so a join to it returns nothing: the name comes back null and the
      shell silently renders without it. SQLite has no RLS, so the same join passes
      the whole suite and fails on the deployed system, which is what happened.

      The client's name is therefore read by the SESSION ROUTE, in the portal phase
      the join was implicitly assuming it was in (`ClientService.getEntityName`).
    */
    return this.q().all<Row>(
      `select cu.id, cu.user_id, cu.client_id, cu.tenant_id, cu.display_name,
              cu.display_name_ar, cu.job_title, cu.phone, cu.portal_role, cu.status
         from client_users cu
        where cu.user_id = ? and cu.status = 'active'`,
      [userId],
    );
  }

  /**
   * The client's own name, in the portal phase.
   *
   * Two columns, and nothing else: the shell needs a label, not a record. RLS
   * narrows this to the caller's tenant and the exact set of client ids their
   * `client_users` rows grant, so it cannot be turned into a read of another
   * client — and a missing row returns undefined rather than throwing, because a
   * blank entity line is a far better outcome than a portal that will not load.
   */
  async getClientEntityName(clientId: string, tenantId: string) {
    const row = await this.q().get<Row>(
      `select name, name_ar from clients where id = ? and tenant_id = ?`,
      [clientId, tenantId],
    );
    return row ? { name: String(row.name), nameAr: (row.name_ar as string | null) ?? null } : null;
  }

  async getClient(clientId: string, tenantId: string) {
    return this.q().get<Row>(
      `select id, tenant_id, client_type, name, name_ar, national_id_masked,
              commercial_reg_masked, email, phone, address_line, city, country,
              identity_verified, verification_note, status
         from clients where id = ? and tenant_id = ?`,
      [clientId, tenantId],
    );
  }

  async getTenant(tenantId: string) {
    return this.q().get<Row>(
      `select id, slug, name, name_ar, country, default_language, default_calendar
         from tenants where id = ?`,
      [tenantId],
    );
  }

  async updateClientProfile(clientId: string, tenantId: string, patch: Record<string, Param>) {
    // Phone/address only. name, client_type, national_id*, tenant_id, status and
    // identity_verified are firm-controlled (§25, §35 R11).
    const allowed = new Set(['phone', 'address_line', 'city', 'country']);
    const keys = Object.keys(patch).filter((k) => allowed.has(k) && patch[k] !== undefined);
    if (!keys.length) return { changes: 0 };
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    return this.q().run(
      `update clients set ${sets}, updated_at = ? where id = ? and tenant_id = ?`,
      [...keys.map((k) => patch[k]), new Date().toISOString(), clientId, tenantId],
    );
  }

  async updateClientUserDisplay(clientUserId: string, userId: string, patch: Record<string, Param>) {
    const allowed = new Set(['display_name', 'display_name_ar', 'job_title', 'phone']);
    const keys = Object.keys(patch).filter((k) => allowed.has(k) && patch[k] !== undefined);
    if (!keys.length) return { changes: 0 };
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    return this.q().run(
      `update client_users set ${sets}, updated_at = ? where id = ? and user_id = ?`,
      [...keys.map((k) => patch[k]), new Date().toISOString(), clientUserId, userId],
    );
  }

  // =========================================================================
  // INVITATIONS
  // =========================================================================
  async getInvitationByTokenHash(tokenHash: string) {
    return this.q().get<Row>(
      `select id, tenant_id, client_id, email, display_name, display_name_ar, portal_role,
              token_hash, token_hint, expires_at, accepted_at, revoked_at, created_at
         from client_invitations where token_hash = ?`,
      [tokenHash],
    );
  }

  async createInvitation(row: Record<string, Param>) {
    await this.q().run(
      `insert into client_invitations (id, tenant_id, client_id, email, display_name,
              display_name_ar, portal_role, token_hash, token_hint, expires_at,
              created_by_staff, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.tenant_id, row.client_id, row.email, row.display_name, row.display_name_ar ?? null,
       row.portal_role, row.token_hash, row.token_hint, row.expires_at, row.created_by_staff ?? null,
       row.created_at],
    );
  }

  async markInvitationAccepted(id: string, ipHash: string | null) {
    await this.q().run(
      `update client_invitations set accepted_at = ?, accept_ip_hash = ?
        where id = ? and accepted_at is null and revoked_at is null`,
      [new Date().toISOString(), ipHash, id],
    );
  }

  async createClientUser(row: Record<string, Param>) {
    await this.q().run(
      `insert into client_users (id, user_id, client_id, tenant_id, display_name,
              display_name_ar, job_title, phone, portal_role, status, created_by_staff,
              created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [row.id, row.user_id, row.client_id, row.tenant_id, row.display_name,
       row.display_name_ar ?? null, row.job_title ?? null, row.phone ?? null,
       row.portal_role, row.created_by_staff ?? null, row.created_at, row.updated_at],
    );
  }

  // =========================================================================
  // SESSIONS & DEVICES
  // =========================================================================
  async createSession(row: Record<string, Param>) {
    await this.q().run(
      `insert into client_sessions (id, user_id, tenant_id, client_id, token_hash,
              created_at, last_activity, expires_at, idle_expires_at, ip_hash, ip_country,
              user_agent, device_label, browser, os, mfa_verified_at, trusted_device_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.user_id, row.tenant_id ?? null, row.client_id ?? null, row.token_hash,
       row.created_at, row.last_activity, row.expires_at, row.idle_expires_at,
       row.ip_hash ?? null, row.ip_country ?? null, row.user_agent ?? null,
       row.device_label ?? null, row.browser ?? null, row.os ?? null,
       row.mfa_verified_at ?? null, row.trusted_device_id ?? null],
    );
  }

  async getSessionByTokenHash(tokenHash: string) {
    return this.q().get<Row>(
      `select id, user_id, tenant_id, client_id, token_hash, created_at, last_activity,
              expires_at, idle_expires_at, ip_hash, ip_country, user_agent, device_label,
              browser, os, mfa_verified_at, trusted_device_id, revoked_at, revoke_reason
         from client_sessions where token_hash = ?`,
      [tokenHash],
    );
  }

  async touchSession(id: string, lastActivity: string, idleExpires: string) {
    await this.q().run(
      `update client_sessions set last_activity = ?, idle_expires_at = ? where id = ?`,
      [lastActivity, idleExpires, id],
    );
  }

  async markSessionMfaVerified(id: string, at: string) {
    await this.q().run(`update client_sessions set mfa_verified_at = ? where id = ?`, [at, id]);
  }

  async revokeSession(id: string, reason: string) {
    await this.q().run(
      `update client_sessions set revoked_at = ?, revoke_reason = ?
        where id = ? and revoked_at is null`,
      [new Date().toISOString(), reason, id],
    );
  }

  async revokeSessionsForUser(userId: string, reason: string, exceptId?: string) {
    const now = new Date().toISOString();
    if (exceptId) {
      return this.q().run(
        `update client_sessions set revoked_at = ?, revoke_reason = ?
          where user_id = ? and revoked_at is null and id <> ?`,
        [now, reason, userId, exceptId],
      );
    }
    return this.q().run(
      `update client_sessions set revoked_at = ?, revoke_reason = ?
        where user_id = ? and revoked_at is null`,
      [now, reason, userId],
    );
  }

  async listActiveSessions(userId: string) {
    return this.q().all<Row>(
      `select id, created_at, last_activity, expires_at, ip_country, device_label,
              browser, os, user_agent, mfa_verified_at, revoked_at
         from client_sessions
        where user_id = ? and revoked_at is null and expires_at > ?
        order by last_activity desc`,
      [userId, new Date().toISOString()],
    );
  }

  async getSessionForUser(userId: string, sessionId: string) {
    return this.q().get<Row>(
      `select id, user_id, created_at, last_activity, expires_at, ip_country,
              device_label, browser, os, revoked_at
         from client_sessions where id = ? and user_id = ?`,
      [sessionId, userId],
    );
  }

  /**
   * Housekeeping. Sessions past their absolute expiry are deleted; revoked ones
   * are retained for seven days so the login history in the Security centre
   * still shows why a device was signed out.
   */
  async purgeExpiredSessions() {
    const now = Date.now();
    return this.q().run(
      `delete from client_sessions
        where expires_at < ?
           or (revoked_at is not null and revoked_at < ?)`,
      [new Date(now).toISOString(), new Date(now - 7 * 86_400_000).toISOString()],
    );
  }

  async upsertDevice(row: Record<string, Param>) {
    await this.q().run(
      `insert into client_devices (id, user_id, fingerprint_hash, label, trusted_until,
              mfa_trusted, last_seen_at, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (user_id, fingerprint_hash) do update set
         last_seen_at = excluded.last_seen_at,
         label = coalesce(excluded.label, client_devices.label),
         trusted_until = case when excluded.mfa_trusted = TRUE then excluded.trusted_until
                              else client_devices.trusted_until end,
         mfa_trusted = case when excluded.mfa_trusted = TRUE then TRUE
                            else client_devices.mfa_trusted end`,
      [row.id, row.user_id, row.fingerprint_hash, row.label ?? null, row.trusted_until ?? null,
       row.mfa_trusted ?? false, row.last_seen_at, row.created_at],
    );
  }

  async getDeviceByFingerprint(userId: string, fingerprintHash: string) {
    return this.q().get<Row>(
      `select id, user_id, fingerprint_hash, label, trusted_until, mfa_trusted,
              last_seen_at, revoked_at, created_at
         from client_devices where user_id = ? and fingerprint_hash = ?`,
      [userId, fingerprintHash],
    );
  }

  async listDevices(userId: string) {
    return this.q().all<Row>(
      `select id, label, trusted_until, mfa_trusted, last_seen_at, revoked_at, created_at
         from client_devices where user_id = ? order by last_seen_at desc`,
      [userId],
    );
  }

  async revokeDevice(userId: string, deviceId: string) {
    return this.q().run(
      `update client_devices set revoked_at = ?, trusted_until = null, mfa_trusted = FALSE
        where id = ? and user_id = ?`,
      [new Date().toISOString(), deviceId, userId],
    );
  }

  // =========================================================================
  // LOGIN ATTEMPTS / TOKENS / ALERTS
  // =========================================================================
  async recordLoginAttempt(row: Record<string, Param>) {
    await this.q().run(
      `insert into login_attempts (email, user_id, ip_hash, user_agent, outcome, created_at)
       values (?, ?, ?, ?, ?, ?)`,
      [row.email ?? null, row.user_id ?? null, row.ip_hash, row.user_agent ?? null,
       row.outcome, row.created_at],
    );
  }

  async countRecentLoginFailures(email: string | null, ipHash: string | null, sinceIso: string) {
    const byEmail = email
      ? await this.q().get<{ n: number }>(
          `select count(*) as n from login_attempts
            where email = ? and outcome in ('bad_password','mfa_failed') and created_at > ?`,
          [email, sinceIso],
        )
      : { n: 0 };
    const byIp = ipHash
      ? await this.q().get<{ n: number }>(
          `select count(*) as n from login_attempts
            where ip_hash = ? and outcome in ('bad_password','mfa_failed','unknown_account')
              and created_at > ?`,
          [ipHash, sinceIso],
        )
      : { n: 0 };
    return { byEmail: toNumber(byEmail?.n), byIp: toNumber(byIp?.n) };
  }

  async createAuthToken(row: Record<string, Param>) {
    await this.q().run(
      `insert into auth_tokens (id, user_id, kind, token_hash, code_hash, expires_at,
                                attempts, created_ip_hash, created_at)
       values (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [row.id, row.user_id, row.kind, row.token_hash, row.code_hash ?? null,
       row.expires_at, row.created_ip_hash ?? null, row.created_at],
    );
  }

  async getAuthToken(kind: string, tokenHash: string) {
    return this.q().get<Row>(
      `select id, user_id, kind, token_hash, code_hash, expires_at, used_at, attempts, created_at
         from auth_tokens where kind = ? and token_hash = ?`,
      [kind, tokenHash],
    );
  }

  async getActiveOtp(userId: string, kind: string) {
    return this.q().get<Row>(
      `select id, user_id, kind, code_hash, expires_at, used_at, attempts, created_at
         from auth_tokens
        where user_id = ? and kind = ? and used_at is null and expires_at > ?
        order by created_at desc`,
      [userId, kind, new Date().toISOString()],
    );
  }

  async consumeAuthToken(id: string) {
    await this.q().run(
      `update auth_tokens set used_at = ? where id = ? and used_at is null`,
      [new Date().toISOString(), id],
    );
  }

  async incrementTokenAttempts(id: string) {
    await this.q().run(`update auth_tokens set attempts = attempts + 1 where id = ?`, [id]);
  }

  async revokeTokensForUser(userId: string, kind: string) {
    await this.q().run(
      `update auth_tokens set used_at = ? where user_id = ? and kind = ? and used_at is null`,
      [new Date().toISOString(), userId, kind],
    );
  }

  async saveRecoveryCodes(userId: string, hashes: string[]) {
    const now = new Date().toISOString();
    for (const h of hashes) {
      await this.q().run(
        `insert into mfa_recovery_codes (id, user_id, code_hash, used_at, created_at)
         values (?, ?, ?, null, ?)`,
        [cryptoRandomId(), userId, h, now],
      );
    }
  }

  async consumeRecoveryCode(userId: string, codeHash: string) {
    const res = await this.q().run(
      `update mfa_recovery_codes set used_at = ?
        where user_id = ? and code_hash = ? and used_at is null`,
      [new Date().toISOString(), userId, codeHash],
    );
    return res.changes > 0;
  }

  async createSecurityAlert(row: Record<string, Param>) {
    await this.q().run(
      `insert into security_alerts (id, user_id, tenant_id, kind, severity, message,
              message_ar, ip_hash, ip_country, user_agent, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.user_id, row.tenant_id ?? null, row.kind, row.severity ?? 'info',
       row.message ?? null, row.message_ar ?? null, row.ip_hash ?? null,
       row.ip_country ?? null, row.user_agent ?? null, row.created_at],
    );
  }

  async listSecurityAlerts(userId: string, limit = 20) {
    return this.q().all<Row>(
      `select id, kind, severity, message, message_ar, ip_country, acknowledged_at, created_at
         from security_alerts where user_id = ? order by created_at desc limit ?`,
      [userId, limit],
    );
  }

  // =========================================================================
  // MATTERS
  // =========================================================================
  async listMatters(tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return [];
    const ph = clientIds.map(() => '?').join(',');
    return this.q().all<Row>(
      `select m.id, m.matter_number, m.case_number, m.title, m.title_ar,
              m.practice_area, m.practice_area_ar, m.court, m.court_ar,
              m.client_status, m.summary, m.summary_ar, m.opened_at, m.closed_at,
              m.last_client_update_at
         from matters m
        where m.tenant_id = ? and m.client_id in (${ph})
          and m.client_status <> 'archived'
        order by m.last_client_update_at desc, m.opened_at desc`,
      [tenantId, ...clientIds],
    );
  }

  async getMatter(matterId: string, tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return undefined;
    const ph = clientIds.map(() => '?').join(',');
    return this.q().get<Row>(
      `select m.id, m.client_id, m.matter_number, m.case_number, m.title, m.title_ar,
              m.practice_area, m.practice_area_ar, m.court, m.court_ar,
              m.client_status, m.summary, m.summary_ar, m.opened_at, m.closed_at,
              m.last_client_update_at
         from matters m
        where m.id = ? and m.tenant_id = ? and m.client_id in (${ph})`,
      [matterId, tenantId, ...clientIds],
    );
  }

  async listMatterTeam(matterId: string, tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return [];
    const ph = clientIds.map(() => '?').join(',');
    return this.q().all<Row>(
      `select s.full_name, s.full_name_ar, s.client_title, s.client_title_ar,
              mt.matter_role, mt.client_role_label, mt.client_role_label_ar
         from matter_team mt
         join staff s on s.id = mt.staff_id
         join matters m on m.id = mt.matter_id
        where mt.matter_id = ? and mt.tenant_id = ? and m.client_id in (${ph})
          and mt.client_visible = TRUE and mt.is_active = TRUE
          and s.client_visible = TRUE and s.is_active = TRUE
        order by mt.matter_role`,
      [matterId, tenantId, ...clientIds],
    );
  }

  async listTimeline(matterId: string, tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return [];
    const ph = clientIds.map(() => '?').join(',');
    return this.q().all<Row>(
      `select t.id, t.occurred_at, t.event_type, t.title, t.title_ar,
              t.description, t.description_ar, t.status
         from matter_timeline t
         join matters m on m.id = t.matter_id
        where t.matter_id = ? and t.tenant_id = ? and m.client_id in (${ph})
          and t.client_visible = TRUE
        order by t.occurred_at desc`,
      [matterId, tenantId, ...clientIds],
    );
  }

  // =========================================================================
  // HEARINGS & DEADLINES
  // =========================================================================
  async listHearings(tenantId: string, clientIds: string[], matterId?: string) {
    if (!clientIds.length) return [];
    const ph = clientIds.map(() => '?').join(',');
    const extra = matterId ? ' and h.matter_id = ?' : '';
    return this.q().all<Row>(
      `select h.id, h.matter_id, h.scheduled_at, h.ends_at, h.court, h.court_ar,
              h.hearing_type, h.location, h.location_ar, h.is_remote, h.remote_platform,
              h.remote_link, h.client_status, h.instructions, h.instructions_ar,
              m.title as matter_title, m.title_ar as matter_title_ar, m.case_number
         from hearings h
         join matters m on m.id = h.matter_id
        where h.tenant_id = ? and h.client_id in (${ph}) and h.client_visible = TRUE${extra}
        order by h.scheduled_at desc`,
      matterId ? [tenantId, ...clientIds, matterId] : [tenantId, ...clientIds],
    );
  }

  async listDeadlines(tenantId: string, clientIds: string[], matterId?: string) {
    if (!clientIds.length) return [];
    const ph = clientIds.map(() => '?').join(',');
    const extra = matterId ? ' and d.matter_id = ?' : '';
    // kind = 'client_action' AND client_visible = TRUE: internal lawyer tasks
    // are excluded at the SQL level, not filtered in the UI (§16).
    return this.q().all<Row>(
      `select d.id, d.matter_id, d.title, d.title_ar, d.description, d.description_ar,
              d.due_at, d.priority, d.client_status,
              m.title as matter_title, m.title_ar as matter_title_ar
         from deadlines d
         join matters m on m.id = d.matter_id
        where d.tenant_id = ? and d.client_id in (${ph})
          and d.kind = 'client_action' and d.client_visible = TRUE${extra}
        order by d.due_at asc`,
      matterId ? [tenantId, ...clientIds, matterId] : [tenantId, ...clientIds],
    );
  }

  async updateDeadlineClientStatus(deadlineId: string, tenantId: string, clientIds: string[], status: string) {
    if (!clientIds.length) return { changes: 0 };
    const ph = clientIds.map(() => '?').join(',');
    // Only a narrow, forward-only transition set is permitted.
    if (!['in_progress', 'submitted', 'completed'].includes(status)) return { changes: 0 };
    return this.q().run(
      `update deadlines set client_status = ?, updated_at = ?
        where id = ? and tenant_id = ? and client_id in (${ph})
          and kind = 'client_action' and client_visible = TRUE`,
      [status, new Date().toISOString(), deadlineId, tenantId, ...clientIds],
    );
  }

  // =========================================================================
  // DOCUMENTS
  // =========================================================================
  async listDocuments(tenantId: string, clientIds: string[], opts: { matterId?: string; category?: string } = {}) {
    if (!clientIds.length) return [];
    const ph = clientIds.map(() => '?').join(',');
    const clauses: string[] = [
      'd.tenant_id = ?',
      `d.client_id in (${ph})`,
      "d.client_visibility = 'visible'",
      "d.status <> 'purged'",
    ];
    const params: Param[] = [tenantId, ...clientIds];
    if (opts.matterId) { clauses.push('d.matter_id = ?'); params.push(opts.matterId); }
    if (opts.category) { clauses.push('d.category = ?'); params.push(opts.category); }
    return this.q().all<Row>(
      `select d.id, d.matter_id, d.title, d.title_ar, d.document_type, d.category,
              d.origin, d.version, d.mime_type, d.size_bytes, d.status, d.scan_status,
              d.requested, d.request_note, d.request_note_ar, d.created_at, d.original_filename,
              m.title as matter_title, m.title_ar as matter_title_ar
         from documents d
         left join matters m on m.id = d.matter_id
        where ${clauses.join(' and ')}
        order by d.created_at desc`,
      params,
    );
  }

  /**
   * The single authorization gate for document bytes (§18, §35 R10).
   * A document is returnable only if it belongs to the tenant AND to one of the
   * caller's clients AND is client-visible AND available AND scan-clean.
   */
  async getReadableDocument(documentId: string, tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return undefined;
    const ph = clientIds.map(() => '?').join(',');
    return this.q().get<Row>(
      `select d.id, d.tenant_id, d.client_id, d.matter_id, d.storage_bucket, d.storage_key,
              d.original_filename, d.title, d.title_ar, d.document_type, d.category,
              d.mime_type, d.size_bytes, d.sha256, d.version, d.status, d.scan_status,
              d.client_visibility, d.created_at
         from documents d
        where d.id = ? and d.tenant_id = ? and d.client_id in (${ph})
          and d.client_visibility = 'visible'
          and d.status = 'available'
          and d.scan_status = 'clean'`,
      [documentId, tenantId, ...clientIds],
    );
  }

  async insertDocument(row: Record<string, Param>) {
    await this.q().run(
      `insert into documents (id, tenant_id, client_id, matter_id, storage_bucket,
              storage_key, original_filename, stored_filename, title, title_ar,
              document_type, category, origin, version, mime_type, size_bytes, sha256,
              scan_status, scanned_at, status, client_visibility, requested,
              uploaded_by_user_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'clean', ?, 'available',
               'visible', ?, ?, ?, ?)`,
      [row.id, row.tenant_id, row.client_id, row.matter_id ?? null, row.storage_bucket,
       row.storage_key, row.original_filename, row.stored_filename, row.title, row.title_ar ?? null,
       row.document_type, row.category, row.origin, row.mime_type, row.size_bytes, row.sha256,
       row.scanned_at, row.requested ?? false, row.uploaded_by_user_id ?? null,
       row.created_at, row.created_at],
    );
  }

  async logDocumentAccess(row: Record<string, Param>) {
    await this.q().run(
      `insert into document_access_log (document_id, tenant_id, accessor_kind, accessor_id,
                                        action, ip_hash, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [row.document_id, row.tenant_id, row.accessor_kind, row.accessor_id ?? null,
       row.action, row.ip_hash ?? null, row.created_at],
    );
  }

  /** Marks a firm-requested document as fulfilled when the client uploads it. */
  async fulfillDocumentRequest(requestDocId: string, tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return { changes: 0 };
    const ph = clientIds.map(() => '?').join(',');
    return this.q().run(
      `update documents set requested = FALSE, updated_at = ?
        where id = ? and tenant_id = ? and client_id in (${ph}) and requested = TRUE`,
      [new Date().toISOString(), requestDocId, tenantId, ...clientIds],
    );
  }

  // =========================================================================
  // INVOICES & PAYMENTS
  // =========================================================================
  /**
   * Draft and pending_internal_approval invoices are excluded in SQL, so they
   * cannot be enumerated or fetched by a client at all (§20).
   */
  async listInvoices(tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return [];
    const ph = clientIds.map(() => '?').join(',');
    return this.q().all<Row>(
      `select i.id, i.invoice_number, i.issue_date, i.due_date, i.currency, i.subtotal,
              i.vat_rate, i.vat_amount, i.total, i.amount_paid, i.client_status, i.matter_id,
              m.title as matter_title, m.title_ar as matter_title_ar
         from invoices i
         left join matters m on m.id = i.matter_id
        where i.tenant_id = ? and i.client_id in (${ph})
          and i.internal_status not in ('draft','pending_internal_approval')
        order by i.due_date asc`,
      [tenantId, ...clientIds],
    );
  }

  async getInvoice(invoiceId: string, tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return undefined;
    const ph = clientIds.map(() => '?').join(',');
    return this.q().get<Row>(
      `select i.id, i.invoice_number, i.issue_date, i.due_date, i.currency, i.subtotal,
              i.vat_rate, i.vat_amount, i.total, i.amount_paid, i.client_status,
              i.matter_id, i.client_id, i.storage_key,
              m.title as matter_title, m.title_ar as matter_title_ar, m.matter_number
         from invoices i
         left join matters m on m.id = i.matter_id
        where i.id = ? and i.tenant_id = ? and i.client_id in (${ph})
          and i.internal_status not in ('draft','pending_internal_approval')`,
      [invoiceId, tenantId, ...clientIds],
    );
  }

  async listInvoiceLines(invoiceId: string, tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return [];
    const ph = clientIds.map(() => '?').join(',');
    return this.q().all<Row>(
      `select l.id, l.position, l.description, l.description_ar, l.quantity, l.unit_price, l.amount
         from invoice_lines l
         join invoices i on i.id = l.invoice_id
        where l.invoice_id = ? and i.tenant_id = ? and i.client_id in (${ph})
          and i.internal_status not in ('draft','pending_internal_approval')
        order by l.position`,
      [invoiceId, tenantId, ...clientIds],
    );
  }

  async listPaymentsForInvoice(invoiceId: string, tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return [];
    const ph = clientIds.map(() => '?').join(',');
    return this.q().all<Row>(
      `select p.id, p.provider, p.amount, p.currency, p.status, p.receipt_number,
              p.completed_at, p.created_at
         from payments p
         join invoices i on i.id = p.invoice_id
        where p.invoice_id = ? and p.tenant_id = ? and i.client_id in (${ph})
        order by p.created_at desc`,
      [invoiceId, tenantId, ...clientIds],
    );
  }

  async getReceiptForInvoice(invoiceId: string, tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return undefined;
    const ph = clientIds.map(() => '?').join(',');
    return this.q().get<Row>(
      `select r.id, r.receipt_number, r.issued_at, r.amount, r.currency, r.storage_key, r.payment_id
         from receipts r
        where r.invoice_id = ? and r.tenant_id = ? and r.client_id in (${ph})
        order by r.issued_at desc`,
      [invoiceId, tenantId, ...clientIds],
    );
  }

  async createPaymentIntent(row: Record<string, Param>) {
    await this.q().run(
      `insert into payments (id, tenant_id, invoice_id, client_id, initiated_by_user_id,
              provider, idempotency_key, amount, currency, status, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, 'SAR', 'intent_created', ?)`,
      [row.id, row.tenant_id, row.invoice_id, row.client_id, row.initiated_by_user_id,
       row.provider, row.idempotency_key, row.amount, row.created_at],
    );
  }

  async getPaymentIntent(id: string, tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return undefined;
    const ph = clientIds.map(() => '?').join(',');
    return this.q().get<Row>(
      `select p.id, p.invoice_id, p.amount, p.currency, p.status, p.provider, p.idempotency_key
         from payments p join invoices i on i.id = p.invoice_id
        where p.id = ? and p.tenant_id = ? and i.client_id in (${ph})`,
      [id, tenantId, ...clientIds],
    );
  }

  // =========================================================================
  // MESSAGES
  // =========================================================================
  async listThreads(tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return [];
    const ph = clientIds.map(() => '?').join(',');
    return this.q().all<Row>(
      `select t.id, t.matter_id, t.subject, t.subject_ar, t.thread_status,
              t.last_message_at, t.created_at,
              m.title as matter_title, m.title_ar as matter_title_ar
         from message_threads t
         join matters m on m.id = t.matter_id
        where t.tenant_id = ? and t.client_id in (${ph})
        order by (t.last_message_at is null) asc, t.last_message_at desc`,
      [tenantId, ...clientIds],
    );
  }

  async getThread(threadId: string, tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return undefined;
    const ph = clientIds.map(() => '?').join(',');
    return this.q().get<Row>(
      `select t.id, t.matter_id, t.client_id, t.subject, t.subject_ar, t.thread_status,
              t.last_message_at, m.title as matter_title, m.title_ar as matter_title_ar
         from message_threads t join matters m on m.id = t.matter_id
        where t.id = ? and t.tenant_id = ? and t.client_id in (${ph})`,
      [threadId, tenantId, ...clientIds],
    );
  }

  async listMessages(threadId: string, tenantId: string, clientIds: string[], readerUserId: string) {
    if (!clientIds.length) return [];
    const ph = clientIds.map(() => '?').join(',');
    // internal_flag = FALSE excludes firm-internal annotations on the thread.
    return this.q().all<Row>(
      `select msg.id, msg.sender_kind, msg.sender_display_name, msg.body, msg.created_at,
              case when mr.read_at is null then FALSE else TRUE end as read_by_me
         from messages msg
         join message_threads t on t.id = msg.thread_id
         left join message_reads mr
           on mr.message_id = msg.id and mr.reader_kind = 'client' and mr.reader_id = ?
        where msg.thread_id = ? and msg.tenant_id = ? and t.client_id in (${ph})
          and msg.internal_flag = FALSE
        order by msg.created_at asc`,
      [readerUserId, threadId, tenantId, ...clientIds],
    );
  }

  async insertMessage(row: Record<string, Param>) {
    await this.q().run(
      `insert into messages (id, thread_id, tenant_id, sender_kind, sender_user_id,
              sender_staff_id, sender_display_name, body, internal_flag, created_at)
       values (?, ?, ?, 'client', ?, null, ?, ?, FALSE, ?)`,
      [row.id, row.thread_id, row.tenant_id, row.sender_user_id, row.sender_display_name,
       row.body, row.created_at],
    );
    await this.q().run(
      `update message_threads set last_message_at = ?, thread_status = 'awaiting_firm'
        where id = ?`,
      [row.created_at, row.thread_id],
    );
  }

  async markThreadRead(threadId: string, tenantId: string, clientIds: string[], userId: string) {
    if (!clientIds.length) return;
    const ph = clientIds.map(() => '?').join(',');
    const rows = await this.q().all<{ id: string }>(
      `select msg.id from messages msg
         join message_threads t on t.id = msg.thread_id
        where msg.thread_id = ? and msg.tenant_id = ? and t.client_id in (${ph})
          and msg.sender_kind = 'staff' and msg.internal_flag = FALSE`,
      [threadId, tenantId, ...clientIds],
    );
    const now = new Date().toISOString();
    for (const r of rows) {
      await this.q().run(
        `insert into message_reads (message_id, reader_kind, reader_id, read_at)
         values (?, 'client', ?, ?)
         on conflict (message_id, reader_kind, reader_id) do nothing`,
        [r.id, userId, now],
      );
    }
  }

  // =========================================================================
  // APPOINTMENTS
  // =========================================================================
  async listAppointmentTypes(tenantId: string) {
    return this.q().all<Row>(
      `select id, code, label, label_ar, duration_min from appointment_types
        where tenant_id = ? and is_active = TRUE order by duration_min`,
      [tenantId],
    );
  }

  async listAppointments(tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return [];
    const ph = clientIds.map(() => '?').join(',');
    return this.q().all<Row>(
      `select a.id, a.matter_id, a.type_label, a.type_label_ar, a.preferred_date,
              a.preferred_time, a.preferred_mode, a.client_note, a.confirmed_at, a.status,
              a.cancellation_reason, a.cancelled_by, a.created_at,
              m.title as matter_title, m.title_ar as matter_title_ar
         from appointments a
         left join matters m on m.id = a.matter_id
        where a.tenant_id = ? and a.client_id in (${ph})
        order by a.created_at desc`,
      [tenantId, ...clientIds],
    );
  }

  async createAppointment(row: Record<string, Param>) {
    await this.q().run(
      `insert into appointments (id, tenant_id, client_id, matter_id, requested_by_user_id,
              type_id, type_label, type_label_ar, preferred_date, preferred_time,
              preferred_mode, client_note, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`,
      [row.id, row.tenant_id, row.client_id, row.matter_id ?? null, row.requested_by_user_id,
       row.type_id ?? null, row.type_label, row.type_label_ar, row.preferred_date,
       row.preferred_time, row.preferred_mode, row.client_note ?? null,
       row.created_at, row.created_at],
    );
  }

  /**
   * A client may cancel a REQUESTED or PENDING appointment. A CONFIRMED one
   * requires a reschedule flow with server validation (§23) — this method
   * refuses it rather than silently succeeding.
   */
  async cancelAppointment(appointmentId: string, tenantId: string, clientIds: string[], reason: string) {
    if (!clientIds.length) return { changes: 0 };
    const ph = clientIds.map(() => '?').join(',');
    return this.q().run(
      `update appointments
          set status = 'cancelled', cancellation_reason = ?, cancelled_by = 'client', updated_at = ?
        where id = ? and tenant_id = ? and client_id in (${ph})
          and status in ('requested','pending_confirmation')`,
      [reason, new Date().toISOString(), appointmentId, tenantId, ...clientIds],
    );
  }

  // =========================================================================
  // NOTIFICATIONS & PREFERENCES
  // =========================================================================
  async listNotifications(userId: string, tenantId: string, limit = 50) {
    return this.q().all<Row>(
      `select id, category, severity, title, title_ar, body, body_ar, link, matter_id,
              read_at, created_at
         from notifications
        where user_id = ? and tenant_id = ?
        order by created_at desc limit ?`,
      [userId, tenantId, limit],
    );
  }

  async countUnreadNotifications(userId: string, tenantId: string) {
    const r = await this.q().get<{ n: number }>(
      `select count(*) as n from notifications
        where user_id = ? and tenant_id = ? and read_at is null`,
      [userId, tenantId],
    );
    return toNumber(r?.n);
  }

  async markNotificationRead(id: string, userId: string, tenantId: string) {
    return this.q().run(
      `update notifications set read_at = ?
        where id = ? and user_id = ? and tenant_id = ? and read_at is null`,
      [new Date().toISOString(), id, userId, tenantId],
    );
  }

  async markAllNotificationsRead(userId: string, tenantId: string) {
    return this.q().run(
      `update notifications set read_at = ? where user_id = ? and tenant_id = ? and read_at is null`,
      [new Date().toISOString(), userId, tenantId],
    );
  }

  async listNotificationPreferences(userId: string) {
    return this.q().all<Row>(
      `select category, in_app, email, locked, updated_at
         from notification_preferences where user_id = ? order by category`,
      [userId],
    );
  }

  async updateNotificationPreference(userId: string, category: string, inApp: boolean, email: boolean) {
    // 'security' is locked and cannot be disabled.
    return this.q().run(
      `update notification_preferences
          set in_app = ?, email = ?, updated_at = ?
        where user_id = ? and category = ? and locked = FALSE`,
      [inApp, email, new Date().toISOString(), userId, category],
    );
  }

  async createNotification(row: Record<string, Param>) {
    await this.q().run(
      `insert into notifications (id, tenant_id, user_id, client_id, category, severity,
              title, title_ar, body, body_ar, link, matter_id, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.tenant_id, row.user_id, row.client_id, row.category, row.severity ?? 'info',
       row.title, row.title_ar, row.body ?? null, row.body_ar ?? null, row.link ?? null,
       row.matter_id ?? null, row.created_at],
    );
  }

  // =========================================================================
  // PRIVACY
  // =========================================================================
  async listConsents(userId: string) {
    return this.q().all<Row>(
      `select purpose, consented, policy_version, recorded_at
         from consent_records where user_id = ? order by recorded_at desc`,
      [userId],
    );
  }

  async recordConsent(row: Record<string, Param>) {
    await this.q().run(
      `insert into consent_records (id, tenant_id, user_id, purpose, consented,
              policy_version, ip_hash, recorded_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.tenant_id, row.user_id, row.purpose, row.consented,
       row.policy_version, row.ip_hash ?? null, row.recorded_at],
    );
  }

  async createPrivacyRequest(row: Record<string, Param>) {
    await this.q().run(
      `insert into privacy_requests (id, tenant_id, user_id, client_id, request_type,
              details, status, retention_block, due_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, 'submitted', FALSE, ?, ?, ?)`,
      [row.id, row.tenant_id, row.user_id, row.client_id, row.request_type, row.details ?? null,
       row.due_at, row.created_at, row.created_at],
    );
  }

  async listPrivacyRequests(userId: string, tenantId: string) {
    return this.q().all<Row>(
      `select id, request_type, details, status, retention_block, resolution_note_client,
              reviewed_at, due_at, created_at
         from privacy_requests where user_id = ? and tenant_id = ? order by created_at desc`,
      [userId, tenantId],
    );
  }

  async withdrawPrivacyRequest(id: string, userId: string, tenantId: string) {
    return this.q().run(
      `update privacy_requests set status = 'withdrawn', updated_at = ?
        where id = ? and user_id = ? and tenant_id = ? and status = 'submitted'`,
      [new Date().toISOString(), id, userId, tenantId],
    );
  }

  // =========================================================================
  // AUDIT (insert-only)
  // =========================================================================
  async audit(row: AuditRow) {
    await this.q().run(
      `insert into audit_events (occurred_at, tenant_id, actor_kind, actor_user_id,
              actor_client_id, action, resource_type, resource_id, outcome, reason_code,
              ip_hash, ip_country, user_agent, request_id, metadata)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.occurred_at, row.tenant_id ?? null, row.actor_kind, row.actor_user_id ?? null,
       row.actor_client_id ?? null, row.action, row.resource_type ?? null,
       row.resource_id ?? null, row.outcome ?? 'success', row.reason_code ?? null,
       row.ip_hash ?? null, row.ip_country ?? null, row.user_agent ?? null,
       row.request_id ?? null, JSON.stringify(sanitizeAuditMetadata(row.metadata ?? {}))],
    );
  }

  // =========================================================================
  // DASHBOARD AGGREGATES
  // =========================================================================
  async dashboardCounts(tenantId: string, clientIds: string[]) {
    if (!clientIds.length) {
      return { matters: 0, upcomingHearings: 0, openDeadlines: 0, unpaidInvoices: 0, unreadMessages: 0, unreadNotifications: 0 };
    }
    const ph = clientIds.map(() => '?').join(',');
    const now = new Date().toISOString();

    const [m, h, d, i] = await Promise.all([
      this.q().get<{ n: number }>(
        `select count(*) as n from matters
          where tenant_id = ? and client_id in (${ph}) and client_status <> 'closed'`,
        [tenantId, ...clientIds],
      ),
      this.q().get<{ n: number }>(
        `select count(*) as n from hearings
          where tenant_id = ? and client_id in (${ph}) and client_visible = TRUE
            and client_status = 'upcoming' and scheduled_at > ?`,
        [tenantId, ...clientIds, now],
      ),
      this.q().get<{ n: number }>(
        `select count(*) as n from deadlines
          where tenant_id = ? and client_id in (${ph}) and kind = 'client_action'
            and client_visible = TRUE and client_status in ('open','in_progress')`,
        [tenantId, ...clientIds],
      ),
      this.q().get<{ n: number }>(
        `select count(*) as n from invoices
          where tenant_id = ? and client_id in (${ph})
            and internal_status not in ('draft','pending_internal_approval','cancelled','written_off','paid')`,
        [tenantId, ...clientIds],
      ),
    ]);

    return {
      matters: toNumber(m?.n),
      upcomingHearings: toNumber(h?.n),
      openDeadlines: toNumber(d?.n),
      unpaidInvoices: toNumber(i?.n),
      unreadMessages: 0,
      unreadNotifications: 0,
    };
  }

  async outstandingBalance(tenantId: string, clientIds: string[]) {
    if (!clientIds.length) return '0.00';
    const ph = clientIds.map(() => '?').join(',');
    const r = await this.q().get<{ total: unknown }>(
      `select coalesce(sum(total - amount_paid), 0) as total from invoices
        where tenant_id = ? and client_id in (${ph})
          and internal_status not in ('draft','pending_internal_approval','cancelled','written_off')`,
      [tenantId, ...clientIds],
    );
    return toMoney(r?.total);
  }
}

/**
 * §38 — audit metadata must never contain a secret or an unmasked identifier.
 *
 * TWO LISTS, because one kind of match does not fit both jobs:
 *
 *   SUBSTRING — for keys that are dangerous in any compound form. `password`
 *     must catch `new_password`, `passwordConfirm`, `user.password_hash`. A
 *     caller cannot escape these by renaming.
 *
 *   EXACT — for short words that are only dangerous on their own. `code` is the
 *     reason this list exists: matched as a substring it also swallowed
 *     `roleCode`, `reasonCode` and `statusCode`, which are precisely the detail
 *     a privilege-escalation review needs (§49). Recording
 *     `{"roleCode":"[redacted]"}` on a ROLE_GRANTED event is not safety, it is a
 *     hole in the trail with a safety label on it. So `code` is refused only when
 *     it IS the key, and the compound forms that really do carry one-time
 *     secrets are named explicitly in the substring list instead.
 */
const AUDIT_METADATA_DENYLIST_SUBSTRING = [
  'password', 'token', 'secret', 'authorization', 'cookie', 'cvv',
  'card_number', 'national_id', 'api_key', 'signature', 'service_key',
  'private_key', 'otp', 'recovery_code', 'access_code', 'verification_code',
  'mfa_code', 'auth_code', 'pin',
];
const AUDIT_METADATA_DENYLIST_EXACT = ['code', 'codes', 'challenge', 'credential', 'credentials'];

function isDeniedMetadataKey(key: string): boolean {
  const k = key.toLowerCase();
  return AUDIT_METADATA_DENYLIST_EXACT.includes(k)
    || AUDIT_METADATA_DENYLIST_SUBSTRING.some((bad) => k.includes(bad));
}

const MAX_META_DEPTH = 3;
const MAX_META_STRING = 200;
const MAX_META_ENTRIES = 40;

/**
 * Auditable metadata must survive the round trip.
 *
 * Flattening every array and object to a placeholder — which is what a naive
 * sanitizer does — destroys exactly the detail an incident responder needs:
 * `{"fields":["tenant_id","role"]}` becoming `{"fields":"[object]"}` records
 * that something was refused but not WHAT was attempted. So structure is
 * preserved, within hard bounds: bounded depth, bounded entries, bounded
 * strings, dates as ISO, and buffers never dumped into the log at all.
 *
 * The denylist is applied at every level, not just the top, so a secret cannot
 * be smuggled one layer down.
 */
function sanitizeMetaValue(v: unknown, depth: number): unknown {
  if (v === null || v === undefined) return null;

  switch (typeof v) {
    case 'string':
      return (v as string).slice(0, MAX_META_STRING);
    case 'number':
      return Number.isFinite(v as number) ? v : null;
    case 'boolean':
      return v;
    case 'bigint':
      return String(v);
    case 'object':
      break;
    default:
      // function, symbol — not data.
      return '[unserializable]';
  }

  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `[bytes:${(v as Uint8Array).length}]`;
  if (depth >= MAX_META_DEPTH) return '[truncated]';

  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_META_ENTRIES).map((el) => sanitizeMetaValue(el, depth + 1));
    if (v.length > MAX_META_ENTRIES) out.push(`[+${v.length - MAX_META_ENTRIES} more]`);
    return out;
  }

  const out: Record<string, unknown> = {};
  let i = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (i++ >= MAX_META_ENTRIES) { out['…'] = '[truncated]'; break; }
    const key = k.slice(0, 60);
    out[key] = isDeniedMetadataKey(key) ? '[redacted]' : sanitizeMetaValue(val, depth + 1);
  }
  return out;
}

export function sanitizeAuditMetadata(input: unknown): Record<string, unknown> {
  const wrapped = Array.isArray(input) ? { items: input } : input;
  if (!wrapped || typeof wrapped !== 'object') return {};

  const out: Record<string, unknown> = {};
  let i = 0;
  for (const [k, v] of Object.entries(wrapped as Record<string, Param>)) {
    if (i++ >= MAX_META_ENTRIES) { out['…'] = '[truncated]'; break; }
    const key = k.slice(0, 60);
    out[key] = isDeniedMetadataKey(key) ? '[redacted]' : sanitizeMetaValue(v, 0);
  }
  return out;
}

function cryptoRandomId(): string {
  // Small local helper to avoid a circular import from lib/crypto.
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Shared row→DTO coercion helpers, re-exported for the domain layer. */
export const coerce = { toBool, toIso, toMoney, toNumber, toStr };
