import { isTransientConnectionError } from '../db/transient.js';

/**
 * Error model (§32).
 *
 * A `PortalError` carries exactly two things that may reach a browser:
 *   - an HTTP status
 *   - a stable, non-revealing `code` that the UI maps to a localized message
 *
 * The underlying cause is logged server-side with a request id and is NEVER
 * serialized. There is no code path in this application that puts a database
 * error, a stack trace, a SQL fragment, a provider message or a JWT failure
 * into a response body.
 */
export type ErrorCode =
  // auth
  | 'invalid_credentials'
  | 'account_locked'
  | 'account_disabled'
  | 'email_not_verified'
  | 'mfa_required'
  | 'mfa_invalid'
  | 'session_expired'
  | 'session_revoked'
  | 'unauthenticated'
  | 'rate_limited'
  | 'token_invalid'
  | 'token_expired'
  | 'token_used'
  | 'password_policy'
  | 'password_mismatch'
  | 'invitation_invalid'
  | 'invitation_expired'
  | 'invitation_revoked'
  | 'invitation_accepted'
  | 'signup_disabled'
  // authorization
  | 'forbidden'
  | 'not_found'
  | 'tenant_mismatch'
  | 'client_mismatch'
  | 'resource_not_accessible'
  /*
    The portal's role gate (§36). A `client_contact` is a colleague the account
    holder has admitted to the WORK; the invoices, the receipts and the act of
    paying belong to the holder. Named rather than generic `forbidden` because
    the reader deserves the rule, not a shut door — and because the audit trail
    should say which rule refused, not that something did.
  */
  | 'role_not_permitted'
  | 'internal_resource'
  | 'mutation_denied'
  | 'field_not_writable'
  // the conflict gate (§P0.1) — each of these names an obstacle a lawyer can act on.
  // A single generic 'forbidden' here would tell them the door is shut without
  // saying which key opens it, and they would work around the control instead.
  | 'already_dispositioned'
  /*
    P0.3 · CLIENT DUE DILIGENCE. Every code here is a named obstacle, for the same reason
    the conflict gate's are: the obligation is a list of requirements, and a person who is
    refused needs to know which one they have not met. `cdd_gate_denied` is the manual's
    prohibition — the firm may not act for this client — and it is deliberately distinct
    from `cdd_incomplete`, which is a file that is merely unfinished.
  */
  | 'cdd_missing'
  | 'cdd_incomplete'
  | 'cdd_unable_to_complete'
  | 'cdd_gate_denied'
  | 'cdd_already_open'
  | 'cdd_record_closed'
  | 'senior_approval_required'
  | 'screening_unresolved'
  | 'screening_incomplete'
  | 'screening_failed'
  | 'sanctions_match'
  | 'cdd_review_overdue'
  | 'cdd_beneficial_owner_missing'
  | 'aml_record_retention'
  | 'str_narrative_incomplete'
  | 'str_narrative_not_arabic'
  | 'str_filed_immutable'
  | 'str_not_approved'
  | 'str_not_draft'
  | 'str_not_reviewed'
  | 'str_not_filed'
  /*
    P0.4 · JUDGMENTS, SERVICE AND ENFORCEMENT. The codes are in the ORDER of the gate, and
    the order is the contract: a person refused `judgment_not_enforceable` learns nothing
    from also being told the period is open, and the first true reason is the one that
    tells them what to do next. `appeal_window_open` is the only refusal in this system
    that carries a date on the wire (`details.unblocksAt`), because for it the date IS the
    instruction: wait until then, or do something else meanwhile.
  */
  | 'judgment_missing'
  /* No judgment on the matter is the operative one — every judgment is superseded, or the
     latest one has been set aside. Distinct from `judgment_missing`, which is a matter with
     no register at all. */
  | 'judgment_not_operative'
  | 'judgment_not_enforceable'
  | 'judgment_not_served'
  | 'service_defective'
  | 'execution_stayed'
  | 'appeal_pending'
  | 'appeal_window_open'
  | 'enforcement_transition_invalid'
  | 'appeal_not_available'
  /* A judgment was served and no period was computed from it — the state in which a system
     believes it has diarised an appeal and has not. Refused by the database as well. */
  | 'appeal_window_uncomputed'
  | 'judgment_finality_contradiction'
  | 'judgment_retention'
  /* P0.5 — the privilege ring. `privilege_ring_refused` is the one DB refusal that IS an
     authorization decision, so it is the one that maps to a 403: the record is fine, the
     caller is not in the ring, and the reason travels with it. */
  | 'privilege_ring_refused'
  | 'privilege_ground_recipient_mismatch'
  | 'privilege_consent_document_required'
  /* The release ledger's two document references must be documents of THIS matter (the
     subject) and of the CLIENT (the consent). An FK proves a document exists somewhere;
     it does not prove it is the document the release claims to rest on. */
  | 'privilege_document_mismatch'
  | 'service_retention'
  | 'procedural_deadline_lane'
  | 'written_consent_required'
  | 'not_a_confirmed_conflict'
  | 'no_affected_party'
  | 'conflicts_outstanding'
  | 'conflict_gate'
  /**
   * A client may not be linked to a party that is archived or merged: the engine
   * would then match current work against a record the firm has retired, and the
   * party's successor would be missed.
   */
  | 'party_not_active'
  /**
   * A concluded conflict check may not be restated. Same reason as an already
   * dispositioned finding: the record has to show the decision, not the latest
   * wording of it.
   */
  | 'already_concluded'
  /*
    ── 0034–0036 · the fiscal document, client money and the fee ─────────────────

    Every one of these names an obstacle the person holding the money can act on.
    That is the rule the conflict-gate codes above follow: a refusal that says only
    "forbidden" tells a finance manager the door is shut without saying which key
    opens it, and they will route around the control instead of through it — which is
    how a firm ends up with client money outside the ledger.
  */
  /** The invoice is not (yet) a tax invoice, so it may not reach the client. */
  | 'invoice_not_issued'
  | 'invoice_number_taken'
  /** A standard invoice that ZATCA has not cleared — the buyer cannot claim the VAT. */
  | 'invoice_not_cleared'
  /** The firm has no onboarded production fiscal identity and device. */
  | 'fiscal_identity_incomplete'
  /** A UUID without a counter, a hash or a QR is not an issued document. */
  | 'fiscal_chain_incomplete'
  /** A standard invoice must name the buyer's VAT registration number. */
  | 'buyer_vat_required'
  /** An issued invoice is immutable; the remedy is a credit note. */
  | 'issued_invoice_immutable'
  | 'issued_invoice_not_deletable'
  | 'invoice_lines_do_not_reconcile'
  | 'credit_note_exceeds_invoice'
  | 'credit_note_against_unissued_invoice'
  /* The rule the database enforces for a standard invoice, and nothing else does. */
  | 'credit_note_not_cleared'
  /* client money */
  | 'ledger_is_append_only'
  | 'ledger_not_found'
  | 'ledger_not_open'
  | 'ledger_direction_wrong'
  | 'ledger_evidence_required'
  | 'already_reversed'
  | 'trust_application_exceeds_invoice'
  | 'trust_application_wrong_client'
  /** The firm spent money that belonged to a client. The end of a practice. */
  | 'client_funds_overdrawn'
  | 'reconciliation_is_append_only'
  | 'reconciliation_does_not_balance'
  /* the fee */
  | 'engagement_gate'
  | 'billing_cap_exceeded'
  | 'billing_terms_disagree'
  | 'expense_receipt_required'
  | 'expense_wrong_client'
  | 'entry_already_billed'
  | 'ceiling_actor_unknown'
  // validation
  | 'validation_failed'
  | 'upload_too_large'
  | 'upload_type_not_allowed'
  | 'upload_rejected'
  | 'upload_not_permitted'
  | 'payload_too_large'
  | 'invalid_json'
  // misc
  | 'csrf_failed'
  | 'conflict'
  | 'unavailable'
  | 'internal_error'
  /**
   * The database was unreachable for this request and the failure was transient: the
   * pooler refused a connection, an idle one was closed underneath us, or a cold
   * instance's connect timed out. Distinct from `internal_error` because it is worth
   * trying again, and because telling a user "something unexpected went wrong" when the
   * server knows exactly what went wrong is not an error message, it is a shrug.
   */
  | 'service_unavailable';

export class PortalError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly safeDetails?: Record<string, unknown>;
  /** Server-side only. Never serialized to the client. */
  readonly internalCause?: unknown;
  /** Machine-readable audit reason. */
  readonly auditReason?: string;
  /**
   * The entity this error concerns, when known. Carrying it on the error lets
   * the audit trail record "client X attempted matter Y" rather than the raw
   * request path — which is what an incident report actually needs. Server-side
   * only; never serialized into the client response body.
   */
  readonly resource?: { type: string; id: string | null };
  /**
   * Set when the throwing code has ALREADY written the audit event for this
   * refusal. The error handler must not write a second row: one attempt, one
   * event, with the specific reason the guard knew about rather than the
   * generic error code.
   */
  readonly alreadyAudited?: boolean;
  /**
   * Safe to send the identical request again. Only ever true for a failure that happened
   * before the statement ran, or for a read that failed on a dead connection.
   */
  readonly retryable?: boolean;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    opts: {
      details?: Record<string, unknown>;
      cause?: unknown;
      auditReason?: string;
      resource?: { type: string; id: string | null };
      alreadyAudited?: boolean;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'PortalError';
    this.status = status;
    this.code = code;
    this.safeDetails = opts.details;
    this.internalCause = opts.cause;
    this.auditReason = opts.auditReason;
    this.resource = opts.resource;
    this.alreadyAudited = opts.alreadyAudited;
    this.retryable = opts.retryable;
  }
}

export const badRequest = (code: ErrorCode, msg: string, details?: Record<string, unknown>) =>
  new PortalError(400, code, msg, { details });

export const unauthorized = (code: ErrorCode, msg: string, details?: Record<string, unknown>) =>
  new PortalError(401, code, msg, { details });

export const forbidden = (
  code: ErrorCode,
  msg: string,
  auditReason?: string,
  opts: { alreadyAudited?: boolean } = {},
) => new PortalError(403, code, msg, { auditReason, alreadyAudited: opts.alreadyAudited });

/**
 * Missing and forbidden are intentionally indistinguishable from the outside:
 * probing for another client's matter id must not be able to distinguish
 * "exists but not yours" from "does not exist".
 */
/**
 * @param what  entity type, e.g. 'matter'
 * @param id    the identifier that was requested. Recorded in the audit trail so
 *              a denial names the entity, not just the URL. Never returned to
 *              the caller, keeping "not yours" indistinguishable from "absent".
 */
export const notFoundOrForbidden = (what = 'resource', id?: string | null) =>
  new PortalError(404, 'not_found', `${what} not found`, {
    auditReason: 'resource_not_visible',
    resource: { type: what, id: id ?? null },
  });

export const conflict = (code: ErrorCode, msg: string) => new PortalError(409, code, msg);

export const tooMany = (retryAfterSeconds: number) =>
  new PortalError(429, 'rate_limited', 'too many requests', {
    details: { retryAfterSeconds },
  });

export const internal = (cause?: unknown) =>
  new PortalError(500, 'internal_error', 'internal error', { cause });

/**
 * Converts unknown throwables into a PortalError. Anything that is not already
 * a PortalError becomes a generic 500 — the original detail is attached as
 * `cause` for server-side logging and is never sent to the client (§32).
 */
/**
 * Reduces any thrown value to a PortalError.
 *
 * Malformed input is the single most common hostile request a portal receives,
 * so the framework's own parse/size errors are mapped to honest 4xx codes here.
 * Without this mapping a truncated JSON body or an oversized upload becomes a
 * 500: the caller learns that the server had an internal error, the incident log
 * fills with noise, and the real signal is lost.
 *
 * Only the well-known `type`/`code` discriminators published by body-parser and
 * multer are trusted. A status code found on an arbitrary error object is NOT
 * honoured — an internal failure must not be able to masquerade as a client
 * error and escape the audit trail.
 */
export function toPortalError(err: unknown): PortalError {
  if (err instanceof PortalError) return err;

  const e = err as { type?: unknown; code?: unknown; message?: unknown } | null;
  const type = typeof e?.type === 'string' ? e.type : '';
  const code = typeof e?.code === 'string' ? e.code : '';

  switch (type) {
    case 'entity.parse.failed':
      return new PortalError(400, 'invalid_json', 'the request body is not valid JSON', { cause: err });
    case 'entity.too.large':
      return new PortalError(413, 'payload_too_large', 'the request body is too large', { cause: err });
    case 'entity.verify.failed':
      return new PortalError(400, 'validation_failed', 'the request body could not be verified', { cause: err });
    case 'encoding.unsupported':
      return new PortalError(415, 'validation_failed', 'unsupported character encoding', { cause: err });
    case 'request.aborted':
      return new PortalError(400, 'validation_failed', 'the request was aborted', { cause: err });
    default:
      break;
  }

  switch (code) {
    case 'LIMIT_FILE_SIZE':
      return new PortalError(400, 'upload_too_large', 'the file exceeds the maximum size', { cause: err });
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_PART_COUNT':
      return new PortalError(400, 'upload_rejected', 'too many files were submitted', { cause: err });
    case 'LIMIT_FIELD_KEY':
    case 'LIMIT_FIELD_VALUE':
    case 'LIMIT_FIELD_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return new PortalError(400, 'upload_rejected', 'the upload is malformed', { cause: err });
    default:
      break;
  }

  /*
    ── THE DATABASE'S OWN REFUSALS ───────────────────────────────────────────────

    The guards in 0034–0036 raise their refusal with a token at the front of the
    message — `client_funds_overdrawn: …`, `entry_already_billed: …` — and the SQLite
    mirror raises the identical strings so both engines say the same thing. Those
    messages are a REFUSAL VOCABULARY, not diagnostics, and until this mapping existed
    they arrived at the API edge as an opaque driver error and left as a 500.

    That is the worst of both answers: the person at the desk loses the reason, and a
    legitimate business refusal is recorded in the logs as a server fault. The mapping
    is exact — the token must be followed by a colon AND must be one of the declared
    refusals — so an unrelated SQLite failure still surfaces as a 500 and still gets
    investigated. Mapping on a loose pattern would hide real breakage.
  */
  const refusal = typeof e?.message === 'string' ? REFUSAL_PATTERN.exec(e.message) : null;
  if (refusal) {
    const [token, detail] = [refusal[1], refusal[2] ?? ''];
    return new PortalError(REFUSAL_STATUS[token] ?? 400, token as ErrorCode, detail.trim(), {
      cause: err,
      auditReason: token,
    });
  }

  /*
    A CONNECTION THAT FAILED IS NOT AN INTERNAL ERROR.

    Everything above this line answers questions about the request: is the body
    well-formed, is the record in a state that permits this, did a guard refuse it. This
    final case is the only one that is about the SERVER — and the first version of it
    reported a pooler at its connection limit to the person signing in as "The request
    could not be completed. Something unexpected went wrong. Please try again." The user
    was told to try again by a message that also implied trying again would not help, with
    no reference to quote and nothing in the log tying the two together.

    503 with `retryable`, an honest sentence, and the request id the handler already
    attaches — because the remedy really is to try again, and the second attempt really
    does work.
  */
  if (isTransientConnectionError(err)) {
    return new PortalError(503, 'service_unavailable',
      'the database is temporarily unavailable', {
        cause: err,
        retryable: true,
        details: { retryable: true },
      });
  }

  return new PortalError(500, 'internal_error', 'internal error', { cause: err });
}

/**
 * A guard's message, as `<refusal>: <what the person at the desk can do about it>`.
 * Anchored at the start of the message so a token that merely appears inside a stack
 * trace or a nested cause cannot be mistaken for the refusal itself.
 */
const REFUSAL_PATTERN = /^([a-z][a-z0-9_]{4,60}):\s*([\s\S]*)$/;

/**
 * Which refusal deserves which status.
 *
 * A conflict is a refusal about the STATE of the record — an issued invoice, a billed
 * entry, a ledger already reversed. Everything else is a 400: the request asked for
 * something the firm's own rules do not permit, and the answer names which rule.
 * Nothing here is a 403, because a guard refusing a well-formed request is the
 * database doing its job, not an authorization decision — those are made above it.
 */
const REFUSAL_STATUS: Record<string, number> = {
  issued_invoice_immutable: 409,
  issued_invoice_not_deletable: 409,
  entry_already_billed: 409,
  entry_invoice_immutable: 409,
  already_reversed: 409,
  ledger_is_append_only: 409,
  reconciliation_is_append_only: 409,
  invoice_not_issued: 409,
  invoice_number_taken: 409,

  /*
    P0.3, and the same distinction. A refusal about the STATE of a record that has moved
    on is 409: the decision has been taken (a match has been dispositioned, a report has
    been filed) or a deadline has passed (the review fell due), and re-sending the request
    will not change the answer. A refusal about a file that is merely unfinished, or an
    input that does not meet the reporting requirement, is 400 — the person can complete
    the record or rewrite the narrative and come back.
  */
  already_dispositioned: 409,
  cdd_review_overdue: 409,
  aml_record_retention: 409,
  cdd_already_open: 409,
  cdd_record_closed: 409,
  str_filed_immutable: 409,
  str_not_approved: 409,
  str_not_draft: 409,
  str_not_reviewed: 409,
  str_not_filed: 409,

  // The gate's own answers, spelled out rather than left to the `?? 400` default, so the
  // vocabulary is closed: a token that reaches this file and is not listed here is a
  // refusal somebody forgot to classify.
  cdd_missing: 400,
  cdd_incomplete: 400,
  cdd_unable_to_complete: 400,
  cdd_gate_denied: 400,
  cdd_beneficial_owner_missing: 400,
  senior_approval_required: 400,
  screening_incomplete: 400,
  screening_unresolved: 400,
  screening_failed: 400,
  sanctions_match: 400,
  str_narrative_incomplete: 400,
  str_narrative_not_arabic: 400,

  /*
    P0.5, AND THE ONE EXCEPTION TO THE RULE ABOVE. Everything else in this table is a
    guard refusing a well-formed request: the record's state is wrong, or the request
    does not meet a rule the firm wrote. This one is different — the record is fine and
    the REQUESTER is outside the privilege ring. That is an authorization decision, and
    it is the only refusal in the system whose answer changes with WHO ASKED rather than
    with what was asked, so it is the only one that returns 403. Naming it 400 would
    hide the distinction the member needs: "you may not" and "you may not *yet*" are
    different sentences.
  */
  privilege_ring_refused: 403,
  privilege_ground_recipient_mismatch: 400,
  privilege_consent_document_required: 400,
  privilege_document_mismatch: 400,
};
