-- ============================================================================
-- KGM LEGAL OS — CLIENT PORTAL
-- Migration 0001 · Core identity, tenancy, invitation & session schema
-- Target: PostgreSQL 15+ / Supabase
--
-- DESIGN INVARIANTS (see README §Security Model)
--   I1  tenant_id / client_id / role are NEVER supplied by a client user.
--       They are resolved server-side from client_users, which is written only
--       by firm staff through the Internal Firm OS.
--   I2  Authentication credentials (users) are separated from the legal
--       relationship (clients) by the client_users join. One human may be a
--       contact for several clients; one client may have several contacts.
--   I3  No plaintext national identifiers are ever stored. Only a masked
--       display value and a keyed hash used for verification.
--   I4  Session tokens are stored hashed. A database leak does not yield
--       usable sessions.
--   I5  Public, unrestricted signup is impossible: a user row can only be
--       created by consuming a server-generated invitation.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ----------------------------------------------------------------------------
-- TENANCY
-- ----------------------------------------------------------------------------
create table if not exists public.tenants (
  id                uuid primary key default gen_random_uuid(),
  slug              citext not null unique,
  name              text   not null,
  name_ar           text   not null,
  country           text   not null default 'SA',
  default_language  text   not null default 'ar' check (default_language in ('ar','en')),
  default_calendar  text   not null default 'islamic-umalqura'
                    check (default_calendar in ('islamic-umalqura','gregory')),
  status            text   not null default 'active'
                    check (status in ('active','suspended','archived')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.tenants is
  'A law firm. The outermost authorization boundary. Every row in the system belongs to exactly one tenant.';

-- ----------------------------------------------------------------------------
-- CLIENTS  (the legal relationship, not a login)
-- ----------------------------------------------------------------------------
create table if not exists public.clients (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete restrict,
  client_type           text not null default 'individual'
                        check (client_type in ('individual','organization')),
  name                  text not null,
  name_ar               text,
  -- I3: masked value is safe to render. hash is used only to verify a value the
  -- holder already knows. The plaintext never touches this database.
  national_id_masked    text,
  national_id_hash      text,
  commercial_reg_masked text,
  email                 citext,
  phone                 text,
  address_line          text,
  city                  text,
  country               text not null default 'SA',
  identity_verified     boolean not null default false,
  verification_note     text,
  status                text not null default 'active'
                        check (status in ('active','inactive','restricted')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists clients_tenant_idx on public.clients(tenant_id);
create unique index if not exists clients_tenant_nid_hash_uq
  on public.clients(tenant_id, national_id_hash)
  where national_id_hash is not null;

comment on table public.clients is
  'A firm''s client entity. Created only by firm staff. A client user reaches a client row exclusively through client_users.';

-- ----------------------------------------------------------------------------
-- USERS  (authentication principal)
-- ----------------------------------------------------------------------------
create table if not exists public.users (
  id                    uuid primary key default gen_random_uuid(),
  email                 citext not null unique,
  password_hash         text,                      -- null until invitation accepted
  password_updated_at   timestamptz,
  email_verified_at     timestamptz,
  status                text not null default 'invited'
                        check (status in ('invited','active','locked','disabled','deletion_requested')),
  -- Brute-force protection state (§6). Reset on successful login.
  failed_login_count    smallint not null default 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  last_login_ip_hash    text,
  -- MFA-ready architecture (§8). Secret stored encrypted by the application
  -- layer; the column is opaque to anything reading the database directly.
  mfa_enabled           boolean not null default false,
  mfa_method            text check (mfa_method in ('totp','email_otp','sms_otp','webauthn')),
  mfa_secret_enc        text,
  mfa_enabled_at        timestamptz,
  -- Preferences are the ONLY user-writable authorization-adjacent columns.
  preferred_language    text not null default 'ar' check (preferred_language in ('ar','en')),
  preferred_calendar    text not null default 'islamic-umalqura'
                        check (preferred_calendar in ('islamic-umalqura','gregory')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.users is
  'Authentication principal only. Contains NO tenant_id, NO role, NO permissions. Those live in client_users and are resolved server-side.';

-- ----------------------------------------------------------------------------
-- CLIENT_USERS  (the authorization join — the heart of the security model)
-- ----------------------------------------------------------------------------
create table if not exists public.client_users (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id)   on delete cascade,
  client_id         uuid not null references public.clients(id) on delete restrict,
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  display_name      text not null,
  display_name_ar   text,
  job_title         text,
  phone             text,
  -- Portal scope. This is a *display/behavioural* scope, never an elevation to
  -- firm-internal access. There is deliberately no 'admin' value here.
  portal_role       text not null default 'client_contact'
                    check (portal_role in ('client_primary','client_contact')),
  status            text not null default 'active'
                    check (status in ('active','suspended','removed')),
  created_by_staff  uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, client_id)
);

create index if not exists client_users_user_idx   on public.client_users(user_id);
create index if not exists client_users_client_idx on public.client_users(client_id);
create index if not exists client_users_tenant_idx on public.client_users(tenant_id);

comment on table public.client_users is
  'Sole source of portal authorization. Written only by firm staff via the Internal Firm OS. A client user may read/modify NOTHING outside the client_ids present here.';

-- Integrity: tenant_id must agree with the client's tenant. Prevents a
-- mis-keyed join from silently crossing the tenancy boundary.
create or replace function public.assert_client_user_tenant()
returns trigger language plpgsql as $$
begin
  if (select tenant_id from public.clients where id = new.client_id) <> new.tenant_id then
    raise exception 'client_users.tenant_id must match clients.tenant_id';
  end if;
  return new;
end $$;

drop trigger if exists client_users_tenant_guard on public.client_users;
create trigger client_users_tenant_guard
  before insert or update of client_id, tenant_id on public.client_users
  for each row execute function public.assert_client_user_tenant();

-- ----------------------------------------------------------------------------
-- INVITATIONS  (§3 — the only route into an account)
-- ----------------------------------------------------------------------------
create table if not exists public.client_invitations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  client_id         uuid not null references public.clients(id) on delete restrict,
  email             citext not null,
  display_name      text not null,
  display_name_ar   text,
  portal_role       text not null default 'client_contact'
                    check (portal_role in ('client_primary','client_contact')),
  -- Only the hash is stored. The raw token appears once, in the invite link.
  token_hash        text not null unique,
  token_hint        text not null,                 -- last 6 chars, for support
  expires_at        timestamptz not null,
  accepted_at       timestamptz,
  revoked_at        timestamptz,
  created_by_staff  uuid,
  accept_ip_hash    text,
  created_at        timestamptz not null default now()
);

create index if not exists invitations_email_idx on public.client_invitations(email);

comment on table public.client_invitations is
  'Server-generated, single-use, expiring. tenant_id/client_id/portal_role are fixed at creation by staff and cannot be altered by the recipient.';

-- A client can never re-target their own invitation.
alter table public.client_invitations enable row level security;

create or replace function public.guard_invitation_immutability()
returns trigger language plpgsql as $$
begin
  -- Only expiry/revocation/acceptance bookkeeping may change.
  if new.tenant_id      <> old.tenant_id
  or new.client_id      <> old.client_id
  or new.email          <> old.email
  or new.portal_role    <> old.portal_role
  or new.token_hash     <> old.token_hash
  or new.created_by_staff is distinct from old.created_by_staff then
    raise exception 'invitation binding is immutable';
  end if;
  return new;
end $$;

drop trigger if exists invitation_immutability on public.client_invitations;
create trigger invitation_immutability
  before update on public.client_invitations
  for each row execute function public.guard_invitation_immutability();

-- ----------------------------------------------------------------------------
-- SESSIONS & DEVICES  (§7, §26)
-- ----------------------------------------------------------------------------
create table if not exists public.client_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  -- The tenant/client a session was minted for. Frozen at login; a session can
  -- never be re-pointed at another tenancy.
  tenant_id         uuid,
  client_id         uuid,
  token_hash        text not null unique,
  created_at        timestamptz not null default now(),
  last_activity     timestamptz not null default now(),
  expires_at        timestamptz not null,
  idle_expires_at   timestamptz not null,
  ip_hash           text,
  ip_country        text,
  user_agent        text,
  device_label      text,
  browser           text,
  os                text,
  mfa_verified_at   timestamptz,
  trusted_device_id uuid,
  revoked_at        timestamptz,
  revoke_reason     text check (revoke_reason in
                    ('logout','password_changed','admin','idle','absolute','suspicious','all_others'))
);

create index if not exists sessions_user_idx    on public.client_sessions(user_id);
create index if not exists sessions_expires_idx on public.client_sessions(expires_at);

comment on table public.client_sessions is
  'Opaque, hashed, revocable, dual-expiry (absolute + idle). Sensitive fields (token, full IP) are never sent to the browser.';

create table if not exists public.client_devices (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  fingerprint_hash  text not null,
  label             text,
  -- §8: device trust is time-boxed and revocable, never permanent.
  trusted_until     timestamptz,
  mfa_trusted       boolean not null default false,
  last_seen_at      timestamptz not null default now(),
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  unique (user_id, fingerprint_hash)
);

create table if not exists public.login_attempts (
  id            bigint generated always as identity primary key,
  email         citext,
  user_id       uuid,
  ip_hash       text not null,
  user_agent    text,
  outcome       text not null check (outcome in
                ('success','bad_password','unknown_account','locked','mfa_required',
                 'mfa_failed','disabled','rate_limited','suspicious')),
  created_at    timestamptz not null default now()
);

create index if not exists login_attempts_ip_idx    on public.login_attempts(ip_hash, created_at desc);
create index if not exists login_attempts_email_idx on public.login_attempts(email, created_at desc);

comment on table public.login_attempts is
  'Feeds brute-force protection and suspicious-login detection (§6). Append-only.';

-- ----------------------------------------------------------------------------
-- TOKEN LIFECYCLE  (password reset, email verification)
-- ----------------------------------------------------------------------------
create table if not exists public.auth_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  kind          text not null check (kind in ('password_reset','email_verification','mfa_enroll','mfa_otp','mfa_challenge','magic_link')),
  token_hash    text not null unique,
  code_hash     text,                              -- for short OTPs
  expires_at    timestamptz not null,
  used_at       timestamptz,
  attempts      smallint not null default 0,       -- OTP guess budget
  created_ip_hash text,
  created_at    timestamptz not null default now()
);

create index if not exists auth_tokens_user_kind_idx on public.auth_tokens(user_id, kind, created_at desc);

create table if not exists public.mfa_recovery_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  code_hash   text not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (user_id, code_hash)
);

-- ----------------------------------------------------------------------------
-- SECURITY ALERTS  (§26)
-- ----------------------------------------------------------------------------
create table if not exists public.security_alerts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  tenant_id     uuid,
  kind          text not null check (kind in
                ('new_device_login','impossible_travel','brute_force_blocked',
                 'password_changed','mfa_enabled','mfa_disabled','session_revoked',
                 'account_locked','sensitive_export')),
  severity      text not null default 'info' check (severity in ('info','warning','critical')),
  message       text,
  message_ar    text,
  ip_hash       text,
  ip_country    text,
  user_agent    text,
  acknowledged_at timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists security_alerts_user_idx on public.security_alerts(user_id, created_at desc);
