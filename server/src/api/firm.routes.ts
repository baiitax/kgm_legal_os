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
import { badRequest, forbidden, notFoundOrForbidden } from '../lib/errors.js';
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
