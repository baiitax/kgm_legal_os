-- ═══════════════════════════════════════════════════════════════════════════════
--  0031 · THE ENGINE'S OPINION IS NOT A LAWYER'S DECISION
--
--  WHAT WAS WRONG
--  `conflict_hits` carries two columns that record a JUDGEMENT rather than a fact:
--  `severity` and `affected_party_id`. Migration 0029 constrains them deliberately:
--
--      constraint conflict_hits_severity_needs_confirmation
--        check (severity is null or disposition = 'same_party')
--      constraint conflict_hits_confirmed_complete
--        check (disposition <> 'same_party' or (severity is not null and affected_party_id is not null))
--
--  The intent is the same principle as everywhere else in this subsystem: the
--  engine finds, a person decides, and the database refuses to let the two be
--  confused. A hit starts `open` with no severity. It acquires one when somebody
--  records that it IS a conflict.
--
--  `FirmRepo.recordConflictHit` wrote the engine's proposed severity into the hit at
--  insert time, while the hit was `open`. Every conflict check that found anything at
--  all therefore failed with
--
--      CHECK constraint failed: severity is null or disposition = 'same_party'
--
--  The constraint is right and the repository was wrong, which is the direction that
--  is easy to get backwards: when a write fails a constraint during development, the
--  temptation is to loosen the constraint.
--
--  WHAT IS ADDED
--  The engine's assessment is a real fact and losing it would be a mistake — "the
--  matcher flagged this as a potential conflict and a lawyer recorded it as none" is
--  exactly what a supervisor reviewing a clearance needs to see. So it gets its own
--  column, with a name that says whose opinion it is:
--
--      proposed_severity   what the ENGINE concluded, never presented as decided
--      severity            what a PERSON decided, only ever set on a disposition
--
--  Both are now recorded, neither can be mistaken for the other, and the rule that a
--  machine may not declare a conflict stands.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.conflict_hits
  add column if not exists proposed_severity text
    check (proposed_severity is null or proposed_severity in ('actual','potential','none'));

comment on column public.conflict_hits.proposed_severity is
  'The match engine''s assessment, recorded as an opinion. `severity` is the decision.';

-- ── the writes ───────────────────────────────────────────────────────────────
grant select (proposed_severity) on public.conflict_hits to firm_api;
grant insert (proposed_severity) on public.conflict_hits to firm_api;

-- ── backfill ─────────────────────────────────────────────────────────────────
-- Rows written before this migration by the broken insert do not exist: the insert
-- failed, so no hit was ever stored with a severity and an open disposition. The
-- statement below is therefore a no-op in practice, and it is here so the invariant
-- holds on any database that was written by a build in between.
update public.conflict_hits
   set proposed_severity = severity
 where disposition = 'same_party' and proposed_severity is null;

-- ── VERIFY ───────────────────────────────────────────────────────────────────
do $$
declare
  missing text;
begin
  select string_agg(c.column_name, ', ') into missing
    from unnest(array['proposed_severity']) c(column_name)
   where not exists (
           select 1 from information_schema.column_privileges p
            where p.table_schema = 'public' and p.table_name = 'conflict_hits'
              and p.grantee = 'firm_api' and p.privilege_type = 'INSERT'
              and p.column_name = c.column_name);
  if missing is not null then
    raise exception '0031: conflict_hits INSERT not granted for: %', missing;
  end if;

  -- The rule this file exists to protect, restated as a check on the live schema.
  if not exists (
       select 1 from pg_constraint
        where conname = 'conflict_hits_severity_needs_confirmation') then
    raise exception '0031: the severity/disposition constraint has disappeared';
  end if;

  raise notice '0031 applied: the engine''s opinion and the lawyer''s decision are separate columns.';
end $$;
