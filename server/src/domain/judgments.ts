/**
 * P0.4 · JUDGMENTS, SERVICE, AND THE PERIOD FOR CHALLENGING ONE
 *
 * This file is the arbitration on *when* something is true: when a judgment became final,
 * when the period for appealing it ran out, whether a recorded service actually started a
 * clock, and whether enforcement may begin. Everything else in the phase — the tables, the
 * routes, the trigger, the screens — is a way of asking these functions.
 *
 * WHY IT EXISTS AT ALL
 *
 * The gap analysis put it in one sentence:
 *
 *     «تبدأ المدة من تاريخ تسليم صك الحكم إلى المحكوم عليه»
 *     the period runs from delivery of the judgment copy to the party against whom it
 *     was issued — not from pronouncement.
 *
 * A system that knows a judgment was pronounced but not when it was delivered cannot
 * diarise an appeal. It can hold a date and be wrong about it, which for a thirty-day
 * period is malpractice with an identifiable victim. So the delivery is a first-class fact
 * (a `service_events` row), the arithmetic that turns it into a deadline lives here in one
 * copy, and the article that fixes the period is carried on every date the system computes.
 *
 * THE THREE RULES, STATED ONCE
 *
 *   1. THE PERIOD RUNS FROM THE DAY AFTER DELIVERY. Not the day of, which would cost a day;
 *      not from pronouncement, which would cost however long the court took to issue the
 *      copy — occasionally months.
 *
 *   2. THE LAST DAY EXTENDS, THE FIRST DOES NOT. A period whose thirtieth day is a Friday
 *      ends on the next working day the courts sit: the weekend and every day in
 *      `court_calendar`. The day it STARTS from is the day it starts from — an argument that
 *      the start should also move to a working day would be a different rule, and a wrong one.
 *
 *   3. THE DAY ENDS IN THE KINGDOM. A statutory period expires at the end of the working day
 *      in Saudi Arabia, which is UTC+03:00 and has no daylight saving, so the moment a period
 *      closes is 23:59:59+03:00 — not 23:59:59Z, which would close it three hours early and
 *      refuse a filing that was made in time.
 *
 * AND ONE THING THIS FILE REFUSES TO DO
 *
 * It does not decide that an attempted service was a service. A registered letter nobody
 * collected and an address nobody could find are NOT service, and no clock runs from either;
 * a refusal recorded by a judicial officer IS service, because otherwise the party could stop
 * the clock by declining the envelope. That distinction is the whole reason `serviceEffect`
 * exists, and the database carries its answer (`service_events.effective_at`) rather than
 * recomputing it — one computation, in one place, read by everyone.
 */
import { WEEKEND_DAYS, isWorkingDay } from './aml.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 1 · THE VOCABULARY
// ═══════════════════════════════════════════════════════════════════════════════

/** What kind of decision it is. It decides which period applies to challenging it. */
export type JudgmentKind = 'first_instance' | 'appeal' | 'cassation';

/** What the judgment actually orders. A judgment that orders nothing cannot be enforced. */
export type ReliefKind = 'monetary' | 'non_monetary' | 'none';

/** How a judgment is challenged. */
export type AppealKind = 'appeal' | 'cassation' | 'rehearing';

export type AppealStatus = 'filed' | 'registered' | 'decided' | 'withdrawn' | 'rejected';

export type AppealOutcome = 'upheld' | 'varied' | 'overturned' | 'remanded' | 'dismissed';

/**
 * THE ENFORCEMENT LIFECYCLE.
 *
 * `awaiting_finality` is where most judgments live, and it is not a failure — it is the
 * honest name for "this may yet be challenged". `stayed` is a court order and outranks
 * everything except a terminal state, which is why the gate returns it before it returns
 * anything about appeals: when a court has said stop, nothing else matters.
 */
export type EnforcementStatus =
  | 'not_enforceable' | 'awaiting_finality' | 'enforceable'
  | 'stayed' | 'under_enforcement' | 'satisfied' | 'closed';

/** The legal channels a document reaches a person through. */
export type ServiceMethod =
  | 'in_court' | 'personal' | 'agent' | 'registered_mail'
  | 'electronic' | 'publication' | 'judicial_bailiff';

/** What became of the attempt. Four of these are service; three are not. */
export type ServiceOutcome =
  | 'pending' | 'served' | 'refused' | 'unclaimed' | 'untraceable' | 'substituted';

/** Who was served. Enforcement turns on the party it is sought against. */
export type ServiceOnKind = 'client' | 'opponent' | 'representative' | 'third_party';

export type NoticeKind =
  | 'judgment' | 'court_notice' | 'execution_notice'
  | 'opponent_notice' | 'client_notice' | 'third_party_notice';

// ═══════════════════════════════════════════════════════════════════════════════
// 2 · THE PERIODS, AND THE ARTICLE THAT FIXES EACH ONE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A period with its provenance attached.
 *
 * `cited` is not decoration. Every date this system computes is a date somebody may one day
 * have to defend, and the defending question is always the same one: *which provision, and
 * which rule did you apply it with?* A timestamp with no article is an assertion; a timestamp
 * carrying its article is an answer.
 */
export interface DeadlineRule {
  /** Stable identifier, stored on the computed date. */
  code: string;
  days: number;
  urgentDays: number;
  /** The provision, in Arabic, as it would be cited in a filing. */
  cited: string;
  citedEn: string;
  /** What the period runs FROM, in one clause. */
  runs: string;
}

export const APPEAL_RULES: Readonly<Record<string, DeadlineRule>> = {
  'appeal.first_instance': {
    code: 'appeal.first_instance',
    days: 30,
    urgentDays: 10,
    cited: 'نظام المرافعات الشرعية — المادة ١٨٧',
    citedEn: 'Civil Procedure Law, art. 187',
    runs: 'from the day following delivery of the judgment copy to the party',
  },
  'cassation.from_appeal_judgment': {
    code: 'cassation.from_appeal_judgment',
    days: 30,
    urgentDays: 15,
    cited: 'نظام المرافعات الشرعية — المادة ١٨٧ (الاعتراض بالتمييز)',
    citedEn: 'Civil Procedure Law, art. 187 (objection by cassation)',
    runs: 'from the day following delivery of the appeal judgment',
  },
  'rehearing.from_knowledge': {
    code: 'rehearing.from_knowledge',
    days: 30,
    urgentDays: 30,
    cited: 'نظام المرافعات الشرعية — التماس إعادة النظر',
    citedEn: 'Civil Procedure Law — petition for rehearing',
    runs: 'from the day the ground for the petition became known',
  },
} as const;

/**
 * Which rule governs a challenge, or null when the law provides no route.
 *
 * The null is load-bearing: a judgment of the Supreme Court is not appealed, and a system
 * that offered a thirty-day clock against one would be inventing a proceeding. The route
 * refuses with `appeal_not_available` rather than accepting a filing that cannot exist.
 */
export function ruleFor(args: {
  judgmentKind: JudgmentKind;
  appealKind: AppealKind;
  urgent: boolean;
}): DeadlineRule | null {
  const { judgmentKind, appealKind, urgent } = args;
  const pick = (code: string): DeadlineRule => {
    const rule = APPEAL_RULES[code]!;
    return urgent ? { ...rule, days: rule.urgentDays } : rule;
  };
  if (appealKind === 'rehearing') {
    /* A petition for rehearing lies against a final judgment, so it is available against
       any of the three kinds — including one this court itself issued. */
    return pick('rehearing.from_knowledge');
  }
  if (appealKind === 'appeal') {
    return judgmentKind === 'first_instance' ? pick('appeal.first_instance') : null;
  }
  /* cassation */
  return judgmentKind === 'appeal' ? pick('cassation.from_appeal_judgment') : null;
}

/** Every rule, for the screen that shows the firm what the system is applying. */
export function appealRulesCatalogue(): DeadlineRule[] {
  return Object.values(APPEAL_RULES).map((r) => ({ ...r }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3 · THE ARITHMETIC
// ═══════════════════════════════════════════════════════════════════════════════

const DAY_MS = 86_400_000;

/**
 * The Kingdom's offset, as a fixed number of minutes.
 *
 * Saudi Arabia observes UTC+03:00 with no daylight saving, which is why this is a constant
 * and not a timezone database lookup. If that ever changes, this is the one line that
 * changes, and every computed period moves with it — which is the point of it being here
 * rather than spread across the SQL, the route and the screen.
 */
export const KSA_OFFSET_MINUTES = 180;

/** The UTC moment that is the end of a calendar day in the Kingdom. */
export function endOfDayKsa(day: string | Date): string {
  const date = utcMidnight(day);
  const next = new Date(date.getTime() + DAY_MS);
  /* 00:00 the next day, in the Kingdom, is the last instant of this one. */
  return new Date(next.getTime() - KSA_OFFSET_MINUTES * 60_000 - 1).toISOString();
}

/** Midnight UTC of the calendar date a timestamp falls on. */
export function utcMidnight(value: string | Date): Date {
  const d = new Date(typeof value === 'string' ? value : value.getTime());
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${String(value)}`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

export interface AppealClock {
  /** The day the period begins: the day after delivery. */
  startsAt: string;
  /** The day the period ends, after any extension. `YYYY-MM-DD`. */
  dueDate: string;
  /** The moment it ends: the end of that day in the Kingdom. */
  dueAt: string;
  /** The number of days applied — 30 normally, 10 or 15 when the matter is urgent. */
  days: number;
  rule: DeadlineRule;
  /** The un-extended date, when an extension happened. Null on the ordinary case. */
  extendedFrom: string | null;
  /** The weekday the period would have ended on without the extension. */
  extendedBecause: string | null;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Turn a delivery date into a deadline.
 *
 * `effectiveAt` is when the service took effect — for a personal service that is the hour it
 * happened, for substituted service it is the end of the publication period, and the caller
 * gets that from `serviceEffect`. Only its calendar date is used, because a period expressed
 * in days is a period expressed in days.
 */
export function appealDeadlineAt(args: {
  effectiveAt: string | Date;
  rule: DeadlineRule;
  holidays?: string[];
}): AppealClock {
  const { rule } = args;
  const holidays = args.holidays ?? [];
  const served = utcMidnight(args.effectiveAt);

  /* Rule 1: the period runs from the day AFTER delivery, and day `n` is the nth day after it. */
  const starts = new Date(served.getTime() + DAY_MS);
  const raw = new Date(served.getTime() + rule.days * DAY_MS);

  /* Rule 2: the last day moves to the next day the courts sit; the first does not. */
  let due = raw;
  while (!isWorkingDay(due, holidays)) due = new Date(due.getTime() + DAY_MS);
  const extended = due.getTime() !== raw.getTime();

  return {
    startsAt: isoDay(starts),
    dueDate: isoDay(due),
    /* Rule 3: the moment is the end of that day in the Kingdom. */
    dueAt: endOfDayKsa(due),
    days: rule.days,
    rule,
    extendedFrom: extended ? isoDay(raw) : null,
    extendedBecause: extended ? WEEKDAY_NAMES[raw.getUTCDay()]! : null,
  };
}

/** The last moment of a date-only deadline, for the comparisons that use one. */
export function endOfDayIso(day: string): string {
  return endOfDayKsa(day);
}

/** True when `now` is past the moment the period closed. */
/**
 * Adds whole days to an ISO instant, in UTC — the horizon a calendar lookup needs.
 *
 * NOT A PERIOD CALCULATION: it does not know about weekends, holidays or the Kingdom's
 * offset. It answers one question — "how far ahead does a caller have to look for holidays
 * before a period can end" — and the answer is deliberately generous. A calendar lookup
 * that was too short would silently extend a deadline past a holiday nobody fetched, which
 * is the one direction of error this whole phase exists to avoid.
 */
export function addDaysToInstant(instant: string, days: number): string {
  const d = new Date(instant);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function isWindowClosed(dueAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!dueAt) return false;
  return now.getTime() > new Date(dueAt).getTime();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4 · SERVICE, AND WHAT COUNTS AS ONE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The outcomes that are service. Everything else is an attempt.
 *
 * `refused` is here on purpose and it is the one people get wrong. A party who refuses to
 * accept the judgment copy does not thereby postpone the period — the refusal is recorded by
 * the judicial officer who attended, and the service takes effect. Treating refusal as a
 * failed service would hand every defendant a veto over the calendar.
 */
export const SERVICE_TAKING_OUTCOMES: readonly ServiceOutcome[] = ['served', 'refused', 'substituted'];

/** The default publication period, used when the record does not name one. */
export const DEFAULT_PUBLICATION_DAYS = 15;

export interface ServiceFacts {
  noticeKind: NoticeKind;
  method: ServiceMethod;
  outcome: ServiceOutcome;
  servedOnKind: ServiceOnKind;
  servedAt: string | null;
  attemptedAt: string | null;
  publicationDays: number | null;
  proofDocumentId: string | null;
  proofReference: string | null;
}

export interface ServiceEffect {
  /** Whether this attempt started a clock. */
  effective: boolean;
  /** When it took effect. Null when it did not. */
  effectiveAt: string | null;
  /** Why not, in the vocabulary of the gate, when it did not. */
  code: 'service_defective' | 'judgment_not_served' | null;
  /** One sentence a person can act on. */
  reason: string;
}

export function serviceEffect(f: ServiceFacts): ServiceEffect {
  const { outcome, method, servedAt } = f;

  if (outcome === 'pending') {
    return {
      effective: false, effectiveAt: null, code: 'judgment_not_served',
      reason: 'the service has been attempted but its outcome is not recorded yet, so no '
        + 'period runs from it',
    };
  }

  if (outcome === 'unclaimed' || outcome === 'untraceable') {
    /*
      NEITHER OF THESE IS SERVICE, AND SAYING SO IS THE POINT OF THE FUNCTION.

      A registered letter that was never collected, and an address that could not be found,
      are both attempts. The law's answer to each is another attempt or an application for
      substituted service — not a clock that starts running against a person who was never
      told. A system that treated them as service would produce a date that looks like a
      deadline and is a defence for the other side.
    */
    return {
      effective: false, effectiveAt: null, code: 'service_defective',
      reason: outcome === 'unclaimed'
        ? 'the registered letter was not collected: an uncollected notice is not service, and the '
          + 'period does not run — serve again, or apply for substituted service'
        : 'the party could not be found at the recorded address: an attempt that did not reach '
          + 'anyone is not service — apply for substituted service',
    };
  }

  if (!SERVICE_TAKING_OUTCOMES.includes(outcome)) {
    return {
      effective: false, effectiveAt: null, code: 'service_defective',
      reason: `an outcome of "${outcome}" does not effect service`,
    };
  }

  if (!servedAt) {
    return {
      effective: false, effectiveAt: null, code: 'service_defective',
      reason: 'the outcome says service but no date of service is recorded, so no period can run',
    };
  }

  if (outcome === 'substituted') {
    /*
      SUBSTITUTED SERVICE TAKES EFFECT AT THE END OF ITS PUBLICATION PERIOD.

      The period is the court's to fix and the firm's to record, so it is stored on the row
      (`publication_days`) rather than assumed here. The default is the firm's own practice
      parameter and it is written onto the row at creation, which means no computed date in
      this system depends on a constant nobody can see.
    */
    const days = f.publicationDays ?? DEFAULT_PUBLICATION_DAYS;
    const starts = new Date(utcMidnight(servedAt).getTime() + days * DAY_MS);
    return {
      effective: true,
      effectiveAt: new Date(starts.getTime() - KSA_OFFSET_MINUTES * 60_000 - 1).toISOString(),
      code: null,
      reason: `substituted service by ${method}: effective at the end of the publication period `
        + `of ${days} days`,
    };
  }

  return {
    effective: true,
    effectiveAt: new Date(servedAt).toISOString(),
    code: null,
    reason: outcome === 'refused'
      ? 'the party refused the copy and the refusal was recorded: a documented refusal is service'
      : 'the judgment copy was delivered',
  };
}

/**
 * Whether a service record is complete enough to be relied on.
 *
 * The proof is not a formality. In a hearing about whether a party was served, the answer is
 * the officer's report or the acknowledgment — so a service with no proof is recorded as a
 * service that happened and cannot be evidenced, and the register says so rather than
 * presenting it as done.
 */
export function serviceProofMissing(f: ServiceFacts): boolean {
  if (!SERVICE_TAKING_OUTCOMES.includes(f.outcome)) return false;
  return !f.proofDocumentId && !f.proofReference;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5 · FINALITY AND ENFORCEABILITY
// ═══════════════════════════════════════════════════════════════════════════════

export interface AppealFacts {
  id: string;
  kind: AppealKind;
  status: AppealStatus;
  filedAt: string | null;
  deadlineAt: string | null;
  outcome: AppealOutcome | null;
}

export interface JudgmentFacts {
  id: string;
  matterId: string;
  clientId: string;
  kind: JudgmentKind;
  urgent: boolean;
  pronouncedAt: string;
  /** The date of the service that took effect, and whether one did. */
  servedAt: string | null;
  serviceEffectiveAt: string | null;
  /** A service exists whose outcome was not service — the difference between the two refusals. */
  serviceAttemptedWithoutEffect: boolean;
  /** Recorded by the firm when the judgment cannot be appealed at all (a Supreme Court ruling). */
  appealable: boolean;
  /** Closed by an explicit finding, when the firm records one. */
  finalAt: string | null;
  stayInForce: boolean;
  relief: ReliefKind;
  amountSar: number | null;
  enforcementStatus: EnforcementStatus;
  appeals: AppealFacts[];
  /** The clock the register holds for this judgment, if one was computed at service. */
  appealDeadlineAt: string | null;
  appealRuleCited: string | null;
  appealRuleDays: number | null;
}

export interface JudgmentAssessment {
  /** May no longer be challenged on the ordinary routes. */
  final: boolean;
  /** May be enforced: final, served, unstayed, and ordering something. */
  enforceable: boolean;
  /** An appeal or cassation is filed and undecided. */
  appealPending: boolean;
  /** The period for challenging it is still running. */
  windowOpen: boolean;
  /** The challenge that is pending, if any. */
  pendingAppeal: AppealFacts | null;
  /** Why it is not final, in the same vocabulary the gate refuses with. */
  notFinalBecause: 'appeal_pending' | 'appeal_window_open' | null;
}

/** An appeal is pending while it is filed or registered and no decision has been given. */
export function isAppealPending(a: AppealFacts): boolean {
  return a.status === 'filed' || a.status === 'registered';
}

/**
 * Judge one judgment.
 *
 * Deliberately takes facts and a clock rather than reading anything, so that the same
 * function answers for the register on the screen, for the gate on the route, and for the
 * test that drives both.
 */
export function assessJudgment(f: JudgmentFacts, now: Date = new Date()): JudgmentAssessment {
  const pendingAppeal = f.appeals.find(isAppealPending) ?? null;
  const appealPending = pendingAppeal !== null;

  /*
    A JUDGMENT IS FINAL FOR ONE OF THREE REASONS, and they are worth separating because the
    screen explains them differently:

      · a court has said so and the firm recorded it (`finalAt`);
      · it cannot be challenged at all (`appealable = false`, or a cassation judgment);
      · the period for challenging it has run out with nothing filed.
  */
  const windowOpen = f.appealable && !isWindowClosed(f.appealDeadlineAt, now);
  const final = f.finalAt !== null
    || !f.appealable
    || f.kind === 'cassation'
    || (!windowOpen && !appealPending);

  const enforceable = final
    && !appealPending
    && f.serviceEffectiveAt !== null
    && !f.stayInForce
    && f.relief !== 'none'
    && f.enforcementStatus !== 'satisfied'
    && f.enforcementStatus !== 'closed'
    && f.enforcementStatus !== 'not_enforceable';

  return {
    final,
    enforceable,
    appealPending,
    windowOpen,
    pendingAppeal,
    notFinalBecause: appealPending ? 'appeal_pending' : windowOpen ? 'appeal_window_open' : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6 · THE GATE ON ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export type ExecutionRefusal =
  | 'judgment_missing' | 'judgment_not_enforceable' | 'judgment_not_served'
  | 'service_defective' | 'execution_stayed' | 'appeal_pending' | 'appeal_window_open'
  | 'judgment_not_operative';

export type ExecutionOutcome =
  | { allowed: true; judgmentId: string }
  | {
      allowed: false;
      code: ExecutionRefusal;
      message: string;
      /** The date the refusal stops being true, when the system knows it. */
      unblocksAt: string | null;
    };

/**
 * Which judgment a matter is enforced on: the latest one pronounced.
 *
 * NOT THE JUDGMENT THAT SUITS THE FIRM BEST, and not the first one either. A matter can
 * carry a first-instance judgment and the appeal judgment that followed it; the appeal
 * judgment is what stands, and whether it may be enforced is a question about ITS period for
 * cassation. Choosing between them by any other rule would be the system deciding a legal
 * question, which is the one thing this file must never do.
 *
 * The tie-break is `createdAt`, because two judgments pronounced the same day are ordered by
 * when the firm recorded them — deterministic, and stated here so that the SQL can state it
 * too rather than the database and this function disagreeing about which row is decisive.
 */
export function operativeJudgment<T extends { pronouncedAt: string; createdAt?: string }>(
  judgments: readonly T[],
): T | null {
  if (!judgments.length) return null;
  return [...judgments].sort((a, b) => {
    const byDate = String(b.pronouncedAt).localeCompare(String(a.pronouncedAt));
    if (byDate !== 0) return byDate;
    return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
  })[0]!;
}

/**
 * THE GATE.
 *
 * The order is part of the answer. It runs from the fact that cannot be worked around to the
 * one that merely needs patience:
 *
 *   1 · is there a judgment at all — nothing else can be true without one;
 *   2 · does it order something that can be executed — a procedural dismissal is a judgment
 *       the firm won and there is nothing to collect;
 *   3 · may the power of the state be used against this person — has the صك reached them;
 *   4 · was the attempt at service one that does not count;
 *   5 · has a court stopped the execution;
 *   6 · is a challenge pending;
 *   7 · is the period for challenging it still open, and until when.
 *
 * A refusal that names the date it stops being true is the difference between a gate and a
 * wall: `appeal_window_open` carries the day the period closes, and the register sorts by it.
 */
export function executionOutcome(args: {
  judgments: readonly JudgmentFacts[];
  now?: Date;
}): ExecutionOutcome {
  const now = args.now ?? new Date();
  const judgments = args.judgments;

  if (!judgments.length) {
    return {
      allowed: false, code: 'judgment_missing',
      message: 'no judgment is registered on this matter: record the صك and its delivery before '
        + 'enforcement is considered',
      unblocksAt: null,
    };
  }

  const operative = operativeJudgment(judgments);
  if (!operative) {
    return {
      allowed: false, code: 'judgment_missing',
      message: 'no judgment is registered on this matter',
      unblocksAt: null,
    };
  }

  /* (2) Nothing to enforce. Said in those words, because "you won nothing to collect" and
     "you have not registered the judgment" are different jobs for the reader. */
  if (operative.relief === 'none') {
    return {
      allowed: false, code: 'judgment_not_enforceable',
      message: 'the operative judgment orders nothing that can be executed (a procedural '
        + 'decision, or a claim dismissed in full)',
      unblocksAt: null,
    };
  }

  const assessment = assessJudgment(operative, now);

  /* (3) THE DELIVERY. Without it the period has not started, and enforcement against a person
     who has not been told is not enforcement — it is a surprise. */
  if (!operative.serviceEffectiveAt) {
    if (operative.serviceAttemptedWithoutEffect) {
      return {
        allowed: false, code: 'service_defective',
        message: 'the only service recorded for this judgment did not take effect (refused copy, '
          + 'uncollected letter, or a party who could not be found): serve again lawfully, or apply '
          + 'for substituted service',
        unblocksAt: null,
      };
    }
    return {
      allowed: false, code: 'judgment_not_served',
      message: 'the judgment has not been served on the party enforcement is sought against, so '
        + 'no period has started to run from',
      unblocksAt: null,
    };
  }

  /* (5) A court has said stop. Before the appeal questions, because it settles them. */
  if (operative.stayInForce) {
    return {
      allowed: false, code: 'execution_stayed',
      message: 'a stay of execution is in force against this judgment — enforcement may not begin '
        + 'while it stands',
      unblocksAt: null,
    };
  }

  /* (6) A challenge is pending: the matter is before a court. */
  if (assessment.appealPending) {
    return {
      allowed: false, code: 'appeal_pending',
      message: `a ${assessment.pendingAppeal!.kind} is filed and undecided (status `
        + `"${assessment.pendingAppeal!.status}")`,
      unblocksAt: null,
    };
  }

  /* (7) The period is still open, and the refusal says until when. */
  if (assessment.windowOpen) {
    return {
      allowed: false, code: 'appeal_window_open',
      message: `the period for challenging this judgment is still running; it closes at the end `
        + `of ${String(operative.appealDeadlineAt).slice(0, 10)}`,
      unblocksAt: operative.appealDeadlineAt,
    };
  }

  return { allowed: true, judgmentId: operative.id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7 · THE LIFECYCLE, AS A MATRIX
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Which enforcement states may follow which.
 *
 * Written as a matrix rather than as a chain of conditions, because the database has to
 * enforce the same matrix and a matrix can be transcribed into a trigger and diffed. The
 * tempting invalid moves are the interesting entries: `under_enforcement → enforceable` would
 * be enforcement quietly un-happening, `satisfied → under_enforcement` would be the same
 * judgment collected twice, and both are refused.
 */
/*
  THE MATRIX, WITH ONE EDGE THAT LOOKS WRONG AND IS NOT.

  `awaiting_finality → under_enforcement` is deliberately allowed. The status column is a
  RECORD of the judgment's procedural position, and a record can lag the facts: a period
  closes on a Thursday and nobody opens the file until the following month, so the judgment
  is enforceable in law while its row still says `awaiting_finality`. If the matrix refused
  that edge, a firm that had not ticked the intermediate state could not enforce a judgment
  it is entitled to enforce — and the refusal would tell them to "mark it enforceable
  first", which is not a legal act, it is data entry.

  WHAT MAKES THE EDGE SAFE IS WHO TAKES IT. Only the enforcement gate, and only after every
  condition it checks has passed — no appeal pending, nothing stayed, the period closed,
  something ordered. The gate records that finality on the way through (it writes `final_at`
  when the row has none), so the state it skips is not erased from the file; it is written
  at the moment it becomes true. And the edges that protect against real error are untouched:
  `under_enforcement → enforceable` is still impossible, and `satisfied` still has none.
*/
export const ENFORCEMENT_TRANSITIONS: Readonly<Record<EnforcementStatus, readonly EnforcementStatus[]>> = {
  not_enforceable: ['awaiting_finality'],
  awaiting_finality: ['enforceable', 'stayed', 'not_enforceable', 'under_enforcement'],
  enforceable: ['under_enforcement', 'stayed', 'not_enforceable'],
  stayed: ['enforceable', 'awaiting_finality', 'not_enforceable'],
  under_enforcement: ['satisfied', 'closed', 'stayed'],
  satisfied: [],
  closed: ['awaiting_finality'],
} as const;

export function canMoveEnforcement(from: EnforcementStatus, to: EnforcementStatus): boolean {
  return (ENFORCEMENT_TRANSITIONS[from] ?? []).includes(to);
}

/** The state a judgment should be in, given what is true of it. Derived, never typed. */
export function enforcementStatusFor(
  f: JudgmentFacts,
  assessment: JudgmentAssessment,
): EnforcementStatus {
  /* A terminal state is terminal: what is done is done, whatever a later fact says. */
  if (f.enforcementStatus === 'satisfied' || f.enforcementStatus === 'closed') return f.enforcementStatus;
  if (f.enforcementStatus === 'under_enforcement') {
    return f.stayInForce ? 'stayed' : 'under_enforcement';
  }
  if (f.relief === 'none') return 'not_enforceable';
  if (f.stayInForce) return 'stayed';
  return assessment.enforceable ? 'enforceable' : 'awaiting_finality';
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8 · WHAT THE REGISTER SHOWS
// ═══════════════════════════════════════════════════════════════════════════════

export interface RegisterEntry {
  judgmentId: string;
  matterId: string;
  clientId: string;
  enforcementStatus: EnforcementStatus;
  /** The gate's answer about this judgment. */
  outcome: ExecutionOutcome;
  /** The date the refusal stops being true, when the system knows it. */
  unblocksAt: string | null;
  /** The next thing that will happen, in the firm's own terms. */
  nextStep: 'enforce' | 'wait_for_period' | 'wait_for_appeal' | 'wait_for_stay'
    | 'serve_the_judgment' | 'none';
}

/**
 * The register: one line per judgment, ordered by what needs attention soonest.
 *
 * The ordering is the feature. A list sorted by matters puts the one whose period closes on
 * Thursday below the one that cannot move at all; a list sorted by the date the system will
 * next change its mind puts it at the top, which is where a person about to run out of time
 * needs it to be.
 */
export function enforcementRegister(
  rows: ReadonlyArray<{ facts: JudgmentFacts; assessment: JudgmentAssessment }>,
): RegisterEntry[] {
  const entries = rows.map(({ facts, assessment }) => {
    const outcome = executionOutcome({ judgments: [facts] });
    let nextStep: RegisterEntry['nextStep'];
    if (outcome.allowed) nextStep = 'enforce';
    else if (outcome.code === 'judgment_not_served' || outcome.code === 'service_defective') nextStep = 'serve_the_judgment';
    else if (outcome.code === 'execution_stayed') nextStep = 'wait_for_stay';
    else if (outcome.code === 'appeal_pending') nextStep = 'wait_for_appeal';
    else if (outcome.code === 'appeal_window_open') nextStep = 'wait_for_period';
    else nextStep = 'none';
    return {
      judgmentId: facts.id,
      matterId: facts.matterId,
      clientId: facts.clientId,
      enforcementStatus: enforcementStatusFor(facts, assessment),
      outcome,
      unblocksAt: outcome.allowed ? null : outcome.unblocksAt,
      nextStep,
    };
  });

  /* Decided first, then whatever unblocks soonest, then the ones with no date at all. */
  const rank = (e: RegisterEntry): number =>
    e.nextStep === 'enforce' ? 0 : e.unblocksAt ? 1 : 2;
  return entries.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const at = (e: RegisterEntry) => (e.unblocksAt ? new Date(e.unblocksAt).getTime() : Number.MAX_SAFE_INTEGER);
    return at(a) - at(b);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9 · THE HIJRI DATE THE CALENDAR CARRIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The Umm al-Qura date of a Gregorian day, as the firm would write it.
 *
 * The arithmetic above stays Gregorian on purpose — that is what the courts and the
 * calendar run on — but a Saudi court's own recess is announced in Hijri terms, so the
 * calendar records both: the Gregorian date it is keyed by and the Hijri date a person
 * reading it recognises. `Intl` with `islamic-umalqura` is the same conversion the portal
 * uses to render a date for a client, so the two cannot drift apart.
 */
export function hijriDateOf(day: string | Date): string | null {
  const d = utcMidnight(day);
  try {
    const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    /* Written as the Kingdom writes it: 1448-03-21, not 03/21/1448 AH. A date a person
       reads off a screen and copies into a form must not be re-parseable only in Ohio. */
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return null;
  }
}

/** The weekend the Kingdom observes, exported so a screen can say it and mean this one. */
export const COURT_WEEKEND_DAYS: readonly number[] = WEEKEND_DAYS;

/**
 * Whether the courts sit on a calendar date, by its date-only form.
 *
 * THE STRING ENTRY POINT TO THE SAME RULE. `isWorkingDay` in the AML module takes a `Date`,
 * because that is what the period arithmetic walks; every INTERFACE in this product — a
 * screen, a route, a recorded holiday — speaks in `YYYY-MM-DD`, because that is what a person
 * types and what a court writes. Stating the conversion once, here, is what stops two callers
 * from making it differently: a `new Date('2026-10-02')` in one place and
 * `new Date('2026-10-02T00:00:00+03:00')` in another are the same day in Riyadh and different
 * days in UTC, and the difference is a deadline.
 */
export function isCourtDay(day: string | Date, holidays: string[] = []): boolean {
  return isWorkingDay(utcMidnight(day), holidays);
}
