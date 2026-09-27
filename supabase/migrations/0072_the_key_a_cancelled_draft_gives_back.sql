-- ═══════════════════════════════════════════════════════════════════════════════
-- 0072 · letting go of what a cancelled draft billed
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS. One column privilege and one policy, so that cancelling a draft can give
-- its sources back — on the real database, where the privilege is the difference between
-- a working cancellation and a 42501.
--
-- THE COLLISION IT RESOLVES. Two rules, both right, that met each other:
--
--   1  `invoice_lines(billing_source_key)` is UNIQUE. It exists so that one recorded hour
--      cannot appear on two invoices at once — the same hour sold twice is the oldest
--      fraud in a law firm's books, and a partial unique index is a better guarantee than
--      a service convention (see 0068, which restated it for this repository).
--
--   2  A cancelled draft KEEPS its lines and its figures. A register that erases its
--      mistakes cannot be audited, and the reason for the cancellation is written onto
--      the document precisely so a reader a year later can see what happened.
--
-- Together they meant a cancelled draft still held the key for the hour it had billed, and
-- the hour could not be billed again. The first draft of the cancellation failed on SQLite
-- with `UNIQUE constraint failed: invoice_lines.billing_source_key`, which is the index
-- doing its job and the cancellation being wrong: the LINK is what must be released, not
-- the line. Once an entry has been released, nothing on this invoice points at it any
-- more, so a key that still claimed it would be a key that lies.
--
-- WHAT THE SERVICE NOW WRITES. On cancellation, `FirmRepo.cancelInvoiceDraft` sets
-- `billing_source_key = null` on the invoice's lines and appends the released keys to the
-- invoice's own note, so the provenance survives in text where the column cannot keep it.
-- The line, its description, its amount and its VAT treatment are untouched: what the firm
-- drafted is still on the document.
--
-- WHY THIS IS SAFE TO GRANT, AND TO WHOM. `firm_api` gets UPDATE on exactly one column of
-- `invoice_lines` — not the amounts, not the descriptions, not the invoice it belongs to —
-- and the policy admits only lines whose INVOICE IS NOT ISSUED. That is the same line 0070
-- draws for the entries behind them: while a document has no fiscal identity, a member may
-- take back what it claimed; once it carries a UUID, the document and everything it
-- recorded are frozen, and the remedy is a credit note.

-- ── 1 · THE PRIVILEGE ───────────────────────────────────────────────────────
grant update (billing_source_key) on public.invoice_lines to firm_api;

-- ── 2 · THE POLICY ──────────────────────────────────────────────────────────
/*
  `using` decides which rows may be UPDATED; `with check` decides what they may become.
  Both sides ask the same question — the parent invoice is in this firm, in this tenant,
  reachable by this member, and NOT ISSUED — because a policy that checked only the
  starting row would let a member move a key onto a line of an issued document.
*/
drop policy if exists invoice_lines_firm_unlink on public.invoice_lines;
create policy invoice_lines_firm_unlink on public.invoice_lines
  for update
  to firm_api
  using (
    public.kgm_is_firm()
    and exists (
      select 1 from public.invoices i
       where i.id = invoice_lines.invoice_id
         and i.tenant_id = public.kgm_tenant()
         and public.matter_visible(i.matter_id)
         and i.invoice_uuid is null
    )
  )
  with check (
    public.kgm_is_firm()
    and exists (
      select 1 from public.invoices i
       where i.id = invoice_lines.invoice_id
         and i.tenant_id = public.kgm_tenant()
         and public.matter_visible(i.matter_id)
         and i.invoice_uuid is null
    )
  );

-- ── 3 · VERIFY ──────────────────────────────────────────────────────────────
do $$
declare
  v_missing text;
  v_policies int;
begin
  /* The privilege, asked column by column rather than by name: `has_column_privilege` is
     the only form that answers the question the service actually asks. */
  if not has_column_privilege('firm_api', 'public.invoice_lines', 'billing_source_key', 'UPDATE') then
    raise exception 'firm_api cannot update invoice_lines.billing_source_key — cancelling a draft would fail on a privilege';
  end if;

  /* AND NOT THE COLUMNS THAT WOULD LET IT REWRITE A DOCUMENT. This is the half of a grant
     that a checker never looks for, and the half that matters: a privilege that arrived one
     column wider than intended is how an audit trail becomes decorative. */
  select string_agg(c.col, ', ') into v_missing
    from unnest(array['amount', 'unit_price', 'quantity', 'description', 'invoice_id']) as c(col)
   where has_column_privilege('firm_api', 'public.invoice_lines', c.col, 'UPDATE');

  if v_missing is not null then
    raise exception 'firm_api can rewrite % on invoice_lines — cancellation must release the source key and nothing else', v_missing;
  end if;

  /* The policy this migration adds, by name, plus a count of the rest so a rename
     elsewhere cannot quietly take one away. The names are the database's, not the ones
     this file would have chosen: `invoice_lines` carries `firm_full`, `firm_invoice_scope`,
     `invoice_line_scope` and `invoice_lines_firm_insert`, and the first version of this
     check looked for a `..._client_read` policy that has never existed — which is how it
     failed its own dry run rather than passing on a wrong premise. */
  select count(*) into v_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'invoice_lines';

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'invoice_lines'
       and policyname = 'invoice_lines_firm_unlink'
  ) then
    raise exception '0072: the policy that lets a cancelled draft release its sources was not created';
  end if;

  if v_policies < 5 then
    raise exception '0072: invoice_lines has only % policies — the firm insert, the scope policies or this one are missing', v_policies;
  end if;
end $$;
