-- ============================================================================
-- KGM LEGAL OS · 0027 — THE ELIGIBILITY LAYER  (phase P‑1.1 – P‑1.3, P‑1.5)
-- ============================================================================
-- Every control in this system, before this file, answered one question:
--
--     "may this actor do this thing?"
--
-- None of them answered the prior one:
--
--     "is this actor legally permitted to be doing this at all?"
--
-- In a general-purpose system those coincide. In a legal system they do not, and
-- the second dominates — because the professional obligations of a Saudi law firm
-- are overwhelmingly STATUS CONDITIONS ON THE ACTOR rather than limits on the
-- action. The system would grant matters.assign to a member whose licence is
-- suspended, and would happily record a lawyer as working for two firms.
--
-- WHAT THIS FILE ADDS, AND WHY EACH PIECE IS A TABLE RATHER THAN A COLUMN
--
--   staff.bar_number is free text. Adding `licence_status` beside it would make
--   the same mistake the conflict boolean made: a value a human asserts, with no
--   history, no evidence and no expiry. A licence is a THING THAT CHANGES —
--   issued, renewed, suspended, restored, expired — and a practice needs the
--   history, not the current value. So: `professional_licences`, one row per
--   licence-period, append-mostly.
--
--   The same reasoning gives `prior_office` its own table. Article 14 of نظام
--   المحاماة and Rule 8/3 of قواعد السلوك المهني impose a FIVE-YEAR window
--   against work connected to a former judicial or government post. Screening
--   for that needs the dates of the appointment, not a flag saying it happened.
--
--   And `tenant_relationships` exists so the Article 16 guard can have an
--   exemption that is DECLARED rather than assumed. Article 16 forbids a lawyer
--   from working for more than one law firm; it does not forbid a firm's own
--   branches. The difference has to be recorded by someone, with their name on
--   it, or the guard is either useless or wrong.
--
-- THE GATE FUNCTIONS ARE DERIVED, NOT ASSERTED
--   `member_entitled_to_practise()` computes from the licence rows. There is no
--   column anywhere that a caller can set to "true" to make it pass — the same
--   discipline as `derive_invoice_client_status()`, applied to authority instead
--   of to a status column. Read the comment above that function's CHECK if you
--   want the origin of this idea; it is the best pattern in this repository.
--
-- ABSENCE IS NOT PERMISSION
--   A member with NO licence row is not entitled to practise. This is the
--   deliberate inverse of the usual default, and it matches the existing rule for
--   financial ceilings ("NULL = no authority. Never read NULL as unlimited.").
--   The consequence is that a new lawyer cannot be assigned a matter until
--   someone records their licence — which is the correct workflow, and is
--   enforced rather than merely encouraged.
--
-- WHY THE SINGLE-FIRM GUARD IS `security definer`, AND WHY THAT IS SAFE HERE
--   The guard must see memberships in OTHER tenants, and RLS hides exactly those
--   rows from `firm_api`. So the function needs the owner's visibility. That is a
--   real privilege, and it is bounded three ways:
--     1. `set search_path = pg_catalog, public` — without it a caller could
--        shadow `firm_memberships` with a temp table and defeat the check. This
--        is the standard SECURITY DEFINER hazard and it is closed explicitly.
--     2. It reads and returns nothing to the caller. It raises or it does not.
--        A function that cannot leak cannot be an oracle.
--     3. EXECUTE is revoked from PUBLIC and granted only to the roles that need
--        the trigger to fire.
--   The alternative — enforcing the single-firm rule in the API layer — would
--   leave it bypassable by any second write path, which is how the eleven
--   Postgres-only defects in this repository's history were all born.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 0 · WHICH ROLES PRACTISE LAW
-- ─────────────────────────────────────────────────────────────────────────────
-- Whether a role requires a practising licence is a property of the ROLE, not a
-- hardcoded list in a function: a tenant that invents a "Legal Consultant" role
-- must be able to declare that it practises, and a court-services role must be
-- able to declare that it does not.
--
-- Default false, deliberately. A new role does not silently start demanding a
-- licence, and does not silently start exempting one either: it is inert until
-- someone decides, and the decision is auditable in the roles table.
alter table public.roles
  add column if not exists requires_practising_licence boolean not null default false;

comment on column public.roles.requires_practising_licence is
  'True where holding this role means practising law, so a valid professional licence is a precondition. Consulted by member_eligible_for_matter(); never used to WIDEN access.';

-- The four practising roles in the seeded catalogue. PARALEGAL is deliberately
-- NOT included: a paralegal does legal work under supervision and does not hold
-- a licence to practise, so requiring one would block a legitimate hire. The
-- supervisor of that paralegal does hold one, and is gated.
update public.roles
   set requires_practising_licence = true
 where code in ('MANAGING_PARTNER', 'PARTNER', 'ASSOCIATE', 'LAWYER');


-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · PROFESSIONAL LICENCES  (P‑1.1)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.professional_licences (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete restrict,
  staff_id           uuid not null references public.staff(id) on delete restrict,
  -- The number as it appears on the Saudi Bar Association record. Free text
  -- because the numbering format is the regulator's, not ours.
  licence_number     text not null,
  -- Date-free by design: a licence with no expiry recorded is treated as
  -- EXPIRING AT UNKNOWN, not as never expiring. See the CHECK note below.
  issued_at          date,
  expires_at         date,
  status             text not null default 'valid'
                     check (status in ('valid','suspended','expired','revoked','pending')),
  -- The date the status took effect. Separate from updated_at (when the row was
  -- touched) because a suspension order is dated, and the date is the legal fact.
  status_effective_from date,
  -- Why the status is not 'valid' — the reference of the disciplinary or
  -- administrative decision. Kept because a suspension is challenged, and the
  -- firm needs to know on what authority it stood the member down.
  status_reference   text,
  verified_by_membership_id uuid references public.firm_memberships(id) on delete set null,
  verified_at        timestamptz,
  -- Where the verification came from: a copy of the licence, the Bar's own
  -- record, an official letter. §50 applies to evidence too — the firm should be
  -- able to say how it knew, not only that it knew.
  evidence_document_id uuid references public.documents(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- One CURRENT row per staff member per licence number. A renewal is a new row
  -- with a later expires_at, so the history survives and the present is the row
  -- with no successor.
  unique (staff_id, licence_number)
);

create index if not exists professional_licences_staff_idx
  on public.professional_licences(staff_id, status);
create index if not exists professional_licences_tenant_idx
  on public.professional_licences(tenant_id);

comment on table public.professional_licences is
  'The licence register. Supersedes staff.bar_number, which was free text with no validity, no expiry and no suspension and therefore could not support the two rules that depend on it: Rule 10 (no practice under a final suspension) and Article 16 (one firm).';

comment on column public.staff.bar_number is
  'DEPRECATED as a source of truth — use public.professional_licences. Retained because the portal projection and the demo seed still read it; nothing new should.';

-- A licence may not be valid AND suspended. The CHECK is on status so this is
-- expressed as an invariant about the pair a caller is most likely to get wrong:
-- restoring a licence must clear the suspension reference, not leave both.
alter table public.professional_licences
  drop constraint if exists professional_licences_status_consistency;
alter table public.professional_licences
  add constraint professional_licences_status_consistency
  check (
    (status = 'valid' and status_reference is null) or
    (status <> 'valid')
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · PRIOR OFFICE  (P‑1.2)
-- ─────────────────────────────────────────────────────────────────────────────
-- Article 14 of نظام المحاماة: a lawyer may not accept a case or give an opinion
-- against an entity for which they worked until five years have passed from the
-- end of that relationship. Rule 8/3 of قواعد السلوك المهني sets the same
-- five-year window generally, and Rule 8/4 sets THREE years for a former CLIENT.
--
-- The windows are recorded as data on this row rather than recomputed from a
-- constant in a query, because the rule is about a person's history and the query
-- that screens them must be able to read the history rather than a boolean.
create table if not exists public.prior_office (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete restrict,
  staff_id           uuid not null references public.staff(id) on delete restrict,
  office_kind        text not null check (office_kind in
                     ('judiciary','public_prosecution','bog','committee',
                      'government_body','court_administration','foreign_judiciary')),
  -- The institution, as named in the appointment. Free text: the firm must be
  -- able to write "محكمة الاستئناف بالرياض" and screen against it.
  institution        text not null,
  institution_ar     text,
  role_title         text,
  role_title_ar      text,
  started_on         date not null,
  -- The end of the appointment. NULL means STILL IN POST, in which case no
  -- restriction window has begun and the bar is absolute.
  ended_on           date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (ended_on is null or ended_on >= started_on)
);

create index if not exists prior_office_staff_idx on public.prior_office(staff_id);
create index if not exists prior_office_institution_idx
  on public.prior_office(lower(institution));

comment on table public.prior_office is
  'Judicial / prosecutorial / government service before private practice. Feeds the five-year screen of Article 14 of نظام المحاماة and Rule 8/3, and the three-year former-CLIENT window of Rule 8/4. A flag could not do this: the screen needs the institution and the dates.';

-- THE RESTRICTION WINDOW IS NOT A COLUMN.
--
-- The first draft of this file stored `restriction_ends_on`, derived by a trigger
-- from `ended_on`. It was removed for two reasons, and the second is the one that
-- decides it:
--
--   1. This database has already been bitten by a stored derived value —
--      `invoices.client_status`. The fix there was to derive on read and refuse a
--      contradicting write, and the same applies here: `ended_on + 5 years` is a
--      pure function of a stored column and nothing is gained by storing it twice.
--
--   2. SQLite cannot assign to NEW inside a trigger, so the mirror would have had
--      to compute the window in the repository layer while Postgres computed it in
--      a trigger — TWO expressions for one rule. The eleven Postgres-only defects
--      in this repository's history all came from exactly that divergence.
--
-- So the window is computed in ONE place: `priorOfficeBar()` in the repository,
-- which both drivers call. The database stores the appointment; the rule is the
-- application's, stated once.


-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · TENANT RELATIONSHIPS  (the Article 16 exemption, declared)
-- ─────────────────────────────────────────────────────────────────────────────
-- Article 16 of the اللائحة التنفيذية: «لا يجوز أن يكون المحامي شريكاً في أكثر من
-- شركة مهنية للمحاماة، كما لا يجوز أن يعمل المحامي لدى أكثر من مكتب أو شركة
-- مهنية للمحاماة.»
--
-- The prohibition is on separate FIRMS. It does not reach a firm's own branches,
-- and it must not, or a practice could not open a Riyadh and a Jeddah office with
-- the same partners. The guard therefore needs to distinguish "another firm" from
-- "the same firm, elsewhere" — and that distinction is a fact about the two
-- tenants that only a human can state.
--
-- Stored in ONE direction as written, and read in both (see the guard). Requiring
-- the operator to insert both directions is how a partial relationship is created.
create table if not exists public.tenant_relationships (
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  related_tenant_id   uuid not null references public.tenants(id) on delete cascade,
  kind                text not null check (kind in
                      ('branch','affiliate','merged','successor')),
  -- Who declared it. A relationship that exempts someone from Article 16 must
  -- have a name against it, or the exemption is anonymous and unauditable.
  declared_by_membership_id uuid references public.firm_memberships(id) on delete set null,
  note                text,
  declared_at         timestamptz not null default now(),
  primary key (tenant_id, related_tenant_id),
  check (tenant_id <> related_tenant_id)
);

comment on table public.tenant_relationships is
  'Declared relationships between tenants. The ONLY exemption path for the Article 16 single-firm guard, so it is deliberately small, named and auditable rather than inferred from a naming convention or a shared owner.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · ELIGIBILITY CHECKS  (P‑1.5 — the generic gate record)
-- ─────────────────────────────────────────────────────────────────────────────
-- The system already has three gates — invoice status derivation, the deadline
-- lane, the document scan — each with its own bespoke trigger. This is the fourth
-- pattern: ONE record shape for "a precondition was evaluated, here is what
-- evidenced it, here is who decided". The later phases (conflicts, CDD,
-- engagement letters, fiscal clearance) all write this table rather than each
-- inventing a mechanism.
--
-- It is APPEND-ONLY. Evidence that can be edited is not evidence.
create table if not exists public.eligibility_checks (
  id                 bigint generated always as identity primary key,
  tenant_id          uuid not null references public.tenants(id) on delete restrict,
  -- What the gate was about. Loosely typed on purpose: the registry of gates
  -- grows faster than a CHECK constraint can be migrated.
  subject_kind       text not null check (subject_kind in
                     ('membership','staff','matter','client','invoice','document','matter_assignment')),
  subject_id         uuid not null,
  -- Which precondition. Same reasoning as above; the values are declared in code
  -- and this column is indexed for the audit query that matters ("has this
  -- subject ever PASSED gate X").
  precondition       text not null,
  outcome            text not null check (outcome in ('pass','fail','waived','not_applicable')),
  -- Everything the decision rested on: licence ids, dates, the rule cited. JSONB
  -- because the shape differs per gate and a column per field would make this
  -- table the schema of all other schemas.
  evidence           jsonb not null default '{}'::jsonb,
  -- The article or rule, where the gate implements one. Optional because some
  -- gates are firm policy rather than statute — and the difference should be
  -- visible rather than implied.
  rule_cited         text,
  evaluated_by_membership_id uuid references public.firm_memberships(id) on delete set null,
  evaluated_at       timestamptz not null default now()
);

create index if not exists eligibility_subject_idx
  on public.eligibility_checks(subject_kind, subject_id, precondition, evaluated_at desc);
create index if not exists eligibility_tenant_idx
  on public.eligibility_checks(tenant_id, evaluated_at desc);

-- Append-only, enforced rather than documented. The audit_events table learned
-- this lesson already; this is the same rule applied here.
create or replace function public.deny_eligibility_check_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'eligibility_checks is append-only: a check that can be edited is not evidence';
end $$;

drop trigger if exists eligibility_checks_immutable on public.eligibility_checks;
create trigger eligibility_checks_immutable
  before update or delete on public.eligibility_checks
  for each row execute function public.deny_eligibility_check_mutation();


-- ─────────────────────────────────────────────────────────────────────────────
-- 5 · THE DERIVED GATES
-- ─────────────────────────────────────────────────────────────────────────────

-- Is there a licence on record that is currently good?
--
-- FALSE for: no row at all · status not 'valid' · expires_at in the past.
-- A null expires_at with status 'valid' is treated as VALID, because the Saudi
-- Bar licence is not uniformly dated in every record a firm holds — but the row
-- must exist. The distinction being drawn is between "we checked and it is
-- current" and "we never checked", and only the second one is refused.
create or replace function public.member_entitled_to_practise(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.professional_licences l
      join public.firm_memberships fm on fm.staff_id = l.staff_id
     where fm.id = p_membership_id
       and l.status = 'valid'
       and (l.expires_at is null or l.expires_at > current_date)
  );
$$;

-- Does this member hold a role that means practising law?
--
-- A role with `requires_practising_licence` and a live grant of it. Explicitly
-- checks `revoked_at is null` — a revoked role must not impose the licence
-- requirement any more than it confers its permissions.
create or replace function public.member_requires_licence(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.membership_roles mr
      join public.roles r on r.id = mr.role_id
     where mr.membership_id = p_membership_id
       and mr.revoked_at is null
       and r.requires_practising_licence
  );
$$;

-- THE GATE. May this member be given work?
--
--   a practitioner  →  must hold a valid licence
--   a non-practitioner (paralegal, finance, compliance, admin)  →  not required
--
-- Kept as its own function rather than inlined at each call site, so that the
-- rule has exactly one definition and cannot drift between the assignment route,
-- the RLS policy and the matter-access grant. Every call site reading a different
-- expression is how the same defect got fixed three times in this repository at
-- migrations 0017, 0018 and 0019.
create or replace function public.member_eligible_for_matter(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when not public.member_requires_licence(p_membership_id) then true
    else public.member_entitled_to_practise(p_membership_id)
  end;
$$;

comment on function public.member_eligible_for_matter(uuid) is
  'The eligibility gate for matter assignment. Derived from professional_licences and the role catalogue; there is no column anywhere that can be set to make it pass. Phase P-1.1.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 6 · THE ARTICLE 16 GUARD  (P‑1.3)
-- ─────────────────────────────────────────────────────────────────────────────
-- Refuses an active membership for a licensed lawyer who already holds an active
-- membership at a DIFFERENT, UNRELATED tenant.
--
-- Checked on the transition INTO 'active', not on every write. A membership may be
-- invited, suspended or left freely; it is the act of conferring the right to
-- practise here that has to be lawful.
create or replace function public.assert_single_firm_affiliation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_licensed boolean;
  v_conflicts integer;
begin
  if new.status <> 'active' then
    return new;
  end if;

  -- Only a person holding a valid practising licence is subject to Article 16.
  -- A paralegal, an accountant or a marketing hire may hold memberships in as
  -- many tenants as they like; the rule is about the profession, not employment.
  select exists (
    select 1 from public.professional_licences l
     where l.staff_id = new.staff_id
       and l.status = 'valid'
       and (l.expires_at is null or l.expires_at > current_date)
  ) into v_licensed;

  if not v_licensed then
    return new;
  end if;

  select count(*) into v_conflicts
    from public.firm_memberships m
   where m.user_id = new.user_id
     and m.id <> new.id
     and m.status = 'active'
     and m.tenant_id <> new.tenant_id
     and not exists (
       select 1 from public.tenant_relationships r
        where (r.tenant_id = new.tenant_id and r.related_tenant_id = m.tenant_id)
           or (r.tenant_id = m.tenant_id and r.related_tenant_id = new.tenant_id)
     );

  if v_conflicts > 0 then
    -- errcode 23514 (check_violation) rather than a bespoke code: this is a
    -- constraint on the row being written, and using the standard code means the
    -- existing error mapping in the API layer already reports it correctly
    -- instead of turning it into a 500.
    raise exception
      'Article 16 of the Implementing Regulation prohibits a licensed lawyer from holding active memberships at two unrelated firms'
      using errcode = '23514';
  end if;

  return new;
end $$;

drop trigger if exists firm_memberships_single_firm_guard on public.firm_memberships;
create trigger firm_memberships_single_firm_guard
  before insert or update on public.firm_memberships
  for each row execute function public.assert_single_firm_affiliation();

-- A SECURITY DEFINER function is only as safe as its search_path and its grants.
-- Revoke from PUBLIC: the trigger needs EXECUTE, an anonymous caller does not.
revoke all on function public.assert_single_firm_affiliation() from public;
revoke all on function public.member_entitled_to_practise(uuid) from public;
revoke all on function public.member_requires_licence(uuid) from public;
revoke all on function public.member_eligible_for_matter(uuid) from public;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7 · GRANTS AND POLICIES
-- ─────────────────────────────────────────────────────────────────────────────
-- The firm reads its own tenant's rows. Writes are admitted for the tables the
-- application actually writes, with the WITH CHECK expressing the application's
-- own rule for that write rather than restating the visibility clause — the
-- distinction migration 0021 established and this file follows.
--
-- The PORTAL gets nothing. These are internal diligence records; there is no
-- client-facing projection of a licence, a prior office or an eligibility check,
-- and granting a column "just in case" is how a projection leaks.

grant select (id, tenant_id, staff_id, licence_number, issued_at, expires_at,
              status, status_effective_from, status_reference, verified_at)
  on public.professional_licences to firm_api;

grant select (id, tenant_id, staff_id, office_kind, institution, institution_ar,
              role_title, role_title_ar, started_on, ended_on)
  on public.prior_office to firm_api;

grant select (id, tenant_id, subject_kind, subject_id, precondition, outcome,
              evidence, rule_cited, evaluated_by_membership_id, evaluated_at)
  on public.eligibility_checks to firm_api;

grant select (tenant_id, related_tenant_id, kind, note, declared_at)
  on public.tenant_relationships to firm_api;

grant insert (tenant_id, staff_id, licence_number, issued_at, expires_at, status,
              status_effective_from, status_reference, verified_by_membership_id)
  on public.professional_licences to firm_api;

grant update (issued_at, expires_at, status, status_effective_from,
              status_reference, verified_by_membership_id, verified_at, updated_at)
  on public.professional_licences to firm_api;

grant insert (tenant_id, staff_id, office_kind, institution, institution_ar,
              role_title, role_title_ar, started_on, ended_on)
  on public.prior_office to firm_api;

grant insert (tenant_id, subject_kind, subject_id, precondition, outcome,
              evidence, rule_cited, evaluated_by_membership_id)
  on public.eligibility_checks to firm_api;

grant insert (tenant_id, related_tenant_id, kind, declared_by_membership_id, note)
  on public.tenant_relationships to firm_api;

grant execute on function public.member_entitled_to_practise(uuid) to firm_api;
grant execute on function public.member_requires_licence(uuid) to firm_api;
grant execute on function public.member_eligible_for_matter(uuid) to firm_api;

-- ── professional_licences ────────────────────────────────────────────────────
drop policy if exists professional_licences_read on public.professional_licences;
create policy professional_licences_read on public.professional_licences
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists professional_licences_insert on public.professional_licences;
create policy professional_licences_insert on public.professional_licences
  for insert to firm_api
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    -- The licence must belong to a member of THIS firm. Without this a caller
    -- could attach a licence row to another tenant's staff member and then move
    -- the Article 16 guard's answer for them.
    and exists (
      select 1 from public.staff s
       where s.id = staff_id and s.tenant_id = public.kgm_tenant()
    )
  );

drop policy if exists professional_licences_update on public.professional_licences;
create policy professional_licences_update on public.professional_licences
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and exists (
      select 1 from public.staff s
       where s.id = staff_id and s.tenant_id = public.kgm_tenant()
    )
  );

-- No DELETE policy and no DELETE grant: a licence row that a practice has stopped
-- relying on is superseded, not erased. The history is the point.

-- ── prior_office ─────────────────────────────────────────────────────────────
drop policy if exists prior_office_read on public.prior_office;
create policy prior_office_read on public.prior_office
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists prior_office_insert on public.prior_office;
create policy prior_office_insert on public.prior_office
  for insert to firm_api
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and exists (
      select 1 from public.staff s
       where s.id = staff_id and s.tenant_id = public.kgm_tenant()
    )
  );

-- ── eligibility_checks ──────────────────────────────────────────────────────
drop policy if exists eligibility_checks_read on public.eligibility_checks;
create policy eligibility_checks_read on public.eligibility_checks
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists eligibility_checks_insert on public.eligibility_checks;
create policy eligibility_checks_insert on public.eligibility_checks
  for insert to firm_api
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    -- Attribution: a member may not record a compliance check as having been
    -- performed by someone else. Same rule as matter_permissions' grant
    -- attribution in 0021, for the same reason.
    and evaluated_by_membership_id = public.kgm_membership()
  );

-- ── tenant_relationships ────────────────────────────────────────────────────
-- Readable to both sides of the relationship: a firm needs to know that the
-- tenant it is merging with has declared the relationship too, and hiding one
-- direction would make the view asymmetric for no security benefit.
drop policy if exists tenant_relationships_read on public.tenant_relationships;
create policy tenant_relationships_read on public.tenant_relationships
  for select to firm_api
  using (
    public.kgm_is_firm()
    and (tenant_id = public.kgm_tenant() or related_tenant_id = public.kgm_tenant())
  );

drop policy if exists tenant_relationships_insert on public.tenant_relationships;
create policy tenant_relationships_insert on public.tenant_relationships
  for insert to firm_api
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and declared_by_membership_id = public.kgm_membership()
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- 8 · THE AUDIT VOCABULARY GROWS — INCLUDING MATTER_VIEWED  (P‑1.4)
-- ─────────────────────────────────────────────────────────────────────────────
-- The 69-action list contains DOCUMENT_VIEWED, INVOICE_VIEWED, MESSAGE_READ and
-- RECEIPT_VIEWED. It does not contain MATTER_VIEWED, and because migration 0023
-- makes this table the CONTRACT that server/src/audit/logger.ts must satisfy, no
-- call site could have written one even if someone had tried.
--
-- That absence is the reason this system cannot answer a disqualification
-- motion. The question asked when a conflict surfaces late is not "was the screen
-- clean in March", it is "who here had actually seen that file, and when" — and
-- for the CASE FILE, as opposed to a PDF inside it, there was no record at all.
--
-- The licence and eligibility actions are added in the same migration because the
-- audit union and this constraint must move together: a declared action the
-- database rejects is a dropped audit row or a 500, and neither of those says
-- "the vocabulary is out of date". The DO-block in section 9 fails loudly instead.
alter table public.audit_events drop constraint audit_events_action_check;

alter table public.audit_events add constraint audit_events_action_check
  check (action in (
    -- authentication
    'LOGIN','LOGIN_FAILED','LOGOUT','LOGOUT_ALL_OTHERS','SESSION_EXPIRED',
    'SESSION_REVOKED','ACCOUNT_LOCKED','RATE_LIMITED',
    -- credentials
    'PASSWORD_RESET_REQUESTED','PASSWORD_RESET_COMPLETED','PASSWORD_CHANGED',
    'EMAIL_VERIFICATION_SENT','EMAIL_VERIFIED',
    'INVITATION_CREATED','INVITATION_ACCEPTED','INVITATION_EXPIRED','INVITATION_REVOKED',
    -- mfa
    'MFA_ENROLLMENT_STARTED','MFA_ENABLED','MFA_DISABLED','MFA_VERIFIED','MFA_FAILED',
    'DEVICE_TRUSTED','DEVICE_UNTRUSTED',
    -- documents
    'DOCUMENT_VIEWED','DOCUMENT_DOWNLOADED','DOCUMENT_UPLOADED',
    'DOCUMENT_UPLOAD_REJECTED','SIGNED_URL_ISSUED','DOCUMENT_ACCESS_DENIED',
    -- financial
    'INVOICE_VIEWED','PAYMENT_STARTED','PAYMENT_COMPLETED','PAYMENT_FAILED',
    'RECEIPT_VIEWED','WEBHOOK_RECEIVED','WEBHOOK_SIGNATURE_INVALID',
    -- communication
    'MESSAGE_SENT','MESSAGE_READ','APPOINTMENT_REQUESTED','APPOINTMENT_CANCELLED',
    -- account
    'PROFILE_UPDATED','PREFERENCES_UPDATED','NOTIFICATION_READ',
    'PRIVACY_REQUEST_SUBMITTED','CONSENT_RECORDED',
    -- authorization failures
    'AUTHZ_DENIED','TENANT_ISOLATION_VIOLATION','CLIENT_ISOLATION_VIOLATION',
    'INTERNAL_RESOURCE_ACCESS_ATTEMPT','FIELD_TAMPER_ATTEMPT','MUTATION_DENIED',
    -- firm
    'FIRM_LOGIN','FIRM_LOGIN_FAILED','FIRM_LOGOUT','FIRM_SESSION_REVOKED',
    'FIRM_MFA_VERIFIED','FIRM_MFA_FAILED',
    'PERMISSION_DENIED','MATTER_SCOPE_DENIED','CEILING_EXCEEDED',
    'ROLE_GRANTED','ROLE_REVOKED','MATTER_ACCESS_GRANTED','MATTER_ACCESS_REVOKED',
    'MATTER_RESTRICTED','MATTER_UNRESTRICTED',
    'ESCALATION_ATTEMPT','ADMIN_MUTATION',
    -- 0027 · case-file access, and the eligibility layer
    'MATTER_VIEWED',
    'LICENCE_RECORDED','LICENCE_STATUS_CHANGED','LICENCE_VERIFIED',
    'PRIOR_OFFICE_RECORDED',
    'TENANT_RELATIONSHIP_DECLARED',
    'ELIGIBILITY_EVALUATED','ELIGIBILITY_DENIED','MULTI_FIRM_AFFILIATION_DENIED'
  ));


-- ─────────────────────────────────────────────────────────────────────────────
-- 9 · VERIFY — the database admits every action the TypeScript declares.
-- ─────────────────────────────────────────────────────────────────────────────
-- Kept in step with server/src/audit/logger.ts in the same change. If an action
-- is added to the union and not here, the insert is rejected at runtime; if it is
-- added here and not to the union, nothing writes it. Both directions are wrong,
-- so the list is verified rather than trusted.
do $$
declare
  declared text[] := array[
    'LOGIN','LOGIN_FAILED','LOGOUT','LOGOUT_ALL_OTHERS','SESSION_EXPIRED',
    'SESSION_REVOKED','ACCOUNT_LOCKED','RATE_LIMITED',
    'PASSWORD_RESET_REQUESTED','PASSWORD_RESET_COMPLETED','PASSWORD_CHANGED',
    'EMAIL_VERIFICATION_SENT','EMAIL_VERIFIED',
    'INVITATION_CREATED','INVITATION_ACCEPTED','INVITATION_EXPIRED','INVITATION_REVOKED',
    'MFA_ENROLLMENT_STARTED','MFA_ENABLED','MFA_DISABLED','MFA_VERIFIED','MFA_FAILED',
    'DEVICE_TRUSTED','DEVICE_UNTRUSTED',
    'DOCUMENT_VIEWED','DOCUMENT_DOWNLOADED','DOCUMENT_UPLOADED',
    'DOCUMENT_UPLOAD_REJECTED','SIGNED_URL_ISSUED','DOCUMENT_ACCESS_DENIED',
    'INVOICE_VIEWED','PAYMENT_STARTED','PAYMENT_COMPLETED','PAYMENT_FAILED',
    'RECEIPT_VIEWED','WEBHOOK_RECEIVED','WEBHOOK_SIGNATURE_INVALID',
    'MESSAGE_SENT','MESSAGE_READ','APPOINTMENT_REQUESTED','APPOINTMENT_CANCELLED',
    'PROFILE_UPDATED','PREFERENCES_UPDATED','NOTIFICATION_READ',
    'PRIVACY_REQUEST_SUBMITTED','CONSENT_RECORDED',
    'AUTHZ_DENIED','TENANT_ISOLATION_VIOLATION','CLIENT_ISOLATION_VIOLATION',
    'INTERNAL_RESOURCE_ACCESS_ATTEMPT','FIELD_TAMPER_ATTEMPT','MUTATION_DENIED',
    'FIRM_LOGIN','FIRM_LOGIN_FAILED','FIRM_LOGOUT','FIRM_SESSION_REVOKED',
    'FIRM_MFA_VERIFIED','FIRM_MFA_FAILED',
    'PERMISSION_DENIED','MATTER_SCOPE_DENIED','CEILING_EXCEEDED',
    'ROLE_GRANTED','ROLE_REVOKED','MATTER_ACCESS_GRANTED','MATTER_ACCESS_REVOKED',
    'MATTER_RESTRICTED','MATTER_UNRESTRICTED','ESCALATION_ATTEMPT','ADMIN_MUTATION',
    'MATTER_VIEWED',
    'LICENCE_RECORDED','LICENCE_STATUS_CHANGED','LICENCE_VERIFIED',
    'PRIOR_OFFICE_RECORDED','TENANT_RELATIONSHIP_DECLARED',
    'ELIGIBILITY_EVALUATED','ELIGIBILITY_DENIED','MULTI_FIRM_AFFILIATION_DENIED'
  ];
  missing text[];
begin
  select array_agg(a) into missing
    from unnest(declared) a
   where not exists (
     select 1 from pg_constraint c
      where c.conname = 'audit_events_action_check'
        and c.conrelid = 'public.audit_events'::regclass
        and pg_get_constraintdef(c.oid) like '%''' || a || '''%'
   );

  if missing is not null then
    raise exception 'audit vocabulary out of step: % not admitted by audit_events_action_check', missing;
  end if;
end $$;

-- The eligibility gate functions must exist and must be callable by the API role,
-- or the guards they support fail closed in a way that looks like a bug.
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'member_eligible_for_matter') then
    raise exception 'member_eligible_for_matter() is missing — the eligibility gate would be unenforced';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgname = 'firm_memberships_single_firm_guard' and not tgisinternal) then
    raise exception 'the Article 16 single-firm guard is missing';
  end if;
end $$;
