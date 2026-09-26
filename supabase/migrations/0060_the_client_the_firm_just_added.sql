-- 0060 — THE CLIENT THE FIRM JUST ADDED
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
--
-- 0058 gave the firm the three writes intake needs: `clients_firm_insert` and
-- `clients_firm_write` (UPDATE). Its comment reasons the UPDATE rule out exactly
-- right, and that reasoning is the reason this file exists:
--
--   "a client created thirty seconds ago has no matter, so no visible matter
--    exists, so the member could not complete the record they just started.
--    The second branch covers exactly that window and no more."
--
-- The read rule was left as it was written in 0008: `firm_client_scope` reaches a
-- client ONLY through a matter the member can see. 0008 chose that deliberately —
-- the firm's client book is a competitive asset, and a client list that ignored
-- matter scoping would be a way around the ring. It also stated the consequence
-- plainly: "a client the user has no visible matter for does not appear."
--
-- The consequence was invisible while clients were only ever seeded. Task 25 made
-- the firm ADD a client itself, and then immediately attach a matter to it. On
-- that path the window 0058 opened for UPDATE is a window for SELECT too, and the
-- read policy closes it:
--
--   POST /clients        -> 201. The row is written; the INSERT policy admits it.
--   PATCH /clients/:id   -> 200. The UPDATE policy admits a client with no matters.
--   GET  /clients        -> the client is NOT in the register. No visible matter.
--   GET  /clients/new    -> not offered in the picker.
--   POST /matters        -> 404 `client not found`.
--
--   …and the duplicate check is blind in the same way. `findClientByName` decides
--   whether a name is already on the register by reading the register, so a client
--   created second ago cannot be found, so the SECOND client of the same name is
--   created, and the firm now has two rows for one client — the exact defect the
--   intake stage exists to prevent. Two conflict checks, each seeing half the
--   truth.
--
--   The live harness found this. `tests/security/intake.test.ts` passes 23/23 on
--   SQLite, which has no policies: the SELECT simply happens and the workflow looks
--   perfect. It is the twenty-third time this project has paid for the difference
--   between the two dialects, and it is the first time the payment was a whole
--   stage of the product.
--
-- ============================================================================
-- THE FIX, AND ITS BOUNDARY
-- ============================================================================
--
-- A separate SELECT policy, `clients_firm_read`, whose predicate is the SAME TWO
-- CASES `clients_firm_write` already uses:
--
--   1. the client has at least one matter the member can see — the rule 0008
--      wrote, unchanged; or
--   2. the client has NO matters at all — the firm's own intake window.
--
-- Case 2 is not a widening of the ring, because the ring protects MATTERS. A
-- client with no matters carries no matter to protect: it is a name, a type, a
-- city and a masked identifier on the firm's own register, written by a member of
-- that firm minutes ago. A client whose ONLY matters are invisible to the member
-- fails both branches and stays invisible, exactly as before — so a restricted
-- file still cannot be reached sideways by enumerating the client book.
--
-- This is the "one-line change with a visible audit trail" 0008 promised for the
-- day the Clients module was specified to show more. The audit trail is the
-- `CLIENT_CREATED` row each of these clients already writes.
--
-- ============================================================================

begin;

drop policy if exists clients_firm_read on public.clients;
create policy clients_firm_read on public.clients
  for select
  to firm_api
  using (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and (
      exists (select 1 from public.matters m
               where m.client_id = clients.id and public.matter_visible(m.id))
      or not exists (select 1 from public.matters m where m.client_id = clients.id)
    )
  );

/*
  The boundary, written where the next person will read it. 0008's comment on
  `firm_client_scope` still stands for every client that has a matter; this policy
  adds only the case that has none.
*/
comment on policy clients_firm_read on public.clients is
  'The intake window: a client the firm added but has not yet opened a file for '
  'must be readable — otherwise the picker, the duplicate check and POST /matters '
  'are all blind to it. A client whose only matters are hidden stays hidden.';

-- ── THE ASSERTIONS ───────────────────────────────────────────────────────────────

do $$
declare
  v_ok boolean;
  v_n  integer;
  v_def text;
begin
  /* (a) The policy exists, is a SELECT policy, is permissive, and is declared to
     firm_api. Asked by name and by command, because `for all` would also have
     "worked" while meaning something weaker. */
  select count(*) into v_n
    from pg_policies
   where schemaname = 'public' and tablename = 'clients'
     and policyname = 'clients_firm_read'
     and cmd = 'SELECT'
     and permissive = 'PERMISSIVE'
     and roles::text like '%firm_api%';
  if v_n <> 1 then
    raise exception '0060: clients_firm_read is missing, or is not a permissive SELECT policy for firm_api';
  end if;

  /* (b) BOTH branches are in the predicate. The empty-matter branch is the whole
     point of this migration; a later edit that "simplifies" the policy back to the
     0008 shape would leave the product working on SQLite and broken here, which is
     the failure this file exists to end. `pg_policies.qual` is the normalised text
     of the USING clause, so it is asked for what it must contain, not how it is
     written. */
  select qual into v_def
    from pg_policies
   where schemaname = 'public' and tablename = 'clients' and policyname = 'clients_firm_read';
  if v_def is null
     or v_def not like '%matter_visible%'
     or v_def not like '%NOT (EXISTS%' then
    raise exception '0060: clients_firm_read lost one of its two branches: %', coalesce(v_def, '(null)');
  end if;

  /* (c) 0008's rule is still there and still unqualified. The intake window is added
     BESIDE the ring, never in place of it. */
  select count(*) into v_n
    from pg_policies
   where schemaname = 'public' and tablename = 'clients' and policyname = 'firm_client_scope';
  if v_n <> 1 then
    raise exception '0060: firm_client_scope is gone — the ring was replaced instead of widened';
  end if;

  /* (d) The other half of the window is still open. Read and write must be the same
     shape or the product is asymmetric in a way no test on SQLite can see. */
  select count(*) into v_n
    from pg_policies
   where schemaname = 'public' and tablename = 'clients'
     and policyname = 'clients_firm_write';
  if v_n <> 1 then
    raise exception '0060: clients_firm_write is missing';
  end if;

  /* (e) The identity hash is still not readable by the portal, and the portal's own
     client policy is untouched by this file. */
  select exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'clients'
       and policyname = 'client_scope' and roles::text like '%portal_api%'
  ) into v_ok;
  if not v_ok then
    raise exception '0060: the portal client policy disappeared';
  end if;
end $$;

commit;
