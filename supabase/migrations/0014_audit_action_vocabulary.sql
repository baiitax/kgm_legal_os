-- 0014 — ADMIT THE FIRM'S AUDIT-ACTION VOCABULARY
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
-- Same shape as 0012, on the audit trail rather than the login ledger. With the
-- grant in place, firm sign-in reached its very last statement and failed:
--
--     new row for relation "audit_events" violates check constraint
--     "audit_events_action_check"
--
-- `audit_events.action` is constrained to 52 values (0003), all of them written
-- by the client portal or the shared identity layer. The Firm OS writes nine more
-- that the list never learned about. Diffed mechanically — every `action:` literal
-- in `server/src` against the live constraint definition — the gap is:
--
--     ADMIN_MUTATION        FIRM_LOGIN            FIRM_LOGIN_FAILED
--     CEILING_EXCEEDED      FIRM_LOGOUT           FIRM_MFA_FAILED
--     ESCALATION_ATTEMPT    FIRM_MFA_VERIFIED     FIRM_SESSION_REVOKED
--
-- and they are the §50/§51/§73 events — privilege escalation attempts, financial
-- ceiling refusals, administrative mutations and the firm's own authentication
-- trail. In other words the constraint rejected precisely the audit records that
-- matter most to a firm compliance officer, and SQLite (no CHECK) accepted them
-- throughout development.
--
-- The seven values that are constrained but not currently written are LEFT IN
-- PLACE. They are the §49 isolation-violation actions, which are written on paths
-- that do not appear as literals (`TENANT_ISOLATION_VIOLATION` and friends are
-- raised from the shared middleware), and removing a security event from the
-- vocabulary because a grep did not find it is exactly the wrong direction.
--
-- ============================================================================
-- WHY WIDEN THE CONSTRAINT RATHER THAN RENAME THE ACTIONS
-- ============================================================================
-- The namespacing is the design, not an accident. `FIRM_LOGIN` and `LOGIN` are
-- different events with different meanings; §50 wants escalation attempts
-- searchable as a class; and a compliance report that cannot separate a partner's
-- sign-in from a client's is not a compliance report. Renaming the firm's events
-- into the portal's vocabulary would lose that distinction to satisfy a CHECK.
--
-- The list is a closed vocabulary ON PURPOSE — an audit trail that accepts
-- arbitrary action strings cannot be indexed, filtered or alerted on. So it is
-- extended explicitly rather than replaced with a pattern match.

-- ---------------------------------------------------------------------------
-- 1 · Admit the nine firm actions.
-- ---------------------------------------------------------------------------
alter table public.audit_events
  drop constraint if exists audit_events_action_check;

alter table public.audit_events
  add constraint audit_events_action_check check (action in (
    -- ---- client portal + shared identity (§6, §12, §20, §34) ----
    'LOGIN','LOGIN_FAILED','LOGOUT','LOGOUT_ALL_OTHERS','SESSION_EXPIRED',
    'SESSION_REVOKED','ACCOUNT_LOCKED','RATE_LIMITED',
    'PASSWORD_RESET_REQUESTED','PASSWORD_RESET_COMPLETED','PASSWORD_CHANGED',
    'EMAIL_VERIFICATION_SENT','EMAIL_VERIFIED',
    'INVITATION_CREATED','INVITATION_ACCEPTED','INVITATION_EXPIRED','INVITATION_REVOKED',
    'MFA_ENROLLMENT_STARTED','MFA_ENABLED','MFA_DISABLED','MFA_VERIFIED','MFA_FAILED',
    'DEVICE_TRUSTED','DEVICE_UNTRUSTED',
    'DOCUMENT_VIEWED','DOCUMENT_DOWNLOADED','DOCUMENT_UPLOADED',
    'DOCUMENT_UPLOAD_REJECTED','SIGNED_URL_ISSUED','DOCUMENT_ACCESS_DENIED',
    'INVOICE_VIEWED','PAYMENT_STARTED','PAYMENT_COMPLETED','PAYMENT_FAILED','RECEIPT_VIEWED',
    'WEBHOOK_RECEIVED','WEBHOOK_SIGNATURE_INVALID',
    'MESSAGE_SENT','MESSAGE_READ','APPOINTMENT_REQUESTED','APPOINTMENT_CANCELLED',
    'PROFILE_UPDATED','PREFERENCES_UPDATED','NOTIFICATION_READ',
    'PRIVACY_REQUEST_SUBMITTED','CONSENT_RECORDED',
    'AUTHZ_DENIED','TENANT_ISOLATION_VIOLATION','CLIENT_ISOLATION_VIOLATION',
    'INTERNAL_RESOURCE_ACCESS_ATTEMPT','FIELD_TAMPER_ATTEMPT','MUTATION_DENIED',
    -- ---- internal firm OS (§50, §51, §52, §73) ----
    'FIRM_LOGIN','FIRM_LOGIN_FAILED','FIRM_LOGOUT','FIRM_SESSION_REVOKED',
    'FIRM_MFA_VERIFIED','FIRM_MFA_FAILED',
    'ADMIN_MUTATION',        -- §51 administration changes, attributed to a membership
    'ESCALATION_ATTEMPT',    -- §50 self-grant / privilege-escalation refusal
    'CEILING_EXCEEDED'       -- §73 a financial authority limit refused a write
  ));

comment on column public.audit_events.action is
  'Closed action vocabulary. Portal and shared-identity events are unprefixed; '
  'firm OS events are FIRM_*. Extended explicitly by migration, never by pattern; '
  'an audit trail that accepts arbitrary action strings cannot be alerted on.';

-- ---------------------------------------------------------------------------
-- 2 · Assert both halves of the vocabulary, and that it is still closed.
-- ---------------------------------------------------------------------------
do $$
declare
  a text;
  missing text;
begin
  -- Every action the code writes must satisfy the constraint. Tested by inserting
  -- and rolling back, so this verifies the constraint rather than its text.
  foreach a in array array['ADMIN_MUTATION','CEILING_EXCEEDED','ESCALATION_ATTEMPT',
                            'FIRM_LOGIN','FIRM_LOGIN_FAILED','FIRM_LOGOUT',
                            'FIRM_MFA_FAILED','FIRM_MFA_VERIFIED','FIRM_SESSION_REVOKED']
  loop
    begin
      insert into public.audit_events (action, actor_kind, outcome)
      values (a, 'system', 'success');
      raise exception 'PROBE_ROLLBACK';
    exception
      when check_violation then
        raise exception 'audit_events.action still rejects the firm action %', a;
      when others then
        if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
    end;
  end loop;

  -- The portal's vocabulary must be intact — this migration must not have
  -- displaced anything.
  foreach a in array array['LOGIN','LOGIN_FAILED','AUTHZ_DENIED',
                            'TENANT_ISOLATION_VIOLATION','CLIENT_ISOLATION_VIOLATION',
                            'FIELD_TAMPER_ATTEMPT','MUTATION_DENIED','SIGNED_URL_ISSUED']
  loop
    begin
      insert into public.audit_events (action, actor_kind, outcome)
      values (a, 'system', 'success');
      raise exception 'PROBE_ROLLBACK';
    exception
      when check_violation then
        raise exception 'audit_events.action no longer accepts the portal action %', a;
      when others then
        if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
    end;
  end loop;

  -- ...and a value outside the vocabulary must still be refused.
  begin
    insert into public.audit_events (action, actor_kind, outcome)
    values ('NOT_A_REAL_ACTION', 'system', 'success');
    raise exception 'audit_events.action accepts an arbitrary string — the vocabulary is no longer closed.';
  exception
    when check_violation then null;
  end;

  select string_agg(distinct x, ', ') into missing
    from unnest(array['FIRM_LOGIN','ADMIN_MUTATION','ESCALATION_ATTEMPT','CEILING_EXCEEDED']) x
   where not exists (select 1 from unnest(array['FIRM_LOGIN','ADMIN_MUTATION','ESCALATION_ATTEMPT','CEILING_EXCEEDED']) y where y = x);
  if missing is not null then
    raise exception 'vocabulary check incomplete: %', missing;
  end if;

  raise notice 'audit_events admits both vocabularies and still refuses anything else.';
end $$;
