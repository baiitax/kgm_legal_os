-- ═══════════════════════════════════════════════════════════════════════════════
--  0045 · JUDGMENTS, SERVICE, AND THE PERIOD FOR CHALLENGING ONE  (phase P0.4)
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  WHY THIS EXISTS
--
--  Until this migration, "judgment" existed in this database as three string literals:
--  twice as a lifecycle state on `matters` (`internal_status`, `client_status`) and once
--  as a `matter_timeline.event_type`. There was no صك, no issuing court or circuit, no
--  judgment type, no finality — and, fatally, NO DATE OF DELIVERY TO THE PARTY.
--
--      «تبدأ المدة من تاريخ تسليم صك الحكم إلى المحكوم عليه»
--      the period runs from delivery of the judgment copy to the party against whom it
--      was issued — not from pronouncement.
--
--  The consequence is stated in the gap analysis and it is the reason this phase comes
--  before the deadline engine: you cannot diarise an appeal period without a judgment
--  register and a service register. A thirty-day period that the system thinks started on
--  the wrong day is worse than no period at all, because somebody will rely on it.
--
--  WHAT IS HERE
--
--    1 · court_calendar   — the firm's non-working days, Hijri date beside the Gregorian
--    2 · judgments        — the register, with the enforcement lifecycle on it
--    3 · service_events   — what was served, on whom, when, how, with what proof
--    4 · judgment_appeals — each challenge, with its own filing clock
--    5 · the derived columns: the clock the service started, the article that fixed it
--    6 · the guards: the appeal clock, the enforcement matrix, retention
--    7 · the gate on `matters.internal_status → 'execution'`
--    8 · the `deadlines` extension the gate writes into
--    9 · row-level security and the column grants
--
--  THE ONE SENTENCE THIS MIGRATION ENFORCES
--
--  Enforcement does not begin on a judgment that is not yet enforceable, and it never
--  begins against a party who has not been served.
--
--  WHY THE CLOCK IS STORED AND NOT RECOMPUTED
--
--  The arithmetic — day-after-delivery, thirty days, extend the last day to the next day
--  the courts sit, close at 23:59:59+03:00 — lives in `server/src/domain/judgments.ts`,
--  ONE copy, and its answer is written onto the row (`appeal_deadline_at`, with
--  `appeal_rule_cited` and `appeal_rule_days`). The triggers below READ those columns.
--  They do not re-derive them. This codebase has already paid for the other arrangement:
--  the 25% beneficial-ownership rule existed in three dialects, only one of them required
--  a natural person, and the live gate disagreed with the domain about a holding company.
--  One computation, one place; the database enforces what the row says, not its own
--  opinion of what the row should say.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · THE DAYS THE COURTS DO NOT SIT ──────────────────────────────────────────
/*
  THE EXTEND-THE-LAST-DAY RULE NEEDS A CALENDAR.

  A period whose thirtieth day is a Friday ends on the next working day. Without this table
  that rule is a guess about weekends and a blind spot for every Eid, every National Day and
  every court recess — and the failure mode is a deadline the system reports as closed when
  a court would still have accepted the filing.

  THE HIJRI DATE IS STORED BESIDE THE GREGORIAN ONE. The arithmetic stays Gregorian, because
  that is what a calendar of working days is; but a court's recess is announced in Hijri
  terms and a person reading this table needs to recognise the row they entered. Both dates
  are on the row so that neither has to be converted by eye.
*/
create table if not exists public.court_calendar (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete restrict,
  calendar_date             date not null,
  hijri_date                text,             -- '1448-03-21', as the announcement wrote it
  kind                      text not null default 'public_holiday'
                            check (kind in ('weekend','public_holiday','court_recess','emergency_closure')),
  name                      text not null,
  name_ar                   text not null,
  note                      text,
  created_by_membership_id  uuid references public.firm_memberships(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (tenant_id, calendar_date)
);

create index if not exists court_calendar_tenant_idx
  on public.court_calendar(tenant_id, calendar_date);

-- ── 2 · THE REGISTER ────────────────────────────────────────────────────────────
/*
  ONE ROW PER PRONOUNCED JUDGMENT, NOT ONE PER MATTER.

  A matter has a first-instance judgment, an appeal judgment, sometimes a cassation
  judgment. Enforcement is a question about the LATEST of them — which is `operative` in the
  domain and `order by pronounced_at desc, created_at desc limit 1` here, the same rule in
  two places, deliberately, because a disagreement between them would be a gate that opens
  for the route and refuses the trigger.

  `served_at` AND `service_effective_at` ARE DENORMALISED FROM THE SERVICE REGISTER, on
  purpose. The service event records what happened; these two columns record the answer the
  domain computed from it, so that the gate reads a fact rather than re-deriving it from a
  channel, an outcome and a publication period. Substituted service takes effect at the end
  of its publication period, and the difference between "delivered on the 3rd" and "effective
  on the 18th" is exactly the kind of arithmetic that drifts when it exists twice.
*/
create table if not exists public.judgments (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete restrict,
  client_id                 uuid not null references public.clients(id) on delete restrict,
  matter_id                 uuid not null references public.matters(id) on delete restrict,
  -- رقم الصك. The judgment's own number, which is how it is cited in a filing.
  deed_number               text not null,
  case_number               text,
  court                     text not null,
  court_ar                  text not null,
  circuit                   text,
  circuit_ar                text,
  judge_name                text,
  judgment_kind             text not null
                            check (judgment_kind in ('first_instance','appeal','cassation')),
  /*
    PRESENCE DECIDES WHAT THE PERIOD RUNS FROM. An in-absentia judgment (حكم غيابي) runs from
    notification, and a default judgment (غيابي اعتباري) from the defendant's knowledge of it.
    Both are recorded rather than inferred, because the system cannot tell from here which of
    the three happened, and guessing would be guessing about a statutory period.
  */
  presence                  text not null default 'in_presence'
                            check (presence in ('in_presence','in_absentia','in_absentia_default')),
  urgent                    boolean not null default false,
  pronounced_at             timestamptz not null,
  relief_kind               text not null default 'none'
                            check (relief_kind in ('monetary','non_monetary','none')),
  amount_sar                numeric(14,2),
  currency                  text not null default 'SAR',
  verdict_for               text check (verdict_for in ('client','opponent','split','procedural')),
  summary                   text,
  summary_ar                text,
  document_id               uuid references public.documents(id) on delete set null,

  -- ─ the clock, as computed by the domain and written down ─
  appealable                boolean not null default true,
  served_at                 timestamptz,
  service_effective_at      timestamptz,
  appeal_deadline_at        timestamptz,
  appeal_rule_cited         text,
  appeal_rule_days          integer,
  final_at                  timestamptz,

  -- ─ the stay, which outranks everything but a terminal state ─
  stay_in_force             boolean not null default false,
  stay_reason               text,
  stay_ordered_at           timestamptz,

  -- ─ the enforcement lifecycle ─
  enforcement_status        text not null default 'awaiting_finality'
                            check (enforcement_status in
                              ('not_enforceable','awaiting_finality','enforceable',
                               'stayed','under_enforcement','satisfied','closed')),
  enforcement_opened_at     timestamptz,
  enforcement_court         text,
  enforcement_reference     text,
  satisfied_at              timestamptz,
  recovered_amount_sar      numeric(14,2),

  created_by_membership_id  uuid not null references public.firm_memberships(id) on delete restrict,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  unique (tenant_id, deed_number),
  /* A monetary judgment with no amount is a claim nobody can enforce or plead. */
  check (relief_kind <> 'monetary' or amount_sar is not null),
  check (amount_sar is null or amount_sar >= 0),
  /* A stay with no order behind it is a note, not a stay. */
  check (not stay_in_force or stay_ordered_at is not null),
  /* A period that was computed carries the article that fixed it. */
  check (appeal_deadline_at is null or (appeal_rule_cited is not null and appeal_rule_days is not null)),
  /* Enforcement that never opened cannot have been satisfied. */
  check (enforcement_status <> 'under_enforcement' or enforcement_opened_at is not null)
);

create index if not exists judgments_matter_idx  on public.judgments(matter_id, pronounced_at desc);
create index if not exists judgments_client_idx  on public.judgments(client_id, pronounced_at desc);
/* The register's own index: what is enforceable now, and what is about to become so. */
create index if not exists judgments_enforceable_idx
  on public.judgments(tenant_id, enforcement_status, appeal_deadline_at);
create index if not exists judgments_open_stay_idx
  on public.judgments(tenant_id) where stay_in_force = true;

-- ── 3 · THE SERVICE REGISTER ────────────────────────────────────────────────────
/*
  WHAT WAS SERVED, ON WHOM, WHEN, HOW, AND WITH WHAT PROOF.

  The plan of record called this `service_records`. It records notices as well as judgments
  — a court notice, an execution notice, a notice to the other side — and each is a thing
  that happened on a date, which is what an event is. The name follows the thing.

  `effective_at` IS THE WHOLE POINT OF THE TABLE, and the CHECK constraint below is the
  point of the column: the database refuses an effective date on a service that did not take
  effect. An uncollected registered letter and an address nobody could find are attempts;
  a refusal recorded by the judicial officer IS service, because otherwise the party could
  stop the clock by declining the envelope. That reasoning lives in the domain, and the
  database holds the line so that a caller who is not this application cannot write the
  opposite.
*/
create table if not exists public.service_events (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete restrict,
  client_id                 uuid not null references public.clients(id) on delete restrict,
  matter_id                 uuid not null references public.matters(id) on delete restrict,
  judgment_id               uuid references public.judgments(id) on delete restrict,
  notice_kind               text not null
                            check (notice_kind in ('judgment','court_notice','execution_notice',
                                                   'opponent_notice','client_notice','third_party_notice')),
  method                    text not null
                            check (method in ('in_court','personal','agent','registered_mail',
                                              'electronic','publication','judicial_bailiff')),
  outcome                   text not null default 'pending'
                            check (outcome in ('pending','served','refused','unclaimed',
                                               'untraceable','substituted')),
  served_on_kind            text not null
                            check (served_on_kind in ('client','opponent','representative','third_party')),
  served_on_name            text,
  served_on_party_id        uuid references public.parties(id) on delete set null,
  attempted_at              timestamptz,
  served_at                 timestamptz,
  /* The period the court ordered for substituted service; recorded, never assumed. */
  publication_days          integer check (publication_days is null or publication_days between 1 and 180),
  /* The computed answer: null unless this attempt was a service. Guarded below. */
  effective_at              timestamptz,
  proof_document_id         uuid references public.documents(id) on delete set null,
  proof_reference           text,
  acknowledged_at           timestamptz,
  /* The deadline this service created, when it started a clock. */
  deadline_id               uuid references public.deadlines(id) on delete set null,
  note                      text,
  recorded_by_membership_id uuid not null references public.firm_memberships(id) on delete restrict,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  /*
    THE LINE, IN ONE CONSTRAINT. An effective date exists if and only if the outcome is one
    of the three that take effect. Written as an equivalence so that both directions are
    refused: a service marked served with no date on it (a clock nobody can compute) and a
    date on an uncollected letter (a clock that should not exist).
  */
  check ((outcome in ('served','refused','substituted')) = (effective_at is not null)),
  check (effective_at is null or served_at is not null),
  /* Substituted service carries the period it was published for; nothing else needs one. */
  check (outcome <> 'substituted' or publication_days is not null),
  check (outcome = 'substituted' or publication_days is null)
);

create index if not exists service_events_matter_idx   on public.service_events(matter_id, served_at desc);
create index if not exists service_events_judgment_idx on public.service_events(judgment_id);
create index if not exists service_events_clock_idx    on public.service_events(tenant_id, effective_at desc)
  where judgment_id is not null;

-- ── 4 · THE CHALLENGES ──────────────────────────────────────────────────────────
/*
  AN APPEAL IS NOT A BOOLEAN ON A JUDGMENT.

  It has a filing date, the deadline it was filed against, the court, and an outcome that
  changes what may be enforced. `filed_late` is recorded rather than refused, because the
  court decides whether a late filing is accepted — the system's job is to say that the
  period had closed, on the record, so that nobody is surprised by it later.
*/
create table if not exists public.judgment_appeals (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete restrict,
  client_id                 uuid not null references public.clients(id) on delete restrict,
  matter_id                 uuid not null references public.matters(id) on delete restrict,
  judgment_id               uuid not null references public.judgments(id) on delete restrict,
  appeal_kind               text not null check (appeal_kind in ('appeal','cassation','rehearing')),
  filed_at                  timestamptz not null,
  filing_deadline_at        timestamptz,
  rule_cited                text,
  rule_days                 integer,
  filed_late                boolean not null default false,
  court                     text,
  court_ar                  text,
  reference                 text,
  status                    text not null default 'filed'
                            check (status in ('filed','registered','decided','withdrawn','rejected')),
  outcome                   text check (outcome in ('upheld','varied','overturned','remanded','dismissed')),
  decided_at                timestamptz,
  result_judgment_id        uuid references public.judgments(id) on delete set null,
  stay_requested            boolean not null default false,
  stay_granted              boolean not null default false,
  grounds                   text,
  grounds_ar                text,
  created_by_membership_id  uuid not null references public.firm_memberships(id) on delete restrict,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  /* A decision has an outcome and a date. A filing has neither. */
  check (status <> 'decided' or (outcome is not null and decided_at is not null)),
  check (status not in ('decided','withdrawn','rejected') or decided_at is not null),
  check (outcome is null or status = 'decided'),
  /* A cassation or a rehearing is not available against a judgment of the same court's own
     level; the route says so with a named code, and this keeps a raw caller honest. */
  check (filed_late = false or filing_deadline_at is not null)
);

create index if not exists judgment_appeals_judgment_idx on public.judgment_appeals(judgment_id, filed_at desc);
/* The gate asks one question of this table: is anything filed and undecided? */
create index if not exists judgment_appeals_pending_idx
  on public.judgment_appeals(judgment_id) where status in ('filed','registered');

-- ── 5 · THE CLOCK FOLLOWS THE SERVICE ───────────────────────────────────────────
/*
  RECORDING A SERVICE ON A JUDGMENT STARTS ITS PERIOD.

  The route computes the deadline (one copy of the arithmetic, in the domain) and writes
  three columns onto the judgment: when the period ends, the article that fixed it, and how
  many days it was. This trigger exists for the caller who is not the route: it refuses a
  serviced judgment whose period was never computed, because that is the state in which a
  system believes it has diarised an appeal and has not.

  IT DOES NOT COMPUTE THE DATE. If it did, the date would exist in two implementations and
  the one the printout shows would be whichever ran last.
*/
create or replace function public.guard_judgment_clock() returns trigger
language plpgsql as $$
begin
  if new.service_effective_at is not null
     and tg_op = 'UPDATE'
     and (old.service_effective_at is distinct from new.service_effective_at)
     and new.appeal_deadline_at is null
     and new.appealable
  then
    raise exception 'appeal_window_uncomputed: this judgment was served and its period was never '
                    'computed — a delivery date with no deadline is an appeal nobody diarised'
      using errcode = 'check_violation';
  end if;

  /* A final judgment that is appealable and whose period is still running is a contradiction:
     one of the two is wrong, and the register must not carry both. */
  if new.final_at is not null
     and new.appealable
     and new.appeal_deadline_at is not null
     and new.appeal_deadline_at > new.final_at
  then
    raise exception 'judgment_finality_contradiction: this judgment is recorded as final before the '
                    'period for challenging it closed'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists judgments_clock_guard on public.judgments;
create trigger judgments_clock_guard
  before insert or update on public.judgments
  for each row execute function public.guard_judgment_clock();

-- ── 6a · THE ENFORCEMENT MATRIX ─────────────────────────────────────────────────
/*
  THE SAME MATRIX AS `ENFORCEMENT_TRANSITIONS` IN THE DOMAIN, transcribed.

  A matrix and not a chain of conditions, because a matrix can be transcribed and diffed.
  The tempting invalid moves are the interesting ones: `under_enforcement → enforceable`
  would be enforcement quietly un-happening, and `satisfied → under_enforcement` would be
  the same judgment collected twice.
*/
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
    when 'awaiting_finality' then new.enforcement_status in ('enforceable','stayed','not_enforceable')
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

  /* Enforcement that ended says how it ended. */
  if new.enforcement_status = 'satisfied' and new.satisfied_at is null then
    raise exception 'enforcement_transition_invalid: a satisfied judgment carries the date it was '
                    'satisfied' using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists judgments_enforcement_guard on public.judgments;
create trigger judgments_enforcement_guard
  before update on public.judgments
  for each row execute function public.guard_enforcement_state();

-- ── 6b · RETENTION ──────────────────────────────────────────────────────────────
/*
  A JUDGMENT THAT HAS BEEN RELIED ON OUTSIDE THE FIRM IS NOT THE FIRM'S TO DELETE.

  Once a صك has been served, challenged or enforced, other people — a party, a court, an
  execution judge — have acted on it, and the firm's copy is evidence of what it did. The
  privilege to delete is absent and this trigger says why, in both directions:

    · a judgment that was NEVER served, never challenged and never enforced may be deleted,
      because a mis-keyed deed number is corrected, not retained for ten years;
    · anything else is kept, including the service attempt that failed, because the question
      "what did the firm do about service" has an answer in this table or it does not exist.
*/
create or replace function public.guard_judgment_retention() returns trigger
language plpgsql as $$
begin
  if old.service_effective_at is not null
     or old.served_at is not null
     or old.final_at is not null
     or old.enforcement_status in ('under_enforcement','satisfied','closed')
     or exists (select 1 from public.judgment_appeals a where a.judgment_id = old.id)
     or exists (select 1 from public.service_events s where s.judgment_id = old.id)
  then
    raise exception 'judgment_retention: this judgment has been served, challenged or enforced — '
                    'it records what the firm did and may not be deleted'
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists judgments_retention on public.judgments;
create trigger judgments_retention
  before delete on public.judgments
  for each row execute function public.guard_judgment_retention();

/* The same rule for the service register: the fact every computed date depends on. */
create or replace function public.guard_service_retention() returns trigger
language plpgsql as $$
begin
  if old.effective_at is not null or old.deadline_id is not null then
    raise exception 'service_retention: this service started a period the firm diarised — deleting it '
                    'would leave the deadline with no cause'
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists service_events_retention on public.service_events;
create trigger service_events_retention
  before delete on public.service_events
  for each row execute function public.guard_service_retention();

-- ── 7 · THE GATE ON ENFORCEMENT ─────────────────────────────────────────────────
/*
  THE REFUSAL ORDER IS PART OF THE ANSWER, and it runs from the fact that cannot be worked
  around to the one that merely needs patience:

    1 · is there a judgment at all;
    2 · does it order something that can be executed — a procedural decision is a judgment the
        firm won and there is nothing to collect;
    3 · may the power of the state be used against this person — has the صك reached them;
    4 · was the attempt at service one that does not count;
    5 · has a court stopped the execution;
    6 · is a challenge pending;
    7 · is the period for challenging it still open.

  THE OPERATIVE JUDGMENT IS THE LATEST PRONOUNCED, in the same order the domain uses, tie
  broken by when the firm recorded it. The gate guards the TRANSITION into 'execution' and
  nothing else: matters that were already in execution before this phase existed keep
  working, which is the same reasoning — and the same shape — as the conflict gate in 0029
  and the CDD gate in 0040.

  IT ALSO MOVES THE JUDGMENT. A caller who is not this application gets the same end state,
  not merely the same refusal: the register on the next screen must not say `enforceable`
  about a judgment that is already in execution.
*/
create or replace function public.matter_execution_guard() returns trigger
language plpgsql as $$
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
         updated_at = now()
   where id = j.id
     and enforcement_status in ('enforceable','awaiting_finality','stayed');

  return new;
end $$;

drop trigger if exists matter_execution_gate on public.matters;
create trigger matter_execution_gate
  before update on public.matters
  for each row when (new.internal_status = 'execution' and old.internal_status is distinct from 'execution')
  execute function public.matter_execution_guard();

-- ── 8 · THE DEADLINE THE SERVICE CREATES ────────────────────────────────────────
/*
  THE POINT OF THE WHOLE PHASE: the date exists because the service exists.

  ANALYSIS I ASKED FOR THIS IN THESE WORDS: extend `deadlines.kind` to `limitation`, `appeal`,
  `cassation`, `reconsideration`; store the rule and THE ARTICLE CITED on every computed date.

  WHY THE NEW KINDS MAY NOT BE CLIENT-VISIBLE. They are the firm's obligations, not the
  client's: a client cannot be assigned a statutory period, and a screen that showed one as
  a client task would be asking the wrong person to do the work. The existing lane guard is
  restated below with that rule added, so the database refuses it rather than a comment
  asking nicely.
*/
alter table public.deadlines drop constraint if exists deadlines_kind_check;
alter table public.deadlines add constraint deadlines_kind_check
  check (kind in ('client_action','internal_task','appeal','cassation','reconsideration','limitation'));

alter table public.deadlines
  add column if not exists rule_code      text,
  add column if not exists rule_cited     text,
  add column if not exists rule_days      integer,
  add column if not exists trigger_event  text,
  add column if not exists source_kind    text,
  add column if not exists source_id      uuid;

create index if not exists deadlines_source_idx on public.deadlines(source_kind, source_id);

/*
  THE LANE GUARD, RESTATED — by replacing the FUNCTION and leaving the trigger alone.

  `create or replace function` keeps the trigger bound to it, which is the only way to change
  this rule without the near-miss that 0043 produced: a second trigger with a similar name,
  both firing, each believing it was the only one.
*/
create or replace function public.assert_deadline_lane()
returns trigger language plpgsql as $$
begin
  if new.kind = 'internal_task' and new.client_visible then
    raise exception 'internal_task deadlines cannot be client_visible';
  end if;
  if new.kind = 'internal_task' and (new.assigned_staff_id is not null or new.internal_comment is not null)
     and new.client_visible then
    raise exception 'internal assignment metadata cannot be exposed';
  end if;
  /* P0.4: a statutory period is the firm's obligation and is never a client task. */
  if new.kind in ('appeal','cassation','reconsideration','limitation') and new.client_visible then
    raise exception 'procedural deadlines are the firm''s obligation and cannot be client_visible';
  end if;
  /* And a period that was computed names the provision it was computed from. */
  if new.kind in ('appeal','cassation','reconsideration','limitation')
     and (new.rule_cited is null or new.rule_days is null) then
    raise exception 'a procedural deadline carries the article it was computed from';
  end if;
  return new;
end $$;

-- ── 9a · ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
/*
  NONE OF THESE FOUR TABLES IS GRANTED TO `portal_api`, and there is a policy saying so.

  The judgment register is the firm's case file: the صك, its delivery, the appeal plan, the
  enforcement posture, what the firm thinks the relief is worth. The client's window onto a
  judgment is the matter timeline and the released document — projections that already exist.
  A portal read of the register would hand the client the firm's assessment of their own case
  alongside the court's decision, and would hand the other side's identity and the firm's
  enforcement strategy to whoever holds the client's credentials.

  The non-recursive shape the rest of the schema uses: one policy per command, a visibility
  predicate that does not query the table it protects, and a WITH CHECK that does not re-test
  the visibility it has just changed.
*/
alter table public.court_calendar    enable row level security;
alter table public.judgments         enable row level security;
alter table public.service_events    enable row level security;
alter table public.judgment_appeals  enable row level security;

drop policy if exists court_calendar_firm_all on public.court_calendar;
create policy court_calendar_firm_read on public.court_calendar
  for select to firm_api using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy court_calendar_firm_insert on public.court_calendar
  for insert to firm_api with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy court_calendar_firm_write on public.court_calendar
  for update to firm_api using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy court_calendar_firm_delete on public.court_calendar
  for delete to firm_api using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists judgments_firm_all on public.judgments;
create policy judgments_firm_read on public.judgments
  for select to firm_api using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy judgments_firm_insert on public.judgments
  for insert to firm_api with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy judgments_firm_write on public.judgments
  for update to firm_api using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists service_events_firm_all on public.service_events;
create policy service_events_firm_read on public.service_events
  for select to firm_api using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy service_events_firm_insert on public.service_events
  for insert to firm_api with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy service_events_firm_write on public.service_events
  for update to firm_api using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists judgment_appeals_firm_all on public.judgment_appeals;
create policy judgment_appeals_firm_read on public.judgment_appeals
  for select to firm_api using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy judgment_appeals_firm_insert on public.judgment_appeals
  for insert to firm_api with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy judgment_appeals_firm_write on public.judgment_appeals
  for update to firm_api using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

/* The portal: named, deliberate, and false. */
drop policy if exists court_calendar_portal_none on public.court_calendar;
create policy court_calendar_portal_none on public.court_calendar for select to portal_api using (false);
drop policy if exists judgments_portal_none on public.judgments;
create policy judgments_portal_none on public.judgments for select to portal_api using (false);
drop policy if exists service_events_portal_none on public.service_events;
create policy service_events_portal_none on public.service_events for select to portal_api using (false);
drop policy if exists judgment_appeals_portal_none on public.judgment_appeals;
create policy judgment_appeals_portal_none on public.judgment_appeals for select to portal_api using (false);

-- ── 9b · GRANTS ─────────────────────────────────────────────────────────────────
/*
  FEATURE BY FEATURE, COLUMN BY COLUMN.

  Every column the server names in a statement needs its own privilege, including ones with
  defaults and ones it only reads in a WHERE clause — the class of defect that cost 0028 and
  0038. The lists below are the statements in `FirmRepo`'s P0.4 methods, and
  `scripts/verify/schema-parity.ts` fails if the two drift apart.

  NOTE WHAT IS NOT GRANTED. `firm_api` may not DELETE from `judgments` or `service_events` at
  all: retention is the privilege's job as well as the trigger's, and a privilege cannot be
  dropped by a trigger. `court_calendar` may be deleted from — a closed day that was entered
  twice is corrected, not retained — and that is the only delete in this phase.
*/
grant select on public.court_calendar to firm_api;
grant insert (id, tenant_id, calendar_date, hijri_date, kind, name, name_ar, note,
              created_by_membership_id, created_at, updated_at)
  on public.court_calendar to firm_api;
grant update (calendar_date, hijri_date, kind, name, name_ar, note, updated_at)
  on public.court_calendar to firm_api;
grant delete on public.court_calendar to firm_api;

grant select on public.judgments to firm_api;
grant insert (id, tenant_id, client_id, matter_id, deed_number, case_number, court, court_ar,
              circuit, circuit_ar, judge_name, judgment_kind, presence, urgent, pronounced_at,
              relief_kind, amount_sar, currency, verdict_for, summary, summary_ar, document_id,
              appealable, served_at, service_effective_at, appeal_deadline_at, appeal_rule_cited,
              appeal_rule_days, final_at, stay_in_force, stay_reason, stay_ordered_at,
              enforcement_status, created_by_membership_id, created_at, updated_at)
  on public.judgments to firm_api;
grant update (deed_number, case_number, court, court_ar, circuit, circuit_ar, judge_name,
              judgment_kind, presence, urgent, pronounced_at, relief_kind, amount_sar, currency,
              verdict_for, summary, summary_ar, document_id, appealable, served_at,
              service_effective_at, appeal_deadline_at, appeal_rule_cited, appeal_rule_days,
              final_at, stay_in_force, stay_reason, stay_ordered_at, enforcement_status,
              enforcement_opened_at, enforcement_court, enforcement_reference, satisfied_at,
              recovered_amount_sar, updated_at)
  on public.judgments to firm_api;

grant select on public.service_events to firm_api;
grant insert (id, tenant_id, client_id, matter_id, judgment_id, notice_kind, method, outcome,
              served_on_kind, served_on_name, served_on_party_id, attempted_at, served_at,
              publication_days, effective_at, proof_document_id, proof_reference, acknowledged_at,
              deadline_id, note, recorded_by_membership_id, created_at, updated_at)
  on public.service_events to firm_api;
grant update (outcome, served_on_name, served_on_party_id, attempted_at, served_at,
              publication_days, effective_at, proof_document_id, proof_reference, acknowledged_at,
              deadline_id, note, updated_at)
  on public.service_events to firm_api;

grant select on public.judgment_appeals to firm_api;
grant insert (id, tenant_id, client_id, matter_id, judgment_id, appeal_kind, filed_at,
              filing_deadline_at, rule_cited, rule_days, filed_late, court, court_ar, reference,
              status, outcome, decided_at, result_judgment_id, stay_requested, stay_granted,
              grounds, grounds_ar, created_by_membership_id, created_at, updated_at)
  on public.judgment_appeals to firm_api;
grant update (filing_deadline_at, rule_cited, rule_days, filed_late, court, court_ar, reference,
              status, outcome, decided_at, result_judgment_id, stay_requested, stay_granted,
              grounds, grounds_ar, updated_at)
  on public.judgment_appeals to firm_api;

/* The procedure's writer: the deadline the service creates (P0.4 is the first firm_api writer
   of this table — until now the firm held a SELECT policy and no write privilege at all). */
grant insert (id, matter_id, tenant_id, client_id, kind, title, title_ar, description,
              description_ar, due_at, priority, internal_status, client_status,
              assigned_staff_id, internal_comment, client_visible,
              rule_code, rule_cited, rule_days, trigger_event, source_kind, source_id,
              created_at, updated_at)
  on public.deadlines to firm_api;
grant update (title, title_ar, description, description_ar, due_at, priority, internal_status,
              client_status, assigned_staff_id, internal_comment, client_visible,
              rule_code, rule_cited, rule_days, trigger_event, source_kind, source_id, updated_at)
  on public.deadlines to firm_api;

-- ── 10 · VERIFY ─────────────────────────────────────────────────────────────────
do $$
declare
  n integer;
  missing text;
begin
  /* Four tables, with row-level security actually on. */
  select count(*) into n from pg_tables t
   where t.schemaname = 'public' and t.rowsecurity
     and t.tablename in ('court_calendar','judgments','service_events','judgment_appeals');
  if n <> 4 then
    raise exception '0045: % of the four P0.4 tables have row-level security enabled', n;
  end if;

  /* The guards, by exact name — the near-miss lesson from 0043. */
  for missing in
    select t.name from unnest(array['matter_execution_gate','judgments_clock_guard',
                                    'judgments_enforcement_guard','judgments_retention',
                                    'service_events_retention','deadline_lane_guard']) t(name)
     where not exists (select 1 from pg_trigger g where g.tgname = t.name and not g.tgisinternal)
  loop
    raise exception '0045: the trigger % is not installed', missing;
  end loop;

  /* The lane guard is the restated one, not the 0002 original: check it refuses a client-visible
     appeal deadline. Checked by structure rather than by running it, because a DO block cannot
     insert into a table it is also locking. */
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'assert_deadline_lane'
                    and pg_get_functiondef(p.oid) like '%procedural deadlines are the firm%')
  then
    raise exception '0045: assert_deadline_lane was not restated with the P0.4 rule';
  end if;

  /* The deadline vocabulary admits the four procedural kinds. */
  if not exists (select 1 from pg_constraint c
                  where c.conname = 'deadlines_kind_check'
                    and pg_get_constraintdef(c.oid) like '%reconsideration%')
  then
    raise exception '0045: deadlines.kind does not admit the procedural kinds';
  end if;

  /* AND THE PORTAL HOLDS NOTHING — not "no rows": no privilege. */
  select string_agg(distinct p.table_name, ', ') into missing
    from information_schema.table_privileges p
   where p.table_schema = 'public' and p.grantee = 'portal_api'
     and p.table_name in ('court_calendar','judgments','service_events','judgment_appeals');
  if missing is not null then
    raise exception '0045: portal_api holds a privilege on the firm''s judgment register: %', missing;
  end if;

  /* The firm may not delete a judgment or a service event — retention is also the privilege's job. */
  select string_agg(distinct p.table_name || '.' || p.privilege_type, ', ') into missing
    from information_schema.table_privileges p
   where p.table_schema = 'public' and p.grantee = 'firm_api' and p.privilege_type = 'DELETE'
     and p.table_name in ('judgments','service_events','judgment_appeals');
  if missing is not null then
    raise exception '0045: firm_api holds a DELETE privilege on a retained table: %', missing;
  end if;

  raise notice '0045 applied: the judgment is recorded, its delivery is recorded, the period is computed with its article, and enforcement is refused until both are true.';
end $$;
