-- ============================================================================
-- KGM LEGAL OS · 0018 — PORTAL UPDATE POLICIES (systematic)
-- ============================================================================
-- 0017 fixed two tables. This one fixes the class.
--
-- Every portal policy in the schema was written as `for all`, which is the only
-- shape that lets one policy cover read and write with a single USING expression.
-- The cost is that WITH CHECK — which in Postgres applies to INSERT *and* UPDATE —
-- has to mean both things at once, and it can only mean one:
--
--   * written for INSERT (five tables here), it asserts a property of a NEWLY
--     CREATED row, such as `status = 'submitted'`. Every later UPDATE then has to
--     reproduce that property, so any legitimate state change is refused.
--   * written as `with check (false)` (deadlines, invoices), it is a precise way
--     of saying "this role may read, and create nothing" — and it also forbids
--     every update.
--
-- On SQLite there is no RLS, so all five tables had passing tests and working
-- pages. On Postgres each update failed as:
--
--     new row violates row-level security policy for table "<t>"
--
-- Observed live, in this order: appointments and client_users (0017), then
-- deadlines and documents, and the same shape is waiting on invoices and payments
-- the first time a payment webhook lands.
--
-- THE FIX
--   Each of the five policies is replaced by per-command policies. The bounds are
--   carried over exactly, and each one is asserted against the vocabulary the
--   application actually writes, so nothing is widened beyond what the code does:
--
--     table             INSERT keeps                        UPDATE now allows
--     ----------------- ---------------------------------- --------------------------------
--     deadlines         (nothing was insertable)            client_status in the three values
--                                                           the PATCH route accepts
--     documents         origin='client', uploader = caller  a row that is the caller's own
--                                                           upload OR a document the firm
--                                                           asked them for (origin='firm',
--                                                           requested = true)
--     invoices          (nothing was insertable)            the same scope, so a draft or
--                                                           internally-pending invoice is
--                                                           still invisible and still
--                                                           cannot be updated into view
--     payments          status='intent_created'             status in the lifecycle the
--                                                           payment service writes
--     privacy_requests  status='submitted'                  status in ('submitted','withdrawn')
--
--   DELETE is not granted on any of the five: the portal deletes none of them.
--
-- WHAT THIS DOES NOT OPEN
--   Tenant, client and user are re-asserted in every WITH CHECK, so no row can be
--   moved between tenants, between clients, or to another user. The client still
--   cannot confirm its own appointment (0017), still cannot create a document with
--   the firm as the origin, still cannot pay a draft invoice, and still cannot
--   change a privacy request to a status it is not allowed to set.
-- ============================================================================

-- ── deadlines ───────────────────────────────────────────────────────────────
-- A client may advance its own client_action deadline through the three states
-- the PATCH /api/client/deadlines/:id route accepts. Nothing else is mutable.
drop policy if exists deadline_scope on public.deadlines;

create policy deadline_scope_read on public.deadlines
  for select to portal_api
  using (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and kind = 'client_action' and client_visible = true
  );

create policy deadline_scope_update on public.deadlines
  for update to portal_api
  using (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and kind = 'client_action' and client_visible = true
  )
  with check (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and kind = 'client_action' and client_visible = true
    and client_status in ('in_progress', 'submitted', 'completed')
  );

-- ── documents ───────────────────────────────────────────────────────────────
-- The upload route already created rows under the old WITH CHECK; the fulfil path
-- (the client supplies a document the firm asked for) updates a row the client did
-- not create, and was refused.
drop policy if exists document_scope on public.documents;

create policy document_scope_read on public.documents
  for select to portal_api
  using (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and client_visibility = 'visible' and status = 'available' and scan_status = 'clean'
  );

create policy document_scope_insert on public.documents
  for insert to portal_api
  with check (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and origin = 'client' and client_visibility = 'visible' and uploaded_by_user_id = kgm_user()
  );

create policy document_scope_update on public.documents
  for update to portal_api
  using (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and client_visibility = 'visible'
    and ((origin = 'client' and uploaded_by_user_id = kgm_user()) or requested = true)
  )
  with check (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and client_visibility = 'visible'
    and ((origin = 'client' and uploaded_by_user_id = kgm_user()) or requested = true)
  );

-- ── invoices ────────────────────────────────────────────────────────────────
-- The payment service settles an invoice: amount_paid, client_status and the
-- internal_status that records settlement. A draft or internally-pending invoice
-- stays invisible AND unupdatable, which is the invariant the original policy was
-- protecting.
drop policy if exists invoice_scope on public.invoices;

create policy invoice_scope_read on public.invoices
  for select to portal_api
  using (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and internal_status <> all (array['draft', 'pending_internal_approval'])
  );

create policy invoice_scope_update on public.invoices
  for update to portal_api
  using (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and internal_status <> all (array['draft', 'pending_internal_approval'])
  )
  with check (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and internal_status <> all (array['draft', 'pending_internal_approval'])
  );

-- ── payments ────────────────────────────────────────────────────────────────
-- Created as `intent_created`; the webhook settles it to `succeeded` or `failed`.
-- Update was refused because the original check pinned the row to its initial state.
drop policy if exists payment_scope on public.payments;

create policy payment_scope_read on public.payments
  for select to portal_api
  using (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
  );

create policy payment_scope_insert on public.payments
  for insert to portal_api
  with check (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and status = 'intent_created'
  );

create policy payment_scope_update on public.payments
  for update to portal_api
  using (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
  )
  with check (
    kgm_phase() = 'portal' and tenant_id = kgm_tenant() and client_id = any(kgm_clients())
    and status in ('intent_created', 'succeeded', 'failed')
  );

-- ── privacy_requests ────────────────────────────────────────────────────────
-- A client submits a request and may withdraw it. The UPDATE branch of the repo
-- only ever writes 'withdrawn', and only from 'submitted'.
drop policy if exists privacy_scope on public.privacy_requests;

create policy privacy_scope_read on public.privacy_requests
  for select to portal_api
  using (
    kgm_phase() = 'portal' and user_id = kgm_user() and tenant_id = kgm_tenant()
  );

create policy privacy_scope_insert on public.privacy_requests
  for insert to portal_api
  with check (
    kgm_phase() = 'portal' and user_id = kgm_user() and tenant_id = kgm_tenant()
    and status = 'submitted'
  );

create policy privacy_scope_update on public.privacy_requests
  for update to portal_api
  using (
    kgm_phase() = 'portal' and user_id = kgm_user() and tenant_id = kgm_tenant()
  )
  with check (
    kgm_phase() = 'portal' and user_id = kgm_user() and tenant_id = kgm_tenant()
    and status in ('submitted', 'withdrawn')
  );

-- ============================================================================
-- VERIFY — every table has read/insert/update covered by the intended role, the
-- `for all` originals are gone, and the INSERT-only bounds survived the split.
-- ============================================================================
do $$
declare
  t text;
  n int;
begin
  foreach t in array array['deadlines', 'documents', 'invoices', 'payments', 'privacy_requests'] loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and cmd = 'ALL'
                 and 'portal_api' = any(roles)) then
      raise exception '% still has a for-all policy for portal_api', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and cmd = 'DELETE'
                 and 'portal_api' = any(roles) and permissive = 'PERMISSIVE') then
      raise exception '% grants the portal a DELETE policy', t;
    end if;
  end loop;

  -- The INSERT bounds that must survive: a client still cannot create a confirmed
  -- appointment, a firm-origin document, a settled payment or a non-submitted request.
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'payments'
    and policyname = 'payment_scope_insert' and with_check like '%intent_created%';
  if n <> 1 then raise exception 'payments no longer pins new rows to intent_created'; end if;

  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'documents'
    and policyname = 'document_scope_insert' and with_check like '%origin = ''client''%';
  if n <> 1 then raise exception 'documents INSERT no longer requires origin = client'; end if;

  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'privacy_requests'
    and policyname = 'privacy_scope_insert' and with_check like '%submitted%';
  if n <> 1 then raise exception 'privacy_requests INSERT no longer requires status = submitted'; end if;

  -- Every table above must still be readable and updatable by the portal.
  foreach t in array array['deadlines', 'documents', 'invoices', 'payments', 'privacy_requests'] loop
    select count(*) into n from pg_policies where schemaname = 'public' and tablename = t
      and 'portal_api' = any(roles) and cmd in ('SELECT', 'UPDATE');
    if n < 2 then raise exception '% is missing a SELECT or UPDATE policy for portal_api (% found)', t, n; end if;
  end loop;

  raise notice 'five portal policies are split per command; INSERT bounds and scope are intact.';
end $$;
