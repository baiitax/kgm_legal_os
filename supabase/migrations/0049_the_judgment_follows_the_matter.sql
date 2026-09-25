-- ═══════════════════════════════════════════════════════════════════════════════
--  0049 · THE EDGE THE MATRIX WAS MISSING, AND THE FINALITY IT DECLARES
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  Found by writing the phase's own test and walking a matter into execution: the gate
--  admitted it, and the judgment's own guard then refused the write the gate made.
--
--      enforcement_transition_invalid: a judgment cannot move from awaiting_finality to
--      under_enforcement
--
--  0045's matrix allowed `awaiting_finality → enforceable` and `enforceable →
--  under_enforcement`, and nothing in the system moved a judgment from the first to the
--  second. So a judgment whose period had closed, which was served, unstayed and
--  unchallenged — admissible in every particular — could not actually be enforced, because
--  its row was still waiting for a state nobody had set.
--
--  THAT IS THE WRONG WAY ROUND FOR A GATE TO FAIL. The matrix is there to stop mistakes
--  about finality, not to require a data-entry step before a court order can be executed.
--
--  `awaiting_finality → under_enforcement` is therefore allowed, and it is safe because of
--  WHO TAKES IT. Only the enforcement gate, and only after it has checked every condition:
--  a judgment exists, it orders something, it was served, the service took effect, it is
--  not stayed, no challenge is pending, and the period for challenging it has closed.
--
--  AND THE GATE NOW WRITES THE FINALITY IT DECLARED. It sets `final_at` when the row has
--  none, in the same UPDATE that opens enforcement. The state the matrix skips is not
--  erased from the file — it is recorded at the moment it becomes true. The rest of the
--  matrix is untouched, including the edges that protect against real error:
--  `under_enforcement → enforceable` remains impossible, and `satisfied` remains terminal.
--
--  The domain's `ENFORCEMENT_TRANSITIONS` and the SQLite mirror carry the same edge and the
--  same reasoning; all three are diffed by tests/security/judgments-and-service.test.ts.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── the matrix, widened by exactly one edge ─────────────────────────────────────
create or replace function public.guard_enforcement_state() returns trigger
language plpgsql as $$
declare
  allowed boolean;
begin
  if new.enforcement_status is not distinct from old.enforcement_status then
    return new;
  end if;

  allowed := case old.enforcement_status
    when 'not_enforceable'   then new.enforcement_status in ('awaiting_finality')
    /* The one edge 0045 did not have: the gate may open enforcement on a judgment whose
       period closed while the record still said the matter was waiting for finality. */
    when 'awaiting_finality' then new.enforcement_status in ('enforceable','stayed','not_enforceable','under_enforcement')
    when 'enforceable'       then new.enforcement_status in ('under_enforcement','stayed','not_enforceable')
    when 'stayed'            then new.enforcement_status in ('enforceable','awaiting_finality','not_enforceable')
    when 'under_enforcement' then new.enforcement_status in ('satisfied','closed','stayed')
    when 'satisfied'         then false
    when 'closed'            then new.enforcement_status in ('awaiting_finality')
    else false
  end;

  if not allowed then
    raise exception 'enforcement_transition_invalid: a judgment cannot move from % to %',
      old.enforcement_status, new.enforcement_status
      using errcode = 'check_violation';
  end if;

  if new.enforcement_status = 'satisfied' and new.satisfied_at is null then
    raise exception 'enforcement_transition_invalid: a satisfied judgment carries the date it was '
                    'satisfied' using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- ── the gate, which now records the finality it declares ────────────────────────
create or replace function public.matter_execution_gate() returns trigger
language plpgsql as $$
declare
  operative_id uuid;
begin
  if not (new.internal_status = 'execution' and old.internal_status is distinct from 'execution') then
    return new;
  end if;

  select j.id into operative_id
    from public.judgments j
   where j.matter_id = new.id and j.tenant_id = new.tenant_id
   order by j.pronounced_at desc, j.created_at desc
   limit 1;

  /* 1 · there is no judgment */
  if operative_id is null then
    raise exception 'judgment_missing: no judgment is registered on this matter — record the صك '
                    'and its delivery before enforcement is considered'
      using errcode = 'check_violation';
  end if;

  /* 2 · nothing to execute */
  if exists (select 1 from public.judgments j
              where j.id = operative_id and j.relief_kind = 'none') then
    raise exception 'judgment_not_enforceable: the operative judgment orders nothing that can be '
                    'executed' using errcode = 'check_violation';
  end if;

  /* 3 · not served */
  if exists (select 1 from public.judgments j
              where j.id = operative_id and j.service_effective_at is null) then
    raise exception 'judgment_not_served: the judgment has not been served on the party enforcement '
                    'is sought against, so no period has started to run'
      using errcode = 'check_violation';
  end if;

  /* 4 · an attempt that did not take effect */
  if exists (select 1 from public.service_events s
              where s.judgment_id = operative_id and s.effective_at is null) then
    raise exception 'service_defective: the only service recorded for this judgment did not take '
                    'effect — serve again lawfully, or apply for substituted service'
      using errcode = 'check_violation';
  end if;

  /* 5 · a court said stop */
  if exists (select 1 from public.judgments j
              where j.id = operative_id and j.stay_in_force) then
    raise exception 'execution_stayed: a stay of execution is in force against this judgment — '
                    'enforcement may not begin while it stands'
      using errcode = 'check_violation';
  end if;

  /* 6 · a challenge is pending */
  if exists (select 1 from public.judgment_appeals a
              where a.judgment_id = operative_id and a.status in ('filed','registered')) then
    raise exception 'appeal_pending: a challenge is filed and undecided against this judgment — '
                    'the matter is before a court'
      using errcode = 'check_violation';
  end if;

  /* 7 · the period is still running */
  if exists (select 1 from public.judgments j
              where j.id = operative_id
                and j.appealable
                and j.judgment_kind <> 'cassation'
                and (j.appeal_deadline_at is null or j.appeal_deadline_at > now())) then
    raise exception 'appeal_window_open: the period for challenging this judgment is still running'
      using errcode = 'check_violation';
  end if;

  /* Admitted. The judgment follows the matter, and the finality being declared is written
     down as it is declared — see the note at the head of this migration. */
  update public.judgments
     set enforcement_status = 'under_enforcement',
         enforcement_opened_at = coalesce(enforcement_opened_at, now()),
         final_at = coalesce(final_at, now()),
         updated_at = now()
   where id = operative_id;

  return new;
end $$;

-- ── VERIFY ─────────────────────────────────────────────────────────────────────
do $$
declare
  src text;
begin
  select prosrc into src from pg_proc where proname = 'guard_enforcement_state';
  if src is null then
    raise exception '0049: the matrix guard is not in the database';
  end if;
  if position('''awaiting_finality'' then new.enforcement_status in (''enforceable'',''stayed'',''not_enforceable'',''under_enforcement'')' in src) = 0 then
    raise exception '0049: the edge was not applied to the matrix';
  end if;
  /* The protective edges must still be absent. Asserted by their absence from the source,
     because a widened matrix that also admitted these would pass every functional test. */
  if position('when ''satisfied''         then false' in src) = 0 then
    raise exception '0049: the terminal state stopped being terminal';
  end if;

  select prosrc into src from pg_proc where proname = 'matter_execution_gate';
  if position('final_at = coalesce(final_at, now())' in src) = 0 then
    raise exception '0049: the gate no longer records the finality it declares';
  end if;

  raise notice '0049 applied: enforcement may open on a judgment whose period closed while the record still said it was waiting.';
end $$;
