-- 0012 — ADMIT THE FIRM'S LOGIN-ATTEMPT VOCABULARY
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
-- Firm sign-in failed after the grants were fixed, with a different error — which
-- is itself the useful part: it means the permission layer was finally satisfied
-- and the next layer down was reached.
--
--     POST /api/firm/auth/login -> 500
--     new row for relation "login_attempts" violates check constraint
--     "login_attempts_outcome_check"
--
-- `login_attempts.outcome` is constrained to the PORTAL's vocabulary (0001):
--
--     'success','bad_password','unknown_account','locked','mfa_required',
--     'mfa_failed','disabled','rate_limited','suspicious'
--
-- The Firm OS records its own, deliberately namespaced vocabulary. From
-- `firm-auth.ts`, writing through `FirmRepo.recordLoginAttempt`:
--
--     firm_success          firm_bad_password       firm_unknown_account
--     firm_locked           firm_disabled           firm_mfa_required
--     firm_login_email_budget                      firm_login_ip_budget
--
-- The SQLite schema declares `outcome text not null` with NO check, so every one
-- of these was accepted in development and the entire sequence works there. The
-- repository comment even records the intent — "Append-only attempt record. The
-- `outcome` vocabulary is firm-specific." — and the constraint was never updated
-- to match it.
--
-- WHY THE NAMESPACING IS RIGHT, AND WHY THE FIX IS TO WIDEN THE CHECK
--   A shared identity table means a lawyer's password guess should burn the same
--   budget whichever door it is tried at (that is `updateUserAuthState`'s whole
--   design). But the TRAIL still needs to say which door. Collapsing the firm
--   values into the portal's would lose that, and rewriting the application to
--   emit portal vocabulary would make the firm's failure modes indistinguishable
--   from the portal's in the audit record.
--
--   So the constraint is widened to admit both vocabularies rather than narrowing
--   the code. The portal's nine values remain valid and unchanged.
--
-- A NOTE ON HOW THIS CLASS KEEPS APPEARING
--   This is the fifth failure of the same kind: SQLite accepts what Postgres
--   rejects. Column privileges (#1-#4) and this CHECK are the two mechanisms.
--   SQLite has neither. Anything the database enforces and SQLite does not is a
--   place where "it works" means "it works on the wrong database", and the only
--   reliable detector is running against Postgres — which is why every migration
--   here now ends in assertions and `verify_live_pages.mjs` drives the real HTTP
--   surface rather than reading the database.

-- ---------------------------------------------------------------------------
-- 1 · Admit both vocabularies.
-- ---------------------------------------------------------------------------
alter table public.login_attempts
  drop constraint if exists login_attempts_outcome_check;

alter table public.login_attempts
  add constraint login_attempts_outcome_check check (outcome in (
    -- portal (§6)
    'success','bad_password','unknown_account','locked','mfa_required',
    'mfa_failed','disabled','rate_limited','suspicious',
    -- firm OS (§52). Namespaced so the audit trail says which door was tried.
    'firm_success','firm_bad_password','firm_unknown_account','firm_locked',
    'firm_disabled','firm_mfa_required','firm_mfa_failed',
    'firm_login_email_budget','firm_login_ip_budget','firm_rate_limited'
  ));

comment on column public.login_attempts.outcome is
  'Attempt outcome. Two namespaced vocabularies share this table because the '
  'lockout counters are shared by design across both audiences; the prefix says '
  'which door was tried. Portal values are unprefixed, firm values are firm_*.';

-- ---------------------------------------------------------------------------
-- 2 · Assert that both vocabularies are actually admitted.
-- ---------------------------------------------------------------------------
do $$
declare
  bad text;
begin
  -- Every value the firm code writes must satisfy the constraint. Tested by
  -- inserting and rolling back inside a savepoint, so the check is real rather
  -- than a reading of the constraint text.
  begin
    foreach bad in array array['firm_success','firm_bad_password','firm_unknown_account',
                               'firm_locked','firm_disabled','firm_mfa_required',
                               'firm_login_email_budget','firm_login_ip_budget']
    loop
      begin
        insert into public.login_attempts (ip_hash, outcome) values ('__constraint_probe__', bad);
        raise exception 'PROBE_ROLLBACK';
      exception
        when check_violation then
          raise exception 'login_attempts.outcome still rejects the firm value %', bad;
        when others then
          if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
      end;
    end loop;
  end;

  -- ...and the portal's values must not have been displaced by the widening.
  foreach bad in array array['success','bad_password','unknown_account','locked',
                             'mfa_required','mfa_failed','disabled','rate_limited','suspicious']
  loop
    begin
      insert into public.login_attempts (ip_hash, outcome) values ('__constraint_probe__', bad);
      raise exception 'PROBE_ROLLBACK';
    exception
      when check_violation then
        raise exception 'login_attempts.outcome no longer accepts the portal value %', bad;
      when others then
        if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
    end;
  end loop;

  -- A value in neither vocabulary must still be refused, or the constraint has
  -- stopped constraining.
  begin
    insert into public.login_attempts (ip_hash, outcome) values ('__constraint_probe__', 'not_a_real_outcome');
    raise exception 'login_attempts.outcome accepts an arbitrary string — the CHECK is gone.';
  exception
    when check_violation then null;    -- correct
  end;

  raise notice 'login_attempts admits both vocabularies and still refuses anything else.';
end $$;
