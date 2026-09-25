/**
 * SQLite schema for the demo/development/test driver.
 *
 * This mirrors supabase/migrations/0001–0005 column-for-column where the
 * portal touches the data, with types adapted to SQLite. The Postgres
 * migrations remain the production source of truth (they add uuid types,
 * RLS, column-level grants and roles, which have no SQLite equivalent).
 *
 * The structural guarantees that CAN be expressed in SQLite are expressed:
 *   - audit_events is append-only (triggers)
 *   - internal_task deadlines cannot be client_visible (trigger)
 *   - a document cannot be 'available' before a clean scan (trigger)
 *   - invoice client_status must be derived, amount_paid monotonic (trigger)
 *   - invitation bindings are immutable (trigger)
 *   - internal_notes exists as a table the portal repository never selects
 */
export const SQLITE_SCHEMA = `
pragma journal_mode = WAL;
pragma foreign_keys = ON;

-- =========================== IDENTITY =====================================
create table if not exists tenants (
  id text primary key,
  slug text not null unique collate nocase,
  name text not null,
  name_ar text not null,
  country text not null default 'SA',
  default_language text not null default 'ar',
  default_calendar text not null default 'islamic-umalqura',
  status text not null default 'active',
  created_at text not null,
  updated_at text not null
);

create table if not exists clients (
  id text primary key,
  tenant_id text not null references tenants(id),
  client_type text not null default 'individual',
  name text not null,
  name_ar text,
  national_id_masked text,
  national_id_hash text,
  commercial_reg_masked text,
  email text collate nocase,
  phone text,
  address_line text,
  city text,
  country text not null default 'SA',
  identity_verified integer not null default 0,
  verification_note text,
  status text not null default 'active',
  -- 0029. clients is a commercial relationship; parties is an identity. The link
  -- is nullable because the register arrived after the clients did, and a client
  -- without it is matched on its own name columns instead — one matcher, two storage
  -- paths, no second rule. No FK is declared here because parties is created by the
  -- FIRM schema, which SQLite applies second; Postgres declares the reference.
  party_id text,
  -- Rule 8/4's starting point. An override: the repository falls back to the most
  -- recent matter closed for the client when it is null.
  relationship_ended_on text,
  created_at text not null,
  updated_at text not null
);
create index if not exists clients_tenant_idx on clients(tenant_id);

create table if not exists users (
  id text primary key,
  email text not null unique collate nocase,
  password_hash text,
  password_updated_at text,
  email_verified_at text,
  status text not null default 'invited',
  failed_login_count integer not null default 0,
  locked_until text,
  last_login_at text,
  last_login_ip_hash text,
  mfa_enabled integer not null default 0,
  mfa_method text,
  mfa_secret_enc text,
  mfa_enabled_at text,
  preferred_language text not null default 'ar',
  preferred_calendar text not null default 'islamic-umalqura',
  created_at text not null,
  updated_at text not null
);

create table if not exists staff (
  id text primary key,
  tenant_id text not null references tenants(id),
  full_name text not null,
  full_name_ar text,
  email text,
  internal_role text not null,
  bar_number text,
  client_visible integer not null default 1,
  client_title text,
  client_title_ar text,
  is_active integer not null default 1,
  created_at text not null
);

create table if not exists client_users (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  client_id text not null references clients(id),
  tenant_id text not null references tenants(id),
  display_name text not null,
  display_name_ar text,
  job_title text,
  phone text,
  portal_role text not null default 'client_contact',
  status text not null default 'active',
  created_by_staff text,
  created_at text not null,
  updated_at text not null,
  unique (user_id, client_id)
);
create index if not exists client_users_user_idx on client_users(user_id);
create index if not exists client_users_client_idx on client_users(client_id);

-- The portal may never re-point an authorization binding.
-- (In production this is enforced twice more: portal_api has no INSERT grant
-- on client_users, and no UPDATE grant on user_id/client_id/tenant_id/
-- portal_role/status — see supabase/migrations/0004.)
create trigger if not exists client_users_binding_guard
  before update of user_id, client_id, tenant_id, portal_role, status on client_users
  begin select raise(ABORT, 'client_users binding is not writable from the portal'); end;

create table if not exists client_invitations (
  id text primary key,
  tenant_id text not null references tenants(id),
  client_id text not null references clients(id),
  email text not null collate nocase,
  display_name text not null,
  display_name_ar text,
  portal_role text not null default 'client_contact',
  token_hash text not null unique,
  token_hint text not null,
  expires_at text not null,
  accepted_at text,
  revoked_at text,
  created_by_staff text,
  accept_ip_hash text,
  created_at text not null
);
create index if not exists invitations_email_idx on client_invitations(email);

create trigger if not exists invitation_immutability
  before update of tenant_id, client_id, email, portal_role, token_hash on client_invitations
  begin select raise(ABORT, 'invitation binding is immutable'); end;

create table if not exists client_sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  tenant_id text,
  client_id text,
  token_hash text not null unique,
  created_at text not null,
  last_activity text not null,
  expires_at text not null,
  idle_expires_at text not null,
  ip_hash text,
  ip_country text,
  user_agent text,
  device_label text,
  browser text,
  os text,
  mfa_verified_at text,
  trusted_device_id text,
  revoked_at text,
  revoke_reason text
);
create index if not exists sessions_user_idx on client_sessions(user_id);

create table if not exists client_devices (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  fingerprint_hash text not null,
  label text,
  trusted_until text,
  mfa_trusted integer not null default 0,
  last_seen_at text not null,
  revoked_at text,
  created_at text not null,
  unique (user_id, fingerprint_hash)
);

create table if not exists login_attempts (
  id integer primary key autoincrement,
  email text collate nocase,
  user_id text,
  ip_hash text not null,
  user_agent text,
  outcome text not null,
  created_at text not null
);
create index if not exists login_attempts_ip_idx on login_attempts(ip_hash, created_at desc);
create index if not exists login_attempts_email_idx on login_attempts(email, created_at desc);

create table if not exists auth_tokens (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  kind text not null,
  token_hash text not null unique,
  code_hash text,
  expires_at text not null,
  used_at text,
  attempts integer not null default 0,
  created_ip_hash text,
  created_at text not null
);
create index if not exists auth_tokens_user_kind_idx on auth_tokens(user_id, kind, created_at desc);

create table if not exists mfa_recovery_codes (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  code_hash text not null,
  used_at text,
  created_at text not null,
  unique (user_id, code_hash)
);

create table if not exists security_alerts (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  tenant_id text,
  kind text not null,
  severity text not null default 'info',
  message text,
  message_ar text,
  ip_hash text,
  ip_country text,
  user_agent text,
  acknowledged_at text,
  created_at text not null
);
create index if not exists security_alerts_user_idx on security_alerts(user_id, created_at desc);

-- =========================== LEGAL DOMAIN =================================
create table if not exists matters (
  id text primary key,
  tenant_id text not null references tenants(id),
  client_id text not null references clients(id),
  matter_number text not null,
  case_number text,
  title text not null,
  title_ar text not null,
  practice_area text not null,
  practice_area_ar text not null,
  court text,
  court_ar text,
  internal_status text not null default 'intake',
  client_status text not null default 'opened',
  summary text,
  summary_ar text,
  opened_at text not null,
  closed_at text,
  last_client_update_at text,
  risk_rating text,
  conflict_cleared integer,
  internal_notes text,
  created_at text not null,
  updated_at text not null,
  unique (tenant_id, matter_number)
);
create index if not exists matters_client_idx on matters(client_id);

create table if not exists matter_team (
  id text primary key,
  matter_id text not null references matters(id) on delete cascade,
  tenant_id text not null references tenants(id),
  staff_id text not null references staff(id),
  matter_role text not null,
  client_visible integer not null default 1,
  client_role_label text,
  client_role_label_ar text,
  is_active integer not null default 1,
  created_at text not null,
  unique (matter_id, staff_id)
);
create index if not exists matter_team_matter_idx on matter_team(matter_id);

create table if not exists matter_timeline (
  id text primary key,
  matter_id text not null references matters(id) on delete cascade,
  tenant_id text not null references tenants(id),
  occurred_at text not null,
  event_type text not null,
  title text not null,
  title_ar text not null,
  description text,
  description_ar text,
  status text not null default 'complete',
  client_visible integer not null default 1,
  created_by_staff text,
  created_at text not null
);
create index if not exists timeline_matter_idx on matter_timeline(matter_id, occurred_at desc);

create table if not exists hearings (
  id text primary key,
  matter_id text not null references matters(id) on delete cascade,
  tenant_id text not null references tenants(id),
  client_id text not null references clients(id),
  scheduled_at text not null,
  ends_at text,
  court text not null,
  court_ar text not null,
  hearing_type text not null default 'session',
  location text,
  location_ar text,
  is_remote integer not null default 0,
  remote_platform text,
  remote_link text,
  internal_status text not null default 'scheduled',
  client_status text not null default 'upcoming',
  instructions text,
  instructions_ar text,
  client_visible integer not null default 1,
  created_at text not null,
  updated_at text not null
);
create index if not exists hearings_matter_idx on hearings(matter_id, scheduled_at);
create index if not exists hearings_client_idx on hearings(client_id, scheduled_at);

create table if not exists deadlines (
  id text primary key,
  matter_id text not null references matters(id) on delete cascade,
  tenant_id text not null references tenants(id),
  client_id text not null references clients(id),
  kind text not null check (kind in ('client_action','internal_task')),
  title text not null,
  title_ar text not null,
  description text,
  description_ar text,
  due_at text not null,
  priority text not null default 'normal',
  internal_status text not null default 'open',
  client_status text not null default 'open',
  assigned_staff_id text,
  internal_comment text,
  client_visible integer not null default 0,
  created_at text not null,
  updated_at text not null
);
create index if not exists deadlines_client_idx on deadlines(client_id, due_at);

create trigger if not exists deadline_lane_guard
  before insert on deadlines
  when new.kind = 'internal_task' and new.client_visible = 1
  begin select raise(ABORT, 'internal_task deadlines cannot be client_visible'); end;

create trigger if not exists deadline_lane_guard_upd
  before update on deadlines
  when new.kind = 'internal_task' and new.client_visible = 1
  begin select raise(ABORT, 'internal_task deadlines cannot be client_visible'); end;

-- Internal lawyer work product. The portal repository has no query against it.
create table if not exists internal_notes (
  id text primary key,
  tenant_id text not null references tenants(id),
  matter_id text not null references matters(id) on delete cascade,
  author_staff_id text not null references staff(id),
  note_type text not null default 'general',
  body text not null,
  is_privileged integer not null default 0,
  created_at text not null
);
create index if not exists internal_notes_matter_idx on internal_notes(matter_id);

create table if not exists message_threads (
  id text primary key,
  tenant_id text not null references tenants(id),
  matter_id text not null references matters(id) on delete cascade,
  client_id text not null references clients(id),
  subject text not null,
  subject_ar text not null,
  thread_status text not null default 'open',
  last_message_at text,
  created_at text not null
);
create index if not exists threads_client_idx on message_threads(client_id, last_message_at desc);

create table if not exists messages (
  id text primary key,
  thread_id text not null references message_threads(id) on delete cascade,
  tenant_id text not null references tenants(id),
  sender_kind text not null check (sender_kind in ('client','staff')),
  sender_user_id text,
  sender_staff_id text,
  sender_display_name text not null,
  body text not null,
  internal_flag integer not null default 0,
  internal_note text,
  created_at text not null,
  check ((sender_kind = 'client' and sender_user_id is not null)
      or (sender_kind = 'staff' and sender_staff_id is not null))
);
create index if not exists messages_thread_idx on messages(thread_id, created_at);

create trigger if not exists messages_immutable
  before update on messages
  begin select raise(ABORT, 'sent messages are immutable'); end;
create trigger if not exists messages_no_delete
  before delete on messages
  begin select raise(ABORT, 'sent messages cannot be deleted'); end;

create table if not exists message_reads (
  message_id text not null references messages(id) on delete cascade,
  reader_kind text not null,
  reader_id text not null,
  read_at text not null,
  primary key (message_id, reader_kind, reader_id)
);

create table if not exists message_attachments (
  id text primary key,
  message_id text not null references messages(id) on delete cascade,
  tenant_id text not null references tenants(id),
  document_id text,
  file_name text not null,
  size_bytes integer,
  created_at text not null
);

create table if not exists documents (
  id text primary key,
  tenant_id text not null references tenants(id),
  client_id text not null references clients(id),
  matter_id text references matters(id),
  storage_bucket text not null default 'client-documents',
  storage_key text not null unique,
  original_filename text not null,
  stored_filename text not null,
  title text not null,
  title_ar text,
  document_type text not null,
  category text not null default 'other',
  origin text not null check (origin in ('firm','client')),
  version integer not null default 1,
  mime_type text not null,
  size_bytes integer not null,
  sha256 text not null,
  scan_status text not null default 'pending',
  scan_result text,
  scanned_at text,
  status text not null default 'processing',
  client_visibility text not null default 'visible',
  requested integer not null default 0,
  request_note text,
  request_note_ar text,
  uploaded_by_user_id text,
  uploaded_by_staff_id text,
  created_at text not null,
  updated_at text not null
);
create index if not exists documents_client_idx on documents(client_id, created_at desc);
create index if not exists documents_matter_idx on documents(matter_id, created_at desc);

create trigger if not exists document_scan_guard
  before insert on documents
  when new.status = 'available' and new.scan_status <> 'clean'
  begin select raise(ABORT, 'document cannot be available before a clean malware scan'); end;
create trigger if not exists document_scan_guard_upd
  before update on documents
  when new.status = 'available' and new.scan_status <> 'clean'
  begin select raise(ABORT, 'document cannot be available before a clean malware scan'); end;

-- A client cannot re-point a document at another tenant/client/matter or path.
create trigger if not exists document_path_guard
  before update of storage_key, storage_bucket, tenant_id, client_id, matter_id, client_visibility on documents
  begin select raise(ABORT, 'document ownership and storage path are immutable'); end;

create table if not exists document_access_log (
  id integer primary key autoincrement,
  document_id text not null references documents(id) on delete cascade,
  tenant_id text not null,
  accessor_kind text not null,
  accessor_id text,
  action text not null,
  ip_hash text,
  created_at text not null
);
create index if not exists doc_access_doc_idx on document_access_log(document_id, created_at desc);

create table if not exists invoices (
  id text primary key,
  tenant_id text not null references tenants(id),
  client_id text not null references clients(id),
  matter_id text references matters(id),
  invoice_number text not null,
  issue_date text not null,
  due_date text not null,
  currency text not null default 'SAR',
  subtotal real not null check (subtotal >= 0),
  vat_rate real not null default 0.15,
  vat_amount real not null check (vat_amount >= 0),
  total real not null check (total >= 0),
  amount_paid real not null default 0 check (amount_paid >= 0),
  internal_status text not null default 'draft',
  client_status text,
  storage_key text,
  approved_by_staff text,
  approved_at text,
  notes_internal text,
  created_at text not null,
  updated_at text not null,
  unique (tenant_id, invoice_number)
);
create index if not exists invoices_client_idx on invoices(client_id, due_date);

create trigger if not exists invoice_paid_guard
  before update on invoices
  when new.amount_paid < old.amount_paid
  begin select raise(ABORT, 'invoice amount_paid cannot decrease outside a refund'); end;

create trigger if not exists invoice_overpay_guard
  before update on invoices
  when new.amount_paid > new.total
  begin select raise(ABORT, 'invoice cannot be overpaid without a credit record'); end;

-- client_status must be derived from internal_status, never asserted.
create trigger if not exists invoice_derive_guard
  before update of client_status on invoices
  when new.client_status is not null and new.client_status <> (
    case
      when new.internal_status = 'cancelled' then 'cancelled'
      when new.internal_status = 'written_off' then 'cancelled'
      when new.amount_paid >= new.total and new.total > 0 then 'paid'
      when new.amount_paid > 0 then 'partially_paid'
      when new.due_date < date('now') then 'overdue'
      else 'awaiting_payment'
    end)
  begin select raise(ABORT, 'client_status must be derived from internal_status'); end;

create table if not exists invoice_lines (
  id text primary key,
  invoice_id text not null references invoices(id) on delete cascade,
  position integer not null default 1,
  description text not null,
  description_ar text,
  quantity real not null default 1,
  unit_price real not null,
  amount real not null
);

create table if not exists payments (
  id text primary key,
  tenant_id text not null references tenants(id),
  invoice_id text not null references invoices(id),
  client_id text not null references clients(id),
  initiated_by_user_id text,
  provider text not null,
  provider_intent_id text,
  idempotency_key text unique,
  amount real not null check (amount > 0),
  currency text not null default 'SAR',
  status text not null default 'intent_created',
  receipt_number text,
  failure_reason text,
  webhook_received_at text,
  completed_at text,
  created_at text not null
);
create index if not exists payments_invoice_idx on payments(invoice_id, created_at desc);

create table if not exists receipts (
  id text primary key,
  tenant_id text not null references tenants(id),
  payment_id text not null unique references payments(id),
  invoice_id text not null references invoices(id),
  client_id text not null references clients(id),
  receipt_number text not null unique,
  issued_at text not null,
  amount real not null,
  currency text not null default 'SAR',
  storage_key text not null,
  created_at text not null
);

create table if not exists payment_webhook_events (
  id integer primary key autoincrement,
  provider text not null,
  event_id text not null,
  signature_valid integer not null default 0,
  payload_hash text not null,
  processed_at text,
  processing_error text,
  received_at text not null,
  unique (provider, event_id)
);

-- =========================== PORTAL DOMAIN ================================
create table if not exists appointment_types (
  id text primary key,
  tenant_id text not null references tenants(id),
  code text not null,
  label text not null,
  label_ar text not null,
  duration_min integer not null default 30,
  is_active integer not null default 1,
  unique (tenant_id, code)
);

create table if not exists appointments (
  id text primary key,
  tenant_id text not null references tenants(id),
  client_id text not null references clients(id),
  matter_id text references matters(id),
  requested_by_user_id text not null references users(id),
  type_id text references appointment_types(id),
  type_label text not null,
  type_label_ar text not null,
  preferred_date text not null,
  preferred_time text not null,
  preferred_mode text not null default 'in_person',
  client_note text,
  confirmed_at text,
  confirmed_staff_id text,
  rescheduled_from text,
  status text not null default 'requested',
  cancellation_reason text,
  cancelled_by text,
  created_at text not null,
  updated_at text not null
);
create index if not exists appointments_client_idx on appointments(client_id, created_at desc);

create trigger if not exists appointment_confirm_guard
  before update on appointments
  when old.status in ('confirmed','completed') and new.status = 'requested'
  begin select raise(ABORT, 'a confirmed appointment cannot revert to requested'); end;

create table if not exists notifications (
  id text primary key,
  tenant_id text not null references tenants(id),
  user_id text not null references users(id) on delete cascade,
  client_id text not null references clients(id),
  category text not null,
  severity text not null default 'info',
  title text not null,
  title_ar text not null,
  body text,
  body_ar text,
  link text,
  matter_id text,
  read_at text,
  emailed_at text,
  created_at text not null
);
create index if not exists notifications_user_idx on notifications(user_id, created_at desc);

create table if not exists notification_preferences (
  user_id text not null references users(id) on delete cascade,
  category text not null,
  in_app integer not null default 1,
  email integer not null default 1,
  locked integer not null default 0,
  updated_at text not null,
  primary key (user_id, category)
);

create trigger if not exists notif_pref_guard
  before update on notification_preferences
  when new.category = 'security' and (new.in_app = 0 or new.email = 0)
  begin select raise(ABORT, 'security notifications cannot be disabled'); end;

create table if not exists consent_records (
  id text primary key,
  tenant_id text not null references tenants(id),
  user_id text not null references users(id) on delete cascade,
  purpose text not null,
  consented integer not null,
  policy_version text not null,
  ip_hash text,
  recorded_at text not null
);

create table if not exists privacy_requests (
  id text primary key,
  tenant_id text not null references tenants(id),
  user_id text not null references users(id) on delete cascade,
  client_id text not null references clients(id),
  request_type text not null,
  details text,
  status text not null default 'submitted',
  retention_block integer not null default 0,
  resolution_note text,
  resolution_note_client text,
  reviewed_by_staff text,
  reviewed_at text,
  due_at text not null,
  created_at text not null,
  updated_at text not null
);
create index if not exists privacy_requests_user_idx on privacy_requests(user_id, created_at desc);

create table if not exists data_exports (
  id text primary key,
  tenant_id text not null references tenants(id),
  request_id text not null references privacy_requests(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  storage_key text not null,
  sha256 text not null,
  expires_at text not null,
  downloaded_at text,
  created_at text not null
);

-- =========================== AUDIT (append-only) ==========================
create table if not exists audit_events (
  id integer primary key autoincrement,
  occurred_at text not null,
  tenant_id text,
  actor_kind text not null,
  actor_user_id text,
  actor_client_id text,
  action text not null,
  resource_type text,
  resource_id text,
  outcome text not null default 'success',
  reason_code text,
  ip_hash text,
  ip_country text,
  user_agent text,
  request_id text,
  metadata text not null default '{}'
);
create index if not exists audit_tenant_time_idx on audit_events(tenant_id, occurred_at desc);
create index if not exists audit_actor_idx on audit_events(actor_user_id, occurred_at desc);
create index if not exists audit_denied_idx on audit_events(occurred_at desc) where outcome = 'denied';

create trigger if not exists audit_no_update
  before update on audit_events
  begin select raise(ABORT, 'audit_events is append-only'); end;
create trigger if not exists audit_no_delete
  before delete on audit_events
  begin select raise(ABORT, 'audit_events is append-only'); end;
`;
