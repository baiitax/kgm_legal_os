-- ============================================================================
-- KGM LEGAL OS · 0023 — THE AUDIT VOCABULARY, DERIVED FROM THE TYPE UNION
-- ============================================================================
-- 0022 extended the action allowlist by scanning the audit CALL SITES for string
-- literals. That is the wrong source of truth, and it left two actions behind —
-- the ones not written as literals anywhere:
--
--     PERMISSION_DENIED     container.ts denialAction() — the default branch,
--                           i.e. every refused permission that is not a matter
--                           scope, a ceiling or an escalation
--     MATTER_SCOPE_DENIED   denialAction() for matter_not_visible /
--                           matter_level_insufficient / matter_not_found — the
--                           reason a member asking for a matter they cannot see
--                           is turned away
--
-- Both are chosen by a switch inside the audit wrapper, so no call site contains
-- the string. The effect is the same class as 0022 and quieter: these writes go
-- through tryWrite (fire and forget, never inside the request transaction), so the
-- request still returns 404 and the audit row is dropped with a console warning.
-- A denial that is not recorded is invisible to the review §72 is built around —
-- the security log silently under-reports refusals, which is precisely the failure
-- mode an audit trail exists to prevent.
--
-- THE SOURCE OF TRUTH IS NOW THE DECLARED TYPE
--   server/src/audit/logger.ts declares AuditAction and AuditInput.action is typed
--   by it, so a call site cannot invent an action: the union IS the contract. This
--   file makes the database agree with it, and the DO-block below fails if any
--   declared action is not admitted. When an action is added to the union, extend
--   this list in the same change; the runtime failure is otherwise a dropped audit
--   row or a 500, depending on whether the write shares the request transaction,
--   and neither of those says "the database rejected the action".
--
--   69 actions declared, 67 admitted, 2 added here.
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
    'ROLE_REVOKED',
    'PERMISSION_DENIED',
    'MATTER_SCOPE_DENIED'
  ));

-- ============================================================================
-- VERIFY — every action the TypeScript declares is admitted by the database.
-- ============================================================================
do $$
declare
  declared text[] := array[
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
    'PERMISSION_DENIED',
    'MATTER_SCOPE_DENIED',
    'CEILING_EXCEEDED',
    'ROLE_GRANTED',
    'ROLE_REVOKED',
    'MATTER_ACCESS_GRANTED',
    'MATTER_ACCESS_REVOKED',
    'MATTER_RESTRICTED',
    'MATTER_UNRESTRICTED',
    'ESCALATION_ATTEMPT',
    'ADMIN_MUTATION'
  ];
  a text;
  def text;
  absent text[] := '{}';
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint where conname = 'audit_events_action_check';
  if def is null then
    raise exception 'audit_events_action_check is missing';
  end if;

  foreach a in array declared loop
    if position('''' || a || '''' in def) = 0 then
      absent := absent || a;
    end if;
  end loop;

  if array_length(absent, 1) > 0 then
    raise exception 'the audit action check does not admit the declared vocabulary: %',
      array_to_string(absent, ', ');
  end if;

  raise notice 'the DB admits every one of the % actions declared by AuditAction.',
    array_length(declared, 1);
end $$;
