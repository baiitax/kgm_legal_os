-- ═══════════════════════════════════════════════════════════════════════════════
--  0053 · THE ENFORCEMENT THAT DECLARES ITSELF FINAL
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  WHAT 0052 LEFT BEHIND.
--
--  0052 repaired the function the gate actually calls, so from that moment every
--  admission records `final_at` as well as opening enforcement. It could not repair the
--  rows admitted BEFORE it — the days when the trigger ran 0045's body, which opened
--  enforcement and said nothing about finality. Read off the live register:
--
--      enforcement_status  final_at    rows
--      awaiting_finality   NULL         5
--      under_enforcement   NULL         1   ← opened while the old body was running
--      under_enforcement   set          2   ← opened after 0052
--
--  One row is not the point. The point is that NOTHING IN THE SCHEMA FORBADE IT. 0045
--  wrote this beside the lifecycle:
--
--      check (enforcement_status <> 'under_enforcement' or enforcement_opened_at is not null)
--
--  — enforcement that never opened cannot be under way — and wrote no twin saying that
--  enforcement under way cannot have skipped the finality that admits it. So a row could
--  reach `under_enforcement` and, in the same statement, lose the fact that the register
--  exists to record: the moment the judgment became final. An enforcement with no final
--  date is a file that cannot answer the first question a court asks.
--
--  THIS MIGRATION DOES TWO THINGS:
--    1 · repairs the rows the old body left, using THE GATE'S OWN RULE to derive the date
--        it should have written;
--    2 · adds the missing twin of 0045's check, so the state can never be entered without
--        its declaration again — by the gate, by a route, or by an operator at a psql
--        prompt at two in the morning.
--
--  The repair derives, and says so. `final_at` is `now()` when the gate admits, because
--  the gate can only know the moment it acted. For a row that was admitted at some
--  unrecorded point in the past, `now()` would be a comfortable lie: it would say the
--  judgment became final today. The truthful value is the one the admission PRESUPPOSED —
--  the appeal deadline that had passed, or, for a judgment no appeal lies from, the day it
--  was served.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · the rows the old body left under enforcement with no finality ───────────
/*
  The three-way case is the gate's own reasoning, read backwards:
    · an appealable judgment that is not the last instance became final when its period
      closed — and the gate will not admit it before then, so the deadline is in the past;
    · a cassation judgment is not waiting on a period it can spend (the gate skips the
      window check for it), so finality follows service;
    · anything else — not appealable at all — became final when it was served.
  `created_at` is the last resort and is never reached on a row the gate admitted, because
  the gate requires `service_effective_at` before it will look at anything else.
*/
update public.judgments
   set final_at = case
         when appealable
              and judgment_kind <> 'cassation'
              and appeal_deadline_at is not null
           then appeal_deadline_at
         else coalesce(service_effective_at, enforcement_opened_at, created_at)
       end,
       updated_at = now()
 where enforcement_status = 'under_enforcement'
   and final_at is null;

-- ── 2 · the twin of 0045's check ────────────────────────────────────────────────
/*
  Dropped first so the migration is re-runnable, in the same shape 0045 used for its
  sibling: an enforcement under way carries the finality that admitted it.
*/
alter table public.judgments
  drop constraint if exists judgments_enforcement_carries_finality;

alter table public.judgments
  add constraint judgments_enforcement_carries_finality
  check (enforcement_status <> 'under_enforcement' or final_at is not null);

-- ── 3 · VERIFY, AND TRY TO BREAK IT ─────────────────────────────────────────────
do $$
declare
  cdef     text;
  left_over integer;
  target   uuid;
  refused  boolean := false;
begin
  /* The constraint is present and says what it is supposed to say. */
  select pg_get_constraintdef(oid) into cdef
    from pg_constraint
   where conname = 'judgments_enforcement_carries_finality'
     and conrelid = 'public.judgments'::regclass;
  if cdef is null then
    raise exception '0053: the check was not created on public.judgments';
  end if;
  if position('under_enforcement' in cdef) = 0 or position('final_at' in cdef) = 0 then
    raise exception '0053: the check does not mention what it is meant to constrain: %', cdef;
  end if;

  /* And nothing in the register still violates it. */
  select count(*) into left_over
    from public.judgments
   where enforcement_status = 'under_enforcement' and final_at is null;
  if left_over <> 0 then
    raise exception '0053: % judgment(s) are under enforcement with no finality recorded', left_over;
  end if;

  /* THE CHECK IS PROVEN BY BEING REFUSED, not by existing. Take a real row that is under
     enforcement and try to take its finality away; the database must say no. The whole
     attempt runs inside a handled block, so the savepoint rolls it back either way. */
  select id into target
    from public.judgments
   where enforcement_status = 'under_enforcement'
   limit 1;

  if target is not null then
    begin
      update public.judgments set final_at = null, updated_at = now() where id = target;
      /* Reached only if the database allowed it. Not a check_violation, so the handler
         below does not swallow this one: the migration fails. */
      raise exception '0053: the register accepted an enforcement with no finality recorded';
    exception
      when check_violation then refused := true;
    end;

    if not refused then
      raise exception '0053: the register accepted an enforcement with no finality recorded';
    end if;
  end if;

  raise notice '0053 applied: % row(s) repaired; enforcement now carries the finality it declares (%)',
    left_over, coalesce(cdef, 'constraint absent');
end $$;
