/**
 * §P0.5 · THE PRIVILEGE RING.
 *
 * A lawyer may not disclose a secret entrusted to him or learned through his
 * profession, even after the mandate ends — نظام المحاماة، المادة الثالثة والعشرون.
 * The duty attaches to the LAWYER, so the material it protects is not readable by
 * everyone who happens to work at the firm: a paralegal, a finance officer and a
 * compliance officer are outside it, which is exactly the disclosure question the
 * gap analysis found unanswered.
 *
 * THE RING IS NOT A ROLE AND NOT AN ACCESS LEVEL.
 *
 *   · An access level says how much of a matter you may see.
 *   · A role says what you are for, and what you may do.
 *   · Neither says whether you may LAWFULLY practise — and that is the fact the
 *     duty attaches to.
 *
 * So the ring is `requiresPractisingLicence ∧ entitled`, which is the verdict
 * P-1 already computes: the firm declares which of its roles mean practising law
 * (`roles.requires_practising_licence`), and `eligibilityFor()` decides whether
 * the person holding one has a licence good enough to practise — with absence
 * treated as no permission and a suspension outranking an expiry.
 *
 * IT IS RESOLVED ONCE, AT PRINCIPAL RESOLUTION, AND CARRIED.
 *
 * Re-deriving it where the field is projected would mean two answers to one
 * question — the shape of bug this codebase has met four times. The projector
 * receives the verdict, never the inputs.
 *
 * AND IT IS NOT A WALL, IT IS A RING WITH A DOOR.
 *
 * القاعدة الحادية والعشرون of the professional-conduct rules names the only
 * grounds on which disclosure is permitted. A system that can only say "refused"
 * cannot serve a firm that must report a suspicious transaction, answer a
 * complaint against itself, or release a document on the client's written
 * instruction — so the grounds are data, each release names one, and each is
 * recorded in `privilege_releases`.
 */

/**
 * Why the ring was or was not satisfied.
 *
 * The refusal reasons are deliberately the SAME STRINGS `eligibilityFor()` returns,
 * because the member who is outside the ring will ask why, and the answer must not
 * change depending on which screen asked. `outside_ring` is the one reason that
 * belongs to this module alone: a non-practising role is not a licence problem.
 */
export type RingReason =
  | 'in_ring'
  /** Not a role the firm declares as practising: a paralegal, a finance officer, an administrator. */
  | 'outside_ring'
  | 'no_licence_on_record'
  | 'suspended'
  | 'revoked'
  | 'expired'
  | 'pending';

export interface LawyerRing {
  /** True only when the member may lawfully practise AND may practise here. */
  readonly inRing: boolean;
  /** The reason, always present — `in_ring` when nothing stands in the way. */
  readonly reason: RingReason;
}

/** A ring nobody is in, for callers that have no membership (portal, tests, anonymous). */
export const NO_RING: LawyerRing = { inRing: false, reason: 'outside_ring' };

/**
 * The ring from the two facts, in the order they matter.
 *
 * `requiresPractisingLicence = false` is not a licence failure — it means the
 * question does not arise for this member, and it is answered before the licence
 * is even consulted. That ordering is the whole reason a paralegal is outside the
 * ring rather than "unlicensed": the firm is not gating her hire, it is declining
 * to hand her the firm's privileged work product.
 */
export function lawyerRingFrom(
  eligibility: { requiresLicence: boolean; entitled: boolean; reason: string },
): LawyerRing {
  if (!eligibility.requiresLicence) return { inRing: false, reason: 'outside_ring' };
  if (eligibility.entitled) return { inRing: true, reason: 'in_ring' };
  /* The refusal reasons pass through unchanged, and an unknown one becomes
     `outside_ring` rather than a permissive default. An unrecognised reason is a
     refusal that has not been explained yet, not a licence that has been seen. */
  switch (eligibility.reason) {
    case 'no_licence_on_record':
    case 'suspended':
    case 'revoked':
    case 'expired':
    case 'pending':
      return { inRing: false, reason: eligibility.reason };
    default:
      return { inRing: false, reason: 'outside_ring' };
  }
}

// ============================================================================
// THE FOUR GROUNDS
// ============================================================================

/**
 * القاعدة الحادية والعشرون — the grounds on which a lawyer may disclose what the
 * duty protects, each in the words the rule uses.
 *
 * Kept as data, checked by a database CHECK and by the release route, so that
 * "why was this released?" is answerable from the record rather than from
 * somebody's memory of the conversation.
 */
export const DISCLOSURE_GROUNDS = [
  {
    /** منع حدوث جريمة */
    code: 'crime_prevention',
    label: 'منع حدوث جريمة',
    labelEn: 'Prevention of a crime',
    /** The counterparties this ground can lawfully be used against. */
    recipients: ['authority'] as const,
    /** A ground that must name a writing: Rule 21 requires a document, not a flag. */
    requiresDocument: false,
  },
  {
    /** الاشتباه بجريمة غسل الأموال أو تمويل الإرهاب */
    code: 'aml_suspicion',
    label: 'الاشتباه بجريمة غسل الأموال أو تمويل الإرهاب',
    labelEn: 'Suspicion of money laundering or terrorism financing',
    /*
      THE REGULATOR, NOT THE COUNTERPARTY. A suspicion is reported to the financial
      intelligence unit (P0.3 builds the STR). A schema that permitted this ground to
      name any recipient would permit a firm to tell the other side what it suspected —
      and the ground's own wording would be cited as the authority.
    */
    recipients: ['regulator'] as const,
    requiresDocument: false,
  },
  {
    /** ما يستلزمه دفاع المحامي عن نفسه ضد أي دعوى أو شكوى */
    code: 'self_defence',
    label: 'ما يستلزمه دفاع المحامي عن نفسه ضد أي دعوى أو شكوى',
    labelEn: 'The lawyer’s own defence against a claim or complaint',
    recipients: ['court', 'authority', 'regulator'] as const,
    requiresDocument: false,
  },
  {
    /** موافقة العميل المكتوبة على الإفصاح */
    code: 'client_written_consent',
    label: 'موافقة العميل المكتوبة على الإفصاح',
    labelEn: 'The client’s written consent to disclosure',
    recipients: ['court', 'authority', 'regulator', 'third_party', 'client'] as const,
    /*
      WRITTEN. The word in the rule is مكتوبة, so the release must point at the
      document that carries it — a boolean saying "the client agreed" is not a
      writing, and the database refuses the row rather than trusting the form.
    */
    requiresDocument: true,
  },
] as const;

export type DisclosureGround = (typeof DISCLOSURE_GROUNDS)[number]['code'];
export type DisclosureRecipient = 'court' | 'authority' | 'regulator' | 'third_party' | 'client';

export const DISCLOSURE_GROUND_CODES: readonly DisclosureGround[] =
  DISCLOSURE_GROUNDS.map((g) => g.code);

export const DISCLOSURE_RECIPIENTS: readonly DisclosureRecipient[] =
  ['court', 'authority', 'regulator', 'third_party', 'client'] as const;

/** The ground, or undefined. Used by the route to refuse before the database does. */
export function groundOf(code: string) {
  return DISCLOSURE_GROUNDS.find((g) => g.code === code);
}

/**
 * Whether one ground permits one recipient.
 *
 * Exported rather than inlined so the route and the suite ask the same question, and so
 * the refusal message can say which recipients the ground does allow — a member who
 * tried to disclose an AML suspicion to the counterparty should be told what the rule
 * permits, not merely that the request failed.
 */
export function groundPermits(code: string, recipient: string): boolean {
  const g = groundOf(code);
  if (!g) return false;
  return (g.recipients as readonly string[]).includes(recipient);
}

/**
 * The document classes a document may carry.
 *
 * `none` is the default and means the document is ordinary matter material. The
 * three privileged classes are different kinds of work product, kept distinct
 * because a litigation file is expected to be withheld in a way a general advice
 * note is not, and because a firm that must answer "how much of this file is
 * privileged?" should not have to guess from a boolean.
 */
export const PRIVILEGE_CLASSES = ['none', 'advice', 'work_product', 'litigation'] as const;
export type PrivilegeClass = (typeof PRIVILEGE_CLASSES)[number];

/** True for the three classes the ring protects. */
export function isPrivilegedClass(value: unknown): boolean {
  return typeof value === 'string' && value !== 'none' && (PRIVILEGE_CLASSES as readonly string[]).includes(value);
}
