/**
 * KGM LEGAL OS — CLIENT DUE DILIGENCE AND THE AML GATES (§P0.3)
 *
 * WHY THIS MODULE IS PURE
 *
 *   Everything here answers a question about a set of facts and returns an answer with
 *   its reasons. Nothing reads the database, nothing writes one, and nothing knows what
 *   an HTTP request is — because the same answers are needed in four places that must
 *   not disagree: the firm's screen, the route that refuses a write, the nightly
 *   reconciliation of who is overdue a review, and the live verifier that asks
 *   PostgreSQL whether the gates really hold.
 *
 * THE OBLIGATION, IN ONE PARAGRAPH
 *
 *   A law firm in Saudi Arabia is a Designated Non-Financial Business and Profession
 *   under the Anti-Money Laundering Law (Royal Decree M/20 of 2017, and the AML-CFT
 *   manual issued to the profession). That status carries five things a lawyer cannot
 *   delegate to a filing cabinet: know who the client is, know who is really behind the
 *   client (the beneficial owner, at a 25% threshold), know whether either is a
 *   politically exposed person or a designated person, keep asking while the
 *   relationship lasts, and report what looks wrong to SAFIU in Arabic without telling
 *   the person reported. The manual states the consequence of failing the first of
 *   those plainly: **the lawyer may not act.**
 *
 * WHY THE ANSWERS ARE COMPUTED RATHER THAN STORED
 *
 *   The system that preceded this phase carried `clients.identity_verified`, a boolean
 *   somebody typed. A boolean nobody computed is worse than no boolean, because it is
 *   believed. Every flag this module produces — whether due diligence is complete,
 *   whether the owners are accounted for, whether screening is resolved, what the risk
 *   rating is — is derived from the record, and the database derives the same things
 *   behind the same write so that an application bug cannot assert them.
 */

/** The beneficial-ownership threshold the manual sets: a quarter of the capital. */
export const UBO_THRESHOLD_PCT = 25;

/**
 * How long the firm has to report a suspicious operation.
 *
 * The manual requires reporting to SAFIU "without delay", and the operating practice a
 * DNFBP is measured against is three working days. It is expressed here as WORKING days
 * because the Saudi week is Sunday to Thursday: a suspicion arising on Wednesday
 * evening is not due on Saturday, when nobody is there to file it.
 */
export const STR_WORKING_DAYS = 3;

/** The Saudi working week, as `Date.getDay()` numbers. 5 = Friday, 6 = Saturday. */
export const WEEKEND_DAYS = [5, 6] as const;

export type ClientKind = 'individual' | 'organization';
export type CddLevel = 'simplified' | 'standard' | 'enhanced';
export type CddStatus = 'not_started' | 'in_progress' | 'complete' | 'unable_to_complete' | 'expired';
export type RiskRating = 'low' | 'medium' | 'high';
export type PepStatus = 'not_pep' | 'pep' | 'pep_family' | 'pep_associate';
export type ScreeningStatus = 'clear' | 'potential_match' | 'match' | 'failed';
export type ScreeningSubjectKind = 'client' | 'party' | 'beneficial_owner' | 'staff';
export type MatchDisposition = 'open' | 'false_positive' | 'true_match' | 'escalated';

// ═══════════════════════════════════════════════════════════════════════════════
// 1 · WHAT MUST BE RECORDED, AND FOR WHOM
// ═══════════════════════════════════════════════════════════════════════════════

export interface Requirement {
  /** Stable key, so a refusal can name one requirement in a test. */
  key: string;
  label: string;
  labelAr: string;
  /** True when the record's absence forbids acting; false when it is incomplete but not fatal. */
  blocking: boolean;
}

/**
 * The identification record, by what the client IS.
 *
 * A natural person is identified by who they are — a name, a birth date, a nationality,
 * an address on the register, and a document that proves it. A legal person is not
 * identified by its certificate of incorporation; that only says a company exists. It
 * is identified by who controls it, which is why the ownership requirement appears here
 * as a requirement rather than as a separate workflow the clerk can forget.
 */
export function requirementsFor(kind: ClientKind, level: CddLevel): Requirement[] {
  const common: Requirement[] = [
    { key: 'legal_name', label: 'the full legal name', labelAr: 'الاسم القانوني الكامل', blocking: true },
    { key: 'address', label: 'a verified address', labelAr: 'عنوان موثّق', blocking: true },
    { key: 'identity_document', label: 'an identity document, recorded as a hash and a mask',
      labelAr: 'مستند هوية محفوظ كبصمة وقناع', blocking: true },
    { key: 'verification_method', label: 'how the identity was verified',
      labelAr: 'طريقة التحقق من الهوية', blocking: true },
    { key: 'source_of_funds', label: 'the source of the funds', labelAr: 'مصدر الأموال', blocking: true },
    { key: 'purpose', label: 'the purpose of the relationship',
      labelAr: 'الغرض من العلاقة', blocking: true },
    { key: 'pep_status', label: 'a recorded PEP determination',
      labelAr: 'تحديد ما إذا كان شخصاً ذا نفوذ سياسي', blocking: true },
  ];

  if (kind === 'individual') {
    common.splice(3, 0,
      { key: 'date_of_birth', label: 'the date of birth', labelAr: 'تاريخ الميلاد', blocking: true },
      { key: 'nationality', label: 'the nationality', labelAr: 'الجنسية', blocking: true });
  } else {
    common.splice(1, 0,
      { key: 'cr_number', label: 'the commercial registration number',
        labelAr: 'رقم السجل التجاري', blocking: true },
      { key: 'incorporation_country', label: 'the country of incorporation',
        labelAr: 'بلد التأسيس', blocking: true },
      { key: 'business_activity', label: 'what the company actually does',
        labelAr: 'النشاط الفعلي للشركة', blocking: true },
      { key: 'owners', label: 'the beneficial owners who control it',
        labelAr: 'المستفيدون الحقيقيون المسيطرون', blocking: true });
  }

  /*
    Enhanced due diligence asks for two things a standard relationship does not, and
    both are about the *person* rather than the paperwork: where the wealth came from,
    and a named human who accepted the risk. A firm that records the first without the
    second has written an essay, not a decision.
  */
  if (level === 'enhanced') {
    common.push(
      { key: 'source_of_wealth', label: 'the source of wealth, separately from the funds',
        labelAr: 'مصدر الثروة، منفصلاً عن الأموال', blocking: true },
      { key: 'senior_approval', label: 'approval by senior management, recorded by name',
        labelAr: 'موافقة الإدارة العليا بالاسم', blocking: true },
      { key: 'screening', label: 'screening of every person in the relationship, current and clear',
        labelAr: 'فحص كل شخص في العلاقة، حديثاً وسليماً', blocking: true });
  }

  return common;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2 · THE FACTS THIS MODULE REASONS OVER
// ═══════════════════════════════════════════════════════════════════════════════

export interface CddFacts {
  clientKind: ClientKind;
  level: CddLevel;
  status: CddStatus;
  legalName: string | null;
  legalNameAr: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  residenceCountry: string | null;
  address: string | null;
  crNumber: string | null;
  incorporationCountry: string | null;
  businessActivity: string | null;
  idType: string | null;
  idNumberHash: string | null;
  sourceOfFunds: string | null;
  sourceOfWealth: string | null;
  purpose: string | null;
  verificationMethod: string | null;
  pepStatus: PepStatus | null;
  /** Null when no senior manager has accepted the risk; enhanced DD requires one. */
  seniorApprovedByMembershipId: string | null;
  reviewDueAt: string | null;
  /** How many persons in the relationship have been screened and cleared. Supplied by the caller. */
  screening: ScreeningState;
  /** Whether a legal person's ownership has been accounted for. Supplied by the caller. */
  ownership: OwnershipCoverage;
}

export interface OwnerFacts {
  fullName: string;
  /**
   * Whether the owner is a person or another company.
   *
   * THIS FIELD IS THE WHOLE RULE, and it was missing from the first draft of this file —
   * which counted a Jersey holding company at 100% as an identified owner and would have
   * admitted Nukhba. A beneficial owner, in the manual and in the FATF glossary, is a
   * NATURAL PERSON: a company that owns a company is a layer, and the obligation is to
   * look through it until people appear. A percentage written next to a legal person is a
   * statement about the structure, not about who is behind it.
   */
  ownerKind: 'natural_person' | 'legal_person';
  ownershipPct: number | null;
  controlBasis: 'ownership' | 'voting_rights' | 'senior_management' | 'other';
  nationality: string | null;
  residenceCountry: string | null;
  dateOfBirth: string | null;
  idNumberHash: string | null;
  isPep: boolean;
  verifiedAt: string | null;
}

export interface ScreeningRunFacts {
  id: string;
  subjectKind: ScreeningSubjectKind;
  subjectId: string;
  listSets: string[];
  listAsOf: string | null;
  status: ScreeningStatus;
  matches: Array<{ id: string; disposition: MatchDisposition }>;
  runAt: string;
}

export type ScreeningSubject = { kind: ScreeningSubjectKind; id: string; name: string };

export interface ScreeningState {
  /** Persons the relationship contains and the policy requires screened. */
  required: ScreeningSubject[];
  /** Of those, the ones with at least one run that is current and not failed. */
  screened: ScreeningSubject[];
  unscreened: ScreeningSubject[];
  /** Matches found but not yet dispositioned — the reason a cleared-looking client is not cleared. */
  unresolvedMatches: Array<{ runId: string; matchId: string; subjectId: string; listSets: string[] }>;
  /** A confirmed designation. Nothing resolves it: the relationship is prohibited. */
  confirmedMatches: Array<{ runId: string; matchId: string; subjectId: string }>;
  /** Runs that errored. Not a clearance, and counted separately so it cannot read as one. */
  failedRuns: string[];
  complete: boolean;
}

export interface OwnershipCoverage {
  identifiedPct: number;
  /** Owners recorded by a control right rather than a shareholding. */
  controlBasisCount: number;
  /** True when the identified owners reach the threshold, or a control basis is recorded. */
  covered: boolean;
  reason: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3 · BENEFICIAL OWNERSHIP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Whether the persons behind a legal person have been accounted for.
 *
 * TWO WAYS TO SATISFY A 25% RULE, and both are in the manual. The usual one is
 * arithmetic: the owners whose stakes reach the threshold between them have been
 * identified. The other is the reason the rule exists at all — a company can be
 * controlled by someone who owns nothing, through a shareholders' agreement, a golden
 * share, or the fact that they are the only person who signs. A register that demanded
 * a percentage for that company would be satisfied by a fiction, so a recorded control
 * right counts.
 *
 * AN OWNER WITH NO VERIFICATION IS NOT AN IDENTIFIED OWNER. The role of the field is to
 * be evidence, and until somebody checked the document, there is none.
 */
export function ownershipCoverage(owners: OwnerFacts[]): OwnershipCoverage {
  /*
    ONLY PEOPLE COUNT. A verified 100% held by a holding company contributes nothing here,
    because it identifies no one; the same rule the gate applies in SQL, stated once in
    TypeScript so the screen, the route and the database cannot disagree about it. The
    divergences this caught are recorded in 0043.
  */
  const verifiedByOwnership = owners.filter(
    (o) => o.ownerKind === 'natural_person'
      && o.controlBasis === 'ownership' && o.verifiedAt !== null,
  );
  const identifiedPct = verifiedByOwnership.reduce((sum, o) => sum + Number(o.ownershipPct ?? 0), 0);
  const controlBasisCount = owners.filter(
    (o) => o.ownerKind === 'natural_person'
      && o.controlBasis !== 'ownership' && o.verifiedAt !== null,
  ).length;

  const covered = identifiedPct >= UBO_THRESHOLD_PCT || controlBasisCount > 0;
  const reason = covered
    ? (identifiedPct >= UBO_THRESHOLD_PCT
      ? `${identifiedPct.toFixed(2)}% of the capital is identified and verified`
      : 'a control right is recorded and verified')
    : owners.length === 0
      ? 'no beneficial owner has been recorded'
      : `the identified owners hold ${identifiedPct.toFixed(2)}% — below the ${UBO_THRESHOLD_PCT}% threshold, `
        + 'and no control right is recorded';

  return { identifiedPct, controlBasisCount, covered, reason };
}

/** An owner whose stake reaches the threshold, and who is therefore a screening subject. */
export function isThresholdOwner(o: OwnerFacts): boolean {
  if (o.ownerKind !== 'natural_person') return false;
  return o.controlBasis !== 'ownership' || Number(o.ownershipPct ?? 0) >= UBO_THRESHOLD_PCT;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4 · SCREENING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Who the relationship contains, in the terms the sanctions lists work in.
 *
 * THE COMPANY IS NOT THE ONLY SUBJECT. A list designates people and entities, and a
 * designated individual who owns 40% of a perfectly ordinary trading company is reached
 * through the company. A screening programme that checks the name on the engagement
 * letter and stops there has checked one of three subjects, which is the most common
 * and most expensive way this obligation is failed.
 */
export function screeningSubjects(
  client: { id: string; name: string },
  owners: Array<{ id: string; fullName: string; owner: OwnerFacts }>,
): ScreeningSubject[] {
  /*
    BEING SCREENED DOES NOT DEPEND ON HAVING VERIFIED THE PAPERWORK. An owner above the
    threshold is a subject whether or not the firm has finished checking the share
    certificate: a designated person does not become undesignated because the file is thin,
    and a screening is an inexpensive thing to run. The first version of the SQL gate
    demanded `verified_at is not null` here, which meant an unverified 40% owner was never
    screened and never reported as unscreened — a hole that reads as a clean file. 0043
    aligned the database with this function.
  */
  const subjects: ScreeningSubject[] = [{ kind: 'client', id: client.id, name: client.name }];
  for (const o of owners) {
    if (!isThresholdOwner(o.owner)) continue;
    subjects.push({ kind: 'beneficial_owner', id: o.id, name: o.fullName });
  }
  return subjects;
}

/**
 * Whether the screening is resolved for every subject.
 *
 * A RUN THAT FAILED IS NOT A CLEARANCE. The failure mode this guards against is the
 * one an auditor looks for first: a screening provider that timed out, a result that
 * was never written, and a client who reads as "no matches found" because there is no
 * row saying anything at all. `failed` is therefore its own status and its own count,
 * and it leaves the subject unscreened.
 */
export function screeningState(
  required: ScreeningSubject[],
  runs: ScreeningRunFacts[],
  opts: { listSets?: string[] } = {},
): ScreeningState {
  const wanted = new Set(opts.listSets ?? []);
  const usable = runs.filter((r) => r.status !== 'failed' && (wanted.size === 0 || wanted.has('*')
    || r.listSets.some((s) => wanted.has(s))));

  const screened: ScreeningSubject[] = [];
  const unscreened: ScreeningSubject[] = [];
  for (const subject of required) {
    const mine = usable.filter((r) => r.subjectKind === subject.kind && r.subjectId === subject.id);
    if (mine.length > 0) screened.push(subject); else unscreened.push(subject);
  }

  const relevant = usable.filter((r) =>
    required.some((s) => s.kind === r.subjectKind && s.id === r.subjectId));

  const unresolvedMatches = relevant.flatMap((r) =>
    r.matches.filter((m) => m.disposition === 'open')
      .map((m) => ({ runId: r.id, matchId: m.id, subjectId: r.subjectId, listSets: r.listSets })));

  const confirmedMatches = relevant.flatMap((r) =>
    r.matches.filter((m) => m.disposition === 'true_match')
      .map((m) => ({ runId: r.id, matchId: m.id, subjectId: r.subjectId })));

  const failedRuns = runs.filter((r) => r.status === 'failed').map((r) => r.id);

  return {
    required, screened, unscreened, unresolvedMatches, confirmedMatches, failedRuns,
    complete: required.length > 0 && unscreened.length === 0
      && unresolvedMatches.length === 0 && confirmedMatches.length === 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5 · COMPLETENESS — AND THE TWO ANSWERS THAT ARE NOT "INCOMPLETE"
// ═══════════════════════════════════════════════════════════════════════════════

export interface Assessment {
  /** Requirements whose evidence is absent from the record. */
  missing: Requirement[];
  /** Missing requirements that forbid acting. */
  blocking: Requirement[];
  /** The complete answer to "may this relationship be established?" */
  complete: boolean;
  /** Why not, in one sentence, for the refusal the caller will return. */
  reason: string | null;
  ownership: OwnershipCoverage;
  screening: ScreeningState;
}

export function assessCdd(facts: CddFacts): Assessment {
  const requirements = requirementsFor(facts.clientKind, facts.level);
  const present: Record<string, boolean> = {
    legal_name: filled(facts.legalName),
    address: filled(facts.address),
    identity_document: filled(facts.idNumberHash) && facts.idType !== null,
    verification_method: filled(facts.verificationMethod),
    source_of_funds: filled(facts.sourceOfFunds),
    purpose: filled(facts.purpose),
    pep_status: facts.pepStatus !== null,
    date_of_birth: filled(facts.dateOfBirth),
    nationality: filled(facts.nationality),
    cr_number: filled(facts.crNumber),
    incorporation_country: filled(facts.incorporationCountry),
    business_activity: filled(facts.businessActivity),
    // The ownership requirement is met by the coverage computation, not by a column,
    // because what makes it true is arithmetic over other rows.
    owners: facts.clientKind !== 'organization' || facts.ownership.covered,
    source_of_wealth: filled(facts.sourceOfWealth),
    senior_approval: filled(facts.seniorApprovedByMembershipId),
    screening: facts.screening.complete,
  };

  const missing = requirements.filter((r) => !present[r.key]);
  const blocking = missing.filter((r) => r.blocking);
  const complete = missing.length === 0 && facts.status === 'complete';

  return {
    missing, blocking, complete,
    reason: complete ? null : describeMissing(missing, facts),
    ownership: facts.ownership,
    screening: facts.screening,
  };
}

function describeMissing(missing: Requirement[], facts: CddFacts): string {
  if (missing.length === 0) {
    return facts.status === 'complete'
      ? 'the record is complete'
      : `the record is ${facts.status.replace(/_/g, ' ')} — it has not been completed`;
  }
  return 'the record is missing: ' + missing.map((m) => m.label).join('; ');
}

const filled = (v: string | null | undefined): boolean =>
  typeof v === 'string' && v.trim().length > 0;

/**
 * Whether this client may be taken on, or kept.
 *
 * THE ORDER OF THE CHECKS IS PART OF THE INTERFACE, and this function's first version had
 * it wrong. It reported the screening before the ownership chain, and the databases — the
 * SQLite mirror and 0043's PL/pgSQL, which agree with each other — report the ownership
 * chain first. Two engines and one screen giving three answers to "why was this refused"
 * is the kind of disagreement that costs a firm its credibility with an inspector: the
 * person at the desk reads one reason, the register records another, and neither is
 * wrong. The order is now the sequence the manual imposes, and it is the order both
 * dialects enforce:
 *
 *     is there a record?                       cdd_missing
 *     could due diligence be completed?         cdd_unable_to_complete
 *     has the record been finished?             cdd_incomplete (the missing evidence named)
 *     is a PEP's process at the right level?    senior_approval_required
 *     are the PEOPLE behind it identified?      cdd_beneficial_owner_missing
 *     has everyone been screened and resolved?  screening_unresolved
 *     is anyone designated?                     sanctions_match
 *
 * A designation is last because it cannot be truthfully asserted about a person the firm
 * has not identified yet: identify, look through, screen, and only then answer about the
 * lists.
 *
 * TWO REFUSALS THAT ARE NOT "INCOMPLETE DUE DILIGENCE", and the difference matters to
 * the person reading it. A relationship whose due diligence could not be completed — the
 * client would not produce a document, the owner is a nominee nobody will name — is not
 * a clerical backlog. The manual says the lawyer may not act, so the honest answer is a
 * prohibition, not a to-do item. And a confirmed sanctions match is not a risk to
 * manage; it is a relationship that may not exist.
 */
export type ActivationOutcome =
  | { allowed: true }
  | { allowed: false; code: 'cdd_unable_to_complete' | 'sanctions_match' | 'cdd_incomplete' | 'cdd_missing'
      | 'senior_approval_required' | 'screening_unresolved' | 'cdd_beneficial_owner_missing'
      | 'cdd_review_overdue' | 'screening_incomplete'; message: string };

export function activationOutcome(args: {
  facts: CddFacts | null;
  assessment: Assessment | null;
}): ActivationOutcome {
  const { facts, assessment } = args;
  if (!facts || !assessment) {
    return { allowed: false, code: 'cdd_missing',
      message: 'no client due diligence has been recorded for this client' };
  }
  if (facts.status === 'unable_to_complete') {
    return { allowed: false, code: 'cdd_unable_to_complete',
      message: 'customer due diligence could not be completed for this client — the firm may not act (AML Law, M/20)' };
  }
  /*
    A PEP IS NOT A PROHIBITION; IT IS A PROMOTION TO THE STRICTER PROCESS.
    Where the determination has been made and the level has not followed it, the fix is
    the level, so the refusal says so rather than reporting the enhanced requirements as
    a list of missing fields.
  */
  if (facts.pepStatus && facts.pepStatus !== 'not_pep' && facts.level !== 'enhanced') {
    return { allowed: false, code: 'senior_approval_required',
      message: 'this client is a politically exposed person: due diligence must be enhanced and approved by senior management' };
  }
  /* The persons behind a legal person, before the screening that is an answer about them. */
  if (facts.clientKind !== 'individual' && !assessment.ownership.covered) {
    return { allowed: false, code: 'cdd_beneficial_owner_missing',
      message: 'the persons who control this client have not been identified to the 25% threshold, '
        + 'and no control right is recorded' };
  }
  /*
    A SUBJECT WITH NO USABLE RUN IS THE FIRST SCREENING REFUSAL, and this outcome was
    missing from the first version of this function: the database refused such a client with
    `screening_incomplete` while the route fell through to `cdd_incomplete` and listed the
    screening among the missing fields. The database's own check counts a subject as
    screened only when a run exists AND no hit is open, so it reports one code for both
    cases; the route distinguishes them, because "nobody has looked at this person" and
    "somebody looked and the hit is still open" are different sentences to a compliance
    officer and the same answer to a gate.
  */
  if (assessment.screening.unscreened.length > 0) {
    return { allowed: false, code: 'screening_incomplete',
      message: `${assessment.screening.unscreened.length} of ${assessment.screening.required.length} `
        + 'persons in this relationship have no usable screening' };
  }
  if (assessment.screening.unresolvedMatches.length > 0) {
    return { allowed: false, code: 'screening_unresolved',
      message: 'a screening match is awaiting a disposition — a client is not cleared while a hit is open' };
  }
  if (assessment.screening.confirmedMatches.length > 0) {
    return { allowed: false, code: 'sanctions_match',
      message: 'a confirmed sanctions match is recorded for a person in this relationship — the relationship may not be established' };
  }
  if (!assessment.complete) {
    return { allowed: false, code: 'cdd_incomplete', message: assessment.reason ?? 'the record is incomplete' };
  }
  return { allowed: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6 · RISK, DERIVED AND EXPLAINED
// ═══════════════════════════════════════════════════════════════════════════════

export interface RiskReason {
  code: string;
  label: string;
  labelAr: string;
  weight: 'medium' | 'high';
}

export interface RiskCountry {
  countryCode: string;
  listSource: string;
  riskLevel: 'high' | 'prohibited';
}

export interface RiskFacts {
  clientKind: ClientKind;
  nationality: string | null;
  residenceCountry: string | null;
  incorporationCountry: string | null;
  businessActivity: string | null;
  ownership: OwnershipCoverage;
  pepStatus: PepStatus | null;
  expectedAnnualVolumeSar: number | null;
}

/**
 * The rating, and the reasons that produced it.
 *
 * A RISK RATING WITH NO REASONS IS AN OPINION, and one that cannot be reviewed a year
 * later when the client is being discussed. Every input that moved the rating is
 * returned with it, in both languages, so the record answers "why is this client high
 * risk" without the person who typed it.
 *
 * The scale is deliberately coarse — low, medium, high — because the only decisions
 * hanging off it are how much evidence to collect and how often to look again, and a
 * five-point scale invites a discussion about the difference between a 3 and a 4.
 */
export function deriveRisk(args: {
  facts: RiskFacts;
  countries: RiskCountry[];
  homeCountry?: string;
}): { rating: RiskRating; reasons: RiskReason[] } {
  const { facts, countries, homeCountry = 'SA' } = args;
  const reasons: RiskReason[] = [];

  const register = new Map(countries.map((c) => [c.countryCode.toUpperCase(), c]));
  const countriesOf = [
    { code: facts.nationality, what: 'nationality', label: 'the client is a national of', labelAr: 'جنسية العميل من' },
    { code: facts.residenceCountry, what: 'residence', label: 'the client resides in', labelAr: 'يقيم العميل في' },
    { code: facts.incorporationCountry, what: 'incorporation', label: 'the client is incorporated in', labelAr: 'الشركة مؤسسة في' },
  ];
  for (const c of countriesOf) {
    const code = (c.code ?? '').toUpperCase();
    if (!code) continue;
    const entry = register.get(code);
    if (!entry) continue;
    reasons.push({
      code: `risk_country_${c.what}`,
      label: `${c.label} ${code}, which the firm's register lists as ${entry.riskLevel} risk (${entry.listSource})`,
      labelAr: `${c.labelAr} ${code}، وهي مدرجة في سجل الشركة كعالية المخاطر (${entry.listSource})`,
      weight: 'high',
    });
  }

  if (facts.pepStatus && facts.pepStatus !== 'not_pep') {
    reasons.push({
      code: 'pep',
      label: 'a politically exposed person is connected to this relationship',
      labelAr: 'يرتبط بالعلاقة شخص ذو نفوذ سياسي',
      weight: 'high',
    });
  }

  if (facts.clientKind === 'organization' && !facts.ownership.covered) {
    reasons.push({
      code: 'opaque_ownership',
      label: `the ownership is opaque — ${facts.ownership.reason}`,
      labelAr: 'هيكل الملكية غير واضح',
      weight: 'high',
    });
  }

  const residency = (facts.residenceCountry ?? '').toUpperCase();
  if (residency && residency !== homeCountry.toUpperCase()) {
    reasons.push({
      code: 'non_resident',
      label: 'the client is not resident in the Kingdom',
      labelAr: 'العميل غير مقيم في المملكة',
      weight: 'medium',
    });
  }

  if ((facts.expectedAnnualVolumeSar ?? 0) >= 500_000) {
    reasons.push({
      code: 'high_volume',
      label: `the expected annual volume is SAR ${Number(facts.expectedAnnualVolumeSar).toLocaleString('en-US')} or more`,
      labelAr: 'الحجم السنوي المتوقع مرتفع',
      weight: 'medium',
    });
  }

  /*
    A CASH-INTENSIVE BUSINESS IS A RATING ITEM, NOT A JUDGEMENT ABOUT THE CLIENT.
    The classification is a short, listed vocabulary rather than free text so that it can
    be reasoned over at all; the clerk writes the sentence, the list supplies the weight.
  */
  const activity = (facts.businessActivity ?? '').toLowerCase();
  if (/cash|نقد|retail|تجارة تجزئة|money exchange|صرافة|gold|ذهب|jewel|مجوهرات|crypto/.test(activity)) {
    reasons.push({
      code: 'cash_intensive',
      label: 'the business is cash-intensive by nature',
      labelAr: 'النشاط كثيف النقد بطبيعته',
      weight: 'medium',
    });
  }

  const rating: RiskRating = reasons.some((r) => r.weight === 'high') ? 'high'
    : reasons.some((r) => r.weight === 'medium') ? 'medium'
      : 'low';

  return { rating, reasons };
}

/**
 * When the relationship must next be looked at.
 *
 * The interval follows the rating because that is what "risk-based" means: enhanced
 * diligence on a high-risk client that is never revisited is a form, not a control.
 * Dates are returned as an ISO day so they survive a round trip through either dialect.
 */
export const REVIEW_MONTHS: Record<RiskRating, number> = { low: 24, medium: 12, high: 6 };

export function reviewDueAt(rating: RiskRating, from: Date | string): string {
  const start = typeof from === 'string' ? new Date(from) : from;
  const due = new Date(start.getTime());
  due.setUTCMonth(due.getUTCMonth() + REVIEW_MONTHS[rating]);
  return due.toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7 · WORKING DAYS, AND WHEN A REPORT IS LATE
// ═══════════════════════════════════════════════════════════════════════════════

export function isWorkingDay(date: Date, holidays: string[] = []): boolean {
  if ((WEEKEND_DAYS as readonly number[]).includes(date.getUTCDay())) return false;
  return !holidays.includes(date.toISOString().slice(0, 10));
}

/**
 * Add working days, skipping the Saudi weekend and the firm's own calendar.
 *
 * P0.4 builds the court calendar; this function takes the holidays as an argument now so
 * that the answer does not change shape when it arrives. A statutory period that ends on
 * a Friday ends on the next working day, and a report "due Tuesday" that nobody was in
 * the office to file on Saturday is a report that was late for no reason.
 */
export function addWorkingDays(from: Date | string, days: number, holidays: string[] = []): Date {
  const cursor = new Date(typeof from === 'string' ? from : from.getTime());
  let remaining = days;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isWorkingDay(cursor, holidays)) remaining -= 1;
  }
  return cursor;
}

/** The deadline for the report: three working days from the moment the suspicion arose. */
export function strDueAt(from: Date | string, holidays: string[] = []): string {
  return addWorkingDays(from, STR_WORKING_DAYS, holidays).toISOString();
}

export function isStrOverdue(dueAt: string, now: Date = new Date()): boolean {
  return new Date(dueAt).getTime() < now.getTime();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8 · THE ARABIC THE FILING ITSELF REQUIRES
// ═══════════════════════════════════════════════════════════════════════════════

/** Arabic block, plus the presentation forms a PDF or a copy-paste so often produces. */
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;

export function containsArabic(text: string | null | undefined): boolean {
  return typeof text === 'string' && ARABIC.test(text);
}

/**
 * The indicator vocabulary a report is grounded in.
 *
 * SAFIU's report form is a narrative plus the indicators the reporter relies on, and the
 * indicators are what a subsequent review actually reads. Kept short, listed and
 * Arabic-labelled, for the same reason the rating reasons are: a free-text field cannot
 * be counted, compared or trained on.
 */
export const STR_INDICATORS: ReadonlyArray<{ code: string; label: string; labelAr: string }> = [
  { code: 'structuring', label: 'Payments structured to avoid a reporting threshold',
    labelAr: 'دفعات مقسمة لتجنب حد الإبلاغ' },
  { code: 'unusual_funding_source', label: 'Funds from a source inconsistent with the client',
    labelAr: 'أموال من مصدر لا يتوافق مع العميل' },
  { code: 'third_party_funding', label: 'A third party funding the fees without explanation',
    labelAr: 'طرف ثالث يسدد الأتعاب دون تفسير' },
  { code: 'reluctant_identification', label: 'Reluctance to provide identification or ownership',
    labelAr: 'التردد في تقديم الهوية أو بيانات الملكية' },
  { code: 'sanctions_or_pep_link', label: 'A link to a designated person or a PEP',
    labelAr: 'ارتباط بشخص مدرج أو شخص ذو نفوذ سياسي' },
  { code: 'backdated_or_altered_documents', label: 'Documents that appear backdated or altered',
    labelAr: 'مستندات تبدو مؤرخة بأثر رجعي أو معدلة' },
  { code: 'abnormal_urgency', label: 'Unusual urgency, or an insistence on anonymity',
    labelAr: 'استعجال غير معتاد أو إصرار على عدم الكشف عن الهوية' },
  { code: 'property_or_corporate_anomaly', label: 'A property or corporate structure with no commercial purpose',
    labelAr: 'هيكل عقاري أو شركات بلا غرض تجاري' },
  { code: 'adverse_media', label: 'A credible adverse media report',
    labelAr: 'تقرير إعلامي سلبي موثوق' },
  { code: 'other', label: 'Another indicator, described in the narrative',
    labelAr: 'مؤشر آخر موضح في السرد' },
];

export function isKnownIndicator(code: string): boolean {
  return STR_INDICATORS.some((i) => i.code === code);
}

/**
 * Whether a report is ready to leave the firm.
 *
 * THE FILING IS IN ARABIC. The narrative is what SAFIU receives, and a report whose
 * narrative is in English is a report that will be returned — so the language of the
 * filing is a completeness condition, checked where the report is prepared rather than
 * discovered by the authority.
 */
export function strReadiness(r: {
  narrativeAr: string | null;
  grounds: string[];
  subjectKind: string | null;
  status: string;
}): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!containsArabic(r.narrativeAr)) reasons.push('the narrative must be written in Arabic');
  if ((r.narrativeAr ?? '').trim().length < 40) reasons.push('the narrative is too short to be a report');
  if (r.grounds.length === 0) reasons.push('at least one indicator must be selected');
  const unknown = r.grounds.filter((g) => !isKnownIndicator(g));
  if (unknown.length > 0) reasons.push(`unknown indicator(s): ${unknown.join(', ')}`);
  if (!r.subjectKind) reasons.push('the report must name what it is about');
  return { ready: reasons.length === 0, reasons };
}
