-- ============================================================================
-- KGM LEGAL OS · 0021 — FIRM-SIDE WRITE POLICIES (the mirror of 0017–0019)
-- ============================================================================
-- The firm OS could read everything and write almost nothing.
--
-- `firm_api` held `FOR ALL` policies whose USING clause described *visibility*
-- and whose WITH CHECK was the literal `false`. A `FOR ALL` policy's WITH CHECK
-- is enforced on INSERT and UPDATE, so `false` there means "never", and Postgres
-- reports it as:
--
--     new row violates row-level security policy for table "matter_permissions"
--
-- which reaches the operator as a bare 500, because an RLS refusal is
-- indistinguishable from a bug at the API layer. The first live casualty was
-- `POST /api/firm/matters/:id/access`:
--
--     cause: permission denied for table matter_permissions      <- 0020, the grants
--     cause: new row violates row-level security policy ...      <- this file, the policy
--
-- Two independent faults on one endpoint, in sequence. 0020 fixed the grants.
-- This file fixes the policies — for every table the application actually writes.
--
-- WHY THE SHAPE IS WRONG, NOT JUST THE VALUE
--   0017–0019 established the rule for the portal side: one policy per command,
--   because USING and WITH CHECK answer different questions. USING selects the
--   rows a statement may SEE; WITH CHECK validates the row it is about to WRITE.
--   A single `FOR ALL` policy forces one expression to answer both, and when it
--   cannot, `false` is the safe-looking answer that silently disables all writes.
--
-- WHERE THE CHECK COMES FROM (not copied from USING)
--   For each table below the WITH CHECK is the *application's own rule for that
--   write*, expressed in SQL — taken from the route that performs it, not from
--   the USING clause. Where the two differ, the difference is the point:
--
--     matter_permissions  grant/revoke  needs 'full' on the matter  →  MATTER_MANAGE
--     membership_roles    assign_role   target + role in my tenant  →  same-tenant role
--     firm_memberships    deactivate    same tenant, nothing else
--     matter_controls     restrict      same tenant — and NOT the access level (below)
--     invoices (firm)     approve       same tenant + matter visible
--
--   The 0019 lesson is applied deliberately in two places. A WITH CHECK is
--   judged on the NEW row, so it must never restate something the statement
--   clears or changes:
--
--     · matter_permissions UPDATE does not pin `granted_by_membership_id`. A
--       revocation by an administrator who did not make the original grant is
--       legitimate, and the column is not rewritten by the revoke statement.
--
--     · matter_controls UPDATE does NOT test `matter_access_level(matter_id)`.
--       The restriction being written changes that very answer: setting
--       is_restricted = true can make the level 'none' for the actor who set it.
--       The write that creates the new state cannot be judged by its own effect.
--       (Authority is enforced at the API: `matters.restrict` + MATTER_MANAGE.)
--
-- WHAT IS DELIBERATELY LEFT READ-ONLY
--   These tables keep `with check false` on the firm side because NOTHING in
--   server/src writes them — verified by scanning every insert/update in the
--   codebase, not by assumption:
--
--     matters, matter_team, matter_timeline, hearings, invoice_lines, staff,
--     roles, role_permissions, tenants, tenant_settings, membership_practice_areas,
--     internal_notes
--
--   internal_notes additionally denies reads to both roles by design. The moment
--   a route is added that creates a matter, a hearing or a timeline entry, that
--   table needs the same treatment as the five below — the outage will look
--   exactly like this one, so this list is the place to look first.
--
-- ALSO VERIFIED HERE (no change needed)
--   · firm_sessions: firm writes go through `firm_sessions_self` as firm_api,
--     which carries a real WITH CHECK (`membership_id = kgm_membership()`), so
--     create/touch/revoke are admitted. `firm_sessions_auth_phase` (portal_api)
--     is SELECT-only during session resolution; its `false` check is correct.
--   · messages / message_threads: the only writer is the client
--     (`insertMessage` hardcodes sender_kind = 'client'). There is no firm-side
--     insert path in the code yet, so `firm_thread_scope` is not reachable.
--     It needs fixing when the firm reply route lands.
--   · users: the firm flow touches `users` only during authentication, which
--     runs in the auth phase under `users_auth_phase`.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · matter_permissions — who may act on a matter
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists matter_permissions_tenant on public.matter_permissions;

create policy matter_permissions_read on public.matter_permissions
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy matter_permissions_insert on public.matter_permissions
  for insert to firm_api
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    -- Attribution: a grant records who made it, and the caller cannot record
    -- someone else's membership id as the grantor.
    and granted_by_membership_id = public.kgm_membership()
    -- Authority: granting access to a matter requires 'full' on that matter
    -- (the route requires MATTER_MANAGE, which is ['full']). Without this, any
    -- member who can reach the table could grant themselves or an accomplice
    -- any level — the escalation §72 exists to catch.
    and public.matter_access_level(matter_id) = 'full'
  );

create policy matter_permissions_update on public.matter_permissions
  for update to firm_api
  using (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
  )
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    -- The upsert's DO UPDATE branch lands here when a grant already exists, so
    -- a re-grant to a different level is checked exactly like a first grant.
    and public.matter_access_level(matter_id) = 'full'
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · membership_roles — role assignment (the escalation surface, §72)
-- ─────────────────────────────────────────────────────────────────────────────
-- The old policy was self-scoped for ALL commands: `membership_id =
-- kgm_membership()`. For reads that is merely narrow. For writes it is worse
-- than a bug — a self-scoped INSERT lets a member grant THEMSELVES any role, so
-- the policy that looked strictest was the one that permitted privilege
-- escalation. Role assignment is an administrator action on someone else's
-- membership, so the write scope is the tenant, bounded by the target
-- membership and the role both belonging to it.
drop policy if exists membership_roles_self on public.membership_roles;

create policy membership_roles_read on public.membership_roles
  for select to firm_api
  using (
    public.kgm_is_firm()
    and exists (
      select 1 from public.firm_memberships fm
       where fm.id = membership_roles.membership_id
         and fm.tenant_id = public.kgm_tenant()
    )
  );

create policy membership_roles_insert on public.membership_roles
  for insert to firm_api
  with check (
    public.kgm_is_firm()
    and granted_by_membership_id = public.kgm_membership()
    and exists (
      select 1 from public.firm_memberships fm
       where fm.id = membership_roles.membership_id
         and fm.tenant_id = public.kgm_tenant()
    )
    and exists (
      select 1 from public.roles r
       where r.id = membership_roles.role_id
         and (r.tenant_id = public.kgm_tenant() or r.tenant_id is null)
    )
  );

create policy membership_roles_update on public.membership_roles
  for update to firm_api
  using (
    public.kgm_is_firm()
    and exists (
      select 1 from public.firm_memberships fm
       where fm.id = membership_roles.membership_id
         and fm.tenant_id = public.kgm_tenant()
    )
  )
  with check (
    public.kgm_is_firm()
    and exists (
      select 1 from public.firm_memberships fm
       where fm.id = membership_roles.membership_id
         and fm.tenant_id = public.kgm_tenant()
    )
    and exists (
      select 1 from public.roles r
       where r.id = membership_roles.role_id
         and (r.tenant_id = public.kgm_tenant() or r.tenant_id is null)
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · firm_memberships — suspend / deactivate / reactivate a member
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists firm_members_tenant on public.firm_memberships;

create policy firm_memberships_read on public.firm_memberships
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy firm_memberships_update on public.firm_memberships
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · matter_controls — restriction flag (§27)
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists matter_controls_tenant on public.matter_controls;

create policy matter_controls_read on public.matter_controls
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy matter_controls_update on public.matter_controls
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    -- No matter_access_level() here: see the header. Restricting a matter is
    -- exactly the write that changes the actor's derived level.
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5 · invoices — firm-side approval
-- ─────────────────────────────────────────────────────────────────────────────
-- The firm policy is dropped by name from THIS table only; `firm_matter_scope`
-- is the same policy name on matters, matter_team, matter_timeline, hearings and
-- message_threads, and all of those stay read-only.
drop policy if exists firm_matter_scope on public.invoices;

create policy invoices_firm_read on public.invoices
  for select to firm_api
  using (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and public.matter_visible(matter_id)
  );

create policy invoices_firm_update on public.invoices
  for update to firm_api
  using (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and public.matter_visible(matter_id)
  )
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and public.matter_visible(matter_id)
  );

-- ============================================================================
-- VERIFY
--   The five tables must have a real write policy, and no table the application
--   writes may still carry a WITH CHECK of `false`.
-- ============================================================================
do $$
declare
  r record;
  problems text[] := '{}';
  writes text[] := array[
    'matter_permissions', 'membership_roles', 'firm_memberships',
    'matter_controls', 'invoices'
  ];
  expected text[][] := array[
    ['matter_permissions', 'matter_permissions_read'],
    ['matter_permissions', 'matter_permissions_insert'],
    ['matter_permissions', 'matter_permissions_update'],
    ['membership_roles',   'membership_roles_read'],
    ['membership_roles',   'membership_roles_insert'],
    ['membership_roles',   'membership_roles_update'],
    ['firm_memberships',   'firm_memberships_read'],
    ['firm_memberships',   'firm_memberships_update'],
    ['matter_controls',    'matter_controls_read'],
    ['matter_controls',    'matter_controls_update'],
    ['invoices',           'invoices_firm_read'],
    ['invoices',           'invoices_firm_update']
  ];
  i int;
begin
  -- 1. every write policy exists
  for i in 1 .. array_length(expected, 1) loop
    if not exists (
      select 1 from pg_policies
       where schemaname = 'public'
         and tablename = expected[i][1]
         and policyname = expected[i][2]
    ) then
      problems := problems || ('missing policy ' || expected[i][1] || '.' || expected[i][2]);
    end if;
  end loop;

  -- 2. the superseded `for all` policies are gone
  for r in
    select tablename, policyname from pg_policies
     where schemaname = 'public'
       and (tablename, policyname) in (
         ('matter_permissions', 'matter_permissions_tenant'),
         ('membership_roles', 'membership_roles_self'),
         ('firm_memberships', 'firm_members_tenant'),
         ('matter_controls', 'matter_controls_tenant'),
         ('invoices', 'firm_matter_scope')
       )
  loop
    problems := problems || ('old policy still present: ' || r.tablename || '.' || r.policyname);
  end loop;

  -- 3. each of the five tables must have at least one policy that can actually
  --    admit the write. Permissive policies are OR'd, so a neighbouring
  --    read-only policy with `with check false` (e.g. firm_membership_self, or
  --    the auth-phase policy on portal_api) is harmless — it is the ABSENCE of
  --    any admitting policy that produces the 500.
  for r in
    select * from (values
      ('matter_permissions', 'INSERT'),
      ('matter_permissions', 'UPDATE'),
      ('membership_roles',   'INSERT'),
      ('membership_roles',   'UPDATE'),
      ('firm_memberships',   'UPDATE'),
      ('matter_controls',    'UPDATE'),
      ('invoices',           'UPDATE')
    ) as t(table_name, op)
  loop
    if not exists (
      select 1 from pg_policies
       where schemaname = 'public'
         and tablename = r.table_name
         and (cmd = r.op or cmd = 'ALL')
         and coalesce(with_check, 'true') <> 'false'
    ) then
      problems := problems || ('no policy admits ' || r.op || ' on ' || r.table_name);
    end if;
  end loop;

  -- 4. the escalation bound is present where it matters
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'matter_permissions'
       and policyname = 'matter_permissions_insert'
       and with_check like '%matter_access_level%full%'
  ) then
    problems := problems || 'matter_permissions_insert does not require full access on the matter';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'matter_controls'
       and policyname = 'matter_controls_update'
       and with_check not like '%matter_access_level%'
  ) then
    problems := problems || 'matter_controls_update must not test matter_access_level (0019-shaped trap)';
  end if;

  if array_length(problems, 1) > 0 then
    raise exception E'firm write policies incomplete (%):\n  %',
      array_length(problems, 1), array_to_string(problems, E'\n  ');
  end if;

  raise notice 'firm-side writes admitted on all five tables; escalation bound present.';
end $$;
