/**
 * THE MATTER STATE MACHINE — WHICH MOVES ARE LEGAL, AND WHY EACH ONE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A matter's `internal_status` has carried eleven values since migration 0002, and
 * the route that writes it has accepted ALL of them from ALL of them. The column
 * was a vocabulary, not a machine: a caller could move a matter from `archived`
 * straight to `active` in one write, and the record — which is the firm's account
 * of how the file got where it is — would show a single jump with no path behind
 * it. That is the gap this file closes, and it is the one the standing sequence
 * reserved a migration for (item ⑥). The map lives in the domain because the
 * transition table is a rule about law practice, not about storage.
 *
 * WHAT THE MAP IS FOR, AND WHAT IT IS NOT
 *
 *   It answers "may this move be made at all". It does NOT answer "is this member
 *   allowed to make it" (that is `matters.status`, plus `matters.close` and
 *   `matters.reopen` for the two moves that end or resume the file), and it does
 *   NOT answer "is the firm entitled to be here" — the conflict gate (Rule 11) and
 *   the customer-due-diligence gate are asked separately in the route, in that
 *   order, so a refusal names the obstacle that actually stopped it.
 *
 *   Three independent questions, three refusals, three codes. A single gate that
 *   answered all three would produce the one thing a workflow must never produce:
 *   a "no" with no reason attached.
 *
 * WHY THE MAP IS GENEROUS IN THE MIDDLE AND STRICT AT THE ENDS
 *
 *   Real files move backwards. A partner review that raises a question sends the
 *   matter back to `internal_review`; a hearing that goes badly moves a matter from
 *   `judgment` back to `on_hold`; an appeal puts an `execution` matter back under
 *   `judgment`. A machine that only moved forward would be ignored within a week,
 *   and a workflow people route around is worse than none. So the middle of the map
 *   permits the backward and lateral moves a firm actually makes.
 *
 *   The ends are strict. `archived` is terminal: reopening an archived file is a
 *   records-management decision with a retention consequence, not a click on a
 *   screen, and a firm that wants it can reopen through the API with a recorded
 *   reason. Nothing enters `execution` except from `judgment` — enforcement is an
 *   act that requires a judgment to enforce.
 *
 * THE TWO MOVES WITH THEIR OWN PERMISSION
 *
 *   · into `closed` or `archived`             → `matters.close`
 *   · out of `closed` (reopen)                → `matters.reopen`
 *
 *   Both codes have been in the permission catalogue since P0.6 and were granted to
 *   the roles that should hold them, and NOTHING consulted either one: a member with
 *   `matters.status` could close a file for the firm without the catalogue ever being
 *   asked. Closing a matter is the act that ends the accrual of obligations — it is
 *   the single most consequential transition in the list — so it carries its own code.
 */
/**
 * The eleven states, exactly as migration 0002's CHECK declares them. Typed here
 * rather than imported because the wire enum in `firm.routes.ts` and the database
 * CHECK are both derived from this list, and a fourth copy would be a fourth thing
 * to forget.
 */
export type MatterStatus =
  | 'intake' | 'conflict_check' | 'restricted' | 'internal_review' | 'partner_review'
  | 'active' | 'on_hold' | 'judgment' | 'execution' | 'closed' | 'archived';

export const MATTER_STATUSES: readonly MatterStatus[] = [
  'intake', 'conflict_check', 'restricted', 'internal_review', 'partner_review',
  'active', 'on_hold', 'judgment', 'execution', 'closed', 'archived',
];

/**
 * Every legal move, from every state.
 *
 * Read a row as: "a matter in THIS state may be moved to one of THESE".
 */
/**
 * THE WORKING SET — the states a live file moves among.
 *
 * A matter can be re-checked for conflicts mid-file (a new counterparty appears), sent
 * back for partner review, put on hold and resumed, moved into judgment and then back
 * out of it on appeal. Every one of those is a real move in a real firm, and a machine
 * that forbade them would be routed around within a week.
 *
 * The constraint is at the EDGES, not in the middle: a file cannot enter the working
 * set from `archived`, cannot leave `intake` except forward, and cannot enter
 * `execution` without a judgment (that last one is the enforcement gate's job, not the
 * map's — the map says the move exists, the gate says the judgment permits it).
 */
const WORKING: readonly MatterStatus[] = [
  'conflict_check', 'internal_review', 'partner_review',
  'active', 'on_hold', 'judgment', 'execution',
];

/** Every working state except this one, then the two exits. */
const fromWorking = (self: MatterStatus): readonly MatterStatus[] =>
  [...WORKING.filter((s) => s !== self), 'closed', 'archived'];

export const MATTER_TRANSITIONS: Readonly<Record<MatterStatus, readonly MatterStatus[]>> = {
  /*
    Intake is where a file is opened and not much else. It may go to conflict check (the
    normal path), to review, straight to ACTIVE for a routine engagement whose conflict
    position is already established, or away entirely. It may not jump to judgment,
    execution or on_hold: those states describe something that has happened to the file,
    and nothing has happened to it yet.
  */
  intake: ['conflict_check', 'internal_review', 'active', 'archived'],

  /*
    The working set. Rule 11 holds a matter HERE — the conflict gate in the route refuses
    every exit while the engine reports an undispositioned finding, and `archived` is the
    one exception, because abandoning a file is not accepting it.
  */
  conflict_check: fromWorking('conflict_check'),

  /*
    `restricted` is a state the firm can put a file in, and — deliberately — a state the
    STATUS route does not offer as a destination. Restriction is set by
    `/matters/:id/restrict`, which carries `matters.restrict`, a mandatory reason and an
    audit action. A screen that offered it here would be offering a weaker write of the
    same thing, and the weaker write is the one that would get used.
  */
  restricted: ['conflict_check', 'internal_review', 'archived'],

  internal_review: fromWorking('internal_review'),
  partner_review: fromWorking('partner_review'),
  active: fromWorking('active'),
  on_hold: fromWorking('on_hold'),
  judgment: fromWorking('judgment'),
  execution: fromWorking('execution'),

  /*
    CLOSED IS NOT FINAL — a file closed in error, or one the client reopens, must be
    resumable, and `matters.reopen` exists precisely so that resuming it is a
    permissioned act rather than an accident. Archiving is reachable from here too, which
    is how a closed file becomes a historic one.
  */
  closed: ['active', 'archived'],

  /*
    TERMINAL. Archived is the end of the operational life of a matter: it is what retention
    schedules and legal holds are computed against, and moving out of it with a single
    status write would make both of those meaningless. A firm that archived in error has
    the API and a recorded reason; that is a deliberate asymmetry.
  */
  archived: [],
};

/** The states reachable from `from`, in the order declared above. */
export function nextStates(from: MatterStatus): readonly MatterStatus[] {
  return MATTER_TRANSITIONS[from] ?? [];
}

/** May a matter in `from` be moved to `to`? A no-op move is not a transition. */
export function canTransition(from: MatterStatus, to: MatterStatus): boolean {
  if (from === to) return false;
  return nextStates(from).includes(to);
}

/** The states that END the operational life of a matter — the `matters.close` set. */
export const CLOSING_STATES: readonly MatterStatus[] = ['closed', 'archived'];

/**
 * Does this move close or archive the file, i.e. does it need `matters.close`?
 *
 * Note the asymmetry with `isReopen`: moving from `closed` to `archived` is a
 * close-set move and NOT a reopen — the file was already closed, and archiving it
 * does not resume work. Getting that backwards would demand `matters.reopen` from a
 * member putting a finished file away, which is the kind of rule that gets a
 * permission removed from a role instead of being fixed.
 */
export function isClosing(from: MatterStatus, to: MatterStatus): boolean {
  return CLOSING_STATES.includes(to) && from !== to;
}

/** Does this move resume a file that had been closed or archived? Needs `matters.reopen`. */
export function isReopen(from: MatterStatus, to: MatterStatus): boolean {
  return CLOSING_STATES.includes(from) && !CLOSING_STATES.includes(to);
}
