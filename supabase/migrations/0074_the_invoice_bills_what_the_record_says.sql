-- ═══════════════════════════════════════════════════════════════════════════════
-- 0074 · the invoice bills what the time record says
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT, MEASURED. A lawyer records 95 minutes at SAR 1,200 an hour. The time entry
-- stores SAR 1,900 for that work — that is `round2((95/60) × 1200)` and it is the firm's
-- own record of what was done. Drafting an invoice for it produced a line of
-- `1.58 × 1,200 = SAR 1,896`. Four riyals disappeared; the invoice and the record now
-- disagree about the same hour; and the document is internally consistent, so nothing on
-- screen looks wrong. Second example from the live database: SAR 3,792 billed against
-- SAR 3,800 recorded.
--
-- THE CAUSE IS THIS COLUMN. `quantity` is numeric(10,2). Ninety-five minutes is
-- 1.583333… hours, and at two decimal places the invoice could only say 1.58 — a figure
-- that multiplies out to 1,896. The application then had no choice: it must keep
-- `subtotal = Σ round(quantity × unit_price − discount)` true, because
-- `guard_invoice_lines_reconcile` refuses a document whose header disagrees with its own
-- lines, so it derived the money FROM the rounded hours and the fact was lost in the
-- rounding.
--
-- THE DECISION, TAKEN BY THE FIRM AND RECORDED HERE. The recorded amount is the primary
-- fact and the invoice follows it. `quantity` is now wide enough to carry the duration
-- exactly, so the document's own arithmetic reproduces the recorded amount instead of
-- approximating it: 1.583333 × 1,200 = 1,899.9996, which rounds to SAR 1,900.00 — the
-- figure on the time entry.
--
-- WHY SIX PLACES AND NOT MORE. A minute is 1/60 of an hour, so an exact decimal
-- representation does not exist; what is needed is enough precision that the product
-- lands inside the half-halala the reconcile guard already allows (±0.01). At six decimal
-- places the error is at most 0.0000005 × rate — under a third of a halala for any rate
-- below SAR 10,000 an hour, which is every rate in the system. The alternative (bill the
-- rounded hours and change the time entries to match) would have made the firm's record of
-- its own work follow its paperwork, which is the wrong direction for a legal file.
--
-- WHAT THIS DOES NOT CHANGE. `unit_price` stays the contracted rate and `amount` stays the
-- figure billed; the console still DISPLAYS the hours to two decimals, because that is how
-- a person reads an hour. Nothing is recomputed on existing documents: an issued invoice
-- is immutable by design, and a draft keeps the figures it was drafted with — the fix
-- applies to the next draft, and the two live drafts it affected were cancelled during the
-- review that found this.

alter table public.invoice_lines
  alter column quantity type numeric(12,6);

comment on column public.invoice_lines.quantity is
  'The billed duration. Six decimal places since 0074: the invoice must be able to state the duration the time entry recorded (95 minutes = 1.583333 h) so that quantity × unit_price reproduces the recorded amount. Displayed to two decimals.';

-- ── VERIFY ──────────────────────────────────────────────────────────────────────
do $$
declare
  v_type   text;
  v_scale  int;
  v_rounds boolean;
begin
  select data_type, numeric_scale into v_type, v_scale
    from information_schema.columns
   where table_schema = 'public' and table_name = 'invoice_lines' and column_name = 'quantity';

  if v_type <> 'numeric' or v_scale < 6 then
    raise exception '0074: invoice_lines.quantity is % (scale %), not numeric with at least 6 decimals — the invoice still cannot state the recorded duration', v_type, v_scale;
  end if;

  /* The claim this migration exists for, asserted in the database's own arithmetic rather
     than in JavaScript: a 95-minute hour at 1,200 must bill 1,900, and the figure the line
     would be reconciled on must round to it. */
  select round(round(1900.00 / 1200, 6) * 1200, 2) = 1900.00 into v_rounds;
  if not v_rounds then
    raise exception '0074: the recovered duration does not reconcile to the recorded amount — the arithmetic this migration depends on is not sound';
  end if;

  /* And the long tail: every minute-value in a working day, against three rates, must
     reproduce its own recorded amount to the halala. A migration that fixed one example
     and not the class would be worse than one that fixed nothing. */
  if exists (
    select 1
      from generate_series(1, 1440) as m(minutes)
      cross join (values (450.00), (1200.00), (2750.50)) as r(rate)
     where round(round(round(m.minutes / 60.0, 6) * r.rate, 2) - round(m.minutes / 60.0 * r.rate, 2), 2) <> 0
  ) then
    raise exception '0074: some duration and rate still fail to reproduce the recorded amount';
  end if;
end $$;
