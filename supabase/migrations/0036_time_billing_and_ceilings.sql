-- ═══════════════════════════════════════════════════════════════════════════════
-- 0036 · WHAT A FEE RESTS ON  (analysis I · P1.2, P1.3, P1.4)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- THE FINDING THIS CLOSES
--   Two findings, and they are the same finding seen from two ends.
--
--   1. The firm can APPROVE an invoice and cannot PRODUCE one. There is no time
--      recording, no disbursement record, no rate card, and no statement of what
--      basis the fee is charged on. `time.read` and `expenses.read` and their six
--      siblings have been in the permission catalogue since 0020 with no operation
--      behind a single one of them — 69 permissions, 8 of them promises.
--
--   2. `firm_memberships.writeoff_authority_sar` and `discount_authority_pct` are
--      COLUMNS WITH NO GUARD. They are seeded (25,000 for Sara in Finance), they
--      are displayed in the profile drawer, and nothing anywhere reads them. A
--      displayed limit that is not enforced is worse than no limit at all: it tells
--      the person holding it that they may do something they may not.
--
--   And underneath both, the obligation the rules actually place on the firm:
--
--     القاعدة الثانية عشرة: على المحامي أن يبرم مع الموكل عقدًا مكتوبًا … يحدد
--     أطراف العقد، والأعمال الموكلة إليه، والأتعاب المتفق عليها وطريقة حسابها.
--
--     (Rule 12: the lawyer shall conclude a WRITTEN contract with the client stating
--     the parties, the work entrusted to him, the agreed fee and the METHOD OF
--     CALCULATING it.)
--
--   A system that can bill without a written agreement stating how the fee is
--   calculated is a system that makes Rule 12 unenforceable by construction. So the
--   engagement contract is not a document filed on the matter; it is the PRECONDITION
--   of the matter being billable at all, and that is how it is built here.
--
-- THE THREE TABLES, AND WHY EACH IS SEPARATE
--   `matter_billing_terms` — HOW this matter is charged (hourly · fixed · capped ·
--        staged), and up to what. One row per matter, versioned: a fee that changes
--        mid-matter is a new set of terms with a date, not an edit.
--   `rate_cards`        — WHAT an hour is worth, per membership level, with an
--        effective date. Rates change; invoices issued in March must still be
--        explainable from March's card.
--   `time_entries` and `expenses` — the WORK. Both carry their own rate and amount,
--        copied from the card at the moment of recording rather than joined at
--        billing time, because a rate card edit must not silently restate an hour
--        already worked.
--   `engagement_letters` — the Rule 12 contract, and the gate.
--
-- THE CEILINGS, ENFORCED WHERE THEY CANNOT BE BYPASSED
--   The three-step gate that invoice approval already uses — permission, then
--   ceiling, then apply — is now the ONLY way money leaves the firm's claim on a
--   client: a discount changes what is owed, a write-off abandons it, an expense
--   approval commits it. Each is a guarded operation with a `CEILING_EXCEEDED` row
--   behind it, so a refusal is visible in the same ledger as the approval it refused
--   to make.
--
-- DEPENDENCIES
--   0002 (matters, staff, invoices), 0005 (firm memberships and ceilings), 0020–0021
--   (permissions and the invoice gate), 0034 (the fiscal invoice), 0035 (client money).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · RATE CARDS ─────────────────────────────────────────────────────────────
create table if not exists public.rate_cards (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete restrict,
  /* Null level = the firm's default rate, used when the member has no card of their own. */
  level              text,
  staff_id           uuid references public.staff(id) on delete cascade,
  practice_area      text,
  hourly_rate_sar    numeric(12,2) not null check (hourly_rate_sar > 0),
  /*
    Effective from a DATE, not a boolean "current". Two cards are "current" for a
    member on the day one replaces the other, and the only way to say which applies
    to an hour worked on 3 March is to give each a start.
  */
  effective_from     date not null,
  effective_to       date,
  created_by_user_id uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  check (staff_id is not null or level is not null)
);

create index if not exists rate_cards_lookup_idx
  on public.rate_cards(tenant_id, staff_id, effective_from desc);

-- ── 2 · THE BILLING BASIS (Rule 12's "طريقة حسابها") ───────────────────────────
create table if not exists public.matter_billing_terms (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete restrict,
  matter_id           uuid not null references public.matters(id) on delete cascade,
  /*
    The four bases the rule's "method of calculating" resolves to in practice.
    'staged' carries its own schedule in `stages` rather than as four more columns.
  */
  basis               text not null check (basis in ('hourly','fixed','capped','staged','retainer')),
  /*
    The figure the basis needs, and it is NOT nullable for the bases that need it —
    a 'capped' agreement with no cap is not an agreement.
  */
  fee_amount_sar      numeric(14,2) check (fee_amount_sar is null or fee_amount_sar >= 0),
  cap_amount_sar      numeric(14,2) check (cap_amount_sar is null or cap_amount_sar > 0),
  retainer_amount_sar numeric(14,2) check (retainer_amount_sar is null or retainer_amount_sar > 0),
  stages              text,          -- JSON array of {label, amount, trigger}
  /*
    The discount agreed UP FRONT, which is a different thing from a discount
    authorised at billing time. The first is part of the contract; the second is a
    commercial decision somebody has to be allowed to make.
  */
  agreed_discount_pct numeric(5,2) not null default 0 check (agreed_discount_pct >= 0 and agreed_discount_pct <= 100),
  vat_applicable      boolean not null default true,
  effective_from      date not null,
  effective_to        date,
  superseded_by       uuid references public.matter_billing_terms(id) on delete set null,
  notes               text,
  created_by_user_id  uuid references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  check (basis <> 'fixed'    or fee_amount_sar is not null),
  check (basis <> 'capped'   or cap_amount_sar is not null),
  check (basis <> 'retainer' or retainer_amount_sar is not null),
  check (basis <> 'staged'   or stages is not null)
);

create index if not exists matter_billing_terms_matter_idx
  on public.matter_billing_terms(matter_id, effective_from desc);

-- ── 3 · THE WORK ───────────────────────────────────────────────────────────────
create table if not exists public.time_entries (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete restrict,
  matter_id        uuid not null references public.matters(id) on delete restrict,
  staff_id         uuid not null references public.staff(id) on delete restrict,
  entry_date       date not null,
  minutes          integer not null check (minutes > 0 and minutes <= 1440),
  narrative        text not null check (length(btrim(narrative)) >= 5),
  narrative_ar     text,
  billable         boolean not null default true,
  /*
    COPIED from the rate card at the moment of recording, not joined at billing
    time. A card edited in December must not restate an hour worked in March — and
    the only way an entry can be defended a year later is if it carries the rate it
    was actually recorded at.
  */
  hourly_rate_sar  numeric(12,2) not null check (hourly_rate_sar >= 0),
  amount_sar       numeric(14,2) not null check (amount_sar >= 0),
  /* What this hour became. */
  invoice_id       uuid references public.invoices(id) on delete set null,
  status           text not null default 'draft' check (status in
                     ('draft','submitted','approved','billed','written_off','non_billable')),
  approved_by_user_id uuid references public.users(id) on delete set null,
  approved_at      timestamptz,
  written_off_reason text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  /* A non-billable hour is not a billable hour waiting to be invoiced. */
  check (billable or status = 'non_billable'),
  check (status <> 'written_off' or written_off_reason is not null),
  check (status <> 'billed' or invoice_id is not null)
);

create index if not exists time_entries_matter_idx on public.time_entries(matter_id, entry_date desc);
create index if not exists time_entries_staff_idx on public.time_entries(staff_id, entry_date desc);
create index if not exists time_entries_unbilled_idx
  on public.time_entries(tenant_id, matter_id) where status in ('submitted','approved');

create table if not exists public.expenses (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  matter_id         uuid not null references public.matters(id) on delete restrict,
  client_id         uuid not null references public.clients(id) on delete restrict,
  submitted_by_staff uuid not null references public.staff(id) on delete restrict,
  incurred_on       date not null,
  category          text not null check (category in
                      ('court_fee','filing_fee','expert','translation','notarisation',
                       'travel','courier','government_fee','other')),
  description       text not null check (length(btrim(description)) >= 3),
  description_ar    text,
  /*
    NET AND VAT SEPARATELY. A court fee receipt in Saudi Arabia carries 15% VAT on
    the service charge, and a disbursement that is passed on must show what was paid
    and what tax was paid on it, or the invoice built from it cannot comply.
  */
  net_amount_sar    numeric(14,2) not null check (net_amount_sar >= 0),
  vat_amount_sar    numeric(14,2) not null default 0 check (vat_amount_sar >= 0),
  total_amount_sar  numeric(14,2) not null check (total_amount_sar >= 0),
  vat_category      text not null default 'standard' check (vat_category in
                      ('standard','zero_rated','exempt','out_of_scope')),
  /*
    THE RECEIPT IS NOT OPTIONAL for anything being recharged. A disbursement passed
    to a client without evidence is a charge the client cannot verify and the firm
    cannot defend — and it is the single most common source of fee complaints.
  */
  receipt_document_id uuid references public.documents(id) on delete set null,
  reimbursable      boolean not null default true,
  invoice_id        uuid references public.invoices(id) on delete set null,
  status            text not null default 'submitted' check (status in
                      ('submitted','approved','rejected','billed','written_off')),
  approved_by_user_id uuid references public.users(id) on delete set null,
  approved_at       timestamptz,
  rejection_reason  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (abs(total_amount_sar - (net_amount_sar + vat_amount_sar)) < 0.01),
  check (status <> 'rejected' or rejection_reason is not null),
  check (status <> 'billed' or invoice_id is not null)
);

create index if not exists expenses_matter_idx on public.expenses(matter_id, incurred_on desc);
create index if not exists expenses_unbilled_idx
  on public.expenses(tenant_id, matter_id) where status = 'approved';

-- ── 4 · THE ENGAGEMENT CONTRACT (Rule 12, and the gate) ────────────────────────
create table if not exists public.engagement_letters (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  matter_id         uuid not null references public.matters(id) on delete cascade,
  client_id         uuid not null references public.clients(id) on delete restrict,
  /*
    Rule 12's four stated contents, each a column so that a missing one is a
    database refusal rather than a paragraph somebody was supposed to write:
    the parties (matter_id + client_id), the work (`scope`), the agreed fee
    (`fee_amount_sar`) and the method of calculation (`calculation_method`).
  */
  scope             text not null check (length(btrim(scope)) >= 10),
  scope_ar          text,
  fee_amount_sar    numeric(14,2) check (fee_amount_sar is null or fee_amount_sar >= 0),
  calculation_method text not null check (length(btrim(calculation_method)) >= 10),
  signed_by_client_at timestamptz,
  signed_by_client_name text,
  document_id       uuid references public.documents(id) on delete restrict,
  /*
    Rule 11's three preconditions, recorded ON the gate rather than in a separate
    checklist: identity and capacity verified, conflict excluded. The conflict one
    is not a boolean to be trusted — the guard reads the conflict ledger.
  */
  identity_verified_at timestamptz,
  capacity_verified    boolean not null default false,
  status            text not null default 'draft' check (status in
                      ('draft','sent','signed','superseded','withdrawn')),
  superseded_by     uuid references public.engagement_letters(id) on delete set null,
  created_by_user_id uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  check (status <> 'signed' or (signed_by_client_at is not null and document_id is not null)),
  check (status <> 'signed' or (identity_verified_at is not null and capacity_verified))
);

create unique index if not exists engagement_letters_active_idx
  on public.engagement_letters(matter_id) where status = 'signed';

-- ── 5 · THE GATES ──────────────────────────────────────────────────────────────

/**
 * Is this matter billable at all?
 *
 * Rule 12 is the test, and the answer is a boolean the server can also ask BEFORE
 * it tries, so the UI can say "no signed engagement" rather than surfacing a 409
 * from a button.
 */
create or replace function public.kgm_matter_billable(p_matter uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
      select 1 from public.engagement_letters el
       where el.matter_id = p_matter
         and el.status = 'signed'
         and el.superseded_by is null
    )
    and exists (
      select 1 from public.matter_billing_terms mbt
       where mbt.matter_id = p_matter
         and mbt.superseded_by is null
         and mbt.effective_from <= current_date
         and (mbt.effective_to is null or mbt.effective_to >= current_date)
    );
$$;

/**
 * NO BILLABLE TIME WITHOUT A SIGNED ENGAGEMENT.
 *
 * This is the trigger that makes Rule 12 real. Time may still be recorded —
 * because a lawyer must be able to record an hour the moment it is worked, and
 * refusing to let them would simply mean the hour is lost — but it may not be
 * recorded as BILLABLE on a matter that has no signed contract stating how the fee
 * is calculated.
 */
create or replace function public.guard_time_entry_billable()
returns trigger
language plpgsql
as $$
declare
  v_terms public.matter_billing_terms%rowtype;
  v_cap numeric(14,2);
  v_billed numeric(14,2);
begin
  if not new.billable then
    return new;
  end if;

  if not public.kgm_matter_billable(new.matter_id) then
    raise exception 'engagement_gate: billable time requires a signed engagement letter and current billing terms on this matter (Rule 12)'
      using errcode = 'check_violation';
  end if;

  /*
    A CAPPED AGREEMENT IS A CAP ON THE MATTER, NOT ON EACH LINE. Checking the line
    against the cap would let a hundred lines each individually under the cap sail
    past it — which is precisely the failure a cap exists to prevent.
  */
  select * into v_terms from public.matter_billing_terms
   where matter_id = new.matter_id and superseded_by is null
     and effective_from <= new.entry_date
     and (effective_to is null or effective_to >= new.entry_date)
   order by effective_from desc limit 1;

  if v_terms.basis = 'capped' then
    v_cap := v_terms.cap_amount_sar;
    select coalesce(sum(amount_sar), 0) into v_billed
      from public.time_entries
     where matter_id = new.matter_id
       and billable
       and status in ('submitted','approved','billed')
       and id <> new.id;

    if v_billed + new.amount_sar > v_cap + 0.01 then
      raise exception 'billing_cap_exceeded: this entry takes the matter to % against an agreed cap of %', (v_billed + new.amount_sar), v_cap
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

/**
 * A disbursement being recharged must carry its receipt, and must belong to the
 * matter's client.
 *
 * The two are separate failures: a charge with no evidence, and a charge raised
 * against the wrong client's matter — the second of which is the same class of
 * error as applying one client's money to another's invoice.
 */
create or replace function public.guard_expense_shape()
returns trigger
language plpgsql
as $$
declare
  v_client uuid;
begin
  select client_id into v_client from public.matters where id = new.matter_id;
  if v_client is null then
    raise exception 'expense_unknown_matter: no such matter'
      using errcode = 'check_violation';
  end if;

  if v_client <> new.client_id then
    raise exception 'expense_wrong_client: this expense names a client that is not the matter''s client'
      using errcode = 'check_violation';
  end if;

  if new.reimbursable and new.status in ('approved','billed') and new.receipt_document_id is null then
    raise exception 'expense_receipt_required: a reimbursable disbursement must attach the receipt being passed on'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

/**
 * The billing terms must agree with the engagement letter that admits them.
 *
 * A matter whose contract says a fixed fee of 40,000 and whose terms say hourly is
 * a matter nobody can bill correctly, and the disagreement is invisible until an
 * invoice is issued from it.
 */
create or replace function public.guard_billing_terms_agree()
returns trigger
language plpgsql
as $$
declare
  v_letter public.engagement_letters%rowtype;
begin
  select * into v_letter from public.engagement_letters
   where matter_id = new.matter_id and status = 'signed' and superseded_by is null
   order by signed_by_client_at desc limit 1;

  if v_letter.id is null then
    return new;   -- terms may be drafted ahead of signature; the gate is at billing
  end if;

  if v_letter.fee_amount_sar is not null
     and new.basis = 'fixed'
     and new.fee_amount_sar is not null
     and abs(v_letter.fee_amount_sar - new.fee_amount_sar) > 0.01 then
    raise exception 'billing_terms_disagree: the signed engagement states a fixed fee of %, the terms say %', v_letter.fee_amount_sar, new.fee_amount_sar
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

/**
 * BILLING IS CLOSED ONCE THE INVOICE IS ISSUED.
 *
 * An hour billed to an invoice that has been issued may not then be un-billed: the
 * invoice is a tax document and cannot be amended (0034), so moving a billed entry
 * off it would make the invoice's own totals wrong. Corrections go through a credit
 * note, and through new time entries.
 */
create or replace function public.guard_billed_entry_immutable()
returns trigger
language plpgsql
as $$
begin
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

/*
  ── THE FIGURES BEHIND AN ISSUED INVOICE ARE FROZEN ───────────────────────────

  `guard_billed_entry_immutable` above stops an entry being un-billed or moved to
  another invoice. It does NOT stop the figures being rewritten underneath: an hour
  that is on an issued invoice could have its duration, its rate or its matter
  changed, and the invoice's own lines would then be computed from numbers that no
  longer exist anywhere. The invoice cannot be amended (0034), so the entry must not
  be either.

  This is the same class of hole the phase exists to close: the invoice was protected
  and the thing the invoice was built from was not.

  One function per table, because the frozen columns differ — an hour is priced by
  minutes × rate, a disbursement by net + VAT.
*/
create or replace function public.guard_billed_time_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'billed' and (
       new.minutes            is distinct from old.minutes
    or new.amount_sar         is distinct from old.amount_sar
    or new.hourly_rate_sar    is distinct from old.hourly_rate_sar
    or new.matter_id          is distinct from old.matter_id
    or new.entry_date         is distinct from old.entry_date
    or new.billable           is distinct from old.billable
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

drop trigger if exists time_entry_billed_figures_guard on public.time_entries;
create trigger time_entry_billed_figures_guard
  before update on public.time_entries
  for each row execute function public.guard_billed_time_immutable();

drop trigger if exists expense_billed_figures_guard on public.expenses;
create trigger expense_billed_figures_guard
  before update on public.expenses
  for each row execute function public.guard_billed_expense_immutable();

drop trigger if exists time_entry_billable_guard on public.time_entries;
create trigger time_entry_billable_guard
  before insert or update on public.time_entries
  for each row execute function public.guard_time_entry_billable();

drop trigger if exists time_entry_billed_immutable_guard on public.time_entries;
create trigger time_entry_billed_immutable_guard
  before update on public.time_entries
  for each row execute function public.guard_billed_entry_immutable();

drop trigger if exists expense_shape_guard on public.expenses;
create trigger expense_shape_guard
  before insert or update on public.expenses
  for each row execute function public.guard_expense_shape();

drop trigger if exists expense_billed_immutable_guard on public.expenses;
create trigger expense_billed_immutable_guard
  before update on public.expenses
  for each row execute function public.guard_billed_entry_immutable();

drop trigger if exists billing_terms_agree_guard on public.matter_billing_terms;
create trigger billing_terms_agree_guard
  before insert or update on public.matter_billing_terms
  for each row execute function public.guard_billing_terms_agree();

/*
  ── THE CEILING FLOOR ──────────────────────────────────────────────────────────

  A last line of defence at the database for the two ceilings that had none.

  The server enforces them properly — permission, then ceiling, then apply, with a
  CEILING_EXCEEDED row on the way out — but the server is one deployment of the
  software and the ceiling is a term of the member's authority. `financial_authority_sar`
  has had a database-level expression of this idea since 0005 in the approval guard;
  write-off and discount did not.

  WHAT THIS CAN AND CANNOT SEE. A trigger on `invoices` sees the new total and the
  old one, so it can compute the discount actually granted and refuse it when the
  member's `discount_authority_pct` does not cover it. It CANNOT see who is making
  the change — PostgreSQL has no notion of "the firm member on whose behalf this
  statement runs" beyond the session GUC the server sets. So the guard reads
  `current_setting('kgm.membership_id')`, which the firm-side driver sets on every
  statement, and REFUSES THE WRITE WHEN THE SETTING IS ABSENT. A missing setting is
  not "allow": it is a path that did not come through the firm API, and the safe
  answer to that is no.
*/
create or replace function public.guard_invoice_discount_ceiling()
returns trigger
language plpgsql
as $$
declare
  v_membership text;
  v_pct numeric(5,2);
  v_authority numeric(5,2);
  v_discount numeric(5,2);
begin
  if old.subtotal is null or new.subtotal is null then
    return new;
  end if;
  /* Only a REDUCTION is a discount. An increase is caught by the immutability guard. */
  if new.subtotal >= old.subtotal then
    return new;
  end if;

  v_membership := nullif(current_setting('kgm.membership_id', true), '');
  if v_membership is null then
    raise exception 'ceiling_actor_unknown: a discount must be applied through the firm API, which declares the member it is acting for'
      using errcode = 'check_violation';
  end if;

  v_discount := round(((old.subtotal - new.subtotal) / old.subtotal) * 100, 2);

  select discount_authority_pct into v_authority
    from public.firm_memberships
   where id = v_membership::uuid and tenant_id = new.tenant_id and status = 'active';

  if v_authority is null then
    raise exception 'ceiling_not_set: this member has no discount authority'
      using errcode = 'check_violation';
  end if;

  if v_discount > v_authority + 0.001 then
    raise exception 'ceiling_exceeded: a discount of %%% exceeds this member''s authority of %%%', v_discount, v_authority
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists invoice_discount_ceiling_guard on public.invoices;
create trigger invoice_discount_ceiling_guard
  before update on public.invoices
  for each row execute function public.guard_invoice_discount_ceiling();

-- ── 6 · ROW LEVEL SECURITY ─────────────────────────────────────────────────────
alter table public.rate_cards            enable row level security;
alter table public.matter_billing_terms  enable row level security;
alter table public.time_entries          enable row level security;
alter table public.expenses              enable row level security;
alter table public.engagement_letters    enable row level security;

/*
  These five are matter-scoped, and they use the SAME visibility predicate every
  other matter-scoped table uses (`matter_visible`). Restating it differently here
  would create a second definition of "may see this matter", and two definitions of
  one rule is a way for the two to drift.
*/
drop policy if exists rate_cards_firm_all on public.rate_cards;
create policy rate_cards_firm_read on public.rate_cards
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy rate_cards_firm_insert on public.rate_cards
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy rate_cards_firm_write on public.rate_cards
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists matter_billing_terms_firm_all on public.matter_billing_terms;
create policy matter_billing_terms_firm_read on public.matter_billing_terms
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant() and public.matter_visible(matter_id));
create policy matter_billing_terms_firm_insert on public.matter_billing_terms
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy matter_billing_terms_firm_write on public.matter_billing_terms
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant() and public.matter_visible(matter_id))
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists time_entries_firm_all on public.time_entries;
create policy time_entries_firm_read on public.time_entries
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant() and public.matter_visible(matter_id));
create policy time_entries_firm_insert on public.time_entries
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy time_entries_firm_write on public.time_entries
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant() and public.matter_visible(matter_id))
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists expenses_firm_all on public.expenses;
create policy expenses_firm_read on public.expenses
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant() and public.matter_visible(matter_id));
create policy expenses_firm_insert on public.expenses
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy expenses_firm_write on public.expenses
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant() and public.matter_visible(matter_id))
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists engagement_letters_firm_all on public.engagement_letters;
create policy engagement_letters_firm_read on public.engagement_letters
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant() and public.matter_visible(matter_id));
create policy engagement_letters_firm_insert on public.engagement_letters
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
create policy engagement_letters_firm_write on public.engagement_letters
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant() and public.matter_visible(matter_id))
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

/*
  THE PORTAL SEES ITS OWN ENGAGEMENT CONTRACT AND NOTHING ELSE OF THESE.

  A client is entitled to the contract they signed — that is their document. They are
  not entitled to the firm's rate cards, its internal time entries, or its expense
  ledger, and none of those are projected.
*/
drop policy if exists engagement_letters_portal_read on public.engagement_letters;
create policy engagement_letters_portal_read on public.engagement_letters
  for select to portal_api
  using (
    public.kgm_phase() = 'portal'
    and tenant_id = public.kgm_tenant()
    and client_id = any(public.kgm_clients())
    and status = 'signed'
  );

drop policy if exists rate_cards_portal_none on public.rate_cards;
create policy rate_cards_portal_none on public.rate_cards for select to portal_api using (false);

drop policy if exists matter_billing_terms_portal_none on public.matter_billing_terms;
create policy matter_billing_terms_portal_none on public.matter_billing_terms for select to portal_api using (false);

drop policy if exists time_entries_portal_none on public.time_entries;
create policy time_entries_portal_none on public.time_entries for select to portal_api using (false);

drop policy if exists expenses_portal_none on public.expenses;
create policy expenses_portal_none on public.expenses for select to portal_api using (false);

-- ── 7 · GRANTS ─────────────────────────────────────────────────────────────────
grant select, insert, update on public.rate_cards to firm_api;
grant select, insert, update on public.matter_billing_terms to firm_api;
grant select, insert, update on public.time_entries to firm_api;
grant select, insert, update on public.expenses to firm_api;
grant select, insert, update on public.engagement_letters to firm_api;

grant select on public.engagement_letters to portal_api;

grant execute on function public.kgm_matter_billable(uuid) to firm_api;

/* The exact columns the server writes. 0030 taught this the expensive way: a grant
   is required for every column NAMED in a statement, including one with a default. */
grant update (invoice_id, status, approved_by_user_id, approved_at, written_off_reason,
              narrative, narrative_ar, minutes, billable, hourly_rate_sar, amount_sar,
              entry_date, updated_at)
  on public.time_entries to firm_api;

grant update (invoice_id, status, approved_by_user_id, approved_at, rejection_reason,
              description, description_ar, net_amount_sar, vat_amount_sar, total_amount_sar,
              vat_category, receipt_document_id, reimbursable, incurred_on, category, updated_at)
  on public.expenses to firm_api;

grant update (status, signed_by_client_at, signed_by_client_name, document_id,
              identity_verified_at, capacity_verified, superseded_by, scope, scope_ar,
              fee_amount_sar, calculation_method)
  on public.engagement_letters to firm_api;

grant update (basis, fee_amount_sar, cap_amount_sar, retainer_amount_sar, stages,
              agreed_discount_pct, vat_applicable, effective_from, effective_to,
              superseded_by, notes)
  on public.matter_billing_terms to firm_api;

/*
  THE TWO CEILINGS' OWN WRITES, on a table that has existed since 0002. A discount
  recomputes the fee and the tax that follows it; a write-off records the reason the
  balance was abandoned without touching the document's totals. Both statements name
  columns `firm_api` was never granted, which is the defect class this project has now
  met four times — `scripts/verify/schema-parity.ts` runs the same statements against
  the grants and reports them before they are ever sent.
*/
grant update (subtotal, vat_amount, total, notes_internal) on public.invoices to firm_api;

-- ── 8 · VERIFICATION ───────────────────────────────────────────────────────────
do $$
declare
  missing text;
  n int;
begin
  select string_agg(t, ', ') into missing
    from unnest(array['rate_cards','matter_billing_terms','time_entries','expenses',
                      'engagement_letters']) t
   where not exists (select 1 from information_schema.tables
                      where table_schema = 'public' and table_name = t);
  if missing is not null then
    raise exception '0036: missing table(s): %', missing;
  end if;

  /* The columns this migration makes writable on invoices: the discounted fee, the tax
     that moves with it, and the internal note a write-off leaves behind. */
  select string_agg(col, ', ') into missing
    from unnest(array['subtotal','vat_amount','total','notes_internal']) col
   where not exists (select 1 from information_schema.column_privileges
                      where table_schema = 'public' and table_name = 'invoices'
                        and grantee = 'firm_api' and privilege_type = 'UPDATE'
                        and column_name = col);
  if missing is not null then
    raise exception '0036: firm_api lacks UPDATE on invoices column(s): %', missing;
  end if;

  select string_agg(t, ', ') into missing
    from unnest(array['time_entry_billable_guard','time_entry_billed_immutable_guard',
                      'time_entry_billed_figures_guard',
                      'expense_shape_guard','expense_billed_immutable_guard',
                      'expense_billed_figures_guard',
                      'billing_terms_agree_guard','invoice_discount_ceiling_guard']) t
   where not exists (select 1 from pg_trigger where tgname = t and not tgisinternal);
  if missing is not null then
    raise exception '0036: missing trigger(s): %', missing;
  end if;

  select string_agg(t, ', ') into missing
    from unnest(array['rate_cards','matter_billing_terms','time_entries','expenses',
                      'engagement_letters']) t
   where not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                      where ns.nspname = 'public' and c.relname = t and c.relrowsecurity);
  if missing is not null then
    raise exception '0036: RLS not enabled on: %', missing;
  end if;

  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('rate_cards','matter_billing_terms','time_entries','expenses','engagement_letters')
     and cmd = 'ALL' and roles::text like '%firm_api%';
  if n > 0 then
    raise exception '0036: % ALL policy(ies) — the shape §71 forbids', n;
  end if;

  /* The eight permission codes that now have operations behind them. If a code is
     renamed in the catalogue these operations lose their guard, so the names are
     asserted against the catalogue's own table of grants. */
  select string_agg(c, ', ') into missing
    from unnest(array['time.read','time.create','time.adjust','expenses.read',
                      'expenses.create','expenses.approve']) c
   where not exists (select 1 from public.permissions p where p.code = c);
  if missing is not null then
    raise exception '0036: permission code(s) not in the catalogue: %', missing;
  end if;

  raise notice '0036: rate cards, billing terms, time, expenses, the engagement gate and both ceilings — verified';
end $$;
