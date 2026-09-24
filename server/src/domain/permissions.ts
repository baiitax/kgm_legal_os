/**
 * THE FIRM OS AUTHORIZATION ENGINE (§7-§17, §27, §50, §71-§73)
 *
 * This is the layer that answers "may this person do this?". Everything above it
 * (routes, handlers) asks; everything below it (repository, database) supplies
 * facts. The browser is never consulted.
 *
 * WHY THE LOGIC LIVES HERE AND NOT IN THE QUERIES
 *   On Postgres, migration 0006 also encodes these rules as Row Level Security
 *   so that a bug in this file cannot become a data breach. On SQLite there is
 *   no RLS, so this file IS the enforcement point for the demo — and the demo is
 *   what the security suite attacks. Both copies are written to the same
 *   precedence, in the same order, and tests/security/firm-rbac.test.ts asserts
 *   the correspondence rather than trusting it.
 *
 * THE FOUR THINGS THIS FILE REFUSES TO GUESS ABOUT
 *   1. A NULL financial ceiling is NO authority, never unlimited (§10).
 *   2. A restricted matter is reachable only by explicit grant (§27). Being on
 *      the team, being in the practice group, or holding matters.read_all does
 *      not open it.
 *   3. An explicit 'none' grant outranks everything, including a team role. It
 *      is a recorded decision to exclude someone, and a later widening of their
 *      practice scope must not silently undo it.
 *   4. A suspended, invited or departed membership resolves to NO principal.
 *      Not a reduced one — none.
 */
import type { FirmRepo, MatterAuthFacts, MembershipRow } from '../db/firm-repo.js';
import { teamRoleToLevel } from '../db/firm-repo.js';
import { PortalError } from '../lib/errors.js';
import { PERMISSIONS } from './firm-catalogue.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Matter access levels (§17).
 *
 * These are NOT a single ladder. `financial` and `compliance` are lateral: a
 * finance officer with `financial` on a matter must not be able to read its
 * legal strategy, and a compliance officer with `compliance` must not be able to
 * edit its pleadings. That is why authorization takes an ACCEPTANCE SET rather
 * than a minimum rank — a rank would let 'view' satisfy a 'financial' check or
 * vice versa depending on where the numbers were placed.
 */
export type AccessLevel =
  | 'full'
  | 'edit'
  | 'operational'
  | 'view'
  | 'financial'
  | 'compliance'
  | 'none';

export const ACCESS_LEVELS: readonly AccessLevel[] = [
  'full', 'edit', 'operational', 'view', 'financial', 'compliance', 'none',
] as const;

/** Acceptance sets, named for the intent rather than the level. */
export const MATTER_READ: readonly AccessLevel[] =
  ['full', 'edit', 'operational', 'view', 'financial', 'compliance'];
export const MATTER_WRITE: readonly AccessLevel[] = ['full', 'edit'];
export const MATTER_OPERATE: readonly AccessLevel[] = ['full', 'edit', 'operational'];
export const MATTER_FINANCIAL: readonly AccessLevel[] = ['full', 'financial'];
export const MATTER_COMPLIANCE: readonly AccessLevel[] = ['full', 'compliance'];
export const MATTER_MANAGE: readonly AccessLevel[] = ['full'];

export interface PrincipalRole {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameAr: string;
  readonly isSystem: boolean;
}

export interface PrincipalDepartment {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameAr: string;
  readonly isLead: boolean;
}

/** Numeric approval authority (§10). `null` means "none", never "unlimited". */
export interface AuthorityCeilings {
  readonly financialSar: number | null;
  readonly writeoffSar: number | null;
  readonly discountPct: number | null;
}

/**
 * A resolved firm principal. Built once per request from the database and then
 * treated as immutable: nothing downstream may widen it, and a handler that
 * wants to act as someone else has to go and resolve that someone else.
 */
export interface FirmPrincipal {
  readonly kind: 'firm_member';
  readonly membershipId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly staffId: string;
  readonly email: string;
  readonly displayName: string;
  readonly displayNameAr: string | null;
  readonly jobTitle: string | null;
  readonly jobTitleAr: string | null;
  readonly internalRole: string | null;
  readonly roles: readonly PrincipalRole[];
  /** Distinct permission codes across every active, non-revoked role. */
  readonly permissions: ReadonlySet<string>;
  readonly departments: readonly PrincipalDepartment[];
  /**
   * Practice-area scope. The sentinel `'*'` means unrestricted within the
   * tenant. An EMPTY set is a real scope, not a missing one: it restricts the
   * member to matters they are assigned to (§11).
   */
  readonly practiceAreas: ReadonlySet<string>;
  readonly ceilings: AuthorityCeilings;
  readonly language: string;
  readonly calendar: string;
  readonly mfaEnabled: boolean;
  /** Session state, set by the session layer after resolution. */
  readonly mfaVerified: boolean;
}

/** Which numeric ceiling a financial action draws on. */
export type FinancialAuthorityKind = 'invoice' | 'writeoff' | 'discount_pct';

/** Recorded when the engine refuses. The route layer turns it into an audit row. */
export interface PermissionDenial {
  readonly reason: string;
  readonly principal: Pick<FirmPrincipal, 'membershipId' | 'tenantId' | 'userId'>;
  readonly permission?: string;
  readonly resourceType?: string;
  readonly resourceId?: string | null;
  readonly detail?: Record<string, unknown>;
}

export interface PermissionEngineDeps {
  readonly firm: FirmRepo;
  /**
   * Optional sink for refusals. Wiring it means a denial is audited even when
   * the handler forgets to, which is the point: §49 requires the attempt to be
   * recorded, and "the developer remembered" is not a control.
   */
  readonly onDenial?: (denial: PermissionDenial) => Promise<void> | void;
}

// ============================================================================
// ENGINE
// ============================================================================

export class PermissionEngine {
  private readonly firm: FirmRepo;
  private readonly onDenial?: (d: PermissionDenial) => Promise<void> | void;

  constructor(deps: PermissionEngineDeps) {
    this.firm = deps.firm;
    this.onDenial = deps.onDenial;
  }

  // --------------------------------------------------------------------------
  // RESOLUTION
  // --------------------------------------------------------------------------

  /**
   * Builds the principal for a user inside a tenant, or returns null.
   *
   * Null is returned — not thrown — because "no membership here" is a normal
   * answer during login and tenant switching. Routes use `requirePrincipal()`,
   * which turns null into a 403.
   */
  async resolve(userId: string, tenantId: string): Promise<FirmPrincipal | null> {
    const membership = await this.firm.getMembership(userId, tenantId);
    if (!membership) return null;
    // A suspended or departed membership has no principal at all. Their session
    // is revoked by the session layer; this check is the second door.
    if (membership.status !== 'active') return null;
    return this.fromMembership(membership);
  }

  async resolveByMembershipId(membershipId: string): Promise<FirmPrincipal | null> {
    const membership = await this.firm.getMembershipById(membershipId);
    if (!membership || membership.status !== 'active') return null;
    return this.fromMembership(membership);
  }

  private async fromMembership(m: MembershipRow): Promise<FirmPrincipal> {
    const [roles, codes, departments, areas] = await Promise.all([
      this.firm.getRoles(m.id),
      this.firm.getPermissionCodes(m.id),
      this.firm.getDepartments(m.id),
      this.firm.getPracticeAreas(m.id),
    ]);
    return {
      kind: 'firm_member',
      membershipId: m.id,
      tenantId: m.tenantId,
      userId: m.userId,
      staffId: m.staffId,
      email: m.email,
      displayName: m.staffName ?? m.email,
      displayNameAr: m.staffNameAr,
      jobTitle: m.jobTitle,
      jobTitleAr: m.jobTitleAr,
      internalRole: m.internalRole,
      roles,
      permissions: new Set(codes),
      departments,
      practiceAreas: new Set(areas),
      ceilings: {
        financialSar: m.financialAuthority,
        writeoffSar: m.writeoffAuthority,
        discountPct: m.discountPct,
      },
      language: m.language,
      calendar: m.calendar,
      mfaEnabled: m.mfaEnabled,
      mfaVerified: false,
    };
  }

  /** Same principal with the session's MFA state applied. Returns a new object. */
  withMfaVerified(p: FirmPrincipal, verified: boolean): FirmPrincipal {
    return { ...p, mfaVerified: verified };
  }

  // --------------------------------------------------------------------------
  // PERMISSION CHECKS (§8, §9-§16)
  // --------------------------------------------------------------------------

  can(p: FirmPrincipal, code: string): boolean {
    return p.permissions.has(code);
  }

  canAny(p: FirmPrincipal, codes: readonly string[]): boolean {
    return codes.some((c) => p.permissions.has(c));
  }

  /** True when the member's practice scope covers the whole tenant. */
  hasFirmWideScope(p: FirmPrincipal): boolean {
    return p.practiceAreas.has('*') || p.permissions.has('matters.read_all');
  }

  /**
   * Assert a permission. Throws 403 on refusal and records the attempt.
   *
   * The thrown error deliberately does NOT name the permission: telling a
   * paralegal "you lack users.assign_role" confirms the endpoint exists and
   * invites the next probe. The permission is in the audit row, where it belongs.
   */
  assertCan(
    p: FirmPrincipal,
    code: string,
    resource?: { type: string; id?: string | null },
  ): void {
    if (p.permissions.has(code)) return;
    void this.deny({
      reason: 'permission_denied',
      principal: p,
      permission: code,
      resourceType: resource?.type,
      resourceId: resource?.id ?? null,
    });
    throw new PortalError(403, 'forbidden', 'You do not have access to this action', {
      auditReason: `permission_denied:${code}`,
      resource: resource ? { type: resource.type, id: resource.id ?? null } : undefined,
    });
  }

  /**
   * Assert one of several permissions, for endpoints where more than one role
   * has a legitimate reason to arrive. The audit row records the whole set that
   * was accepted, so a reviewer can see the gate that was tested.
   */
  assertCanAny(
    p: FirmPrincipal,
    codes: readonly string[],
    resource?: { type: string; id?: string | null },
  ): void {
    if (codes.some((c) => p.permissions.has(c))) return;
    void this.deny({
      reason: 'permission_denied',
      principal: p,
      permission: codes.join('|'),
      resourceType: resource?.type,
      resourceId: resource?.id ?? null,
    });
    throw new PortalError(403, 'forbidden', 'You do not have access to this action', {
      auditReason: `permission_denied:${codes.join('|')}`,
      resource: resource ? { type: resource.type, id: resource.id ?? null } : undefined,
    });
  }

  // --------------------------------------------------------------------------
  // MATTER ACCESS (§17, §27, §71)
  // --------------------------------------------------------------------------

  /**
   * The access level for one matter, or 'none'.
   *
   * Mirrors `matter_access_level(uuid)` in migration 0006 branch for branch.
   * Changing one without the other is the single most dangerous edit in this
   * file, which is why the correspondence is asserted in tests rather than left
   * to review.
   */
  async matterAccessLevel(p: FirmPrincipal, matterId: string): Promise<AccessLevel> {
    const facts = await this.firm.getMatterAuthFacts(p.tenantId, matterId, p.membershipId, p.staffId);
    if (!facts) return 'none';
    return this.levelFromFacts(p, facts);
  }

  /**
   * Pure function over facts, split out so the precedence can be tested without
   * a database and so the list endpoint and the detail endpoint provably use the
   * same rule.
   */
  levelFromFacts(
    p: FirmPrincipal,
    facts: Pick<MatterAuthFacts, 'isRestricted' | 'explicitLevel' | 'teamLevel' | 'practiceArea'>,
  ): AccessLevel {
    // 1 · An explicit grant wins outright. That includes an explicit 'none',
    //     which is a recorded exclusion and must survive everything below.
    if (facts.explicitLevel) return normalizeLevel(facts.explicitLevel);

    // 2 · Restricted: nothing else counts (§27).
    if (facts.isRestricted) return 'none';

    // 3 · The matter_team role's default level.
    if (facts.teamLevel) return normalizeLevel(facts.teamLevel);

    // 4 · Practice-area scope, or the firm-wide read permission. Weakest useful
    //     level only: seeing that a matter exists is not editing it.
    if (this.inPracticeScope(p, facts.practiceArea)) return 'view';

    return 'none';
  }

  /**
   * Practice scope, including the two widening permissions.
   *
   * `'*'` is the Managing Partner's sentinel. `matters.read_all` is what lets
   * Finance bill across the firm without being added to every matter team — a
   * permission, not a scope row, so it can be revoked without touching the
   * member's legal scope.
   */
  inPracticeScope(p: FirmPrincipal, practiceArea: string | null): boolean {
    if (p.practiceAreas.has('*')) return true;
    if (p.permissions.has('matters.read_all')) return true;
    if (!practiceArea) return false;
    return p.practiceAreas.has(practiceArea);
  }

  /**
   * Facts plus the resolved level, or a 404.
   *
   * The 404 is the same shape the portal uses for "not yours": a matter in
   * another tenant, a matter that does not exist, and a matter this member may
   * not see are indistinguishable from the outside. The difference is recorded
   * in the audit row, where an incident reviewer can see it.
   */
  async requireMatter(
    p: FirmPrincipal,
    matterId: string,
    acceptable: readonly AccessLevel[],
  ): Promise<{ facts: MatterAuthFacts; level: AccessLevel }> {
    const facts = await this.firm.getMatterAuthFacts(p.tenantId, matterId, p.membershipId, p.staffId);
    if (!facts) {
      void this.deny({
        reason: 'matter_not_found',
        principal: p,
        resourceType: 'matter',
        resourceId: matterId,
      });
      throw notFoundMatter();
    }

    const level = this.levelFromFacts(p, facts);
    if (!acceptable.includes(level)) {
      void this.deny({
        reason: level === 'none' ? 'matter_not_visible' : 'matter_level_insufficient',
        principal: p,
        resourceType: 'matter',
        resourceId: matterId,
        detail: { level, acceptable: [...acceptable], restricted: facts.isRestricted },
      });
      throw notFoundMatter();
    }

    return { facts, level };
  }

  /** The matters this member may see, each labelled with its resolved level. */
  async listMatters(p: FirmPrincipal) {
    const rows = await this.firm.listVisibleMatters({
      tenantId: p.tenantId,
      membershipId: p.membershipId,
      staffId: p.staffId,
      practiceAreas: [...p.practiceAreas],
      readAll: p.permissions.has('matters.read_all'),
    });
    return rows
      .map((r) => ({
        ...r,
        accessLevel: this.levelFromFacts(p, {
          isRestricted: r.isRestricted,
          explicitLevel: r.explicitLevel,
          teamLevel: r.teamLevel,
          practiceArea: r.practiceArea,
        }),
      }))
      // Defence in depth: the query already filtered, so this should be a no-op.
      // It stays because a list endpoint that leaks is the worst kind of bug, and
      // a redundant filter costs nothing.
      .filter((r) => r.accessLevel !== 'none');
  }

  // --------------------------------------------------------------------------
  // FINANCIAL AUTHORITY (§10, §38, §73)
  // --------------------------------------------------------------------------

  /**
   * The ceiling that applies, or null when the member holds none.
   *
   * NULL IS REFUSAL. This is the single most important line in the file: the
   * natural way to write it is `ceiling ?? Infinity`, and that one character
   * difference is the whole attack.
   */
  ceilingFor(p: FirmPrincipal, kind: FinancialAuthorityKind): number | null {
    switch (kind) {
      case 'invoice': return p.ceilings.financialSar;
      case 'writeoff': return p.ceilings.writeoffSar;
      case 'discount_pct': return p.ceilings.discountPct;
      default: return null;
    }
  }

  /**
   * Assert that an amount is within authority.
   *
   * Refuses when: the amount is not a finite non-negative number; the member has
   * no ceiling for this kind; or the amount exceeds it. Comparison is on the
   * rounded cent, because a ceiling of 25,000.00 must not be defeated by
   * submitting 25,000.004.
   */
  assertWithinAuthority(
    p: FirmPrincipal,
    kind: FinancialAuthorityKind,
    amount: number,
    resource?: { type: string; id?: string | null },
  ): void {
    const refuse = (reason: string, detail: Record<string, unknown>) => {
      void this.deny({
        reason,
        principal: p,
        resourceType: resource?.type ?? 'financial_action',
        resourceId: resource?.id ?? null,
        detail: { kind, ...detail },
      });
      throw new PortalError(403, 'forbidden', 'This action exceeds your financial authority', {
        auditReason: `${reason}:${kind}`,
        resource: resource ? { type: resource.type, id: resource.id ?? null } : undefined,
      });
    };

    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      refuse('invalid_amount', { amount: Number.isFinite(amount) ? amount : String(amount) });
    }

    const ceiling = this.ceilingFor(p, kind);
    if (ceiling === null) refuse('ceiling_not_set', { amount: round2(amount) });

    // A discount is a percentage; the same comparison applies, on 0-100.
    if (round2(amount) > round2(ceiling as number)) {
      refuse('ceiling_exceeded', { amount: round2(amount), ceiling: round2(ceiling as number) });
    }
  }

  /**
   * Approving money needs BOTH the permission and the ceiling. Splitting them
   * into one call is deliberate: a handler that checks only the permission is
   * the exact bug §73 asks us to test for, and this is the method the handlers
   * are told to use.
   */
  assertCanApproveAmount(
    p: FirmPrincipal,
    permission: string,
    kind: FinancialAuthorityKind,
    amount: number,
    resource?: { type: string; id?: string | null },
  ): void {
    this.assertCan(p, permission, resource);
    this.assertWithinAuthority(p, kind, amount, resource);
  }

  // --------------------------------------------------------------------------
  // MFA GATING (§52)
  // --------------------------------------------------------------------------

  /**
   * Critical permissions require a verified second factor when the tenant says
   * so. Checked separately from `assertCan` because it depends on session state
   * rather than the authorization graph.
   *
   * THE ENROLMENT DETAIL IS THE WHOLE CONTROL
   *   `mfaVerified` on the principal is true for a member who has NOT enrolled,
   *   because elsewhere in the system "no second factor configured" means "no
   *   second factor to satisfy". That is right for a portal session and wrong
   *   here: when a firm switches on compulsory MFA for its administrators, a
   *   Managing Partner who never enrolled must be REFUSED, not waved through on
   *   the strength of a flag that means "nothing to check". So this gate demands
   *   both enrollment and verification.
   */
  assertMfaForCritical(p: FirmPrincipal, code: string, mfaRequired: boolean): void {
    if (!mfaRequired) return;
    const def = PERMISSIONS.find((x) => x.code === code);
    if (!def || def.sensitivity !== 'critical') return;
    if (p.mfaEnabled && p.mfaVerified) return;
    void this.deny({
      reason: 'mfa_required',
      principal: p,
      permission: code,
      detail: { enrolled: p.mfaEnabled, verified: p.mfaVerified, sensitivity: def.sensitivity },
    });
    throw new PortalError(403, 'mfa_required',
      p.mfaEnabled
        ? 'Multi-factor verification is required for this action'
        : 'Multi-factor authentication must be enrolled before this action', {
        auditReason: `mfa_required:${code}`,
        details: { step: p.mfaEnabled ? 'mfa' : 'enroll_mfa' },
      });
  }

  // --------------------------------------------------------------------------
  // DENIAL SINK
  // --------------------------------------------------------------------------

  private deny(d: PermissionDenial): void {
    if (!this.onDenial) return;
    // Fire and forget, but never let an audit failure mask the refusal: the
    // 403 has to reach the client even if the sink throws.
    try {
      const r = this.onDenial(d);
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((err) => {
          console.error('[firm] denial audit failed', d.reason, err instanceof Error ? err.message : err);
        });
      }
    } catch (err) {
      console.error('[firm] denial audit threw', d.reason, err instanceof Error ? err.message : err);
    }
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/** Anything unrecognised collapses to 'none'. Fail closed, always. */
export function normalizeLevel(v: string | null | undefined): AccessLevel {
  return (ACCESS_LEVELS as readonly string[]).includes(String(v))
    ? (String(v) as AccessLevel)
    : 'none';
}

/** Exposed for tests that build facts by hand. */
export { teamRoleToLevel };

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * "Not found" for a matter the caller may not see. Indistinguishable from a
 * matter that does not exist, which is the point (§72: URL-level probing must
 * not be able to enumerate the firm's matter list).
 */
function notFoundMatter(): PortalError {
  return new PortalError(404, 'not_found', 'matter not found', {
    auditReason: 'matter_scope_denied',
    resource: { type: 'matter', id: null },
  });
}
