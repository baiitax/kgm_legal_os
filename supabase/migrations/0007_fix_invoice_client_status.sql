-- 0007 — FIX invoices.client_status NULLABILITY AND WIDEN THE STATE GUARD
--
-- WHAT WAS WRONG
--   `0002` originally declared:
--
--       client_status text not null default 'awaiting_payment' check (...)
--
--   but `derive_invoice_client_status` -- the function the guard trigger uses as
--   the single source of truth -- returns NULL for 'draft' and
--   'pending_internal_approval', with the comment "not projected at all". The
--   column therefore contradicted its own derivation rule.
--
--   The contradiction has two failure modes and the dangerous one is silent:
--
--     1. LOUD  — an explicit INSERT passing client_status = NULL is rejected by
--                the not-null constraint. This is how the demo seed failed.
--     2. QUIET — an INSERT that OMITS the column takes the DEFAULT and stores
--                'awaiting_payment'. A draft invoice the firm has not approved
--                and never released would appear in the client's portal as
--                "awaiting payment" — a payment demand on an unreleased invoice.
--                The UPDATE-only guard trigger never saw it.
--
--   The SQLite schema (`server/src/db/schema.sqlite.ts`) declares the column
--   plainly as `client_status text` — nullable — so Postgres was the outlier,
--   and the driver-swap contract was broken in the one direction that matters:
--   the demo ran clean and the real database refused.
--
-- WHAT THIS DOES
--   1. Drops NOT NULL and the default, matching SQLite and the derivation rule.
--      A CHECK still constrains every non-null value (a CHECK passes on NULL).
--   2. Rewrites `guard_invoice_state` so it branches on TG_OP instead of reading
--      `old.*` unconditionally — OLD is unassigned on INSERT, so the old body
--      could not simply be attached to an INSERT trigger.
--   3. Fires the guard on INSERT as well as UPDATE, so derivation cannot be
--      bypassed by back-dooring a plausible status at insert time.
--
--   0002 has been corrected in place as well, so a database built from scratch
--   gets this shape directly and this file is a no-op there. It exists to bring
--   databases that already ran the original 0002 — including the live one —
--   to the same state. Both paths converge; re-running is safe.

alter table public.invoices alter column client_status drop not null;
alter table public.invoices alter column client_status drop default;

comment on column public.invoices.client_status is
  'CLIENT-SAFE lifecycle (§20). Read by the portal, never written by it. NULL means '
  'the invoice is not client-visible yet (draft / pending_internal_approval). '
  'Always derived by derive_invoice_client_status via the invoice_state_guard trigger.';

create or replace function public.guard_invoice_state()
returns trigger language plpgsql as $$
begin
  -- TG_OP is branched explicitly. OLD is unassigned on INSERT, so the UPDATE-only
  -- rules (monotonicity, overpayment) cannot be evaluated on the insert path --
  -- referencing OLD fields there is undefined rather than merely null.
  if tg_op = 'UPDATE' then
    -- Financial state may only move forward through defined transitions, and
    -- amount_paid may only increase via a recorded payment.
    if new.amount_paid < old.amount_paid then
      raise exception 'invoice amount_paid cannot decrease outside a refund record';
    end if;
    if new.amount_paid > new.total then
      raise exception 'invoice cannot be overpaid without a credit record';
    end if;
  elsif tg_op = 'INSERT' then
    if new.amount_paid > new.total then
      raise exception 'invoice cannot be overpaid without a credit record';
    end if;
    if new.amount_paid < 0 then
      raise exception 'invoice amount_paid cannot be negative';
    end if;
  end if;

  -- client_status must be derived, never independently asserted. Applies to both
  -- INSERT and UPDATE, so an insert cannot back-door a draft invoice into the
  -- client's list by pushing a plausible-looking status.
  if new.client_status is distinct from
     public.derive_invoice_client_status(new.internal_status, new.amount_paid, new.total, new.due_date) then
    raise exception 'client_status must be derived from internal_status, not set directly';
  end if;
  return new;
end $$;

drop trigger if exists invoice_state_guard on public.invoices;
create trigger invoice_state_guard
  before insert or update on public.invoices
  for each row execute function public.guard_invoice_state();
