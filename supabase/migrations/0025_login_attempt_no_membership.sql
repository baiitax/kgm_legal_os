-- ============================================================================
-- KGM LEGAL OS · 0025 — THE LOGIN-ATTEMPT VOCABULARY ADMITS "NO MEMBERSHIP"
-- ============================================================================
-- `login_attempts.outcome` is a CHECK-constrained vocabulary, and it was missing
-- exactly one value: `firm_no_membership`.
--
-- When it is written
--   A correct password for an account with NO active firm membership. This is
--   the cross-audience door §72 exists to watch: a *client user* presenting
--   valid client credentials at the firm login. `firm-auth.ts` reaches
--   `record(ctx, 'firm_no_membership', …)` on that path.
--
-- What the rejection did — verified live, not reasoned about
--   The record is written with plain `run()` (not the best-effort `tryWrite`),
--   so the CHECK refused the INSERT and the rejection propagated out of the
--   login handler:
--
--     client credentials at the firm login  -> 500 internal_error
--     unknown account at the firm login     -> 401 invalid_credentials
--
--   The two responses must be BYTE-IDENTICAL. The comment directly above that
--   line says so: "Saying so would confirm that this address is a client of the
--   firm, so the response stays identical to a bad password — only the audit row
--   knows the difference." A schema mismatch silently defeated that intent and
--   turned the strongest refusal in the flow into an account-enumeration oracle:
--   500 means "this email has a valid password, it just is not a firm member".
--
-- THE TWO HALVES OF THE FIX
--   1 · This file: admit the value, and verify the whole set the firm flow writes.
--   2 · firm-auth.ts: the login-attempt record becomes best-effort, so a future
--       vocabulary drift degrades to a missing telemetry row rather than a
--       response that discloses whether an account exists. The CHECK stays the
--       contract; the difference is that violating it must not be observable to
--       an unauthenticated caller.
-- ============================================================================

alter table public.login_attempts drop constraint login_attempts_outcome_check;

alter table public.login_attempts add constraint login_attempts_outcome_check
  check (outcome in (
    -- client portal (session.ts)
    'success', 'bad_password', 'unknown_account', 'locked', 'mfa_required',
    'mfa_failed', 'disabled', 'rate_limited', 'suspicious',
    -- firm OS (firm-auth.ts)
    'firm_success', 'firm_bad_password', 'firm_unknown_account', 'firm_locked',
    'firm_disabled', 'firm_mfa_required', 'firm_mfa_failed',
    'firm_login_email_budget', 'firm_login_ip_budget', 'firm_rate_limited',
    -- correct password, no active membership: the cross-audience door.
    'firm_no_membership'
  ));

-- ============================================================================
-- VERIFY — every outcome the authentication flows write is admitted.
-- ============================================================================
do $$
declare
  needed text[] := array[
    'success', 'bad_password', 'unknown_account', 'locked', 'mfa_required',
    'mfa_failed', 'disabled', 'rate_limited', 'suspicious',
    'firm_success', 'firm_bad_password', 'firm_unknown_account', 'firm_locked',
    'firm_disabled', 'firm_mfa_required', 'firm_mfa_failed',
    'firm_login_email_budget', 'firm_login_ip_budget', 'firm_rate_limited',
    'firm_no_membership'
  ];
  a text;
  def text;
  absent text[] := '{}';
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint where conname = 'login_attempts_outcome_check';
  if def is null then
    raise exception 'login_attempts_outcome_check is missing';
  end if;

  foreach a in array needed loop
    if position('''' || a || '''' in def) = 0 then
      absent := absent || a;
    end if;
  end loop;

  if array_length(absent, 1) > 0 then
    raise exception 'login outcome vocabulary is missing: %', array_to_string(absent, ', ');
  end if;

  raise notice 'all % login outcomes are admitted, including firm_no_membership.', array_length(needed, 1);
end $$;
