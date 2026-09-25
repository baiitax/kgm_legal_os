-- ═══════════════════════════════════════════════════════════════════════════════
-- 0042 · THE DEADLINE COLUMN THE INSERT GRANT DID NOT REACH
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS REPAIRS, AND WHY IT IS A MIGRATION RATHER THAN AN EDIT TO 0040.
--
-- 0040 granted INSERT on `str_reports` for every column the repository writes — except
-- `filed_due_at`. The repository names it, the trigger fills it, and the privilege for it
-- was missing, so on the real server the first report a compliance officer prepared would
-- have failed with `permission denied for table str_reports` and surfaced as a 500. Not a
-- business refusal: a fault, on the one action in this phase with a statutory clock
-- attached to it.
--
-- The parity check found it the moment 0040 was applied (`str_reports INSERT: NOT GRANTED
-- for INSERT: filed_due_at`), which is the same class of defect 0027 hit with
-- `evaluated_at` and the reason that check exists. It is repaired FORWARD rather than by
-- editing 0040 because 0040 has been applied: a migration that has run is a fact about
-- the database, and rewriting it would leave environments that applied the old text
-- unable to say what they contain. Every environment that applies 0042 lands in the same
-- place anyway.
--
-- WHY `filed_due_at` IS NOT ALSO GRANTED FOR UPDATE. `guard_str_due_date` derives it in a
-- BEFORE INSERT OR UPDATE trigger: on INSERT from the prepared date, and on UPDATE only
-- when `prepared_at` itself moves. The repository never names the column in an UPDATE —
-- and once a report is filed, `guard_str_filing` refuses any change to it at all. Granting
-- the UPDATE privilege would widen what the firm role may write, in the one direction this
-- phase is trying to narrow: the due date is arithmetic, and arithmetic is not something a
-- caller should be able to assert.
-- ═══════════════════════════════════════════════════════════════════════════════

grant insert (filed_due_at) on public.str_reports to firm_api;

-- ── verify ─────────────────────────────────────────────────────────────────────
do $$
declare
  ok_insert boolean;
  ok_update boolean;
begin
  select bool_or(privilege_type = 'INSERT') into ok_insert
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'str_reports'
     and grantee = 'firm_api' and column_name = 'filed_due_at';

  select bool_or(privilege_type = 'UPDATE') into ok_update
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'str_reports'
     and grantee = 'firm_api' and column_name = 'filed_due_at';

  if ok_insert is not true then
    raise exception '0042: firm_api still cannot insert filed_due_at on str_reports';
  end if;

  if ok_update is true then
    raise exception '0042: firm_api holds UPDATE on filed_due_at, which is derived and must not be asserted by a caller';
  end if;

  raise notice '0042 applied: the report can be prepared, and only the trigger sets its deadline.';
end $$;
