-- ═══════════════════════════════════════════════════════════════════════════════
--  0030 · CONFLICT WRITE PRIVILEGES
--
--  WHAT THIS FIXES
--
--  Migration 0029 created seven tables, granted `firm_api` the columns it needed on
--  six of them — and omitted the two columns it added to `matters`. The result is
--  the same failure 0027 produced and 0028 was written to repair: `matter_status_gate`
--  and the conflict-clearance route both issue
--
--      update public.matters set internal_status = …, conflict_cleared = …, updated_at = …
--
--  against a table that was granted SELECT and nothing else. The grant table now
--  reads:
--
--      firm_api   SELECT   … every column …
--      firm_api   UPDATE   (nothing)
--
--  so in production that statement raises `permission denied for table matters`, the
--  route turns a 42501 into an opaque 500, and the single most important control in
--  P0.1 — the one that stops a matter leaving `conflict_check` without a conflict
--  clearance — fails closed with a database error rather than an explanation. Failing
--  closed is the right direction, but a control that cannot be exercised is not a
--  control; it is an outage waiting for the first lawyer who tries to open a file.
--
--  WHY A NEW FILE AND NOT AN EDIT TO 0029
--
--  0029 has been applied, and `kgm_migrations` records its checksum. Editing an
--  applied migration would leave this environment and any other environment with the
--  same file name and different contents, which is the one thing a migration ledger
--  exists to prevent. So the repair is a second migration, exactly as 0028 repaired
--  0027.
--
--  HOW IT WAS FOUND
--
--  Not by a lawyer, and not by a test of the route — by `scripts/verify/schema-parity.ts`,
--  which reads `firm_api`'s column privileges out of the live database and compares
--  them against the column list of every statement the server actually issues. That
--  checker was extended in this same phase, and it is why the phase gate requires it
--  to run before the phase is called done.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · the columns the matter lifecycle writes ──────────────────────────────
--
-- `internal_status` is the firm's own view of where a matter stands; the platform
-- moved it deliberately and only ever on its own service role before this phase.
-- `conflict_cleared` is DERIVED — the repository is the only writer and the trigger
-- `matter_conflict_gate` re-derives it independently — so granting the column is not
-- granting a client the ability to assert it.
grant update (internal_status, conflict_cleared, updated_at) on public.matters to firm_api;

-- ── 2 · VERIFY ───────────────────────────────────────────────────────────────
do $$
declare
  missing text;
  n integer;
begin
  select string_agg(c.column_name, ', ') into missing
    from unnest(array['internal_status','conflict_cleared','updated_at']) c(column_name)
   where not exists (
           select 1 from information_schema.column_privileges p
            where p.table_schema = 'public' and p.table_name = 'matters'
              and p.grantee = 'firm_api' and p.privilege_type = 'UPDATE'
              and p.column_name = c.column_name);
  if missing is not null then
    raise exception '0030: matters UPDATE still not granted for: %', missing;
  end if;

  -- The portal must NOT have gained the lifecycle columns. Its writer is the
  -- invoice/portal service, and a status is an internal fact.
  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'matters'
     and grantee = 'portal_api' and privilege_type = 'UPDATE';
  if n > 0 then
    raise exception '0030: portal_api gained % UPDATE column(s) on matters — it must have none', n;
  end if;

  raise notice '0030 applied: matters is writable by firm_api for the lifecycle columns, and only there.';
end $$;
