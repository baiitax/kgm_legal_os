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

  /*
    A FORM BODY SETS ITS OWN CONTENT-TYPE. `multipart/form-data` is only valid with the
    boundary the browser generates, so setting the header here would produce a body the
    server cannot parse — the failure looks like "no file was provided" on a request that
    plainly had one. Everything else is JSON, which is what the rest of the API speaks.
  */
  const multipart = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  if (opts.body !== undefined && !multipart) headers['content-type'] = 'application/json';

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
      body: opts.body === undefined ? undefined
        : (multipart ? (opts.body as FormData) : JSON.stringify(opts.body)),
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

  /**
   * The dashboard's counts.
   *
   * Every field is `null`-able and the null is MEANINGFUL: it means the member
   * does not hold the permission for that card, and the screen must render no
   * card rather than a zero. The endpoint returns `withheld` alongside so the
   * page can tell "nothing to show you" from "nothing happened".
   */
  async dashboardSummary(): Promise<DashboardSummary> {
    return request<DashboardSummary>('/dashboard/summary');
  },

  // ---- matters (§17, §18, §57) ------------------------------------------

  async matters(): Promise<MatterListResponse> {
    return request<MatterListResponse>('/matters');
  },

  async matter(id: string): Promise<MatterDetail> {
    return request<MatterDetail>(`/matters/${encodeURIComponent(id)}`);
  },

  /*
    ── THE LIFECYCLE WRITES ──────────────────────────────────────────────────
    Gap analysis III, §2.3: eleven matter routes and no screen. These are four of
    them, and they are the four a firm uses every week — a matter moves through
    its states, gets restricted when a conflict surfaces, and gets opened to the
    people who will work it.

    Each of these can refuse with a REASON the server computed, not a validation
    message: `conflict_gate` (Rule 11 — the matter may not leave conflict_check),
    `cdd_incomplete` (the client has not been identified) and `eligibility` (the
    member's licence is suspended) all arrive as `FirmApiError` with a code, and
    the dialogs render the code rather than a shrug. A refusal that does not say
    which gate it was teaches the member to ask a colleague instead of the system.
  */

  /** Advance the state machine. The server recomputes `conflict_cleared` itself. */
  async setMatterStatus(id: string, body: {
    internalStatus: MatterInternalStatus;
    reason?: string | null;
  }): Promise<{ id: string; internalStatus?: string; from?: string }> {
    return request(`/matters/${encodeURIComponent(id)}/status`, { method: 'POST', body });
  },

  /** Restrict a matter (P0.5). The reason is mandatory in the server, so it is here. */
  async setMatterRestriction(id: string, body: {
    restricted: boolean;
    reason?: string | null;
    reasonAr?: string | null;
  }): Promise<{ id: string; restricted: boolean }> {
    return request(`/matters/${encodeURIComponent(id)}/restrict`, { method: 'POST', body });
  },

  /** Grant or revoke a member's explicit access to a matter. Gated by eligibility. */
  async setMatterAccess(id: string, body: {
    membershipId: string;
    accessLevel: MatterAccessLevel | 'none';
    reason?: string | null;
  }): Promise<{ id: string; membershipId: string; accessLevel: string }> {
    return request(`/matters/${encodeURIComponent(id)}/access`, { method: 'POST', body });
  },

  /* ── PARTIES ─────────────────────────────────────────────────────────────── */

  async parties(query?: string): Promise<{ count: number; parties: PartyRow[] }> {
    const qs = query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
    return request<{ count: number; parties: PartyRow[] }>(`/parties${qs}`);
  },


  /**
   * Put a party on a matter, in the role they hold ON THIS FILE.
   *
   * `createIfMissing` is the server's own convenience and is used as such: intake often
   * knows the other side as a NAME and nothing else, and a two-call sequence would leave
   * a party in the register with no matter on it when the second call failed. `partyId`
   * must still be a uuid-shaped value — the route validates it before consulting
   * `createIfMissing` — so a caller creating on the fly sends a fresh one.
   */
  async attachParty(matterId: string, body: {
    partyId: string;
    role: MatterPartyRole;
    note?: string | null;
    createIfMissing?: {
      kind: 'individual' | 'company' | 'government' | 'nonprofit' | 'other';
      name: string;
      nameAr?: string | null;
    } | null;
  }): Promise<{ partyId: string; partyCreated?: boolean; conflictCleared?: boolean }> {
    return request(`/matters/${encodeURIComponent(matterId)}/parties`, { method: 'POST', body });
  },

  /* ── CONFLICTS ───────────────────────────────────────────────────────────── */

  async runConflictCheck(
    matterId: string,
    kind: 'intake' | 'adverse_check' | 'periodic' | 'recheck' = 'intake',
  ): Promise<Record<string, unknown> & { id?: string; checkId?: string }> {
    return request(`/matters/${encodeURIComponent(matterId)}/conflict-check`, { method: 'POST', body: { kind } });
  },

  async dispositionHit(hitId: string, body: {
    disposition: 'different_party' | 'same_party';
    /** Required when confirming a hit: a legal judgement on a confirmed identity. */
    severity?: 'actual' | 'potential' | 'none' | null;
    affectedPartyId?: string | null;
    reason: string;
  }): Promise<{ id: string; disposition: string }> {
    return request(`/conflicts/hits/${encodeURIComponent(hitId)}/disposition`, { method: 'POST', body });
  },

  /**
   * The client's WRITTEN CONSENT — the thing that cures a conflict Rule 8 would
   * otherwise prohibit. The server wants the consent's own date and scope, not a
   * summary of it: a waiver is evidence, and evidence is the document's terms.
   */
  async waiveHit(hitId: string, body: {
    consentSignedOn: string;
    scope: string;
    consentReference?: string | null;
    consentDocumentId?: string | null;
  }): Promise<{ id: string }> {
    return request(`/conflicts/hits/${encodeURIComponent(hitId)}/waiver`, { method: 'POST', body });
  },

  async concludeConflicts(matterId: string, body: {
    checkId: string;
    decision: 'clear' | 'not_accepted' | 'abandoned';
    conclusion: string;
  }): Promise<{ id: string; state: string }> {
    return request(`/matters/${encodeURIComponent(matterId)}/conflict-conclusion`, { method: 'POST', body });
  },

  /* ── JUDGMENTS ───────────────────────────────────────────────────────────── */


  async recordJudgment(matterId: string, body: Record<string, unknown>): Promise<{ id: string }> {
    return request(`/matters/${encodeURIComponent(matterId)}/judgments`, { method: 'POST', body });
  },


  /** Service of process — the act that starts the appeal clock (Art. 187). */
  async recordJudgmentService(id: string, body: Record<string, unknown>): Promise<{ id: string }> {
    return request(`/judgments/${encodeURIComponent(id)}/service`, { method: 'POST', body });
  },

  async recordAppeal(id: string, body: Record<string, unknown>): Promise<{ id: string }> {
    return request(`/judgments/${encodeURIComponent(id)}/appeals`, { method: 'POST', body });
  },

  async recordStay(id: string, body: { inForce: boolean; reason?: string | null }): Promise<{ id: string }> {
    return request(`/judgments/${encodeURIComponent(id)}/stays`, { method: 'POST', body });
  },

  /*
    ── THE WORKSPACE'S TAB BODIES ────────────────────────────────────────────

    One call per tab, fetched when the tab is opened. Deliberately not one call
    for the whole workspace: the firm's file for a matter is unbounded, and a
    screen that asks for all of it so it can render one panel is a screen that
    gets slower every year the practice keeps records.

    Each of these can 403 or 404, and the panels treat both honestly — a tab the
    member's access level does not carry answers with a refusal, and the panel
    says so rather than showing an empty list that reads like "nothing here".
  */

  async matterDocuments(id: string): Promise<MatterDocumentsResponse> {
    return request(`/matters/${encodeURIComponent(id)}/documents`);
  },

  /**
   * FILE A DOCUMENT (P2.1).
   *
   * The metadata goes in the same multipart body as the file rather than in a JSON call
   * followed by an upload. Two calls would mean a document row that exists for a few
   * seconds with no bytes behind it, and a failure between them would leave it there —
   * a filing that half-happened, which for the attachment a conflict waiver rests on is
   * not a state the firm should ever be able to reach.
   */
  async fileMatterDocument(matterId: string, file: File, fields: FilingFields): Promise<FiledDocument> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') form.set(k, String(v));
    }
    form.append('file', file, file.name);
    return request(`/matters/${encodeURIComponent(matterId)}/documents`, { method: 'POST', body: form });
  },

  /** A NEW VERSION of a document that already exists (P2.6). */
  async fileMatterDocumentVersion(
    matterId: string, documentId: string, file: File, fields: { title?: string; titleAr?: string } = {},
  ): Promise<FiledDocument> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') form.set(k, String(v));
    }
    form.append('file', file, file.name);
    return request(
      `/matters/${encodeURIComponent(matterId)}/documents/${encodeURIComponent(documentId)}/versions`,
      { method: 'POST', body: form },
    );
  },

  /** The chain, oldest first. */
  async matterDocumentVersions(matterId: string, documentId: string): Promise<DocumentChainResponse> {
    return request(`/matters/${encodeURIComponent(matterId)}/documents/${encodeURIComponent(documentId)}/versions`);
  },

  /**
   * RELEASE, RESTRICT, RE-FILE, ARCHIVE — one route, because they are one object.
   *
   * The server checks a DIFFERENT permission for each field in this patch, so the UI must
   * gate each control separately: a partner who may release a document is not thereby a
   * member who may rename it, and the button that fails for the wrong reason is the
   * failure this split exists to prevent.
   */
  async updateMatterDocument(
    matterId: string, documentId: string,
    patch: {
      clientVisibility?: 'visible' | 'restricted' | 'internal';
      title?: string; titleAr?: string | null;
      documentType?: string; category?: string;
      status?: 'archived'; note?: string;
    },
  ): Promise<Record<string, unknown>> {
    return request(
      `/matters/${encodeURIComponent(matterId)}/documents/${encodeURIComponent(documentId)}`,
      { method: 'PATCH', body: patch },
    );
  },

  /**
   * A URL FOR THE BYTES, NOT A FETCH.
   *
   * The content route is a plain authenticated GET: the session cookie is httpOnly and
   * same-origin, so the browser carries it on a navigation and on a download without any
   * of this file's request plumbing. Fetching the bytes into JavaScript to then re-build
   * a blob URL would mean a file whose whole size sits in memory before the user sees it,
   * for no gain.
   */
  matterDocumentContentUrl(matterId: string, documentId: string, disposition: 'inline' | 'attachment' = 'inline'): string {
    return `${API_BASE}/matters/${encodeURIComponent(matterId)}/documents/${encodeURIComponent(documentId)}`
      + `/content?disposition=${disposition}`;
  },

  async matterHearings(id: string): Promise<MatterHearingsResponse> {
    return request(`/matters/${encodeURIComponent(id)}/hearings`);
  },

  async matterDeadlines(id: string): Promise<MatterDeadlinesResponse> {
    return request(`/matters/${encodeURIComponent(id)}/deadlines`);
  },

  async matterTimeline(id: string): Promise<MatterTimelineResponse> {
    return request(`/matters/${encodeURIComponent(id)}/timeline`);
  },

  async matterTeam(id: string): Promise<MatterTeamResponse> {
    return request(`/matters/${encodeURIComponent(id)}/team`);
  },

  /** The conflict register for the matter (P0.1). */
  async matterParties(id: string): Promise<{ count: number; parties: MatterPartyRow[] }> {
    return request(`/matters/${encodeURIComponent(id)}/parties`);
  },

  async matterConflicts(id: string): Promise<MatterConflictsResponse> {
    return request(`/matters/${encodeURIComponent(id)}/conflicts`);
  },

  /** The judgments register for the matter (P0.4), with the execution gate. */
  async matterJudgments(id: string): Promise<MatterJudgmentsResponse> {
    return request(`/matters/${encodeURIComponent(id)}/judgments`);
  },

  /** Billing for the matter (P1): terms, letters, unbilled, and why. */
  async matterBilling(id: string): Promise<MatterBillingResponse> {
    return request(`/matters/${encodeURIComponent(id)}/billing`);
  },

  // ---- intake (task 25) -------------------------------------------------

  /**
   * The client register, for choosing from.
   *
   * The firm app has a Clients screen built from the matter list — deliberately, so
   * there is one scope rule. This is the register the INTAKE form needs: clients who
   * have no matter yet appear here and nowhere else, which is exactly the client
   * somebody is about to open a file for.
   */
  async clients(query?: string): Promise<{ count: number; clients: FirmClientRow[] }> {
    const qs = query ? `?q=${encodeURIComponent(query)}` : '';
    return request(`/clients${qs}`);
  },

  /**
   * ADD CLIENT.
   *
   * `confirmDuplicate` is the answer to the 409 this can raise: the caller is told
   * which clients the firm already holds under the name, and decides. The refusal
   * carries `details.matches`, so a screen can offer them rather than dead-end.
   */
  async createClient(body: {
    clientType: 'individual' | 'organization';
    name: string;
    nameAr?: string | null;
    email?: string | null;
    phone?: string | null;
    city?: string | null;
    commercialRegistration?: string | null;
    nationalId?: string | null;
    identityVerified?: boolean;
    verificationNote?: string | null;
    confirmDuplicate?: boolean;
  }): Promise<{ id: string; name: string; nameAr: string | null; normalized: string; createdAt: string }> {
    return request('/clients', { method: 'POST', body });
  },

  /** Correct or complete a client. Never a party link — that is its own route. */
  async updateClient(id: string, patch: Record<string, unknown>): Promise<{ id: string; changed: number }> {
    return request(`/clients/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
  },

  /** Invite one of the client's people to the portal. Returns the link to hand over. */
  async inviteClientUser(
    clientId: string,
    body: { email: string; displayName: string; displayNameAr?: string | null;
      portalRole?: 'client_primary' | 'client_contact' },
  ): Promise<{ link: string; expiresAt: string; portalRole: string; email: string }> {
    return request(`/clients/${encodeURIComponent(clientId)}/invitations`, { method: 'POST', body });
  },

  /** Everything the opening form needs, including the number it will be given. */
  async matterIntake(): Promise<MatterIntakeBootstrap> {
    return request('/matters/new');
  },

  /**
   * ADD THE CASE — matter, lead, conflict check and opening entry in one call.
   *
   * One call and not four: each of the four stages is a step a case can be lost at,
   * and every one of them is mandatory in the sense that a file missing any of them
   * is a file somebody has to repair.
   */
  async createMatter(body: {
    clientId: string;
    title: string;
    titleAr?: string | null;
    matterNumber?: string | null;
    caseNumber?: string | null;
    practiceArea?: string | null;
    practiceAreaAr?: string | null;
    court?: string | null;
    courtAr?: string | null;
    summary?: string | null;
    summaryAr?: string | null;
    leadStaffId?: string | null;
    leadRole?: 'lead_partner' | 'lead_lawyer';
    team?: Array<{ staffId: string; matterRole: string }>;
    runConflictCheck?: boolean;
  }): Promise<CreateMatterResult> {
    return request('/matters', { method: 'POST', body });
  },

  /** The case report, the team, and whether this member may change any of it. */
  async matterReport(id: string): Promise<MatterReportPayload> {
    return request(`/matters/${encodeURIComponent(id)}/report`);
  },

  /** UPDATE THE CASE REPORT — and tell the client in the same write. */
  async updateMatterReport(id: string, patch: MatterReportPatch):
  Promise<{ id: string; updatedAt: string; notifiedClient: boolean; fields: string[] }> {
    return request(`/matters/${encodeURIComponent(id)}/report`, { method: 'PATCH', body: patch });
  },

  /** ASSIGN — the lawyer who answers for the file, or anyone else on it. */
  async assignMatterMember(id: string, body: {
    staffId: string; matterRole: string; clientVisible?: boolean;
    clientRoleLabel?: string | null; clientRoleLabelAr?: string | null; replaceLead?: boolean;
  }): Promise<AssignTeamResult> {
    return request(`/matters/${encodeURIComponent(id)}/team`, { method: 'POST', body });
  },

  /** Take somebody off a file. A deactivation: the record of the work stays. */
  async removeMatterMember(id: string, staffId: string, reason?: string):
  Promise<{ id: string; staffId: string; active: boolean; changed: number; team: MatterTeamRow[] }> {
    return request(
      `/matters/${encodeURIComponent(id)}/team/${encodeURIComponent(staffId)}`,
      { method: 'PATCH', body: { reason: reason ?? null } },
    );
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

  // ---- the money console (P2.3) -----------------------------------------

  /**
   * THE FIRM'S INVOICES.
   *
   * `?detail=1` is not a preference: without it the route answers the scope question it
   * has always answered — which matters this member may bill — and returns no rows. The
   * console asks for the rows; a caller that only wants the scope does not pay for them.
   * `matterIds` still comes back either way, because screens use it to say "12 matters
   * in scope" beside the table.
   */
  async invoices(params: InvoiceQuery = {}): Promise<InvoiceListResponse> {
    const q = new URLSearchParams({ detail: '1' });
    if (params.matterId) q.set('matterId', params.matterId);
    if (params.clientId) q.set('clientId', params.clientId);
    if (params.status) q.set('status', params.status);
    if (params.limit !== undefined) q.set('limit', String(params.limit));
    return request(`/billing/invoices?${q.toString()}`);
  },

  /*
    NO SEPARATE SCOPE METHOD. `GET /billing/invoices` without `?detail` answers which
    matters a member may bill, and the console's own call already receives `matterIds`
    alongside the rows — so a second method for the same route would be a second caller of
    one endpoint with nothing to do. The route keeps its two shapes because a scope check
    that only wants the ids should not pay for the list; the CLIENT does not need both.
  */

  /** One invoice with its lines and the receipts against it. */
  async invoice(id: string): Promise<FirmInvoiceDetail> {
    return request(`/billing/invoices/${encodeURIComponent(id)}`);
  },

  /**
   * DRAFT AN INVOICE.
   *
   * The number is omitted on purpose: the server suggests the next free one in the
   * firm's own series and marks it `-DRAFT` until the invoice is issued. A firm that
   * keeps its own numbering can pass `invoiceNumber`, and the server appends the marker.
   */
  async createInvoice(body: CreateInvoiceBody): Promise<CreatedInvoice> {
    return request('/billing/invoices', { method: 'POST', body });
  },

  /**
   * CANCEL A DRAFT, AND GET ITS SOURCES BACK.
   *
   * The way out of a mistake that has not been made official: nothing has been approved,
   * the invoice has no fiscal identity and no client has seen it. The response says how
   * many hours and disbursements returned to the unbilled list, because that is the
   * question the member has after pressing the button.
   *
   * An ISSUED invoice cannot be cancelled — it is a tax document, and its remedy is a
   * credit note. The screen does not offer the action on one.
   */
  async cancelInvoice(id: string, reason: string): Promise<{
    id: string; internalStatus: string; releasedTime: number; releasedExpenses: number;
  }> {
    return request(`/billing/invoices/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: { reason },
    });
  },

  /**
   * THE FIRM'S TAX IDENTITY, ITS DEVICES, AND WHETHER IT MAY ISSUE AT ALL.
   *
   * `ready: false` is not an error and not an empty state: it is a firm that cannot
   * legally send a tax invoice, and the response names each missing condition so the
   * screen can say which part of onboarding is undone.
   */
  async fiscalIdentity(): Promise<FiscalIdentityResponse> {
    return request('/billing/fiscal-identity');
  },

  /**
   * Record the firm's tax registration. Needs `settings.manage` — a practising lawyer
   * has no business editing the firm's VAT number, and the server says so.
   */
  async saveFiscalIdentity(body: SaveFiscalIdentityBody): Promise<{ id: string }> {
    return request('/billing/fiscal-identity', { method: 'POST', body });
  },

  /** Register a device that may issue in the firm's name. It starts inactive. */
  async addFiscalDevice(body: { deviceLabel: string; deviceSerial: string }): Promise<{ id: string }> {
    return request('/billing/fiscal-devices', { method: 'POST', body });
  },

  /**
   * ISSUE THE DOCUMENT — the moment a draft becomes a tax invoice.
   *
   * It allocates the next ICV, links the hash chain, builds the QR and the XML, and
   * stamps the document with its UUID. It cannot be undone: an issued invoice is
   * immutable and its only correction is a credit note. Needs `billing.approve` and
   * financial authority over the amount.
   */
  async issueInvoice(id: string, body: {
    subtype?: 'standard' | 'simplified';
    deviceId?: string;
    supplyAt?: string;
  } = {}): Promise<IssuedInvoice> {
    return request(`/billing/invoices/${encodeURIComponent(id)}/issue`, { method: 'POST', body });
  },

  /**
   * RECORD WHAT THE AUTHORITY SAID.
   *
   * A separate call from issuing, deliberately: clearance is the authority's answer, and
   * folding it into the issue would mean a network timeout could not be retried without
   * reissuing the document — which is the one thing that must never happen, because the
   * ICV and the hash would change.
   */
  async submitInvoice(id: string, body: {
    submissionType: 'clearance' | 'reporting' | 'compliance';
    status: 'pending' | 'submitted' | 'cleared' | 'reported' | 'rejected' | 'failed' | 'timed_out';
    httpStatus?: number | null;
    responseCode?: string | null;
    responseBody?: string | null;
    warnings?: string | null;
    errors?: string | null;
    nextRetryAt?: string | null;
  }): Promise<{ id: string; fiscalStatus: string; nextAttempt: number; nextRetryAt: string | null }> {
    return request(`/billing/invoices/${encodeURIComponent(id)}/submissions`, { method: 'POST', body });
  },

  /** The document's fiscal identity, its submissions and the credit notes against it. */
  async invoiceFiscal(id: string): Promise<InvoiceFiscalResponse> {
    return request(`/billing/invoices/${encodeURIComponent(id)}/fiscal`);
  },

  /** Simplified invoices whose 24-hour window is open, or has passed. */
  async reportingQueue(): Promise<ReportingQueueResponse> {
    return request('/billing/reporting-queue');
  },

  /**
   * CORRECT AN ISSUED INVOICE. The credit note is the only remedy the tax rules leave:
   * the document itself cannot be edited or deleted, so the correction is a second
   * document that refers to the first.
   */
  async creditNote(id: string, body: {
    reason: string;
    amount: number;
    vatAmount: number;
    creditNumber: string;
    deviceId?: string;
  }): Promise<{ id: string; uuid: string; icv: number; total: number; xml: string; qrPayload: string; fiscalStatus: string }> {
    return request(`/billing/invoices/${encodeURIComponent(id)}/credit-notes`, { method: 'POST', body });
  },

  /**
   * A DISCOUNT ON AN UNAPPROVED DOCUMENT, which is a decision about the firm's own fee
   * rather than a correction to the tax record — hence `billing.discount` and a ceiling
   * on how much of it a member may give away without a partner.
   */
  async applyDiscount(id: string, body: { newSubtotal: number; reason: string }): Promise<{
    id: string; subtotal: number; discountPct: number;
  }> {
    return request(`/billing/invoices/${encodeURIComponent(id)}/discount`, { method: 'POST', body });
  },

  /**
   * WRITE THE RECEIVABLE OFF. The invoice stays — it is a tax document and it keeps its
   * number and its place in the chain — and `taxAdjusted: false` is the server saying in
   * as many words that the tax already reported is unaffected. A write-off is a decision
   * about collecting, not about what was supplied.
   */
  async writeOff(id: string, reason: string): Promise<{
    id: string; writtenOff: number; status: string; taxAdjusted: boolean;
  }> {
    return request(`/billing/invoices/${encodeURIComponent(id)}/write-off`, {
      method: 'POST', body: { reason },
    });
  },

  /* ── compliance · the AML record ─────────────────────────────────────────── */

  /**
   * THE COMPLIANCE CONSOLE IN ONE CALL.
   *
   * The census, the queue, the risk-country register and — the field this screen exists
   * for — `refused`: every client the firm may not act for, with the reasons. A gate that
   * silently rejects work is a gate nobody trusts; this is the same gate, said out loud.
   */
  async complianceConsole(): Promise<ComplianceConsoleResponse> {
    return request('/compliance/due-diligence');
  },

  /** One client's identification record, its owners and its screening history. */
  async clientDueDiligence(clientId: string): Promise<ClientDueDiligenceResponse> {
    return request(`/clients/${encodeURIComponent(clientId)}/due-diligence`);
  },

  /** Open or refresh a client's record. `level` decides how much is required. */
  async createClientDueDiligence(clientId: string, body: {
    level?: 'simplified' | 'standard' | 'enhanced';
  } = {}): Promise<{ id: string; level: string; status: string }> {
    return request(`/clients/${encodeURIComponent(clientId)}/due-diligence`, { method: 'POST', body });
  },

  /** Amend the identification record — names, identity document, source of funds. */
  async updateDueDiligence(id: string, body: Record<string, unknown>): Promise<{ id: string }> {
    return request(`/due-diligence/${encodeURIComponent(id)}`, { method: 'PATCH', body });
  },

  /**
   * SIGN THE RECORD OFF. A senior approval is required for enhanced due diligence, and
   * the server refuses a completion that has one outstanding — `seniorApprovedByMembershipId`
   * is who accepted the risk, by name.
   */
  async completeDueDiligence(id: string, body: {
    seniorApprovedByMembershipId?: string | null;
    seniorApprovalNote?: string | null;
  } = {}): Promise<{ id: string; status: string }> {
    return request(`/due-diligence/${encodeURIComponent(id)}/complete`, { method: 'POST', body });
  },

  /**
   * "WE COULD NOT IDENTIFY THIS CLIENT." This is not a failure state to hide: not being
   * able to complete identification is itself a reason the firm may not act, and it must
   * be recorded with its reason rather than left as an empty checklist.
   */
  async unableToCompleteDueDiligence(id: string, reason: string): Promise<{ id: string; status: string }> {
    return request(`/due-diligence/${encodeURIComponent(id)}/unable`, { method: 'POST', body: { reason } });
  },

  /**
   * A BENEFICIAL OWNER. The 25% threshold comes from the law and the server applies it:
   * an owner recorded below it is still recorded, and it is the OWNERSHIP figures that
   * decide whether the identification is complete.
   */
  async addBeneficialOwner(dueDiligenceId: string, body: {
    id?: string | null;
    ownerKind?: 'natural_person' | 'legal_person';
    fullName: string;
    fullNameAr?: string | null;
    dateOfBirth?: string | null;
    nationality?: string | null;
    residenceCountry?: string | null;
    address?: string | null;
    ownershipPct?: number;
    controlRights?: number;
    isPep?: boolean;
    idType?: string | null;
    idNumber?: string | null;
    idCountry?: string | null;
  }): Promise<{ id: string }> {
    return request(`/due-diligence/${encodeURIComponent(dueDiligenceId)}/owners`, { method: 'POST', body });
  },

  /**
   * RUN A SCREENING. It records the lists it was run against, the date of those lists and
   * the provider — because a screening that cannot say which version of a list it used is
   * not evidence of anything.
   */
  async runScreening(clientId: string, body: {
    subjectKind: 'client' | 'party' | 'beneficial_owner' | 'staff';
    subjectId: string;
    subjectName: string;
    listSets: Array<'un_consolidated' | 'eu_consolidated' | 'sama_designations' | 'ofac_sdn' | 'internal_register'>;
    listAsOf?: string | null;
    provider: 'internal_register' | 'manual_review' | 'external_provider' | 'regulator_feed';
  }): Promise<{ id: string; status: string; matches: number }> {
    return request(`/clients/${encodeURIComponent(clientId)}/screening-runs`, { method: 'POST', body });
  },

  /**
   * DECIDE A MATCH. `false_positive`, `true_match` or `escalated`, with a reason of at
   * least ten characters, and it can be decided ONCE: the server refuses a second
   * disposition, because re-deciding a hit would erase the first decision's trail.
   */
  async dispositionScreeningMatch(matchId: string, body: {
    disposition: 'false_positive' | 'true_match' | 'escalated';
    reason: string;
  }): Promise<{ id: string; disposition: string }> {
    return request(`/screening-matches/${encodeURIComponent(matchId)}/disposition`, { method: 'POST', body });
  },

  /** Add a country to the firm's own risk list, or amend one already on it. */
  async upsertRiskCountry(body: {
    id?: string | null;
    countryCode: string;
    countryName: string;
    countryNameAr?: string | null;
    listSource: 'fatf_call_for_action' | 'fatf_grey' | 'un_sanctions' | 'eu_consolidated' | 'sama_circular' | 'internal';
    riskLevel: 'high' | 'prohibited';
    effectiveFrom: string;
    note?: string | null;
  }): Promise<{ id: string }> {
    return request('/compliance/risk-countries', { method: 'POST', body });
  },

  /* ── compliance · the report, and the clock on it ────────────────────────── */

  /**
   * THE SUSPICIOUS TRANSACTION REPORTS, WITH THEIR DEADLINE COMPUTED.
   *
   * `late` is calculated by the server on every read — not stored — because a stored flag
   * would be wrong by the next morning, and this is the one date in the whole system where
   * being wrong is a criminal exposure rather than a clerical one.
   */
  async strReports(params: { status?: string; clientId?: string } = {}): Promise<StrReportsResponse> {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.clientId) q.set('clientId', params.clientId);
    const suffix = q.toString();
    return request(`/str-reports${suffix ? `?${suffix}` : ''}`);
  },

  /**
   * DRAFT THE REPORT. The narrative is Arabic and at least 40 characters: SA FIU receives
   * Arabic, and a report too short to explain itself is a report that will be sent back.
   */
  async createStrReport(body: CreateStrReportBody): Promise<{ id: string; reportNumber: string }> {
    return request('/str-reports', { method: 'POST', body });
  },

  /** Send a draft for review. Only a draft can be sent — the server says so. */
  async reviewStrReport(id: string): Promise<{ id: string; status: string }> {
    return request(`/str-reports/${encodeURIComponent(id)}/review`, { method: 'POST', body: {} });
  },

  /**
   * FILE IT WITH SAFIU, and note what the acknowledgement says: filing requires the
   * tipping-off acknowledgement to be explicitly true. Telling the client that a report
   * has been made is itself an offence, and the form makes the member say they know that.
   */
  async fileStrReport(id: string, body: { fiuReference: string; tippingOffAcknowledged: true }): Promise<{
    id: string; status: string; filedAt: string;
  }> {
    return request(`/str-reports/${encodeURIComponent(id)}/file`, { method: 'POST', body });
  },

  /** Record what the FIU answered — or that it rejected the report. */
  async strReportResponse(id: string, body: {
    status: 'acknowledged' | 'rejected_by_fiu';
    response?: string | null;
  }): Promise<{ id: string; status: string }> {
    return request(`/str-reports/${encodeURIComponent(id)}/response`, { method: 'POST', body });
  },

  /* ── compliance · who may practise ──────────────────────────────────────── */

  /**
   * THE STANDING OF EVERY MEMBER — licence validity and any former-office bar.
   *
   * Article 14 of the نظام المحاماة bars a former judge or prosecutor from practice for
   * five years, and the bar attaches to the FIRM as much as to the person: a matter
   * staffed by someone still inside that window is a matter the firm may not run.
   */
  async eligibility(): Promise<EligibilityResponse> {
    return request('/eligibility');
  },

  /** Record or renew a practising licence for a member. */
  async addLicence(membershipId: string, body: {
    licenceNumber: string;
    issuedAt?: string | null;
    expiresAt?: string | null;
    status?: 'valid' | 'suspended' | 'expired' | 'revoked' | 'pending';
    statusReference?: string | null;
  }): Promise<{ id: string }> {
    return request(`/eligibility/${encodeURIComponent(membershipId)}/licences`, { method: 'POST', body });
  },

  /** Record a member's previous public office, which is what starts the five-year bar. */
  async addPriorOffice(membershipId: string, body: {
    officeKind: 'judiciary' | 'public_prosecution' | 'bog' | 'committee' | 'government_body' | 'court_administration' | 'foreign_judiciary';
    institution: string;
    institutionAr?: string | null;
    roleTitle?: string | null;
    startedOn: string;
    endedOn?: string | null;
  }): Promise<{ id: string }> {
    return request(`/eligibility/${encodeURIComponent(membershipId)}/prior-office`, { method: 'POST', body });
  },

  /** Release an approved, issued invoice to the client. */
  async sendInvoice(id: string): Promise<{ id: string; internalStatus: string }> {
    return request(`/billing/invoices/${encodeURIComponent(id)}/send`, { method: 'POST', body: {} });
  },

  /** Record money received against an issued invoice. */
  async recordInvoicePayment(id: string, body: RecordPaymentBody): Promise<RecordedPayment> {
    return request(`/billing/invoices/${encodeURIComponent(id)}/payments`, { method: 'POST', body });
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

/**
 * THE STATES A MATTER MOVES THROUGH — the wire's own vocabulary, in the order the
 * server validates them (migration 0002's CHECK, `r.post('/matters/:id/status')`).
 *
 * `restricted` is here and is NOT reached by the status route: it is set by
 * `/matters/:id/restrict`, which carries its own permission and its own mandatory
 * reason. A screen that offered it as a state transition would be offering a write
 * the server will refuse, so the picker omits it and says why.
 */
export type MatterInternalStatus =
  | 'intake' | 'conflict_check' | 'restricted' | 'internal_review' | 'partner_review'
  | 'active' | 'on_hold' | 'judgment' | 'execution' | 'closed' | 'archived';

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

  /**
   * THE MOVES THIS MATTER CAN MAKE, AS THE SERVER SEES THEM.
   *
   * Sent by `GET /matters/:id` from the domain's own map, so the screen never keeps a
   * second copy of the state machine. Absent on a response from an older server, so the
   * dialog that uses it treats `undefined` as "no moves to offer" rather than as an
   * empty list — the difference between a hidden control and a broken one.
   */
  allowedTransitions?: MatterInternalStatus[];
}

/**
 * One live session, as returned by `/session/devices`.
 *
 * CORRECTED AGAINST A LIVE RESPONSE — THE THIRD INSTANCE OF THE SAME BUG.
 *
 * The draft declared `lastSeenAt`, `sessionExpiresAt` and `mfaVerified`. The wire
 * sends `lastActivity`, `expiresAt` and `mfaVerifiedAt`, and additionally sends
 * `browser`, `os` and `revokedAt`, which were omitted entirely.
 *
 * The names are close enough to look plausible and different enough that nothing
 * renders: a sessions panel built on the draft would show a permanently empty
 * "last seen" column and a permanently false MFA badge, with no error anywhere.
 * That is the failure mode this interface exists to prevent, so it is worth
 * naming rather than quietly fixing.
 *
 * `mfaVerifiedAt` is a TIMESTAMP, not a boolean. Rendering it as one loses the
 * answer to "when did this session prove its second factor", which is the
 * question a security review actually asks.
 */
export interface FirmDevice {
  id: string;
  deviceLabel: string | null;
  /** Parsed browser, e.g. "Chrome". Separate from the raw agent string. */
  browser: string | null;
  /** Parsed operating system, e.g. "macOS". */
  os: string | null;
  userAgent: string | null;
  /** Country only. The server never projects a raw IP to the client. */
  ipCountry: string | null;
  createdAt: string;
  lastActivity: string | null;
  expiresAt: string | null;
  /** When this session verified its second factor; null if it never did. */
  mfaVerifiedAt: string | null;
  /** Set once revoked. A revoked session is listed, not hidden, so the member
   *  can see that a revocation happened rather than wondering where it went. */
  revokedAt: string | null;
  /** True for the session making this request. */
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

/* ---------------------------------------------------------- workspace tabs -- */

export interface MatterDocumentRow {
  id: string;
  title: string;
  titleAr: string | null;
  documentType: string;
  category: string;
  origin: string;
  version: number;
  mimeType: string;
  sizeBytes: number;
  status: string;
  clientVisibility: string;
  privilegeClass: string;
  requested: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * WHAT A FILING RETURNS.
 *
 * `releaseReason` is not decoration: it is the server's answer to "why is this not with
 * the client", and it distinguishes three cases the UI must not blur — `not_released_yet`
 * (a decision nobody has made), `privileged` (a decision the law made) and a released row.
 * A single grey "internal" badge would say the first two were the same thing.
 */
export interface FiledDocument {
  id: string;
  matterId: string;
  title: string;
  titleAr: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  documentType: string;
  privilegeClass: string;
  clientVisibility: string;
  supersedesDocumentId: string | null;
  createdAt: string;
  releaseReason?: string;
  previousVersion?: number;
  previousStillReleased?: boolean;
}

/** One link in the version chain (P2.6). */
export interface DocumentVersionRow {
  id: string;
  version: number;
  title: string;
  titleAr: string | null;
  status: string;
  clientVisibility: string;
  privilegeClass: string;
  supersededBy: string | null;
  isHead: boolean;
  createdAt: string;
  createdByStaffId: string | null;
}

export interface DocumentChainResponse {
  documentId: string;
  count: number;
  withheldCount: number;
  headId: string;
  versions: DocumentVersionRow[];
}

/** The metadata a filing carries. The file itself is appended separately. */
export interface FilingFields {
  documentType: string;
  title?: string;
  titleAr?: string;
  category?: string;
  privilegeClass?: string;
  release?: boolean;
}

export interface MatterDocumentsResponse {
  matterId: string;
  count: number;
  /** Privileged material the ring withheld — reported, never hidden silently. */
  withheldCount: number;
  privilege: { inRing: boolean; reason: string };
  documents: MatterDocumentRow[];
}

export interface MatterHearingRow {
  id: string;
  scheduledAt: string;
  endsAt: string | null;
  court: string;
  courtAr: string | null;
  hearingType: string;
  location: string | null;
  locationAr: string | null;
  isRemote: boolean;
  remotePlatform: string | null;
  internalStatus: string;
  clientStatus: string;
  clientVisible: boolean;
  instructions: string | null;
  instructionsAr: string | null;
}

export interface MatterHearingsResponse {
  matterId: string;
  count: number;
  upcoming: MatterHearingRow[];
  past: MatterHearingRow[];
}

export interface MatterDeadlineRow {
  id: string;
  kind: string;
  title: string;
  titleAr: string | null;
  description: string | null;
  descriptionAr: string | null;
  dueAt: string;
  priority: string;
  internalStatus: string;
  clientStatus: string;
  clientVisible: boolean;
  assignedStaffId: string | null;
  ruleCited: string | null;
  ruleCode: string | null;
  ruleDays: number | null;
  sourceKind: string | null;
  /** Computed by the server against the same clock the reminder job uses. */
  overdue: boolean;
}

export interface MatterDeadlinesResponse {
  matterId: string;
  count: number;
  deadlines: MatterDeadlineRow[];
}

export interface MatterTimelineRow {
  id: string;
  occurredAt: string;
  eventType: string;
  title: string;
  titleAr: string | null;
  description: string | null;
  descriptionAr: string | null;
  status: string;
  clientVisible: boolean;
  createdByStaffId: string | null;
}

export interface MatterTimelineResponse {
  matterId: string;
  count: number;
  timeline: MatterTimelineRow[];
}

export interface MatterTeamRow {
  id: string;
  staffId: string;
  matterRole: string;
  clientVisible: boolean;
  clientRoleLabel: string | null;
  clientRoleLabelAr: string | null;
  name: string;
  nameAr: string | null;
  internalRole: string;
  barNumber: string | null;
}

export interface MatterTeamResponse {
  matterId: string;
  count: number;
  yourAccessLevel: MatterAccessLevel;
  /** Whether this member may change the team, and the people they may add. */
  mayAssign: boolean;
  assignable: AssignableStaffRow[];
  team: MatterTeamRow[];
}

/** A member who can be put on a matter, and the load they already carry. */
export interface AssignableStaffRow {
  staffId: string;
  name: string;
  nameAr: string | null;
  role: string;
  jobTitle: string | null;
  jobTitleAr: string | null;
  activeMatters: number;
  /** Already on this file — the picker marks them rather than offering them twice. */
  onThisMatter: boolean;
}

export interface MatterPartyRow {
  id: string;
  partyId: string;
  role: string;
  note: string | null;
  createdAt: string;
  name: string;
  nameAr: string | null;
  kind: string;
  status: string;
}

/**
 * THE ROLE A PARTY HOLDS ON A MATTER — the wire's enum, verbatim.
 *
 * `our_client` is absent on purpose: the client is on the matter as its CLIENT, not as
 * a party, and the conflict engine is built on that distinction. Offering it here would
 * let a screen record the firm's own client as its counterparty.
 */
export type MatterPartyRole =
  | 'counterparty' | 'adverse_party' | 'related_entity' | 'guarantor'
  | 'witness' | 'expert' | 'interested_party' | 'other';

/** A party in the firm's register, as `/parties` projects it. */
export interface PartyRow {
  id: string;
  kind: string;
  name: string;
  nameAr: string | null;
  status: string;
  note?: string | null;
  [key: string]: unknown;
}

/** A judgment row, loosely typed: the register returns far more than the list shows. */
export interface JudgmentRow {
  id: string;
  operative?: boolean;
  [key: string]: unknown;
}

export interface MatterConflictHitRow {
  id: string;
  [key: string]: unknown;
}

export interface MatterConflictsResponse {
  matterId: string;
  state: string;
  count: number;
  waivers: Array<Record<string, unknown>>;
  checks: Array<{ id: string; [key: string]: unknown; hits: MatterConflictHitRow[] }>;
}

export interface MatterJudgmentsResponse {
  matterId: string;
  judgments: Array<Record<string, unknown> & { id: string; operative?: boolean }>;
  matterExecution: Record<string, unknown>;
  services: Array<Record<string, unknown> & { id: string }>;
  rules: unknown;
}

export interface MatterBillingResponse {
  matterId: string;
  billable: boolean;
  blockers: string[];
  terms: null | {
    id: string; basis: string; feeAmountSar: number | null; capAmountSar: number | null;
    retainerAmountSar: number | null; agreedDiscountPct: number; effectiveFrom: string | null;
    notes: string | null;
  };
  engagementLetters: Array<Record<string, unknown> & { id: string }>;
  unbilled: { time: number; expenses: number; total: number };
  time: Array<Record<string, unknown> & { id: string }>;
  expenses: Array<Record<string, unknown> & { id: string }>;
}

export interface DashboardSummary {
  /** Upcoming hearings across the matters this member can see. */
  hearingsUpcoming: number | null;
  /** Deadlines falling due within the next seven days. */
  deadlinesThisWeek: number | null;
  /** Documents the firm has requested and not yet received. */
  documentsRequested: number | null;
  outstanding: { amountSar: number; openInvoiceCount: number } | null;
  /** Which metrics were withheld, so the screen can explain a short dashboard. */
  withheld: string[];
}

/*
  ── TASK 25 · INTAKE ──────────────────────────────────────────────────────────

  The four stages, typed. The shapes follow the routes exactly: a create returns the
  number it allocated and the conflict result it produced, because the screen that
  just opened a file has to be able to say what the file is called and whether the
  Rule 11 gate is holding it — and asking again would be a second round trip that can
  disagree with the first.
*/

/** A client as the register projects them. Never carries `national_id_hash`. */
export interface FirmClientRow {
  id: string;
  clientType: string;
  name: string;
  nameAr: string | null;
  status: string;
  city: string | null;
  hasParty: boolean;
  matterCount: number;
  lastMatterAt: string | null;
}

/** A member who can be given a matter, with the load they already carry. */
export interface IntakeStaffRow {
  staffId: string;
  name: string;
  nameAr: string | null;
  role: string;
  jobTitle: string | null;
  jobTitleAr: string | null;
  roleCodes: string[];
  activeMatters: number;
}

export interface MatterIntakeBootstrap {
  clients: FirmClientRow[];
  staff: IntakeStaffRow[];
  practiceAreas: string[];
  matterNumber: { proposed: string; prefix: string };
  roles: string[];
}

export interface CreateMatterResult {
  id: string;
  matterNumber: string;
  internalStatus: string;
  practiceArea: string;
  client: { id: string; name: string };
  lead: { staffId: string; name: string; matterRole: string } | null;
  conflict: {
    checkId: string | null;
    hits: Array<Record<string, unknown> & { id: string; severity?: string | null }>;
    warnings: string[];
    partiesChecked: number;
    mattersSearched: number;
  };
  next: { matter: string; status: string; report: string };
}

export interface MatterReportPayload {
  report: {
    id: string;
    matterNumber: string;
    caseNumber: string | null;
    title: string;
    titleAr: string | null;
    practiceArea: string;
    practiceAreaAr: string | null;
    court: string | null;
    courtAr: string | null;
    summary: string | null;
    summaryAr: string | null;
    internalStatus: string;
    clientStatus: string;
    openedAt: string;
    lastClientUpdateAt: string | null;
    client: { id: string | null; name: string | null; nameAr: string | null };
  };
  team: MatterTeamRow[];
  /** Whether this member may change the report — the form's own gate. */
  mayUpdate: boolean;
}

/** The body of `PATCH /matters/:id/report`. Only these keys are accepted. */
export interface MatterReportPatch {
  title?: string;
  titleAr?: string | null;
  caseNumber?: string | null;
  practiceArea?: string;
  practiceAreaAr?: string | null;
  court?: string | null;
  courtAr?: string | null;
  summary?: string | null;
  summaryAr?: string | null;
  note?: string | null;
  noteAr?: string | null;
  notifyClient?: boolean;
}

export interface AssignTeamResult {
  id: string;
  staffId: string;
  matterRole: string;
  clientVisible: boolean;
  /** True when §11 forced the role off the client's view. */
  clientVisibleForced: boolean;
  created: boolean;
  replaced: boolean;
  team: MatterTeamRow[];
}

/** The 409 body of `POST /clients`: the clients the firm already holds under this name. */
export interface ClientNameMatch {
  id: string;
  name: string;
  nameAr: string | null;
  status: string;
  matterCount: number;
}

/*
  ── P2.3 · THE MONEY CONSOLE ───────────────────────────────────────────────────

  Transcribed from the routes, not inferred. Three of these shapes are the answer to a
  question the product could not previously answer: what an invoice IS, what it bills,
  and what has been paid against it.
*/

export interface InvoiceQuery {
  matterId?: string;
  clientId?: string;
  /** One of the internal states: draft, approved, sent, partially_paid, paid, … */
  status?: string;
  limit?: number;
}

/**
 * A row in the firm's invoice list.
 *
 * `internalStatus` is what the FIRM has done to the document; `clientStatus` is whether
 * the CLIENT can see it at all, and it is null until the invoice is sent. A console that
 * showed only one of the two would either hide a sent invoice's progress or promise a
 * client a document they cannot open.
 */
export interface FirmInvoiceRow {
  id: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: number;
  vatAmount: number;
  total: number;
  amountPaid: number;
  outstanding: number;
  internalStatus: string;
  clientStatus: string | null;
  /** True once the invoice carries a UUID and a hash: it has been issued, not merely approved. */
  issued: boolean;
  fiscalStatus: string | null;
  matterId: string | null;
  matterNumber: string | null;
  clientName: string | null;
  clientNameAr: string | null;
}

export interface InvoiceListResponse {
  count: number;
  /** Every matter in this member's billing scope, whether or not it has invoices. */
  matterIds: string[];
  invoices: FirmInvoiceRow[];
}

/** The line an invoice bills, and where it came from. */
export interface FirmInvoiceLine {
  id: string;
  position: number;
  description: string;
  descriptionAr: string | null;
  quantity: number;
  unitPrice: number;
  amount: number;
  discountAmount: number;
  vatCategory: string;
  vatRate: number;
  vatAmount: number;
  /** `time:<id>` or `expense:<id>` where the line bills recorded work, null for a manual line. */
  billingSourceKey: string | null;
}

export interface FirmInvoicePayment {
  id: string;
  provider: string;
  amount: number;
  currency: string;
  status: string;
  /**
   * The bank or SADAD reference the money arrived under, and NULL when it arrived under
   * none — a cash payment at the counter has no reference, and the server records that
   * honestly rather than inventing one that would look real during a reconciliation.
   */
  receiptNumber: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * ── THE FIRM'S TAX IDENTITY, AND THE PATH OUT OF `draft` ──────────────────────────
 *
 * Everything below exists because the firm could DRAFT an invoice and stop: the issue,
 * the submission to the authority, the credit note that corrects one, the discount and
 * the write-off were all built on the server and reachable by no screen. `billing` was
 * eleven routes wide in the audit's own numbers, and this is the half of it that turns a
 * draft into a tax document.
 */

/**
 * The firm's tax registration, exactly as the row is stored.
 *
 * SNAKE CASE, DELIBERATELY, AND IT WAS MEASURED RATHER THAN GUESSED. The devices are
 * mapped by the route into camelCase, but the identity is the row itself — and the first
 * version of this interface guessed camelCase for both. The screen then read `undefined`
 * for every field and would have shown an empty registration under a firm that IS
 * registered: a wrong answer, not a missing one. `scripts/verify/fiscal-live.mjs` caught
 * it by comparing each field against the table.
 */
export interface FiscalIdentity {
  id: string;
  tenant_id: string;
  registered_name: string;
  registered_name_ar: string | null;
  vat_registration_number: string;
  commercial_registration: string;
  registered_address: string;
  registered_address_ar: string | null;
  city: string | null;
  postal_code: string | null;
  country: string;
  environment: 'sandbox' | 'simulation' | 'production';
  onboarding_status: string;
  certificate_expires_at: string | null;
}

export interface FiscalDevice {
  id: string;
  label: string;
  serial: string;
  /** The device's own invoice counter — the ICV the next document will carry. */
  counterValue: number;
  /** Whether a hash-chain head exists. The hash itself is asked for per invoice. */
  hasChainHead: boolean;
  isActive: boolean;
}

/**
 * `ready` is the answer to one question: may this firm legally send a tax invoice? When
 * it is false, `blockers` names each missing condition — a screen has to be able to say
 * WHICH part of onboarding is undone, not merely that something is.
 */
export interface FiscalIdentityResponse {
  identity: FiscalIdentity | null;
  devices: FiscalDevice[];
  ready: boolean;
  blockers: Array<'no_fiscal_identity' | 'onboarding_incomplete' | 'no_active_device'>;
}

export interface SaveFiscalIdentityBody {
  registeredName: string;
  registeredNameAr?: string | null;
  vatRegistrationNumber: string;
  commercialRegistration: string;
  registeredAddress: string;
  registeredAddressAr?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string;
  environment: 'sandbox' | 'simulation' | 'production';
  onboardingStatus: string;
  certificateExpiresAt?: string | null;
}

/** What issuing produced: the document's identity and the XML that was hashed. */
export interface IssuedInvoice {
  id: string;
  invoiceNumber: string;
  uuid: string;
  icv: number;
  hash: string;
  subtype: 'standard' | 'simplified';
  total: number;
  xml: string;
  qrPayload: string;
  fiscalStatus: string;
  /** What the authority requires next, in the server's own words. */
  nextStep: string;
}

/** A submitted attempt at clearance or reporting, and what came back. */
export interface FiscalSubmission {
  id: string;
  type: 'clearance' | 'reporting' | 'compliance';
  attempt: number;
  status: string;
  httpStatus: number | null;
  responseCode: string | null;
  warnings: string | null;
  errors: string | null;
  nextRetryAt: string | null;
  submittedAt: string | null;
  resolvedAt: string | null;
}

export interface FiscalCreditNote {
  id: string;
  number: string;
  reason: string;
  total: number;
  uuid: string | null;
  icv: number | null;
  status: string | null;
  issuedAt: string | null;
}

export interface InvoiceFiscalResponse {
  id: string;
  invoiceNumber: string;
  fiscal: {
    uuid: string | null;
    subtype: string | null;
    icv: number | null;
    previousHash: string | null;
    hash: string | null;
    qrPayload: string | null;
    xmlStorageKey: string | null;
    supplyAt: string | null;
    buyerName: string | null;
    buyerVat: string | null;
    status: string;
    statusAt: string | null;
    device: { label: string; serial: string } | null;
  };
  submissions: FiscalSubmission[];
  creditNotes: FiscalCreditNote[];
}

/** A simplified invoice whose 24-hour reporting window is open, or has passed. */
export interface ReportingQueueRow {
  id: string;
  number: string;
  uuid: string | null;
  supplyAt: string | null;
  total: number;
  icv: number | null;
  status: string | null;
  /** Past the deadline. The window is 24 hours from the time of supply. */
  overdue: boolean;
  reportBy: string | null;
}

export interface ReportingQueueResponse {
  count: number;
  overdue: number;
  invoices: ReportingQueueRow[];
}

/**
 * ── COMPLIANCE · the AML record, and the register of who may act ─────────────────
 *
 * The firm is a DNFBP under the Anti-Money Laundering Law (Royal Decree M/20 of 2017):
 * it must identify its clients and their beneficial owners to a 25% threshold, screen
 * them, and — if it suspects — report to SAFIU within about three working days. It must
 * also not act through a lawyer who is barred, and the professional-conduct rules bar a
 * former judge or prosecutor for five years.
 *
 * Every type below exists because one of those obligations has a screen behind it now.
 * The one that matters most is `allowed`: a client for whom the firm may not act, with
 * the reason, in the firm's own words — because the gate that refuses the work is worth
 * nothing if nobody can see why.
 */

export interface DueDiligenceRow {
  clientId: string;
  clientName: string;
  clientType: string;
  ddId: string | null;
  status: string | null;
  level: string | null;
  riskRating: string | null;
  pepStatus: string | null;
  /** When this client's file falls due for review again, by risk rating. */
  reviewDueAt: string | null;
  ownershipPct: number;
  controlRights: number;
  openMatches: number;
  confirmedMatches: number;
  failedRuns: number;
  /** May the firm act? The answer the intake gate gives, stated once. */
  allowed: boolean;
  blockers: string[];
}

export interface RiskCountry {
  id: string;
  countryCode: string;
  countryName: string;
  countryNameAr: string | null;
  listSource: string;
  riskLevel: 'high' | 'prohibited';
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
}

export interface ComplianceCensus {
  clients: number;
  complete: number;
  unable: number;
  notStarted: number;
  reviewOverdue: number;
  openMatches: number;
  failedRuns: number;
  reportsOpen: number;
  reportsFiled: number;
  reportsLate: number;
  activeMattersUnidentified: number;
}

export interface ComplianceConsoleResponse {
  census: ComplianceCensus;
  countries: RiskCountry[];
  queue: DueDiligenceRow[];
  /** The percentage that makes someone a beneficial owner. 25, from the law. */
  thresholdPct: number;
  /** The review cycle per risk rating, in months. */
  reviewMonths: Record<string, number>;
  /** Who the firm may NOT act for, and why. The first thing a compliance page owes. */
  refused: Array<{ clientId: string; clientName: string; blockers: string[] }>;
}

export interface StrReport {
  id: string;
  reportNumber: string;
  subjectKind: string;
  subjectName: string | null;
  clientId: string | null;
  clientName: string | null;
  matterId: string | null;
  matterNumber: string | null;
  grounds: string[];
  status: string;
  amountSar: number | null;
  currency: string;
  preparedAt: string;
  /** The filing deadline. Past it and unfiled, the report is late. */
  filedDueAt: string | null;
  filedAt: string | null;
  fiuReference: string | null;
  fiuRespondedAt: string | null;
  closureReason: string | null;
  /** Computed by the server on every read — a stored flag would be stale by morning. */
  late: boolean;
}

export interface StrReportsResponse {
  reports: StrReport[];
  indicators: Array<{ code: string; label: string; labelAr: string }>;
}

export interface CreateStrReportBody {
  reportNumber: string;
  subjectKind: 'client' | 'party' | 'beneficial_owner' | 'staff' | 'transaction';
  subjectId?: string | null;
  subjectName?: string | null;
  clientId?: string | null;
  matterId?: string | null;
  grounds: string[];
  narrativeAr: string;
  narrativeEn?: string | null;
  amountSar?: number | null;
  transactionReference?: string | null;
  transactionAt?: string | null;
}

/** One member's standing to practise: licence, and any former-office bar. */
export interface EligibilityMember {
  membershipId: string;
  displayName: string;
  displayNameAr: string | null;
  email: string | null;
  status: string;
  requiresLicence: boolean;
  entitled: boolean;
  reason: string;
  licences: Array<{
    id: string;
    licenceNumber: string;
    issuedAt: string | null;
    expiresAt: string | null;
    status: string;
    statusEffectiveFrom: string | null;
    statusReference: string | null;
    verifiedAt: string | null;
  }>;
  priorOffice: {
    barred: boolean;
    restrictionEndsOn: string | null;
    stillInPost: boolean;
    institution: string | null;
  };
}

export interface EligibilityResponse {
  count: number;
  notEntitled: number;
  barredByPriorOffice: number;
  members: EligibilityMember[];
}

export interface ClientDueDiligenceResponse {
  clientId: string;
  clientName: string;
  clientType: string;
  dd: null | {
    id: string;
    status: string;
    level: string;
    riskRating: string;
    pepStatus: string;
    reviewDueAt: string | null;
    legalName: string | null;
    legalNameAr: string | null;
    idType: string | null;
    idNumber: string | null;
    sourceOfFunds: string | null;
    purposeOfRelationship: string | null;
    unableReason: string | null;
    completedAt: string | null;
  };
  owners: Array<{
    id: string;
    ownerKind: string;
    fullName: string;
    fullNameAr: string | null;
    ownershipPct: number;
    controlRights: number;
    isPep: boolean;
  }>;
  screening: Array<{
    id: string;
    subjectKind: string;
    subjectName: string;
    provider: string;
    status: string;
    runAt: string;
    listAsOf: string | null;
    matches: Array<{ id: string; listName: string; matchScore: number; disposition: string | null; dispositionReason: string | null }>;
  }>;
}

export interface FirmInvoiceDetail extends FirmInvoiceRow {
  vatRate: number;
  invoiceUuid: string | null;
  invoiceType: string | null;
  icv: number | null;
  supplyAt: string | null;
  notesInternal: string | null;
  matterTitle: string | null;
  matterTitleAr: string | null;
  clientId: string;
  clientVatNumber: string | null;
  lines: FirmInvoiceLine[];
  payments: FirmInvoicePayment[];
}

/** One line of a new invoice: either recorded work (by id) or a fee typed in. */
export interface CreateInvoiceLine {
  description: string;
  descriptionAr?: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
  vatRate?: number;
  vatCategory?: 'standard' | 'zero_rated' | 'exempt' | 'out_of_scope';
}

export interface CreateInvoiceBody {
  matterId: string;
  invoiceNumber?: string;
  issueDate?: string;
  dueDate?: string;
  notesInternal?: string | null;
  /** Time entries to bill, taken from the matter's unbilled list. */
  timeEntryIds?: string[];
  /** Approved disbursements to pass on. */
  expenseIds?: string[];
  lines?: CreateInvoiceLine[];
}

export interface CreatedInvoice {
  id: string;
  invoiceNumber: string;
  subtotal: number;
  vatAmount: number;
  total: number;
  timeEntriesBilled: number;
  expensesBilled: number;
  /** Selected sources that were taken by another draft between the read and the write. */
  shortfall: number;
}

export interface RecordPaymentBody {
  amount: number;
  provider?: 'bank_transfer' | 'sadad' | 'manual';
  reference?: string | null;
  receivedOn?: string;
}

export interface RecordedPayment {
  id: string;
  amountPaid: number;
  total: number;
  outstanding: number;
  internalStatus: string;
}
