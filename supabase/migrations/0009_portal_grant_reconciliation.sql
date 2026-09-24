-- 0009 — RECONCILE THE PORTAL GRANTS WITH THE QUERIES THE CODE ACTUALLY RUNS
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
-- SQLite has no column privileges. Postgres does. The repository layer was
-- written and tested against SQLite, where every query works, and 0004's grants
-- are a hand-written enumeration of the columns those queries were THOUGHT to
-- need. Where the two disagree, the query works in development and returns
--
--     permission denied for table <t>
--
-- against the real database. That is the whole class of bug, and it has now
-- produced four separate failures — each discovered only by running live:
--
--   0007  invoices.client_status   NOT NULL while the derivation returns NULL
--   0008  matters.risk_rating      reachable via inherited table-level SELECT
--   0009  users.*                  LOGIN RETURNED HTTP 500
--   0009  nine more tables         every affected page returned HTTP 500
--
-- THE LOGIN FAILURE, CONCRETELY
--   `repo.getUserByEmail` selects 17 columns from `users`. 0004 granted 14.
--   The three it did not:
--
--     users.created_at           not granted to anyone
--     users.last_login_ip_hash   not granted to anyone
--     users.mfa_enabled_at       granted UPDATE (the enrolment write) but never SELECT
--
--   So the first query of every sign-in failed and the API answered 500 — the
--   "request could not be completed" the client portal showed. Nothing in the
--   application was wrong; the database refused the read.
--
-- WHY THIS IS A MIGRATION AND NOT A ONE-LINE FIX
--   `supabase/ops/reconcile_column_grants.mjs` extracts every column the code
--   references from the SQL in `server/src`, resolves each against the live
--   catalog, and reports which are ungranted. It found 18 for the portal across
--   11 tables — not one, and not a set anyone would have guessed. Enumerating by
--   hand is what produced the drift, so the list below is generated from that
--   report rather than from reading the queries again.
--
--   Run it after any change to a query or a grant. It is the guard against this
--   class returning.
--
-- ============================================================================
-- THE COLUMNS, AND WHY EACH IS DEFENSIBLE
-- ============================================================================
-- 1 · users — the login fix. All three are authentication bookkeeping the portal
--     already operates on: when the account was created, from where it last
--     signed in (a salted hash, not an address), and when MFA was enabled.
--     None is another user's data, and RLS still scopes every row to the caller.
--
-- 2 · tenant_id on deadlines / hearings / matter_team / matter_timeline /
--     messages. The repository filters `where tenant_id = ?`, and filtering on a
--     column REQUIRES SELECT on it. These are not disclosures — the value is the
--     caller's own tenant, which the server resolved and passed in, and RLS
--     already restricts the rows to it.
--
-- 3 · invoices.internal_status and messages.internal_flag — the two genuinely
--     uncomfortable ones, so the reasoning is recorded rather than assumed.
--
--     Both are used ONLY to EXCLUDE internal content:
--       invoices:   `internal_status not in ('draft','pending_internal_approval')`
--       messages:   `internal_flag = FALSE`
--     Without the read the portal cannot filter, and the failure is not a
--     permission error — it is a client seeing an invoice the firm has not
--     approved and never released. A wrong disclosure caused by a missing grant
--     is worse than the grant.
--
--     The cost is real: a careless `select *` on invoices or messages would now
--     return these two columns. They are the least sensitive of the §57 set — a
--     status enum and a boolean — and the projection that strips them is covered
--     by tests. See the FOLLOW-UP note at the end of this file: the correct fix is
--     to let the portal filter without holding the column.
--
-- 4 · payments / receipts / privacy_requests — the portal's own financial and
--     privacy surfaces. tenant_id and user_id are the caller's own identity
--     (already known to them); idempotency_key and client_id are read by the
--     receipt projection, which is the client's own receipt.
--
-- 5 · payment_webhook_events — see below; this one was a correctness bug, not
--     just a permission error.

-- ---------------------------------------------------------------------------
-- 1 · users — the sign-in read
-- ---------------------------------------------------------------------------
grant select (created_at, last_login_ip_hash, mfa_enabled_at)
  on public.users to portal_api;

-- ---------------------------------------------------------------------------
-- 2 · the tenant_id filters
-- ---------------------------------------------------------------------------
grant select (tenant_id) on public.deadlines       to portal_api;
grant select (tenant_id) on public.hearings        to portal_api;
grant select (tenant_id) on public.matter_team     to portal_api;
grant select (tenant_id) on public.matter_timeline to portal_api;
grant select (tenant_id) on public.messages        to portal_api;

-- ---------------------------------------------------------------------------
-- 3 · the exclusion filters (see the header for the tradeoff)
-- ---------------------------------------------------------------------------
grant select (internal_status) on public.invoices to portal_api;
grant select (internal_flag)   on public.messages to portal_api;

-- ---------------------------------------------------------------------------
-- 4 · the portal's own financial / privacy surfaces
-- ---------------------------------------------------------------------------
grant select (tenant_id, idempotency_key) on public.payments         to portal_api;
grant select (client_id, tenant_id)       on public.receipts         to portal_api;
grant select (tenant_id, user_id)         on public.privacy_requests to portal_api;

-- ---------------------------------------------------------------------------
-- 5 · payment_webhook_events — a CORRECTNESS bug hiding behind a grant error
-- ---------------------------------------------------------------------------
/*
  `payment-service.ts` checks replay protection with:

      select count(*) from payment_webhook_events where provider = ? and event_id = ?

  and inserts a row per delivery. The portal role held no grant on the table and
  no policy applied to it — `webhook_scope` is declared `TO payments_service`,
  and RLS fails closed for every other role.

  So on Postgres the idempotency check would have counted zero rows for an event
  that had already been processed, and — if the grant alone had been added without
  the policy — a replayed delivery would have been accepted as new. Signature
  verification would still reject a forged body, but a provider's legitimate
  at-least-once REDELIVERY would have been applied twice: a double payment
  credited against an invoice.

  The fix is a grant AND a policy. The policy is phase-gated to 'auth' rather than
  `using (true)`: the webhook is unauthenticated, so its request context is the
  pre-session phase, while a signed-in portal request is phase 'portal' and cannot
  read the table at all. That keeps the idempotency ledger out of the client
  surface while leaving the webhook path working.
*/
grant select, insert on public.payment_webhook_events to portal_api;

drop policy if exists webhook_portal_scope on public.payment_webhook_events;
create policy webhook_portal_scope on public.payment_webhook_events to portal_api
  using (public.kgm_phase() = 'auth')
  with check (public.kgm_phase() = 'auth');

-- ---------------------------------------------------------------------------
-- 6 · Assert the outcome, and assert that nothing was widened by accident.
-- ---------------------------------------------------------------------------
do $$
declare
  missing text;
begin
  -- The three columns whose absence caused the HTTP 500.
  select string_agg(c, ', ') into missing
    from unnest(array['created_at', 'last_login_ip_hash', 'mfa_enabled_at']) c
   where not has_column_privilege('portal_api', 'public.users', c, 'SELECT');

  if missing is not null then
    raise exception 'portal_api still cannot read users.% — login will return 500.', missing;
  end if;

  -- ...and the internal columns must STILL be out of reach. This migration adds
  -- two status columns for filtering; it must not have widened anything else, and
  -- 0008's fix must still hold.
  select string_agg(t || '.' || c, ', ') into missing
    from (values
      ('matters', 'risk_rating'), ('matters', 'internal_notes'),
      ('invoices', 'notes_internal'), ('deadlines', 'assigned_staff_id'),
      ('deadlines', 'internal_comment'), ('hearings', 'internal_status'),
      ('messages', 'internal_note')
    ) as x(t, c)
   where has_column_privilege('portal_api', 'public.' || t, c, 'SELECT');

  if missing is not null then
    raise exception 'portal_api can read internal column(s): %', missing;
  end if;

  -- The inheritance fix from 0008 must not have been undone in passing.
  if pg_has_role('portal_api', 'firm_api', 'USAGE') then
    raise exception 'portal_api INHERITS firm_api again — see 0008.';
  end if;

  raise notice 'portal_api grants reconciled; §57 internal columns still denied.';
end $$;

-- ---------------------------------------------------------------------------
-- FOLLOW-UP (not a blocker, recorded so it is not lost)
-- ---------------------------------------------------------------------------
-- Invoices and messages are the only two places the portal filters on a §57
-- column, and both filter for exclusion. The grant above is a deliberate,
-- reasoned widening; the strictly better shape is to stop needing it:
--
--   invoices: `client_status is not null` is EXACTLY equivalent to
--             `internal_status not in ('draft','pending_internal_approval')` —
--             because derive_invoice_client_status returns NULL for precisely
--             those two states, and 0007 made client_status nullable to hold that
--             NULL. Rewriting the three repository predicates to test
--             client_status would let this grant be revoked.
--
--   messages: add `client_visible boolean generated always as (not internal_flag) stored`
--             and filter on that instead.
--
-- Either change lets migration 0010 revoke both column grants and shrink the
-- portal's column reach back to the client-safe projection alone.
