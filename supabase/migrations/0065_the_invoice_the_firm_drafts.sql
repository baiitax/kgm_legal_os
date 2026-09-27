-- ═══════════════════════════════════════════════════════════════════════════════
--  0065 · THE FIRM DRAFTS ITS OWN INVOICE, AND THE POLICIES NO FILE DECLARED
--
--  WHAT THIS PHASE IS
--
--  The firm could approve an invoice, discount it, write it off, issue it with a
--  ZATCA hash, report it and reconcile its trust ledger — and could not CREATE one.
--  `POST /billing/invoices` did not exist, so every invoice in this system arrived
--  from somewhere else: a seed fixture, or a database client. The gap analysis's
--  money block (24 routes no screen reached) begins here, because an invoice nobody
--  can draft is an invoice nobody can bill.
--
--  ── 1 · THE DRIFT, RECORDED BECAUSE IT WAS FOUND ────────────────────────────
--
--  Investigating what the create path would need, a live probe of `firm_api`'s
--  privileges found INSERT on `invoices` and `invoice_lines`, a
--  `billing_source_key` column on `invoice_lines` that exists for exactly the
--  purpose this phase puts it to, and four policies — `invoices_firm_insert`,
--  `invoices_firm_read`, `invoices_firm_update`, `invoice_lines_firm_insert` —
--  that NO MIGRATION FILE IN THIS REPOSITORY DECLARES.
--
--  So the database was ahead of the repository. The first draft of this header
--  guessed that someone had prepared the schema in a file that was later lost. The
--  ledger says otherwise, and worse: `kgm_migrations` records FOUR migrations
--  applied on 27 September between 08:08 and 09:06 UTC whose names describe exactly
--  this phase —
--
--      0065_the_firm_drafts_the_invoice_it_approves.sql
--      0066_the_invoice_the_firm_drafts_and_the_send_that_releases_it.sql
--      0067_fixed_and_staged_fee_invoice_sources.sql
--      0067_the_level_a_member_is_priced_at.sql
--
--  — and a fifth, `0065_the_firm_drafts_its_own_invoice.sql`, applied at 08:59. Not
--  one of those files is in this repository, in its git history, or anywhere on
--  this machine. A parallel line of work advanced the live database by a whole
--  phase and left no artifacts behind.
--
--  That is a reproducibility defect and it is worse than the missing privilege would
--  have been: a database restored from `supabase/migrations` alone would not have
--  those policies, the invoice-drafting column, or its unique index, and the firm's
--  invoice writes would fail with a violation no file explains. It is also a
--  COLLISION — the numbering it used is the numbering this phase needs.
--
--  This file does not attempt to reconstruct those four. It states the end state they
--  and this phase agree on, so that a rebuilt database reaches it: the policies, the
--  privileges, and the negative constraints below. The divergence itself is reported
--  in the phase report and in the ledger, because a database that has been changed by
--  something nobody can read is a fact the next reader needs in writing.
--
--  This file makes the repository the truth again: it restates all four policies
--  (plus `firm_invoice_scope`, which was declared in 0006 and is restated here to
--  confirm it still says what 0006 meant) and asserts them. From now on a rebuilt
--  database reaches the same state as the live one.
--
--  ── 2 · ONE IMPROVEMENT MADE WHILE RESTATING ───────────────────────────────
--
--  `invoices_firm_insert` as it existed allowed a firm to insert an invoice in ANY
--  internal state — including `sent`, with a `client_status` that the guard happily
--  accepts as derived. Such a row would appear in the client's portal WITHOUT ever
--  having been approved: the approval workflow (P1) would be bypassed by a single
--  INSERT, and the portal's own policy would not stop it, because the portal policy
--  hides only `draft` and `pending_internal_approval`.
--
--  An invoice is BORN UNAPPROVED. That is not a business rule that belongs in the
--  service layer alone; it is the boundary of what a create may express, so it is
--  in the WITH CHECK.
--
--  ── 3 · WHAT GENUINELY DID NOT EXIST: FIRM PAYMENTS ─────────────────────────
--
--  `payments` had grants for `portal_api` (online intents) and `payments_service`
--  (webhook settlement) and NONE for `firm_api`: no SELECT, no INSERT, no policy.
--  A firm could not record a bank transfer it had received, so `billing.record_payment`
--  — a permission code granted to three roles since P0.6 — was enforced only on the
--  TRUST path (`/trust/ledgers/:clientId/entries`), and the invoice's own
--  `amount_paid` could only move by applying trust money.
--
--  That is backwards for how a Saudi practice works: the client pays by transfer,
--  the receipt is recorded, and if the money is held for the client it goes to the
--  trust ledger first. Both directions are needed and only one existed.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · THE POLICIES THE REPOSITORY WAS MISSING ─────────────────────────────
/*
  Dropped and recreated rather than created-if-absent: PostgreSQL has no
  `create policy if not exists`, and `drop policy if exists` is the idempotent form
  this repository already uses (0061 does the same for documents).
*/

/* The firm reads its own tenant's invoices, on matters it can see. */
drop policy if exists invoices_firm_read on public.invoices;
create policy invoices_firm_read on public.invoices
  for select
  to firm_api
  using (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and public.matter_visible(matter_id)
  );

/*
  DRAFTING. An invoice is born unapproved — see §2 of the header. `matter_id` is
  required because an invoice with no matter is an invoice no member's scope rule can
  evaluate, and `matter_visible(NULL)` is not true.
*/
drop policy if exists invoices_firm_insert on public.invoices;
create policy invoices_firm_insert on public.invoices
  for insert
  to firm_api
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and matter_visible(matter_id)
    and internal_status in ('draft', 'pending_internal_approval')
  );

/* Approve, send, discount, write off, issue — all updates. */
drop policy if exists invoices_firm_update on public.invoices;
create policy invoices_firm_update on public.invoices
  for update
  to firm_api
  using (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and public.matter_visible(matter_id)
  )
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and public.matter_visible(matter_id)
  );

/*
  THE LINES OF AN INVOICE THE FIRM MAY WRITE TO. The rule is about the PARENT, not
  the line: a line is readable and writable exactly when its invoice is. `invoice_lines`
  has no tenant column of its own, so `matter_visible` is reached through the join —
  which is also why there is no way to write a line onto another tenant's invoice.
*/
drop policy if exists invoice_lines_firm_insert on public.invoice_lines;
create policy invoice_lines_firm_insert on public.invoice_lines
  for insert
  to firm_api
  with check (
    public.kgm_is_firm()
    and exists (
      select 1 from public.invoices i
       where i.id = invoice_id
         and i.tenant_id = public.kgm_tenant()
         and public.matter_visible(i.matter_id)
    )
  );

/*
  RESTATED FROM 0006, UNCHANGED. Its `with check (false)` is deliberate and is not a
  mistake to fix: this policy is the READ policy for the ALL command, and the
  permissive INSERT policy above is what grants the write. Flipping the check to true
  would silently widen every command at once.
*/
drop policy if exists firm_invoice_scope on public.invoice_lines;
create policy firm_invoice_scope on public.invoice_lines
  to firm_api
  using (
    public.kgm_is_firm()
    and exists (
      select 1 from public.invoices i
       where i.id = invoice_lines.invoice_id
         and i.tenant_id = public.kgm_tenant()
         and public.matter_visible(i.matter_id)
    )
  )
  with check (false);

-- ── 2 · FIRM PAYMENTS ───────────────────────────────────────────────────────
/*
  A RECEIPT THE FIRM RECORDED, not a payment a client initiated.

  The provider list is the boundary: `mada`, `apple_pay`, `visa` and `mastercard`
  arrive from a payment gateway and a firm that writes one is forging a gateway's
  record. What a firm records is money that arrived by transfer, by SADAD, or across
  a counter — and only once it is SETTLED, so a firm row is never an intent.
*/
grant select on public.payments to firm_api;
grant insert (
  id, tenant_id, invoice_id, client_id, provider, provider_intent_id,
  amount, currency, status, receipt_number, completed_at, created_at
) on public.payments to firm_api;

drop policy if exists payments_firm_read on public.payments;
create policy payments_firm_read on public.payments
  for select
  to firm_api
  using (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and exists (
      select 1 from public.invoices i
       where i.id = invoice_id
         and i.tenant_id = public.kgm_tenant()
         and public.matter_visible(i.matter_id)
    )
  );

drop policy if exists payments_firm_insert on public.payments;
create policy payments_firm_insert on public.payments
  for insert
  to firm_api
  with check (
    public.kgm_is_firm()
    and tenant_id = public.kgm_tenant()
    and provider in ('bank_transfer', 'sadad', 'manual')
    and status = 'succeeded'
    and exists (
      select 1 from public.invoices i
       where i.id = invoice_id
         and i.tenant_id = public.kgm_tenant()
         and public.matter_visible(i.matter_id)
    )
  );

-- ── 3 · VERIFY ──────────────────────────────────────────────────────────────
/*
  The union of what the create, send and payment paths write, checked as one list
  against the live catalog. Asserting only what this migration adds would let the
  next omission through in exactly the way the policies above arrived — so the check
  is written against the STATEMENTS, in the same spirit as 0038.
*/
do $$
declare
  missing text := '';
  n integer;
begin
  -- 3a · the INSERT path on invoices names these columns.
  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'invoices'
     and grantee = 'firm_api' and privilege_type = 'INSERT'
     and column_name in ('tenant_id', 'client_id', 'matter_id', 'invoice_number',
                         'issue_date', 'due_date', 'currency', 'subtotal', 'vat_rate',
                         'vat_amount', 'total', 'amount_paid', 'internal_status',
                         'client_status', 'notes_internal');
  if n <> 15 then
    missing := missing || format('invoices INSERT covers %s of 15 columns; ', n);
  end if;

  -- 3b · the line INSERT path.
  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'invoice_lines'
     and grantee = 'firm_api' and privilege_type = 'INSERT'
     and column_name in ('id', 'invoice_id', 'position', 'description', 'description_ar',
                         'quantity', 'unit_price', 'amount', 'discount_amount',
                         'vat_category', 'vat_rate', 'vat_amount', 'billing_source_key');
  if n <> 13 then
    missing := missing || format('invoice_lines INSERT covers %s of 13 columns; ', n);
  end if;

  -- 3c · the payment path.
  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'payments'
     and grantee = 'firm_api' and privilege_type in ('INSERT', 'SELECT');
  if n < 12 then
    missing := missing || format('payments covers %s of 12 privileges; ', n);
  end if;

  -- 3d · the policies the create path depends on, by name and command.
  select count(*) into n
    from pg_policies
   where schemaname = 'public'
     and 'firm_api' = any(roles)
     and (tablename, policyname) in (
       ('invoices', 'invoices_firm_insert'), ('invoices', 'invoices_firm_read'),
       ('invoices', 'invoices_firm_update'), ('invoice_lines', 'invoice_lines_firm_insert'),
       ('invoice_lines', 'firm_invoice_scope'),
       ('payments', 'payments_firm_insert'), ('payments', 'payments_firm_read'));
  if n <> 7 then
    missing := missing || format('%s of 7 policies present; ', n);
  end if;

  /*
    3e · AN INVOICE MAY NOT BE BORN APPROVED. Asserted as text because the rule lives
    inside a WITH CHECK expression, and the assertion that matters is that the clause
    is still there at all: a future migration that recreates this policy without it
    would restore the hole §2 of the header describes, and nothing else would notice.
  */
  select count(*) into n
    from pg_policies
   where schemaname = 'public' and tablename = 'invoices'
     and policyname = 'invoices_firm_insert'
     and with_check like '%internal_status%';
  if n <> 1 then
    missing := missing || 'invoices_firm_insert does not constrain the birth state; ';
  end if;

  if missing <> '' then
    raise exception '0065 verification failed: %', missing;
  end if;
end $$;
