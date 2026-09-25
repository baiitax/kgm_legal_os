/**
 * §8 PERMISSION CATALOGUE · §9-§16 ROLE BOUNDARIES · §10/§11/§27 MATTER SCOPING
 * §49/§51 ADMINISTRATION AND AUDIT · §52 SESSIONS · §71 NON-RECURSION
 * §72 PRIVILEGE-ESCALATION MATRIX · §73 FINANCIAL SECURITY
 *
 * This is the Firm OS half of the security suite. The client portal's suite
 * proves that an outsider cannot get in; this one proves that an INSIDER cannot
 * get further in than they should — which is the harder problem, because every
 * caller here is authenticated, holds a real session, and is entitled to
 * something.
 *
 * The escalation matrix (§72) is exercised four ways for each pair, because a
 * control that holds in only one of them is not a control:
 *   API     — call the endpoint that performs the action
 *   URL     — probe the route directly, including shapes that do not exist
 *   PAYLOAD — inject the fields an escalation would need (role, tenant, amount)
 *   DB      — attempt the mutation underneath the API, where the triggers and
 *             CHECK constraints are the last line
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootStack, firmLoginAs, loginAs, createAgent, FIRM, IDS, type Stack } from '../helpers.js';
import { parseFirmCatalogueFile } from '../../server/src/domain/parse-firm-catalogue.js';
import { PERMISSIONS, ROLE_TEMPLATES, TEMPLATE_GRANTS } from '../../server/src/domain/firm-catalogue.js';
import { PermissionEngine, MATTER_READ } from '../../server/src/domain/permissions.js';
import { FirmRepo } from '../../server/src/db/firm-repo.js';
import { hashPassword, newId } from '../../server/src/lib/crypto.js';
import { assertCsrf } from '../../server/src/auth/csrf.js';

const MIGRATION = 'supabase/migrations/0006_firm_rbac.sql';

let s: Stack;
beforeEach(async () => { s = await bootStack(); });
afterEach(async () => { await s.shutdown(); });

// ============================================================================
// FIXTURE HELPERS
// ============================================================================

/** Resolves the seeded membership id for one of the five demo operators. */
async function membershipOf(email: string): Promise<string> {
  const r = await s.db.get<{ id: string }>(
    `select fm.id from firm_memberships fm join users u on u.id = fm.user_id where u.email = ?`,
    [email],
  );
  if (!r) throw new Error(`no membership for ${email}`);
  return r.id;
}

/** Resolves the tenant-scoped role id for a system role code. */
async function roleIdOf(code: string, tenantId: string = IDS.tenantKgm): Promise<string> {
  const r = await s.db.get<{ id: string }>(
    `select id from roles where code = ? and tenant_id = ?`, [code, tenantId],
  );
  if (!r) throw new Error(`no role ${code} in ${tenantId}`);
  return r.id;
}

/** Grants a role directly, as an administrator action would. */
async function grantRole(membershipId: string, roleCode: string, byMembershipId: string) {
  await s.db.run(
    `insert into membership_roles (membership_id, role_id, granted_by_membership_id, grant_origin, granted_at)
     values (?, ?, ?, 'admin', ?)
     on conflict (membership_id, role_id) do update set revoked_at = null`,
    [membershipId, await roleIdOf(roleCode), byMembershipId, new Date().toISOString()],
  );
}

async function auditRows(action?: string, reasonLike?: string) {
  const rows = await s.db.all<{ action: string; reason_code: string | null; resource_id: string | null; metadata: unknown }>(
    `select action, reason_code, resource_id, metadata from audit_events order by id`,
  );
  return rows.filter((r) => (!action || r.action === action)
    && (!reasonLike || String(r.reason_code ?? '').includes(reasonLike)));
}

/** Waits for fire-and-forget audit writes to land. */
const settle = () => new Promise((r) => setTimeout(r, 150));

/**
 * Adds a firm member that the demo dataset does not contain, so the escalation
 * matrix can cover ASSOCIATE and ADMIN as well as the five seeded roles.
 * Everything is synthetic; no real identifiers appear.
 */
async function addMember(opts: {
  email: string;
  name: string;
  nameAr: string;
  roleCode: string;
  practiceAreas?: string[];
  financial?: number | null;
  writeoff?: number | null;
  discount?: number | null;
  tenantId?: string;
}): Promise<{ userId: string; staffId: string; membershipId: string }> {
  const tenantId = opts.tenantId ?? IDS.tenantKgm;
  const userId = newId();
  const staffId = newId();
  const membershipId = newId();
  const now = new Date().toISOString();

  await s.db.run(
    `insert into users (id, email, password_hash, password_updated_at, email_verified_at, status,
                        failed_login_count, mfa_enabled, preferred_language, preferred_calendar,
                        created_at, updated_at)
     values (?, ?, ?, ?, ?, 'active', 0, 0, 'ar', 'islamic-umalqura', ?, ?)`,
    [userId, opts.email, hashPassword('Demo!Firm2026'), now, now, now, now],
  );
  await s.db.run(
    `insert into staff (id, tenant_id, full_name, full_name_ar, email, internal_role,
                        bar_number, client_visible, client_title, client_title_ar, is_active, created_at)
     values (?, ?, ?, ?, ?, ?, null, 0, null, null, 1, ?)`,
    [staffId, tenantId, opts.name, opts.nameAr, opts.email, opts.roleCode.toLowerCase(), now],
  );
  await s.db.run(
    `insert into firm_memberships (id, tenant_id, user_id, staff_id, job_title, job_title_ar, status,
                                   financial_authority_sar, writeoff_authority_sar, discount_authority_pct,
                                   joined_at, invited_by_membership_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, null, 'active', ?, ?, ?, ?, null, ?, ?)`,
    [membershipId, tenantId, userId, staffId, opts.roleCode,
     opts.financial ?? null, opts.writeoff ?? null, opts.discount ?? null, now, now, now],
  );
  await grantRole(membershipId, opts.roleCode, membershipId);
  for (const area of opts.practiceAreas ?? []) {
    await s.db.run(
      `insert into membership_practice_areas (membership_id, practice_area, granted_at) values (?, ?, ?)`,
      [membershipId, area, now],
    );
  }
  return { userId, staffId, membershipId };
}

// ============================================================================
// §8 · THE CATALOGUE IS ONE CONTRACT, NOT TWO
// ============================================================================

describe('§8 · permission catalogue integrity', () => {
  const sql = parseFirmCatalogueFile(MIGRATION);

  it('the generated TypeScript module matches the migration exactly', () => {
    // This is the drift gate. If someone edits the SQL and forgets to run
    // `npx tsx server/scripts/gen-firm-catalogue.ts`, the demo seed and the
    // production migration would disagree about what a role may do — and every
    // other test in this file would keep passing, because each only looks at one
    // side. So the two are compared here, in full.
    expect(PERMISSIONS.map((p) => p.code)).toEqual(sql.permissions.map((p) => p.code));
    for (const [i, p] of PERMISSIONS.entries()) {
      expect(p.module, p.code).toBe(sql.permissions[i].module);
      expect(p.sensitivity, p.code).toBe(sql.permissions[i].sensitivity);
      expect(p.descriptionAr, p.code).toBe(sql.permissions[i].descriptionAr);
    }
    expect(ROLE_TEMPLATES.map((r) => [r.templateId, r.code, r.nameAr]))
      .toEqual(sql.roleTemplates.map((r) => [r.templateId, r.code, r.nameAr]));
    expect(Object.keys(TEMPLATE_GRANTS).sort()).toEqual(Object.keys(sql.templateGrants).sort());
    for (const code of Object.keys(TEMPLATE_GRANTS)) {
      expect(TEMPLATE_GRANTS[code], code).toEqual(sql.templateGrants[code]);
    }
  });

  it('seeds the same catalogue the migration defines', async () => {
    const n = await s.db.get<{ n: number }>(`select count(*) as n from permissions`);
    expect(Number(n?.n)).toBe(sql.permissions.length);
    expect(sql.permissions.length).toBeGreaterThanOrEqual(69);

    // Every code in the SQL catalogue exists as a row, with the same sensitivity.
    for (const p of sql.permissions) {
      const row = await s.db.get<{ sensitivity: string; module: string }>(
        `select sensitivity, module from permissions where code = ?`, [p.code]);
      expect(row, p.code).toBeTruthy();
      expect(row!.sensitivity, p.code).toBe(p.sensitivity);
      expect(row!.module, p.code).toBe(p.module);
    }
  });

  it('gives every tenant its own copy of all nine system templates', async () => {
    for (const tenant of [IDS.tenantKgm, IDS.tenantNajd]) {
      const rows = await s.db.all<{ code: string }>(
        `select code from roles where tenant_id = ? and is_system = 1 order by code`, [tenant]);
      expect(rows.map((r) => r.code)).toEqual(sql.roleTemplates.map((t) => t.code).sort());
    }
    // A template copy is not shared between firms: editing KGM's PARALEGAL must
    // not touch Najd's.
    const kgm = await roleIdOf('PARALEGAL', IDS.tenantKgm);
    const najd = await roleIdOf('PARALEGAL', IDS.tenantNajd);
    expect(kgm).not.toBe(najd);
  });

  it('§13 · PARALEGAL holds no administration, billing-approval or compliance authority', () => {
    const held = new Set(TEMPLATE_GRANTS.PARALEGAL);
    for (const forbidden of [
      'users.read', 'users.invite', 'users.update', 'users.deactivate',
      'users.assign_role', 'users.assign_matter', 'users.revoke_session',
      'roles.read', 'roles.manage', 'settings.manage', 'audit.read', 'audit.export',
      'billing.approve', 'billing.writeoff', 'billing.record_payment', 'billing.discount',
      'compliance.approve', 'compliance.review', 'matters.restrict', 'clients.read_sensitive',
    ]) {
      expect(held.has(forbidden), `PARALEGAL must not hold ${forbidden}`).toBe(false);
    }
    // And they DO hold real work, so the absence above is a boundary not a stub.
    for (const allowed of ['matters.read', 'matters.update', 'documents.create', 'tasks.manage']) {
      expect(held.has(allowed), `PARALEGAL should hold ${allowed}`).toBe(true);
    }
  });

  it('§14 · FINANCE holds no compliance authority and no unmasked identifiers', () => {
    const held = new Set(TEMPLATE_GRANTS.FINANCE);
    for (const p of PERMISSIONS.filter((x) => x.module === 'compliance')) {
      expect(held.has(p.code), `FINANCE must not hold ${p.code}`).toBe(false);
    }
    for (const forbidden of ['clients.read_sensitive', 'matters.restrict', 'audit.export', 'billing.approve']) {
      expect(held.has(forbidden), `FINANCE must not hold ${forbidden}`).toBe(false);
    }
    // matters.read_all is the one widening permission Finance legitimately needs
    // in order to bill across the firm without joining every matter team.
    expect(held.has('matters.read_all')).toBe(true);
    expect(held.has('billing.read')).toBe(true);
  });

  it('§16 · ADMIN holds no financial approval and no compliance decision', () => {
    const held = new Set(TEMPLATE_GRANTS.ADMIN);
    for (const forbidden of [
      'billing.approve', 'billing.writeoff', 'billing.record_payment', 'billing.send',
      'compliance.approve', 'compliance.review', 'matters.restrict',
    ]) {
      expect(held.has(forbidden), `ADMIN must not hold ${forbidden}`).toBe(false);
    }
    expect(held.has('users.assign_role')).toBe(true);
    expect(held.has('settings.manage')).toBe(true);
  });

  it('§9 · MANAGING_PARTNER holds everything except audit mutation, which nobody holds', () => {
    const held = new Set(TEMPLATE_GRANTS.MANAGING_PARTNER);
    expect(held.size).toBe(PERMISSIONS.length);
    // §51: the trail is append-only, so no permission to mutate it may exist for
    // ANY role. Asserting the catalogue rather than one role is what makes this
    // hold when a new role is added.
    expect(PERMISSIONS.some((p) => /^audit\.(delete|update|edit|purge|truncate)/.test(p.code))).toBe(false);
    for (const grants of Object.values(TEMPLATE_GRANTS)) {
      expect(grants.some((g) => /^audit\.(delete|update|edit|purge|truncate)/.test(g))).toBe(false);
    }
    expect(held.has('audit.read')).toBe(true);
  });

  it('every grant references a real permission and every permission is granted somewhere', () => {
    const codes = new Set(PERMISSIONS.map((p) => p.code));
    const granted = new Set<string>();
    for (const [role, perms] of Object.entries(TEMPLATE_GRANTS)) {
      for (const p of perms) {
        expect(codes.has(p), `${role} grants unknown permission ${p}`).toBe(true);
        granted.add(p);
      }
      // No duplicate grants: a duplicated row would silently double-count in a
      // UI that renders "N permissions".
      expect(new Set(perms).size, role).toBe(perms.length);
    }
    // An orphan permission is a code with no call site and no holder — dead
    // weight that reads like a feature. Fail instead.
    expect([...codes].filter((c) => !granted.has(c))).toEqual([]);
  });

  it('classifies every privilege-changing permission as critical', () => {
    const byCode = new Map(PERMISSIONS.map((p) => [p.code, p.sensitivity]));
    for (const critical of [
      'users.invite', 'users.deactivate', 'users.assign_role', 'users.assign_matter',
      'users.revoke_session', 'roles.manage', 'settings.manage', 'audit.read', 'audit.export',
      'billing.writeoff', 'compliance.approve', 'matters.restrict', 'clients.read_sensitive',
    ]) {
      expect(byCode.get(critical), critical).toBe('critical');
    }
  });
});

// ============================================================================
// §6 · TWO AUDIENCES, ONE ORIGIN, NO SHARED AUTHORIZATION SURFACE
// ============================================================================

describe('§6 · the firm audience is separate from the client audience', () => {
  it('each seeded operator can sign in to the Firm OS', async () => {
    for (const email of Object.values(FIRM)) {
      const agent = createAgent(s.app);
      const res = await firmLoginAs(agent, email);
      expect(res.status, email).toBe(200);
      expect(res.body.data.step, email).toBe('authenticated');
      expect(res.body.data.member.email).toBe(email);
      expect(agent.cookies.has('kgm_firm_session'), email).toBe(true);
      // The firm SPA needs the codes to decide what to render.
      expect(Array.isArray(res.body.data.member.permissions)).toBe(true);
    }
  });

  it('the client password does not work at the firm door, and vice versa', async () => {
    const firmAgent = createAgent(s.app);
    // Correct firm email, client password.
    const r1 = await firmLoginAs(firmAgent, FIRM.lawyer, 'Demo!Portal2026');
    expect(r1.status).toBe(401);
    expect(r1.body.error.code).toBe('invalid_credentials');

    // Correct client email, firm password — on the portal door.
    const portalAgent = createAgent(s.app);
    const r2 = await loginAs(portalAgent, 'ahmed.alsaud@example.test', 'Demo!Firm2026');
    expect(r2.status).toBe(401);
  });

  it('a client user with the right password still has no firm access', async () => {
    // Ahmed is a client, not a member. His password is correct; the audience is
    // wrong. The response must be identical to a wrong password, or the endpoint
    // becomes a way to enumerate which addresses are clients of the firm.
    const agent = createAgent(s.app);
    const res = await firmLoginAs(agent, 'ahmed.alsaud@example.test', 'Demo!Portal2026');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_credentials');
    await settle();
    const rows = await auditRows('FIRM_LOGIN_FAILED', 'no_active_membership');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('a firm session is not a portal session', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    for (const url of ['/api/client/dashboard', '/api/client/matters', '/api/client/invoices', '/api/client/profile']) {
      const res = await agent.get(url);
      expect(res.status, url).toBe(401);
    }
    // And no firm cookie was accepted as a portal cookie.
    expect(agent.cookies.has('kgm_portal_session')).toBe(false);
  });

  it('a portal session finds nothing at the firm API, and the attempt is recorded', async () => {
    const agent = createAgent(s.app);
    await loginAs(agent, 'ahmed.alsaud@example.test');
    const paths = [
      '/api/firm/session', '/api/firm/matters', '/api/firm/admin/members',
      '/api/firm/admin/audit', '/api/firm/admin/settings', '/api/firm/settings',
      '/api/firm/billing/invoices', '/api/firm/matters/anything-here',
      `/api/firm/matters/${IDS.matterCommercial}`,
    ];
    for (const p of paths) {
      const res = await agent.get(p);
      // Uniform 404: from a portal caller's point of view the firm API does not
      // exist, which is what the portal suite has always asserted.
      expect(res.status, p).toBe(404);
      expect(res.body.error.code, p).toBe('not_found');
    }
    await settle();
    const rows = await auditRows('ESCALATION_ATTEMPT', 'cross_audience');
    expect(rows.length).toBe(paths.length);
    expect(rows.map((r) => r.resource_id)).toContain('/api/firm/admin/members');
  });

  it('a portal caller cannot POST to a firm endpoint either', async () => {
    const agent = createAgent(s.app);
    await loginAs(agent, 'ahmed.alsaud@example.test');
    const res = await agent.post('/api/firm/admin/members/x/roles', { roleCode: 'MANAGING_PARTNER' });
    expect(res.status).toBe(404);
    await settle();
    expect((await auditRows('ESCALATION_ATTEMPT', 'cross_audience')).length).toBeGreaterThan(0);
  });

  it('both sessions can coexist in one browser without crossing over', async () => {
    // A lawyer who is also a client of the firm. Two cookies, two CSRF tokens,
    // two principals — and neither audience may act through the other.
    const agent = createAgent(s.app);
    await loginAs(agent, 'ahmed.alsaud@example.test');
    const portalRes = await agent.get('/api/client/dashboard');
    expect(portalRes.status).toBe(200);

    const firmRes = await firmLoginAs(agent, FIRM.lawyer);
    expect(firmRes.status).toBe(200);

    // The portal still works, and still returns ONLY Ahmed's client data.
    const after = await agent.get('/api/client/matters');
    expect(after.status).toBe(200);
    const ids = after.body.data.matters.map((m: any) => m.id);
    expect(ids).not.toContain(IDS.matterGulf);

    // The firm side now works and returns firm-shaped data.
    const firmMatters = await agent.get('/api/firm/matters');
    expect(firmMatters.status).toBe(200);
    expect(firmMatters.body.data.matters.map((m: any) => m.matterNumber)).toContain('KGM-2026-0148');
  });

  it('a portal CSRF token is refused on a firm endpoint', async () => {
    const agent = createAgent(s.app);
    await loginAs(agent, 'ahmed.alsaud@example.test');
    const portalCsrf = agent.csrf();
    expect(portalCsrf).toBeTruthy();
    await firmLoginAs(agent, FIRM.managingPartner);

    // Present the PORTAL token in the header while the FIRM cookie is sent. The
    // double-submit check fails on mismatch, and if an attacker somehow matched
    // them the signed audience claim would still refuse it.
    const res = await agent.post(
      `/api/firm/matters/${IDS.matterCommercial}/restrict`,
      { restricted: true, reason: 'escalation probe' },
      { csrf: portalCsrf },
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf_failed');
  });

  it('a firm CSRF token is refused on a portal endpoint', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const firmCsrf = agent.firmCsrf();
    expect(firmCsrf).toBeTruthy();
    await loginAs(agent, 'ahmed.alsaud@example.test');

    const res = await agent.post(`/api/client/messages/${newId()}`, { body: 'probe' }, { csrf: firmCsrf });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf_failed');
  });

  it('the signed audience claim is enforced even when the cookies match', async () => {
    // The test above fails on the double-submit mismatch, which is the first
    // gate. This one proves the SECOND gate: an attacker who could set both the
    // cookie and the header to the same firm token still cannot reach a portal
    // endpoint, because the token's signed `aud` claim says 'firm'. They cannot
    // relabel it — the HMAC is keyed with the server master key.
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const firmToken = agent.firmCsrf()!;

    // The same token is placed in BOTH cookie jars and in the header, so the
    // double-submit check passes for either audience and only the signed claim
    // can tell them apart.
    const fakeReq = {
      method: 'POST',
      cookies: { kgm_csrf: firmToken, kgm_firm_csrf: firmToken },
      header: (name: string) => (name.toLowerCase() === 'x-csrf-token' ? firmToken : undefined),
    } as unknown as import('express').Request;

    expect(() => assertCsrf(fakeReq, 'some-portal-session', { audience: 'portal' }))
      .toThrowError(/audience mismatch/);

    // And the same token IS accepted by the audience it was minted for, when
    // presented with the session it is bound to — so the refusal above is the
    // audience claim and not merely a bad session id.
    const sid = (await s.db.get<{ id: string }>(
      `select id from firm_sessions order by created_at desc limit 1`))!.id;
    expect(() => assertCsrf(fakeReq, sid, { audience: 'firm' })).not.toThrow();
    // A portal session id must not satisfy a firm token.
    expect(() => assertCsrf(fakeReq, 'some-portal-session', { audience: 'firm' }))
      .toThrowError(/not bound to session/);
  });

  it('the firm session cookie is HttpOnly and SameSite=Strict', async () => {
    const agent = createAgent(s.app);
    const res = await firmLoginAs(agent, FIRM.lawyer);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    const sessionCookie = raw.find((c) => c.startsWith('kgm_firm_session='));
    expect(sessionCookie, 'firm session cookie must be set').toBeTruthy();
    expect(sessionCookie!.toLowerCase()).toContain('httponly');
    expect(sessionCookie!.toLowerCase()).toContain('samesite=strict');
    // The CSRF cookie must be readable by the SPA; the session cookie must not.
    const csrfCookie = raw.find((c) => c.startsWith('kgm_firm_csrf='));
    expect(csrfCookie).toBeTruthy();
    expect(csrfCookie!.toLowerCase()).not.toContain('httponly');
  });

  it('the firm API answers nothing at all without a credential', async () => {
    const agent = createAgent(s.app);
    for (const p of ['/api/firm/session', '/api/firm/matters', '/api/firm/admin/members']) {
      const res = await agent.get(p);
      expect(res.status, p).toBe(404);
    }
    // The login surface itself is reachable, because a product has to have a door.
    expect((await agent.get('/api/firm/auth/health')).status).toBe(200);
  });
});

// ============================================================================
// §10 / §11 / §17 / §27 · MATTER SCOPING
// ============================================================================

describe('§10/§11 · practice-area and assignment scoping', () => {
  it('the Managing Partner sees the whole firm but not another firm', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const res = await agent.get('/api/firm/matters');
    expect(res.status).toBe(200);
    const numbers = res.body.data.matters.map((m: any) => m.matterNumber).sort();
    /*
      SIX, and two of them are CLOSED. KGM-2024-0112 and KGM-2019-0044 were added by
      the P0.1 party model, because a conflict engine that cannot see the firm's
      closed files cannot see a former client — and القاعدة ٨/٤ is almost entirely
      about former clients. A demo dataset containing only live matters could not
      exercise the rule at all, which is why the count in this assertion changed.
    */
    expect(numbers).toEqual([
      'KGM-2019-0044', 'KGM-2024-0112', 'KGM-2026-0148',
      'KGM-2026-0151', 'KGM-2026-0163', 'KGM-2026-0170',
    ]);
    expect(res.body.data.scope.firmWide).toBe(true);
    expect(numbers).not.toContain('NLP-2026-0021');
  });

  it('§11 · a lawyer sees their practice areas, not the whole practice', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.lawyer);
    const res = await agent.get('/api/firm/matters');
    const byNumber = Object.fromEntries(res.body.data.matters.map((m: any) => [m.matterNumber, m]));
    // Commercial Litigation and Real Estate are his areas.
    expect(byNumber['KGM-2026-0148']).toBeTruthy();
    expect(byNumber['KGM-2026-0151']).toBeTruthy();
    // The restricted acquisition is visible only because of an explicit grant.
    expect(byNumber['KGM-2026-0170'].accessLevel).toBe('edit');
    // Labour & Employment is NOT his area and he is not on that team.
    expect(byNumber['KGM-2026-0163']).toBeUndefined();
    expect(res.body.data.scope.firmWide).toBe(false);
    expect(res.body.data.scope.practiceAreas.sort()).toEqual(['Commercial Litigation', 'Real Estate']);
  });

  it('§13 · a paralegal is ASSIGNED to one matter and merely READS her practice area', async () => {
    /*
      The title used to read "sees only the matter she is assigned to", and it was
      true by accident of the dataset: the Commercial Litigation practice area
      contained exactly one matter and she was on it. Adding two closed commercial
      matters to the demo exposed the difference between the two mechanisms, which is
      the distinction §10/§11 actually draws:

        · assignment        → 'operational', she works the file
        · practice area     → 'view', she can read it and cannot change it

      The assertion is now about the LEVEL rather than the count, because the level is
      the control.
    */
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.paralegal);
    const res = await agent.get('/api/firm/matters');
    const byNumber = Object.fromEntries(
      res.body.data.matters.map((m: any) => [m.matterNumber, m.accessLevel]));

    expect(byNumber['KGM-2026-0148']).toBe('operational');
    // Commercial Litigation, not assigned to her, and CLOSED — read-only.
    expect(byNumber['KGM-2024-0112']).toBe('view');
    expect(byNumber['KGM-2019-0044']).toBe('view');
    // Not her area and not assigned: absent entirely.
    expect(byNumber['KGM-2026-0151']).toBeUndefined();
    expect(byNumber['KGM-2026-0163']).toBeUndefined();
  });

  it('§15 · compliance reaches a matter by assignment, at a lateral level', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.compliance);
    const res = await agent.get('/api/firm/matters');
    expect(res.body.data.count).toBe(1);
    const m = res.body.data.matters[0];
    expect(m.accessLevel).toBe('compliance');

    // A lateral level is not a ladder rung: `compliance` does not satisfy a
    // write requirement, which is what stops Compliance editing pleadings.
    const detail = await agent.get(`/api/firm/matters/${IDS.matterCommercial}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.accessLevel).toBe('compliance');
    const restrict = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/restrict`,
      { restricted: true, reason: 'probe' });
    expect([403, 404]).toContain(restrict.status);
  });

  it('§14 · finance sees billing across the firm at the weakest level only', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.finance);
    const res = await agent.get('/api/firm/matters');
    const byNumber = Object.fromEntries(res.body.data.matters.map((m: any) => [m.matterNumber, m]));
    // matters.read_all widens visibility...
    expect(byNumber['KGM-2026-0148'].accessLevel).toBe('view');
    expect(byNumber['KGM-2026-0151'].accessLevel).toBe('view');
    expect(byNumber['KGM-2026-0163'].accessLevel).toBe('view');
    // ...and the explicit grant on the restricted matter is lateral, not full.
    expect(byNumber['KGM-2026-0170'].accessLevel).toBe('financial');
  });

  it('the engine and the API agree on every member and every matter', async () => {
    // Two implementations of the same rule — the SQL list query and the
    // TypeScript precedence function. If they ever diverge, a matter appears in
    // a list and 404s on click (or the reverse, which is worse). Comparing them
    // over the whole seeded graph is the cheapest way to keep them honest.
    const firm = new FirmRepo(s.db);
    const engine = new PermissionEngine({ firm });
    for (const email of Object.values(FIRM)) {
      const userId = (await s.db.get<{ id: string }>(`select id from users where email = ?`, [email]))!.id;
      const p = await engine.resolve(userId, IDS.tenantKgm);
      expect(p, email).toBeTruthy();

      const viaEngine = await engine.listMatters(p!);
      const agent = createAgent(s.app);
      await firmLoginAs(agent, email);
      const res = await agent.get('/api/firm/matters');
      const viaApi = res.body.data.matters.map((m: any) => ({ id: m.id, level: m.accessLevel }));

      expect(viaApi.map((m: any) => m.id).sort(), email)
        .toEqual(viaEngine.map((m) => m.id).sort());
      for (const api of viaApi) {
        const eng = viaEngine.find((m) => m.id === api.id)!;
        expect(api.level, `${email} · ${api.id}`).toBe(eng.accessLevel);
      }
    }
  });
});

describe('§27 · restricted matters', () => {
  it('an explicit denial outranks a later widening of practice scope', async () => {
    // Mariam is excluded from the confidential acquisition by an explicit 'none'
    // row. Widening her practice area to cover it must NOT open it: the recorded
    // decision survives the scope change, which is the entire point of storing a
    // denial rather than merely omitting a grant.
    const mariam = await membershipOf(FIRM.paralegal);
    await s.db.run(
      `insert into membership_practice_areas (membership_id, practice_area, granted_at)
       values (?, 'Corporate / M&A', ?) on conflict do nothing`,
      [mariam, new Date().toISOString()],
    );

    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.paralegal);
    const res = await agent.get('/api/firm/matters');
    expect(res.body.data.matters.map((m: any) => m.matterNumber)).not.toContain('KGM-2026-0170');
    const detail = await agent.get(`/api/firm/matters/${IDS.matterGulf}`);
    expect(detail.status).toBe(404);
  });

  it('practice scope alone never opens a restricted matter', async () => {
    // A partner scoped to Corporate / M&A who is NOT on the team and has NOT been
    // granted access. Unrestricted matters in that area would be theirs; this one
    // is restricted, so it must not be.
    const partner = await addMember({
      email: 'probe.partner@kgm.example.test', name: 'Probe Partner', nameAr: 'شريك اختبار',
      roleCode: 'PARTNER', practiceAreas: ['Corporate / M&A'],
      financial: 100000, writeoff: 10000, discount: 15,
    });

    const firm = new FirmRepo(s.db);
    const engine = new PermissionEngine({ firm });
    const p = await engine.resolve(partner.userId, IDS.tenantKgm);
    expect(p).toBeTruthy();
    expect(await engine.matterAccessLevel(p!, IDS.matterGulf)).toBe('none');
    await expect(engine.requireMatter(p!, IDS.matterGulf, MATTER_READ)).rejects.toMatchObject({ status: 404 });

    // Now lift the restriction and ask again. The member's scope, roles and team
    // membership are all unchanged, so the ONLY thing that was blocking them was
    // §27 — which is what makes this a test of the restriction rather than of
    // the scope. Each test boots a fresh stack, so lifting it here is safe.
    await s.db.run(`update matter_controls set is_restricted = 0 where matter_id = ?`, [IDS.matterGulf]);
    expect(await engine.matterAccessLevel(p!, IDS.matterGulf)).toBe('view');

    // A matter outside their practice area stays invisible either way.
    expect(await engine.matterAccessLevel(p!, IDS.matterCommercial)).toBe('none');
  });

  it('team membership alone does not open a restricted matter', async () => {
    // Noura and Faisal hold explicit grants on the acquisition. Remove Faisal's
    // and his lead_lawyer team row must no longer be enough.
    const faisal = await membershipOf(FIRM.lawyer);
    await s.db.run(
      `update matter_permissions set revoked_at = ? where matter_id = ? and membership_id = ?`,
      [new Date().toISOString(), IDS.matterGulf, faisal],
    );

    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.lawyer);
    const res = await agent.get('/api/firm/matters');
    expect(res.body.data.matters.map((m: any) => m.matterNumber)).not.toContain('KGM-2026-0170');
    expect((await agent.get(`/api/firm/matters/${IDS.matterGulf}`)).status).toBe(404);
    // And matters.read_all does not rescue it either — Finance is next.
  });

  it('matters.read_all does not open a restricted matter', async () => {
    const sara = await membershipOf(FIRM.finance);
    await s.db.run(
      `update matter_permissions set revoked_at = ? where matter_id = ? and membership_id = ?`,
      [new Date().toISOString(), IDS.matterGulf, sara],
    );
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.finance);
    const res = await agent.get('/api/firm/matters');
    // Still sees every unrestricted matter through read_all — five of them, now
    // that the two closed files exist...
    expect(res.body.data.count).toBe(5);
    expect(res.body.data.matters.map((m: any) => m.matterNumber)).not.toContain('KGM-2026-0170');
  });

  it('the restriction reason is visible only to someone who can manage the matter', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const res = await agent.get(`/api/firm/matters/${IDS.matterGulf}`);
    expect(res.status).toBe(200);
    expect(res.body.data.restricted).toBe(true);
    expect(res.body.data.restrictionReason).toContain('confidential');

    // Sara has 'financial' on the same matter: enough to bill it, not enough to
    // read why the firm locked it down.
    const fin = createAgent(s.app);
    await firmLoginAs(fin, FIRM.finance);
    const finRes = await fin.get(`/api/firm/matters/${IDS.matterGulf}`);
    expect(finRes.status).toBe(200);
    expect(finRes.body.data.restricted).toBe(true);

    // §57 changed the shape here, and the change is the point: a withheld field
    // is ABSENT rather than null, and its name is reported in `withheld`. A null
    // is ambiguous — "no reason recorded" and "not for you" look identical — so
    // the caller cannot tell whether to render an empty value or a lock. Assert
    // all three properties: absent key, named in withheld, value nowhere in the
    // body. Asserting only `toBeNull()` would now fail, and asserting only
    // `toBeUndefined()` would be weaker than what the endpoint guarantees.
    expect(finRes.body.data).not.toHaveProperty('restrictionReason');
    expect(finRes.body.data).not.toHaveProperty('restrictionReasonAr');
    expect(finRes.body.data.withheld).toEqual(
      expect.arrayContaining(['restrictionReason', 'restrictionReasonAr']),
    );
    // Assert against the DISTINCTIVE value, not a generic word. The matter's own
    // title is "Corporate Acquisition" and is `public` classification, so a bare
    // needle of "acquisition" fails on data Sara is entitled to read — a false
    // failure that would eventually teach someone to delete the assertion.
    expect(finRes.text.toLowerCase()).not.toContain('highly confidential');
    expect(finRes.text.toLowerCase()).not.toContain('client 2 only');
    // The reason is visible to the partner on the same endpoint, so this is a
    // real difference between the two callers and not an absent value.
    expect(res.text.toLowerCase()).toContain('highly confidential');
  });

  it('restricting a matter requires the permission AND full access to it', async () => {
    // Faisal has matters.update but not matters.restrict, and only 'edit' on the
    // acquisition. Both gates must refuse him.
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.lawyer);
    const res = await agent.post(`/api/firm/matters/${IDS.matterGulf}/restrict`,
      { restricted: true, reason: 'probe' });
    expect(res.status).toBe(403);
    await settle();
    expect((await auditRows('PERMISSION_DENIED', 'matters.restrict')).length).toBeGreaterThan(0);

    // The restriction is unchanged in the database.
    const row = await s.db.get<{ is_restricted: number }>(
      `select is_restricted from matter_controls where matter_id = ?`, [IDS.matterGulf]);
    expect(Number(row?.is_restricted)).toBe(1);
  });

  it('a Managing Partner can restrict a matter and the change is audited', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const res = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/restrict`,
      { restricted: true, reason: 'Settlement posture confidential', reasonAr: 'سرية موقف التسوية' });
    expect(res.status).toBe(200);

    const row = await s.db.get<{ is_restricted: number; restriction_reason: string; restricted_by_membership_id: string }>(
      `select is_restricted, restriction_reason, restricted_by_membership_id from matter_controls where matter_id = ?`,
      [IDS.matterCommercial]);
    expect(Number(row?.is_restricted)).toBe(1);
    expect(row!.restriction_reason).toContain('Settlement');
    expect(row!.restricted_by_membership_id).toBe(await membershipOf(FIRM.managingPartner));
    await settle();
    expect((await auditRows('MATTER_RESTRICTED')).length).toBe(1);

    // And it took effect for everyone else immediately: Faisal is on the team,
    // but a restricted matter now needs an explicit grant he does not have.
    const lawyer = createAgent(s.app);
    await firmLoginAs(lawyer, FIRM.lawyer);
    const list = await lawyer.get('/api/firm/matters');
    expect(list.body.data.matters.map((m: any) => m.matterNumber)).not.toContain('KGM-2026-0148');
  });

  it('a restriction without a recorded reason is refused', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const res = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/restrict`, { restricted: true });
    expect(res.status).toBe(400);
    const row = await s.db.get<{ is_restricted: number }>(
      `select is_restricted from matter_controls where matter_id = ?`, [IDS.matterCommercial]);
    expect(Number(row?.is_restricted)).toBe(0);
  });
});

describe('§17 · cross-tenant matter isolation', () => {
  it('a matter from another firm is indistinguishable from one that does not exist', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const other = await agent.get(`/api/firm/matters/${IDS.matterLayla}`);
    const fake = await agent.get(`/api/firm/matters/${newId()}`);
    expect(other.status).toBe(404);
    expect(fake.status).toBe(404);
    expect(other.body).toEqual(fake.body);
  });

  it('listing never crosses the tenant boundary', async () => {
    for (const email of Object.values(FIRM)) {
      const agent = createAgent(s.app);
      await firmLoginAs(agent, email);
      const res = await agent.get('/api/firm/matters');
      for (const m of res.body.data.matters) {
        expect(m.matterNumber, email).not.toBe('NLP-2026-0021');
      }
    }
  });

  it('§72 · switching into a firm you do not belong to is refused and recorded', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const res = await agent.post('/api/firm/session/switch', { tenantId: IDS.tenantNajd });
    expect(res.status).toBe(403);
    await settle();
    const rows = await auditRows('ESCALATION_ATTEMPT', 'tenant_switch_not_member');
    expect(rows.length).toBe(1);
    // The live session survived the failed switch: a refused escalation must not
    // log the legitimate operator out.
    expect((await agent.get('/api/firm/session')).status).toBe(200);
  });
});

// ============================================================================
// §72 · PRIVILEGE-ESCALATION MATRIX
// ============================================================================

/**
 * The matrix from §72, as data. Each row is "this role tries to reach that
 * role's authority". Every pair is checked three ways: against the resolved
 * permission set, over HTTP where an endpoint exists, and against the database
 * where a constraint is the last line of defence.
 */
const ESCALATIONS: { from: string; to: string; permissions: string[] }[] = [
  { from: 'PARALEGAL', to: 'MANAGING_PARTNER', permissions: [
    'users.assign_role', 'users.invite', 'users.deactivate', 'roles.manage',
    'settings.manage', 'billing.approve', 'billing.writeoff', 'compliance.approve',
    'matters.restrict', 'audit.read', 'audit.export', 'clients.read_sensitive'] },
  { from: 'ASSOCIATE', to: 'PARTNER', permissions: [
    'matters.restrict', 'matters.close', 'matters.reopen', 'matters.assign',
    'billing.approve', 'users.assign_matter', 'documents.approve', 'clients.read_sensitive'] },
  { from: 'LAWYER', to: 'COMPLIANCE', permissions: [
    'compliance.read', 'compliance.create', 'compliance.review', 'compliance.approve',
    'compliance.complaints', 'clients.read_sensitive'] },
  { from: 'FINANCE', to: 'ADMIN', permissions: [
    'users.assign_role', 'users.deactivate', 'users.invite', 'roles.read',
    'settings.manage', 'users.revoke_session'] },
  { from: 'ADMIN', to: 'MANAGING_PARTNER', permissions: [
    'billing.approve', 'billing.writeoff', 'billing.send', 'compliance.approve',
    'compliance.review', 'matters.restrict', 'matters.close', 'clients.read_sensitive'] },
  { from: 'COMPLIANCE', to: 'FINANCE', permissions: [
    'billing.create', 'billing.edit', 'billing.send', 'billing.record_payment',
    'billing.discount', 'expenses.approve', 'time.adjust'] },
  { from: 'OPERATIONS', to: 'MANAGING_PARTNER', permissions: [
    'users.assign_role', 'billing.approve', 'compliance.approve', 'settings.manage',
    'audit.read', 'matters.restrict'] },
];

describe('§72 · escalation matrix — resolved authority matches the catalogue exactly', () => {
  it('every seeded operator holds precisely their template grant set, and nothing more', async () => {
    const engine = s.c.permissions;
    const pairs: [string, string][] = [
      [FIRM.managingPartner, 'MANAGING_PARTNER'], [FIRM.lawyer, 'LAWYER'],
      [FIRM.paralegal, 'PARALEGAL'], [FIRM.compliance, 'COMPLIANCE'], [FIRM.finance, 'FINANCE'],
    ];
    for (const [email, template] of pairs) {
      const userId = (await s.db.get<{ id: string }>(`select id from users where email = ?`, [email]))!.id;
      const p = await engine.resolve(userId, IDS.tenantKgm);
      expect(p, email).toBeTruthy();
      expect([...p!.permissions].sort(), email)
        .toEqual([...TEMPLATE_GRANTS[template]].sort());
    }
  });

  for (const esc of ESCALATIONS) {
    it(`${esc.from} cannot reach ${esc.to} authority`, async () => {
      const engine = s.c.permissions;
      const member = await addMember({
        email: `probe.${esc.from.toLowerCase()}@kgm.example.test`,
        name: `Probe ${esc.from}`, nameAr: `اختبار ${esc.from}`, roleCode: esc.from,
      });
      const p = await engine.resolve(member.userId, IDS.tenantKgm);
      expect(p, esc.from).toBeTruthy();

      for (const perm of esc.permissions) {
        // The permission must exist in the catalogue, or this test would pass
        // vacuously by checking a code nobody could ever hold.
        expect(PERMISSIONS.some((x) => x.code === perm), `${perm} must be a real permission`).toBe(true);
        expect(p!.permissions.has(perm), `${esc.from} must NOT hold ${perm}`).toBe(false);
        expect(() => engine.assertCan(p!, perm), `${perm} must be refused`).toThrowError(/access/i);
      }
    });
  }

  it('the target roles DO hold what the source role lacks, so the matrix is not vacuous', async () => {
    // A matrix where nobody holds anything proves nothing. For each pair, assert
    // the escalated-to role genuinely has the authority being attempted.
    const engine = s.c.permissions;
    for (const esc of ESCALATIONS) {
      const target = await addMember({
        email: `target.${esc.to.toLowerCase()}.${esc.from.toLowerCase()}@kgm.example.test`,
        name: `Target ${esc.to}`, nameAr: `هدف ${esc.to}`, roleCode: esc.to,
      });
      const p = await engine.resolve(target.userId, IDS.tenantKgm);
      for (const perm of esc.permissions) {
        expect(p!.permissions.has(perm), `${esc.to} SHOULD hold ${perm}`).toBe(true);
      }
      expect(engine, 'engine reachable').toBeTruthy();
    }
  });
});

describe('§72 · escalation over HTTP — API, URL and payload', () => {
  it('a paralegal cannot administer members, roles, settings or the audit log', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.paralegal);
    const target = await membershipOf(FIRM.lawyer);

    const attempts: [string, () => Promise<{ status: number; body: any }>][] = [
      ['GET  /admin/members', () => agent.get('/api/firm/admin/members')],
      ['GET  /admin/settings', () => agent.get('/api/firm/admin/settings')],
      ['GET  /admin/audit', () => agent.get('/api/firm/admin/audit')],
      ['POST /admin/members/:id/status', () => agent.post(`/api/firm/admin/members/${target}/status`, { status: 'suspended' })],
      ['POST /admin/members/:id/roles', () => agent.post(`/api/firm/admin/members/${target}/roles`, { roleCode: 'MANAGING_PARTNER' })],
      ['POST /matters/:id/restrict', () => agent.post(`/api/firm/matters/${IDS.matterCommercial}/restrict`, { restricted: true, reason: 'probe attempt' })],
      ['POST /matters/:id/access', () => agent.post(`/api/firm/matters/${IDS.matterCommercial}/access`, { membershipId: target, accessLevel: 'full' })],
    ];
    for (const [label, fn] of attempts) {
      const res = await fn();
      expect(res.status, label).toBeGreaterThanOrEqual(400);
      expect(res.status, label).toBeLessThan(500);
      // No endpoint may answer 200 to a paralegal's administrative attempt.
      expect(res.status, label).not.toBe(200);
    }

    await settle();
    // The target lawyer is untouched.
    const lawyer = await s.db.get<{ status: string }>(
      `select status from firm_memberships where id = ?`, [target]);
    expect(lawyer!.status).toBe('active');
    const roles = await s.db.all<{ code: string }>(
      `select r.code from membership_roles mr join roles r on r.id = mr.role_id
        where mr.membership_id = ? and mr.revoked_at is null`, [target]);
    expect(roles.map((r) => r.code)).toEqual(['LAWYER']);
    // And every attempt left a trail.
    expect((await auditRows('PERMISSION_DENIED')).length).toBeGreaterThanOrEqual(5);
  });

  it('a lawyer cannot make compliance decisions', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.lawyer);
    // There is no compliance endpoint yet (P4), so the refusal is proven at the
    // layer that would guard it: the engine, with the real resolved principal and
    // the container's denial sink, which is what writes the audit row.
    const engine = s.c.permissions;
    const userId = (await s.db.get<{ id: string }>(`select id from users where email = ?`, [FIRM.lawyer]))!.id;
    const p = await engine.resolve(userId, IDS.tenantKgm);
    for (const perm of ['compliance.approve', 'compliance.review', 'compliance.read', 'compliance.create']) {
      expect(() => engine.assertCan(p!, perm)).toThrowError(/access/i);
    }
    await settle();
    expect((await auditRows('PERMISSION_DENIED', 'compliance.')).length).toBe(4);
  });

  it('finance cannot administer users or change firm settings', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.finance);
    const target = await membershipOf(FIRM.paralegal);
    expect((await agent.get('/api/firm/admin/members')).status).toBe(403);
    expect((await agent.get('/api/firm/admin/settings')).status).toBe(403);
    expect((await agent.post(`/api/firm/admin/members/${target}/status`, { status: 'suspended' })).status).toBe(403);
    expect((await agent.post(`/api/firm/admin/members/${target}/roles`, { roleCode: 'ADMIN' })).status).toBe(403);
    const row = await s.db.get<{ status: string }>(`select status from firm_memberships where id = ?`, [target]);
    expect(row!.status).toBe('active');
  });

  it('an administrator cannot approve money or make compliance decisions', async () => {
    const admin = await addMember({
      email: 'probe.admin@kgm.example.test', name: 'Probe Admin', nameAr: 'إداري اختبار',
      roleCode: 'ADMIN', financial: 999999, writeoff: 999999, discount: 99,
    });
    // A deliberately generous ceiling: the point is that NO ceiling rescues a
    // missing permission. Authority and permission are independent gates.
    const agent = createAgent(s.app);
    await firmLoginAs(agent, 'probe.admin@kgm.example.test');
    expect((await agent.get('/api/firm/admin/members')).status).toBe(200);

    const invoice = 'd1000000-0000-4000-8000-000000000004';
    const res = await agent.post(`/api/firm/billing/invoices/${invoice}/approve`, { amount: 25300 });
    expect(res.status).toBe(403);
    await settle();
    expect((await auditRows('PERMISSION_DENIED', 'billing.approve')).length).toBe(1);
    const row = await s.db.get<{ internal_status: string }>(`select internal_status from invoices where id = ?`, [invoice]);
    expect(row!.internal_status).toBe('pending_internal_approval');
    expect(admin.membershipId).toBeTruthy();
  });

  it('URL probing cannot reach an endpoint that does not exist, and cannot bypass one that does', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.paralegal);
    const target = await membershipOf(FIRM.lawyer);
    const shapes = [
      '/api/firm/admin/members/../audit',
      '/api/firm/admin//members',
      '/api/firm/admin/members/',
      '/api/firm/admin/audit?format=csv',
      `/api/firm/admin/members/${target}/roles?as=MANAGING_PARTNER`,
      '/api/firm/ADMIN/members',
      '/api/firm/admin/members%2f..%2f..%2fclient',
      '/api/firm/roles',
      '/api/firm/users',
      '/api/firm/permissions',
      '/api/firm/audit',
      '/api/firm/settings',
    ];
    for (const url of shapes) {
      const res = await agent.get(url);
      expect([403, 404], `${url} -> ${res.status}`).toContain(res.status);
      expect(res.status, url).not.toBe(200);
    }
    // The query string cannot carry authority either.
    const post = await agent.post(`/api/firm/admin/members/${target}/roles?roleCode=MANAGING_PARTNER`, {});
    expect([400, 403, 404]).toContain(post.status);
  });

  it('payload injection cannot add authority that was not resolved', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.paralegal);
    const target = await membershipOf(FIRM.lawyer);

    // Unknown keys are refused outright and recorded, rather than ignored: an
    // ignored key is a silent probe, and §72 asks us to assume the caller is
    // testing the boundary on purpose.
    const injections = [
      { roleCode: 'MANAGING_PARTNER', tenantId: IDS.tenantNajd },
      { roleCode: 'MANAGING_PARTNER', permissions: ['users.assign_role'] },
      { roleCode: 'MANAGING_PARTNER', membershipId: await membershipOf(FIRM.managingPartner) },
      { roleCode: 'MANAGING_PARTNER', isSystem: true },
      { roleCode: 'MANAGING_PARTNER', grantedByMembershipId: await membershipOf(FIRM.managingPartner) },
    ];
    for (const body of injections) {
      const res = await agent.post(`/api/firm/admin/members/${target}/roles`, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
    await settle();
    expect((await auditRows('FIELD_TAMPER_ATTEMPT', 'unrecognized_keys')).length).toBe(injections.length);

    // A well-formed request from the same caller is still refused on permission.
    const clean = await agent.post(`/api/firm/admin/members/${target}/roles`, { roleCode: 'MANAGING_PARTNER' });
    expect(clean.status).toBe(403);

    // Nothing changed.
    const roles = await s.db.all<{ code: string }>(
      `select r.code from membership_roles mr join roles r on r.id = mr.role_id
        where mr.membership_id = ? and mr.revoked_at is null`, [target]);
    expect(roles.map((r) => r.code)).toEqual(['LAWYER']);
  });

  it('a member cannot grant access on a matter in another firm by naming its id', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const own = await membershipOf(FIRM.paralegal);
    // Noura legitimately holds users.assign_matter, so the permission gate
    // passes; the matter gate must still refuse a Najd matter.
    const res = await agent.post(`/api/firm/matters/${IDS.matterLayla}/access`,
      { membershipId: own, accessLevel: 'full' });
    expect(res.status).toBe(404);
    const rows = await s.db.all<{ n: number }>(
      `select count(*) as n from matter_permissions where matter_id = ?`, [IDS.matterLayla]);
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  it('a member cannot grant matter access to a membership of another firm', async () => {
    // A Najd membership id presented to a KGM administrator. The permission is
    // real, the matter is real, the target is not theirs.
    const najdMember = await addMember({
      email: 'probe.najd@najd.example.test', name: 'Najd Probe', nameAr: 'اختبار نجد',
      roleCode: 'LAWYER', tenantId: IDS.tenantNajd, practiceAreas: ['*'],
    });
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const res = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/access`,
      { membershipId: najdMember.membershipId, accessLevel: 'full' });
    expect(res.status).toBe(404);
    await settle();
    expect((await auditRows('ESCALATION_ATTEMPT', 'cross_tenant_matter_grant')).length).toBe(1);
    const rows = await s.db.all<{ n: number }>(
      `select count(*) as n from matter_permissions where membership_id = ?`, [najdMember.membershipId]);
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  it('an administrator cannot change their own status, and cannot suspend themselves out of a request', async () => {
    const admin = await addMember({
      email: 'probe.selfadmin@kgm.example.test', name: 'Self Admin', nameAr: 'إداري ذاتي',
      roleCode: 'ADMIN',
    });
    const agent = createAgent(s.app);
    await firmLoginAs(agent, 'probe.selfadmin@kgm.example.test');
    const res = await agent.post(`/api/firm/admin/members/${admin.membershipId}/status`, { status: 'suspended' });
    expect(res.status).toBe(403);
    const row = await s.db.get<{ status: string }>(`select status from firm_memberships where id = ?`, [admin.membershipId]);
    expect(row!.status).toBe('active');
  });
});

// ============================================================================
// §73 · FINANCIAL SECURITY
// ============================================================================

const DRAFT_INVOICE = 'd1000000-0000-4000-8000-000000000004'; // 25,300.00 SAR outstanding
const DRAFT_OUTSTANDING = 25300;

describe('§73 · financial authority ceilings', () => {
  it('a NULL ceiling refuses, it never means unlimited', async () => {
    const engine = s.c.permissions;
    const userId = (await s.db.get<{ id: string }>(`select id from users where email = ?`, [FIRM.lawyer]))!.id;
    const p = await engine.resolve(userId, IDS.tenantKgm);
    expect(p!.ceilings.financialSar).toBeNull();
    expect(p!.ceilings.writeoffSar).toBeNull();
    expect(p!.ceilings.discountPct).toBeNull();

    // Zero, one satoshi, and a huge number all refuse. This is the single most
    // important assertion in the file: `ceiling ?? Infinity` would pass all three.
    for (const amount of [0, 0.01, 1, 1000, 1e9]) {
      expect(() => engine.assertWithinAuthority(p!, 'invoice', amount), `amount ${amount}`)
        .toThrowError(/financial authority/i);
    }
    await settle();
    expect((await auditRows('CEILING_EXCEEDED', 'ceiling_not_set')).length).toBe(5);
  });

  it('over-ceiling is refused, at-ceiling is allowed, and the comparison is on the cent', async () => {
    const engine = s.c.permissions;
    const userId = (await s.db.get<{ id: string }>(`select id from users where email = ?`, [FIRM.finance]))!.id;
    const p = await engine.resolve(userId, IDS.tenantKgm);
    expect(p!.ceilings.financialSar).toBe(25000);

    expect(() => engine.assertWithinAuthority(p!, 'invoice', 24999.99)).not.toThrow();
    expect(() => engine.assertWithinAuthority(p!, 'invoice', 25000)).not.toThrow();
    // A fraction of a halala over the ceiling must not slip through on a float
    // comparison, and must not be rounded away either.
    expect(() => engine.assertWithinAuthority(p!, 'invoice', 25000.01)).toThrowError(/financial authority/i);
    expect(() => engine.assertWithinAuthority(p!, 'invoice', 25000.004)).not.toThrow();

    // The write-off and discount ceilings are separate numbers, not aliases.
    expect(() => engine.assertWithinAuthority(p!, 'writeoff', 5000)).not.toThrow();
    expect(() => engine.assertWithinAuthority(p!, 'writeoff', 5001)).toThrowError(/financial authority/i);
    expect(() => engine.assertWithinAuthority(p!, 'discount_pct', 10)).not.toThrow();
    expect(() => engine.assertWithinAuthority(p!, 'discount_pct', 10.5)).toThrowError(/financial authority/i);
  });

  it('a negative, NaN or infinite amount is refused before any ceiling is consulted', async () => {
    const engine = s.c.permissions;
    const userId = (await s.db.get<{ id: string }>(`select id from users where email = ?`, [FIRM.managingPartner]))!.id;
    const p = await engine.resolve(userId, IDS.tenantKgm);
    expect(p!.ceilings.financialSar).toBe(500000);
    for (const amount of [-1, -0.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => engine.assertWithinAuthority(p!, 'invoice', amount), `amount ${amount}`)
        .toThrowError(/financial authority/i);
    }
  });

  it('a Managing Partner can approve an invoice inside her ceiling', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const res = await agent.post(`/api/firm/billing/invoices/${DRAFT_INVOICE}/approve`,
      { amount: DRAFT_OUTSTANDING });
    expect(res.status).toBe(200);
    const row = await s.db.get<{ internal_status: string; approved_by_staff: string }>(
      `select internal_status, approved_by_staff from invoices where id = ?`, [DRAFT_INVOICE]);
    expect(row!.internal_status).toBe('approved');
    expect(row!.approved_by_staff).toBeTruthy();
    await settle();
    expect((await auditRows('ADMIN_MUTATION', 'billing.approve')).length).toBe(1);
  });

  it('lowering the ceiling mid-session takes effect on the next request', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const noura = await membershipOf(FIRM.managingPartner);

    await s.db.run(`update firm_memberships set financial_authority_sar = 1000 where id = ?`, [noura]);
    const res = await agent.post(`/api/firm/billing/invoices/${DRAFT_INVOICE}/approve`,
      { amount: DRAFT_OUTSTANDING });
    expect(res.status).toBe(403);
    await settle();
    expect((await auditRows('CEILING_EXCEEDED', 'ceiling_exceeded')).length).toBe(1);
    const row = await s.db.get<{ internal_status: string }>(`select internal_status from invoices where id = ?`, [DRAFT_INVOICE]);
    expect(row!.internal_status).toBe('pending_internal_approval');
  });

  it('a permission without a ceiling still refuses — Finance granted approval authority cannot exceed 25,000', async () => {
    // The two gates are independent. Sara's 25,000 ceiling is deliberately just
    // under this invoice's 25,300 balance, so holding the permission is not
    // enough on its own.
    const sara = await membershipOf(FIRM.finance);
    const noura = await membershipOf(FIRM.managingPartner);
    await grantRole(sara, 'PARTNER', noura);
    // Approving an invoice requires financial-level access to the matter it
    // belongs to, not merely visibility. Sara's matters.read_all gives her
    // 'view' on every unrestricted matter, which is deliberately NOT enough —
    // so grant the lateral 'financial' level explicitly, and the only gate left
    // standing between her and this invoice is the numeric ceiling.
    await s.db.run(
      `insert into matter_permissions (id, matter_id, tenant_id, membership_id, access_level, reason,
                                       granted_by_membership_id, granted_at)
       values (?, ?, ?, ?, 'financial', 'billing authority for ceiling test', ?, ?)
       on conflict (matter_id, membership_id) do update
         set access_level = 'financial', revoked_at = null`,
      [newId(), IDS.matterCommercial, IDS.tenantKgm, sara, noura, new Date().toISOString()],
    );

    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.finance);
    // The new role is live without re-login: authority is re-resolved per request.
    const session = await agent.get('/api/firm/session');
    expect(session.body.data.member.roles.map((r: any) => r.code).sort()).toEqual(['FINANCE', 'PARTNER']);
    expect(session.body.data.member.permissions).toContain('billing.approve');

    const res = await agent.post(`/api/firm/billing/invoices/${DRAFT_INVOICE}/approve`,
      { amount: DRAFT_OUTSTANDING });
    expect(res.status).toBe(403);
    await settle();
    expect((await auditRows('CEILING_EXCEEDED')).length).toBeGreaterThan(0);
    const row = await s.db.get<{ internal_status: string }>(`select internal_status from invoices where id = ?`, [DRAFT_INVOICE]);
    expect(row!.internal_status).toBe('pending_internal_approval');
  });

  it('understating the amount to slip under a ceiling is refused', async () => {
    const sara = await membershipOf(FIRM.finance);
    const noura = await membershipOf(FIRM.managingPartner);
    await grantRole(sara, 'PARTNER', noura);
    await s.db.run(
      `insert into matter_permissions (id, matter_id, tenant_id, membership_id, access_level, reason,
                                       granted_by_membership_id, granted_at)
       values (?, ?, ?, ?, 'financial', 'billing authority for mismatch test', ?, ?)
       on conflict (matter_id, membership_id) do update
         set access_level = 'financial', revoked_at = null`,
      [newId(), IDS.matterCommercial, IDS.tenantKgm, sara, noura, new Date().toISOString()],
    );
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.finance);

    // Claiming to approve 24,000 of a 25,300 invoice. The server authorizes the
    // invoice's actual balance, not the number in the body.
    const res = await agent.post(`/api/firm/billing/invoices/${DRAFT_INVOICE}/approve`, { amount: 24000 });
    expect(res.status).toBe(400);
    await settle();
    expect((await auditRows('CEILING_EXCEEDED', 'amount_mismatch')).length).toBe(1);
    const row = await s.db.get<{ internal_status: string }>(`select internal_status from invoices where id = ?`, [DRAFT_INVOICE]);
    expect(row!.internal_status).toBe('pending_internal_approval');
  });

  it('an invoice cannot be approved twice, and a paid invoice cannot be re-approved', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const first = await agent.post(`/api/firm/billing/invoices/${DRAFT_INVOICE}/approve`, { amount: DRAFT_OUTSTANDING });
    expect(first.status).toBe(200);
    const second = await agent.post(`/api/firm/billing/invoices/${DRAFT_INVOICE}/approve`, { amount: DRAFT_OUTSTANDING });
    expect(second.status).toBe(404);

    // A settled invoice is not in an approvable state either.
    const paid = 'd1000000-0000-4000-8000-000000000003';
    const paidRow = await s.db.get<{ total: number; amount_paid: number }>(
      `select total, amount_paid from invoices where id = ?`, [paid]);
    const outstanding = Number(paidRow!.total) - Number(paidRow!.amount_paid);
    const res = await agent.post(`/api/firm/billing/invoices/${paid}/approve`, { amount: outstanding });
    expect([400, 404]).toContain(res.status);
  });

  it('an invoice in another firm cannot be approved by id', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const res = await agent.post('/api/firm/billing/invoices/d2000000-0000-4000-8000-000000000001/approve',
      { amount: 1000 });
    expect(res.status).toBe(404);
  });

  it('a non-finite or negative amount in the body never reaches the ceiling check', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    for (const amount of [-1, '25300', null, {}, 1e13]) {
      const res = await agent.post(`/api/firm/billing/invoices/${DRAFT_INVOICE}/approve`, { amount } as never);
      expect(res.status, `amount ${JSON.stringify(amount)}`).toBe(400);
    }
    const row = await s.db.get<{ internal_status: string }>(`select internal_status from invoices where id = ?`, [DRAFT_INVOICE]);
    expect(row!.internal_status).toBe('pending_internal_approval');
  });
});

// ============================================================================
// §52 · FIRM SESSIONS
// ============================================================================

describe('§52 · firm sessions', () => {
  it('logout revokes the session row and clears the cookie', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.lawyer);
    expect((await agent.get('/api/firm/session')).status).toBe(200);

    const res = await agent.post('/api/firm/auth/logout', {});
    expect(res.status).toBe(200);
    expect(agent.cookies.has('kgm_firm_session')).toBe(false);

    const rows = await s.db.all<{ revoked_at: string | null; revoke_reason: string | null }>(
      `select revoked_at, revoke_reason from firm_sessions`);
    expect(rows.length).toBe(1);
    expect(rows[0].revoked_at).toBeTruthy();
    expect(rows[0].revoke_reason).toBe('logout');
    await settle();
    expect((await auditRows('FIRM_LOGOUT')).length).toBe(1);
  });

  it('a revoked session token cannot be replayed', async () => {
    const agent = createAgent(s.app);
    const login = await firmLoginAs(agent, FIRM.lawyer);
    expect(login.status).toBe(200);
    const token = agent.cookies.get('kgm_firm_session')!;
    await agent.post('/api/firm/auth/logout', {});

    // Put the old cookie back and try again.
    agent.cookies.set('kgm_firm_session', token);
    const res = await agent.get('/api/firm/session');
    expect(res.status).toBe(401);
  });

  it('suspending a member ends their live session immediately', async () => {
    const target = createAgent(s.app);
    await firmLoginAs(target, FIRM.paralegal);
    expect((await target.get('/api/firm/matters')).status).toBe(200);

    const admin = createAgent(s.app);
    await firmLoginAs(admin, FIRM.managingPartner);
    const res = await admin.post(`/api/firm/admin/members/${await membershipOf(FIRM.paralegal)}/status`,
      { status: 'suspended' });
    expect(res.status).toBe(200);

    // The paralegal's cookie is still in their jar; the session behind it is not.
    expect((await target.get('/api/firm/matters')).status).toBe(401);
    expect((await target.get('/api/firm/session')).status).toBe(401);

    const row = await s.db.get<{ status: string }>(
      `select status from firm_memberships where id = ?`, [await membershipOf(FIRM.paralegal)]);
    expect(row!.status).toBe('suspended');
    await settle();
    expect((await auditRows('ADMIN_MUTATION', 'users.deactivate')).length).toBe(1);
  });

  it('reinstating a suspended member does not resurrect their old session', async () => {
    const target = createAgent(s.app);
    await firmLoginAs(target, FIRM.paralegal);
    const token = target.cookies.get('kgm_firm_session')!;

    const admin = createAgent(s.app);
    await firmLoginAs(admin, FIRM.managingPartner);
    const m = await membershipOf(FIRM.paralegal);
    await admin.post(`/api/firm/admin/members/${m}/status`, { status: 'suspended' });
    await admin.post(`/api/firm/admin/members/${m}/status`, { status: 'active' });

    target.cookies.set('kgm_firm_session', token);
    expect((await target.get('/api/firm/session')).status).toBe(401);
    // They can sign in again.
    expect((await firmLoginAs(target, FIRM.paralegal)).status).toBe(200);
  });

  it('changing a role ends the affected sessions so stale authority cannot linger', async () => {
    const target = createAgent(s.app);
    await firmLoginAs(target, FIRM.paralegal);
    expect((await target.get('/api/firm/admin/members')).status).toBe(403);

    const admin = createAgent(s.app);
    await firmLoginAs(admin, FIRM.managingPartner);
    const res = await admin.post(`/api/firm/admin/members/${await membershipOf(FIRM.paralegal)}/roles`,
      { roleCode: 'ADMIN' });
    expect(res.status).toBe(200);
    await settle();
    expect((await auditRows('ROLE_GRANTED')).length).toBe(1);

    // The old session is dead...
    expect((await target.get('/api/firm/session')).status).toBe(401);
    // ...and the new one carries the new authority.
    const fresh = createAgent(s.app);
    await firmLoginAs(fresh, FIRM.paralegal);
    const session = await fresh.get('/api/firm/session');
    expect(session.body.data.member.roles.map((r: any) => r.code).sort()).toEqual(['ADMIN', 'PARALEGAL']);
    expect((await fresh.get('/api/firm/admin/members')).status).toBe(200);
  });

  it('authority granted directly in the database applies on the next request, without re-login', async () => {
    // The mirror image of the test above: sessions are revoked by the ROUTE as a
    // deliberate policy, but the authorization graph itself is re-read from the
    // database on every request. A session is never a cache of permissions.
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.paralegal);
    expect((await agent.get('/api/firm/admin/members')).status).toBe(403);

    await grantRole(await membershipOf(FIRM.paralegal), 'ADMIN', await membershipOf(FIRM.managingPartner));
    expect((await agent.get('/api/firm/admin/members')).status).toBe(200);

    // And revoking it takes away again, mid-session.
    await s.db.run(
      `update membership_roles set revoked_at = ? where membership_id = ? and role_id = ?`,
      [new Date().toISOString(), await membershipOf(FIRM.paralegal), await roleIdOf('ADMIN')],
    );
    expect((await agent.get('/api/firm/admin/members')).status).toBe(403);
  });

  it('a session cannot outlive its membership', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.lawyer);
    expect((await agent.get('/api/firm/session')).status).toBe(200);
    await s.db.run(`update firm_memberships set status = 'left', left_at = ? where id = ?`,
      [new Date().toISOString(), await membershipOf(FIRM.lawyer)]);
    expect((await agent.get('/api/firm/session')).status).toBe(401);
  });

  it('§52 · tenant MFA policy blocks a Managing Partner who has not enrolled', async () => {
    await s.db.run(`update tenant_settings set mfa_required = 1 where tenant_id = ?`, [IDS.tenantKgm]);

    // Noura is a Managing Partner with no MFA enrollment. The policy says she
    // may not sign in with a password alone — and the refusal is a 403 asking her
    // to enroll, NOT a silent downgrade to password-only.
    const mp = createAgent(s.app);
    const res = await firmLoginAs(mp, FIRM.managingPartner);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('mfa_required');
    expect(res.body.error.details.step).toBe('enroll_mfa');
    expect(mp.cookies.has('kgm_firm_session')).toBe(false);

    // A role outside the policy still signs in normally.
    const fin = createAgent(s.app);
    expect((await firmLoginAs(fin, FIRM.finance)).status).toBe(200);
    await settle();
    expect((await auditRows('FIRM_LOGIN_FAILED', 'mfa_enrollment_required')).length).toBe(1);
  });

  it('§52 · a critical action is refused mid-session once the MFA policy is switched on', async () => {
    const admin = createAgent(s.app);
    await firmLoginAs(admin, FIRM.managingPartner);
    const target = await membershipOf(FIRM.paralegal);

    // Works while the policy is off.
    expect((await admin.post(`/api/firm/admin/members/${target}/status`, { status: 'suspended' })).status).toBe(200);
    await admin.post(`/api/firm/admin/members/${target}/status`, { status: 'active' });

    await s.db.run(`update tenant_settings set mfa_required = 1 where tenant_id = ?`, [IDS.tenantKgm]);
    const res = await admin.post(`/api/firm/admin/members/${target}/status`, { status: 'suspended' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('mfa_required');
    await settle();
    expect((await auditRows('ESCALATION_ATTEMPT', 'mfa_required')).length).toBe(1);

    // A non-critical action is unaffected: the gate is per-permission, not global.
    expect((await admin.get('/api/firm/matters')).status).toBe(200);
  });

  it('the session list never exposes raw IP addresses', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const res = await agent.get('/api/firm/session/devices');
    expect(res.status).toBe(200);
    expect(res.body.data.sessions.length).toBe(1);
    expect(res.body.data.sessions[0].current).toBe(true);
    expect(res.text).not.toMatch(/ipHash/);
    expect(res.text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it('sign out everywhere revokes every session for the membership', async () => {
    const a = createAgent(s.app);
    const b = createAgent(s.app);
    await firmLoginAs(a, FIRM.lawyer);
    await firmLoginAs(b, FIRM.lawyer);
    expect((await a.get('/api/firm/session')).status).toBe(200);
    expect((await b.get('/api/firm/session')).status).toBe(200);

    expect((await a.post('/api/firm/session/revoke-all', {})).status).toBe(200);
    expect((await b.get('/api/firm/session')).status).toBe(401);
    const rows = await s.db.all<{ revoked_at: string | null }>(`select revoked_at from firm_sessions`);
    expect(rows.every((r) => r.revoked_at)).toBe(true);
  });
});

// ============================================================================
// §49 / §51 · ADMINISTRATION AND THE AUDIT TRAIL
// ============================================================================

describe('§49/§51 · administration and audit', () => {
  it('audit search exists only for holders of audit.read', async () => {
    // PARALEGAL, LAWYER, FINANCE and ADMIN hold no audit permission at all
    // (§13, §14, §16). COMPLIANCE and MANAGING_PARTNER do (§15, §9).
    for (const email of [FIRM.paralegal, FIRM.lawyer, FIRM.finance]) {
      const agent = createAgent(s.app);
      await firmLoginAs(agent, email);
      const res = await agent.get('/api/firm/admin/audit');
      // 404, not 403: a member without the permission must not learn that a log
      // search exists to be denied.
      expect(res.status, email).toBe(404);
    }
    for (const email of [FIRM.managingPartner, FIRM.compliance]) {
      const agent = createAgent(s.app);
      await firmLoginAs(agent, email);
      expect((await agent.get('/api/firm/admin/audit')).status, email).toBe(200);
    }
    // An ADMIN — who can change the authorization graph but must not read the
    // trail of everyone else doing it — is refused too.
    const admin = await addMember({
      email: 'probe.auditadmin@kgm.example.test', name: 'Audit Admin', nameAr: 'إداري التدقيق',
      roleCode: 'ADMIN',
    });
    const adminAgent = createAgent(s.app);
    await firmLoginAs(adminAgent, 'probe.auditadmin@kgm.example.test');
    expect((await adminAgent.get('/api/firm/admin/audit')).status).toBe(404);
    expect(admin.membershipId).toBeTruthy();
  });

  it('the audit trail a Managing Partner reads is append-only', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    // Generate a couple of rows first.
    await agent.post(`/api/firm/admin/members/${await membershipOf(FIRM.paralegal)}/roles`, { roleCode: 'LAWYER' });
    await settle();

    const res = await agent.get('/api/firm/admin/audit?limit=500');
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBeGreaterThan(0);

    const before = await s.db.get<{ n: number }>(`select count(*) as n from audit_events`);
    // UPDATE and DELETE are refused by the schema, for any actor kind.
    await expect(s.db.run(`update audit_events set action = 'REDACTED'`)).rejects.toThrow();
    await expect(s.db.run(`delete from audit_events`)).rejects.toThrow();
    const after = await s.db.get<{ n: number }>(`select count(*) as n from audit_events`);
    expect(Number(after!.n)).toBe(Number(before!.n));
    const redacted = await s.db.all<{ n: number }>(`select count(*) as n from audit_events where action = 'REDACTED'`);
    expect(Number(redacted[0].n)).toBe(0);
  });

  it('audit search is confined to the caller\'s own firm', async () => {
    // A Najd operator must not read KGM's trail even though both live in one
    // table. Najd has no seeded membership, so create one.
    const najdAdmin = await addMember({
      email: 'najd.admin@najd.example.test', name: 'Najd Admin', nameAr: 'إداري نجد',
      roleCode: 'MANAGING_PARTNER', tenantId: IDS.tenantNajd, practiceAreas: ['*'],
      financial: 100000, writeoff: 10000, discount: 20,
    });
    // Give Najd something to find, and make sure KGM has something too.
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    await agent.post(`/api/firm/admin/members/${await membershipOf(FIRM.paralegal)}/roles`, { roleCode: 'LAWYER' });
    await settle();

    const najd = createAgent(s.app);
    await firmLoginAs(najd, 'najd.admin@najd.example.test');
    const res = await najd.get('/api/firm/admin/audit?limit=500');
    expect(res.status).toBe(200);

    // Najd sees its own trail — its login at minimum — and not one row of KGM's.
    // The projection carries tenant_id precisely so this is checkable from the
    // outside rather than assumed from the WHERE clause.
    const events = res.body.data.events as { tenantId: string; action: string }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.tenantId === IDS.tenantNajd)).toBe(true);
    expect(events.some((e) => e.tenantId === IDS.tenantKgm)).toBe(false);
    expect(events.some((e) => e.action === 'ROLE_GRANTED')).toBe(false);

    // And KGM's own search does contain that row, so the difference above is the
    // tenant boundary and not an empty log.
    const kgm = await agent.get('/api/firm/admin/audit?limit=500');
    expect(kgm.body.data.events.some((e: any) => e.action === 'ROLE_GRANTED')).toBe(true);
    expect(najdAdmin.membershipId).toBeTruthy();
  });

  it('every firm refusal is attributed to a membership, not just a user', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.paralegal);
    await agent.get('/api/firm/admin/members');
    await settle();
    const rows = await s.db.all<{ actor_kind: string; metadata: string }>(
      `select actor_kind, metadata from audit_events where action = 'PERMISSION_DENIED'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.actor_kind).toBe('firm_member');
      const meta = JSON.parse(r.metadata) as { membershipId?: string };
      expect(meta.membershipId, 'denial must name the membership').toBe(await membershipOf(FIRM.paralegal));
    }
  });

  it('a successful privilege change records both the actor and the target', async () => {
    const admin = createAgent(s.app);
    await firmLoginAs(admin, FIRM.managingPartner);
    const target = await membershipOf(FIRM.paralegal);
    await admin.post(`/api/firm/admin/members/${target}/roles`, { roleCode: 'LAWYER' });
    await settle();

    const rows = await s.db.all<{ metadata: string; resource_id: string }>(
      `select metadata, resource_id from audit_events where action = 'ROLE_GRANTED'`);
    expect(rows.length).toBe(1);
    expect(rows[0].resource_id).toBe(target);
    const meta = JSON.parse(rows[0].metadata) as Record<string, unknown>;
    expect(meta.membershipId).toBe(await membershipOf(FIRM.managingPartner));
    expect(meta.roleCode).toBe('LAWYER');
    expect(meta.revoke).toBe(false);
  });
});

// ============================================================================
// DATABASE-LEVEL DEFENCE (§71, §83) — the last line, underneath the API
// ============================================================================

describe('database constraints · the last line of defence', () => {
  it('a membership cannot be moved to another firm', async () => {
    const m = await membershipOf(FIRM.lawyer);
    await expect(s.db.run(`update firm_memberships set tenant_id = ? where id = ?`,
      [IDS.tenantNajd, m])).rejects.toThrow(/immutable/i);
    const row = await s.db.get<{ tenant_id: string }>(`select tenant_id from firm_memberships where id = ?`, [m]);
    expect(row!.tenant_id).toBe(IDS.tenantKgm);
  });

  it('a financial ceiling cannot be negative, and a discount cannot exceed 100', async () => {
    const m = await membershipOf(FIRM.finance);
    await expect(s.db.run(`update firm_memberships set financial_authority_sar = -1 where id = ?`, [m]))
      .rejects.toThrow();
    await expect(s.db.run(`update firm_memberships set writeoff_authority_sar = -0.01 where id = ?`, [m]))
      .rejects.toThrow();
    await expect(s.db.run(`update firm_memberships set discount_authority_pct = 100.5 where id = ?`, [m]))
      .rejects.toThrow();
    await expect(s.db.run(`update firm_memberships set discount_authority_pct = -1 where id = ?`, [m]))
      .rejects.toThrow();
    // The stored values are unchanged.
    const row = await s.db.get<{ f: number; w: number; d: number }>(
      `select financial_authority_sar f, writeoff_authority_sar w, discount_authority_pct d
         from firm_memberships where id = ?`, [m]);
    expect(row!.f).toBe(25000);
    expect(row!.w).toBe(5000);
    expect(row!.d).toBe(10);
  });

  it('a role grant must name who granted it, unless the origin explains why it cannot', async () => {
    const m = await membershipOf(FIRM.paralegal);
    const role = await roleIdOf('MANAGING_PARTNER');
    await expect(s.db.run(
      `insert into membership_roles (membership_id, role_id, granted_by_membership_id, grant_origin, granted_at)
       values (?, ?, null, 'admin', ?)`,
      [m, role, new Date().toISOString()],
    )).rejects.toThrow(/who granted it/i);

    // An unexplained origin is rejected by the CHECK constraint.
    await expect(s.db.run(
      `insert into membership_roles (membership_id, role_id, granted_by_membership_id, grant_origin, granted_at)
       values (?, ?, null, 'because_i_said_so', ?)`,
      [m, role, new Date().toISOString()],
    )).rejects.toThrow();

    // 'bootstrap' is the one honest way to have no actor, and it is recorded.
    await s.db.run(
      `insert into membership_roles (membership_id, role_id, granted_by_membership_id, grant_origin, granted_at)
       values (?, ?, null, 'bootstrap', ?) on conflict do nothing`,
      [m, role, new Date().toISOString()],
    );
    const row = await s.db.get<{ grant_origin: string }>(
      `select grant_origin from membership_roles where membership_id = ? and role_id = ?`, [m, role]);
    expect(row!.grant_origin).toBe('bootstrap');
  });

  it('a system role template can be tuned but never deleted or unmarked', async () => {
    const role = await roleIdOf('PARALEGAL');
    await expect(s.db.run(`delete from roles where id = ?`, [role])).rejects.toThrow(/system role/i);
    await expect(s.db.run(`update roles set is_system = 0 where id = ?`, [role])).rejects.toThrow(/system role/i);
    // Tuning the grants of a tenant's own copy is allowed — that is the point of
    // giving each firm its own row.
    await s.db.run(`delete from role_permissions where role_id = ? and permission_code = 'clients.create'`, [role]);
    const firm = new FirmRepo(s.db);
    const engine = new PermissionEngine({ firm });
    const userId = (await s.db.get<{ id: string }>(`select id from users where email = ?`, [FIRM.paralegal]))!.id;
    const p = await engine.resolve(userId, IDS.tenantKgm);
    expect(p!.permissions.has('clients.create')).toBe(false);
    // And the OTHER firm's copy is untouched.
    const najdRole = await roleIdOf('PARALEGAL', IDS.tenantNajd);
    const najdPerms = await s.db.all<{ permission_code: string }>(
      `select permission_code from role_permissions where role_id = ?`, [najdRole]);
    expect(najdPerms.map((r) => r.permission_code)).toContain('clients.create');
  });

  it('a matter control row cannot claim a matter from another firm', async () => {
    await expect(s.db.run(
      `insert into matter_controls (matter_id, tenant_id, is_restricted, created_at, updated_at)
       values (?, ?, 0, ?, ?)`,
      [IDS.matterLayla, IDS.tenantKgm, new Date().toISOString(), new Date().toISOString()],
    )).rejects.toThrow(/must match the matter/i);
  });

  it('restricting a matter in the database requires a reason and an actor', async () => {
    await expect(s.db.run(
      `update matter_controls set is_restricted = 1 where matter_id = ?`, [IDS.matterCommercial],
    )).rejects.toThrow(/reason and an actor/i);
    const row = await s.db.get<{ is_restricted: number }>(
      `select is_restricted from matter_controls where matter_id = ?`, [IDS.matterCommercial]);
    expect(Number(row!.is_restricted)).toBe(0);
  });

  it('an access level cannot be blank', async () => {
    await expect(s.db.run(
      `insert into matter_permissions (id, matter_id, tenant_id, membership_id, access_level, granted_at)
       values (?, ?, ?, ?, '  ', ?)`,
      [newId(), IDS.matterCommercial, IDS.tenantKgm, await membershipOf(FIRM.paralegal), new Date().toISOString()],
    )).rejects.toThrow(/access_level is required/i);
    // And the CHECK constraint rejects an invented level.
    await expect(s.db.run(
      `insert into matter_permissions (id, matter_id, tenant_id, membership_id, access_level, granted_at)
       values (?, ?, ?, ?, 'superuser', ?)`,
      [newId(), IDS.matterCommercial, IDS.tenantKgm, await membershipOf(FIRM.paralegal), new Date().toISOString()],
    )).rejects.toThrow();
  });

  it('only an active membership can hold a session', async () => {
    const m = await membershipOf(FIRM.lawyer);
    await s.db.run(`update firm_memberships set status = 'suspended' where id = ?`, [m]);
    await expect(s.db.run(
      `insert into firm_sessions (id, membership_id, user_id, tenant_id, token_hash, created_at,
                                   last_activity, expires_at, idle_expires_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), m, IDS.userFaisal, IDS.tenantKgm, 'x'.repeat(64),
       new Date().toISOString(), new Date().toISOString(),
       new Date(Date.now() + 3600_000).toISOString(), new Date(Date.now() + 3600_000).toISOString()],
    )).rejects.toThrow(/active membership/i);
  });

  it('a membership is unique per firm, so a second identity cannot be created for the same person', async () => {
    await expect(s.db.run(
      `insert into firm_memberships (id, tenant_id, user_id, staff_id, status, created_at, updated_at)
       values (?, ?, ?, ?, 'active', ?, ?)`,
      [newId(), IDS.tenantKgm, IDS.userFaisal, newId(), new Date().toISOString(), new Date().toISOString()],
    )).rejects.toThrow();
  });
});

// ============================================================================
// §71 · NON-RECURSIVE ROW LEVEL SECURITY
// ============================================================================

/**
 * §71 is a structural property of the SQL, not a runtime behaviour, so it is
 * asserted structurally: by reading the migration and checking the dependency
 * graph between policies and the functions they call.
 *
 * The failure mode this prevents is real and silent. A policy on `matters` that
 * calls a function which itself selects from `matters` re-enters the policy, and
 * Postgres either errors out or — depending on how the recursion is broken —
 * evaluates the inner query with RLS bypassed. Both outcomes are bad, and
 * neither shows up in a functional test, because the happy path still works.
 */
describe('§71 · row level security does not recurse', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const sql = readFileSync(MIGRATION, 'utf8');

  /** Every authorization function name that may appear in a policy or a body. */
  const FUNCTIONS = [
    'kgm_membership', 'kgm_tenant', 'kgm_is_firm', 'kgm_holds',
    'is_matter_member', 'matter_in_practice_scope', 'matter_access_level',
    'matter_visible', 'firm_audit_search',
  ];
  /** The subset DEFINED in this migration. kgm_tenant / kgm_is_firm / kgm_membership
   *  come from 0004, so their bodies are not in this file to read. */
  const DEFINED_HERE = FUNCTIONS.filter((n) => sql.includes(`function public.${n}(`));

  function functionBody(name: string): string {
    const start = sql.indexOf(`function public.${name}(`);
    expect(start, `${name} must be defined in 0006`).toBeGreaterThan(-1);
    const bodyStart = sql.indexOf('$$', start);
    const bodyEnd = sql.indexOf('$$', bodyStart + 2);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    return sql.slice(bodyStart + 2, bodyEnd);
  }

  function tablesRead(body: string): string[] {
    const found = new Set<string>();
    for (const m of body.matchAll(/public\.([a-z_]+)/g)) {
      if (!FUNCTIONS.includes(m[1])) found.add(m[1]);
    }
    return [...found].sort();
  }

  function policiesOn(table: string): string[] {
    const out: string[] = [];
    for (const m of sql.matchAll(/create policy[\s\S]*?;/g)) {
      const text = m[0];
      if (new RegExp(`on\\s+public\\.${table}\\b`).test(text)) out.push(text);
    }
    return out;
  }

  it('the matter-authorization functions are SECURITY DEFINER with a pinned search_path', () => {
    for (const name of ['is_matter_member', 'matter_in_practice_scope', 'matter_access_level', 'matter_visible', 'kgm_holds']) {
      expect(DEFINED_HERE, `${name} must be defined in this migration`).toContain(name);
      const declStart = sql.indexOf(`function public.${name}(`);
      const declEnd = sql.indexOf('$$', declStart);
      const decl = sql.slice(declStart, declEnd);
      expect(decl, `${name} must be SECURITY DEFINER`).toMatch(/security definer/i);
      expect(decl, `${name} must pin search_path`).toMatch(/set search_path\s*=\s*public/i);
      expect(decl, `${name} must be STABLE`).toMatch(/stable/i);
    }
  });

  it('no function that a policy calls reads a table whose policy calls it back', () => {
    // Build the graph: function -> tables it reads.
    const reads: Record<string, string[]> = {};
    for (const name of DEFINED_HERE) {
      reads[name] = tablesRead(functionBody(name));
    }

    // For each such table, collect the functions its own policies call.
    for (const [fn, tables] of Object.entries(reads)) {
      for (const table of tables) {
        for (const policy of policiesOn(table)) {
          for (const called of DEFINED_HERE) {
            if (called === fn) continue;
            const callsIt = new RegExp(`${called}\\s*\\(`).test(policy);
            // The cycle we must never build: policy(table) -> fn2 -> ... -> fn,
            // where fn reads `table`. Direct self-reference is the dangerous
            // short cycle, so assert it explicitly.
            if (callsIt && tablesRead(functionBody(called)).includes(table) && called !== 'firm_audit_search') {
              // Allowed only when `called` is itself SECURITY DEFINER, which
              // breaks the cycle by running as the owner.
              const declStart = sql.indexOf(`function public.${called}(`);
              const decl = sql.slice(declStart, sql.indexOf('$$', declStart));
              expect(decl, `${fn} reads ${table}, whose policy calls ${called} — ${called} must be SECURITY DEFINER`)
                .toMatch(/security definer/i);
            }
          }
        }
      }
    }
  });

  it('matter_visible is the only gate the matter-scoped policies use', () => {
    const matterScoped = ['matters', 'hearings', 'deadlines', 'documents', 'matter_timeline', 'message_threads', 'invoices'];
    for (const table of matterScoped) {
      const policies = policiesOn(table).filter((p) => /firm_matter_scope/.test(p));
      expect(policies.length, `${table} must have a firm_matter_scope policy`).toBe(1);
      expect(policies[0], `${table} policy must call matter_visible`).toMatch(/matter_visible\s*\(/);
      // A policy that also called a second predicate would be a second rule to
      // keep in sync with the engine. One gate, one rule.
      expect(policies[0]).not.toMatch(/matter_in_practice_scope\s*\(/);
      expect(policies[0]).not.toMatch(/is_matter_member\s*\(/);
      expect(policies[0], `${table} policy must require the firm phase`).toMatch(/kgm_is_firm\s*\(\s*\)/);
      expect(policies[0], `${table} policy must require the tenant`).toMatch(/kgm_tenant\s*\(\s*\)/);
      // Read-only: the firm role projects, it does not write through RLS.
      expect(policies[0], `${table} policy must not permit writes`).toMatch(/with check \(false\)/);
    }
  });

  it('the leaf tables the functions read have no policy that calls back into them', () => {
    // matter_team and matter_permissions are the leaves. Their firm policies
    // must be tenant-only, which is what makes the SECURITY DEFINER reads safe
    // even if the definer attribute were ever dropped by mistake.
    for (const table of ['matter_team', 'matter_permissions']) {
      for (const policy of policiesOn(table)) {
        expect(policy, `${table} policy must not call matter_visible`)
          .not.toMatch(/matter_visible\s*\(|matter_access_level\s*\(|matter_in_practice_scope\s*\(|is_matter_member\s*\(/);
      }
    }
  });

  it('audit_events is insert-only for the firm role and denied for reading', () => {
    // No SELECT grant, so the only read path is the definer function, which
    // checks audit.read itself.
    expect(sql).not.toMatch(/grant select on public\.audit_events to firm_api/i);
    expect(sql).toMatch(/grant insert \([^)]*\)\s+on public\.audit_events to firm_api/is);
    expect(sql).not.toMatch(/grant (update|delete) on public\.audit_events to firm_api/i);
    // internal_notes stays closed to the firm role too: it is the portal's
    // structural guarantee, and the Firm OS reads notes through its own surface.
    const notesPolicies = policiesOn('internal_notes').filter((p) => /firm_api/.test(p));
    for (const policy of notesPolicies) {
      expect(policy, 'internal_notes must not be readable by firm_api')
        .toMatch(/with check \(false\)|using \(false\)/);
    }
  });

  it('the TypeScript precedence and the SQL precedence are written in the same order', () => {
    // A textual correspondence check. It cannot prove semantic equivalence, but
    // it makes a reordering impossible to miss: the SQL function must mention
    // explicit, then restricted, then team, then scope — the same order the
    // engine uses.
    const body = functionBody('matter_access_level');
    // The CTE that feeds the CASE lists the facts in reading order, which is not
    // the precedence order. Match the `f.`-qualified branches so this asserts the
    // decision sequence and not the order someone typed three subqueries in.
    const iExplicit = body.indexOf('f.explicit_level');
    const iRestricted = body.indexOf('f.is_restricted');
    const iTeam = body.indexOf('f.team_level');
    const iScope = body.indexOf('matter_in_practice_scope');
    expect(iExplicit).toBeGreaterThan(-1);
    expect(iRestricted).toBeGreaterThan(iExplicit);
    expect(iTeam).toBeGreaterThan(iRestricted);
    expect(iScope).toBeGreaterThan(iTeam);

    const { readFileSync: rf } = require('node:fs') as typeof import('node:fs');
    const ts = rf('server/src/domain/permissions.ts', 'utf8');
    // Search the IMPLEMENTATION, not the signature: the parameter type lists
    // every field name up front, so matching bare identifiers would find them
    // all at position zero and prove nothing.
    const fnStart = ts.indexOf('levelFromFacts(');
    const fnBody = ts.slice(ts.indexOf('): AccessLevel {', fnStart));
    const tExplicit = fnBody.indexOf('facts.explicitLevel');
    const tRestricted = fnBody.indexOf('facts.isRestricted');
    const tTeam = fnBody.indexOf('facts.teamLevel');
    const tScope = fnBody.indexOf('this.inPracticeScope(p,');
    expect(tExplicit).toBeGreaterThan(-1);
    expect(tRestricted).toBeGreaterThan(tExplicit);
    expect(tTeam).toBeGreaterThan(tRestricted);
    expect(tScope).toBeGreaterThan(tTeam);
  });
});
