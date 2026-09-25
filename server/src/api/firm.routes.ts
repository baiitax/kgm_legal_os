/**
 * FIRM OS API (§7-§17, §27, §38, §49-§52, §72-§73)
 *
 * Mounted at `/api/firm`. The portal is mounted at `/api/client`. They share a
 * process, a database and an audit log, and nothing else.
 *
 * THE SHAPE OF EVERY HANDLER HERE
 *   1. parse and STRICTLY validate the body — unknown keys are a tamper attempt
 *      and are audited as one, not silently dropped
 *   2. `requireFirmSession` has already resolved the principal from the cookie
 *   3. assert the PERMISSION for the action
 *   4. assert the MATTER ACCESS LEVEL when the action is matter-scoped
 *   5. assert the NUMERIC CEILING when the action moves money
 *   6. mutate and audit in one transaction
 *
 *   Steps 3-5 are never inferred from the URL, never from the body, and never
 *   from a role name in the request. The principal was resolved server-side from
 *   a session cookie and re-derived from the database on this very request.
 *
 * WHY 404 AND NOT 403 FOR A MATTER YOU MAY NOT SEE
 *   A 403 confirms the matter exists. §72 asks us to assume the caller is
 *   probing, so "not yours" and "not real" answer identically. The difference is
 *   recorded in the audit row, where the reviewer can see it.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../container.js';
import { config } from '../config.js';
import { ok } from '../lib/http.js';
import { badRequest, conflict, forbidden, notFoundOrForbidden } from '../lib/errors.js';
import { normalizeArabicName, normalizeIdentifier } from '../domain/arabic-names.js';
import { evaluateConflicts } from '../domain/conflict-engine.js';
import { keyedHash, maskNationalId } from '../lib/crypto.js';
import { ah } from '../auth/middleware.js';
import { requestInfo } from '../audit/logger.js';
import {
  attachFirmPrincipal, requireFirm, firmCsrfGuard, ensureFirmCsrf, requireFirmMfa,
} from '../auth/firm-middleware.js';
import {
  MATTER_READ, MATTER_WRITE, MATTER_MANAGE, MATTER_FINANCIAL, ACCESS_LEVELS,
  type AccessLevel,
} from '../domain/permissions.js';
import { projectMatter, projectMatterList } from '../domain/classification.js';
import {
  GENESIS_PIH, buildInvoiceXml, buildQrPayload, invoiceHash, reconcileInvoice,
  reportingDeadline, supplyTimestamp,
} from '../domain/zatca.js';
import { newId } from '../lib/crypto.js';

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const passwordSchema = z.string().min(1).max(1000);

/**
 * Strict body parsing for the firm audience.
 *
 * `.strict()` makes an unexpected key a validation error rather than a silently
 * ignored field. That matters more here than in the portal: a firm request body
 * is where someone would try `{"role":"MANAGING_PARTNER"}` or
 * `{"tenantId":"..."}`, and the attempt should be recorded even though the
 * handler would never have read it.
 */
/**
 * Money is compared on the rounded cent, exactly as `round2` in the repository and the
 * `numeric(14,2)` columns do. A route that rounds differently from the trigger would
 * produce refusals nobody can reproduce.
 */
function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** A row value as a string, or null — never the string 'null'. */
function toStrOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

function strictBody<T extends z.ZodTypeAny>(schema: T, req: { body: unknown }, c: Container, path: string) {
  const parsed = schema.safeParse(req.body);
  if (parsed.success) return parsed.data as z.infer<T>;
  const unknownKeys = parsed.error.issues
    .filter((i) => i.code === 'unrecognized_keys')
    .flatMap((i) => (i as unknown as { keys: string[] }).keys ?? []);
  if (unknownKeys.length) {
    void c.audit.tryWrite({
      action: 'FIELD_TAMPER_ATTEMPT',
      actor: req.body && typeof req.body === 'object'
        ? { kind: 'firm_member' as const }
        : { kind: 'anonymous' as const },
      outcome: 'denied',
      reasonCode: 'unrecognized_keys',
      resourceType: 'route',
      resourceId: path.slice(0, 200),
      metadata: { keys: unknownKeys.slice(0, 20) },
    }, { ipHash: null, ipCountry: null, userAgent: null, requestId: null });
  }
  throw badRequest('validation_failed', 'invalid request', {
    fields: parsed.error.issues.map((i) => i.path.join('.') || '(body)').slice(0, 20),
  });
}

export function firmRouter(c: Container): Router {
  const r = Router();

  // Every /api/firm request resolves the firm session first. The gate that
  // decides what an unauthenticated or client-authenticated caller sees is
  // `requireFirm`, mounted per-route below.
  r.use(attachFirmPrincipal(c));

  /** The resolved principal, or a throw. Every guarded handler starts here. */
  const principal = (req: { firm?: { principal: import('../domain/permissions.js').FirmPrincipal } }) => {
    if (!req.firm) throw forbidden('forbidden', 'firm authentication required');
    return req.firm.principal;
  };

  // ==========================================================================
  // AUTH — the only endpoints that answer without a firm session
  // ==========================================================================

  r.get('/auth/health', (_req, res) => {
    // Reveals that the product exists and nothing about who uses it.
    ok(res, { status: 'ok', audience: 'firm', env: config.env });
  });

  r.get('/auth/csrf', ensureFirmCsrf, (_req, res) => {
    ok(res, { issued: true });
  });

  r.post('/auth/csrf', ensureFirmCsrf, (_req, res) => {
    ok(res, { issued: true });
  });

  r.post(
    '/auth/login',
    ensureFirmCsrf,
    firmCsrfGuard({ acceptAnonymous: true }),
    ah(async (req, res) => {
      const body = strictBody(
        z.object({
          email: emailSchema,
          password: passwordSchema,
          remember: z.boolean().optional().default(false),
        }).strict(),
        req, c, '/api/firm/auth/login',
      );

      const result = await c.firmAuth.login(req, res, requestInfo(req, c.trustProxy), body);

      if (result.kind === 'mfa_required') {
        return ok(res, {
          step: 'mfa',
          method: result.method,
          maskedDestination: result.maskedDestination,
          expiresInMinutes: config.auth.otpTtlMinutes,
        });
      }

      ok(res, { step: 'authenticated', csrfToken: result.csrfToken, ...sessionPayload(result.session) });
    }),
  );

  r.post(
    '/auth/mfa/verify',
    firmCsrfGuard({ acceptAnonymous: true }),
    ah(async (req, res) => {
      const body = strictBody(
        z.object({ code: z.string().trim().min(4).max(12), remember: z.boolean().optional().default(false) }).strict(),
        req, c, '/api/firm/auth/mfa/verify',
      );
      const result = await c.firmAuth.verifyMfa(req, res, requestInfo(req, c.trustProxy), body);
      if (result.kind === 'mfa_required') {
        return ok(res, { step: 'mfa', method: result.method, maskedDestination: result.maskedDestination });
      }
      ok(res, { step: 'authenticated', csrfToken: result.csrfToken, ...sessionPayload(result.session) });
    }),
  );

  r.post('/auth/logout', ah(async (req, res) => {
    await c.firmAuth.logout(req, res, requestInfo(req, c.trustProxy), req.firm ?? null);
    ok(res, { signedOut: true });
  }));

  // ==========================================================================
  // EVERYTHING BELOW REQUIRES A FIRM SESSION
  // ==========================================================================
  r.use(requireFirm(c));
  r.use(requireFirmMfa());

  // ---- session / identity --------------------------------------------------
  r.get('/session', ah(async (req, res) => {
    const s = req.firm!;
    const settings = await c.firm.getTenantSettings(s.principal.tenantId);
    const tenant = await c.firm.getTenant(s.principal.tenantId);
    ok(res, {
      ...sessionPayload(s),
      settings: settings ? {
        displayName: settings.displayName, displayNameAr: settings.displayNameAr,
        brandKey: settings.brandKey, timezone: settings.timezone, currency: settings.currency,
        vatRate: settings.vatRate, mfaRequired: settings.mfaRequired,
        sessionIdleMinutes: settings.sessionIdleMinutes,
      } : null,
      tenant: tenant ? { id: String(tenant.id), slug: String(tenant.slug), name: String(tenant.name) } : null,
    });
  }));

  r.post('/session/switch', firmCsrfGuard(), ah(async (req, res) => {
    const body = strictBody(
      z.object({ tenantId: z.string().uuid() }).strict(),
      req, c, '/api/firm/session/switch',
    );
    const result = await c.firmAuth.switchTenant(req, res, requestInfo(req, c.trustProxy), req.firm!, body);
    if (result.kind !== 'session') throw forbidden('forbidden', 'switch requires an established session');
    ok(res, { step: 'authenticated', csrfToken: result.csrfToken, ...sessionPayload(result.session) });
  }));

  r.get('/session/devices', ah(async (req, res) => {
    const rows = await c.firm.listFirmSessions(req.firm!.principal.membershipId);
    ok(res, {
      sessions: rows.map((s) => ({
        ...s,
        current: s.id === req.firm!.sessionId,
        // The raw IP hash is never returned; only the coarse country hint is.
        ipHash: undefined,
      })),
    });
  }));

  r.post('/session/revoke-all', firmCsrfGuard(), ah(async (req, res) => {
    const n = await c.firmSessions.revokeAll(req.firm!.principal.membershipId, 'user_request');
    await c.audit.tryWrite({
      action: 'FIRM_SESSION_REVOKED',
      actor: { kind: 'firm_member', userId: req.firm!.principal.userId, tenantId: req.firm!.principal.tenantId },
      resourceType: 'firm_session', outcome: 'success', reasonCode: 'revoke_all',
      metadata: { count: n, membershipId: req.firm!.principal.membershipId },
    }, requestInfo(req, c.trustProxy));
    c.firmSessions.clearCookies(res);
    ok(res, { revoked: n });
  }));

  // ---- matters (§17, §27) --------------------------------------------------
  r.get('/matters', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'matters.read', { type: 'matter_collection' });
    const matters = await c.permissions.listMatters(p);
    ok(res, {
      count: matters.length,
      scope: {
        practiceAreas: [...p.practiceAreas],
        firmWide: c.permissions.hasFirmWideScope(p),
      },
      // Each row is projected at ITS OWN access level (§57). A list is where a
      // leak is easiest to miss: the caller is entitled to most of it, so a
      // field that should be withheld on the two rows they merely have practice
      // scope over slides past review.
      matters: matters.map((m) => {
        const projected = projectMatterList<Record<string, unknown>>(
          m as unknown as Record<string, unknown>,
          { principal: p, accessLevel: m.accessLevel },
        );
        return {
          ...projected.data,
          // Authorization facts, not classified fields.
          restricted: m.isRestricted,
          accessLevel: m.accessLevel,
        };
      }),
    });
  }));

  /**
   * Matter detail, projected through the §57 classification registry.
   *
   * Two independent decisions happen here and it is worth keeping them visibly
   * separate:
   *
   *   1. `requireMatter` — may this member open this matter AT ALL? A refusal is
   *      a 404, indistinguishable from a matter that does not exist.
   *   2. `projectMatter` — having opened it, WHICH FIELDS may they read? A
   *      refusal is a withheld name, not an error.
   *
   * Conflating them is the bug this split prevents. A paralegal legitimately on
   * a matter team passes (1) with `operational` access, and must still not be
   * handed `internal_notes` or `risk_rating` — the matter is theirs to work, not
   * the firm's strategy to read.
   *
   * `withheld` is returned to the client as NAMES only, so the UI can render a
   * lock where a field was classified away instead of a blank the member cannot
   * interpret. Values never appear, and a name appears whether or not the column
   * held anything — otherwise the list becomes an oracle for "does this matter
   * have a risk rating?".
   */
  r.get('/matters/:id', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'matters.read', { type: 'matter', id: req.params.id });
    const { facts, level } = await c.permissions.requireMatter(p, String(req.params.id), MATTER_READ);

    const row = await c.firm.getMatterRow(p.tenantId, facts.matterId);
    if (!row) throw notFoundOrForbidden();

    const projected = projectMatter<Record<string, unknown>>(row, {
      principal: p,
      accessLevel: level,
    });

    /*
      MATTER_VIEWED · phase P-1.4

      The 69-action vocabulary held DOCUMENT_VIEWED, INVOICE_VIEWED, MESSAGE_READ
      and RECEIPT_VIEWED, and not this one — and because migration 0023 makes the
      union the database's contract, no call site could have written it.

      That absence is why this system cannot answer a disqualification motion. The
      question asked when a conflict surfaces late is not "was the screen clean in
      March" but "who here had actually seen that file, and when", because imputed
      knowledge attaches to the lawyer who read the matter regardless of any
      register. The firm could prove which PDFs were opened and could not prove
      who had looked at the case.

      Written with `tryWrite` — fire-and-forget, outside the request transaction —
      because a failure to record a READ must never fail the read itself. The
      asymmetry is deliberate and is the opposite of the rule for writes: a
      mutation whose audit is lost must fail, a read whose audit is lost must not.
      The consequence is a logged warning rather than a silent hole, which is the
      best available outcome once the decision to not block is made.

      `reasonCode` carries the ACCESS LEVEL rather than a refusal, so the log
      answers the follow-up question too: not just that they looked, but how much
      they were entitled to see when they did.
    */
    await c.audit.tryWrite({
      action: 'MATTER_VIEWED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      resourceType: 'matter', resourceId: facts.matterId, outcome: 'success',
      reasonCode: `access_level:${level}`,
      metadata: {
        membershipId: p.membershipId,
        matterNumber: facts.matterNumber,
        restricted: facts.isRestricted,
      },
    }, requestInfo(req, c.trustProxy));

    ok(res, {
      ...projected.data,
      // Authorization facts, not classified fields: the member needs to know
      // their own standing on the matter to understand why a field is withheld.
      accessLevel: level,
      restricted: facts.isRestricted,
      teamRole: facts.teamRole,
      department: facts.departmentCode,
      withheld: projected.withheld,
    });
  }));

  r.post('/matters/:id/restrict', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        restricted: z.boolean(),
        reason: z.string().trim().min(3).max(500).optional().nullable(),
        reasonAr: z.string().trim().min(3).max(500).optional().nullable(),
      }).strict(),
      req, c, '/api/firm/matters/:id/restrict',
    );

    const matterId = String(req.params.id);
    // Restricting a matter is a critical action: it needs the permission AND
    // 'full' access on the matter itself. A partner from another practice group
    // cannot lock a matter they cannot see.
    c.permissions.assertCan(p, 'matters.restrict', { type: 'matter', id: matterId });

    if (body.restricted) {
      await c.permissions.requireMatter(p, matterId, MATTER_MANAGE);
    } else {
      /*
        Lifting a restriction cannot require a level the restriction itself
        removed. See FirmPermissions.canLiftRestriction: the member who applied
        the restriction may reverse it, and anyone else must still reach 'full'
        through the normal precedence (an explicit grant).
      */
      const control = await c.firm.getRestrictionOwner(p.tenantId, matterId);
      const mine = control !== null
        && c.permissions.canLiftRestriction(p, control);
      if (!mine) {
        await c.permissions.requireMatter(p, matterId, MATTER_MANAGE);
      }
    }

    if (body.restricted && !body.reason) {
      throw badRequest('validation_failed', 'a restriction requires a recorded reason');
    }

    const changes = await c.firm.tx(async () => {
      const n = await c.firm.setMatterRestriction({
        tenantId: p.tenantId, matterId, restricted: body.restricted,
        reason: body.restricted ? (body.reason ?? null) : null,
        reasonAr: body.restricted ? (body.reasonAr ?? null) : null,
        actorMembershipId: p.membershipId,
      });
      await c.audit.write({
        action: body.restricted ? 'MATTER_RESTRICTED' : 'MATTER_UNRESTRICTED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'matter', resourceId: matterId, outcome: 'success',
        metadata: { membershipId: p.membershipId, reason: body.reason ?? null },
      }, requestInfo(req, c.trustProxy));
      return n;
    });

    if (!changes) throw notFoundOrForbidden('matter', matterId);
    ok(res, { id: matterId, restricted: body.restricted });
  }));

  r.post('/matters/:id/access', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        membershipId: z.string().uuid(),
        accessLevel: z.enum(ACCESS_LEVELS as unknown as [string, ...string[]]),
        reason: z.string().trim().min(3).max(500).optional().nullable(),
      }).strict(),
      req, c, '/api/firm/matters/:id/access',
    );

    const matterId = String(req.params.id);
    // Granting matter access is critical (§49): permission, plus 'full' on the
    // matter, plus the target must be a member of THIS tenant.
    c.permissions.assertCan(p, 'users.assign_matter', { type: 'matter', id: matterId });
    await c.permissions.requireMatter(p, matterId, MATTER_MANAGE);

    const target = await c.firm.getMembershipById(body.membershipId);
    if (!target || target.tenantId !== p.tenantId) {
      // Naming a membership from another firm is an escalation attempt.
      await c.audit.tryWrite({
        action: 'ESCALATION_ATTEMPT',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        outcome: 'denied', reasonCode: 'cross_tenant_matter_grant',
        resourceType: 'matter', resourceId: matterId,
        metadata: { membershipId: p.membershipId, target: body.membershipId },
      }, requestInfo(req, c.trustProxy));
      throw notFoundOrForbidden('member', body.membershipId);
    }

    /*
      THE ELIGIBILITY GATE · phase P-1.1

      A member may not be given work they are not entitled to perform. This is the
      first of the gates from the gap analysis: the system could previously grant
      matter access to a member whose licence was suspended, and recorded nothing
      about whether the question had even been asked.

      The check is on the TARGET, not the actor: an administrator delegating work
      is doing nothing wrong, and refusing them would send the message to the
      wrong person.

      REVOKING access is deliberately NOT gated. Removing a member from a matter
      is how a firm responds to a suspended licence, so requiring the licence to
      be valid in order to revoke it would make the remedy unavailable in exactly
      the case it exists for.
    */
    if (body.accessLevel !== 'none') {
      const eligibility = await c.firm.eligibilityFor(p.tenantId, body.membershipId);
      if (!eligibility.entitled) {
        await c.firm.recordEligibilityCheck({
          tenantId: p.tenantId,
          subjectKind: 'matter_assignment',
          subjectId: matterId,
          precondition: 'member_entitled_to_practise',
          outcome: 'fail',
          evidence: {
            targetMembershipId: body.membershipId,
            reason: eligibility.reason,
            requiresLicence: eligibility.requiresLicence,
            licences: eligibility.licences.map((l) => ({
              number: l.licenceNumber, status: l.status, expiresAt: l.expiresAt,
            })),
          },
          ruleCited: 'قواعد السلوك المهني — Rule 10 (no practice under suspension); نظام المحاماة',
          evaluatedByMembershipId: p.membershipId,
        });
        await c.audit.tryWrite({
          action: 'ELIGIBILITY_DENIED',
          actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
          outcome: 'denied', reasonCode: eligibility.reason,
          resourceType: 'matter', resourceId: matterId,
          metadata: { membershipId: p.membershipId, targetMembershipId: body.membershipId },
        }, requestInfo(req, c.trustProxy));
        // The same response a member of another tenant gets, so this cannot be
        // used to enumerate who holds a licence: §72's rule, applied here.
        throw notFoundOrForbidden('member', body.membershipId);
      }
    }

    await c.firm.tx(async () => {
      if (body.accessLevel === 'none') {
        await c.firm.revokeMatterAccess({ tenantId: p.tenantId, matterId, membershipId: body.membershipId });
      } else {
        await c.firm.grantMatterAccess({
          id: newId(), tenantId: p.tenantId, matterId,
          membershipId: body.membershipId, accessLevel: body.accessLevel,
          reason: body.reason ?? null, grantedByMembershipId: p.membershipId,
        });
      }
      await c.audit.write({
        action: body.accessLevel === 'none' ? 'MATTER_ACCESS_REVOKED' : 'MATTER_ACCESS_GRANTED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'matter', resourceId: matterId, outcome: 'success',
        metadata: {
          membershipId: p.membershipId, targetMembershipId: body.membershipId,
          accessLevel: body.accessLevel, reason: body.reason ?? null,
        },
      }, requestInfo(req, c.trustProxy));
    });

    ok(res, { id: matterId, membershipId: body.membershipId, accessLevel: body.accessLevel });
  }));

  // ---- billing (§38, §73) --------------------------------------------------
  r.post('/billing/invoices/:id/approve', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({ amount: z.number().finite().nonnegative().max(1e12) }).strict(),
      req, c, '/api/firm/billing/invoices/:id/approve',
    );

    const invoiceId = String(req.params.id);
    const invoice = await c.firm.getInvoiceForApproval(p.tenantId, invoiceId);
    if (!invoice) throw notFoundOrForbidden('invoice', invoiceId);

    // The amount that matters is the invoice's outstanding balance, NOT the
    // number in the body. The body amount is checked against it so that
    // understating the approval to slip under a ceiling is refused (§73).
    const outstanding = invoice.outstanding;
    if (Math.abs(body.amount - outstanding) > 0.005) {
      await c.audit.tryWrite({
        action: 'CEILING_EXCEEDED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        outcome: 'denied', reasonCode: 'amount_mismatch',
        resourceType: 'invoice', resourceId: invoiceId,
        metadata: { membershipId: p.membershipId, submitted: body.amount, outstanding },
      }, requestInfo(req, c.trustProxy));
      throw badRequest('validation_failed', 'submitted amount does not match the invoice balance');
    }

    // Permission first, then matter scope, then the numeric ceiling. All three,
    // in that order, every time.
    c.permissions.assertCan(p, 'billing.approve', { type: 'invoice', id: invoiceId });
    if (invoice.matterId) {
      await c.permissions.requireMatter(p, invoice.matterId, MATTER_FINANCIAL);
    }
    c.permissions.assertWithinAuthority(p, 'invoice', outstanding, { type: 'invoice', id: invoiceId });

    const changes = await c.firm.tx(async () => {
      const n = await c.firm.approveInvoice({
        tenantId: p.tenantId, invoiceId, approvedByStaff: p.staffId,
        expectedStatuses: ['draft', 'pending_internal_approval'],
      });
      if (n > 0) {
        await c.audit.write({
          action: 'ADMIN_MUTATION',
          actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
          resourceType: 'invoice', resourceId: invoiceId, outcome: 'success',
          reasonCode: 'billing.approve',
          metadata: { membershipId: p.membershipId, amount: outstanding, ceiling: p.ceilings.financialSar },
        }, requestInfo(req, c.trustProxy));
      }
      return n;
    });

    if (!changes) throw notFoundOrForbidden('invoice', invoiceId);
    ok(res, { id: invoiceId, status: 'approved', amount: outstanding });
  }));

  r.get('/billing/invoices', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCanAny(p, ['billing.read', 'billing.read_all'], { type: 'invoice_collection' });
    const matters = await c.permissions.listMatters(p);
    const visible = new Set(matters.filter((m) => MATTER_FINANCIAL.includes(m.accessLevel as AccessLevel)).map((m) => m.id));
    ok(res, {
      // The list is derived from the matter scope, not from a separate query:
      // one scope rule, applied everywhere, is the only way the two stay in step.
      count: visible.size,
      matterIds: [...visible],
    });
  }));

  // ---- parties and conflicts (§P0.1, migration 0029) ----------------------
  /*
    THE CONFLICT SURFACE

    Two things happen here and they are deliberately separated:

      · the ENGINE runs and produces findings — `POST /matters/:id/conflict-check`.
        It is deterministic, it cites the rule, and it decides nothing.
      · a HUMAN dispositions each finding and, where the rule allows it, records the
        written consent that cures it — `POST /conflicts/hits/:hitId/disposition`
        and `.../waiver`.

    The separation is the design. A conflict system that decided by itself would be
    either over-confident (clearing on a name resemblance) or useless (refusing
    everything and being turned off). This one produces what a competent paralegal
    would produce — a list of things that might be the same party and the rule that
    applies — and requires someone to sign off on each.

    Every negative here answers 404 rather than 403, for the §72 reason: a distinct
    status would confirm that a party, a matter or a finding exists.
  */

  r.get('/parties', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'clients.read', { type: 'party_collection' });
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    const parties = await c.firm.listParties(p.tenantId, { query });
    ok(res, { count: parties.length, parties });
  }));

  r.post('/parties', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        kind: z.enum(['individual', 'company', 'government', 'nonprofit', 'other']),
        name: z.string().trim().min(2).max(300),
        nameAr: z.string().trim().min(2).max(300).optional().nullable(),
        commercialRegistration: z.string().trim().max(40).optional().nullable(),
        vatNumber: z.string().trim().max(40).optional().nullable(),
        nationalId: z.string().trim().max(40).optional().nullable(),
        notes: z.string().trim().max(1000).optional().nullable(),
        /** Optional: link this party to an existing client record. */
        clientId: z.string().uuid().optional().nullable(),
      }).strict(),
      req, c, '/api/firm/parties',
    );

    c.permissions.assertCan(p, 'clients.create', { type: 'party_collection' });

    // The normalised form is derived here, once, by the module the engine also uses.
    const normalized = normalizeArabicName(
      [body.nameAr, body.name].filter(Boolean).join(' '));

    const id = newId();
    await c.firm.tx(async () => {
      await c.firm.createParty({
        id, tenantId: p.tenantId, kind: body.kind, name: body.name,
        nameAr: body.nameAr ?? null, normalized,
        commercialRegistration: normalizeIdentifier(body.commercialRegistration),
        vatNumber: normalizeIdentifier(body.vatNumber),
        // The plaintext national id never arrives and is never stored; the same
        // convention as `clients`, enforced by hashing here rather than by trusting
        // the caller to send a hash.
        // `keyedHash` and `maskNationalId` are the same pair the portal uses for a
        // client's identity: masked for display, keyed hash for verification, and
        // the plaintext never stored. A party's identifier is no less sensitive than
        // a client's — it is how the conflict engine decides identity.
        nationalIdMasked: maskNationalId(body.nationalId ?? null),
        nationalIdHash: body.nationalId ? keyedHash(body.nationalId.trim()) : null,
        notes: body.notes ?? null, createdByMembershipId: p.membershipId,
      });
      if (body.clientId) {
        const client = await c.firm.getClientForTenant(p.tenantId, body.clientId);
        if (!client) throw notFoundOrForbidden('client', body.clientId);
        await c.firm.linkClientParty({ tenantId: p.tenantId, clientId: body.clientId, partyId: id });
      }
      await c.audit.write({
        action: 'PARTY_CREATED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'party', resourceId: id, outcome: 'success',
        metadata: { membershipId: p.membershipId, kind: body.kind, hasRegistration: !!body.commercialRegistration },
      }, requestInfo(req, c.trustProxy));
    });

    ok(res, { id, name: body.name, normalized }, 201);
  }));

  /*
    Link an EXISTING client to an EXISTING party.

    `POST /parties` can create a party and link it to a client in one step, which is
    the intake path. It cannot help a firm that already has clients — and every firm
    this system will be sold to already has clients. Without this route the
    `clients.party_id` column added by migration 0029 is only ever populated at
    creation, so the conflict engine falls back to matching on the client's own name
    columns for the entire existing book of business, and the party register fills up
    with duplicates of companies the firm already recorded.

    This is a separate route rather than a parameter on `POST /parties` because it is
    a different act with a different authority: creating a party is `clients.create`,
    while asserting that an existing client IS that party changes what the conflict
    engine will find for a client the firm already has — `clients.update`.
  */
  r.post('/clients/:id/party', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({ partyId: z.string().uuid() }).strict(),
      req, c, '/api/firm/clients/:id/party',
    );

    c.permissions.assertCan(p, 'clients.update', { type: 'client', id: String(req.params.id) });

    const clientId = String(req.params.id);
    const client = await c.firm.getClientForTenant(p.tenantId, clientId);
    if (!client) throw notFoundOrForbidden('client', clientId);

    const party = await c.firm.getParty(p.tenantId, body.partyId);
    if (!party) throw notFoundOrForbidden('party', body.partyId);
    if (party.status !== 'active') {
      // A merged or archived party is not an identity a client can be given: the
      // engine would then match current work against a retired record.
      throw badRequest('party_not_active', 'not_active_party');
    }

    await c.firm.tx(async () => {
      await c.firm.linkClientParty({ tenantId: p.tenantId, clientId, partyId: body.partyId });
      await c.audit.write({
        action: 'PARTY_UPDATED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'client', resourceId: clientId, outcome: 'success',
        metadata: { membershipId: p.membershipId, linkedPartyId: body.partyId,
          // The previous link is recorded, because re-linking a client changes what
          // every future conflict check will find, and the question after a missed
          // conflict is always "when did that link change".
          previousPartyId: (client as { partyId?: string | null }).partyId ?? null },
      }, requestInfo(req, c.trustProxy));
    });

    ok(res, { clientId, partyId: body.partyId, name: party.name });
  }));

  r.post('/parties/:id/aliases', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        alias: z.string().trim().min(2).max(300),
        script: z.enum(['ar', 'en', 'other']).default('ar'),
        source: z.enum(['court_filing', 'najiz', 'commercial_registration', 'client_statement',
          'opposing_counsel', 'manual', 'other']).optional().nullable(),
        note: z.string().trim().max(300).optional().nullable(),
      }).strict(),
      req, c, '/api/firm/parties/:id/aliases',
    );

    c.permissions.assertCan(p, 'clients.update', { type: 'party_collection' });

    const partyId = String(req.params.id);
    const party = await c.firm.getParty(p.tenantId, partyId);
    if (!party) throw notFoundOrForbidden('party', partyId);

    await c.firm.tx(async () => {
      await c.firm.addPartyAlias({
        id: newId(), tenantId: p.tenantId, partyId, alias: body.alias,
        normalized: normalizeArabicName(body.alias), script: body.script,
        source: body.source ?? null, note: body.note ?? null,
      });
      await c.audit.write({
        action: 'PARTY_ALIAS_ADDED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'party', resourceId: partyId, outcome: 'success',
        // The alias itself is recorded: a match later disputed turns on which
        // spelling was known, and when.
        metadata: { membershipId: p.membershipId, alias: body.alias, source: body.source ?? null },
      }, requestInfo(req, c.trustProxy));
    });

    ok(res, { partyId, alias: body.alias });
  }));

  r.post('/parties/:id/affiliations', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        staffId: z.string().uuid(),
        relation: z.enum(['former_employer', 'current_employer', 'board_member',
          'shareholder', 'other_interest']),
        startedOn: z.string().date().optional().nullable(),
        endedOn: z.string().date().optional().nullable(),
        note: z.string().trim().max(500).optional().nullable(),
      }).strict(),
      req, c, '/api/firm/parties/:id/affiliations',
    );

    // A declared interest is a compliance record about a member of the firm, so it
    // needs the compliance permission and not merely the ability to edit clients.
    c.permissions.assertCan(p, 'compliance.create', { type: 'party_collection' });

    const partyId = String(req.params.id);
    const party = await c.firm.getParty(p.tenantId, partyId);
    if (!party) throw notFoundOrForbidden('party', partyId);

    await c.firm.tx(async () => {
      await c.firm.recordAffiliation({
        id: newId(), tenantId: p.tenantId, partyId, staffId: body.staffId,
        relation: body.relation, startedOn: body.startedOn ?? null,
        endedOn: body.endedOn ?? null, note: body.note ?? null,
        recordedByMembershipId: p.membershipId,
      });
      await c.audit.write({
        action: 'PARTY_AFFILIATION_RECORDED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'party', resourceId: partyId, outcome: 'success',
        metadata: { membershipId: p.membershipId, staffId: body.staffId, relation: body.relation },
      }, requestInfo(req, c.trustProxy));
    });

    ok(res, { partyId, relation: body.relation }, 201);
  }));

  r.get('/matters/:id/parties', ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'matters.read', { type: 'matter', id: matterId });
    await c.permissions.requireMatter(p, matterId, MATTER_READ);
    const parties = await c.firm.listMatterParties(p.tenantId, matterId);
    ok(res, { count: parties.length, parties });
  }));

  r.post('/matters/:id/parties', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        partyId: z.string().uuid(),
        role: z.enum(['counterparty', 'adverse_party', 'related_entity', 'guarantor',
          'witness', 'expert', 'interested_party', 'other']),
        note: z.string().trim().max(500).optional().nullable(),
        /** Create the party in the same call — the intake path, where the other side is a name and nothing else. */
        createIfMissing: z.object({
          kind: z.enum(['individual', 'company', 'government', 'nonprofit', 'other']),
          name: z.string().trim().min(2).max(300),
          nameAr: z.string().trim().min(2).max(300).optional().nullable(),
        }).strict().optional().nullable(),
      }).strict(),
      req, c, '/api/firm/matters/:id/parties',
    );

    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'matters.update', { type: 'matter', id: matterId });
    await c.permissions.requireMatter(p, matterId, MATTER_WRITE);

    let partyId = body.partyId;
    let created = false;

    await c.firm.tx(async () => {
      const existing = await c.firm.getParty(p.tenantId, partyId);
      if (!existing) {
        if (!body.createIfMissing) throw notFoundOrForbidden('party', partyId);
        const normalized = normalizeArabicName(
          [body.createIfMissing.nameAr, body.createIfMissing.name].filter(Boolean).join(' '));
        await c.firm.createParty({
          id: partyId, tenantId: p.tenantId, kind: body.createIfMissing.kind,
          name: body.createIfMissing.name, nameAr: body.createIfMissing.nameAr ?? null,
          normalized, commercialRegistration: null, vatNumber: null,
          nationalIdMasked: null, nationalIdHash: null, notes: null,
          createdByMembershipId: p.membershipId,
        });
        created = true;
        await c.audit.write({
          action: 'PARTY_CREATED',
          actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
          resourceType: 'party', resourceId: partyId, outcome: 'success',
          metadata: { membershipId: p.membershipId, kind: body.createIfMissing.kind, via: 'matter_intake' },
        }, requestInfo(req, c.trustProxy));
      }

      await c.firm.addMatterParty({
        id: newId(), tenantId: p.tenantId, matterId, partyId, role: body.role,
        note: body.note ?? null, addedByMembershipId: p.membershipId,
      });

      /*
        Adding a party INVALIDATES any clearance, and the message says so.

        The clearance belongs to the party set the check saw — that is what the
        database enforces and what `conflictStateFor` reports. Saying it here as well
        is not redundancy: a lawyer who adds a counterparty and then watches the
        matter refuse to advance needs to know that this is the reason, or the gate
        reads as a bug.
      */
      const state = await c.firm.conflictStateFor(p.tenantId, matterId);
      await c.audit.write({
        action: 'MATTER_PARTY_ADDED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'matter', resourceId: matterId, outcome: 'success',
        metadata: {
          membershipId: p.membershipId, partyId, role: body.role,
          conflictClearedAfterAdd: state.cleared,
        },
      }, requestInfo(req, c.trustProxy));
    });

    const state = await c.firm.conflictStateFor(p.tenantId, matterId);
    ok(res, {
      matterId, partyId, role: body.role, partyCreated: created,
      conflictCleared: state.cleared,
      note: state.cleared
        ? undefined
        : 'the matter now needs a conflict check covering this party before it can leave conflict_check.',
    }, 201);
  }));

  r.post('/matters/:id/conflict-check', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({ kind: z.enum(['intake', 'adverse_check', 'periodic', 'recheck']).default('intake') }).strict(),
      req, c, '/api/firm/matters/:id/conflict-check',
    );

    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'compliance.create', { type: 'matter', id: matterId });
    // A conflict check reads the whole firm's history, so the member must at least
    // be able to see the matter it is about. MATTER_READ and not MATTER_MANAGE:
    // running a check is diligence, not a change to the file.
    await c.permissions.requireMatter(p, matterId, MATTER_READ);

    const dataset = await c.firm.loadConflictDataset(p.tenantId, matterId);
    if (!dataset.matter) throw notFoundOrForbidden('matter', matterId);

    const clientId = String(dataset.matter.client_id);
    const client = await c.firm.clientIdentityForMatter(p.tenantId, clientId);
    if (!client) throw notFoundOrForbidden('client', clientId);

    const result = evaluateConflicts({
      matter: {
        id: matterId,
        matterNumber: String(dataset.matter.matter_number ?? ''),
        caseNumber: dataset.matter.case_number == null ? null : String(dataset.matter.case_number),
        clientId,
        clientIdentity: client.identity,
        // Real row id or null — never the synthetic matching label. See the note on
        // `clientIdentityForMatter`.
        clientPartyId: client.partyId,
      },
      parties: dataset.parties,
      priorAppearances: dataset.priorAppearances,
      clients: dataset.clients,
      affiliations: dataset.affiliations,
      clientMatters: dataset.clientMatters,
    });

    const checkId = newId();
    await c.firm.tx(async () => {
      await c.firm.createConflictCheck({
        id: checkId, tenantId: p.tenantId, matterId, kind: body.kind,
        startedByMembershipId: p.membershipId,
      });
      for (const finding of result.findings) {
        await c.firm.recordConflictHit({
          id: newId(), tenantId: p.tenantId, checkId, matterId, finding,
        });
      }
      await c.firm.updateCheckScope({
        checkId, tenantId: p.tenantId, partiesChecked: result.partiesChecked,
        mattersSearched: result.mattersSearched, hitsFound: result.findings.length,
      });
      await c.audit.write({
        action: 'CONFLICT_CHECK_RUN',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'matter', resourceId: matterId, outcome: 'success',
        metadata: {
          membershipId: p.membershipId, checkId, kind: body.kind,
          partiesChecked: result.partiesChecked, mattersSearched: result.mattersSearched,
          hitsFound: result.findings.length,
          warnings: result.warnings,
        },
      }, requestInfo(req, c.trustProxy));

      /*
        One audit row per finding, and it carries the RULE. The audit log is read
        after a dispute, and "a conflict check ran" answers none of the questions
        asked then — what it found, under which article, and whether it was a
        current client or a former one, are the questions.
      */
      for (const finding of result.findings) {
        await c.audit.tryWrite({
          action: 'CONFLICT_HIT',
          actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
          resourceType: 'matter', resourceId: matterId, outcome: 'success',
          reasonCode: finding.relation,
          metadata: {
            checkId, partyId: finding.partyId, matchedPartyId: finding.matchedPartyId,
            severity: finding.severity, matchStrength: finding.matchStrength,
            ruleCited: finding.ruleCited,
          },
        }, requestInfo(req, c.trustProxy));
      }
    });

    const hits = await c.firm.listConflictHits(p.tenantId, checkId);
    ok(res, {
      checkId,
      partiesChecked: result.partiesChecked,
      mattersSearched: result.mattersSearched,
      // The findings are returned WITH the rule and the window, not merely as a
      // count: the register is the product here, and a number would force the
      // lawyer to open a second screen to learn what it means.
      hits,
      warnings: result.warnings,
    }, 201);
  }));

  r.get('/matters/:id/conflicts', ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'compliance.read', { type: 'matter', id: matterId });
    await c.permissions.requireMatter(p, matterId, MATTER_READ);

    const checks = await c.firm.listConflictChecks(p.tenantId, matterId);
    const detailed = [];
    for (const check of checks) {
      detailed.push({
        ...check,
        hits: await c.firm.listConflictHits(p.tenantId, String(check.id)),
      });
    }
    ok(res, {
      matterId,
      state: await c.firm.conflictStateFor(p.tenantId, matterId),
      waivers: await c.firm.listConflictWaivers(p.tenantId, matterId),
      count: detailed.length,
      checks: detailed,
    });
  }));

  r.post('/conflicts/hits/:hitId/disposition', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        disposition: z.enum(['different_party', 'same_party']),
        /**
         * Severity is the CALLER's, not this handler's, because it is a legal
         * judgement on a confirmed identity — and it is validated against the
         * engine's own evidence below rather than trusted.
         */
        severity: z.enum(['actual', 'potential', 'none']).optional().nullable(),
        affectedPartyId: z.string().uuid().optional().nullable(),
        reason: z.string().trim().min(5).max(500),
      }).strict(),
      req, c, '/api/firm/conflicts/hits/:hitId/disposition',
    );

    const hitId = String(req.params.hitId);
    c.permissions.assertCan(p, 'compliance.review', { type: 'conflict_collection' });

    const hit = await c.firm.getConflictHit(p.tenantId, hitId);
    if (!hit) throw notFoundOrForbidden('finding', hitId);
    if (hit.disposition !== 'open') {
      // The database refuses this too; refusing it here as well produces a message
      // that says what to do instead of an opaque constraint violation.
      throw badRequest('already_dispositioned', 'this finding has already been dispositioned — run a new check');
    }
    await c.permissions.requireMatter(p, hit.matterId, MATTER_READ);

    if (body.disposition === 'same_party' && (!body.severity || !body.affectedPartyId)) {
      throw badRequest('validation_failed',
        'confirming a finding requires a severity and the party whose consent the rule requires');
    }
    if (body.disposition === 'different_party' && body.severity) {
      throw badRequest('validation_failed', 'a ruled-out finding carries no severity');
    }

    await c.firm.tx(async () => {
      await c.firm.dispositionConflictHit({
        tenantId: p.tenantId, hitId, disposition: body.disposition,
        severity: body.disposition === 'same_party' ? body.severity! : null,
        affectedPartyId: body.disposition === 'same_party' ? body.affectedPartyId! : null,
        reason: body.reason, membershipId: p.membershipId,
      });
      await c.audit.write({
        action: 'CONFLICT_DISPOSITION_RECORDED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'matter', resourceId: hit.matterId, outcome: 'success',
        metadata: {
          membershipId: p.membershipId, hitId, disposition: body.disposition,
          severity: body.severity ?? null, reason: body.reason,
        },
      }, requestInfo(req, c.trustProxy));
    });

    ok(res, { hitId, disposition: body.disposition });
  }));

  r.post('/conflicts/hits/:hitId/waiver', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        // Rule 8's exception is a WRITING. Either the document, or a reference that
        // identifies it in the firm's own records until firm-side documents exist.
        consentDocumentId: z.string().uuid().optional().nullable(),
        consentReference: z.string().trim().min(3).max(200).optional().nullable(),
        consentSignedOn: z.string().date(),
        scope: z.string().trim().min(10).max(1000),
      }).strict(),
      req, c, '/api/firm/conflicts/hits/:hitId/waiver',
    );

    const hitId = String(req.params.hitId);
    c.permissions.assertCan(p, 'compliance.review', { type: 'conflict_collection' });

    const hit = await c.firm.getConflictHit(p.tenantId, hitId);
    if (!hit) throw notFoundOrForbidden('finding', hitId);
    await c.permissions.requireMatter(p, hit.matterId, MATTER_READ);

    if (!body.consentDocumentId && !body.consentReference) {
      throw badRequest('written_consent_required',
        'القاعدة الثامنة requires written consent: attach the document or cite where it is held');
    }
    if (hit.disposition !== 'same_party') {
      throw badRequest('not_a_confirmed_conflict',
        'a waiver cures a confirmed conflict; this finding has not been confirmed as the same party');
    }
    if (!hit.affectedPartyId) {
      throw badRequest('no_affected_party', 'the finding names no affected party, so no consent can be matched to it');
    }

    const waiverId = newId();
    await c.firm.tx(async () => {
      await c.firm.recordConflictWaiver({
        id: waiverId, tenantId: p.tenantId, hitId, matterId: hit.matterId,
        // The affected party comes from the FINDING, never from the body. A caller
        // choosing who consented would defeat the rule; the database refuses a
        // mismatch too.
        waivedByPartyId: hit.affectedPartyId!,
        consentDocumentId: body.consentDocumentId ?? null,
        consentReference: body.consentReference ?? null,
        consentSignedOn: body.consentSignedOn, scope: body.scope,
        membershipId: p.membershipId,
      });
      await c.audit.write({
        action: 'CONFLICT_WAIVED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'matter', resourceId: hit.matterId, outcome: 'success',
        metadata: {
          membershipId: p.membershipId, hitId, waiverId,
          affectedPartyId: hit.affectedPartyId, affectedPartyName: hit.affectedPartyName,
          consentDocumentId: body.consentDocumentId ?? null,
          consentReference: body.consentReference ?? null,
          windowLiftsOn: hit.windowLiftsOn,
        },
      }, requestInfo(req, c.trustProxy));
    });

    ok(res, { waiverId, hitId, waivedByPartyId: hit.affectedPartyId }, 201);
  }));

  r.post('/matters/:id/conflict-conclusion', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        checkId: z.string().uuid(),
        decision: z.enum(['clear', 'not_accepted', 'abandoned']),
        conclusion: z.string().trim().min(5).max(1000),
      }).strict(),
      req, c, '/api/firm/matters/:id/conflict-conclusion',
    );

    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'compliance.review', { type: 'matter', id: matterId });
    await c.permissions.requireMatter(p, matterId, MATTER_MANAGE);

    const checks = await c.firm.listConflictChecks(p.tenantId, matterId);
    const check = checks.find((x) => String(x.id) === body.checkId);
    if (!check) throw notFoundOrForbidden('check', body.checkId);
    if (check.concluded_at != null) {
      /*
        A concluded check is EVIDENCE. The database refuses to let its status change,
        and this refuses the narrower hole the trigger leaves open: a second
        conclusion with the same status would re-stamp the date and replace the
        conclusion text, so the record would show the last thing written rather than
        the decision that was taken. A lawyer who wants a different answer runs a new
        check, which is also what a reviewer would want to see in the file.
      */
      throw badRequest('already_concluded',
        'this conflict check has been concluded — run a new check rather than restating the old one');
    }

    const hits = await c.firm.listConflictHits(p.tenantId, body.checkId);
    const open = hits.filter((h) => h.disposition === 'open').length;
    const unwaived = hits.filter(
      (h) => h.disposition === 'same_party' && h.severity !== 'none' && h.waiverCount === 0,
    ).length;

    if (body.decision === 'clear' && (open > 0 || unwaived > 0)) {
      /*
        The refusal names the obstacle rather than saying "not allowed". A lawyer who
        cannot see WHY the matter will not clear will work around the control, and
        this is the control the firm most needs them not to work around.
      */
      throw badRequest('conflicts_outstanding',
        open > 0
          ? `${open} finding(s) have not been dispositioned`
          : `${unwaived} confirmed conflict(s) have no written consent from the affected party`);
    }

    // Derived, one expression, in the repository — and the database refuses a
    // contradicting write, so this value is checked rather than trusted.
    const status = body.decision === 'clear'
      ? (hits.some((h) => h.disposition === 'same_party' && h.severity !== 'none')
        ? 'cleared_with_waiver' : 'clear')
      : (body.decision === 'not_accepted' ? 'conflicts_not_accepted' : 'abandoned');

    await c.firm.tx(async () => {
      await c.firm.concludeConflictCheck({
        tenantId: p.tenantId, checkId: body.checkId, status,
        conclusion: body.conclusion, membershipId: p.membershipId,
      });
      const state = await c.firm.conflictStateFor(p.tenantId, matterId);
      if (state.cleared) {
        await c.firm.setMatterConflictCleared({ tenantId: p.tenantId, matterId, cleared: true });
      }
      await c.audit.write({
        action: state.cleared ? 'CONFLICT_CLEARED' : 'CONFLICT_DECLINED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'matter', resourceId: matterId, outcome: 'success',
        metadata: {
          membershipId: p.membershipId, checkId: body.checkId, status,
          confirmedConflicts: hits.filter((h) => h.disposition === 'same_party' && h.severity !== 'none').length,
          exceptedByWindow: hits.filter((h) => h.disposition === 'same_party' && h.severity === 'none').length,
        },
      }, requestInfo(req, c.trustProxy));
    });

    ok(res, { matterId, checkId: body.checkId, status, cleared: status !== 'conflicts_not_accepted' && status !== 'abandoned' });
  }));

  // ---- the matter lifecycle, and the Rule 11 gate -------------------------
  /*
    Until now no route changed a matter's status, which meant `MatterTabs` showed a
    lifecycle nothing could move and the conflict gate guarded a door with no handle.
    The gate is only real if there is a way to walk through it.
  */
  r.post('/matters/:id/status', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        internalStatus: z.enum(['intake', 'conflict_check', 'restricted', 'internal_review',
          'partner_review', 'active', 'on_hold', 'judgment', 'execution', 'closed', 'archived']),
        reason: z.string().trim().max(500).optional().nullable(),
        /** Set only by the server from the derived state; a caller may not assert it. */
        conflictCleared: z.boolean().optional().nullable(),
      }).strict(),
      req, c, '/api/firm/matters/:id/status',
    );

    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'matters.status', { type: 'matter', id: matterId });
    const { facts } = await c.permissions.requireMatter(p, matterId, MATTER_MANAGE);

    const row = await c.firm.getMatterRow(p.tenantId, matterId);
    if (!row) throw notFoundOrForbidden('matter', matterId);
    const from = String(row.internal_status ?? '');

    /*
      `conflict_cleared` is DERIVED. A caller may send it, and it is refused by the
      database if it contradicts the record — but the server never propagates a
      caller's claim into the write. It recomputes and writes its own answer, so the
      column cannot be used to launder a clearance.
    */
    const state = await c.firm.conflictStateFor(p.tenantId, matterId);

    if (from === 'conflict_check' && body.internalStatus !== 'conflict_check'
        && body.internalStatus !== 'archived' && !state.cleared) {
      await c.audit.tryWrite({
        action: 'MATTER_SCOPE_DENIED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'matter', resourceId: matterId, outcome: 'denied',
        reasonCode: 'conflict_gate',
        metadata: { membershipId: p.membershipId, from, to: body.internalStatus, reasons: state.reasons },
      }, requestInfo(req, c.trustProxy));
      throw badRequest('conflict_gate',
        `Rule 11: this matter cannot leave conflict_check — ${state.reasons.join('; ')}`);
    }

    await c.firm.tx(async () => {
      await c.firm.setMatterStatus({
        tenantId: p.tenantId, matterId, internalStatus: body.internalStatus,
        conflictCleared: state.cleared,
      });
      await c.audit.write({
        action: 'MATTER_STATUS_CHANGED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'matter', resourceId: matterId, outcome: 'success',
        metadata: {
          membershipId: p.membershipId, from, to: body.internalStatus,
          reason: body.reason ?? null, conflictCleared: state.cleared,
          restricted: facts.isRestricted,
        },
      }, requestInfo(req, c.trustProxy));
    });

    ok(res, {
      id: matterId, internalStatus: body.internalStatus, previous: from,
      conflictCleared: state.cleared,
    });
  }));

  // ---- eligibility (§P-1.1 – P-1.3, migration 0027) -----------------------
  /*
    The eligibility register, readable.

    Permission is `compliance.licences` where it exists — the code has been in the
    catalogue since 0006 with no table behind it, granting two roles the authority
    to manage something that did not exist. This is what it now refers to.

    `users.read` is accepted as well, because a managing partner reviewing their
    own firm's standing is doing administration, not compliance, and requiring a
    second grant to answer "who here may still practise" would make the register
    one nobody looks at. The two are not additive in any other direction: neither
    one widens what matters a member can reach.
  */
  r.get('/eligibility', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCanAny(p, ['compliance.licences', 'users.read'], { type: 'member_collection' });

    const members = await c.firm.listMembers(p.tenantId);
    const rows = await Promise.all(members.map(async (m) => {
      const eligibility = await c.firm.eligibilityFor(p.tenantId, m.membershipId);
      const prior = await c.firm.priorOfficeBar(p.tenantId, m.membershipId);
      return {
        membershipId: m.membershipId,
        displayName: m.displayName,
        displayNameAr: m.displayNameAr,
        email: m.email,
        status: m.status,
        requiresLicence: eligibility.requiresLicence,
        entitled: eligibility.entitled,
        reason: eligibility.reason,
        licences: eligibility.licences,
        priorOffice: {
          barred: prior.barred,
          restrictionEndsOn: prior.restrictionEndsOn,
          stillInPost: prior.stillInPost,
          // The institution is named only where a bar is live. Reporting it
          // unconditionally would turn this endpoint into a searchable list of
          // where every colleague used to work, which is not what a licence
          // register is for.
          institution: prior.barred ? prior.institution : null,
        },
      };
    }));

    ok(res, {
      count: rows.length,
      // The headline number a managing partner is looking for, computed rather
      // than left to the client: a UI that recounts this is a second definition
      // of "may practise" and the two will disagree eventually.
      notEntitled: rows.filter((r) => !r.entitled).length,
      barredByPriorOffice: rows.filter((r) => r.priorOffice.barred).length,
      members: rows,
    });
  }));

  r.get('/eligibility/me', ah(async (req, res) => {
    const p = principal(req);
    // Own standing: no permission beyond an authenticated session. A member must
    // always be able to find out why they were refused work.
    const eligibility = await c.firm.eligibilityFor(p.tenantId, p.membershipId);
    const prior = await c.firm.priorOfficeBar(p.tenantId, p.membershipId);
    ok(res, {
      membershipId: p.membershipId,
      requiresLicence: eligibility.requiresLicence,
      entitled: eligibility.entitled,
      reason: eligibility.reason,
      licences: eligibility.licences,
      priorOffice: {
        barred: prior.barred,
        restrictionEndsOn: prior.restrictionEndsOn,
        stillInPost: prior.stillInPost,
        institution: prior.institution,
      },
    });
  }));

  r.post('/eligibility/:membershipId/licences', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        licenceNumber: z.string().trim().min(3).max(60),
        issuedAt: z.string().date().optional().nullable(),
        expiresAt: z.string().date().optional().nullable(),
        status: z.enum(['valid', 'suspended', 'expired', 'revoked', 'pending']).default('valid'),
        statusReference: z.string().trim().max(200).optional().nullable(),
      }).strict(),
      req, c, '/api/firm/eligibility/:membershipId/licences',
    );

    c.permissions.assertCanAny(p, ['compliance.licences', 'users.read'], { type: 'member_collection' });

    const target = await c.firm.getMembershipById(String(req.params.membershipId));
    if (!target || target.tenantId !== p.tenantId) {
      await c.audit.tryWrite({
        action: 'ESCALATION_ATTEMPT',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        outcome: 'denied', reasonCode: 'cross_tenant_licence_write',
        resourceType: 'membership', resourceId: String(req.params.membershipId),
        metadata: { membershipId: p.membershipId },
      }, requestInfo(req, c.trustProxy));
      throw notFoundOrForbidden('member', String(req.params.membershipId));
    }

    // A licence number may not be recorded twice for the same person: a renewal is
    // a new number or an UPDATE of the expiry, and silently accepting a duplicate
    // would create two rows whose agreement nothing checks.
    const existing = await c.firm.listLicences(p.tenantId, target.staffId);
    const clash = existing.find((l) => l.licenceNumber === body.licenceNumber);

    await c.firm.tx(async () => {
      await c.firm.upsertLicence({
        tenantId: p.tenantId,
        staffId: target.staffId,
        licenceNumber: body.licenceNumber,
        issuedAt: body.issuedAt ?? null,
        expiresAt: body.expiresAt ?? null,
        status: body.status,
        statusReference: body.statusReference ?? null,
        verifiedByMembershipId: p.membershipId,
      });
      await c.audit.write({
        action: clash ? 'LICENCE_STATUS_CHANGED' : 'LICENCE_RECORDED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'staff', resourceId: target.staffId, outcome: 'success',
        metadata: {
          membershipId: p.membershipId, licenceNumber: body.licenceNumber,
          status: body.status, previousStatus: clash?.status ?? null,
        },
      }, requestInfo(req, c.trustProxy));
    });

    const eligibility = await c.firm.eligibilityFor(p.tenantId, target.id);
    ok(res, { licenceNumber: body.licenceNumber, status: body.status, eligibility });
  }));

  r.post('/eligibility/:membershipId/prior-office', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        officeKind: z.enum(['judiciary', 'public_prosecution', 'bog', 'committee',
          'government_body', 'court_administration', 'foreign_judiciary']),
        institution: z.string().trim().min(2).max(200),
        institutionAr: z.string().trim().max(200).optional().nullable(),
        roleTitle: z.string().trim().max(120).optional().nullable(),
        startedOn: z.string().date(),
        endedOn: z.string().date().optional().nullable(),
      }).strict(),
      req, c, '/api/firm/eligibility/:membershipId/prior-office',
    );

    c.permissions.assertCanAny(p, ['compliance.licences', 'users.read'], { type: 'member_collection' });

    const target = await c.firm.getMembershipById(String(req.params.membershipId));
    if (!target || target.tenantId !== p.tenantId) {
      throw notFoundOrForbidden('member', String(req.params.membershipId));
    }
    if (body.endedOn && body.endedOn < body.startedOn) {
      throw badRequest('validation_failed', 'endedOn cannot precede startedOn');
    }

    await c.firm.tx(async () => {
      await c.firm.recordPriorOffice({
        id: newId(), tenantId: p.tenantId, staffId: target.staffId,
        officeKind: body.officeKind, institution: body.institution,
        institutionAr: body.institutionAr ?? null,
        roleTitle: body.roleTitle ?? null, roleTitleAr: null,
        startedOn: body.startedOn, endedOn: body.endedOn ?? null,
      });
      await c.audit.write({
        action: 'PRIOR_OFFICE_RECORDED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'staff', resourceId: target.staffId, outcome: 'success',
        metadata: {
          membershipId: p.membershipId, officeKind: body.officeKind,
          // The institution is recorded in the audit because the audit is
          // privileged and the endpoint's list view is not; a reviewer needs to
          // know which body, and a colleague browsing the register does not.
          institution: body.institution,
          endedOn: body.endedOn ?? null,
        },
      }, requestInfo(req, c.trustProxy));
    });

    ok(res, await c.firm.priorOfficeBar(p.tenantId, target.id));
  }));

  // ---- administration (§49, §50) -------------------------------------------
  r.get('/admin/members', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'users.read', { type: 'member_collection' });
    const members = await c.firm.listMembers(p.tenantId);
    const roles = await c.firm.getRolesForTenant(p.tenantId);
    ok(res, { count: members.length, members, roles });
  }));

  r.post('/admin/members/:membershipId/status', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({ status: z.enum(['active', 'suspended', 'deactivated', 'left']) }).strict(),
      req, c, '/api/firm/admin/members/:membershipId/status',
    );

    const targetId = String(req.params.membershipId);
    // Critical permission: gated on MFA as well when the tenant requires it.
    c.permissions.assertCan(p, 'users.deactivate', { type: 'member', id: targetId });
    const settings = await c.firm.getTenantSettings(p.tenantId);
    c.permissions.assertMfaForCritical(p, 'users.deactivate', settings?.mfaRequired ?? false);

    const target = await c.firm.getMembershipById(targetId);
    if (!target || target.tenantId !== p.tenantId) throw notFoundOrForbidden('member', targetId);

    // Self-demotion guard: an admin must not be able to lock themselves out mid
    // request, and must not be able to suspend the only Managing Partner.
    if (targetId === p.membershipId) {
      throw forbidden('forbidden', 'you cannot change your own membership status');
    }

    const changes = await c.firm.tx(async () => {
      const n = await c.firm.setMembershipStatus({
        tenantId: p.tenantId, membershipId: targetId, status: body.status,
      });
      if (n > 0 && body.status !== 'active') {
        // A suspended member's live sessions die with the change. Without this,
        // the authorization graph would say "suspended" while a browser tab kept
        // working until its session expired.
        await c.firmSessions.revokeAll(targetId, `status_${body.status}`);
      }
      await c.audit.write({
        action: 'ADMIN_MUTATION',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'firm_membership', resourceId: targetId, outcome: 'success',
        reasonCode: 'users.deactivate',
        metadata: { membershipId: p.membershipId, status: body.status },
      }, requestInfo(req, c.trustProxy));
      return n;
    });

    if (!changes) throw notFoundOrForbidden('member', targetId);
    ok(res, { membershipId: targetId, status: body.status });
  }));

  r.post('/admin/members/:membershipId/roles', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({ roleCode: z.string().trim().min(2).max(64), revoke: z.boolean().optional().default(false) }).strict(),
      req, c, '/api/firm/admin/members/:membershipId/roles',
    );

    const targetId = String(req.params.membershipId);
    // THE privilege-escalation endpoint. Permission + MFA + same-tenant target +
    // the role must exist in THIS tenant. Nothing about the caller's own roles
    // is taken from the request.
    c.permissions.assertCan(p, 'users.assign_role', { type: 'member', id: targetId });
    const settings = await c.firm.getTenantSettings(p.tenantId);
    c.permissions.assertMfaForCritical(p, 'users.assign_role', settings?.mfaRequired ?? false);

    const target = await c.firm.getMembershipById(targetId);
    if (!target || target.tenantId !== p.tenantId) throw notFoundOrForbidden('member', targetId);

    const roles = await c.firm.getRolesForTenant(p.tenantId);
    const role = roles.find((x) => x.code === body.roleCode.toUpperCase());
    if (!role || !role.isActive) throw notFoundOrForbidden('role', body.roleCode);

    await c.firm.tx(async () => {
      if (body.revoke) {
        await c.firm.revokeRole({ membershipId: targetId, roleId: role.id });
      } else {
        await c.firm.grantRole({
          membershipId: targetId, roleId: role.id, grantedByMembershipId: p.membershipId,
        });
      }
      // A role change invalidates the cached authority of any live session.
      await c.firmSessions.revokeAll(targetId, body.revoke ? 'role_revoked' : 'role_granted');
      await c.audit.write({
        action: body.revoke ? 'ROLE_REVOKED' : 'ROLE_GRANTED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'firm_membership', resourceId: targetId, outcome: 'success',
        reasonCode: 'users.assign_role',
        metadata: { membershipId: p.membershipId, roleCode: role.code, revoke: body.revoke },
      }, requestInfo(req, c.trustProxy));
    });

    ok(res, { membershipId: targetId, roleCode: role.code, revoked: body.revoke });
  }));

  r.get('/admin/audit', ah(async (req, res) => {
    const p = principal(req);
    // Audit search is itself a privilege. The endpoint exists for holders of
    // audit.read and 404s for everyone else, so a paralegal cannot confirm that
    // a log search is even available.
    if (!c.permissions.can(p, 'audit.read')) throw notFoundOrForbidden('resource');
    const rows = await c.firm.searchAudit({
      tenantId: p.tenantId,
      action: typeof req.query.action === 'string' ? req.query.action.slice(0, 64) : null,
      limit: Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500),
    });
    ok(res, { count: rows.length, events: rows });
  }));

  r.get('/admin/settings', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCanAny(p, ['settings.read', 'settings.manage'], { type: 'tenant_settings' });
    const settings = await c.firm.getTenantSettings(p.tenantId);
    if (!settings) throw notFoundOrForbidden('settings');
    ok(res, settings);
  }));


  /* ══════════════════════════════════════════════════════════════════════════
   * P0.2 · THE FISCAL DOCUMENT
   *
   * One route here carries the whole phase: `POST /billing/invoices/:id/issue`.
   * Everything else is either configuration (the identity and the device) or the
   * record of what ZATCA said (the submissions).
   * ══════════════════════════════════════════════════════════════════════════ */

  r.get('/billing/fiscal-identity', ah(async (req, res) => {
    const p = principal(req);
    // The identity is a firm-level compliance record. Reading it needs billing.read;
    // changing it needs settings.manage, which only the managing partner carries — a
    // practising lawyer has no business editing the firm's VAT registration number.
    c.permissions.assertCanAny(p, ['billing.read', 'billing.read_all', 'settings.read'], { type: 'fiscal_identity' });
    const [identity, devices, ready] = await Promise.all([
      c.firm.fiscalIdentityFor(p.tenantId),
      c.firm.listFiscalDevices(p.tenantId),
      c.firm.fiscalReady(p.tenantId),
    ]);
    ok(res, {
      identity: identity ?? null,
      devices: devices.map((d) => ({
        id: String(d.id),
        label: String(d.device_label),
        serial: String(d.device_serial),
        counterValue: Number(d.invoice_counter_value),
        // Never the hash itself in a list: the chain head is a value an auditor asks
        // for by invoice, not a value to spray across a dashboard.
        hasChainHead: d.last_invoice_hash !== null,
        isActive: Boolean(d.is_active),
      })),
      ready,
      /*
        `ready: false` is reported WITH ITS REASON and not as an error. A firm that has
        not integrated yet is not broken; it is a firm that cannot legally send a tax
        invoice, and the screen has to say which of the conditions is missing.
      */
      blockers: ready ? [] : [
        ...(identity ? [] : ['no_fiscal_identity']),
        ...(identity && identity.onboarding_status !== 'production_csid' ? ['onboarding_incomplete'] : []),
        ...(devices.some((d) => d.is_active) ? [] : ['no_active_device']),
      ],
    });
  }));

  r.post('/billing/fiscal-identity', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'settings.manage', { type: 'fiscal_identity' });
    const body = strictBody(
      z.object({
      registeredName: z.string().trim().min(2).max(200),
      registeredNameAr: z.string().trim().max(200).nullable().optional(),
      // The shape is checked here as well as by the CHECK, so the refusal is a 400
      // with a message rather than a 500 from the driver.
      vatRegistrationNumber: z.string().trim().regex(/^3[0-9]{13}3$/,
        'a Saudi VAT registration is 15 digits beginning and ending with 3'),
      commercialRegistration: z.string().trim().min(6).max(30),
      registeredAddress: z.string().trim().min(5).max(500),
      registeredAddressAr: z.string().trim().max(500).nullable().optional(),
      city: z.string().trim().max(100).nullable().optional(),
      postalCode: z.string().trim().max(20).nullable().optional(),
      country: z.string().trim().length(2).default('SA'),
      environment: z.enum(['sandbox', 'simulation', 'production']),
      onboardingStatus: z.enum(['not_started', 'csr_generated', 'compliance_csid',
        'compliance_passed', 'production_csid', 'failed']),
      certificateExpiresAt: z.string().datetime().nullable().optional(),
    }).strict(),
      req, c, '/billing/fiscal-identity',
    );

    const id = await c.firm.upsertFiscalIdentity({ tenantId: p.tenantId, ...body });
    await c.audit.tryWrite({
      action: 'FISCAL_IDENTITY_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success',
      resourceType: 'fiscal_identity', resourceId: id,
      // The VAT number is NOT in the metadata. It is a public identifier, but an audit
      // log is not a data store, and the row that says "the identity changed" does not
      // need to carry the identifier it changed to.
      metadata: { environment: body.environment, onboarding: body.onboardingStatus },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id });
  }));

  r.post('/billing/fiscal-devices', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'settings.manage', { type: 'fiscal_device' });
    const body = strictBody(
      z.object({
      deviceLabel: z.string().trim().min(2).max(120),
      deviceSerial: z.string().trim().min(2).max(120),
    }).strict(),
      req, c, '/billing/fiscal-devices',
    );

    const identity = await c.firm.fiscalIdentityFor(p.tenantId);
    if (!identity) throw badRequest('fiscal_identity_incomplete', 'record the firm fiscal identity before adding a device to it');

    const id = await c.firm.createFiscalDevice({
      tenantId: p.tenantId, fiscalIdentityId: String(identity.id), ...body,
    });
    await c.audit.tryWrite({
      action: 'FISCAL_DEVICE_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'fiscal_device', resourceId: id,
      metadata: { label: body.deviceLabel, serial: body.deviceSerial },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id });
  }));

  /**
   * ISSUE A TAX INVOICE. The route the whole phase exists for.
   *
   * WHAT IT DOES, IN ORDER, AND WHY THE ORDER IS THE POINT:
   *
   *   1. the draft must be in a state that can still be issued — an invoice already
   *      sent is not a draft, and issuing one would put a second document into the
   *      chain for the same supply;
   *   2. the caller must hold the billing permission AND see the matter financially;
   *   3. the firm must be fiscal-ready — refused here with a named blocker, and
   *      refused again by the database if this check were ever bypassed;
   *   4. the document is BUILT (QR, then XML, then hash) and its own arithmetic is
   *      reconciled before it is hashed, because a document that does not add up must
   *      not enter the chain;
   *   5. the ICV is allocated, the invoice is written, and the chain head moves.
   *
   * Once this route has run, the invoice can no longer be amended — by this code or by
   * anything else. That is the design, and the response says so.
   */
  r.post('/billing/invoices/:id/issue', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const invoiceId = String(req.params.id);
    const body = strictBody(
      z.object({
        subtype: z.enum(['standard', 'simplified']).optional(),
        deviceId: z.string().uuid().optional(),
        supplyAt: z.string().datetime().optional(),
      }).strict(),
      req, c, '/billing/invoices/:id/issue',
    );

    const invoice = await c.firm.getInvoiceFiscal(p.tenantId, invoiceId);
    if (!invoice) throw notFoundOrForbidden('invoice', invoiceId);
    /*
      PERMISSION FIRST, THEN MATTER SCOPE — the order invoice approval already uses, and
      the order matters for two reasons. A member without the permission is refused
      without the matter being looked up at all, so the answer cannot vary with whether
      the matter exists; and a member with the permission on a matter they cannot
      financially reach gets the scope refusal, which is the true obstacle.
    */
    c.permissions.assertCan(p, 'billing.approve', { type: 'invoice', id: invoiceId });
    // The matter scope is checked against the FINANCIAL access level, the same level
    // invoice approval uses: issuing is a stronger act than approving, not a weaker one.
    const matterId = toStrOrNull(invoice.matter_id);
    if (matterId) await c.permissions.requireMatter(p, matterId, MATTER_FINANCIAL);

    if (invoice.invoice_uuid) {
      throw conflict('issued_invoice_immutable',
        'this invoice has already been issued — the sequential number and hash cannot be taken twice');
    }
    if (!['draft', 'pending_internal_approval', 'approved'].includes(String(invoice.internal_status))) {
      throw badRequest('invoice_not_issued', `an invoice in ${String(invoice.internal_status)} cannot be issued`);
    }

    const devices = await c.firm.listFiscalDevices(p.tenantId);
    const device = body.deviceId
      ? devices.find((d) => String(d.id) === body.deviceId && Boolean(d.is_active))
      : devices.find((d) => Boolean(d.is_active));
    if (!device) {
      throw badRequest('fiscal_identity_incomplete',
        'no active fiscal device — the ICV sequence and the hash chain belong to a device, and there is none to issue from');
    }

    const ready = await c.firm.fiscalReady(p.tenantId);
    if (!ready) {
      /*
        The refusal that matters most in this file. It is audited as a DENIAL, so an
        attempt to issue against an un-onboarded firm is visible in the same ledger as
        the issues that succeeded.
      */
      await c.audit.tryWrite({
        action: 'ELIGIBILITY_DENIED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        outcome: 'denied', reasonCode: 'fiscal_identity_incomplete',
        resourceType: 'invoice', resourceId: invoiceId,
        metadata: { rule: 'e-invoicing integration phase' },
      }, requestInfo(req, c.trustProxy));
      throw badRequest('fiscal_identity_incomplete',
        'this firm cannot issue a tax invoice: no production fiscal identity and device are onboarded with ZATCA');
    }

    const client = await c.firm.getClientForInvoice(p.tenantId, String(invoice.client_id));
    const lines = await c.firm.listInvoiceLines(invoiceId);
    if (lines.length === 0) {
      throw badRequest('validation_failed', 'an invoice with no lines cannot be issued');
    }

    /*
      A DRAFT'S NUMBER IS PROVISIONAL; A DOCUMENT'S IS NOT. A draft is numbered
      `<final>-DRAFT` while it waits for approval, and the marker is stripped here — in
      the same write that gives the invoice its UUID — because the number is sealed the
      instant the document exists. An issued tax invoice numbered "…-DRAFT" is not a
      document that can be reported, and the invoice's own guard would then refuse to
      correct it: the label would have become permanent.
    */
    const draftNumber = String(invoice.invoice_number ?? '').trim();
    const officialNumber = draftNumber.replace(/[\s\-–—]*draft\s*$/i, '').trim();
    if (!officialNumber) {
      throw badRequest('validation_failed',
        'this invoice carries no official number to issue under — number it before issuing');
    }
    if (await c.firm.invoiceNumberInUse(p.tenantId, officialNumber, invoiceId)) {
      throw conflict('invoice_number_taken',
        `${officialNumber} is already on an issued invoice — the sequence may not repeat`);
    }

    const subtype = body.subtype ?? (client?.vatNumber ? 'standard' : 'simplified');
    if (subtype === 'standard' && !client?.vatNumber) {
      throw badRequest('buyer_vat_required',
        'a standard tax invoice must carry the buyer VAT registration number — without one this is a simplified supply');
    }

    const identity = await c.firm.fiscalIdentityFor(p.tenantId);
    const supplyAt = body.supplyAt ? new Date(body.supplyAt) : new Date();

    const xmlLines = lines.map((l, i) => {
      const amount = round2(Number(l.quantity) * Number(l.unit_price) - Number(l.discount_amount ?? 0));
      const rate = Number(l.vat_rate ?? 0.15);
      return {
        position: i + 1,
        description: String(l.description),
        descriptionAr: toStrOrNull(l.description_ar),
        quantity: String(l.quantity),
        unitPrice: Number(l.unit_price).toFixed(2),
        lineExtensionAmount: amount.toFixed(2),
        discountAmount: Number(l.discount_amount ?? 0).toFixed(2),
        vatCategory: String(l.vat_category ?? 'standard') as 'standard' | 'zero_rated' | 'exempt' | 'out_of_scope',
        vatRate: String(rate),
        vatAmount: round2(amount * rate).toFixed(2),
      };
    });

    const totals = {
      subtotal: round2(xmlLines.reduce((a, l) => a + Number(l.lineExtensionAmount), 0)).toFixed(2),
      vatTotal: round2(xmlLines.reduce((a, l) => a + Number(l.vatAmount), 0)).toFixed(2),
    };
    const total = round2(Number(totals.subtotal) + Number(totals.vatTotal)).toFixed(2);

    /*
      THE ARITHMETIC IS CHECKED BEFORE THE HASH, not after. The lines must sum to the
      totals — the guard checks the same thing at the database — but checking here means
      the refusal names the arithmetic rather than the constraint.
    */
    const reconciled = reconcileInvoice({
      lines: xmlLines.map((l) => ({ lineExtensionAmount: l.lineExtensionAmount, vatAmount: l.vatAmount })),
      subtotal: totals.subtotal, vatTotal: totals.vatTotal, total,
    });
    if (!reconciled.ok) {
      throw badRequest('invoice_lines_do_not_reconcile', reconciled.problems.join('; '));
    }

    /*
      THE ORDER OF THESE THREE STEPS IS THE REGULATION. The QR goes on the document, so
      the QR is built first; the document is what is hashed, so the XML is built carrying
      that QR; the hash is over those bytes, so it is computed last. A generator that
      hashed first would produce a document whose own hash does not verify against it.
    */
    const reference = await c.firm.fiscalDeviceChainHead(String(device.id));
    const qrPayload = buildQrPayload({
      sellerName: identity?.registered_name_ar ? String(identity.registered_name_ar) : String(identity?.registered_name ?? ''),
      vatRegistrationNumber: String(identity?.vat_registration_number ?? ''),
      timestamp: supplyTimestamp(supplyAt),
      totalWithVat: total,
      vatTotal: totals.vatTotal,
    });

    const uuid = newId();
    const xml = buildInvoiceXml({
      documentTypeCode: '388',
      subtype,
      invoiceNumber: officialNumber,
      uuid,
      issueDate: String(invoice.issue_date).slice(0, 10),
      issueTime: supplyTimestamp(supplyAt).slice(11, 19),
      supplyDate: subtype === 'standard' ? String(invoice.issue_date).slice(0, 10) : null,
      currency: String(invoice.currency ?? 'SAR'),
      icv: reference.icv + 1,
      previousInvoiceHash: reference.previousHash ?? GENESIS_PIH,
      seller: {
        name: String(identity?.registered_name ?? ''),
        nameAr: toStrOrNull(identity?.registered_name_ar),
        vatRegistrationNumber: String(identity?.vat_registration_number ?? ''),
        commercialRegistration: String(identity?.commercial_registration ?? ''),
        address: String(identity?.registered_address ?? ''),
        city: toStrOrNull(identity?.city),
        postalCode: toStrOrNull(identity?.postal_code),
        country: String(identity?.country ?? 'SA'),
      },
      buyer: {
        name: String(client?.name ?? ''),
        nameAr: toStrOrNull(client?.name_ar),
        vatNumber: toStrOrNull(client?.vat_number),
        address: null,
      },
      lines: xmlLines,
      subtotal: totals.subtotal,
      vatTotal: totals.vatTotal,
      total,
      qrPayload,
    });

    /* Taken, then used, then written — and the chain head moves only if the write did. */
    const allocated = await c.firm.allocateFiscalNumber(String(device.id));
    const hash = invoiceHash(xml);

    const changed = await c.firm.recordInvoiceIssue({
      tenantId: p.tenantId, invoiceId, deviceId: String(device.id), icv: allocated.icv,
      previousHash: allocated.previousHash ?? GENESIS_PIH, hash, qr: qrPayload,
      subtype, uuid, supplyAt: supplyAt.toISOString(),
      buyerName: String(client?.name ?? ''), buyerVat: toStrOrNull(client?.vat_number),
      xmlStorageKey: `${p.tenantId}/${String(invoice.client_id)}/fiscal/${invoiceId}/${uuid}.xml`,
      invoiceNumber: officialNumber,
    });
    if (changed === 0) {
      // The row was already issued by a concurrent request, or a guard refused the write.
      throw conflict('issued_invoice_immutable', 'this invoice was issued by another request — reload before retrying');
    }

    await c.audit.tryWrite({
      action: 'INVOICE_ISSUED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'invoice', resourceId: invoiceId,
      /*
        The HASH and the ICV go in the audit metadata; the XML does not. The hash is the
        thing that proves this document is the one that was issued; the XML is the
        document, and it belongs in storage behind a signed URL, not in a log row.
      */
      metadata: {
        uuid, icv: allocated.icv, subtype, hash,
        total, vat: totals.vatTotal,
        clearanceRequired: subtype === 'standard',
      },
    }, requestInfo(req, c.trustProxy));

    ok(res, {
      id: invoiceId, invoiceNumber: officialNumber, uuid, icv: allocated.icv, hash, subtype, total,
      // Returned so an integration can post the document without a second round trip.
      xml,
      qrPayload,
      fiscalStatus: subtype === 'standard' ? 'pending_clearance' : 'pending_reporting',
      nextStep: subtype === 'standard'
        ? 'Submit for clearance. The invoice may not be sent to the client until ZATCA clears it.'
        : 'Report within 24 hours of supply. The invoice may be issued to the client now.',
    }, 201);
  }));

  /**
   * Record what ZATCA said.
   *
   * A SEPARATE ROUTE FROM ISSUE, deliberately. Issuing is a firm act; clearance is the
   * authority's answer, and modelling the answer as part of the act would mean a
   * network timeout could not be retried without reissuing the document — which is the
   * one thing that must never happen, because the ICV and the hash would change.
   */
  r.post('/billing/invoices/:id/submissions', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const invoiceId = String(req.params.id);
    c.permissions.assertCan(p, 'billing.approve', { type: 'invoice', id: invoiceId });

    const body = strictBody(
      z.object({
      submissionType: z.enum(['clearance', 'reporting', 'compliance']),
      status: z.enum(['pending', 'submitted', 'cleared', 'reported', 'rejected', 'failed', 'timed_out']),
      httpStatus: z.number().int().min(100).max(599).nullable().optional(),
      responseCode: z.string().max(200).nullable().optional(),
      responseBody: z.string().max(20_000).nullable().optional(),
      warnings: z.string().max(20_000).nullable().optional(),
      errors: z.string().max(20_000).nullable().optional(),
      requestBodyHash: z.string().max(200).nullable().optional(),
      retryInSeconds: z.number().int().min(0).max(86_400).nullable().optional(),
    }).strict(),
      req, c, '/billing/invoices/:id/submissions',
    );

    const invoice = await c.firm.getInvoiceFiscal(p.tenantId, invoiceId);
    if (!invoice) throw notFoundOrForbidden('invoice', invoiceId);
    if (!invoice.invoice_uuid) {
      throw badRequest('invoice_not_issued', 'there is nothing to submit — this invoice has not been issued');
    }

    const nextRetryAt = body.status === 'failed' || body.status === 'timed_out'
      /* A retry is SCHEDULED, not hoped for. The backoff is supplied by the caller so
         this route makes no assumption about how a scheduler works; the column is what
         makes "the submission that was never retried" a queryable fact. */
      ? new Date(Date.now() + (body.retryInSeconds ?? 900) * 1000).toISOString()
      : null;

    const { id, nextAttempt } = await c.firm.recordSubmission({
      tenantId: p.tenantId, invoiceId,
      submissionType: body.submissionType, attempt: 0, status: body.status,
      httpStatus: body.httpStatus ?? null, responseCode: body.responseCode ?? null,
      requestBodyHash: body.requestBodyHash ?? null, responseBody: body.responseBody ?? null,
      warnings: body.warnings ?? null, errors: body.errors ?? null, nextRetryAt,
    });

    /*
      The invoice's fiscal status follows the submission ONLY in the direction that
      settles it: a clearance that succeeds sets 'cleared'. A failure records the
      attempt and leaves the invoice alone — setting 'failed' on the invoice would lose
      the fact that a later attempt cleared it.
    */
    const nextStatus =
      body.status === 'cleared' ? 'cleared'
      : body.status === 'reported' ? 'reported'
      : body.status === 'rejected' ? 'rejected'
      : null;
    if (nextStatus) await c.firm.setFiscalStatus(p.tenantId, invoiceId, nextStatus);

    const action = body.status === 'cleared' ? 'INVOICE_CLEARED'
      : body.status === 'reported' ? 'INVOICE_REPORTED'
      : body.status === 'rejected' ? 'INVOICE_REJECTED'
      : 'INVOICE_SUBMITTED';

    await c.audit.tryWrite({
      action,
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: body.status === 'rejected' ? 'denied' : 'success',
      reasonCode: body.status === 'rejected' ? (body.responseCode ?? 'rejected') : undefined,
      resourceType: 'invoice', resourceId: invoiceId,
      // The response BODY is not copied into the audit row: it can carry the whole
      // document back, and the audit log is not a document store.
      metadata: { submissionType: body.submissionType, status: body.status, httpStatus: body.httpStatus ?? null },
    }, requestInfo(req, c.trustProxy));

    ok(res, {
      id,
      fiscalStatus: nextStatus ?? String(invoice.fiscal_status ?? 'not_issued'),
      nextAttempt, nextRetryAt,
    }, 201);
  }));

  r.get('/billing/invoices/:id/fiscal', ah(async (req, res) => {
    const p = principal(req);
    const invoiceId = String(req.params.id);
    c.permissions.assertCanAny(p, ['billing.read', 'billing.read_all'], { type: 'invoice', id: invoiceId });
    const invoice = await c.firm.getInvoiceFiscal(p.tenantId, invoiceId);
    if (!invoice) throw notFoundOrForbidden('invoice', invoiceId);
    const [submissions, creditNotes] = await Promise.all([
      c.firm.listSubmissions(p.tenantId, invoiceId),
      c.firm.listCreditNotes(p.tenantId, invoiceId),
    ]);
    ok(res, {
      id: invoiceId,
      invoiceNumber: String(invoice.invoice_number),
      fiscal: {
        uuid: invoice.invoice_uuid ?? null,
        subtype: invoice.invoice_type ?? null,
        icv: invoice.icv ?? null,
        previousHash: invoice.previous_invoice_hash ?? null,
        hash: invoice.invoice_hash ?? null,
        qrPayload: invoice.qr_payload ?? null,
        xmlStorageKey: invoice.xml_storage_key ?? null,
        supplyAt: invoice.supply_at ?? null,
        buyerName: invoice.buyer_name ?? null,
        buyerVat: invoice.buyer_vat_number ?? null,
        status: invoice.fiscal_status ?? 'not_issued',
        statusAt: invoice.fiscal_status_at ?? null,
        device: invoice.device_label ? { label: invoice.device_label, serial: invoice.device_serial } : null,
      },
      submissions: submissions.map((s) => ({
        id: String(s.id), type: String(s.submission_type), attempt: Number(s.attempt),
        status: String(s.status), httpStatus: s.http_status ?? null,
        responseCode: s.response_code ?? null, warnings: s.warnings ?? null,
        errors: s.errors ?? null, nextRetryAt: s.next_retry_at ?? null,
        submittedAt: s.submitted_at ?? null, resolvedAt: s.resolved_at ?? null,
      })),
      creditNotes: creditNotes.map((cn) => ({
        id: String(cn.id), number: String(cn.credit_number), reason: String(cn.reason),
        total: Number(cn.total), uuid: cn.invoice_uuid ?? null, icv: cn.icv ?? null,
        status: cn.fiscal_status ?? null, issuedAt: cn.issued_at ?? null,
      })),
    });
  }));

  /** Simplified invoices whose 24-hour reporting window is open, or has passed. */
  r.get('/billing/reporting-queue', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCanAny(p, ['billing.read', 'billing.read_all'], { type: 'invoice_collection' });
    const rows = await c.firm.listInvoicesNeedingReporting(p.tenantId);
    ok(res, {
      count: rows.length,
      overdue: rows.filter((x) => Number(x.overdue) === 1).length,
      invoices: rows.map((x) => ({
        id: String(x.id), number: String(x.invoice_number), uuid: x.invoice_uuid ?? null,
        supplyAt: x.supply_at ?? null, total: Number(x.total), icv: x.icv ?? null,
        status: x.fiscal_status ?? null, overdue: Number(x.overdue) === 1,
        /*
          The deadline is COMPUTED HERE rather than stored. It is 24 hours from supply —
          a rule, not a fact — and storing it would create a second date that can
          disagree with the first.
        */
        reportBy: x.supply_at ? reportingDeadline(new Date(String(x.supply_at))).toISOString() : null,
      })),
    });
  }));

  /** Issue a credit note — the ONLY way to correct an invoice that has been issued. */
  r.post('/billing/invoices/:id/credit-notes', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const invoiceId = String(req.params.id);
    const body = strictBody(
      z.object({
      reason: z.string().trim().min(5).max(500),
      amount: z.number().positive(),
      vatAmount: z.number().min(0),
      creditNumber: z.string().trim().min(2).max(60),
      deviceId: z.string().uuid().optional(),
    }).strict(),
      req, c, '/billing/invoices/:id/credit-notes',
    );

    const invoice = await c.firm.getInvoiceFiscal(p.tenantId, invoiceId);
    if (!invoice) throw notFoundOrForbidden('invoice', invoiceId);

    const total = round2(body.amount + body.vatAmount);
    /*
      Crediting a balance is the same class of act as writing it off, so it takes the
      same gate with the same ceiling, for the same amount. The matter scope is checked
      as well: a member who cannot see a matter financially cannot release a client from
      part of its fee either, and an earlier version of this route checked neither the
      scope nor the client — it only checked that the invoice existed.
    */
    c.permissions.assertCanApproveAmount(p, 'billing.discount', 'writeoff', total, { type: 'invoice', id: invoiceId });
    const creditMatterId = toStrOrNull(invoice.matter_id);
    if (creditMatterId) await c.permissions.requireMatter(p, creditMatterId, MATTER_FINANCIAL);

    if (!invoice.invoice_uuid) {
      throw badRequest('credit_note_against_unissued_invoice',
        'there is nothing to credit — this invoice was never issued');
    }

    const existing = await c.firm.listCreditNotes(p.tenantId, invoiceId);
    const credited = round2(existing.reduce((a, cn) => a + Number(cn.total), 0));
    if (credited + total > Number(invoice.total) + 0.01) {
      throw badRequest('credit_note_exceeds_invoice',
        `credits of ${round2(credited + total).toFixed(2)} against an invoice of ${Number(invoice.total).toFixed(2)}`);
    }

    const identity = await c.firm.fiscalIdentityFor(p.tenantId);
    const devices = await c.firm.listFiscalDevices(p.tenantId);
    const device = body.deviceId
      ? devices.find((d) => String(d.id) === body.deviceId)
      : devices.find((d) => String(d.id) === String(invoice.fiscal_device_id));
    if (!device) throw badRequest('fiscal_identity_incomplete', 'no fiscal device to issue a credit note from');
    if (!(await c.firm.fiscalReady(p.tenantId))) {
      throw badRequest('fiscal_identity_incomplete',
        'this firm cannot issue a credit note: no production fiscal identity and device are onboarded');
    }

    const supplyAt = new Date();
    const reference = await c.firm.fiscalDeviceChainHead(String(device.id));
    const qrPayload = buildQrPayload({
      sellerName: identity?.registered_name_ar ? String(identity.registered_name_ar) : String(identity?.registered_name ?? ''),
      vatRegistrationNumber: String(identity?.vat_registration_number ?? ''),
      timestamp: supplyTimestamp(supplyAt),
      totalWithVat: total.toFixed(2),
      vatTotal: round2(body.vatAmount).toFixed(2),
    });
    const uuid = newId();
    const xml = buildInvoiceXml({
      documentTypeCode: '381',
      subtype: String(invoice.invoice_type) === 'standard' ? 'standard' : 'simplified',
      invoiceNumber: body.creditNumber, uuid,
      issueDate: supplyAt.toISOString().slice(0, 10),
      issueTime: supplyTimestamp(supplyAt).slice(11, 19),
      supplyDate: supplyAt.toISOString().slice(0, 10),
      currency: 'SAR',
      icv: reference.icv + 1,
      previousInvoiceHash: reference.previousHash ?? GENESIS_PIH,
      seller: {
        name: String(identity?.registered_name ?? ''),
        nameAr: toStrOrNull(identity?.registered_name_ar),
        vatRegistrationNumber: String(identity?.vat_registration_number ?? ''),
        commercialRegistration: String(identity?.commercial_registration ?? ''),
        address: String(identity?.registered_address ?? ''),
        city: toStrOrNull(identity?.city), postalCode: toStrOrNull(identity?.postal_code),
        country: String(identity?.country ?? 'SA'),
      },
      buyer: {
        name: String(invoice.buyer_name ?? ''),
        vatNumber: invoice.buyer_vat_number ? String(invoice.buyer_vat_number) : null,
      },
      lines: [{
        position: 1,
        description: body.reason,
        quantity: '1',
        unitPrice: round2(body.amount).toFixed(2),
        lineExtensionAmount: round2(body.amount).toFixed(2),
        vatCategory: 'standard', vatRate: '0.15',
        vatAmount: round2(body.vatAmount).toFixed(2),
      }],
      subtotal: round2(body.amount).toFixed(2),
      vatTotal: round2(body.vatAmount).toFixed(2),
      total: total.toFixed(2),
      qrPayload,
      // MANDATORY on a credit note, and the reason the XML builder refuses one without it.
      billingReference: {
        invoiceNumber: String(invoice.invoice_number),
        uuid: String(invoice.invoice_uuid),
        issueDate: String(invoice.issue_date).slice(0, 10),
      },
      note: body.reason,
    });

    const allocated = await c.firm.allocateFiscalNumber(String(device.id));
    const id = await c.firm.createCreditNote({
      tenantId: p.tenantId, invoiceId, clientId: String(invoice.client_id),
      creditNumber: body.creditNumber, reason: body.reason,
      amount: round2(body.amount), vatAmount: round2(body.vatAmount), total,
      deviceId: String(device.id), icv: allocated.icv,
      previousHash: allocated.previousHash ?? GENESIS_PIH,
      hash: invoiceHash(xml), qr: qrPayload, uuid, issuedByStaff: p.staffId,
    });

    await c.audit.tryWrite({
      action: 'CREDIT_NOTE_ISSUED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'invoice', resourceId: invoiceId,
      metadata: { creditNoteId: id, creditNumber: body.creditNumber, uuid, icv: allocated.icv, total },
    }, requestInfo(req, c.trustProxy));

    ok(res, { id, uuid, icv: allocated.icv, total, xml, qrPayload, fiscalStatus: 'pending_clearance' }, 201);
  }));

  /* ══════════════════════════════════════════════════════════════════════════
   * P1.1 · CLIENT MONEY
   *
   * The firm holds other people's money, and the whole of this section exists to make
   * that fact visible: what is held, whose it is, and what changed it.
   * ══════════════════════════════════════════════════════════════════════════ */

  r.get('/trust/ledgers', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCanAny(p, ['billing.read', 'billing.read_all'], { type: 'trust_ledger' });
    const ledgers = await c.firm.listClientLedgers(p.tenantId);
    const total = round2(ledgers.reduce((a, l) => a + Number(l.balance), 0));
    ok(res, {
      count: ledgers.length,
      // THE FIRM'S LIABILITY, stated as such. This is not the firm's money, and the
      // field name is chosen so that no screen can mistake it for revenue.
      heldForClients: total,
      ledgers: ledgers.map((l) => ({
        id: String(l.id), clientId: String(l.client_id),
        clientName: String(l.client_name), clientNameAr: l.client_name_ar ?? null,
        currency: String(l.currency), status: String(l.status),
        frozenReason: l.frozen_reason ?? null,
        balance: round2(Number(l.balance)), entryCount: Number(l.entry_count),
        lastMovementAt: l.last_movement_at ?? null,
      })),
    });
  }));

  r.get('/trust/ledgers/:clientId', ah(async (req, res) => {
    const p = principal(req);
    const clientId = String(req.params.clientId);
    c.permissions.assertCanAny(p, ['billing.read', 'billing.read_all'], { type: 'trust_ledger' });
    const ledger = await c.firm.getClientLedger(p.tenantId, clientId);
    if (!ledger) throw notFoundOrForbidden('ledger', clientId);
    const entries = await c.firm.listLedgerEntries(p.tenantId, clientId);
    const balance = await c.firm.ledgerBalance(String(ledger.id));
    ok(res, {
      id: String(ledger.id), clientId,
      clientName: String(ledger.client_name), clientNameAr: ledger.client_name_ar ?? null,
      currency: String(ledger.currency), status: String(ledger.status),
      frozenReason: ledger.frozen_reason ?? null,
      openedAt: ledger.opened_at ?? null,
      balance,
      /*
        The entries are returned newest-first for reading, and the balance is returned
        beside them as a figure the server computed — not as something the screen adds
        up. Recomputing a running balance in a view is how two people come to disagree
        about what the firm holds.
      */
      entries: entries.map((e) => ({
        id: String(e.id), type: String(e.entry_type), direction: String(e.direction),
        amount: round2(Number(e.amount)), description: String(e.description),
        reference: e.reference ?? null, invoiceId: e.invoice_id ?? null,
        invoiceNumber: e.invoice_number ?? null, matterId: e.matter_id ?? null,
        matterNumber: e.matter_number ?? null,
        evidenceDocumentId: e.evidence_document_id ?? null,
        reversesEntryId: e.reverses_entry_id ?? null,
        reversalReason: e.reversal_reason ?? null,
        entryAt: e.entry_at, recordedAt: e.recorded_at,
        recordedBy: e.recorded_by_email ?? null,
      })),
    });
  }));

  /**
   * The movements that put money in or take it out.
   *
   * ONE ROUTE WITH A TYPE, not five routes. The database refuses the wrong direction
   * for a type, refuses an application against an unissued invoice, refuses a debit
   * that would overdraw, and refuses an update or a delete to anything already written
   * — so these five operations are five TYPES of one thing, and five routes would
   * duplicate the same permission check five times with four chances to miss one.
   */
  r.post('/trust/ledgers/:clientId/entries', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const clientId = String(req.params.clientId);
    const body = strictBody(
      z.object({
      entryType: z.enum(['receipt', 'application_to_fee', 'disbursement', 'refund', 'bank_charge', 'interest']),
      amount: z.number().positive(),
      description: z.string().trim().min(3).max(500),
      reference: z.string().trim().max(200).nullable().optional(),
      matterId: z.string().uuid().nullable().optional(),
      invoiceId: z.string().uuid().nullable().optional(),
      evidenceDocumentId: z.string().uuid().nullable().optional(),
      entryAt: z.string().datetime().nullable().optional(),
    }).strict(),
      req, c, '/trust/ledgers/:clientId/entries',
    );

    /*
      THE PERMISSION FOLLOWS THE DIRECTION OF THE MONEY.

      Recording a receipt is bookkeeping and `billing.record_payment` covers it. Taking
      money OUT — a disbursement, a refund, a bank charge — is spending a client's
      funds, and it needs `billing.writeoff` as well, because it is an act the firm
      answers for rather than a record of something that happened elsewhere.
    */
    const outgoing = ['disbursement', 'refund', 'bank_charge'].includes(body.entryType);
    c.permissions.assertCan(p, outgoing ? 'billing.writeoff' : 'billing.record_payment', {
      type: 'trust_ledger', id: clientId,
    });

    if (outgoing) {
      // Same reason a write-off carries a ceiling: spending money is a financial
      // decision with a limit attached to the member making it.
      c.permissions.assertWithinAuthority(p, 'writeoff', body.amount, { type: 'trust_ledger', id: clientId });
    }

    if (body.entryType === 'application_to_fee') {
      if (!body.invoiceId) {
        throw badRequest('validation_failed', 'an application to a fee must name the invoice it is applied to');
      }
      const invoice = await c.firm.getInvoiceFiscal(p.tenantId, body.invoiceId);
      if (!invoice) throw notFoundOrForbidden('invoice', body.invoiceId);
      // The invoice's own client must be this client. The database refuses it too, and
      // refusing here means the message names the mismatch instead of a trigger.
      if (String(invoice.client_id) !== clientId) {
        throw badRequest('trust_application_wrong_client',
          'money held for one client may not be applied to another client invoice');
      }
      const ledger = await c.firm.getClientLedger(p.tenantId, clientId);
      if (ledger) {
        const balance = await c.firm.ledgerBalance(String(ledger.id));
        if (round2(body.amount) > balance + 0.01) {
          throw badRequest('client_funds_overdrawn',
            `this client holds ${balance.toFixed(2)} — ${round2(body.amount).toFixed(2)} cannot be applied from it`);
        }
      }
    }

    const id = await c.firm.recordLedgerEntry({
      tenantId: p.tenantId, clientId,
      entryType: body.entryType, amount: round2(body.amount), description: body.description,
      reference: body.reference ?? null, matterId: body.matterId ?? null,
      invoiceId: body.invoiceId ?? null, evidenceDocumentId: body.evidenceDocumentId ?? null,
      entryAt: body.entryAt ?? undefined, recordedByUserId: p.userId,
    });

    const ledger = await c.firm.getClientLedger(p.tenantId, clientId);
    const balance = ledger ? await c.firm.ledgerBalance(String(ledger.id)) : 0;

    await c.audit.tryWrite({
      action: body.entryType === 'receipt' ? 'TRUST_RECEIPT_RECORDED'
        : body.entryType === 'application_to_fee' ? 'TRUST_APPLIED_TO_INVOICE'
        : body.entryType === 'refund' ? 'TRUST_REFUND_PAID'
        : 'TRUST_DISBURSEMENT_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'trust_ledger', resourceId: clientId,
      /*
        The RUNNING BALANCE goes in the audit row. A receipt logged with its amount
        alone cannot answer the only question asked of it later — whether the balance
        after it matched the bank on that date.
      */
      metadata: {
        entryId: id, entryType: body.entryType, amount: round2(body.amount), balanceAfter: balance,
        invoiceId: body.invoiceId ?? null, matterId: body.matterId ?? null,
      },
    }, requestInfo(req, c.trustProxy));

    ok(res, { id, balance }, 201);
  }));

  r.get('/trust/reconciliations', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCanAny(p, ['billing.read', 'billing.read_all'], { type: 'trust_reconciliation' });
    const rows = await c.firm.listReconciliations(p.tenantId);
    const ledgers = await c.firm.listClientLedgers(p.tenantId);
    ok(res, {
      count: rows.length,
      // The live position, so a reader sees "as it stands now" beside the last
      // reconciliation instead of comparing two pages.
      currentLedgerTotal: round2(ledgers.reduce((a, l) => a + Number(l.balance), 0)),
      clientsWithBalance: ledgers.filter((l) => Number(l.balance) > 0).length,
      reconciliations: rows.map((x) => ({
        id: String(x.id), asOf: x.as_of, ledgerTotal: round2(Number(x.ledger_total)),
        bankBalance: round2(Number(x.bank_balance)), difference: round2(Number(x.difference)),
        status: String(x.status), notes: x.notes ?? null,
        bankStatementReference: x.bank_statement_reference ?? null,
        clientsWithBalance: Number(x.clients_with_balance),
        performedAt: x.performed_at,
      })),
    });
  }));

  /**
   * Perform a reconciliation.
   *
   * THE LEDGER TOTAL IS COMPUTED HERE and cannot be supplied. A reconciliation that
   * accepted its own "what the ledgers say" figure would let the person performing it
   * type in whatever made the difference disappear — which is the only way a
   * reconciliation control can be defeated by the person using it.
   */
  r.post('/trust/reconciliations', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    /*
      RECONCILIATION IS AN ATTESTATION OVER THE WHOLE CLIENT ACCOUNT, so it takes
      firm-wide financial visibility (`billing.read_all`) rather than a narrower code:
      a member who can only see their own practice area's billing cannot attest that
      the firm holds what the banks say it holds. The ledger itself is append-only, so
      the attestation adds no write authority to lose.
    */
    c.permissions.assertCan(p, 'billing.read_all', { type: 'trust_reconciliation' });
    const body = strictBody(
      z.object({
      asOf: z.string().datetime(),
      bankBalance: z.number(),
      bankStatementReference: z.string().trim().max(200).nullable().optional(),
      bankStatementDocumentId: z.string().uuid().nullable().optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
    }).strict(),
      req, c, '/trust/reconciliations',
    );

    const ledgers = await c.firm.listClientLedgers(p.tenantId);
    const ledgerTotal = round2(ledgers.reduce((a, l) => a + Number(l.balance), 0));
    const clientsWithBalance = ledgers.filter((l) => Number(l.balance) > 0).length;
    const difference = round2(ledgerTotal - body.bankBalance);

    const id = await c.firm.createReconciliation({
      tenantId: p.tenantId, asOf: body.asOf, ledgerTotal, bankBalance: round2(body.bankBalance),
      bankStatementReference: body.bankStatementReference ?? null,
      bankStatementDocumentId: body.bankStatementDocumentId ?? null,
      clientsWithBalance,
      // The caller may state an intention; the repository derives the fact. A
      // difference cannot end up recorded as 'balanced' because the repository
      // overrides the status.
      status: Math.abs(difference) < 0.01 ? 'balanced' : (body.notes ? 'investigated' : 'difference'),
      notes: body.notes ?? null, performedByUserId: p.userId,
    });

    /* A discrepancy is its own audit action. A reconciliation that balances is
       routine; one that does not is the event a partner needs to see without having to
       go looking for it. */
    await c.audit.tryWrite({
      action: Math.abs(difference) < 0.01 ? 'LEDGER_RECONCILED' : 'TRUST_DISCREPANCY_FOUND',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: Math.abs(difference) < 0.01 ? 'success' : 'denied',
      reasonCode: Math.abs(difference) < 0.01 ? undefined : 'difference',
      resourceType: 'trust_reconciliation', resourceId: id,
      metadata: { asOf: body.asOf, ledgerTotal, bankBalance: round2(body.bankBalance), difference, clientsWithBalance },
    }, requestInfo(req, c.trustProxy));

    ok(res, {
      id, ledgerTotal, bankBalance: round2(body.bankBalance), difference,
      balanced: Math.abs(difference) < 0.01,
      // The refusal vocabulary an operator acts on, in the response rather than in a
      // log: a difference is not an error, it is a result that needs explaining.
      requiresExplanation: Math.abs(difference) >= 0.01,
    }, 201);
  }));

  /* ══════════════════════════════════════════════════════════════════════════
   * P1.2 · P1.4 · THE FEE
   * ══════════════════════════════════════════════════════════════════════════ */

  r.get('/matters/:id/billing', ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    await c.permissions.requireMatter(p, matterId, MATTER_FINANCIAL);
    const [terms, letters, billable, time, expenses] = await Promise.all([
      c.firm.billingTermsForMatter(p.tenantId, matterId),
      c.firm.listEngagementLetters(p.tenantId, matterId),
      c.firm.matterBillable(matterId),
      c.firm.listTimeEntries(p.tenantId, { matterId }),
      c.firm.listExpenses(p.tenantId, { matterId }),
    ]);
    const unbilledTime = round2(time.filter((t) => ['submitted', 'approved'].includes(String(t.status)))
      .reduce((a, t) => a + Number(t.amount_sar), 0));
    const unbilledExpenses = round2(expenses.filter((e) => String(e.status) === 'approved')
      .reduce((a, e) => a + Number(e.total_amount_sar), 0));
    ok(res, {
      matterId,
      /*
        `billable` is the Rule 12 answer, returned as the PRIMARY field rather than
        something a screen infers by looking at two lists. The same test the database
        trigger applies answers it, so the screen and the trigger cannot disagree.
      */
      billable,
      /*
        The blockers are derived from the SAME predicate as `billable` above, not from a
        second reading of the same rows. A superseded letter is still `status = 'signed'`
        — it was signed, and that is a fact about the past — so a blocker list that
        looked at the status alone would report nothing missing on a matter that is
        plainly not billable, and the screen would say "blocked" with no reason beside it.
      */
      blockers: billable ? [] : [
        ...(letters.some((l) => String(l.status) === 'signed' && l.superseded_by === null)
          ? [] : ['no_signed_engagement_letter']),
        ...(terms ? [] : ['no_billing_terms']),
      ],
      terms: terms ? {
        id: String(terms.id), basis: String(terms.basis),
        feeAmountSar: terms.fee_amount_sar === null ? null : Number(terms.fee_amount_sar),
        capAmountSar: terms.cap_amount_sar === null ? null : Number(terms.cap_amount_sar),
        retainerAmountSar: terms.retainer_amount_sar === null ? null : Number(terms.retainer_amount_sar),
        stages: terms.stages ? JSON.parse(String(terms.stages)) : null,
        agreedDiscountPct: Number(terms.agreed_discount_pct),
        effectiveFrom: terms.effective_from, notes: terms.notes ?? null,
      } : null,
      engagementLetters: letters.map((l) => ({
        id: String(l.id), status: String(l.status), scope: String(l.scope),
        calculationMethod: String(l.calculation_method),
        feeAmountSar: l.fee_amount_sar === null ? null : Number(l.fee_amount_sar),
        signedAt: l.signed_by_client_at ?? null, signedByName: l.signed_by_client_name ?? null,
        documentId: l.document_id ?? null, identityVerifiedAt: l.identity_verified_at ?? null,
        capacityVerified: Boolean(l.capacity_verified),
      })),
      unbilled: { time: unbilledTime, expenses: unbilledExpenses, total: round2(unbilledTime + unbilledExpenses) },
      time: time.map((t) => ({
        id: String(t.id), date: t.entry_date, minutes: Number(t.minutes),
        narrative: String(t.narrative), narrativeAr: t.narrative_ar ?? null,
        billable: Boolean(t.billable), rate: Number(t.hourly_rate_sar), amount: Number(t.amount_sar),
        status: String(t.status), staffName: String(t.staff_name),
      })),
      expenses: expenses.map((e) => ({
        id: String(e.id), incurredOn: e.incurred_on, category: String(e.category),
        description: String(e.description), net: Number(e.net_amount_sar),
        vat: Number(e.vat_amount_sar), total: Number(e.total_amount_sar),
        reimbursable: Boolean(e.reimbursable), status: String(e.status),
        receiptDocumentId: e.receipt_document_id ?? null,
      })),
    });
  }));

  r.post('/matters/:id/billing-terms', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    /*
      Setting the basis on which a client is charged is a BILLING act, not a matter edit:
      a member who may edit a matter's description may not set its fee. `billing.edit` is
      the code the catalogue gives the finance module for changing billing records, and it
      is held by exactly the roles that should hold this — partner, lawyer and finance —
      and not by a paralegal or a compliance officer.
    */
    c.permissions.assertCan(p, 'billing.edit', { type: 'matter', id: matterId });
    await c.permissions.requireMatter(p, matterId, MATTER_MANAGE);

    const body = strictBody(
      z.object({
      basis: z.enum(['hourly', 'fixed', 'capped', 'staged', 'retainer']),
      feeAmountSar: z.number().min(0).nullable().optional(),
      capAmountSar: z.number().positive().nullable().optional(),
      retainerAmountSar: z.number().positive().nullable().optional(),
      stages: z.array(z.object({ label: z.string().min(1), amount: z.number().min(0) })).nullable().optional(),
      agreedDiscountPct: z.number().min(0).max(100).default(0),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      notes: z.string().trim().max(1000).nullable().optional(),
    }).strict(),
      req, c, '/matters/:id/billing-terms',
    );

    /* The basis determines which figure is required. The refusal names the missing
       figure rather than letting a CHECK constraint report 'null value in column'. */
    if (body.basis === 'fixed' && body.feeAmountSar == null) throw badRequest('validation_failed', 'a fixed fee needs the fee');
    if (body.basis === 'capped' && body.capAmountSar == null) throw badRequest('validation_failed', 'a capped fee needs the cap');
    if (body.basis === 'retainer' && body.retainerAmountSar == null) throw badRequest('validation_failed', 'a retainer needs the amount');
    if (body.basis === 'staged' && !body.stages?.length) throw badRequest('validation_failed', 'a staged fee needs its stages');

    const id = await c.firm.setBillingTerms({
      tenantId: p.tenantId, matterId, basis: body.basis,
      feeAmountSar: body.feeAmountSar ?? null, capAmountSar: body.capAmountSar ?? null,
      retainerAmountSar: body.retainerAmountSar ?? null,
      stages: body.stages ? JSON.stringify(body.stages) : null,
      agreedDiscountPct: body.agreedDiscountPct, effectiveFrom: body.effectiveFrom,
      notes: body.notes ?? null, createdByUserId: p.userId,
    });
    await c.audit.tryWrite({
      action: 'BILLING_TERMS_SET',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'matter', resourceId: matterId,
      metadata: { termsId: id, basis: body.basis, effectiveFrom: body.effectiveFrom },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id, basis: body.basis }, 201);
  }));

  r.post('/matters/:id/engagement-letters', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'contracts.manage', { type: 'matter', id: matterId });
    await c.permissions.requireMatter(p, matterId, MATTER_WRITE);
    const body = strictBody(
      z.object({
      scope: z.string().trim().min(10).max(4000),
      scopeAr: z.string().trim().max(4000).nullable().optional(),
      feeAmountSar: z.number().min(0).nullable().optional(),
      calculationMethod: z.string().trim().min(10).max(2000),
      clientId: z.string().uuid(),
      status: z.enum(['draft', 'sent']).default('draft'),
    }).strict(),
      req, c, '/matters/:id/engagement-letters',
    );

    const id = await c.firm.upsertEngagementLetter({
      tenantId: p.tenantId, matterId, clientId: body.clientId, scope: body.scope,
      scopeAr: body.scopeAr ?? null, feeAmountSar: body.feeAmountSar ?? null,
      calculationMethod: body.calculationMethod, status: body.status, createdByUserId: p.userId,
    });
    await c.audit.tryWrite({
      action: 'ENGAGEMENT_LETTER_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'matter', resourceId: matterId,
      metadata: { letterId: id, status: body.status },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id }, 201);
  }));

  /**
   * Sign the engagement letter — the act that opens billing on a matter.
   *
   * Rule 11's preconditions are recorded HERE, at the moment of signature, because
   * that is when the rule requires them to have been established: identity and capacity
   * verified, conflict excluded. The conflict half is NOT restated as a boolean in this
   * request — it is `matters.conflict_cleared`, which P0.1 derives from the check
   * ledger, and a second answer to that question is exactly what the gate matrix forbids.
   */
  r.post('/engagement-letters/:id/sign', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const letterId = String(req.params.id);
    const body = strictBody(
      z.object({
      signedByName: z.string().trim().min(2).max(200),
      documentId: z.string().uuid(),
      identityVerifiedAt: z.string().datetime(),
      capacityVerified: z.boolean(),
    }).strict(),
      req, c, '/engagement-letters/:id/sign',
    );

    const letter = await c.firm.getEngagementLetter(p.tenantId, letterId);
    if (!letter) throw notFoundOrForbidden('engagement_letter', letterId);
    c.permissions.assertCan(p, 'contracts.manage', { type: 'matter', id: String(letter.matter_id) });
    await c.permissions.requireMatter(p, String(letter.matter_id), MATTER_MANAGE);

    if (!body.capacityVerified) {
      throw badRequest('validation_failed',
        'Rule 11 requires the client legal capacity to have been verified before the work is accepted');
    }

    const changed = await c.firm.signEngagementLetter({
      tenantId: p.tenantId, letterId, signedByName: body.signedByName,
      documentId: body.documentId, identityVerifiedAt: body.identityVerifiedAt,
      capacityVerified: body.capacityVerified,
    });
    if (changed === 0) throw notFoundOrForbidden('engagement_letter', letterId);

    await c.audit.tryWrite({
      action: 'ENGAGEMENT_LETTER_SIGNED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'matter', resourceId: String(letter.matter_id),
      metadata: { letterId, documentId: body.documentId },
    }, requestInfo(req, c.trustProxy));

    const billable = await c.firm.matterBillable(String(letter.matter_id));
    ok(res, {
      id: letterId, signed: true, billable,
      // The half that usually still blocks: a signed contract with no stated method of
      // calculating the fee is not the written agreement the rules ask for.
      nextStep: billable ? null
        : 'Record the billing terms — a signed letter with no stated basis for the fee does not satisfy the engagement rules.',
    });
  }));

  r.get('/rate-cards', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCanAny(p, ['billing.read', 'billing.read_all', 'settings.read'], { type: 'rate_card' });
    const cards = await c.firm.listRateCards(p.tenantId);
    ok(res, {
      count: cards.length,
      cards: cards.map((c) => ({
        id: String(c.id), level: c.level ?? null, staffId: c.staff_id ?? null,
        hourlyRateSar: Number(c.hourly_rate_sar),
        effectiveFrom: c.effective_from, effectiveTo: c.effective_to ?? null,
      })),
    });
  }));

  r.post('/rate-cards', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    // The rate card is the firm's price list: a billing record, changed by the same
    // members who may change billing.
    c.permissions.assertCan(p, 'billing.edit', { type: 'rate_card' });
    const body = strictBody(
      z.object({
      level: z.string().trim().min(2).max(60).nullable().optional(),
      staffId: z.string().uuid().nullable().optional(),
      hourlyRateSar: z.number().positive().max(100_000),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).strict(),
      req, c, '/rate-cards',
    );
    if (!body.level && !body.staffId) {
      throw badRequest('validation_failed', 'a rate card applies to a level or to a member, and this one applies to neither');
    }
    const id = await c.firm.createRateCard({
      tenantId: p.tenantId, level: body.level ?? null, staffId: body.staffId ?? null,
      hourlyRateSar: body.hourlyRateSar, effectiveFrom: body.effectiveFrom, createdByUserId: p.userId,
    });
    await c.audit.tryWrite({
      action: 'RATE_CARD_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'rate_card', resourceId: id,
      metadata: { level: body.level ?? null, staffId: body.staffId ?? null,
        hourlyRateSar: body.hourlyRateSar, effectiveFrom: body.effectiveFrom },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id }, 201);
  }));

  r.get('/time-entries', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'time.read', { type: 'time_entry_collection' });
    const matterId = typeof req.query.matterId === 'string' ? req.query.matterId : null;
    if (matterId) await c.permissions.requireMatter(p, matterId, MATTER_FINANCIAL);
    const rows = await c.firm.listTimeEntries(p.tenantId, { matterId });
    ok(res, {
      count: rows.length,
      entries: rows.map((t) => ({
        id: String(t.id), matterId: String(t.matter_id), matterNumber: String(t.matter_number),
        matterTitle: String(t.matter_title), date: t.entry_date, minutes: Number(t.minutes),
        narrative: String(t.narrative), narrativeAr: t.narrative_ar ?? null,
        billable: Boolean(t.billable), rate: Number(t.hourly_rate_sar), amount: Number(t.amount_sar),
        status: String(t.status), staffName: String(t.staff_name), invoiceId: t.invoice_id ?? null,
      })),
    });
  }));

  /**
   * Record an hour.
   *
   * THE RATE IS RESOLVED FROM THE CARD AND THE AMOUNT FROM THE MINUTES. Neither is
   * taken from the caller: a fee is the product of a recorded duration and a recorded
   * rate, and a caller who can supply either number can bill anything. When no card
   * matches, the refusal says so rather than falling back to a default — an hour billed
   * at a guessed rate is worse than an hour that waits for its card.
   */
  r.post('/time-entries', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
      matterId: z.string().uuid(),
      staffId: z.string().uuid().optional(),
      entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      minutes: z.number().int().positive().max(1440),
      narrative: z.string().trim().min(5).max(2000),
      narrativeAr: z.string().trim().max(2000).nullable().optional(),
      billable: z.boolean().default(true),
    }).strict(),
      req, c, '/time-entries',
    );

    c.permissions.assertCan(p, 'time.create', { type: 'time_entry' });

    /*
      An hour is recorded for oneself unless the caller holds time.adjust, which is the
      permission for touching other people's time. Without this, time.create would be a
      way to write hours onto a colleague's timesheet.
    */
    const staffId = body.staffId ?? p.staffId;
    if (!staffId) throw badRequest('validation_failed', 'no staff record is linked to this membership');
    if (staffId !== p.staffId && !c.permissions.can(p, 'time.adjust')) {
      throw forbidden('forbidden', 'recording time for another member needs time.adjust');
    }

    /*
      A NON-BILLABLE HOUR HAS NO PRICE, and that is not a missing rate card — it is the
      definition. Requiring a card here would make it impossible to record pro bono or
      admin time on a matter that has none, which is the opposite of what the rule
      intends: the fixture itself carries exactly such an hour.
    */
    let rate = 0;
    if (body.billable) {
      const card = await c.firm.rateFor(staffId, body.entryDate);
      if (card === null) {
        throw badRequest('validation_failed',
          'no rate card applies to this member on that date — record the rate before recording the hour');
      }
      rate = card;
    }

    /* THE ENGAGEMENT GATE, ASKED EARLY. The database refuses a billable hour without a
       signed engagement and current terms; asking here means the refusal arrives with
       its reason and is audited, rather than surfacing as a constraint violation. */
    if (body.billable) {
      const billable = await c.firm.matterBillable(body.matterId);
      if (!billable) {
        await c.audit.tryWrite({
          action: 'ENGAGEMENT_GATE_DENIED',
          actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
          outcome: 'denied', reasonCode: 'engagement_gate',
          resourceType: 'matter', resourceId: body.matterId,
          metadata: { minutes: body.minutes, rule: 'engagement and fee-writing requirements' },
        }, requestInfo(req, c.trustProxy));
        throw badRequest('engagement_gate',
          'billable time requires a signed engagement letter and current billing terms on this matter');
      }
    }

    const id = await c.firm.recordTimeEntry({
      tenantId: p.tenantId, matterId: body.matterId, staffId, entryDate: body.entryDate,
      minutes: body.minutes, narrative: body.narrative, narrativeAr: body.narrativeAr ?? null,
      billable: body.billable, hourlyRateSar: rate,
    });

    await c.audit.tryWrite({
      action: 'TIME_ENTRY_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'time_entry', resourceId: id,
      metadata: { matterId: body.matterId, minutes: body.minutes, rate, billable: body.billable },
    }, requestInfo(req, c.trustProxy));

    ok(res, {
      id, rate, amount: round2((body.minutes / 60) * rate), billable: body.billable,
      // The stored figures, restated: a non-billable hour carries 0 and 0, which is what
      // makes "unbillable time" a queryable fact rather than a rate of zero that nobody
      // can distinguish from an unpriced one.
    }, 201);
  }));

  r.post('/time-entries/:id/adjust', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const entryId = String(req.params.id);
    c.permissions.assertCan(p, 'time.adjust', { type: 'time_entry', id: entryId });
    const body = strictBody(
      z.object({
      status: z.enum(['draft', 'submitted', 'approved', 'written_off', 'non_billable']).optional(),
      minutes: z.number().int().positive().max(1440).nullable().optional(),
      narrative: z.string().trim().min(5).max(2000).nullable().optional(),
      writtenOffReason: z.string().trim().min(5).max(500).nullable().optional(),
    }).strict(),
      req, c, '/time-entries/:id/adjust',
    );
    if (body.status === 'written_off' && !body.writtenOffReason) {
      throw badRequest('validation_failed', 'writing off recorded time needs a reason');
    }

    const entry = await c.firm.getTimeEntry(p.tenantId, entryId);
    if (!entry) throw notFoundOrForbidden('time_entry', entryId);
    await c.permissions.requireMatter(p, String(entry.matter_id), MATTER_FINANCIAL);

    const changed = await c.firm.adjustTimeEntry({
      tenantId: p.tenantId, entryId, status: body.status ?? null,
      minutes: body.minutes ?? null, narrative: body.narrative ?? null,
      writtenOffReason: body.writtenOffReason ?? null, approvedByUserId: p.userId,
    });
    if (changed === 0) throw notFoundOrForbidden('time_entry', entryId);

    await c.audit.tryWrite({
      action: body.status === 'written_off' ? 'TIME_WRITTEN_OFF' : 'TIME_ENTRY_ADJUSTED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'time_entry', resourceId: entryId,
      metadata: {
        matterId: String(entry.matter_id), status: body.status ?? null,
        minutes: body.minutes ?? null, reason: body.writtenOffReason ?? null,
        // Whether this entry was already on an invoice decides what the caller may do
        // next: past this point, corrections go through a credit note, not an edit.
        alreadyBilled: entry.invoice_id !== null,
      },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id: entryId, adjusted: true, alreadyBilled: entry.invoice_id !== null });
  }));

  r.get('/expenses', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'expenses.read', { type: 'expense_collection' });
    const matterId = typeof req.query.matterId === 'string' ? req.query.matterId : null;
    if (matterId) await c.permissions.requireMatter(p, matterId, MATTER_FINANCIAL);
    const rows = await c.firm.listExpenses(p.tenantId, { matterId });
    ok(res, {
      count: rows.length,
      expenses: rows.map((e) => ({
        id: String(e.id), matterId: String(e.matter_id), matterNumber: String(e.matter_number),
        incurredOn: e.incurred_on, category: String(e.category), description: String(e.description),
        net: Number(e.net_amount_sar), vat: Number(e.vat_amount_sar), total: Number(e.total_amount_sar),
        reimbursable: Boolean(e.reimbursable), status: String(e.status),
        receiptDocumentId: e.receipt_document_id ?? null,
        approvedAt: e.approved_at ?? null, rejectionReason: e.rejection_reason ?? null,
        submittedBy: String(e.staff_name),
      })),
    });
  }));

  r.post('/expenses', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
      matterId: z.string().uuid(),
      incurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      category: z.enum(['court_fee', 'filing_fee', 'expert', 'translation', 'notarisation',
        'travel', 'courier', 'government_fee', 'other']),
      description: z.string().trim().min(3).max(500),
      descriptionAr: z.string().trim().max(500).nullable().optional(),
      netAmountSar: z.number().min(0),
      vatAmountSar: z.number().min(0).default(0),
      vatCategory: z.enum(['standard', 'zero_rated', 'exempt', 'out_of_scope']).default('standard'),
      receiptDocumentId: z.string().uuid().nullable().optional(),
      reimbursable: z.boolean().default(true),
    }).strict(),
      req, c, '/expenses',
    );

    c.permissions.assertCan(p, 'expenses.create', { type: 'expense' });
    await c.permissions.requireMatter(p, body.matterId, MATTER_WRITE);

    /*
      A REIMBURSABLE DISBURSEMENT WITHOUT ITS RECEIPT IS REFUSED AT SUBMISSION, not at
      approval. Refusing it later would put the burden on the person who paid the fee to
      remember it days afterwards; refusing it now, while the receipt is still in their
      hand, is the only version of this control that survives contact with practice.
    */
    if (body.reimbursable && !body.receiptDocumentId) {
      throw badRequest('expense_receipt_required',
        'a reimbursable disbursement must attach the receipt being passed to the client');
    }

    const matter = await c.firm.getMatterClient(p.tenantId, body.matterId);
    if (!matter) throw notFoundOrForbidden('matter', body.matterId);
    if (!p.staffId) throw badRequest('validation_failed', 'no staff record is linked to this membership');

    const total = round2(body.netAmountSar + body.vatAmountSar);
    const id = await c.firm.recordExpense({
      tenantId: p.tenantId, matterId: body.matterId, clientId: matter.clientId,
      submittedByStaff: p.staffId, incurredOn: body.incurredOn, category: body.category,
      description: body.description, descriptionAr: body.descriptionAr ?? null,
      netAmountSar: round2(body.netAmountSar), vatAmountSar: round2(body.vatAmountSar),
      totalAmountSar: total, vatCategory: body.vatCategory,
      receiptDocumentId: body.receiptDocumentId ?? null, reimbursable: body.reimbursable,
    });
    await c.audit.tryWrite({
      action: 'EXPENSE_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'expense', resourceId: id,
      metadata: { matterId: body.matterId, category: body.category, total, reimbursable: body.reimbursable },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id, total }, 201);
  }));

  r.post('/expenses/:id/decision', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const expenseId = String(req.params.id);
    const body = strictBody(
      z.object({
      decision: z.enum(['approved', 'rejected']),
      rejectionReason: z.string().trim().min(5).max(500).nullable().optional(),
    }).strict(),
      req, c, '/expenses/:id/decision',
    );
    if (body.decision === 'rejected' && !body.rejectionReason) {
      throw badRequest('validation_failed', 'a rejection needs a reason the submitter can act on');
    }

    /*
      THE GATE, THEN THE READ. The permission is checked before the expense is looked
      up, so a member without expenses.approve is refused without the record being
      fetched at all; the matter scope follows, and the ceiling follows that.
    */
    c.permissions.assertCan(p, 'expenses.approve', { type: 'expense', id: expenseId });

    const expense = await c.firm.getExpense(p.tenantId, expenseId);
    if (!expense) throw notFoundOrForbidden('expense', expenseId);
    await c.permissions.requireMatter(p, String(expense.matter_id), MATTER_FINANCIAL);

    /*
      Approving a disbursement is spending a client's money on their behalf, so it
      carries the member's write-off ceiling — the same ceiling the trust ledger applies
      to an outgoing payment, because it is the same act one step earlier in the process.
      The value at risk is the TOTAL being approved.
    */
    if (body.decision === 'approved') {
      c.permissions.assertWithinAuthority(p, 'writeoff', Number(expense.total_amount_sar), {
        type: 'expense', id: expenseId,
      });
    }

    const changed = await c.firm.decideExpense({
      tenantId: p.tenantId, expenseId, decision: body.decision,
      approvedByUserId: p.userId, rejectionReason: body.rejectionReason ?? null,
    });
    if (changed === 0) throw conflict('entry_already_billed', 'this expense has already been decided');

    await c.audit.tryWrite({
      action: body.decision === 'approved' ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: body.decision === 'approved' ? 'success' : 'denied',
      reasonCode: body.rejectionReason ?? undefined,
      resourceType: 'expense', resourceId: expenseId,
      metadata: { matterId: String(expense.matter_id), total: Number(expense.total_amount_sar) },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id: expenseId, decision: body.decision });
  }));

  /* ══════════════════════════════════════════════════════════════════════════
   * P1.3 · THE TWO CEILINGS, THROUGH THE SAME THREE-STEP GATE AS APPROVAL
   * ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Discount an invoice.
   *
   * THE THREE STEPS, IN ORDER, AND THE ORDER IS THE CONTROL:
   *   1. the PERMISSION (`billing.discount`) — may this member discount at all;
   *   2. the CEILING (`discount_pct`) — up to what percentage;
   *   3. apply.
   *
   * A route that checked only the permission is precisely the defect the financial
   * security section asks to be tested for, and it was live here until this work: the
   * discount ceiling was seeded, displayed on the member's record, and read by nothing.
   *
   * The percentage is COMPUTED from the request, never accepted from it: a caller who
   * could state the percentage could state a smaller one than the discount they asked
   * for, and the ceiling would be checked against the wrong number.
   */
  r.post('/billing/invoices/:id/discount', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const invoiceId = String(req.params.id);
    const body = strictBody(
      z.object({
      newSubtotal: z.number().min(0),
      reason: z.string().trim().min(5).max(500),
    }).strict(),
      req, c, '/billing/invoices/:id/discount',
    );

    const invoice = await c.firm.getInvoiceForApproval(p.tenantId, invoiceId);
    if (!invoice) throw notFoundOrForbidden('invoice', invoiceId);
    if (invoice.subtotal <= 0) throw badRequest('validation_failed', 'this invoice has no subtotal to discount');
    if (body.newSubtotal >= invoice.subtotal) {
      throw badRequest('validation_failed', 'a discount reduces the subtotal — an increase goes on as a new line');
    }

    const discountPct = round2(((invoice.subtotal - body.newSubtotal) / invoice.subtotal) * 100);

    // Steps 1 and 2, together, through the method that exists so the two cannot drift
    // apart in one route and not another — the PERMISSION and the CEILING, before the
    // matter is looked at, so a member without either is refused for the right reason.
    c.permissions.assertCanApproveAmount(p, 'billing.discount', 'discount_pct', discountPct, {
      type: 'invoice', id: invoiceId,
    });
    if (invoice.matterId) await c.permissions.requireMatter(p, invoice.matterId, MATTER_FINANCIAL);

    const changed = await c.firm.applyDiscount({
      tenantId: p.tenantId, invoiceId, newSubtotal: round2(body.newSubtotal),
      membershipId: p.membershipId, discountPct,
    });
    if (changed === 0) {
      throw conflict('issued_invoice_immutable',
        'only a draft or unapproved invoice can be discounted — an issued invoice is corrected by credit note');
    }

    await c.audit.tryWrite({
      action: 'DISCOUNT_APPLIED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'invoice', resourceId: invoiceId,
      metadata: {
        from: invoice.subtotal, to: round2(body.newSubtotal), discountPct, reason: body.reason,
      },
    }, requestInfo(req, c.trustProxy));

    ok(res, { id: invoiceId, subtotal: round2(body.newSubtotal), discountPct });
  }));

  /**
   * Write off an outstanding balance.
   *
   * The amount at risk is the OUTSTANDING figure, not the invoice total — the same
   * choice invoice approval makes, and for the same reason: a member with a 5,000
   * write-off ceiling must not be able to abandon a 60,000 balance simply because the
   * invoice it sits on happens to be for 60,000.
   */
  r.post('/billing/invoices/:id/write-off', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const invoiceId = String(req.params.id);
    const body = strictBody(
      z.object({
      reason: z.string().trim().min(10).max(1000),
    }).strict(),
      req, c, '/billing/invoices/:id/write-off',
    );

    const invoice = await c.firm.getInvoiceForApproval(p.tenantId, invoiceId);
    if (!invoice) throw notFoundOrForbidden('invoice', invoiceId);
    if (invoice.outstanding <= 0) {
      throw badRequest('validation_failed', 'there is no outstanding balance to write off');
    }

    c.permissions.assertCanApproveAmount(p, 'billing.writeoff', 'writeoff', invoice.outstanding, {
      type: 'invoice', id: invoiceId,
    });
    if (invoice.matterId) await c.permissions.requireMatter(p, invoice.matterId, MATTER_FINANCIAL);

    const changed = await c.firm.writeOffInvoice({
      tenantId: p.tenantId, invoiceId, amountSar: invoice.outstanding,
      reason: body.reason, approvedByStaff: p.staffId ?? p.membershipId,
    });
    if (changed === 0) {
      throw conflict('issued_invoice_immutable', 'only a sent, partly paid or overdue invoice can be written off');
    }

    /*
      A WRITE-OFF ADJUSTS NO TAX. The invoice stands as issued, with its VAT, because
      the supply happened; what stops is the pursuit of the balance. Recording that
      distinction is what keeps the revenue figure and the collection figure separately
      answerable.
    */
    await c.audit.tryWrite({
      action: 'WRITE_OFF_APPROVED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'invoice', resourceId: invoiceId,
      metadata: {
        outstandingWrittenOff: invoice.outstanding, reason: body.reason,
        // Explicit, because the question asked afterwards is always whether the invoice
        // was also revised. It was not, and the audit row says so.
        invoiceLeftIssued: true,
      },
    }, requestInfo(req, c.trustProxy));

    ok(res, { id: invoiceId, writtenOff: invoice.outstanding, status: 'written_off', taxAdjusted: false });
  }));

  return r;
}

/**
 * The session payload returned to the firm SPA.
 *
 * Deliberately includes the permission CODES: the frontend needs them to decide
 * what to render, and hiding them would only push the UI towards guessing. It
 * does NOT include ceilings as authoritative limits — the UI may show them, but
 * every financial action is re-checked server-side against the database value.
 */
function sessionPayload(s: import('../auth/firm-session.js').FirmSession) {
  const p = s.principal;
  return {
    member: {
      membershipId: p.membershipId,
      userId: p.userId,
      email: p.email,
      displayName: p.displayName,
      displayNameAr: p.displayNameAr,
      jobTitle: p.jobTitle,
      jobTitleAr: p.jobTitleAr,
      roles: p.roles.map((r) => ({ code: r.code, name: r.name, nameAr: r.nameAr })),
      departments: p.departments.map((d) => ({ code: d.code, name: d.name, nameAr: d.nameAr, isLead: d.isLead })),
      practiceAreas: [...p.practiceAreas],
      firmWideScope: p.practiceAreas.has('*') || p.permissions.has('matters.read_all'),
      permissions: [...p.permissions].sort(),
      ceilings: p.ceilings,
    },
    preferences: { language: p.language, calendar: p.calendar },
    security: {
      mfaEnabled: p.mfaEnabled,
      mfaVerified: s.mfaVerified,
      sessionExpiresAt: s.sessionExpiresAt,
      remembered: s.remembered,
    },
    tenants: s.tenants,
    activeTenantId: p.tenantId,
  };
}
