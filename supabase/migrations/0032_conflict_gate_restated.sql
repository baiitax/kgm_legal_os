-- ═══════════════════════════════════════════════════════════════════════════════
--  0032 · THE CONFLICT GATE, RESTATED
--
--  THREE THINGS ARE WRONG WITH THE GUARD INSTALLED BY 0029, and all three only
--  appear against a database that already has rows in it.
--
--  1. IT PUNISHES A ROW FOR A VALUE IT DID NOT WRITE.
--     The rule was "conflict_cleared may not contradict the ledger". It was written
--     as an unconditional test of `new.conflict_cleared`, and `new` carries the
--     EXISTING value forward on every update. So on a matter that was marked clear
--     before this subsystem existed — which is every matter in the demo dataset, and
--     every matter in a firm that migrates in — an unrelated update (a risk rating,
--     an internal note, a client status) raises:
--
--         matters.conflict_cleared is derived from the conflict checks and may not be asserted
--
--     The firm cannot edit the file at all until someone runs a conflict check, and
--     the error names a column nobody touched. A guard must refuse an ASSERTION, not
--     a value it merely carried forward. It now fires only when the statement
--     CHANGES the column.
--
--  2. THE PREDICATE IS WRITTEN TWICE, IN BOTH DIALECTS.
--     "Does a concluded check cover this matter" appeared twice in the Postgres
--     trigger and twice in the SQLite mirror — four copies of one legal rule, which
--     is three more than a rule may have. It is now a function, and both rules in
--     both dialects call it.
--
--  3. THE EXISTING ROWS ARE INCONSISTENT, AND THE MIGRATION SAID NOTHING.
--     0029 added the guard without reconciling the rows it was now guarding. Three
--     matters in the live database assert `conflict_cleared = true` with no conflict
--     check anywhere behind them: a clearance that was an assertion, which is the
--     precise defect P0.1 exists to remove. They are normalised to NULL below — not
--     to `false`, because false is also a claim about the ledger, and the truth is
--     that nobody has checked.
--
--  A NOTE ON WHY NULL AND NOT FALSE
--     `conflict_cleared` is tri-state on purpose. True means a check cleared it.
--     False means a check examined it and did not. NULL means nobody has looked.
--     Collapsing the last two would destroy the distinction between "checked and
--     refused" and "not checked", which is the distinction Rule 11 turns on.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · the rule, once ───────────────────────────────────────────────────────
create or replace function public.matter_conflict_covered(p_matter uuid)
returns boolean
language sql
stable
as $$
  -- There exists a concluded clearing check that
  --   · saw every party on the matter as it now stands (a check that ran before the
  --     counterparty was known has not checked the counterparty), and
  --   · left no finding undispositioned, and
  --   · has a written waiver for every confirmed actual or potential conflict.
  select exists (
    select 1
      from public.conflict_checks c
     where c.matter_id = p_matter
       and c.status in ('clear', 'cleared_with_waiver')
       and not exists (
         select 1 from public.matter_parties mp
          where mp.matter_id = p_matter and mp.created_at > c.started_at)
       and not exists (
         select 1 from public.conflict_hits h
          where h.check_id = c.id and h.disposition = 'open')
       and not exists (
         select 1 from public.conflict_hits h
          where h.check_id = c.id
            and h.disposition = 'same_party'
            and h.severity in ('actual', 'potential')
            and not exists (select 1 from public.conflict_waivers w where w.hit_id = h.id))
  );
$$;

comment on function public.matter_conflict_covered(uuid) is
  'The Rule 11 coverage predicate: is there a concluded conflict check that covers this matter as it now stands? Called by the guard on matters; must not be reimplemented.';

-- The trigger runs with the privileges of the role that fired it, so `firm_api`
-- needs EXECUTE. It does NOT need SELECT on anything new: the function is a plain
-- (invoker-rights) function, so the row-level policies of the caller still apply and
-- the guard cannot be used to read another tenant's conflicts.
revoke all on function public.matter_conflict_covered(uuid) from public;
grant execute on function public.matter_conflict_covered(uuid) to firm_api;

-- ── 2 · the guard, restated ──────────────────────────────────────────────────
create or replace function public.matter_conflict_guard() returns trigger
language plpgsql as $$
begin
  -- (a) A CHANGE of the derived value may not contradict the ledger. A value that
  --     was merely carried forward is not a claim, and refusing it froze every
  --     matter that predated this subsystem.
  if new.conflict_cleared is distinct from old.conflict_cleared
     and new.conflict_cleared is not null
     and new.conflict_cleared <> public.matter_conflict_covered(new.id) then
    raise exception using
      errcode = '23514',
      message = 'matters.conflict_cleared is derived from the conflict checks and may not be asserted';
  end if;

  -- (b) Rule 11: work may not be accepted on an unexamined file. Unchanged from
  --     0029 — this rule is about the transition, not about the column, and it was
  --     right the first time.
  if tg_op = 'UPDATE'
     and old.internal_status = 'conflict_check'
     and new.internal_status <> 'conflict_check'
     and new.internal_status <> 'archived'
     and not public.matter_conflict_covered(new.id) then
    raise exception using
      errcode = '23514',
      message = 'a matter may not leave conflict_check without an excluding conflict check (Rule 11)';
  end if;

  return new;
end $$;

-- ── 3 · the rows this guard is now guarding ──────────────────────────────────
-- Clearances asserted before the ledger existed. NULL says what is true: nobody has
-- checked. The UPDATE is permitted by rule (a) as restated, because it sets NULL.
do $$
declare
  reconciled integer;
begin
  update public.matters m
     set conflict_cleared = null,
         updated_at = now()
   where m.conflict_cleared is not null
     and m.conflict_cleared is distinct from public.matter_conflict_covered(m.id);
  get diagnostics reconciled = row_count;
  raise notice '0032: % matter(s) carried an unsupported clearance and now read NULL (not checked)', reconciled;
end $$;

-- ── 4 · VERIFY ───────────────────────────────────────────────────────────────
do $$
declare
  n integer;
  body text;
begin
  -- Every remaining non-null value is supported by the ledger.
  select count(*) into n
    from public.matters m
   where m.conflict_cleared is not null
     and m.conflict_cleared is distinct from public.matter_conflict_covered(m.id);
  if n > 0 then
    raise exception '0032: % matter(s) still assert a clearance the ledger does not support', n;
  end if;

  -- The guard calls the function rather than restating the rule.
  select prosrc into body
    from pg_proc where proname = 'matter_conflict_guard';
  if body is null or position('matter_conflict_covered' in body) = 0 then
    raise exception '0032: the guard does not use matter_conflict_covered()';
  end if;
  if position('conflict_hits' in body) > 0 then
    raise exception '0032: the guard restates the coverage rule instead of calling it';
  end if;

  -- And the change-only semantics are in place, which is the defect this file was
  -- written for: without this, an unrelated UPDATE to a pre-existing matter raises.
  if position('is distinct from old.conflict_cleared' in body) = 0 then
    raise exception '0032: the guard still tests new.conflict_cleared unconditionally';
  end if;

  raise notice '0032 applied: one coverage rule, called from one guard, and no unsupported clearance on the record.';
end $$;
