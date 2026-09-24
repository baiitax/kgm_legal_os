-- ============================================================================
-- KGM LEGAL OS — CLIENT PORTAL
-- Migration 0004 · Roles, column-level grants, Row Level Security
--
-- WHY THIS MIGRATION EXISTS
--   §49 states the browser is never trusted and every permission must be
--   enforced independently at UI + API + Domain + Database + Storage.
--   This file is the DATABASE layer. It provides two guarantees that survive
--   an application bug:
--
--   G1  COLUMN-LEVEL GRANTS. The `portal_api` role is never granted SELECT on
--       internal columns (risk_rating, conflict_cleared, internal_notes,
--       notes_internal, assigned_staff_id, internal_comment, internal_status).
--       A projection that forgets its column list gets "permission denied",
--       not a data leak. `internal_notes` has no grant at all.
--
--   G2  ROW LEVEL SECURITY keyed to transaction-local GUCs. The application
--       sets kgm.tenant_id / kgm.client_ids / kgm.user_id at the start of each
--       request. A forgotten WHERE clause still cannot cross a tenancy or
--       client boundary.
--
--   G3  The Supabase browser-facing roles (anon, authenticated) are denied
--       everything. The anon key is never shipped to the client bundle.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ROLES
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'portal_api') then
    create role portal_api nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'payments_service') then
    create role payments_service nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'firm_os') then
    create role firm_os nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'auditor') then
    create role auditor nologin;
  end if;
end $$;

revoke all on schema public from public;
grant usage on schema public to portal_api, payments_service, firm_os, auditor;

-- ----------------------------------------------------------------------------
-- REQUEST CONTEXT HELPERS
-- ----------------------------------------------------------------------------
-- 'auth' = pre-authentication, capability-based lookups only.
-- 'portal' = a principal is resolved and scope is enforced.
-- Set by the server from the resolved session state; never from the request.
create or replace function public.kgm_phase() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('kgm.phase', true), ''), 'auth')
$$;

create or replace function public.kgm_tenant() returns uuid
language sql stable as $$
  select nullif(current_setting('kgm.tenant_id', true), '')::uuid
$$;

create or replace function public.kgm_user() returns uuid
language sql stable as $$
  select nullif(current_setting('kgm.user_id', true), '')::uuid
$$;

create or replace function public.kgm_clients() returns uuid[]
language sql stable as $$
  select coalesce(
    string_to_array(nullif(current_setting('kgm.client_ids', true), ''), ',')::uuid[],
    '{}'::uuid[]
  )
$$;

-- ----------------------------------------------------------------------------
-- G1 · COLUMN-LEVEL GRANTS FOR portal_api
-- ----------------------------------------------------------------------------
revoke all on all tables in schema public from portal_api;

-- Identity ------------------------------------------------------------------
grant select (id, slug, name, name_ar, country, default_language, default_calendar)
  on public.tenants to portal_api;

grant select (id, tenant_id, client_type, name, name_ar, national_id_masked,
              commercial_reg_masked, email, phone, address_line, city, country,
              identity_verified, verification_note, status)
  on public.clients to portal_api;
-- national_id_hash is deliberately NOT granted: the portal has no reason to
-- read it, and cannot use it as an oracle.

grant select (id, email, email_verified_at, status, failed_login_count,
              locked_until, last_login_at, mfa_enabled, mfa_method, mfa_secret_enc,
              preferred_language, preferred_calendar, password_hash, password_updated_at)
  on public.users to portal_api;
grant update (password_hash, password_updated_at, email_verified_at, status,
              failed_login_count, locked_until, last_login_at, mfa_enabled,
              mfa_method, mfa_secret_enc, mfa_enabled_at,
              preferred_language, preferred_calendar)
  on public.users to portal_api;
-- NO update on users.email, users.id, users.created_at.

grant select (id, user_id, client_id, tenant_id, display_name, display_name_ar,
              job_title, phone, portal_role, status)
  on public.client_users to portal_api;
grant update (display_name, display_name_ar, job_title, phone)
  on public.client_users to portal_api;
-- CRITICAL: portal_api cannot insert client_users rows, and cannot update
-- user_id / client_id / tenant_id / portal_role / status. This is §35 R1-R3
-- enforced by the database, not by application discipline.

grant insert, update, select
  (id, tenant_id, client_id, email, display_name, display_name_ar, portal_role,
   token_hash, token_hint, expires_at, accepted_at, revoked_at, accept_ip_hash, created_at)
  on public.client_invitations to portal_api;

grant select, insert, update
  (id, user_id, tenant_id, client_id, token_hash, created_at, last_activity,
   expires_at, idle_expires_at, ip_hash, ip_country, user_agent, device_label,
   browser, os, mfa_verified_at, trusted_device_id, revoked_at, revoke_reason)
  on public.client_sessions to portal_api;
grant delete on public.client_sessions to portal_api;   -- expired-session GC

grant select, insert, update
  (id, user_id, fingerprint_hash, label, trusted_until, mfa_trusted,
   last_seen_at, revoked_at, created_at)
  on public.client_devices to portal_api;

grant select, insert on public.login_attempts to portal_api;
grant select (id, user_id, kind, token_hash, code_hash, expires_at, used_at,
              attempts, created_at) on public.auth_tokens to portal_api;
grant insert, update, delete on public.auth_tokens to portal_api;
grant select, insert, update on public.mfa_recovery_codes to portal_api;
grant select, insert on public.security_alerts to portal_api;
grant update (acknowledged_at) on public.security_alerts to portal_api;

-- Legal domain --------------------------------------------------------------
grant select (id, tenant_id, client_id, matter_number, case_number, title, title_ar,
              practice_area, practice_area_ar, court, court_ar, client_status,
              summary, summary_ar, opened_at, closed_at, last_client_update_at, created_at)
  on public.matters to portal_api;
-- NOT granted: internal_status, risk_rating, conflict_cleared, internal_notes.

grant select (id, matter_id, staff_id, matter_role, client_visible,
              client_role_label, client_role_label_ar, is_active)
  on public.matter_team to portal_api;

grant select (id, full_name, full_name_ar, client_visible, client_title, client_title_ar, is_active)
  on public.staff to portal_api;
-- NOT granted: internal_role, bar_number, email.

grant select (id, matter_id, occurred_at, event_type, title, title_ar, description,
              description_ar, status, client_visible, created_at)
  on public.matter_timeline to portal_api;

grant select (id, matter_id, client_id, scheduled_at, ends_at, court, court_ar,
              hearing_type, location, location_ar, is_remote, remote_platform,
              remote_link, client_status, instructions, instructions_ar, client_visible)
  on public.hearings to portal_api;
-- NOT granted: internal_status.

grant select (id, matter_id, client_id, kind, title, title_ar, description,
              description_ar, due_at, priority, client_status, client_visible, created_at)
  on public.deadlines to portal_api;
grant update (client_status) on public.deadlines to portal_api;
-- NOT granted: assigned_staff_id, internal_comment, internal_status.
-- NOT granted: INSERT — a client cannot manufacture a deadline.

-- internal_notes: NO GRANT OF ANY KIND to portal_api.
-- Selecting from it as portal_api raises 42501 insufficient_privilege.

grant select (id, tenant_id, matter_id, client_id, subject, subject_ar,
              thread_status, last_message_at, created_at)
  on public.message_threads to portal_api;
grant select (id, thread_id, sender_kind, sender_user_id, sender_display_name,
              body, created_at)
  on public.messages to portal_api;
grant insert (id, thread_id, tenant_id, sender_kind, sender_user_id,
              sender_display_name, body, created_at)
  on public.messages to portal_api;
-- NOT granted: internal_flag, internal_note, sender_staff_id.
-- NOT granted: UPDATE/DELETE on messages — sent messages are immutable.

grant select, insert, delete on public.message_reads to portal_api;
grant select, insert on public.message_attachments to portal_api;

grant select (id, tenant_id, client_id, matter_id, storage_bucket, storage_key,
              original_filename, title, title_ar, document_type, category, origin,
              version, mime_type, size_bytes, sha256, scan_status, status,
              client_visibility, requested, request_note, request_note_ar,
              uploaded_by_user_id, created_at)
  on public.documents to portal_api;
grant insert (id, tenant_id, client_id, matter_id, storage_bucket, storage_key,
              original_filename, stored_filename, title, title_ar, document_type,
              category, origin, version, mime_type, size_bytes, sha256,
              scan_status, status, client_visibility, requested,
              uploaded_by_user_id, created_at)
  on public.documents to portal_api;
grant update (scan_status, scan_result, scanned_at, status, title, title_ar)
  on public.documents to portal_api;
-- NOT granted: update of storage_key/storage_bucket/client_visibility/tenant_id/
-- client_id/matter_id. §35 R10 — a client cannot re-point a document.

grant select, insert on public.document_access_log to portal_api;

-- Financial ----------------------------------------------------------------
grant select (id, tenant_id, client_id, matter_id, invoice_number, issue_date,
              due_date, currency, subtotal, vat_rate, vat_amount, total,
              amount_paid, client_status, storage_key, created_at)
  on public.invoices to portal_api;
-- NOT granted: internal_status, notes_internal, approved_by_staff, approved_at.
-- NOT granted: ANY update/insert/delete. §35 R6 at the database layer.

grant select (id, invoice_id, position, description, description_ar, quantity,
              unit_price, amount) on public.invoice_lines to portal_api;

grant select (id, invoice_id, client_id, provider, amount, currency, status,
              receipt_number, completed_at, created_at)
  on public.payments to portal_api;
grant insert (id, tenant_id, invoice_id, client_id, initiated_by_user_id, provider,
              idempotency_key, amount, currency, status, created_at)
  on public.payments to portal_api;
-- NOT granted: update. Only payments_service (post-webhook) may complete one.
-- NOT granted: provider_intent_id, failure_reason.

grant select (id, payment_id, invoice_id, receipt_number, issued_at, amount,
              currency, storage_key) on public.receipts to portal_api;

-- Portal domain -------------------------------------------------------------
grant select on public.appointment_types to portal_api;
grant select (id, tenant_id, client_id, matter_id, requested_by_user_id,
              type_label, type_label_ar, preferred_date, preferred_time,
              preferred_mode, client_note, confirmed_at, status,
              cancellation_reason, cancelled_by, created_at)
  on public.appointments to portal_api;
grant insert (id, tenant_id, client_id, matter_id, requested_by_user_id, type_id,
              type_label, type_label_ar, preferred_date, preferred_time,
              preferred_mode, client_note, status, created_at)
  on public.appointments to portal_api;
grant update (status, cancellation_reason, cancelled_by) on public.appointments to portal_api;
-- NOT granted: confirmed_at, confirmed_staff_id, rescheduled_from. §23.

grant select, insert on public.notifications to portal_api;
grant update (read_at) on public.notifications to portal_api;
-- NOT granted: delete.

grant select, insert, update on public.notification_preferences to portal_api;
grant select, insert on public.consent_records to portal_api;
grant select (id, request_type, details, status, retention_block,
              resolution_note_client, reviewed_at, due_at, created_at)
  on public.privacy_requests to portal_api;
grant insert (id, tenant_id, user_id, client_id, request_type, details, status, created_at)
  on public.privacy_requests to portal_api;
grant update (status) on public.privacy_requests to portal_api;  -- withdraw only
-- NOT granted: resolution_note (internal), retention_block, reviewed_by_staff.

grant select (id, request_id, storage_key, sha256, expires_at, downloaded_at)
  on public.data_exports to portal_api;

-- AUDIT: insert-only. §35 R7 / §38.
grant insert (id, occurred_at, tenant_id, actor_kind, actor_user_id, actor_client_id,
              action, resource_type, resource_id, outcome, reason_code,
              ip_hash, ip_country, user_agent, request_id, metadata)
  on public.audit_events to portal_api;
grant usage, select on sequence public.audit_events_id_seq to portal_api;
-- NO select, NO update, NO delete. A client user cannot read, edit or erase
-- the audit trail, and cannot even enumerate it.

grant sequence usage on all sequences in schema public to portal_api;

-- payments_service: the webhook path ----------------------------------------
revoke all on all tables in schema public from payments_service;
grant usage on schema public to payments_service;
grant select, insert, update on public.payments to payments_service;
grant select, insert, update on public.invoices to payments_service;
grant select, insert on public.receipts to payments_service;
grant select, insert on public.payment_webhook_events to payments_service;
grant insert on public.audit_events to payments_service;
grant usage, select on sequence public.audit_events_id_seq to payments_service;
grant usage, select on all sequences in schema public to payments_service;

-- auditor: read-only over the trail ----------------------------------------
revoke all on all tables in schema public from auditor;
grant select on public.audit_events, public.login_attempts,
                public.document_access_log, public.security_alerts to auditor;

-- firm_os: full internal access (Internal Firm OS only) ---------------------
grant all on all tables in schema public to firm_os;
grant all on all sequences in schema public to firm_os;

-- ----------------------------------------------------------------------------
-- G3 · The browser-facing Supabase roles get nothing.
-- ----------------------------------------------------------------------------
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- G2 · ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
alter table public.tenants                  enable row level security;
alter table public.tenants                  force  row level security;
alter table public.clients                  enable row level security;
alter table public.clients                  force  row level security;
alter table public.users                    enable row level security;
alter table public.users                    force  row level security;
alter table public.client_users             enable row level security;
alter table public.client_users             force  row level security;
alter table public.client_invitations       enable row level security;
alter table public.client_invitations       force  row level security;
alter table public.client_sessions          enable row level security;
alter table public.client_sessions          force  row level security;
alter table public.client_devices           enable row level security;
alter table public.client_devices           force  row level security;
alter table public.login_attempts           enable row level security;
alter table public.login_attempts           force  row level security;
alter table public.auth_tokens              enable row level security;
alter table public.auth_tokens              force  row level security;
alter table public.mfa_recovery_codes       enable row level security;
alter table public.mfa_recovery_codes       force  row level security;
alter table public.security_alerts          enable row level security;
alter table public.security_alerts          force  row level security;
alter table public.matters                  enable row level security;
alter table public.matters                  force  row level security;
alter table public.matter_team              enable row level security;
alter table public.matter_team              force  row level security;
alter table public.matter_timeline          enable row level security;
alter table public.matter_timeline          force  row level security;
alter table public.staff                    enable row level security;
alter table public.staff                    force  row level security;
alter table public.hearings                 enable row level security;
alter table public.hearings                 force  row level security;
alter table public.deadlines                enable row level security;
alter table public.deadlines                force  row level security;
alter table public.internal_notes           enable row level security;
alter table public.internal_notes           force  row level security;
alter table public.message_threads          enable row level security;
alter table public.message_threads          force  row level security;
alter table public.messages                 enable row level security;
alter table public.messages                 force  row level security;
alter table public.message_reads            enable row level security;
alter table public.message_reads            force  row level security;
alter table public.message_attachments      enable row level security;
alter table public.message_attachments      force  row level security;
alter table public.documents                enable row level security;
alter table public.documents                force  row level security;
alter table public.document_access_log      enable row level security;
alter table public.document_access_log      force  row level security;
alter table public.invoices                 enable row level security;
alter table public.invoices                 force  row level security;
alter table public.invoice_lines            enable row level security;
alter table public.invoice_lines            force  row level security;
alter table public.payments                 enable row level security;
alter table public.payments                 force  row level security;
alter table public.receipts                 enable row level security;
alter table public.receipts                 force  row level security;
alter table public.payment_webhook_events   enable row level security;
alter table public.payment_webhook_events   force  row level security;
alter table public.appointment_types        enable row level security;
alter table public.appointment_types        force  row level security;
alter table public.appointments             enable row level security;
alter table public.appointments             force  row level security;
alter table public.notifications            enable row level security;
alter table public.notifications            force  row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_preferences force  row level security;
alter table public.consent_records          enable row level security;
alter table public.consent_records          force  row level security;
alter table public.privacy_requests         enable row level security;
alter table public.privacy_requests         force  row level security;
alter table public.data_exports             enable row level security;
alter table public.data_exports             force  row level security;
alter table public.audit_events             enable row level security;
alter table public.audit_events             force  row level security;

-- internal_notes: NO policy is created for any non-firm role. With RLS forced
-- and no permissive policy, every access is denied regardless of grants.
create policy internal_notes_firm_only on public.internal_notes
  to firm_os using (true) with check (true);

create policy audit_no_read_for_portal on public.audit_events
  to portal_api with check (true);                 -- insert-only; no USING clause
create policy audit_firm_read on public.audit_events
  to firm_os, auditor using (true) with check (true);

-- ---------------------------------------------------------------------------
-- AUTH-PHASE POLICIES
--
-- Session resolution must read users / client_sessions / client_invitations
-- BEFORE the caller is known, so it cannot be user-scoped. Instead of widening
-- the role, these tables get a second permissive policy that applies only while
-- kgm.phase = 'auth'. Column grants still restrict WHICH columns are readable,
-- and no domain table has an auth-phase policy at all — so a request that has
-- not yet authenticated cannot read a single matter, document or invoice.
--
-- The capability that makes an auth-phase read safe is the opaque token itself:
-- a session token, an invitation token or a password-reset token is a 256-bit
-- secret, so "read the row this token points at" is not an enumeration surface.
-- ---------------------------------------------------------------------------
create policy tenants_auth_phase on public.tenants to portal_api
  using (public.kgm_phase() = 'auth');

create policy users_auth_phase on public.users to portal_api
  using (public.kgm_phase() = 'auth')
  with check (public.kgm_phase() = 'auth');

create policy client_users_auth_phase on public.client_users to portal_api
  using (public.kgm_phase() = 'auth')
  with check (false);   -- a binding may never be written during auth

create policy sessions_auth_phase on public.client_sessions to portal_api
  using (public.kgm_phase() = 'auth')
  with check (public.kgm_phase() = 'auth');

create policy devices_auth_phase on public.client_devices to portal_api
  using (public.kgm_phase() = 'auth')
  with check (public.kgm_phase() = 'auth');

create policy invitations_auth_phase on public.client_invitations to portal_api
  using (public.kgm_phase() = 'auth')
  with check (public.kgm_phase() = 'auth');

create policy auth_tokens_auth_phase on public.auth_tokens to portal_api
  using (public.kgm_phase() = 'auth')
  with check (public.kgm_phase() = 'auth');

create policy recovery_auth_phase on public.mfa_recovery_codes to portal_api
  using (public.kgm_phase() = 'auth')
  with check (public.kgm_phase() = 'auth');

create policy attempts_auth_phase on public.login_attempts to portal_api
  using (public.kgm_phase() = 'auth')
  with check (public.kgm_phase() = 'auth');

create policy alerts_auth_phase on public.security_alerts to portal_api
  using (public.kgm_phase() = 'auth')
  with check (public.kgm_phase() = 'auth');

-- Audit writes are permitted in both phases: an authentication failure is one
-- of the most important things in the trail.
drop policy if exists audit_no_read_for_portal on public.audit_events;
create policy audit_no_read_for_portal on public.audit_events
  to portal_api with check (true);                 -- insert-only; no USING clause

-- ---------------------------------------------------------------------------
-- PORTAL-PHASE POLICIES (strictly scoped)
-- ---------------------------------------------------------------------------
create policy tenant_scope on public.tenants to portal_api
  using (public.kgm_phase() = 'portal' and id = public.kgm_tenant());

create policy client_scope on public.clients to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and id = any (public.kgm_clients()));

create policy user_scope on public.users to portal_api
  using (public.kgm_phase() = 'portal' and id = public.kgm_user())
  with check (public.kgm_phase() = 'portal' and id = public.kgm_user());

create policy client_user_scope on public.client_users to portal_api
  using (public.kgm_phase() = 'portal' and user_id = public.kgm_user()
         and tenant_id = public.kgm_tenant())
  with check (false);   -- never writable in the portal phase either

create policy session_scope on public.client_sessions to portal_api
  using (public.kgm_phase() = 'portal' and user_id = public.kgm_user())
  with check (public.kgm_phase() = 'portal' and user_id = public.kgm_user());

create policy device_scope on public.client_devices to portal_api
  using (public.kgm_phase() = 'portal' and user_id = public.kgm_user())
  with check (public.kgm_phase() = 'portal' and user_id = public.kgm_user());

create policy auth_token_scope on public.auth_tokens to portal_api
  using (public.kgm_phase() = 'portal' and user_id = public.kgm_user())
  with check (public.kgm_phase() = 'portal' and user_id = public.kgm_user());

create policy recovery_scope on public.mfa_recovery_codes to portal_api
  using (public.kgm_phase() = 'portal' and user_id = public.kgm_user())
  with check (public.kgm_phase() = 'portal' and user_id = public.kgm_user());

create policy alert_scope on public.security_alerts to portal_api
  using (public.kgm_phase() = 'portal' and user_id = public.kgm_user())
  with check (public.kgm_phase() = 'portal' and user_id = public.kgm_user());

create policy attempt_scope on public.login_attempts to portal_api
  using (public.kgm_phase() = 'portal') with check (public.kgm_phase() = 'portal');

create policy invitation_scope on public.client_invitations to portal_api
  using (public.kgm_phase() = 'portal')
  with check (public.kgm_phase() = 'portal');

create policy matter_scope on public.matters to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and client_id = any (public.kgm_clients()));

create policy matter_team_scope on public.matter_team to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and matter_id in (select m.id from public.matters m
                           where m.tenant_id = public.kgm_tenant()
                             and m.client_id = any (public.kgm_clients())));

create policy timeline_scope on public.matter_timeline to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and client_visible = true
         and matter_id in (select m.id from public.matters m
                           where m.client_id = any (public.kgm_clients())));

create policy staff_scope on public.staff to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and client_visible = true and is_active = true);

create policy hearing_scope on public.hearings to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and client_id = any (public.kgm_clients()) and client_visible = true);

create policy deadline_scope on public.deadlines to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and client_id = any (public.kgm_clients())
         and kind = 'client_action' and client_visible = true)
  with check (false);            -- portal may never create or re-lane a deadline

create policy thread_scope on public.message_threads to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and client_id = any (public.kgm_clients()));

create policy message_scope on public.messages to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and internal_flag = false
         and thread_id in (select t.id from public.message_threads t
                           where t.client_id = any (public.kgm_clients())))
  with check (tenant_id = public.kgm_tenant() and sender_kind = 'client'
              and sender_user_id = public.kgm_user());

create policy message_read_scope on public.message_reads to portal_api
  using (public.kgm_phase() = 'portal' and reader_kind = 'client'
         and reader_id = public.kgm_user())
  with check (public.kgm_phase() = 'portal' and reader_kind = 'client'
               and reader_id = public.kgm_user());

create policy attachment_scope on public.message_attachments to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and message_id in (select m.id from public.messages m
                            where m.tenant_id = public.kgm_tenant()));

-- The document policy is the storage-authorization backbone (§18, §35 R10).
create policy document_scope on public.documents to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and client_id = any (public.kgm_clients())
         and client_visibility = 'visible'
         and status = 'available'
         and scan_status = 'clean')
  with check (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
              and client_id = any (public.kgm_clients())
              and origin = 'client' and client_visibility = 'visible'
              and uploaded_by_user_id = public.kgm_user());

create policy doc_access_scope on public.document_access_log to portal_api
  using (public.kgm_phase() = 'portal' and accessor_kind = 'client'
         and accessor_id = public.kgm_user())
  with check (public.kgm_phase() = 'portal');

create policy invoice_scope on public.invoices to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and client_id = any (public.kgm_clients())
         and internal_status not in ('draft','pending_internal_approval'))
  with check (false);

create policy invoice_line_scope on public.invoice_lines to portal_api
  using (invoice_id in (select i.id from public.invoices i
                        where i.tenant_id = public.kgm_tenant()
                          and i.client_id = any (public.kgm_clients())
                          and i.internal_status not in ('draft','pending_internal_approval')));

create policy payment_scope on public.payments to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and client_id = any (public.kgm_clients()))
  with check (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
              and client_id = any (public.kgm_clients())
              and status = 'intent_created');

create policy receipt_scope on public.receipts to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and client_id = any (public.kgm_clients()));

create policy webhook_scope on public.payment_webhook_events to payments_service
  using (true) with check (true);

create policy appt_type_scope on public.appointment_types to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and is_active = true);

create policy appointment_scope on public.appointments to portal_api
  using (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
         and client_id = any (public.kgm_clients()))
  with check (public.kgm_phase() = 'portal' and tenant_id = public.kgm_tenant()
              and client_id = any (public.kgm_clients())
              and requested_by_user_id = public.kgm_user()
              and status = 'requested');

create policy notification_scope on public.notifications to portal_api
  using (public.kgm_phase() = 'portal' and user_id = public.kgm_user()
         and tenant_id = public.kgm_tenant())
  with check (public.kgm_phase() = 'portal' and user_id = public.kgm_user());

create policy notif_pref_scope on public.notification_preferences to portal_api
  using (public.kgm_phase() = 'portal' and user_id = public.kgm_user())
  with check (public.kgm_phase() = 'portal' and user_id = public.kgm_user());

create policy consent_scope on public.consent_records to portal_api
  using (public.kgm_phase() = 'portal' and user_id = public.kgm_user())
  with check (public.kgm_phase() = 'portal' and user_id = public.kgm_user());

create policy privacy_scope on public.privacy_requests to portal_api
  using (public.kgm_phase() = 'portal' and user_id = public.kgm_user()
         and tenant_id = public.kgm_tenant())
  with check (public.kgm_phase() = 'portal' and user_id = public.kgm_user()
              and status = 'submitted');

create policy export_scope on public.data_exports to portal_api
  using (public.kgm_phase() = 'portal' and user_id = public.kgm_user());

-- firm_os and payments_service retain full access via their own policies.
do $$
declare t text;
begin
  foreach t in array array[
    'tenants','clients','users','client_users','client_invitations','client_sessions',
    'client_devices','login_attempts','auth_tokens','mfa_recovery_codes','security_alerts',
    'staff','matters','matter_team','matter_timeline','hearings','deadlines',
    'message_threads','messages','message_reads','message_attachments','documents',
    'document_access_log','invoices','invoice_lines','payments','receipts',
    'appointment_types','appointments','notifications','notification_preferences',
    'consent_records','privacy_requests','data_exports'
  ] loop
    execute format('drop policy if exists firm_full on public.%I', t);
    execute format('create policy firm_full on public.%I to firm_os using (true) with check (true)', t);
  end loop;

  foreach t in array array['payments','invoices','receipts'] loop
    execute format('drop policy if exists payments_full on public.%I', t);
    execute format('create policy payments_full on public.%I to payments_service using (true) with check (true)', t);
  end loop;
end $$;
