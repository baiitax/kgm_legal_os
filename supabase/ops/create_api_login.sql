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

-- WHY THE ATTRIBUTES ARE NOT RE-ASSERTED HERE
--   `alter role portal_api nosuperuser nobypassrls` FAILS on Supabase:
--
--     permission denied to alter role
--     Only roles with the SUPERUSER attribute may alter roles with the SUPERUSER attribute.
--
--   Supabase's `supautils` extension restricts changing those attributes, and
--   the restriction fires even when the change would remove the privilege.
--   Verified: `create role x nologin` succeeds, `alter role x with login
--   password` succeeds, `alter role x nosuperuser nobypassrls` is refused.
--
--   It is not needed. Migration 0004 creates the role as `create role portal_api
--   nologin`, and CREATE ROLE defaults NOSUPERUSER, NOBYPASSRLS, NOCREATEDB and
--   NOCREATEROLE. The verification block below ASSERTS those facts against
--   pg_roles rather than re-applying them, so the install still fails loudly if
--   the real attributes are ever wrong — which is the property that matters.
--
-- ONE LOGIN, TWO AUDIENCES — REACHED BY SET ROLE, NEVER BY INHERITANCE
--   This deployment runs a single API process with a single connection pool, but
--   migration 0006 declares 34 policies `TO firm_api` while 0004 declares 100
--   `TO portal_api`. A connection that is one role only cannot satisfy the other's
--   policies, and RLS fails closed — the firm half of the product would return
--   nothing, with no error to explain it.
--
--   Granting firm_api TO portal_api closes that gap, and it is what this line
--   does. What it must NOT do is let the connection INHERIT firm_api's
--   privileges, and the first version of this file made exactly that mistake.
--
--   Inheritance is all-or-nothing and privileges are additive, so inheriting
--   from firm_api meant inheriting its TABLE-LEVEL SELECT on 22 tables — which
--   subsumes every column-level grant 0004 wrote. `portal_api` could read
--   `matters.risk_rating` and `matters.internal_notes`: the firm's internal
--   settlement strategy, readable inside a client's own portal request. §57 puts
--   field classification at the database layer so a mistaken query is not the
--   last line of defence, and it had stopped being one. Migration 0008 removes
--   the inheritance; this file must never put it back.
--
--   WITH INHERIT FALSE   -> the connection gains nothing by default, so its own
--                           column grants bound it. Verified: has_column_privilege
--                           on any internal column is false for portal_api.
--   WITH SET TRUE        -> the request path may still assume the role for the
--                           duration of a firm request, which is the only way the
--                           firm half can satisfy its own policies on one pool.
--                           server/src/db/postgres.ts issues `SET ROLE firm_api`
--                           when the resolved phase is 'firm', and `RESET ROLE` on
--                           every other path — including the release back to the
--                           pool, because RESET ALL does NOT reset the role and a
--                           connection returned holding firm_api would serve the
--                           next request — plausibly a portal request — with the
--                           firm role's reach.
--
--   Separation now rests on TWO independent mechanisms that agree with each
--   other: the ROLE (set by the server from the resolved session) and the PHASE
--   (`kgm_phase()`, likewise never taken from the request; `kgm_is_firm()`
--   requires phase = 'firm'). A portal request is the wrong role AND the wrong
--   phase, so neither mechanism alone is load-bearing.
grant firm_api to portal_api with inherit false, set true;

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

  -- The §57 floor. `GRANT ... WITH INHERIT FALSE` is not the default, so a rebuild
  -- that used a plain GRANT would produce a database that reads internal columns
  -- with no error anywhere — the failure this file now exists to prevent.
  --
  -- MEASURED, and the measurement corrects a natural assumption: re-issuing a
  -- PLAIN grant over an EXISTING membership does NOT restore inheritance, because
  -- PostgreSQL updates only the options named in the statement. Re-running this
  -- bootstrap against an already-correct database is therefore harmless. The
  -- danger is a FRESH membership created with a plain grant — a rebuilt project,
  -- or a role recreated by hand — and that case is what the assertions below
  -- catch: verified to fail with inherits=true, can_read_risk_rating=true.
  if pg_has_role('portal_api', 'firm_api', 'USAGE') then
    raise exception
      'portal_api INHERITS firm_api again. Inheritance is all-or-nothing, so '
      'firm_api''s table-level SELECT on 22 tables subsumes the portal''s '
      'column-level grants and the portal can read matters.risk_rating and '
      'matters.internal_notes. Re-grant WITH INHERIT FALSE, SET TRUE (see 0008).';
  end if;

  if not pg_has_role('portal_api', 'firm_api', 'SET') then
    raise exception
      'portal_api cannot SET ROLE into firm_api. Every firm-audience request would '
      'fail RLS closed and return empty result sets with no error to explain it.';
  end if;

  if has_column_privilege('portal_api', 'public.matters', 'risk_rating', 'SELECT') then
    raise exception
      'portal_api can read matters.risk_rating — the §57 field-level floor is not in place.';
  end if;

  raise notice
    'portal_api verified: login enabled, not superuser, no BYPASSRLS, owns 0 tables, '
    'inherits nothing, may SET ROLE into firm_api.';
end $$;

-- ---------------------------------------------------------------------------
-- 3 · Report the connection string shape for the server's DATABASE_URL.
-- ---------------------------------------------------------------------------
-- Printed WITHOUT the password, so it is safe in a terminal that is being logged.
-- The host is not interpolated from the session: behind the pooler,
-- inet_server_addr() reports the pooler's own address and would produce a
-- misleading string.
--
-- NOTE THE USERNAME. The Supabase pooler identifies the tenant by a suffix on
-- the username, so it is `portal_api.<project-ref>`, NOT `portal_api`:
--
--     postgresql://portal_api.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres
--
-- Connecting with a bare `portal_api` fails with
--   "no tenant identifier provided (external_id or sni_hostname required)".
select format(
  'DATABASE_URL=postgresql://portal_api.%s:%s@%s:5432/%s',
  '<<PROJECT-REF>>',
  '<<PASSWORD>>',
  '<<POOLER-HOST>>',
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
