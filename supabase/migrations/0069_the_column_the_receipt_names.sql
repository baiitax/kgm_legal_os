-- ═══════════════════════════════════════════════════════════════════════════════
-- 0069 · the column the receipt names
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS. One column-level INSERT privilege that 0065 forgot.
--
-- HOW IT WAS FOUND, because that is the part worth keeping. `scripts/verify/
-- schema-parity.ts` holds a list of every statement the server issues against the
-- firm's tables, with the columns each one writes, and it checks each of those
-- columns against the LIVE PostgreSQL grants. It reported exactly one disagreement
-- after the money console was wired:
--
--     · payments INSERT: server uses ungranted column(s) — initiated_by_user_id
--
-- So `FirmRepo.recordInvoicePayment` would have failed on the real database with a
-- privilege error — not in the test suite, which runs on SQLite and has no grants at
-- all, and not in 0065's own verification, which counted the PRIVILEGES rather than
-- comparing them column by column to the statements the code issues. The gate that
-- was built to check this class of thing is what caught it, which is the whole point
-- of having built it.
--
-- WHY A NEW FILE AND NOT AN EDIT TO 0065. 0065 is applied. This repository does not
-- edit an applied migration — the checksum in `kgm_migrations` would then describe a
-- file that no longer exists, and a database rebuilt from the tree would differ from
-- the one running in production in a way nobody could see. A correction arrives as a
-- new file; that is the same rule 0065 itself followed for the drift it restated.
--
-- WHAT THE COLUMN IS FOR. `initiated_by_user_id` is whoever at the firm recorded the
-- money. It is the difference between a receipt and a rumour: the payments table will
-- show which member took the transfer in, which is the question an audit asks when a
-- client says they paid and the ledger disagrees. It is nullable because a payment
-- initiated by the CLIENT through the gateway has no member behind it — that path
-- writes its own row with its own grants, and this one only ever carries a firm member.
--
-- ── 1 · THE PRIVILEGE ───────────────────────────────────────────────────────
grant insert (initiated_by_user_id) on public.payments to firm_api;

-- ── 2 · VERIFY ──────────────────────────────────────────────────────────────
/*
  The whole 13-column insert list the server issues, checked as a WHOLE rather than in
  the one-column increment this file adds. A migration that verifies only its own delta
  cannot tell that the list it is completing was short in two places, and the next
  reader would have to reconstruct the total from two files to know what the code can
  actually do.
*/
do $$
declare
  missing text;
begin
  select string_agg(c.col, ', ' order by c.col) into missing
    from unnest(array[
      'id', 'tenant_id', 'invoice_id', 'client_id', 'initiated_by_user_id', 'provider',
      'provider_intent_id', 'amount', 'currency', 'status', 'receipt_number',
      'completed_at', 'created_at'
    ]) as c(col)
   where not has_column_privilege('firm_api', 'public.payments', c.col, 'INSERT');

  if missing is not null then
    raise exception
      'firm_api cannot insert %. FirmRepo.recordInvoicePayment writes these columns for every receipt the firm records.',
      missing;
  end if;

  -- And the read the console does: the receipt list on one invoice.
  if not has_column_privilege('firm_api', 'public.payments', 'amount', 'SELECT') then
    raise exception 'firm_api cannot read payments.amount — the invoice panel would show receipts with no figures.';
  end if;
end $$;
