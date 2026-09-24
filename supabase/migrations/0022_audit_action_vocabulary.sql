-- ============================================================================
-- KGM LEGAL OS · 0022 — THE AUDIT VOCABULARY ADMITS FIRM ACTIONS
-- ============================================================================
-- `audit_events_action_check` was written from the client portal's action list.
-- The Firm OS was built afterwards and added its own vocabulary, and the CHECK
-- was never widened — so every firm mutation that records its audit event inside
-- the same transaction failed, and the whole transaction rolled back:
--
--     POST /api/firm/admin/members/:id/roles -> 500 internal_error
--     cause: new row for relation "audit_events" violates check constraint
--            "audit_events_action_check"
--
--   The six actions below are written by server/src but were not admitted:
--
--     MATTER_ACCESS_GRANTED   firm.routes.ts  POST /matters/:id/access
--     MATTER_ACCESS_REVOKED   firm.routes.ts  same route, accessLevel 'none'
--     MATTER_RESTRICTED       firm.routes.ts  POST /matters/:id/restrict
--     MATTER_UNRESTRICTED     firm.routes.ts  same route, restricted false
--     ROLE_GRANTED            firm.routes.ts  POST /admin/members/:id/roles
--     ROLE_REVOKED            firm.routes.ts  same route, revoke true
--
-- WHY THIS IS THE WORST PLACE FOR A MISMATCH
--   §38 requires a sensitive operation to commit WITH its audit record, so the
--   audit write shares the transaction. A constraint that rejects the audit row
--   therefore does not merely lose the log line — it refuses the operation. The
--   correct outcome (the action is forbidden) and the observed outcome (a 500,
--   indistinguishable from a crash) looked nothing alike. Three endpoints that
--   SHOULD have been operational were dead, and the security suite could not
--   see it because the suite asserts refusals, not admissions.
--
-- THE LIST IS NOW THE WHOLE APP VOCABULARY
--   Derived from the live constraint and extended, not retyped. 61 -> 67.
--   A new action must be added here in the same change that writes it; the
--   failure mode otherwise is a 500 on a write that should have succeeded.
-- ============================================================================

alter table public.audit_events drop constraint audit_events_action_check;

alter table public.audit_events add constraint audit_events_action_check
  check (action in (
    'LOGIN',
    'LOGIN_FAILED',
    'LOGOUT',
    'LOGOUT_ALL_OTHERS',
    'SESSION_EXPIRED',
    'SESSION_REVOKED',
    'ACCOUNT_LOCKED',
    'RATE_LIMITED',
    'PASSWORD_RESET_REQUESTED',
    'PASSWORD_RESET_COMPLETED',
    'PASSWORD_CHANGED',
    'EMAIL_VERIFICATION_SENT',
    'EMAIL_VERIFIED',
    'INVITATION_CREATED',
    'INVITATION_ACCEPTED',
    'INVITATION_EXPIRED',
    'INVITATION_REVOKED',
    'MFA_ENROLLMENT_STARTED',
    'MFA_ENABLED',
    'MFA_DISABLED',
    'MFA_VERIFIED',
    'MFA_FAILED',
    'DEVICE_TRUSTED',
    'DEVICE_UNTRUSTED',
    'DOCUMENT_VIEWED',
    'DOCUMENT_DOWNLOADED',
    'DOCUMENT_UPLOADED',
    'DOCUMENT_UPLOAD_REJECTED',
    'SIGNED_URL_ISSUED',
    'DOCUMENT_ACCESS_DENIED',
    'INVOICE_VIEWED',
    'PAYMENT_STARTED',
    'PAYMENT_COMPLETED',
    'PAYMENT_FAILED',
    'RECEIPT_VIEWED',
    'WEBHOOK_RECEIVED',
    'WEBHOOK_SIGNATURE_INVALID',
    'MESSAGE_SENT',
    'MESSAGE_READ',
    'APPOINTMENT_REQUESTED',
    'APPOINTMENT_CANCELLED',
    'PROFILE_UPDATED',
    'PREFERENCES_UPDATED',
    'NOTIFICATION_READ',
    'PRIVACY_REQUEST_SUBMITTED',
    'CONSENT_RECORDED',
    'AUTHZ_DENIED',
    'TENANT_ISOLATION_VIOLATION',
    'CLIENT_ISOLATION_VIOLATION',
    'INTERNAL_RESOURCE_ACCESS_ATTEMPT',
    'FIELD_TAMPER_ATTEMPT',
    'MUTATION_DENIED',
    'FIRM_LOGIN',
    'FIRM_LOGIN_FAILED',
    'FIRM_LOGOUT',
    'FIRM_SESSION_REVOKED',
    'FIRM_MFA_VERIFIED',
    'FIRM_MFA_FAILED',
    'ADMIN_MUTATION',
    'ESCALATION_ATTEMPT',
    'CEILING_EXCEEDED',
    'MATTER_ACCESS_GRANTED',
    'MATTER_ACCESS_REVOKED',
    'MATTER_RESTRICTED',
    'MATTER_UNRESTRICTED',
    'ROLE_GRANTED',
    'ROLE_REVOKED'
  ));

-- ============================================================================
-- VERIFY — the six firm actions are admitted, and the check is a superset.
-- ============================================================================
do $$
declare
  needed text[] := array[
    'MATTER_ACCESS_GRANTED', 'MATTER_ACCESS_REVOKED',
    'MATTER_RESTRICTED', 'MATTER_UNRESTRICTED',
    'ROLE_GRANTED', 'ROLE_REVOKED'
  ];
  a text;
  def text;
  n int;
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint where conname = 'audit_events_action_check';
  if def is null then
    raise exception 'audit_events_action_check is missing';
  end if;

  foreach a in array needed loop
    if position('''' || a || '''' in def) = 0 then
      raise exception 'audit action % is still not admitted by the check', a;
    end if;
  end loop;

  n := (select count(*) from regexp_matches(def, '''([A-Z][A-Z0-9_]+)''', 'g'));
  if n < 67 then
    raise exception 'audit vocabulary shrank: % actions, expected at least 67', n;
  end if;

  raise notice 'audit vocabulary admits % actions, including all six firm actions.', n;
end $$;
