/*
  0058 · THE INTAKE THE FIRM ACTUALLY RUNS
  ─────────────────────────────────────────────────────────────────────────────────────────

  WHY THIS MIGRATION EXISTS

  The system can do almost everything to a case EXCEPT OPEN ONE. Reading the grants for
  the application role (`firm_api`) on the intake tables is the fastest way to see it:

    clients        INSERT  ✗   the firm cannot create a client
    matters        INSERT  ✗   the firm cannot create a matter
    matter_team    INSERT  ✗   the firm cannot assign a lawyer — the privilege is absent,
    matter_team    UPDATE  ✗   so the feature was never merely unbuilt, it was impossible
    client_invitations INSERT ✗  the firm cannot invite a client's portal user

  And where a column grant exists, the policy does not admit the write: `matters` carries
  `matters_firm_write` (UPDATE) whose USING clause is `matter_visible(id)` — which is
  false for a matter that does not exist yet, and `firm_client_scope` on `clients` is a
  `for all` policy with `with check (false)`, written to deny rather than to permit. So
  four of the five workflows a law firm runs every day — open a client, open a matter,
  staff it, report on it — were closed at the database, and no amount of front-end work
  would have opened them.

  This migration opens them, deliberately and narrowly, and closes two integrity holes at
  the same time.

  WHAT IT GRANTS, AND TO WHOM

    · firm_api may INSERT a client and UPDATE its own record. The `for all` policy on
      `clients` (`firm_client_scope`) is left exactly as it was: it governs READS, and a
      client with no matter yet is unreachable through it. The new write policies say
      what they mean — a firm member may edit a client whose file they can see, and may
      edit a client who has no file yet, because that client is brand new and whoever
      created them is the only person who can complete them.
    · firm_api may INSERT a matter scoped to its own tenant, and UPDATE the columns a
      case REPORT is made of: the title, the case number, the court, the practice area
      and the client-facing summary. `internal_notes` and `risk_rating` are NOT in that
      list and never will be: 0054 revoked SELECT on them and P0.5 routes them through a
      `security definer` function that checks the ring. A grant here would re-open the
      ring through the back door, which is why the grant is a named column list rather
      than a table privilege.
    · firm_api may INSERT and UPDATE `matter_team`, gated on `matter_visible(matter_id)`.
      UPDATE and not DELETE: removing a lawyer from a file is a deactivation, and a file
      that has been staffed twice should be able to say so.
    · firm_api may INSERT and SELECT `client_invitations`. The portal accepts invitations
      in the portal phase and could already read them; the firm could not create one, so
      "invitation-only onboarding" was a property of the demo route. It is now a property
      of the product.

  WHAT IT FIXES WHILE IT IS OPEN

    (a) ONE LEAD. Two active leads on the same file means two people who believe they own
        it, and the access level each of them gets is 'full'. A partial unique index makes
        a second one unrepresentable rather than discouraged. A partial index and not a
        trigger: the rule is about the SET of rows, and a unique index is enforced at the
        same commit boundary as the writes that create it.
    (b) §11 · FINANCE AND COMPLIANCE ARE ON THE MATTER AND NOT SHOWN. The seed already
        sets `client_visible = false` for the compliance contact, and the portal's
        projection filters on it — but nothing stopped a later write from flipping it to
        true, which would put the firm's AML officer's name in front of the client. The
        CHECK makes the pair of columns state one rule.

  HOW TO APPLY
    node supabase/ops/dry-run.mjs 0058       # parse + roll back
    node supabase/ops/migrate.mjs            # apply
*/

-- ── 1 · CLIENTS · the firm may open one, and complete it ─────────────────────────
/*
  A NAMED COLUMN LIST, NOT `GRANT INSERT ON clients`. The table carries
  `national_id_hash`, which is a keyed hash of a client's identity document: the firm
  writes it at intake and may never read it back, so it is granted for INSERT and not
  added to any SELECT path. A table-level grant would hand over every column added to
  `clients` in future as well, and this project has paid for that reasoning twice.
*/
grant insert (id, tenant_id, client_type, name, name_ar, national_id_masked, national_id_hash,
              commercial_reg_masked, email, phone, address_line, city, country,
              identity_verified, verification_note, status, created_at, updated_at)
  on public.clients to firm_api;
grant update (client_type, name, name_ar, national_id_masked, national_id_hash,
              commercial_reg_masked, email, phone, address_line, city, country,
              identity_verified, verification_note, status, updated_at)
  on public.clients to firm_api;

drop policy if exists clients_firm_insert on public.clients;
create policy clients_firm_insert on public.clients
  for insert
  to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

/*
  THE UPDATE RULE, AND WHY IT IS TWO CASES.

  `firm_client_scope` (the read policy) reaches a client through a matter the member can
  see. That is right for reading an existing relationship and useless for writing a new
  one: a client created thirty seconds ago has no matter, so no visible matter exists, so
  the member could not complete the record they just started. The second branch covers
  exactly that window and no more.
*/
drop policy if exists clients_firm_write on public.clients;
create policy clients_firm_write on public.clients
  for update
  to firm_api
  using (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and (
      exists (select 1 from public.matters m
               where m.client_id = clients.id and public.matter_visible(m.id))
      or not exists (select 1 from public.matters m where m.client_id = clients.id)
    )
  )
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

-- ── 2 · MATTERS · opening the file, and reporting on it ──────────────────────────
grant insert (id, tenant_id, client_id, matter_number, case_number, title, title_ar,
              practice_area, practice_area_ar, court, court_ar, internal_status,
              client_status, summary, summary_ar, opened_at, conflict_cleared,
              created_at, updated_at)
  on public.matters to firm_api;

/*
  THE REPORTING COLUMNS, AND NOTHING ELSE.

  These five are what a case report IS: what the file is called, what the court calls it,
  what it is about, and the summary the client reads. `internal_status` was already
  granted (the state machine route needs it) and stays the only OTHER writable column.
  `risk_rating` and `internal_notes` are absent by design (0054/P0.5): the ring is closed
  here as it is closed there.

  `last_client_update_at` is here because the portal shows it, and a summary that changed
  without the client being told is a report nobody received.
*/
grant update (title, title_ar, case_number, court, court_ar, practice_area, practice_area_ar,
              summary, summary_ar, last_client_update_at, closed_at, client_status)
  on public.matters to firm_api;

drop policy if exists matters_firm_insert on public.matters;
create policy matters_firm_insert on public.matters
  for insert
  to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

-- ── 3 · MATTER_TEAM · assigning the lawyer ───────────────────────────────────────
grant insert (id, matter_id, tenant_id, staff_id, matter_role, client_visible,
              client_role_label, client_role_label_ar, is_active, created_at)
  on public.matter_team to firm_api;
grant update (matter_role, client_visible, client_role_label, client_role_label_ar, is_active)
  on public.matter_team to firm_api;

drop policy if exists matter_team_firm_write on public.matter_team;
create policy matter_team_firm_write on public.matter_team
  for all
  to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant() and public.matter_visible(matter_id))
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant() and public.matter_visible(matter_id));

/*
  (a) ONE LEAD PER FILE — PER LEAD ROLE.

  Written first as "one lead row per matter", and the dry run refused it: the seed staffs
  a file with a lead_partner AND a lead_lawyer, which is not a defect but the way a firm
  works — the partner is answerable for the file, the lawyer runs it, and both resolve to
  access level 'full'. The rule that matches the domain is therefore one ACTIVE row per
  (matter, lead role): two lead parties is two people who each believe they answer for the
  file, which is how a deadline is missed by both.

  A partial unique index rather than a trigger: the rule is about the set of rows, and an
  index is enforced at the same commit boundary as the writes that create it.
*/
drop index if exists matter_team_one_lead_uq;
create unique index matter_team_one_lead_uq
  on public.matter_team (matter_id, matter_role)
  where is_active and matter_role in ('lead_partner', 'lead_lawyer');

/*
  (b) §11 · THE FINANCE AND COMPLIANCE CONTACTS ARE ON THE FILE AND OFF THE CLIENT'S VIEW.

  The portal filters on `client_visible`, so the leak is not a rendering bug — it is a
  data bug waiting to happen at the next write that forgets. The CHECK makes the sentence
  true in the table instead of true in the projection.
*/
alter table public.matter_team drop constraint if exists matter_team_hidden_roles_check;
alter table public.matter_team add constraint matter_team_hidden_roles_check
  check (
    matter_role not in ('finance_contact', 'compliance_contact')
    or client_visible = false
  );

-- ── 4 · CLIENT_INVITATIONS · the firm invites, the portal accepts ────────────────
grant insert (id, tenant_id, client_id, email, display_name, display_name_ar, portal_role,
              token_hash, token_hint, expires_at, created_by_staff, created_at)
  on public.client_invitations to firm_api;
grant select (id, tenant_id, client_id, email, display_name, display_name_ar, portal_role,
              token_hint, expires_at, accepted_at, revoked_at, created_by_staff, created_at)
  on public.client_invitations to firm_api;

drop policy if exists invitations_firm_insert on public.client_invitations;
create policy invitations_firm_insert on public.client_invitations
  for insert
  to firm_api
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    /* The invitation must name a client of THIS firm. A cross-tenant invitation would be
       an account-creation primitive for another firm's client, which is the one thing the
       tenant boundary exists to stop. */
    and exists (select 1 from public.clients c
                 where c.id = client_id and c.tenant_id = public.kgm_tenant())
  );

drop policy if exists invitations_firm_read on public.client_invitations;
create policy invitations_firm_read on public.client_invitations
  for select
  to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

-- ── 5 · VERIFICATION · the migration refuses to apply if it is wrong ─────────────
do $$
declare
  v_missing text;
  v_ok      boolean;
  v_n       integer;
begin
  /* (a) The four writes the product needs must be GRANTED. Asked of the catalogue rather
     than re-reading the statements, because `grant insert (…)` is silent when a column
     name is misspelled — it fails the whole statement, and this block is what turns a
     partially applied file into a visible error. */
  for v_missing, v_n in
    select t.table_name || '.' || t.priv, count(*)
      from (values ('clients','INSERT'), ('clients','UPDATE'), ('matters','INSERT'),
                   ('matters','UPDATE'), ('matter_team','INSERT'), ('matter_team','UPDATE'),
                   ('client_invitations','INSERT'), ('client_invitations','SELECT')) as t(table_name, priv)
     where not exists (
       select 1 from information_schema.column_privileges cp
        where cp.grantee = 'firm_api' and cp.table_name = t.table_name
          and cp.privilege_type = t.priv)
     group by 1
  loop
    raise exception '0058: firm_api holds no % privilege on % — the intake route will fail at runtime', v_n, v_missing;
  end loop;

  /* (b) THE RING STAYS CLOSED. A column grant on these two would re-open P0.5 through the
     back door, and it would do it silently: the route reads them through the definer
     function and would never notice it had become directly readable. */
  select exists (
    select 1 from information_schema.column_privileges
     where grantee = 'firm_api' and table_name = 'matters'
       and column_name in ('internal_notes', 'risk_rating')
       and privilege_type in ('SELECT', 'INSERT', 'UPDATE')
  ) into v_ok;
  if v_ok then
    raise exception '0058: the ring is open — firm_api holds a grant on internal_notes or risk_rating';
  end if;

  /* (c) The policies must exist AND be present for the right command. A policy that is
     permissive and `for all` would have been an easier thing to write and would have
     weakened the read rule; asked here by name so it cannot be swapped later. */
  select count(*) into v_n
    from pg_policies
   where schemaname = 'public'
     and policyname in ('clients_firm_insert','clients_firm_write','matters_firm_insert',
                        'matter_team_firm_write','invitations_firm_insert','invitations_firm_read');
  if v_n <> 6 then
    raise exception '0058: expected 6 intake policies, found %', v_n;
  end if;

  /* (d) The two integrity rules are constraints, not comments. */
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'matter_team'
       and indexname = 'matter_team_one_lead_uq'
  ) into v_ok;
  if not v_ok then
    raise exception '0058: the one-lead index is missing';
  end if;

  /* (d2) …and it says one per (matter, role), not one per matter. Asserted because the
     difference is a domain decision that a later tidier-looking edit would collapse. */
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'matter_team'
       and indexname = 'matter_team_one_lead_uq'
       and indexdef like '%(matter_id, matter_role)%'
  ) into v_ok;
  if not v_ok then
    raise exception '0058: the one-lead index does not key on (matter_id, matter_role)';
  end if;

  select exists (
    select 1 from pg_constraint
     where conrelid = 'public.matter_team'::regclass
       and conname = 'matter_team_hidden_roles_check'
  ) into v_ok;
  if not v_ok then
    raise exception '0058: the hidden-roles constraint is missing';
  end if;

  /* (e) The seed must already satisfy the constraint this file adds. A CHECK that the
     demo data violates would have failed the ALTER above, so this is a statement about
     the data rather than about the schema — and it is here because the constraint is the
     kind that gets added, noticed in a test, and removed by the next person in a hurry. */
  select count(*) into v_n
    from public.matter_team
   where matter_role in ('finance_contact','compliance_contact') and client_visible;
  if v_n > 0 then
    raise exception '0058: % finance/compliance rows are visible to the client', v_n;
  end if;

  raise notice '0058 ok: intake is open (clients, matters, matter_team, invitations), the ring is closed, one lead per role per file';
end $$;
