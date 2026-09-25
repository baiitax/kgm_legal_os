-- ═══════════════════════════════════════════════════════════════════════════════
-- 0043 · THE OWNER IS A PERSON, AND THE RECORDS ARE KEPT
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- TWO CORRECTIONS, FOUND BY RUNNING THE PHASE AGAINST THE DEPLOYED SYSTEM RATHER THAN
-- AGAINST SQLITE, AND ONE DECISION THE PHASE HAD LEFT IMPLICIT.
--
-- WHY A NEW MIGRATION INSTEAD OF AN EDIT TO 0040. 0040 has been applied. A migration that
-- has run is a fact about every database it ran against; rewriting it would leave those
-- environments unable to say what they contain, and the next reader unable to tell a
-- correction from the original design. The security-definer function below is replaced
-- wholesale, which is what a gate this important deserves: the current rule in one place,
-- readable in one sitting.
--
-- ── 1 · A BENEFICIAL OWNER IS A NATURAL PERSON ─────────────────────────────────
--
-- The 25% rule is about PEOPLE. A company that owns a company is a layer of the
-- structure, and the obligation is to look through it until people appear — which is why
-- the FATF glossary defines a beneficial owner as a natural person, and why the manual
-- attaches the identification duty to "the natural person who ultimately owns or
-- controls".
--
-- 0040 counted any verified row with `control_basis = 'ownership'` toward the threshold.
-- A Jersey holding company recorded at 100% therefore satisfied the rule on paper, and
-- the gate ADMITTED a client whose owner is nobody the firm has identified. The SQLite
-- mirror and the TypeScript domain both refuse that case, so the two engines disagreed
-- about the most consequential question in this phase — and the disagreement was
-- invisible to every check in the phase except actually running it live. All three now
-- say the same thing:
--
--     only verified NATURAL PERSONS contribute a percentage,
--     only a verified NATURAL PERSON holds a control right that counts.
--
-- ── 2 · A SUBJECT IS A SUBJECT BEFORE THE PAPERWORK IS IN ──────────────────────
--
-- The subject set — who has to be screened — was filtered on `verified_at is not null`.
-- That made the screening obligation depend on the document collection, in the direction
-- that matters least: an owner at 40% whose share certificate had not arrived was never
-- screened AND never reported as unscreened, so a file with a real gap read as complete.
-- Screening is cheap; being designated does not stop because a file is thin. The subject
-- set is now the client plus every natural-person owner at or above the threshold, or
-- holding a control right, VERIFIED OR NOT — which is what `screeningSubjects()` in
-- `server/src/domain/aml.ts` has said since it was written.
--
-- ── 3 · RETENTION, AS A FACT ABOUT THE DATA ───────────────────────────────────
--
-- Royal Decree M/20 requires these records to be kept for ten years. Until now the
-- system's answer was an absent privilege — `firm_api` holds no DELETE on the six tables
-- — which is half an answer. A privilege can be granted by a later migration nobody
-- thinks about; a trigger can be dropped by a superuser before an offboarding script runs
-- in a hurry. Both halves are needed, so the guards below refuse the delete in the
-- database's own words, on the same principle as the filed report and the issued invoice:
-- the record of what the firm knew on a date is not current state to be corrected, and a
-- record corrected by deletion is a record nobody can rely on.
--
-- A PURGE AFTER TEN YEARS IS AN OPERATOR ACTION — disabling these guards deliberately,
-- with the reason written down. The refusal messages are what make that a decision
-- instead of an accident.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1+2 · THE GATE, RESTATED IN ONE PLACE ───────────────────────────────────────
create or replace function public.matter_cdd_gate() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dd   public.client_due_diligence;
  v_kind text;
  v_owners boolean;
  v_subjects integer;
  v_screened integer;
begin
  if not (new.internal_status = 'active' and old.internal_status is distinct from 'active') then
    return new;
  end if;

  select * into v_dd
    from public.client_due_diligence d
   where d.tenant_id = new.tenant_id
     and d.client_id = new.client_id
     and d.superseded_by is null;

  -- (1) No record at all.
  if not found then
    raise exception 'cdd_missing: no client due diligence has been recorded for this client'
      using errcode = 'check_violation';
  end if;

  -- (2) The prohibition the manual is clearest about, and it comes first: due diligence
  --     that could not be completed means the firm may not act, at all.
  if v_dd.status = 'unable_to_complete' then
    raise exception 'cdd_unable_to_complete: customer due diligence could not be completed for this client — the firm may not act (AML Law, M/20)'
      using errcode = 'check_violation';
  end if;

  -- (3) A record that exists and has not been finished.
  if v_dd.status <> 'complete' then
    raise exception 'cdd_incomplete: this client''s due diligence is % — a matter may not be opened on an unidentified client', v_dd.status
      using errcode = 'check_violation';
  end if;

  -- (4) Enhanced due diligence with nobody named to accept the risk.
  if v_dd.cdd_level = 'enhanced' and v_dd.senior_approved_by_membership_id is null then
    raise exception 'senior_approval_required: enhanced due diligence requires a named senior approver'
      using errcode = 'check_violation';
  end if;

  -- (5) A PEP whose process was not raised to meet the determination.
  if v_dd.pep_status is not null and v_dd.pep_status <> 'not_pep' and v_dd.cdd_level <> 'enhanced' then
    raise exception 'senior_approval_required: this client is a politically exposed person — due diligence must be enhanced and approved by senior management'
      using errcode = 'check_violation';
  end if;

  -- (6) A review that has fallen due is a record nobody has looked at since.
  if v_dd.review_due_at is not null and v_dd.review_due_at < now() then
    raise exception 'cdd_review_overdue: this client''s due diligence was due for review on %', v_dd.review_due_at
      using errcode = 'check_violation';
  end if;

  /* (7) The persons behind a legal person: ONLY PEOPLE COUNT. */
  select c.client_type into v_kind from public.clients c where c.id = new.client_id;
  if v_kind is distinct from 'individual' then
    select (
      coalesce((select sum(bo.ownership_pct) from public.beneficial_owners bo
                 where bo.dd_id = v_dd.id
                   and bo.control_basis = 'ownership'
                   and bo.owner_kind = 'natural_person'
                   and bo.verified_at is not null), 0) >= 25
      or exists (select 1 from public.beneficial_owners bo
                  where bo.dd_id = v_dd.id
                    and bo.control_basis <> 'ownership'
                    and bo.owner_kind = 'natural_person'
                    and bo.verified_at is not null)
    ) into v_owners;
    if not v_owners then
      raise exception 'cdd_beneficial_owner_missing: the persons who control this client have not been identified to the 25%% threshold, and no control right is recorded'
        using errcode = 'check_violation';
    end if;
  end if;

  /* (8) Every person in the relationship, screened, resolved, and not designated — the
         subject set independent of whether the paperwork has been verified. */
  with subjects as (
    select 'client'::text as kind, new.client_id as id
    union all
    select 'beneficial_owner'::text, bo.id
      from public.beneficial_owners bo
     where bo.dd_id = v_dd.id
       and bo.owner_kind = 'natural_person'
       and (coalesce(bo.ownership_pct, 0) >= 25 or bo.control_basis <> 'ownership')
  )
  select count(*) into v_subjects from subjects;

  with subjects as (
    select 'client'::text as kind, new.client_id as id
    union all
    select 'beneficial_owner'::text, bo.id
      from public.beneficial_owners bo
     where bo.dd_id = v_dd.id
       and bo.owner_kind = 'natural_person'
       and (coalesce(bo.ownership_pct, 0) >= 25 or bo.control_basis <> 'ownership')
  )
  select count(*) into v_screened
    from subjects s
   where exists (
     select 1 from public.screening_runs r
      where r.tenant_id = new.tenant_id
        and r.subject_kind = s.kind and r.subject_id = s.id
        and r.status <> 'failed'
        and not exists (select 1 from public.screening_matches m
                         where m.run_id = r.id and m.disposition = 'open'));

  if v_screened < v_subjects then
    raise exception 'screening_incomplete: % of % persons in this relationship have an unresolved or failed screening',
      (v_subjects - v_screened), v_subjects
      using errcode = 'check_violation';
  end if;

  -- (9) A confirmed designation is the end of the matter rather than a risk to weigh.
  if exists (
    select 1 from public.screening_matches m
      join public.screening_runs r on r.id = m.run_id
     where r.tenant_id = new.tenant_id
       and m.disposition = 'true_match'
       and ((r.subject_kind = 'client' and r.subject_id = new.client_id)
            or (r.subject_kind = 'beneficial_owner'
                and r.subject_id in (select bo.id from public.beneficial_owners bo where bo.dd_id = v_dd.id))))
  then
    raise exception 'sanctions_match: a confirmed designation is recorded for a person in this relationship — the relationship may not be established'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists matters_cdd_gate on public.matters;
create trigger matters_cdd_gate
  before update on public.matters
  for each row execute function public.matter_cdd_gate();

-- ── 3 · RETENTION ───────────────────────────────────────────────────────────────
create or replace function public.guard_aml_retention() returns trigger
language plpgsql as $$
begin
  raise exception '%: %', tg_argv[0], tg_argv[1]
    using errcode = 'check_violation';
end $$;

do $$
declare
  spec text[][] := array[
    ['client_due_diligence', 'a due-diligence record is kept for ten years (AML Law M/20) — correct it with a new version, never by deletion'],
    ['beneficial_owners', 'a beneficial owner is part of the identification record and is kept for ten years (AML Law M/20)'],
    ['screening_runs', 'a screening is evidence of what was checked, and is kept for ten years (AML Law M/20)'],
    ['screening_matches', 'a name hit and its disposition are kept for ten years (AML Law M/20)'],
    ['str_reports', 'a report to SAFIU is kept for ten years (AML Law M/20)'],
    ['aml_risk_countries', 'a jurisdiction risk listing is dated, not deleted — a risk assessment reads the list that was in force on the date it was made']
  ];
  row_spec text[];
begin
  foreach row_spec slice 1 in array spec loop
    execute format('drop trigger if exists %I on public.%I', row_spec[1] || '_retention', row_spec[1]);
    execute format(
      'create trigger %I before delete on public.%I for each row execute function public.guard_aml_retention(%L, %L)',
      row_spec[1] || '_retention', row_spec[1], 'aml_record_retention', row_spec[2]);
  end loop;
end $$;

comment on function public.guard_aml_retention() is
  'Refuses DELETE on the due-diligence tables. Retention (AML Law M/20, ten years) is a property of the records, not only an absent privilege: the privilege can be granted again, and a trigger has to be dropped deliberately.';

-- ── 4 · VERIFY ──────────────────────────────────────────────────────────────────
do $$
declare
  body text;
  n integer;
begin
  -- The gate carries the natural-person rule in all three places it appears.
  select prosrc into body from pg_proc where proname = 'matter_cdd_gate';
  if body is null then
    raise exception '0043: matters_cdd_gate is missing';
  end if;
  n := (select count(*) from regexp_matches(body, 'owner_kind = ''natural_person''', 'g'));
  if n < 4 then
    raise exception '0043: the gate names the natural-person rule % time(s); it must appear in the ownership sum, the control-right check and both subject sets', n;
  end if;
  if body like '%bo.verified_at is not null%' and n < 4 then
    raise exception '0043: the gate still conditions the subject set on verification';
  end if;

  -- The guards are installed, one per table, all refusing with the same vocabulary.
  select count(*) into n
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal
     and c.relname in ('client_due_diligence','beneficial_owners','screening_runs',
                       'screening_matches','str_reports','aml_risk_countries')
     and t.tgname like '%_retention';
  if n <> 6 then
    raise exception '0043: % of the six retention guards are installed', n;
  end if;

  -- And the privilege half still holds: one rule, two mechanisms.
  select count(*) into n
    from information_schema.table_privileges
   where table_schema = 'public' and grantee = 'firm_api' and privilege_type = 'DELETE'
     and table_name in ('client_due_diligence','beneficial_owners','screening_runs',
                        'screening_matches','str_reports','aml_risk_countries');
  if n <> 0 then
    raise exception '0043: firm_api holds DELETE on % of the AML tables', n;
  end if;

  raise notice '0043 applied: only people are owners, every subject is screened, and the record of what the firm knew is kept.';
end $$;
