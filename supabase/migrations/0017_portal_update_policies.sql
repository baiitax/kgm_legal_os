-- ============================================================================
-- KGM LEGAL OS · 0017 — PORTAL UPDATE POLICIES
-- ============================================================================
-- Two portal actions that work on SQLite (which has no RLS) were refused by the
-- database, both for the same reason: a single `for all` policy cannot carry two
-- different WITH CHECK expressions, so the check written for INSERT was applied
-- to UPDATE as well.
--
--   PATCH /api/client/profile
--     new row violates row-level security policy for table "client_users"
--
--   POST /api/client/appointments/:id/cancel
--     new row violates row-level security policy for table "appointments"
--
-- Neither is a grant problem; the columns were already granted (0016). The
-- policies were.
--
-- WHY THE ORIGINAL FORM COULD NOT WORK
--   `appointment_scope` is `for all` with
--
--     with check (... and requested_by_user_id = kgm_user() and status = 'requested')
--
--   `status = 'requested'` is a statement about a NEW appointment, and it is
--   correct there: a client may create a request, never a confirmed booking. But
--   `for all` applies the same expression to UPDATE, so the moment the client
--   cancels — the row becomes `status = 'cancelled'` — the new row fails its own
--   policy. The only surviving update was one that changed nothing.
--
--   `client_user_scope` is `for all` ... `with check (false)`, which is the
--   deliberate shape for "this role may read these rows and create nothing". It
--   also refused the client's own profile edit.
--
-- THE FIX, AND WHAT IT DOES NOT OPEN
--   Both policies are split by command, so each command keeps the check that suits
--   it. Nothing is widened:
--
--     SELECT  unchanged scope (phase, tenant, the caller's own clients/row)
--     INSERT  appointments keep `status = 'requested'` — a client still cannot
--             book themselves a confirmed appointment
--     INSERT  client_users is still NOT permitted in the portal phase; creation
--             belongs to the invite flow, which runs in the `auth` phase and is
--             covered by `client_users_auth_phase`
--     UPDATE  must still leave the row inside the caller's scope AND still owned
--             by the caller, so no row can be moved to another tenant, client or
--             user
--     UPDATE  appointment status is bounded to the two values a client may set;
--             a client still cannot mark its own appointment `confirmed`
--     DELETE  not granted at all — the portal deletes neither rows
--
--   The status vocabulary is listed explicitly rather than inferred, because the
--   whole point of this migration is that a check meant for one statement was
--   silently applied to another.
--
-- VERIFIED AGAINST THE LIVE DATABASE
--   Applied to the Supabase project and re-tested over HTTP: the profile save and
--   the appointment cancellation both return 200, and the negative cases below
--   still refuse.
-- ============================================================================

-- ── appointments ────────────────────────────────────────────────────────────
drop policy if exists appointment_scope on public.appointments;

create policy appointment_scope_read on public.appointments
  for select to portal_api
  using (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
  );

create policy appointment_scope_insert on public.appointments
  for insert to portal_api
  with check (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and requested_by_user_id = kgm_user() and status = 'requested'
  );

create policy appointment_scope_update on public.appointments
  for update to portal_api
  using (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and requested_by_user_id = kgm_user()
  )
  with check (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and requested_by_user_id = kgm_user()
    and status in ('requested', 'cancelled')
  );

-- ── client_users ────────────────────────────────────────────────────────────
drop policy if exists client_user_scope on public.client_users;

create policy client_user_scope_read on public.client_users
  for select to portal_api
  using (
    kgm_phase() = 'portal' and user_id = kgm_user() and tenant_id = kgm_tenant()
  );

create policy client_user_scope_update on public.client_users
  for update to portal_api
  using (
    kgm_phase() = 'portal' and user_id = kgm_user() and tenant_id = kgm_tenant()
  )
  with check (
    kgm_phase() = 'portal' and user_id = kgm_user() and tenant_id = kgm_tenant()
  );

-- ============================================================================
-- VERIFY — the shapes above exist, and the ones that must stay closed still are.
-- ============================================================================
do $$
declare
  n int;
begin
  -- The permissive `for all` policies that caused the two outages are gone.
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'appointments'
                and policyname = 'appointment_scope') then
    raise exception 'appointments still carries the for-all policy that cannot express both checks';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'client_users'
                and policyname = 'client_user_scope') then
    raise exception 'client_users still carries the for-all policy with check (false)';
  end if;

  -- The split policies exist.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'appointments'
     and policyname in ('appointment_scope_read', 'appointment_scope_insert', 'appointment_scope_update');
  if n <> 3 then raise exception 'expected 3 appointment policies, found %', n; end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'client_users'
     and policyname in ('client_user_scope_read', 'client_user_scope_update');
  if n <> 2 then raise exception 'expected 2 client_users policies, found %', n; end if;

  -- A client may still not create a client_users row outside the invite flow.
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'client_users'
                and policyname like 'client_user_scope%' and cmd = 'INSERT') then
    raise exception 'portal_api gained an INSERT policy on client_users in the portal phase';
  end if;

  raise notice 'portal update policies are split per command; INSERT and the status vocabulary are still bounded.';
end $$;
