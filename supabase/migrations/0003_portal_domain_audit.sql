-- ============================================================================
-- KGM LEGAL OS — CLIENT PORTAL
-- Migration 0003 · Appointments, notifications, privacy, audit
-- ============================================================================

-- ----------------------------------------------------------------------------
-- APPOINTMENTS  (§23)
-- ----------------------------------------------------------------------------
create table if not exists public.appointment_types (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete restrict,
  code          text not null,
  label         text not null,
  label_ar      text not null,
  duration_min  integer not null default 30,
  is_active     boolean not null default true,
  unique (tenant_id, code)
);

create table if not exists public.appointments (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  client_id         uuid not null references public.clients(id) on delete restrict,
  matter_id         uuid references public.matters(id) on delete set null,
  requested_by_user_id uuid not null references public.users(id) on delete restrict,
  type_id           uuid references public.appointment_types(id),
  type_label        text not null,
  type_label_ar     text not null,
  -- The client proposes; the firm disposes. These are *preferences*.
  preferred_date    date not null,
  preferred_time    time not null,
  preferred_mode    text not null default 'in_person'
                    check (preferred_mode in ('in_person','video','phone')),
  client_note       text,
  -- Firm-confirmed values. NULL until the firm acts; the client cannot write them.
  confirmed_at      timestamptz,
  confirmed_staff_id uuid references public.staff(id),
  rescheduled_from  timestamptz,
  status            text not null default 'requested' check (status in
                    ('requested','pending_confirmation','confirmed',
                     'rescheduled','completed','cancelled','declined')),
  cancellation_reason text,
  cancelled_by      text check (cancelled_by in ('client','firm','system')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists appointments_client_idx on public.appointments(client_id, created_at desc);

comment on column public.appointments.confirmed_at is
  'Firm-written only. A client PATCH touching this column is rejected (§23, §35 R11).';

-- Once confirmed, the client may not silently rewrite the appointment.
create or replace function public.guard_appointment_state()
returns trigger language plpgsql as $$
begin
  if old.status in ('confirmed','completed') and new.status = 'requested' then
    raise exception 'a confirmed appointment cannot revert to requested';
  end if;
  if old.status = 'completed' and new.status <> 'completed' then
    raise exception 'a completed appointment is terminal';
  end if;
  if old.confirmed_at is not null
     and (new.preferred_date <> old.preferred_date or new.preferred_time <> old.preferred_time)
     and new.rescheduled_from is null then
    raise exception 'changing a confirmed appointment requires a reschedule record';
  end if;
  return new;
end $$;

drop trigger if exists appointment_state_guard on public.appointments;
create trigger appointment_state_guard
  before update on public.appointments
  for each row execute function public.guard_appointment_state();

-- ----------------------------------------------------------------------------
-- NOTIFICATIONS  (§24)
-- ----------------------------------------------------------------------------
create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete restrict,
  user_id       uuid not null references public.users(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete restrict,
  category      text not null check (category in
                ('matter_update','hearing','deadline','document','invoice',
                 'payment','appointment','message','security','system')),
  severity      text not null default 'info' check (severity in ('info','action_required','urgent')),
  title         text not null,
  title_ar      text not null,
  body          text,
  body_ar       text,
  link          text,
  matter_id     uuid references public.matters(id) on delete cascade,
  read_at       timestamptz,
  emailed_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists notifications_user_idx on public.notifications(user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications(user_id)
  where read_at is null;

create table if not exists public.notification_preferences (
  user_id     uuid not null references public.users(id) on delete cascade,
  category    text not null check (category in
              ('matter_update','hearing','deadline','document','invoice',
               'payment','appointment','message','security','system')),
  in_app      boolean not null default true,
  email       boolean not null default true,
  -- Security notifications cannot be opted out of.
  locked      boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, category)
);

create or replace function public.guard_security_notifications()
returns trigger language plpgsql as $$
begin
  if new.category = 'security' and (new.in_app = false or new.email = false) then
    raise exception 'security notifications cannot be disabled';
  end if;
  return new;
end $$;

drop trigger if exists notif_pref_guard on public.notification_preferences;
create trigger notif_pref_guard
  before insert or update on public.notification_preferences
  for each row execute function public.guard_security_notifications();

-- ----------------------------------------------------------------------------
-- PRIVACY CENTER  (§27)
-- ----------------------------------------------------------------------------
create table if not exists public.consent_records (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete restrict,
  user_id       uuid not null references public.users(id) on delete cascade,
  purpose       text not null check (purpose in
                ('portal_access','marketing','analytics','document_delivery','sms_notifications')),
  consented     boolean not null,
  policy_version text not null,
  ip_hash       text,
  recorded_at   timestamptz not null default now()
);

create index if not exists consent_user_idx on public.consent_records(user_id, purpose, recorded_at desc);

-- Deletion is a REQUEST, never a self-service destructive action. Retention
-- obligations under Saudi law and matter files take precedence (§27).
create table if not exists public.privacy_requests (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  user_id           uuid not null references public.users(id) on delete cascade,
  client_id         uuid not null references public.clients(id) on delete restrict,
  request_type      text not null check (request_type in
                    ('access','rectification','erasure','portability','restriction','objection')),
  details           text,
  status            text not null default 'submitted' check (status in
                    ('submitted','under_review','retention_assessment','approved',
                     'partially_approved','rejected','completed','withdrawn')),
  retention_block   boolean not null default false,
  resolution_note   text,                    -- INTERNAL review note
  resolution_note_client text,               -- safe to show the requester
  reviewed_by_staff uuid references public.staff(id),
  reviewed_at       timestamptz,
  due_at            timestamptz not null default (now() + interval '30 days'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists privacy_requests_user_idx on public.privacy_requests(user_id, created_at desc);

create or replace function public.guard_privacy_request()
returns trigger language plpgsql as $$
begin
  -- A requester may not approve their own request or clear a retention block.
  if new.status in ('approved','partially_approved','rejected','completed')
     and new.reviewed_by_staff is null then
    raise exception 'privacy request resolution requires a staff reviewer';
  end if;
  if old.retention_block and not new.retention_block and new.reviewed_by_staff is null then
    raise exception 'a retention block can only be lifted by compliance review';
  end if;
  return new;
end $$;

drop trigger if exists privacy_request_guard on public.privacy_requests;
create trigger privacy_request_guard
  before update on public.privacy_requests
  for each row execute function public.guard_privacy_request();

create table if not exists public.data_exports (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete restrict,
  request_id    uuid not null references public.privacy_requests(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  storage_key   text not null,
  sha256        text not null,
  expires_at    timestamptz not null,          -- short-lived download
  downloaded_at timestamptz,
  created_at    timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- AUDIT  (§38) — APPEND ONLY
-- ----------------------------------------------------------------------------
create table if not exists public.audit_events (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  tenant_id     uuid,
  actor_kind    text not null check (actor_kind in ('client_user','staff','system','anonymous','webhook')),
  actor_user_id uuid,
  actor_client_id uuid,
  action        text not null check (action in
                -- authentication
                ('LOGIN','LOGIN_FAILED','LOGOUT','LOGOUT_ALL_OTHERS','SESSION_EXPIRED',
                 'SESSION_REVOKED','ACCOUNT_LOCKED','RATE_LIMITED',
                 -- credentials
                 'PASSWORD_RESET_REQUESTED','PASSWORD_RESET_COMPLETED','PASSWORD_CHANGED',
                 'EMAIL_VERIFICATION_SENT','EMAIL_VERIFIED',
                 'INVITATION_CREATED','INVITATION_ACCEPTED','INVITATION_EXPIRED','INVITATION_REVOKED',
                 -- mfa
                 'MFA_ENROLLMENT_STARTED','MFA_ENABLED','MFA_DISABLED','MFA_VERIFIED','MFA_FAILED',
                 'DEVICE_TRUSTED','DEVICE_UNTRUSTED',
                 -- documents
                 'DOCUMENT_VIEWED','DOCUMENT_DOWNLOADED','DOCUMENT_UPLOADED',
                 'DOCUMENT_UPLOAD_REJECTED','SIGNED_URL_ISSUED','DOCUMENT_ACCESS_DENIED',
                 -- financial
                 'INVOICE_VIEWED','PAYMENT_STARTED','PAYMENT_COMPLETED','PAYMENT_FAILED',
                 'RECEIPT_VIEWED','WEBHOOK_RECEIVED','WEBHOOK_SIGNATURE_INVALID',
                 -- communication
                 'MESSAGE_SENT','MESSAGE_READ','APPOINTMENT_REQUESTED','APPOINTMENT_CANCELLED',
                 -- account
                 'PROFILE_UPDATED','PREFERENCES_UPDATED','NOTIFICATION_READ',
                 'PRIVACY_REQUEST_SUBMITTED','CONSENT_RECORDED',
                 -- authorization failures (the important ones)
                 'AUTHZ_DENIED','TENANT_ISOLATION_VIOLATION','CLIENT_ISOLATION_VIOLATION',
                 'INTERNAL_RESOURCE_ACCESS_ATTEMPT','FIELD_TAMPER_ATTEMPT','MUTATION_DENIED')),
  resource_type text,
  resource_id   text,
  outcome       text not null default 'success' check (outcome in ('success','denied','failure','error')),
  reason_code   text,                          -- machine-readable, safe
  ip_hash       text,
  ip_country    text,
  user_agent    text,
  request_id    text,
  metadata      jsonb not null default '{}'::jsonb
);

create index if not exists audit_tenant_time_idx on public.audit_events(tenant_id, occurred_at desc);
create index if not exists audit_actor_idx       on public.audit_events(actor_user_id, occurred_at desc);
create index if not exists audit_action_idx      on public.audit_events(action, occurred_at desc);
create index if not exists audit_denied_idx      on public.audit_events(occurred_at desc)
  where outcome = 'denied';

comment on table public.audit_events is
  'Append-only security log. No UPDATE or DELETE is granted to the application role, and a trigger rejects any attempt. Metadata must never contain passwords, tokens, full IPs or unmasked national IDs.';

-- Hard immutability at the database layer (§35 R7).
create or replace function public.deny_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only: % is not permitted', tg_op;
end $$;

drop trigger if exists audit_no_update on public.audit_events;
create trigger audit_no_update
  before update or delete or truncate on public.audit_events
  for each statement execute function public.deny_audit_mutation();

-- Guard against secrets leaking into audit metadata.
create or replace function public.assert_audit_metadata_safe()
returns trigger language plpgsql as $$
declare k text;
begin
  foreach k in array array['password','password_hash','token','token_hash','secret',
                           'mfa_secret_enc','national_id','authorization','cookie',
                           'session_token','otp','code','cvv','card_number']
  loop
    if new.metadata ? k then
      raise exception 'audit metadata must not contain sensitive field: %', k;
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists audit_metadata_guard on public.audit_events;
create trigger audit_metadata_guard
  before insert on public.audit_events
  for each row execute function public.assert_audit_metadata_safe();

-- ----------------------------------------------------------------------------
-- updated_at maintenance
-- ----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'tenants','clients','users','client_users','matters','hearings','deadlines',
    'documents','invoices','appointments','privacy_requests','notification_preferences'
  ] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;
