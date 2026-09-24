-- 0008 — RESTORE THE §57 FIELD-LEVEL FLOOR: BREAK THE PRIVILEGE INHERITANCE
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
-- `create_api_login.sql` ends with `grant firm_api to portal_api`, so that one
-- API role can satisfy both the portal policies (100 declared `TO portal_api`)
-- and the firm policies (34 declared `TO firm_api`). The intent was sound and the
-- reasoning is documented there: this deployment runs one process with one pool,
-- and RLS fails closed, so a connection that is one role only would leave half the
-- product returning nothing with no error to explain it.
--
-- The consequence was not intended, and it is the kind that leaves no trace.
--
--   Privileges in PostgreSQL are ADDITIVE, and inheritance is all-or-nothing.
--   `firm_api` holds TABLE-LEVEL SELECT on 22 tables — it must, because firm staff
--   legitimately read `matters.risk_rating` and `matters.internal_notes`. A
--   table-level grant SUBSUMES every column-level grant on that table. So by
--   becoming a member of `firm_api`, `portal_api` acquired table-level SELECT on
--   those 22 tables and every exclusion 0004 had carefully written became
--   decorative:
--
--     matters.risk_rating        matters.internal_notes     invoices.notes_internal
--     deadlines.assigned_staff_id  deadlines.internal_comment
--     hearings.internal_status   messages.internal_note
--
--   Measured on the live database, as `portal_api`, inside a real portal request
--   context scoped to a single client (phase='portal', kgm.tenant_id and
--   kgm.client_ids set as the server sets them):
--
--     select title, client_status, risk_rating, internal_notes from matters
--       -> 'Commercial Dispute'     | 'high'   | 'INTERNAL: partner to approve
--                                                settlement posture before next session.'
--       -> 'Real Estate Contract…'  | 'medium' | 'INTERNAL: awaiting conflict
--                                                clearance on counterparty.'
--
--   RLS still limited the ROWS to that client's own matters. It did not limit the
--   COLUMNS. One carelessly written `select m.*` — or a `returning *`, or an
--   ORM entity — in a portal route would hand a client the firm's internal
--   settlement strategy and its conflict-check notes.
--
--   §57 puts field classification at the database layer for exactly one reason:
--   so that a mistaken query is not the last line of defence. It was.
--
-- ============================================================================
-- WHY THIS CANNOT BE FIXED WITH GRANTS
-- ============================================================================
-- There is no negative grant. Any privilege `firm_api` holds, `portal_api` holds.
-- A single role therefore cannot serve two audiences with different column reach
-- — and firm staff genuinely need the internal columns the portal must never see.
-- The only two ways out are two logins with two pools, or `SET ROLE`.
--
-- ============================================================================
-- THE FIX
-- ============================================================================
--   INHERIT FALSE, SET TRUE.
--
--   `portal_api` now inherits NOTHING from `firm_api`, so its column grants are
--   once again the entire extent of its column reach — the §57 floor is restored
--   by subtraction, with no grant rewritten and nothing lost. It may still switch
--   into `firm_api` for the duration of a firm request, which is what the role was
--   for all along. `server/src/db/postgres.ts` issues `SET ROLE firm_api` when the
--   resolved request phase is 'firm' and `RESET ROLE` on every other path,
--   including the release back to the pool.
--
--   This is strictly stronger than what it replaces. Previously the role and the
--   phase disagreed — the connection was `portal_api` while purporting to serve a
--   firm request, and `kgm_is_firm()` was the only thing withholding firm rows.
--   Now they agree: a portal request runs as `portal_api` and satisfies only
--   portal policies; a firm request runs as `firm_api` and satisfies only firm
--   policies. The phase GUC becomes the second lock on the door rather than the
--   only one.
--
-- ============================================================================
-- WHY `firm_api` AND NOT `firm_os`
-- ============================================================================
--   `firm_os` carries `firm_full ... USING (true)` on the domain tables
--   (matters, clients, documents, invoices, matters_team) plus
--   `grant all on all tables in schema public`. It is a SERVICE role — back-office
--   jobs, migrations and administrative workflows that must attribute their own
--   writes — and on those tables it is not tenant-filtered. Switching user
--   requests into it would trade a column leak for a cross-tenant one.
--
--   `firm_api`'s policies are the strict ones, and they are the ones written for
--   user-facing firm traffic:
--
--     firm_matter_scope: kgm_is_firm() AND tenant_id = kgm_tenant()
--                        AND matter_visible(<matter>)
--
--   `matter_visible()` is SECURITY DEFINER and resolves through
--   `matter_access_level()`, so matter-level and practice-area scoping (§5, §71)
--   still apply. `firm_api` is also least-privilege on writes: SELECT only,
--   plus INSERT/UPDATE on its own session and device tables.
--
-- ============================================================================
-- ALSO IN THIS FILE: the two tables the firm role was never given
-- ============================================================================
--   `firm_api` held no grant at all on `clients` or `matter_team`, and neither
--   table has a `firm_api` policy — only `firm_full`, deferred above. But
--   `server/src/db/firm-repo.ts` left-joins `clients` for the matter and invoice
--   lists and subqueries `matter_team` for the caller's matter role, so against
--   Postgres those columns came back empty. Measured before this migration, as the
--   API role in a firm request context: `select count(*) from clients` returned 0
--   of 3, `matter_team` 0 of 8 — client names and matter roles rendered blank.
--
--   This is a pre-existing gap, independent of the inheritance defect above: it
--   would have behaved identically had the roles been separated from the start.
--   Both are closed here because the firm half cannot be verified live without it.

-- ---------------------------------------------------------------------------
-- 1 · Break the inheritance, keep the reachability.
-- ---------------------------------------------------------------------------
revoke firm_api from portal_api;

-- PostgreSQL 16+ syntax. Supabase runs 17.6 (verified against the live project).
-- INHERIT FALSE  -> the connection gains none of firm_api's privileges by default,
--                   so 0004's column grants bound it once more.
-- SET TRUE       -> the request path may still assume it explicitly.
grant firm_api to portal_api with inherit false, set true;

-- ---------------------------------------------------------------------------
-- 2 · Assert the outcome instead of assuming it.
-- ---------------------------------------------------------------------------
-- A silent failure here has no symptom: the portal keeps working and simply has
-- its internal columns back, and nobody finds out until a client reads one. The
-- install verifies its own result and aborts if the floor is not restored.
do $$
declare
  inherits_privs boolean;
  can_assume     boolean;
  firm_bypass    boolean;
  firm_super     boolean;
begin
  select pg_has_role('portal_api', 'firm_api', 'USAGE') into inherits_privs;
  select pg_has_role('portal_api', 'firm_api', 'SET')   into can_assume;

  if inherits_privs then
    raise exception
      'portal_api still INHERITS firm_api. The §57 column grants are still subsumed '
      'by firm_api''s table-level SELECT, and the portal can still read internal columns.';
  end if;

  if not can_assume then
    raise exception
      'portal_api can no longer SET ROLE into firm_api. Every firm-audience request '
      'would fail RLS closed and the firm OS would return empty result sets with no error.';
  end if;

  -- The floor itself: the two columns that motivated this migration.
  if has_column_privilege('portal_api', 'public.matters', 'risk_rating', 'SELECT') then
    raise exception 'portal_api can still read matters.risk_rating — floor not restored.';
  end if;

  if has_column_privilege('portal_api', 'public.matters', 'internal_notes', 'SELECT') then
    raise exception 'portal_api can still read matters.internal_notes — floor not restored.';
  end if;

  -- ...and the legitimate reader must not have been narrowed by the fix.
  if not has_column_privilege('firm_api', 'public.matters', 'risk_rating', 'SELECT') then
    raise exception 'firm_api lost matters.risk_rating — the firm OS needs this column.';
  end if;

  -- The role assumed for firm requests must itself be safe to assume. The boot
  -- guard checks this too (role-guard.ts); failing here points at the role rather
  -- than at a server that mysteriously will not start.
  select rolbypassrls, rolsuper into firm_bypass, firm_super
    from pg_roles where rolname = 'firm_api';

  if firm_super or firm_bypass then
    raise exception
      'firm_api is superuser=% or bypassrls=%, so assuming it for firm requests would '
      'exempt the whole firm half of the product from Row Level Security.', firm_super, firm_bypass;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3 · The two tables firm_api was never given (see the header note).
-- ---------------------------------------------------------------------------
grant select on public.clients     to firm_api;
grant select on public.matter_team to firm_api;

-- mirrors firm_matter_scope on the neighbouring tables exactly.
drop policy if exists firm_matter_scope on public.matter_team;
create policy firm_matter_scope on public.matter_team to firm_api
  using (public.kgm_is_firm()
         and tenant_id = public.kgm_tenant()
         and public.matter_visible(matter_id))
  with check (false);            -- firm_api has SELECT only; writes go through firm_os

/*
  Clients are gated through matters, not granted wholesale.

  A firm user may read a client record only where they can already read one of
  that client's matters. The alternative — every client in the tenant — would make
  this table a way around the matter-level scoping that everything else obeys, and
  a lawyer scoped to Commercial Litigation would be able to enumerate the firm's
  entire client book by name, which is a competitive asset as much as it is
  personal data.

  CONSEQUENCE, STATED PLAINLY: a client the user has no visible matter for does
  not appear. The firm OS "Clients" module therefore lists clients-by-matter
  rather than the whole book. If a practice needs a full-book conflict check, that
  is a deliberate, separately-permissioned surface (a `matter_controls` style
  check that runs with attribution) — not a side effect of the client list.
  Revisit if the Clients module is specified to show more; the policy to widen is
  this one, and widening it is a one-line change with a visible audit trail.

  `matter_visible()` is SECURITY DEFINER, so the matters subquery cannot recurse
  into this policy. The matters RLS applies on top and only narrows further.
*/
drop policy if exists firm_client_scope on public.clients;
create policy firm_client_scope on public.clients to firm_api
  using (public.kgm_is_firm()
         and tenant_id = public.kgm_tenant()
         and exists (select 1 from public.matters m
                      where m.client_id = public.clients.id
                        and public.matter_visible(m.id)))
  with check (false);

comment on policy firm_client_scope on public.clients is
  'Firm-side client visibility, gated through matter_visible() so the client list '
  'cannot bypass matter-level scoping (§5, §71). Widening this is a policy decision.';
