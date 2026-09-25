-- ═══════════════════════════════════════════════════════════════════════════════
--  0050 · THE BROWSER-FACING ROLES, AGAIN — AND THIS TIME FOR EVERY TABLE
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  FOUND BY THE P0.4 LIVE HARNESS, which asked the deployed database a question the suite
--  cannot ask: "which roles hold privileges on the judgment register?" The answer was not
--  the two application roles. It was `anon` and `authenticated`.
--
--      anon:judgments:INSERT, anon:judgments:SELECT, anon:judgments:UPDATE, …
--      authenticated:service_events:DELETE, authenticated:court_calendar:TRUNCATE, …
--
--  `anon` is the Supabase role for an unauthenticated request — the key that is shipped in
--  a browser bundle — and `authenticated` is any logged-in Supabase user. Neither is an
--  application role: this product authenticates through its own API and reaches the
--  database as `portal_api` or `firm_api`, and nothing else.
--
--  WHY IT HAPPENED, AND WHY IT IS NOT ONLY ABOUT P0.4
--
--  0004 did revoke these roles — with `revoke all on all tables in schema public`. That
--  statement covers the tables that EXIST WHEN IT RUNS. Supabase, meanwhile, carries a
--  default privilege that grants ALL on new tables in `public` to `anon` and
--  `authenticated`, so every table created by every migration since 0004 arrived with the
--  grant. The verification at the end of 0004 could not have caught it, because it asked
--  about the tables that existed then.
--
--  FORTY-EIGHT TABLES ARE AFFECTED, INCLUDING `firm_sessions`, `firm_memberships`,
--  `client_due_diligence` and `str_reports`. Forty-four of them have row level security
--  enabled, and no policy names either role, so RLS refuses them everything — which is why
--  this has never shown up as a functional failure. FOUR DID NOT HAVE IT ENABLED AT ALL:
--
--      eligibility_checks · prior_office · professional_licences · tenant_relationships
--
--  On those four, `anon` — the browser key — could read, insert, update and delete every
--  row. There is no policy to refuse it because there is no RLS to evaluate one. That is not
--  a hardening gap; it is an exposed table.
--
--  WHAT THIS MIGRATION DOES
--
--    · revokes all on every table, sequence and function in `public` from both roles, so the
--      statement covers what EXISTS rather than what existed in 0004;
--    · REVOKES THE DEFAULT PRIVILEGES, so the next table does not inherit the grant — the
--      durable half, and the one that was missing;
--    · enables and forces row level security on every table in `public` that does not have
--      it, by walking the catalogue rather than by naming the four. A list of tables to fix
--      is a list that will be incomplete the next time somebody adds one;
--    · verifies all of it from the catalogue, because a revoke that missed a table and a
--      revoke that worked look identical from the outside.
--
--  AND IT DOES NOT TOUCH RLS FOR ANYTHING ELSE. `force row level security` makes policies
--  apply to the table's OWNER too. It is applied here to tables that have no RLS at all,
--  which is a state no table in this schema should be in — every one of them has policies
--  for `firm_api` or `portal_api` already, so turning RLS on closes the gap without taking
--  anything away from the application.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · what exists now ─────────────────────────────────────────────────────────
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
    end if;
  end loop;
end $$;

-- ── 2 · what will exist next ────────────────────────────────────────────────────
/*
  THE HALF THAT WAS MISSING. `revoke all on all tables` is a statement about the present
  tense; a default privilege is a statement about every future table. Without this line,
  migration 0051 would reintroduce the same grants and nobody would notice for a phase.
*/
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;

-- ── 3 · every table carries a policy engine ─────────────────────────────────────
do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and (not c.relrowsecurity or not c.relforcerowsecurity)
     order by c.relname
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    execute format('alter table public.%I force  row level security', t.relname);
    raise notice '0050: row level security enabled and forced on public.%', t.relname;
  end loop;
end $$;

-- ── VERIFY ──────────────────────────────────────────────────────────────────────
do $$
declare
  n integer;
  names text;
begin
  /* No privilege of any kind, on any table, for either role. */
  select count(*), string_agg(distinct table_name, ', ')
    into n, names
    from information_schema.table_privileges
   where table_schema = 'public' and grantee in ('anon','authenticated');
  if n <> 0 then
    raise exception '0050: % privilege(s) still granted to a browser-facing role on: %', n, names;
  end if;

  /* And the default privileges are gone, so the next migration does not undo this. */
  select count(*) into n
    from pg_default_acl d
    join pg_roles r on r.oid = d.defaclrole
   where r.rolname in ('anon','authenticated')
     and exists (
       select 1 from aclexplode(d.defaclacl) e
        where e.grantee = r.oid and e.privilege_type <> 'USAGE');
  if n <> 0 then
    raise exception '0050: % default privilege grant(s) to a browser-facing role survived', n;
  end if;

  /* Every table is behind RLS, enabled and forced. */
  select count(*), string_agg(c.relname, ', ')
    into n, names
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r'
     and (not c.relrowsecurity or not c.relforcerowsecurity);
  if n <> 0 then
    raise exception '0050: % table(s) in public are not behind forced RLS: %', n, names;
  end if;

  raise notice '0050 applied: anon and authenticated hold nothing, and future tables will hold nothing either.';
end $$;
