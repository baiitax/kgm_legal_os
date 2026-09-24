-- ============================================================================
-- KGM LEGAL OS · 0024 — THE INVOICE APPROVAL WRITE, GRANTED AS A WHOLE
-- ============================================================================
-- `POST /api/firm/billing/invoices/:id/approve` failed in three layers, in
-- sequence, and each layer needed its own fix:
--
--   1 · permission denied for table invoices          <- 0020's class: the grant
--   2 · client_status must be derived from internal_status, not set directly
--                                                     <- the trigger, fixed in the
--                                                        application (firm-repo.ts)
--   3 · permission denied for table invoices          <- HERE, again, but a
--                                                        different column
--
-- Layer 3 is the one this file closes, and it is the reason the earlier fix had
-- to come first: `guard_invoice_state` refused the statement until the
-- application also wrote `client_status`, and the moment it did, the statement
-- needed a column grant that no reconciler had recorded — because before that
-- change nothing wrote `client_status` from the firm side.
--
-- The statement, as it now stands (firm-repo.ts · approveInvoice):
--
--   update invoices
--      set internal_status = 'approved',
--          client_status   = case ... end,      -- NEW — this file
--          approved_by_staff = ?, approved_at = ?, updated_at = ?
--    where id = ? and tenant_id = ? and internal_status in (...) and approved_at is null
--
-- `firm_api` already held UPDATE on internal_status, approved_by_staff,
-- approved_at and updated_at. `client_status` was missing. It is granted here —
-- and NOT to `portal_api`, which already has it for the client's own settlement
-- path, and NOT `amount_paid` to `firm_api`, which the approval path never
-- writes: a firm user approving an invoice must not be able to record a payment.
--
-- WHY THE RECONCILERS KEEP MISSING THIS
--   supabase/ops/reconcile_column_grants.mjs diffs column NAMES in `insert into
--   t (cols)` and `update t set cols` against `information_schema`. It cannot see
--   a column that the statement gains as a consequence of something else — here,
--   a database trigger dictating what the application must write. A cheap
--   improvement, for the next pass: run the application's own write statements
--   against a transaction that is rolled back, rather than reading their text.
-- ============================================================================

grant update (client_status) on public.invoices to firm_api;

-- ============================================================================
-- VERIFY — both the firm approval write and the client settlement write are
-- writable end to end, column by column, by the role that performs each.
-- ============================================================================
do $$
declare
  r record;
  missing text[] := '{}';
begin
  for r in
    select * from (values
      -- firm approval (firm-repo.ts · approveInvoice)
      ('firm_api',   'internal_status'),
      ('firm_api',   'client_status'),
      ('firm_api',   'approved_by_staff'),
      ('firm_api',   'approved_at'),
      ('firm_api',   'updated_at'),
      -- client settlement (payment-service.ts · applyWebhook)
      ('portal_api', 'amount_paid'),
      ('portal_api', 'internal_status'),
      ('portal_api', 'client_status'),
      ('portal_api', 'updated_at')
    ) as t(role_name, column_name)
  loop
    if not has_column_privilege(r.role_name, 'public.invoices', r.column_name, 'UPDATE') then
      missing := missing || (r.role_name || ' UPDATE invoices.' || r.column_name);
    end if;
  end loop;

  -- The approval path must NOT be able to record money.
  if has_column_privilege('firm_api', 'public.invoices', 'amount_paid', 'UPDATE') then
    raise exception 'firm_api must not be able to write invoices.amount_paid from the approval path';
  end if;

  if array_length(missing, 1) > 0 then
    raise exception 'invoice write grants missing: %', array_to_string(missing, ', ');
  end if;

  raise notice 'both invoice write paths are granted; approval cannot record a payment.';
end $$;
