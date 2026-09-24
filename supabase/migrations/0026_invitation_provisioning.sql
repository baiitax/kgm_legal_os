-- ============================================================================
-- KGM LEGAL OS · 0026 — THE INVITATION FRONT DOOR
-- ============================================================================
-- This portal is invitation-only. Accepting an invitation is therefore THE way
-- an account comes into existence, and it did not work on the real database:
--
--     POST /api/auth/invite/accept -> 500 internal_error
--
-- Two independent faults, on the same request, in sequence:
--
--   1 · the application wrote `mfa_enabled` as 0. SQLite stores booleans as
--       integers and accepts that; Postgres refuses it outright:
--
--         column "mfa_enabled" is of type boolean but expression is of type integer
--
--       Fixed in `repo.ts` (the literal FALSE, which is what the repository's SQL
--       conventions already required). It went unnoticed because every other flow
--       READS a user — accepting an invitation is the only path that CREATES one.
--
--   2 · THIS FILE — linking the authorization row failed, and would have failed
--       even with (1) fixed. `client_users` carried:
--
--         client_users_auth_phase  [ALL]  USING (phase = 'auth')  WITH CHECK false
--
--       which is correct for reads and impossible for writes: the accept flow has
--       no session yet, so it runs in the auth phase, and its INSERT of the
--       `client_users` row was refused by a WITH CHECK of `false`. This is the
--       `for all` shape 0017–0021 removed everywhere else; it survived here
--       because the read half was doing something real (see below), which made
--       the policy look intentional.
--
-- WHY THE READ HALF MUST SURVIVE
--   The accept flow reads `getClientUsersForUser(userId)` BEFORE inserting, to
--   decide whether the user is already linked to this client. So the phase='auth'
--   read is load-bearing, and the fix is to SPLIT the policy rather than drop it:
--   a read policy that keeps the old USING, and an insert policy with a real
--   bound. Exactly the pattern of 0017/0018, arrived at from the other direction.
--
-- THE BOUND ON THE INSERT
--   The row must be provisioned FROM an open invitation that matches it:
--   same tenant and client, the invited email is the new account's email, the
--   role is the invited role, the invitation is neither accepted, revoked nor
--   expired. So an auth-phase caller cannot invent a client link — it can only
--   realise an invitation that already exists. That is what makes the phase
--   acceptable here at all: the authorization row is copied from a record the
--   firm created, never from the request.
--
--   Note the ORDER the application relies on: `markInvitationAccepted` runs AFTER
--   the link is written, so `accepted_at is null` holds at insert time. Pinning it
--   is what stops a replayed token from provisioning a second account.
-- ============================================================================

drop policy if exists client_users_auth_phase on public.client_users;

-- The read half: authenticated-adjacent lookups during session and invitation
-- resolution, before a principal exists.
create policy client_users_auth_read on public.client_users
  for select to portal_api
  using (public.kgm_phase() = 'auth');

-- The write half: provisioning a client user from an invitation.
create policy client_users_invite_insert on public.client_users
  for insert to portal_api
  with check (
    public.kgm_phase() = 'auth'
    and status = 'active'
    and exists (
      select 1
        from public.client_invitations i
        join public.users u on u.id = client_users.user_id
       where i.tenant_id  = client_users.tenant_id
         and i.client_id  = client_users.client_id
         and i.email      = u.email
         and i.portal_role = client_users.portal_role
         and i.accepted_at is null
         and i.revoked_at is null
         and i.expires_at > now()
    )
  );

-- ============================================================================
-- VERIFY — the accept path can write, the read path survives, and nothing can
-- provision a client link without an open invitation behind it.
-- ============================================================================
do $$
declare
  problems text[] := '{}';
begin
  -- 1 · an INSERT policy exists and is not vacuous
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'client_users'
       and cmd = 'INSERT' and coalesce(with_check, 'true') <> 'false'
  ) then
    problems := problems || 'no policy admits INSERT into client_users';
  end if;

  -- 2 · the auth-phase read survives (the accept flow reads before it writes)
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'client_users'
       and cmd = 'SELECT' and qual like '%auth%'
  ) then
    problems := problems || 'the auth-phase read on client_users was lost';
  end if;

  -- 3 · the insert is bounded by an open invitation
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'client_users'
       and cmd = 'INSERT'
       and with_check like '%client_invitations%'
       and with_check like '%accepted_at%'
  ) then
    problems := problems || 'the client_users INSERT is not bounded by an open invitation';
  end if;

  -- 4 · no ALL/UPDATE/DELETE policy is left whose CHECK can never hold
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'client_users'
       and cmd in ('ALL', 'UPDATE', 'DELETE')
       and coalesce(with_check, 'true') = 'false'
  ) then
    problems := problems || 'a client_users policy still refuses every write';
  end if;

  if array_length(problems, 1) > 0 then
    raise exception E'invitation provisioning is still incomplete:\n  %',
      array_to_string(problems, E'\n  ');
  end if;

  raise notice 'the invitation path can provision: READ survives, INSERT is bounded by an open invitation.';
end $$;
