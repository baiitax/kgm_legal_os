-- ═══════════════════════════════════════════════════════════════════════════════
--  0051 · THE DEADLINE THE FIRM DIARISES — A GRANT WITH NO POLICY IS NOT A GRANT
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  FOUND BY THE P0.4 LIVE HARNESS, at the moment a period was computed:
--
--      new row violates row-level security policy for table "deadlines"
--
--  after the API-level gate had passed and the deadline had been computed correctly. This is
--  0033 again, one table over, and it is worth naming why the same mistake is possible twice.
--
--  `deadlines` is a PORTAL table. Its policies were written for `portal_api`: a client sees
--  the deadlines of its own matters, and only the ones marked client-visible. `firm_api` held
--  a SELECT grant from 0006 and nothing else, because nothing in the product wrote a deadline
--  from the firm's side — the seeded ones were made by the seeder. P0.4 gives the firm a
--  write: the period a service creates is the firm's OWN obligation, it is the thing the firm
--  is sanctioned for missing, and it belongs on the firm's calendar.
--
--  0045 granted the columns. It did not add a policy, and a column grant with no policy is a
--  privilege the database will not honour — the operator of the grant and the operator of the
--  policy are different people reading different files. Both halves are now here, beside each
--  other, so the next phase that writes this table finds them together.
--
--  WHAT THE POLICIES SAY, AND WHAT THEY DELIBERATELY DO NOT
--
--    · The firm may INSERT a deadline on a matter it can see, in its own tenant. It may not
--      write one onto a file outside its scope, and it may not write into another firm.
--
--    · The firm may UPDATE such a deadline — a period is met, a hearing is adjourned, a
--      deadline is corrected — with the same visibility rule.
--
--    · DELETE IS NOT GRANTED, in either dialect. A deadline that has passed is a fact about
--      the file: it is closed, not removed. The retention test in the phase's suite asserts
--      that the privilege is absent, because a policy can be dropped by a superuser and a
--      missing privilege cannot.
--
--    · THE CLIENT-VISIBLE LANE IS NOT DECIDED HERE. `assert_deadline_lane` — restated in 0045
--      — is the rule: a procedural deadline is never client-visible and always carries the
--      article it was computed from; an `internal_task` deadline is never client-visible. A
--      policy that also tested the lane would put half the rule in a place where a reader
--      looking for the lane rule would not find it, and the lane rule has one home.
--
--  Nothing in 0004's portal policies is edited: a permissive ADDITION to a table whose other
-- policies still say what they always said.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.deadlines enable row level security;
alter table public.deadlines force  row level security;

drop policy if exists deadlines_firm_insert on public.deadlines;
create policy deadlines_firm_insert on public.deadlines for insert to firm_api
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and public.matter_visible(matter_id)
  );

drop policy if exists deadlines_firm_write on public.deadlines;
create policy deadlines_firm_write on public.deadlines for update to firm_api
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

-- ── VERIFY ──────────────────────────────────────────────────────────────────────
do $$
declare n integer;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'deadlines'
     and policyname in ('deadlines_firm_insert','deadlines_firm_write');
  if n <> 2 then
    raise exception '0051: % of the two firm policies are on deadlines', n;
  end if;

  /* The write privileges must exist on the columns the statement names — the failure 0048
     repaired and this migration must not undo. */
  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'deadlines'
     and grantee = 'firm_api' and privilege_type in ('INSERT','UPDATE');
  if n < 30 then
    raise exception '0051: only % column privileges for firm_api on deadlines', n;
  end if;

  /* And the one thing the firm may never do to a procedure. */
  select count(*) into n
    from information_schema.table_privileges
   where table_schema = 'public' and table_name = 'deadlines'
     and grantee = 'firm_api' and privilege_type = 'DELETE';
  if n <> 0 then
    raise exception '0051: firm_api may delete a deadline — a date that passed is closed, not removed';
  end if;

  raise notice '0051 applied: the firm can diarise its own procedure, and cannot erase it.';
end $$;
