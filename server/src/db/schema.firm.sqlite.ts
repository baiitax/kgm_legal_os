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
