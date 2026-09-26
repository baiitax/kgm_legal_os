/**
 * Internal Firm OS — identity, RBAC and matter-scoping schema (SQLite mirror).
 *
 * Production source of truth: supabase/migrations/0006_firm_rbac.sql. This file
 * is the SQLite equivalent, kept column-for-column compatible for every column
 * the application reads. SQLite has no RLS and no roles, so the authorization
 * enforcement point for the demo is `server/src/domain/permissions.ts` — which
 * is the same resolver production uses, sitting behind the same RLS policies.
 *
 * Deliberate structural choices:
 *
 *  · `users` stays the single authentication identity for BOTH audiences. A
 *    person is a `users` row; what they are allowed to do is decided by
 *    `client_users` (portal) or `firm_memberships` (internal). There is no
 *    conversion path between the two, and no shared session table.
 *
 *  · `permissions` is a GLOBAL catalogue with no tenant_id. Permission codes are
 *    part of the product's contract with itself — a tenant may grant or withhold
 *    them, but cannot invent new ones at runtime, which keeps `assertCan()`
 *    call sites auditable.
 *
 *  · `roles` is tenant-scoped. System roles are seeded per tenant and marked
 *    `is_system` so they cannot be deleted; a firm may add its own.
 *
 *  · Matter scoping lives in `matter_controls` and `matter_permissions`, NOT in
 *    new columns on `matters`. The portal's `matters` table is untouched, which
 *    is what keeps its 185 tests meaningful as a regression gate.
 *
 *  · Financial ceilings (§10) are per-membership nullable columns. NULL means
 *    "no authority", never "unlimited" — the resolver treats an absent ceiling
 *    as a refusal, not as a pass.
 */
export const FIRM_RBAC_SCHEMA = `
-- ============================ PERMISSION CATALOGUE =========================
create table if not exists permissions (
  code text primary key,
  module text not null,
  description text,
  description_ar text,
  sensitivity text not null default 'normal',
  created_at text not null
);
create index if not exists permissions_module_idx on permissions(module);

-- ============================ ROLES ========================================
create table if not exists roles (
  id text primary key,
  tenant_id text references tenants(id),
  code text not null,
  name text not null,
  name_ar text not null,
  description text,
  description_ar text,
  is_system integer not null default 0,
  -- 0027: whether holding this role means practising law, so a valid licence is
  -- a precondition. Default 0 — a new role is inert until someone decides.
  requires_practising_licence integer not null default 0,
  is_active integer not null default 1,
  created_at text not null,
  updated_at text not null,
  unique (tenant_id, code)
);

create table if not exists role_permissions (
  role_id text not null references roles(id) on delete cascade,
  permission_code text not null references permissions(code) on delete cascade,
  granted_at text not null,
  primary key (role_id, permission_code)
);
create index if not exists role_permissions_perm_idx on role_permissions(permission_code);

-- ============================ FIRM MEMBERSHIP ==============================
create table if not exists firm_memberships (
  id text primary key,
  tenant_id text not null references tenants(id),
  user_id text not null references users(id),
  staff_id text not null references staff(id),
  job_title text,
  job_title_ar text,
  status text not null default 'invited',
  -- Financial authority (§10). NULL = no authority. Never read NULL as unlimited.
  financial_authority_sar real,
  writeoff_authority_sar real,
  discount_authority_pct real,
  joined_at text,
  left_at text,
  invited_by_membership_id text,
  created_at text not null,
  updated_at text not null,
  unique (tenant_id, user_id),
  check (status in ('invited','active','suspended','left','deactivated')),
  check (financial_authority_sar is null or financial_authority_sar >= 0),
  check (writeoff_authority_sar is null or writeoff_authority_sar >= 0),
  check (discount_authority_pct is null or (discount_authority_pct >= 0 and discount_authority_pct <= 100))
);
create index if not exists firm_memberships_user_idx on firm_memberships(user_id);
create index if not exists firm_memberships_staff_idx on firm_memberships(staff_id);
create index if not exists firm_memberships_status_idx on firm_memberships(tenant_id, status);

create table if not exists membership_roles (
  membership_id text not null references firm_memberships(id) on delete cascade,
  role_id text not null references roles(id) on delete cascade,
  granted_by_membership_id text,
  -- See migration 0006: attribution is mandatory unless the origin provably has
  -- no membership actor (the tenant's first grant, or an invitation).
  grant_origin text not null default 'admin',
  granted_at text not null,
  revoked_at text,
  primary key (membership_id, role_id),
  check (grant_origin in ('admin','bootstrap','invitation','system'))
);

-- ============================ DEPARTMENTS (§5) =============================
create table if not exists departments (
  id text primary key,
  tenant_id text not null references tenants(id),
  code text not null,
  name text not null,
  name_ar text not null,
  parent_id text references departments(id),
  is_active integer not null default 1,
  created_at text not null,
  updated_at text not null,
  unique (tenant_id, code)
);

create table if not exists department_members (
  department_id text not null references departments(id) on delete cascade,
  membership_id text not null references firm_memberships(id) on delete cascade,
  is_lead integer not null default 0,
  joined_at text not null,
  primary key (department_id, membership_id)
);

-- Practice-area scoping (the chosen model): departments stay the org tree, and
-- a member's legal reach is the set of practice areas they may see. An empty set
-- means "assigned matters only"; the sentinel '*' means unrestricted within the
-- tenant, which is what a Managing Partner holds.
create table if not exists membership_practice_areas (
  membership_id text not null references firm_memberships(id) on delete cascade,
  practice_area text not null,
  granted_at text not null,
  primary key (membership_id, practice_area)
);

-- ============================ MATTER SCOPING (§17, §27) ====================
create table if not exists matter_controls (
  matter_id text primary key references matters(id) on delete cascade,
  tenant_id text not null references tenants(id),
  department_id text references departments(id),
  owner_membership_id text references firm_memberships(id),
  lead_staff_id text references staff(id),
  supervising_partner_staff_id text references staff(id),
  is_restricted integer not null default 0,
  restriction_reason text,
  restriction_reason_ar text,
  restricted_at text,
  restricted_by_membership_id text,
  created_at text not null,
  updated_at text not null
);
create index if not exists matter_controls_tenant_idx on matter_controls(tenant_id, is_restricted);

create table if not exists matter_permissions (
  id text primary key,
  matter_id text not null references matters(id) on delete cascade,
  tenant_id text not null references tenants(id),
  membership_id text not null references firm_memberships(id) on delete cascade,
  access_level text not null,
  reason text,
  granted_by_membership_id text,
  granted_at text not null,
  revoked_at text,
  unique (matter_id, membership_id),
  check (access_level in ('full','edit','operational','view','financial','compliance','none'))
);
create index if not exists matter_permissions_member_idx on matter_permissions(membership_id, revoked_at);

-- ============================ FIRM AUTH ====================================
create table if not exists firm_sessions (
  id text primary key,
  membership_id text not null references firm_memberships(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  tenant_id text not null references tenants(id),
  token_hash text not null unique,
  created_at text not null,
  last_activity text not null,
  expires_at text not null,
  idle_expires_at text not null,
  ip_hash text,
  ip_country text,
  user_agent text,
  device_label text,
  browser text,
  os text,
  mfa_verified_at text,
  trusted_device_id text,
  -- Permissions are re-resolved every request; this is only a cache hint and is
  -- never consulted for an authorization decision.
  role_snapshot text,
  revoked_at text,
  revoke_reason text
);
create index if not exists firm_sessions_membership_idx on firm_sessions(membership_id, revoked_at);
create index if not exists firm_sessions_expiry_idx on firm_sessions(expires_at, idle_expires_at);

create table if not exists firm_invitations (
  id text primary key,
  tenant_id text not null references tenants(id),
  staff_id text references staff(id),
  email text not null collate nocase,
  full_name text not null,
  full_name_ar text,
  token_hash text not null unique,
  token_hint text not null,
  expires_at text not null,
  accepted_at text,
  revoked_at text,
  created_by_membership_id text,
  accept_ip_hash text,
  created_at text not null
);
create index if not exists firm_invitations_email_idx on firm_invitations(tenant_id, email);

create table if not exists firm_invitation_roles (
  invitation_id text not null references firm_invitations(id) on delete cascade,
  role_id text not null references roles(id) on delete cascade,
  primary key (invitation_id, role_id)
);

create table if not exists firm_devices (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  fingerprint_hash text not null,
  label text,
  trusted_until text,
  mfa_trusted integer not null default 0,
  last_seen_at text not null,
  revoked_at text,
  created_at text not null,
  unique (user_id, fingerprint_hash)
);

-- ============================ TENANT CONFIG (multi-firm) ===================
create table if not exists tenant_settings (
  tenant_id text primary key references tenants(id) on delete cascade,
  display_name text,
  display_name_ar text,
  brand_key text,
  support_email text,
  support_phone text,
  timezone text not null default 'Asia/Riyadh',
  currency text not null default 'SAR',
  vat_rate real not null default 0.15,
  fiscal_year_start_month integer not null default 1,
  notification_channels text not null default '["in_app","email"]',
  mfa_required integer not null default 0,
  password_min_length integer not null default 12,
  session_absolute_minutes integer not null default 720,
  session_idle_minutes integer not null default 60,
  updated_at text not null,
  check (vat_rate >= 0 and vat_rate <= 1),
  check (password_min_length >= 8 and password_min_length <= 128)
);

-- ============================ INTEGRITY TRIGGERS ===========================
-- System role templates are the product's definition of each role (section 7).
-- A firm may copy and tune one, but the copy stays marked is_system, and a
-- marked role can neither be deleted nor quietly unmarked -- because unmarking
-- is how an administrator would delete it on the next request. Migration 0006
-- carries the same pair of guards as roles_system_guard.
create trigger if not exists roles_system_no_delete
  before delete on roles
  for each row when (old.is_system = 1)
  begin select raise(ABORT, 'a system role template cannot be deleted'); end;

create trigger if not exists roles_system_no_unmark
  before update of is_system on roles
  for each row when (old.is_system = 1 and new.is_system <> 1)
  begin select raise(ABORT, 'a system role cannot be unmarked'); end;

-- A membership cannot be moved between firms: tenant_id is fixed at creation.
create trigger if not exists firm_membership_tenant_immutable
  before update of tenant_id on firm_memberships
  begin select raise(ABORT, 'firm_memberships.tenant_id is immutable'); end;

-- A matter's tenant cannot drift from the matter it controls.
create trigger if not exists matter_controls_tenant_matches
  before insert on matter_controls
  for each row when (
    (select tenant_id from matters where id = new.matter_id) is not new.tenant_id
  )
  begin select raise(ABORT, 'matter_controls.tenant_id must match the matter'); end;

-- Restricting a matter must record why and by whom (§27, §83).
create trigger if not exists matter_controls_restriction_needs_reason
  before update of is_restricted on matter_controls
  for each row when (new.is_restricted = 1 and old.is_restricted = 0)
  begin
    select case
      when new.restriction_reason is null or new.restricted_by_membership_id is null
      then raise(ABORT, 'restricting a matter requires a reason and an actor')
    end;
  end;

-- An explicit 'none' grant is a denial record, not a grant: it may not be
-- silently turned into access by clearing the row.
create trigger if not exists matter_permissions_level_not_empty
  before insert on matter_permissions
  for each row when (new.access_level is null or length(trim(new.access_level)) = 0)
  begin select raise(ABORT, 'matter_permissions.access_level is required'); end;

-- Role grants are attributed, unless the origin explains why there is no actor.
create trigger if not exists membership_roles_needs_actor
  before insert on membership_roles
  for each row when (new.grant_origin = 'admin' and new.granted_by_membership_id is null)
  begin select raise(ABORT, 'a role grant must record who granted it'); end;

create trigger if not exists membership_roles_needs_actor_update
  before update of grant_origin, granted_by_membership_id on membership_roles
  for each row when (new.grant_origin = 'admin' and new.granted_by_membership_id is null)
  begin select raise(ABORT, 'a role grant must record who granted it'); end;

-- Left/deactivated memberships may not hold a live session: revocation is
-- enforced by the resolver too, but the database should not be able to hold a
-- contradictory state.
create trigger if not exists firm_sessions_no_active_after_left
  before insert on firm_sessions
  for each row when (
    (select status from firm_memberships where id = new.membership_id) not in ('active')
  )
  begin select raise(ABORT, 'only an active membership may hold a session'); end;


-- ============================================================================
-- 0027 · THE ELIGIBILITY LAYER  (mirror of the Postgres migration)
-- ============================================================================
-- The Postgres side expresses the derived predicates as SQL functions
-- (member_entitled_to_practise, member_requires_licence, member_eligible_for_matter).
-- SQLite has no functions, so the READ side of those predicates is implemented in
-- firm-repo.ts as one query that both drivers run — which is the better place for
-- it anyway, because a predicate the application reads and a predicate the
-- database enforces must be the SAME expression, and a function on one dialect
-- only is how they drift.
--
-- What is mirrored here are the REFUSALS, because those must hold even if a write
-- path never goes through the repository.

create table if not exists professional_licences (
  id text primary key,
  tenant_id text not null references tenants(id) on delete restrict,
  staff_id text not null references staff(id) on delete restrict,
  licence_number text not null,
  issued_at text,
  expires_at text,
  status text not null default 'valid'
    check (status in ('valid','suspended','expired','revoked','pending')),
  status_effective_from text,
  status_reference text,
  verified_by_membership_id text references firm_memberships(id) on delete set null,
  verified_at text,
  evidence_document_id text,
  created_at text not null,
  updated_at text not null,
  unique (staff_id, licence_number),
  -- A licence may not be valid AND carry a suspension reference.
  check (status = 'valid' and status_reference is null or status <> 'valid')
);
create index if not exists professional_licences_staff_idx on professional_licences(staff_id, status);
create index if not exists professional_licences_tenant_idx on professional_licences(tenant_id);

create table if not exists prior_office (
  id text primary key,
  tenant_id text not null references tenants(id) on delete restrict,
  staff_id text not null references staff(id) on delete restrict,
  office_kind text not null check (office_kind in
    ('judiciary','public_prosecution','bog','committee',
     'government_body','court_administration','foreign_judiciary')),
  institution text not null,
  institution_ar text,
  role_title text,
  role_title_ar text,
  started_on text not null,
  -- NULL means STILL IN POST: no restriction window has begun and the bar is
  -- absolute. The window itself is derived in priorOfficeBar() (firm-repo.ts),
  -- not stored — see the note in the Postgres migration for why there is no
  -- restriction_ends_on column in either dialect.
  ended_on text,
  created_at text not null,
  updated_at text not null,
  check (ended_on is null or ended_on >= started_on)
);
create index if not exists prior_office_staff_idx on prior_office(staff_id);

-- The five-year window is NOT a trigger here. SQLite cannot assign to NEW, and
-- computing it in a trigger on one dialect while Postgres computes it in another
-- is two expressions for one rule. It lives in priorOfficeBar() instead.

create table if not exists tenant_relationships (
  tenant_id text not null references tenants(id) on delete cascade,
  related_tenant_id text not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('branch','affiliate','merged','successor')),
  declared_by_membership_id text references firm_memberships(id) on delete set null,
  note text,
  declared_at text not null,
  primary key (tenant_id, related_tenant_id),
  check (tenant_id <> related_tenant_id)
);

-- Append-only: a check that can be edited is not evidence.
create table if not exists eligibility_checks (
  id integer primary key autoincrement,
  tenant_id text not null references tenants(id) on delete restrict,
  subject_kind text not null check (subject_kind in
    ('membership','staff','matter','client','invoice','document','matter_assignment')),
  subject_id text not null,
  precondition text not null,
  outcome text not null check (outcome in ('pass','fail','waived','not_applicable')),
  evidence text not null default '{}',
  rule_cited text,
  evaluated_by_membership_id text references firm_memberships(id) on delete set null,
  evaluated_at text not null
);
create index if not exists eligibility_subject_idx
  on eligibility_checks(subject_kind, subject_id, precondition, evaluated_at desc);

create trigger if not exists eligibility_checks_immutable_upd
  before update on eligibility_checks
  begin select raise(ABORT, 'eligibility_checks is append-only: a check that can be edited is not evidence'); end;

create trigger if not exists eligibility_checks_immutable_del
  before delete on eligibility_checks
  begin select raise(ABORT, 'eligibility_checks is append-only: a check that can be edited is not evidence'); end;

-- ── Article 16 · the single-firm guard ──────────────────────────────────────
-- Refuses an ACTIVE membership for a licensed lawyer who already holds one at a
-- different, unrelated tenant. Only the transition into 'active' is checked: a
-- membership may be invited, suspended or left freely; it is conferring the right
-- to practise here that has to be lawful.
create trigger if not exists firm_memberships_single_firm_guard
  before insert on firm_memberships
  for each row when (
    new.status = 'active'
    and exists (
      select 1 from professional_licences l
       where l.staff_id = new.staff_id and l.status = 'valid'
         and (l.expires_at is null or l.expires_at > date('now'))
    )
    and exists (
      select 1 from firm_memberships m
       where m.user_id = new.user_id
         and m.id <> new.id
         and m.status = 'active'
         and m.tenant_id <> new.tenant_id
         and not exists (
           select 1 from tenant_relationships r
            where (r.tenant_id = new.tenant_id and r.related_tenant_id = m.tenant_id)
               or (r.tenant_id = m.tenant_id and r.related_tenant_id = new.tenant_id)
         )
    )
  )
  begin select raise(ABORT, 'Article 16: a licensed lawyer may not hold active memberships at two unrelated firms'); end;

create trigger if not exists firm_memberships_single_firm_guard_upd
  before update of status on firm_memberships
  for each row when (
    new.status = 'active'
    and exists (
      select 1 from professional_licences l
       where l.staff_id = new.staff_id and l.status = 'valid'
         and (l.expires_at is null or l.expires_at > date('now'))
    )
    and exists (
      select 1 from firm_memberships m
       where m.user_id = new.user_id
         and m.id <> new.id
         and m.status = 'active'
         and m.tenant_id <> new.tenant_id
         and not exists (
           select 1 from tenant_relationships r
            where (r.tenant_id = new.tenant_id and r.related_tenant_id = m.tenant_id)
               or (r.tenant_id = m.tenant_id and r.related_tenant_id = new.tenant_id)
         )
    )
  )
  begin select raise(ABORT, 'Article 16: a licensed lawyer may not hold active memberships at two unrelated firms'); end;

-- ── P0.1 · parties and conflicts (mirror of 0029) ───────────────────────────
-- SQLite has no roles, no functions and no policies, so only the REFUSALS are
-- mirrored: the gates and the immutability guards. The predicates — the Arabic
-- name matcher, the match decision, the Rule 8 windows — live once in
-- server/src/domain/arabic-names.ts and conflict-engine.ts and are used by both
-- drivers, which is the arrangement the eligibility layer settled on for the same
-- reason: two expressions of one legal rule will eventually disagree.

create table if not exists parties (
  id text primary key,
  tenant_id text not null references tenants(id) on delete restrict,
  kind text not null default 'company' check (kind in
    ('individual','company','government','nonprofit','other')),
  name text not null,
  name_ar text,
  -- DERIVED by the application; candidate generation only, never the decision.
  name_normalized text not null,
  commercial_registration text,
  vat_number text,
  national_id_masked text,
  national_id_hash text,
  status text not null default 'active' check (status in ('active','archived','merged')),
  merged_into_party_id text references parties(id) on delete set null,
  notes text,
  created_by_membership_id text references firm_memberships(id) on delete set null,
  created_at text not null,
  updated_at text not null,
  check (merged_into_party_id is null or merged_into_party_id <> id),
  check (status <> 'merged' or merged_into_party_id is not null)
);
create index if not exists parties_tenant_name_idx on parties(tenant_id, name_normalized);
create index if not exists parties_tenant_cr_idx on parties(tenant_id, commercial_registration);
create index if not exists parties_tenant_vat_idx on parties(tenant_id, vat_number);
create index if not exists parties_tenant_nid_idx on parties(tenant_id, national_id_hash);

create table if not exists party_aliases (
  id text primary key,
  tenant_id text not null references tenants(id) on delete restrict,
  party_id text not null references parties(id) on delete cascade,
  alias text not null,
  alias_normalized text not null,
  script text not null default 'ar' check (script in ('ar','en','other')),
  source text check (source is null or source in
    ('court_filing','najiz','commercial_registration','client_statement',
     'opposing_counsel','manual','other')),
  note text,
  created_at text not null,
  updated_at text not null,
  unique (tenant_id, party_id, alias_normalized)
);
create index if not exists party_aliases_norm_idx on party_aliases(tenant_id, alias_normalized);

create table if not exists party_affiliations (
  id text primary key,
  tenant_id text not null references tenants(id) on delete restrict,
  party_id text not null references parties(id) on delete cascade,
  staff_id text not null references staff(id) on delete cascade,
  relation text not null check (relation in
    ('former_employer','current_employer','board_member','shareholder','other_interest')),
  started_on text,
  ended_on text,
  note text,
  recorded_by_membership_id text references firm_memberships(id) on delete set null,
  created_at text not null,
  updated_at text not null,
  unique (tenant_id, staff_id, party_id, relation),
  check (ended_on is null or started_on is null or ended_on >= started_on)
);
create index if not exists party_affiliations_staff_idx on party_affiliations(tenant_id, staff_id);

-- No 'client' role: the client of a matter is matters.client_id, and a second way
-- to say it would be a second answer to the question the engine asks.
create table if not exists matter_parties (
  id text primary key,
  tenant_id text not null references tenants(id) on delete restrict,
  matter_id text not null references matters(id) on delete cascade,
  party_id text not null references parties(id) on delete restrict,
  role text not null check (role in
    ('counterparty','adverse_party','related_entity','guarantor','witness',
     'expert','interested_party','other')),
  note text,
  added_by_membership_id text references firm_memberships(id) on delete set null,
  created_at text not null,
  updated_at text not null,
  unique (tenant_id, matter_id, party_id, role)
);
create index if not exists matter_parties_matter_idx on matter_parties(tenant_id, matter_id);
create index if not exists matter_parties_party_idx on matter_parties(tenant_id, party_id);

create table if not exists conflict_checks (
  id text primary key,
  tenant_id text not null references tenants(id) on delete restrict,
  matter_id text not null references matters(id) on delete cascade,
  kind text not null default 'intake' check (kind in ('intake','adverse_check','periodic','recheck')),
  status text not null default 'running' check (status in
    ('running','clear','cleared_with_waiver','conflicts_not_accepted','abandoned')),
  parties_checked integer not null default 0,
  matters_searched integer not null default 0,
  hits_found integer not null default 0,
  started_by_membership_id text not null references firm_memberships(id) on delete restrict,
  started_at text not null,
  concluded_by_membership_id text references firm_memberships(id) on delete set null,
  concluded_at text,
  conclusion text,
  created_at text not null,
  updated_at text not null,
  check ((status = 'running') = (concluded_at is null)),
  check ((concluded_at is null) = (concluded_by_membership_id is null))
);
create index if not exists conflict_checks_matter_idx on conflict_checks(tenant_id, matter_id, started_at desc);

create table if not exists conflict_hits (
  id text primary key,
  tenant_id text not null references tenants(id) on delete restrict,
  check_id text not null references conflict_checks(id) on delete cascade,
  matter_id text not null references matters(id) on delete cascade,
  party_id text not null references parties(id) on delete restrict,
  matched_party_id text references parties(id) on delete restrict,
  matched_matter_id text references matters(id) on delete set null,
  matched_client_id text references clients(id) on delete set null,
  relation text not null check (relation in
    ('former_client','current_client','former_employer','current_employer',
     'same_case_opponent','linked_party','related_entity')),
  match_strength text not null check (match_strength in ('exact','strong','candidate')),
  match_basis text not null check (match_basis in
    ('name','alias','commercial_registration','vat_number','national_id_hash')),
  affected_party_id text references parties(id) on delete restrict,
  severity text check (severity in ('actual','potential','none')),
  -- 0031. proposed_severity is what the ENGINE assessed; severity is what a PERSON
  -- decided. The CHECK on the next column is the reason they are two columns: a
  -- machine may not declare a conflict, so a hit starts open with no severity.
  proposed_severity text check (proposed_severity is null
    or proposed_severity in ('actual','potential','none')),
  rule_cited text not null,
  relationship_ended_on text,
  window_years integer,
  window_lifts_on text,
  within_window integer,
  disposition text not null default 'open' check (disposition in
    ('open','different_party','same_party')),
  disposition_reason text,
  disposition_by_membership_id text references firm_memberships(id) on delete set null,
  disposition_at text,
  created_at text not null,
  updated_at text not null,
  unique (check_id, party_id, matched_matter_id, affected_party_id, relation),
  check ((disposition = 'open') = (disposition_at is null)),
  check (disposition <> 'same_party' or (severity is not null and affected_party_id is not null)),
  check (severity is null or disposition = 'same_party')
);
create index if not exists conflict_hits_check_idx on conflict_hits(check_id);
create index if not exists conflict_hits_matter_idx on conflict_hits(tenant_id, matter_id);
create index if not exists conflict_hits_open_idx on conflict_hits(check_id) where disposition = 'open';

create table if not exists conflict_waivers (
  id text primary key,
  tenant_id text not null references tenants(id) on delete restrict,
  hit_id text not null references conflict_hits(id) on delete cascade,
  matter_id text not null references matters(id) on delete cascade,
  waived_by_party_id text not null references parties(id) on delete restrict,
  consent_document_id text references documents(id) on delete set null,
  consent_reference text,
  consent_signed_on text not null,
  scope text not null,
  recorded_by_membership_id text not null references firm_memberships(id) on delete restrict,
  created_at text not null,
  -- Rule 8 admits one remedy and it is a writing: either the document or a
  -- reference that identifies it in the firm's own records.
  check (consent_document_id is not null
         or (consent_reference is not null and trim(consent_reference) <> ''))
);
create index if not exists conflict_waivers_hit_idx on conflict_waivers(hit_id);

-- ── the record is immutable ─────────────────────────────────────────────────
create trigger if not exists conflict_hits_disposition_final
  before update on conflict_hits
  when old.disposition <> 'open' and new.disposition <> old.disposition
  begin select raise(ABORT, 'a conflict disposition is final: run a new check rather than revising the record'); end;

create trigger if not exists conflict_hits_findings_immutable
  before update on conflict_hits
  when old.disposition <> 'open' and (
    new.severity is not old.severity
    or new.affected_party_id is not old.affected_party_id
    or new.rule_cited is not old.rule_cited
    or new.within_window is not old.within_window
  )
  begin select raise(ABORT, 'the findings behind a conflict disposition are evidence and may not be rewritten'); end;

create trigger if not exists conflict_checks_conclusion_final
  before update on conflict_checks
  when old.concluded_at is not null and new.status <> old.status
  begin select raise(ABORT, 'a concluded conflict check is evidence: run a new check rather than reopening it'); end;

create trigger if not exists conflict_waivers_immutable_upd
  before update on conflict_waivers
  begin select raise(ABORT, 'a written consent is evidence: it is recorded once and never edited or withdrawn'); end;

create trigger if not exists conflict_waivers_immutable_del
  before delete on conflict_waivers
  begin select raise(ABORT, 'a written consent is evidence: it is recorded once and never edited or withdrawn'); end;

-- The consent must come from the party the finding says needs to give it.
create trigger if not exists conflict_waivers_party_guard
  before insert on conflict_waivers
  when (
    (select h.affected_party_id from conflict_hits h where h.id = new.hit_id) is null
    or new.waived_by_party_id <> (select h.affected_party_id from conflict_hits h where h.id = new.hit_id)
  )
  begin select raise(ABORT, 'the consent must come from the party affected by the conflict, as recorded on the finding'); end;

-- ── the coverage rule, once ──────────────────────────────────────────────────
-- 0032 · SQLite has no user-defined functions, so the rule lives in a VIEW here and
-- in a function on the other dialect. Either way there is ONE copy per dialect, and
-- the guard calls it: "does a concluded check cover this matter as it now stands" is
-- a legal rule, and four copies of a legal rule is three too many.
create view if not exists matter_conflict_coverage as
  select m.id as matter_id,
         exists (
           select 1 from conflict_checks c
            where c.matter_id = m.id
              and c.status in ('clear','cleared_with_waiver')
              -- a check that ran before the counterparty was known has not checked
              -- the counterparty
              and not exists (select 1 from matter_parties mp
                               where mp.matter_id = m.id and mp.created_at > c.started_at)
              -- an undispositioned finding is not an answer
              and not exists (select 1 from conflict_hits h
                               where h.check_id = c.id and h.disposition = 'open')
              -- a confirmed conflict needs the affected party's written consent
              and not exists (select 1 from conflict_hits h
                               where h.check_id = c.id and h.disposition = 'same_party'
                                 and h.severity in ('actual','potential')
                                 and not exists (select 1 from conflict_waivers w where w.hit_id = h.id))
         ) as covered
    from matters m;

-- ── the gate ─────────────────────────────────────────────────────────────────
create trigger if not exists matter_conflict_gate
  before update on matters
  when (
    -- (a) a CHANGE of the derived value may not contradict the ledger. Only a change:
    -- the row carrying an existing value forward is not making a claim, and treating
    -- it as one froze every matter that predated this subsystem.
    (new.conflict_cleared is not old.conflict_cleared
     and new.conflict_cleared is not null
     and new.conflict_cleared <> coalesce(
       (select covered from matter_conflict_coverage where matter_id = new.id), 0))
    or
    -- (b) Rule 11: work may not be accepted on an unexamined file
    (old.internal_status = 'conflict_check'
     and new.internal_status <> 'conflict_check'
     and new.internal_status <> 'archived'
     and not coalesce(
       (select covered from matter_conflict_coverage where matter_id = new.id), 0))
  )
  begin select raise(ABORT, 'conflict gate: a matter may not leave conflict_check without an excluding conflict check (Rule 11), and conflict_cleared may not be asserted against the record'); end;
`;

export const FISCAL_TRUST_BILLING_SCHEMA = `
/* ═══════════════════════════════════════════════════════════════════════════════
 * 0034 · FISCAL IDENTITY AND A LEGALLY VALID TAX INVOICE  (P0.2)
 * 0035 · CLIENT MONEY                                     (P1.1)
 * 0036 · WHAT A FEE RESTS ON                              (P1.2, P1.3, P1.4)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The SQLite side of the three migrations above. The production source of truth is
 * supabase/migrations/0034–0036; this is the demo driver's equivalent, and the rule
 * that keeps it honest is that THE REFUSAL MESSAGES ARE IDENTICAL. A test may assert
 * on 'invoice_not_issued' and mean the same thing on both engines, which is what
 * makes the SQLite suite a regression gate for behaviour rather than for syntax.
 *
 * TWO GUARDS ARE DELIBERATELY ABSENT HERE, AND THE REASON MATTERS.
 *
 *  · 'guard_invoice_discount_ceiling' reads 'current_setting('kgm.membership_id')',
 *    the session GUC the firm-side driver sets so that a trigger can know WHOSE
 *    authority a discount is measured against. SQLite has no session variables, and
 *    the alternative — threading the membership id through every statement — would
 *    change the statements themselves and defeat the point of a shared repository.
 *    The ceiling is therefore enforced on this driver at the SERVER layer only,
 *    which is where the three-step gate lives anyway; on PostgreSQL it is enforced
 *    at both. 'scripts/verify/sqlite-mirror.ts' reports the gap rather than hiding it.
 *
 *  · The ICV/hash chain has no trigger on either engine. It is allocated by
 *    'kgm_next_fiscal_number' on PostgreSQL and by the repository's own
 *    read-modify-write on SQLite; the invariant is asserted by test in both cases
 *    rather than by the database in one and not the other.
 */

-- ── the seller ───────────────────────────────────────────────────────────────
create table if not exists fiscal_identity (
  id                      text primary key,
  tenant_id               text not null references tenants(id),
  registered_name         text not null,
  registered_name_ar      text,
  vat_registration_number text not null,
  commercial_registration text not null,
  registered_address      text not null,
  registered_address_ar   text,
  city                    text,
  postal_code             text,
  country                 text not null default 'SA',
  environment             text not null default 'simulation',
  onboarding_status       text not null default 'not_started',
  certificate_expires_at  text,
  superseded_by           text,
  created_at              text not null default (datetime('now')),
  updated_at              text not null default (datetime('now')),
  unique (tenant_id, vat_registration_number)
);

create table if not exists fiscal_devices (
  id                    text primary key,
  tenant_id             text not null references tenants(id),
  fiscal_identity_id    text not null references fiscal_identity(id),
  device_label          text not null,
  device_serial         text not null,
  invoice_counter_value integer not null default 0,
  last_invoice_hash     text,
  is_active             integer not null default 1,
  created_at            text not null default (datetime('now')),
  updated_at            text not null default (datetime('now')),
  unique (tenant_id, device_serial)
);

create table if not exists invoice_submissions (
  id                text primary key,
  tenant_id         text not null references tenants(id),
  invoice_id        text not null references invoices(id),
  submission_type   text not null,
  attempt           integer not null default 1,
  status            text not null default 'pending',
  http_status       integer,
  response_code     text,
  request_body_hash text,
  response_body     text,
  warnings          text,
  errors            text,
  next_retry_at     text,
  submitted_at      text,
  resolved_at       text,
  created_at        text not null default (datetime('now'))
);

create table if not exists credit_notes (
  id                    text primary key,
  tenant_id             text not null references tenants(id),
  invoice_id            text not null references invoices(id),
  client_id             text not null references clients(id),
  credit_number         text not null,
  reason                text not null,
  amount                real not null,
  vat_amount            real not null,
  total                 real not null,
  currency              text not null default 'SAR',
  fiscal_device_id      text not null references fiscal_devices(id),
  invoice_uuid          text,
  icv                   integer,
  previous_invoice_hash text,
  invoice_hash          text,
  qr_payload            text,
  xml_storage_key       text,
  fiscal_status         text,
  issued_by_staff       text,
  issued_at             text,
  created_at            text not null default (datetime('now')),
  unique (tenant_id, credit_number)
);

-- ── the gates ────────────────────────────────────────────────────────────────
/*
  Is this firm able to issue a tax invoice at all? The same four conditions as
  'kgm_fiscal_ready' on PostgreSQL, written as a view so the trigger below can read
  it without a function.
*/
create view if not exists fiscal_ready as
  select fi.tenant_id as tenant_id,
         max(case when fi.superseded_by is null
                   and fi.onboarding_status = 'production_csid'
                   and (fi.certificate_expires_at is null or fi.certificate_expires_at > datetime('now'))
                   and fd.is_active = 1
                  then 1 else 0 end) as ready
    from fiscal_identity fi
    join fiscal_devices fd on fd.fiscal_identity_id = fi.id
   group by fi.tenant_id;

/*
  THE CLIENT-FACING STATUS DOES NOT NEED A UUID TO BE REACHED — IT NEEDS A UUID TO BE
  PERMITTED. This is the arm that makes the rest of the gate mean anything, and it is
  first for the same reason it is first in 0034.
*/
create trigger if not exists invoice_fiscal_issue_guard
  before insert on invoices
  when new.internal_status in ('sent','partially_paid','paid','overdue')
   and new.invoice_uuid is null
  begin
    select raise(ABORT, 'invoice_not_issued: an invoice may not reach a client before it is issued as a tax invoice');
  end;

create trigger if not exists invoice_fiscal_issue_guard_u
  before update on invoices
  when new.internal_status in ('sent','partially_paid','paid','overdue')
   and new.invoice_uuid is null
  begin
    select raise(ABORT, 'invoice_not_issued: an invoice may not reach a client before it is issued as a tax invoice');
  end;

/* The identity, the type, the chain and the QR — when a UUID is present at all. */
create trigger if not exists invoice_fiscal_shape_guard
  before insert on invoices
  when new.invoice_uuid is not null
   and (new.invoice_type is null
        or new.icv is null
        or new.invoice_hash is null
        or new.qr_payload is null
        or new.fiscal_device_id is null
        or coalesce((select ready from fiscal_ready where tenant_id = new.tenant_id), 0) = 0)
  begin
    select raise(ABORT, 'fiscal_identity_incomplete: a tax invoice needs an onboarded fiscal identity, a device, an ICV, a hash and a QR code');
  end;

create trigger if not exists invoice_fiscal_shape_guard_u
  before update on invoices
  when new.invoice_uuid is not null
   and (new.invoice_type is null
        or new.icv is null
        or new.invoice_hash is null
        or new.qr_payload is null
        or new.fiscal_device_id is null)
  begin
    select raise(ABORT, 'fiscal_identity_incomplete: a tax invoice needs a device, an ICV, a hash and a QR code');
  end;

/*
  An issued invoice is immutable. The same field list as 0034, for the same reason:
  the penalty for amending one starts at SAR 10,000 per document.
*/
create trigger if not exists invoice_fiscal_immutable_guard
  before update on invoices
  when old.invoice_uuid is not null
   and (new.invoice_uuid is not old.invoice_uuid
     or new.invoice_type is not old.invoice_type
     or new.icv is not old.icv
     or new.fiscal_device_id is not old.fiscal_device_id
     or new.invoice_hash is not old.invoice_hash
     or new.previous_invoice_hash is not old.previous_invoice_hash
     or new.qr_payload is not old.qr_payload
     or new.buyer_vat_number is not old.buyer_vat_number
     or new.buyer_name is not old.buyer_name
     or new.supply_at is not old.supply_at
     or new.issue_date is not old.issue_date
     or new.subtotal is not old.subtotal
     or new.vat_amount is not old.vat_amount
     or new.total is not old.total
     or new.client_id is not old.client_id
     or new.invoice_number is not old.invoice_number)
  begin
    select raise(ABORT, 'issued_invoice_immutable: an issued tax invoice may not be amended — issue a credit note instead');
  end;

create trigger if not exists invoice_no_delete_guard
  before delete on invoices
  when old.invoice_uuid is not null
  begin
    select raise(ABORT, 'issued_invoice_not_deletable: an issued tax invoice is retained for six years and corrected by credit note, never deleted');
  end;

create trigger if not exists invoice_lines_no_delete_guard
  before delete on invoice_lines
  when (select invoice_uuid from invoices where id = old.invoice_id) is not null
  begin
    select raise(ABORT, 'issued_invoice_not_deletable: the lines of an issued tax invoice may not be removed');
  end;

/*
  And the lines may not be REWRITTEN either: the totals of an issued invoice are frozen
  above, so a line whose unit price changed afterwards would leave the document
  disagreeing with the lines it was computed from. Adding a line falsifies it the same
  way, which is why the insert trigger exists as well as the update one.
*/
create trigger if not exists invoice_lines_no_update_guard
  before update on invoice_lines
  when (select invoice_uuid from invoices where id = old.invoice_id) is not null
  begin
    select raise(ABORT, 'issued_invoice_immutable: the lines of an issued tax invoice may not be added to or amended — issue a credit note instead');
  end;

create trigger if not exists invoice_lines_no_insert_guard
  before insert on invoice_lines
  when (select invoice_uuid from invoices where id = new.invoice_id) is not null
  begin
    select raise(ABORT, 'issued_invoice_immutable: the lines of an issued tax invoice may not be added to or amended — issue a credit note instead');
  end;

/* The invoice's own arithmetic must agree with its lines, at issue. */
create trigger if not exists invoice_lines_reconcile_guard
  before update on invoices
  when new.invoice_uuid is not null
   and new.invoice_uuid is not old.invoice_uuid
   and (
     abs(new.subtotal - coalesce((select sum(round(quantity * unit_price - discount_amount, 2))
                                    from invoice_lines where invoice_id = new.id), 0)) > 0.01
     or abs(new.vat_amount - coalesce((select sum(vat_amount)
                                         from invoice_lines where invoice_id = new.id), 0)) > 0.01
   )
  begin
    select raise(ABORT, 'invoice_lines_do_not_reconcile: the invoice totals must equal the sum of its lines');
  end;

/* A credit note against a STANDARD invoice may not be shared before ZATCA clears it.
   The rule is the same one 0039 repairs in Postgres: a correction the authority has not
   seen cannot be relied on by the buyer, so the credit note may not be reported until
   the invoice it corrects has been cleared. */
create trigger if not exists credit_note_needs_clearance_guard
  before insert on credit_notes
  for each row when new.invoice_uuid is not null
    and (select invoice_type from invoices where id = new.invoice_id) = 'standard'
    and not exists (select 1 from invoice_submissions
                     where invoice_id = new.invoice_id
                       and submission_type = 'clearance' and status = 'cleared')
  begin
    select raise(ABORT, 'credit_note_not_cleared: a credit note against a standard tax invoice may not be shared before ZATCA clears it');
  end;

/* A credit note may not exceed what it corrects. */
create trigger if not exists credit_note_within_invoice_guard
  before insert on credit_notes
  when new.total > coalesce((select total from invoices where id = new.invoice_id), 0)
                   - coalesce((select sum(total) from credit_notes where invoice_id = new.invoice_id), 0) + 0.01
  begin
    select raise(ABORT, 'credit_note_exceeds_invoice: the credits against an invoice may not exceed it');
  end;

/*
  A CREDIT NOTE AGAINST A STANDARD INVOICE IS NOT SHARED UNTIL ZATCA HAS CLEARED IT.

  The buyer cannot recover the VAT on a correction the authority never saw, so the rule
  belongs to the document rather than to the route. Postgres has enforced it since 0034
  and — until 0039 corrected the lookup — enforced it WRONGLY: the guard compared the
  submission to the credit note's own id, so no clearance could ever satisfy it. SQLite
  did not implement the rule at all, which is how a suite of 42 tests stayed green while
  a firm could not correct a single B2B invoice. Both halves are fixed; this is the
  mirror, and it fires only once the credit note carries a fiscal identity.
*/
create trigger if not exists credit_note_needs_clearance_guard
  before insert on credit_notes
  for each row when new.invoice_uuid is not null
    and (select invoice_type from invoices where id = new.invoice_id) = 'standard'
    and not exists (
      select 1 from invoice_submissions
       where invoice_id = new.invoice_id
         and submission_type = 'clearance' and status = 'cleared')
  begin
    select raise(ABORT, 'credit_note_not_cleared: a credit note against a standard tax invoice may not be shared before ZATCA clears it');
  end;

create trigger if not exists credit_note_against_unissued_guard
  before insert on credit_notes
  when (select invoice_uuid from invoices where id = new.invoice_id) is null
  begin
    select raise(ABORT, 'credit_note_against_unissued_invoice: there is nothing to credit — the invoice was never issued');
  end;

-- ── client money (0035) ──────────────────────────────────────────────────────
create table if not exists client_ledgers (
  id            text primary key,
  tenant_id     text not null references tenants(id),
  client_id     text not null references clients(id),
  currency      text not null default 'SAR',
  status        text not null default 'open',
  frozen_reason text,
  opened_at     text not null default (datetime('now')),
  closed_at     text,
  created_at    text not null default (datetime('now')),
  updated_at    text not null default (datetime('now')),
  unique (tenant_id, client_id, currency)
);

create table if not exists ledger_entries (
  id                   text primary key,
  tenant_id            text not null references tenants(id),
  ledger_id            text not null references client_ledgers(id),
  client_id            text not null references clients(id),
  entry_type           text not null,
  direction            text not null,
  amount               real not null,
  currency             text not null default 'SAR',
  invoice_id           text references invoices(id),
  matter_id            text references matters(id),
  description          text not null,
  reference            text,
  evidence_document_id text references documents(id),
  reverses_entry_id    text references ledger_entries(id),
  reversal_reason      text,
  entry_at             text not null,
  recorded_by_user_id  text references users(id),
  recorded_at          text not null default (datetime('now'))
);

create index if not exists ledger_entries_ledger_idx on ledger_entries(ledger_id, entry_at);
create index if not exists ledger_entries_invoice_idx on ledger_entries(invoice_id);

create table if not exists ledger_reconciliations (
  id                         text primary key,
  tenant_id                  text not null references tenants(id),
  currency                   text not null default 'SAR',
  as_of                      text not null,
  ledger_total               real not null,
  bank_balance               real not null,
  difference                 real not null,
  bank_statement_reference   text,
  bank_statement_document_id text references documents(id),
  clients_with_balance       integer not null default 0,
  status                     text not null,
  notes                      text,
  performed_by_user_id       text references users(id),
  performed_at               text not null default (datetime('now')),
  created_at                 text not null default (datetime('now')),
  unique (tenant_id, as_of, currency)
);

/* Append-only. No escape hatch, on either engine. */
create trigger if not exists ledger_entry_append_only_guard
  before update on ledger_entries
  begin select raise(ABORT, 'ledger_is_append_only: a client-money entry may not be updated — post a reversal instead'); end;

create trigger if not exists ledger_entry_append_only_delete_guard
  before delete on ledger_entries
  begin select raise(ABORT, 'ledger_is_append_only: a client-money entry may not be deleted — post a reversal instead'); end;

create trigger if not exists ledger_entry_shape_guard
  before insert on ledger_entries
  when (select status from client_ledgers where id = new.ledger_id) <> 'open'
   and (select status from client_ledgers where id = new.ledger_id) is not null
  begin
    select raise(ABORT, 'ledger_not_open: no further movement may be recorded on a frozen or closed ledger');
  end;

create trigger if not exists ledger_direction_guard
  before insert on ledger_entries
  when (new.entry_type in ('receipt','interest') and new.direction <> 'credit')
    or (new.entry_type in ('application_to_fee','disbursement','refund','bank_charge') and new.direction <> 'debit')
  begin
    select raise(ABORT, 'ledger_direction_wrong: the entry type determines whether the entry is a credit or a debit');
  end;

create trigger if not exists ledger_evidence_guard
  before insert on ledger_entries
  when new.entry_type in ('disbursement','refund','bank_charge') and new.evidence_document_id is null
  begin
    select raise(ABORT, 'ledger_evidence_required: the movement must attach the document that proves it');
  end;

/*
  Client money may only be applied to an ISSUED invoice of THE SAME CLIENT, never
  beyond what is outstanding, and never twice over. The four conditions are the same
  four as 0034's 'guard_ledger_application'.
*/
create trigger if not exists ledger_application_guard
  before insert on ledger_entries
  when new.entry_type = 'application_to_fee'
   and (
     new.invoice_id is null
     or coalesce((select client_id from invoices where id = new.invoice_id), '') <> new.client_id
     or coalesce((select tenant_id from invoices where id = new.invoice_id), '') <> new.tenant_id
     or coalesce((select internal_status from invoices where id = new.invoice_id), '') in
        ('', 'draft', 'pending_internal_approval', 'cancelled', 'written_off')
     or coalesce((select fiscal_status from invoices where id = new.invoice_id), '') in ('', 'rejected', 'failed')
     or (new.amount + coalesce((select sum(amount) from ledger_entries
                                 where invoice_id = new.invoice_id and entry_type = 'application_to_fee'), 0))
        > coalesce((select total - amount_paid from invoices where id = new.invoice_id), 0) + 0.01
   )
  begin
    select raise(ABORT, 'trust_application_refused: client money may only be applied to an issued, fiscally valid invoice of the same client, and never beyond its outstanding balance');
  end;

/* THE ONE THAT MATTERS MOST: a client's balance may never go below zero. */
create trigger if not exists ledger_no_overdraft_guard
  before insert on ledger_entries
  when coalesce((select sum(case when direction = 'credit' then amount else -amount end)
                   from ledger_entries where ledger_id = new.ledger_id), 0)
       + case when new.direction = 'credit' then new.amount else -new.amount end
       < -0.01
  begin
    select raise(ABORT, 'client_funds_overdrawn: client money may never be spent on the firm''s behalf');
  end;

create trigger if not exists reconciliation_append_only_guard
  before update on ledger_reconciliations
  begin select raise(ABORT, 'reconciliation_is_append_only: perform a new reconciliation rather than amending this one'); end;

create trigger if not exists reconciliation_append_only_delete_guard
  before delete on ledger_reconciliations
  begin select raise(ABORT, 'reconciliation_is_append_only: perform a new reconciliation rather than amending this one'); end;

-- ── the billing basis (0036) ─────────────────────────────────────────────────
create table if not exists rate_cards (
  id                 text primary key,
  tenant_id          text not null references tenants(id),
  level              text,
  staff_id           text references staff(id),
  practice_area      text,
  hourly_rate_sar    real not null,
  effective_from     text not null,
  effective_to       text,
  created_by_user_id text references users(id),
  created_at         text not null default (datetime('now'))
);

create table if not exists matter_billing_terms (
  id                  text primary key,
  tenant_id           text not null references tenants(id),
  matter_id           text not null references matters(id),
  basis               text not null,
  fee_amount_sar      real,
  cap_amount_sar      real,
  retainer_amount_sar real,
  stages              text,
  agreed_discount_pct real not null default 0,
  vat_applicable      integer not null default 1,
  effective_from      text not null,
  effective_to        text,
  superseded_by       text,
  notes               text,
  created_by_user_id  text references users(id),
  created_at          text not null default (datetime('now'))
);

create table if not exists time_entries (
  id                  text primary key,
  tenant_id           text not null references tenants(id),
  matter_id           text not null references matters(id),
  staff_id            text not null references staff(id),
  entry_date          text not null,
  minutes             integer not null,
  narrative           text not null,
  narrative_ar        text,
  billable            integer not null default 1,
  hourly_rate_sar     real not null,
  amount_sar          real not null,
  invoice_id          text references invoices(id),
  status              text not null default 'draft',
  approved_by_user_id text references users(id),
  approved_at         text,
  written_off_reason  text,
  created_at          text not null default (datetime('now')),
  updated_at          text not null default (datetime('now'))
);

create table if not exists expenses (
  id                   text primary key,
  tenant_id            text not null references tenants(id),
  matter_id            text not null references matters(id),
  client_id            text not null references clients(id),
  submitted_by_staff   text not null references staff(id),
  incurred_on          text not null,
  category             text not null,
  description          text not null,
  description_ar       text,
  net_amount_sar       real not null,
  vat_amount_sar       real not null default 0,
  total_amount_sar     real not null,
  vat_category         text not null default 'standard',
  receipt_document_id  text references documents(id),
  reimbursable         integer not null default 1,
  invoice_id           text references invoices(id),
  status               text not null default 'submitted',
  approved_by_user_id  text references users(id),
  approved_at          text,
  rejection_reason     text,
  created_at           text not null default (datetime('now')),
  updated_at           text not null default (datetime('now'))
);

create table if not exists engagement_letters (
  id                   text primary key,
  tenant_id            text not null references tenants(id),
  matter_id            text not null references matters(id),
  client_id            text not null references clients(id),
  scope                text not null,
  scope_ar             text,
  fee_amount_sar       real,
  calculation_method   text not null,
  signed_by_client_at  text,
  signed_by_client_name text,
  document_id          text references documents(id),
  identity_verified_at text,
  capacity_verified    integer not null default 0,
  status               text not null default 'draft',
  superseded_by        text,
  created_by_user_id   text references users(id),
  created_at           text not null default (datetime('now'))
);

create unique index if not exists engagement_letters_active_idx
  on engagement_letters(matter_id) where status = 'signed';

/*
  Rule 12 as a trigger: billable time requires a signed engagement AND current terms.
  Both halves — an engagement with no stated basis for the fee is not the written
  agreement the rule asks for.
*/
create trigger if not exists time_entry_billable_guard
  before insert on time_entries
  when new.billable = 1
   and (
     not exists (select 1 from engagement_letters el
                  where el.matter_id = new.matter_id and el.status = 'signed' and el.superseded_by is null)
     or not exists (select 1 from matter_billing_terms mbt
                     where mbt.matter_id = new.matter_id
                       and mbt.superseded_by is null
                       and mbt.effective_from <= new.entry_date
                       and (mbt.effective_to is null or mbt.effective_to >= new.entry_date))
   )
  begin
    select raise(ABORT, 'engagement_gate: billable time requires a signed engagement letter and current billing terms on this matter (Rule 12)');
  end;

create trigger if not exists time_entry_cap_guard
  before insert on time_entries
  when new.billable = 1
   and coalesce((select basis from matter_billing_terms
                  where matter_id = new.matter_id and superseded_by is null
                    and effective_from <= new.entry_date
                    and (effective_to is null or effective_to >= new.entry_date)
                  order by effective_from desc limit 1), '') = 'capped'
   and new.amount_sar + coalesce((select sum(amount_sar) from time_entries
                                   where matter_id = new.matter_id and billable = 1
                                     and status in ('submitted','approved','billed')), 0)
       > coalesce((select cap_amount_sar from matter_billing_terms
                    where matter_id = new.matter_id and superseded_by is null
                      and effective_from <= new.entry_date
                      and (effective_to is null or effective_to >= new.entry_date)
                    order by effective_from desc limit 1), 0) + 0.01
  begin
    select raise(ABORT, 'billing_cap_exceeded: the entry takes the matter past its agreed fee cap');
  end;

create trigger if not exists expense_shape_guard
  before insert on expenses
  when (new.reimbursable = 1 and new.status in ('approved','billed') and new.receipt_document_id is null)
    or coalesce((select client_id from matters where id = new.matter_id), '') <> new.client_id
  begin
    select raise(ABORT, 'expense_refused: a disbursement must belong to the matter''s client, and a reimbursable one must attach its receipt');
  end;

/*
  BILLING IS CLOSED ONCE THE INVOICE IS ISSUED — the mirror of
  guard_billed_entry_immutable and the two figure guards in 0036. (No backticks:
  this file is a TypeScript template literal, and one would end the schema.)

  Two rules, because they fail for two different reasons. An entry that is on an issued
  invoice may not be un-billed or moved to another invoice: the invoice is a tax
  document that cannot be amended, so moving the entry would make its own totals wrong.
  And its figures may not be rewritten either — an invoice whose lines were computed
  from a duration that has since changed is a document with no defensible basis.
*/
create trigger if not exists time_entry_billed_immutable_guard
  before update on time_entries
  when old.status = 'billed' and new.status <> 'billed'
  begin
    select raise(ABORT, 'entry_already_billed: this entry is on an issued invoice — correct it with a credit note, not by un-billing it');
  end;

create trigger if not exists entry_invoice_move_guard
  before update on time_entries
  when old.invoice_id is not null and new.invoice_id is not old.invoice_id
  begin
    select raise(ABORT, 'entry_invoice_immutable: a billed entry may not be moved to another invoice');
  end;

create trigger if not exists time_entry_billed_figures_guard
  before update on time_entries
  when old.status = 'billed' and (
       new.minutes is not old.minutes
    or new.amount_sar is not old.amount_sar
    or new.hourly_rate_sar is not old.hourly_rate_sar
    or new.matter_id is not old.matter_id
    or new.entry_date is not old.entry_date
    or new.billable is not old.billable
  )
  begin
    select raise(ABORT, 'entry_already_billed: this hour is on an issued invoice — its duration, rate, date, matter and billability are frozen; correct the invoice with a credit note and record new time');
  end;

create trigger if not exists expense_billed_immutable_guard
  before update on expenses
  when old.status = 'billed' and new.status <> 'billed'
  begin
    select raise(ABORT, 'entry_already_billed: this disbursement is on an issued invoice — correct it with a credit note, not by un-billing it');
  end;

create trigger if not exists expense_invoice_move_guard
  before update on expenses
  when old.invoice_id is not null and new.invoice_id is not old.invoice_id
  begin
    select raise(ABORT, 'entry_invoice_immutable: a billed disbursement may not be moved to another invoice');
  end;

create trigger if not exists expense_billed_figures_guard
  before update on expenses
  when old.status = 'billed' and (
       new.net_amount_sar is not old.net_amount_sar
    or new.vat_amount_sar is not old.vat_amount_sar
    or new.total_amount_sar is not old.total_amount_sar
    or new.matter_id is not old.matter_id
    or new.category is not old.category
    or new.reimbursable is not old.reimbursable
  )
  begin
    select raise(ABORT, 'entry_already_billed: this disbursement is on an issued invoice — its amounts, category, matter and rechargeability are frozen; correct the invoice with a credit note');
  end;

`;

// ═══════════════════════════════════════════════════════════════════════════════
export const CLIENT_DUE_DILIGENCE_SCHEMA = `
-- ═══════════════════════════════════════════════════════════════════════════════
--  P0.3 · CLIENT DUE DILIGENCE AND THE AML GATES — the SQLite mirror of 0040.
--
--  Column for column with the migration, so 'scripts/verify/schema-parity.ts'
--  compares them and fails when they drift. What cannot be mirrored is stated
--  where it lives rather than left for somebody to discover:
--
--    · ROW-LEVEL SECURITY does not exist here. The authorization enforcement point
--      for the demo is server/src/domain/permissions.ts, the same resolver
--      production uses behind its policies.
--    · COLUMN GRANTS do not exist here either. The Postgres grants in 0040 are the
--      specification, and the parity checker measures the server's statements
--      against them.
--    · UNICODE SCRIPTS CANNOT BE TESTED. The Arabic-narrative rule is enforced in
--      'server/src/domain/aml.ts' — one implementation, both dialects — and by the
--      Postgres trigger with a script range. This dialect can only say that the
--      narrative contains something outside ASCII, and says so.
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists aml_risk_countries (
  id                        text primary key,
  tenant_id                 text not null references tenants(id),
  country_code              text not null,
  country_name              text not null,
  country_name_ar           text,
  list_source               text not null check (list_source in
                              ('fatf_call_for_action','fatf_grey','un_sanctions','eu_consolidated',
                               'sama_circular','internal')),
  risk_level                text not null check (risk_level in ('high','prohibited')),
  effective_from            text not null,
  effective_to              text,
  note                      text,
  created_by_membership_id  text,
  created_at                text not null,
  updated_at                text not null,
  check (effective_to is null or effective_to >= effective_from)
);

create unique index if not exists aml_risk_countries_key
  on aml_risk_countries(tenant_id, country_code, list_source, effective_from);

create table if not exists client_due_diligence (
  id                               text primary key,
  tenant_id                        text not null references tenants(id),
  client_id                        text not null references clients(id),
  party_id                         text,
  version                          integer not null default 1 check (version >= 1),
  cdd_level                        text not null default 'standard'
                                     check (cdd_level in ('simplified','standard','enhanced')),
  status                           text not null default 'not_started'
                                     check (status in ('not_started','in_progress','complete',
                                                       'unable_to_complete','expired')),
  legal_name                       text,
  legal_name_ar                    text,
  date_of_birth                    text,
  nationality                      text,
  residence_country                text,
  address                          text,
  id_type                          text check (id_type in
                                     ('national_id','iqama','passport','gcc_id','commercial_registration')),
  id_number_hash                   text,
  id_number_masked                 text,
  id_issued_at                     text,
  id_expires_at                    text,
  cr_number                        text,
  cr_issued_at                     text,
  incorporation_country            text,
  business_activity                text,
  ownership_structure              text,
  source_of_funds                  text,
  source_of_wealth                 text,
  purpose                          text,
  expected_annual_volume_sar       real,
  verification_method              text check (verification_method in
                                     ('original_seen','certified_copy','electronic','relying_on_third_party')),
  verification_source              text,
  verified_by_membership_id        text,
  verified_at                      text,
  pep_status                       text check (pep_status in ('not_pep','pep','pep_family','pep_associate')),
  pep_details                      text,
  risk_rating                      text check (risk_rating in ('low','medium','high')),
  -- JSON, serialised by the repository. Postgres uses jsonb for the same value.
  risk_reasons                     text not null default '[]',
  risk_assessed_at                 text,
  senior_approved_by_membership_id text,
  senior_approved_at               text,
  senior_approval_note             text,
  review_due_at                    text,
  last_reviewed_at                 text,
  completed_at                     text,
  completed_by_membership_id       text,
  unable_reason                    text,
  notes                            text,
  superseded_by                    text,
  superseded_at                    text,
  created_by_membership_id         text,
  created_at                       text not null,
  updated_at                       text not null,
  check (status <> 'unable_to_complete'
         or (unable_reason is not null and length(trim(unable_reason)) >= 10)),
  check (status <> 'complete'
         or (completed_at is not null and completed_by_membership_id is not null)),
  check (cdd_level <> 'enhanced' or status <> 'complete'
         or senior_approved_by_membership_id is not null),
  check ((risk_rating is null) = (risk_assessed_at is null)),
  check (id_expires_at is null or id_issued_at is null or id_expires_at > id_issued_at)
);

create unique index if not exists client_due_diligence_current_idx
  on client_due_diligence(tenant_id, client_id) where superseded_by is null;
create unique index if not exists client_due_diligence_version_idx
  on client_due_diligence(tenant_id, client_id, version);

create table if not exists beneficial_owners (
  id                        text primary key,
  tenant_id                 text not null references tenants(id),
  dd_id                     text not null references client_due_diligence(id) on delete cascade,
  client_id                 text not null references clients(id),
  party_id                  text,
  owner_kind                text not null check (owner_kind in ('natural_person','legal_person')),
  full_name                 text not null,
  full_name_ar              text,
  date_of_birth             text,
  nationality               text,
  residence_country         text,
  address                   text,
  id_type                   text check (id_type in ('national_id','iqama','passport','gcc_id')),
  id_number_hash            text,
  id_number_masked          text,
  cr_number                 text,
  ownership_pct             real,
  control_basis             text not null check (control_basis in
                              ('ownership','voting_rights','senior_management','other')),
  control_description       text,
  pep_status                text check (pep_status in ('not_pep','pep','pep_family','pep_associate')),
  is_designated             integer,
  source                    text,
  verification_method       text check (verification_method in
                              ('original_seen','certified_copy','electronic','relying_on_third_party')),
  verified_by_membership_id text,
  verified_at               text,
  notes                     text,
  created_at                text not null,
  updated_at                text not null,
  check (ownership_pct is null or (ownership_pct >= 0 and ownership_pct <= 100)),
  check (control_basis <> 'ownership' or (ownership_pct is not null and ownership_pct > 0)),
  check (control_basis = 'ownership'
         or (control_description is not null and length(trim(control_description)) >= 10)),
  check (owner_kind <> 'natural_person' or (date_of_birth is not null and nationality is not null)),
  check (owner_kind <> 'legal_person' or (cr_number is not null and length(trim(cr_number)) >= 4))
);

create table if not exists screening_runs (
  id                   text primary key,
  tenant_id            text not null references tenants(id),
  dd_id                text references client_due_diligence(id) on delete cascade,
  client_id            text not null references clients(id),
  subject_kind         text not null check (subject_kind in
                         ('client','party','beneficial_owner','staff')),
  subject_id           text not null,
  subject_name         text not null,
  list_sets            text not null default '[]',
  list_as_of           text,
  provider             text not null check (provider in
                         ('internal_register','manual_review','external_provider','regulator_feed')),
  provider_reference   text,
  status               text not null check (status in ('clear','potential_match','match','failed')),
  matches_found        integer not null default 0 check (matches_found >= 0),
  failure_reason       text,
  run_at               text not null,
  run_by_membership_id text,
  note                 text,
  created_at           text not null,
  check (status <> 'failed'
         or (failure_reason is not null and length(trim(failure_reason)) >= 5)),
  check (status <> 'clear' or matches_found = 0),
  check (status <> 'potential_match' or matches_found > 0),
  check (status <> 'match' or matches_found > 0)
);

create index if not exists screening_runs_subject_idx
  on screening_runs(tenant_id, subject_kind, subject_id, run_at desc);

create table if not exists screening_matches (
  id                           text primary key,
  tenant_id                    text not null references tenants(id),
  run_id                       text not null references screening_runs(id) on delete cascade,
  list_source                  text not null,
  matched_name                 text not null,
  matched_reference            text,
  match_kind                   text not null check (match_kind in
                                 ('exact_name','fuzzy_name','national_id','alias','date_of_birth','address')),
  score                        real,
  disposition                  text not null default 'open' check (disposition in
                                 ('open','false_positive','true_match','escalated')),
  disposition_reason           text,
  disposition_by_membership_id text,
  disposition_at               text,
  created_at                   text not null,
  check (score is null or (score >= 0 and score <= 100)),
  check (disposition = 'open' or (disposition_reason is not null
                                  and length(trim(disposition_reason)) >= 10
                                  and disposition_at is not null
                                  and disposition_by_membership_id is not null)),
  check (disposition <> 'open' or (disposition_reason is null and disposition_at is null))
);

create table if not exists str_reports (
  id                                         text primary key,
  tenant_id                                  text not null references tenants(id),
  report_number                              text not null,
  subject_kind                               text not null check (subject_kind in
                                               ('client','party','beneficial_owner','staff','transaction')),
  subject_id                                 text,
  subject_name                               text,
  client_id                                  text references clients(id),
  matter_id                                  text references matters(id),
  grounds                                    text not null default '[]',
  narrative_ar                               text not null,
  narrative_en                               text,
  amount_sar                                 real,
  currency                                   text not null default 'SAR',
  transaction_reference                      text,
  transaction_at                             text,
  status                                     text not null default 'draft' check (status in
                                               ('draft','pending_review','filed','acknowledged',
                                                'rejected_by_fiu','withdrawn')),
  prepared_by_membership_id                  text,
  prepared_at                                text,
  reviewed_by_membership_id                  text,
  reviewed_at                                text,
  filed_by_membership_id                     text,
  filed_at                                   text,
  filed_due_at                               text,
  fiu_reference                              text,
  fiu_response                               text,
  fiu_responded_at                           text,
  tipping_off_acknowledged_at                text,
  tipping_off_acknowledged_by_membership_id  text,
  closure_reason                             text,
  closed_at                                  text,
  created_by_membership_id                   text,
  created_at                                 text not null,
  updated_at                                 text not null,
  unique (tenant_id, report_number),
  check (amount_sar is null or amount_sar >= 0),
  check (status not in ('filed','acknowledged','rejected_by_fiu')
         or (filed_at is not null and filed_by_membership_id is not null
             and fiu_reference is not null
             and tipping_off_acknowledged_at is not null
             and tipping_off_acknowledged_by_membership_id is not null)),
  check (status <> 'acknowledged' or fiu_responded_at is not null),
  check (status <> 'withdrawn' or (closure_reason is not null and closed_at is not null))
);

/*
  ── THE DERIVED IDENTITY FLAG ────────────────────────────────────────────────
  'clients.identity_verified' is not a field anybody types. The claim it makes —
  that this client's identity has been verified — is refused unless a current
  due-diligence record supports it, in the same terms in both dialects. Asserting
  the NEGATIVE is always allowed: a false that should have been true is a gap, and
  is visible as one; a true that should have been false is a lie the portal repeats
  back to the client.
*/
create trigger if not exists clients_identity_derived_insert
  before insert on clients
  for each row when new.identity_verified = 1
    and not exists (select 1 from client_due_diligence d
                     where d.tenant_id = new.tenant_id and d.client_id = new.id
                       and d.superseded_by is null and d.status = 'complete')
  begin
    select raise(ABORT, 'identity_verification_not_derived: clients.identity_verified follows from a complete due-diligence record and may not be asserted');
  end;

create trigger if not exists clients_identity_derived_update
  before update on clients
  for each row when new.identity_verified = 1
    and not exists (select 1 from client_due_diligence d
                     where d.tenant_id = new.tenant_id and d.client_id = new.id
                       and d.superseded_by is null and d.status = 'complete')
  begin
    select raise(ABORT, 'identity_verification_not_derived: clients.identity_verified follows from a complete due-diligence record and may not be asserted');
  end;

/*
  ── THE GATE ON ACCEPTING THE WORK ───────────────────────────────────────────

  ONE TRIGGER, AND ITS CHECKS IN A DELIBERATE ORDER.

  The obvious mirror of the Postgres function is one trigger per condition. It is
  the wrong mirror: SQLite does not define the order in which several triggers on
  the same event fire, so which refusal a person reads would be the database's
  choice rather than the rule's. The conditions overlap by construction — a client
  with no ownership record and no screening fails both — so the messages would
  differ between two runs of the same test.

  Statements inside ONE trigger body do run in order, and that gives exactly the
  precedence the Postgres function states: the prohibition before the backlog, the
  backlog before the arithmetic, the screening last because it is the one that
  most often looks finished.

  The gate guards the TRANSITION into 'active' and nothing else. Matters that
  predate this phase are already sitting there for clients nobody identified, and a
  blanket check would refuse the firm permission to touch its own files — the same
  reasoning, and the same shape, as the conflict gate in 0029.
*/
create trigger if not exists matter_cdd_gate
  before update on matters
  for each row when new.internal_status = 'active' and old.internal_status <> 'active'
  begin
    /* (1) No record at all. */
    select raise(ABORT, 'cdd_missing: no client due diligence has been recorded for this client')
     where not exists (select 1 from client_due_diligence d
                        where d.tenant_id = new.tenant_id and d.client_id = new.client_id
                          and d.superseded_by is null);

    /* (2) The prohibition the manual is clearest about, and it comes FIRST. */
    select raise(ABORT, 'cdd_unable_to_complete: customer due diligence could not be completed for this client — the firm may not act (AML Law, M/20)')
     where exists (select 1 from client_due_diligence d
                    where d.tenant_id = new.tenant_id and d.client_id = new.client_id
                      and d.superseded_by is null and d.status = 'unable_to_complete');

    /* (3) A record that exists and has not been finished. */
    select raise(ABORT, 'cdd_incomplete: this client''s due diligence is not complete — a matter may not be opened on an unidentified client')
     where exists (select 1 from client_due_diligence d
                    where d.tenant_id = new.tenant_id and d.client_id = new.client_id
                      and d.superseded_by is null
                      and d.status not in ('complete','unable_to_complete'));

    /* (4) Enhanced due diligence with nobody named to accept the risk. */
    select raise(ABORT, 'senior_approval_required: enhanced due diligence requires a named senior approver')
     where exists (select 1 from client_due_diligence d
                    where d.tenant_id = new.tenant_id and d.client_id = new.client_id
                      and d.superseded_by is null and d.status = 'complete'
                      and d.cdd_level = 'enhanced' and d.senior_approved_by_membership_id is null);

    /*
      (5) A PEP WHOSE PROCESS WAS NOT RAISED TO MEET THE DETERMINATION.

      The manual does not prohibit acting for a politically exposed person; it requires
      enhanced due diligence and senior approval before the firm does. So the refusal is
      not "this client is a PEP" — it is that the determination was recorded and the
      level was left where it was, which leaves the record claiming a completeness it
      does not have.
    */
    select raise(ABORT, 'senior_approval_required: this client is a politically exposed person — due diligence must be enhanced and approved by senior management')
     where exists (select 1 from client_due_diligence d
                    where d.tenant_id = new.tenant_id and d.client_id = new.client_id
                      and d.superseded_by is null and d.status = 'complete'
                      and d.pep_status is not null and d.pep_status <> 'not_pep'
                      and d.cdd_level <> 'enhanced');

    /* (6) A review that has fallen due is a record nobody has looked at since. */
    select raise(ABORT, 'cdd_review_overdue: this client''s due diligence is due for review — look before you act')
     where exists (select 1 from client_due_diligence d
                    where d.tenant_id = new.tenant_id and d.client_id = new.client_id
                      and d.superseded_by is null and d.status = 'complete'
                      and d.review_due_at is not null and d.review_due_at < date('now'));

    /*
      (7) The persons behind a legal person.

      A COMPANY THAT OWNS ITSELF PASSES A NAIVE SUM AND FAILS THIS. The identified
      percentage counts only VERIFIED NATURAL PERSONS — a chain ending in a holding
      company contributes nothing, however large the number written beside it —
      and a control right counts only when somebody has verified it.
    */
    select raise(ABORT, 'cdd_beneficial_owner_missing: the persons who control this client have not been identified to the 25% threshold, and no control right is recorded')
     where (select client_type from clients where id = new.client_id) is not 'individual'
       and exists (select 1 from client_due_diligence d
                    where d.tenant_id = new.tenant_id and d.client_id = new.client_id
                      and d.superseded_by is null and d.status = 'complete')
       and not (
         coalesce((select sum(bo.ownership_pct) from beneficial_owners bo
                    join client_due_diligence d on d.id = bo.dd_id
                   where d.tenant_id = new.tenant_id and d.client_id = new.client_id
                     and d.superseded_by is null and bo.control_basis = 'ownership'
                     and bo.owner_kind = 'natural_person' and bo.verified_at is not null), 0) >= 25
         or exists (select 1 from beneficial_owners bo
                     join client_due_diligence d on d.id = bo.dd_id
                    where d.tenant_id = new.tenant_id and d.client_id = new.client_id
                      and d.superseded_by is null and bo.control_basis <> 'ownership'
                      and bo.verified_at is not null)
       );

    /*
      (8) Every person in the relationship, screened, resolved and not designated.

      A RUN THAT FAILED IS NOT A CLEARANCE, and an open hit is not a clearance
      either — both leave the subject unscreened. A confirmed designation is the end
      of the matter rather than a risk to weigh.
    */
    select raise(ABORT, 'screening_incomplete: a person in this relationship has an unresolved or failed screening')
     where exists (
       with subjects as (
         select 'client' as kind, new.client_id as id
         union all
         select 'beneficial_owner', bo.id from beneficial_owners bo
           join client_due_diligence d on d.id = bo.dd_id
          where d.tenant_id = new.tenant_id and d.client_id = new.client_id
            and d.superseded_by is null and bo.verified_at is not null
            and (coalesce(bo.ownership_pct, 0) >= 25 or bo.control_basis <> 'ownership')
       )
       select 1 from subjects s
        where not exists (select 1 from screening_runs r
                           where r.tenant_id = new.tenant_id
                             and r.subject_kind = s.kind and r.subject_id = s.id
                             and r.status <> 'failed'
                             and not exists (select 1 from screening_matches m
                                              where m.run_id = r.id and m.disposition = 'open'))
     );

    select raise(ABORT, 'sanctions_match: a confirmed designation is recorded for a person in this relationship — the relationship may not be established')
     where exists (
       select 1 from screening_matches m join screening_runs r on r.id = m.run_id
        where r.tenant_id = new.tenant_id and m.disposition = 'true_match'
          and (r.subject_kind = 'client' and r.subject_id = new.client_id
               or r.subject_kind = 'beneficial_owner'
                  and r.subject_id in (select bo.id from beneficial_owners bo
                                         join client_due_diligence d on d.id = bo.dd_id
                                        where d.tenant_id = new.tenant_id
                                          and d.client_id = new.client_id
                                          and d.superseded_by is null))
     );
  end;

/*
  ── THE REPORT ───────────────────────────────────────────────────────────────
  The due date is computed by the repository — one implementation of the working-day
  arithmetic in server/src/domain/aml.ts, used by both dialects — and the database
  refuses a report that arrives without one, so a draft can never be filed against a
  clock nobody started.
*/
create trigger if not exists str_reports_due_date_required
  before insert on str_reports
  for each row when new.filed_due_at is null
  begin
    select raise(ABORT, 'str_due_date_missing: a report carries the working-day deadline computed when it was prepared');
  end;

create trigger if not exists str_reports_narrative_guard
  before insert on str_reports
  for each row when length(trim(new.narrative_ar)) < 40
  begin
    select raise(ABORT, 'str_narrative_too_short: a report is a narrative, not a label');
  end;

/*
  AND THE NARRATIVE IS NOT ASCII. SQLite cannot test a Unicode script class, so this is
  the weak form of the rule: at least one character outside ASCII, which the shared
  domain check ('containsArabic') and the Postgres trigger both make precise. Stated
  rather than implied, because a rule that quietly differs between engines is how this
  project has been wrong before.
*/
create trigger if not exists str_reports_narrative_script_guard
  before insert on str_reports
  for each row when length(hex(new.narrative_ar)) / 2 = length(new.narrative_ar)
  begin
    select raise(ABORT, 'str_narrative_not_arabic: the narrative of a report to SAFIU must be written in Arabic');
  end;

create trigger if not exists str_reports_filing_guard
  before insert on str_reports
  for each row when new.status in ('filed','acknowledged','rejected_by_fiu')
    and (new.reviewed_by_membership_id is null or new.reviewed_at is null)
  begin
    select raise(ABORT, 'str_not_approved: a report is filed on the compliance officer''s decision, recorded by name');
  end;

create trigger if not exists str_reports_filed_immutable
  before update on str_reports
  for each row when old.status in ('filed','acknowledged','rejected_by_fiu')
    and (new.narrative_ar is not old.narrative_ar
      or new.grounds is not old.grounds
      or new.subject_id is not old.subject_id
      or new.subject_kind is not old.subject_kind
      or new.client_id is not old.client_id
      or new.amount_sar is not old.amount_sar
      or new.transaction_reference is not old.transaction_reference
      or new.report_number is not old.report_number
      or new.filed_at is not old.filed_at
      or new.filed_due_at is not old.filed_due_at)
  begin
    select raise(ABORT, 'str_filed_immutable: a filed report is the record of what was reported — correct it with a new report');
  end;

create trigger if not exists str_reports_filing_approved
  before update on str_reports
  for each row when new.status in ('filed','acknowledged','rejected_by_fiu')
    and new.status is not old.status
    and (new.reviewed_by_membership_id is null or new.reviewed_at is null)
  begin
    select raise(ABORT, 'str_not_approved: a report is filed on the compliance officer''s decision, recorded by name');
  end;

/*
  ── A DISPOSITION IS FINAL ───────────────────────────────────────────────────
  The decision about a match is what an inspection reads, so it is as fixed as the
  finding it answers. A match may not be re-decided; a new screening is run instead.
*/
create trigger if not exists screening_matches_disposition_final
  before update on screening_matches
  for each row when old.disposition <> 'open' and new.disposition is not old.disposition
  begin
    select raise(ABORT, 'already_dispositioned: this match has been decided — run a new screening rather than re-deciding it');
  end;

create trigger if not exists screening_matches_reason_final
  before update on screening_matches
  for each row when old.disposition <> 'open'
    and (new.disposition_reason is not old.disposition_reason
      or new.disposition_by_membership_id is not old.disposition_by_membership_id)
  begin
    select raise(ABORT, 'already_dispositioned: the reason for a decision is as fixed as the decision');
  end;

/*
  ═══════════════════════════════════════════════════════════════════════════════
  RETENTION · THE RECORDS OF WHAT THE FIRM KNEW ARE KEPT FOR TEN YEARS
  ═══════════════════════════════════════════════════════════════════════════════

  Royal Decree M/20 requires a DNFBP to keep its customer due-diligence records, its
  screening results and its reports for ten years. Until 0043 this system's answer to that
  was an ABSENT PRIVILEGE — firm_api simply holds no DELETE on these tables — which is
  half an answer. The other half is this guard, and both halves are needed: a privilege can
  be granted by a later migration nobody thinks about, and a trigger can be dropped by a
  superuser before an offboarding script runs in a hurry. Neither alone is the rule.

  WHY NOTHING HERE MAY BE DELETED, STATED AS THE PRODUCT'S REASON. These rows are not
  current state that a workflow corrects; they are statements about what the firm knew on a
  date. A record corrected by deletion is a record nobody can rely on, and the obligations
  attached to them — the review clock, the screening subject set, the ten-year retention —
  are all read from the history rather than from the latest version.

  A PURGE AFTER TEN YEARS IS AN OPERATOR ACTION, not an application feature: it means
  disabling these guards deliberately, with the reason written down, and this refusal
  message is what makes that a decision rather than an accident.
*/
create trigger if not exists client_due_diligence_retention
  before delete on client_due_diligence
  begin
    select raise(ABORT, 'aml_record_retention: a due-diligence record is kept for ten years (AML Law M/20) — correct it with a new version, never by deletion');
  end;

create trigger if not exists beneficial_owners_retention
  before delete on beneficial_owners
  begin
    select raise(ABORT, 'aml_record_retention: a beneficial owner is part of the identification record and is kept for ten years (AML Law M/20)');
  end;

create trigger if not exists screening_runs_retention
  before delete on screening_runs
  begin
    select raise(ABORT, 'aml_record_retention: a screening is evidence of what was checked, and is kept for ten years (AML Law M/20)');
  end;

create trigger if not exists screening_matches_retention
  before delete on screening_matches
  begin
    select raise(ABORT, 'aml_record_retention: a name hit and its disposition are kept for ten years (AML Law M/20)');
  end;

create trigger if not exists str_reports_retention
  before delete on str_reports
  begin
    select raise(ABORT, 'aml_record_retention: a report to SAFIU is kept for ten years (AML Law M/20)');
  end;

create trigger if not exists aml_risk_countries_retention
  before delete on aml_risk_countries
  begin
    select raise(ABORT, 'aml_record_retention: a jurisdiction risk listing is dated, not deleted — a risk assessment reads the list that was in force on the date it was made');
  end;

`;

/**
 * P0.4 · JUDGMENTS, SERVICE, AND THE PERIOD FOR CHALLENGING ONE.
 *
 * Production source of truth: supabase/migrations/0045_judgments_and_service.sql. A fifth
 * literal, for the reason the fourth exists: keeping one migration per literal makes it
 * obvious which phase a table came from when one of them fails to apply. It must run AFTER
 * CLIENT_DUE_DILIGENCE_SCHEMA — `judgments` references `matters` and `documents`, and the
 * enforcement gate reads `client_due_diligence` for nothing but is written beside it.
 *
 * ONE RULE, ONE COPY — EVEN ACROSS DIALECTS. The appeal arithmetic (day after delivery,
 * thirty days, extend the last day, close at 23:59:59+03:00) is NOT here. It lives in
 * `server/src/domain/judgments.ts` and its answer is written onto the row, in both engines,
 * by the same function. This file stores the answer and enforces the consequences. The
 * 25%-ownership defect in P0.3 was a rule with three implementations and one of them wrong;
 * this is the phase that stopped doing that.
 */
export const JUDGMENTS_SERVICE_SCHEMA = `
/* ── THE DAYS THE COURTS DO NOT SIT ───────────────────────────────────────────── */
create table if not exists court_calendar (
  id                        text primary key,
  tenant_id                 text not null references tenants(id),
  calendar_date             text not null,
  hijri_date                text,
  kind                      text not null default 'public_holiday'
                            check (kind in ('weekend','public_holiday','court_recess','emergency_closure')),
  name                      text not null,
  name_ar                   text not null,
  note                      text,
  created_by_membership_id  text references firm_memberships(id),
  created_at                text not null,
  updated_at                text not null,
  unique (tenant_id, calendar_date)
);
create index if not exists court_calendar_tenant_idx on court_calendar(tenant_id, calendar_date);

/* ── THE REGISTER ─────────────────────────────────────────────────────────────── */
create table if not exists judgments (
  id                        text primary key,
  tenant_id                 text not null references tenants(id),
  client_id                 text not null references clients(id),
  matter_id                 text not null references matters(id) on delete restrict,
  deed_number               text not null,
  case_number               text,
  court                     text not null,
  court_ar                  text not null,
  circuit                   text,
  circuit_ar                text,
  judge_name                text,
  judgment_kind             text not null
                            check (judgment_kind in ('first_instance','appeal','cassation')),
  presence                  text not null default 'in_presence'
                            check (presence in ('in_presence','in_absentia','in_absentia_default')),
  urgent                    integer not null default 0,
  pronounced_at             text not null,
  relief_kind               text not null default 'none'
                            check (relief_kind in ('monetary','non_monetary','none')),
  amount_sar                real,
  currency                  text not null default 'SAR',
  verdict_for               text check (verdict_for in ('client','opponent','split','procedural')),
  summary                   text,
  summary_ar                text,
  document_id               text references documents(id),
  appealable                integer not null default 1,
  served_at                 text,
  service_effective_at      text,
  appeal_deadline_at        text,
  appeal_rule_cited         text,
  appeal_rule_days          integer,
  final_at                  text,
  stay_in_force             integer not null default 0,
  stay_reason               text,
  stay_ordered_at           text,
  enforcement_status        text not null default 'awaiting_finality'
                            check (enforcement_status in
                              ('not_enforceable','awaiting_finality','enforceable',
                               'stayed','under_enforcement','satisfied','closed')),
  enforcement_opened_at     text,
  enforcement_court         text,
  enforcement_reference     text,
  satisfied_at              text,
  recovered_amount_sar      real,
  created_by_membership_id  text not null references firm_memberships(id),
  created_at                text not null,
  updated_at                text not null,
  unique (tenant_id, deed_number),
  check (relief_kind <> 'monetary' or amount_sar is not null),
  check (amount_sar is null or amount_sar >= 0),
  check (stay_in_force = 0 or stay_ordered_at is not null),
  check (appeal_deadline_at is null or (appeal_rule_cited is not null and appeal_rule_days is not null)),
  check (enforcement_status <> 'under_enforcement' or enforcement_opened_at is not null),
  /* The twin of the line above, and it was missing until 0053 on the Postgres side: the
     gate that opens enforcement RECORDS the finality that admits it, so an enforcement
     under way cannot be a row that never learned when the judgment became final. Kept in
     both dialects because a mirror that permits what the real schema forbids is a mirror
     that teaches the wrong lesson — the entire reason this file carries foreign keys. */
  check (enforcement_status <> 'under_enforcement' or final_at is not null)
);
create index if not exists judgments_matter_idx on judgments(matter_id, pronounced_at desc);
create index if not exists judgments_client_idx on judgments(client_id, pronounced_at desc);
create index if not exists judgments_enforceable_idx
  on judgments(tenant_id, enforcement_status, appeal_deadline_at);

/* ── THE SERVICE REGISTER ─────────────────────────────────────────────────────── */
create table if not exists service_events (
  id                        text primary key,
  tenant_id                 text not null references tenants(id),
  client_id                 text not null references clients(id),
  matter_id                 text not null references matters(id) on delete restrict,
  judgment_id               text references judgments(id),
  notice_kind               text not null
                            check (notice_kind in ('judgment','court_notice','execution_notice',
                                                   'opponent_notice','client_notice','third_party_notice')),
  method                    text not null
                            check (method in ('in_court','personal','agent','registered_mail',
                                              'electronic','publication','judicial_bailiff')),
  outcome                   text not null default 'pending'
                            check (outcome in ('pending','served','refused','unclaimed',
                                               'untraceable','substituted')),
  served_on_kind            text not null
                            check (served_on_kind in ('client','opponent','representative','third_party')),
  served_on_name            text,
  served_on_party_id        text references parties(id),
  attempted_at              text,
  served_at                 text,
  publication_days          integer,
  effective_at              text,
  proof_document_id         text references documents(id),
  proof_reference           text,
  acknowledged_at           text,
  deadline_id               text references deadlines(id),
  note                      text,
  recorded_by_membership_id text not null references firm_memberships(id),
  created_at                text not null,
  updated_at                text not null,
  /* THE LINE, IN ONE CONSTRAINT, IN BOTH DIALECTS. An effective date exists if and only if
     the outcome is one of the three that take effect. */
  check ((outcome in ('served','refused','substituted'))
         = (case when effective_at is null then 0 else 1 end)),
  check (effective_at is null or served_at is not null),
  check (outcome <> 'substituted' or publication_days is not null),
  check (outcome = 'substituted' or publication_days is null)
);
create index if not exists service_events_matter_idx on service_events(matter_id, served_at desc);
create index if not exists service_events_judgment_idx on service_events(judgment_id);

/* ── THE CHALLENGES ───────────────────────────────────────────────────────────── */
create table if not exists judgment_appeals (
  id                        text primary key,
  tenant_id                 text not null references tenants(id),
  client_id                 text not null references clients(id),
  matter_id                 text not null references matters(id) on delete restrict,
  judgment_id               text not null references judgments(id),
  appeal_kind               text not null check (appeal_kind in ('appeal','cassation','rehearing')),
  filed_at                  text not null,
  filing_deadline_at        text,
  rule_cited                text,
  rule_days                 integer,
  filed_late                integer not null default 0,
  court                     text,
  court_ar                  text,
  reference                 text,
  status                    text not null default 'filed'
                            check (status in ('filed','registered','decided','withdrawn','rejected')),
  outcome                   text check (outcome in ('upheld','varied','overturned','remanded','dismissed')),
  decided_at                text,
  result_judgment_id        text references judgments(id),
  stay_requested            integer not null default 0,
  stay_granted              integer not null default 0,
  grounds                   text,
  grounds_ar                text,
  created_by_membership_id  text not null references firm_memberships(id),
  created_at                text not null,
  updated_at                text not null,
  check (status <> 'decided' or (outcome is not null and decided_at is not null)),
  check (status not in ('decided','withdrawn','rejected') or decided_at is not null),
  check (outcome is null or status = 'decided'),
  check (filed_late = 0 or filing_deadline_at is not null)
);
create index if not exists judgment_appeals_judgment_idx on judgment_appeals(judgment_id, filed_at desc);

/* ── THE DEADLINE THE SERVICE CREATES ─────────────────────────────────────────── */
/*
  The new columns and the new kinds, in the demo engine too. 'deadlines' lives in the
  PORTAL schema literal (schema.sqlite.ts) and is therefore owned by a file this one does
  not edit — which is exactly why the columns are added here, beside the phase that needs
  them, rather than by reopening a file whose bytes several hundred tests were written
  against. SQLite cannot widen a CHECK constraint with ALTER, so the constraint in this
  phase's terms is enforced by the trigger below, in the same voice as the Postgres one.
*/
create trigger if not exists deadline_procedural_guard_ins
  before insert on deadlines
  for each row when new.kind in ('appeal','cassation','reconsideration','limitation')
    and (new.client_visible = 1 or new.rule_cited is null or new.rule_days is null)
  begin
    select raise(ABORT, 'procedural_deadline_lane: a procedural deadline is the firm''s own obligation — it is never client-visible and it always carries the article it was computed from');
  end;

create trigger if not exists deadline_procedural_guard_upd
  before update on deadlines
  for each row when new.kind in ('appeal','cassation','reconsideration','limitation')
    and (new.client_visible = 1 or new.rule_cited is null or new.rule_days is null)
  begin
    select raise(ABORT, 'procedural_deadline_lane: a procedural deadline is the firm''s own obligation — it is never client-visible and it always carries the article it was computed from');
  end;

/* ── THE CLOCK FOLLOWS THE SERVICE ────────────────────────────────────────────── */
create trigger if not exists judgments_clock_guard_upd
  before update on judgments
  for each row when new.service_effective_at is not null
    and (old.service_effective_at is null or old.service_effective_at <> new.service_effective_at)
    and new.appeal_deadline_at is null
    and new.appealable = 1
  begin
    select raise(ABORT, 'appeal_window_uncomputed: this judgment was served and its period was never computed — a delivery date with no deadline is an appeal nobody diarised');
  end;

create trigger if not exists judgments_finality_guard_ins
  before insert on judgments
  for each row when new.final_at is not null and new.appealable = 1
    and new.appeal_deadline_at is not null and new.appeal_deadline_at > new.final_at
  begin
    select raise(ABORT, 'judgment_finality_contradiction: this judgment is recorded as final before the period for challenging it closed');
  end;

create trigger if not exists judgments_finality_guard_upd
  before update on judgments
  for each row when new.final_at is not null and new.appealable = 1
    and new.appeal_deadline_at is not null and new.appeal_deadline_at > new.final_at
  begin
    select raise(ABORT, 'judgment_finality_contradiction: this judgment is recorded as final before the period for challenging it closed');
  end;

/* ── THE ENFORCEMENT MATRIX ───────────────────────────────────────────────────── */
/*
  The same matrix as 'ENFORCEMENT_TRANSITIONS' in the domain, transcribed — and transcribed
  as a MATRIX rather than as a chain of conditions, so the two can be diffed against each
  other. The tempting invalid moves are the interesting entries: 'under_enforcement →
  enforceable' would be enforcement quietly un-happening, and 'satisfied →
  under_enforcement' would be the same judgment collected twice.
*/
create trigger if not exists judgments_enforcement_guard
  before update on judgments
  for each row when new.enforcement_status <> old.enforcement_status
    and not (
      (old.enforcement_status = 'not_enforceable'   and new.enforcement_status = 'awaiting_finality')
      /* awaiting_finality -> under_enforcement is allowed, and the reason is written out at
         length beside ENFORCEMENT_TRANSITIONS in server/src/domain/judgments.ts: a status
         column is a record and a record can lag the facts. Only the enforcement gate takes
         this edge, only after every condition passed, and it records final_at as it goes. */
   or (old.enforcement_status = 'awaiting_finality' and new.enforcement_status in ('enforceable','stayed','not_enforceable','under_enforcement'))
   or (old.enforcement_status = 'enforceable'       and new.enforcement_status in ('under_enforcement','stayed','not_enforceable'))
   or (old.enforcement_status = 'stayed'            and new.enforcement_status in ('enforceable','awaiting_finality','not_enforceable'))
   or (old.enforcement_status = 'under_enforcement' and new.enforcement_status in ('satisfied','closed','stayed'))
   or (old.enforcement_status = 'closed'            and new.enforcement_status = 'awaiting_finality')
    )
  begin
    select raise(ABORT, 'enforcement_transition_invalid: a judgment cannot move to that enforcement state from the one it is in');
  end;

create trigger if not exists judgments_enforcement_satisfied_guard
  before update on judgments
  for each row when new.enforcement_status = 'satisfied' and new.satisfied_at is null
  begin
    select raise(ABORT, 'enforcement_transition_invalid: a satisfied judgment carries the date it was satisfied');
  end;

/* ── RETENTION ────────────────────────────────────────────────────────────────── */
create trigger if not exists judgments_retention
  before delete on judgments
  for each row when old.service_effective_at is not null
    or old.served_at is not null
    or old.final_at is not null
    or old.enforcement_status in ('under_enforcement','satisfied','closed')
    or exists (select 1 from judgment_appeals a where a.judgment_id = old.id)
    or exists (select 1 from service_events s where s.judgment_id = old.id)
  begin
    select raise(ABORT, 'judgment_retention: this judgment has been served, challenged or enforced — it records what the firm did and may not be deleted');
  end;

create trigger if not exists service_events_retention
  before delete on service_events
  for each row when old.effective_at is not null or old.deadline_id is not null
  begin
    select raise(ABORT, 'service_retention: this service started a period the firm diarised — deleting it would leave the deadline with no cause');
  end;

/* ── THE GATE ON ENFORCEMENT ──────────────────────────────────────────────────── */
/*
  ONE TRIGGER, AND ITS CHECKS IN A DELIBERATE ORDER.

  The obvious mirror of the Postgres function is one trigger per condition, and it is the
  wrong mirror for the reason the CDD gate is written this way: SQLite does not define the
  order in which several triggers on the same event fire, so which refusal a person reads
  would be the database's choice rather than the rule's. The conditions overlap by
  construction — a judgment that is unserved and unenforceable fails both — so the messages
  would differ between two runs of the same test.

  Statements inside ONE trigger body DO run in order, and that gives exactly the precedence
  the Postgres function states: the existence of a judgment, what it orders, whether it
  reached the party, whether a court stopped it, whether a challenge is pending, whether the
  period is still open.

  THE OPERATIVE JUDGMENT IS THE LATEST PRONOUNCED — selected with the same ordering the
  domain uses, tie broken by 'created_at', so the route and the trigger cannot disagree
  about which deed number the answer is about.
*/
create trigger if not exists matter_execution_gate
  before update on matters
  for each row when new.internal_status = 'execution' and old.internal_status <> 'execution'
  begin
    /* (1) There is no judgment. */
    select raise(ABORT, 'judgment_missing: no judgment is registered on this matter — record the صك and its delivery before enforcement is considered')
     where not exists (select 1 from judgments j where j.matter_id = new.id and j.tenant_id = new.tenant_id);

    /* (2) Nothing to execute. */
    select raise(ABORT, 'judgment_not_enforceable: the operative judgment orders nothing that can be executed')
     where exists (select 1 from judgments j where j.matter_id = new.id and j.tenant_id = new.tenant_id
                     and j.id = (select j2.id from judgments j2 where j2.matter_id = new.id
                                  order by j2.pronounced_at desc, j2.created_at desc limit 1)
                     and j.relief_kind = 'none');

    /* (3) Not served. */
    select raise(ABORT, 'judgment_not_served: the judgment has not been served on the party enforcement is sought against, so no period has started to run')
     where exists (select 1 from judgments j where j.matter_id = new.id and j.tenant_id = new.tenant_id
                     and j.id = (select j2.id from judgments j2 where j2.matter_id = new.id
                                  order by j2.pronounced_at desc, j2.created_at desc limit 1)
                     and j.service_effective_at is null);

    /* (4) An attempt that did not take effect. */
    select raise(ABORT, 'service_defective: the only service recorded for this judgment did not take effect — serve again lawfully, or apply for substituted service')
     where exists (select 1 from judgments j where j.matter_id = new.id and j.tenant_id = new.tenant_id
                     and j.id = (select j2.id from judgments j2 where j2.matter_id = new.id
                                  order by j2.pronounced_at desc, j2.created_at desc limit 1)
                     and j.service_effective_at is null
                     and exists (select 1 from service_events s where s.judgment_id = j.id));

    /* (5) A court said stop. */
    select raise(ABORT, 'execution_stayed: a stay of execution is in force against this judgment — enforcement may not begin while it stands')
     where exists (select 1 from judgments j where j.matter_id = new.id and j.tenant_id = new.tenant_id
                     and j.id = (select j2.id from judgments j2 where j2.matter_id = new.id
                                  order by j2.pronounced_at desc, j2.created_at desc limit 1)
                     and j.stay_in_force = 1);

    /* (6) A challenge is pending. */
    select raise(ABORT, 'appeal_pending: a challenge is filed and undecided against this judgment — the matter is before a court')
     where exists (select 1 from judgment_appeals a
                    where a.status in ('filed','registered')
                      and a.judgment_id = (select j2.id from judgments j2 where j2.matter_id = new.id
                                            order by j2.pronounced_at desc, j2.created_at desc limit 1));

    /* (7) The period is still running. */
    select raise(ABORT, 'appeal_window_open: the period for challenging this judgment is still running')
     where exists (select 1 from judgments j where j.matter_id = new.id and j.tenant_id = new.tenant_id
                     and j.id = (select j2.id from judgments j2 where j2.matter_id = new.id
                                  order by j2.pronounced_at desc, j2.created_at desc limit 1)
                     and j.appealable = 1 and j.judgment_kind <> 'cassation'
                     and (j.appeal_deadline_at is null or j.appeal_deadline_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')));

    /* Admitted: the judgment follows the matter, so the register cannot disagree with it. */
    update judgments
       set enforcement_status = 'under_enforcement',
           enforcement_opened_at = coalesce(enforcement_opened_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           /* The finality the admission declares is written down as it is declared, so the
              state the matrix skipped is not missing from the file. */
           final_at = coalesce(final_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     where matter_id = new.id
       and id = (select j2.id from judgments j2 where j2.matter_id = new.id
                  order by j2.pronounced_at desc, j2.created_at desc limit 1)
       and enforcement_status in ('enforceable','awaiting_finality','stayed');
  end;

`;

// ═══════════════════════════════════════════════════════════════════════════════
// P0.5 · THE PRIVILEGE RING — the demo engine's copy
// ═══════════════════════════════════════════════════════════════════════════════
/*
  WHAT LIVES IN POSTGRES AND CANNOT LIVE HERE, AND WHAT IS THEREFORE HERE INSTEAD.

  Migration 0054 protects `matters.internal_notes` and `matters.risk_rating` with a
  COLUMN PRIVILEGE: the application role has no SELECT on them and the values come back
  through a `security definer` function. SQLite has neither roles nor column grants, so
  that mechanism cannot be mirrored — which is not a gap in the demo, it is the reason
  the demo cannot be the only place a rule is tested. The suite asserts the DOMAIN
  refuses (the projector withholds the field), the live harness asserts the DATABASE
  refuses (the grant is absent, the function raises), and this literal carries the part
  that is a property of the SCHEMA rather than of a role:

    · `documents.privilege_class`, and the rule that a privileged document is internal —
      a rule Postgres states as a CHECK, and which is stated here as a TRIGGER because
      SQLite cannot add a CHECK to a table that already exists;
    · `privilege_releases`, the ledger of deliberate exits, with the two legal rules the
      grounds carry: the client's consent is a WRITING (so it names a document), and a
      suspicion of money laundering goes to the REGULATOR (so it cannot name the other
      side). Those are CHECKs here and in 0054, and a drift check compares the two lists.
*/
export const PRIVILEGE_RING_SCHEMA = `
-- A privileged document is internal. Postgres says so with a CHECK —
-- check (privilege_class = 'none' or client_visibility = 'internal') — and SQLite cannot
-- add a CHECK to an existing table, so it is said with triggers, which also cover rows
-- written by a route that never consulted the registry.
create trigger if not exists document_privilege_internal_ins
  before insert on documents
  when new.privilege_class <> 'none' and new.client_visibility <> 'internal'
  begin select raise(ABORT, 'privilege_class_internal: a privileged document is internal — the advice the client receives is a document issued to the client, and a release is what moves material across'); end;

create trigger if not exists document_privilege_internal_upd
  before update on documents
  when new.privilege_class <> 'none' and new.client_visibility <> 'internal'
  begin select raise(ABORT, 'privilege_class_internal: a privileged document is internal'); end;

-- A privileged document cannot become client-visible by an update of one column either.
create trigger if not exists document_privilege_visibility_upd
  before update of client_visibility on documents
  when new.client_visibility <> 'internal' and old.privilege_class <> 'none'
  begin select raise(ABORT, 'privilege_class_internal: a privileged document cannot be made client-visible'); end;

/*
  THE DOOR'S LEDGER.

  Append-only in Postgres by privilege (no UPDATE or DELETE granted to anyone but the
  owner). SQLite has no grants, so it is append-only by trigger — the same rule, stated
  in the dialect that has to state it differently.
*/
create table if not exists privilege_releases (
  id                text primary key,
  tenant_id         text not null references tenants(id),
  matter_id         text not null references matters(id),
  document_id       text references documents(id),
  subject_kind      text not null check (subject_kind in ('matter_note','document','assessment')),
  -- القاعدة الحادية والعشرون: the four grounds, and no fifth.
  ground            text not null check (ground in
                      ('crime_prevention','aml_suspicion','self_defence','client_written_consent')),
  recipient_kind    text not null check (recipient_kind in
                      ('court','authority','regulator','third_party','client')),
  recipient_name    text not null,
  consent_document_id text references documents(id),
  released_by_membership_id text not null references firm_memberships(id),
  -- Postgres has a now() default (0054). The application writes this value explicitly in
  -- both dialects, but the default is mirrored so that a row inserted by hand means the same
  -- thing in the demo as in production.
  released_at       text not null default (datetime('now')),
  note              text,
  /* A document release must say which document. */
  check (subject_kind <> 'document' or document_id is not null),
  /* The client's consent is WRITTEN: name the writing, not a flag saying it happened. */
  check (ground <> 'client_written_consent' or consent_document_id is not null),
  /* A suspicion of money laundering is reported to the regulator — never to the other side. */
  check (ground <> 'aml_suspicion' or recipient_kind = 'regulator')
);
create index if not exists privilege_releases_matter_idx
  on privilege_releases(tenant_id, matter_id, released_at desc);

-- 0056 · WHERE THE RELEASE'S TWO DOCUMENTS ACTUALLY LIVE.
--
-- A foreign key proves only that a document EXISTS. The document being released must be a
-- document OF THIS MATTER; the writing that carries the client's consent must belong to the
-- CLIENT this matter is for. Same two rules, same token, same sentences as
-- privilege_release_guard() in 0056 and as the release route — defect (o) is what happens
-- when one copy of a rule is written differently from the others.
create trigger if not exists privilege_release_document_scope_ins
  before insert on privilege_releases
  when new.document_id is not null
   and not exists (
     select 1 from documents d
      where d.id = new.document_id and d.tenant_id = new.tenant_id
        and d.matter_id = new.matter_id)
  begin select raise(ABORT, 'privilege_document_mismatch: documentId — the document being released is not a document of this matter'); end;

create trigger if not exists privilege_release_consent_scope_ins
  before insert on privilege_releases
  when new.consent_document_id is not null
   and not exists (
     select 1 from documents d
      where d.id = new.consent_document_id and d.tenant_id = new.tenant_id
        and d.client_id = (select m.client_id from matters m where m.id = new.matter_id))
  begin select raise(ABORT, 'privilege_document_mismatch: consentDocumentId — the document named as the client''s written consent is not a document of this client'); end;

create trigger if not exists privilege_releases_append_only_upd
  before update on privilege_releases
  begin select raise(ABORT, 'privilege_release_immutable: a release that can be edited afterwards is not a record of a release'); end;

create trigger if not exists privilege_releases_append_only_del
  before delete on privilege_releases
  begin select raise(ABORT, 'privilege_release_immutable: a release that can be deleted is not a record of a release'); end;
`;
