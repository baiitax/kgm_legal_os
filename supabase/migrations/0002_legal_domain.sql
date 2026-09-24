-- ============================================================================
-- KGM LEGAL OS — CLIENT PORTAL
-- Migration 0002 · Legal practice domain
--
-- THE PROJECTION PRINCIPLE (§11, §13, §22, §37)
--   The portal is a *controlled projection* of firm data, not a mirror of it.
--   That boundary is expressed structurally, not by convention:
--
--     a) Matters carry BOTH internal_status and client_status. The portal API
--        reads client_status only. Internal workflow states (conflict_check,
--        partner_review, restricted) have no client-side representation.
--     b) Client-facing deadlines carry kind='client_action'. Internal lawyer
--        tasks carry kind='internal_task' and client_visible=false. They are
--        different rows in a different logical lane, never filtered UI-side.
--     c) internal_notes is a SEPARATE TABLE from messages. There is no column,
--        flag or join that can turn an internal note into a client message.
--     d) Financial state transitions are only reachable from a validated
--        provider webhook, never from a client-writable column.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STAFF (internal actors — referenced by the portal, never exposed to it)
-- ----------------------------------------------------------------------------
create table if not exists public.staff (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  full_name         text not null,
  full_name_ar      text,
  email             citext,
  internal_role     text not null check (internal_role in
                    ('managing_partner','partner','lawyer','paralegal',
                     'finance','compliance','admin')),
  bar_number        text,
  -- §11: controls whether this person may be *named* to a client at all.
  client_visible    boolean not null default true,
  client_title      text,                        -- e.g. "Senior Associate"
  client_title_ar   text,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now()
);

create index if not exists staff_tenant_idx on public.staff(tenant_id);

comment on table public.staff is
  'Internal firm personnel. The portal may only ever read full_name/client_title of rows where client_visible=true. internal_role is never serialized to a client.';

-- ----------------------------------------------------------------------------
-- MATTERS
-- ----------------------------------------------------------------------------
create table if not exists public.matters (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  client_id         uuid not null references public.clients(id) on delete restrict,
  matter_number     text not null,
  case_number       text,
  title             text not null,
  title_ar          text not null,
  practice_area     text not null,
  practice_area_ar  text not null,
  court             text,
  court_ar          text,
  -- INTERNAL lifecycle. Never serialized to a client.
  internal_status   text not null default 'intake' check (internal_status in
                    ('intake','conflict_check','restricted','internal_review',
                     'partner_review','active','on_hold','judgment','execution',
                     'closed','archived')),
  -- CLIENT-SAFE lifecycle (§13). This is the only status the portal may read.
  client_status     text not null default 'opened' check (client_status in
                    ('opened','under_review','hearings','judgment','execution','closed')),
  summary           text,
  summary_ar        text,
  opened_at         timestamptz not null default now(),
  closed_at         timestamptz,
  last_client_update_at timestamptz,
  -- INTERNAL ONLY — the projection layer must never select these columns.
  risk_rating       text check (risk_rating in ('low','medium','high','critical')),
  conflict_cleared  boolean,
  internal_notes    text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, matter_number)
);

create index if not exists matters_client_idx on public.matters(client_id);
create index if not exists matters_tenant_idx on public.matters(tenant_id);

comment on column public.matters.risk_rating   is 'INTERNAL. Excluded from every client DTO.';
comment on column public.matters.conflict_cleared is 'INTERNAL. Excluded from every client DTO.';
comment on column public.matters.internal_notes is 'INTERNAL. Excluded from every client DTO.';

-- ----------------------------------------------------------------------------
-- MATTER TEAM (who the client is allowed to see)
-- ----------------------------------------------------------------------------
create table if not exists public.matter_team (
  id            uuid primary key default gen_random_uuid(),
  matter_id     uuid not null references public.matters(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete restrict,
  staff_id      uuid not null references public.staff(id)   on delete restrict,
  matter_role   text not null check (matter_role in
                ('lead_partner','lead_lawyer','associate','paralegal',
                 'finance_contact','compliance_contact')),
  -- §11: a compliance or finance actor is on the matter but is NOT shown.
  client_visible boolean not null default true,
  client_role_label    text,
  client_role_label_ar text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (matter_id, staff_id)
);

create index if not exists matter_team_matter_idx on public.matter_team(matter_id);

-- ----------------------------------------------------------------------------
-- TIMELINE  (client-safe events only)
-- ----------------------------------------------------------------------------
create table if not exists public.matter_timeline (
  id            uuid primary key default gen_random_uuid(),
  matter_id     uuid not null references public.matters(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete restrict,
  occurred_at   timestamptz not null,
  event_type    text not null check (event_type in
                ('matter_opened','documents_received','hearing_scheduled',
                 'hearing_held','submission_filed','status_update','judgment',
                 'execution_started','matter_closed','note')),
  title         text not null,
  title_ar      text not null,
  description   text,
  description_ar text,
  status        text not null default 'complete'
                check (status in ('complete','in_progress','upcoming')),
  -- Only rows with client_visible=true are eligible for the portal projection.
  client_visible boolean not null default true,
  created_by_staff uuid,
  created_at    timestamptz not null default now()
);

create index if not exists timeline_matter_idx
  on public.matter_timeline(matter_id, occurred_at desc);
create index if not exists timeline_client_visible_idx
  on public.matter_timeline(matter_id) where client_visible = true;

-- ----------------------------------------------------------------------------
-- HEARINGS
-- ----------------------------------------------------------------------------
create table if not exists public.hearings (
  id                uuid primary key default gen_random_uuid(),
  matter_id         uuid not null references public.matters(id) on delete cascade,
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  client_id         uuid not null references public.clients(id) on delete restrict,
  scheduled_at      timestamptz not null,
  ends_at           timestamptz,
  court             text not null,
  court_ar          text not null,
  hearing_type      text not null default 'session'
                    check (hearing_type in ('session','mediation','arbitration','expert','enforcement')),
  location          text,
  location_ar       text,
  is_remote         boolean not null default false,
  remote_platform   text,
  remote_link       text,               -- released to client only when client_visible
  internal_status   text not null default 'scheduled'
                    check (internal_status in ('draft','scheduled','postponed','held','cancelled','internal_prep')),
  client_status     text not null default 'upcoming'
                    check (client_status in ('upcoming','postponed','held','cancelled')),
  instructions      text,
  instructions_ar   text,
  client_visible    boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists hearings_matter_idx   on public.hearings(matter_id, scheduled_at);
create index if not exists hearings_client_idx   on public.hearings(client_id, scheduled_at);
create index if not exists hearings_upcoming_idx on public.hearings(scheduled_at)
  where client_visible = true and client_status = 'upcoming';

-- ----------------------------------------------------------------------------
-- DEADLINES  (two lanes in one table, structurally separated)
-- ----------------------------------------------------------------------------
create table if not exists public.deadlines (
  id                uuid primary key default gen_random_uuid(),
  matter_id         uuid not null references public.matters(id) on delete cascade,
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  client_id         uuid not null references public.clients(id) on delete restrict,
  -- THE LANE. internal_task rows are invisible to the portal by construction.
  kind              text not null check (kind in ('client_action','internal_task')),
  title             text not null,
  title_ar          text not null,
  description       text,
  description_ar    text,
  due_at            timestamptz not null,
  priority          text not null default 'normal'
                    check (priority in ('low','normal','high','critical')),
  internal_status   text not null default 'open'
                    check (internal_status in ('open','in_progress','blocked','done','overdue','cancelled')),
  client_status     text not null default 'open'
                    check (client_status in ('open','in_progress','submitted','completed','overdue','cancelled')),
  -- Internal task assignment must never leak (§16).
  assigned_staff_id uuid references public.staff(id) on delete set null,
  internal_comment  text,
  client_visible    boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists deadlines_client_idx on public.deadlines(client_id, due_at);
create index if not exists deadlines_portal_idx on public.deadlines(client_id, due_at)
  where kind = 'client_action' and client_visible = true;

-- An internal task can never be projected to a client, even if a flag is flipped.
create or replace function public.assert_deadline_lane()
returns trigger language plpgsql as $$
begin
  if new.kind = 'internal_task' and new.client_visible then
    raise exception 'internal_task deadlines cannot be client_visible';
  end if;
  if new.kind = 'internal_task' and (new.assigned_staff_id is not null or new.internal_comment is not null)
     and new.client_visible then
    raise exception 'internal assignment metadata cannot be exposed';
  end if;
  return new;
end $$;

drop trigger if exists deadline_lane_guard on public.deadlines;
create trigger deadline_lane_guard
  before insert or update on public.deadlines
  for each row execute function public.assert_deadline_lane();

-- ----------------------------------------------------------------------------
-- INTERNAL NOTES  (§11, §22 — deliberately a separate model from messages)
-- ----------------------------------------------------------------------------
create table if not exists public.internal_notes (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete restrict,
  matter_id     uuid not null references public.matters(id) on delete cascade,
  author_staff_id uuid not null references public.staff(id) on delete restrict,
  note_type     text not null default 'general'
                check (note_type in ('general','strategy','conflict','aml',
                                     'risk','financial','compliance','privileged')),
  body          text not null,
  is_privileged boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists internal_notes_matter_idx on public.internal_notes(matter_id);

comment on table public.internal_notes is
  'Lawyer work product. NO client_visibility column exists on this table: exposure is not configurable, it is structurally impossible. The portal repository has no SELECT grant on it.';

-- ----------------------------------------------------------------------------
-- MESSAGES  (client ↔ firm)
-- ----------------------------------------------------------------------------
create table if not exists public.message_threads (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete restrict,
  matter_id     uuid not null references public.matters(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete restrict,
  subject       text not null,
  subject_ar    text not null,
  thread_status text not null default 'open'
                check (thread_status in ('open','awaiting_client','awaiting_firm','closed')),
  last_message_at timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists threads_client_idx on public.message_threads(client_id, last_message_at desc);

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  thread_id       uuid not null references public.message_threads(id) on delete cascade,
  tenant_id       uuid not null references public.tenants(id) on delete restrict,
  -- sender_kind decides which of the two nullable author columns applies.
  sender_kind     text not null check (sender_kind in ('client','staff')),
  sender_user_id  uuid references public.users(id)  on delete set null,
  sender_staff_id uuid references public.staff(id)  on delete set null,
  sender_display_name text not null,
  body            text not null,
  -- Internal-only annotations on a message. Never serialized to a client.
  internal_flag   boolean not null default false,
  internal_note   text,
  created_at      timestamptz not null default now(),
  constraint messages_sender_check check (
    (sender_kind = 'client' and sender_user_id is not null) or
    (sender_kind = 'staff'  and sender_staff_id is not null)
  )
);

create index if not exists messages_thread_idx on public.messages(thread_id, created_at);

create table if not exists public.message_reads (
  message_id  uuid not null references public.messages(id) on delete cascade,
  reader_kind text not null check (reader_kind in ('client','staff')),
  reader_id   uuid not null,
  read_at     timestamptz not null default now(),
  primary key (message_id, reader_kind, reader_id)
);

create table if not exists public.message_attachments (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references public.messages(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete restrict,
  document_id uuid references public.documents(id) on delete set null,
  file_name   text not null,
  size_bytes  bigint,
  created_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- DOCUMENTS  (§17, §18, §19)
-- ----------------------------------------------------------------------------
create table if not exists public.documents (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  client_id         uuid not null references public.clients(id) on delete restrict,
  matter_id         uuid references public.matters(id) on delete set null,
  -- Server-generated. A client NEVER supplies or influences this value (§35 R10).
  storage_bucket    text not null default 'client-documents',
  storage_key       text not null unique,
  original_filename text not null,
  stored_filename   text not null,
  title             text not null,
  title_ar          text,
  document_type     text not null check (document_type in
                    ('firm_letter','court_document','signed_document','contract',
                     'evidence','invoice','receipt','client_upload','identity',
                     'correspondence','other')),
  category          text not null default 'other' check (category in
                    ('from_firm','requested','uploaded','signed','court','financial')),
  origin            text not null check (origin in ('firm','client')),
  version           integer not null default 1,
  mime_type         text not null,
  size_bytes        bigint not null,
  sha256            text not null,
  -- Malware scan gate (§19). A document is not readable until scan_status='clean'.
  scan_status       text not null default 'pending'
                    check (scan_status in ('pending','scanning','clean','infected','error')),
  scan_result       text,
  scanned_at        timestamptz,
  status            text not null default 'processing'
                    check (status in ('processing','available','rejected','archived','purged')),
  -- THE VISIBILITY GATE. 'internal' rows are unreachable from the portal.
  client_visibility text not null default 'visible'
                    check (client_visibility in ('visible','restricted','internal')),
  requested         boolean not null default false,
  request_note      text,
  request_note_ar   text,
  uploaded_by_user_id  uuid references public.users(id) on delete set null,
  uploaded_by_staff_id uuid references public.staff(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists documents_client_idx on public.documents(client_id, created_at desc);
create index if not exists documents_matter_idx on public.documents(matter_id, created_at desc);
create index if not exists documents_portal_idx on public.documents(client_id)
  where client_visibility = 'visible' and status = 'available' and scan_status = 'clean';

-- A rejected/infected/internal document can never become downloadable by
-- flipping a single column in isolation.
create or replace function public.assert_document_readable()
returns trigger language plpgsql as $$
begin
  if new.status = 'available' and new.scan_status <> 'clean' then
    raise exception 'document cannot be available before a clean malware scan';
  end if;
  if new.client_visibility = 'internal' and new.origin = 'client' then
    raise exception 'client-originated documents cannot be marked internal-only';
  end if;
  return new;
end $$;

drop trigger if exists document_readable_guard on public.documents;
create trigger document_readable_guard
  before insert or update on public.documents
  for each row execute function public.assert_document_readable();

create table if not exists public.document_access_log (
  id            bigint generated always as identity primary key,
  document_id   uuid not null references public.documents(id) on delete cascade,
  tenant_id     uuid not null,
  accessor_kind text not null check (accessor_kind in ('client','staff','system')),
  accessor_id   uuid,
  action        text not null check (action in ('signed_url_issued','viewed','downloaded','upload_completed','access_denied')),
  ip_hash       text,
  created_at    timestamptz not null default now()
);

create index if not exists doc_access_doc_idx on public.document_access_log(document_id, created_at desc);

-- ----------------------------------------------------------------------------
-- INVOICES & PAYMENTS  (§20, §21)
-- ----------------------------------------------------------------------------
create table if not exists public.invoices (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete restrict,
  client_id         uuid not null references public.clients(id) on delete restrict,
  matter_id         uuid references public.matters(id) on delete set null,
  invoice_number    text not null,
  issue_date        date not null,
  due_date          date not null,
  currency          text not null default 'SAR' check (currency in ('SAR')),
  subtotal          numeric(14,2) not null check (subtotal >= 0),
  vat_rate          numeric(5,4) not null default 0.1500,
  vat_amount        numeric(14,2) not null check (vat_amount >= 0),
  total             numeric(14,2) not null check (total >= 0),
  amount_paid       numeric(14,2) not null default 0 check (amount_paid >= 0),
  -- INTERNAL lifecycle. Draft / pending_internal_approval are never projected.
  internal_status   text not null default 'draft' check (internal_status in
                    ('draft','pending_internal_approval','approved','sent',
                     'partially_paid','paid','overdue','cancelled','written_off')),
  -- CLIENT-SAFE lifecycle (§20). The portal reads this column only.
  client_status     text not null default 'awaiting_payment' check (client_status in
                    ('awaiting_payment','partially_paid','paid','overdue','cancelled')),
  storage_key       text,                     -- rendered PDF, private bucket
  approved_by_staff uuid references public.staff(id),
  approved_at       timestamptz,
  notes_internal    text,                     -- INTERNAL ONLY
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, invoice_number)
);

create index if not exists invoices_client_idx on public.invoices(client_id, due_date);
create index if not exists invoices_matter_idx on public.invoices(matter_id);

comment on column public.invoices.notes_internal is 'INTERNAL financial commentary. Excluded from every client DTO.';

create table if not exists public.invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references public.invoices(id) on delete cascade,
  position      integer not null default 1,
  description   text not null,
  description_ar text,
  quantity      numeric(10,2) not null default 1,
  unit_price    numeric(14,2) not null,
  amount        numeric(14,2) not null
);

-- §20/§35 R6: a client user may NEVER drive an invoice status change.
-- The only permitted writers are (a) firm staff via Internal Firm OS and
-- (b) the payment webhook path below. Enforced by trigger + RLS in 0004.
create or replace function public.guard_invoice_state()
returns trigger language plpgsql as $$
begin
  -- Financial state may only move forward through defined transitions, and
  -- amount_paid may only increase via a recorded payment.
  if new.amount_paid < old.amount_paid then
    raise exception 'invoice amount_paid cannot decrease outside a refund record';
  end if;
  if new.amount_paid > new.total then
    raise exception 'invoice cannot be overpaid without a credit record';
  end if;
  -- client_status must be derived, never independently asserted.
  if new.client_status <> public.derive_invoice_client_status(new.internal_status, new.amount_paid, new.total, new.due_date) then
    raise exception 'client_status must be derived from internal_status, not set directly';
  end if;
  return new;
end $$;

create or replace function public.derive_invoice_client_status(
  p_internal text, p_paid numeric, p_total numeric, p_due date
) returns text language sql immutable as $$
  select case
    when p_internal in ('draft','pending_internal_approval') then null  -- not projected at all
    when p_internal = 'cancelled'  then 'cancelled'
    when p_internal = 'written_off' then 'cancelled'
    when p_paid >= p_total and p_total > 0 then 'paid'
    when p_paid > 0 then 'partially_paid'
    when p_due < current_date then 'overdue'
    else 'awaiting_payment'
  end;
$$;

drop trigger if exists invoice_state_guard on public.invoices;
create trigger invoice_state_guard
  before update on public.invoices
  for each row execute function public.guard_invoice_state();

create table if not exists public.payments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete restrict,
  invoice_id          uuid not null references public.invoices(id) on delete restrict,
  client_id           uuid not null references public.clients(id) on delete restrict,
  initiated_by_user_id uuid references public.users(id) on delete set null,
  provider            text not null check (provider in ('mada','apple_pay','visa','mastercard','bank_transfer','sadad','manual')),
  provider_intent_id  text,
  idempotency_key     text unique,             -- webhook replay protection
  amount              numeric(14,2) not null check (amount > 0),
  currency            text not null default 'SAR',
  status              text not null default 'intent_created' check (status in
                      ('intent_created','processing','succeeded','failed','refunded','cancelled')),
  receipt_number      text,
  failure_reason      text,                    -- provider code, never shown raw to client
  webhook_received_at timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists payments_invoice_idx on public.payments(invoice_id, created_at desc);
create index if not exists payments_intent_idx  on public.payments(provider_intent_id);

comment on table public.payments is
  'The ONLY writer of invoice.amount_paid and the ONLY legitimate path to a paid status. Browser-driven state changes are rejected at the API, domain and database layers.';

create table if not exists public.receipts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete restrict,
  payment_id    uuid not null unique references public.payments(id) on delete restrict,
  invoice_id    uuid not null references public.invoices(id) on delete restrict,
  client_id     uuid not null references public.clients(id) on delete restrict,
  receipt_number text not null unique,
  issued_at     timestamptz not null default now(),
  amount        numeric(14,2) not null,
  currency      text not null default 'SAR',
  storage_key   text not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.payment_webhook_events (
  id                bigint generated always as identity primary key,
  provider          text not null,
  event_id          text not null,
  signature_valid   boolean not null default false,
  payload_hash      text not null,
  processed_at      timestamptz,
  processing_error  text,
  received_at       timestamptz not null default now(),
  unique (provider, event_id)               -- replay protection
);
