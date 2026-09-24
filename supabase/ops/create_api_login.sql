-- ============================================================================
-- KGM LEGAL OS · API LOGIN BOOTSTRAP
-- ============================================================================
-- Creates the login identity the API server authenticates as.
--
-- Run ONCE per Supabase project, as the project owner, against the DIRECT
-- (non-pooler) connection:
--
--   psql "postgresql://postgres.sdpezbxwedvxqelpslfv@aws-0-us-east-1.pooler.supabase.com:5432/postgres" \
--        -v pw="$KGM_DB_PASSWORD" -f supabase/ops/create_api_login.sql
--
-- The password is passed as a psql VARIABLE and never written into this file, so
-- no credential enters git. This repository is public.
--
-- ----------------------------------------------------------------------------
-- WHY THE APP CANNOT JUST CONNECT AS `portal_api` TODAY
-- ----------------------------------------------------------------------------
-- Migration 0004 creates `portal_api` with NOLOGIN (`create role portal_api
-- nologin;`), which is correct as a privilege container but means it cannot
-- authenticate on its own. Something has to give it a login.
--
-- Two ways to bridge that:
--
--   (a) ALTER ROLE portal_api LOGIN PASSWORD '...'      <-- used below
--   (b) CREATE ROLE some_login LOGIN; GRANT portal_api TO some_login;
--
-- (a) is chosen deliberately. Under (b) the connection authenticates as
-- `some_login` and reaches the policies only through membership. `set_config`
-- and the RLS helper functions key off session state rather than role identity,
-- so (b) would probably work — but "probably" is the wrong standard for the
-- layer that decides which tenants a query can see. Under (a) `current_user` IS
-- `portal_api`, the policies declared `TO portal_api` match exactly, and the
-- column-level GRANTs apply directly instead of by inheritance.
--
-- ----------------------------------------------------------------------------
-- WHY THE ROLE MUST NOT BE A SUPERUSER (enforced at boot, not just here)
-- ----------------------------------------------------------------------------
-- Supabase's default connection string authenticates as `postgres`, a SUPERUSER.
-- Superusers bypass Row Level Security entirely, and no SQL can change that. A
-- server pointed at that string starts cleanly, serves every request
-- successfully, and has silently lost its entire database-level defence — the
-- 64 tables with RLS enabled would have policies that are present, correct and
-- inert.
--
-- `server/src/db/role-guard.ts` therefore refuses to boot unless the connected
-- role is a non-superuser, non-BYPASSRLS, non-owner. This file sets up a role
-- that passes; that check is what keeps it that way.
-- ============================================================================

\set ON_ERROR_STOP on

-- Refuse to run without a password. Without this, an unset :pw expands to an
-- EMPTY string and the install reports success while setting portal_api's
-- password to nothing — a live login with a blank credential.
\if :{?pw}
\else
  \echo 'ERROR: no password supplied. Pass it as a psql variable: -v pw="$KGM_DB_PASSWORD"'
  \quit
\endif

-- ---------------------------------------------------------------------------
-- 1 · Give portal_api the ability to authenticate.
-- ---------------------------------------------------------------------------
-- The password arrives as :'pw'. If the variable is unset, psql fails loudly
-- rather than setting the password to the literal string ":pw".
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'portal_api') then
    raise exception
      'portal_api does not exist. Run supabase/migrations/0004_rls_and_grants.sql first.';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'firm_api') then
    raise exception
      'firm_api does not exist. Run supabase/migrations/0006_firm_rbac.sql first.';
  end if;
end $$;

alter role portal_api with login password :'pw';

-- Defence in depth: assert the attributes explicitly rather than relying on
-- CREATE ROLE defaults. These three are exactly what role-guard.ts checks, so
-- the database and the boot check agree on what "safe" means.
alter role portal_api nosuperuser nobypassrls nocreatedb nocreaterole;

-- ---------------------------------------------------------------------------
-- 2 · Assert the outcome instead of assuming it.
-- ---------------------------------------------------------------------------
-- A silent failure here would surface much later as a confusing permissions bug,
-- so the install verifies its own result and aborts if the role is not safe.
do $$
declare
  r record;
  owned integer;
begin
  select rolsuper, rolbypassrls, rolcanlogin into r
    from pg_roles where rolname = 'portal_api';

  if r.rolsuper then
    raise exception 'portal_api is a SUPERUSER — RLS would be bypassed.';
  end if;
  if r.rolbypassrls then
    raise exception 'portal_api has BYPASSRLS — RLS would be inert.';
  end if;
  if not r.rolcanlogin then
    raise exception 'portal_api cannot log in — the password was not applied.';
  end if;

  select count(*) into owned
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and pg_get_userbyid(c.relowner) = 'portal_api';

  if owned > 0 then
    raise exception
      'portal_api owns % table(s); RLS does not apply to a table owner and no '
      'migration here applies FORCE ROW LEVEL SECURITY.', owned;
  end if;

  raise notice 'portal_api verified: login enabled, not superuser, no BYPASSRLS, owns 0 tables.';
end $$;

-- ---------------------------------------------------------------------------
-- 3 · Report the connection string shape for the server's DATABASE_URL.
-- ---------------------------------------------------------------------------
-- Printed WITHOUT the password, so it is safe in a terminal that is being logged.
-- The host is not interpolated from the session: behind the pooler,
-- inet_server_addr() reports the pooler's own address and would produce a
-- misleading string. The host is printed as a placeholder for the operator to
-- substitute from the Supabase dashboard.
select format(
  'DATABASE_URL=postgresql://portal_api:%s@%s:5432/%s',
  '<<PASSWORD>>',
  '<<POOLER-OR-DB-HOST>>',
  current_database()
) as expected_shape;

-- ============================================================================
-- POOLING MODE IS NOT OPTIONAL
-- ============================================================================
-- Use the SESSION pooler on port 5432, or the direct connection on
-- db.<ref>.supabase.co:5432. NEVER the transaction pooler on port 6543.
--
-- The driver injects caller identity with:
--
--   select set_config('kgm.tenant_id', $1, false)
--
-- The third argument (is_local = false) makes the setting SESSION-scoped, and it
-- is cleared with RESET ALL only when the connection is released. Transaction
-- pooling multiplexes many clients over one backend session between
-- transactions, so a setting written for one caller can be observed by another
-- — a cross-tenant read that no amount of application-layer care prevents,
-- because the leak happens below the application.
--
-- This is the single highest-consequence setting in the deployment.
-- ============================================================================
