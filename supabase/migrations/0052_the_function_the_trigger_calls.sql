-- ═══════════════════════════════════════════════════════════════════════════════
--  0052 · THE FUNCTION THE TRIGGER ACTUALLY CALLS
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  A NEAR MISS, ON THE ONE NIGHT IT COULD DO REAL DAMAGE.
--
--  The trigger is `matter_execution_gate`. The function it executes is
--  `matter_execution_guard`. 0049 replaced a function called `matter_execution_gate` — which
--  did not exist, so `create or replace` MADE one — and its verification asked
--  `pg_proc where proname = 'matter_execution_gate'`, which found the function it had just
--  written. Both the replacement and the check were satisfied by the same mistake, and the
--  live gate kept running the 0045 body: the rule it enforces was right, and the finality it
--  declares was still not recorded.
--
--  The live harness found it, because it asked the DATABASE what the register said after the
--  gate ran — `final_at is NULL` — rather than asking whether a function with a plausible
--  name existed. This is the second time in this project that a name one word away from the
--  right one has been accepted silently. The lesson this migration encodes is the check at
--  the bottom: **look the function up THROUGH THE TRIGGER**, since that is the only mapping
--  that decides what actually runs.
--
--  THE BODY BELOW IS THE LIVE ONE, TAKEN FROM THE CATALOGUE, WITH ONE LINE ADDED. Not a
--  retyped copy: `pg_get_functiondef` was read, the line inserted, and the result applied —
--  so everything else about the function (its refusal messages, which name the deed number;
--  the `and enforcement_status in (…)` guard on its own UPDATE) is exactly what was running.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · the function nothing called ─────────────────────────────────────────────
/*
  Dropped rather than left in place. A function with a name one word away from the live one is
  a trap for the next person: a `create or replace` aimed at the wrong name would succeed, do
  nothing, and verify clean. `drop function ... if exists` with no arguments, because a
  same-named overload would be the same problem wearing a different signature.
*/
drop function if exists public.matter_execution_gate();

-- ── 2 · the live body, plus the line ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.matter_execution_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $$
declare
  j              record;
  attempted      boolean;
  pending_appeal text;
begin
  /* The operative judgment. The same ordering as `operativeJudgment()` in the domain. */
  select * into j
    from public.judgments
   where matter_id = new.id
     and tenant_id = new.tenant_id
   order by pronounced_at desc, created_at desc
   limit 1;

  if not found then
    raise exception 'judgment_missing: no judgment is registered on this matter — record the صك and '
                    'its delivery before enforcement is considered'
      using errcode = 'check_violation';
  end if;

  if j.relief_kind = 'none' then
    raise exception 'judgment_not_enforceable: the operative judgment orders nothing that can be '
                    'executed (deed %)', j.deed_number
      using errcode = 'check_violation';
  end if;

  if j.service_effective_at is null then
    select exists (select 1 from public.service_events s where s.judgment_id = j.id) into attempted;
    if attempted then
      raise exception 'service_defective: the only service recorded for deed % did not take effect — '
                      'serve again lawfully, or apply for substituted service', j.deed_number
        using errcode = 'check_violation';
    end if;
    raise exception 'judgment_not_served: the judgment (deed %) has not been served on the party '
                    'enforcement is sought against, so no period has started to run', j.deed_number
      using errcode = 'check_violation';
  end if;

  if j.stay_in_force then
    raise exception 'execution_stayed: a stay of execution is in force against deed % — enforcement '
                    'may not begin while it stands', j.deed_number
      using errcode = 'check_violation';
  end if;

  select a.appeal_kind into pending_appeal
    from public.judgment_appeals a
   where a.judgment_id = j.id and a.status in ('filed','registered')
   limit 1;

  if pending_appeal is not null then
    raise exception 'appeal_pending: a % is filed and undecided against deed % — the matter is before '
                    'a court', pending_appeal, j.deed_number
      using errcode = 'check_violation';
  end if;

  if j.appealable and j.judgment_kind <> 'cassation'
     and (j.appeal_deadline_at is null or j.appeal_deadline_at > now())
  then
    raise exception 'appeal_window_open: the period for challenging deed % is still running (closes %)',
      j.deed_number, coalesce(to_char(j.appeal_deadline_at, 'YYYY-MM-DD'), 'never computed')
      using errcode = 'check_violation';
  end if;

  /* Admitted. The judgment follows the matter, so the register cannot disagree with it. */
  update public.judgments
     set enforcement_status = 'under_enforcement',
         enforcement_opened_at = coalesce(enforcement_opened_at, now()),
         /* THE FINALITY THE ADMISSION DECLARES IS WRITTEN AS IT IS DECLARED. The status column
            is a record of the judgment''s procedural position, and this UPDATE can lawfully
            move a judgment straight from awaiting_finality to under_enforcement — the edge
            ENFORCEMENT_TRANSITIONS gained with the reasoning beside it. Recording final_at
            here is what keeps the skipped state in the file rather than missing from it. */
         final_at = coalesce(final_at, now()),
         updated_at = now()
   where id = j.id
     and enforcement_status in ('enforceable','awaiting_finality','stayed');

  return new;
end $$;

-- ── 3 · VERIFY, THROUGH THE TRIGGER ─────────────────────────────────────────────
do $$
declare
  fn text;
  src text;
  attached integer;
begin
  /* WHICH FUNCTION RUNS is a fact about the trigger, and this is the only way to ask it. */
  select p.proname into fn
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    join pg_class c on c.oid = t.tgrelid
   where c.relname = 'matters' and t.tgname = 'matter_execution_gate' and not t.tgisinternal;
  if fn is null then
    raise exception '0052: no trigger matter_execution_gate on matters';
  end if;
  if fn <> 'matter_execution_guard' then
    raise exception '0052: the gate trigger calls %, which is not the guard this migration patched', fn;
  end if;

  select prosrc into src from pg_proc where proname = 'matter_execution_guard';
  if position('final_at = coalesce(final_at, now())' in src) = 0 then
    raise exception '0052: the function the trigger calls still does not record finality';
  end if;
  /* And the rule it enforces is untouched — the refusals still name the deed. */
  if position('appeal_window_open' in src) = 0 or position('j.deed_number' in src) = 0 then
    raise exception '0052: the guard lost part of itself in the patch';
  end if;

  /* No orphan left behind. */
  select count(*) into attached from pg_proc where proname = 'matter_execution_gate';
  if attached <> 0 then
    raise exception '0052: a function named matter_execution_gate still exists';
  end if;

  raise notice '0052 applied: the gate now records the finality it declares.';
end $$;
