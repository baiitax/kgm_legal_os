/**
 * THE CONFLICT ENGINE  (analysis I · P0.1)
 *
 * Answers one question for a matter: given who is on it, is the firm prohibited
 * from acting, and if so under which rule and with whose consent can that be
 * cured?
 *
 * PURE BY CONSTRUCTION. No database, no clock, no I/O. The repository loads the
 * firm's parties, clients, prior appearances and affiliations and passes them in.
 * Two consequences, both wanted: the rules can be tested exhaustively without
 * fixtures, and the same code decides a conflict on SQLite and on PostgreSQL —
 * which is the arrangement this project settled on after the eleventh defect that
 * existed in only one dialect.
 *
 * ── THE RULES, AND WHERE EACH ONE COMES FROM ──────────────────────────────────
 *
 * القاعدة الثامنة من قواعد السلوك المهني للمحامين
 * (قرار وزير العدل رقم ٣٤٥٣ وتاريخ ٢٤/١٢/١٤٤٢هـ، ساري من ٣ سبتمبر ٢٠٢١):
 *
 *   ١- يُحظر على المحامي أي تصرف يمثل تعارضًا فعليًّا أو محتملاً مع مصالح عملائه
 *      الحاليين أو السابقين، إلا بعد الموافقة المكتوبة من العميل ذي الصلة.
 *   ٢- … مع مصالح جهات العمل التي كان يعمل فيها، إلا بعد الموافقة المكتوبة من جهة
 *      العمل ذات الصلة بالتصرف.
 *   ٣- لا يعد من تعارض المصالح تقديم عملٍ ضد جهات العمل السابقة إذا مر على انقضاء
 *      العلاقة معها خمس سنوات.
 *   ٤- لا يعد من تعارض المصالح تقديم عملٍ ضد عملاء سابقين إذا مر على انقضاء العلاقة
 *      معهم أو تقديم آخر عمل لهم ثلاث سنوات.
 *
 * المادة (١٠/٤) من اللائحة التنفيذية لنظام المحاماة:
 *   «لا يجوز أن يوكل المحامون الشركاء في أي مرافعة أو استشارة عن أطراف متعارضي
 *    المصالح في قضية واحدة، إلا إذا كانت هناك موافقة مكتوبة من الأطراف المتأثرين
 *    بالقضية»
 *
 * القاعدة الحادية عشرة: على المحامي قبل قبول أي قضية التأكد من … عدم تعارض المصالح
 *   بين العميل … وعملاء المحامي السابقين أو الحاليين.
 *
 * ── WHAT THE ENGINE WILL NOT DO ───────────────────────────────────────────────
 *
 *   1. It does not clear anything. It returns FINDINGS. A matter becomes cleared
 *      when every finding has been either ruled out by a person or cured by a
 *      written consent — see `clearanceOf()`.
 *
 *   2. It does not treat a name resemblance as an identity. A match returns a
 *      STRENGTH ('exact' only for an identifier match or an identical normalised
 *      name), and everything weaker than exact is a question addressed to a human.
 *
 *   3. It does not decide whose consent cures a conflict from scratch each time:
 *      the affected party is computed here, stored on the finding, and the database
 *      refuses a waiver signed by anyone else. If this function names the wrong
 *      party, the wrong consent is refused rather than accepted.
 *
 *   4. It does not search only open matters. Rule 8/4 measures three years from the
 *      end of a former client relationship, and a rule written around former
 *      clients cannot be implemented by searching the current workload. Closed
 *      matters are the substance of the check, not an edge case.
 */
import {
  matchParties,
  restrictionWindow,
  FORMER_CLIENT_CONFLICT_YEARS,
  FORMER_EMPLOYER_CONFLICT_YEARS,
  type MatchStrength,
} from './arabic-names.js';

/** The role a party holds on a matter. Adverseness is derived from this, once. */
export type MatterPartyRole =
  | 'counterparty' | 'adverse_party' | 'related_entity' | 'guarantor'
  | 'witness' | 'expert' | 'interested_party' | 'other';

/**
 * Roles that put a party on the other side. Exported because the engine, the
 * repository and the clearance rule must all agree, and a second list would be a
 * second definition of "the other side".
 */
export const ADVERSE_ROLES: readonly MatterPartyRole[] = ['counterparty', 'adverse_party'];

export function isAdverse(role: MatterPartyRole): boolean {
  return ADVERSE_ROLES.includes(role);
}

export type PartyIdentity = {
  id: string;
  kind: string;
  name: string;
  nameAr: string | null;
  aliases: string[];
  commercialRegistration: string | null;
  vatNumber: string | null;
  nationalIdHash: string | null;
};

export type MatterPartyRecord = { party: PartyIdentity; role: MatterPartyRole };

/** A party's appearance in some matter of the firm, current or closed. */
export type PriorAppearance = {
  party: PartyIdentity;
  matterId: string;
  matterNumber: string;
  caseNumber: string | null;
  role: MatterPartyRole;
  matterStatus: string;
  closedAt: string | null;
};

export type ClientRecord = {
  clientId: string;
  partyId: string | null;
  identity: PartyIdentity;
  /** 'active' | 'inactive' | 'restricted' — the client's status, not the matter's. */
  status: string;
  /**
   * When the firm stopped acting for them. Resolved by the caller from
   * `clients.relationship_ended_on` or, when that is null, the most recent matter
   * closed for that client — Rule 8/4 measures from the end of the relationship
   * *or* from the last work done, so both are the same fact stored two ways.
   */
  relationshipEndedOn: string | null;
};

export type AffiliationRecord = {
  staffId: string;
  staffName: string;
  party: PartyIdentity;
  relation: 'former_employer' | 'current_employer' | 'board_member' | 'shareholder' | 'other_interest';
  endedOn: string | null;
};

export type ConflictRelation =
  | 'former_client' | 'current_client' | 'former_employer' | 'current_employer'
  | 'same_case_opponent' | 'linked_party' | 'related_entity';

export type MatchBasis =
  | 'name' | 'alias' | 'commercial_registration' | 'vat_number' | 'national_id_hash';

export type Severity = 'actual' | 'potential' | 'none';

export type ConflictFinding = {
  /** The party as recorded on the matter being screened. */
  partyId: string;
  /**
   * Real row ids ONLY. Every one of these is written to a `uuid` column, so each is
   * either a genuine primary key or null — never a synthetic matching label.
   * `tests/security/conflicts.test.ts` asserts that over every branch of the engine.
   */
  matchedPartyId: string | null;
  matchedMatterId: string | null;
  matchedClientId: string | null;
  relation: ConflictRelation;
  matchStrength: MatchStrength;
  matchBasis: MatchBasis;
  /** Whose written consent Rule 8 requires. Null only for a finding the rule excepts. */
  affectedPartyId: string | null;
  severity: Severity;
  /** The article or rule relied on, in the form a reviewer would cite it. */
  ruleCited: string;
  relationshipEndedOn: string | null;
  windowYears: number | null;
  windowLiftsOn: string | null;
  withinWindow: boolean | null;
  /** Human-readable, for the register. Never used to make a decision. */
  explanation: string;
};

export type EvaluationInput = {
  matter: {
    /**
     * The prospective client's PARTY row, when it has one.
     *
     * `clientIdentity.id` is not usable as a database key: for a client that predates
     * the party register, `loadConflictDataset` mints a synthetic `client:<uuid>`
     * identity so the matcher has something to compare against. That label is fine
     * for matching and for the explanation text, and it is poison in a `uuid` column
     * — it took a production 500 ("invalid input syntax for type uuid") to make this
     * explicit, on the first check that matched a client rather than a counterparty.
     */
    clientPartyId: string | null;
    id: string;
    matterNumber: string;
    caseNumber: string | null;
    clientId: string;
    clientIdentity: PartyIdentity;
  };
  /** The parties recorded on this matter. The client is not among them. */
  parties: MatterPartyRecord[];
  /** Every party-matter link the firm has, open and closed, excluding this matter. */
  priorAppearances: PriorAppearance[];
  clients: ClientRecord[];
  /**
   * The firm's matters and which client each belongs to, with the case number.
   *
   * Needed for المادة ١٠/٤, and it cannot be derived from `priorAppearances`: the
   * client of a matter is `matters.client_id`, not a `matter_parties` row, so
   * "which matters do we act for this client in" is a different question from
   * "where has this party appeared".
   */
  clientMatters: Array<{ clientId: string; matterId: string; caseNumber: string | null; status: string }>;
  affiliations: AffiliationRecord[];
  /** Injected so the tests do not depend on the day they are run. */
  today?: Date;
};

export type EvaluationResult = {
  findings: ConflictFinding[];
  partiesChecked: number;
  mattersSearched: number;
  /**
   * Things the reviewer should know that are not conflicts. A clearance over a
   * litigation matter with no adverse party recorded is arithmetically clean and
   * substantively empty, and the register should say so rather than present it as
   * diligence.
   */
  warnings: string[];
};

const RULE = {
  formerClient: 'القاعدة الثامنة/١ و ٨/٤ من قواعد السلوك المهني — تعارض مع عميل سابق',
  currentClient: 'القاعدة الثامنة/١ من قواعد السلوك المهني — تعارض فعلي مع عميل حالي',
  formerEmployer: 'القاعدة الثامنة/٢ و ٨/٣ من قواعد السلوك المهني — تعارض مع جهة عمل سابقة',
  currentEmployer: 'القاعدة الثامنة/٢ من قواعد السلوك المهني — تعارض مع جهة عمل قائمة',
  sameCase: 'المادة (١٠/٤) من اللائحة التنفيذية — أطراف متعارضة في قضية واحدة',
  interest: 'القاعدة الثامنة/١ من قواعد السلوك المهني — تعارض محتمل مع مصلحة قائمة',
} as const;

/** Digits and letters only, so «٤٥١٢٣٤٥٦٧٨/١» and «4512345678-1» compare equal. */
export function normalizeCaseNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => {
    const cp = d.codePointAt(0)!;
    return String(cp - (cp >= 0x06F0 ? 0x06F0 : 0x0660));
  }).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  return digits.length >= 4 ? digits : null;
}

/** Which of the two parties' columns produced the match — for the register. */
function basisOf(
  a: PartyIdentity, b: PartyIdentity, strength: MatchStrength,
): MatchBasis {
  const norm = (v: string | null) => (v ? v.replace(/\D/g, '') : null);
  if (norm(a.commercialRegistration) && norm(a.commercialRegistration) === norm(b.commercialRegistration)) {
    return 'commercial_registration';
  }
  if (norm(a.vatNumber) && norm(a.vatNumber) === norm(b.vatNumber)) return 'vat_number';
  if (a.nationalIdHash && a.nationalIdHash === b.nationalIdHash) return 'national_id_hash';
  if (strength === 'exact' || strength === 'strong') return 'name';
  return 'alias';
}

function identityMatches(a: PartyIdentity, b: PartyIdentity): MatchStrength {
  return matchParties(
    { name: a.name, nameAr: a.nameAr, aliases: a.aliases,
      commercialRegistration: a.commercialRegistration, vatNumber: a.vatNumber,
      nationalIdHash: a.nationalIdHash },
    { name: b.name, nameAr: b.nameAr, aliases: b.aliases,
      commercialRegistration: b.commercialRegistration, vatNumber: b.vatNumber,
      nationalIdHash: b.nationalIdHash },
  );
}

/**
 * Runs every rule against every party on the matter.
 *
 * The order of the loops is deliberate: the outer loop is the party, so a reader
 * asking "why is this counterparty a problem?" finds every reason in one block
 * rather than interleaved with the other parties' reasons.
 */
export function evaluateConflicts(input: EvaluationInput): EvaluationResult {
  const today = input.today ?? new Date();
  const findings: ConflictFinding[] = [];
  const warnings: string[] = [];

  const adverse = input.parties.filter((p) => isAdverse(p.role));
  const nonAdverse = input.parties.filter((p) => !isAdverse(p.role));

  if (adverse.length === 0) {
    warnings.push(
      'no adverse party is recorded on this matter, so the conflict search had nothing to search for. '
      + 'A clearance over an empty party list asserts only that nobody looked at anything.',
    );
  }

  /*
    The client is screened too, but not for the reason the adverse parties are. A
    client who was previously adverse to one of the firm's current clients creates a
    conflict in the SAME CASE (المادة ١٠/٤) — the firm cannot be briefed for both
    sides of one dispute, which is a prohibition on the firm's posture rather than on
    any single party.
  */
  const sameCaseMatches: Array<{ party: PartyIdentity; client: ClientRecord; strength: MatchStrength }> = [];

  for (const record of input.parties) {
    const party = record.party;

    // ── Rule 8/1 and 8/4 · was this party ever a client of the firm? ─────────
    // Only adverse parties. A witness who happens to be a client is not a conflict;
    // the firm acting FOR its client while its client witnesses a matter is
    // ordinary practice.
    if (isAdverse(record.role)) {
      for (const client of input.clients) {
        const strength = identityMatches(party, client.identity);
        if (strength === 'none') continue;

        const window = restrictionWindow(client.relationshipEndedOn, FORMER_CLIENT_CONFLICT_YEARS, today);
        const isCurrent = client.relationshipEndedOn === null && client.status === 'active';
        const relation: ConflictRelation = isCurrent ? 'current_client' : 'former_client';
        const severity: Severity = isCurrent ? 'actual' : (window.withinWindow ? 'potential' : 'none');

        findings.push({
          partyId: party.id,
          // The client ROW is always a real key. Its party row may not exist — a
          // client that predates the register — and in that case this is null rather
          // than the synthetic matching label.
          matchedPartyId: client.partyId,
          matchedMatterId: null,
          matchedClientId: client.clientId,
          relation,
          matchStrength: strength,
          matchBasis: basisOf(party, client.identity, strength),
          // The consent Rule 8 requires is the affected party's own: the current or
          // former client being acted against, never the prospective client's.
          //
          // Null when that client has no party row. The waiver route then refuses with
          // `no_affected_party`, which is the truth: there is nobody on the register
          // whose consent could be recorded, and the remedy is to register them. A
          // synthetic label here would instead have produced a foreign-key violation
          // or, worse, silently matched nothing.
          affectedPartyId: client.partyId,
          severity,
          ruleCited: isCurrent ? RULE.currentClient : RULE.formerClient,
          relationshipEndedOn: client.relationshipEndedOn,
          windowYears: FORMER_CLIENT_CONFLICT_YEARS,
          windowLiftsOn: window.liftsOn,
          withinWindow: window.withinWindow,
          explanation: isCurrent
            ? `«${client.identity.name}» is a CURRENT client of the firm and is being acted against here.`
            : window.withinWindow
              ? `«${client.identity.name}» was a client until ${client.relationshipEndedOn}; `
                + `the three years of القاعدة ٨/٤ run to ${window.liftsOn}.`
              : `«${client.identity.name}» was a client, but the relationship ended on `
                + `${client.relationshipEndedOn} and more than three years have passed, so القاعدة ٨/٤ `
                + `says this is not a conflict.`,
        });

        // ── المادة ١٠/٤ · the same case, both sides ──────────────────────────
        // The rule is not about meeting this party twice. It is about the FIRM
        // being briefed for opposing parties in ONE case, so the test is whether
        // this party is the client of another matter carrying the same case number
        // — the firm on both sides, which is what the article names.
        if (sameCaseFor(client, input)) {
          sameCaseMatches.push({ party, client, strength });
        }
      }
    }

    // ── Rule 8/2 and 8/3 · a former employer of one of our own lawyers ──────
    if (isAdverse(record.role)) {
      for (const aff of input.affiliations) {
        const strength = identityMatches(party, aff.party);
        if (strength === 'none') continue;

        const current = aff.relation === 'current_employer';
        const window = restrictionWindow(
          aff.endedOn, FORMER_EMPLOYER_CONFLICT_YEARS, today);
        const severity: Severity = current
          ? 'actual'
          : (window.withinWindow ? 'potential' : 'none');

        findings.push({
          partyId: party.id,
          matchedPartyId: aff.party.id,
          matchedMatterId: null,
          matchedClientId: null,
          relation: current ? 'current_employer' : 'former_employer',
          matchStrength: strength,
          matchBasis: basisOf(party, aff.party, strength),
          affectedPartyId: aff.party.id,
          severity,
          ruleCited: current ? RULE.currentEmployer : RULE.formerEmployer,
          relationshipEndedOn: aff.endedOn,
          windowYears: FORMER_EMPLOYER_CONFLICT_YEARS,
          windowLiftsOn: window.liftsOn,
          withinWindow: window.withinWindow,
          explanation: current
            ? `«${aff.party.name}» is a CURRENT employer of ${aff.staffName}; القاعدة ٨/٢ requires their `
              + `written consent, and المادة ١٦ restricts practising while employed elsewhere.`
            : window.withinWindow
              ? `«${aff.party.name}» employed ${aff.staffName} until ${aff.endedOn}; the five years of `
                + `القاعدة ٨/٣ run to ${window.liftsOn}.`
              : `«${aff.party.name}» employed ${aff.staffName}, but the relationship ended on ${aff.endedOn} `
                + `and more than five years have passed, so القاعدة ٨/٣ says this is not a conflict.`,
        });
      }

      // ── Rule 8/1 · a declared interest rather than an employment ──────────
      // No window: a shareholding or a board seat does not expire with time, only
      // with the interest. The rule's own word for this is «محتملاً».
      for (const aff of input.affiliations) {
        if (aff.relation === 'former_employer' || aff.relation === 'current_employer') continue;
        const strength = identityMatches(party, aff.party);
        if (strength === 'none') continue;
        findings.push({
          partyId: party.id,
          matchedPartyId: aff.party.id,
          matchedMatterId: null,
          matchedClientId: null,
          relation: 'linked_party',
          matchStrength: strength,
          matchBasis: basisOf(party, aff.party, strength),
          affectedPartyId: aff.party.id,
          severity: 'potential',
          ruleCited: RULE.interest,
          relationshipEndedOn: aff.endedOn,
          windowYears: null,
          windowLiftsOn: null,
          withinWindow: null,
          explanation: `${aff.staffName} holds a declared ${aff.relation.replace(/_/g, ' ')} in `
            + `«${aff.party.name}», which is adverse on this matter.`,
        });
      }
    }
  }

  /*
    Same-case findings are emitted after the party loop because they are about a
    PAIR of parties, and المادة ١٠/٤ requires the consent of the affected parties in
    the plural: one finding per required consent, so the register shows exactly how
    many signatures stand between the firm and the work.
  */
  for (const match of sameCaseMatches) {
    const caseNumber = normalizeCaseNumber(input.matter.caseNumber);
    for (const affected of [
      { id: match.client.partyId, who: `the existing client «${match.client.identity.name}»` },
      { id: input.matter.clientPartyId, who: `the prospective client «${input.matter.clientIdentity.name}»` },
    ]) {
      findings.push({
        partyId: match.party.id,
        matchedPartyId: match.client.partyId,
        matchedMatterId: null,
        matchedClientId: match.client.clientId,
        relation: 'same_case_opponent',
        matchStrength: match.strength,
        matchBasis: basisOf(match.party, match.client.identity, match.strength),
        affectedPartyId: affected.id,
        severity: 'potential',
        ruleCited: RULE.sameCase,
        relationshipEndedOn: null,
        windowYears: null,
        windowLiftsOn: null,
        withinWindow: null,
        explanation: `Case ${input.matter.caseNumber}: the firm already acts for ${affected.who === `the existing client «${match.client.identity.name}»` ? 'the other side' : 'the client'} in this dispute. `
          + `المادة ١٠/٤ requires the written consent of ${affected.who}.`,
      });
    }
  }

  // ── de-duplicate, keeping the strongest evidence for each pair ─────────────
  /*
    Two rules can reach the same conclusion about the same pair — a party who is
    both a former client and a former employer's affiliate, for instance. The
    register should show both reasons, because a waiver cures one rule and not
    necessarily the other; what it must not show is the same reason twice, which is
    what an inner join over aliases produces.
  */
  const seen = new Map<string, ConflictFinding>();
  for (const f of findings) {
    const key = [f.partyId, f.matchedPartyId ?? '', f.relation, f.affectedPartyId ?? ''].join('|');
    const existing = seen.get(key);
    if (!existing) { seen.set(key, f); continue; }
    const rank: Record<Severity, number> = { none: 0, potential: 1, actual: 2 };
    if (rank[f.severity] > rank[existing.severity]) seen.set(key, f);
  }

  return {
    findings: [...seen.values()],
    partiesChecked: 1 + input.parties.length,
    mattersSearched: new Set(input.priorAppearances.map((p) => p.matterId)).size,
    warnings,
  };
}

/**
 * Whether the firm is already acting for this party in the same case.
 *
 * المادة ١٠/٤ is a prohibition on the firm's POSTURE, not on a party: «لا يجوز أن
 * يوكل المحامون الشركاء في أي مرافعة أو استشارة عن أطراف متعارضي المصالح في قضية
 * واحدة». So the question is not "have we met this party before" — it is "is this
 * the party we act for, in a matter carrying the same case number".
 *
 * Deliberately narrow in one direction: it compares case numbers, which today are
 * free text taken from Najiz, and does NOT attempt to judge whether two matters are
 * "substantially the same dispute". That is a legal judgement, and a machine that
 * guessed at it would produce confident wrong answers in the one place they are
 * least affordable. The mapping table in P2.5 is where a reliable case identity
 * comes from.
 */
function sameCaseFor(client: ClientRecord, input: EvaluationInput): boolean {
  const currentCase = normalizeCaseNumber(input.matter.caseNumber);
  if (!currentCase) return false;
  return input.clientMatters.some((cm) =>
    cm.clientId === client.clientId
    && cm.matterId !== input.matter.id
    && normalizeCaseNumber(cm.caseNumber) === currentCase);
}

export type ClearanceState = {
  /** True only when every finding has been accounted for. */
  cleared: boolean;
  /** Findings waiting on a human. */
  open: number;
  /** Confirmed conflicts with no written consent yet. */
  unwaived: number;
  /** Findings the rule excepts — recorded, but not obstacles. */
  excepted: number;
  /** Why it is not cleared, in the reviewer's language. */
  reasons: string[];
};

/**
 * Whether a set of findings amounts to a clearance.
 *
 * This is the SAME condition the database enforces in `matter_conflict_gate`, and
 * that duplication is intentional and known: the database must be able to refuse a
 * transition even if this function is never called, and the application must be
 * able to explain to a lawyer why the door is shut. What must never happen is the
 * two disagreeing, so both are derived from the same three-part statement —
 * nothing outstanding, nothing confirmed-but-unconsented, and the check having seen
 * every party — and a test asserts they agree.
 */
export function clearanceOf(
  findings: Array<Pick<ConflictFinding, 'severity' | 'affectedPartyId'> & {
    disposition: 'open' | 'different_party' | 'same_party';
    waived: boolean;
  }>,
): ClearanceState {
  const reasons: string[] = [];
  let open = 0;
  let unwaived = 0;
  let excepted = 0;

  for (const f of findings) {
    if (f.disposition === 'open') { open += 1; continue; }
    if (f.disposition === 'different_party') continue;
    if (f.severity === 'none') { excepted += 1; continue; }
    if (!f.waived) unwaived += 1;
  }

  if (open > 0) {
    reasons.push(`${open} finding(s) still need a decision: confirm the party or rule it out.`);
  }
  if (unwaived > 0) {
    reasons.push(`${unwaived} confirmed conflict(s) have no written consent from the affected party.`);
  }
  return { cleared: open === 0 && unwaived === 0, open, unwaived, excepted, reasons };
}
