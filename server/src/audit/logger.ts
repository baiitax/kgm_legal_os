/**
 * Audit logging (§38).
 *
 * Properties:
 *   - append-only: the repository exposes an INSERT and nothing else; the
 *     Postgres role has no SELECT/UPDATE/DELETE grant and the SQLite schema has
 *     BEFORE UPDATE/DELETE triggers that raise. A client user cannot read,
 *     alter or erase the trail (§35 R7).
 *   - transactional: `audit()` runs on the request-scoped Queryable, so an
 *     audit row and the mutation it describes commit or roll back together.
 *     A sensitive operation therefore cannot succeed without its audit event.
 *   - secret-free: metadata passes through a denylist before it is written, and
 *     Postgres rejects the insert if a sensitive key survives.
 */
import type { Repo } from '../db/repo.js';
import type { Request } from 'express';
import { ipHashFor, geoHint, parseUserAgent } from '../lib/http.js';

export type AuditAction =
  | 'LOGIN' | 'LOGIN_FAILED' | 'LOGOUT' | 'LOGOUT_ALL_OTHERS' | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED' | 'ACCOUNT_LOCKED' | 'RATE_CARD_RECORDED'
  | 'RATE_LIMITED'
  | 'PASSWORD_RESET_REQUESTED' | 'PASSWORD_RESET_COMPLETED' | 'PASSWORD_CHANGED'
  | 'EMAIL_VERIFICATION_SENT' | 'EMAIL_VERIFIED'
  | 'INVITATION_CREATED' | 'INVITATION_ACCEPTED' | 'INVITATION_EXPIRED' | 'INVITATION_REVOKED'
  | 'MFA_ENROLLMENT_STARTED' | 'MFA_ENABLED' | 'MFA_DISABLED' | 'MFA_VERIFIED' | 'MFA_FAILED'
  | 'DEVICE_TRUSTED' | 'DEVICE_UNTRUSTED'
  | 'DOCUMENT_VIEWED' | 'DOCUMENT_DOWNLOADED' | 'DOCUMENT_UPLOADED'
  | 'DOCUMENT_UPLOAD_REJECTED' | 'SIGNED_URL_ISSUED' | 'DOCUMENT_ACCESS_DENIED'
  | 'INVOICE_VIEWED' | 'PAYMENT_STARTED' | 'PAYMENT_COMPLETED' | 'PAYMENT_FAILED'
  | 'RECEIPT_VIEWED' | 'WEBHOOK_RECEIVED' | 'WEBHOOK_SIGNATURE_INVALID'
  | 'MESSAGE_SENT' | 'MESSAGE_READ' | 'APPOINTMENT_REQUESTED' | 'APPOINTMENT_CANCELLED'
  | 'PROFILE_UPDATED' | 'PREFERENCES_UPDATED' | 'NOTIFICATION_READ'
  | 'PRIVACY_REQUEST_SUBMITTED' | 'CONSENT_RECORDED'
  | 'AUTHZ_DENIED' | 'TENANT_ISOLATION_VIOLATION' | 'CLIENT_ISOLATION_VIOLATION'
  | 'INTERNAL_RESOURCE_ACCESS_ATTEMPT' | 'FIELD_TAMPER_ATTEMPT' | 'MUTATION_DENIED'
  // Firm OS (§49, §51, §83). These are the rows a privilege-escalation review
  // is built from, so every one of them names the permission that was refused
  // and the membership that asked for it.
  | 'FIRM_LOGIN' | 'FIRM_LOGIN_FAILED' | 'FIRM_LOGOUT' | 'FIRM_SESSION_REVOKED'
  | 'FIRM_MFA_VERIFIED' | 'FIRM_MFA_FAILED'
  | 'PERMISSION_DENIED' | 'MATTER_SCOPE_DENIED' | 'CEILING_EXCEEDED'
  | 'ROLE_GRANTED' | 'ROLE_REVOKED' | 'MATTER_ACCESS_GRANTED' | 'MATTER_ACCESS_REVOKED'
  | 'MATTER_RESTRICTED' | 'MATTER_UNRESTRICTED'
  | 'ESCALATION_ATTEMPT' | 'ADMIN_MUTATION'
  /*
    ── 0029 · the party register and the conflict record (P0.1) ────────────────

    CONFLICT_HIT is separate from CONFLICT_CHECK_RUN on purpose. The run is an
    action; the hit is a FINDING, and the question asked after a disqualification
    motion is not "did somebody run the check" but "what did it find, and what did
    we do about it". An audit log that recorded only the run would show the firm
    performing diligence while saying nothing about what diligence produced.

    CONFLICT_WAIVED is written at the moment a written consent is recorded, and it
    carries the affected party — because the obligation is owed to that party, and
    the regulator's question is whether THEY consented, not whether consent exists.
  */
  | 'PARTY_CREATED' | 'PARTY_UPDATED' | 'PARTY_MERGED' | 'PARTY_ALIAS_ADDED'
  | 'PARTY_AFFILIATION_RECORDED' | 'MATTER_PARTY_ADDED' | 'MATTER_PARTY_UPDATED'
  | 'MATTER_STATUS_CHANGED'
  | 'CONFLICT_CHECK_RUN' | 'CONFLICT_HIT' | 'CONFLICT_DISPOSITION_RECORDED'
  | 'CONFLICT_CLEARED' | 'CONFLICT_DECLINED' | 'CONFLICT_WAIVED'
  /*
    ── 0027 · case-file access, and the eligibility layer ──────────────────────
    MATTER_VIEWED is the one this system was missing and could not have added by
    accident. DOCUMENT_VIEWED, INVOICE_VIEWED, MESSAGE_READ and RECEIPT_VIEWED
    were all here; reading the CASE FILE itself was not.

    That is the record a disqualification motion asks for. When a conflict
    surfaces late, the question is not "was the screen clean in March" but "who
    here had actually seen that file, and when" — imputed knowledge attaches to
    the lawyer who read the matter, independently of any register. Without this
    action the firm can prove which PDFs were opened and cannot prove who looked
    at the case.

    Note the mechanism that made this unfixable without a migration: 0023 derives
    the database's allowlist from THIS union, so a call site cannot invent an
    action. Adding the string here without admitting it in the constraint yields
    a dropped audit row, not an error. Both must move together.
  */
  | 'MATTER_VIEWED'
  | 'LICENCE_RECORDED' | 'LICENCE_STATUS_CHANGED' | 'LICENCE_VERIFIED'
  | 'PRIOR_OFFICE_RECORDED' | 'TENANT_RELATIONSHIP_DECLARED'
  | 'ELIGIBILITY_EVALUATED' | 'ELIGIBILITY_DENIED'
  | 'MULTI_FIRM_AFFILIATION_DENIED'
  /*
    ── 0034–0036 · the fiscal document, client money and the fee (P0.2, P1) ─────

    The financial actions are split by the QUESTION a reviewer asks, not by the table
    they touch. Four of them exist because a single "invoice" action could not answer
    the questions that actually get asked after a tax dispute:

      INVOICE_ISSUED      — this document entered the chain, and here is its hash.
                            Without it the chain has links and no provenance.
      INVOICE_SUBMITTED   — what we sent to ZATCA.
      INVOICE_CLEARED     — what they said back, and therefore whether the buyer may
                            claim the input VAT.
      INVOICE_REJECTED    — a rejection is a different fact from a failure, and the
                            two are triaged differently at 9am.

    A rejection that is not recorded is how a firm discovers in an audit that it has
    been issuing non-compliant documents for a month.

    The trust actions are separate from the billing actions for the same reason the
    ledger is a separate table: money held for a client and money owed by a client are
    different obligations, and a log that conflates them cannot be used to answer
    either. TRUST_DISCREPANCY_FOUND is written by the reconciliation, and it is the
    row that makes an unexplained difference a recorded event rather than a figure in
    a spreadsheet.

    ENGAGEMENT_GATE_DENIED is the Rule 12 refusal. It is a denial like any other, but
    it names the rule, and the pattern of them over a year tells a firm who is
    recording billable time on files that have no contract.
  */
  | 'FISCAL_IDENTITY_RECORDED' | 'FISCAL_DEVICE_RECORDED'
  | 'INVOICE_ISSUED' | 'INVOICE_SUBMITTED' | 'INVOICE_CLEARED' | 'INVOICE_REPORTED'
  | 'INVOICE_REJECTED' | 'CREDIT_NOTE_ISSUED'
  | 'TRUST_RECEIPT_RECORDED' | 'TRUST_APPLIED_TO_INVOICE' | 'TRUST_DISBURSEMENT_RECORDED'
  | 'TRUST_REFUND_PAID' | 'TRUST_LEDGER_FROZEN' | 'TRUST_DISCREPANCY_FOUND'
  | 'LEDGER_RECONCILED'
  | 'TIME_ENTRY_RECORDED' | 'TIME_ENTRY_ADJUSTED' | 'TIME_WRITTEN_OFF'
  | 'EXPENSE_RECORDED' | 'EXPENSE_APPROVED' | 'EXPENSE_REJECTED'
  | 'BILLING_TERMS_SET' | 'ENGAGEMENT_LETTER_RECORDED' | 'ENGAGEMENT_LETTER_SIGNED'
  | 'ENGAGEMENT_GATE_DENIED' | 'WRITE_OFF_APPROVED' | 'DISCOUNT_APPLIED'
  /*
    P0.3 · CLIENT DUE DILIGENCE AND THE AML GATES.

    WHY THESE ARE SEPARATE ACTIONS AND NOT ONE `CDD_UPDATED`. The obligation is a
    sequence of decisions, and an inspection does not ask whether the file was
    touched — it asks who decided the client was not a PEP, who ruled out a name
    match, and when the report left the building. One action for all of them would
    answer none of those.

    AND WHY THE DENIAL IS HERE TOO. `CDD_GATE_DENIED` is the manual's prohibition
    firing. A firm that never sees this action in its own trail has either nothing
    to refuse or a gate that is not working, and those are different problems.
  */
  | 'CDD_RECORDED' | 'CDD_UPDATED' | 'CDD_COMPLETED' | 'CDD_UNABLE_TO_COMPLETE'
  | 'CDD_REVIEW_SCHEDULED' | 'CDD_GATE_DENIED'
  | 'BENEFICIAL_OWNER_RECORDED' | 'BENEFICIAL_OWNER_VERIFIED'
  | 'SCREENING_RUN' | 'SCREENING_MATCH_FOUND' | 'SCREENING_MATCH_DISPOSITIONED'
  | 'SCREENING_FAILED' | 'RISK_ASSESSED' | 'RISK_COUNTRY_RECORDED'
  | 'STR_PREPARED' | 'STR_REVIEWED' | 'STR_FILED' | 'STR_RESPONSE_RECORDED'
  /*
    P0.4 · JUDGMENTS, SERVICE AND ENFORCEMENT.

    THE FOUR MEMBERS OF THIS FAMILY THAT MATTER MOST.

    `JUDGMENT_SERVICE_RECORDED` is written for a service that did NOT take effect as well as
    for one that did, with the domain's refusal as the reason code — because the interesting
    question about a file is not how many notices were sent but how many were sent that do
    not count. A trail that recorded only the successful ones would make a defectively served
    judgment look like an unserved one.

    `APPEAL_PERIOD_COMPUTED` CARRIES THE ARITHMETIC: the article, the number of days, the
    date it started, the last day, and — when the last day moved off a weekend — the date it
    moved FROM and the weekday that pushed it. The period is a legal position the firm took,
    and three months later the only way to defend it is to be able to show what was computed,
    from what, on what authority.

    `EXECUTION_GATE_DENIED` is the refusal, and it is the sibling of `CDD_GATE_DENIED`: the
    firm cannot demonstrate it is considering enforcement properly if its trail never shows
    a matter being stopped.

    `APPEAL_FILED` records lateness as a fact (`filedLate`) rather than refusing the filing.
    Whether a late challenge is accepted is the court's decision; what this system owes the
    file is what the period was and by how much it was missed.
  */
  | 'JUDGMENT_RECORDED' | 'JUDGMENT_AMENDED' | 'JUDGMENT_SERVICE_RECORDED'
  | 'APPEAL_PERIOD_COMPUTED' | 'APPEAL_FILED' | 'EXECUTION_GATE_DENIED'
  | 'EXECUTION_STAYED' | 'EXECUTION_STAY_LIFTED'
  | 'COURT_CALENDAR_RECORDED' | 'COURT_CALENDAR_REMOVED'
  /*
    P0.5 · the privilege ring. A READ, recorded because the question asked in a
    disqualification motion is who read the firm's privileged material and when — the
    same reasoning as MATTER_VIEWED, one level down. Outcome 'denied' carries the ring's
    own reason, so the record separates a paralegal from a suspended lawyer.
  */
  | 'PRIVILEGED_READ'
  /* A deliberate exit from the ring: which of القاعدة الحادية والعشرون's four grounds,
     to whom, and on whose instruction. Written whether it succeeded or was refused. */
  | 'PRIVILEGE_RELEASED';

export interface AuditActor {
  /**
   * `firm_member` is distinct from `staff` on purpose: `staff` is the display
   * record a client sees, while `firm_member` is a membership with a resolved
   * permission set. An escalation review has to be able to tell them apart.
   */
  kind: 'client_user' | 'staff' | 'firm_member' | 'system' | 'anonymous' | 'webhook';
  userId?: string | null;
  clientId?: string | null;
  tenantId?: string | null;
}

export interface AuditInput {
  action: AuditAction;
  actor: AuditActor;
  resourceType?: string;
  resourceId?: string;
  outcome?: 'success' | 'denied' | 'failure' | 'error';
  reasonCode?: string;
  metadata?: Record<string, unknown>;
}

export interface RequestContextInfo {
  ipHash: string | null;
  ipCountry: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export function requestInfo(req: Request, trustProxy: boolean): RequestContextInfo {
  return {
    ipHash: ipHashFor(req, trustProxy),
    ipCountry: geoHint(req),
    userAgent: (req.header('user-agent') || '').slice(0, 400) || null,
    requestId: (req.id as string | undefined) ?? null,
  };
}

export class AuditLogger {
  constructor(private readonly repo: Repo) {}

  async write(input: AuditInput, ctx: RequestContextInfo): Promise<void> {
    try {
      await this.repo.audit({
        occurred_at: new Date().toISOString(),
        tenant_id: input.actor.tenantId ?? null,
        actor_kind: input.actor.kind,
        actor_user_id: input.actor.userId ?? null,
        actor_client_id: input.actor.clientId ?? null,
        action: input.action,
        resource_type: input.resourceType ?? null,
        resource_id: input.resourceId ?? null,
        outcome: input.outcome ?? 'success',
        reason_code: input.reasonCode ?? null,
        ip_hash: ctx.ipHash,
        ip_country: ctx.ipCountry,
        user_agent: ctx.userAgent,
        request_id: ctx.requestId,
        metadata: input.metadata ?? {},
      });
    } catch (err) {
      // Audit is append-only and must not become a data-exfiltration channel,
      // so the failure detail goes to the server log only.
      console.error('[audit] failed to write event', input.action, err instanceof Error ? err.message : err);
      throw err;
    }
  }

  /** Best-effort variant for high-volume, non-critical events. */
  async tryWrite(input: AuditInput, ctx: RequestContextInfo): Promise<void> {
    try {
      await this.write(input, ctx);
    } catch {
      /* already logged */
    }
  }
}

/**
 * Convenience builder for the most security-relevant event in the system:
 * a denied authorization attempt. These are the rows a reviewer looks for.
 */
export function denial(
  action: AuditAction,
  actor: AuditActor,
  reasonCode: string,
  resource?: { type?: string; id?: string },
  metadata?: Record<string, unknown>,
): AuditInput {
  return {
    action,
    actor,
    outcome: 'denied',
    reasonCode,
    resourceType: resource?.type,
    resourceId: resource?.id,
    metadata,
  };
}

export { parseUserAgent };
