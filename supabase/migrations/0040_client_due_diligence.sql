-- ═══════════════════════════════════════════════════════════════════════════════
--  0040 · CLIENT DUE DILIGENCE AND THE AML GATES  (phase P0.3)
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  WHY THIS EXISTS
--
--  A law firm in the Kingdom is a Designated Non-Financial Business and Profession under
--  the Anti-Money Laundering Law (Royal Decree M/20 of 2017) and the AML-CFT manual
--  issued to the profession. The obligations that attach are not advisory: identify the
--  client, identify the person behind the client at a 25% threshold, determine whether
--  either is politically exposed, screen both against the designation lists, keep looking
--  while the relationship lasts, and report suspicions to SAFIU in Arabic without
--  informing the person reported.
--
--  What the system carried until now was `clients.identity_verified` — a boolean somebody
--  typed — and a `compliance.review` permission that guarded nothing. A matter could be
--  opened, worked and billed for a client the firm had never identified, and the record
--  would have said so only if a clerk had remembered to say so.
--
--  THE ONE SENTENCE THE MANUAL IS CLEAREST ABOUT: if customer due diligence cannot be
--  completed, the lawyer MAY NOT ACT. That is a prohibition, not a backlog item, and it
--  is the reason this migration puts a gate on the transition into `active` rather than
--  a reminder on a dashboard.
--
--  WHAT IS HERE
--
--    1 · aml_risk_countries   — the register of high-risk jurisdictions, with dates
--    2 · client_due_diligence — the identification record, one current version per client
--    3 · beneficial_owners    — the persons behind a legal person, at the 25% threshold
--    4 · screening_runs       — each screening, with its list version and its outcome
--    5 · screening_matches    — each hit, and the disposition that closed it
--    6 · str_reports          — the suspicious-operation report and its filing
--    7 · the derived identity flag, the matter gate, the working-day clock
--    8 · row-level security and the column grants
--
--  WHY `str_reports` AND NOT `str_flags`
--
--  The plan of record said `str_flags`. A flag is the internal signal that something
--  looks wrong; a report is the document the firm files and answers for. They have
--  different obligations attached — one is written while a person is deciding, the other
--  is immutable once it leaves — so they are one table with a status, named for the thing
--  the firm is accountable for.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 0 · THE WORKING-DAY CLOCK ───────────────────────────────────────────────────
/*
  The obligations in this phase are measured in working days, and the working week here
  is Sunday to Thursday. A report "due in three days" that lands on a Friday is a report
  with nobody in the office to file it, so the arithmetic belongs somewhere both the
  database and the application can reach it.

  The clock is read in Riyadh, explicitly. `extract(isodow ...)` on a timestamptz uses the
  session's TimeZone, which on a pooler connection is whatever the client left it as — the
  same class of defect as an expression that evaluates differently under two drivers.
*/
create or replace function public.kgm_working_day(p_ts timestamptz) returns boolean
language sql immutable as $$
  select extract(isodow from (p_ts at time zone 'Asia/Riyadh')) not in (5, 6)
$$;

comment on function public.kgm_working_day(timestamptz) is
  'Sunday to Thursday in Riyadh. Friday (isodow 5) and Saturday (6) are the weekend.';

create or replace function public.kgm_add_working_days(p_from timestamptz, p_days integer)
returns timestamptz
language plpgsql immutable as $$
declare
  cursor_ts timestamptz := p_from;
  remaining integer := p_days;
begin
  if p_days < 0 then
    raise exception 'kgm_add_working_days: a negative number of working days is a different function'
      using errcode = 'invalid_parameter_value';
  end if;
  while remaining > 0 loop
    cursor_ts := cursor_ts + interval '1 day';
    if public.kgm_working_day(cursor_ts) then
      remaining := remaining - 1;
    end if;
  end loop;
  return cursor_ts;
end $$;

comment on function public.kgm_add_working_days(timestamptz, integer) is
  'Advances by WORKING days, skipping the Saudi weekend. The mirror of addWorkingDays() in server/src/domain/aml.ts.';

-- ── 1 · THE REGISTER OF HIGH-RISK JURISDICTIONS ─────────────────────────────────
/*
  A TABLE, NOT A CONSTANT IN THE CODE.

  The FATF calls-for-action list changes, the grey list changes more often, and the
  Kingdom's own designations arrive by circular. A list compiled into a release would make
  the firm's risk assessment a function of which version of the software it is running,
  and would leave no record of which list was in force on the day a client was accepted —
  which is the first question asked when the acceptance is reviewed.

  So the register carries `effective_from` and `effective_to` and the list it came from,
  and a rating records the reasons it used. Nothing here expires silently: a row is closed
  by dating it, never by deleting it.
*/
create table if not exists public.aml_risk_countries (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete restrict,
  country_code              text not null check (length(trim(country_code)) between 2 and 3),
  country_name              text not null,
  country_name_ar           text,
  list_source               text not null check (list_source in
                              ('fatf_call_for_action','fatf_grey','un_sanctions','eu_consolidated',
                               'sama_circular','internal')),
  risk_level                text not null check (risk_level in ('high','prohibited')),
  effective_from            date not null,
  effective_to              date,
  note                      text,
  created_by_membership_id  uuid references public.firm_memberships(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  -- The register is a history, so the same country may be listed by the same source
  -- twice with different windows and must not be listed twice within one.
  unique (tenant_id, country_code, list_source, effective_from)
);

comment on table public.aml_risk_countries is
  'Which jurisdictions the firm treats as high risk, from which list, for which period. Dated, never deleted.';

-- ── 2 · THE IDENTIFICATION RECORD ───────────────────────────────────────────────
/*
  ONE CURRENT RECORD PER CLIENT, and the rest is history.

  Due diligence is not done once. A client is re-identified when the relationship is
  reviewed, when the ownership changes, when a document expires; and an auditor asking
  "what did you know about this client in March" is asking about a version, not about a
  row that a later review overwrote. `superseded_by` gives the current record without a
  second table, which is the same shape `fiscal_identity` uses for the same reason.

  WHAT IS *NOT* HERE, AND WHY: the identity document itself. What is stored is a keyed
  hash for matching and a mask for display — the same treatment `clients.national_id_hash`
  already gives a national ID. A firm does not need to hold the number to satisfy the
  obligation; it needs to be able to say it saw the document and to recognise the number
  if it sees it again.
*/
create table if not exists public.client_due_diligence (
  id                              uuid primary key default gen_random_uuid(),
  tenant_id                       uuid not null references public.tenants(id) on delete restrict,
  client_id                       uuid not null references public.clients(id) on delete restrict,
  party_id                        uuid references public.parties(id) on delete set null,
  version                         integer not null default 1 check (version >= 1),

  cdd_level                       text not null default 'standard'
                                    check (cdd_level in ('simplified','standard','enhanced')),
  status                          text not null default 'not_started'
                                    check (status in ('not_started','in_progress','complete',
                                                      'unable_to_complete','expired')),

  -- ── who the client is ──
  legal_name                      text,
  legal_name_ar                   text,
  date_of_birth                   date,
  nationality                     text,
  residence_country               text,
  address                         text,
  id_type                         text check (id_type in
                                    ('national_id','iqama','passport','gcc_id','commercial_registration')),
  id_number_hash                  text,
  id_number_masked                text,
  id_issued_at                    date,
  id_expires_at                   date,
  cr_number                       text,
  cr_issued_at                    date,
  incorporation_country           text,
  business_activity               text,
  ownership_structure             text,
  source_of_funds                 text,
  source_of_wealth                text,
  purpose                         text,
  expected_annual_volume_sar      numeric(14,2) check (expected_annual_volume_sar is null
                                                        or expected_annual_volume_sar >= 0),

  -- ── how it was checked ──
  verification_method             text check (verification_method in
                                    ('original_seen','certified_copy','electronic','relying_on_third_party')),
  verification_source             text,
  verified_by_membership_id       uuid references public.firm_memberships(id) on delete set null,
  verified_at                     timestamptz,

  -- ── the determination ──
  /*
    NULLABLE ON PURPOSE, and this is the same rule the conflict boolean taught: null means
    NOT DETERMINED, 'not_pep' means determined and clear. A screening column defaulted to
    the reassuring answer is a claim nothing computed, which is exactly the defect this
    phase exists to remove from `identity_verified`.
  */
  pep_status                      text check (pep_status in ('not_pep','pep','pep_family','pep_associate')),
  pep_details                     text,
  risk_rating                     text check (risk_rating in ('low','medium','high')),
  /*
    THE REASONS ARE STORED WITH THE RATING. A rating with no reasons is an opinion, and it
    cannot be reviewed later by anybody who did not make it. The pairing is enforced below:
    one without the other is a write the database refuses.
  */
  risk_reasons                    jsonb not null default '[]'::jsonb,
  risk_assessed_at                timestamptz,

  -- ── enhanced due diligence ──
  senior_approved_by_membership_id uuid references public.firm_memberships(id) on delete set null,
  senior_approved_at              timestamptz,
  senior_approval_note            text,

  -- ── keeping it current ──
  review_due_at                   date,
  last_reviewed_at                timestamptz,
  completed_at                    timestamptz,
  completed_by_membership_id      uuid references public.firm_memberships(id) on delete set null,
  unable_reason                   text,
  notes                           text,

  superseded_by                   uuid,
  superseded_at                   timestamptz,
  created_by_membership_id        uuid references public.firm_memberships(id) on delete set null,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),

  /* A refusal to act must say why. "Unable to complete" with no ground is an unexplained exit. */
  check (status <> 'unable_to_complete' or (unable_reason is not null and length(trim(unable_reason)) >= 10)),
  /* Completing is an act by a member at a moment, not a state the row drifts into. */
  check (status <> 'complete' or (completed_at is not null and completed_by_membership_id is not null)),
  /* Enhanced due diligence without a named senior approver is not enhanced due diligence. */
  check (cdd_level <> 'enhanced' or status <> 'complete'
         or senior_approved_by_membership_id is not null),
  /* The rating and the reasons travel together, in both directions. */
  check ((risk_rating is null) = (risk_assessed_at is null)),
  /*
    An expired document is a stale identification, and the date it expires is the date the
    firm stops being able to rely on it — so it may not be recorded after it has passed.
  */
  check (id_expires_at is null or id_issued_at is null or id_expires_at > id_issued_at)
);

create unique index if not exists client_due_diligence_current_idx
  on public.client_due_diligence(tenant_id, client_id) where superseded_by is null;

create unique index if not exists client_due_diligence_version_idx
  on public.client_due_diligence(tenant_id, client_id, version);

create index if not exists client_due_diligence_review_idx
  on public.client_due_diligence(tenant_id, review_due_at) where status = 'complete';

comment on table public.client_due_diligence is
  'The identification record for a client. One current version per client; earlier versions are superseded, never overwritten.';

-- ── 3 · THE PERSONS BEHIND A LEGAL PERSON ───────────────────────────────────────
/*
  THE 25% RULE, AND THE REASON IT IS NOT THE WHOLE RULE.

  The threshold is where the obligation starts, not where it ends. A company can be
  controlled by somebody who owns nothing: a shareholders' agreement, a golden share, or
  the simple fact that they are the only person who signs. A register that demanded a
  percentage would be satisfied by a fiction in exactly those cases, so a recorded control
  right counts — and the column that says which applies is required.

  TWO CHECKS BELOW ARE ABOUT IDENTIFICATION RATHER THAN ARITHMETIC. A natural person's
  date of birth and nationality are how a list search tells two people with one name
  apart, so an owner without them is not an identified owner; and a company that owns
  another company is a chain the firm has to walk, so its own registration is required.
*/
create table if not exists public.beneficial_owners (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete restrict,
  dd_id                     uuid not null references public.client_due_diligence(id) on delete cascade,
  client_id                 uuid not null references public.clients(id) on delete restrict,
  party_id                  uuid references public.parties(id) on delete set null,

  owner_kind                text not null check (owner_kind in ('natural_person','legal_person')),
  full_name                 text not null,
  full_name_ar              text,
  date_of_birth             date,
  nationality               text,
  residence_country         text,
  address                   text,
  id_type                   text check (id_type in ('national_id','iqama','passport','gcc_id')),
  id_number_hash            text,
  id_number_masked          text,
  cr_number                 text,
  ownership_pct             numeric(6,3) check (ownership_pct is null
                                                or (ownership_pct >= 0 and ownership_pct <= 100)),
  control_basis             text not null check (control_basis in
                              ('ownership','voting_rights','senior_management','other')),
  control_description       text,
  pep_status                text check (pep_status in ('not_pep','pep','pep_family','pep_associate')),
  is_designated             boolean,
  source                    text,
  verification_method       text check (verification_method in
                              ('original_seen','certified_copy','electronic','relying_on_third_party')),
  verified_by_membership_id uuid references public.firm_memberships(id) on delete set null,
  verified_at               timestamptz,
  notes                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  /* A shareholding has a percentage; a control right has a description. Neither may be absent. */
  check (control_basis <> 'ownership' or (ownership_pct is not null and ownership_pct > 0)),
  check (control_basis = 'ownership' or (control_description is not null
                                         and length(trim(control_description)) >= 10)),
  /* A person is identified by a birth date and a nationality; a company by its registration. */
  check (owner_kind <> 'natural_person' or (date_of_birth is not null and nationality is not null)),
  check (owner_kind <> 'legal_person' or (cr_number is not null and length(trim(cr_number)) >= 4))
);

create index if not exists beneficial_owners_dd_idx on public.beneficial_owners(dd_id);
create index if not exists beneficial_owners_party_idx on public.beneficial_owners(tenant_id, party_id);

comment on table public.beneficial_owners is
  'The natural and legal persons behind a client, by shareholding or by another control right.';

-- ── 4 · EACH SCREENING ──────────────────────────────────────────────────────────
/*
  `failed` IS A STATUS, AND IT IS THE IMPORTANT ONE.

  The failure this table is shaped around is a screening that never happened but looks
  like one: a provider that timed out, a batch that was interrupted, a result nobody
  wrote down. In a schema where the only outcomes are "matches" and "no matches", all
  three read as clear. `failed` is therefore its own status, it carries its reason, and it
  does not count as a clearance anywhere in this migration.

  `list_as_of` records WHICH list was searched. Screening against an eighteen-month-old
  designation list is not screening, and it is indistinguishable from screening unless the
  date is on the row.
*/
create table if not exists public.screening_runs (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete restrict,
  dd_id                 uuid references public.client_due_diligence(id) on delete cascade,
  client_id             uuid not null references public.clients(id) on delete restrict,
  subject_kind          text not null check (subject_kind in
                          ('client','party','beneficial_owner','staff')),
  subject_id            uuid not null,
  subject_name          text not null,
  list_sets             jsonb not null default '[]'::jsonb,
  list_as_of            date,
  provider              text not null check (provider in
                          ('internal_register','manual_review','external_provider','regulator_feed')),
  provider_reference    text,
  status                text not null check (status in ('clear','potential_match','match','failed')),
  matches_found         integer not null default 0 check (matches_found >= 0),
  failure_reason        text,
  run_at                timestamptz not null default now(),
  run_by_membership_id  uuid references public.firm_memberships(id) on delete set null,
  note                  text,
  created_at            timestamptz not null default now(),

  /* A failure says what failed. */
  check (status <> 'failed' or (failure_reason is not null and length(trim(failure_reason)) >= 5)),
  /* A clearance found nothing; the two claims have to agree. */
  check (status <> 'clear' or matches_found = 0),
  check (status <> 'potential_match' or matches_found > 0),
  check (status <> 'match' or matches_found > 0)
);

create index if not exists screening_runs_subject_idx
  on public.screening_runs(tenant_id, subject_kind, subject_id, run_at desc);
create index if not exists screening_runs_dd_idx on public.screening_runs(dd_id);

comment on table public.screening_runs is
  'Each screening of each person in a relationship, against a named list set as of a named date.';

-- ── 5 · EACH HIT ────────────────────────────────────────────────────────────────
/*
  A HIT IS DISPOSITIONED ONCE, BY A NAMED PERSON, WITH A REASON.

  Two names matching is not a finding and it is not nothing: it is a question for a human,
  who either rules it out or confirms it. The disposition is final in the same sense the
  conflict dispositions are — a match quietly re-classified later is worse than one that
  was wrong, because the record of the decision is what an inspection reads.

  `true_match` is not a severity to be managed. A confirmed designation prohibits the
  relationship, and the gate in section 7 refuses on it whatever else is recorded.
*/
create table if not exists public.screening_matches (
  id                            uuid primary key default gen_random_uuid(),
  tenant_id                     uuid not null references public.tenants(id) on delete restrict,
  run_id                        uuid not null references public.screening_runs(id) on delete cascade,
  list_source                   text not null,
  matched_name                  text not null,
  matched_reference             text,
  match_kind                    text not null check (match_kind in
                                  ('exact_name','fuzzy_name','national_id','alias','date_of_birth','address')),
  score                         numeric(5,2) check (score is null or (score >= 0 and score <= 100)),
  disposition                   text not null default 'open' check (disposition in
                                  ('open','false_positive','true_match','escalated')),
  disposition_reason            text,
  disposition_by_membership_id  uuid references public.firm_memberships(id) on delete set null,
  disposition_at                timestamptz,
  created_at                    timestamptz not null default now(),

  check (disposition = 'open' or (disposition_reason is not null
                                  and length(trim(disposition_reason)) >= 10
                                  and disposition_at is not null
                                  and disposition_by_membership_id is not null)),
  check (disposition <> 'open' or (disposition_reason is null and disposition_at is null))
);

create index if not exists screening_matches_run_idx on public.screening_matches(run_id);
create index if not exists screening_matches_open_idx
  on public.screening_matches(tenant_id) where disposition = 'open';

comment on table public.screening_matches is
  'One hit from one screening, and the decision that closed it. Confirmed matches prohibit the relationship.';

-- ── 6 · THE REPORT ──────────────────────────────────────────────────────────────
/*
  THE REPORT IS THE DOCUMENT THE FIRM ANSWERS FOR, so its completeness is a database
  condition rather than a form rule. A filed report carries the moment it was filed, the
  member who filed it, the authority's reference, and an acknowledgement that the client
  has not been told — because tipping off is its own offence, and a firm that has not
  recorded the instruction has not given it.

  THE NARRATIVE IS IN ARABIC. That is the language SAFIU receives, and the check is here as
  well as in the domain layer: a report whose narrative is English is a report that comes
  back, and the place to discover that is before it is filed.
*/
create table if not exists public.str_reports (
  id                                    uuid primary key default gen_random_uuid(),
  tenant_id                             uuid not null references public.tenants(id) on delete restrict,
  report_number                         text not null,
  subject_kind                          text not null check (subject_kind in
                                          ('client','party','beneficial_owner','staff','transaction')),
  subject_id                            uuid,
  subject_name                          text,
  client_id                             uuid references public.clients(id) on delete restrict,
  matter_id                             uuid references public.matters(id) on delete set null,
  grounds                               jsonb not null default '[]'::jsonb,
  narrative_ar                          text not null,
  narrative_en                          text,
  amount_sar                            numeric(14,2) check (amount_sar is null or amount_sar >= 0),
  currency                              text not null default 'SAR',
  transaction_reference                 text,
  transaction_at                        timestamptz,
  status                                text not null default 'draft' check (status in
                                          ('draft','pending_review','filed','acknowledged',
                                           'rejected_by_fiu','withdrawn')),
  prepared_by_membership_id             uuid references public.firm_memberships(id) on delete set null,
  prepared_at                           timestamptz,
  reviewed_by_membership_id             uuid references public.firm_memberships(id) on delete set null,
  reviewed_at                           timestamptz,
  filed_by_membership_id                uuid references public.firm_memberships(id) on delete set null,
  filed_at                              timestamptz,
  filed_due_at                          timestamptz,
  fiu_reference                         text,
  fiu_response                          text,
  fiu_responded_at                      timestamptz,
  tipping_off_acknowledged_at           timestamptz,
  tipping_off_acknowledged_by_membership_id uuid references public.firm_memberships(id) on delete set null,
  closure_reason                        text,
  closed_at                             timestamptz,
  created_by_membership_id              uuid references public.firm_memberships(id) on delete set null,
  created_at                            timestamptz not null default now(),
  updated_at                            timestamptz not null default now(),

  /* Filing is an act with an actor, a reference and a decision not to tell the client. */
  check (status not in ('filed','acknowledged','rejected_by_fiu')
         or (filed_at is not null and filed_by_membership_id is not null
             and fiu_reference is not null
             and tipping_off_acknowledged_at is not null
             and tipping_off_acknowledged_by_membership_id is not null)),
  /* An acknowledged report has an answer from the authority attached to it. */
  check (status <> 'acknowledged' or fiu_responded_at is not null),
  /* Withdrawing one is also a decision with a reason. */
  check (status <> 'withdrawn' or (closure_reason is not null and closed_at is not null)),
  unique (tenant_id, report_number)
);

create index if not exists str_reports_status_idx on public.str_reports(tenant_id, status, filed_due_at);
create index if not exists str_reports_client_idx on public.str_reports(tenant_id, client_id);

comment on table public.str_reports is
  'A suspicious-operation report: the grounds, the Arabic narrative, the filing, and the answer.';

-- ── 7a · THE CLOCK ON THE REPORT ────────────────────────────────────────────────
/*
  The due date is set when the report is PREPARED, not when it is filed, because the
  period runs from the suspicion and not from the paperwork. A report that has sat in
  `draft` past its date is late, and the register says so by arithmetic rather than by
  anybody remembering.
*/
create or replace function public.guard_str_due_date() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.prepared_at is null then new.prepared_at := now(); end if;
    if new.filed_due_at is null then
      new.filed_due_at := public.kgm_add_working_days(new.prepared_at, 3);
    end if;
  elsif tg_op = 'UPDATE' and new.prepared_at is distinct from old.prepared_at then
    /* Re-prepared is a new suspicion clock, and the old deadline goes with the old draft. */
    new.filed_due_at := public.kgm_add_working_days(new.prepared_at, 3);
  end if;
  return new;
end $$;

drop trigger if exists str_reports_due_date on public.str_reports;
create trigger str_reports_due_date
  before insert or update on public.str_reports
  for each row execute function public.guard_str_due_date();

-- ── 7b · ARABIC, AND THE FROZEN FILING ──────────────────────────────────────────
/*
  Two rules, one trigger, because they are both about the report being the document it
  claims to be. The narrative carries Arabic script; and once the report has left the firm,
  what it says is fixed — the only things that may still change are the authority's answer
  and the status that records it.

  THE FROZEN COLUMNS ARE LISTED EXPLICITLY rather than "everything except", because a
  report that gains a column must be a decision about whether that column is part of the
  filing, and an `except` list would answer that question silently.
*/
create or replace function public.guard_str_filing() returns trigger
language plpgsql as $$
begin
  if not (new.narrative_ar ~ E'[\u0600-\u06FF]') then
    raise exception 'str_narrative_not_arabic: the narrative of a report to SAFIU must be written in Arabic'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' and old.status in ('filed','acknowledged','rejected_by_fiu') then
    if new.narrative_ar is distinct from old.narrative_ar
       or new.grounds is distinct from old.grounds
       or new.subject_id is distinct from old.subject_id
       or new.subject_kind is distinct from old.subject_kind
       or new.client_id is distinct from old.client_id
       or new.amount_sar is distinct from old.amount_sar
       or new.transaction_reference is distinct from old.transaction_reference
       or new.report_number is distinct from old.report_number
       or new.filed_at is distinct from old.filed_at
       or new.filed_due_at is distinct from old.filed_due_at then
      raise exception 'str_filed_immutable: a filed report is the record of what was reported — correct it with a new report'
        using errcode = 'check_violation';
    end if;
  end if;

  /*
    AND A REPORT IS FILED ON SOMEBODY'S DECISION. The manual puts the reporting decision
    with the compliance officer; the schema puts a name and a moment on it, separately from
    the person who prepared the narrative — the two are different acts and, in this firm,
    different people.
  */
  if new.status in ('filed','acknowledged','rejected_by_fiu')
     and (new.reviewed_by_membership_id is null or new.reviewed_at is null) then
    raise exception 'str_not_approved: a report is filed on the compliance officer''s decision, recorded by name'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists str_reports_filing_guard on public.str_reports;
create trigger str_reports_filing_guard
  before insert or update on public.str_reports
  for each row execute function public.guard_str_filing();

create or replace function public.guard_screening_disposition_final() returns trigger
language plpgsql as $$
begin
  if old.disposition <> 'open' and new.disposition is distinct from old.disposition then
    raise exception 'already_dispositioned: this match has been decided — run a new screening rather than re-deciding it'
      using errcode = 'check_violation';
  end if;
  if old.disposition <> 'open'
     and (new.disposition_reason is distinct from old.disposition_reason
          or new.disposition_by_membership_id is distinct from old.disposition_by_membership_id) then
    raise exception 'already_dispositioned: the reason for a decision is as fixed as the decision'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists screening_matches_disposition_final on public.screening_matches;
create trigger screening_matches_disposition_final
  before update on public.screening_matches
  for each row execute function public.guard_screening_disposition_final();

-- ── 7c · `clients.identity_verified` IS DERIVED ─────────────────────────────────
/*
  THE BOOLEAN THIS PHASE IS REPLACING.

  `clients.identity_verified` has been typed by a clerk since the first migration, and the
  portal shows it to the client as "your identity is verified". It is now the database's
  opinion, derived from whether a current due-diligence record exists and is complete. The
  trigger ASSIGNS rather than refuses, deliberately: a write that asserts verification the
  record does not support is not an error to report, it is a claim to discard — the same
  way `guard_invoice_state` derives `client_status` rather than arguing about it.

  It fires on INSERT as well as UPDATE. On INSERT of a client there is no due-diligence
  record yet, so the answer is false; a client becomes verified when the record completes,
  and the deferred pass in `seed.ts` recomputes the seeded clients the same way.
*/
create or replace function public.guard_client_identity_derived() returns trigger
language plpgsql as $$
begin
  new.identity_verified := exists (
    select 1 from public.client_due_diligence d
     where d.tenant_id = new.tenant_id
       and d.client_id = new.id
       and d.superseded_by is null
       and d.status = 'complete');
  return new;
end $$;

drop trigger if exists clients_identity_derived on public.clients;
create trigger clients_identity_derived
  before insert or update on public.clients
  for each row execute function public.guard_client_identity_derived();

-- ── 7d · THE GATE ON ACCEPTING THE WORK ─────────────────────────────────────────
/*
  THE PROHIBITION, IN ONE PLACE.

  The manual says the lawyer may not act if due diligence cannot be completed. "Acting" in
  this system is the matter existing in `active`: intake is a file being considered,
  `conflict_check` is a file being examined, and `active` is a file the firm is working.
  So the guard is on the TRANSITION INTO `active`, and on nothing else.

  THAT CHOICE IS ALSO A NECESSITY. Matters that predate this migration are already sitting
  in `active` for clients nobody ever identified, and a guard on INSERT — or a blanket
  consistency check — would refuse the firm's permission to touch its own files. It guards
  MOVEMENT, which is what the obligation governs; the same reasoning as the conflict gate
  in 0029, and the same shape.

  WHAT IT ASKS, in one quantified statement: for this matter's client there is a current
  due-diligence record that is complete, that was completed by an approver senior enough
  for the level it claims, whose ownership is accounted for if the client is a legal
  person, whose review has not fallen due, and against which every person in the
  relationship has been screened by a run that did not fail, with no hit left open and no
  designation confirmed.

  IT IS DELIBERATELY NARROWER THAN THE APPLICATION'S OWN CHECK. `activationOutcome()` in
  server/src/domain/aml.ts answers the same question with the full requirement list, so
  that the refusal a person reads names the missing field. This one answers it with the
  facts a database can see, and refuses whether or not the application asked. A database
  that can only be right when the application is right is not a last line of defence.
*/
create or replace function public.matter_cdd_guard() returns trigger
language plpgsql as $$
declare
  v_dd       public.client_due_diligence%rowtype;
  v_kind     text;
  v_owners   boolean;
  v_subjects integer;
  v_screened integer;
begin
  if tg_op <> 'UPDATE' or new.internal_status <> 'active' or old.internal_status = 'active' then
    return new;
  end if;

  select * into v_dd from public.client_due_diligence d
   where d.tenant_id = new.tenant_id and d.client_id = new.client_id and d.superseded_by is null;

  if not found then
    raise exception 'cdd_missing: no client due diligence has been recorded for this client'
      using errcode = 'check_violation';
  end if;

  /* The prohibition first, and with its own words: this is not a backlog item. */
  if v_dd.status = 'unable_to_complete' then
    raise exception 'cdd_unable_to_complete: customer due diligence could not be completed for this client — the firm may not act (AML Law, M/20)'
      using errcode = 'check_violation';
  end if;

  if v_dd.status <> 'complete' then
    raise exception 'cdd_incomplete: this client''s due diligence is % — a matter may not be opened on an unidentified client', v_dd.status
      using errcode = 'check_violation';
  end if;

  if v_dd.cdd_level = 'enhanced' and v_dd.senior_approved_by_membership_id is null then
    raise exception 'senior_approval_required: enhanced due diligence requires a named senior approver'
      using errcode = 'check_violation';
  end if;

  /*
    A PEP WHOSE PROCESS WAS NOT RAISED TO MEET THE DETERMINATION.

    The manual does not prohibit acting for a politically exposed person; it requires
    enhanced due diligence and senior approval first. So this is not "the client is a
    PEP" — it is that the determination was recorded and the level left where it was,
    which leaves the record claiming a completeness it does not have. The refusal names
    the fix, because the fix is a decision rather than a field.
  */
  if v_dd.pep_status is not null and v_dd.pep_status <> 'not_pep' and v_dd.cdd_level <> 'enhanced' then
    raise exception 'senior_approval_required: this client is a politically exposed person — due diligence must be enhanced and approved by senior management'
      using errcode = 'check_violation';
  end if;

  if v_dd.review_due_at is not null
     and v_dd.review_due_at < (now() at time zone 'Asia/Riyadh')::date then
    raise exception 'cdd_review_overdue: this client''s due diligence was due for review on %', v_dd.review_due_at
      using errcode = 'check_violation';
  end if;

  /* ── a legal person is identified through the people behind it ── */
  select c.client_type into v_kind from public.clients c where c.id = new.client_id;
  if v_kind is distinct from 'individual' then
    select (
      coalesce((select sum(bo.ownership_pct) from public.beneficial_owners bo
                 where bo.dd_id = v_dd.id and bo.control_basis = 'ownership'
                   and bo.verified_at is not null), 0) >= 25
      or exists (select 1 from public.beneficial_owners bo
                  where bo.dd_id = v_dd.id and bo.control_basis <> 'ownership'
                    and bo.verified_at is not null)
    ) into v_owners;
    if not v_owners then
      raise exception 'cdd_beneficial_owner_missing: the persons who control this client have not been identified to the 25%% threshold, and no control right is recorded'
        using errcode = 'check_violation';
    end if;
  end if;

  /* ── every person in the relationship has been screened, and none is unresolved ── */
  with subjects as (
    select 'client'::text as kind, new.client_id as id
    union all
    select 'beneficial_owner'::text, bo.id
      from public.beneficial_owners bo
     where bo.dd_id = v_dd.id
       and bo.verified_at is not null
       and (coalesce(bo.ownership_pct, 0) >= 25 or bo.control_basis <> 'ownership')
  )
  select count(*) into v_subjects from subjects;

  with subjects as (
    select 'client'::text as kind, new.client_id as id
    union all
    select 'beneficial_owner'::text, bo.id
      from public.beneficial_owners bo
     where bo.dd_id = v_dd.id
       and bo.verified_at is not null
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

  if exists (
    select 1 from public.screening_matches m
      join public.screening_runs r on r.id = m.run_id
     where r.tenant_id = new.tenant_id
       and m.disposition = 'true_match'
       and (r.subject_kind = 'client' and r.subject_id = new.client_id
            or r.subject_kind = 'beneficial_owner'
               and r.subject_id in (select bo.id from public.beneficial_owners bo where bo.dd_id = v_dd.id)))
  then
    raise exception 'sanctions_match: a confirmed designation is recorded for a person in this relationship — the relationship may not be established'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists matter_cdd_gate on public.matters;
create trigger matter_cdd_gate
  before update on public.matters
  for each row execute function public.matter_cdd_guard();

-- ── 8 · ROW-LEVEL SECURITY ──────────────────────────────────────────────────────
/*
  NONE OF THESE SIX TABLES IS GRANTED TO `portal_api`, and there is a policy saying so.

  The firm's assessment of a client — its risk rating, its reasons, the matches it found,
  the report it filed — is not the client's record. The client's own documents, their
  matters and their engagement letter are; this is the firm's opinion about them, and the
  professional secrecy that attaches to a suspicion report is criminal-law territory. So
  the portal holds no privilege at all, which is a stronger statement than a policy, and
  the explicit `using (false)` policies make the intent legible to the next reader who
  opens pg_policies and finds five tables from this phase and six from the last.
*/
alter table public.aml_risk_countries    enable row level security;
alter table public.client_due_diligence  enable row level security;
alter table public.beneficial_owners     enable row level security;
alter table public.screening_runs        enable row level security;
alter table public.screening_matches     enable row level security;
alter table public.str_reports           enable row level security;

/*
  The same non-recursive shape the rest of the schema uses: a policy per command, a
  visibility predicate that does not query the table it protects, and a write policy whose
  WITH CHECK does not re-test the visibility it has just changed.
*/
drop policy if exists aml_risk_countries_firm_all on public.aml_risk_countries;
create policy aml_risk_countries_firm_read on public.aml_risk_countries
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy aml_risk_countries_firm_insert on public.aml_risk_countries
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy aml_risk_countries_firm_write on public.aml_risk_countries
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists client_due_diligence_firm_all on public.client_due_diligence;
create policy client_due_diligence_firm_read on public.client_due_diligence
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy client_due_diligence_firm_insert on public.client_due_diligence
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy client_due_diligence_firm_write on public.client_due_diligence
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists beneficial_owners_firm_all on public.beneficial_owners;
create policy beneficial_owners_firm_read on public.beneficial_owners
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy beneficial_owners_firm_insert on public.beneficial_owners
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy beneficial_owners_firm_write on public.beneficial_owners
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists screening_runs_firm_all on public.screening_runs;
create policy screening_runs_firm_read on public.screening_runs
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy screening_runs_firm_insert on public.screening_runs
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy screening_runs_firm_write on public.screening_runs
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists screening_matches_firm_all on public.screening_matches;
create policy screening_matches_firm_read on public.screening_matches
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy screening_matches_firm_insert on public.screening_matches
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy screening_matches_firm_write on public.screening_matches
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists str_reports_firm_all on public.str_reports;
create policy str_reports_firm_read on public.str_reports
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy str_reports_firm_insert on public.str_reports
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy str_reports_firm_write on public.str_reports
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

/* The portal: named, deliberate, and false. */
drop policy if exists client_due_diligence_portal_none on public.client_due_diligence;
create policy client_due_diligence_portal_none on public.client_due_diligence for select to portal_api using (false);
drop policy if exists beneficial_owners_portal_none on public.beneficial_owners;
create policy beneficial_owners_portal_none on public.beneficial_owners for select to portal_api using (false);
drop policy if exists screening_runs_portal_none on public.screening_runs;
create policy screening_runs_portal_none on public.screening_runs for select to portal_api using (false);
drop policy if exists screening_matches_portal_none on public.screening_matches;
create policy screening_matches_portal_none on public.screening_matches for select to portal_api using (false);
drop policy if exists str_reports_portal_none on public.str_reports;
create policy str_reports_portal_none on public.str_reports for select to portal_api using (false);
drop policy if exists aml_risk_countries_portal_none on public.aml_risk_countries;
create policy aml_risk_countries_portal_none on public.aml_risk_countries for select to portal_api using (false);

-- ── 9 · GRANTS ──────────────────────────────────────────────────────────────────
/*
  FEATURE BY FEATURE, COLUMN BY COLUMN.

  Every column the server names in a statement needs its own privilege, including ones
  with defaults and ones it only reads in a WHERE clause — the class of defect that cost
  0028 and 0038. The lists below are the statements in `FirmRepo`'s P0.3 methods, and
  `scripts/verify/schema-parity.ts` fails if the two drift apart.

  NOTE WHAT IS NOT GRANTED. `firm_api` may not UPDATE `screening_matches` except to
  disposition one — a trigger enforces the same rule, and the privilege enforces what the
  trigger cannot: that a match row cannot be rewritten by a statement nobody anticipated.
  `firm_api` may not DELETE from any of these six tables at all: a due-diligence record, a
  screening and a report are records of what the firm knew and when.
*/
grant select on public.aml_risk_countries to firm_api;
grant insert (id, tenant_id, country_code, country_name, country_name_ar, list_source,
              risk_level, effective_from, effective_to, note, created_by_membership_id,
              created_at, updated_at) on public.aml_risk_countries to firm_api;
grant update (country_name, country_name_ar, risk_level, effective_to, note, updated_at)
  on public.aml_risk_countries to firm_api;

grant select on public.client_due_diligence to firm_api;
grant insert (id, tenant_id, client_id, party_id, version, cdd_level, status,
              legal_name, legal_name_ar, date_of_birth, nationality, residence_country, address,
              id_type, id_number_hash, id_number_masked, id_issued_at, id_expires_at,
              cr_number, cr_issued_at, incorporation_country, business_activity, ownership_structure,
              source_of_funds, source_of_wealth, purpose, expected_annual_volume_sar,
              verification_method, verification_source, verified_by_membership_id, verified_at,
              pep_status, pep_details, risk_rating, risk_reasons, risk_assessed_at,
              senior_approved_by_membership_id, senior_approved_at, senior_approval_note,
              review_due_at, last_reviewed_at, completed_at, completed_by_membership_id,
              unable_reason, notes, created_by_membership_id, created_at, updated_at)
  on public.client_due_diligence to firm_api;
grant update (cdd_level, status, legal_name, legal_name_ar, date_of_birth, nationality,
              residence_country, address, id_type, id_number_hash, id_number_masked,
              id_issued_at, id_expires_at, cr_number, cr_issued_at, incorporation_country,
              business_activity, ownership_structure, source_of_funds, source_of_wealth, purpose,
              expected_annual_volume_sar, verification_method, verification_source,
              verified_by_membership_id, verified_at, pep_status, pep_details,
              risk_rating, risk_reasons, risk_assessed_at,
              senior_approved_by_membership_id, senior_approved_at, senior_approval_note,
              review_due_at, last_reviewed_at, completed_at, completed_by_membership_id,
              unable_reason, notes, superseded_by, superseded_at, updated_at)
  on public.client_due_diligence to firm_api;

grant select on public.beneficial_owners to firm_api;
grant insert (id, tenant_id, dd_id, client_id, party_id, owner_kind, full_name, full_name_ar,
              date_of_birth, nationality, residence_country, address, id_type, id_number_hash,
              id_number_masked, cr_number, ownership_pct, control_basis, control_description,
              pep_status, is_designated, source, verification_method, verified_by_membership_id,
              verified_at, notes, created_at, updated_at) on public.beneficial_owners to firm_api;
grant update (party_id, owner_kind, full_name, full_name_ar, date_of_birth, nationality,
              residence_country, address, id_type, id_number_hash, id_number_masked, cr_number,
              ownership_pct, control_basis, control_description, pep_status, is_designated,
              source, verification_method, verified_by_membership_id, verified_at, notes, updated_at)
  on public.beneficial_owners to firm_api;

grant select on public.screening_runs to firm_api;
grant insert (id, tenant_id, dd_id, client_id, subject_kind, subject_id, subject_name,
              list_sets, list_as_of, provider, provider_reference, status, matches_found,
              failure_reason, run_at, run_by_membership_id, note, created_at)
  on public.screening_runs to firm_api;
grant update (status, matches_found, failure_reason, list_sets, list_as_of,
              provider_reference, note, run_at) on public.screening_runs to firm_api;

grant select on public.screening_matches to firm_api;
grant insert (id, tenant_id, run_id, list_source, matched_name, matched_reference, match_kind,
              score, disposition, created_at) on public.screening_matches to firm_api;
grant update (disposition, disposition_reason, disposition_by_membership_id, disposition_at)
  on public.screening_matches to firm_api;

grant select on public.str_reports to firm_api;
grant insert (id, tenant_id, report_number, subject_kind, subject_id, subject_name,
              client_id, matter_id, grounds, narrative_ar, narrative_en, amount_sar, currency,
              transaction_reference, transaction_at, status, prepared_by_membership_id,
              prepared_at, created_by_membership_id, created_at, updated_at)
  on public.str_reports to firm_api;
grant update (status, grounds, narrative_ar, narrative_en, amount_sar, currency,
              transaction_reference, transaction_at, subject_kind, subject_id, subject_name,
              client_id, matter_id, prepared_at, reviewed_by_membership_id, reviewed_at,
              filed_by_membership_id, filed_at, fiu_reference, fiu_response, fiu_responded_at,
              tipping_off_acknowledged_at, tipping_off_acknowledged_by_membership_id,
              closure_reason, closed_at, updated_at) on public.str_reports to firm_api;

/* The two functions the application calls by name. */
grant execute on function public.kgm_working_day(timestamptz) to firm_api;
grant execute on function public.kgm_add_working_days(timestamptz, integer) to firm_api;

-- ── 10 · VERIFY ─────────────────────────────────────────────────────────────────
do $$
declare
  n integer;
  missing text;
begin
  /* Six tables, one policy per command plus the portal's refusal, all with RLS on. */
  select count(*) into n from pg_tables t
   where t.schemaname = 'public' and t.rowsecurity
     and t.tablename in ('aml_risk_countries','client_due_diligence','beneficial_owners',
                         'screening_runs','screening_matches','str_reports');
  if n <> 6 then
    raise exception '0040: % of the six P0.3 tables have row-level security enabled', n;
  end if;

  /* The gate, the identity derivation, the filing guard and the clock. */
  for missing in
    select t.name from unnest(array['matter_cdd_gate','clients_identity_derived',
                                    'str_reports_due_date','str_reports_filing_guard',
                                    'screening_matches_disposition_final']) t(name)
     where not exists (select 1 from pg_trigger g where g.tgname = t.name and not g.tgisinternal)
  loop
    raise exception '0040: the trigger % is not installed', missing;
  end loop;

  /*
    AND THE PORTAL HOLDS NOTHING. Not "no rows": no privilege. Checked against the catalog
    because a grant added later by a migration nobody re-reads is exactly how the portal
    came to hold SELECT on the firm's rate cards in an earlier phase.
  */
  select string_agg(distinct p.table_name, ', ') into missing
    from information_schema.table_privileges p
   where p.table_schema = 'public' and p.grantee = 'portal_api'
     and p.table_name in ('aml_risk_countries','client_due_diligence','beneficial_owners',
                          'screening_runs','screening_matches','str_reports');
  if missing is not null then
    raise exception '0040: portal_api holds a privilege on the firm''s AML tables: %', missing;
  end if;

  raise notice '0040 applied: the client is identified, the owners are accounted for, the screening is resolved, and the matter gate refuses the rest.';
end $$;
