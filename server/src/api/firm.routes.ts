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
import {
  badRequest, conflict, forbidden, notFoundOrForbidden, toPortalError,
} from '../lib/errors.js';
import { normalizeArabicName, normalizeIdentifier } from '../domain/arabic-names.js';
import { evaluateConflicts } from '../domain/conflict-engine.js';
import { keyedHash, maskNationalId, maskRegistration } from '../lib/crypto.js';
import { ah } from '../auth/middleware.js';
import { requestInfo } from '../audit/logger.js';
import {
  attachFirmPrincipal, requireFirm, firmCsrfGuard, ensureFirmCsrf, requireFirmMfa,
} from '../auth/firm-middleware.js';
import {
  MATTER_READ, MATTER_WRITE, MATTER_MANAGE, MATTER_FINANCIAL, MATTER_OPERATE,
  ACCESS_LEVELS, type AccessLevel,
} from '../domain/permissions.js';
import { projectMatter, projectMatterList } from '../domain/classification.js';
import {
  DISCLOSURE_GROUND_CODES, DISCLOSURE_RECIPIENTS, groundOf, groundPermits,
} from '../domain/privilege.js';
import {
  MATTER_TEAM_ROLES, MATTER_TEAM_LABELS, HIDDEN_MATTER_ROLES,
} from '../domain/matter-team.js';
import {
  SERVICE_TAKING_OUTCOMES,
  COURT_WEEKEND_DAYS,
  appealDeadlineAt,
  appealRulesCatalogue,
  assessJudgment,
  addDaysToInstant,
  canMoveEnforcement,
  enforcementRegister,
  executionOutcome,
  hijriDateOf,
  operativeJudgment,
  ruleFor,
  serviceEffect,
  type AppealKind,
  type AppealOutcome,
  type AppealStatus,
  type EnforcementStatus,
  type JudgmentFacts,
  type JudgmentKind,
  type ReliefKind,
} from '../domain/judgments.js';
import {
  UBO_THRESHOLD_PCT, REVIEW_MONTHS, assessCdd, activationOutcome, containsArabic, deriveRisk,
  isThresholdOwner, ownershipCoverage, requirementsFor, reviewDueAt, screeningState,
  screeningSubjects, strDueAt, strReadiness, STR_INDICATORS,
  type CddFacts, type OwnerFacts, type ScreeningRunFacts, type ScreeningSubjectKind,
} from '../domain/aml.js';
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
          { principal: p, accessLevel: m.accessLevel, ring: p.ring },
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


  // ══════════════════════════════════════════════════════════════════════════
  // TASK 25 · INTAKE — open a client, open a matter, staff it, report on it
  //
  // WHY THIS BLOCK EXISTS. The system could do everything to a case except open
  // one. `POST /matters` did not exist; neither did `POST /clients`; `matter_team`
  // had no insert route and, more to the point, `firm_api` held NO INSERT privilege
  // on it, so the feature was not merely unbuilt — it was IMPOSSIBLE, and no front
  // end could have made it work. Migration 0058 opens the four writes; this is the
  // route layer on top, and the two are one change.
  //
  // WHAT MAKES IT A WORKFLOW RATHER THAN FOUR FORMS. The stages a firm runs in one
  // sitting are the same four stages, and every hand-off between them is a place a
  // case gets lost: a client recorded under a name the conflict engine will not
  // match, a matter opened with nobody answerable for it, a check that never ran.
  // So each route does the WHOLE of its stage inside one transaction, and each one
  // carries the next stage's evidence forward:
  //
  //   POST /clients        → normalises the name the conflict engine will search on
  //   GET  /matters/new    → ONE call for what the opening form needs, including
  //                          the matter number it will receive
  //   POST /matters        → matter + lead assignment + conflict check + opening
  //                          timeline entry, atomically
  //   POST /matters/:id/team → assignment, with the §11 role rule applied
  //   PATCH /matters/:id/report → the case report, and the client-facing summary in
  //                          the same write
  //
  // WHAT IT DELIBERATELY DOES NOT DO. Nothing here asserts `conflict_cleared`: the
  // matter is born unclear and the derived state clears it (0032, and the SQLite
  // trigger that mirrors it). Nothing here accepts `internal_status` from a caller
  // on create, because a matter cannot be born active — the CDD gate guards that
  // transition and it is guarded in `POST /matters/:id/status`. Nothing here writes
  // `internal_notes` or `risk_rating`: 0054 removed them from the application role
  // and P0.5 routes them through the ring, and an intake form is not a way round it.
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The client register.
   *
   * `clients.read` opens it, and the payload carries no `national_id_hash` — the
   * register is for choosing a client, not for verifying one.
   */
  r.get('/clients', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'clients.read', { type: 'client_collection' });
    const query = typeof req.query.q === 'string' && req.query.q.trim()
      ? req.query.q.trim() : undefined;
    const clients = await c.firm.listClientsForPicker(p.tenantId, { query });
    ok(res, { count: clients.length, clients });
  }));

  /**
   * ADD CLIENT.
   *
   * THE NAME IS NORMALISED HERE, ONCE, BY THE MODULE THE CONFLICT ENGINE USES. A
   * client created through this route is findable by the conflict search on the
   * first attempt; a client created by writing `name` alone is a client the firm
   * can act for and cannot check, which is the defect the intake stage exists to
   * prevent. `normalizeArabicName` strips the definite article, the honorifics and
   * the tatweel — so «شركة الأفق التجاري» and "Al-Afaq Trading Co." reach the same
   * key, and the engine's fallback to the client's own name columns still works.
   *
   * IDENTITY IS MASKED AND HASHED, NEVER STORED. The plaintext national id arrives,
   * is masked for display and hashed for matching, and is dropped: the same
   * convention `POST /parties` follows, and the reason `clients` has a
   * `national_id_masked` column and a `national_id_hash` column rather than a
   * national id column.
   *
   * A DUPLICATE IS A QUESTION, NOT A REFUSAL. If the normalised name is already on
   * the register the route answers 409 with the matches it found — because two
   * clients with one name is how a firm ends up with two conflict searches that
   * each see half the truth. `confirmDuplicate: true` records the decision and
   * proceeds; the audit row carries that it was confirmed, so the choice is
   * reviewable rather than invisible.
   */
  r.post('/clients', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        clientType: z.enum(['individual', 'organization']),
        name: z.string().trim().min(2).max(300),
        nameAr: z.string().trim().min(2).max(300).optional().nullable(),
        email: z.string().trim().email().max(200).optional().nullable(),
        phone: z.string().trim().max(40).optional().nullable(),
        addressLine: z.string().trim().max(300).optional().nullable(),
        city: z.string().trim().max(120).optional().nullable(),
        country: z.string().trim().length(2).default('SA'),
        /** Plaintext in, masked + hashed out. Never stored. */
        nationalId: z.string().trim().max(40).optional().nullable(),
        commercialRegistration: z.string().trim().max(40).optional().nullable(),
        identityVerified: z.boolean().default(false),
        verificationNote: z.string().trim().max(500).optional().nullable(),
        /** The answer to the 409 below, recorded rather than assumed. */
        confirmDuplicate: z.boolean().default(false),
      }).strict(),
      req, c, '/api/firm/clients',
    );

    c.permissions.assertCan(p, 'clients.create', { type: 'client_collection' });

    const normalized = normalizeArabicName(
      [body.nameAr, body.name].filter(Boolean).join(' '));
    if (!normalized) throw badRequest('name_unusable', 'this name has no searchable characters');

    const matches = await c.firm.findClientByName(p.tenantId, body.name, body.nameAr ?? null);
    if (matches.length && !body.confirmDuplicate) {
      /*
        A 409 with the matches in the body. The caller is not being told "no": they
        are being told what the firm already holds, which is the information they
        need and did not have.
      */
      throw conflict('client_name_exists',
        `${matches.length} client(s) are already on the register under this name`,
        { matches });
    }

    const id = newId();
    const now = new Date().toISOString();
    await c.firm.tx(async () => {
      await c.firm.createClient({
        id, tenantId: p.tenantId, clientType: body.clientType, name: body.name,
        nameAr: body.nameAr ?? null,
        nationalIdMasked: maskNationalId(body.nationalId ?? null),
        nationalIdHash: body.nationalId ? keyedHash(body.nationalId.trim()) : null,
        commercialRegMasked: maskRegistration(body.commercialRegistration ?? null),
        email: body.email ?? null, phone: body.phone ?? null,
        addressLine: body.addressLine ?? null, city: body.city ?? null,
        country: body.country, status: 'active',
        identityVerified: body.identityVerified,
        verificationNote: body.verificationNote ?? null,
      });
      await c.audit.write({
        action: 'CLIENT_CREATED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'client', resourceId: id, outcome: 'success',
        metadata: {
          membershipId: p.membershipId, clientType: body.clientType,
          hasIdentity: !!body.nationalId, hasRegistration: !!body.commercialRegistration,
          // Not the name. An audit trail a client can read is one thing; copying
          // the register into it in bulk is another.
          confirmedDuplicate: body.confirmDuplicate, duplicatesFound: matches.length,
        },
      }, requestInfo(req, c.trustProxy));
    });

    ok(res, { id, name: body.name, nameAr: body.nameAr ?? null, normalized, createdAt: now }, 201);
  }));

  /**
   * COMPLETE OR CORRECT A CLIENT.
   *
   * The columns here are the ones 0058 granted, which is the list the client record
   * is MADE of rather than the table's columns: `party_id` is absent, so an edit
   * cannot silently change what the conflict engine will find (that is
   * `POST /clients/:id/party`, with its own authority), and the identity fields are
   * write-only in the sense that a hash goes in and nothing comes back.
   */
  r.patch('/clients/:id', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const clientId = String(req.params.id);
    const body = strictBody(
      z.object({
        clientType: z.enum(['individual', 'organization']).optional(),
        name: z.string().trim().min(2).max(300).optional(),
        nameAr: z.string().trim().max(300).optional().nullable(),
        email: z.string().trim().email().max(200).optional().nullable(),
        phone: z.string().trim().max(40).optional().nullable(),
        addressLine: z.string().trim().max(300).optional().nullable(),
        city: z.string().trim().max(120).optional().nullable(),
        country: z.string().trim().length(2).optional(),
        status: z.enum(['active', 'inactive', 'restricted']).optional(),
        nationalId: z.string().trim().max(40).optional().nullable(),
        commercialRegistration: z.string().trim().max(40).optional().nullable(),
        identityVerified: z.boolean().optional(),
        verificationNote: z.string().trim().max(500).optional().nullable(),
      }).strict(),
      req, c, '/api/firm/clients/:id',
    );

    c.permissions.assertCan(p, 'clients.update', { type: 'client', id: clientId });
    // The row is looked up FIRST so an unknown or another firm's client is a 404
    // rather than a silent zero-row update (trap (m)).
    const existing = await c.firm.getClientForTenant(p.tenantId, clientId);
    if (!existing) throw notFoundOrForbidden('client', clientId);

    const patch: Parameters<typeof c.firm.updateClient>[0]['patch'] = {};
    if (body.clientType !== undefined) patch.clientType = body.clientType;
    if (body.name !== undefined) patch.name = body.name;
    if (body.nameAr !== undefined) patch.nameAr = body.nameAr;
    if (body.email !== undefined) patch.email = body.email;
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.addressLine !== undefined) patch.addressLine = body.addressLine;
    if (body.city !== undefined) patch.city = body.city;
    if (body.country !== undefined) patch.country = body.country;
    if (body.status !== undefined) patch.status = body.status;
    if (body.identityVerified !== undefined) patch.identityVerified = body.identityVerified;
    if (body.verificationNote !== undefined) patch.verificationNote = body.verificationNote;
    if (body.commercialRegistration !== undefined) {
      patch.commercialRegMasked = maskRegistration(body.commercialRegistration);
    }
    if (body.nationalId !== undefined) {
      patch.nationalIdMasked = maskNationalId(body.nationalId);
      patch.nationalIdHash = body.nationalId ? keyedHash(body.nationalId.trim()) : null;
    }
    if (!Object.keys(patch).length) throw badRequest('nothing_to_update', 'no fields were supplied');

    const changed = await c.firm.updateClient({ tenantId: p.tenantId, clientId, patch });
    await c.audit.tryWrite({
      action: 'CLIENT_UPDATED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      resourceType: 'client', resourceId: clientId, outcome: 'success',
      metadata: { membershipId: p.membershipId, fields: Object.keys(patch).sort() },
    }, requestInfo(req, c.trustProxy));

    ok(res, { id: clientId, changed });
  }));

  /**
   * INVITE THE CLIENT'S PEOPLE TO THE PORTAL.
   *
   * This is the fifth hand-off in intake and the one the firm had no way to make:
   * `client_invitations` could be written by the portal in the AUTH phase and by
   * nobody else, so "invitation-only onboarding" was a property of a demo route
   * (`POST /api/dev/invite`) rather than of the product. 0058 grants and admits the
   * firm's insert; this is the route, and it is the firm's own access grant being
   * made — which is why it needs `clients.update` rather than anything weaker.
   *
   * THE OWNERSHIP CHECK IS THE POINT. An invitation names a client AND a tenant.
   * The route resolves the client inside the caller's tenant before minting
   * anything, so a firm member cannot invite a user into another firm's client —
   * the one write that would cross the tenant boundary the whole system rests on.
   *
   * The link is returned as well as emailed: in production the email is the
   * delivery path, but a firm that has just typed an address in wants to be able to
   * hand it over, and the token is single-use, expiring and bound server-side.
   */
  r.post('/clients/:clientId/invitations', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const clientId = String(req.params.clientId);
    const body = strictBody(
      z.object({
        email: z.string().trim().email().max(200),
        displayName: z.string().trim().min(2).max(120),
        displayNameAr: z.string().trim().max(120).optional().nullable(),
        portalRole: z.enum(['client_primary', 'client_contact']).default('client_contact'),
      }).strict(),
      req, c, '/api/firm/clients/:clientId/invitations',
    );

    c.permissions.assertCan(p, 'clients.update', { type: 'client', id: clientId });
    const client = await c.firm.getClientForTenant(p.tenantId, clientId);
    if (!client) throw notFoundOrForbidden('client', clientId);

    const out = await c.auth.createInvitation(requestInfo(req, c.trustProxy), {
      tenantId: p.tenantId, clientId, email: body.email, displayName: body.displayName,
      displayNameAr: body.displayNameAr ?? undefined, portalRole: body.portalRole,
      createdByStaff: p.staffId ?? undefined,
    });

    /*
      A client with no email address on file gets one, because an invitation sent to
      a person the register cannot name is a portal account nobody can find again.
      The client's own address is preferred and never overwritten.
    */
    if (!client.email) {
      await c.firm.updateClient({
        tenantId: p.tenantId, clientId, patch: { email: body.email.toLowerCase() },
      });
    }

    ok(res, {
      /*
        The LINK, and not the token separately: the token is single-use, expiring and
        bound server-side, and handing the same secret back under two names invites
        one of them to be logged.
      */
      link: out.link, expiresAt: out.expiresAt,
      portalRole: body.portalRole, email: body.email,
    }, 201);
  }));

  /**
   * WHAT THE OPENING FORM NEEDS, IN ONE CALL.
   *
   * Efficiency is the requirement, so the form that opens a matter does not make
   * four round trips: it receives the client register it will choose from, the
   * people it can assign, the practice areas this firm actually uses, and THE
   * MATTER NUMBER IT IS ABOUT TO BE GIVEN — allocated read-only here and reserved
   * for real at create, so nobody has to ask what the file will be called.
   */
  r.get('/matters/new', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'matters.create', { type: 'matter_collection' });

    const [clients, staff, tenant] = await Promise.all([
      c.firm.listClientsForPicker(p.tenantId, {}),
      c.firm.listAssignableStaff(p.tenantId),
      c.firm.getTenant(p.tenantId),
    ]);

    const prefix = String(tenant?.slug ?? 'M').toUpperCase().slice(0, 8);
    const proposed = await c.firm.allocateMatterNumber(p.tenantId, prefix);

    /*
      The practice areas offered are the ones THIS firm already runs matters under,
      plus the areas the member is scoped to. A form that offers a fixed list of
      thirty areas to a firm that practises in four produces intake data the reports
      cannot group — and the firm's own vocabulary is the only one that matters.
    */
    const existing = await c.firm.listPracticeAreasInUse(p.tenantId);
    const scoped = [...p.practiceAreas].filter((a) => a !== '*');
    const practiceAreas = [...new Set([...scoped, ...existing])].sort();

    ok(res, {
      clients: clients.map((cl) => ({
        id: cl.id, name: cl.name, nameAr: cl.nameAr, clientType: cl.clientType,
        status: cl.status, matterCount: cl.matterCount, lastMatterAt: cl.lastMatterAt,
      })),
      staff: staff.map((s) => ({
        staffId: s.staffId, name: s.name, nameAr: s.nameAr, role: s.internalRole,
        jobTitle: s.jobTitle, jobTitleAr: s.jobTitleAr, roleCodes: s.roleCodes,
        activeMatters: s.activeMatters,
      })),
      practiceAreas,
      matterNumber: { proposed, prefix },
      roles: MATTER_TEAM_ROLES,
    });
  }));

  /**
   * ADD THE CASE — matter, lead, conflict check and opening entry, atomically.
   *
   * THE FOUR WRITES ARE ONE TRANSACTION BECAUSE ANY THREE OF THEM IS WORSE THAN
   * NONE. A matter with no lead is a file nobody answers for. A matter with no
   * conflict check looks, on every screen and in every report, exactly like a matter
   * that was cleared — and Rule 11's gate then holds it in `conflict_check` with no
   * way out until somebody notices. A matter with neither, plus a number consumed,
   * is the state that teaches a firm to work outside the system.
   *
   * THE MATTER IS BORN IN `conflict_check` WHEN A PARTY IS KNOWN AND THE CHECK
   * CANNOT CLEAR, and otherwise in `intake`. Both are non-active: this route cannot
   * create an active matter, because the CDD gate guards that transition and intake
   * is where a firm is most tempted to skip it. The promotion is one call to
   * `POST /matters/:id/status` once the register is satisfied — which is also the
   * call that asks for the documents.
   *
   * THE CONFLICT CHECK RUNS INSIDE THE TRANSACTION IT CREATED THE ROWS FOR. That is
   * the whole reason the engine takes a dataset rather than a matter id: it reads
   * the firm's history AND the rows written milliseconds ago, so the check covers the
   * client and the parties as they are, not as they were before the transaction.
   *
   * IT CANNOT CLEAR THE MATTER, AND THAT IS THE DESIGN. `concludeConflictCheck` and
   * the `conflict_cleared` column belong to the conclusion route, where a human
   * dispositions every finding first. A create route that cleared its own new matter
   * would be a way to open a file on a conflicted party without anybody deciding
   * anything — the exact workaround Rule 8 exists to stop.
   */
  r.post('/matters', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        clientId: z.string().uuid(),
        title: z.string().trim().min(2).max(300),
        titleAr: z.string().trim().max(300).optional().nullable(),
        /** Omit to have one allocated from the firm's own sequence. */
        matterNumber: z.string().trim().min(3).max(40).optional().nullable(),
        caseNumber: z.string().trim().max(60).optional().nullable(),
        practiceArea: z.string().trim().max(120).optional().nullable(),
        practiceAreaAr: z.string().trim().max(120).optional().nullable(),
        court: z.string().trim().max(200).optional().nullable(),
        courtAr: z.string().trim().max(200).optional().nullable(),
        summary: z.string().trim().max(4000).optional().nullable(),
        summaryAr: z.string().trim().max(4000).optional().nullable(),
        /** Who answers for the file. Assignment is not a second visit to the form. */
        leadStaffId: z.string().uuid().optional().nullable(),
        leadRole: z.enum(['lead_partner', 'lead_lawyer']).default('lead_lawyer'),
        /** Anyone else who should be on it from the first minute. */
        team: z.array(z.object({
          staffId: z.string().uuid(),
          matterRole: z.enum(MATTER_TEAM_ROLES),
          clientRoleLabel: z.string().trim().max(80).optional().nullable(),
          clientRoleLabelAr: z.string().trim().max(80).optional().nullable(),
        }).strict()).max(20).default([]),
        /*
          THERE IS NO "SHOW THE OPENING TO THE CLIENT" FLAG, because the answer is always
          yes. `matter_timeline` is the client's own chronology and 0048 admits only
          client-visible appends: "a firm that could write a hidden row into the timeline
          could put an account of events into the portal's table that the client's own
          session will never render — an internal note in the wrong drawer." An opening
          entry the firm could hide would be exactly that, so the option was removed
          rather than defaulted to true-and-ignored. What the client may NOT see belongs in
          `internal_notes`, which the ring governs.
        */
        runConflictCheck: z.boolean().default(true),
        kind: z.enum(['intake', 'adverse_check', 'periodic', 'recheck']).default('intake'),
      }).strict(),
      req, c, '/api/firm/matters',
    );

    c.permissions.assertCan(p, 'matters.create', { type: 'matter_collection' });

    /*
      THE CLIENT FIRST, IN THIS TENANT. Not merely for the 404: `matters.client_id`
      is a foreign key, so a client of another firm would be accepted by the
      constraint and would then be unreachable through every policy — a matter
      nobody can see, holding a number from this firm's sequence.
    */
    const client = await c.firm.getClientForTenant(p.tenantId, body.clientId);
    if (!client) throw notFoundOrForbidden('client', body.clientId);

    /*
      THE LEAD IS RESOLVED BEFORE ANYTHING IS WRITTEN. An assignment naming a
      departed member is a file nobody answers for, and finding that out after the
      matter exists means a rollback or a file with a lead who cannot log in.
    */
    const lead = body.leadStaffId
      ? await c.firm.getActiveStaffMember(p.tenantId, body.leadStaffId)
      : null;
    if (body.leadStaffId && !lead) {
      throw notFoundOrForbidden('staff', body.leadStaffId);
    }
    const extras: Array<{ staffId: string; matterRole: string;
      clientRoleLabel: string | null; clientRoleLabelAr: string | null;
      name: string; nameAr: string | null }> = [];
    for (const member of body.team) {
      if (member.staffId === body.leadStaffId) continue;
      const staff = await c.firm.getActiveStaffMember(p.tenantId, member.staffId);
      if (!staff) throw notFoundOrForbidden('staff', member.staffId);
      extras.push({
        staffId: staff.staffId, matterRole: member.matterRole,
        clientRoleLabel: member.clientRoleLabel ?? MATTER_TEAM_LABELS[member.matterRole].en,
        clientRoleLabelAr: member.clientRoleLabelAr ?? MATTER_TEAM_LABELS[member.matterRole].ar,
        name: staff.name, nameAr: staff.nameAr,
      });
    }

    const tenant = await c.firm.getTenant(p.tenantId);
    const prefix = String(tenant?.slug ?? 'M').toUpperCase().slice(0, 8);
    const practiceArea = body.practiceArea
      ?? [...p.practiceAreas].find((a) => a !== '*')
      ?? 'general';
    /*
      BOTH TITLE COLUMNS ARE NOT NULL, IN BOTH DIALECTS, AND THE FALLBACK IS THE
      ENGLISH ONE. A firm that names a file "Sharjah arbitration — Crescent" and
      types no Arabic is not making an error; the register holds two names because
      the portal and the court are addressed differently, and a file with one name
      gets that name in both columns. Refusing the create over a missing translation
      would be the kind of rule that teaches people to type a hyphen into the Arabic
      field, which is worse than the fallback.
    */
    const titleAr = body.titleAr?.trim() || body.title;
    const practiceAreaAr = body.practiceAreaAr?.trim() || practiceArea;
    const matterId = newId();
    const openedAt = new Date().toISOString();

    /*
      THE NUMBER, AND THE RETRY. `allocateMatterNumber` counts what exists; two
      simultaneous openings can therefore compute the same number, and the unique
      constraint on (tenant_id, matter_number) is the arbiter. Each attempt is its
      own transaction because the first failing attempt has already aborted one, and
      the retry is bounded because an unbounded one would turn a full register into a
      hung request. On the last attempt the error is rethrown with its own name.
    */
    let attempt = 0;
    let matterNumber = '';
    let conflictResult: {
      checkId: string | null; hits: unknown[]; warnings: string[];
      partiesChecked: number; mattersSearched: number;
    } = { checkId: null, hits: [], warnings: [], partiesChecked: 0, mattersSearched: 0 };
    let status = 'intake';

    for (;;) {
      attempt += 1;
      matterNumber = body.matterNumber?.trim()
        || await c.firm.allocateMatterNumber(p.tenantId, prefix);

      if (body.matterNumber && await c.firm.matterNumberTaken(p.tenantId, matterNumber)) {
        throw conflict('matter_number_taken',
          `${matterNumber} is already on this firm's register`);
      }

      try {
        await c.firm.tx(async () => {
          await c.firm.createMatter({
            id: matterId, tenantId: p.tenantId, clientId: body.clientId,
            matterNumber, caseNumber: body.caseNumber ?? null,
            title: body.title, titleAr: titleAr,
            practiceArea, practiceAreaAr: practiceAreaAr,
            court: body.court ?? null, courtAr: body.courtAr ?? null,
            // Never 'active': the CDD gate owns that transition.
            internalStatus: 'intake', riskRating: null,
            summary: body.summary ?? null, summaryAr: body.summaryAr ?? null,
            openedAt, createdByMembershipId: p.membershipId,
          });

          if (lead) {
            await c.firm.assignMatterTeamMember({
              id: newId(), tenantId: p.tenantId, matterId, staffId: lead.staffId,
              matterRole: body.leadRole, clientVisible: true,
              clientRoleLabel: MATTER_TEAM_LABELS[body.leadRole].en,
              clientRoleLabelAr: MATTER_TEAM_LABELS[body.leadRole].ar,
            });
          }
          for (const member of extras) {
            /*
              EVERY MEMBER IS AUDITED, NOT JUST THE LEAD. The trail below used to record the
              lead and mention the team only as a count — so "who was on this file" was
              answerable for one person and for nobody else, which is the question the audit
              trail exists to answer. Assigning a member changes who can read the file; that
              is the event, and one row per event is the rule everywhere else in this file.
            */
            const assigned = await c.firm.assignMatterTeamMember({
              id: newId(), tenantId: p.tenantId, matterId, staffId: member.staffId,
              matterRole: member.matterRole,
              // §11 in the service, and again in the table (0058's CHECK).
              clientVisible: !HIDDEN_MATTER_ROLES.includes(member.matterRole),
              clientRoleLabel: member.clientRoleLabel,
              clientRoleLabelAr: member.clientRoleLabelAr,
            });
            await c.audit.write({
              action: 'MATTER_TEAM_ASSIGNED',
              actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
              resourceType: 'matter', resourceId: matterId, outcome: 'success',
              metadata: {
                membershipId: p.membershipId, staffId: member.staffId,
                matterRole: member.matterRole, via: 'intake', created: assigned.created,
                clientVisible: !HIDDEN_MATTER_ROLES.includes(member.matterRole),
              },
            }, requestInfo(req, c.trustProxy));
          }

          await c.firm.addTimelineEntry({
            tenantId: p.tenantId, matterId, clientId: body.clientId,
            eventType: 'matter_opened', occurredAt: openedAt,
            title: 'Matter opened', titleAr: 'تم فتح القضية',
            description: `File ${matterNumber} opened for ${String(client.name)}`
              + (lead ? `, led by ${lead.name}` : ''),
            descriptionAr: `فُتح الملف ${matterNumber}` + (lead ? `، بقيادة ${lead.name}` : ''),
            /* Forced, not defaulted: 0048's WITH CHECK requires `client_visible is true`
               for anything firm_api appends, so a hidden opening is a 500 on PostgreSQL and
               a silent internal row on SQLite. One dialect must not be the only one tested. */
            status: 'complete', clientVisible: true,
            createdByStaff: p.staffId ?? null,
          });

          /*
            THE CHECK, INSIDE THE SAME TRANSACTION.

            The dataset is loaded after the matter row exists, so the parties link to
            a real matter and the client is reachable through it; `clientIdentityForMatter`
            then resolves the identity the engine matches on, including the client's
            linked party when the firm has recorded one.
          */
          if (body.runConflictCheck) {
            const dataset = await c.firm.loadConflictDataset(p.tenantId, matterId);
            const identity = await c.firm.clientIdentityForMatter(p.tenantId, body.clientId);
            if (dataset.matter && identity) {
              const result = evaluateConflicts({
                matter: {
                  id: matterId,
                  matterNumber,
                  caseNumber: body.caseNumber ?? null,
                  clientId: body.clientId,
                  clientIdentity: identity.identity,
                  clientPartyId: identity.partyId,
                },
                parties: dataset.parties,
                priorAppearances: dataset.priorAppearances,
                clients: dataset.clients,
                affiliations: dataset.affiliations,
                clientMatters: dataset.clientMatters,
              });
              const checkId = newId();
              await c.firm.recordConflictCheckWithHits({
                id: checkId, tenantId: p.tenantId, matterId, kind: body.kind,
                startedByMembershipId: p.membershipId,
                partiesChecked: result.partiesChecked, mattersSearched: result.mattersSearched,
                findings: result.findings,
              });
              conflictResult = {
                checkId, hits: await c.firm.listConflictHits(p.tenantId, checkId),
                warnings: result.warnings, partiesChecked: result.partiesChecked,
                mattersSearched: result.mattersSearched,
              };
              status = result.findings.length ? 'conflict_check' : 'intake';

              await c.audit.write({
                action: 'CONFLICT_CHECK_RUN',
                actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
                resourceType: 'matter', resourceId: matterId, outcome: 'success',
                metadata: {
                  membershipId: p.membershipId, checkId, kind: body.kind,
                  partiesChecked: result.partiesChecked, mattersSearched: result.mattersSearched,
                  hitsFound: result.findings.length, warnings: result.warnings,
                  via: 'intake',
                },
              }, requestInfo(req, c.trustProxy));
              for (const finding of result.findings) {
                await c.audit.tryWrite({
                  action: 'CONFLICT_HIT',
                  actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
                  resourceType: 'matter', resourceId: matterId, outcome: 'success',
                  reasonCode: finding.relation,
                  metadata: {
                    checkId, partyId: finding.partyId, matchedPartyId: finding.matchedPartyId,
                    severity: finding.severity, matchStrength: finding.matchStrength,
                    ruleCited: finding.ruleCited, via: 'intake',
                  },
                }, requestInfo(req, c.trustProxy));
              }
            }
          }

          /*
            THE STATUS IS SET LAST, AND ONLY TO A NON-ACTIVE ONE.

            `createMatter` writes the row in `intake`; when the check found something
            the matter moves to `conflict_check` so the Rule 11 gate holds it there
            until a human dispositions the findings. Writing it through the repository
            (rather than in the insert) keeps ONE way a matter's status changes, which
            is what makes the gate auditable: every transition is a call to
            `setMatterStatus`, on this path and on the route that owns the lifecycle.
          */
          if (status !== 'intake') {
            await c.firm.setMatterStatus({
              tenantId: p.tenantId, matterId, internalStatus: status, conflictCleared: false,
            });
          }

          await c.audit.write({
            action: 'MATTER_CREATED',
            actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
            resourceType: 'matter', resourceId: matterId, outcome: 'success',
            metadata: {
              membershipId: p.membershipId, matterNumber, clientId: body.clientId,
              practiceArea, internalStatus: status, leadStaffId: lead?.staffId ?? null,
              leadRole: lead ? body.leadRole : null, teamSize: extras.length + (lead ? 1 : 0),
              openedWithConflictCheck: !!conflictResult.checkId,
              conflictFindings: conflictResult.hits.length,
            },
          }, requestInfo(req, c.trustProxy));

          if (lead) {
            await c.audit.write({
              action: 'MATTER_TEAM_ASSIGNED',
              actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
              resourceType: 'matter', resourceId: matterId, outcome: 'success',
              metadata: {
                membershipId: p.membershipId, staffId: lead.staffId,
                matterRole: body.leadRole, via: 'intake',
              },
            }, requestInfo(req, c.trustProxy));
          }
        });
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const collided = /matter_number|duplicate key|unique/i.test(message)
          && /matter_number|matters_tenant_id_matter_number/i.test(message);
        if (!collided || attempt >= 5 || body.matterNumber) {
          if (!collided) throw err;
          throw conflict('matter_number_taken',
            `could not allocate a matter number after ${attempt} attempts — supply one explicitly`);
        }
      }
    }

    ok(res, {
      id: matterId, matterNumber, internalStatus: status, practiceArea,
      client: { id: body.clientId, name: String(client.name) },
      lead: lead ? { staffId: lead.staffId, name: lead.name, matterRole: body.leadRole } : null,
      conflict: conflictResult,
      next: {
        matter: `/matters/${matterId}`,
        // The two calls the next stage needs, named rather than described, so the
        // screen after this one does not have to derive them.
        status: `/api/firm/matters/${matterId}/status`,
        report: `/api/firm/matters/${matterId}/report`,
      },
    }, 201);
  }));

  /** The case report as the matter header and the report form read it. */
  r.get('/matters/:id/report', ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'matters.read', { type: 'matter', id: matterId });
    const { level } = await c.permissions.requireMatter(p, matterId, MATTER_READ);

    const report = await c.firm.getMatterReport(p.tenantId, matterId);
    if (!report) throw notFoundOrForbidden('matter', matterId);

    const team = await c.firm.listMatterTeam(p.tenantId, matterId);
    ok(res, {
      report: {
        id: report.id, matterNumber: report.matterNumber, caseNumber: report.caseNumber,
        title: report.title, titleAr: report.titleAr,
        practiceArea: report.practiceArea, practiceAreaAr: report.practiceAreaAr,
        court: report.court, courtAr: report.courtAr,
        summary: report.summary, summaryAr: report.summaryAr,
        internalStatus: report.internalStatus, clientStatus: report.clientStatus,
        openedAt: report.openedAt, lastClientUpdateAt: report.lastClientUpdateAt,
        client: { id: report.clientId, name: report.clientName, nameAr: report.clientNameAr },
      },
      team,
      /**
        Whether this member may change any of it — the form's own gate, so an
        operational or financial reader sees the report and no "Save" button rather
        than a button that fails. `MATTER_WRITE` is the same list the PATCH below
        enforces, which is what stops the two answers drifting.
      */
      mayUpdate: p.permissions.has('matters.update') && MATTER_WRITE.includes(level),
    });
  }));

  /**
   * UPDATE THE CASE REPORT.
   *
   * One route for the four things a report is made of — what the file is called, what
   * the court calls it, what it is about, and what the CLIENT is told — because in
   * practice a lawyer does all four in one sitting, and a form that posts them
   * separately is a form that gets half-filled.
   *
   * `notifyClient` IS THE EFFICIENCY THAT MATTERS. When it is set (the default when a
   * summary is supplied), the same transaction writes a `status_update` entry to the
   * matter timeline and moves `last_client_update_at`. The client portal reads both, so
   * "update the case report" and "tell the client" stop being two jobs — and the
   * second one stops being forgotten, which is the complaint clients actually make.
   * The timeline entry is client-visible: a summary written for the client and hidden
   * from them would be worse than no summary.
   *
   * THE STATUS IS NOT HERE. `internal_status` moves through
   * `POST /matters/:id/status`, where the conflict, CDD and enforcement gates live.
   * A report form that could set `active` would be a second, unguarded door into the
   * lifecycle.
   */
  r.patch('/matters/:id/report', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    const body = strictBody(
      z.object({
        title: z.string().trim().min(2).max(300).optional(),
        titleAr: z.string().trim().max(300).optional().nullable(),
        caseNumber: z.string().trim().max(60).optional().nullable(),
        practiceArea: z.string().trim().max(120).optional(),
        practiceAreaAr: z.string().trim().max(120).optional().nullable(),
        court: z.string().trim().max(200).optional().nullable(),
        courtAr: z.string().trim().max(200).optional().nullable(),
        summary: z.string().trim().max(4000).optional().nullable(),
        summaryAr: z.string().trim().max(4000).optional().nullable(),
        /** Client-facing progress note; written to the timeline when notifyClient. */
        note: z.string().trim().max(2000).optional().nullable(),
        noteAr: z.string().trim().max(2000).optional().nullable(),
        notifyClient: z.boolean().optional(),
      }).strict(),
      req, c, '/api/firm/matters/:id/report',
    );

    c.permissions.assertCan(p, 'matters.update', { type: 'matter', id: matterId });
    const { facts, level } = await c.permissions.requireMatter(p, matterId, MATTER_WRITE);

    const existing = await c.firm.getMatterReport(p.tenantId, matterId);
    if (!existing) throw notFoundOrForbidden('matter', matterId);

    const patch: Parameters<typeof c.firm.updateMatterReport>[0]['patch'] = {};
    for (const key of ['title', 'titleAr', 'caseNumber', 'court', 'courtAr',
      'practiceArea', 'practiceAreaAr', 'summary', 'summaryAr'] as const) {
      const value = body[key];
      if (value !== undefined) patch[key] = value as never;
    }

    const tellsClient = body.summary !== undefined || body.summaryAr !== undefined;
    const notifyClient = body.notifyClient ?? tellsClient;
    const now = new Date().toISOString();

    if (Object.keys(patch).length) {
      const changed = await c.firm.updateMatterReport({
        tenantId: p.tenantId, matterId, updatedAt: now, touchClient: notifyClient, patch,
      });
      if (!changed) throw notFoundOrForbidden('matter', matterId);
    } else if (!body.note && !notifyClient) {
      throw badRequest('nothing_to_update', 'no report fields were supplied');
    }

    /*
      THE NOTE REACHES THE TIMELINE ONLY WHEN THE CLIENT IS TOLD. `client_visible` is fixed
      at true for firm appends (0048), so a note written while `notifyClient` is false has no
      legal home in this table — it is the firm talking to itself, which is what the audit
      row and `internal_notes` are for. Writing it anyway produced a 500 on PostgreSQL.
    */
    if ((body.note || body.noteAr) && notifyClient) {
      await c.firm.addTimelineEntry({
        tenantId: p.tenantId, matterId, clientId: String(existing.clientId ?? ''),
        eventType: 'status_update', occurredAt: now,
        title: (body.note ?? body.noteAr ?? '').slice(0, 120),
        titleAr: (body.noteAr ?? body.note ?? '').slice(0, 120),
        description: body.note ?? null, descriptionAr: body.noteAr ?? null,
        status: 'complete', clientVisible: true,
        createdByStaff: p.staffId ?? null,
      });
    }

    await c.audit.write({
      action: 'MATTER_REPORT_UPDATED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      resourceType: 'matter', resourceId: matterId, outcome: 'success',
      metadata: {
        membershipId: p.membershipId,
        // Field NAMES, never values: the summary is the client's confidential
        // business and an audit search returns rows in bulk.
        fields: Object.keys(patch).sort(),
        notifiedClient: notifyClient, noteAdded: !!body.note || !!body.noteAr,
        restricted: facts.isRestricted, accessLevel: level,
      },
    }, requestInfo(req, c.trustProxy));

    ok(res, { id: matterId, updatedAt: now, notifiedClient: notifyClient,
      fields: Object.keys(patch).sort() });
  }));

  /**
   * ASSIGN THE CASE TO A LAWYER.
   *
   * `matters.assign` plus full access on the file: deciding who can read a matter is
   * a decision about the matter's confidentiality, so it may not be made by somebody
   * who merely has it open.
   *
   * TWO RULES ARE APPLIED HERE THAT THE DATABASE ALSO HOLDS, because the refusal has
   * to be readable and `matter_team` has no way to explain itself:
   *
   *   §11 · THE HIDDEN ROLES. A finance or compliance contact is on the file and is
   *   NOT shown to the client. When one is assigned, `clientVisible` is forced false
   *   rather than refused — the caller's intent to display the firm's AML officer is
   *   not a legitimate request to deny, and the constraint in 0058 would refuse the
   *   write anyway. The response says it was forced, so nothing is silent.
   *
   *   ONE LEAD PER ROLE. A file with two lead partners has two people who each believe
   *   they answer for it, which is how a deadline is missed by both. `replaceLead`
   *   makes taking over one step rather than two, and the transaction deactivates the
   *   incumbent so the index in 0058 is never even tested by a losing race.
   */
  r.post('/matters/:id/team', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    const body = strictBody(
      z.object({
        staffId: z.string().uuid(),
        matterRole: z.enum(MATTER_TEAM_ROLES),
        clientVisible: z.boolean().optional(),
        clientRoleLabel: z.string().trim().max(80).optional().nullable(),
        clientRoleLabelAr: z.string().trim().max(80).optional().nullable(),
        /** Take the role over from the incumbent rather than being refused. */
        replaceLead: z.boolean().default(false),
      }).strict(),
      req, c, '/api/firm/matters/:id/team',
    );

    c.permissions.assertCan(p, 'matters.assign', { type: 'matter', id: matterId });
    const { facts } = await c.permissions.requireMatter(p, matterId, MATTER_MANAGE);

    const matter = await c.firm.getMatterReport(p.tenantId, matterId);
    if (!matter) throw notFoundOrForbidden('matter', matterId);

    const staff = await c.firm.getActiveStaffMember(p.tenantId, body.staffId);
    if (!staff) throw notFoundOrForbidden('staff', body.staffId);

    const hidden = HIDDEN_MATTER_ROLES.includes(body.matterRole);
    const clientVisible = hidden ? false : (body.clientVisible ?? true);
    const isLead = body.matterRole === 'lead_partner' || body.matterRole === 'lead_lawyer';

    const incumbent = isLead
      ? await c.firm.activeLeadFor(matterId, body.matterRole) : null;
    if (incumbent && incumbent.staffId !== body.staffId && !body.replaceLead) {
      throw conflict('matter_has_lead',
        `${incumbent.name} is already the ${MATTER_TEAM_LABELS[body.matterRole].en} on this file —`
        + ' reassign with replaceLead, or deactivate them first',
        { incumbent });
    }

    const now = new Date().toISOString();
    let replaced = false;
    let created = false;
    await c.firm.tx(async () => {
      if (incumbent && incumbent.staffId !== body.staffId) {
        await c.firm.deactivateMatterTeamMember({
          tenantId: p.tenantId, matterId, staffId: incumbent.staffId,
        });
        replaced = true;
        await c.audit.write({
          action: 'MATTER_TEAM_UNASSIGNED',
          actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
          resourceType: 'matter', resourceId: matterId, outcome: 'success',
          reasonCode: 'replaced',
          metadata: {
            membershipId: p.membershipId, staffId: incumbent.staffId,
            matterRole: body.matterRole, replacedBy: staff.staffId,
          },
        }, requestInfo(req, c.trustProxy));
      }

      const assigned = await c.firm.assignMatterTeamMember({
        id: newId(), tenantId: p.tenantId, matterId, staffId: staff.staffId,
        matterRole: body.matterRole, clientVisible,
        clientRoleLabel: body.clientRoleLabel ?? MATTER_TEAM_LABELS[body.matterRole].en,
        clientRoleLabelAr: body.clientRoleLabelAr ?? MATTER_TEAM_LABELS[body.matterRole].ar,
      });
      created = assigned.created;

      /*
        THE ASSIGNMENT IS NOT A TIMELINE ENTRY, AND THAT IS A DECISION, NOT AN OMISSION.

        This used to write an internal `note` row saying who had been assigned. On SQLite
        that looked like good practice; on PostgreSQL every assignment returned 500, because
        0048's `firm_timeline_append` requires `client_visible is true`: the client's
        chronology is the CLIENT's, and the firm may not write history into it that the
        client's own session will never render.

        So the fact goes where the platform already keeps it:

          · `matter_team.client_visible` is the client-facing answer to "who runs my case",
            and the portal projects it — one fact, one place it becomes visible;
          · the audit row below is the firm's internal record of who changed what, when, and
            whether the previous holder had to be replaced;
          · `internal_notes` is where an internal narrative belongs, and it is ring-governed.

        A hidden timeline row would be a fourth copy in the wrong drawer.
      */

      await c.audit.write({
        action: 'MATTER_TEAM_ASSIGNED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'matter', resourceId: matterId, outcome: 'success',
        metadata: {
          membershipId: p.membershipId, staffId: staff.staffId, matterRole: body.matterRole,
          created, clientVisible, clientVisibleForced: hidden && body.clientVisible !== false,
          replaced, restricted: facts.isRestricted,
        },
      }, requestInfo(req, c.trustProxy));
    });

    const team = await c.firm.listMatterTeam(p.tenantId, matterId);
    ok(res, {
      id: matterId, staffId: staff.staffId, matterRole: body.matterRole,
      clientVisible, clientVisibleForced: hidden && body.clientVisible !== false,
      created, replaced, team,
    }, 201);
  }));

  /**
   * TAKE SOMEBODY OFF A FILE.
   *
   * A deactivation, never a delete: the record of who worked a matter, and when, is
   * the firm's answer to a disqualification motion, and `matter_team`'s row is the
   * only place it exists. The audit row carries the reason code the register shows.
   */
  r.patch('/matters/:id/team/:staffId', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    const staffId = String(req.params.staffId);
    const body = strictBody(
      z.object({ reason: z.string().trim().max(300).optional().nullable() }).strict(),
      req, c, '/api/firm/matters/:id/team/:staffId',
    );

    c.permissions.assertCan(p, 'matters.assign', { type: 'matter', id: matterId });
    await c.permissions.requireMatter(p, matterId, MATTER_MANAGE);
    const matter = await c.firm.getMatterReport(p.tenantId, matterId);
    if (!matter) throw notFoundOrForbidden('matter', matterId);

    const team = await c.firm.listMatterTeam(p.tenantId, matterId);
    const member = team.find((m) => m.staffId === staffId);
    if (!member) throw notFoundOrForbidden('matter_team_member', staffId);

    const changed = await c.firm.deactivateMatterTeamMember({
      tenantId: p.tenantId, matterId, staffId,
    });
    await c.audit.write({
      action: 'MATTER_TEAM_UNASSIGNED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      resourceType: 'matter', resourceId: matterId, outcome: 'success',
      reasonCode: body.reason ?? 'removed',
      metadata: {
        membershipId: p.membershipId, staffId, matterRole: member.matterRole, changed,
      },
    }, requestInfo(req, c.trustProxy));

    const remaining = await c.firm.listMatterTeam(p.tenantId, matterId);
    ok(res, { id: matterId, staffId, active: false, changed, team: remaining });
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

    /*
      ── P0.5 · THE PRIVILEGED FIELDS ────────────────────────────────────────────

      `getMatterRow` does not select them: 0054 revoked the application role's SELECT
      privilege on `matters.internal_notes` and `matters.risk_rating`, so there is no
      version of this query that could leak them. They are fetched through
      `readMatterPrivilege()` — a security-definer function that checks the ring and
      names its refusal — and fetched ONLY when the member is in the ring AND the
      projection would emit them anyway.

      THE ORDER MATTERS. The ring is consulted before the database is asked, so an
      ordinary paralegal viewing a matter does not generate a database refusal on every
      page load; the withheld list is the signal for that case, and it is already
      correct. The refusal path below exists for the case where the database DISAGREES
      with the application — a principal resolved a moment before a suspension landed,
      or a bug in the ring — and that disagreement must not be swallowed: it is recorded,
      with the reason, and the fields stay withheld.
    */
    let privileged: { internalNotes: string | null; riskRating: string | null } | null = null;
    const wouldEmitPrivileged =
      MATTER_WRITE.includes(level as AccessLevel) && p.ring.inRing;
    if (wouldEmitPrivileged) {
      try {
        privileged = await c.firm.readMatterPrivilege(p.tenantId, facts.matterId);
        if (privileged) {
          row.internal_notes = privileged.internalNotes;
          row.risk_rating = privileged.riskRating;
          /*
            RECORDED, because the question asked in a disqualification motion is not
            "was the screen clean" but "who read the firm's privileged material, and
            when" — the same reasoning as MATTER_VIEWED, one level down. Fire-and-
            forget, like every read: a lost audit must not fail a permitted read.
          */
          await c.audit.tryWrite({
            action: 'PRIVILEGED_READ',
            actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
            resourceType: 'matter', resourceId: facts.matterId, outcome: 'success',
            reasonCode: 'in_ring',
            metadata: {
              membershipId: p.membershipId,
              matterNumber: facts.matterNumber,
              fields: ['internalNotes', 'riskRating'],
            },
          }, requestInfo(req, c.trustProxy));
        }
      } catch (err) {
        /* The database refused a member the application believed was in the ring. The
           fields are withheld — the projection emits nothing for a null row value — and
           the disagreement is recorded rather than raised: the member's view of the
           matter is not wrong, it is narrower than they expected, and the operator
           reading the log is the one who needs to see it. */
        await c.audit.tryWrite({
          action: 'PRIVILEGED_READ',
          actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
          resourceType: 'matter', resourceId: facts.matterId, outcome: 'denied',
          reasonCode: String((err as Error)?.message ?? 'unknown').slice(0, 120),
          metadata: { membershipId: p.membershipId, matterNumber: facts.matterNumber },
        }, requestInfo(req, c.trustProxy));
      }
    }

    const projected = projectMatter<Record<string, unknown>>(row, {
      principal: p,
      accessLevel: level,
      ring: p.ring,
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
      /*
        THE RING, AS A FACT THE SCREEN MAY RENDER AND MAY NOT OVERRIDE (§50). A member
        whose licence is suspended will see `privileged` fields locked and no value; the
        screen is told WHY so it can say "يحتاج ترخيصاً سارياً" instead of showing a blank
        they cannot interpret. Nothing here decides access — the server already did.
      */
      privilege: { inRing: p.ring.inRing, reason: p.ring.reason },
    });
  }));

  /*
    ── THE DASHBOARD'S NUMBERS ─────────────────────────────────────────────────

    Four counts, each gated by the permission of the CARD that shows it — not by
    one umbrella check. A member with `hearings.read` and nothing else gets their
    hearings count and null for the rest; a finance officer gets the money and
    null for the legal work. Returning zeros instead would be worse than useless:
    a zero is a measurement, and "0 overdue" that means "you may not see" is the
    kind of lie this codebase spends its comments preventing.

    `null` is therefore a first-class answer here, and the dashboard renders it as
    an absent card rather than as a number.
  */
  r.get('/dashboard/summary', ah(async (req, res) => {
    const p = principal(req);
    const wantsLegal =
      p.permissions.has('hearings.read') || p.permissions.has('deadlines.read');
    const wantsDocs = p.permissions.has('documents.read');
    const wantsMoney = p.permissions.has('billing.read') || p.permissions.has('billing.read_all');
    if (!wantsLegal && !wantsDocs && !wantsMoney) {
      /* A member who may see none of it is told so rather than served zeroes. */
      ok(res, { hearingsUpcoming: null, deadlinesThisWeek: null, documentsRequested: null, outstanding: null });
      return;
    }

    const counts = await c.firm.dashboardCounts(p.tenantId, new Date());
    ok(res, {
      hearingsUpcoming: p.permissions.has('hearings.read') ? counts.hearingsUpcoming : null,
      deadlinesThisWeek: p.permissions.has('deadlines.read') ? counts.deadlinesThisWeek : null,
      documentsRequested: wantsDocs ? counts.documentsRequested : null,
      outstanding: wantsMoney
        ? { amountSar: counts.outstandingSar, openInvoiceCount: counts.openInvoiceCount }
        : null,
      /* The screen needs to know which silence is which: `withheld` is a decision
         the firm made, `none` is a member this dashboard has nothing for. */
      withheld: [!p.permissions.has('hearings.read') ? 'hearings' : null,
                 !p.permissions.has('deadlines.read') ? 'deadlines' : null,
                 !wantsDocs ? 'documents' : null,
                 !wantsMoney ? 'billing' : null].filter(Boolean),
    });
  }));

  /*
    ── THE MATTER WORKSPACE'S TAB BODIES ──────────────────────────────────────

    Five reads, one per tab that now has a screen. They are separate endpoints
    rather than one fat `/matters/:id` because that is what the tab strip means:
    opening a matter should not send the firm's entire file, and a member reading
    the Documents tab should not be served the conflict register.

    THE TWO GATES ARE THE SAME TWO THE DETAIL ROUTE USES, in the same order, and
    they are named here rather than implied:

      1. `assertCan(p, <module code>)` — is this module part of the member's grant
         at all? A fee-earner with `matters.read` but no `documents.read` passes
         the matter check and fails this one.
      2. `requireMatter(p, id, <acceptance set>)` — may they open THIS matter, at
         an access level that carries this material? A finance officer holding
         `view` on a litigation matter fails here on documents and passes on
         billing, which is the whole point of two gates rather than one.

    A tab hidden by §50 is therefore hidden TWICE over: the strip filters it from
    `permissions` + `accessLevel` on the client, and the route refuses it with the
    server's own verdict. The client's copy of the rule is a courtesy that saves a
    request; the server's is the rule.
  */

  /** Documents filed against the matter. Privileged material needs the ring. */
  r.get('/matters/:id/documents', ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'documents.read', { type: 'matter', id: matterId });
    await c.permissions.requireMatter(p, matterId, MATTER_OPERATE);

    const documents = await c.firm.listMatterDocuments(p.tenantId, matterId, { inRing: p.ring.inRing });

    /*
      WITHHELD MATERIAL IS COUNTED, NOT ERASED — and the count is fetched, not
      derived from the list, because the list no longer contains the rows. On
      PostgreSQL the database withheld them before the application saw anything;
      on the demo engine the same predicate ran inside the statement. Either way
      the panel can say "one document is restricted to licensed lawyers" rather
      than showing a shorter file and letting the member conclude the firm lost
      it. That is §57's discipline applied to a document list: a reader should
      learn that material exists and that access is the reason they cannot read
      it.

      ONLY ASKED WHEN THE ANSWER CAN BE NON-ZERO. A member in the ring is shown the
      documents themselves, so the question is not put to the database at all —
      one fewer definer call on the common path, and one fewer audit trail that
      records a question nobody needed answered.
    */
    const withheldCount = p.ring.inRing
      ? 0
      : await c.firm.countMatterPrivilegedDocuments(p.tenantId, matterId);

    ok(res, {
      matterId,
      count: documents.length,
      withheldCount,
      privilege: { inRing: p.ring.inRing, reason: p.ring.reason },
      documents,
    });
  }));

  /** The matter's hearings, with the court's own calendar weekend in force. */
  r.get('/matters/:id/hearings', ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'hearings.read', { type: 'matter', id: matterId });
    await c.permissions.requireMatter(p, matterId, MATTER_OPERATE);
    const hearings = await c.firm.listMatterHearings(p.tenantId, matterId);
    const now = Date.now();
    ok(res, {
      matterId,
      count: hearings.length,
      /* Split by the clock rather than left to the client: two screens computing
         "upcoming" from their own clocks disagree at midnight, and this one is
         the same rule the reminder job would use. */
      upcoming: hearings.filter((h) => Date.parse(String(h.scheduledAt)) >= now),
      past: hearings.filter((h) => Date.parse(String(h.scheduledAt)) < now),
    });
  }));

  /** The matter's deadlines, soonest first, with what is overdue made explicit. */
  r.get('/matters/:id/deadlines', ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'deadlines.read', { type: 'matter', id: matterId });
    await c.permissions.requireMatter(p, matterId, MATTER_OPERATE);
    const deadlines = await c.firm.listMatterDeadlines(p.tenantId, matterId);
    const now = Date.now();
    const open = (d: { internalStatus: string }) => !['done', 'cancelled', 'missed'].includes(d.internalStatus);
    ok(res, {
      matterId,
      count: deadlines.length,
      deadlines: deadlines.map((d) => ({
        ...d,
        overdue: open(d) && Date.parse(String(d.dueAt)) < now,
      })),
    });
  }));

  /** What happened on this matter, newest first. */
  r.get('/matters/:id/timeline', ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'matters.read', { type: 'matter', id: matterId });
    await c.permissions.requireMatter(p, matterId, MATTER_READ);
    const timeline = await c.firm.listMatterTimeline(p.tenantId, matterId);
    ok(res, { matterId, count: timeline.length, timeline });
  }));

  /** Who is on the matter, and at what role — the fact the access level came from. */
  r.get('/matters/:id/team', ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'matters.read', { type: 'matter', id: matterId });
    await c.permissions.requireMatter(p, matterId, MATTER_READ);
    const team = await c.firm.listMatterTeam(p.tenantId, matterId);
    const { level } = await c.permissions.requireMatter(p, matterId, MATTER_READ);

    /*
      WHO THIS MEMBER MAY PUT ON THE FILE, AND ONLY WHEN THEY MAY.

      The assignment control lives on this tab, and a control that fetches its own
      options in a second request can show a picker populated from a different
      authority than the one that will refuse the write — so the options travel with
      the team. They are withheld entirely from a member without `matters.assign`:
      an empty picker would invite the attempt this refuses.
    */
    const mayAssign = p.permissions.has('matters.assign') && level === 'full';
    const assignable = mayAssign ? await c.firm.listAssignableStaff(p.tenantId) : [];

    ok(res, {
      matterId,
      count: team.length,
      /* The viewer's own level, so the tab can say which of these rows is them and
         why their name may or may not appear. */
      yourAccessLevel: level,
      mayAssign,
      assignable: assignable.map((s) => ({
        staffId: s.staffId, name: s.name, nameAr: s.nameAr, role: s.internalRole,
        jobTitle: s.jobTitle, jobTitleAr: s.jobTitleAr, activeMatters: s.activeMatters,
        onThisMatter: team.some((m) => m.staffId === s.staffId),
      })),
      team,
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

    /*
      ═══ THE CUSTOMER DUE DILIGENCE GATE · P0.3 ═══

      The obligation is about the RELATIONSHIP, and this is the moment the relationship
      begins: a matter does not become active for a client the firm has not identified.
      Asked here for the same reason the conflict gate is — so the refusal arrives with
      its reason, and so it is audited — and refused again by the database underneath,
      which is what makes it a gate rather than a formality.

      IT GUARDS THE TRANSITION INTO `active` ONLY. A matter may be opened at intake, put
      through conflict check and reviewed while the client is still producing documents:
      that is how a firm works, and a gate that blocked intake would only teach people to
      create the matter elsewhere. What it may not do is become ACTIVE — the state in
      which the firm acts — on an unidentified client.

      A CLIENT WITH NO MATTER AT ALL IS NOT MENTIONED HERE. There is no relationship to
      gate; the manual's prohibition bites when the firm acts, and the firm acts through
      matters.
    */
    if (body.internalStatus === 'active' && from !== 'active') {
      await assertCddAdmits(req, p, String(row.client_id), matterId);
    }

    /*
      ═══ THE ENFORCEMENT GATE · P0.4 ═══

      THE SECOND DOOR INTO THIS ROUTE, AND IT ASKS A DIFFERENT QUESTION. The CDD gate asks
      whether the firm may act for this client at all; this one asks whether the firm may
      now use the state's power to collect. A matter may move into `execution` only when a
      judgment on it is enforceable, has been served, is not stayed and is not under
      challenge — and the period for challenging it has closed.

      WHERE THE ORDER COMES FROM is the same place the other gates' does: the domain's
      `executionOutcome`, which is also what the register on the screen is built from. So
      the list a person reads and the refusal they receive cannot disagree about which
      judgments may be enforced — which is the failure that would make this a formality.

      `judgments.manage` IS NOT REQUIRED HERE, AND THAT IS DELIBERATE. This route is the
      matter lifecycle, and the permission for moving a matter to execution is the one that
      guards the lifecycle: `matters.status`. Requiring the register's write permission as
      well would mean two permissions for one decision — and the register's own routes are
      where `judgments.manage` is checked. The database enforces the same rule for a caller
      that never passes through this route at all.
    */
    if (body.internalStatus === 'execution' && from !== 'execution') {
      await assertEnforcementAdmits(req, p, matterId);
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
        nameAr: client?.nameAr ?? null,
        vatNumber: client?.vatNumber ?? null,
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
      buyerName: String(client?.name ?? ''), buyerVat: client?.vatNumber ?? null,
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

    /*
      THE CLIENT MUST EXIST BEFORE A LEDGER IS OPENED FOR THEM.

      A ledger is created on its first movement, so this route is the only place that can
      notice a request naming a client the firm has no record of — and without this check
      the insert that opens the ledger fails on its foreign key, which reaches the caller
      as "internal error". A 500 says the system is broken; the honest answer is that
      there is no such client here. The lookup is tenant-scoped, so a client of another
      firm gets the same answer and the refusal discloses nothing about whose it is.
    */
    if (!(await c.firm.getClientForTenant(p.tenantId, clientId))) {
      throw notFoundOrForbidden('client', clientId);
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

  /* ═══════════════════════════════════════════════════════════════════════════
     P0.3 · CLIENT DUE DILIGENCE, SCREENING AND THE REPORT

     WHERE THE GATE LIVES. The obligation is enforced in three places and each of
     them answers a different question:

       · the ROUTE refuses with a named code, so the person reading it learns which
         field is missing (this file);
       · the DOMAIN assessment (`assessCdd`) is what the route asks, and it is the
         same function the queue on the screen uses — so the list and the gate cannot
         disagree about who is admissible;
       · the DATABASE refuses the transition into `active` whether or not the
         application asked (0040 and its SQLite mirror). A last line of defence that
         depends on the application being right is not one.

     The last of those is why the test suite attacks the update directly with SQL as
     well as through the API: the refusal has to hold against a caller who is not the
     server.
     ═════════════════════════════════════════════════════════════════════════════ */

  /** Everything the assessment needs, assembled once, from the record. */
  async function loadDdFacts(p: { tenantId: string }, clientId: string) {
    const dd = await c.firm.getCurrentDueDiligence(p.tenantId, clientId);
    const owners = dd ? await c.firm.listBeneficialOwners(p.tenantId, dd.id) : [];
    const runs = await c.firm.listScreeningRuns(p.tenantId, clientId);
    const client = await c.firm.getClientForTenant(p.tenantId, clientId);
    if (!client) return null;

    const ownerFacts: OwnerFacts[] = owners.map((o) => ({
      fullName: o.fullName, ownerKind: o.ownerKind as OwnerFacts['ownerKind'],
      ownershipPct: o.ownershipPct, controlBasis: o.controlBasis as OwnerFacts['controlBasis'],
      nationality: o.nationality, residenceCountry: o.residenceCountry,
      dateOfBirth: o.dateOfBirth, idNumberHash: null, isPep: o.pepStatus !== null && o.pepStatus !== 'not_pep',
      verifiedAt: o.verifiedAt,
    }));
    const ownership = ownershipCoverage(ownerFacts);
    /*
      THE SUBJECTS ARE COMPUTED, NOT LISTED. `screeningSubjects` is the same function
      the screen uses to say who still has to be screened, and the same rule the
      database applies in its own words — one definition of "who is in this
      relationship", in three places that must agree.
    */
    const subjects = screeningSubjects(
      { id: clientId, name: String(client.name) },
      owners.map((o, i) => ({ id: o.id, fullName: o.fullName, owner: ownerFacts[i] })),
    );
    const runFacts: ScreeningRunFacts[] = [];
    for (const r of runs) {
      const matches = await c.firm.listScreeningMatches(p.tenantId, r.id);
      runFacts.push({
        id: r.id, subjectKind: r.subjectKind as ScreeningSubjectKind, subjectId: r.subjectId,
        listSets: r.listSets, listAsOf: r.listAsOf, status: r.status as ScreeningRunFacts['status'],
        matches: matches.map((m) => ({ id: m.id, disposition: m.disposition as ScreeningRunFacts['matches'][number]['disposition'] })),
        runAt: String(r.runAt),
      });
    }
    const screening = screeningState(subjects, runFacts);
    const clientType = String(client.client_type ?? client.clientType ?? 'individual');
    const kind: 'individual' | 'organization' = clientType === 'individual' ? 'individual' : 'organization';

    const facts: CddFacts = {
      clientKind: kind, level: (dd?.level ?? 'standard') as CddFacts['level'],
      status: (dd?.status ?? 'not_started') as CddFacts['status'],
      legalName: dd?.legalName ?? null, legalNameAr: dd?.legalNameAr ?? null,
      dateOfBirth: dd?.dateOfBirth ?? null, nationality: dd?.nationality ?? null,
      residenceCountry: dd?.residenceCountry ?? null, address: dd?.address ?? null,
      crNumber: dd?.crNumber ?? null, incorporationCountry: dd?.incorporationCountry ?? null,
      businessActivity: dd?.businessActivity ?? null,
      idType: dd?.idType ?? null, idNumberHash: dd?.idNumberHash ?? null,
      sourceOfFunds: dd?.sourceOfFunds ?? null, sourceOfWealth: dd?.sourceOfWealth ?? null,
      purpose: dd?.purpose ?? null, verificationMethod: dd?.verificationMethod ?? null,
      pepStatus: (dd?.pepStatus ?? null) as CddFacts['pepStatus'],
      seniorApprovedByMembershipId: dd?.seniorApprovedByMembershipId ?? null,
      reviewDueAt: dd?.reviewDueAt ?? null, screening, ownership,
    };
    return { client, dd, owners, ownersFacts: ownerFacts, subjects, runs, facts,
      /*
        `gateFacts` IS NULL WHEN THERE IS NO RECORD, and the distinction is not cosmetic.
        The display shape always has a facts object — a screen has to render empty fields —
        and feeding that object to the gate made a client with NO record at all read as a
        record with missing evidence: the route said `cdd_incomplete` while the database
        said `cdd_missing`. Two names for one situation, and the one the person can act on
        is the one that says there is nothing to act on yet.
      */
      gateFacts: dd ? facts : null,
      assessment: assessCdd(facts) };
  }

  /** The gate's answer about a loaded record, from the same facts the screen is built on. */
  function gateOutcome(loaded: Awaited<ReturnType<typeof loadDdFacts>>) {
    if (!loaded) return activationOutcome({ facts: null, assessment: null });
    return activationOutcome({ facts: loaded.gateFacts, assessment: loaded.assessment });
  }

  /**
   * The gate, as a route asks it.
   *
   * REFUSES WITH THE DOMAIN'S OWN CODE AND MESSAGE. A gate that produced a generic
   * validation error would leave the person to work out which of seven requirements
   * blocked them, and the record itself — which the obligation is about — is the
   * thing they would not read.
   */
  async function assertCddAdmits(
    req: import('express').Request,
    p: { tenantId: string; userId: string }, clientId: string,
    matterId: string | null,
  ): Promise<void> {
    const loaded = await loadDdFacts(p, clientId);
    const outcome = gateOutcome(loaded);
    if (outcome.allowed) return;
    await c.audit.tryWrite({
      action: 'CDD_GATE_DENIED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'denied', resourceType: 'matter', resourceId: matterId ?? undefined,
      reasonCode: outcome.code,
      /*
        `refusal`, NOT `code`. The audit writer's denylist refuses a metadata key named
        `code` — it is one of the keys an OTP or a recovery code would arrive under — and
        `tryWrite` swallows that refusal with a console warning. The first version of this
        gate therefore refused correctly and recorded NOTHING, which is the failure mode
        this codebase keeps meeting: correct in the direction anybody looks, silent in the
        other. The harness caught it by asking the database for the row.
      */
      metadata: {
        clientId, refusal: outcome.code,
        missing: loaded?.assessment?.missing.map((m) => m.key) ?? [],
      },
    }, requestInfo(req, c.trustProxy));
    throw badRequest(outcome.code, outcome.message);
  }

  // ── the client's record ────────────────────────────────────────────────────
  r.get('/clients/:clientId/due-diligence', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'compliance.read', { type: 'client', id: String(req.params.clientId) });
    const clientId = String(req.params.clientId);
    const loaded = await loadDdFacts(p, clientId);
    if (!loaded) throw notFoundOrForbidden('client', clientId);

    ok(res, {
      client: {
        id: clientId, name: loaded.client.name, nameAr: loaded.client.name_ar ?? null,
        type: loaded.facts.clientKind,
      },
      record: loaded.dd ? {
        id: loaded.dd.id, version: loaded.dd.version, level: loaded.dd.level,
        status: loaded.dd.status, completedAt: loaded.dd.completedAt,
        reviewDueAt: loaded.dd.reviewDueAt, unableReason: loaded.dd.unableReason,
        riskRating: loaded.dd.riskRating, riskReasons: loaded.dd.riskReasons,
        pepStatus: loaded.dd.pepStatus, pepDetails: loaded.dd.pepDetails,
        seniorApprovedByMembershipId: loaded.dd.seniorApprovedByMembershipId,
        sourceOfFunds: loaded.dd.sourceOfFunds, purpose: loaded.dd.purpose,
        verificationMethod: loaded.dd.verificationMethod, verifiedAt: loaded.dd.verifiedAt,
        // The identifier is returned masked, and only masked: the hash is a matching
        // device and the mask is what a screen may show.
        idType: loaded.dd.idType, idNumberMasked: loaded.dd.idNumberMasked,
        crNumber: loaded.dd.crNumber,
      } : null,
      /*
        THE REQUIREMENTS THEMSELVES, SENT TO THE CLIENT. A screen that shows a list of
        fields and a red badge is a screen that makes the reader guess which field the
        gate is about; this sends the rule, with the missing ones marked.
      */
      requirements: requirementsFor(loaded.facts.clientKind, loaded.facts.level).map((r) => ({
        key: r.key, label: r.label, labelAr: r.labelAr,
        satisfied: !loaded.assessment.missing.some((m) => m.key === r.key),
      })),
      ownership: {
        identifiedPct: loaded.assessment.ownership.identifiedPct,
        thresholdPct: UBO_THRESHOLD_PCT,
        controlRights: loaded.assessment.ownership.controlBasisCount,
        covered: loaded.assessment.ownership.covered,
        reason: loaded.assessment.ownership.reason,
        owners: loaded.owners,
      },
      screening: {
        required: loaded.subjects,
        unscreened: loaded.assessment.screening.unscreened,
        unresolvedMatches: loaded.assessment.screening.unresolvedMatches,
        confirmedMatches: loaded.assessment.screening.confirmedMatches,
        failedRuns: loaded.assessment.screening.failedRuns,
        complete: loaded.assessment.screening.complete,
        runs: loaded.runs.map((r) => ({
          id: r.id, subjectKind: r.subjectKind, subjectName: r.subjectName,
          status: r.status, listSets: r.listSets, listAsOf: r.listAsOf,
          matchesFound: r.matchesFound, openMatches: r.openMatches,
          failureReason: r.failureReason, runAt: r.runAt,
        })),
      },
      assessment: {
        complete: loaded.assessment.complete,
        missing: loaded.assessment.missing.map((m) => m.key),
        reason: loaded.assessment.reason,
      },
      /* The screen and the gate answer from one call, so a record that reads as
         admissible on the page cannot be refused by the write. */
      admissible: gateOutcome(loaded).allowed,
      refusal: (() => {
        const o = gateOutcome(loaded);
        return o.allowed ? null : { code: o.code, message: o.message };
      })(),
    });
  }));

  r.post('/clients/:clientId/due-diligence', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const clientId = String(req.params.clientId);
    c.permissions.assertCan(p, 'clients.kyc', { type: 'client', id: clientId });
    const body = strictBody(z.object({
      level: z.enum(['simplified', 'standard', 'enhanced']).optional(),
    }).strict(), req, c, '/api/firm/clients/:clientId/due-diligence');

    const client = await c.firm.getClientForTenant(p.tenantId, clientId);
    if (!client) throw notFoundOrForbidden('client', clientId);
    const existing = await c.firm.getCurrentDueDiligence(p.tenantId, clientId);
    if (existing && existing.status !== 'expired') {
      throw conflict('cdd_already_open',
        'this client already has a current due-diligence record — add a version only when the review falls due');
    }
    const id = await c.firm.openDueDiligence({
      tenantId: p.tenantId, clientId, partyId: (client.party_id as string | null) ?? null,
      level: body.level ?? 'standard', membershipId: p.membershipId,
    });
    await c.audit.write({
      action: 'CDD_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'client', resourceId: clientId,
      metadata: { dueDiligenceId: id, level: body.level ?? 'standard', superseded: Boolean(existing) },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id }, 201);
  }));

  r.patch('/due-diligence/:id', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const ddId = String(req.params.id);
    c.permissions.assertCan(p, 'clients.kyc', { type: 'due_diligence', id: ddId });
    const body = strictBody(z.object({
      legalName: z.string().trim().min(2).max(200).optional(),
      legalNameAr: z.string().trim().min(2).max(200).nullable().optional(),
      dateOfBirth: z.string().date().nullable().optional(),
      nationality: z.string().trim().length(2).nullable().optional(),
      residenceCountry: z.string().trim().length(2).nullable().optional(),
      address: z.string().trim().min(5).max(500).nullable().optional(),
      idType: z.enum(['national_id', 'iqama', 'passport', 'gcc_id', 'commercial_registration']).nullable().optional(),
      idNumber: z.string().trim().min(4).max(60).nullable().optional(),
      idIssuedAt: z.string().date().nullable().optional(),
      idExpiresAt: z.string().date().nullable().optional(),
      crNumber: z.string().trim().min(4).max(30).nullable().optional(),
      crIssuedAt: z.string().date().nullable().optional(),
      incorporationCountry: z.string().trim().length(2).nullable().optional(),
      businessActivity: z.string().trim().min(3).max(500).nullable().optional(),
      ownershipStructure: z.string().trim().min(3).max(1000).nullable().optional(),
      sourceOfFunds: z.string().trim().min(5).max(1000).nullable().optional(),
      sourceOfWealth: z.string().trim().min(5).max(1000).nullable().optional(),
      purpose: z.string().trim().min(5).max(1000).nullable().optional(),
      expectedAnnualVolumeSar: z.number().min(0).max(1_000_000_000).nullable().optional(),
      peSubmission: z.never().optional(),
      pepStatus: z.enum(['not_pep', 'pep', 'pep_family', 'pep_associate']).nullable().optional(),
      pepDetails: z.string().trim().max(1000).nullable().optional(),
      verificationMethod: z.enum(['original_seen', 'certified_copy', 'electronic', 'relying_on_third_party']).nullable().optional(),
      verificationSource: z.string().trim().max(500).nullable().optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
    }).strict(), req, c, '/api/firm/due-diligence/:id');

    const dd = await c.firm.getDueDiligence(p.tenantId, ddId);
    if (!dd) throw notFoundOrForbidden('due_diligence', ddId);
    if (dd.status === 'complete' || dd.status === 'unable_to_complete') {
      throw conflict('cdd_record_closed',
        'a completed record is superseded by a new version, never edited — open a review');
    }

    /*
      THE FORM'S FIELD NAMES AND THE COLUMN NAMES ARE NOT THE SAME NAMES, AND THE
      TRANSLATION HAS TO BE WRITTEN DOWN.

      The repository's write takes COLUMN names — an allow-list of them, so that a body
      cannot name a column the feature does not own. The first version of this route passed
      the parsed body straight through, so every camelCase key was filtered out inside the
      repository and the route answered 200 having written nothing at all: a due-diligence
      form that silently stored no answers, with the gate downstream reporting the record
      as incomplete and nobody able to see why. The map below is the translation, and the
      guard after it is the point: a field added to the schema above and forgotten here
      fails the request rather than disappearing into a 200.
    */
    const CD_COLUMNS: Record<string, string> = {
      legalName: 'legal_name', legalNameAr: 'legal_name_ar',
      dateOfBirth: 'date_of_birth', nationality: 'nationality',
      residenceCountry: 'residence_country', address: 'address',
      idType: 'id_type', idIssuedAt: 'id_issued_at', idExpiresAt: 'id_expires_at',
      crNumber: 'cr_number', crIssuedAt: 'cr_issued_at',
      incorporationCountry: 'incorporation_country', businessActivity: 'business_activity',
      ownershipStructure: 'ownership_structure', sourceOfFunds: 'source_of_funds',
      sourceOfWealth: 'source_of_wealth', purpose: 'purpose',
      expectedAnnualVolumeSar: 'expected_annual_volume_sar',
      pepStatus: 'pep_status', pepDetails: 'pep_details',
      verificationMethod: 'verification_method', verificationSource: 'verification_source',
      notes: 'notes',
    };
    const untranslated = Object.keys(body).filter((k) => k !== 'idNumber' && !CD_COLUMNS[k]);
    if (untranslated.length > 0) {
      throw badRequest('validation_failed',
        'these fields are not accepted by this route', { fields: untranslated });
    }
    const fields: Record<string, unknown> = {};
    for (const [sent, column] of Object.entries(CD_COLUMNS)) {
      if (sent in body) fields[column] = (body as Record<string, unknown>)[sent];
    }

    /*
      THE IDENTIFIER IS HASHED HERE, NOT STORED. What the firm keeps is a keyed hash it
      can match against and a mask it can display; the number itself is not needed to
      satisfy the obligation, and a column that held it would be the first thing taken in
      a breach. `keyedHash` is the same primitive the national identifier already uses.
    */
    if (body.idNumber !== undefined) {
      fields.id_number_hash = body.idNumber === null ? null : keyedHash(body.idNumber);
      fields.id_number_masked = body.idNumber === null ? null : maskNationalId(body.idNumber);
    }
    if (body.verificationMethod) fields.verified_at = new Date().toISOString();

    await c.firm.updateDueDiligence({
      tenantId: p.tenantId, id: ddId, fields, membershipId: p.membershipId,
    });
    await c.audit.write({
      action: 'CDD_UPDATED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'client', resourceId: dd.clientId,
      metadata: { dueDiligenceId: ddId, fields: Object.keys(body) },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id: ddId, updated: Object.keys(body) });
  }));

  /**
   * Completing the record — and the assessment that has to agree with it.
   *
   * THE RATING IS RECOMPUTED HERE rather than accepted from the caller, from the record
   * as it now stands. A form that submits its own risk rating is a form that can claim
   * 'low' about a client whose record says otherwise, and the reasons — which are what
   * make the rating reviewable a year later — would be the caller's prose rather than
   * the register's facts.
   */
  r.post('/due-diligence/:id/complete', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const ddId = String(req.params.id);
    c.permissions.assertCan(p, 'clients.kyc', { type: 'due_diligence', id: ddId });
    const body = strictBody(z.object({
      seniorApprovedByMembershipId: z.string().uuid().optional().nullable(),
      seniorApprovalNote: z.string().trim().max(1000).optional().nullable(),
    }).strict(), req, c, '/api/firm/due-diligence/:id/complete');

    const dd = await c.firm.getDueDiligence(p.tenantId, ddId);
    if (!dd) throw notFoundOrForbidden('due_diligence', ddId);

    /*
      THE RATING IS DERIVED FROM THE RECORD AS IT NOW STANDS, through the same assembly the
      screen uses — not from a facts object built here by hand. The first version of this
      route assembled one, with `ownership: ownershipCoverage([])` and a client kind
      guessed from an empty string: it produced `opaque_ownership` on every client,
      including individuals that own nothing, and it never looked at the jurisdiction
      register, so a client resident in a listed country rated high for a different reason
      and the reason list did not mention the country. The reasons are the reviewable part
      of a rating; a reason that is true of everybody is not a reason.
    */
    const loaded = await loadDdFacts(p, dd.clientId);
    const countries = await c.firm.listRiskCountries(p.tenantId);
    const { rating, reasons } = deriveRisk({
      facts: {
        clientKind: loaded?.facts.clientKind ?? 'organization',
        nationality: dd.nationality, residenceCountry: dd.residenceCountry,
        incorporationCountry: dd.incorporationCountry, businessActivity: dd.businessActivity,
        ownership: loaded?.assessment.ownership ?? ownershipCoverage([]),
        pepStatus: dd.pepStatus,
        expectedAnnualVolumeSar: dd.expectedAnnualVolumeSar,
      },
      countries: countries.map((k) => ({
        countryCode: k.countryCode, listSource: k.listSource,
        riskLevel: k.riskLevel as 'high' | 'prohibited',
      })),
    });
    await c.firm.updateDueDiligence({
      tenantId: p.tenantId, id: ddId, membershipId: p.membershipId,
      fields: {
        risk_rating: rating, risk_reasons: JSON.stringify(reasons),
        risk_assessed_at: new Date().toISOString(),
      },
    });
    await c.firm.setReviewDue({
      tenantId: p.tenantId, id: ddId, dueAt: reviewDueAt(rating, new Date()),
    });
    await c.firm.completeDueDiligence({
      tenantId: p.tenantId, id: ddId, membershipId: p.membershipId,
      seniorApproval: body.seniorApprovedByMembershipId
        ? { membershipId: body.seniorApprovedByMembershipId, note: body.seniorApprovalNote ?? null }
        : null,
    });

    /*
      READ AGAIN AFTER THE WRITES. `loaded` was read before the rating, the review clock
      and the completion were written, so its `status` was `not_started` and the gate built
      on it answered `cdd_incomplete` about the record this request had just completed —
      the screen disagreeing with the register in the response to the request that made
      them agree. The evidence is unchanged; only the completeness is, and completeness is
      exactly what this route decides.
    */
    const completed = await loadDdFacts(p, dd.clientId);
    const outcome = gateOutcome(completed);
    await c.audit.write({
      action: 'CDD_COMPLETED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'client', resourceId: dd.clientId,
      metadata: {
        dueDiligenceId: ddId, riskRating: rating,
        riskReasons: reasons.map((r) => r.code), admissible: outcome.allowed,
        refusal: outcome.allowed ? null : outcome.code,
      },
    }, requestInfo(req, c.trustProxy));

    ok(res, {
      id: ddId, riskRating: rating, riskReasons: reasons,
      reviewDueAt: reviewDueAt(rating, new Date()),
      admissible: outcome.allowed,
      refusal: outcome.allowed ? null : { code: outcome.code, message: outcome.message },
      missing: completed?.assessment.missing.map((m) => m.key) ?? [],
    });
  }));

  /**
   * The prohibition, recorded as a decision.
   *
   * THIS IS NOT A WAY TO CLOSE A FILE. It is the answer the manual gives when a client
   * cannot be identified, and it carries a ground the database refuses to do without.
   * The firm's remedy is a new version if the client produces the documents — which is
   * exactly why this does not delete the record.
   */
  r.post('/due-diligence/:id/unable', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const ddId = String(req.params.id);
    c.permissions.assertCan(p, 'compliance.approve', { type: 'due_diligence', id: ddId });
    const body = strictBody(z.object({
      reason: z.string().trim().min(20).max(1000),
    }).strict(), req, c, '/api/firm/due-diligence/:id/unable');

    const dd = await c.firm.getDueDiligence(p.tenantId, ddId);
    if (!dd) throw notFoundOrForbidden('due_diligence', ddId);
    await c.firm.recordUnableToComplete({
      tenantId: p.tenantId, id: ddId, reason: body.reason, membershipId: p.membershipId,
    });
    await c.audit.write({
      action: 'CDD_UNABLE_TO_COMPLETE',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'client', resourceId: dd.clientId,
      reasonCode: 'cdd_unable_to_complete',
      metadata: { dueDiligenceId: ddId, reason: body.reason },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id: ddId, status: 'unable_to_complete' });
  }));

  // ── the persons behind the client ──────────────────────────────────────────
  r.post('/due-diligence/:id/owners', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const ddId = String(req.params.id);
    c.permissions.assertCan(p, 'clients.kyc', { type: 'due_diligence', id: ddId });
    const body = strictBody(z.object({
      id: z.string().uuid().optional().nullable(),
      ownerKind: z.enum(['natural_person', 'legal_person']).default('natural_person'),
      fullName: z.string().trim().min(3).max(200),
      fullNameAr: z.string().trim().max(200).nullable().optional(),
      dateOfBirth: z.string().date().nullable().optional(),
      nationality: z.string().trim().length(2).nullable().optional(),
      residenceCountry: z.string().trim().length(2).nullable().optional(),
      address: z.string().trim().max(500).nullable().optional(),
      idType: z.enum(['national_id', 'iqama', 'passport', 'gcc_id']).nullable().optional(),
      idNumber: z.string().trim().min(4).max(60).nullable().optional(),
      crNumber: z.string().trim().min(4).max(30).nullable().optional(),
      ownershipPct: z.number().min(0).max(100).nullable().optional(),
      controlBasis: z.enum(['ownership', 'voting_rights', 'senior_management', 'other']).default('ownership'),
      controlDescription: z.string().trim().min(10).max(500).nullable().optional(),
      pepStatus: z.enum(['not_pep', 'pep', 'pep_family', 'pep_associate']).nullable().optional(),
      isDesignated: z.boolean().nullable().optional(),
      source: z.string().trim().max(500).nullable().optional(),
      verificationMethod: z.enum(['original_seen', 'certified_copy', 'electronic', 'relying_on_third_party']).nullable().optional(),
      verified: z.boolean().default(false),
      notes: z.string().trim().max(1000).nullable().optional(),
    }).strict(), req, c, '/api/firm/due-diligence/:id/owners');

    const dd = await c.firm.getDueDiligence(p.tenantId, ddId);
    if (!dd) throw notFoundOrForbidden('due_diligence', ddId);

    /*
      THE SHAPE OF A PERSON, CHECKED BEFORE THE DATABASE HAS TO. The table carries CHECKs
      that a natural person has a date of birth and a nationality, and that an ownership
      stake is a positive number — they exist because a register of people with no
      birthdays is a list of names — and without these lines a caller who omitted one got a
      CHECK violation surfaced as a 500. The same rule, in the caller's terms, with the
      field named.
    */
    if (body.ownerKind === 'natural_person' && (!body.dateOfBirth || !body.nationality)) {
      throw badRequest('validation_failed',
        'a natural person is recorded with a date of birth and a nationality', {
          fields: [...(!body.dateOfBirth ? ['dateOfBirth'] : []), ...(!body.nationality ? ['nationality'] : [])],
        });
    }
    if (body.controlBasis === 'ownership' && !(Number(body.ownershipPct ?? 0) > 0)) {
      throw badRequest('validation_failed',
        'an owner recorded by shareholding is recorded with the share, or with the control right that puts them there', {
          fields: ['ownershipPct', 'controlBasis'],
        });
    }
    if (body.controlBasis !== 'ownership' && !body.controlDescription) {
      throw badRequest('validation_failed',
        'a control right is recorded with the document that creates it', { fields: ['controlDescription'] });
    }

    const id = await c.firm.upsertBeneficialOwner({
      tenantId: p.tenantId, id: body.id ?? null, ddId, clientId: dd.clientId,
      partyId: null, membershipId: p.membershipId,
      fields: {
        ...body,
        idNumberHash: body.idNumber ? keyedHash(body.idNumber) : null,
        idNumberMasked: body.idNumber ? maskNationalId(body.idNumber) : null,
        verifiedAt: body.verified ? new Date().toISOString() : null,
      },
    });
    await c.audit.write({
      action: body.verified ? 'BENEFICIAL_OWNER_VERIFIED' : 'BENEFICIAL_OWNER_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'client', resourceId: dd.clientId,
      metadata: {
        dueDiligenceId: ddId, ownerId: id, ownershipPct: body.ownershipPct ?? null,
        controlBasis: body.controlBasis, thresholdOwner:
          body.controlBasis !== 'ownership' || Number(body.ownershipPct ?? 0) >= UBO_THRESHOLD_PCT,
      },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id }, body.id ? 200 : 201);
  }));

  // ── screening ──────────────────────────────────────────────────────────────
  /**
   * Recording what a screening actually returned.
   *
   * THE PROVIDER IS NOT CALLED HERE. This route records the RESULT of a screening —
   * against the internal register, by hand, or from a feed — because the system has no
   * integration with a screening provider and a route that pretended to have one would
   * be a claim nothing computed, which is the defect class this whole phase exists to
   * remove. What it refuses to do is let a failed screening pass for a clear one: the
   * status is the caller's, the count is derived from the matches, and the database
   * refuses `clear` with matches or `failed` without a reason.
   */
  r.post('/clients/:clientId/screening-runs', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const clientId = String(req.params.clientId);
    c.permissions.assertCan(p, 'clients.kyc', { type: 'client', id: clientId });
    const body = strictBody(z.object({
      subjectKind: z.enum(['client', 'party', 'beneficial_owner', 'staff']),
      subjectId: z.string().uuid(),
      subjectName: z.string().trim().min(2).max(200),
      listSets: z.array(z.enum(['un_consolidated', 'eu_consolidated', 'sama_designations',
        'internal_register', 'local_media'])).min(1),
      listAsOf: z.string().date().nullable().optional(),
      provider: z.enum(['internal_register', 'manual_review', 'external_provider', 'regulator_feed']),
      providerReference: z.string().trim().max(200).nullable().optional(),
      status: z.enum(['clear', 'potential_match', 'match', 'failed']),
      failureReason: z.string().trim().min(5).max(500).nullable().optional(),
      note: z.string().trim().max(1000).nullable().optional(),
      matches: z.array(z.object({
        listSource: z.string().trim().min(2).max(100),
        matchedName: z.string().trim().min(2).max(200),
        matchedReference: z.string().trim().max(200).nullable().optional(),
        matchKind: z.enum(['exact_name', 'fuzzy_name', 'national_id', 'alias', 'date_of_birth', 'address']),
        score: z.number().min(0).max(100).nullable().optional(),
      })).max(50).default([]),
    }).strict(), req, c, '/api/firm/clients/:clientId/screening-runs');

    const dd = await c.firm.getCurrentDueDiligence(p.tenantId, clientId);
    if (!dd) throw badRequest('cdd_missing', 'this client has no due-diligence record to screen against');
    if (body.status === 'clear' && body.matches.length > 0) {
      throw badRequest('validation_failed', 'a clearance with matches on it is not a clearance');
    }
    if (body.status !== 'clear' && body.matches.length === 0) {
      throw badRequest('validation_failed', 'a run that found something must carry what it found');
    }
    if (body.status === 'failed' && !body.failureReason) {
      throw badRequest('validation_failed', 'a failed screening says what failed');
    }
    const run = await c.firm.recordScreeningRun({
      tenantId: p.tenantId, clientId, ddId: dd.id,
      subjectKind: body.subjectKind, subjectId: body.subjectId, subjectName: body.subjectName,
      listSets: body.listSets, listAsOf: body.listAsOf ?? null, provider: body.provider,
      providerReference: body.providerReference ?? null, status: body.status,
      failureReason: body.failureReason ?? null, note: body.note ?? null,
      membershipId: p.membershipId,
      matches: body.matches.map((m) => ({
        listSource: m.listSource, matchedName: m.matchedName,
        matchedReference: m.matchedReference ?? null, matchKind: m.matchKind, score: m.score ?? null,
      })),
    });
    await c.audit.write({
      action: body.status === 'failed' ? 'SCREENING_FAILED'
        : body.matches.length > 0 ? 'SCREENING_MATCH_FOUND' : 'SCREENING_RUN',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'client', resourceId: clientId,
      metadata: {
        runId: run.id, subjectKind: body.subjectKind, subjectId: body.subjectId,
        status: body.status, listSets: body.listSets, listAsOf: body.listAsOf ?? null,
        matchesFound: run.matchesFound, failureReason: body.failureReason ?? null,
      },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id: run.id, matchesFound: run.matchesFound }, 201);
  }));

  r.post('/screening-matches/:matchId/disposition', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const matchId = String(req.params.matchId);
    c.permissions.assertCan(p, 'compliance.review', { type: 'screening_match', id: matchId });
    const body = strictBody(z.object({
      disposition: z.enum(['false_positive', 'true_match', 'escalated']),
      reason: z.string().trim().min(10).max(1000),
    }).strict(), req, c, '/api/firm/screening-matches/:matchId/disposition');

    const changed = await c.firm.dispositionScreeningMatch({
      tenantId: p.tenantId, matchId, disposition: body.disposition,
      reason: body.reason, membershipId: p.membershipId,
    });
    if (changed === 0) {
      throw conflict('already_dispositioned',
        'this match has already been decided — run a new screening rather than re-deciding it');
    }
    await c.audit.write({
      action: 'SCREENING_MATCH_DISPOSITIONED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'screening_match', resourceId: matchId,
      metadata: { disposition: body.disposition, reason: body.reason },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id: matchId, disposition: body.disposition });
  }));

  // ── the report ─────────────────────────────────────────────────────────────
  r.get('/str-reports', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'compliance.read', { type: 'compliance_collection' });
    const rows = await c.firm.listStrReports(p.tenantId, {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      clientId: typeof req.query.clientId === 'string' ? req.query.clientId : undefined,
    });
    const now = Date.now();
    ok(res, {
      reports: rows.map((r) => ({
        ...r,
        // Late is computed, not stored: a stored flag would be wrong by the next morning.
        late: r.status !== 'filed' && r.filedDueAt !== null && new Date(String(r.filedDueAt)).getTime() < now,
      })),
      indicators: STR_INDICATORS,
    });
  }));

  r.post('/str-reports', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'compliance.create', { type: 'str_report' });
    const body = strictBody(z.object({
      reportNumber: z.string().trim().min(3).max(40),
      subjectKind: z.enum(['client', 'party', 'beneficial_owner', 'staff', 'transaction']),
      subjectId: z.string().uuid().nullable().optional(),
      subjectName: z.string().trim().max(200).nullable().optional(),
      clientId: z.string().uuid().nullable().optional(),
      matterId: z.string().uuid().nullable().optional(),
      grounds: z.array(z.string().trim().min(2).max(60)).min(1),
      narrativeAr: z.string().trim().min(40).max(20_000),
      narrativeEn: z.string().trim().max(20_000).nullable().optional(),
      amountSar: z.number().min(0).nullable().optional(),
      transactionReference: z.string().trim().max(200).nullable().optional(),
      transactionAt: z.string().datetime().nullable().optional(),
    }).strict(), req, c, '/api/firm/str-reports');

    const readiness = strReadiness({
      narrativeAr: body.narrativeAr, grounds: body.grounds,
      subjectKind: body.subjectKind, status: 'draft',
    });
    if (!readiness.ready) {
      /*
        THE CODE NAMES THE RULE THAT BIT. `str_narrative_not_arabic` is the refusal the
        database raises and the manual implies — SAFIU is addressed in Arabic — so a
        narrative in English is reported as that, not as a general incompleteness. Two
        codes for one problem would mean the person at the desk sees one of them
        depending on which layer noticed first, which is how a vocabulary stops meaning
        anything.
      */
      const arabicProblem = !containsArabic(body.narrativeAr);
      throw badRequest(arabicProblem ? 'str_narrative_not_arabic' : 'str_narrative_incomplete',
        readiness.reasons.join('; '));
    }
    const preparedAt = new Date();
    const id = await c.firm.createStrReport({
      tenantId: p.tenantId, reportNumber: body.reportNumber, subjectKind: body.subjectKind,
      subjectId: body.subjectId ?? null, subjectName: body.subjectName ?? null,
      clientId: body.clientId ?? null, matterId: body.matterId ?? null,
      grounds: body.grounds, narrativeAr: body.narrativeAr, narrativeEn: body.narrativeEn ?? null,
      amountSar: body.amountSar ?? null, transactionReference: body.transactionReference ?? null,
      transactionAt: body.transactionAt ?? null, membershipId: p.membershipId,
      preparedAt, dueAt: strDueAt(preparedAt),
    });
    await c.audit.write({
      action: 'STR_PREPARED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'str_report', resourceId: id,
      metadata: {
        reportNumber: body.reportNumber, subjectKind: body.subjectKind,
        grounds: body.grounds, amountSar: body.amountSar ?? null,
        filedDueAt: strDueAt(preparedAt),
      },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id, reportNumber: body.reportNumber, filedDueAt: strDueAt(preparedAt) }, 201);
  }));

  r.post('/str-reports/:id/review', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const id = String(req.params.id);
    c.permissions.assertCan(p, 'compliance.approve', { type: 'str_report', id });
    /*
      THE ROW IS LOOKED UP FIRST, and the reason is the 404/409 distinction. Without the
      lookup, a report id that does not exist returns "only a draft can be sent for review"
      — a statement about a report that is not there, and an existence oracle in reverse.
      The lookup also answers the question the status cannot: a report in another tenant
      is not found, which is what a caller should learn.
    */
    const report = await c.firm.getStrReport(p.tenantId, id);
    if (!report) throw notFoundOrForbidden('str_report', id);
    const changed = await c.firm.reviewStrReport({
      tenantId: p.tenantId, id, membershipId: p.membershipId,
    });
    if (changed === 0) throw conflict('str_not_draft', 'only a draft can be sent for review');
    await c.audit.write({
      action: 'STR_REVIEWED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'str_report', resourceId: id,
    }, requestInfo(req, c.trustProxy));
    ok(res, { id, status: 'pending_review' });
  }));

  /**
   * THE FILING, AND THE ACKNOWLEDGEMENT THAT GOES WITH IT.
   *
   * `tippingOffAcknowledged` is required and it is not a checkbox for its own sake:
   * tipping off is a separate offence under the same law, and a firm that has not
   * recorded that the client was not told has not given the instruction. The database
   * refuses a filed report without it, so a caller that omits it is refused here too.
   */
  r.post('/str-reports/:id/file', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const id = String(req.params.id);
    c.permissions.assertCan(p, 'compliance.approve', { type: 'str_report', id });
    const body = strictBody(z.object({
      fiuReference: z.string().trim().min(3).max(100),
      tippingOffAcknowledged: z.literal(true),
    }).strict(), req, c, '/api/firm/str-reports/:id/file');

    const report = await c.firm.getStrReport(p.tenantId, id);
    if (!report) throw notFoundOrForbidden('str_report', id);
    const changed = await c.firm.fileStrReport({
      tenantId: p.tenantId, id, membershipId: p.membershipId,
      fiuReference: body.fiuReference, tippingOffAcknowledged: true,
    });
    if (changed === 0) {
      throw conflict('str_not_reviewed', 'a report is reviewed before it is filed');
    }
    await c.audit.write({
      action: 'STR_FILED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'str_report', resourceId: id,
      // The reference, the issuer and the moment — not the narrative. A log row is not
      // where a report's contents belong; the report is.
      metadata: { fiuReference: body.fiuReference, tippingOffAcknowledged: true },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id, status: 'filed' });
  }));

  r.post('/str-reports/:id/response', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const id = String(req.params.id);
    c.permissions.assertCan(p, 'compliance.approve', { type: 'str_report', id });
    const body = strictBody(z.object({
      status: z.enum(['acknowledged', 'rejected_by_fiu']),
      response: z.string().trim().max(5000).nullable().optional(),
    }).strict(), req, c, '/api/firm/str-reports/:id/response');
    const report = await c.firm.getStrReport(p.tenantId, id);
    if (!report) throw notFoundOrForbidden('str_report', id);
    const changed = await c.firm.recordFiuResponse({
      tenantId: p.tenantId, id, status: body.status, response: body.response ?? null,
    });
    if (changed === 0) throw conflict('str_not_filed', 'only a filed report has an answer to record');
    await c.audit.write({
      action: 'STR_RESPONSE_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'str_report', resourceId: id,
      metadata: { status: body.status },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id, status: body.status });
  }));

  // ── the queue, the census and the register ─────────────────────────────────
  r.get('/compliance/due-diligence', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'compliance.read', { type: 'compliance_collection' });
    const [queue, census, countries] = await Promise.all([
      c.firm.dueDiligenceQueue(p.tenantId),
      c.firm.dueDiligenceCensus(p.tenantId),
      c.firm.listRiskCountries(p.tenantId),
    ]);
    ok(res, {
      census, countries, queue,
      thresholdPct: UBO_THRESHOLD_PCT,
      reviewMonths: REVIEW_MONTHS,
      /* Who this firm may not act for, in one list — the first thing a compliance page
         should answer, and the answer the gate gives. */
      refused: queue.filter((q) => !q.allowed)
        .map((q) => ({ clientId: q.clientId, clientName: q.clientName, blockers: q.blockers })),
    });
  }));

  r.post('/compliance/risk-countries', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'compliance.approve', { type: 'risk_register' });
    const body = strictBody(z.object({
      id: z.string().uuid().nullable().optional(),
      countryCode: z.string().trim().length(2),
      countryName: z.string().trim().min(3).max(120),
      countryNameAr: z.string().trim().max(120).nullable().optional(),
      listSource: z.enum(['fatf_call_for_action', 'fatf_grey', 'un_sanctions', 'eu_consolidated', 'sama_circular', 'internal']),
      riskLevel: z.enum(['high', 'prohibited']),
      effectiveFrom: z.string().date(),
      note: z.string().trim().max(500).nullable().optional(),
    }).strict(), req, c, '/api/firm/compliance/risk-countries');

    const id = await c.firm.upsertRiskCountry({
      tenantId: p.tenantId, id: body.id ?? null, countryCode: body.countryCode.toUpperCase(),
      countryName: body.countryName, countryNameAr: body.countryNameAr ?? null,
      listSource: body.listSource, riskLevel: body.riskLevel, effectiveFrom: body.effectiveFrom,
      note: body.note ?? null, membershipId: p.membershipId,
    });
    await c.audit.write({
      action: 'RISK_COUNTRY_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'risk_country', resourceId: id,
      metadata: { countryCode: body.countryCode, listSource: body.listSource, riskLevel: body.riskLevel },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id }, body.id ? 200 : 201);
  }));

  /* ═══════════════════════════════════════════════════════════════════════════
     P0.4 · JUDGMENTS, SERVICE AND THE APPEAL PERIOD

     WHERE THE GATE LIVES. The same three places P0.3 established, each answering a
     different question:

       · the ROUTE refuses with a named code, so the person reading learns which fact is
         missing and, where the system knows, the date the refusal stops being true;
       · the DOMAIN (`executionOutcome`, `assessJudgment`) is what the route asks, and it
         is the same function the register on the screen is built from — so the list and
         the gate cannot disagree about which judgments may be enforced;
       · the DATABASE refuses the transition into `execution` whether or not this
         application asked (0045 and its SQLite mirror). A last line of defence that
         depends on the application being right is not one.

     WHAT THIS FILE COMPUTES AND WHAT IT STORES. Every period is computed by
     `server/src/domain/judgments.ts` and the RESULT is written down — the deadline, the
     article, the number of days. No trigger recomputes it, in either engine. That is the
     P0.3 lesson applied in advance: a rule with three implementations has none.
     ═══════════════════════════════════════════════════════════════════════════ */

  /**
   * A register row as the DOMAIN's facts.
   *
   * ONE MAPPER, TWO CALLERS. The gate and the register both ask about the same judgment and
   * must answer from the same values — a second mapping written for the list view would be
   * the third implementation of the same rule, which is the shape of defect this phase
   * exists to stop repeating.
   */
  function factsOf(j: Record<string, unknown>): JudgmentFacts {
    const appeals = (j.appeals ?? []) as Array<Record<string, unknown>>;
    return {
      id: String(j.id), matterId: String(j.matterId), clientId: String(j.clientId),
      kind: String(j.judgmentKind) as JudgmentKind,
      urgent: Boolean(j.urgent),
      pronouncedAt: String(j.pronouncedAt),
      servedAt: (j.servedAt ?? null) as string | null,
      serviceEffectiveAt: (j.serviceEffectiveAt ?? null) as string | null,
      serviceAttemptedWithoutEffect: Boolean(j.serviceAttemptedWithoutEffect),
      appealable: Boolean(j.appealable),
      finalAt: (j.finalAt ?? null) as string | null,
      stayInForce: Boolean(j.stayInForce),
      relief: String(j.reliefKind) as ReliefKind,
      amountSar: (j.amountSar ?? null) as number | null,
      enforcementStatus: String(j.enforcementStatus) as EnforcementStatus,
      appeals: appeals.map((a) => ({
        id: String(a.id), kind: String(a.kind) as AppealKind,
        status: String(a.status) as AppealStatus, filedAt: String(a.filedAt),
        deadlineAt: (a.deadlineAt ?? null) as string | null,
        outcome: (a.outcome ?? null) as AppealOutcome | null,
      })),
      appealDeadlineAt: (j.appealDeadlineAt ?? null) as string | null,
      appealRuleCited: (j.appealRuleCited ?? null) as string | null,
      appealRuleDays: (j.appealRuleDays ?? null) as number | null,
    };
  }

  /** Everything the execution gate and the register need about one matter's judgments. */
  async function loadAllJudgments(
    p: { tenantId: string },
    clientId: string | null,
    matterId?: string | null,
  ) {
    const rows = await c.firm.enforcementRegister(
      p.tenantId, { clientId, matterId: matterId ?? null });
    return rows.map((j) => {
      const facts = factsOf(j as unknown as Record<string, unknown>);
      return {
        facts,
        assessment: assessJudgment(facts),
        row: j as unknown as Record<string, unknown>,
      };
    });
  }

  /**
   * The gate, as a route asks it.
   *
   * REFUSES WITH THE DOMAIN'S OWN CODE AND MESSAGE, and carries the date the refusal
   * stops being true when there is one. `appeal_window_open` without its date is a wall;
   * with it, it is an instruction — and the register sorts by that date, which is the
   * whole reason it is on the wire.
   */
  async function assertEnforcementAdmits(
    req: import('express').Request,
    p: { tenantId: string; userId: string },
    matterId: string,
  ): Promise<void> {
    const loaded = await loadAllJudgments(p, null, matterId);
    const outcome = executionOutcome({ judgments: loaded.map((r) => r.facts) });
    if (outcome.allowed) return;

    await c.audit.write({
      action: 'EXECUTION_GATE_DENIED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'denied',
      reasonCode: outcome.code,
      resourceType: 'matter',
      resourceId: matterId,
      /*
        THE METADATA KEY IS `refusal`, NOT `code`.
        P0.3 shipped `code` and the audit writer's denylist dropped the whole event, so the
        refusal happened and nothing recorded that it had. The key is named for the thing it
        carries and checked against `AUDIT_METADATA_DENYLIST_*` before use.
      */
      metadata: {
        refusal: outcome.code,
        unblocksAt: outcome.unblocksAt,
        matterId,
      },
    }, requestInfo(req, c.trustProxy));

    throw forbidden(outcome.code, outcome.message, outcome.code);
  }

  // ── the court calendar ────────────────────────────────────────────────────

  r.get('/court-calendar', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'court_calendar.read', { type: 'court_calendar' });
    const from = String(req.query.from ?? `${new Date().getUTCFullYear()}-01-01`).slice(0, 10);
    const to = String(req.query.to ?? `${new Date().getUTCFullYear()}-12-31`).slice(0, 10);
    const days = await c.firm.listCourtCalendar(p.tenantId, from, to);
    ok(res, { from, to, days, weekend: COURT_WEEKEND_DAYS });
  }));

  r.post('/court-calendar', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'court_calendar.manage', { type: 'court_calendar' });
    const body = strictBody(z.object({
      calendarDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      /* Optional: the server derives it from the Gregorian date when the caller does not
         supply one, so an operator entering a holiday does not have to convert a calendar
         by hand — and the two cannot disagree because one of them is computed here. */
      hijriDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      kind: z.enum(['weekend', 'public_holiday', 'court_recess', 'emergency_closure']),
      name: z.string().trim().min(2).max(120),
      nameAr: z.string().trim().min(2).max(120),
      note: z.string().trim().max(500).optional(),
    }).strict(), req, c, '/api/firm/court-calendar');

    const id = await c.firm.upsertCourtCalendarDay({
      tenantId: p.tenantId,
      calendarDate: body.calendarDate,
      hijriDate: body.hijriDate ?? hijriDateOf(body.calendarDate),
      kind: body.kind, name: body.name, nameAr: body.nameAr, note: body.note ?? null,
      membershipId: p.membershipId,
    });
    await c.audit.write({
      action: 'COURT_CALENDAR_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'court_calendar', resourceId: id,
      metadata: {
        calendarDate: body.calendarDate, kind: body.kind,
        hijriDate: body.hijriDate ?? hijriDateOf(body.calendarDate),
      },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id, hijriDate: body.hijriDate ?? hijriDateOf(body.calendarDate) }, 201);
  }));

  r.delete('/court-calendar/:id', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const id = String(req.params.id);
    c.permissions.assertCan(p, 'court_calendar.manage', { type: 'court_calendar', id });
    /* The row is looked up first: a delete that reports success for an id that was never
       there cannot be distinguished from one that worked, and this table decides statutory
       dates. 404 where 404 belongs, not a cheerful 200. */
    const days = await c.firm.listCourtCalendar(p.tenantId, '0001-01-01', '9999-12-31');
    const row = days.find((d) => d.id === id);
    if (!row) throw notFoundOrForbidden('not_found', 'no such calendar day');
    const removed = await c.firm.deleteCourtCalendarDay(p.tenantId, id);
    await c.audit.write({
      action: 'COURT_CALENDAR_REMOVED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: removed ? 'success' : 'denied', resourceType: 'court_calendar', resourceId: id,
      metadata: { calendarDate: row.calendarDate, removed },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id, removed });
  }));

  // ── the register ──────────────────────────────────────────────────────────

  r.get('/judgments', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'judgments.read', { type: 'judgment' });
    const matterId = req.query.matterId ? String(req.query.matterId) : null;
    const clientId = req.query.clientId ? String(req.query.clientId) : null;
    const scoped = await loadAllJudgments(p, clientId, matterId);
    const entries = enforcementRegister(
      scoped.map(({ facts, assessment }) => ({ facts, assessment })),
    );
    const byId = new Map(scoped.map((s) => [s.facts.id, s]));
    ok(res, {
      /*
        THE REGISTER IS THE DOMAIN'S ANSWER, not the repository's ordering. The rows come
        back in the order the register computes — decided first, then whatever unblocks
        soonest — because a list sorted by the matter puts the judgment whose period closes
        on Thursday below the one that cannot move at all, which is the wrong list for the
        person who opens it on Thursday morning.
      */
      register: entries.map((e) => {
        const loaded = byId.get(e.judgmentId)!;
        return {
          ...judgmentView(loaded.facts, loaded.row),
          enforcementStatus: e.enforcementStatus,
          nextStep: e.nextStep,
          allowed: e.outcome.allowed,
          refusal: e.outcome.allowed ? null : e.outcome.code,
          refusalMessage: e.outcome.allowed ? null : e.outcome.message,
          unblocksAt: e.unblocksAt,
          assessment: {
            final: loaded.assessment.final,
            enforceable: loaded.assessment.enforceable,
            appealPending: loaded.assessment.appealPending,
            windowOpen: loaded.assessment.windowOpen,
          },
        };
      }),
      rules: appealRulesCatalogue(),
      weekend: COURT_WEEKEND_DAYS,
    });
  }));

  /**
   * The wire shape of a judgment: the domain's facts, plus what a screen labels them with.
   *
   * THE ROW IS PASSED IN, because the facts are the domain's vocabulary and the row is the
   * register's — a screen wants the circuit, the deed number and the client's name, and the
   * domain has no business carrying any of them. Mapping here rather than at the call site
   * is what keeps the two from being confused for each other, which is the defect P0.3 paid
   * for when a projection returned `vat_number` and the route read `vatNumber`.
   */
  function judgmentView(
    f: JudgmentFacts,
    row?: Record<string, unknown> | null,
  ) {
    return {
      id: f.id, matterId: f.matterId, clientId: f.clientId,
      deedNumber: row?.deedNumber ?? null,
      caseNumber: row?.caseNumber ?? null,
      court: row?.court ?? null, courtAr: row?.courtAr ?? null,
      currency: row?.currency ?? 'SAR',
      circuit: row?.circuit ?? null, circuitAr: row?.circuitAr ?? null,
      judgmentKind: f.kind, presence: row?.presence ?? null, urgent: f.urgent,
      pronouncedAt: f.pronouncedAt,
      reliefKind: f.relief, amountSar: f.amountSar,
      verdictFor: row?.verdictFor ?? null,
      summary: row?.summary ?? null, summaryAr: row?.summaryAr ?? null,
      documentId: row?.documentId ?? null,
      appealable: f.appealable, finalAt: f.finalAt,
      servedAt: f.servedAt, serviceEffectiveAt: f.serviceEffectiveAt,
      appealDeadlineAt: f.appealDeadlineAt, appealRuleCited: f.appealRuleCited,
      appealRuleDays: f.appealRuleDays,
      stayInForce: f.stayInForce, stayReason: row?.stayReason ?? null,
      enforcementStatus: f.enforcementStatus,
      matterNumber: row?.matterNumber ?? null, matterTitle: row?.matterTitle ?? null,
      clientName: row?.clientName ?? null,
    };
  }

  r.get('/matters/:id/judgments', ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'judgments.read', { type: 'matter', id: matterId });
    const matter = await c.firm.getMatterRow(p.tenantId, matterId);
    if (!matter) throw notFoundOrForbidden('not_found', 'no such matter');

    const loaded = await loadAllJudgments(p, null, matterId);
    const operative = operativeJudgment(loaded.map((l) => l.facts));
    ok(res, {
      matterId,
      judgments: loaded.map((l) => ({
        ...judgmentView({ ...l.facts }),
        assessment: l.assessment,
        operative: operative?.id === l.facts.id,
        execution: executionOutcome({ judgments: l.facts ? [l.facts] : [] }),
      })),
      /* The gate about the MATTER, which is what the enforcement button asks. */
      matterExecution: executionOutcome({ judgments: loaded.map((l) => l.facts) }),
      services: (await c.firm.listServiceEvents(p.tenantId, { matterId })).map((s) => ({
        id: s.id, judgmentId: s.judgmentId, noticeKind: s.noticeKind, method: s.method,
        outcome: s.outcome, servedOnKind: s.servedOnKind, servedOnName: s.servedOnName,
        attemptedAt: s.attemptedAt, servedAt: s.servedAt, effectiveAt: s.effectiveAt,
        publicationDays: s.publicationDays, proofReference: s.proofReference,
        proofDocumentId: s.proofDocumentId, deadlineId: s.deadlineId,
        /* The proof question is answered here rather than left to the reader: a service
           that happened and cannot be evidenced is a finding, and the register says so. */
        evidenced: Boolean(s.proofDocumentId || s.proofReference),
      })),
      rules: appealRulesCatalogue(),
    });
  }));

  r.post('/matters/:id/judgments', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const matterId = String(req.params.id);
    c.permissions.assertCan(p, 'judgments.record', { type: 'matter', id: matterId });
    const matter = await c.firm.getMatterRow(p.tenantId, matterId);
    if (!matter) throw notFoundOrForbidden('not_found', 'no such matter');

    const body = strictBody(z.object({
      deedNumber: z.string().trim().min(1).max(60),
      caseNumber: z.string().trim().max(60).nullable().optional(),
      court: z.string().trim().min(2).max(200),
      courtAr: z.string().trim().min(2).max(200),
      circuit: z.string().trim().max(100).nullable().optional(),
      circuitAr: z.string().trim().max(100).nullable().optional(),
      judgeName: z.string().trim().max(200).nullable().optional(),
      judgmentKind: z.enum(['first_instance', 'appeal', 'cassation']),
      presence: z.enum(['in_presence', 'in_absentia', 'in_absentia_default']).default('in_presence'),
      urgent: z.boolean().default(false),
      pronouncedAt: z.string().datetime(),
      reliefKind: z.enum(['monetary', 'non_monetary', 'none']).default('none'),
      amountSar: z.number().min(0).nullable().optional(),
      currency: z.string().trim().length(3).default('SAR'),
      verdictFor: z.enum(['client', 'opponent', 'split', 'procedural']).nullable().optional(),
      summary: z.string().trim().max(4000).nullable().optional(),
      summaryAr: z.string().trim().max(4000).nullable().optional(),
      documentId: z.string().uuid().nullable().optional(),
      appealable: z.boolean().default(true),
    }).strict(), req, c, `/api/firm/matters/${matterId}/judgments`);

    /*
      A MONETARY JUDGMENT WITH NO AMOUNT IS REFUSED HERE, not by a CHECK constraint that
      would surface as a 500. The database has the same rule; this is the version the person
      reads, and it names the field.
    */
    if (body.reliefKind === 'monetary' && (body.amountSar ?? null) === null) {
      throw badRequest('validation_failed', 'a monetary judgment must carry the amount it awards', {
        fields: ['amountSar'],
      });
    }

    const clientId = String(matter.client_id ?? matter.clientId);
    const id = await c.firm.createJudgment({
      tenantId: p.tenantId, clientId, matterId,
      deedNumber: body.deedNumber, caseNumber: body.caseNumber ?? null,
      court: body.court, courtAr: body.courtAr, circuit: body.circuit ?? null,
      circuitAr: body.circuitAr ?? null, judgeName: body.judgeName ?? null,
      judgmentKind: body.judgmentKind, presence: body.presence, urgent: body.urgent,
      pronouncedAt: body.pronouncedAt, reliefKind: body.reliefKind,
      amountSar: body.amountSar ?? null, currency: body.currency,
      verdictFor: body.verdictFor ?? null, summary: body.summary ?? null,
      summaryAr: body.summaryAr ?? null, documentId: body.documentId ?? null,
      appealable: body.appealable, membershipId: p.membershipId,
    });

    /* The timeline gets the event the portal is allowed to see — a judgment was pronounced.
       The register is the firm's; the timeline is the projection, and it says what the
       client may know: that a decision was issued, not the firm's plan for it. */
    await c.firm.addTimelineEntry({
      tenantId: p.tenantId, matterId, clientId,
      eventType: 'judgment', occurredAt: body.pronouncedAt,
      title: `Judgment recorded: ${body.deedNumber}`,
      titleAr: `تسجيل صك الحكم: ${body.deedNumber}`,
      description: null, descriptionAr: null,
      status: 'complete', clientVisible: true, createdByStaff: p.staffId ?? null,
    }).catch(() => {
      /* A timeline row is a projection; failing to write one must not fail the record. */
    });

    await c.audit.write({
      action: 'JUDGMENT_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'judgment', resourceId: id,
      metadata: {
        deedNumber: body.deedNumber, judgmentKind: body.judgmentKind,
        reliefKind: body.reliefKind, amountSar: body.amountSar ?? null,
        pronouncedAt: body.pronouncedAt, appealable: body.appealable,
      },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id, deedNumber: body.deedNumber }, 201);
  }));

  r.patch('/judgments/:id', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const id = String(req.params.id);
    c.permissions.assertCan(p, 'judgments.manage', { type: 'judgment', id });
    const before = await c.firm.getJudgment(p.tenantId, id);
    if (!before) throw notFoundOrForbidden('not_found', 'no such judgment');

    const body = strictBody(z.object({
      deedNumber: z.string().trim().min(1).max(60).optional(),
      caseNumber: z.string().trim().max(60).nullable().optional(),
      court: z.string().trim().min(2).max(200).optional(),
      courtAr: z.string().trim().min(2).max(200).optional(),
      circuit: z.string().trim().max(100).nullable().optional(),
      circuitAr: z.string().trim().max(100).nullable().optional(),
      judgeName: z.string().trim().max(200).nullable().optional(),
      judgmentKind: z.enum(['first_instance', 'appeal', 'cassation']).optional(),
      presence: z.enum(['in_presence', 'in_absentia', 'in_absentia_default']).optional(),
      urgent: z.boolean().optional(),
      pronouncedAt: z.string().datetime().optional(),
      reliefKind: z.enum(['monetary', 'non_monetary', 'none']).optional(),
      amountSar: z.number().min(0).nullable().optional(),
      verdictFor: z.enum(['client', 'opponent', 'split', 'procedural']).nullable().optional(),
      summary: z.string().trim().max(4000).nullable().optional(),
      summaryAr: z.string().trim().max(4000).nullable().optional(),
      documentId: z.string().uuid().nullable().optional(),
      /*
        THE THREE THAT DECIDE ENFORCEMENT, and each is a statement rather than a form field:
        `appealable` says the law provides no route to challenge it; `finalAt` says a court
        has closed it; the stay says a court has stopped it. All three are `judgments.manage`.
      */
      appealable: z.boolean().optional(),
      finalAt: z.string().datetime().nullable().optional(),
      stayInForce: z.boolean().optional(),
      stayReason: z.string().trim().max(500).nullable().optional(),
      stayOrderedAt: z.string().datetime().nullable().optional(),
      enforcementStatus: z.enum(['not_enforceable', 'awaiting_finality', 'enforceable',
        'stayed', 'under_enforcement', 'satisfied', 'closed']).optional(),
      enforcementCourt: z.string().trim().max(200).nullable().optional(),
      enforcementReference: z.string().trim().max(100).nullable().optional(),
      satisfiedAt: z.string().datetime().nullable().optional(),
      recoveredAmountSar: z.number().min(0).nullable().optional(),
    }).strict(), req, c, `/api/firm/judgments/${id}`);

    /*
      A STAY WITHOUT ITS ORDER IS REFUSED, because the database refuses it too — and the
      version the person reads should be this one. The same shape of check the CDD route
      makes before the record is written: say it here, in the domain's words, rather than let
      a constraint surface as a 500.
    */
    if (body.stayInForce === true && !(body.stayOrderedAt ?? before.stayOrderedAt)) {
      throw badRequest('validation_failed',
        'a stay of execution must carry the order it comes from: record when it was ordered',
        { fields: ['stayOrderedAt'] });
    }
    if (body.reliefKind === 'monetary' && (body.amountSar ?? before.amountSar ?? null) === null) {
      throw badRequest('validation_failed', 'a monetary judgment must carry the amount it awards',
        { fields: ['amountSar'] });
    }

    const changes = await c.firm.updateJudgment(p.tenantId, id, body);
    await c.audit.write({
      action: 'JUDGMENT_AMENDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: changes ? 'success' : 'denied', resourceType: 'judgment', resourceId: id,
      metadata: {
        fields: Object.keys(body).slice(0, 20),
        changed: changes,
        /* What the enforcement posture was and is — the pair is the answer to "who decided
           this may be collected", which is the question asked after the fact. */
        enforcementStatusBefore: before.enforcementStatus,
        enforcementStatusAfter: body.enforcementStatus ?? before.enforcementStatus,
      },
    }, requestInfo(req, c.trustProxy));

    const after = await c.firm.getJudgment(p.tenantId, id);
    ok(res, {
      id, changed: changes,
      judgment: after
        /* The row is what a screen reads; the facts are what the gate reads. Rebuilding the
           facts here and handing them to the view is how a projection ends up missing the
           column the view names — the defect P0.3 paid for — so both are passed. */
        ? { ...judgmentView(factsOf(after), after as unknown as Record<string, unknown>),
            enforcementStatus: after.enforcementStatus }
        : null,
    });
  }));

  // ── service: the fact the whole phase is about ────────────────────────────

  r.post('/judgments/:id/service', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const id = String(req.params.id);
    /*
      `judgments.serve`, NOT `judgments.record`. Recording a صك is reading a court document
      back into the file; recording its DELIVERY is the fact that starts a thirty-day period
      running. The second is the one that has to be right, so it is its own permission.
    */
    c.permissions.assertCan(p, 'judgments.serve', { type: 'judgment', id });
    const judgment = await c.firm.getJudgment(p.tenantId, id);
    if (!judgment) throw notFoundOrForbidden('not_found', 'no such judgment');

    const body = strictBody(z.object({
      noticeKind: z.enum(['judgment', 'court_notice', 'execution_notice', 'opponent_notice',
        'client_notice', 'third_party_notice']).default('judgment'),
      method: z.enum(['in_court', 'personal', 'agent', 'registered_mail', 'electronic',
        'publication', 'judicial_bailiff']),
      outcome: z.enum(['pending', 'served', 'refused', 'unclaimed', 'untraceable', 'substituted']),
      servedOnKind: z.enum(['client', 'opponent', 'representative', 'third_party']),
      servedOnName: z.string().trim().max(200).nullable().optional(),
      servedOnPartyId: z.string().uuid().nullable().optional(),
      attemptedAt: z.string().datetime().nullable().optional(),
      servedAt: z.string().datetime().nullable().optional(),
      publicationDays: z.number().int().min(1).max(180).nullable().optional(),
      proofDocumentId: z.string().uuid().nullable().optional(),
      proofReference: z.string().trim().max(200).nullable().optional(),
      note: z.string().trim().max(1000).nullable().optional(),
    }).strict(), req, c, `/api/firm/judgments/${id}/service`);

    /*
      THE DOMAIN DECIDES WHETHER THIS WAS SERVICE, and the route does not second-guess it.
      An uncollected letter and an address nobody could find are attempts; a documented
      refusal is service. The answer is stored on the row, and the database's own constraint
      holds the same line for a caller who is not this application.
    */
    const effect = serviceEffect({
      noticeKind: body.noticeKind, method: body.method, outcome: body.outcome,
      servedOnKind: body.servedOnKind, servedAt: body.servedAt ?? null,
      attemptedAt: body.attemptedAt ?? null,
      publicationDays: body.publicationDays ?? null,
      proofDocumentId: body.proofDocumentId ?? null, proofReference: body.proofReference ?? null,
    });

    /* Substituted service without the period the court ordered is refused rather than
       defaulted: the default is the firm's practice parameter, and a statutory period may
       not rest on a constant the caller cannot see. */
    if (body.outcome === 'substituted' && (body.publicationDays ?? null) === null) {
      throw badRequest('validation_failed',
        'substituted service must record the publication period the court ordered',
        { fields: ['publicationDays'] });
    }
    if ((body.outcome === 'served' || body.outcome === 'refused' || body.outcome === 'substituted')
      && !body.servedAt) {
      throw badRequest('validation_failed',
        'this outcome is a service: record the date it happened', { fields: ['servedAt'] });
    }

    /* The clock, computed once, in the domain — and only when the notice is the judgment
       itself. A court notice served on the other side does not start an appeal period. */
    let clock: ReturnType<typeof appealDeadlineAt> | null = null;
    let rule: ReturnType<typeof ruleFor> = null;
    if (effect.effective && body.noticeKind === 'judgment') {
      rule = ruleFor({
        judgmentKind: judgment.judgmentKind as JudgmentKind,
        appealKind: 'appeal',
        urgent: judgment.urgent,
      });
      if (rule && judgment.appealable) {
        const holidays = await c.firm.courtHolidays(
          p.tenantId, effect.effectiveAt!.slice(0, 10), addDaysToInstant(effect.effectiveAt!, 90));
        clock = appealDeadlineAt({
          effectiveAt: effect.effectiveAt!, rule, holidays,
        });
      }
    }

    const written = await c.firm.tx(async () => {
      const { serviceId } = await c.firm.recordService({
        tenantId: p.tenantId, clientId: judgment.clientId, matterId: judgment.matterId,
        judgmentId: id, noticeKind: body.noticeKind, method: body.method, outcome: body.outcome,
        servedOnKind: body.servedOnKind, servedOnName: body.servedOnName ?? null,
        servedOnPartyId: body.servedOnPartyId ?? null,
        attemptedAt: body.attemptedAt ?? null, servedAt: body.servedAt ?? null,
        publicationDays: body.publicationDays ?? null, effectiveAt: effect.effectiveAt,
        proofDocumentId: body.proofDocumentId ?? null,
        proofReference: body.proofReference ?? null, note: body.note ?? null,
        membershipId: p.membershipId,
      });

      let deadlineId: string | null = null;
      if (clock && body.servedAt) {
        await c.firm.applyServiceClock({
          tenantId: p.tenantId, judgmentId: id, servedAt: body.servedAt,
          /* `effect.effectiveAt`, NOT `clock.startsAt`: the judgment's `service_effective_at`
             is the moment the party was told, and the period starts the day after it. Storing
             the start of the period as the effective date would make the register report a
             service a day late — and, on a substituted service, fifteen days late. */
          effectiveAt: effect.effectiveAt!,
          deadlineAt: clock.dueAt,
          ruleCited: clock.rule.cited, ruleDays: clock.days,
        });
        deadlineId = await c.firm.createProceduralDeadline({
          tenantId: p.tenantId, matterId: judgment.matterId, clientId: judgment.clientId,
          kind: 'appeal',
          title: `Appeal period — deed ${judgment.deedNumber} (closes ${clock.dueDate})`,
          titleAr: `مدة الاعتراض — الصك ${judgment.deedNumber} (تنتهي ${clock.dueDate})`,
          description: `Computed from delivery on the day after it, ${clock.days} days, closing at `
            + `the end of ${clock.dueDate} in the Kingdom.`,
          descriptionAr: `محسوبة من اليوم التالي للتبليغ، ${clock.days} يوماً، وتنتهي بنهاية يوم ${clock.dueDate}.`,
          dueAt: clock.dueAt, priority: 'critical',
          ruleCode: clock.rule.code, ruleCited: clock.rule.cited, ruleDays: clock.days,
          triggerEvent: 'judgment_served', sourceKind: 'service_event', sourceId: serviceId,
          /* The deadline is the responsibility of the member who accepted the service, and it
             is held by their STAFF row — which is what the column references. */
          assignedStaffId: p.staffId ?? null,
        });
        await c.firm.linkServiceDeadline(p.tenantId, serviceId, deadlineId);
      }
      return { serviceId, deadlineId };
    });

    await c.audit.write({
      action: 'JUDGMENT_SERVICE_RECORDED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: effect.effective ? 'success' : 'denied',
      /* The reason code is the refusal the DOMAIN named, so a reviewer counting "how often
         did the firm attempt a service that does not count" reads the same vocabulary the
         person at the desk was shown. */
      /* `?? undefined` rather than null: AuditEvent's reason code is `string | undefined`,
         and the domain's refusal is `string | null` when the service DID take effect. */
      reasonCode: (effect.effective ? null : effect.code) ?? undefined,
      resourceType: 'judgment', resourceId: id,
      metadata: {
        noticeKind: body.noticeKind, method: body.method, outcome: body.outcome,
        servedOnKind: body.servedOnKind,
        effective: effect.effective,
        effectiveAt: effect.effectiveAt,
        deadlineAt: clock?.dueAt ?? null,
        ruleCited: clock?.rule.cited ?? null,
        days: clock?.days ?? null,
        evidenced: Boolean(body.proofDocumentId || body.proofReference),
      },
    }, requestInfo(req, c.trustProxy));

    if (clock) {
      await c.audit.write({
        action: 'APPEAL_PERIOD_COMPUTED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        outcome: 'success', resourceType: 'judgment', resourceId: id,
        metadata: {
          ruleCode: clock.rule.code, ruleCited: clock.rule.cited, days: clock.days,
          startsAt: clock.startsAt, dueDate: clock.dueDate, dueAt: clock.dueAt,
          extendedFrom: clock.extendedFrom,
          /* Whether the last day moved, and off which weekday — because "the period ended on
             a Sunday" is a question somebody will ask about a date that changed. */
          extendedBecause: clock.extendedBecause,
          serviceId: written.serviceId,
        },
      }, requestInfo(req, c.trustProxy));
    }

    ok(res, {
      serviceId: written.serviceId,
      effective: effect.effective,
      effectiveAt: effect.effectiveAt,
      /* When a service does not count, the response says so AND says what to do instead. */
      refusal: effect.effective ? null : effect.code,
      reason: effect.reason,
      /* AND THE PROOF GAP IS REPORTED RATHER THAN SWALLOWED: a service that happened and
         cannot be evidenced is a finding for the file, not a detail of the write. */
      proofMissing: !body.proofDocumentId && !body.proofReference
        && SERVICE_TAKING_OUTCOMES.includes(body.outcome),
      clock: clock ? {
        startsAt: clock.startsAt, dueDate: clock.dueDate, dueAt: clock.dueAt,
        days: clock.days, ruleCited: clock.rule.cited, ruleCode: clock.rule.code,
        extendedFrom: clock.extendedFrom, extendedBecause: clock.extendedBecause,
      } : null,
      deadlineId: written.deadlineId,
      judgment: {
        servedAt: body.servedAt ?? null,
        serviceEffectiveAt: effect.effectiveAt,
        appealDeadlineAt: clock?.dueAt ?? judgment.appealDeadlineAt,
      },
    }, 201);
  }));

  // ── the challenges ────────────────────────────────────────────────────────

  r.post('/judgments/:id/appeals', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const id = String(req.params.id);
    c.permissions.assertCan(p, 'judgments.manage', { type: 'judgment', id });
    const judgment = await c.firm.getJudgment(p.tenantId, id);
    if (!judgment) throw notFoundOrForbidden('not_found', 'no such judgment');

    const body = strictBody(z.object({
      appealKind: z.enum(['appeal', 'cassation', 'rehearing']),
      filedAt: z.string().datetime(),
      court: z.string().trim().max(200).nullable().optional(),
      courtAr: z.string().trim().max(200).nullable().optional(),
      reference: z.string().trim().max(100).nullable().optional(),
      stayRequested: z.boolean().default(false),
      grounds: z.string().trim().max(4000).nullable().optional(),
      groundsAr: z.string().trim().max(4000).nullable().optional(),
    }).strict(), req, c, `/api/firm/judgments/${id}/appeals`);

    /*
      THE ROUTE REFUSES A PROCEEDING THE LAW DOES NOT PROVIDE, with a named code rather than
      a generic validation error: a judgment of the Supreme Court is not appealed, and a
      first-instance judgment is not taken to cassation directly. Accepting the filing would
      put a challenge on the register that cannot exist, and the register is what the
      enforcement gate reads.
    */
    const rule = ruleFor({
      judgmentKind: judgment.judgmentKind as JudgmentKind,
      appealKind: body.appealKind,
      urgent: judgment.urgent,
    });
    if (!rule) {
      throw badRequest('appeal_not_available',
        body.appealKind === 'appeal'
          ? `a ${judgment.judgmentKind.replace('_', ' ')} judgment is not appealed: no such proceeding`
          : `cassation is not available against a ${judgment.judgmentKind.replace('_', ' ')} judgment`,
        { judgmentKind: judgment.judgmentKind, appealKind: body.appealKind });
    }

    /*
      FILED LATE IS RECORDED, NOT REFUSED — and the difference matters. Whether a late filing
      is accepted is the court's decision, not this system's. What this system owes the file
      is the fact: the period had closed, by how much, and on what authority. So the filing is
      recorded with `filed_late` set and the deadline it was measured against.
    */
    const filingDeadlineAt = judgment.appealDeadlineAt
      ?? (judgment.serviceEffectiveAt
        ? appealDeadlineAt({
          effectiveAt: judgment.serviceEffectiveAt, rule,
          holidays: await c.firm.courtHolidays(
            p.tenantId, judgment.serviceEffectiveAt.slice(0, 10),
            addDaysToInstant(judgment.serviceEffectiveAt, 90)),
        }).dueAt
        : null);
    const filedLate = filingDeadlineAt !== null
      && new Date(body.filedAt).getTime() > new Date(filingDeadlineAt).getTime();

    const appealId = await c.firm.tx(async () => c.firm.createAppeal({
      tenantId: p.tenantId, clientId: judgment.clientId, matterId: judgment.matterId,
      judgmentId: id, appealKind: body.appealKind, filedAt: body.filedAt,
      filingDeadlineAt, ruleCited: rule.cited, ruleDays: rule.days, filedLate,
      court: body.court ?? null, courtAr: body.courtAr ?? null,
      reference: body.reference ?? null, status: 'filed',
      stayRequested: body.stayRequested,
      grounds: body.grounds ?? null, groundsAr: body.groundsAr ?? null,
      membershipId: p.membershipId,
    }));

    /* Filing closes the diarised period: the obligation was met, and a register that still
       shows it as open is a register that will be chased by somebody for no reason. */
    const services = await c.firm.listServiceEvents(p.tenantId, { judgmentId: id });
    const linked = services.find((s) => s.deadlineId)?.deadlineId ?? null;
    if (linked) await c.firm.closeProceduralDeadline(p.tenantId, linked);

    await c.audit.write({
      action: 'APPEAL_FILED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'judgment_appeal', resourceId: appealId,
      metadata: {
        judgmentId: id, appealKind: body.appealKind, filedAt: body.filedAt,
        filingDeadlineAt, filedLate, ruleCited: rule.cited, days: rule.days,
        stayRequested: body.stayRequested, closedDeadlineId: linked,
      },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id: appealId, filedLate, filingDeadlineAt, ruleCited: rule.cited }, 201);
  }));

  r.post('/judgments/:id/stays', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const id = String(req.params.id);
    c.permissions.assertCan(p, 'judgments.manage', { type: 'judgment', id });
    const judgment = await c.firm.getJudgment(p.tenantId, id);
    if (!judgment) throw notFoundOrForbidden('not_found', 'no such judgment');

    const body = strictBody(z.object({
      inForce: z.boolean(),
      reason: z.string().trim().max(500).nullable().optional(),
      orderedAt: z.string().datetime().nullable().optional(),
    }).strict(), req, c, `/api/firm/judgments/${id}/stays`);

    if (body.inForce && !body.orderedAt) {
      throw badRequest('validation_failed',
        'a stay of execution must carry the order it comes from: record when it was ordered',
        { fields: ['orderedAt'] });
    }

    /*
      A STAY MOVES THE JUDGMENT'S ENFORCEMENT POSTURE, and the move is checked against the
      domain's own matrix before it is written — so a refused transition is a 409 with a
      named code rather than a database error. The register's promise is that a stay outranks
      everything but a terminal state; that promise is only kept if raising one changes the
      state the gate reads.
    */
    const next = body.inForce ? 'stayed' : (judgment.reliefKind === 'none' ? 'not_enforceable' : 'awaiting_finality');
    if (!canMoveEnforcement(judgment.enforcementStatus as EnforcementStatus, next)
      && judgment.enforcementStatus !== next) {
      throw conflict('enforcement_transition_invalid',
        `a judgment in "${judgment.enforcementStatus}" cannot move to "${next}"`);
    }

    await c.firm.updateJudgment(p.tenantId, id, {
      stayInForce: body.inForce,
      stayReason: body.inForce ? (body.reason ?? null) : null,
      stayOrderedAt: body.inForce ? body.orderedAt : judgment.stayOrderedAt,
      enforcementStatus: next,
    });

    await c.audit.write({
      action: body.inForce ? 'EXECUTION_STAYED' : 'EXECUTION_STAY_LIFTED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'judgment', resourceId: id,
      metadata: {
        reason: body.reason ?? null, orderedAt: body.orderedAt ?? null,
        enforcementStatusBefore: judgment.enforcementStatus, enforcementStatusAfter: next,
      },
    }, requestInfo(req, c.trustProxy));
    ok(res, { id, stayInForce: body.inForce, enforcementStatus: next });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // P0.5 · THE PRIVILEGE RING — THE DOOR
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The releases recorded on a matter.
   *
   * Readable by anyone who can see the matter, deliberately: the member who may not
   * read the firm's strategy IS entitled to know that a document left the file and on
   * whose instruction — that is the difference between a ring and a secret, and it is
   * the answer the firm gives when the client asks who has seen their file.
   */
  /**
   * The disclosures recorded on one matter.
   *
   * READING THE LEDGER IS A PRIVILEGED READ. The entries are metadata about privileged
   * material — that the firm's own notes went to the Public Prosecution on a
   * crime-prevention ground is a fact a client would pay to know, and a fact an adverse
   * party would like to have — so the ring gates the read as well as the write. Opening it
   * to every member who can see the matter would have left the door locked and the doorway
   * made of glass.
   */
  r.get('/matters/:id/privilege-releases', ah(async (req, res) => {
    const p = principal(req);
    c.permissions.assertCan(p, 'matters.read', { type: 'matter', id: req.params.id });
    const { facts } = await c.permissions.requireMatter(p, String(req.params.id), MATTER_READ);
    if (!p.ring.inRing) {
      await c.audit.write({
        action: 'PRIVILEGED_READ',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        outcome: 'denied', resourceType: 'matter', resourceId: facts.matterId,
        reasonCode: p.ring.reason,
        metadata: { membershipId: p.membershipId, surface: 'privilege_releases' },
      }, requestInfo(req, c.trustProxy));
      throw forbidden('privilege_ring_refused',
        `the privilege ring excludes this member: ${p.ring.reason}`,
        p.ring.reason, { alreadyAudited: true });
    }
    const releases = await c.firm.listPrivilegeReleases(p.tenantId, facts.matterId);
    ok(res, { count: releases.length, releases });
  }));

  /**
   * Release privileged material, naming the ground القاعدة الحادية والعشرون provides.
   *
   * THIS ROUTE HAS NO "just share it" FORM, and that is the design. A lawyer who must
   * disclose — to a court, to the regulator, in his own defence, or because the client
   * instructed it in writing — has exactly four grounds, and the record says which one
   * was relied on, to whom the material went, and which document carries the client's
   * consent. A member outside the ring cannot open the door; the database's trigger
   * enforces that as well, because the ledger is what a court will read.
   */
  r.post('/matters/:id/privilege-releases', firmCsrfGuard(), ah(async (req, res) => {
    const p = principal(req);
    const body = strictBody(
      z.object({
        subjectKind: z.enum(['matter_note', 'document', 'assessment']),
        documentId: z.string().uuid().optional().nullable(),
        ground: z.enum(DISCLOSURE_GROUND_CODES as unknown as [string, ...string[]]),
        recipientKind: z.enum(DISCLOSURE_RECIPIENTS as unknown as [string, ...string[]]),
        recipientName: z.string().trim().min(2).max(200),
        consentDocumentId: z.string().uuid().optional().nullable(),
        note: z.string().trim().max(1000).optional().nullable(),
      }).strict(),
      req, c, '/api/firm/matters/:id/privilege-releases',
    );

    c.permissions.assertCan(p, 'matters.read', { type: 'matter', id: req.params.id });
    const { facts, level } = await c.permissions.requireMatter(p, String(req.params.id), MATTER_WRITE);

    /*
      THE RING, CHECKED BEFORE THE DATABASE IS ASKED.

      A named refusal beats a driver error, and this is one of the few refusals in the
      system that is genuinely a 403 rather than a 409: the record is not in a bad state,
      the caller is not in the ring. The database refuses the same thing underneath
      (0054's trigger), which is where the rule lives for anybody who reaches the ledger
      without this route.
    */
    if (!p.ring.inRing) {
      await c.audit.write({
        action: 'PRIVILEGE_RELEASED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        outcome: 'denied', resourceType: 'matter', resourceId: facts.matterId,
        reasonCode: p.ring.reason,
        metadata: {
          membershipId: p.membershipId, ground: body.ground,
          recipientKind: body.recipientKind, refusal: p.ring.reason,
        },
      }, requestInfo(req, c.trustProxy));
      /* `alreadyAudited` — the denial was written above, and with the reason recorded as
         the audit's reasonCode. A second, generic row for the same refusal would be
         noise in the one place a reviewer looks for signal. */
      throw forbidden('privilege_ring_refused',
        `the privilege ring excludes this member: ${p.ring.reason}`,
        'privilege_ring_refused', { alreadyAudited: true });
    }

    /* THE GROUND'S OWN RULE, stated here so the member is told what is permitted rather
       than merely that the request failed. A suspicion of money laundering is reported
       to the regulator; a client's consent is a writing, not a flag. */
    if (!groundPermits(body.ground, body.recipientKind)) {
      const g = groundOf(body.ground);
      throw badRequest('privilege_ground_recipient_mismatch',
        `the ground "${body.ground}" does not permit disclosure to "${body.recipientKind}"`,
        /* `badRequest(code, message, details)` — the third argument IS the details object.
           Wrapping it in another `{ details: … }` nests it one level down, which type-checks
           and ships `error.details.details`. The screen then cannot find the list of
           recipients the ground does allow, and the refusal reads as merely negative. */
        { ground: body.ground, permittedRecipients: g ? [...g.recipients] : [] });
    }
    const ground = groundOf(body.ground)!;
    if (ground.requiresDocument && !body.consentDocumentId) {
      throw badRequest('privilege_consent_document_required',
        'disclosure on the client’s consent must name the document that carries the consent',
        { ground: body.ground });
    }
    if (body.subjectKind === 'document' && !body.documentId) {
      throw badRequest('validation_failed',
        'a document release must name the document', { fields: ['documentId'] });
    }

    /*
      ── WHERE THOSE DOCUMENTS ACTUALLY LIVE ────────────────────────────────────────

      A foreign key proves a document EXISTS. It does not prove it is the document this
      release claims to rest on, and the two references here answer two different
      questions:

        · `documentId` is the material being released, so it must be a document OF THIS
          MATTER. A ledger entry disclosing a document that belongs to another file — or to
          another firm on the same SaaS — is a record of a disclosure that did not happen.
        · `consentDocumentId` is the CLIENT's writing. Consent is the client's, so the
          document must belong to the same client as the matter: the client may sign it on
          any of their files, and none of them may be somebody else's.

      Checked here AND in `privilege_release_guard()`, because the ledger's reader is a
      regulator with a psql prompt as often as it is this screen. Both refusals carry the
      same token so the two dialects cannot drift into saying different things — defect (o).
    */
    if (body.documentId) {
      const scope = await c.firm.documentScope(body.documentId);
      if (!scope || scope.tenantId !== p.tenantId || scope.matterId !== facts.matterId) {
        throw badRequest('privilege_document_mismatch',
          'the document being released is not a document of this matter',
          { field: 'documentId' });
      }
    }
    if (body.consentDocumentId) {
      const scope = await c.firm.documentScope(body.consentDocumentId);
      if (!scope || scope.tenantId !== p.tenantId || scope.clientId !== facts.clientId) {
        throw badRequest('privilege_document_mismatch',
          'the document named as the client’s written consent is not a document of this client',
          { field: 'consentDocumentId' });
      }
    }

    const id = newId();
    try {
      await c.firm.insertPrivilegeRelease({
        id, tenantId: p.tenantId, matterId: facts.matterId,
        documentId: body.documentId ?? null,
        subjectKind: body.subjectKind,
        ground: body.ground,
        recipientKind: body.recipientKind,
        recipientName: body.recipientName,
        consentDocumentId: body.consentDocumentId ?? null,
        membershipId: p.membershipId,
        note: body.note ?? null,
      });
    } catch (err) {
      /* The database's own CHECKs and trigger, surfaced as refusals rather than 500s —
         the same discipline the P0.4 engine applies to its guards. */
      throw toPortalError(err);
    }

    await c.audit.write({
      action: 'PRIVILEGE_RELEASED',
      actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
      outcome: 'success', resourceType: 'matter', resourceId: facts.matterId,
      metadata: {
        releaseId: id, membershipId: p.membershipId, accessLevel: level,
        subjectKind: body.subjectKind, ground: body.ground,
        recipientKind: body.recipientKind, recipientName: body.recipientName,
        consentDocumentId: body.consentDocumentId ?? null,
      },
    }, requestInfo(req, c.trustProxy));

    ok(res, {
      id, matterId: facts.matterId, ground: body.ground,
      recipientKind: body.recipientKind, recipientName: body.recipientName,
    }, 201);
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
      /*
        P0.5 · the ring, resolved with the principal. Sent so the SPA can explain a lock
        ("يحتاج ترخيصاً سارياً") rather than render a blank — and for no other reason:
        every privileged field is decided server-side, and §50 is the rule that the
        screen has nothing to override.
      */
      privilege: { inRing: p.ring.inRing, reason: p.ring.reason },
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
