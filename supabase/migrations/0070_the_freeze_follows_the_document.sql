-- ═══════════════════════════════════════════════════════════════════════════════
-- 0070 · the freeze follows the document
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG. Three guards in 0036 state a rule about ISSUED invoices and enforce it
-- about ANY invoice. Read their own error messages:
--
--     entry_already_billed: this entry is on an ISSUED invoice — correct it with a credit
--     note, not by un-billing it
--
-- and their own conditions:
--
--     if old.status = 'billed' and new.status <> 'billed' then raise …
--     if old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id …
--
-- Neither condition has anything to do with issuance. `old.status = 'billed'` is set the
-- moment a DRAFT is written, and `old.invoice_id` is set in the same statement. So a
-- draft froze its sources exactly as hard as an issued tax document did.
--
-- WHY THAT MATTERS ENOUGH TO FIX IN ITS OWN MIGRATION. P2.3 gave the firm the ability to
-- draft an invoice from recorded work, which means drafts are now written by people at
-- desks rather than by a seed fixture — and drafts are where mistakes are made. The
-- consequences of the over-broad guard, in the order the member would meet them:
--
--     1  the draft is wrong (the wrong hour, a fee that was never agreed);
--     2  it cannot be written off — `writeOffInvoice` requires sent, partly paid or
--        overdue, and the route refuses a draft with a reason that is correct and
--        unhelpful;
--     3  it cannot be deleted — an unissued invoice is deletable, but the delete cascades
--        into `time_entries.invoice_id` and the guard refuses the cascade;
--     4  the hour cannot be released either, because releasing it is the same refusal;
--     5  so the hour is frozen forever, a number in the firm's own series is consumed,
--        and the client's unbilled total silently drops by the value of that hour, with
--        no screen in the product able to explain why.
--
-- Found while verifying the money writes against this database: the live run's own
-- cleanup could not put back what it had taken. A verification that cannot clear up after
-- itself is usually a bad verification — this time it was the schema saying something
-- true about the product, and it is worth the migration.
--
-- WHAT THIS DOES. The condition becomes the question the message always asked. A row is
-- frozen when the invoice holding it is ISSUED, and `invoice_uuid is not null` is the
-- fact that decides that — the same column 0034's immutability triggers read, and the
-- one that only exists once a document has a fiscal identity. A draft has no UUID, is on
-- no server the tax authority can see, and freezes nothing.
--
-- WHAT IT DELIBERATELY DOES NOT DO. It does not weaken the rule for issued documents by
-- one inch: the same three exceptions raise with the same tokens and the same messages
-- once the invoice carries a UUID. It does not add a delete path, and it does not touch
-- the invoice's own immutability guards.

-- ── 1 · THE QUESTION, ASKED IN ONE PLACE ────────────────────────────────────
/*
  A `security definer` helper rather than an inline subquery, for one reason: the guards
  run as whoever issued the statement, and `invoices` is protected by row-level security
  (`invoices_firm_read` and `invoices_read_all` both narrow by matter scope). An inline
  lookup would therefore answer differently for a partner and a finance member on the same
  invoice — a permission-dependent TRIGGER, which is the kind of thing that produces a bug
  nobody can reproduce. This function asks the catalogue question as the definer, with
  `search_path` pinned, and the answer is about the row rather than about the caller.
*/
create or replace function public.invoice_is_issued(p_invoice_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select i.invoice_uuid is not null
                     from public.invoices i
                    where i.id = p_invoice_id), false);
$$;

comment on function public.invoice_is_issued(uuid) is
  'True when the invoice holding this row carries a fiscal identity. The billing freezes in 0036 ask this and nothing else; see 0070.';

-- ── 2 · THE THREE GUARDS, NARROWED TO THE RULE THEY STATE ───────────────────
create or replace function public.guard_billed_entry_immutable()
returns trigger
language plpgsql
as $$
begin
  /* Nothing to freeze while the invoice is a draft: it may still be cancelled, and the
     entry may go back to being billable. */
  if not public.invoice_is_issued(old.invoice_id) then
    return new;
  end if;

  if old.status = 'billed' and new.status <> 'billed' then
    raise exception 'entry_already_billed: this entry is on an issued invoice — correct it with a credit note, not by un-billing it'
      using errcode = 'check_violation';
  end if;
  if old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id then
    raise exception 'entry_invoice_immutable: a billed entry may not be moved to another invoice'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function public.guard_billed_time_immutable()
returns trigger
language plpgsql
as $$
begin
  if not public.invoice_is_issued(old.invoice_id) then
    return new;
  end if;

  if old.status = 'billed' and (
       new.minutes         is distinct from old.minutes
    or new.amount_sar      is distinct from old.amount_sar
    or new.hourly_rate_sar is distinct from old.hourly_rate_sar
    or new.matter_id       is distinct from old.matter_id
    or new.entry_date      is distinct from old.entry_date
    or new.billable        is distinct from old.billable
  ) then
    raise exception 'entry_already_billed: this hour is on an issued invoice — its duration, rate, date, matter and billability are frozen; correct the invoice with a credit note and record new time'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function public.guard_billed_expense_immutable()
returns trigger
language plpgsql
as $$
begin
  if not public.invoice_is_issued(old.invoice_id) then
    return new;
  end if;

  if old.status = 'billed' and (
       new.net_amount_sar   is distinct from old.net_amount_sar
    or new.vat_amount_sar   is distinct from old.vat_amount_sar
    or new.total_amount_sar is distinct from old.total_amount_sar
    or new.matter_id        is distinct from old.matter_id
    or new.category         is distinct from old.category
    or new.reimbursable     is distinct from old.reimbursable
  ) then
    raise exception 'entry_already_billed: this disbursement is on an issued invoice — its amounts, category, matter and rechargeability are frozen; correct the invoice with a credit note'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ── 3 · VERIFY ──────────────────────────────────────────────────────────────
/*
  Asserted by RUNNING the guards, not by reading their source: a draft's entry is released
  and re-billed inside a subtransaction that is rolled back, and the rollback is what keeps
  this migration from touching a single row of the live data.
*/
do $$
declare
  v_tenant uuid;
  v_matter uuid;
  v_client uuid;
  v_staff  uuid;
  v_draft  uuid;
  v_entry  uuid;
  v_issued_entry uuid;
  v_frozen boolean := false;
begin
  /*
    A MATTER THAT MAY BE BILLED, because the probe has to write a BILLABLE hour: the CHECK
    on `time_entries` requires `billable or status = non_billable`, and only a billable
    hour can carry the `billed` status these guards act on. So the probe asks the same
    Rule 12 question the service asks — a signed engagement letter and terms in force —
    and skips the behavioural half with a notice if this database has no such matter. The
    functions are still replaced either way: that, not the probe, is what the migration
    is for.
  */
  select m.tenant_id, m.id, m.client_id, s.id
    into v_tenant, v_matter, v_client, v_staff
    from public.matters m
    join public.staff s on s.tenant_id = m.tenant_id
   where exists (select 1 from public.engagement_letters l
                  where l.matter_id = m.id and l.status = 'signed' and l.superseded_by is null)
     and exists (select 1 from public.matter_billing_terms t
                  where t.matter_id = m.id and t.superseded_by is null
                    and t.effective_from <= current_date
                    and (t.effective_to is null or t.effective_to >= current_date))
   limit 1;

  if v_tenant is null then
    raise notice 'no billable matter in this database — the guards were replaced, not exercised';
    return;
  end if;

  /*
    ── HALF ONE · A DRAFT DOES NOT FREEZE ITS ENTRY ──────────────────────────

    This is the behaviour 0070 introduces, and the reason it exists. The probe cannot
    fabricate an ISSUED invoice — `guard_invoice_fiscal_issue()` rightly refuses a UUID on
    an invoice that names no device and carries no counter — so half two asks the live data
    for a real one instead.
  */
  begin
    insert into public.invoices
      (id, tenant_id, client_id, matter_id, invoice_number, issue_date, due_date, currency,
       subtotal, vat_rate, vat_amount, total, amount_paid, internal_status, created_at, updated_at)
    values
      (gen_random_uuid(), v_tenant, v_client, v_matter, '__0070_DRAFT__', current_date, current_date,
       'SAR', 100, 0.15, 15, 115, 0, 'draft', now(), now())
    returning id into v_draft;

    /* The hour is worth nothing (rate 0) but is BILLABLE, which is what the CHECK and the
       Rule 12 gate require between them for a row in the `billed` status. What is under
       test is the FREEZE, which reads `status` and `invoice_id` and does not care what the
       hour is priced at. */
    insert into public.time_entries
      (id, tenant_id, matter_id, staff_id, entry_date, minutes, narrative, billable,
       hourly_rate_sar, amount_sar, invoice_id, status, created_at, updated_at)
    values
      (gen_random_uuid(), v_tenant, v_matter, v_staff, current_date, 60, '__0070 probe__', true,
       0, 0, v_draft, 'billed', now(), now())
    returning id into v_entry;

    update public.time_entries set status = 'approved', invoice_id = null where id = v_entry;
    if not found then
      raise exception '0070: the draft released no entry — the guards still fire on a document with no fiscal identity';
    end if;

    raise notice '0070 half one: a draft releases its entries';
  exception
    when others then
      begin
        delete from public.time_entries where narrative = '__0070 probe__';
        delete from public.invoices where invoice_number = '__0070_DRAFT__';
      exception when others then null;
      end;
      raise;
  end;

  /*
    ── HALF TWO · AN ISSUED INVOICE STILL DOES ───────────────────────────────

    The rule was narrowed, not lost. This asks the live database for a row that a real
    issued invoice holds and tries to release it; the release must be refused with the same
    token as before. On a database with no issued invoice and no billed entry the half is
    skipped rather than faked — a probe that fabricated one would be asserting against a
    document that has never been through the fiscal guard.
  */
  select te.id into v_issued_entry
    from public.time_entries te
    join public.invoices i on i.id = te.invoice_id
   where te.status = 'billed' and i.invoice_uuid is not null
   limit 1;

  if v_issued_entry is null then
    raise notice '0070 half two: this database holds no billed entry on an issued invoice — the retained rule was not exercised';
  else
    begin
      update public.time_entries set status = 'approved', invoice_id = null where id = v_issued_entry;
    exception when check_violation then
      v_frozen := true;
    end;

    if not v_frozen then
      raise exception '0070: an ISSUED invoice no longer freezes its entries — the rule was lost, not narrowed';
    end if;

    raise notice '0070 half two: an issued invoice still freezes its entries';
  end if;

  -- Unwind half one: this migration must leave no rows behind.
  delete from public.time_entries where id = v_entry;
  delete from public.invoices where id = v_draft;

  if exists (select 1 from public.invoices where invoice_number = '__0070_DRAFT__')
     or exists (select 1 from public.time_entries where narrative = '__0070 probe__') then
    raise exception '0070: the probe left rows behind';
  end if;
end $$;
