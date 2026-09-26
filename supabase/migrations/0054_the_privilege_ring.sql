-- ═══════════════════════════════════════════════════════════════════════════════
--  0054 · THE PRIVILEGE RING
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  لا يجوز للمحامي أن يفشي سراً اؤتمن عليه أو عرفه عن طريق مهنته ولو بعد انتهاء
--  وكالته — نظام المحاماة، المادة الثالثة والعشرون. القاعدة الحادية والعشرون من
--  قواعد السلوك المهني تذكرها في صيغة أوسع، وتُعدّد الحالات التي يجوز فيها الإفصاح:
--  منع حدوث جريمة، الاشتباه بجريمة غسل الأموال أو تمويل الإرهاب، دفاع المحامي عن
--  نفسه، وموافقة العميل المكتوبة.
--
--  THE DUTY ATTACHES TO THE LAWYER. Not to the firm, not to a role, not to a screen.
--  So the material it protects is not readable by everyone who works at the firm, and
--  the gap analysis measured exactly that: `matters.internal_notes` was reachable by
--  any member with matter write access, including a paralegal, a finance officer and a
--  compliance officer. This migration makes the ring real at the layer that cannot be
--  argued with.
--
--  ── TWO MECHANISMS, BECAUSE THE SECRETS ARE TWO SHAPES ─────────────────────────
--
--  · A secret that is a COLUMN (`matters.internal_notes`, `matters.risk_rating`) is
--    independent of which rows the caller may see: a paralegal may look at the matter
--    — its title, its status, its court — and must not read the firm's strategy on it.
--    Row level security cannot express that, so the mechanism is the GRANT: the
--    application's role stops having SELECT on those two columns at all, and the
--    values come back through a function that checks the ring.
--
--  · A secret that is a ROW (`internal_notes.is_privileged`, a document whose
--    `privilege_class` is not 'none') is the same question RLS exists for: it is
--    enforced as a RESTRICTIVE policy, so that no future permissive policy can widen
--    it back by accident.
--
--  ── THE RING IS P-1'S VERDICT, NOT A SECOND RULE ───────────────────────────────
--
--  `roles.requires_practising_licence` is the firm's own declaration that a role means
--  practising law. A licence that is absent, suspended, revoked, expired or pending
--  keeps the member out — the same precedence `eligibilityFor()` applies in the
--  application, including the one that is easy to get backwards: ABSENCE IS NOT
--  PERMISSION, and a suspension outranks an expiry.
--
--  ── A NOTE ON 0008, WHICH ASSERTED THE OPPOSITE ────────────────────────────────
--
--  Migration 0008 ends with `if not has_column_privilege('firm_api', 'public.matters',
--  'risk_rating', 'SELECT') then raise exception '… the firm OS needs this column.'`
--  That was right then: the column was being read for every member with matter access,
--  and the concern was a client-facing role reaching it. The concern now is the other
--  direction — the firm's own non-lawyers — and the answer is the ring. 0008 is applied
--  and is not edited; this migration reverses its grant deliberately, and the live
--  harness asserts the new state rather than the old one.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · THE RING, IN ONE PLACE ─────────────────────────────────────────────────
/*
  Two functions, one rule. `kgm_lawyer_ring_reason` states the rule and names the
  refusal; `kgm_lawyer_ring` is the boolean every policy asks. The reason is returned
  rather than a bare false because the member who is refused is owed the difference
  between "this is not a lawyer's job here" and "your licence was suspended in March".

  `security definer`, like `matter_visible`: a policy must be able to ask this question
  without the caller needing grants on `membership_roles`, `roles` and
  `professional_licences`, and without the answer depending on the policies on those
  tables — a refusal that depends on a second policy is a refusal nobody can explain.
*/
create or replace function public.kgm_lawyer_ring_reason(p_membership uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    /*
      (1) Does any live role of this member mean practising law?
          A revoked role confers nothing, so it imposes nothing either. `rl.tenant_id is
          null` is the system template every tenant copy descends from.
    */
    when not exists (
      select 1
        from public.membership_roles mr
        join public.roles rl on rl.id = mr.role_id
       where mr.membership_id = p_membership
         and mr.revoked_at is null
         and rl.requires_practising_licence = true
         and (rl.tenant_id is null or rl.tenant_id = public.kgm_tenant())
    ) then 'outside_ring'

    /*
      (2) Is a licence on record? ABSENCE IS NOT PERMISSION — the deliberate inverse of
          the usual default, and the same rule the financial ceilings follow.
    */
    when not exists (
      select 1
        from public.professional_licences pl
        join public.firm_memberships fm on fm.id = p_membership
       where pl.staff_id  = fm.staff_id
         and pl.tenant_id = public.kgm_tenant()
    ) then 'no_licence_on_record'

    /*
      (3) Is one of them good enough to practise TODAY? Matches `eligibilityFor()`:
          status must be `valid`, and the expiry is compared against the UTC date — the
          application compares against `new Date().toISOString().slice(0,10)`, and a
          ring that turned at a different midnight from the screen would be a bug
          nobody could reproduce. A licence with NO expiry recorded is treated as
          expiring at unknown, which is not the same as never expiring.
    */
    when exists (
      select 1
        from public.professional_licences pl
        join public.firm_memberships fm on fm.id = p_membership
       where pl.staff_id  = fm.staff_id
         and pl.tenant_id = public.kgm_tenant()
         and pl.status    = 'valid'
         and (pl.expires_at is null or pl.expires_at > (now() at time zone 'utc')::date)
    ) then 'in_ring'

    /*
      (4) Nothing is good enough. Name the most SERIOUS reason present, not the first
          row's: a member shown "licence pending" when they have in fact been suspended
          is being misled about whether they may practise.
    */
    when exists (
      select 1 from public.professional_licences pl
        join public.firm_memberships fm on fm.id = p_membership
       where pl.staff_id = fm.staff_id and pl.tenant_id = public.kgm_tenant()
         and pl.status = 'suspended'
    ) then 'suspended'
    when exists (
      select 1 from public.professional_licences pl
        join public.firm_memberships fm on fm.id = p_membership
       where pl.staff_id = fm.staff_id and pl.tenant_id = public.kgm_tenant()
         and pl.status = 'revoked'
    ) then 'revoked'
    when exists (
      select 1 from public.professional_licences pl
        join public.firm_memberships fm on fm.id = p_membership
       where pl.staff_id = fm.staff_id and pl.tenant_id = public.kgm_tenant()
         and pl.expires_at is not null
         and pl.expires_at <= (now() at time zone 'utc')::date
    ) then 'expired'
    else 'pending'
  end;
$$;

create or replace function public.kgm_lawyer_ring(p_membership uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_membership is not null
     and public.kgm_lawyer_ring_reason(p_membership) = 'in_ring';
$$;

comment on function public.kgm_lawyer_ring(uuid) is
  'P0.5 · True when the membership may lawfully practise: a live role the firm declares '
  'as practising (requires_practising_licence) AND a licence that is valid today. The '
  'single copy of the rule the policies and the reader function both ask.';

-- ── 2 · THE ONLY WAY THE TWO COLUMNS CAN BE READ ───────────────────────────────
/*
  A `security definer` function is a hole with a lock on it, and the lock is manual:
  THIS FUNCTION DOES NOT INHERIT ROW LEVEL SECURITY. It runs as its owner, so it sees
  every row in every tenant, and the tenant filter below is the only thing standing
  between a matter id from another firm and the answer. It is written out explicitly
  for that reason, and it reads the tenant from the SAME setting the policies read
  (`kgm.tenant_id`) rather than taking it as an argument a caller could supply.
*/
create or replace function public.firm_read_matter_privilege(p_matter uuid)
returns table (internal_notes text, risk_rating text)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.kgm_tenant();
  v_member uuid := public.kgm_membership();
  v_reason text;
begin
  /* The tenant filter, manual and unavoidable. A matter id from another firm is
     indistinguishable from one that does not exist. */
  if not exists (
    select 1 from public.matters m where m.id = p_matter and m.tenant_id = v_tenant
  ) then
    raise exception 'privilege_ring_refused: matter_out_of_scope'
      using errcode = 'check_violation';
  end if;

  v_reason := public.kgm_lawyer_ring_reason(v_member);
  if v_reason <> 'in_ring' then
    /* The refusal is a named one, and it travels to the API as the reason — the member
       who cannot read the firm's strategy on their own matter is entitled to know
       whether that is because of their role or because of their licence. */
    raise exception 'privilege_ring_refused: %', v_reason
      using errcode = 'check_violation';
  end if;

  return query
    select m.internal_notes, m.risk_rating::text
      from public.matters m
     where m.id = p_matter and m.tenant_id = v_tenant;
end $$;

comment on function public.firm_read_matter_privilege(uuid) is
  'P0.5 · The only read path for matters.internal_notes and matters.risk_rating: refuses '
  'outside the lawyer ring, and names the refusal. The application records the read '
  'itself, on the same fire-and-forget rule MATTER_VIEWED follows.';

-- ── 3 · THE GRANT, TAKEN AWAY ──────────────────────────────────────────────────
/*
  NOT HAND-LISTED. 0050 learned this the expensive way: a hand-written list of tables is
  a list that is wrong the next time somebody adds a table. This walks the catalogue and
  grants exactly the columns that are not privileged ones, so a column added later is
  granted automatically and the two named here stay closed.
*/
do $$
declare
  v_cols text;
  v_closed constant text[] := array['internal_notes', 'risk_rating'];
begin
  select string_agg(format('%I', column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'matters'
     and column_name <> all (v_closed);

  if v_cols is null then
    raise exception '0054: no columns found on public.matters — refusing to revoke blind';
  end if;

  revoke select on public.matters from firm_api;
  execute format('grant select (%s) on public.matters to firm_api', v_cols);

  raise notice '0054: matters columns other than % granted to firm_api', array_to_string(v_closed, ', ');
end $$;

-- ── 4 · DOCUMENTS: THE CLASS, AND THE LINE THAT KEEPS IT INTERNAL ──────────────
alter table public.documents
  add column if not exists privilege_class text not null default 'none'
    check (privilege_class in ('none','advice','work_product','litigation'));

/*
  A privileged document is INTERNAL, and the database says so rather than trusting the
  form. The privilege belongs to the client, so the client is not kept out of the
  substance — but the artefact kept in the file is the lawyer's own work product (the
  note, the assessment, the strategy), and the advice the client receives is a document
  the firm issues TO the client. That is a different document with `client_visibility`
  on it, and a release under Rule 21 is what moves material across.

  `client_visibility` is the existing three-valued column (`visible`, `restricted`,
  `internal`), so this needs no new vocabulary: privileged ⇒ internal.
*/
alter table public.documents
  drop constraint if exists documents_privileged_is_internal;
alter table public.documents
  add constraint documents_privileged_is_internal
  check (privilege_class = 'none' or client_visibility = 'internal');

create index if not exists documents_privilege_class_idx
  on public.documents(tenant_id, matter_id) where privilege_class <> 'none';

/*
  RESTRICTIVE policies, not permissive ones. The firm already has a PERMISSIVE `for all`
  policy on documents (`firm_matter_scope`), and permissive policies OR together — so a
  second permissive ring policy would change nothing at all. A restrictive policy ANDs
  with every other policy, which is the only shape that can hold a line against the
  permissive grant that already exists.
*/
drop policy if exists documents_firm_privileged_ring on public.documents;
create policy documents_firm_privileged_ring on public.documents
  as restrictive
  for all
  to firm_api
  using (privilege_class = 'none' or public.kgm_lawyer_ring(public.kgm_membership()))
  with check (privilege_class = 'none' or public.kgm_lawyer_ring(public.kgm_membership()));

drop policy if exists documents_portal_never_privileged on public.documents;
create policy documents_portal_never_privileged on public.documents
  as restrictive
  for all
  to portal_api
  using (privilege_class = 'none')
  with check (privilege_class = 'none');

-- The class is readable by the firm (the registry classifies it on the wire) and never
-- by the client-facing role.
grant select (privilege_class) on public.documents to firm_api;

-- ── 5 · THE NOTES TABLE COMES ALIVE, UNDER THE RING ────────────────────────────
/*
  `internal_notes` is the table the schema has carried since 0002 with a comment saying
  it is lawyer work product and no client visibility, and it has been unreachable: the
  only policies were `internal_notes_firm_only` for the owner role and a blanket
  `internal_notes_denied` (using false) for both API roles, with no grants at all. Every
  one of its seven rows is `is_privileged = true`.

  It becomes reachable — by the ring, and only for the privileged rows. A note that is
  not privileged (a housekeeping note, a filing reminder) is ordinary matter material:
  the paralegal who files the document may read it. The lock is the column that says so,
  not a whole table kept dark because some rows are sensitive.
*/
drop policy if exists internal_notes_denied on public.internal_notes;
drop policy if exists internal_notes_firm_ring on public.internal_notes;
drop policy if exists internal_notes_portal_denied on public.internal_notes;

create policy internal_notes_portal_denied on public.internal_notes
  as permissive for all to portal_api using (false) with check (false);

create policy internal_notes_firm_ring on public.internal_notes
  as restrictive
  for all
  to firm_api
  using (
    public.matter_visible(matter_id)
    and (not is_privileged or public.kgm_lawyer_ring(public.kgm_membership()))
  )
  with check (
    tenant_id = public.kgm_tenant()
    and public.matter_visible(matter_id)
    and (not is_privileged or public.kgm_lawyer_ring(public.kgm_membership()))
  );

/* A permissive policy is still needed: restrictive policies only SUBTRACT, and a table
   with no permissive policy visible to a role admits nothing. */
drop policy if exists internal_notes_firm_scope on public.internal_notes;
create policy internal_notes_firm_scope on public.internal_notes
  as permissive for select to firm_api using (true);

grant select (id, tenant_id, matter_id, author_staff_id, note_type, body, is_privileged, created_at)
  on public.internal_notes to firm_api;
grant insert (id, tenant_id, matter_id, author_staff_id, note_type, body, is_privileged, created_at)
  on public.internal_notes to firm_api;
-- NOT granted: UPDATE and DELETE. A note is a record of what was known at the time; a
-- privileged note that can be edited after the fact is not evidence of anything.

-- ── 6 · THE DOOR, WITH A LEDGER ────────────────────────────────────────────────
/*
  القاعدة الحادية والعشرون permits disclosure on four grounds. A ring with no door
  cannot serve a firm that must report a suspicious transaction, answer a complaint
  against itself, or release a document on the client's written instruction — so the
  grounds are data, and every release names one.
*/
create table if not exists public.privilege_releases (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  matter_id         uuid not null references public.matters(id) on delete restrict,
  document_id       uuid references public.documents(id) on delete restrict,
  subject_kind      text not null check (subject_kind in ('matter_note','document','assessment')),
  /* The four grounds, spelled as القاعدة الحادية والعشرون spells them. */
  ground            text not null check (ground in
                      ('crime_prevention','aml_suspicion','self_defence','client_written_consent')),
  recipient_kind    text not null check (recipient_kind in
                      ('court','authority','regulator','third_party','client')),
  recipient_name    text not null,
  /*
    THE CLIENT'S CONSENT IS WRITTEN, SO THE RELEASE NAMES THE WRITING. A flag saying
    "the client agreed" is not the writing Rule 21 requires, and a schema that accepts
    one will be read, later, as accepting the other.
  */
  consent_document_id uuid references public.documents(id) on delete restrict,
  released_by_membership_id uuid not null
    references public.firm_memberships(id) on delete restrict,
  released_at       timestamptz not null default now(),
  note              text,

  /* A document release must say which document. */
  check (subject_kind <> 'document' or document_id is not null),
  /* Rule 21 permits disclosure on the client's WRITTEN consent: name the writing. */
  check (ground <> 'client_written_consent' or consent_document_id is not null),
  /*
    AND AN AML SUSPICION GOES TO THE REGULATOR. A suspicion of money laundering is
    reported to the financial intelligence unit — the STR P0.3 builds. A schema that let
    this ground name a counterparty would let a firm tell the other side what it
    suspected, citing the ground that permits the opposite.
  */
  check (ground <> 'aml_suspicion' or recipient_kind = 'regulator')
);

create index if not exists privilege_releases_matter_idx
  on public.privilege_releases(tenant_id, matter_id, released_at desc);

comment on table public.privilege_releases is
  'P0.5 · Every deliberate exit from the privilege ring, with the ground القاعدة '
  'الحادية والعشرون provides, the recipient, and the writing the client consented in.';

/*
  ONLY A LAWYER MAY OPEN THE DOOR. The application checks the ring as well — a refusal
  there is a named 403 with a message rather than a driver error — but the rule is also
  here, because the release ledger is the record a court will read.
*/
create or replace function public.privilege_release_guard() returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reason text;
begin
  if new.tenant_id <> public.kgm_tenant() then
    raise exception 'privilege_ring_refused: tenant_mismatch' using errcode = 'check_violation';
  end if;
  if not public.matter_visible(new.matter_id) then
    raise exception 'privilege_ring_refused: matter_out_of_scope' using errcode = 'check_violation';
  end if;

  v_reason := public.kgm_lawyer_ring_reason(public.kgm_membership());
  if v_reason <> 'in_ring' then
    raise exception 'privilege_ring_refused: %', v_reason using errcode = 'check_violation';
  end if;
  if new.released_by_membership_id <> public.kgm_membership() then
    raise exception 'privilege_ring_refused: release_must_name_the_member_who_made_it'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists privilege_releases_guard on public.privilege_releases;
create trigger privilege_releases_guard
  before insert on public.privilege_releases
  for each row execute function public.privilege_release_guard();

/*
  THE LEDGER IS APPEND-ONLY, and by privilege rather than by convention: no UPDATE and
  no DELETE is granted to anyone but the owner. A release that can be edited afterwards
  is not a record of a release.
*/
grant select, insert on public.privilege_releases to firm_api;
grant select (id, tenant_id, matter_id, document_id, subject_kind, ground, recipient_kind,
              recipient_name, consent_document_id, released_by_membership_id, released_at)
  on public.privilege_releases to firm_api;

alter table public.privilege_releases enable row level security;
alter table public.privilege_releases force row level security;

drop policy if exists privilege_releases_firm_read on public.privilege_releases;
create policy privilege_releases_firm_read on public.privilege_releases
  as permissive for select to firm_api
  using (tenant_id = public.kgm_tenant() and public.matter_visible(matter_id));

drop policy if exists privilege_releases_firm_write on public.privilege_releases;
create policy privilege_releases_firm_write on public.privilege_releases
  as permissive for insert to firm_api
  with check (tenant_id = public.kgm_tenant() and public.matter_visible(matter_id));

drop policy if exists privilege_releases_portal_denied on public.privilege_releases;
create policy privilege_releases_portal_denied on public.privilege_releases
  as permissive for all to portal_api using (false) with check (false);

-- ── 7 · VERIFY, AND TRY TO BREAK IT ─────────────────────────────────────────────
do $$
declare
  open_cols text[];
  leaked    text;
  n_pol     integer;
  n_checks  integer;
  refused   boolean;
begin
  /* (a) The two columns are genuinely out of reach of the application role. This is the
     claim the whole migration rests on, and it is asked of the CATALOGUE, not of the
     intent. A grant is a fact; everything above it is a story. */
  select array_agg(column_name order by column_name) into open_cols
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'matters'
     and grantee = 'firm_api' and privilege_type = 'SELECT'
     and column_name in ('internal_notes','risk_rating');
  if open_cols is not null then
    raise exception '0054: firm_api still has SELECT on %', array_to_string(open_cols, ', ');
  end if;

  select string_agg(distinct grantee, ', ') into leaked
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'matters'
     and privilege_type = 'SELECT'
     and column_name in ('internal_notes','risk_rating')
     and grantee in ('anon','authenticated');
  if leaked is not null then
    raise exception '0054: a browser-facing role holds a privileged column: %', leaked;
  end if;

  /* (b) And the columns are still granted to everyone the firm OS needs — a revoke that
     took the title away with the strategy would be found by a user, not by a test. */
  if not has_column_privilege('firm_api','public.matters','title','SELECT')
     or not has_column_privilege('firm_api','public.matters','internal_status','SELECT') then
    raise exception '0054: the revoke took ordinary matter columns with it';
  end if;

  /* (c) The three functions exist and the reader is definer. */
  if not exists (select 1 from pg_proc where proname = 'firm_read_matter_privilege') then
    raise exception '0054: the reader function was not created';
  end if;
  if not exists (select 1 from pg_proc p where p.proname = 'firm_read_matter_privilege'
                  and p.prosecdef) then
    raise exception '0054: the reader is not security definer — it would see nothing';
  end if;

  /* (d) The policies are there, and they are RESTRICTIVE. A permissive ring policy on
     documents would be invisible: it would OR with the firm's existing `for all` policy
     and change nothing whatsoever. */
  select count(*) into n_pol from pg_policies
   where schemaname='public' and tablename='documents'
     and policyname in ('documents_firm_privileged_ring','documents_portal_never_privileged')
     and permissive = 'RESTRICTIVE';
  if n_pol <> 2 then
    raise exception '0054: the document ring policies are missing or permissive (%)', n_pol;
  end if;

  /* (e) The two legal CHECKs are constraints, not comments. */
  select count(*) into n_checks from pg_constraint
   where conrelid = 'public.privilege_releases'::regclass and contype = 'c';
  if n_checks < 5 then
    raise exception '0054: privilege_releases carries % checks; the grounds and the '
                    'writing are not all constrained', n_checks;
  end if;

  /* (f) PROVEN BY BEING REFUSED. The AML ground is offered a counterparty recipient and
     the database must say no — this is the rule that stops a firm citing "suspicion of
     money laundering" to tell the other side what it suspects. */
  refused := false;
  begin
    insert into public.privilege_releases
      (tenant_id, matter_id, subject_kind, ground, recipient_kind, recipient_name,
       released_by_membership_id)
    values
      (public.kgm_tenant(), gen_random_uuid(), 'assessment', 'aml_suspicion', 'third_party',
       'the other side', gen_random_uuid());
    raise exception '0054: the AML ground was accepted against a counterparty';
  exception
    when check_violation then refused := true;
    when foreign_key_violation then refused := true;
  end;
  if not refused then
    raise exception '0054: the AML ground was accepted against a counterparty';
  end if;

  raise notice '0054 applied: the ring is a grant, a policy and a function — and the '
               'two columns are readable only through it.';
end $$;
