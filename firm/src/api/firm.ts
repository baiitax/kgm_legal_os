/**
 * FIRM OS API CLIENT.
 *
 * THIS IS NOT SHARED WITH THE CLIENT PORTAL, and that is deliberate rather than
 * duplication for its own sake. The two products have different cookies,
 * different CSRF headers, different audiences and different ideas of who the
 * caller is. A shared client would have to parameterize all of that, and a
 * parameter that selects an authorization universe is a parameter that can be
 * passed the wrong value. Two clients that each know exactly one door is a
 * boundary; one client that knows two is a convention.
 *
 * WHAT THIS FILE OWNS
 *   - The firm CSRF double-submit: read `kgm_firm_csrf`, echo it in
 *     `x-csrf-token`. The session cookie is httpOnly and never touched here.
 *   - One retry on a stale CSRF token. The token is bound to a session, so after
 *     a tenant switch or a revocation the browser holds a stale value and the
 *     server answers 403 `csrf_failed` while issuing a fresh one. Surfacing that
 *     as a failure would be wrong; retrying once is correct.
 *   - Error normalization into `FirmApiError`.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *   - It never sends identity. No tenant id, no membership id, no role, no
 *     permission. Every one of those is resolved server-side from the session
 *     cookie on every request. A client that could state who it is would be a
 *     client that could state who it wants to be.
 *   - It never widens a projection. There is no `?fields=` or `?include=`
 *     parameter builder here, because §57's whole premise is that the server
 *     decides which fields exist in a response.
 *   - It does not cache. A cached matter could outlive a restriction placed on
 *     it mid-session, which is exactly the case the server revokes for.
 */

export type Lang = 'ar' | 'en';
export type Calendar = 'islamic-umalqura' | 'gregory';

export const FIRM_CSRF_COOKIE = 'kgm_firm_csrf';
export const FIRM_CSRF_HEADER = 'x-csrf-token';

/** The API envelope. `ok(res, data)` on success, `{ok:false,error}` on failure. */
interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export class FirmApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>, requestId?: string) {
    super(message);
    this.name = 'FirmApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /**
   * True when the server refused because the resource is not visible to this
   * member. §27/§72: the API answers 404 for both "not yours" and "does not
   * exist", and the UI must NOT translate that into "empty" — see EmptyState's
   * `denied` kind. This helper exists so screens can pick the right copy without
   * each one re-deriving the rule.
   */
  get isNotVisible(): boolean {
    return this.status === 404;
  }

  /** True when the member lacks the permission, as opposed to the resource. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** True when the action needs a second factor this session has not proven. */
  get needsMfa(): boolean {
    return this.status === 403 && this.details?.step === 'mfa';
  }

  /** True when the member must enrol in MFA before a critical action. */
  get needsMfaEnrolment(): boolean {
    return this.status === 403 && this.details?.step === 'enroll_mfa';
  }

  /** True when a financial ceiling refused the action (§10, §73). */
  get isCeilingExceeded(): boolean {
    return this.status === 403 && this.code === 'authority_ceiling_exceeded';
  }
}

/** Reads a cookie by name. Returns null when absent. */
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const parts = document.cookie ? document.cookie.split(';') : [];
  for (const part of parts) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

/** The CSRF token the server last issued, or null. */
export function firmCsrfToken(): string | null {
  return readCookie(FIRM_CSRF_COOKIE);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Skip the CSRF header. Only correct for GET, which the server does not check. */
  signal?: AbortSignal;
}

const API_BASE = '/api/firm';

/**
 * Performs one request.
 *
 * Retries exactly once on a stale CSRF token, re-reading the cookie the server
 * just refreshed. Any second failure is a real error and is thrown.
 */
async function request<T>(path: string, opts: RequestOptions = {}, isRetry = false): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  // CSRF is required on every state-changing method. Attaching it to GET too is
  // harmless and means no code path has to decide whether a route is "safe".
  const token = firmCsrfToken();
  if (token) headers[FIRM_CSRF_HEADER] = token;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      // The browser must not cache an authorization-bearing response. A cached
      // matter list could outlive a restriction placed on one of its rows.
      cache: 'no-store',
    });
  } catch (err) {
    // A network failure is not an authorization failure and must not be rendered
    // as "no data". §46's error state exists for this.
    if ((err as Error).name === 'AbortError') throw err;
    throw new FirmApiError(0, 'network_error', 'Unable to reach the server');
  }

  const requestId = res.headers.get('x-request-id') ?? undefined;

  // 204 and empty bodies.
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: Envelope<T> | null = null;
  if (text) {
    try { parsed = JSON.parse(text) as Envelope<T>; }
    catch { parsed = null; }
  }

  if (res.ok && parsed?.ok && parsed.data !== undefined) return parsed.data;
  if (res.ok && parsed?.ok) return undefined as T;

  const code = parsed?.error?.code ?? 'unknown';
  const message = parsed?.error?.message ?? res.statusText ?? 'Request failed';
  const details = parsed?.error?.details;

  // One retry on a stale CSRF token. The server issues a fresh cookie alongside
  // the 403, so re-reading it is enough.
  if (!isRetry && res.status === 403 && code === 'csrf_failed' && method !== 'GET') {
    return request<T>(path, opts, true);
  }

  throw new FirmApiError(res.status, code, message, details, requestId);
}

/** Mints the anonymous CSRF token the login form needs before it can post. */
export async function bootstrapCsrf(): Promise<void> {
  await request<{ issued: boolean }>('/auth/csrf');
}

// ==========================================================================
// SESSION (§52)
// ==========================================================================

export interface PrincipalRole { code: string; name: string; nameAr: string; }
export interface PrincipalDepartment { code: string; name: string; nameAr: string; isLead: boolean; }

/** Numeric ceilings. `null` means NO authority — never unlimited (§10). */
export interface AuthorityCeilings {
  financialSar: number | null;
  writeoffSar: number | null;
  discountPct: number | null;
}

export interface FirmMember {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  displayNameAr: string | null;
  jobTitle: string | null;
  jobTitleAr: string | null;
  roles: PrincipalRole[];
  departments: PrincipalDepartment[];
  practiceAreas: string[];
  firmWideScope: boolean;
  /** The resolved permission codes. The navigation is generated from this. */
  permissions: string[];
  ceilings: AuthorityCeilings;
}

/**
 * One firm the signed-in user holds an active membership in (§ multi-tenancy).
 *
 * The field names are the server's, not a tidied version of them: `tenantName`
 * rather than `name`, `tenantId` rather than `id`. Renaming them here would mean
 * a mapping layer that has to be kept in sync with two endpoints, and a drift in
 * that layer fails as `undefined` in the switcher rather than as a type error.
 *
 * `jobTitle` is PER TENANT. The same person can hold different standing at
 * different firms, so the switcher shows the title alongside the firm name — a
 * switcher that lists only firm names hides which role you are about to assume.
 */
export interface TenantRef {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly tenantName: string;
  readonly tenantNameAr: string | null;
  readonly jobTitle: string | null;
  readonly jobTitleAr: string | null;
}

/**
 * The ACTIVE tenant, as returned by GET /session.
 *
 * A different, smaller shape from TenantRef — the server narrows it to
 * {id, slug, name} for the single active firm. Both types are declared rather
 * than unified because they genuinely differ on the wire, and one interface with
 * optional fields would let a caller read `tenant.tenantName` off the active
 * tenant and get undefined at runtime with no type error to warn them.
 */
export interface ActiveTenantRef {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface FirmSessionPayload {
  member: FirmMember;
  preferences: { language: string; calendar: string };
  security: {
    mfaEnabled: boolean;
    mfaVerified: boolean;
    sessionExpiresAt: string | null;
    remembered: boolean;
  };
  tenants: TenantRef[];
  activeTenantId: string;
  /** Present on /session only. */
  settings?: {
    displayName: string | null;
    displayNameAr: string | null;
    brandKey: string | null;
    timezone: string | null;
    currency: string | null;
    vatRate: number | null;
    mfaRequired: boolean;
    sessionIdleMinutes: number | null;
  } | null;
  tenant?: ActiveTenantRef | null;
}

export interface LoginResult {
  step: 'authenticated' | 'mfa';
  csrfToken?: string;
  method?: string;
  maskedDestination?: string;
  expiresInMinutes?: number;
  member?: FirmMember;
  preferences?: FirmSessionPayload['preferences'];
  security?: FirmSessionPayload['security'];
  tenants?: TenantRef[];
  activeTenantId?: string;
}

export const firmApi = {
  /** Restores an existing session on load. 401 means "not signed in". */
  async session(): Promise<FirmSessionPayload> {
    return request<FirmSessionPayload>('/session');
  },

  async login(email: string, password: string, remember = false): Promise<LoginResult> {
    return request<LoginResult>('/auth/login', {
      method: 'POST',
      body: { email, password, remember },
    });
  },

  async verifyMfa(code: string, remember = false): Promise<LoginResult> {
    return request<LoginResult>('/auth/mfa/verify', { method: 'POST', body: { code, remember } });
  },

  async logout(): Promise<void> {
    await request('/auth/logout', { method: 'POST' });
  },

  async switchTenant(tenantId: string): Promise<LoginResult> {
    return request<LoginResult>('/session/switch', { method: 'POST', body: { tenantId } });
  },

  async devices(): Promise<{ sessions: FirmDevice[] }> {
    return request('/session/devices');
  },

  async revokeAllSessions(): Promise<{ revoked: number }> {
    return request('/session/revoke-all', { method: 'POST' });
  },

  // ---- matters (§17, §18, §57) ------------------------------------------

  async matters(): Promise<MatterListResponse> {
    return request<MatterListResponse>('/matters');
  },

  async matter(id: string): Promise<MatterDetail> {
    return request<MatterDetail>(`/matters/${encodeURIComponent(id)}`);
  },

  // ---- administration (§49-§51) -----------------------------------------

  /**
   * Members and the tenant's role catalogue in one call.
   *
   * `roles` is not an optional extra: the assign-role picker needs it, and
   * fetching it separately would allow the picker and the member row to disagree
   * about what is assignable.
   */
  async members(): Promise<{ count: number; members: FirmMemberRow[]; roles: FirmRoleRow[] }> {
    return request('/admin/members');
  },

  async audit(params: { action?: string; limit?: number } = {}): Promise<{ count: number; events: AuditEvent[] }> {
    const qs = new URLSearchParams();
    if (params.action) qs.set('action', params.action);
    if (params.limit) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/admin/audit${suffix}`);
  },

  /**
   * Full tenant settings (§49).
   *
   * NOT the same shape as the session payload's `settings` field, which carries
   * only the seven values the shell needs to render branding and session policy.
   * This returns all fifteen, including support contacts, VAT, fiscal year and
   * password policy. Typing it as the session subset would silently discard
   * eight real fields at compile time while still sending them over the wire.
   */
  async settings(): Promise<TenantSettings> {
    return request<TenantSettings>('/admin/settings');
  },

  // ---- administration mutations (§49, §72) --------------------------------

  /**
   * Changes a membership's status. Suspended sessions die with the change, so
   * the authorization graph and any live browser tab cannot disagree.
   *
   * The server refuses to let an admin change their OWN status, and requires MFA
   * when the tenant does. Both surface as ordinary errors here — the UI must not
   * pre-empt them by disabling controls, because the rules live server-side and
   * a stale client-side guess is how people learn the interface lies.
   */
  async setMemberStatus(
    membershipId: string,
    status: 'active' | 'suspended' | 'deactivated' | 'left',
  ): Promise<{ membershipId: string; status: string }> {
    return request(`/admin/members/${encodeURIComponent(membershipId)}/status`, {
      method: 'POST',
      body: { status },
    });
  },

  /**
   * Grants or revokes a role. This is THE privilege-escalation endpoint, so it is
   * gated on permission + MFA + same-tenant target + the role existing in this
   * tenant. Nothing about the caller's own roles is taken from the request.
   */
  async setMemberRole(
    membershipId: string,
    roleCode: string,
    revoke = false,
  ): Promise<{ membershipId: string; roleCode: string; revoked: boolean }> {
    return request(`/admin/members/${encodeURIComponent(membershipId)}/roles`, {
      method: 'POST',
      body: { roleCode, revoke },
    });
  },
};

// ==========================================================================
// RESPONSE SHAPES
//
// Transcribed from the server's projections rather than inferred, because these
// are the contract. A field the server withholds under §57 is ABSENT here, not
// nullable — which is what makes the `withheld` array meaningful.
// ==========================================================================

export type MatterAccessLevel =
  | 'full' | 'edit' | 'operational' | 'view' | 'financial' | 'compliance';

export interface MatterSummary {
  id: string;
  matterNumber: string | null;
  title: string | null;
  titleAr: string | null;
  practiceArea: string | null;
  practiceAreaAr: string | null;
  clientName: string | null;
  clientNameAr: string | null;
  openedAt: string | null;
  clientStatus: string | null;
  /** Authorization facts, not classified fields. */
  restricted: boolean;
  accessLevel: MatterAccessLevel;
}

export interface MatterListResponse {
  count: number;
  scope: { practiceAreas: string[]; firmWide: boolean };
  matters: MatterSummary[];
}

/**
 * The §57 projection.
 *
 * Classified fields are OPTIONAL, not nullable. That distinction is the entire
 * mechanism: `riskRating: null` means "no rating recorded", an absent
 * `riskRating` means "not for you", and `withheld` says which. Rendering both as
 * an empty cell is how a classification system becomes decorative.
 */
export interface MatterDetail {
  // public
  id?: string;
  matterNumber?: string | null;
  caseNumber?: string | null;
  title?: string | null;
  titleAr?: string | null;
  practiceArea?: string | null;
  practiceAreaAr?: string | null;
  clientName?: string | null;
  clientNameAr?: string | null;
  openedAt?: string | null;
  clientStatus?: string | null;
  // internal
  internalStatus?: string | null;
  court?: string | null;
  courtAr?: string | null;
  summary?: string | null;
  summaryAr?: string | null;
  closedAt?: string | null;
  // confidential
  riskRating?: string | null;
  internalNotes?: string | null;
  // compliance
  conflictCleared?: boolean | number | null;
  // restricted (also needs the matters.restrict permission)
  restrictionReason?: string | null;
  restrictionReasonAr?: string | null;

  // Authorization facts — always present.
  accessLevel: MatterAccessLevel;
  restricted: boolean;
  teamRole: string | null;
  department: string | null;

  /** Wire names withheld by classification. Drives the §57 field locks. */
  withheld: string[];
}

export interface FirmDevice {
  id: string;
  deviceLabel: string | null;
  userAgent: string | null;
  ipCountry: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  sessionExpiresAt: string | null;
  mfaVerified: boolean;
  current: boolean;
}

/**
 * One row of the administration member list (§49).
 *
 * CORRECTED AGAINST A LIVE RESPONSE, NOT INFERRED.
 *
 * The first draft of this interface declared `roles`, `departments`,
 * `practiceAreas` and `mfaEnabled`. The endpoint sends none of them: those
 * belong to the SESSION payload, which describes the caller's own resolved
 * authority, whereas this list describes other people's membership records. The
 * two look similar enough to conflate, and nothing fails loudly when you do —
 * a table renders, and four columns are permanently empty.
 *
 * The endpoint does send `staffId`, `internalRole`, `jobTitleAr` and
 * `clientVisible`, which the draft omitted entirely.
 *
 * Note what is deliberately ABSENT rather than nullable: there is no
 * `permissions` array here. Member-level authority is resolved per request on
 * the server; a cached copy in a list response would be a second source of
 * truth that could disagree with it.
 */
export interface FirmMemberRow {
  membershipId: string;
  userId: string;
  staffId: string;
  email: string;
  displayName: string;
  displayNameAr: string | null;
  /** Directory role, e.g. PARTNER / LAWYER. Distinct from the RBAC roles table. */
  internalRole: string | null;
  jobTitle: string | null;
  jobTitleAr: string | null;
  /** active | suspended | deactivated | left */
  status: string;
  /** Whether this member may appear in the client portal's team projection. */
  clientVisible: boolean;
  ceilings: AuthorityCeilings;
}

/**
 * A role definition in the tenant's RBAC catalogue.
 *
 * Returned ALONGSIDE the member list by `/admin/members` rather than by a second
 * call: assigning a role needs the set of assignable codes, and fetching it
 * separately would leave a window where the picker and the member row disagree.
 */
export interface FirmRoleRow {
  id: string;
  code: string;
  name: string;
  nameAr: string;
  description: string | null;
  /** System roles cannot be deleted or have their permissions edited. */
  isSystem: boolean;
  isActive: boolean;
}

/**
 * Tenant settings as returned by `/admin/settings` (§49).
 *
 * Transcribed from a live response. The seven fields that overlap with the
 * session payload's `settings` are a deliberate subset of these fifteen — the
 * shell needs branding and session policy, an administrator needs all of it.
 */
export interface TenantSettings {
  tenantId: string;
  displayName: string | null;
  displayNameAr: string | null;
  brandKey: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  timezone: string;
  currency: string;
  /** Stored as a fraction: 0.15, not 15. */
  vatRate: number;
  /** 1-12. Saudi firms commonly run a non-January fiscal year. */
  fiscalYearStartMonth: number;
  notificationChannels: string[];
  mfaRequired: boolean;
  passwordMinLength: number;
  sessionAbsoluteMinutes: number;
  sessionIdleMinutes: number;
}

/**
 * One append-only audit row (§51).
 *
 * Field names are the server's, verified against a live response rather than
 * inferred from the schema: the timestamp is `occurredAt`, not `createdAt`, and
 * the actor is `actorUserId`, not `actorId`. An audit screen is the one place
 * where a wrong field name is actively dangerous — it renders as a blank column,
 * and a blank column in an audit log reads as "nothing happened" rather than as
 * "this field is misnamed".
 *
 * There is no `id`. The server does not expose the row primary key, which is
 * correct: an audit UI has no legitimate operation that needs one, since rows
 * cannot be updated or deleted.
 *
 * `metadata` is intentionally untyped. Its shape varies per action — a login
 * records roles and MFA state, an escalation records the method and target
 * audience — and inventing a union here would be a second place to update every
 * time an action is added. Screens that render it read specific keys defensively.
 */
export interface AuditEvent {
  readonly occurredAt: string;
  readonly tenantId: string;
  readonly actorKind: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly outcome: string;
  readonly reasonCode: string | null;
  readonly metadata: Record<string, unknown> | null;
}
