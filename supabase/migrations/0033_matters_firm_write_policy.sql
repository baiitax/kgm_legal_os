-- ═══════════════════════════════════════════════════════════════════════════════
--  0033 · THE FIRM MAY WRITE A MATTER — AND ONLY WHAT IT CAN SEE
--
--  WHAT WAS WRONG
--
--  Migration 0006 wrote:
--
--      create policy firm_matter_scope on public.matters to firm_api
--        using (kgm_is_firm() and tenant_id = kgm_tenant() and matter_visible(id))
--        with check (false);
--
--  No `for` clause, so it was an ALL policy, and `with check (false)` denies every
--  INSERT and UPDATE. That was correct when it was written: the firm read matters and
--  wrote only their CHILD tables (team, permissions, controls, timeline), each with
--  its own policy. Nothing in the product updated a `matters` row.
--
--  P0.1 makes the matter lifecycle the firm's own: `POST /matters/:id/status` moves a
--  file through intake, conflict_check, review and closure, and records the derived
--  `conflict_cleared` with it. On the live database that route answered
--
--      new row violates row-level security policy for table "matters"
--
--  after the API-level Rule 11 gate had already passed — so the control that stops a
--  matter leaving `conflict_check` was reachable, and the write that implements it was
--  not. A unit test cannot see this: SQLite has no row-level security at all, which is
--  precisely why §71 asks for the policies to be checked against the real engine.
--
--  WHAT REPLACES IT
--
--  One policy per command, as migration 0021 established:
--
--    · SELECT keeps the rule it always had — the firm sees the matters that are
--      visible to it, in its own tenant.
--    · UPDATE is new. USING is the same visibility rule, so a member can only change
--      a file they can see. WITH CHECK is deliberately WEAKER: firm phase and tenant,
--      and no visibility test.
--
--  WHY THE WITH CHECK DROPS THE VISIBILITY TEST
--
--  Same reason migration 0021 gives for `matter_controls_update`. The update that
--  restricts a matter to named people — or releases it, or archives it — is exactly
--  the update that changes whether the actor can see it. A WITH CHECK that re-tested
--  visibility would evaluate the NEW row and refuse the write that made the row
--  invisible, which is the restriction feature refusing itself. USING already
--  establishes that the row was visible to the actor when they touched it, and the
--  authority to make it invisible is the permission the route asserts.
--
--  What the weaker check still guarantees: the row stays in the firm's tenant
--  (`tenant_id = kgm_tenant()`), so no route can move a matter to another firm by
--  writing a new tenant_id, and the phase stays firm (`kgm_is_firm()`).
--
--  WHAT IS STILL REFUSED
--
--  INSERT and DELETE. There is no policy for either, so the firm_api role cannot
--  create or destroy a matter row through RLS at all. Matters are created by the
--  provisioning path and destroyed by nothing — the product has no delete, by
--  design. When a route to open a matter exists it will need its own policy, and
--  this comment is where that decision should be made rather than assumed.
-- ═══════════════════════════════════════════════════════════════════════════════

drop policy if exists firm_matter_scope on public.matters;

create policy matters_firm_read on public.matters
  for select to firm_api
  using (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and public.matter_visible(id)
  );

create policy matters_firm_write on public.matters
  for update to firm_api
  using (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and public.matter_visible(id)
  )
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    -- No matter_visible() here: see the header. The write that hides a matter is
    -- authorised by a permission, not by the visibility it is about to remove.
  );

comment on policy matters_firm_write on public.matters is
  'The firm may move a matter it can see through its lifecycle. USING is the visibility rule; WITH CHECK is firm+tenant only, because the write may change visibility.';

-- ── VERIFY ───────────────────────────────────────────────────────────────────
do $$
declare
  n integer;
  probe record;
begin
  -- The superseded ALL policy is gone, and nothing else on this table is ALL.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'matters' and policyname = 'firm_matter_scope';
  if n <> 0 then
    raise exception '0033: firm_matter_scope is still on matters';
  end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'matters'
     and 'firm_api' = any(roles) and cmd = 'ALL';
  if n <> 0 then
    raise exception '0033: matters still carries an ALL policy for firm_api (% found)', n;
  end if;

  -- The read policy still gates on visibility and the phase.
  select * into probe from pg_policies
   where schemaname = 'public' and tablename = 'matters' and policyname = 'matters_firm_read';
  if probe is null then raise exception '0033: matters_firm_read missing'; end if;
  if position('matter_visible' in probe.qual) = 0 or position('kgm_is_firm' in probe.qual) = 0 then
    raise exception '0033: matters_firm_read lost a predicate: %', probe.qual;
  end if;

  -- The write policy permits, and its check is the weak one on purpose.
  select * into probe from pg_policies
   where schemaname = 'public' and tablename = 'matters' and policyname = 'matters_firm_write';
  if probe is null then raise exception '0033: matters_firm_write missing'; end if;
  if probe.cmd <> 'UPDATE' then
    raise exception '0033: matters_firm_write is %, not UPDATE — an ALL policy here would re-deny INSERT', probe.cmd;
  end if;
  if probe.with_check is null or position('kgm_is_firm' in probe.with_check) = 0 then
    raise exception '0033: matters_firm_write has no usable WITH CHECK: %', probe.with_check;
  end if;
  if position('matter_visible' in probe.with_check) > 0 then
    raise exception '0033: matters_firm_write re-tests visibility in WITH CHECK, which refuses the restriction itself';
  end if;
  if position('matter_visible' in probe.qual) = 0 then
    raise exception '0033: matters_firm_write lost the visibility rule from USING';
  end if;

  -- No INSERT policy, so the firm cannot create a matter row.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'matters'
     and 'firm_api' = any(roles) and cmd in ('INSERT', 'ALL');
  if n <> 0 then
    raise exception '0033: firm_api can INSERT into matters (% policy/policies)', n;
  end if;

  raise notice '0033 applied: the firm may UPDATE the matters it can see, and may not create or delete one.';
end $$;
