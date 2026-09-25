-- ═══════════════════════════════════════════════════════════════════════════════
-- 0034 · FISCAL IDENTITY AND A LEGALLY VALID TAX INVOICE  (analysis I · P0.2)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- THE FINDING THIS CLOSES
--   `invoices` has existed since 0002 with a `vat_rate` defaulted to 0.1500 and a
--   `vat_amount` computed from it, and NOTHING ELSE. No seller VAT registration
--   number, no seller commercial registration, no buyer VAT number, no invoice
--   UUID, no counter, no hash chain, no QR, no XML, and no record of ever having
--   spoken to ZATCA. So the software can compute a VAT figure and cannot produce a
--   tax invoice — and the two are not the same object:
--
--     A TAX INVOICE WITHOUT THE SELLER'S VAT REGISTRATION NUMBER IS NOT A TAX
--     INVOICE. It is a demand for money with a percentage printed on it, and the
--     VAT shown on it is not recoverable by the buyer.
--
--   The obligation is not advisory. Under the e-invoicing regulations made under
--   the VAT Law, Phase 2 (the Integration Phase) has been in force since 1 January
--   2023 and applied in waves by revenue. Wave 24 catches turnover above
--   SAR 375,000 and closed 30 June 2026; Wave 25 was announced on 24 July 2026 for
--   turnover above SAR 187,500, with go-live on 1 February 2027. Any firm that is
--   still issuing PDFs by hand is inside one of those windows or the next one, and
--   the penalties are per document, not per filing: up to SAR 50,000 for failing to
--   integrate at all, from SAR 5,000 for a non-compliant invoice, and from
--   SAR 10,000 for DELETING OR AMENDING AN ISSUED INVOICE.
--
--   That last penalty is the one that decides this migration's shape, and it is the
--   reason the guards below are written as they are.
--
-- WHAT THE LAW ACTUALLY REQUIRES, AND WHERE EACH ONE LANDS
--   1. An issued invoice carries a UUID and a cryptographic stamp, and is stored
--      as XML (or PDF/A-3 with the XML embedded). → `invoices.invoice_uuid`,
--      `invoices.invoice_hash`, `invoices.xml_storage_key`.
--   2. A QR code on the document. In Phase 1 it carried five fields; in Phase 2 it
--      carries nine — the five plus the invoice hash, the signature, the public key
--      and the certificate stamp. → `invoices.qr_payload` (base64 TLV, built by
--      `server/src/domain/zatca.ts`, not by the database).
--   3. Every invoice is numbered by a monotonic counter (ICV) and chained to the
--      hash of its predecessor (PIH). The chain is per DEVICE, not per firm: two
--      branches issuing concurrently must not collide on a counter, and an audit
--      that cannot reproduce the chain cannot attest it. → `fiscal_devices`, with
--      `invoice_counter_value` and `last_invoice_hash` as the chain head.
--   4. A STANDARD invoice (B2B, buyer has a VAT number) must be CLEARED — approved
--      by ZATCA — BEFORE it is shared with the buyer. A SIMPLIFIED invoice (B2C)
--      is issued immediately and REPORTED within 24 hours. The two are different
--      obligations with different failure modes, so `invoice_type` is a column and
--      `invoice_submissions.submission_type` is not derived from it loosely: the
--      guard refuses a standard invoice that has never been cleared.
--   5. Invoices are kept electronically for six years and produced on demand. That
--      is a retention duty, scheduled in P1.5; what this migration does is refuse
--      the DELETE that would make the duty unperformable.
--
-- THE DECISION THAT MATTERS MOST
--   AN ISSUED INVOICE IS IMMUTABLE, AND THE ONLY WAY TO CORRECT ONE IS A CREDIT
--   NOTE. This is why `credit_notes` is a table and not a negative invoice: the
--   regulation says so, the penalty says so, and the accounting says so. Amendment
--   and deletion are refused at the database level, not merely unmodelled in the
--   API — a firm whose application cannot amend an invoice cannot accidentally do
--   the thing that costs SAR 10,000 per document.
--
--   `guard_invoice_fiscal_immutable` therefore fires BEFORE UPDATE and compares the
--   fiscal identity, the buyer, the money and the type of every row that already
--   has an `invoice_uuid`. Status may move forward. Nothing else may move at all.
--
-- WHERE THE MONEY GOES AFTER THIS
--   Nothing in this migration debits or credits a trust account. An invoice is a
--   CLAIM; client money is a LIABILITY (0035). The two meet in exactly one place —
--   `ledger_entries.invoice_id` on an application-to-fee entry — and 0035 refuses
--   to apply a client's money to anything but an invoice that has actually been
--   issued.
--
-- DEPENDENCIES
--   0002 (invoices, invoice_lines), 0009–0013 (roles and grants), 0021 (the invoice
--   state machine), 0023 (audit vocabulary), 0025, 0027–0028 (column grants).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · THE SELLER ─────────────────────────────────────────────────────────────
/*
  One row per tenant, and it is a LEGAL identity rather than a settings blob: the
  registered name, the VAT registration number and the commercial registration are
  the three things that appear on every invoice this firm will ever issue. Changing
  any of them changes what a tax invoice says, so this table is append-only in
  spirit — `superseded_by` records a replacement rather than editing the old one,
  because an invoice issued in March must still be explainable in September.
*/
create table if not exists public.fiscal_identity (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete restrict,
  registered_name           text not null,
  registered_name_ar        text,
  /*
    15 digits, beginning and ending with 3, for a Saudi VAT registration. The CHECK
    is a shape test and NOT a validity test — a well-formed number can still be
    wrong, and the only authority on whether it is right is ZATCA. What the shape
    buys is that a blank, a placeholder or a 10-digit CR number typed into the VAT
    field is refused at the door rather than baked into a thousand documents.
  */
  vat_registration_number   text not null check (vat_registration_number ~ '^3[0-9]{13}3$'),
  commercial_registration   text not null check (length(btrim(commercial_registration)) >= 6),
  registered_address        text not null,
  registered_address_ar     text,
  city                      text,
  postal_code               text,
  country                   text not null default 'SA',
  /*
    The ZATCA environment this identity is onboarded in. 'sandbox' and 'simulation'
    are real environments with real endpoints, and a firm must be able to rehearse
    there; the code must never be able to mistake one for production, which is why
    this is a column and not a config default.
  */
  environment               text not null default 'simulation'
                              check (environment in ('sandbox','simulation','production')),
  /*
    Onboarding is a sequence, not a flag: a CSR is generated, the compliance CSRF
    token is fetched, compliance checks pass, and only then is a production CSID
    issued. Collapsing that into `is_integrated boolean` would let the software
    claim an integration it has not performed.
  */
  onboarding_status         text not null default 'not_started' check (onboarding_status in
                              ('not_started','csr_generated','compliance_csid','compliance_passed',
                               'production_csid','failed')),
  certificate_expires_at    timestamptz,
  superseded_by             uuid references public.fiscal_identity(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (tenant_id, vat_registration_number)
);

/*
  The EGS unit / billing device. The ICV sequence and the hash chain live here
  because the regulation defines them per device: a firm with two branches must not
  have both branches write ICV 41, and the chain must be reproducible for each.
*/
create table if not exists public.fiscal_devices (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants(id) on delete restrict,
  fiscal_identity_id      uuid not null references public.fiscal_identity(id) on delete restrict,
  device_label            text not null,
  /*
    The ZATCA device serial, distinct from `id`: the certificate is bound to this
    string, so it is the thing the regulator recognises and the thing an invoice's
    signature is actually attributable to.
  */
  device_serial           text not null,
  /*
    THE CHAIN HEAD, and the reason this table can be trusted.
    `invoice_counter_value` is the ICV of the last invoice issued here, and
    `last_invoice_hash` is its hash — which becomes the NEXT invoice's PIH. Issuing
    an invoice means reading both and writing both, in one statement, so a
    concurrent issue cannot take the same pair.
  */
  invoice_counter_value   bigint not null default 0 check (invoice_counter_value >= 0),
  last_invoice_hash       text,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (tenant_id, device_serial)
);

create index if not exists fiscal_identity_tenant_idx on public.fiscal_identity(tenant_id) where superseded_by is null;
create index if not exists fiscal_devices_tenant_idx on public.fiscal_devices(tenant_id, is_active);

-- ── 2 · THE INVOICE BECOMES A TAX INVOICE ──────────────────────────────────────
/*
  Added to the existing table rather than created beside it. `invoices` already
  carries the state machine, the derivations, the guards and the grants that four
  migrations built; a parallel `tax_invoices` table would have to re-earn all of
  that and would give the same money two homes.
*/
alter table public.invoices
  add column if not exists fiscal_device_id      uuid references public.fiscal_devices(id) on delete restrict,
  /* The UBL UUID. Nullable because a draft has no fiscal existence whatsoever. */
  add column if not exists invoice_uuid         uuid,
  /*
    'standard' (B2B — cleared BEFORE issue) or 'simplified' (B2C — reported within
    24 hours). Assigned at issue, never edited: see the immutability guard.
  */
  add column if not exists invoice_type         text check (invoice_type in ('standard','simplified')),
  add column if not exists icv                  bigint check (icv is null or icv > 0),
  add column if not exists previous_invoice_hash text,   -- PIH, base64 SHA-256
  add column if not exists invoice_hash         text,    -- this invoice's hash
  add column if not exists qr_payload           text,    -- base64 TLV, Phase 2 (9 tags)
  add column if not exists xml_storage_key      text,    -- private bucket; the XML itself
  /*
    THE MOMENT OF SUPPLY, which is not `issue_date`. A tax invoice states the date
    AND TIME of supply, and the simplified-invoice reporting window runs from it —
    so a date column alone cannot tell you whether the 24 hours have elapsed.
  */
  add column if not exists supply_at            timestamptz,
  add column if not exists buyer_vat_number     text,
  add column if not exists buyer_name           text,
  add column if not exists buyer_address        text,
  /*
    The fiscal lifecycle, kept SEPARATE from `internal_status`. An invoice can be
    approved internally and reported to ZATCA, or approved and rejected by it; those
    are orthogonal facts and collapsing them into one column is how a rejected
    invoice gets quietly sent to a client.
  */
  add column if not exists fiscal_status        text check (fiscal_status in
                               ('not_issued','pending_clearance','cleared','pending_reporting',
                                'reported','rejected','failed')),
  add column if not exists fiscal_status_at     timestamptz;

/*
  One line may be standard-rated, zero-rated, exempt or out of scope, and the four
  are NOT interchangeable: an exempt supply and a zero-rated supply both show zero
  VAT and they belong in different boxes of the return. A single invoice-level
  `vat_rate` — which is all 0002 had — cannot express a mixed invoice, and a firm
  that bills a zero-rated export and a standard-rated consultation on one document
  must not have to choose which one to misstate.
*/
alter table public.invoice_lines
  add column if not exists vat_category  text not null default 'standard' check (vat_category in
                           ('standard','zero_rated','exempt','out_of_scope')),
  add column if not exists vat_rate      numeric(5,4) not null default 0.1500
                           check (vat_rate >= 0 and vat_rate <= 1),
  add column if not exists vat_amount    numeric(14,2) not null default 0 check (vat_amount >= 0),
  add column if not exists discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0);

alter table public.invoices
  add column if not exists buyer_address_ar text;

-- ── 3 · THE SUBMISSION LEDGER ──────────────────────────────────────────────────
/*
  Every attempt to talk to ZATCA, kept as its own record.

  WHY NOT COLUMNS ON THE INVOICE. A clearance request can be retried, can time out
  after the invoice was actually cleared, can come back with warnings that are not
  errors, and can be rejected for a reason that is then fixed and resubmitted. All
  of that is a TRAIL, and a trail is rows. It is also the answer to the only
  question that matters after a dispute: what exactly did we send, and what exactly
  did they say back.

  `idempotency_key` is here for the same reason it is on `payments`: a retry must
  resolve to the same submission, not create a second attempt against the same
  invoice that ZATCA would read as a duplicate document.
*/
create table if not exists public.invoice_submissions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  invoice_id        uuid not null references public.invoices(id) on delete restrict,
  submission_type   text not null check (submission_type in ('clearance','reporting','compliance')),
  attempt           integer not null default 1 check (attempt >= 1),
  status            text not null default 'pending' check (status in
                      ('pending','submitted','cleared','reported','rejected','failed','timed_out')),
  http_status       integer,
  /* ZATCA's own code, kept verbatim: it is the string a support case is opened with. */
  response_code     text,
  request_body_hash text,          -- SHA-256 of what was sent, for non-repudiation
  response_body     text,
  warnings          text,
  errors            text,
  next_retry_at     timestamptz,
  submitted_at      timestamptz,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists invoice_submissions_invoice_idx
  on public.invoice_submissions(invoice_id, created_at desc);
create index if not exists invoice_submissions_retry_idx
  on public.invoice_submissions(next_retry_at) where status in ('pending','failed','timed_out');

-- ── 4 · THE CREDIT NOTE, WHICH IS THE ONLY CORRECTION ──────────────────────────
/*
  Mandated by the penalty structure, not by taste. A credit note is its own tax
  document: it has its own UUID, its own place in the ICV chain, its own hash and
  its own QR, and it cites the invoice it corrects. That is why it is a row here and
  not a negative `invoices` row with a flag — the chain must be able to contain it
  as a document in its own right.
*/
create table if not exists public.credit_notes (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete restrict,
  invoice_id           uuid not null references public.invoices(id) on delete restrict,
  client_id            uuid not null references public.clients(id) on delete restrict,
  credit_number        text not null,
  reason               text not null check (length(btrim(reason)) >= 5),
  amount               numeric(14,2) not null check (amount > 0),
  vat_amount           numeric(14,2) not null check (vat_amount >= 0),
  total                numeric(14,2) not null check (total > 0),
  currency             text not null default 'SAR' check (currency in ('SAR')),
  fiscal_device_id     uuid not null references public.fiscal_devices(id) on delete restrict,
  invoice_uuid         uuid,
  icv                  bigint check (icv is null or icv > 0),
  previous_invoice_hash text,
  invoice_hash         text,
  qr_payload           text,
  xml_storage_key      text,
  fiscal_status        text check (fiscal_status in
                         ('not_issued','pending_clearance','cleared','pending_reporting',
                          'reported','rejected','failed')),
  issued_by_staff      uuid references public.staff(id),
  issued_at            timestamptz,
  created_at           timestamptz not null default now(),
  unique (tenant_id, credit_number),
  /* A credit note may not exceed the invoice it corrects — checked in the guard, where
     the invoice's own totals are visible. */
  check (total = amount + vat_amount)
);

create index if not exists credit_notes_invoice_idx on public.credit_notes(invoice_id);

-- ── 5 · THE GATES ──────────────────────────────────────────────────────────────

/*
  Is this tenant able to issue a tax invoice AT ALL?

  Four conditions, all necessary, and the function is deliberately blunt about it:
  a completed onboarding, a production certificate that has not expired, an identity
  that has not been superseded, and an active device bound to that identity.

  Kept as a function because TWO guards need it (invoice issue, credit note issue)
  and a third caller wants it for the UI's honest banner. A pre-flight that says
  "you cannot legally invoice" is worth more than a refusal at the send button.
*/
create or replace function public.kgm_fiscal_ready(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.fiscal_identity fi
      join public.fiscal_devices fd on fd.fiscal_identity_id = fi.id
     where fi.tenant_id = p_tenant
       and fi.superseded_by is null
       and fi.onboarding_status = 'production_csid'
       and (fi.certificate_expires_at is null or fi.certificate_expires_at > now())
       and fd.is_active
  );
$$;

/*
  Bumps the device's chain head and returns the pair the invoice must carry.

  ONE STATEMENT, because the ICV is a shared counter: read-then-write from the
  application would let two concurrent issues take the same ICV, and a duplicated
  ICV is a broken chain that cannot be repaired without reissuing documents.
*/
create or replace function public.kgm_next_fiscal_number(p_device uuid)
returns table (icv bigint, previous_hash text)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.fiscal_devices
     set invoice_counter_value = invoice_counter_value + 1,
         updated_at = now()
   where id = p_device and is_active
  returning invoice_counter_value, last_invoice_hash;
$$;

/**
 * Refuses a fiscal issue that the law does not permit.
 *
 * Fires BEFORE INSERT OR UPDATE on `invoices`, and only does anything when the row
 * is actually being issued — i.e. when `invoice_uuid` is being set, or a fiscal
 * field is already set and the internal status is moving to 'sent'.
 *
 * The distinction between the two invoice types is the whole point of the function:
 *
 *   simplified — issued immediately, reported within 24 hours. The gate asks for a
 *                `supply_at` timestamp so the window is measurable, and for a
 *                reporting submission to exist.
 *   standard   — CLEARED BEFORE IT MAY BE SHARED. The gate refuses `internal_status
 *                = 'sent'` unless `fiscal_status = 'cleared'`. Not "reported", not
 *                "pending": cleared.
 */
create or replace function public.guard_invoice_fiscal_issue()
returns trigger
language plpgsql
as $$
declare
  v_ready boolean;
  v_cleared boolean;
begin
  /*
    ── THE LOOPHOLE THIS CLOSES, WHICH IS WHY IT IS THE FIRST TEST ──

    The obvious shape of this guard is "if nothing fiscal is happening, return
    early" — do that, and an invoice reaches the client by simply never becoming
    fiscal. `internal_status = 'sent'` with no UUID, no type and no QR is a demand
    for money that looks exactly like an invoice in every screen the firm has.

    So the client-facing statuses are refused FIRST, before the early return. This
    is the arm of the gate that makes the rest of it mean anything.
  */
  if new.internal_status in ('sent','partially_paid','paid','overdue')
     and new.invoice_uuid is null then
    raise exception 'invoice_not_issued: an invoice may not reach a client before it is issued as a tax invoice'
      using errcode = 'check_violation';
  end if;

  -- Nothing else fiscal is happening. Every draft edit lands here and is untouched.
  if new.invoice_uuid is null and new.fiscal_status is null then
    return new;
  end if;

  if new.invoice_uuid is null then
    raise exception 'a fiscal status may not be recorded for an invoice with no UUID'
      using errcode = 'check_violation';
  end if;

  /* ── the identity ── */
  v_ready := public.kgm_fiscal_ready(new.tenant_id);
  if not v_ready then
    raise exception 'fiscal_identity_incomplete: this firm cannot issue a tax invoice — no active production fiscal identity and device are onboarded'
      using errcode = 'check_violation';
  end if;

  if new.fiscal_device_id is null then
    raise exception 'fiscal_device_required: a tax invoice must name the device that issued it'
      using errcode = 'check_violation';
  end if;

  /* ── the chain ── */
  if new.icv is null or new.invoice_hash is null then
    raise exception 'fiscal_chain_incomplete: an issued invoice carries an ICV and a hash'
      using errcode = 'check_violation';
  end if;

  if new.invoice_type is null then
    raise exception 'invoice_type_required: an invoice is standard (B2B, cleared before issue) or simplified (B2C, reported within 24 hours)'
      using errcode = 'check_violation';
  end if;

  /*
    A standard invoice needs a buyer VAT number to BE standard. Without it the
    document is, by definition, simplified — and issuing it as standard would put a
    B2C sale in the clearance queue and stall it.
  */
  if new.invoice_type = 'standard'
     and (new.buyer_vat_number is null or length(btrim(new.buyer_vat_number)) < 6) then
    raise exception 'buyer_vat_required: a standard tax invoice must carry the buyer''s VAT registration number'
      using errcode = 'check_violation';
  end if;

  /* ── the QR ── */
  if new.qr_payload is null then
    raise exception 'qr_payload_required: a tax invoice carries a QR code'
      using errcode = 'check_violation';
  end if;

  /*
    ── clearance before sharing ──

    This is the rule that costs the most to get wrong, because the failure is
    silent: the invoice reaches the buyer, the buyer claims the input VAT, and the
    claim is invalid because ZATCA never cleared the document.
  */
  if new.internal_status in ('sent','partially_paid','paid','overdue')
     and new.invoice_type = 'standard' then
    select exists (
      select 1 from public.invoice_submissions s
       where s.invoice_id = new.id
         and s.submission_type = 'clearance'
         and s.status = 'cleared'
    ) into v_cleared;
    if not v_cleared then
      raise exception 'invoice_not_cleared: a standard tax invoice may not be sent before ZATCA clears it'
        using errcode = 'check_violation';
    end if;
  end if;

  /*
    A simplified invoice is reported, not cleared, and the reporting window is 24
    hours from supply. The gate does not refuse an unreported simplified invoice at
    issue — that would make the software unusable at the counter — it refuses one
    whose supply timestamp is missing, because without it the 24 hours cannot be
    measured at all and the obligation becomes unenforceable in software.
  */
  if new.invoice_type = 'simplified' and new.supply_at is null then
    raise exception 'supply_at_required: a simplified tax invoice records the date and time of supply — the 24-hour reporting window runs from it'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

/**
 * An issued invoice may not be amended. Not "should not" — may not.
 *
 * The penalty for amending an issued invoice starts at SAR 10,000 PER DOCUMENT, and
 * the remedy the regulation provides is a credit note. This trigger is that sentence
 * written as code.
 *
 * It compares the fields that a tax invoice literally consists of: the identity of
 * the seller's device, the UUID, the type, the counter, the hashes, the QR, the
 * buyer, the figures, and the date of supply. If any of them differ on a row that
 * already carries a UUID, the UPDATE is refused and the message names the field.
 *
 * What is deliberately NOT frozen: `internal_status`, `client_status`,
 * `amount_paid`, `due_date`, `storage_key`, `notes_internal` and the timestamps.
 * An invoice's life continues after it is issued — it is paid, partly paid, chased,
 * written off. Freezing those would make the invoice impossible to administer and
 * would push the firm towards exactly the amendment this trigger exists to prevent.
 */
create or replace function public.guard_invoice_fiscal_immutable()
returns trigger
language plpgsql
as $$
declare
  v_field text;
begin
  if old.invoice_uuid is null then
    return new;   -- not yet issued: ordinary editing
  end if;

  if new.invoice_uuid is distinct from old.invoice_uuid then v_field := 'invoice_uuid';
  elsif new.invoice_type is distinct from old.invoice_type then v_field := 'invoice_type';
  elsif new.icv is distinct from old.icv then v_field := 'icv';
  elsif new.fiscal_device_id is distinct from old.fiscal_device_id then v_field := 'fiscal_device_id';
  elsif new.invoice_hash is distinct from old.invoice_hash then v_field := 'invoice_hash';
  elsif new.previous_invoice_hash is distinct from old.previous_invoice_hash then v_field := 'previous_invoice_hash';
  elsif new.qr_payload is distinct from old.qr_payload then v_field := 'qr_payload';
  elsif new.buyer_vat_number is distinct from old.buyer_vat_number then v_field := 'buyer_vat_number';
  elsif new.buyer_name is distinct from old.buyer_name then v_field := 'buyer_name';
  elsif new.supply_at is distinct from old.supply_at then v_field := 'supply_at';
  elsif new.issue_date is distinct from old.issue_date then v_field := 'issue_date';
  elsif new.subtotal is distinct from old.subtotal then v_field := 'subtotal';
  elsif new.vat_amount is distinct from old.vat_amount then v_field := 'vat_amount';
  elsif new.total is distinct from old.total then v_field := 'total';
  elsif new.client_id is distinct from old.client_id then v_field := 'client_id';
  elsif new.invoice_number is distinct from old.invoice_number then v_field := 'invoice_number';
  end if;

  if v_field is not null then
    raise exception 'issued_invoice_immutable: % may not change on an issued tax invoice — issue a credit note instead', v_field
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

/**
 * An issued invoice may not be deleted, and neither may its lines.
 */
create or replace function public.guard_issued_invoice_delete()
returns trigger
language plpgsql
as $$
begin
  if old.invoice_uuid is not null then
    raise exception 'issued_invoice_not_deletable: an issued tax invoice is retained for six years and corrected by credit note, never deleted'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

create or replace function public.guard_issued_invoice_line_delete()
returns trigger
language plpgsql
as $$
declare
  v_uuid uuid;
begin
  select invoice_uuid into v_uuid from public.invoices where id = old.invoice_id;
  if v_uuid is not null then
    raise exception 'issued_invoice_not_deletable: the lines of an issued tax invoice may not be removed'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

/*
  ── AND THE LINES THEMSELVES ───────────────────────────────────────────────────

  `guard_issued_invoice_line_delete` stopped the lines being REMOVED. Nothing stopped
  them being REWRITTEN: the unit price or the description of a line on an issued
  invoice could be altered, and the invoice's own totals — which the trigger above
  freezes — would then disagree with the lines they were computed from.

  That is the same shape of hole this phase exists to close, twice over: the document
  was protected and the thing the document was built from was not. An issued tax
  invoice is a statement of a supply, and its lines ARE the statement.

  Refused on INSERT as well as UPDATE, because adding a line after issue falsifies the
  document in exactly the same way as editing one.
*/
create or replace function public.guard_issued_invoice_line_immutable()
returns trigger
language plpgsql
as $$
declare
  v_uuid uuid;
begin
  select invoice_uuid into v_uuid
    from public.invoices
   where id = coalesce(new.invoice_id, old.invoice_id);
  if v_uuid is not null then
    raise exception 'issued_invoice_immutable: the lines of an issued tax invoice may not be added to or amended — issue a credit note instead'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

/**
 * The invoice's VAT is the sum of its lines' VAT, and its subtotal their net.
 *
 * A tax invoice whose printed lines do not add up to its printed total is a
 * non-compliant document whatever the arithmetic of the header says. The check runs
 * only when the invoice is being ISSUED, so a draft may be built line by line in any
 * order; by the time it has a UUID, it adds up.
 *
 * Voided lines are not a concept in the schema, so there is nothing to exclude: a
 * line that must not count is deleted before issue or corrected by credit note after.
 */
create or replace function public.guard_invoice_lines_reconcile()
returns trigger
language plpgsql
as $$
declare
  v_subtotal numeric(14,2);
  v_vat numeric(14,2);
begin
  if new.invoice_uuid is null then
    return new;
  end if;

  select coalesce(sum(round(l.quantity * l.unit_price - l.discount_amount, 2)), 0),
         coalesce(sum(l.vat_amount), 0)
    into v_subtotal, v_vat
    from public.invoice_lines l
   where l.invoice_id = new.id;

  if abs(v_subtotal - new.subtotal) > 0.01 then
    raise exception 'invoice_lines_do_not_reconcile: invoice subtotal % does not equal its lines (%)', new.subtotal, v_subtotal
      using errcode = 'check_violation';
  end if;

  if abs(v_vat - new.vat_amount) > 0.01 then
    raise exception 'invoice_lines_do_not_reconcile: invoice VAT % does not equal its lines (%)', new.vat_amount, v_vat
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

/**
 * A credit note may not exceed what it corrects.
 *
 * Checked against the SUM of credit notes already issued against the invoice, so
 * two credits of 60 against an invoice of 100 are refused on the second — the error
 * a per-row CHECK cannot see and a naive guard gets wrong.
 */
create or replace function public.guard_credit_note_within_invoice()
returns trigger
language plpgsql
as $$
declare
  v_total numeric(14,2);
  v_already numeric(14,2);
begin
  select total into v_total from public.invoices where id = new.invoice_id and tenant_id = new.tenant_id;
  if v_total is null then
    raise exception 'credit_note_unknown_invoice: no such invoice in this tenant'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(total), 0) into v_already
    from public.credit_notes
   where invoice_id = new.invoice_id and id <> new.id;

  if v_already + new.total > v_total + 0.01 then
    raise exception 'credit_note_exceeds_invoice: credits of % against an invoice of %', (v_already + new.total), v_total
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

/**
 * A credit note is issued by the same rules as the invoice it corrects.
 *
 * It carries its own UUID, its own place in the chain and its own QR, and for a
 * standard invoice it must be cleared before it is shared with the buyer — the buyer
 * cannot recover the VAT on a correction ZATCA never saw.
 */
create or replace function public.guard_credit_note_fiscal_issue()
returns trigger
language plpgsql
as $$
declare
  v_ready boolean;
  v_invoice_uuid uuid;
  v_invoice_type text;
  v_cleared boolean;
begin
  if new.invoice_uuid is null and new.fiscal_status is null then
    return new;
  end if;

  if new.invoice_uuid is null then
    raise exception 'a fiscal status may not be recorded for a credit note with no UUID'
      using errcode = 'check_violation';
  end if;

  select invoice_uuid, invoice_type into v_invoice_uuid, v_invoice_type
    from public.invoices where id = new.invoice_id;

  if v_invoice_uuid is null then
    raise exception 'credit_note_against_unissued_invoice: there is nothing to credit — the invoice was never issued'
      using errcode = 'check_violation';
  end if;

  v_ready := public.kgm_fiscal_ready(new.tenant_id);
  if not v_ready then
    raise exception 'fiscal_identity_incomplete: this firm cannot issue a credit note — no active production fiscal identity and device are onboarded'
      using errcode = 'check_violation';
  end if;

  if new.icv is null or new.invoice_hash is null or new.qr_payload is null then
    raise exception 'fiscal_chain_incomplete: an issued credit note carries an ICV, a hash and a QR code'
      using errcode = 'check_violation';
  end if;

  if v_invoice_type = 'standard' then
    select exists (
      select 1 from public.invoice_submissions s
       where s.invoice_id = new.id and s.submission_type = 'clearance' and s.status = 'cleared'
    ) into v_cleared;
    if not v_cleared then
      raise exception 'credit_note_not_cleared: a credit note against a standard tax invoice may not be shared before ZATCA clears it'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists invoice_fiscal_issue_guard on public.invoices;
create trigger invoice_fiscal_issue_guard
  before insert or update on public.invoices
  for each row execute function public.guard_invoice_fiscal_issue();

drop trigger if exists invoice_fiscal_immutable_guard on public.invoices;
create trigger invoice_fiscal_immutable_guard
  before update on public.invoices
  for each row execute function public.guard_invoice_fiscal_immutable();

drop trigger if exists invoice_no_delete_guard on public.invoices;
create trigger invoice_no_delete_guard
  before delete on public.invoices
  for each row execute function public.guard_issued_invoice_delete();

drop trigger if exists invoice_lines_no_delete_guard on public.invoice_lines;
create trigger invoice_lines_no_delete_guard
  before delete on public.invoice_lines
  for each row execute function public.guard_issued_invoice_line_delete();

drop trigger if exists invoice_lines_no_update_guard on public.invoice_lines;
create trigger invoice_lines_no_update_guard
  before update on public.invoice_lines
  for each row execute function public.guard_issued_invoice_line_immutable();

drop trigger if exists invoice_lines_no_insert_guard on public.invoice_lines;
create trigger invoice_lines_no_insert_guard
  before insert on public.invoice_lines
  for each row execute function public.guard_issued_invoice_line_immutable();

drop trigger if exists invoice_lines_reconcile_guard on public.invoices;
create trigger invoice_lines_reconcile_guard
  before insert or update on public.invoices
  for each row execute function public.guard_invoice_lines_reconcile();

drop trigger if exists credit_note_within_invoice_guard on public.credit_notes;
create trigger credit_note_within_invoice_guard
  before insert or update on public.credit_notes
  for each row execute function public.guard_credit_note_within_invoice();

drop trigger if exists credit_note_fiscal_issue_guard on public.credit_notes;
create trigger credit_note_fiscal_issue_guard
  before insert or update on public.credit_notes
  for each row execute function public.guard_credit_note_fiscal_issue();

-- ── 6 · ROW LEVEL SECURITY ─────────────────────────────────────────────────────
/*
  The same non-recursive shape the rest of the schema uses: a policy per command,
  a visibility predicate that does not query the table it protects, and a write
  policy whose WITH CHECK does not re-test the visibility it has just changed.
*/
alter table public.fiscal_identity     enable row level security;
alter table public.fiscal_devices      enable row level security;
alter table public.invoice_submissions enable row level security;
alter table public.credit_notes        enable row level security;

drop policy if exists fiscal_identity_firm_all on public.fiscal_identity;
create policy fiscal_identity_firm_read on public.fiscal_identity
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy fiscal_identity_firm_write on public.fiscal_identity
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy fiscal_identity_firm_insert on public.fiscal_identity
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists fiscal_devices_firm_all on public.fiscal_devices;
create policy fiscal_devices_firm_read on public.fiscal_devices
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy fiscal_devices_firm_write on public.fiscal_devices
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy fiscal_devices_firm_insert on public.fiscal_devices
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists invoice_submissions_firm_all on public.invoice_submissions;
create policy invoice_submissions_firm_read on public.invoice_submissions
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy invoice_submissions_firm_insert on public.invoice_submissions
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy invoice_submissions_firm_write on public.invoice_submissions
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

drop policy if exists credit_notes_firm_all on public.credit_notes;
create policy credit_notes_firm_read on public.credit_notes
  for select to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy credit_notes_firm_insert on public.credit_notes
  for insert to firm_api
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

create policy credit_notes_firm_write on public.credit_notes
  for update to firm_api
  using (public.kgm_is_firm() and tenant_id = public.kgm_tenant())
  with check (public.kgm_is_firm() and tenant_id = public.kgm_tenant());

/*
  THE PORTAL SEES THE FISCAL DOCUMENT AND NOTHING ELSE.

  A client may read the QR and the UUID of an invoice issued TO THEM — that is the
  whole point of a QR code, and a client who cannot see it cannot verify the invoice
  they were sent. The client may not read the seller's identity record, the device,
  or any submission row: those are the firm's compliance record, and a rejected
  submission is not the client's business until it is resolved.
*/
drop policy if exists fiscal_identity_portal_none on public.fiscal_identity;
create policy fiscal_identity_portal_none on public.fiscal_identity
  for select to portal_api
  using (false);

drop policy if exists fiscal_devices_portal_none on public.fiscal_devices;
create policy fiscal_devices_portal_none on public.fiscal_devices
  for select to portal_api
  using (false);

drop policy if exists invoice_submissions_portal_none on public.invoice_submissions;
create policy invoice_submissions_portal_none on public.invoice_submissions
  for select to portal_api
  using (false);

drop policy if exists credit_notes_portal_read on public.credit_notes;
create policy credit_notes_portal_read on public.credit_notes
  for select to portal_api
  using (
    public.kgm_phase() = 'portal'
    and tenant_id = public.kgm_tenant()
    and client_id = any(public.kgm_clients())
    and fiscal_status in ('cleared','reported')
  );

-- ── 7 · GRANTS ─────────────────────────────────────────────────────────────────
grant select, insert, update on public.fiscal_identity to firm_api;
grant select, insert, update on public.fiscal_devices to firm_api;
grant select, insert, update on public.invoice_submissions to firm_api;
grant select, insert, update on public.credit_notes to firm_api;

grant select on public.credit_notes to portal_api;

/* The column list matches exactly what the server names in its statements. 0027's
   lesson: PostgreSQL requires a privilege for every column NAMED, including one
   with a default, and a missing grant is an HTTP 500 on the first real write. */
grant update (internal_status, client_status, fiscal_status, fiscal_status_at,
              invoice_uuid, invoice_type, icv, previous_invoice_hash, invoice_hash,
              qr_payload, xml_storage_key, supply_at, buyer_vat_number, buyer_name,
              buyer_address, buyer_address_ar, fiscal_device_id,
              amount_paid, due_date, storage_key, approved_by_staff, approved_at,
              notes_internal, updated_at)
  on public.invoices to firm_api;

grant update (invoice_counter_value, last_invoice_hash, is_active, updated_at)
  on public.fiscal_devices to firm_api;

grant execute on function public.kgm_fiscal_ready(uuid) to firm_api, portal_api;
grant execute on function public.kgm_next_fiscal_number(uuid) to firm_api;

-- ── 8 · VERIFICATION ───────────────────────────────────────────────────────────
/*
  A DO block that fails the migration rather than reporting success over a schema
  that is not what the file says. Same discipline as 0029–0032, and for the same
  reason: every object below is one whose absence would be discovered by a 500 in
  production rather than by a test.
*/
do $$
declare
  missing text;
  n int;
begin
  /* tables */
  select string_agg(t, ', ') into missing
    from unnest(array['fiscal_identity','fiscal_devices','invoice_submissions','credit_notes']) t
   where not exists (select 1 from information_schema.tables
                      where table_schema = 'public' and table_name = t);
  if missing is not null then
    raise exception '0034: missing table(s): %', missing;
  end if;

  /* invoice columns */
  select string_agg(c, ', ') into missing
    from unnest(array['invoice_uuid','invoice_type','icv','previous_invoice_hash','invoice_hash',
                      'qr_payload','xml_storage_key','supply_at','buyer_vat_number','buyer_name',
                      'buyer_address','fiscal_status','fiscal_status_at','fiscal_device_id']) c
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'invoices' and column_name = c);
  if missing is not null then
    raise exception '0034: invoices missing column(s): %', missing;
  end if;

  /* line columns */
  select string_agg(c, ', ') into missing
    from unnest(array['vat_category','vat_rate','vat_amount','discount_amount']) c
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'invoice_lines' and column_name = c);
  if missing is not null then
    raise exception '0034: invoice_lines missing column(s): %', missing;
  end if;

  /* triggers */
  select string_agg(t, ', ') into missing
    from unnest(array['invoice_fiscal_issue_guard','invoice_fiscal_immutable_guard',
                      'invoice_no_delete_guard','invoice_lines_no_delete_guard',
                      'invoice_lines_no_update_guard','invoice_lines_no_insert_guard',
                      'invoice_lines_reconcile_guard','credit_note_within_invoice_guard',
                      'credit_note_fiscal_issue_guard']) t
   where not exists (select 1 from pg_trigger where tgname = t and not tgisinternal);
  if missing is not null then
    raise exception '0034: missing trigger(s): %', missing;
  end if;

  /* RLS is on, and no forbidden ALL policy was reintroduced */
  select string_agg(t, ', ') into missing
    from unnest(array['fiscal_identity','fiscal_devices','invoice_submissions','credit_notes']) t
   where not exists (select 1 from pg_class c
                      join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relname = t and c.relrowsecurity);
  if missing is not null then
    raise exception '0034: RLS not enabled on: %', missing;
  end if;

  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('fiscal_identity','fiscal_devices','invoice_submissions','credit_notes')
     and cmd = 'ALL' and roles::text like '%firm_api%';
  if n > 0 then
    raise exception '0034: % ALL policy(ies) on a fiscal table — the shape §71 forbids', n;
  end if;

  /* the grants the server's statements actually need */
  select string_agg(c, ', ') into missing
    from unnest(array['internal_status','fiscal_status','invoice_uuid','invoice_type','icv',
                      'previous_invoice_hash','invoice_hash','qr_payload','xml_storage_key',
                      'supply_at','buyer_vat_number','buyer_name','buyer_address',
                      'fiscal_device_id','updated_at']) c
   where not exists (select 1 from information_schema.column_privileges
                      where table_schema = 'public' and table_name = 'invoices'
                        and column_name = c and grantee = 'firm_api' and privilege_type = 'UPDATE');
  if missing is not null then
    raise exception '0034: firm_api lacks UPDATE on invoices columns: %', missing;
  end if;

  select string_agg(c, ', ') into missing
    from unnest(array['invoice_counter_value','last_invoice_hash']) c
   where not exists (select 1 from information_schema.column_privileges
                      where table_schema = 'public' and table_name = 'fiscal_devices'
                        and column_name = c and grantee = 'firm_api' and privilege_type = 'UPDATE');
  if missing is not null then
    raise exception '0034: firm_api lacks UPDATE on fiscal_devices columns: %', missing;
  end if;

  if not exists (select 1 from information_schema.column_privileges
                  where table_schema = 'public' and table_name = 'invoices'
                    and column_name = 'invoice_uuid' and grantee = 'portal_api') then
    -- The portal reads the fiscal document through its own projection; if that
    -- projection ever names invoice_uuid it needs the SELECT, and a missing SELECT
    -- grant here is a 500 at the client's door rather than at the firm's.
    raise notice '0034: portal_api has no column-level SELECT on invoices.invoice_uuid (projection does not name it)';
  end if;

  raise notice '0034: fiscal identity, ICV chain, clearance ledger, credit notes, 7 guards — verified';
end $$;
