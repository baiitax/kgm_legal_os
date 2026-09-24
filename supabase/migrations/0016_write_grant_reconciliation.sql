-- ============================================================================
-- KGM LEGAL OS · 0016 — WRITE GRANT RECONCILIATION
-- ============================================================================
-- 0009 and 0010 reconciled the column grants the application READS. Nothing ever
-- reconciled the ones it WRITES, and the tool that was supposed to
-- (supabase/ops/reconcile_column_grants.mjs) reported two write findings in total,
-- both of which were false positives. Six write paths were therefore broken on
-- Postgres and flawless on SQLite, which is the failure mode this project has now
-- hit four separate times:
--
--   POST /api/client/documents/upload        → permission denied for table documents
--   POST /api/client/messages/:threadId      → permission denied for table messages
--   POST /api/client/appointments            → permission denied for table appointments
--   POST /api/client/privacy/requests        → permission denied for table privacy_requests
--   POST /api/webhooks/*  (issuing receipts) → permission denied for table receipts
--   POST /api/firm/matters/:id/access        → permission denied for table matter_permissions
--   POST /api/firm/administration/roles      → permission denied for table membership_roles
--
-- WHY THE MESSAGE NAMES THE TABLE AND NOT THE COLUMN
--   Postgres reports a column-level INSERT privilege violation as
--   "permission denied for TABLE <t>". The column that is actually missing is not
--   in the error, in the server log, or in the stack — so a one-column gap looks
--   exactly like a missing table grant. That is why the reconciliation below is
--   done per column.
--
-- WHY INHERITANCE HAD TO BE TAKEN INTO ACCOUNT
--   `portal_api` INHERITS `firm_api` (0008), so a privilege granted to firm_api is
--   also held by portal_api, but not the reverse. Every grant below therefore names
--   the NARROWEST role that runs the statement: firm-only tables go to `firm_api`,
--   portal statements to `portal_api`. Granting to both would have widened the
--   firm role with no need.
--
-- WHY THE LOGIN PATH IS DIFFERENT
--   Firm sign-in updates `users` (failed-login counters, last login, lockout)
--   BEFORE a principal exists, so it runs as the login role `portal_api` and those
--   writes already worked. The same columns are granted to `firm_api` here because
--   the firm session that follows owns the same identity row.
--
-- AUDIT NOTE
--   Generated from the INSERT/UPDATE statements in server/src and checked against
--   the live database with has_column_privilege(), then hand-reviewed. The
--   four statements that build their column list at runtime are whitelisted in
--   code (`updateUser`, `updateClientProfile`, `updateClientUserDisplay`,
--   `updateFirmProfile`) or listed explicitly above.
-- ============================================================================

-- Idempotent: GRANT is additive, so re-running this file is a no-op.

grant insert (
         code_hash, created_at, created_ip_hash, expires_at, id, kind, token_hash, user_id
) on public.auth_tokens to firm_api;

grant insert (
         created_at, email, ip_hash, outcome, user_agent, user_id
) on public.login_attempts to firm_api;

grant insert (
         access_level, granted_at, granted_by_membership_id, id, matter_id, membership_id,
         reason, revoked_at, tenant_id
) on public.matter_permissions to firm_api;

grant insert (
         grant_origin, granted_at, granted_by_membership_id, membership_id, role_id
) on public.membership_roles to firm_api;

grant update (
         used_at
) on public.auth_tokens to firm_api;

grant update (
         left_at, status, updated_at
) on public.firm_memberships to firm_api;

grant update (
         approved_at, approved_by_staff, internal_status, updated_at
) on public.invoices to firm_api;

grant update (
         is_restricted, restricted_at, restricted_by_membership_id, restriction_reason,
         restriction_reason_ar, updated_at
) on public.matter_controls to firm_api;

grant update (
         revoked_at
) on public.matter_permissions to firm_api;

grant update (
         revoked_at
) on public.membership_roles to firm_api;

grant update (
         failed_login_count, last_login_at, last_login_ip_hash, locked_until, password_hash,
         password_updated_at, status, updated_at
) on public.users to firm_api;

grant insert (
         updated_at
) on public.appointments to portal_api;

grant insert (
         client_id, created_at, created_by_staff, display_name, display_name_ar, id, job_title,
         phone, portal_role, status, tenant_id, updated_at, user_id
) on public.client_users to portal_api;

grant insert (
         scanned_at, updated_at
) on public.documents to portal_api;

grant insert (
         internal_flag, sender_staff_id
) on public.messages to portal_api;

grant insert (
         due_at, retention_block, updated_at
) on public.privacy_requests to portal_api;

grant insert (
         amount, client_id, created_at, currency, id, invoice_id, issued_at, payment_id,
         receipt_number, storage_key, tenant_id
) on public.receipts to portal_api;

grant insert (
         created_at, email, email_verified_at, failed_login_count, id, mfa_enabled,
         password_hash, password_updated_at, preferred_calendar, preferred_language, status,
         updated_at
) on public.users to portal_api;

grant update (
         updated_at
) on public.appointments to portal_api;

grant update (
         updated_at
) on public.deadlines to portal_api;

grant update (
         requested, updated_at
) on public.documents to portal_api;

grant update (
         amount_paid, client_status, internal_status, updated_at
) on public.invoices to portal_api;

grant update (
         last_message_at, thread_status
) on public.message_threads to portal_api;

grant update (
         amount, completed_at, failure_reason, receipt_number, status, webhook_received_at
) on public.payments to portal_api;

grant update (
         updated_at
) on public.privacy_requests to portal_api;

-- ============================================================================
-- VERIFY — the migration fails if any column the code writes is still ungranted.
-- Run after every schema or query change; it is the check that would have caught
-- all seven outages above before they reached a deployment.
-- ============================================================================
do $$
declare
  r record;
  missing text[] := '{}';
begin
  for r in
    select * from (values
      ('firm_api', 'INSERT', 'auth_tokens', 'code_hash'),
      ('firm_api', 'INSERT', 'auth_tokens', 'created_at'),
      ('firm_api', 'INSERT', 'auth_tokens', 'created_ip_hash'),
      ('firm_api', 'INSERT', 'auth_tokens', 'expires_at'),
      ('firm_api', 'INSERT', 'auth_tokens', 'id'),
      ('firm_api', 'INSERT', 'auth_tokens', 'kind'),
      ('firm_api', 'INSERT', 'auth_tokens', 'token_hash'),
      ('firm_api', 'INSERT', 'auth_tokens', 'user_id'),
      ('firm_api', 'INSERT', 'firm_sessions', 'browser'),
      ('firm_api', 'INSERT', 'firm_sessions', 'created_at'),
      ('firm_api', 'INSERT', 'firm_sessions', 'device_label'),
      ('firm_api', 'INSERT', 'firm_sessions', 'expires_at'),
      ('firm_api', 'INSERT', 'firm_sessions', 'id'),
      ('firm_api', 'INSERT', 'firm_sessions', 'idle_expires_at'),
      ('firm_api', 'INSERT', 'firm_sessions', 'ip_country'),
      ('firm_api', 'INSERT', 'firm_sessions', 'ip_hash'),
      ('firm_api', 'INSERT', 'firm_sessions', 'last_activity'),
      ('firm_api', 'INSERT', 'firm_sessions', 'membership_id'),
      ('firm_api', 'INSERT', 'firm_sessions', 'mfa_verified_at'),
      ('firm_api', 'INSERT', 'firm_sessions', 'os'),
      ('firm_api', 'INSERT', 'firm_sessions', 'role_snapshot'),
      ('firm_api', 'INSERT', 'firm_sessions', 'tenant_id'),
      ('firm_api', 'INSERT', 'firm_sessions', 'token_hash'),
      ('firm_api', 'INSERT', 'firm_sessions', 'trusted_device_id'),
      ('firm_api', 'INSERT', 'firm_sessions', 'user_agent'),
      ('firm_api', 'INSERT', 'firm_sessions', 'user_id'),
      ('firm_api', 'INSERT', 'login_attempts', 'created_at'),
      ('firm_api', 'INSERT', 'login_attempts', 'email'),
      ('firm_api', 'INSERT', 'login_attempts', 'ip_hash'),
      ('firm_api', 'INSERT', 'login_attempts', 'outcome'),
      ('firm_api', 'INSERT', 'login_attempts', 'user_agent'),
      ('firm_api', 'INSERT', 'login_attempts', 'user_id'),
      ('firm_api', 'INSERT', 'matter_permissions', 'access_level'),
      ('firm_api', 'INSERT', 'matter_permissions', 'granted_at'),
      ('firm_api', 'INSERT', 'matter_permissions', 'granted_by_membership_id'),
      ('firm_api', 'INSERT', 'matter_permissions', 'id'),
      ('firm_api', 'INSERT', 'matter_permissions', 'matter_id'),
      ('firm_api', 'INSERT', 'matter_permissions', 'membership_id'),
      ('firm_api', 'INSERT', 'matter_permissions', 'reason'),
      ('firm_api', 'INSERT', 'matter_permissions', 'revoked_at'),
      ('firm_api', 'INSERT', 'matter_permissions', 'tenant_id'),
      ('firm_api', 'INSERT', 'membership_roles', 'grant_origin'),
      ('firm_api', 'INSERT', 'membership_roles', 'granted_at'),
      ('firm_api', 'INSERT', 'membership_roles', 'granted_by_membership_id'),
      ('firm_api', 'INSERT', 'membership_roles', 'membership_id'),
      ('firm_api', 'INSERT', 'membership_roles', 'role_id'),
      ('firm_api', 'UPDATE', 'auth_tokens', 'used_at'),
      ('firm_api', 'UPDATE', 'firm_memberships', 'left_at'),
      ('firm_api', 'UPDATE', 'firm_memberships', 'status'),
      ('firm_api', 'UPDATE', 'firm_memberships', 'updated_at'),
      ('firm_api', 'UPDATE', 'firm_sessions', 'idle_expires_at'),
      ('firm_api', 'UPDATE', 'firm_sessions', 'last_activity'),
      ('firm_api', 'UPDATE', 'firm_sessions', 'mfa_verified_at'),
      ('firm_api', 'UPDATE', 'firm_sessions', 'revoke_reason'),
      ('firm_api', 'UPDATE', 'firm_sessions', 'revoked_at'),
      ('firm_api', 'UPDATE', 'invoices', 'approved_at'),
      ('firm_api', 'UPDATE', 'invoices', 'approved_by_staff'),
      ('firm_api', 'UPDATE', 'invoices', 'internal_status'),
      ('firm_api', 'UPDATE', 'invoices', 'updated_at'),
      ('firm_api', 'UPDATE', 'matter_controls', 'is_restricted'),
      ('firm_api', 'UPDATE', 'matter_controls', 'restricted_at'),
      ('firm_api', 'UPDATE', 'matter_controls', 'restricted_by_membership_id'),
      ('firm_api', 'UPDATE', 'matter_controls', 'restriction_reason'),
      ('firm_api', 'UPDATE', 'matter_controls', 'restriction_reason_ar'),
      ('firm_api', 'UPDATE', 'matter_controls', 'updated_at'),
      ('firm_api', 'UPDATE', 'matter_permissions', 'revoked_at'),
      ('firm_api', 'UPDATE', 'membership_roles', 'revoked_at'),
      ('firm_api', 'UPDATE', 'users', 'failed_login_count'),
      ('firm_api', 'UPDATE', 'users', 'last_login_at'),
      ('firm_api', 'UPDATE', 'users', 'last_login_ip_hash'),
      ('firm_api', 'UPDATE', 'users', 'locked_until'),
      ('firm_api', 'UPDATE', 'users', 'password_hash'),
      ('firm_api', 'UPDATE', 'users', 'password_updated_at'),
      ('firm_api', 'UPDATE', 'users', 'status'),
      ('firm_api', 'UPDATE', 'users', 'updated_at'),
      ('portal_api', 'INSERT', 'appointments', 'client_id'),
      ('portal_api', 'INSERT', 'appointments', 'client_note'),
      ('portal_api', 'INSERT', 'appointments', 'created_at'),
      ('portal_api', 'INSERT', 'appointments', 'id'),
      ('portal_api', 'INSERT', 'appointments', 'matter_id'),
      ('portal_api', 'INSERT', 'appointments', 'preferred_date'),
      ('portal_api', 'INSERT', 'appointments', 'preferred_mode'),
      ('portal_api', 'INSERT', 'appointments', 'preferred_time'),
      ('portal_api', 'INSERT', 'appointments', 'requested_by_user_id'),
      ('portal_api', 'INSERT', 'appointments', 'status'),
      ('portal_api', 'INSERT', 'appointments', 'tenant_id'),
      ('portal_api', 'INSERT', 'appointments', 'type_id'),
      ('portal_api', 'INSERT', 'appointments', 'type_label'),
      ('portal_api', 'INSERT', 'appointments', 'type_label_ar'),
      ('portal_api', 'INSERT', 'appointments', 'updated_at'),
      ('portal_api', 'INSERT', 'auth_tokens', 'attempts'),
      ('portal_api', 'INSERT', 'auth_tokens', 'code_hash'),
      ('portal_api', 'INSERT', 'auth_tokens', 'created_at'),
      ('portal_api', 'INSERT', 'auth_tokens', 'created_ip_hash'),
      ('portal_api', 'INSERT', 'auth_tokens', 'expires_at'),
      ('portal_api', 'INSERT', 'auth_tokens', 'id'),
      ('portal_api', 'INSERT', 'auth_tokens', 'kind'),
      ('portal_api', 'INSERT', 'auth_tokens', 'token_hash'),
      ('portal_api', 'INSERT', 'auth_tokens', 'user_id'),
      ('portal_api', 'INSERT', 'client_devices', 'created_at'),
      ('portal_api', 'INSERT', 'client_devices', 'fingerprint_hash'),
      ('portal_api', 'INSERT', 'client_devices', 'id'),
      ('portal_api', 'INSERT', 'client_devices', 'label'),
      ('portal_api', 'INSERT', 'client_devices', 'last_seen_at'),
      ('portal_api', 'INSERT', 'client_devices', 'mfa_trusted'),
      ('portal_api', 'INSERT', 'client_devices', 'trusted_until'),
      ('portal_api', 'INSERT', 'client_devices', 'user_id'),
      ('portal_api', 'INSERT', 'client_invitations', 'client_id'),
      ('portal_api', 'INSERT', 'client_invitations', 'created_at'),
      ('portal_api', 'INSERT', 'client_invitations', 'created_by_staff'),
      ('portal_api', 'INSERT', 'client_invitations', 'display_name'),
      ('portal_api', 'INSERT', 'client_invitations', 'display_name_ar'),
      ('portal_api', 'INSERT', 'client_invitations', 'email'),
      ('portal_api', 'INSERT', 'client_invitations', 'expires_at'),
      ('portal_api', 'INSERT', 'client_invitations', 'id'),
      ('portal_api', 'INSERT', 'client_invitations', 'portal_role'),
      ('portal_api', 'INSERT', 'client_invitations', 'tenant_id'),
      ('portal_api', 'INSERT', 'client_invitations', 'token_hash'),
      ('portal_api', 'INSERT', 'client_invitations', 'token_hint'),
      ('portal_api', 'INSERT', 'client_sessions', 'browser'),
      ('portal_api', 'INSERT', 'client_sessions', 'client_id'),
      ('portal_api', 'INSERT', 'client_sessions', 'created_at'),
      ('portal_api', 'INSERT', 'client_sessions', 'device_label'),
      ('portal_api', 'INSERT', 'client_sessions', 'expires_at'),
      ('portal_api', 'INSERT', 'client_sessions', 'id'),
      ('portal_api', 'INSERT', 'client_sessions', 'idle_expires_at'),
      ('portal_api', 'INSERT', 'client_sessions', 'ip_country'),
      ('portal_api', 'INSERT', 'client_sessions', 'ip_hash'),
      ('portal_api', 'INSERT', 'client_sessions', 'last_activity'),
      ('portal_api', 'INSERT', 'client_sessions', 'mfa_verified_at'),
      ('portal_api', 'INSERT', 'client_sessions', 'os'),
      ('portal_api', 'INSERT', 'client_sessions', 'tenant_id'),
      ('portal_api', 'INSERT', 'client_sessions', 'token_hash'),
      ('portal_api', 'INSERT', 'client_sessions', 'trusted_device_id'),
      ('portal_api', 'INSERT', 'client_sessions', 'user_agent'),
      ('portal_api', 'INSERT', 'client_sessions', 'user_id'),
      ('portal_api', 'INSERT', 'client_users', 'client_id'),
      ('portal_api', 'INSERT', 'client_users', 'created_at'),
      ('portal_api', 'INSERT', 'client_users', 'created_by_staff'),
      ('portal_api', 'INSERT', 'client_users', 'display_name'),
      ('portal_api', 'INSERT', 'client_users', 'display_name_ar'),
      ('portal_api', 'INSERT', 'client_users', 'id'),
      ('portal_api', 'INSERT', 'client_users', 'job_title'),
      ('portal_api', 'INSERT', 'client_users', 'phone'),
      ('portal_api', 'INSERT', 'client_users', 'portal_role'),
      ('portal_api', 'INSERT', 'client_users', 'status'),
      ('portal_api', 'INSERT', 'client_users', 'tenant_id'),
      ('portal_api', 'INSERT', 'client_users', 'updated_at'),
      ('portal_api', 'INSERT', 'client_users', 'user_id'),
      ('portal_api', 'INSERT', 'consent_records', 'consented'),
      ('portal_api', 'INSERT', 'consent_records', 'id'),
      ('portal_api', 'INSERT', 'consent_records', 'ip_hash'),
      ('portal_api', 'INSERT', 'consent_records', 'policy_version'),
      ('portal_api', 'INSERT', 'consent_records', 'purpose'),
      ('portal_api', 'INSERT', 'consent_records', 'recorded_at'),
      ('portal_api', 'INSERT', 'consent_records', 'tenant_id'),
      ('portal_api', 'INSERT', 'consent_records', 'user_id'),
      ('portal_api', 'INSERT', 'document_access_log', 'accessor_id'),
      ('portal_api', 'INSERT', 'document_access_log', 'accessor_kind'),
      ('portal_api', 'INSERT', 'document_access_log', 'action'),
      ('portal_api', 'INSERT', 'document_access_log', 'created_at'),
      ('portal_api', 'INSERT', 'document_access_log', 'document_id'),
      ('portal_api', 'INSERT', 'document_access_log', 'ip_hash'),
      ('portal_api', 'INSERT', 'document_access_log', 'tenant_id'),
      ('portal_api', 'INSERT', 'documents', 'category'),
      ('portal_api', 'INSERT', 'documents', 'client_id'),
      ('portal_api', 'INSERT', 'documents', 'client_visibility'),
      ('portal_api', 'INSERT', 'documents', 'created_at'),
      ('portal_api', 'INSERT', 'documents', 'document_type'),
      ('portal_api', 'INSERT', 'documents', 'id'),
      ('portal_api', 'INSERT', 'documents', 'matter_id'),
      ('portal_api', 'INSERT', 'documents', 'mime_type'),
      ('portal_api', 'INSERT', 'documents', 'origin'),
      ('portal_api', 'INSERT', 'documents', 'original_filename'),
      ('portal_api', 'INSERT', 'documents', 'requested'),
      ('portal_api', 'INSERT', 'documents', 'scan_status'),
      ('portal_api', 'INSERT', 'documents', 'scanned_at'),
      ('portal_api', 'INSERT', 'documents', 'sha256'),
      ('portal_api', 'INSERT', 'documents', 'size_bytes'),
      ('portal_api', 'INSERT', 'documents', 'status'),
      ('portal_api', 'INSERT', 'documents', 'storage_bucket'),
      ('portal_api', 'INSERT', 'documents', 'storage_key'),
      ('portal_api', 'INSERT', 'documents', 'stored_filename'),
      ('portal_api', 'INSERT', 'documents', 'tenant_id'),
      ('portal_api', 'INSERT', 'documents', 'title'),
      ('portal_api', 'INSERT', 'documents', 'title_ar'),
      ('portal_api', 'INSERT', 'documents', 'updated_at'),
      ('portal_api', 'INSERT', 'documents', 'uploaded_by_user_id'),
      ('portal_api', 'INSERT', 'documents', 'version'),
      ('portal_api', 'INSERT', 'login_attempts', 'created_at'),
      ('portal_api', 'INSERT', 'login_attempts', 'email'),
      ('portal_api', 'INSERT', 'login_attempts', 'ip_hash'),
      ('portal_api', 'INSERT', 'login_attempts', 'outcome'),
      ('portal_api', 'INSERT', 'login_attempts', 'user_agent'),
      ('portal_api', 'INSERT', 'login_attempts', 'user_id'),
      ('portal_api', 'INSERT', 'message_reads', 'message_id'),
      ('portal_api', 'INSERT', 'message_reads', 'read_at'),
      ('portal_api', 'INSERT', 'message_reads', 'reader_id'),
      ('portal_api', 'INSERT', 'message_reads', 'reader_kind'),
      ('portal_api', 'INSERT', 'messages', 'body'),
      ('portal_api', 'INSERT', 'messages', 'created_at'),
      ('portal_api', 'INSERT', 'messages', 'id'),
      ('portal_api', 'INSERT', 'messages', 'internal_flag'),
      ('portal_api', 'INSERT', 'messages', 'sender_display_name'),
      ('portal_api', 'INSERT', 'messages', 'sender_kind'),
      ('portal_api', 'INSERT', 'messages', 'sender_staff_id'),
      ('portal_api', 'INSERT', 'messages', 'sender_user_id'),
      ('portal_api', 'INSERT', 'messages', 'tenant_id'),
      ('portal_api', 'INSERT', 'messages', 'thread_id'),
      ('portal_api', 'INSERT', 'mfa_recovery_codes', 'code_hash'),
      ('portal_api', 'INSERT', 'mfa_recovery_codes', 'created_at'),
      ('portal_api', 'INSERT', 'mfa_recovery_codes', 'id'),
      ('portal_api', 'INSERT', 'mfa_recovery_codes', 'used_at'),
      ('portal_api', 'INSERT', 'mfa_recovery_codes', 'user_id'),
      ('portal_api', 'INSERT', 'notifications', 'body'),
      ('portal_api', 'INSERT', 'notifications', 'body_ar'),
      ('portal_api', 'INSERT', 'notifications', 'category'),
      ('portal_api', 'INSERT', 'notifications', 'client_id'),
      ('portal_api', 'INSERT', 'notifications', 'created_at'),
      ('portal_api', 'INSERT', 'notifications', 'id'),
      ('portal_api', 'INSERT', 'notifications', 'link'),
      ('portal_api', 'INSERT', 'notifications', 'matter_id'),
      ('portal_api', 'INSERT', 'notifications', 'severity'),
      ('portal_api', 'INSERT', 'notifications', 'tenant_id'),
      ('portal_api', 'INSERT', 'notifications', 'title'),
      ('portal_api', 'INSERT', 'notifications', 'title_ar'),
      ('portal_api', 'INSERT', 'notifications', 'user_id'),
      ('portal_api', 'INSERT', 'payment_webhook_events', 'event_id'),
      ('portal_api', 'INSERT', 'payment_webhook_events', 'payload_hash'),
      ('portal_api', 'INSERT', 'payment_webhook_events', 'processing_error'),
      ('portal_api', 'INSERT', 'payment_webhook_events', 'provider'),
      ('portal_api', 'INSERT', 'payment_webhook_events', 'received_at'),
      ('portal_api', 'INSERT', 'payment_webhook_events', 'signature_valid'),
      ('portal_api', 'INSERT', 'payments', 'amount'),
      ('portal_api', 'INSERT', 'payments', 'client_id'),
      ('portal_api', 'INSERT', 'payments', 'created_at'),
      ('portal_api', 'INSERT', 'payments', 'currency'),
      ('portal_api', 'INSERT', 'payments', 'id'),
      ('portal_api', 'INSERT', 'payments', 'idempotency_key'),
      ('portal_api', 'INSERT', 'payments', 'initiated_by_user_id'),
      ('portal_api', 'INSERT', 'payments', 'invoice_id'),
      ('portal_api', 'INSERT', 'payments', 'provider'),
      ('portal_api', 'INSERT', 'payments', 'status'),
      ('portal_api', 'INSERT', 'payments', 'tenant_id'),
      ('portal_api', 'INSERT', 'privacy_requests', 'client_id'),
      ('portal_api', 'INSERT', 'privacy_requests', 'created_at'),
      ('portal_api', 'INSERT', 'privacy_requests', 'details'),
      ('portal_api', 'INSERT', 'privacy_requests', 'due_at'),
      ('portal_api', 'INSERT', 'privacy_requests', 'id'),
      ('portal_api', 'INSERT', 'privacy_requests', 'request_type'),
      ('portal_api', 'INSERT', 'privacy_requests', 'retention_block'),
      ('portal_api', 'INSERT', 'privacy_requests', 'status'),
      ('portal_api', 'INSERT', 'privacy_requests', 'tenant_id'),
      ('portal_api', 'INSERT', 'privacy_requests', 'updated_at'),
      ('portal_api', 'INSERT', 'privacy_requests', 'user_id'),
      ('portal_api', 'INSERT', 'receipts', 'amount'),
      ('portal_api', 'INSERT', 'receipts', 'client_id'),
      ('portal_api', 'INSERT', 'receipts', 'created_at'),
      ('portal_api', 'INSERT', 'receipts', 'currency'),
      ('portal_api', 'INSERT', 'receipts', 'id'),
      ('portal_api', 'INSERT', 'receipts', 'invoice_id'),
      ('portal_api', 'INSERT', 'receipts', 'issued_at'),
      ('portal_api', 'INSERT', 'receipts', 'payment_id'),
      ('portal_api', 'INSERT', 'receipts', 'receipt_number'),
      ('portal_api', 'INSERT', 'receipts', 'storage_key'),
      ('portal_api', 'INSERT', 'receipts', 'tenant_id'),
      ('portal_api', 'INSERT', 'security_alerts', 'created_at'),
      ('portal_api', 'INSERT', 'security_alerts', 'id'),
      ('portal_api', 'INSERT', 'security_alerts', 'ip_country'),
      ('portal_api', 'INSERT', 'security_alerts', 'ip_hash'),
      ('portal_api', 'INSERT', 'security_alerts', 'kind'),
      ('portal_api', 'INSERT', 'security_alerts', 'message'),
      ('portal_api', 'INSERT', 'security_alerts', 'message_ar'),
      ('portal_api', 'INSERT', 'security_alerts', 'severity'),
      ('portal_api', 'INSERT', 'security_alerts', 'tenant_id'),
      ('portal_api', 'INSERT', 'security_alerts', 'user_agent'),
      ('portal_api', 'INSERT', 'security_alerts', 'user_id'),
      ('portal_api', 'INSERT', 'users', 'created_at'),
      ('portal_api', 'INSERT', 'users', 'email'),
      ('portal_api', 'INSERT', 'users', 'email_verified_at'),
      ('portal_api', 'INSERT', 'users', 'failed_login_count'),
      ('portal_api', 'INSERT', 'users', 'id'),
      ('portal_api', 'INSERT', 'users', 'mfa_enabled'),
      ('portal_api', 'INSERT', 'users', 'password_hash'),
      ('portal_api', 'INSERT', 'users', 'password_updated_at'),
      ('portal_api', 'INSERT', 'users', 'preferred_calendar'),
      ('portal_api', 'INSERT', 'users', 'preferred_language'),
      ('portal_api', 'INSERT', 'users', 'status'),
      ('portal_api', 'INSERT', 'users', 'updated_at'),
      ('portal_api', 'UPDATE', 'appointments', 'cancellation_reason'),
      ('portal_api', 'UPDATE', 'appointments', 'cancelled_by'),
      ('portal_api', 'UPDATE', 'appointments', 'status'),
      ('portal_api', 'UPDATE', 'appointments', 'updated_at'),
      ('portal_api', 'UPDATE', 'auth_tokens', 'attempts'),
      ('portal_api', 'UPDATE', 'auth_tokens', 'used_at'),
      ('portal_api', 'UPDATE', 'client_devices', 'mfa_trusted'),
      ('portal_api', 'UPDATE', 'client_devices', 'revoked_at'),
      ('portal_api', 'UPDATE', 'client_devices', 'trusted_until'),
      ('portal_api', 'UPDATE', 'client_invitations', 'accept_ip_hash'),
      ('portal_api', 'UPDATE', 'client_invitations', 'accepted_at'),
      ('portal_api', 'UPDATE', 'client_sessions', 'idle_expires_at'),
      ('portal_api', 'UPDATE', 'client_sessions', 'last_activity'),
      ('portal_api', 'UPDATE', 'client_sessions', 'mfa_verified_at'),
      ('portal_api', 'UPDATE', 'client_sessions', 'revoke_reason'),
      ('portal_api', 'UPDATE', 'client_sessions', 'revoked_at'),
      ('portal_api', 'UPDATE', 'deadlines', 'client_status'),
      ('portal_api', 'UPDATE', 'deadlines', 'updated_at'),
      ('portal_api', 'UPDATE', 'documents', 'requested'),
      ('portal_api', 'UPDATE', 'documents', 'updated_at'),
      ('portal_api', 'UPDATE', 'invoices', 'amount_paid'),
      ('portal_api', 'UPDATE', 'invoices', 'client_status'),
      ('portal_api', 'UPDATE', 'invoices', 'internal_status'),
      ('portal_api', 'UPDATE', 'invoices', 'updated_at'),
      ('portal_api', 'UPDATE', 'message_threads', 'last_message_at'),
      ('portal_api', 'UPDATE', 'message_threads', 'thread_status'),
      ('portal_api', 'UPDATE', 'mfa_recovery_codes', 'used_at'),
      ('portal_api', 'UPDATE', 'notification_preferences', 'email'),
      ('portal_api', 'UPDATE', 'notification_preferences', 'in_app'),
      ('portal_api', 'UPDATE', 'notification_preferences', 'updated_at'),
      ('portal_api', 'UPDATE', 'notifications', 'read_at'),
      ('portal_api', 'UPDATE', 'payments', 'amount'),
      ('portal_api', 'UPDATE', 'payments', 'completed_at'),
      ('portal_api', 'UPDATE', 'payments', 'failure_reason'),
      ('portal_api', 'UPDATE', 'payments', 'receipt_number'),
      ('portal_api', 'UPDATE', 'payments', 'status'),
      ('portal_api', 'UPDATE', 'payments', 'webhook_received_at'),
      ('portal_api', 'UPDATE', 'privacy_requests', 'status'),
      ('portal_api', 'UPDATE', 'privacy_requests', 'updated_at')
    ) as t(role_name, op, table_name, column_name)
  loop
    if not has_column_privilege(r.role_name, 'public.' || r.table_name, r.column_name, r.op) then
      missing := missing || (r.role_name || ' ' || r.op || ' ' || r.table_name || '.' || r.column_name);
    end if;
  end loop;

  if array_length(missing, 1) > 0 then
    raise exception 'write grants still missing (%): %', array_length(missing, 1), array_to_string(missing, ', ');
  end if;
  raise notice 'all % write columns the application uses are granted to the role that runs them.', '328';
end $$;
