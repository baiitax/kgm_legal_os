-- 0011 — THE FIRM LOGIN BOOTSTRAP, AND THE THREE TABLES firm_api WAS NEVER GIVEN
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
-- 0008 removed the privilege inheritance that let `portal_api` read firm tables
-- accidentally. Firm requests now `SET ROLE firm_api`, which is correct — and it
-- exposed two gaps that the inheritance had been papering over:
--
--   A · THE FIRM LOGIN HAS NO ROLE YET.
--       `FirmAuthService.login` resolves a membership BEFORE a session exists:
--
--           const memberships = await this.firm.listActiveMemberships(userId)
--
--       which joins `firm_memberships` to `tenants`. At that moment the request
--       phase is 'auth' — no session, so no membership, so `SET ROLE firm_api` is
--       deliberately NOT applied — and the connection is still `portal_api`, which
--       holds no grant on `firm_memberships` at all. Measured:
--
--           POST /api/firm/auth/login -> 500  permission denied for table firm_memberships
--
--       The firm OS could not be signed into. This is the same bootstrap problem
--       0004 solved for the client portal, and it is solved the same way.
--
--   B · THREE TABLES firm_api WAS NEVER GIVEN.
--       `server/src/db/firm-repo.ts` reads `tenants` (2×), `staff` (3×) and
--       `users` (5×). None has a grant or a policy for `firm_api`. They were
--       reachable only through the inheritance 0008 removed, so the firm OS
--       would have returned blank names and empty member lists — the same
--       silent-empty-result failure that motivates every guard in this repo.
--
-- ============================================================================
-- THE AUTH-PHASE PATTERN, AND WHY IT IS ACCEPTABLE HERE
-- ============================================================================
-- 0004's note on its own auth-phase policies:
--
--   "Session resolution must read users / client_sessions / client_invitations
--    BEFORE the caller is known, so it cannot be user-scoped. Instead of widening
--    the role, these tables get a second permissive policy that applies only while
--    kgm.phase = 'auth'. ... no domain table has an auth-phase policy at all — so
--    a request that has not yet authenticated cannot read a single matter,
--    document or invoice."
--
-- The firm login needs exactly that shape, and the honest difference is recorded
-- rather than glossed: the portal's auth-phase reads are justified by an opaque
-- 256-bit token, and a login request carries no token — it carries an email and a
-- password. So the justification here is narrower and rests on three things:
--
--   1. NO ROUTE EXPOSES IT. The server calls `listActiveMemberships(userId)` with
--      an id from a verified credential. Nothing in `firm.routes.ts` reads
--      `firm_memberships` before the password check.
--   2. THE COLUMNS ARE NARROW. Membership ids, job titles, tenant slug and name.
--      No password material, no financial ceilings, no authority limits — the
--      `financial_authority_sar` columns 0006 added to this very table are NOT
--      granted.
--   3. THE PHASE IS SET BY THE SERVER, FROM THE RESOLVED SESSION, NEVER FROM THE
--      REQUEST. A caller cannot ask for phase 'auth'.
--
-- It is a genuine widening of the database floor, and it is the smallest one that
-- makes firm sign-in possible. It is written down here because the next reader
-- deserves to know it was a decision and not an oversight.
--
-- ============================================================================
-- WHAT IS DELIBERATELY NOT DONE
-- ============================================================================
-- The firm OS's 26 core tables (matters, clients, documents, invoices, roles,
-- permissions, departments, membership_roles, matter_permissions, firm_sessions…)
-- already hold both a grant and a tenant/matter-scoped `firm_api` policy, verified
-- by introspection before this file was written. No grant here touches them, and
-- none widens `portal_api`: section 4 re-asserts that the §57 columns and the
-- firm tables remain out of the portal's reach.

-- ---------------------------------------------------------------------------
-- 1 · A · the firm login read (phase 'auth', role portal_api)
-- ---------------------------------------------------------------------------
/*
  Scoped to 'auth'. In any other phase these grants are inert, because the only
  portal-facing policies on these tables are `tenant_scope` (phase 'portal' and
  id = kgm_tenant()) and `firm_membership_self` (the caller's own row).
*/
grant select (id, tenant_id, user_id, staff_id, job_title, job_title_ar, status)
  on public.firm_memberships to portal_api;

drop policy if exists firm_membership_auth_phase on public.firm_memberships;
create policy firm_membership_auth_phase on public.firm_memberships to portal_api
  using (public.kgm_phase() = 'auth')
  with check (false);      -- a membership may never be created by an unauthenticated request

-- `tenants_auth_phase` already exists for portal_api; it only needed the columns.
grant select (id, slug, name, name_ar, status) on public.tenants to portal_api;

-- ---------------------------------------------------------------------------
-- 2 · B · the three tables firm_api was never given
-- ---------------------------------------------------------------------------
-- tenants: tenant-scoped to the caller's own firm, so the firm OS can render its
-- own branding and cannot enumerate other firms on the platform.
grant select (id, slug, name, name_ar, country, default_language, default_calendar, status)
  on public.tenants to firm_api;

drop policy if exists firm_tenant_scope on public.tenants;
create policy firm_tenant_scope on public.tenants to firm_api
  using (public.kgm_is_firm() and id = public.kgm_tenant())
  with check (false);

-- staff: everyone on the firm's own payroll. Not filtered by client_visible —
-- that column exists to hide INTERNAL staff from CLIENTS, and this is the firm
-- looking at itself.
grant select (id, tenant_id, full_name, full_name_ar, email, internal_role,
              bar_number, client_visible, client_title, client_title_ar, is_active)
  on public.staff to firm_api;

drop policy if exists firm_staff_scope on public.staff;
create policy firm_staff_scope on public.staff to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (false);

/*
  users: gated through the tenant's memberships, not granted wholesale.

  A firm user may read an identity row only where that person holds a membership
  in the caller's own tenant. The alternative — every row in `users` — would make
  the firm OS a way to read the CLIENT accounts on the platform, and `users` is
  shared: portal clients and firm staff are rows in the same table. Gating through
  `firm_memberships` is what keeps one firm's staff list from becoming a directory
  of another firm's clients.
*/
grant select (id, email, password_hash, password_updated_at, email_verified_at, status,
              failed_login_count, locked_until, last_login_at, mfa_enabled, mfa_method,
              mfa_secret_enc, preferred_language, preferred_calendar, created_at)
  on public.users to firm_api;

drop policy if exists firm_users_scope on public.users;
create policy firm_users_scope on public.users to firm_api
  using (public.kgm_is_firm()
         and exists (select 1 from public.firm_memberships fm
                      where fm.user_id = public.users.id
                        and fm.tenant_id = public.kgm_tenant()))
  with check (false);

-- ---------------------------------------------------------------------------
-- 3 · The firm's own admin surface reads memberships, not only its own row.
-- ---------------------------------------------------------------------------
/*
  `firm_membership_self` (0006) shows a firm user exactly one membership: their
  own. That is right for the tenant switcher and for `kgm_membership()`, but the
  Administration → Members screen lists the firm's team, and the permission
  resolver reads colleagues' roles to decide who may be delegated to.

  Without this, that screen renders a single row against Postgres while working
  perfectly on SQLite — the silent-empty class again. Scoped to the tenant, and
  read-only: `with check (false)`, because role and status changes go through the
  attribute path 0006 defines, not through a widened read policy.
*/
drop policy if exists firm_members_tenant on public.firm_memberships;
create policy firm_members_tenant on public.firm_memberships to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (false);

grant select (financial_authority_sar, writeoff_authority_sar, discount_authority_pct,
              joined_at, left_at, invited_by_membership_id, created_at, updated_at)
  on public.firm_memberships to firm_api;

-- ---------------------------------------------------------------------------
-- 4 · Assert the outcome, and assert the portal was not widened.
-- ---------------------------------------------------------------------------
do $$
declare
  missing text;
begin
  -- The firm login path.
  select string_agg(c, ', ') into missing
    from unnest(array['id', 'tenant_id', 'user_id', 'job_title', 'job_title_ar', 'status']) c
   where not has_column_privilege('portal_api', 'public.firm_memberships', c, 'SELECT');
  if missing is not null then
    raise exception 'portal_api cannot read firm_memberships.% — firm login will return 500.', missing;
  end if;

  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'firm_memberships'
                    and policyname = 'firm_membership_auth_phase') then
    raise exception 'firm_membership_auth_phase is missing — firm login cannot resolve a membership.';
  end if;

  -- The three tables firm_api needs.
  select string_agg(t, ', ') into missing
    from unnest(array['tenants', 'staff', 'users']) t
   where not (has_table_privilege('firm_api', 'public.' || t, 'SELECT')
              or exists (select 1 from pg_attribute a
                          where a.attrelid = ('public.' || t)::regclass and a.attnum > 0
                            and not a.attisdropped
                            and has_column_privilege('firm_api', 'public.' || t, a.attname, 'SELECT')));
  if missing is not null then
    raise exception 'firm_api still cannot read % — the firm OS will render blanks.', missing;
  end if;

  select string_agg(t, ', ') into missing
    from unnest(array['tenants', 'staff', 'users']) t
   where not exists (select 1 from pg_policies
                      where schemaname = 'public' and tablename = t
                        and 'firm_api' = any(roles::text[]));
  if missing is not null then
    raise exception 'no firm_api policy on % — RLS will fail closed and return empty sets.', missing;
  end if;

  /*
    THE PORTAL MUST NOT HAVE GAINED ANYTHING.

    This file grants `portal_api` two things, both auth-phase: five tenant columns
    and seven membership columns. Neither may be readable in a portal phase, and
    the §57 columns must still be denied — 0008's fix has to survive 0011.
  */
  select string_agg(t || '.' || c, ', ') into missing
    from (values
      ('matters', 'risk_rating'), ('matters', 'internal_notes'),
      ('invoices', 'notes_internal'), ('deadlines', 'assigned_staff_id'),
      ('deadlines', 'internal_comment'), ('hearings', 'internal_status'),
      ('messages', 'internal_note')
    ) as x(t, c)
   where has_column_privilege('portal_api', 'public.' || t, c, 'SELECT');
  if missing is not null then
    raise exception 'portal_api can read internal column(s) after 0011: %', missing;
  end if;

  if pg_has_role('portal_api', 'firm_api', 'USAGE') then
    raise exception 'portal_api INHERITS firm_api again — see 0008.';
  end if;

  raise notice 'firm login resolved; firm_api can read tenants/staff/users; portal unchanged.';
end $$;
