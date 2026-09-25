-- ═══════════════════════════════════════════════════════════════════════════════
--  0048 · THE FIRM'S WRITES THAT LAND OUTSIDE ITS OWN TABLES
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  Two privileges that P0.4 needs and 0045 does not confer, found by writing the statements
--  and reading the grants back against them — which is the only way this class of defect is
--  ever found. Both would have surfaced in production as a 500 on a write that the domain had
--  already approved, and neither would have failed a test that ran on SQLite.
--
--  ── (1) `deadlines.client_status`, NAMED IN AN INSERT AND NOT GRANTED ───────────
--
--  `FirmRepo.createProceduralDeadline` writes the lane columns explicitly, including
--  `client_status = 'open'`, because a procedural deadline is created in one state or it is
--  created wrongly. Column-level privileges are per NAMED column, including columns that also
--  have a default — the lesson defect (j) taught when `evaluated_at` was omitted from 0027's
--  grant and the eligibility refusal came back as a 500. The column is granted for UPDATE
--  and was not granted for INSERT.
--
--  ── (2) `matter_timeline`, WHICH UNTIL NOW THE FIRM COULD ONLY READ ────────────
--
--  0006 gave firm_api a read policy on the client timeline and `with check (false)` — the
--  firm could see the portal's timeline and had no way to add to it. P0.4 is the first phase
--  where the firm must: "a judgment was pronounced" is the most consequential event a client
--  can be shown, and a portal that keeps saying the matter is in court while the client holds
--  a copy of the صك is a portal nobody trusts.
--
--  THE POLICY IS DELIBERATELY NARROWER THAN THE PERMISSION.
--
--    · APPEND ONLY. INSERT is granted; UPDATE and DELETE are not. A timeline entry is a
--      statement that something happened at a moment; the way to correct one is to write
--      what actually happened beside it. This is the same reason the audit trail is
--      append-only, and the timeline is the client's view of that same record.
--
--    · CLIENT-VISIBLE ONLY. The WITH CHECK requires `client_visible = true`. A firm that
--      could write a hidden row into the timeline could put an account of events into the
--      portal's table that the client's own session will never render — an internal note in
--      the wrong drawer. `internal_notes` exists for what the client may not see, and the two
--      must not be interchangeable.
--
--    · ON A MATTER THE FIRM CAN SEE, IN THE FIRM'S OWN TENANT — the same `matter_visible`
--      gate every other firm policy uses, so the timeline cannot become the one table where a
--      matter-scope check is missing.
--
--  Note the shape of the policy: `for insert ... with check (...)`. The existing permissive
--  policy on the table still says `with check (false)` for everything else, and permissive
--  policies OR together — so SELECT keeps working exactly as it did and only INSERT is newly
--  possible. Nothing in 0006 is edited; the looseness is added explicitly, here, where it can
--  be read.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── (1) the deadline's lane column ──────────────────────────────────────────────
grant insert (client_status) on public.deadlines to firm_api;

-- ── (2) the client timeline ─────────────────────────────────────────────────────
grant insert (id, matter_id, tenant_id, occurred_at, event_type, title, title_ar,
              description, description_ar, status, client_visible, created_by_staff,
              created_at)
  on public.matter_timeline to firm_api;

alter table public.matter_timeline enable row level security;
alter table public.matter_timeline force  row level security;

drop policy if exists firm_timeline_append on public.matter_timeline;
create policy firm_timeline_append on public.matter_timeline for insert to firm_api
  with check (public.kgm_is_firm()
              and tenant_id = public.kgm_tenant()
              and public.matter_visible(matter_id)
              and client_visible is true);

-- ── VERIFY ─────────────────────────────────────────────────────────────────────
do $$
declare
  n integer;
begin
  /* The grant that the INSERT names must exist, or the write is a 500 in production and a
     pass everywhere else. Asked of the catalogue rather than of a statement, because this is
     the privilege the statement needs and not a statement that happens to exercise it. */
  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'deadlines'
     and grantee = 'firm_api' and privilege_type = 'INSERT' and column_name = 'client_status';
  if n <> 1 then
    raise exception '0048: firm_api still may not insert deadlines.client_status';
  end if;

  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'matter_timeline'
     and grantee = 'firm_api' and privilege_type = 'INSERT'
     and column_name in ('id','matter_id','tenant_id','occurred_at','event_type',
                         'title','title_ar','client_visible');
  if n <> 8 then
    raise exception '0048: % of the eight timeline columns the firm writes are not granted', n;
  end if;

  /* And the writes the firm must NOT have gained on the client's timeline. */
  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'matter_timeline'
     and grantee = 'firm_api' and privilege_type in ('UPDATE','DELETE');
  if n <> 0 then
    raise exception '0048: firm_api gained % update/delete privilege(s) on the client timeline — it is append-only', n;
  end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'matter_timeline'
     and policyname = 'firm_timeline_append';
  if n <> 1 then
    raise exception '0048: the append policy is not on matter_timeline';
  end if;

  raise notice '0048 applied: the firm may append to the client timeline, and may not rewrite it.';
end $$;
