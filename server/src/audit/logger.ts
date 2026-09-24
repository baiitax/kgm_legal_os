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
  | 'SESSION_REVOKED' | 'ACCOUNT_LOCKED' | 'RATE_LIMITED'
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
  | 'ESCALATION_ATTEMPT' | 'ADMIN_MUTATION';

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
