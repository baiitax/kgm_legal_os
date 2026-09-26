/**
 * §57 · FIELD-LEVEL CLASSIFICATION.
 *
 * Matter access answers "may this person open this matter?". It does not answer
 * "which of its fields may they read?" — and treating those as one question is
 * how internal notes reach a paralegal who is legitimately on the team.
 *
 * This module is the second half of that decision. A resource is projected
 * through a REGISTRY of field rules; each rule names the database column, the
 * wire name, and the classification that decides whether it is emitted for this
 * caller.
 *
 * FOUR PROPERTIES THAT ARE LOAD-BEARING
 *
 * 1. DEFAULT DENY, IN BOTH DIRECTIONS.
 *    A field with no rule is not emitted. A rule whose classification the caller
 *    does not meet is not emitted. There is no "everything except" list, because
 *    an exclusion list fails open the moment someone adds a column — the exact
 *    failure mode `dto.ts` was written to avoid on the client side.
 *
 * 2. LEVELS ARE NOT A LADDER.
 *    `financial` and `compliance` are lateral to `operational`, matching the
 *    access-level model in permissions.ts. A finance officer with `financial`
 *    access sees money and not legal strategy; a compliance officer sees
 *    conflict state and not pleadings. Each classification therefore declares an
 *    ACCEPTANCE SET of access levels rather than a minimum rank.
 *
 * 3. WITHHELD NAMES ARE REPORTED, VALUES NEVER ARE.
 *    The projector returns the names it withheld so the UI can render a lock
 *    instead of a blank the user cannot interpret. A name is included whether or
 *    not the underlying value is null — deriving the list from values would turn
 *    it into an existence oracle, letting a caller discover that a matter has a
 *    risk rating by watching the list change.
 *
 * 4. `never` MEANS NO WIRE FORMAT EXISTS.
 *    Storage keys, credential material and identity hashes are not "high
 *    classification" — there is no caller for whom emitting them is correct.
 *    They are excluded from every projection and a runtime assertion fails the
 *    request if one appears in output anyway, so a future refactor cannot
 *    quietly promote them.
 */
import {
  MATTER_COMPLIANCE, MATTER_FINANCIAL, MATTER_MANAGE, MATTER_OPERATE, MATTER_READ,
  MATTER_WRITE,
  type AccessLevel, type FirmPrincipal,
} from './permissions.js';
import { NO_RING, type LawyerRing } from './privilege.js';

// ============================================================================
// CLASSIFICATION TIERS
// ============================================================================

export type Classification =
  | 'public'
  | 'internal'
  | 'confidential'
  /** P0.5 — the lawyer ring. Level is not enough; the licence decides. */
  | 'privileged'
  | 'financial'
  | 'compliance'
  | 'restricted'
  | 'never';

/**
 * Which matter access levels satisfy each classification.
 *
 * `internal` deliberately EXCLUDES a bare `view`. Practice-area scope entitles a
 * partner to know that a matter exists, who the client is and where it stands —
 * it does not hand them the firm's work product on a matter they are not on.
 * Widening this set is a policy change, not a bug fix, and the classification
 * suite asserts the current boundary.
 */
export const CLASSIFICATION_ACCEPTS: Readonly<Record<Classification, readonly AccessLevel[]>> = {
  public: MATTER_READ,
  internal: [...MATTER_OPERATE, ...MATTER_FINANCIAL, ...MATTER_COMPLIANCE],
  // Whoever writes the substance of a matter may read the firm's notes on it.
  // `operational` is deliberately outside this set: a paralegal does the work,
  // the risk assessment is not theirs to read.
  confidential: MATTER_WRITE,
  /*
    PRIVILEGED (§P0.5). The level half of the ring: whoever writes the substance of
    the matter — `confidential` already stops a paralegal. The other half is not a
    level at all and is checked separately, because the duty under المادة الثالثة
    والعشرون attaches to the LICENSE, not to the file: a partner whose licence is
    suspended this morning must lose this field this morning, and an associate who
    has never been admitted holds nothing for it to cover.
  */
  privileged: MATTER_WRITE,
  financial: MATTER_FINANCIAL,
  compliance: MATTER_COMPLIANCE,
  // Stricter than `confidential` on purpose. The reason a matter was restricted
  // is itself sensitive, and it is gated on a PERMISSION as well as a level, so
  // a partner with `full` access who cannot manage restrictions still does not
  // learn why.
  restricted: MATTER_MANAGE,
  never: [],
};

/**
 * Column names that must never appear in ANY API response for ANY caller,
 * including the Managing Partner. Kept as a flat list, checked after projection,
 * because it guards against a mistake in a registry rather than a mistake in a
 * permission check.
 */
export const NEVER_ON_THE_WIRE: ReadonlySet<string> = new Set([
  // storage layout — the browser never learns a key it could replay (§18)
  'storage_key', 'storageKey', 'storage_bucket', 'storageBucket', 'stored_filename', 'storedFilename',
  // credential and token material
  'password_hash', 'passwordHash', 'token_hash', 'tokenHash', 'totp_secret', 'totpSecret',
  'mfa_secret', 'mfaSecret', 'recovery_codes', 'recoveryCodes', 'session_token', 'sessionToken',
  // identity digests — a hash of a national ID is still a national ID (§44)
  'national_id_hash', 'nationalIdHash', 'national_id', 'nationalId',
  'commercial_reg_number', 'commercialRegNumber', 'passport_number', 'passportNumber',
  // internal counters an attacker can use to pace a brute-force attempt
  'failed_login_count', 'failedLoginCount', 'locked_until', 'lockedUntil',
  // prototype pollution, for the same reason it is on the request denylist
  '__proto__', 'constructor', 'prototype',
]);

// ============================================================================
// FIELD RULES
// ============================================================================

export interface FieldRule {
  /** Column in the database row. */
  readonly source: string;
  /** Name on the wire. Defaults to `source` when omitted. */
  readonly out?: string;
  readonly level: Classification;
  /**
   * An additional permission the caller must hold ON TOP OF the access level.
   * Used where a classification is not enough — e.g. the restriction reason is
   * `restricted` AND requires `matters.restrict`, so a partner with `full`
   * access who cannot manage restrictions still does not learn why.
   */
  readonly permission?: string;
  /**
   * P0.5 — the field is inside the lawyer ring, and the membership must be in it.
   *
   * A flag rather than a fourth kind of check inside `visible()`, because the ring
   * is not a property of the field: `restrictionReason` is withheld from a partner
   * without `matters.restrict`, and `internalNotes` is withheld from the firm's own
   * managing partner if his licence is not current. Stating it per rule keeps the
   * two reasons separable in the withheld list, which is what the member sees.
   */
  readonly requiresLawyerRing?: boolean;
  /** Applied to the value before it is emitted. Masking lives here, not in handlers. */
  readonly mask?: (value: unknown) => unknown;
}

export type Registry = Readonly<Record<string, readonly FieldRule[]>>;

/** The wire name a rule emits. */
export function outName(rule: FieldRule): string {
  return rule.out ?? rule.source;
}

/** True when `level` is satisfied by this access level. */
export function levelAccepts(level: Classification, access: AccessLevel): boolean {
  return CLASSIFICATION_ACCEPTS[level].includes(access);
}

export interface ProjectionContext {
  readonly principal: FirmPrincipal;
  /** The access level already resolved for THIS resource. Never re-derived here. */
  readonly accessLevel: AccessLevel;
  /**
   * The lawyer ring, already resolved for this member. Never re-derived here.
   *
   * Optional so that the many call sites that project nothing privileged do not
   * have to know the ring exists; a rule that requires it and a context that omits
   * it resolves to NO_RING, which is the refusing direction. Default-deny is the
   * module's first property, and an omitted fact must fail the same way an
   * unlisted field does.
   */
  readonly ring?: LawyerRing;
}

export interface Projection<T> {
  /** Only the fields this caller may see. */
  readonly data: T;
  /**
   * Wire names withheld by classification, regardless of whether they held a
   * value. Sorted, so a caller cannot infer ordering from the registry.
   */
  readonly withheld: readonly string[];
}

// ============================================================================
// PROJECTOR
// ============================================================================

/**
 * Projects one row through one registry.
 *
 * The row is read by column name and nothing is spread: `...row` would defeat
 * the entire module. A column present in the row but absent from the registry is
 * silently dropped, which is the desired default — it is far better to ship a
 * screen missing a field than to ship one leaking it.
 */
export function project<T extends object>(
  resourceType: string,
  rules: readonly FieldRule[],
  row: Record<string, unknown>,
  ctx: ProjectionContext,
): Projection<T> {
  const data: Record<string, unknown> = {};
  const withheld: string[] = [];

  for (const rule of rules) {
    const name = outName(rule);
    if (!visible(rule, ctx)) {
      withheld.push(name);
      continue;
    }
    const raw = row[rule.source];
    const value = rule.mask ? rule.mask(raw) : (raw === undefined ? null : raw);
    // A masked-to-null field is still emitted: the caller is entitled to know
    // the field exists and is empty-for-them, and masking is a transformation
    // rather than a classification decision.
    data[name] = value ?? null;
  }

  assertNothingForbidden(resourceType, data);

  return {
    data: data as T,
    withheld: [...new Set(withheld)].sort(),
  };
}

/** Whether one rule is visible to this caller. */
export function visible(rule: FieldRule, ctx: ProjectionContext): boolean {
  if (rule.level === 'never') return false;
  if (!levelAccepts(rule.level, ctx.accessLevel)) return false;
  if (rule.permission && !ctx.principal.permissions.has(rule.permission)) return false;
  /* The ring is checked LAST and is independent of the level: a `full` partner who
     is not in the ring is refused, and an `edit` associate who is in it is admitted.
     An omitted context ring is NO_RING — the refusing direction. */
  if (rule.requiresLawyerRing && !(ctx.ring ?? NO_RING).inRing) return false;
  return true;
}

/**
 * Fails the request rather than the leak.
 *
 * Throwing here is intentional and aggressive: a field on NEVER_ON_THE_WIRE in
 * output means a registry was edited wrongly, and the alternative — stripping it
 * and continuing — would let the mistake persist unnoticed in a codebase where
 * every other control is asserted. The error is a 500 by design; it is a bug in
 * the server, not a condition the caller caused.
 */
function assertNothingForbidden(resourceType: string, data: Record<string, unknown>): void {
  for (const key of Object.keys(data)) {
    if (NEVER_ON_THE_WIRE.has(key)) {
      throw new Error(
        `classification: ${resourceType} projection emitted "${key}", which is on NEVER_ON_THE_WIRE`,
      );
    }
  }
}

// ============================================================================
// MASKS
// ============================================================================

/**
 * Masks an identifier to its last four characters.
 *
 * Used where a member legitimately needs to recognise a value — confirm they are
 * looking at the right commercial registration — without being handed the whole
 * of it. Returns null for anything too short to mask meaningfully, because a
 * two-character string with one character redacted is not a mask.
 */
export function maskLast4(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (s.length <= 4) return null;
  return `${'•'.repeat(Math.min(s.length - 4, 12))}${s.slice(-4)}`;
}

/** Replaces a value with a boolean presence flag, for fields that must not be readable at all. */
export function presenceOnly(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).length > 0;
}

// ============================================================================
// REGISTRIES
// ============================================================================

/**
 * Matter fields (§18-§20).
 *
 * Ordered from least to most sensitive so a reviewer reading the registry sees
 * the escalation rather than having to hunt for it.
 */
export const MATTER_FIELDS: readonly FieldRule[] = [
  { source: 'id', level: 'public' },
  { source: 'matter_number', out: 'matterNumber', level: 'public' },
  { source: 'case_number', out: 'caseNumber', level: 'public' },
  { source: 'title', level: 'public' },
  { source: 'title_ar', out: 'titleAr', level: 'public' },
  { source: 'practice_area', out: 'practiceArea', level: 'public' },
  { source: 'practice_area_ar', out: 'practiceAreaAr', level: 'public' },
  { source: 'client_name', out: 'clientName', level: 'public' },
  { source: 'client_name_ar', out: 'clientNameAr', level: 'public' },
  { source: 'opened_at', out: 'openedAt', level: 'public' },
  { source: 'client_status', out: 'clientStatus', level: 'public' },

  // The firm's own lifecycle and venue. Visible to anyone working the matter,
  // not to someone who merely sees it in their practice-area list.
  { source: 'internal_status', out: 'internalStatus', level: 'internal' },
  { source: 'court', level: 'internal' },
  { source: 'court_ar', out: 'courtAr', level: 'internal' },
  { source: 'summary', level: 'internal' },
  { source: 'summary_ar', out: 'summaryAr', level: 'internal' },
  { source: 'closed_at', out: 'closedAt', level: 'internal' },

  /*
    THE RING (§P0.5). Both of these were `confidential`, which meant any member with
    write access — and the gap analysis found `internal_notes` reachable by a
    paralegal, a finance officer and a compliance officer. They are not the same
    question as `client_due_diligence.risk_rating`, which is the AML assessment of
    the CLIENT and stays readable by compliance: this one is the firm's assessment of
    its own exposure, which is advice, which is what المادة الثالثة والعشرون covers.
  */
  { source: 'risk_rating', out: 'riskRating', level: 'privileged', requiresLawyerRing: true },
  { source: 'internal_notes', out: 'internalNotes', level: 'privileged', requiresLawyerRing: true },
  { source: 'conflict_cleared', out: 'conflictCleared', level: 'compliance' },
  { source: 'restriction_reason', out: 'restrictionReason', level: 'restricted', permission: 'matters.restrict' },
  { source: 'restriction_reason_ar', out: 'restrictionReasonAr', level: 'restricted', permission: 'matters.restrict' },

  // Structural. Declared so the omission is visible in the registry rather than
  // implicit, and so the projector would throw if a rule ever emitted them.
  { source: 'tenant_id', out: 'tenantId', level: 'never' },
];

/**
 * The matter LIST projection (§18).
 *
 * A list is not a smaller detail view — it is a different promise. Everything
 * here is `public`, because a list is read in one glance by someone deciding
 * what to open next, and a column that appears for some rows and not others is a
 * column nobody can sort or scan.
 *
 * What is NOT here matters more. `riskRating` and `internalStatus` were being
 * emitted by the list endpoint before classification existed, which meant a
 * finance officer holding `matters.read_all` — and therefore `view` on matters
 * she was never assigned to — could read the firm's risk assessment for the
 * whole practice from the list while the detail endpoint correctly refused her.
 * Two endpoints, one resource, two answers is the failure mode §57 exists to
 * prevent, and it is invisible unless something asserts both.
 *
 * `restricted` stays as a BOOLEAN flag on the list. Knowing that a matter is
 * locked is what stops someone opening it; the reason is `restricted`
 * classification and lives on the detail view only.
 */
export const MATTER_LIST_FIELDS: readonly FieldRule[] = [
  { source: 'id', level: 'public' },
  { source: 'matterNumber', level: 'public' },
  { source: 'title', level: 'public' },
  { source: 'titleAr', level: 'public' },
  { source: 'practiceArea', level: 'public' },
  { source: 'practiceAreaAr', level: 'public' },
  { source: 'clientName', level: 'public' },
  { source: 'clientNameAr', level: 'public' },
  { source: 'openedAt', level: 'public' },
  { source: 'clientStatus', level: 'public' },
];

/** The registry lookup, so handlers cannot invent a resource type at the call site. */
export const REGISTRIES: Registry = {
  matter: MATTER_FIELDS,
  matterList: MATTER_LIST_FIELDS,
};

/**
 * Projects a matter row for one caller.
 *
 * This is the entry point handlers use. It exists so that the resource type is
 * fixed here rather than passed by each caller, and so the withheld list is
 * always returned in the same shape.
 */
export function projectMatter<T extends object>(
  row: Record<string, unknown>,
  ctx: ProjectionContext,
): Projection<T> {
  return project<T>('matter', REGISTRIES.matter, row, ctx);
}

/**
 * Projects one row of the matter LIST for one caller.
 *
 * Note the source names here are the repository's camelCase row, not database
 * columns: `listVisibleMatters` already normalizes. That asymmetry with
 * MATTER_FIELDS is deliberate and harmless — what must never differ between the
 * two is the CLASSIFICATION of a field, and `restricted`/`riskRating` carry the
 * same tier wherever they appear.
 *
 * Every row in a list carries its own access level, so the context is per row
 * rather than per request. Projecting a whole list at the caller's highest level
 * would leak on exactly the rows where they are weakest.
 */
export function projectMatterList<T extends object>(
  row: Record<string, unknown>,
  ctx: ProjectionContext,
): Projection<T> {
  return project<T>('matterList', REGISTRIES.matterList, row, ctx);
}
