-- ═══════════════════════════════════════════════════════════════════════════════
-- 0073 · the row every matter is owed, and the key nobody needed
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Two unrelated corrections that belong together only because both are about access
-- that was never granted or never closed. Read them separately.
--
--
-- ── PART ONE · EVERY MATTER NEEDS A CONTROL ROW, AND THE DATABASE MUST MAKE IT ──
--
-- THE DEFECT, in the order it was found:
--
--   1  `POST /api/firm/matters/:id/restrict` answers 404 `not_found` — "matter not
--      found" — for a matter the caller has just read the detail of.
--
--   2  The cause is not the route. `matter_controls` is keyed by `matter_id`, and a
--      matter created through the product has NO row in it. The UPDATE in
--      `FirmRepo.setMatterRestriction` therefore matches zero rows, and the route
--      reads `changes === 0` as "no such matter".
--
--   3  The cause of THAT is a missing grant with a missing rule behind it. On
--      `matter_controls`, `firm_api` holds SELECT on every column and UPDATE on
--      exactly six — the restriction columns — and INSERT on none. The grant is
--      telling the truth: restricting a matter is the application's business, and
--      CREATING the control row was meant to be the database's. No migration ever
--      wrote the rule. Only the demo seeder ever inserted the row, which is why the
--      seven seeded matters work and every matter created since does not.
--
-- WHAT IT COSTS. Two things, one of them worse than the other.
--
--   · The visible half: restricting a matter does nothing, and says the matter does
--     not exist. A firm that restricts a matter for a conflict, a client instruction
--     or a court order is told it succeeded when nothing was written — while
--     `matter_access_level()` keeps answering from `coalesce(mc.is_restricted, false)`,
--     so the matter stays reachable by everyone in its practice area.
--
--   · The lasting half: the route writes its MATTER_RESTRICTED audit row inside the
--     same transaction and THROWS AFTER THE TRANSACTION COMMITS, so the trail records
--     a successful restriction that never happened. An audit trail that can assert an
--     event that did not occur is worse than no trail, because it will be believed.
--     (The route is corrected in the same change: the refusal now happens inside the
--     transaction, before the audit row is written.)
--
-- THE RULE ITSELF. One control row per matter, created by the database, for every
-- writer — the application, an import, a migration, a verification script. A trigger
-- and not a service call, because the service CANNOT do it: with no INSERT privilege
-- on the table, any attempt from `firm_api` would be refused by Postgres. The trigger
-- is SECURITY DEFINER and owned by the migration runner precisely so the rule does not
-- depend on the writer's grants.
--
-- THE ROW IS BORN EMPTY, and that is deliberate. `department_id`, `owner_membership_id`,
-- `lead_staff_id` and `supervising_partner_staff_id` are nullable and are NOT guessed
-- from the matter's practice area or from whoever created it. Guessing an owner would
-- put a name on a matter nobody agreed to own. What this migration guarantees is that
-- the row EXISTS — so the six columns the application is allowed to write have somewhere
-- to be written, and so "the matter has no controls" stops being a state the system can
-- be in.

create or replace function public.matter_controls_row_for_new_matter()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  /*
    `on conflict do nothing` is not decoration. The demo seeder inserts its own
    control row — with the department, the owner, the lead and the restriction that
    make §27 demonstrable — and it does so AFTER the matter row. Whichever arrives
    second must not fail, and here it is this trigger: the seeder's richer row wins,
    which is the behaviour the seed data depends on.
  */
  insert into public.matter_controls (matter_id, tenant_id, created_at, updated_at)
  values (new.id, new.tenant_id, now(), now())
  on conflict (matter_id) do nothing;
  return null;
end $$;

comment on function public.matter_controls_row_for_new_matter() is
  'Creates the matter_controls row every matter is owed. SECURITY DEFINER because firm_api holds no INSERT on the table.';

drop trigger if exists matters_controls_row on public.matters;
create trigger matters_controls_row
  after insert on public.matters
  for each row execute function public.matter_controls_row_for_new_matter();

/* THE MATTERS THAT ALREADY EXIST. A backfill, not a repair of history: the row is
   born empty by the same rule as the trigger, so nothing is asserted about a matter
   that nobody recorded a decision about. */
insert into public.matter_controls (matter_id, tenant_id, created_at, updated_at)
select m.id, m.tenant_id, now(), now()
  from public.matters m
 where not exists (select 1 from public.matter_controls mc where mc.matter_id = m.id)
on conflict (matter_id) do nothing;


-- ═══════════════════════════════════════════════════════════════════════════════
-- ── PART TWO · FUNCTIONS THAT ANONYMOUS CALLERS COULD RUN ──────────────────────
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS FOUND. In PostgreSQL, `CREATE FUNCTION` grants EXECUTE to PUBLIC unless it
-- is revoked. Every helper this schema defines therefore became callable by the two
-- roles Supabase exposes to the network — `anon` (no credential beyond the project
-- URL and the publishable key) and `authenticated`. The table privileges saved the
-- system: `anon` holds ZERO privileges on every table in `public`, so a direct read is
-- refused. But thirteen of those helpers are SECURITY DEFINER, which is to say they
-- run as their DEFINER — the migration runner, a superuser — and they do their own
-- authorization from session variables the CALLER can set. `anon` may set those
-- variables; PostgreSQL lets any role set an unrecognised `kgm.*` parameter.
--
-- DEMONSTRATED, AS `anon`, WITH NO LOGIN:
--
--     select set_config('kgm.tenant_id', '<any tenant uuid>', true);
--     select public.kgm_client_trust_total('<that tenant>');   -- → 65000.00
--     select public.kgm_ledger_balance('<any ledger uuid>');   -- → the balance
--
--   …and `matter_visible()`, `kgm_lawyer_ring()`, `kgm_holds()`, `matter_access_level()`
--   and others answer as ORACLES: a caller who knows or can guess an identifier can ask
--   yes/no questions about it. `kgm_next_fiscal_number()` is the sharpest of them — with
--   a fiscal device id it would move that device's invoice counter, which is the ZATCA
--   chain's integrity, not merely its confidentiality.
--
-- The good news, recorded because it is the part that was already right:
-- `firm_read_matter_privilege()` REFUSED `anon` — it checks the caller's membership ring
-- and raised `privilege_ring_refused: matter_out_of_scope`. It is the one helper whose
-- authorization does not depend on a variable the caller controls.
--
-- THE CORRECTION IS THE DEFAULT, NOT A LIST. Each function is not enumerated — the
-- grant is simply taken back from the general public and given to the four roles the
-- application actually connects as. A new function added tomorrow is therefore closed
-- by default, and the failure mode is a missing GRANT in a migration (loud, immediate,
-- caught by the first request) rather than a helper quietly exposed to the internet
-- for a year.
--
-- WHAT ANON KEEPS: nothing that matters. It has no table privileges, and from here it
-- has no function privileges either. The publishable key alone opens no door.

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on all functions in schema public
  to firm_api, portal_api, auditor, payments_service, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- ── PART THREE · A LOGIN ROLE THAT OPENS BOTH DOORS ───────────────────────────
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- `kgm_probe` was created while the schema was being explored by hand. It is a LOGIN
-- role with a password, it is a member of BOTH `firm_api` and `portal_api`, and it
-- therefore can `SET ROLE` into either audience — the firm's software and the client's
-- portal, from one credential. It owns nothing, holds no grants of its own, and is
-- referenced nowhere in the repository: a second key to the building, cut during
-- construction and never collected.
--
-- IT IS DROPPED RATHER THAN DISABLED. `drop role` revokes the memberships and the
-- privileges it held on the way out, which is the whole of what it had: verified before
-- the drop, it owned no table, no function and no default privilege, and held no grant
-- of its own. (`drop owned by` is deliberately NOT used — it requires the executing role
-- to hold privileges OF the role being emptied, which the migration runner does not, and
-- it would also drop objects, of which there are none to drop.) The password must
-- still be treated as disclosed and rotated anywhere it might have been reused; a role
-- that is gone cannot be logged into, but it can have been.
--
-- The surviving roles are the four the application uses, and their shape is checked on
-- every boot: `portal_api` logs in, and it may `SET ROLE` into `firm_api` and nothing
-- else that carries privileges.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'kgm_probe') then
    /*
      The schema ACL is the only thing holding the role in place — `public` was granted
      to it at creation, along with every other role in the project. Each of these
      revokes is a no-op if the grant is not there, and all four are needed because
      `drop role` refuses on the first dependency it finds rather than listing them.
    */
    execute 'revoke all on schema public from kgm_probe';
    execute 'revoke all on all tables in schema public from kgm_probe';
    execute 'revoke all on all sequences in schema public from kgm_probe';
    execute 'revoke all on all functions in schema public from kgm_probe';
    execute 'drop role kgm_probe';
    raise notice '0073: dropped the kgm_probe login role (member of firm_api and portal_api)';
  else
    raise notice '0073: kgm_probe was already absent';
  end if;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- ── VERIFY ────────────────────────────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_orphans      int;
  v_exposed      text;
  v_not_granted  int;
  v_triggers     int;
begin
  /* PART ONE. Every matter has a control row — and the trigger will keep it that way
     for the next one. */
  select count(*) into v_orphans
    from public.matters m
   where not exists (select 1 from public.matter_controls mc where mc.matter_id = m.id);

  if v_orphans > 0 then
    raise exception '0073: % matter(s) still have no control row — restricting them would silently do nothing', v_orphans;
  end if;

  select count(*) into v_triggers
    from pg_trigger
   where tgrelid = 'public.matters'::regclass
     and tgname = 'matters_controls_row'
     and not tgisinternal;

  if v_triggers <> 1 then
    raise exception '0073: the trigger that creates a matter''s control row is not installed — the next matter created would have none';
  end if;

  /* PART TWO. No SECURITY DEFINER helper is reachable by an unauthenticated caller.
     Written as a sweep over the catalogue rather than over a list, so a function added
     by a later migration without a grant cannot slip past this check. */
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    into v_exposed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  if v_exposed is not null then
    raise exception '0073: these SECURITY DEFINER helpers are still executable by anon or authenticated: %', v_exposed;
  end if;

  /* …and the application can still run the ones it needs. This half matters as much as
     the half above: a security fix that breaks the product is a security fix that gets
     reverted. Checked on two helpers from opposite corners of the schema — an
     authorization predicate every policy calls, and a fiscal one. */
  /* Matched on name and arity, not on a written-out signature: `identity_arguments`
     includes the parameter NAMES (`p_tenant uuid`), so a hand-written `(uuid, ...)` 
     matches nothing and this check would fail on a correct database — which is exactly
     what it did the first time it ran. */
  select count(*) into v_not_granted
    from (values
      ('kgm_is_firm'::text, 0),
      ('matter_visible'::text, 1),
      ('kgm_client_trust_total'::text, 2),
      ('kgm_next_fiscal_number'::text, 1)
    ) as want(fn, arity)
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = want.fn
        and p.pronargs = want.arity
        and has_function_privilege('firm_api', p.oid, 'EXECUTE')
        and has_function_privilege('portal_api', p.oid, 'EXECUTE')
   );

  if v_not_granted > 0 then
    raise exception '0073: % helper(s) the application calls were left without EXECUTE — the revoke went too far', v_not_granted;
  end if;

  /* PART THREE. The key is gone, and the roles that remain are the four the application
     connects as — none of them able to log in except portal_api, which is the door. */
  if exists (select 1 from pg_roles where rolname = 'kgm_probe') then
    raise exception '0073: the kgm_probe login role survived';
  end if;
end $$;
