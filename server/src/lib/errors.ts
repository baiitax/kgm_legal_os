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
  | 'internal_resource'
  | 'mutation_denied'
  | 'field_not_writable'
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
  | 'internal_error';

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

  return new PortalError(500, 'internal_error', 'internal error', { cause: err });
}
