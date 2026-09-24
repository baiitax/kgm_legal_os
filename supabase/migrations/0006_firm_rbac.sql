-- ============================================================================
-- KGM LEGAL OS — INTERNAL FIRM OS
-- Migration 0006 · Firm identity, RBAC, matter scoping, financial authority
--
-- Spec: §5 §6 §7 §8 §9-§17 §27 §50 §52 §70 §71
--
-- WHAT THIS ADDS
--   The portal migrations (0001-0005) built a client-facing authorization
--   surface: client_users, client_sessions, and RLS keyed to (tenant, client).
--   This migration builds the SEPARATE internal surface required by §3 and §6:
--   firm_memberships, a real role/permission graph, department and
--   practice-area scoping, per-matter access levels, and per-membership
--   financial ceilings.
--
--   `staff.internal_role` (a single string) is deliberately NOT used for
--   authorization any more. §6 rejects the "one role column" model. The column
--   stays as a personnel attribute; authority comes from the graph below.
--
-- DESIGN DECISIONS WORTH DEFENDING
--
--   D1 · A restricted `firm_api` role, not `firm_os`.
--        Migration 0004 gave `firm_os` `using (true)` policies — full access,
--        which is correct for back-office jobs and migrations but would make
--        RLS decorative for an API that serves browsers. `firm_api` is the role
--        the Firm OS API connects as, and every policy below is scoped.
--        This is the same reasoning that keeps the portal off the service key.
--
--   D2 · Non-recursive matter authorization (§71).
--        The failure mode the spec names is: matters policy -> matter_team ->
--        matters policy -> infinite recursion. Avoided structurally, not by
--        luck. `is_matter_member()` is SECURITY DEFINER, STABLE, reads exactly
--        two leaf tables, has a pinned search_path, and never calls a function
--        that touches `matters`. The tables it reads have policies keyed to
--        (tenant, membership) only — they never call back.
--        SECURITY DEFINER bypasses RLS, so the function body is the entire
--        trust boundary: it is read-only, takes one uuid, and returns boolean.
--
--   D3 · Permissions are a global catalogue; roles are tenant-scoped.
--        A tenant may grant or withhold `billing.approve`. It may not invent a
--        new code at runtime, because `assertCan()` call sites are written
--        against the catalogue and a code nobody checks is a code that does
--        nothing. Seeded as data at the bottom of this file.
--
--   D4 · NULL financial authority means NO authority, never unlimited.
--        The resolver refuses when the ceiling is NULL. A CHECK constraint keeps
--        the value non-negative; the semantics live in the domain layer and are
--        tested there.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ROLES
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'firm_api') then
    create role firm_api nologin;
  end if;
end $$;

grant usage on schema public to firm_api;

-- ----------------------------------------------------------------------------
-- CONTEXT HELPERS
-- The application sets these from the RESOLVED firm session, never from the
-- request. `kgm.phase()` already exists from 0004 ('auth' | 'portal'); the
-- Firm OS adds a third phase so a portal-scoped transaction can never satisfy
-- a firm-scoped policy, and vice versa.
-- ----------------------------------------------------------------------------
create or replace function public.kgm_membership() returns uuid
language sql stable as $$
  select nullif(current_setting('kgm.membership_id', true), '')::uuid
$$;

create or replace function public.kgm_is_firm() returns boolean
language sql stable as $$
  select public.kgm_phase() = 'firm'
     and public.kgm_tenant() is not null
     and public.kgm_membership() is not null
$$;

comment on function public.kgm_is_firm() is
  'True only inside a transaction the server opened for a resolved firm membership.';

-- ----------------------------------------------------------------------------
-- 1 · PERMISSION CATALOGUE (§8)
-- ----------------------------------------------------------------------------
create table if not exists public.permissions (
  code          text primary key,
  module        text not null,
  description   text,
  description_ar text,
  -- 'elevated' permissions are the ones §51 wants searchable in the audit log
  -- and §50 wants protected from self-grant.
  sensitivity   text not null default 'normal'
                check (sensitivity in ('normal','elevated','critical')),
  created_at    timestamptz not null default now()
);
create index if not exists permissions_module_idx on public.permissions (module);

alter table public.permissions enable row level security;
-- The catalogue is world-readable inside the database and immutable at runtime:
-- no API role may INSERT, UPDATE or DELETE it. Changing the catalogue is a
-- migration, which is the point.
create policy permissions_read on public.permissions to firm_api, portal_api
  using (true);

-- ----------------------------------------------------------------------------
-- 2 · ROLES (§7, §9-§16, §50)
-- ----------------------------------------------------------------------------
create table if not exists public.roles (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references public.tenants(id) on delete cascade,
  code          text not null,
  name          text not null,
  name_ar       text not null,
  description   text,
  description_ar text,
  is_system     boolean not null default false,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, code)
);

create table if not exists public.role_permissions (
  role_id          uuid not null references public.roles(id) on delete cascade,
  permission_code  text not null references public.permissions(code) on delete cascade,
  granted_at       timestamptz not null default now(),
  primary key (role_id, permission_code)
);
create index if not exists role_permissions_perm_idx
  on public.role_permissions (permission_code);

-- System roles are part of the product contract (§7). Deleting one would leave
-- seeded memberships pointing at nothing and would silently change what a
-- job title means.
create or replace function public.roles_protect_system() returns trigger
language plpgsql as $$
begin
  if old.is_system and (tg_op = 'DELETE' or new.is_system is distinct from old.is_system) then
    raise exception 'system roles cannot be deleted or unmarked';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists roles_system_guard on public.roles;
create trigger roles_system_guard
  before update or delete on public.roles
  for each row execute function public.roles_protect_system();

-- ----------------------------------------------------------------------------
-- 3 · FIRM MEMBERSHIP (§6)
-- ----------------------------------------------------------------------------
create table if not exists public.firm_memberships (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id),
  user_id       uuid not null references public.users(id),
  staff_id      uuid not null references public.staff(id),
  job_title     text,
  job_title_ar  text,
  status        text not null default 'invited'
                check (status in ('invited','active','suspended','left','deactivated')),
  -- §10 financial authority. NULL = no authority. Never read NULL as unlimited.
  financial_authority_sar numeric(14,2) check (financial_authority_sar is null or financial_authority_sar >= 0),
  writeoff_authority_sar  numeric(14,2) check (writeoff_authority_sar  is null or writeoff_authority_sar  >= 0),
  discount_authority_pct  numeric(5,2)  check (discount_authority_pct  is null or (discount_authority_pct >= 0 and discount_authority_pct <= 100)),
  joined_at     timestamptz,
  left_at       timestamptz,
  invited_by_membership_id uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index if not exists firm_memberships_user_idx   on public.firm_memberships (user_id);
create index if not exists firm_memberships_staff_idx  on public.firm_memberships (staff_id);
create index if not exists firm_memberships_status_idx on public.firm_memberships (tenant_id, status);

-- A membership cannot migrate between firms. Moving a person between tenants is
-- a new membership with a new audit trail, not an UPDATE — otherwise every
-- historical authorization decision would silently change meaning (§83).
create or replace function public.firm_membership_tenant_immutable() returns trigger
language plpgsql as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'firm_memberships.tenant_id is immutable';
  end if;
  return new;
end $$;

drop trigger if exists firm_membership_tenant_guard on public.firm_memberships;
create trigger firm_membership_tenant_guard
  before update on public.firm_memberships
  for each row execute function public.firm_membership_tenant_immutable();

create table if not exists public.membership_roles (
  membership_id           uuid not null references public.firm_memberships(id) on delete cascade,
  role_id                 uuid not null references public.roles(id) on delete cascade,
  granted_by_membership_id uuid,
  -- Every privilege change records who made it (§49/§83). But the FIRST grant in
  -- a tenant has no granter: someone has to bootstrap the firm, and an
  -- invitation carries its actor on the invitation row. So attribution is
  -- mandatory unless the origin is one that provably has no membership actor.
  -- `grant_origin` is what keeps that honest — a NULL granter is not allowed to
  -- be unexplained.
  grant_origin            text not null default 'admin'
                          check (grant_origin in ('admin','bootstrap','invitation','system')),
  granted_at              timestamptz not null default now(),
  revoked_at              timestamptz,
  primary key (membership_id, role_id)
);
comment on column public.membership_roles.granted_by_membership_id is
  '§49/§83: who granted this role. Required whenever grant_origin is ''admin''.';

create or replace function public.membership_roles_grant_attribution() returns trigger
language plpgsql as $$
begin
  if new.grant_origin = 'admin' and new.granted_by_membership_id is null then
    raise exception 'a role grant must record who granted it';
  end if;
  return new;
end $$;

drop trigger if exists membership_roles_attribution on public.membership_roles;
create trigger membership_roles_attribution
  before insert or update of grant_origin, granted_by_membership_id
  on public.membership_roles
  for each row execute function public.membership_roles_grant_attribution();

-- ----------------------------------------------------------------------------
-- 4 · DEPARTMENTS (§5) AND PRACTICE-AREA SCOPE (§10)
-- ----------------------------------------------------------------------------
create table if not exists public.departments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  code        text not null,
  name        text not null,
  name_ar     text not null,
  parent_id   uuid references public.departments(id),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

create table if not exists public.department_members (
  department_id  uuid not null references public.departments(id) on delete cascade,
  membership_id  uuid not null references public.firm_memberships(id) on delete cascade,
  is_lead        boolean not null default false,
  joined_at      timestamptz not null default now(),
  primary key (department_id, membership_id)
);

-- The chosen scoping model: departments stay the org tree, and a member's legal
-- reach is the set of practice areas they may see. No rows = assigned matters
-- only. The sentinel '*' = unrestricted within the tenant (Managing Partner).
create table if not exists public.membership_practice_areas (
  membership_id   uuid not null references public.firm_memberships(id) on delete cascade,
  practice_area   text not null,
  granted_at      timestamptz not null default now(),
  primary key (membership_id, practice_area)
);

-- ----------------------------------------------------------------------------
-- 5 · MATTER SCOPING (§17, §27)
-- ----------------------------------------------------------------------------
create table if not exists public.matter_controls (
  matter_id                     uuid primary key references public.matters(id) on delete cascade,
  tenant_id                     uuid not null references public.tenants(id),
  department_id                 uuid references public.departments(id),
  owner_membership_id           uuid references public.firm_memberships(id),
  lead_staff_id                 uuid references public.staff(id),
  supervising_partner_staff_id  uuid references public.staff(id),
  is_restricted                 boolean not null default false,
  restriction_reason            text,
  restriction_reason_ar         text,
  restricted_at                 timestamptz,
  restricted_by_membership_id   uuid references public.firm_memberships(id),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);
create index if not exists matter_controls_tenant_idx
  on public.matter_controls (tenant_id, is_restricted);

-- §27: restricting a matter removes access from people who currently have it.
-- That is a consequential act, so the database refuses to record it without a
-- reason and an actor.
create or replace function public.matter_controls_restriction_guard() returns trigger
language plpgsql as $$
begin
  if new.is_restricted and (not old.is_restricted) then
    if new.restriction_reason is null or new.restricted_by_membership_id is null then
      raise exception 'restricting a matter requires a reason and an actor';
    end if;
    new.restricted_at := now();
  end if;
  return new;
end $$;

drop trigger if exists matter_controls_restriction on public.matter_controls;
create trigger matter_controls_restriction
  before update on public.matter_controls
  for each row execute function public.matter_controls_restriction_guard();

create table if not exists public.matter_permissions (
  id            uuid primary key default gen_random_uuid(),
  matter_id     uuid not null references public.matters(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id),
  membership_id uuid not null references public.firm_memberships(id) on delete cascade,
  access_level  text not null
                check (access_level in ('full','edit','operational','view','financial','compliance','none')),
  reason        text,
  granted_by_membership_id uuid,
  granted_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  unique (matter_id, membership_id)
);
create index if not exists matter_permissions_member_idx
  on public.matter_permissions (membership_id, revoked_at);

-- ----------------------------------------------------------------------------
-- 6 · NON-RECURSIVE MATTER AUTHORIZATION (§71)
-- ----------------------------------------------------------------------------
-- Reads two leaf tables. Neither has a policy that calls this function, and the
-- SECURITY DEFINER attribute is what breaks the cycle: the body runs as the
-- owner, so evaluating membership never re-enters the `matters` policy.
create or replace function public.is_matter_member(p_matter uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.matter_team mt
    where mt.matter_id = p_matter
      and mt.staff_id  = (select staff_id from public.firm_memberships
                          where id = public.kgm_membership())
      and mt.is_active
  )
  or exists (
    select 1
    from public.matter_permissions mp
    where mp.matter_id     = p_matter
      and mp.membership_id = public.kgm_membership()
      and mp.revoked_at    is null
      and mp.access_level <> 'none'
  );
$$;

comment on function public.is_matter_member(uuid) is
  '§71: non-recursive matter membership. SECURITY DEFINER over two leaf tables only.';

-- Practice-area scope (§10). The sentinel '*' is unrestricted within the tenant
-- and is what a Managing Partner holds. No rows means the member is scoped to
-- matters they are actually assigned to, which is what §11 requires of lawyers.
create or replace function public.matter_in_practice_scope(p_matter uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.membership_practice_areas pa
    where pa.membership_id = public.kgm_membership()
      and pa.practice_area = '*'
  )
  or exists (
    select 1
    from public.membership_practice_areas pa
    join public.matters m on m.practice_area = pa.practice_area
    where pa.membership_id = public.kgm_membership()
      and m.id = p_matter
  );
$$;

-- The access LEVEL for a matter, resolved in exactly one place so the API and
-- RLS cannot disagree. Precedence, highest first:
--   1. an explicit grant — including an explicit 'none', which is a denial
--      record and outranks everything (§27)
--   2. on a restricted matter, nothing else counts: no team row, no practice
--      scope, no matters.read_all. Explicit grant or no access at all.
--   3. the matter_team role's default level
--   4. practice-area scope or matters.read_all, which grant the weakest useful
--      level, 'view' — how a partner sees their group's work without joining
--      every team
--   5. 'none'
create or replace function public.matter_access_level(p_matter uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with facts as (
    select
      coalesce((select mc.is_restricted from public.matter_controls mc
                where mc.matter_id = p_matter), false) as is_restricted,
      (select mp.access_level
         from public.matter_permissions mp
        where mp.matter_id     = p_matter
          and mp.membership_id = public.kgm_membership()
          and mp.revoked_at    is null
        order by mp.granted_at desc
        limit 1) as explicit_level,
      (select case mt.matter_role
                when 'lead_partner'        then 'full'
                when 'lead_lawyer'         then 'full'
                when 'supervising_partner' then 'full'
                when 'lawyer'              then 'edit'
                when 'associate'           then 'edit'
                when 'paralegal'           then 'operational'
                when 'finance_contact'     then 'financial'
                when 'compliance_contact'  then 'compliance'
                else 'view'
              end
         from public.matter_team mt
        where mt.matter_id = p_matter
          and mt.staff_id  = (select staff_id from public.firm_memberships
                              where id = public.kgm_membership())
          and mt.is_active
        limit 1) as team_level
  )
  select case
    when f.explicit_level is not null then f.explicit_level
    when f.is_restricted              then 'none'
    when f.team_level is not null     then f.team_level
    when public.matter_in_practice_scope(p_matter)
      or public.kgm_holds('matters.read_all') then 'view'
    else 'none'
  end
  from facts f;
$$;

comment on function public.matter_access_level(uuid) is
  'full | edit | operational | view | financial | compliance | none. §17 + §27.';

-- Permission lookup for a membership. SECURITY DEFINER over three leaf tables
-- (membership_roles, role_permissions, roles) whose own policies never call
-- back, so this is safe to use inside a matter-scoped policy. It is deliberately
-- NOT used to authorize rows in firm_* tables — only to widen matter visibility
-- for the two scope-bypassing read permissions.
create or replace function public.kgm_holds(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.membership_roles mr
    join public.roles r            on r.id = mr.role_id and r.is_active
    join public.role_permissions rp on rp.role_id = r.id
    where mr.membership_id   = public.kgm_membership()
      and mr.revoked_at      is null
      and rp.permission_code = p_permission
  );
$$;

comment on function public.kgm_holds(text) is
  'True when the calling membership holds a permission through any active, non-revoked role.';

-- Row visibility: the gate the RLS policies actually use. Deliberately thin —
-- every rule lives in matter_access_level() so there is exactly one place where
-- a matter can be decided, and `matter_visible` cannot drift away from it.
create or replace function public.matter_visible(p_matter uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- Must be in the caller's own tenant, whatever else is true. A matter id
    -- from another firm is indistinguishable from one that does not exist.
    exists (select 1 from public.matters m
            where m.id = p_matter and m.tenant_id = public.kgm_tenant())
    and public.matter_access_level(p_matter) <> 'none';
$$;

comment on function public.matter_visible(uuid) is
  'Single visibility gate for matter-scoped rows. Tenant AND (level OR practice scope).';

-- ----------------------------------------------------------------------------
-- 7 · FIRM AUTH (§52)
-- ----------------------------------------------------------------------------
create table if not exists public.firm_sessions (
  id               uuid primary key default gen_random_uuid(),
  membership_id    uuid not null references public.firm_memberships(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  tenant_id        uuid not null references public.tenants(id),
  token_hash       text not null unique,
  created_at       timestamptz not null default now(),
  last_activity    timestamptz not null default now(),
  expires_at       timestamptz not null,
  idle_expires_at  timestamptz not null,
  ip_hash          text,
  ip_country       text,
  user_agent       text,
  device_label     text,
  browser          text,
  os               text,
  mfa_verified_at  timestamptz,
  trusted_device_id uuid,
  -- A cache hint only. The resolver re-reads the graph every request; nothing
  -- authorizes from this column, because a revoked role must take effect
  -- immediately and not at the next login.
  role_snapshot    jsonb,
  revoked_at       timestamptz,
  revoke_reason    text
);
create index if not exists firm_sessions_membership_idx
  on public.firm_sessions (membership_id, revoked_at);
create index if not exists firm_sessions_expiry_idx
  on public.firm_sessions (expires_at, idle_expires_at);

-- Only an active membership may mint a session. The resolver enforces this too;
-- the database should not be able to hold a contradictory state (§83).
create or replace function public.firm_sessions_require_active() returns trigger
language plpgsql as $$
declare s text;
begin
  select status into s from public.firm_memberships where id = new.membership_id;
  if s is distinct from 'active' then
    raise exception 'only an active membership may hold a session';
  end if;
  return new;
end $$;

drop trigger if exists firm_sessions_active_guard on public.firm_sessions;
create trigger firm_sessions_active_guard
  before insert on public.firm_sessions
  for each row execute function public.firm_sessions_require_active();

create table if not exists public.firm_invitations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id),
  staff_id      uuid references public.staff(id),
  email         text not null,
  full_name     text not null,
  full_name_ar  text,
  token_hash    text not null unique,
  token_hint    text not null,
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  revoked_at    timestamptz,
  created_by_membership_id uuid,
  accept_ip_hash text,
  created_at    timestamptz not null default now()
);
create index if not exists firm_invitations_email_idx
  on public.firm_invitations (tenant_id, lower(email));

create table if not exists public.firm_invitation_roles (
  invitation_id uuid not null references public.firm_invitations(id) on delete cascade,
  role_id       uuid not null references public.roles(id) on delete cascade,
  primary key (invitation_id, role_id)
);

create table if not exists public.firm_devices (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  fingerprint_hash  text not null,
  label             text,
  trusted_until     timestamptz,
  mfa_trusted       boolean not null default false,
  last_seen_at      timestamptz not null default now(),
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  unique (user_id, fingerprint_hash)
);

-- ----------------------------------------------------------------------------
-- 7b · AUDIT ACTOR KINDS FOR THE FIRM AUDIENCE (§51, §83)
-- ----------------------------------------------------------------------------
-- The portal's audit trail already distinguishes client_user / staff / system /
-- anonymous / webhook. A firm operator is none of those: `staff` describes the
-- display record shown to clients, while the actor here is a membership with a
-- resolved permission set. Recording it as `staff` would make it impossible to
-- answer "which membership escalated?" from the log alone, so the enum grows.
-- Done here rather than by editing 0003, because 0003 has already run.
alter table public.audit_events
  drop constraint if exists audit_events_actor_kind_check;
alter table public.audit_events
  add constraint audit_events_actor_kind_check
  check (actor_kind in ('client_user','staff','system','anonymous','webhook','firm_member'));

-- firm_api may append audit rows and nothing else (§51: append-only). The
-- SELECT/UPDATE/DELETE grants are deliberately absent.
grant insert (id, occurred_at, tenant_id, actor_kind, actor_user_id, actor_client_id,
              action, resource_type, resource_id, outcome, reason_code,
              ip_hash, ip_country, user_agent, request_id, metadata)
  on public.audit_events to firm_api;
grant usage, select on sequence public.audit_events_id_seq to firm_api;

-- Audit search is itself a privilege (audit.read). It goes through a SECURITY
-- DEFINER function rather than a table grant, so that holding `audit.read` is
-- the only way in and the grant list never mentions the table.
create or replace function public.firm_audit_search(
  p_from timestamptz default null,
  p_to   timestamptz default null,
  p_actor uuid       default null,
  p_action text      default null,
  p_limit  integer   default 200
)
returns setof public.audit_events
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.audit_events a
  where a.tenant_id = public.kgm_tenant()
    and public.kgm_is_firm()
    and public.kgm_holds('audit.read')
    and (p_from is null or a.occurred_at >= p_from)
    and (p_to   is null or a.occurred_at <= p_to)
    and (p_actor is null or a.actor_user_id = p_actor)
    and (p_action is null or a.action = p_action)
  order by a.occurred_at desc
  limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$$;

revoke all on function public.firm_audit_search(timestamptz, timestamptz, uuid, text, integer) from public;
grant execute on function public.firm_audit_search(timestamptz, timestamptz, uuid, text, integer) to firm_api;

-- ----------------------------------------------------------------------------
-- 8 · TENANT CONFIGURATION (multi-firm)
-- ----------------------------------------------------------------------------
create table if not exists public.tenant_settings (
  tenant_id                 uuid primary key references public.tenants(id) on delete cascade,
  display_name              text,
  display_name_ar           text,
  brand_key                 text,
  support_email             text,
  support_phone             text,
  timezone                  text not null default 'Asia/Riyadh',
  currency                  text not null default 'SAR',
  vat_rate                  numeric(4,3) not null default 0.150
                            check (vat_rate >= 0 and vat_rate <= 1),
  fiscal_year_start_month   smallint not null default 1
                            check (fiscal_year_start_month between 1 and 12),
  notification_channels     jsonb not null default '["in_app","email"]'::jsonb,
  mfa_required              boolean not null default false,
  password_min_length       smallint not null default 12
                            check (password_min_length between 8 and 128),
  session_absolute_minutes  integer not null default 720,
  session_idle_minutes      integer not null default 60,
  updated_at                timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 9 · ROW LEVEL SECURITY FOR firm_api
-- ----------------------------------------------------------------------------
alter table public.permissions               enable row level security;
alter table public.roles                     enable row level security;
alter table public.role_permissions          enable row level security;
alter table public.firm_memberships          enable row level security;
alter table public.membership_roles          enable row level security;
alter table public.departments               enable row level security;
alter table public.department_members        enable row level security;
alter table public.membership_practice_areas enable row level security;
alter table public.matter_controls           enable row level security;
alter table public.matter_permissions        enable row level security;
alter table public.firm_sessions             enable row level security;
alter table public.firm_invitations          enable row level security;
alter table public.firm_invitation_roles     enable row level security;
alter table public.firm_devices              enable row level security;
alter table public.tenant_settings           enable row level security;

-- Membership: a member sees their own row. Seeing OTHER memberships is an
-- administration capability and goes through a view gated in the domain layer,
-- not through a blanket policy — a wide policy here would let any lawyer
-- enumerate the firm's staff list.
create policy firm_membership_self on public.firm_memberships to firm_api
  using (public.kgm_is_firm() and id = public.kgm_membership())
  with check (false);

create policy firm_sessions_self on public.firm_sessions to firm_api
  using (public.kgm_is_firm() and membership_id = public.kgm_membership())
  with check (public.kgm_is_firm() and membership_id = public.kgm_membership());

create policy firm_devices_self on public.firm_devices to firm_api
  using (public.kgm_is_firm()
         and user_id = (select user_id from public.firm_memberships
                        where id = public.kgm_membership()))
  with check (false);

-- Tenant-scoped reference data: readable inside the tenant, never writable
-- through the API role. Role and permission edits are an administrative
-- workflow that runs as `firm_os` with its own audit requirements (§50).
create policy roles_tenant_read on public.roles to firm_api
  using (public.kgm_is_firm() and (tenant_id = public.kgm_tenant() or tenant_id is null))
  with check (false);

create policy role_permissions_read on public.role_permissions to firm_api
  using (public.kgm_is_firm() and exists (
    select 1 from public.roles r
    where r.id = role_id and (r.tenant_id = public.kgm_tenant() or r.tenant_id is null)))
  with check (false);

create policy membership_roles_self on public.membership_roles to firm_api
  using (public.kgm_is_firm() and membership_id = public.kgm_membership())
  with check (false);

create policy departments_tenant_read on public.departments to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (false);

create policy department_members_self on public.department_members to firm_api
  using (public.kgm_is_firm() and membership_id = public.kgm_membership())
  with check (false);

create policy practice_areas_self on public.membership_practice_areas to firm_api
  using (public.kgm_is_firm() and membership_id = public.kgm_membership())
  with check (false);

-- Matter scoping. `matter_permissions` and `matter_team` are the LEAF tables
-- `is_matter_member()` reads; their policies must not call back into `matters`
-- or the recursion the spec warns about returns. Tenant + membership only.
create policy matter_permissions_tenant on public.matter_permissions to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (false);

create policy matter_controls_tenant on public.matter_controls to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (false);

create policy tenant_settings_read on public.tenant_settings to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (false);

-- Invitations are administrative: the API role may read its own tenant's
-- outstanding invitations (to show "pending" in a user list) but never write
-- them, because issuing an invitation is a privilege grant (§49).
create policy firm_invitations_tenant_read on public.firm_invitations to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (false);

create policy firm_invitation_roles_read on public.firm_invitation_roles to firm_api
  using (public.kgm_is_firm() and exists (
    select 1 from public.firm_invitations i
    where i.id = invitation_id and i.tenant_id = public.kgm_tenant()))
  with check (false);

-- ----------------------------------------------------------------------------
-- 10 · MATTER-SCOPED READ ACCESS ON EXISTING TABLES
-- ----------------------------------------------------------------------------
-- The portal's policies (0004) are keyed to (tenant, client) and are untouched.
-- These add firm_api access to the same rows through a DIFFERENT gate: matter
-- membership. Both must be present for a row to be visible to a given role, and
-- no role holds both.
-- Tables that carry matter_id directly. `invoice_lines` and `messages` do not:
-- they hang off invoices and threads, and a join-based policy on a child table
-- would re-enter the parent's policy, so they are authorized through their
-- parent in the domain layer instead. That is a deliberate gap, not an oversight.
alter table public.hearings enable row level security;
drop policy if exists firm_matter_scope on public.hearings;
create policy firm_matter_scope on public.hearings to firm_api
  using (public.kgm_is_firm()
         and tenant_id = public.kgm_tenant()
         and public.matter_visible(matter_id))
  with check (false);

alter table public.deadlines enable row level security;
drop policy if exists firm_matter_scope on public.deadlines;
create policy firm_matter_scope on public.deadlines to firm_api
  using (public.kgm_is_firm()
         and tenant_id = public.kgm_tenant()
         and public.matter_visible(matter_id))
  with check (false);

alter table public.documents enable row level security;
drop policy if exists firm_matter_scope on public.documents;
create policy firm_matter_scope on public.documents to firm_api
  using (public.kgm_is_firm()
         and tenant_id = public.kgm_tenant()
         and public.matter_visible(matter_id))
  with check (false);

alter table public.matter_timeline enable row level security;
drop policy if exists firm_matter_scope on public.matter_timeline;
create policy firm_matter_scope on public.matter_timeline to firm_api
  using (public.kgm_is_firm()
         and tenant_id = public.kgm_tenant()
         and public.matter_visible(matter_id))
  with check (false);

alter table public.message_threads enable row level security;
drop policy if exists firm_matter_scope on public.message_threads;
create policy firm_matter_scope on public.message_threads to firm_api
  using (public.kgm_is_firm()
         and tenant_id = public.kgm_tenant()
         and public.matter_visible(matter_id))
  with check (false);

alter table public.matters enable row level security;
drop policy if exists firm_matter_scope on public.matters;
create policy firm_matter_scope on public.matters to firm_api
  using (public.kgm_is_firm()
         and tenant_id = public.kgm_tenant()
         and public.matter_visible(id))
  with check (false);

-- Child tables authorized through their parent row.
alter table public.invoice_lines enable row level security;
drop policy if exists firm_invoice_scope on public.invoice_lines;
create policy firm_invoice_scope on public.invoice_lines to firm_api
  using (public.kgm_is_firm() and exists (
    select 1 from public.invoices i
    where i.id = invoice_id
      and i.tenant_id = public.kgm_tenant()
      and public.matter_visible(i.matter_id)))
  with check (false);

alter table public.messages enable row level security;
drop policy if exists firm_thread_scope on public.messages;
create policy firm_thread_scope on public.messages to firm_api
  using (public.kgm_is_firm() and exists (
    select 1 from public.message_threads th
    where th.id = thread_id
      and th.tenant_id = public.kgm_tenant()
      and public.matter_visible(th.matter_id)))
  with check (false);

-- `internal_notes` stays closed to firm_api as well as portal_api: the table
-- exists for the compliance and partner workflows that run as `firm_os`.
alter table public.internal_notes enable row level security;
drop policy if exists internal_notes_denied on public.internal_notes;
create policy internal_notes_denied on public.internal_notes to firm_api, portal_api
  using (false) with check (false);

-- ----------------------------------------------------------------------------
-- 11 · GRANTS
-- ----------------------------------------------------------------------------
-- SELECT on the RBAC graph, scoped by the policies above.
grant select on
  public.permissions, public.roles, public.role_permissions,
  public.firm_memberships, public.membership_roles,
  public.departments, public.department_members, public.membership_practice_areas,
  public.matter_controls, public.matter_permissions,
  public.firm_invitations, public.firm_invitation_roles, public.tenant_settings
  to firm_api;

-- The API owns its own session and device rows.
grant select, insert, update on public.firm_sessions to firm_api;
grant select, insert, update on public.firm_devices  to firm_api;

-- Matter-scoped reads.
grant select on
  public.matters, public.hearings, public.deadlines, public.documents,
  public.invoices, public.invoice_lines, public.matter_timeline,
  public.message_threads, public.messages
  to firm_api;
-- invoices has no matter_id-free path: it is matter-scoped through its own
-- tenant_id and matter_id columns, so it needs the same policy as its children.
alter table public.invoices enable row level security;
drop policy if exists firm_matter_scope on public.invoices;
create policy firm_matter_scope on public.invoices to firm_api
  using (public.kgm_is_firm()
         and tenant_id = public.kgm_tenant()
         and public.matter_visible(matter_id))
  with check (false);

-- NO grant on internal_notes, audit_events, staff salary-adjacent columns, or
-- any write path to roles/permissions/matter_permissions. Those are the
-- §50/§51 administrative surfaces and they run as firm_os with attribution.
revoke all on public.internal_notes from firm_api;
revoke all on public.audit_events   from firm_api;

-- firm_os keeps full access for back-office jobs, migrations and the
-- administrative workflows that must attribute their own writes.
do $$
declare t text;
begin
  foreach t in array array[
    'permissions','roles','role_permissions','firm_memberships','membership_roles',
    'departments','department_members','membership_practice_areas','matter_controls',
    'matter_permissions','firm_sessions','firm_invitations','firm_invitation_roles',
    'firm_devices','tenant_settings'
  ] loop
    execute format('drop policy if exists firm_full on public.%I', t);
    execute format('create policy firm_full on public.%I to firm_os using (true) with check (true)', t);
    execute format('grant all on public.%I to firm_os', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 12 · PERMISSION CATALOGUE SEED (§8)
-- ----------------------------------------------------------------------------
-- Idempotent. The codes below are the contract `assertCan()` is written
-- against; adding one without a call site that checks it does nothing, and
-- removing one breaks the build rather than silently widening access.
insert into public.permissions (code, module, description, description_ar, sensitivity) values
  -- clients (§21-§23)
  ('clients.read','clients','View client records','عرض سجلات العملاء','normal'),
  ('clients.create','clients','Create a client','إنشاء عميل','normal'),
  ('clients.update','clients','Edit client records','تعديل سجلات العملاء','normal'),
  ('clients.archive','clients','Archive a client','أرشفة عميل','elevated'),
  ('clients.read_sensitive','clients','View unmasked national identifiers','عرض معرفات الهوية غير المقنّعة','critical'),
  ('clients.kyc','clients','Perform KYC/AML review','إجراء مراجعة اعرف عميلك','elevated'),
  -- matters (§24-§27)
  ('matters.read','matters','View assigned matters','عرض القضايا المسندة','normal'),
  ('matters.read_all','matters','View matters outside practice-area scope','عرض القضايا خارج نطاق الممارسة','elevated'),
  ('matters.create','matters','Create a matter','إنشاء قضية','normal'),
  ('matters.update','matters','Edit matter details','تعديل بيانات القضية','normal'),
  ('matters.assign','matters','Assign and remove matter team members','إسناد أعضاء فريق القضية','elevated'),
  ('matters.restrict','matters','Restrict or unrestrict a matter','تقييد قضية أو رفع القيد','critical'),
  ('matters.close','matters','Close a matter','إغلاق القضية','elevated'),
  ('matters.reopen','matters','Reopen a closed matter','إعادة فتح قضية مغلقة','elevated'),
  ('matters.status','matters','Advance the matter state machine','تحريك حالة القضية','normal'),
  -- documents (§32-§35)
  ('documents.read','documents','View documents on assigned matters','عرض مستندات القضايا المسندة','normal'),
  ('documents.create','documents','Upload and draft documents','رفع المستندات وإنشاء المسودات','normal'),
  ('documents.edit','documents','Edit document content','تعديل محتوى المستند','normal'),
  ('documents.delete','documents','Delete an unapproved document version','حذف إصدار مستند غير معتمد','elevated'),
  ('documents.approve','documents','Approve a document version','اعتماد إصدار المستند','elevated'),
  ('documents.release','documents','Release a document to the client portal','نشر المستند إلى بوابة العميل','elevated'),
  ('documents.templates','documents','Manage document templates','إدارة قوالب المستندات','elevated'),
  -- legal operations (§28-§31, §40-§41)
  ('tasks.read','operations','View tasks','عرض المهام','normal'),
  ('tasks.manage','operations','Create, assign and close tasks','إنشاء المهام وإسنادها وإغلاقها','normal'),
  ('hearings.read','operations','View hearings','عرض الجلسات','normal'),
  ('hearings.manage','operations','Create and update hearings','إنشاء الجلسات وتحديثها','normal'),
  ('deadlines.read','operations','View deadlines','عرض المواعيد النهائية','normal'),
  ('deadlines.manage','operations','Create and update deadlines','إنشاء المواعيد النهائية وتحديثها','normal'),
  ('contracts.read','operations','View engagement contracts','عرض عقود الأتعاب','normal'),
  ('contracts.manage','operations','Create and amend engagement contracts','إنشاء عقود الأتعاب وتعديلها','elevated'),
  ('poa.read','operations','View powers of attorney','عرض الوكالات','normal'),
  ('poa.manage','operations','Record and amend powers of attorney','تسجيل الوكالات وتعديلها','elevated'),
  -- finance (§36-§39)
  ('billing.read','finance','View invoices and billing data','عرض الفواتير وبيانات الفوترة','normal'),
  ('billing.read_all','finance','View billing outside practice-area scope','عرض الفوترة خارج نطاق الممارسة','elevated'),
  ('billing.create','finance','Draft invoices','إنشاء مسودات الفواتير','normal'),
  ('billing.edit','finance','Edit draft invoices','تعديل مسودات الفواتير','normal'),
  ('billing.approve','finance','Approve an invoice for sending','اعتماد الفاتورة للإرسال','elevated'),
  ('billing.send','finance','Send an approved invoice to a client','إرسال فاتورة معتمدة إلى العميل','elevated'),
  ('billing.record_payment','finance','Record a payment from a verified source','تسجيل دفعة من مصدر موثّق','elevated'),
  ('billing.writeoff','finance','Write off a balance','إعدام رصيد','critical'),
  ('billing.discount','finance','Apply a discount','تطبيق خصم','elevated'),
  ('time.read','finance','View time entries','عرض قيود الوقت','normal'),
  ('time.create','finance','Record own time','تسجيل الوقت الشخصي','normal'),
  ('time.adjust','finance','Adjust or void time entries','تعديل أو إبطال قيود الوقت','elevated'),
  ('expenses.read','finance','View expenses','عرض المصروفات','normal'),
  ('expenses.create','finance','Submit own expenses','تقديم المصروفات الشخصية','normal'),
  ('expenses.approve','finance','Approve expenses','اعتماد المصروفات','elevated'),
  -- compliance (§42-§46)
  ('compliance.read','compliance','View compliance records','عرض سجلات الامتثال','elevated'),
  ('compliance.create','compliance','Open conflict checks and reviews','فتح فحوص التعارض والمراجعات','elevated'),
  ('compliance.review','compliance','Review KYC, AML and conflicts','مراجعة اعرف عميلك وغسل الأموال والتعارضات','elevated'),
  ('compliance.approve','compliance','Clear or escalate a compliance item','اعتماد أو تصعيد بند امتثال','critical'),
  ('compliance.licences','compliance','Manage lawyer licences','إدارة تراخيص المحاماة','elevated'),
  ('compliance.training','compliance','Manage CLE and training records','إدارة سجلات التدريب','normal'),
  ('compliance.complaints','compliance','Manage complaints','إدارة الشكاوى','critical'),
  -- administration (§49-§52)
  ('users.read','admin','View firm members','عرض أعضاء المكتب','elevated'),
  ('users.invite','admin','Invite a firm member','دعوة عضو إلى المكتب','critical'),
  ('users.update','admin','Edit a member record','تعديل سجل عضو','elevated'),
  ('users.deactivate','admin','Suspend or deactivate a member','تعليق أو إلغاء تفعيل عضو','critical'),
  ('users.assign_role','admin','Grant or revoke a role','منح دور أو سحبه','critical'),
  ('users.assign_matter','admin','Grant or revoke matter access','منح صلاحية قضية أو سحبها','critical'),
  ('users.revoke_session','admin','Revoke another member session','إنهاء جلسة عضو آخر','critical'),
  ('roles.read','admin','View roles and permissions','عرض الأدوار والصلاحيات','elevated'),
  ('roles.manage','admin','Create and edit roles','إنشاء الأدوار وتعديلها','critical'),
  ('departments.manage','admin','Manage departments and membership','إدارة الأقسام والعضوية','elevated'),
  ('settings.read','admin','View firm settings','عرض إعدادات المكتب','elevated'),
  ('settings.manage','admin','Change firm settings','تغيير إعدادات المكتب','critical'),
  ('audit.read','admin','Search the audit log','البحث في سجل التدقيق','critical'),
  ('audit.export','admin','Export the audit log','تصدير سجل التدقيق','critical'),
  ('analytics.read','admin','View firm analytics and risk centre','عرض التحليلات ومركز المخاطر','elevated')
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
-- 13 · SYSTEM ROLE TEMPLATES (§7, §9-§16)
-- ----------------------------------------------------------------------------
-- tenant_id is NULL for templates: they are the product's definition of each
-- role. A tenant gets its own copy on first boot (application-level seeding),
-- which is what lets one firm tune a role without changing another's.
insert into public.roles (id, tenant_id, code, name, name_ar, description, is_system) values
  ('00000000-0000-4000-8000-0000000000a1', null, 'MANAGING_PARTNER', 'Managing Partner', 'الشريك الإداري',
   'Highest normal business authority (§9). Cannot bypass technical controls or edit audit history.', true),
  ('00000000-0000-4000-8000-0000000000a2', null, 'PARTNER', 'Partner', 'شريك',
   'Partner authority, scoped by department, practice group and financial ceiling (§10).', true),
  ('00000000-0000-4000-8000-0000000000a3', null, 'LAWYER', 'Lawyer', 'محامٍ',
   'Operational access through assigned matters (§11).', true),
  ('00000000-0000-4000-8000-0000000000a4', null, 'ASSOCIATE', 'Associate', 'محامٍ مشارك',
   'Prepares work; controlled actions need approval (§12).', true),
  ('00000000-0000-4000-8000-0000000000a5', null, 'PARALEGAL', 'Paralegal', 'مساعد قانوني',
   'Matter preparation and operations; no administration or financial state (§13).', true),
  ('00000000-0000-4000-8000-0000000000a6', null, 'FINANCE', 'Finance', 'المالية',
   'Financial operating layer; no legal strategy or conflict material (§14).', true),
  ('00000000-0000-4000-8000-0000000000a7', null, 'COMPLIANCE', 'Compliance', 'الامتثال',
   'Compliance workspace with restricted-by-design access (§15).', true),
  ('00000000-0000-4000-8000-0000000000a8', null, 'ADMIN', 'Administration', 'الإدارة',
   'Operating environment; no financial approval or compliance decisions (§16).', true),
  ('00000000-0000-4000-8000-0000000000a9', null, 'OPERATIONS', 'Operations', 'العمليات',
   'Cross-cutting operational support.', true)
on conflict (tenant_id, code) do nothing;

-- Role -> permission mapping for the templates. Kept explicit rather than
-- derived, so reading this file answers "what can a PARALEGAL do?" without
-- running anything. §13's restrictions are visible as absent rows.
with template(id, code) as (values
  ('00000000-0000-4000-8000-0000000000a1'::uuid,'MANAGING_PARTNER'),
  ('00000000-0000-4000-8000-0000000000a2','PARTNER'),
  ('00000000-0000-4000-8000-0000000000a3','LAWYER'),
  ('00000000-0000-4000-8000-0000000000a4','ASSOCIATE'),
  ('00000000-0000-4000-8000-0000000000a5','PARALEGAL'),
  ('00000000-0000-4000-8000-0000000000a6','FINANCE'),
  ('00000000-0000-4000-8000-0000000000a7','COMPLIANCE'),
  ('00000000-0000-4000-8000-0000000000a8','ADMIN'),
  ('00000000-0000-4000-8000-0000000000a9','OPERATIONS')
), grants(code, perm) as (values
  -- MANAGING_PARTNER: everything except audit mutation, which nobody holds.
  ('MANAGING_PARTNER','clients.read'),('MANAGING_PARTNER','clients.create'),
  ('MANAGING_PARTNER','clients.update'),('MANAGING_PARTNER','clients.archive'),
  ('MANAGING_PARTNER','clients.read_sensitive'),('MANAGING_PARTNER','clients.kyc'),
  ('MANAGING_PARTNER','matters.read'),('MANAGING_PARTNER','matters.read_all'),
  ('MANAGING_PARTNER','matters.create'),('MANAGING_PARTNER','matters.update'),
  ('MANAGING_PARTNER','matters.assign'),('MANAGING_PARTNER','matters.restrict'),
  ('MANAGING_PARTNER','matters.close'),('MANAGING_PARTNER','matters.reopen'),
  ('MANAGING_PARTNER','matters.status'),
  ('MANAGING_PARTNER','documents.read'),('MANAGING_PARTNER','documents.create'),
  ('MANAGING_PARTNER','documents.edit'),('MANAGING_PARTNER','documents.delete'),
  ('MANAGING_PARTNER','documents.approve'),('MANAGING_PARTNER','documents.release'),
  ('MANAGING_PARTNER','documents.templates'),
  ('MANAGING_PARTNER','tasks.read'),('MANAGING_PARTNER','tasks.manage'),
  ('MANAGING_PARTNER','hearings.read'),('MANAGING_PARTNER','hearings.manage'),
  ('MANAGING_PARTNER','deadlines.read'),('MANAGING_PARTNER','deadlines.manage'),
  ('MANAGING_PARTNER','contracts.read'),('MANAGING_PARTNER','contracts.manage'),
  ('MANAGING_PARTNER','poa.read'),('MANAGING_PARTNER','poa.manage'),
  ('MANAGING_PARTNER','billing.read'),('MANAGING_PARTNER','billing.read_all'),
  ('MANAGING_PARTNER','billing.create'),('MANAGING_PARTNER','billing.edit'),
  ('MANAGING_PARTNER','billing.approve'),('MANAGING_PARTNER','billing.send'),
  ('MANAGING_PARTNER','billing.record_payment'),('MANAGING_PARTNER','billing.writeoff'),
  ('MANAGING_PARTNER','billing.discount'),
  ('MANAGING_PARTNER','time.read'),('MANAGING_PARTNER','time.create'),('MANAGING_PARTNER','time.adjust'),
  ('MANAGING_PARTNER','expenses.read'),('MANAGING_PARTNER','expenses.create'),('MANAGING_PARTNER','expenses.approve'),
  ('MANAGING_PARTNER','compliance.read'),('MANAGING_PARTNER','compliance.create'),
  ('MANAGING_PARTNER','compliance.review'),('MANAGING_PARTNER','compliance.approve'),
  ('MANAGING_PARTNER','compliance.licences'),('MANAGING_PARTNER','compliance.training'),
  ('MANAGING_PARTNER','compliance.complaints'),
  ('MANAGING_PARTNER','users.read'),('MANAGING_PARTNER','users.invite'),('MANAGING_PARTNER','users.update'),
  ('MANAGING_PARTNER','users.deactivate'),('MANAGING_PARTNER','users.assign_role'),
  ('MANAGING_PARTNER','users.assign_matter'),('MANAGING_PARTNER','users.revoke_session'),
  ('MANAGING_PARTNER','roles.read'),('MANAGING_PARTNER','roles.manage'),
  ('MANAGING_PARTNER','departments.manage'),
  ('MANAGING_PARTNER','settings.read'),('MANAGING_PARTNER','settings.manage'),
  ('MANAGING_PARTNER','audit.read'),('MANAGING_PARTNER','audit.export'),
  ('MANAGING_PARTNER','analytics.read'),
  -- PARTNER: like Managing Partner minus firm configuration and role design.
  ('PARTNER','clients.read'),('PARTNER','clients.create'),('PARTNER','clients.update'),
  ('PARTNER','clients.read_sensitive'),('PARTNER','clients.kyc'),
  ('PARTNER','matters.read'),('PARTNER','matters.create'),('PARTNER','matters.update'),
  ('PARTNER','matters.assign'),('PARTNER','matters.restrict'),('PARTNER','matters.close'),
  ('PARTNER','matters.reopen'),('PARTNER','matters.status'),
  ('PARTNER','documents.read'),('PARTNER','documents.create'),('PARTNER','documents.edit'),
  ('PARTNER','documents.approve'),('PARTNER','documents.release'),('PARTNER','documents.templates'),
  ('PARTNER','tasks.read'),('PARTNER','tasks.manage'),
  ('PARTNER','hearings.read'),('PARTNER','hearings.manage'),
  ('PARTNER','deadlines.read'),('PARTNER','deadlines.manage'),
  ('PARTNER','contracts.read'),('PARTNER','contracts.manage'),
  ('PARTNER','poa.read'),('PARTNER','poa.manage'),
  ('PARTNER','billing.read'),('PARTNER','billing.create'),('PARTNER','billing.edit'),
  ('PARTNER','billing.approve'),('PARTNER','billing.send'),('PARTNER','billing.record_payment'),
  ('PARTNER','billing.discount'),
  ('PARTNER','time.read'),('PARTNER','time.create'),('PARTNER','time.adjust'),
  ('PARTNER','expenses.read'),('PARTNER','expenses.create'),('PARTNER','expenses.approve'),
  ('PARTNER','compliance.read'),('PARTNER','compliance.review'),
  ('PARTNER','users.read'),('PARTNER','users.assign_matter'),
  ('PARTNER','roles.read'),('PARTNER','settings.read'),('PARTNER','analytics.read'),
  -- LAWYER: operational, through assigned matters (§11).
  ('LAWYER','clients.read'),('LAWYER','matters.read'),('LAWYER','matters.update'),('LAWYER','matters.status'),
  ('LAWYER','documents.read'),('LAWYER','documents.create'),('LAWYER','documents.edit'),
  ('LAWYER','tasks.read'),('LAWYER','tasks.manage'),
  ('LAWYER','hearings.read'),('LAWYER','hearings.manage'),
  ('LAWYER','deadlines.read'),('LAWYER','deadlines.manage'),
  ('LAWYER','contracts.read'),('LAWYER','poa.read'),
  ('LAWYER','time.read'),('LAWYER','time.create'),
  ('LAWYER','expenses.read'),('LAWYER','expenses.create'),
  -- ASSOCIATE: LAWYER minus contract authority and matter status (§12).
  ('ASSOCIATE','clients.read'),('ASSOCIATE','matters.read'),('ASSOCIATE','matters.update'),
  ('ASSOCIATE','documents.read'),('ASSOCIATE','documents.create'),('ASSOCIATE','documents.edit'),
  ('ASSOCIATE','tasks.read'),('ASSOCIATE','tasks.manage'),
  ('ASSOCIATE','hearings.read'),('ASSOCIATE','deadlines.read'),('ASSOCIATE','deadlines.manage'),
  ('ASSOCIATE','contracts.read'),('ASSOCIATE','time.read'),('ASSOCIATE','time.create'),
  ('ASSOCIATE','expenses.read'),('ASSOCIATE','expenses.create'),
  -- PARALEGAL (§13). No users.*, no billing approval, no compliance override.
  ('PARALEGAL','clients.read'),('PARALEGAL','clients.create'),
  ('PARALEGAL','matters.read'),('PARALEGAL','matters.update'),
  ('PARALEGAL','documents.read'),('PARALEGAL','documents.create'),('PARALEGAL','documents.edit'),
  ('PARALEGAL','tasks.read'),('PARALEGAL','tasks.manage'),
  ('PARALEGAL','hearings.read'),('PARALEGAL','hearings.manage'),
  ('PARALEGAL','deadlines.read'),('PARALEGAL','deadlines.manage'),
  ('PARALEGAL','poa.read'),('PARALEGAL','time.read'),('PARALEGAL','time.create'),
  ('PARALEGAL','expenses.read'),('PARALEGAL','expenses.create'),
  -- FINANCE (§14). Explicitly NO clients.read_sensitive, NO compliance.*,
  -- NO matters.update, and no route to internal legal notes.
  ('FINANCE','billing.read'),('FINANCE','billing.read_all'),('FINANCE','billing.create'),
  ('FINANCE','billing.edit'),('FINANCE','billing.send'),('FINANCE','billing.record_payment'),
  ('FINANCE','billing.discount'),
  ('FINANCE','time.read'),('FINANCE','time.adjust'),
  ('FINANCE','expenses.read'),('FINANCE','expenses.approve'),
  ('FINANCE','clients.read'),('FINANCE','matters.read'),
  -- matters.read_all is what lets Finance bill across the firm without being
  -- added to every matter team. It widens VISIBILITY to the weakest level
  -- ('view'); it does not confer edit, and it never opens a restricted matter.
  ('FINANCE','matters.read_all'),
  ('FINANCE','analytics.read'),
  -- COMPLIANCE (§15). Restricted material yes; firm financials no.
  ('COMPLIANCE','clients.read'),('COMPLIANCE','clients.read_sensitive'),('COMPLIANCE','clients.kyc'),
  ('COMPLIANCE','matters.read'),('COMPLIANCE','compliance.read'),('COMPLIANCE','compliance.create'),
  ('COMPLIANCE','compliance.review'),('COMPLIANCE','compliance.approve'),
  ('COMPLIANCE','compliance.licences'),('COMPLIANCE','compliance.training'),
  ('COMPLIANCE','compliance.complaints'),
  ('COMPLIANCE','documents.read'),('COMPLIANCE','poa.read'),
  ('COMPLIANCE','audit.read'),
  -- ADMIN (§16). No billing approval, no compliance decision, no audit deletion.
  ('ADMIN','users.read'),('ADMIN','users.invite'),('ADMIN','users.update'),
  ('ADMIN','users.deactivate'),('ADMIN','users.assign_role'),('ADMIN','users.assign_matter'),
  ('ADMIN','users.revoke_session'),
  ('ADMIN','roles.read'),('ADMIN','departments.manage'),
  ('ADMIN','settings.read'),('ADMIN','settings.manage'),
  ('ADMIN','clients.read'),('ADMIN','matters.read'),
  ('ADMIN','tasks.read'),('ADMIN','hearings.read'),('ADMIN','deadlines.read'),
  -- OPERATIONS: cross-cutting read plus scheduling.
  ('OPERATIONS','tasks.read'),('OPERATIONS','tasks.manage'),
  ('OPERATIONS','hearings.read'),('OPERATIONS','hearings.manage'),
  ('OPERATIONS','deadlines.read'),('OPERATIONS','deadlines.manage'),
  ('OPERATIONS','clients.read'),('OPERATIONS','matters.read'),
  ('OPERATIONS','documents.read'),('OPERATIONS','analytics.read')
)
insert into public.role_permissions (role_id, permission_code)
select t.id, g.perm
from grants g join template t on t.code = g.code
join public.permissions p on p.code = g.perm
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- 14 · POST-MIGRATION INVARIANTS
-- ----------------------------------------------------------------------------
-- These run at migration time. If one fails, the migration fails, which is the
-- intended behaviour: a half-applied authorization graph is worse than none.
do $$
declare n int;
begin
  -- A floor, not an exact count: adding a permission must not require editing
  -- this block. The exact catalogue (and the template grants) is pinned by the
  -- TypeScript side, which parses this very file — see
  -- server/src/domain/parse-firm-catalogue.ts and tests/security/firm-rbac.test.ts.
  -- 69 is the count as written when this migration was authored.
  select count(*) into n from public.permissions;
  if n < 69 then
    raise exception 'permission catalogue incomplete: % rows', n;
  end if;

  select count(*) into n from public.roles where is_system and tenant_id is null;
  if n <> 9 then
    raise exception 'expected 9 system role templates, found %', n;
  end if;

  -- §13: a PARALEGAL must hold no administration or billing-approval permission.
  if exists (
    select 1 from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
    where r.code = 'PARALEGAL'
      and (rp.permission_code like 'users.%'
        or rp.permission_code like 'roles.%'
        or rp.permission_code in ('billing.approve','billing.writeoff','billing.record_payment',
                                  'compliance.approve','audit.read','audit.export','settings.manage'))
  ) then
    raise exception 'PARALEGAL holds a forbidden permission (§13)';
  end if;

  -- §14: FINANCE must not hold compliance authority or unmasked identifiers.
  if exists (
    select 1 from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
    where r.code = 'FINANCE'
      and (rp.permission_code like 'compliance.%'
        or rp.permission_code in ('clients.read_sensitive','matters.restrict','audit.export'))
  ) then
    raise exception 'FINANCE holds a forbidden permission (§14)';
  end if;

  -- §16: ADMIN must not hold financial approval or compliance decisions.
  if exists (
    select 1 from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
    where r.code = 'ADMIN'
      and rp.permission_code in ('billing.approve','billing.writeoff','billing.record_payment',
                                 'compliance.approve','compliance.review')
  ) then
    raise exception 'ADMIN holds a forbidden permission (§16)';
  end if;

  -- §9: nobody may hold a permission that mutates audit history. No such code
  -- exists in the catalogue; this asserts that stays true.
  if exists (select 1 from public.permissions
             where code like 'audit.delete%' or code like 'audit.update%') then
    raise exception 'audit mutation permission exists (§51 forbids it)';
  end if;
end $$;
