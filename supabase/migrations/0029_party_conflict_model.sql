-- ═══════════════════════════════════════════════════════════════════════════════
-- 0029 · THE PARTY MODEL AND THE CONFLICT ENGINE  (analysis I · P0.1)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- THE FINDING THIS CLOSES
--   `matters.conflict_cleared` has existed since migration 0002 as a nullable
--   boolean with nothing behind it. `matters.conflict_cleared` has been `true`,
--   `false` and `null` in this database while the firm had no way to run a
--   conflict check, no record of who the other side was, and no register of who
--   its own clients had been. The column was a state the software would happily
--   record without ever having checked the condition it stands for — which is the
--   single pattern the gap analysis named as the root of every finding.
--
--   Worse, the parties were not merely unchecked: they were UNMODELLED. A
--   counterparty existed only as free text inside `matters.title_ar`, if at all.
--   No query can search a paragraph. So the obligation the rules place on a lawyer
--   before accepting any matter —
--
--     القاعدة الحادية عشرة: على المحامي قبل قبول أي قضية التأكد من … عدم تعارض
--     المصالح بين العميل … وعملاء المحامي السابقين أو الحاليين
--
--   — was not merely unperformed. It was UNPERFORMABLE, which is a different and
--   more serious statement about a piece of legal software.
--
-- THE RULES, AS ENACTED
--   القاعدة الثامنة from قواعد السلوك المهني للمحامين (قرار وزير العدل ٣٤٥٣ وتاريخ
--   ٢٤/١٢/١٤٤٢هـ), which entered force ٣ سبتمبر ٢٠٢١:
--
--     ١- يُحظر على المحامي أي تصرف يمثل تعارضًا فعليًّا أو محتملاً مع مصالح عملائه
--        الحاليين أو السابقين، إلا بعد الموافقة المكتوبة من العميل ذي الصلة.
--     ٢- يُحظر … مع مصالح جهات العمل التي كان يعمل فيها، إلا بعد الموافقة المكتوبة
--        من جهة العمل ذات الصلة.
--     ٣- لا يعد من تعارض المصالح تقديم عملٍ ضد جهات العمل السابقة إذا مر على انقضاء
--        العلاقة معها خمس سنوات.
--     ٤- لا يعد من تعارض المصالح تقديم عملٍ ضد عملاء سابقين إذا مر على انقضاء
--        العلاقة معهم أو تقديم آخر عمل لهم ثلاث سنوات.
--
--   Three things in that text decided the shape of this migration:
--
--   · «فعليًّا أو محتملاً» — ACTUAL or POTENTIAL. The rule names two severities
--     itself, so `conflict_hits.severity` uses the rule's own words rather than a
--     scale this project invented. A finding is 'actual' (a current client), or
--     'potential' (a former client or employer inside the window), or 'none' (the
--     rule's own exception applies and it is not a conflict at all).
--   · «موافقة مكتوبة» — WRITTEN consent. Every prohibition in Rule 8 admits
--     exactly one remedy: a writing signed by the affected party. So nothing here
--     is designed to be "blocked forever"; everything is designed to be
--     *unpassable without a document*, and the waiver is where the document goes.
--   · The windows are THREE and FIVE years, and both are measured from the end of
--     the relationship — so a relationship that has not ended is always inside the
--     window, whatever the age of the file.
--
--   المادة (١٠/٤) من اللائحة التنفيذية adds the same-case rule: partners may not
--   be briefed for opposing parties in one case absent the written consent of the
--   affected parties. That is `relation = 'same_case_opponent'`.
--
-- THE SHAPE OF THE MODEL
--   `parties` is an IDENTITY register, not a client list. It holds anyone the firm
--   has encountered: clients, the other side, guarantors, witnesses, experts. The
--   distinction that matters is that a party can exist in this register BECAUSE
--   the firm acted against them — which is exactly the record a conflict check
--   needs and exactly the record that did not exist.
--
--   Adverseness is NOT a column. It is a property of the role a party holds in a
--   matter, and it is decided in one place, `server/src/domain/conflict-engine.ts`,
--   because the same question ("is this party adverse to this client?") is asked by
--   the search, by the severity rules and by the guard, and three answers to it
--   would eventually disagree.
--
--   A party whose name matched another party is a CANDIDATE until a human says
--   otherwise. The engine never clears a matter on the strength of a string
--   comparison: it produces findings with a stated match strength, and every
--   finding must be dispositioned — confirmed the same party, or ruled out with a
--   reason. "No results" is not a clearance; "every result accounted for" is.
--
-- WHAT THE DATABASE REFUSES TO LET HAPPEN
--   1. A matter may not LEAVE `conflict_check` without an excluding check (Rule 11).
--   2. `matters.conflict_cleared` may not be asserted against the evidence.
--   3. A check that did not see every party currently on the matter does not count.
--   4. A confirmed actual or potential conflict may not stand without a written
--      waiver from the affected party.
--   5. A disposition, once made, cannot be changed (re-open by running a new check).
--   6. A concluded check cannot be un-concluded.
--   7. A waiver cannot be edited or deleted.
--
-- Grantee: firm_api only. `parties` names the firm's adverse parties and its
-- former clients; that is among the most confidential data in the system and the
-- portal role is granted nothing on any of these seven tables.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1 · THE IDENTITY REGISTER ────────────────────────────────────────────────
create table if not exists public.parties (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  kind              text not null default 'company' check (kind in
                     ('individual','company','government','nonprofit','other')),
  -- `name` is the display name as the firm writes it; `name_ar` is the Arabic form
  -- when it is known to differ. Both are kept because the matcher compares both,
  -- and because the register is read by people who write one or the other.
  name              text not null,
  name_ar           text,
  -- DERIVED by the application (`server/src/domain/arabic-names.ts`) and stored so
  -- candidate search is an indexable scan instead of a per-row computation.
  -- The DECISION never trusts this column: the engine recomputes both sides in
  -- TypeScript. A change to the normalisation rules therefore costs RECALL (a
  -- candidate is missed) rather than CORRECTNESS (a party wrongly cleared), and a
  -- missed candidate is what the identifier columns below exist to catch.
  name_normalized   text not null,
  -- Identifiers, normalised to digits by the same module. A shared commercial
  -- registration is a DECISIVE match whatever the names say; that is why these are
  -- stored rather than left inside a free-text notes field.
  commercial_registration text,
  vat_number        text,
  -- The same convention as `clients`: the masked value is safe to render, the hash
  -- verifies a value the holder already knows, and the plaintext never arrives.
  national_id_masked text,
  national_id_hash  text,
  status            text not null default 'active' check (status in
                     ('active','archived','merged')),
  -- Merging is how two register entries discovered to be one company are unified
  -- without deleting either — because the matters that reference both must keep
  -- resolving, and because the pair that turned out to be the same party is itself
  -- information about how this firm records names.
  merged_into_party_id uuid references public.parties(id) on delete set null,
  notes             text,
  created_by_membership_id uuid references public.firm_memberships(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint parties_merge_not_self
    check (merged_into_party_id is null or merged_into_party_id <> id),
  -- A merged party must say what it became, or the merge is a silent disappearance.
  constraint parties_merged_has_target
    check (status <> 'merged' or merged_into_party_id is not null)
);

create index if not exists parties_tenant_name_idx
  on public.parties(tenant_id, name_normalized);
create index if not exists parties_tenant_cr_idx
  on public.parties(tenant_id, commercial_registration) where commercial_registration is not null;
create index if not exists parties_tenant_vat_idx
  on public.parties(tenant_id, vat_number) where vat_number is not null;
create index if not exists parties_tenant_nid_idx
  on public.parties(tenant_id, national_id_hash) where national_id_hash is not null;

comment on table public.parties is
  'Identity register for every person and entity the firm has encountered, including adverse parties. Never exposed to the portal.';
comment on column public.parties.name_normalized is
  'DERIVED by the application. Used for candidate generation only; the match decision recomputes both sides in TypeScript.';

-- ── 2 · ALIASES ──────────────────────────────────────────────────────────────
-- A company appears in a court filing as «شركة الأفق للتجارة», in Najiz as «الأفق
-- للتجارة», on the CR as «شركة أفق التجارة المحدودة», and in English as «Gulf
-- Horizon Trading Co.». Those are one party. Without aliases the register would
-- hold four, and a conflict search would find whichever one the searcher happened
-- to type — which is to say it would find the conflict some of the time.
create table if not exists public.party_aliases (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  party_id          uuid not null references public.parties(id) on delete cascade,
  alias             text not null,
  alias_normalized  text not null,
  script            text not null default 'ar' check (script in ('ar','en','other')),
  -- Where the variant came from. A name taken from a court filing is evidence; a
  -- name typed from memory is a note, and the difference matters when a match is
  -- later disputed.
  source            text check (source is null or source in
                     ('court_filing','najiz','commercial_registration','client_statement',
                      'opposing_counsel','manual','other')),
  -- Why this spelling is recorded, when it is worth saying: which filing it came
  -- from, whether the legal form differs. A bare list of variants is hard to trust.
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, party_id, alias_normalized)
);

create index if not exists party_aliases_norm_idx
  on public.party_aliases(tenant_id, alias_normalized);

-- ── 3 · AFFILIATIONS — the firm's own people, and who they used to work for ──
-- Rule 8/2 forbids conduct against a former employer of the lawyer, and Rule 8/3
-- gives that prohibition a five-year life. The obligation is about a PERSON, so it
-- cannot live on the matter's party list: it is a property of a member of staff.
--
-- `board_member`, `shareholder` and `other_interest` are here for the same reason
-- Rule 8/1 uses the words «فعليًّا أو محتملاً»: a partner who sits on a company's
-- board has a potential conflict with every matter that company is adverse in, and
-- the firm cannot expect anyone to remember that relationship unaided.
create table if not exists public.party_affiliations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  party_id          uuid not null references public.parties(id) on delete cascade,
  staff_id          uuid not null references public.staff(id) on delete cascade,
  relation          text not null check (relation in
                     ('former_employer','current_employer','board_member',
                      'shareholder','other_interest')),
  started_on        date,
  ended_on          date,
  note              text,
  recorded_by_membership_id uuid references public.firm_memberships(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, staff_id, party_id, relation),
  constraint party_affiliations_dates
    check (ended_on is null or started_on is null or ended_on >= started_on)
);

create index if not exists party_affiliations_staff_idx
  on public.party_affiliations(tenant_id, staff_id);

-- ── 4 · WHO IS ON THE MATTER, AND IN WHAT CAPACITY ───────────────────────────
-- THERE IS NO 'client' ROLE, deliberately, and the check constraint below enforces
-- its absence. The client of a matter is `matters.client_id` → `clients`; a second
-- way to say it would be a second answer to "who is the client", and the conflict
-- engine's entire question is which side of a matter a party is on.
create table if not exists public.matter_parties (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  matter_id         uuid not null references public.matters(id) on delete cascade,
  party_id          uuid not null references public.parties(id) on delete restrict,
  role              text not null check (role in
                     ('counterparty','adverse_party','related_entity','guarantor',
                      'witness','expert','interested_party','other')),
  note              text,
  added_by_membership_id uuid references public.firm_memberships(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, matter_id, party_id, role)
);

create index if not exists matter_parties_matter_idx
  on public.matter_parties(tenant_id, matter_id);
create index if not exists matter_parties_party_idx
  on public.matter_parties(tenant_id, party_id);

-- ── 5 · THE CHECK ITSELF ─────────────────────────────────────────────────────
create table if not exists public.conflict_checks (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  matter_id         uuid not null references public.matters(id) on delete cascade,
  kind              text not null default 'intake' check (kind in
                     ('intake','adverse_check','periodic','recheck')),
  status            text not null default 'running' check (status in
                     ('running','clear','cleared_with_waiver','conflicts_not_accepted','abandoned')),
  -- What the check actually looked at. A clearance is only meaningful together
  -- with the scope it was given, and months later nobody remembers the scope.
  parties_checked   integer not null default 0,
  matters_searched  integer not null default 0,
  hits_found        integer not null default 0,
  started_by_membership_id  uuid not null references public.firm_memberships(id) on delete restrict,
  started_at        timestamptz not null default now(),
  concluded_by_membership_id uuid references public.firm_memberships(id) on delete set null,
  concluded_at      timestamptz,
  conclusion        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- A concluded check has a time and a person; a running one has neither. This
  -- makes "concluded" checkable rather than a word in a status field.
  constraint conflict_checks_conclusion
    check ((status = 'running') = (concluded_at is null)),
  constraint conflict_checks_concluder
    check ((concluded_at is null) = (concluded_by_membership_id is null))
);

create index if not exists conflict_checks_matter_idx
  on public.conflict_checks(tenant_id, matter_id, started_at desc);

-- ── 6 · WHAT WAS FOUND ───────────────────────────────────────────────────────
create table if not exists public.conflict_hits (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  check_id          uuid not null references public.conflict_checks(id) on delete cascade,
  -- Denormalised from the check so the matter guard is a single-table read. The
  -- guard runs on every status change and must not need three joins to answer a
  -- question it asks thousands of times.
  matter_id         uuid not null references public.matters(id) on delete cascade,
  -- The party as it is recorded on THIS matter — the party being screened.
  party_id          uuid not null references public.parties(id) on delete restrict,
  -- The existing party it resembles, and the matter where that party appeared.
  -- Nullable because an identifier can match a party with no prior matter (a party
  -- created for an intake that was never opened), which is still a finding.
  matched_party_id  uuid references public.parties(id) on delete restrict,
  matched_matter_id uuid references public.matters(id) on delete set null,
  matched_client_id uuid references public.clients(id) on delete set null,
  relation          text not null check (relation in
                     ('former_client','current_client','former_employer','current_employer',
                      'same_case_opponent','linked_party','related_entity')),
  -- HOW SURE THE MACHINE IS, and separately WHAT A HUMAN DECIDED. Keeping them
  -- apart is the whole point: 'exact' from an identifier is a fact, 'candidate'
  -- from a shared token is a question, and collapsing the two would let a
  -- string comparison clear a file.
  match_strength    text not null check (match_strength in ('exact','strong','candidate')),
  match_basis       text not null check (match_basis in
                     ('name','alias','commercial_registration','vat_number','national_id_hash')),
  -- Whose written consent Rule 8 requires. Required whenever severity is actual or
  -- potential, enforced below by trigger, because a waiver has to name somebody and
  -- the database should not accept a consent from a party with no connection to the
  -- conflict.
  affected_party_id uuid references public.parties(id) on delete restrict,
  severity          text check (severity in ('actual','potential','none')),
  rule_cited        text not null,
  -- The Rule 8 windows, computed by the engine and STORED as the evidence of what
  -- was decided on the day. A window recomputed later could differ; the point of a
  -- conflict record is what the firm knew when it accepted the work.
  relationship_ended_on date,
  window_years      integer,
  window_lifts_on   date,
  within_window     boolean,
  disposition       text not null default 'open' check (disposition in
                     ('open','different_party','same_party')),
  disposition_reason text,
  disposition_by_membership_id uuid references public.firm_memberships(id) on delete set null,
  disposition_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (check_id, party_id, matched_matter_id, affected_party_id, relation),
  -- A disposition has a reason, a person and a time, or it is still open.
  constraint conflict_hits_disposition_complete
    check ((disposition = 'open') = (disposition_at is null)),
  -- A confirmed conflict must carry both a severity and the party whose consent the
  -- rule requires. Without this, a 'same_party' hit with a null affected party
  -- would be unwaivable — refused by the guard forever and impossible to satisfy,
  -- which is the shape of a control that gets disabled.
  constraint conflict_hits_confirmed_complete
    check (disposition <> 'same_party' or (severity is not null and affected_party_id is not null)),
  -- The rule's own exception is a finding that severity is 'none'; a severity of
  -- 'none' on a hit nobody confirmed would be a machine clearing itself.
  constraint conflict_hits_severity_needs_confirmation
    check (severity is null or disposition = 'same_party')
);

create index if not exists conflict_hits_check_idx on public.conflict_hits(check_id);
create index if not exists conflict_hits_matter_idx on public.conflict_hits(tenant_id, matter_id);
create index if not exists conflict_hits_open_idx on public.conflict_hits(check_id) where disposition = 'open';

-- ── 7 · THE WRITTEN CONSENT ──────────────────────────────────────────────────
-- «إلا بعد الموافقة المكتوبة من العميل ذي الصلة» — the exception is a WRITING.
-- Several waivers may belong to one hit: المادة (١٠/٤) requires the consent of the
-- affected parties, plural, when partners are briefed for opposing sides in one
-- case, and the engine emits one hit per required consent rather than one hit with
-- an unstated number of signatories.
create table if not exists public.conflict_waivers (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  hit_id            uuid not null references public.conflict_hits(id) on delete cascade,
  matter_id         uuid not null references public.matters(id) on delete cascade,
  waived_by_party_id uuid not null references public.parties(id) on delete restrict,
  -- Either the document itself or, until firm-side document handling exists (P2.1),
  -- a reference that identifies the writing in the firm's own records. The CHECK
  -- below requires ONE OF THEM: Rule 8 does not accept an unwritten consent, and a
  -- waiver with neither field would be a claim that a writing exists somewhere.
  consent_document_id uuid references public.documents(id) on delete set null,
  consent_reference  text,
  consent_signed_on  date not null,
  scope              text not null,
  recorded_by_membership_id uuid not null references public.firm_memberships(id) on delete restrict,
  created_at         timestamptz not null default now(),
  constraint conflict_waivers_written
    check (consent_document_id is not null
           or (consent_reference is not null and btrim(consent_reference) <> ''))
);

create index if not exists conflict_waivers_hit_idx on public.conflict_waivers(hit_id);

-- ── 8 · THE CLIENT LINK ──────────────────────────────────────────────────────
-- `clients` is a commercial relationship; `parties` is an identity. The link is
-- nullable because the register arrived after the clients did, and the engine
-- matches unlinked clients on their own name columns — one matcher, two storage
-- paths, no second rule. See `resolveClientParty()` in the repository.
alter table public.clients
  add column if not exists party_id uuid references public.parties(id) on delete set null;

-- When the firm stopped acting for a client. Rule 8/4 measures three years from the
-- end of the relationship OR from the last work done for them, so this column is an
-- OVERRIDE: the repository falls back to the most recent matter closed for that
-- client when it is null. One expression, in `clientRelationshipEndedOn()`.
alter table public.clients
  add column if not exists relationship_ended_on date;

create index if not exists clients_party_idx
  on public.clients(tenant_id, party_id) where party_id is not null;

-- ── 9 · IMMUTABILITY OF THE RECORD ───────────────────────────────────────────
-- A disposition that can be revised is not a disposition. The remedy for a wrong
-- call is to run another check, which leaves both on the record — so what the firm
-- believed, and when, survives the correction.
create or replace function public.conflict_hits_guard_disposition() returns trigger
language plpgsql as $$
begin
  if old.disposition <> 'open' and new.disposition <> old.disposition then
    raise exception using
      errcode = '23514',
      message = 'a conflict disposition is final: run a new check rather than revising the record';
  end if;
  -- Severity and the affected party travel with the confirmation and may not be
  -- rewritten afterwards either; they are what the waiver was measured against.
  if old.disposition <> 'open' and (
       new.severity is distinct from old.severity
       or new.affected_party_id is distinct from old.affected_party_id
       or new.rule_cited is distinct from old.rule_cited
       or new.within_window is distinct from old.within_window
     ) then
    raise exception using
      errcode = '23514',
      message = 'the findings behind a conflict disposition are evidence and may not be rewritten';
  end if;
  return new;
end $$;

drop trigger if exists conflict_hits_disposition_final on public.conflict_hits;
create trigger conflict_hits_disposition_final
  before update on public.conflict_hits
  for each row execute function public.conflict_hits_guard_disposition();

-- A concluded check is the firm's record of having performed Rule 11. Re-opening it
-- would let a clearance be withdrawn after work was accepted, which is the one
-- direction of change that must be impossible.
create or replace function public.conflict_checks_guard_conclusion() returns trigger
language plpgsql as $$
begin
  if old.concluded_at is not null and new.status <> old.status then
    raise exception using
      errcode = '23514',
      message = 'a concluded conflict check is evidence: run a new check rather than reopening it';
  end if;
  return new;
end $$;

drop trigger if exists conflict_checks_conclusion_final on public.conflict_checks;
create trigger conflict_checks_conclusion_final
  before update on public.conflict_checks
  for each row execute function public.conflict_checks_guard_conclusion();

-- Waivers are append-only. A consent that can be edited is a consent whose terms
-- cannot be proved, and the terms are the whole content of a waiver.
create or replace function public.conflict_waivers_immutable() returns trigger
language plpgsql as $$
begin
  raise exception using
    errcode = '23514',
    message = 'a written consent is evidence: it is recorded once and never edited or withdrawn';
end $$;

drop trigger if exists conflict_waivers_immutable on public.conflict_waivers;
create trigger conflict_waivers_immutable
  before update or delete on public.conflict_waivers
  for each row execute function public.conflict_waivers_immutable();

-- The consent must come from the party the finding says needs to give it. Without
-- this, any signature would satisfy any conflict, and "we obtained consent" would
-- be unverifiable at exactly the moment it is tested.
create or replace function public.conflict_waivers_guard_party() returns trigger
language plpgsql as $$
declare
  expected uuid;
begin
  select h.affected_party_id into expected
    from public.conflict_hits h where h.id = new.hit_id;
  if expected is null then
    raise exception using
      errcode = '23514',
      message = 'the finding names no affected party, so no consent can be matched to it';
  end if;
  if new.waived_by_party_id <> expected then
    raise exception using
      errcode = '23514',
      message = 'the consent must come from the party affected by the conflict, as recorded on the finding';
  end if;
  return new;
end $$;

drop trigger if exists conflict_waivers_party_guard on public.conflict_waivers;
create trigger conflict_waivers_party_guard
  before insert on public.conflict_waivers
  for each row execute function public.conflict_waivers_guard_party();

-- ── 10 · THE GATE ────────────────────────────────────────────────────────────
-- Rule 11 is a precondition on accepting work, so the thing it guards is the
-- TRANSITION out of `conflict_check` — not the existence of a row.
--
-- The whole guard is one quantified statement, and it is worth reading as one:
-- there must exist a conflict check for this matter which is concluded and
-- clearing, which saw every party currently on the matter, which left no finding
-- undispositioned, and against which every confirmed actual or potential conflict
-- has a written waiver.
--
-- Two deliberate choices:
--
--   · It fires on UPDATE only. Matters that predate this migration are sitting in
--     `active` with a null `conflict_cleared`, and a guard on INSERT or a blanket
--     consistency check would refuse to let the firm touch its own existing files.
--     This guards MOVEMENT, which is what the rule governs.
--
--   · It blocks every target except `archived`. Declining an intake without running
--     a check is legitimate — the firm may simply not want the work — and requiring
--     a conflict check before abandoning a matter would be a rule with no
--     obligation behind it. Accepting the work is what Rule 11 forbids.
create or replace function public.matter_conflict_guard() returns trigger
language plpgsql as $$
declare
  covered boolean;
begin
  select exists (
    select 1 from public.conflict_checks c
     where c.matter_id = new.id
       and c.status in ('clear','cleared_with_waiver')
       -- Every party on the matter now was on the matter when the check ran. A
       -- witness added afterwards invalidates the clearance too; that is
       -- deliberately conservative, and it keeps the classification of adverseness
       -- in one place — the engine — rather than duplicating the role vocabulary
       -- into this trigger.
       and not exists (
         select 1 from public.matter_parties mp
          where mp.matter_id = new.id and mp.created_at > c.started_at)
       and not exists (
         select 1 from public.conflict_hits h
          where h.check_id = c.id and h.disposition = 'open')
       and not exists (
         select 1 from public.conflict_hits h
          where h.check_id = c.id
            and h.disposition = 'same_party'
            and h.severity in ('actual','potential')
            and not exists (select 1 from public.conflict_waivers w where w.hit_id = h.id))
  ) into covered;

  -- (a) The derived value may not contradict the evidence. Same precedent as
  --     `guard_invoice_state`, which derives `invoices.client_status`, and the same
  --     reason: a column that can disagree with the record it summarises is worse
  --     than no column, because it is believed.
  if new.conflict_cleared is not null and new.conflict_cleared <> covered then
    raise exception using
      errcode = '23514',
      message = 'matters.conflict_cleared is derived from the conflict checks and may not be asserted';
  end if;

  -- (b) Rule 11: work may not be accepted on an unexamined file.
  if tg_op = 'UPDATE'
     and old.internal_status = 'conflict_check'
     and new.internal_status <> 'conflict_check'
     and new.internal_status <> 'archived'
     and not covered then
    raise exception using
      errcode = '23514',
      message = 'a matter may not leave conflict_check without an excluding conflict check (Rule 11)';
  end if;

  return new;
end $$;

drop trigger if exists matter_conflict_gate on public.matters;
create trigger matter_conflict_gate
  before update on public.matters
  for each row execute function public.matter_conflict_guard();

-- ── 11 · GRANTS ──────────────────────────────────────────────────────────────
-- Every column the server names in a statement needs its own privilege, including
-- ones with defaults — the defect that cost 0028. Column lists here match
-- `FirmRepo` exactly, and `scripts/verify/schema-parity.ts` fails if they drift.
grant select (id, tenant_id, kind, name, name_ar, name_normalized,
              commercial_registration, vat_number, national_id_masked, national_id_hash,
              status, merged_into_party_id, notes, created_by_membership_id,
              created_at, updated_at)
  on public.parties to firm_api;
grant insert (id, tenant_id, kind, name, name_ar, name_normalized,
              commercial_registration, vat_number, national_id_masked, national_id_hash,
              status, notes, created_by_membership_id, created_at, updated_at)
  on public.parties to firm_api;
grant update (kind, name, name_ar, name_normalized, commercial_registration, vat_number,
              national_id_masked, national_id_hash, status, merged_into_party_id,
              notes, updated_at)
  on public.parties to firm_api;

grant select (id, tenant_id, party_id, alias, alias_normalized, script, source, note,
              created_at, updated_at)
  on public.party_aliases to firm_api;
grant insert (id, tenant_id, party_id, alias, alias_normalized, script, source, note,
              created_at, updated_at)
  on public.party_aliases to firm_api;
grant update (alias, alias_normalized, script, source, note, updated_at)
  on public.party_aliases to firm_api;

grant select (id, tenant_id, party_id, staff_id, relation, started_on, ended_on,
              note, recorded_by_membership_id, created_at, updated_at)
  on public.party_affiliations to firm_api;
grant insert (id, tenant_id, party_id, staff_id, relation, started_on, ended_on,
              note, recorded_by_membership_id, created_at, updated_at)
  on public.party_affiliations to firm_api;
grant update (started_on, ended_on, note, updated_at)
  on public.party_affiliations to firm_api;

grant select (id, tenant_id, matter_id, party_id, role, note,
              added_by_membership_id, created_at, updated_at)
  on public.matter_parties to firm_api;
grant insert (id, tenant_id, matter_id, party_id, role, note,
              added_by_membership_id, created_at, updated_at)
  on public.matter_parties to firm_api;
grant update (role, note, updated_at)
  on public.matter_parties to firm_api;

grant select (id, tenant_id, matter_id, kind, status, parties_checked, matters_searched,
              hits_found, started_by_membership_id, started_at, concluded_by_membership_id,
              concluded_at, conclusion, created_at, updated_at)
  on public.conflict_checks to firm_api;
grant insert (id, tenant_id, matter_id, kind, status, parties_checked, matters_searched,
              hits_found, started_by_membership_id, started_at, created_at, updated_at)
  on public.conflict_checks to firm_api;
grant update (status, parties_checked, matters_searched, hits_found,
              concluded_by_membership_id, concluded_at, conclusion, updated_at)
  on public.conflict_checks to firm_api;

grant select (id, tenant_id, check_id, matter_id, party_id, matched_party_id,
              matched_matter_id, matched_client_id, relation, match_strength, match_basis,
              affected_party_id, severity, rule_cited, relationship_ended_on,
              window_years, window_lifts_on, within_window, disposition,
              disposition_reason, disposition_by_membership_id, disposition_at,
              created_at, updated_at)
  on public.conflict_hits to firm_api;
grant insert (id, tenant_id, check_id, matter_id, party_id, matched_party_id,
              matched_matter_id, matched_client_id, relation, match_strength, match_basis,
              affected_party_id, severity, rule_cited, relationship_ended_on,
              window_years, window_lifts_on, within_window, disposition,
              disposition_reason, disposition_by_membership_id, disposition_at,
              created_at, updated_at)
  on public.conflict_hits to firm_api;
grant update (disposition, disposition_reason, disposition_by_membership_id,
              disposition_at, severity, affected_party_id, updated_at)
  on public.conflict_hits to firm_api;

grant select (id, tenant_id, hit_id, matter_id, waived_by_party_id, consent_document_id,
              consent_reference, consent_signed_on, scope, recorded_by_membership_id,
              created_at)
  on public.conflict_waivers to firm_api;
grant insert (id, tenant_id, hit_id, matter_id, waived_by_party_id, consent_document_id,
              consent_reference, consent_signed_on, scope, recorded_by_membership_id,
              created_at)
  on public.conflict_waivers to firm_api;

-- The client link and the relationship end date, both added by this migration.
grant update (party_id, relationship_ended_on, updated_at) on public.clients to firm_api;

-- ── deliberately NOT granted ─────────────────────────────────────────────────
--   DELETE on all seven tables.
--
--     A conflict register that can be deleted is a conflict register that can be
--     emptied, and the party set of a matter is what a clearance claims to have
--     covered: a row that can vanish makes the coverage claim unfalsifiable. The
--     corrections people legitimately need — a party added by mistake, a name
--     spelled wrong, an affiliation that has ended — are all UPDATEs.
--   UPDATE on conflict_waivers.
--     Refused by trigger as well. A consent is recorded once.
--   conflict_checks.status on a concluded row.
--     Granted, because concluding a check sets it; the trigger refuses a change of
--     mind afterwards.
--   `parties.national_id_hash` SELECT is granted; the PLAINTEXT never exists in
--     this database, which is the `clients` convention unchanged.

-- ── 12 · ROW-LEVEL SECURITY ─────────────────────────────────────────────────
alter table public.parties            enable row level security;
alter table public.party_aliases      enable row level security;
alter table public.party_affiliations enable row level security;
alter table public.matter_parties     enable row level security;
alter table public.conflict_checks    enable row level security;
alter table public.conflict_hits      enable row level security;
alter table public.conflict_waivers   enable row level security;

-- parties
drop policy if exists parties_read on public.parties;
create policy parties_read on public.parties
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists parties_insert on public.parties;
create policy parties_insert on public.parties
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists parties_update on public.parties;
create policy parties_update on public.parties
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  -- USING is the old row and WITH CHECK the new one. Both are needed: without the
  -- second, a tenant could move a party into another firm's register, which is the
  -- one way a conflict register could be poisoned from outside.
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

-- party_aliases
drop policy if exists party_aliases_read on public.party_aliases;
create policy party_aliases_read on public.party_aliases
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists party_aliases_insert on public.party_aliases;
create policy party_aliases_insert on public.party_aliases
  for insert to firm_api
  with check (
    public.kgm_is_firm() and tenant_id = public.kgm_tenant()
    -- An alias may only be attached to a party of the same firm. Without this a
    -- tenant could attach an alias to a foreign party id, and the alias is what
    -- decides a match.
    and exists (select 1 from public.parties p
                 where p.id = party_id and p.tenant_id = public.kgm_tenant())
  );

drop policy if exists party_aliases_update on public.party_aliases;
create policy party_aliases_update on public.party_aliases
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

-- party_affiliations
drop policy if exists party_affiliations_read on public.party_affiliations;
create policy party_affiliations_read on public.party_affiliations
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists party_affiliations_insert on public.party_affiliations;
create policy party_affiliations_insert on public.party_affiliations
  for insert to firm_api
  with check (
    public.kgm_is_firm() and tenant_id = public.kgm_tenant()
    -- Both ends of the relation must be this firm's: a party from one firm and a
    -- member of another would be a conflict declared across a tenancy boundary.
    and exists (select 1 from public.parties p
                 where p.id = party_id and p.tenant_id = public.kgm_tenant())
    and exists (select 1 from public.staff s
                 where s.id = staff_id and s.tenant_id = public.kgm_tenant())
  );

drop policy if exists party_affiliations_update on public.party_affiliations;
create policy party_affiliations_update on public.party_affiliations
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

-- matter_parties
drop policy if exists matter_parties_read on public.matter_parties;
create policy matter_parties_read on public.matter_parties
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists matter_parties_insert on public.matter_parties;
create policy matter_parties_insert on public.matter_parties
  for insert to firm_api
  with check (
    public.kgm_is_firm() and tenant_id = public.kgm_tenant()
    and exists (select 1 from public.parties p
                 where p.id = party_id and p.tenant_id = public.kgm_tenant())
    and exists (select 1 from public.matters m
                 where m.id = matter_id and m.tenant_id = public.kgm_tenant())
  );

drop policy if exists matter_parties_update on public.matter_parties;
create policy matter_parties_update on public.matter_parties
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

-- conflict_checks
drop policy if exists conflict_checks_read on public.conflict_checks;
create policy conflict_checks_read on public.conflict_checks
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists conflict_checks_insert on public.conflict_checks;
create policy conflict_checks_insert on public.conflict_checks
  for insert to firm_api
  with check (
    public.kgm_is_firm() and tenant_id = public.kgm_tenant()
    -- Attribution, the same rule as `matter_permissions` in 0021: a check records
    -- who performed it, and a member may not perform one in another member's name.
    and started_by_membership_id = public.kgm_membership()
    and exists (select 1 from public.matters m
                 where m.id = matter_id and m.tenant_id = public.kgm_tenant())
  );

drop policy if exists conflict_checks_update on public.conflict_checks;
create policy conflict_checks_update on public.conflict_checks
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  -- The person who concludes a check is the person whose name is on it. A
  -- conclusion recorded on someone else's behalf is the shape of an audit that
  -- cannot be relied on.
  with check (
    public.kgm_is_firm() and tenant_id = public.kgm_tenant()
    and (concluded_by_membership_id is null
         or concluded_by_membership_id = public.kgm_membership())
  );

-- conflict_hits
drop policy if exists conflict_hits_read on public.conflict_hits;
create policy conflict_hits_read on public.conflict_hits
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists conflict_hits_insert on public.conflict_hits;
create policy conflict_hits_insert on public.conflict_hits
  for insert to firm_api
  with check (
    public.kgm_is_firm() and tenant_id = public.kgm_tenant()
    and exists (select 1 from public.conflict_checks c
                 where c.id = check_id and c.tenant_id = public.kgm_tenant())
  );

drop policy if exists conflict_hits_update on public.conflict_hits;
create policy conflict_hits_update on public.conflict_hits
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (
    public.kgm_is_firm() and tenant_id = public.kgm_tenant()
    and (disposition_by_membership_id is null
         or disposition_by_membership_id = public.kgm_membership())
  );

-- conflict_waivers
drop policy if exists conflict_waivers_read on public.conflict_waivers;
create policy conflict_waivers_read on public.conflict_waivers
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists conflict_waivers_insert on public.conflict_waivers;
create policy conflict_waivers_insert on public.conflict_waivers
  for insert to firm_api
  with check (
    public.kgm_is_firm() and tenant_id = public.kgm_tenant()
    and recorded_by_membership_id = public.kgm_membership()
    and exists (select 1 from public.conflict_hits h
                 where h.id = hit_id and h.tenant_id = public.kgm_tenant())
  );

-- ── 13 · THE AUDIT VOCABULARY ───────────────────────────────────────────────
-- Recreated, not extended: the constraint is a literal list, and migration 0023
-- binds it to the TypeScript union. A declared action the database rejects is a
-- dropped audit row or a 500, and neither of those says "the vocabulary is out of
-- date" — which is why the DO-block below fails loudly instead.
--
-- THIS LIST WAS FIRST WRITTEN BY HAND AND WAS WRONG. It contained plausible action
-- names that do not exist (MATTER_CREATED, INVOICE_SENT, CLIENT_VIEWED) and omitted
-- 18 that do (INVITATION_CREATED, MFA_ENABLED, AUTHZ_DENIED, SIGNED_URL_ISSUED,
-- LICENCE_VERIFIED, ELIGIBILITY_EVALUATED, MULTI_FIRM_AFFILIATION_DENIED …). The
-- migration refused to apply, because it would have NARROWED a live constraint and
-- silently disarmed the audit log for every action it dropped: a write of a
-- removed action would fail at runtime, in production, in the one subsystem whose
-- failures are supposed to be impossible.
--
-- It is now generated from `AuditAction` in server/src/audit/logger.ts, which is
-- the source migration 0023 established, and `scripts/verify/audit-vocabulary.ts`
-- compares the two from here on. The rule this codebase keeps relearning is that a
-- list that must agree with another list has to be checked, not remembered.
alter table public.audit_events drop constraint audit_events_action_check;

alter table public.audit_events add constraint audit_events_action_check
  check (action in (
    'LOGIN','LOGIN_FAILED','LOGOUT','LOGOUT_ALL_OTHERS','SESSION_EXPIRED',
    'SESSION_REVOKED','ACCOUNT_LOCKED','RATE_LIMITED','PASSWORD_RESET_REQUESTED','PASSWORD_RESET_COMPLETED',
    'PASSWORD_CHANGED','EMAIL_VERIFICATION_SENT','EMAIL_VERIFIED','INVITATION_CREATED','INVITATION_ACCEPTED',
    'INVITATION_EXPIRED','INVITATION_REVOKED','MFA_ENROLLMENT_STARTED','MFA_ENABLED','MFA_DISABLED',
    'MFA_VERIFIED','MFA_FAILED','DEVICE_TRUSTED','DEVICE_UNTRUSTED','DOCUMENT_VIEWED',
    'DOCUMENT_DOWNLOADED','DOCUMENT_UPLOADED','DOCUMENT_UPLOAD_REJECTED','SIGNED_URL_ISSUED','DOCUMENT_ACCESS_DENIED',
    'INVOICE_VIEWED','PAYMENT_STARTED','PAYMENT_COMPLETED','PAYMENT_FAILED','RECEIPT_VIEWED',
    'WEBHOOK_RECEIVED','WEBHOOK_SIGNATURE_INVALID','MESSAGE_SENT','MESSAGE_READ','APPOINTMENT_REQUESTED',
    'APPOINTMENT_CANCELLED','PROFILE_UPDATED','PREFERENCES_UPDATED','NOTIFICATION_READ','PRIVACY_REQUEST_SUBMITTED',
    'CONSENT_RECORDED','AUTHZ_DENIED','TENANT_ISOLATION_VIOLATION','CLIENT_ISOLATION_VIOLATION','INTERNAL_RESOURCE_ACCESS_ATTEMPT',
    'FIELD_TAMPER_ATTEMPT','MUTATION_DENIED','FIRM_LOGIN','FIRM_LOGIN_FAILED','FIRM_LOGOUT',
    'FIRM_SESSION_REVOKED','FIRM_MFA_VERIFIED','FIRM_MFA_FAILED','PERMISSION_DENIED','MATTER_SCOPE_DENIED',
    'CEILING_EXCEEDED','ROLE_GRANTED','ROLE_REVOKED','MATTER_ACCESS_GRANTED','MATTER_ACCESS_REVOKED',
    'MATTER_RESTRICTED','MATTER_UNRESTRICTED','ESCALATION_ATTEMPT','ADMIN_MUTATION','PARTY_CREATED',
    'PARTY_UPDATED','PARTY_MERGED','PARTY_ALIAS_ADDED','PARTY_AFFILIATION_RECORDED','MATTER_PARTY_ADDED',
    'MATTER_PARTY_UPDATED','MATTER_STATUS_CHANGED','CONFLICT_CHECK_RUN','CONFLICT_HIT','CONFLICT_DISPOSITION_RECORDED',
    'CONFLICT_CLEARED','CONFLICT_DECLINED','CONFLICT_WAIVED','MATTER_VIEWED','LICENCE_RECORDED',
    'LICENCE_STATUS_CHANGED','LICENCE_VERIFIED','PRIOR_OFFICE_RECORDED','TENANT_RELATIONSHIP_DECLARED','ELIGIBILITY_EVALUATED',
    'ELIGIBILITY_DENIED','MULTI_FIRM_AFFILIATION_DENIED'
  ));

-- ── 14 · VERIFY ─────────────────────────────────────────────────────────────
do $$
declare
  missing text;
  n integer;
begin
  -- The seven tables and the two client columns.
  select string_agg(t.name, ', ') into missing
    from unnest(array['parties','party_aliases','party_affiliations','matter_parties',
                      'conflict_checks','conflict_hits','conflict_waivers']) t(name)
   where to_regclass('public.' || t.name) is null;
  if missing is not null then
    raise exception '0029: tables missing: %', missing;
  end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'clients'
     and column_name in ('party_id','relationship_ended_on');
  if n <> 2 then
    raise exception '0029: clients.party_id / relationship_ended_on missing (% of 2)', n;
  end if;

  -- Every new table must be protected. A table with RLS enabled and no policy is
  -- closed, a table with a policy and no RLS is open, and both look like "granted"
  -- from the API. Only an API request distinguishes them, but a missing policy is
  -- worth catching here rather than in production.
  select string_agg(t.name, ', ') into missing
    from unnest(array['parties','party_aliases','party_affiliations','matter_parties',
                      'conflict_checks','conflict_hits','conflict_waivers']) t(name)
   where not exists (select 1 from pg_policies p where p.tablename = t.name and p.schemaname='public');
  if missing is not null then
    raise exception '0029: tables with no policy: %', missing;
  end if;

  -- The guard must be installed, or the gate is documentation.
  select count(*) into n from pg_trigger
   where tgname in ('matter_conflict_gate','conflict_hits_disposition_final',
                    'conflict_checks_conclusion_final','conflict_waivers_immutable',
                    'conflict_waivers_party_guard') and not tgisinternal;
  if n <> 5 then
    raise exception '0029: expected 5 guards, found %', n;
  end if;

  -- The audit union and the constraint must have moved together.
  select string_agg(a.name, ', ') into missing
    from unnest(array['PARTY_CREATED','MATTER_PARTY_ADDED','CONFLICT_CHECK_RUN',
                      'CONFLICT_HIT','CONFLICT_DISPOSITION_RECORDED','CONFLICT_CLEARED',
                      'CONFLICT_DECLINED','CONFLICT_WAIVED','MATTER_STATUS_CHANGED']) a(name)
   where not exists (
     select 1 from pg_constraint c
      where c.conname = 'audit_events_action_check'
        and c.conrelid = 'public.audit_events'::regclass
        and pg_get_constraintdef(c.oid) like '%''' || a.name || '''%');
  if missing is not null then
    raise exception 'audit vocabulary out of step: % not admitted by audit_events_action_check', missing;
  end if;
end $$;

commit;
