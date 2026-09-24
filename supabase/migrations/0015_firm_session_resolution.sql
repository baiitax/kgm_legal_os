-- 0015 — FIRM SESSION RESOLUTION IN THE AUTH PHASE
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
-- Firm sign-in succeeded (0013, 0014), and the first authenticated page failed:
--
--     GET /api/firm/matters -> 500
--     FirmSessionManager.resolve -> getFirmSessionByTokenHash
--       -> permission denied for table firm_sessions
--
-- `attachFirmPrincipal` resolves the session cookie BEFORE it can know which
-- tenant or membership the request belongs to — so it runs in the 'auth' phase,
-- on the `portal_api` connection, and `firm_sessions` is granted to `firm_api`.
--
-- This is the third instance of one shape, and the shape is worth naming: the
-- server has TWO bootstrap reads that necessarily happen before any identity is
-- known — the firm login (`firm_memberships`, 0011) and the firm session
-- (`firm_sessions`, here). Both were invisible while `portal_api` inherited
-- `firm_api`'s privileges, and both surfaced only after 0008 made the roles real.
--
-- ============================================================================
-- THE JUSTIFICATION, AND IT IS THE STRONGEST ONE IN THE SCHEMA
-- ============================================================================
-- 0004 expresses the rule for the client portal:
--
--   "The capability that makes an auth-phase read safe is the opaque token
--    itself: a session token ... is a 256-bit secret, so 'read the row this token
--    points at' is not an enumeration surface."
--
-- Firm sessions are the same construction: `token_hash = sha256(cookie value)`, a
-- 256-bit secret the caller must already possess. That is a stronger basis than
-- the login path's (0011), which accepts an email and password rather than a
-- token — and 0011 is the weaker of the two and is documented as such.
--
-- The columns granted are the session's own bookkeeping. `token_hash` is NOT
-- among them: the resolution query filters on it, and filtering requires SELECT,
-- so it is granted — but it is the HASH, not the token, and a hash that has been
-- granted read access to a caller who already holds the token adds nothing.
--
-- ============================================================================
-- WHY DELETE IS INCLUDED
-- ============================================================================
-- `FirmSessionManager.resolve` calls `revokeFirmSession(...)` when it finds an
-- expired session, and the hourly GC purges dead sessions. A resolution that
-- cannot retire an expired row leaves it to be re-read and re-rejected on every
-- subsequent request. This mirrors 0004's `grant delete on public.client_sessions
-- to portal_api; -- expired-session GC`.

-- ---------------------------------------------------------------------------
-- 1 · The resolution read, the touch/revoke write, and the GC delete.
-- ---------------------------------------------------------------------------
grant select (id, membership_id, user_id, tenant_id, token_hash, created_at, last_activity,
              expires_at, idle_expires_at, ip_hash, ip_country, user_agent, device_label,
              browser, os, mfa_verified_at, trusted_device_id, revoked_at, revoke_reason)
  on public.firm_sessions to portal_api;

grant update (last_activity, idle_expires_at, mfa_verified_at, revoked_at, revoke_reason)
  on public.firm_sessions to portal_api;

grant delete on public.firm_sessions to portal_api;   -- expired-session GC

/*
  An auth-phase policy, because the resolution happens before the caller is known.
  `with check (false)`: an unauthenticated request may READ a session row (it must,
  to resolve one) but may never create one. Session creation happens in
  `completeLogin`, by which point the phase is already 'firm' — see the
  context switch at the top of `FirmAuthService.login` — and runs as `firm_api`
  against `firm_api`'s own INSERT grant.
*/
drop policy if exists firm_sessions_auth_phase on public.firm_sessions;
create policy firm_sessions_auth_phase on public.firm_sessions to portal_api
  using (public.kgm_phase() = 'auth')
  with check (false);

comment on policy firm_sessions_auth_phase on public.firm_sessions is
  'Session resolution happens before the caller is known, so it cannot be '
  'user-scoped. Safe because the capability is the 256-bit token itself. Read '
  'only: session creation is firm-phase and runs as firm_api.';

-- ---------------------------------------------------------------------------
-- 2 · Assert the outcome, and assert the phase gate is real.
-- ---------------------------------------------------------------------------
do $$
declare
  missing text;
  in_portal bigint;
begin
  select string_agg(c, ', ') into missing
    from unnest(array['membership_id', 'user_id', 'tenant_id', 'expires_at',
                      'idle_expires_at', 'revoked_at']) c
   where not has_column_privilege('portal_api', 'public.firm_sessions', c, 'SELECT');
  if missing is not null then
    raise exception 'portal_api cannot read firm_sessions.% — session resolution returns 500.', missing;
  end if;

  if not has_column_privilege('portal_api', 'public.firm_sessions', 'last_activity', 'UPDATE') then
    raise exception 'portal_api cannot UPDATE firm_sessions.last_activity — the idle timeout cannot advance.';
  end if;

  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'firm_sessions'
                    and policyname = 'firm_sessions_auth_phase') then
    raise exception 'firm_sessions_auth_phase is missing — RLS fails closed and every firm page returns 401.';
  end if;

  if not has_column_privilege('firm_api', 'public.firm_sessions', 'token_hash', 'SELECT') then
    raise exception 'firm_api lost firm_sessions access — firm pages will fail.';
  end if;

  raise notice 'firm session resolution works in the auth phase; creation stays firm-phase only.';
end $$;
