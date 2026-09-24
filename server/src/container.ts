/**
 * Composition root. Everything is constructed once and injected; no module
 * reaches for a global singleton, which keeps the security tests able to build
 * an isolated app against a throwaway in-memory database.
 */
import { getDb } from './db/index.js';
import { Repo } from './db/repo.js';
import { FirmRepo } from './db/firm-repo.js';
import { PermissionEngine, type PermissionDenial } from './domain/permissions.js';
import { FirmSessionManager } from './auth/firm-session.js';
import { FirmAuthService } from './auth/firm-auth.js';
import type { Db } from './db/types.js';
import { SessionManager } from './auth/session.js';
import { AuditLogger } from './audit/logger.js';
import { AuthService } from './auth/service.js';
import { ClientService } from './domain/client-service.js';
import { getStorage } from './storage/service.js';
import type { StorageDriver } from './storage/service.js';
import { PaymentService } from './domain/payment-service.js';

export interface Container {
  db: Db;
  repo: Repo;
  sessions: SessionManager;
  audit: AuditLogger;
  auth: AuthService;
  clients: ClientService;
  payments: PaymentService;
  storage: StorageDriver;
  trustProxy: boolean;

  /**
   * Firm OS (§6). A separate repository, a separate session manager and a
   * separate authorization engine. Nothing here is reachable from a client
   * handler, and nothing in the portal is reachable from a firm handler except
   * the append-only audit log — which is shared precisely so that both
   * audiences' refusals land in one reviewable trail.
   */
  firm: FirmRepo;
  permissions: PermissionEngine;
  firmSessions: FirmSessionManager;
  firmAuth: FirmAuthService;
}

export function createContainer(overrides: {
  db?: Db;
  storage?: StorageDriver;
  trustProxy?: boolean;
} = {}): Container {
  const db = overrides.db ?? getDb();
  const storage = overrides.storage ?? getStorage();
  const repo = new Repo(db);
  const audit = new AuditLogger(repo);
  const sessions = new SessionManager(repo);
  const auth = new AuthService(repo, sessions, audit);
  const clients = new ClientService({ repo, sessions, audit, storage });
  const payments = new PaymentService({ repo, audit, storage });

  // ---- Firm OS ------------------------------------------------------------
  const firm = new FirmRepo(db);
  // Refusals are audited by the engine itself rather than by each handler, so a
  // forgotten audit call in a new route cannot silently drop an escalation
  // attempt (§49). Request context is not available here, so the sink records
  // the membership and the reason; the route layer adds IP/UA when it has them.
  const permissions = new PermissionEngine({
    firm,
    onDenial: (d: PermissionDenial) =>
      audit.tryWrite(
        {
          action: denialAction(d.reason),
          actor: {
            kind: 'firm_member',
            userId: d.principal.userId,
            tenantId: d.principal.tenantId,
          },
          outcome: 'denied',
          reasonCode: d.permission ? `${d.reason}:${d.permission}` : d.reason,
          resourceType: d.resourceType,
          resourceId: d.resourceId ?? undefined,
          metadata: { membershipId: d.principal.membershipId, ...(d.detail ?? {}) },
        },
        // No request context at construction time; the fields are nullable.
        { ipHash: null, ipCountry: null, userAgent: null, requestId: null },
      ),
  });
  const firmSessions = new FirmSessionManager(firm, permissions);
  const firmAuth = new FirmAuthService(firm, firmSessions, permissions, audit);

  return {
    db,
    repo,
    sessions,
    audit,
    auth,
    clients,
    payments,
    storage,
    trustProxy: overrides.trustProxy ?? Boolean(process.env.TRUST_PROXY),
    firm,
    permissions,
    firmSessions,
    firmAuth,
  };
}

/**
 * Maps an engine refusal reason onto an audit action.
 *
 * Kept as an explicit switch rather than a template string: the audit vocabulary
 * is a contract with whoever reads the log, and an unbounded reason would let a
 * new denial silently invent a new action name.
 */
function denialAction(reason: string):
  | 'PERMISSION_DENIED' | 'MATTER_SCOPE_DENIED' | 'CEILING_EXCEEDED' | 'ESCALATION_ATTEMPT' {
  switch (reason) {
    case 'matter_not_visible':
    case 'matter_level_insufficient':
    case 'matter_not_found':
      return 'MATTER_SCOPE_DENIED';
    case 'ceiling_exceeded':
    case 'ceiling_not_set':
    case 'invalid_amount':
      return 'CEILING_EXCEEDED';
    case 'cross_audience':
    case 'mfa_required':
      return 'ESCALATION_ATTEMPT';
    default:
      return 'PERMISSION_DENIED';
  }
}
