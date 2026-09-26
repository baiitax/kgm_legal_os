/**
 * Response shapes, transcribed from the server's DTO projections.
 *
 * These are the ONLY fields the portal can ever receive: the server builds each
 * response field by field, so a type here that does not exist server-side would
 * simply always be `undefined`. Keeping the two in step is what makes
 * "the browser cannot ask for more" true in practice as well as in principle.
 */
import type { Calendar, Lang } from './client';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  displayNameAr: string | null;
  /**
   * The portal's ONLY role, and the portal's only privilege distinction:
   * `client_primary` holds the account (its money and its administration),
   * `client_contact` holds the work that account has shared with them.
   */
  portalRole: 'client_primary' | 'client_contact';
  jobTitle: string | null;
  /**
   * The client entity this session acts for — by NAME. `principal.clientIds`
   * stays server-side; the shell renders the name so the reader knows whose
   * behalf they are acting on, which is a question a portal serving corporate
   * clients has to answer in its own header.
   */
  clientName: string | null;
  clientNameAr: string | null;
}

export interface SessionResponse {
  authenticated: boolean;
  user?: SessionUser;
  preferences?: { language: Lang; calendar: Calendar };
  security?: {
    mfaEnabled: boolean;
    mfaVerified: boolean;
    emailVerified: boolean;
    sessionExpiresAt: string | null;
    remembered: boolean;
  };
}

export interface BootstrapResponse {
  product: { name: string; portal: string; portalAr: string };
  publicSignupEnabled: false;
  languages: Lang[];
  defaultLanguage: Lang;
  calendars: Calendar[];
  currency: string;
  passwordPolicy: {
    minLength: number;
    maxLength: number;
    requiresUppercase: boolean;
    requiresLowercase: boolean;
    requiresDigit: boolean;
    requiresSymbol: boolean;
    rejectsCommon: boolean;
    rejectsPersonalIdentifiers: boolean;
  };
  session: { absoluteTtlSeconds: number; idleTtlSeconds: number; rememberIdleTtlSeconds: number };
  mfa: { supported: string[]; planned: string[] };
  upload: { maxBytes: number; allowedExtensions: string[] };
  authenticated: boolean;
  demoMode: boolean;
}

export interface LoginResponse {
  step: 'authenticated' | 'mfa' | 'password_required' | 'email_unverified';
  csrfToken?: string;
  method?: string;
  maskedDestination?: string;
  expiresInMinutes?: number;
  user?: { id: string; email: string; displayName: string; displayNameAr: string | null };
  preferences?: { language: Lang; calendar: Calendar };
  redirectTo?: string;
}

/* ------------------------------------------------------------- dashboard -- */
export interface MatterSummary {
  id: string;
  matterNumber: string;
  caseNumber: string | null;
  title: string;
  titleAr: string;
  practiceArea: string;
  practiceAreaAr: string;
  court: string | null;
  courtAr: string | null;
  status: string;
  summary: string | null;
  summaryAr: string | null;
  openedAt: string | null;
  lastUpdated: string | null;
  nextHearing: string | null;
}

export interface Hearing {
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

export interface Deadline {
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

export interface DocumentRow {
  id: string;
  matterId: string | null;
  matterTitle: string | null;
  matterTitleAr: string | null;
  title: string;
  titleAr: string | null;
  documentType: string;
  category: string;
  origin: 'firm' | 'client';
  version: number;
  mimeType: string;
  sizeBytes: number;
  status: string;
  requested: boolean;
  requestNote: string | null;
  requestNoteAr: string | null;
  fileName: string;
  createdAt: string | null;
  available: boolean;
}

export interface Invoice {
  id: string;
  number: string;
  matterId: string;
  matterTitle: string;
  matterTitleAr: string;
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

export interface InvoiceLine {
  description: string;
  descriptionAr: string | null;
  quantity: number;
  unitPrice: string;
  amount: string;
}

export interface Payment {
  id: string;
  provider: string;
  amount: string;
  currency: string;
  status: string;
  receiptNumber: string | null;
  completedAt: string | null;
  createdAt: string | null;
}

export interface Receipt {
  id: string;
  number: string;
  issuedAt: string | null;
  amount: string;
  currency: string;
  paymentId: string;
}

export interface InvoiceDetail extends Invoice {
  lines: InvoiceLine[];
  payments: Payment[];
  receipt: Receipt | null;
  payable: boolean;
}

export interface Dashboard {
  greeting: { displayName: string; displayNameAr: string | null; firmName: string; firmNameAr: string | null };
  counts: {
    activeMatters: number;
    upcomingHearings: number;
    openDeadlines: number;
    unpaidInvoices: number;
    unreadNotifications: number;
  };
  outstandingBalance: { amount: string; currency: string };
  matters: MatterSummary[];
  upcomingHearings: Hearing[];
  deadlines: Deadline[];
  serverTime: string;
}

/* ---------------------------------------------------------------- matter -- */
export interface LegalTeamMember {
  name: string;
  nameAr: string | null;
  role: string;
  roleAr: string | null;
}

export interface TimelineEvent {
  id: string;
  occurredAt: string;
  eventType: string;
  title: string;
  titleAr: string;
  description: string | null;
  descriptionAr: string | null;
  status: string;
}

export interface MatterDetail extends MatterSummary {
  lifecycle: string[];
  legalTeam: LegalTeamMember[];
  timeline: TimelineEvent[];
  hearings: Hearing[];
  deadlines: Deadline[];
  documents: DocumentRow[];
  invoices: Invoice[];
  threads: Thread[];
}

/* -------------------------------------------------------------- messages -- */
export interface Thread {
  id: string;
  matterId: string;
  matterTitle: string;
  matterTitleAr: string;
  subject: string;
  subjectAr: string;
  status: string;
  lastMessageAt: string | null;
}

export interface Message {
  id: string;
  from: 'client' | 'firm';
  authorName: string;
  body: string;
  createdAt: string;
  read: boolean;
}

export interface ThreadDetail {
  thread: Thread;
  messages: Message[];
}

/* ----------------------------------------------------------- appointments -- */
export interface Appointment {
  id: string;
  matterId: string | null;
  matterTitle: string | null;
  matterTitleAr: string | null;
  typeLabel: string;
  typeLabelAr: string;
  preferredDate: string;
  preferredTime: string;
  preferredMode: 'in_person' | 'video' | 'phone';
  clientNote: string | null;
  confirmedAt: string | null;
  status: string;
  cancellationReason: string | null;
  cancelledBy: string | null;
  createdAt: string | null;
  canCancel: boolean;
}

export interface AppointmentType {
  id: string;
  code: string;
  label: string;
  labelAr: string;
  durationMinutes: number;
}

/* ---------------------------------------------------------- notifications -- */
export interface Notification {
  id: string;
  category: string;
  severity: string;
  title: string;
  titleAr: string;
  body: string | null;
  bodyAr: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationPreference {
  category: string;
  inApp: boolean;
  email: boolean;
  locked: boolean;
}

/* ---------------------------------------------------------------- profile -- */
export interface Profile {
  displayName: string;
  displayNameAr: string | null;
  jobTitle: string | null;
  email: string;
  emailMasked: string;
  phone: string | null;
  phoneMasked: string | null;
  preferredLanguage: Lang;
  preferredCalendar: Calendar;
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
  firm: { name: string; nameAr: string };
  lastLoginAt: string | null;
  memberSince: string | null;
}

/* --------------------------------------------------------------- security -- */
export interface SessionInfo {
  id: string;
  current: boolean;
  deviceLabel: string;
  browser: string;
  os: string;
  ipCountry: string | null;
  createdAt: string;
  lastActivity: string;
  expiresAt: string;
  mfaVerified: boolean;
}

export interface DeviceInfo {
  id: string;
  label: string;
  browser: string;
  os: string;
  trustedUntil: string | null;
  lastUsedAt: string | null;
}

export interface SecurityAlert {
  id: string;
  kind: string;
  message: string;
  messageAr: string | null;
  createdAt: string;
  severity: string;
}

export interface SecurityOverview {
  password: { lastChangedAt: string | null; ageDays: number | null; minLength: number };
  mfa: {
    enabled: boolean;
    method: string | null;
    enabledAt: string | null;
    availableMethods: string[];
    plannedMethods: string[];
  };
  sessions: SessionInfo[];
  devices: DeviceInfo[];
  alerts: SecurityAlert[];
  lastLoginAt: string | null;
  emailVerified: boolean;
  currentDeviceLabel: string;
}

/**
 * TOTP enrollment. The shared secret is returned ONCE, in this response only:
 * the server stores it encrypted with the master key and can never show it
 * again. Recovery codes work the same way (`showOnce`).
 */
export interface MfaEnrollStart {
  challengeToken: string;
  secret: string;
  otpauthUri: string;
  expiresInMinutes: number;
}

export interface MfaEnrollConfirm {
  enabled: boolean;
  recoveryCodes: string[];
  showOnce: true;
}

/* ---------------------------------------------------------------- privacy -- */
export interface PrivacyRequest {
  id: string;
  requestType: string;
  details: string | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ConsentRecord {
  purpose: string;
  consented: boolean;
  policyVersion: string;
  recordedAt: string;
}

export interface PrivacyOverview {
  requests: PrivacyRequest[];
  consents: ConsentRecord[];
  retention: {
    policyVersion: string;
    matterFileRetention: string;
    matterFileRetentionAr: string | null;
    deletionIsRequestOnly: boolean;
  };
}

/* ------------------------------------------------------------- invitation -- */
/**
 * What an invitation link may reveal BEFORE authentication: the address it was
 * sent to, the name the firm typed, and the firm. Deliberately nothing else —
 * in particular no client entity, which would let a leaked link be used to map
 * the firm's client list.
 */
export interface InvitePeek {
  email: string;
  displayName: string;
  displayNameAr: string | null;
  firmName: string;
  firmNameAr: string | null;
  expiresAt: string;
}
