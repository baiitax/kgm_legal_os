-- ═══════════════════════════════════════════════════════════════════════════════
--  0039 · THE CLEARANCE LOOKUP THAT ASKED THE WRONG ROW
--
--  WHAT THIS FIXES
--
--  0034's `guard_credit_note_fiscal_issue` refuses to share a credit note against a
--  STANDARD tax invoice until ZATCA has cleared that invoice. It looked for the
--  clearance with:
--
--      select exists (
--        select 1 from public.invoice_submissions s
--         where s.invoice_id = new.id and s.submission_type = 'clearance' and s.status = 'cleared')
--
--  `new` is a row of `credit_notes`, so `new.id` is the CREDIT NOTE's id — and no
--  submission can ever carry it, because `invoice_submissions.invoice_id` references
--  `invoices`. The condition was never true. The guard therefore raised
--  `credit_note_not_cleared` on EVERY credit note against a standard invoice, including
--  one the authority had already cleared.
--
--  The effect was not a leak but a DEAD END: a firm could not correct a B2B tax invoice
--  at all. Correcting it with a credit note is the only lawful way to reverse an issued
--  invoice, so the rule that protects the buyer had blocked the remedy.
--
--  WHY THE SUITE WAS GREEN
--
--  Every invoice the 42 behavioural tests credit is SIMPLIFIED — the branch is not
--  reached for a simplified document — and SQLite's mirror of this guard did not
--  implement the rule at all. Neither dialect said the same thing, and nothing in the
--  suite compared them.
--
--  HOW IT WAS FOUND
--
--  By `scripts/verify/invoice-fiscal-live.mjs`, while proving something else: that a
--  row-level-security policy NARROWS rather than merely existing. That proof needs one
--  portal-visible credit note, a credit note is visible to a client only once it is
--  reported or cleared, and to be reported it must first be issuable — so the harness
--  issued its own standard invoice, had the authority clear it, and was refused anyway.
--
--  WHY A NEW FILE AND NOT AN EDIT TO 0034
--
--  0034 has been applied and `kgm_migrations` records its checksum. Editing an applied
--  migration leaves two environments with the same file name and different contents,
--  which is the one thing a migration ledger exists to prevent. Same repair pattern as
--  0028 after 0027, 0030 after 0029 and 0038 after 0034.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1 · THE FUNCTION, WITH THE LOOKUP CORRECTED ─────────────────────────────────
/*
  The body is otherwise unchanged: the same UUID-first shape, the same fiscal identity
  and chain requirements, the same refusal wording. ONE comparison changes — the
  submission is looked up against the invoice being credited (`new.invoice_id`) rather
  than against the credit note itself (`new.id`) — and the comment beside it records
  what the comparison used to be, because the wrong version reads correctly.
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
    /*
      THE INVOICE THE CREDIT NOTE CORRECTS, not the credit note itself. `new.id` here was
      the defect: it compared a submission's invoice to a credit note's id, which is a
      question with no true answer.
    */
    select exists (
      select 1 from public.invoice_submissions s
       where s.invoice_id = new.invoice_id
         and s.submission_type = 'clearance' and s.status = 'cleared'
    ) into v_cleared;
    if not v_cleared then
      raise exception 'credit_note_not_cleared: a credit note against a standard tax invoice may not be shared before ZATCA clears it'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- ── 2 · VERIFY ──────────────────────────────────────────────────────────────────
do $$
declare
  src text;
begin
  /*
    THE INSTALLED SOURCE IS WHAT IS CHECKED, not the file that wrote it. A `create or
    replace` that silently failed, or a body applied from a stale copy, would leave the
    defect in place while this migration reported success — so the assertion is made
    against `pg_get_functiondef`, which returns what the database will actually run.
  */
  select pg_get_functiondef('public.guard_credit_note_fiscal_issue()'::regprocedure) into src;
  if src is null then
    raise exception '0039: the credit-note guard is not installed';
  end if;

  if position('s.invoice_id = new.id' in src) > 0 then
    raise exception '0039: the clearance lookup still compares the submission to the credit note';
  end if;
  if position('s.invoice_id = new.invoice_id' in src) = 0 then
    raise exception '0039: the clearance lookup does not name the invoice being credited';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.credit_notes'::regclass
       and tgname = 'credit_note_fiscal_issue_guard' and not tgisinternal)
  then
    raise exception '0039: the guard is not attached to credit_notes';
  end if;

  raise notice '0039 applied: a credit note against a standard invoice is admitted once the invoice it corrects has been cleared.';
end $$;
