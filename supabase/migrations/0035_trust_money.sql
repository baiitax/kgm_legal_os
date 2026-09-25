-- ═══════════════════════════════════════════════════════════════════════════════
-- 0035 · CLIENT MONEY  (أمانات · analysis I · P1.1)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- THE FINDING THIS CLOSES
--   The system can take money from a client in exactly one way: it can send them an
--   invoice and they can pay it. There is no way to record that a client has put
--   money ON ACCOUNT — a retainer paid before any invoice exists, an advance against
--   disbursements, a settlement sum received on the client's behalf and held pending
--   distribution. For a Saudi law firm that is not an edge case; أمانات is a normal
--   and frequent part of practice, and it is the part where a firm gets into
--   disciplinary trouble rather than billing trouble.
--
--   THE RULE, STATED PLAINLY: money a client places with the firm IS NOT THE FIRM'S
--   MONEY. It is a liability owed back to that client until and unless it is applied
--   to a fee the client actually owes. Two consequences follow, and both are
--   enforced here rather than described in a policy document:
--
--     1. One client's money may never be used for another client's costs. So a
--        client ledger balance may never go below zero, and that is a database
--        refusal, not a report somebody is supposed to read.
--     2. Client money may only be applied to a fee against an ISSUED INVOICE. Not
--        an estimate, not a draft, not "we know it is coming" — an invoice that
--        exists and has been issued to that client.
--
-- THE SHAPE OF THE MODEL
--   `client_ledgers` — one running account per client per currency.
--   `ledger_entries`  — the movements, APPEND-ONLY, one row per movement, forever.
--   `ledger_reconciliations` — the periodic three-way check of the total against the
--                       bank, with the discrepancy recorded rather than resolved away.
--
-- THE BALANCE IS NOT STORED
--   There is no `balance` column, deliberately. A stored balance is a second source
--   of truth that can disagree with the entries, and the disagreement is invisible
--   until the reconciliation, which is far too late. The balance is DERIVED from the
--   entries by `kgm_ledger_balance()`, so "what did we hold for this client on
--   31 December" is a query that cannot lie about the ledger it is summarising.
--
-- WHY CORRECTIONS ARE REVERSALS AND NOT EDITS
--   `ledger_entries` refuses UPDATE and DELETE outright. A mistaken entry is
--   corrected by posting a `reversal` that names it, followed by the right entry.
--   That is not pedantry: a client-money ledger is the record a regulator asks for,
--   and a record that can be edited in place is worthless in exactly the situation
--   where it is needed — after someone has already got the money wrong.
--
-- WHY THERE IS NO TRANSFER BETWEEN CLIENT LEDGERS
--   Moving a receipt from the wrong client's ledger to the right one looks like a
--   transfer and is really a correction. Left as an entry type it would need a
--   paired row in the other ledger, deferred-pairing constraints, and a way to
--   handle half-completed transfers — three complications in the one place in the
--   schema where complexity costs money that is not ours. Instead: reverse the
--   mistaken receipt where it is, and post the correct receipt where it belongs.
--   Two entries, both auditable, no pairing to get wrong.
--
-- DEPENDENCIES
--   0002 (clients, invoices, documents), 0009–0013 (roles and grants), 0021
--   (invoice state machine), 0034 (an invoice is issued before it can be applied to).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · THE LEDGER ─────────────────────────────────────────────────────────────
create table if not exists public.client_ledgers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete restrict,
  client_id     uuid not null references public.clients(id) on delete restrict,
  currency      text not null default 'SAR' check (currency in ('SAR')),
  /*
    `frozen` is not the same as `closed`. A closed ledger is one where the client
    relationship has ended and the balance is nil; a frozen ledger is one where
    something is wrong — an unreconciled difference, a dispute, an AML hold — and no
    further movement may be recorded until a human lifts it. Freezing has to be
    available without closing, because closing would imply the balance is settled.
  */
  status        text not null default 'open' check (status in ('open','frozen','closed')),
  frozen_reason text,
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, client_id, currency),
  check (status <> 'frozen' or frozen_reason is not null),
  check (status <> 'closed' or closed_at is not null)
);

create index if not exists client_ledgers_tenant_idx on public.client_ledgers(tenant_id, status);

-- ── 2 · THE MOVEMENTS ──────────────────────────────────────────────────────────
create table if not exists public.ledger_entries (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete restrict,
  ledger_id              uuid not null references public.client_ledgers(id) on delete restrict,
  /*
    Denormalised from the ledger on purpose: every RLS policy and every balance query
    is about the CLIENT, and a policy that has to join to learn who the money belongs
    to is a policy that can be got wrong in a way that leaks money data.
  */
  client_id              uuid not null references public.clients(id) on delete restrict,
  entry_type             text not null check (entry_type in
                           ('receipt','application_to_fee','disbursement','refund',
                            'bank_charge','interest','reversal')),
  /*
    `credit` puts money INTO the client's account (the firm's liability grows).
    `debit` takes it out. The sign lives in this column rather than in a signed
    amount, because a negative amount plus a direction is two places to disagree.
  */
  direction              text not null check (direction in ('credit','debit')),
  amount                 numeric(14,2) not null check (amount > 0),
  currency               text not null default 'SAR' check (currency in ('SAR')),

  /* Required for application_to_fee; refused on every other type. */
  invoice_id             uuid references public.invoices(id) on delete restrict,
  matter_id              uuid references public.matters(id) on delete restrict,

  description            text not null check (length(btrim(description)) >= 3),
  /* Bank reference, transfer reference, receipt number — the string that ties this
     row to a line on a statement. Free text because every bank formats it differently. */
  reference              text,
  /* What evidences the movement: a deposit slip, a bank statement page, a signed
     refund acknowledgement. A movement with no document behind it is a movement
     nobody can prove happened. */
  evidence_document_id   uuid references public.documents(id) on delete set null,

  /* For a reversal: the entry being reversed. Required there, refused elsewhere. */
  reverses_entry_id      uuid references public.ledger_entries(id) on delete restrict,
  reversal_reason        text,

  entry_at               timestamptz not null,
  recorded_by_user_id    uuid references public.users(id) on delete set null,
  recorded_at            timestamptz not null default now(),

  check (entry_type <> 'application_to_fee' or invoice_id is not null),
  check (entry_type = 'application_to_fee' or invoice_id is null),
  check (entry_type <> 'reversal' or (reverses_entry_id is not null and reversal_reason is not null)),
  check (entry_type = 'reversal' or reverses_entry_id is null)
);

create index if not exists ledger_entries_ledger_idx on public.ledger_entries(ledger_id, entry_at, recorded_at);
create index if not exists ledger_entries_client_idx on public.ledger_entries(tenant_id, client_id, entry_at desc);
create index if not exists ledger_entries_invoice_idx on public.ledger_entries(invoice_id) where invoice_id is not null;

-- ── 3 · THE BALANCE, DERIVED ───────────────────────────────────────────────────
/**
 * What the firm holds for a client, as of a moment.
 *
 * Positive means the firm holds the client's money. It can never legitimately be
 * negative — that would mean the firm has spent a client's money — and the guard
 * below refuses any entry that would take it there.
 *
 * `p_as_of` exists because the question asked in a review is almost never "what is
 * the balance now" but "what was it on the date of the payment we are arguing
 * about". A balance function that can only answer the first question is a balance
 * function that cannot answer the one that matters.
 */
create or replace function public.kgm_ledger_balance(p_ledger uuid, p_as_of timestamptz default null)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0)::numeric(14,2)
    from public.ledger_entries
   where ledger_id = p_ledger
     and (p_as_of is null or entry_at <= p_as_of);
$$;

create or replace function public.kgm_client_trust_total(p_tenant uuid, p_as_of timestamptz default null)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0)::numeric(14,2)
    from public.ledger_entries
   where tenant_id = p_tenant
     and (p_as_of is null or entry_at <= p_as_of);
$$;

-- ── 4 · THE GATES ──────────────────────────────────────────────────────────────
/**
 * A client-money ledger is append-only. Full stop.
 *
 * The trigger refuses UPDATE and DELETE with no escape hatch, no `system` role, no
 * maintenance window. If an entry is wrong, the ledger has a way to say so — post a
 * reversal — and that way leaves both the mistake and the correction visible, which
 * is the entire point of keeping the record.
 */
create or replace function public.guard_ledger_entry_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ledger_is_append_only: a client-money entry may not be % — post a reversal instead',
    lower(tg_op)
    using errcode = 'check_violation';
end;
$$;

/**
 * The shape of a movement, and the two movements that need a reason.
 *
 * Direction is not free: it is determined by the type. That removes the single most
 * expensive class of client-accounting error — a debit recorded as a credit, which
 * turns a payment to a client into a receipt from them and doubles the discrepancy
 * instead of causing it.
 */
create or replace function public.guard_ledger_entry_shape()
returns trigger
language plpgsql
as $$
declare
  v_ledger public.client_ledgers%rowtype;
  v_reversed public.ledger_entries%rowtype;
  v_expected text;
begin
  select * into v_ledger from public.client_ledgers where id = new.ledger_id;
  if v_ledger.id is null then
    raise exception 'ledger_not_found: no such client ledger'
      using errcode = 'check_violation';
  end if;

  if v_ledger.tenant_id <> new.tenant_id or v_ledger.client_id <> new.client_id then
    raise exception 'ledger_mismatch: the entry names a tenant or client that is not this ledger''s'
      using errcode = 'check_violation';
  end if;

  if v_ledger.currency <> new.currency then
    raise exception 'ledger_currency_mismatch: this ledger is %, the entry is %', v_ledger.currency, new.currency
      using errcode = 'check_violation';
  end if;

  if v_ledger.status <> 'open' then
    raise exception 'ledger_not_open: this ledger is % — %', v_ledger.status,
      coalesce(v_ledger.frozen_reason, 'no further movement may be recorded')
      using errcode = 'check_violation';
  end if;

  /* Direction is a function of the type; a reversal takes the opposite of its target. */
  if new.entry_type = 'reversal' then
    select * into v_reversed from public.ledger_entries where id = new.reverses_entry_id;
    if v_reversed.id is null then
      raise exception 'reversal_target_missing: a reversal must name the entry it reverses'
        using errcode = 'check_violation';
    end if;
    if v_reversed.ledger_id <> new.ledger_id then
      raise exception 'reversal_cross_ledger: a reversal must stay inside the ledger it corrects'
        using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.ledger_entries e where e.reverses_entry_id = new.reverses_entry_id) then
      raise exception 'already_reversed: that entry has already been reversed — a second reversal would double the correction'
        using errcode = 'check_violation';
    end if;
    v_expected := case when v_reversed.direction = 'credit' then 'debit' else 'credit' end;
    if new.direction <> v_expected then
      raise exception 'reversal_direction_wrong: reversing a % entry must be a %', v_reversed.direction, v_expected
        using errcode = 'check_violation';
    end if;
    if abs(new.amount - v_reversed.amount) > 0.01 then
      raise exception 'reversal_amount_wrong: a reversal reverses the whole entry (%) — for a part correction, reverse in full and post the correct entry', v_reversed.amount
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  v_expected := case when new.entry_type in ('receipt','interest') then 'credit' else 'debit' end;
  if new.direction <> v_expected then
    raise exception 'ledger_direction_wrong: a % is a % to the client''s account', new.entry_type, v_expected
      using errcode = 'check_violation';
  end if;

  /*
    Everything that takes money OUT of a client's account must say what it was for,
    and the two that leave the firm entirely must be evidenced.
  */
  if new.entry_type in ('disbursement','refund','bank_charge') and new.evidence_document_id is null then
    raise exception 'ledger_evidence_required: a % must attach the document that proves it (statement, receipt, signed acknowledgement)', new.entry_type
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

/**
 * Client money may only be applied to a fee against an ISSUED invoice, and never
 * beyond what that invoice actually owes.
 *
 * Four conditions, and each one is a way real firms have got this wrong:
 *
 *   1. the invoice must be issued — a draft is not a debt. `internal_status` past
 *      approval is the test, and 0034 refuses to send one that is not cleared, so
 *      "issued" here means "the client has been shown a valid tax invoice".
 *   2. it must belong to THE SAME CLIENT and the same tenant. Applying money held
 *      for one client against another client's invoice is the single most serious
 *      thing a client account can do.
 *   3. the application may not exceed the invoice's outstanding balance.
 *   4. the CUMULATIVE applications from client money may not exceed it either —
 *      two applications of 60 against an invoice of 100 must fail on the second.
 */
create or replace function public.guard_ledger_application()
returns trigger
language plpgsql
as $$
declare
  v_inv public.invoices%rowtype;
  v_applied numeric(14,2);
  v_outstanding numeric(14,2);
begin
  if new.entry_type <> 'application_to_fee' then
    return new;
  end if;

  select * into v_inv from public.invoices where id = new.invoice_id;
  if v_inv.id is null then
    raise exception 'invoice_not_found: no such invoice'
      using errcode = 'check_violation';
  end if;

  if v_inv.tenant_id <> new.tenant_id then
    raise exception 'invoice_other_tenant: that invoice belongs to another firm'
      using errcode = 'check_violation';
  end if;

  if v_inv.client_id <> new.client_id then
    raise exception 'trust_application_wrong_client: money held for one client may not be applied to another client''s invoice'
      using errcode = 'check_violation';
  end if;

  if v_inv.internal_status in ('draft','pending_internal_approval','cancelled','written_off') then
    raise exception 'invoice_not_issued: client money may only be applied to an issued invoice — this one is %', v_inv.internal_status
      using errcode = 'check_violation';
  end if;

  if v_inv.fiscal_status is null or v_inv.fiscal_status in ('rejected','failed') then
    raise exception 'invoice_not_fiscally_valid: client money may only be applied to an invoice that is a valid tax invoice (fiscal status %)', coalesce(v_inv.fiscal_status, 'not_issued')
      using errcode = 'check_violation';
  end if;

  v_outstanding := round(v_inv.total - v_inv.amount_paid, 2);
  if v_outstanding <= 0 then
    raise exception 'invoice_already_settled: this invoice has no outstanding balance'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount), 0) into v_applied
    from public.ledger_entries
   where invoice_id = new.invoice_id
     and entry_type = 'application_to_fee';

  if v_applied + new.amount > v_outstanding + 0.01 then
    raise exception 'trust_application_exceeds_invoice: % already applied from client money, % now, against an outstanding balance of %',
      v_applied, new.amount, v_outstanding
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

/**
 * A client's balance may never go below zero.
 *
 * THE MOST IMPORTANT TRIGGER IN THIS MIGRATION. A negative balance means the firm
 * has spent money that belonged to a client — either that client's own money or,
 * once the ledgers are added up, somebody else's. It is the failure that ends
 * practices rather than merely damaging them.
 *
 * The ledger row is locked first. Two concurrent debits that would each leave the
 * balance positive but together take it negative must not both succeed, and a
 * read-then-write without the lock is exactly how that pair gets through.
 */
create or replace function public.guard_ledger_no_overdraft()
returns trigger
language plpgsql
as $$
declare
  v_balance numeric(14,2);
  v_signed numeric(14,2);
begin
  if new.entry_type = 'reversal' then
    -- A reversal increases or decreases the balance according to the entry it
    -- undoes; the direction has already been checked to be the opposite.
    v_signed := case when new.direction = 'credit' then new.amount else -new.amount end;
  else
    v_signed := case when new.direction = 'credit' then new.amount else -new.amount end;
  end if;

  /* Serialise concurrent movements on this ledger. */
  perform 1 from public.client_ledgers where id = new.ledger_id for update;

  select public.kgm_ledger_balance(new.ledger_id) into v_balance;

  if v_balance + v_signed < -0.01 then
    raise exception 'client_funds_overdrawn: this entry would take the client''s trust balance to % — client money may never be spent on the firm''s behalf', to_char(v_balance + v_signed, 'FM999999999990.00')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists ledger_entry_append_only_guard on public.ledger_entries;
create trigger ledger_entry_append_only_guard
  before update or delete on public.ledger_entries
  for each row execute function public.guard_ledger_entry_append_only();

drop trigger if exists ledger_entry_shape_guard on public.ledger_entries;
create trigger ledger_entry_shape_guard
  before insert on public.ledger_entries
  for each row execute function public.guard_ledger_entry_shape();

drop trigger if exists ledger_application_guard on public.ledger_entries;
create trigger ledger_application_guard
  before insert on public.ledger_entries
  for each row execute function public.guard_ledger_application();

drop trigger if exists ledger_no_overdraft_guard on public.ledger_entries;
create trigger ledger_no_overdraft_guard
  before insert on public.ledger_entries
  for each row execute function public.guard_ledger_no_overdraft();

-- ── 5 · RECONCILIATION ─────────────────────────────────────────────────────────
/*
  THREE-WAY. The totals that must agree are:
    · what the clients' ledgers say we hold   → `ledger_total`
    · what the client bank account says       → `bank_balance`
    · the difference, which must be zero or explained → `difference` + `notes`
  A reconciliation that only compares two of them can be satisfied by a firm that
  has a single unrecorded entry, which is the usual way a client account drifts.

  `difference` is a generated column so it cannot be typed in wrongly, and a CHECK
  makes `balanced` mean what it says: status may only be 'balanced' when the
  difference is nil.
*/
create table if not exists public.ledger_reconciliations (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete restrict,
  currency                 text not null default 'SAR' check (currency in ('SAR')),
  as_of                    timestamptz not null,
  ledger_total             numeric(14,2) not null,
  bank_balance             numeric(14,2) not null,
  difference               numeric(14,2) not null,
  bank_statement_reference text,
  bank_statement_document_id uuid references public.documents(id) on delete set null,
  clients_with_balance     integer not null default 0 check (clients_with_balance >= 0),
  status                   text not null check (status in ('balanced','difference','investigated')),
  notes                    text,
  performed_by_user_id     uuid references public.users(id) on delete set null,
  performed_at             timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  unique (tenant_id, as_of, currency),
  /* `balanced` is a factual claim and the difference is the fact. */
  check (status <> 'balanced' or abs(difference) < 0.01),
  /* A difference with no explanation is a finding, not a reconciliation. */
  check (status = 'balanced' or (notes is not null and length(btrim(notes)) >= 10)),
  /* The difference is the arithmetic, not an input. */
  check (abs(difference - (ledger_total - bank_balance)) < 0.01)
);

create index if not exists ledger_reconciliations_tenant_idx
  on public.ledger_reconciliations(tenant_id, as_of desc);

/**
 * Reconciliation is a controlled act: it may be recorded by the firm, and it may
 * not be amended into agreement afterwards.
 *
 * The row is evidence of what the accounts said on a date. Editing `bank_balance`
 * after the fact turns a discrepancy into a clean sheet, which is the one thing a
 * reconciliation exists to prevent — so it is append-only in the same way the
 * ledger is, and a re-check is a new row.
 */
create or replace function public.guard_reconciliation_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'reconciliation_is_append_only: a reconciliation records what the accounts said on a date — perform a new one rather than amending this one'
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists reconciliation_append_only_guard on public.ledger_reconciliations;
create trigger reconciliation_append_only_guard
  before update or delete on public.ledger_reconciliations
  for each row execute function public.guard_reconciliation_append_only();

-- ── 6 · ROW LEVEL SECURITY ─────────────────────────────────────────────────────
/*
  A ledger is visible to the firm that keeps it, and to NOBODY ELSE — not to the
  portal, at any level.

  That is a deliberate and slightly uncomfortable choice, and the reason is worth
  recording. A client is entitled to know what the firm holds for them. But the
  ledger table also carries the running balance of every OTHER client of the same
  firm in adjacent rows, and the portal's isolation model is per-client. Rather than
  write a policy that projects a per-client computation through a shared table, the
  client-facing balance is served by a route that sums ONE client's entries and
  exposes only that sum. The data stays where it can be audited; the projection is
  explicit rather than a side effect of a policy.
*/
alter table public.client_ledgers        enable row level security;
alter table public.ledger_entries        enable row level security;
alter table public.ledger_reconciliations enable row level security;

drop policy if exists client_ledgers_firm_all on public.client_ledgers;
create policy client_ledgers_firm_read on public.client_ledgers
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy client_ledgers_firm_insert on public.client_ledgers
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy client_ledgers_firm_write on public.client_ledgers
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists ledger_entries_firm_all on public.ledger_entries;
create policy ledger_entries_firm_read on public.ledger_entries
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy ledger_entries_firm_insert on public.ledger_entries
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());
/* No UPDATE and no DELETE policy for firm_api — the append-only trigger is the
   second line of defence, not the only one. A role that has no UPDATE privilege on
   the table cannot reach the trigger. */

drop policy if exists ledger_reconciliations_firm_all on public.ledger_reconciliations;
create policy ledger_reconciliations_firm_read on public.ledger_reconciliations
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy ledger_reconciliations_firm_insert on public.ledger_reconciliations
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists client_ledgers_portal_none on public.client_ledgers;
create policy client_ledgers_portal_none on public.client_ledgers
  for select to portal_api using (false);

drop policy if exists ledger_entries_portal_none on public.ledger_entries;
create policy ledger_entries_portal_none on public.ledger_entries
  for select to portal_api using (false);

drop policy if exists ledger_reconciliations_portal_none on public.ledger_reconciliations;
create policy ledger_reconciliations_portal_none on public.ledger_reconciliations
  for select to portal_api using (false);

-- ── 7 · GRANTS ─────────────────────────────────────────────────────────────────
grant select, insert, update on public.client_ledgers to firm_api;
/*
  THE INVOICE'S OWN PAID FIGURE, which is what applying client money moves. Found by
  `scripts/verify/schema-parity.ts` before the migration was applied rather than by a
  500 afterwards: the statement names `amount_paid`, so the role needs UPDATE on that
  column specifically — a table-wide grant it does not have and should not need.
*/
grant update (amount_paid) on public.invoices to firm_api;
grant select, insert on public.ledger_entries to firm_api;
grant select, insert on public.ledger_reconciliations to firm_api;

grant execute on function public.kgm_ledger_balance(uuid, timestamptz) to firm_api;
grant execute on function public.kgm_client_trust_total(uuid, timestamptz) to firm_api;

-- ── 8 · VERIFICATION ───────────────────────────────────────────────────────────
do $$
declare
  missing text;
  n int;
begin
  select string_agg(t, ', ') into missing
    from unnest(array['client_ledgers','ledger_entries','ledger_reconciliations']) t
   where not exists (select 1 from information_schema.tables
                      where table_schema = 'public' and table_name = t);
  if missing is not null then
    raise exception '0035: missing table(s): %', missing;
  end if;

  /* Every column this migration makes writable on a table that already existed. */
  select string_agg(col, ', ') into missing
    from unnest(array['amount_paid']) col
   where not exists (select 1 from information_schema.column_privileges
                      where table_schema = 'public' and table_name = 'invoices'
                        and grantee = 'firm_api' and privilege_type = 'UPDATE'
                        and column_name = col);
  if missing is not null then
    raise exception '0035: firm_api lacks UPDATE on invoices column(s): %', missing;
  end if;

  select string_agg(t, ', ') into missing
    from unnest(array['ledger_entry_append_only_guard','ledger_entry_shape_guard',
                      'ledger_application_guard','ledger_no_overdraft_guard',
                      'reconciliation_append_only_guard']) t
   where not exists (select 1 from pg_trigger where tgname = t and not tgisinternal);
  if missing is not null then
    raise exception '0035: missing trigger(s): %', missing;
  end if;

  select string_agg(t, ', ') into missing
    from unnest(array['client_ledgers','ledger_entries','ledger_reconciliations']) t
   where not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                      where ns.nspname = 'public' and c.relname = t and c.relrowsecurity);
  if missing is not null then
    raise exception '0035: RLS not enabled on: %', missing;
  end if;

  /*
    THE ONE GRANT THAT MUST NOT EXIST. If `firm_api` can UPDATE or DELETE a ledger
    entry, the append-only trigger is the only thing standing between the ledger and
    an edit — and triggers can be disabled by the same role that owns the table in
    some deployments. No privilege, no reachable path.
  */
  select count(*) into n from information_schema.table_privileges
   where table_schema = 'public' and table_name = 'ledger_entries'
     and grantee = 'firm_api' and privilege_type in ('UPDATE','DELETE');
  if n > 0 then
    raise exception '0035: firm_api holds % of UPDATE/DELETE on ledger_entries — the ledger must stay append-only', n;
  end if;

  if not exists (select 1 from information_schema.routines
                  where routine_schema = 'public' and routine_name = 'kgm_ledger_balance') then
    raise exception '0035: kgm_ledger_balance is missing';
  end if;

  raise notice '0035: client ledgers, append-only movements, overdraft guard, three-way reconciliation — verified';
end $$;
