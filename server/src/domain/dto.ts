/**
 * CLIENT DTOs (§37).
 *
 * Every function here builds a response object by NAMING the fields it copies.
 * Nothing spreads a database row. That is deliberate: a projection that
 * `...row` would leak `internal_notes`, `risk_rating` or `notes_internal` the
 * moment someone adds a column, and the leak would be invisible in review.
 *
 * A field that is not listed here cannot reach the browser, and on Postgres it
 * cannot even be read — migration 0004 revokes the SELECT grant.
 */
import type { Row } from '../db/types.js';
import { toBool, toIso, toMoney, toStr } from '../db/types.js';
import { maskEmail, maskNationalId, maskPhone } from '../lib/crypto.js';

const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

// ---------------------------------------------------------------------------
export interface MatterSummaryDto {
  id: string;
  matterNumber: string;
  caseNumber: string | null;
  title: string;
  titleAr: string;
  practiceArea: string;
  practiceAreaAr: string;
  court: string | null;
  courtAr: string | null;
  /** The client-safe lifecycle only (§13). */
  status: string;
  summary: string | null;
  summaryAr: string | null;
  openedAt: string | null;
  lastUpdated: string | null;
  nextHearing: string | null;
}

export function matterSummary(r: Row, nextHearing?: string | null): MatterSummaryDto {
  return {
    id: String(r.id),
    matterNumber: String(r.matter_number),
    caseNumber: toStr(r.case_number),
    title: String(r.title),
    titleAr: String(r.title_ar),
    practiceArea: String(r.practice_area),
    practiceAreaAr: String(r.practice_area_ar),
    court: toStr(r.court),
    courtAr: toStr(r.court_ar),
    status: String(r.client_status),
    summary: toStr(r.summary),
    summaryAr: toStr(r.summary_ar),
    openedAt: toIso(r.opened_at),
    lastUpdated: toIso(r.last_client_update_at),
    nextHearing: nextHearing ?? null,
  };
}

// ---------------------------------------------------------------------------
export interface LegalTeamMemberDto {
  name: string;
  nameAr: string | null;
  role: string;
  roleAr: string | null;
}

export function teamMember(r: Row): LegalTeamMemberDto {
  return {
    name: String(r.full_name),
    nameAr: toStr(r.full_name_ar),
    role: toStr(r.client_role_label) ?? String(r.matter_role),
    roleAr: toStr(r.client_role_label_ar),
  };
}

export interface TimelineEventDto {
  id: string;
  occurredAt: string;
  eventType: string;
  title: string;
  titleAr: string;
  description: string | null;
  descriptionAr: string | null;
  status: string;
}

export function timelineEvent(r: Row): TimelineEventDto {
  return {
    id: String(r.id),
    occurredAt: toIso(r.occurred_at) ?? new Date().toISOString(),
    eventType: String(r.event_type),
    title: String(r.title),
    titleAr: String(r.title_ar),
    description: toStr(r.description),
    descriptionAr: toStr(r.description_ar),
    status: String(r.status),
  };
}

// ---------------------------------------------------------------------------
export interface HearingDto {
  id: string;
  matterId: string;
  matterTitle: string;
  matterTitleAr: string;
  caseNumber: string | null;
  scheduledAt: string;
  endsAt: string | null;
  court: string;
  courtAr: string;
  hearingType: string;
  location: string | null;
  locationAr: string | null;
  isRemote: boolean;
  remotePlatform: string | null;
  remoteLink: string | null;
  status: string;
  instructions: string | null;
  instructionsAr: string | null;
}

export function hearing(r: Row): HearingDto {
  return {
    id: String(r.id),
    matterId: String(r.matter_id),
    matterTitle: toStr(r.matter_title) ?? '',
    matterTitleAr: toStr(r.matter_title_ar) ?? '',
    caseNumber: toStr(r.case_number),
    scheduledAt: toIso(r.scheduled_at) ?? new Date().toISOString(),
    endsAt: toIso(r.ends_at),
    court: String(r.court),
    courtAr: String(r.court_ar),
    hearingType: String(r.hearing_type),
    location: toStr(r.location),
    locationAr: toStr(r.location_ar),
    isRemote: toBool(r.is_remote),
    remotePlatform: toStr(r.remote_platform),
    remoteLink: toStr(r.remote_link),
    status: String(r.client_status),
    instructions: toStr(r.instructions),
    instructionsAr: toStr(r.instructions_ar),
  };
}

// ---------------------------------------------------------------------------
export interface DeadlineDto {
  id: string;
  matterId: string;
  matterTitle: string;
  matterTitleAr: string;
  title: string;
  titleAr: string;
  description: string | null;
  descriptionAr: string | null;
  dueAt: string;
  priority: string;
  status: string;
  overdue: boolean;
  daysRemaining: number | null;
}

const OPEN_STATES = new Set(['open', 'in_progress']);

export function deadline(r: Row, now = Date.now()): DeadlineDto {
  const due = toIso(r.due_at) ?? new Date(now).toISOString();
  const msLeft = new Date(due).getTime() - now;
  const status = String(r.client_status);
  const stillOpen = OPEN_STATES.has(status);
  return {
    id: String(r.id),
    matterId: String(r.matter_id),
    matterTitle: toStr(r.matter_title) ?? '',
    matterTitleAr: toStr(r.matter_title_ar) ?? '',
    title: String(r.title),
    titleAr: String(r.title_ar),
    description: toStr(r.description),
    descriptionAr: toStr(r.description_ar),
    dueAt: due,
    priority: String(r.priority),
    status,
    overdue: stillOpen && msLeft < 0,
    daysRemaining: stillOpen ? Math.ceil(msLeft / 86_400_000) : null,
  };
}

// ---------------------------------------------------------------------------
export interface DocumentDto {
  id: string;
  matterId: string | null;
  matterTitle: string | null;
  matterTitleAr: string | null;
  title: string;
  titleAr: string | null;
  documentType: string;
  category: string;
  origin: string;
  version: number;
  mimeType: string;
  sizeBytes: number;
  status: string;
  requested: boolean;
  requestNote: string | null;
  requestNoteAr: string | null;
  fileName: string;
  createdAt: string | null;
  /** Present only when the caller may actually fetch the bytes. */
  available: boolean;
}

export function document(r: Row): DocumentDto {
  const status = String(r.status);
  const scan = String(r.scan_status);
  return {
    id: String(r.id),
    matterId: toStr(r.matter_id),
    matterTitle: toStr(r.matter_title),
    matterTitleAr: toStr(r.matter_title_ar),
    title: String(r.title),
    titleAr: toStr(r.title_ar),
    documentType: String(r.document_type),
    category: String(r.category),
    origin: String(r.origin),
    version: Number(r.version ?? 1),
    mimeType: String(r.mime_type),
    sizeBytes: Number(r.size_bytes ?? 0),
    status,
    requested: toBool(r.requested),
    requestNote: toStr(r.request_note),
    requestNoteAr: toStr(r.request_note_ar),
    fileName: String(r.original_filename ?? 'document'),
    createdAt: toIso(r.created_at),
    available: status === 'available' && scan === 'clean',
  };
}

// ---------------------------------------------------------------------------
export interface InvoiceDto {
  id: string;
  number: string;
  matterId: string | null;
  matterTitle: string | null;
  matterTitleAr: string | null;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: string;
  vatRate: number;
  vatAmount: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  status: string;
}

export function invoice(r: Row): InvoiceDto {
  const total = toMoney(r.total);
  const paid = toMoney(r.amount_paid);
  const balance = Math.max(0, Number(total) - Number(paid));
  return {
    id: String(r.id),
    number: String(r.invoice_number),
    matterId: toStr(r.matter_id),
    matterTitle: toStr(r.matter_title),
    matterTitleAr: toStr(r.matter_title_ar),
    issueDate: String(r.issue_date).slice(0, 10),
    dueDate: String(r.due_date).slice(0, 10),
    currency: String(r.currency ?? 'SAR'),
    subtotal: toMoney(r.subtotal),
    vatRate: Number(r.vat_rate ?? 0.15),
    vatAmount: toMoney(r.vat_amount),
    total,
    amountPaid: paid,
    balanceDue: balance.toFixed(2),
    status: String(r.client_status),
  };
}

export interface InvoiceLineDto {
  description: string;
  descriptionAr: string | null;
  quantity: number;
  unitPrice: string;
  amount: string;
}

export function invoiceLine(r: Row): InvoiceLineDto {
  return {
    description: String(r.description),
    descriptionAr: toStr(r.description_ar),
    quantity: Number(r.quantity ?? 1),
    unitPrice: toMoney(r.unit_price),
    amount: toMoney(r.amount),
  };
}

export interface PaymentDto {
  id: string;
  provider: string;
  amount: string;
  currency: string;
  status: string;
  receiptNumber: string | null;
  completedAt: string | null;
  createdAt: string | null;
}

export function payment(r: Row): PaymentDto {
  return {
    id: String(r.id),
    provider: String(r.provider),
    amount: toMoney(r.amount),
    currency: String(r.currency ?? 'SAR'),
    // Only terminal, client-meaningful states are exposed; provider internals
    // and failure_reason stay server-side.
    status: ['succeeded', 'failed', 'processing', 'refunded'].includes(String(r.status))
      ? String(r.status)
      : 'processing',
    receiptNumber: toStr(r.receipt_number),
    completedAt: toIso(r.completed_at),
    createdAt: toIso(r.created_at),
  };
}

export interface ReceiptDto {
  id: string;
  number: string;
  issuedAt: string | null;
  amount: string;
  currency: string;
  paymentId: string;
}

export function receipt(r: Row): ReceiptDto {
  return {
    id: String(r.id),
    number: String(r.receipt_number),
    issuedAt: toIso(r.issued_at),
    amount: toMoney(r.amount),
    currency: String(r.currency ?? 'SAR'),
    paymentId: String(r.payment_id),
  };
}

// ---------------------------------------------------------------------------
export interface ThreadDto {
  id: string;
  matterId: string;
  matterTitle: string;
  matterTitleAr: string;
  subject: string;
  subjectAr: string;
  status: string;
  lastMessageAt: string | null;
}

export function thread(r: Row): ThreadDto {
  return {
    id: String(r.id),
    matterId: String(r.matter_id),
    matterTitle: toStr(r.matter_title) ?? '',
    matterTitleAr: toStr(r.matter_title_ar) ?? '',
    subject: String(r.subject),
    subjectAr: String(r.subject_ar),
    status: String(r.thread_status),
    lastMessageAt: toIso(r.last_message_at),
  };
}

export interface MessageDto {
  id: string;
  from: 'client' | 'firm';
  authorName: string;
  body: string;
  createdAt: string;
  read: boolean;
}

export function message(r: Row): MessageDto {
  return {
    id: String(r.id),
    from: r.sender_kind === 'client' ? 'client' : 'firm',
    authorName: String(r.sender_display_name),
    body: String(r.body),
    createdAt: toIso(r.created_at) ?? new Date().toISOString(),
    read: toBool(r.read_by_me),
  };
}

// ---------------------------------------------------------------------------
export interface AppointmentDto {
  id: string;
  matterId: string | null;
  matterTitle: string | null;
  matterTitleAr: string | null;
  typeLabel: string;
  typeLabelAr: string;
  preferredDate: string;
  preferredTime: string;
  preferredMode: string;
  clientNote: string | null;
  confirmedAt: string | null;
  status: string;
  cancellationReason: string | null;
  cancelledBy: string | null;
  createdAt: string | null;
  canCancel: boolean;
}

export function appointment(r: Row): AppointmentDto {
  const status = String(r.status);
  return {
    id: String(r.id),
    matterId: toStr(r.matter_id),
    matterTitle: toStr(r.matter_title),
    matterTitleAr: toStr(r.matter_title_ar),
    typeLabel: String(r.type_label),
    typeLabelAr: String(r.type_label_ar),
    preferredDate: String(r.preferred_date).slice(0, 10),
    preferredTime: String(r.preferred_time).slice(0, 5),
    preferredMode: String(r.preferred_mode),
    clientNote: toStr(r.client_note),
    confirmedAt: toIso(r.confirmed_at),
    status,
    cancellationReason: toStr(r.cancellation_reason),
    cancelledBy: toStr(r.cancelled_by),
    createdAt: toIso(r.created_at),
    // A confirmed appointment requires firm involvement to change (§23).
    canCancel: status === 'requested' || status === 'pending_confirmation',
  };
}

export interface AppointmentTypeDto {
  id: string;
  code: string;
  label: string;
  labelAr: string;
  durationMinutes: number;
}

export function appointmentType(r: Row): AppointmentTypeDto {
  return {
    id: String(r.id),
    code: String(r.code),
    label: String(r.label),
    labelAr: String(r.label_ar),
    durationMinutes: Number(r.duration_min ?? 30),
  };
}

// ---------------------------------------------------------------------------
export interface NotificationDto {
  id: string;
  category: string;
  severity: string;
  title: string;
  titleAr: string;
  body: string | null;
  bodyAr: string | null;
  link: string | null;
  read: boolean;
  createdAt: string | null;
}

export function notification(r: Row): NotificationDto {
  return {
    id: String(r.id),
    category: String(r.category),
    severity: String(r.severity ?? 'info'),
    title: String(r.title),
    titleAr: String(r.title_ar),
    body: toStr(r.body),
    bodyAr: toStr(r.body_ar),
    link: toStr(r.link),
    read: Boolean(r.read_at),
    createdAt: toIso(r.created_at),
  };
}

export interface NotificationPreferenceDto {
  category: string;
  inApp: boolean;
  email: boolean;
  locked: boolean;
}

export function notificationPreference(r: Row): NotificationPreferenceDto {
  return {
    category: String(r.category),
    inApp: toBool(r.in_app),
    email: toBool(r.email),
    locked: toBool(r.locked),
  };
}

// ---------------------------------------------------------------------------
/**
 * PROFILE (§25). Sensitive identity values are masked here, at the projection
 * boundary — not in the UI. The unmasked values are not in this process at all.
 */
export interface ProfileDto {
  displayName: string;
  displayNameAr: string | null;
  jobTitle: string | null;
  email: string;
  emailMasked: string;
  phone: string | null;
  phoneMasked: string | null;
  preferredLanguage: 'ar' | 'en';
  preferredCalendar: 'islamic-umalqura' | 'gregory';
  emailVerified: boolean;
  mfaEnabled: boolean;
  mfaMethod: string | null;
  client: {
    name: string;
    nameAr: string | null;
    type: string;
    nationalIdMasked: string | null;
    commercialRegMasked: string | null;
    addressLine: string | null;
    city: string | null;
    country: string;
    identityVerified: boolean;
    verificationNote: string | null;
  };
  firm: {
    name: string;
    nameAr: string;
  };
  lastLoginAt: string | null;
  memberSince: string | null;
}

export function profile(input: {
  user: Row;
  clientUser: Row;
  client: Row;
  tenant: Row | undefined;
}): ProfileDto {
  const email = String(input.user.email);
  const phone = toStr(input.client.phone) ?? toStr(input.clientUser.phone);
  return {
    displayName: String(input.clientUser.display_name),
    displayNameAr: toStr(input.clientUser.display_name_ar),
    jobTitle: toStr(input.clientUser.job_title),
    email,
    // The client sees their own address in full (they need it) but the masked
    // form is what any secondary surface must use (§25).
    emailMasked: maskEmail(email) ?? email,
    phone,
    phoneMasked: maskPhone(phone),
    preferredLanguage: input.user.preferred_language === 'en' ? 'en' : 'ar',
    preferredCalendar: input.user.preferred_calendar === 'gregory' ? 'gregory' : 'islamic-umalqura',
    emailVerified: Boolean(input.user.email_verified_at),
    mfaEnabled: toBool(input.user.mfa_enabled),
    mfaMethod: toStr(input.user.mfa_method),
    client: {
      name: String(input.client.name),
      nameAr: toStr(input.client.name_ar),
      type: String(input.client.client_type),
      // Masked at the projection boundary. The plaintext is never in this
      // process: only the masked string and a keyed hash exist in the database.
      nationalIdMasked: maskNationalId(toStr(input.client.national_id_masked)),
      commercialRegMasked: maskNationalId(toStr(input.client.commercial_reg_masked)),
      addressLine: toStr(input.client.address_line),
      city: toStr(input.client.city),
      country: String(input.client.country ?? 'SA'),
      identityVerified: toBool(input.client.identity_verified),
      verificationNote: toStr(input.client.verification_note),
    },
    firm: {
      name: input.tenant ? String(input.tenant.name) : '',
      nameAr: input.tenant ? String(input.tenant.name_ar) : '',
    },
    lastLoginAt: toIso(input.user.last_login_at),
    memberSince: toIso(input.clientUser.created_at),
  };
}

// ---------------------------------------------------------------------------
export interface SessionDto {
  id: string;
  current: boolean;
  deviceLabel: string;
  browser: string;
  os: string | null;
  ipCountry: string | null;
  createdAt: string | null;
  lastActivity: string | null;
  expiresAt: string | null;
  mfaVerified: boolean;
}

export function session(r: {
  id: string; current: boolean; deviceLabel: string; browser: string;
  os: string | null; ipCountry: string | null; createdAt: string | null;
  lastActivity: string | null; expiresAt: string | null; mfaVerifiedAt: string | null;
}): SessionDto {
  return {
    id: r.id,
    current: r.current,
    deviceLabel: r.deviceLabel,
    browser: r.browser,
    os: r.os,
    // Only a coarse country is exposed — never an address (§7).
    ipCountry: r.ipCountry,
    createdAt: r.createdAt,
    lastActivity: r.lastActivity,
    expiresAt: r.expiresAt,
    mfaVerified: Boolean(r.mfaVerifiedAt),
  };
}

export interface DeviceDto {
  id: string;
  label: string;
  mfaTrusted: boolean;
  trustedUntil: string | null;
  lastSeenAt: string | null;
  revoked: boolean;
}

export function device(r: {
  id: string; label: string | null; mfaTrusted: boolean; trustedUntil: string | null;
  lastSeenAt: string | null; revokedAt: string | null;
}): DeviceDto {
  return {
    id: r.id,
    label: r.label ?? 'Device',
    mfaTrusted: r.mfaTrusted,
    trustedUntil: r.trustedUntil,
    lastSeenAt: r.lastSeenAt,
    revoked: Boolean(r.revokedAt),
  };
}

export interface SecurityAlertDto {
  id: string;
  kind: string;
  severity: string;
  message: string | null;
  messageAr: string | null;
  ipCountry: string | null;
  acknowledged: boolean;
  createdAt: string | null;
}

export function securityAlert(r: Row): SecurityAlertDto {
  return {
    id: String(r.id),
    kind: String(r.kind),
    severity: String(r.severity ?? 'info'),
    message: toStr(r.message),
    messageAr: toStr(r.message_ar),
    ipCountry: toStr(r.ip_country),
    acknowledged: Boolean(r.acknowledged_at),
    createdAt: toIso(r.created_at),
  };
}

export interface PrivacyRequestDto {
  id: string;
  requestType: string;
  details: string | null;
  status: string;
  retentionBlock: boolean;
  resolutionNote: string | null;
  reviewedAt: string | null;
  dueAt: string | null;
  createdAt: string | null;
  canWithdraw: boolean;
}

export function privacyRequest(r: Row): PrivacyRequestDto {
  const status = String(r.status);
  return {
    id: String(r.id),
    requestType: String(r.request_type),
    details: toStr(r.details),
    status,
    retentionBlock: toBool(r.retention_block),
    // resolution_note (the internal review note) is never projected; only the
    // client-facing summary is.
    resolutionNote: toStr(r.resolution_note_client),
    reviewedAt: toIso(r.reviewed_at),
    dueAt: toIso(r.due_at),
    createdAt: toIso(r.created_at),
    canWithdraw: status === 'submitted',
  };
}

export interface ConsentDto {
  purpose: string;
  consented: boolean;
  policyVersion: string;
  recordedAt: string | null;
}

export function consent(r: Row): ConsentDto {
  return {
    purpose: String(r.purpose),
    consented: toBool(r.consented),
    policyVersion: String(r.policy_version),
    recordedAt: toIso(r.recorded_at),
  };
}

export const dto = { s };
