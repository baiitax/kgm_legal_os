/**
 * §45 AUTHORIZATION · §35 SECURITY RULES 1–9 · §11 PROJECTION
 *
 * The core claim under test: a client can reach exactly the data the firm has
 * linked to their authenticated identity, and nothing else — not another
 * client's matters, not another tenant's, and never the firm's internal work
 * product.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootStack, loginAs, createAgent, type Stack } from '../helpers.js';
import { IDS } from '../../server/src/db/demo-data.js';

let s: Stack;
beforeEach(async () => { s = await bootStack(); });
afterEach(async () => { await s.shutdown(); });

const AHMED = 'ahmed.alsaud@example.test';
const GULF = 'finance@gulfhorizon.example.test';
const LAYLA = 'layla.mansour@example.test';

/** Text that exists in the seed but must never reach a client response. */
const INTERNAL_SECRETS = [
  'partner to approve settlement posture',
  'awaiting conflict clearance',
  'conflict check in progress',
  'highly confidential',
  'do not disclose the settlement floor',
  'INTERNAL FLAG',
  'paralegal to file before Friday',
  'awaiting partner sign-off',
  'INTERNAL: ',
];

async function allClientEndpoints(agent: ReturnType<typeof createAgent>) {
  const urls = [
    '/api/client/dashboard', '/api/client/matters', '/api/client/hearings',
    '/api/client/deadlines', '/api/client/documents', '/api/client/invoices',
    '/api/client/receipts', '/api/client/messages', '/api/client/appointments',
    '/api/client/notifications', '/api/client/profile', '/api/client/security',
    '/api/client/privacy', '/api/client/notification-preferences',
    `/api/client/matters/${IDS.matterCommercial}`,
    `/api/client/matters/${IDS.matterGulf}`,
    `/api/client/matters/${IDS.matterLayla}`,
  ];
  const texts: string[] = [];
  for (const u of urls) {
    const r = await agent.get(u);
    texts.push(r.text);
  }
  return texts.join('\n');
}

describe('Rule 4 · a client cannot access another client\'s matter', () => {
  it('returns Ahmed only Ahmed\'s matters', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get('/api/client/matters');
    const ids = res.body.data.matters.map((m: any) => m.id);
    expect(ids.sort()).toEqual([IDS.matterCommercial, IDS.matterEmployment, IDS.matterRealEstate].sort());
    expect(ids).not.toContain(IDS.matterGulf);
    expect(ids).not.toContain(IDS.matterLayla);
  });

  it('returns 404 for another client\'s matter in the SAME tenant', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get(`/api/client/matters/${IDS.matterGulf}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns 404 for a matter in ANOTHER tenant', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get(`/api/client/matters/${IDS.matterLayla}`);
    expect(res.status).toBe(404);
  });

  it('makes "not yours" indistinguishable from "does not exist"', async () => {
    await loginAs(s.agent, AHMED);
    const notYours = await s.agent.get(`/api/client/matters/${IDS.matterGulf}`);
    const notReal = await s.agent.get('/api/client/matters/eeeeeeee-1111-4111-8111-111111111111');
    expect(notYours.status).toBe(notReal.status);
    expect(notYours.body).toEqual(notReal.body);
  });

  it('records an AUTHZ_DENIED audit event for the cross-client attempt', async () => {
    await loginAs(s.agent, AHMED);
    await s.agent.get(`/api/client/matters/${IDS.matterGulf}`);
    const rows = await s.db.all<any>(
      `select action, outcome, reason_code, resource_type, resource_id from audit_events
        where action = 'AUTHZ_DENIED' order by id desc`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].outcome).toBe('denied');
    // The trail names the ENTITY that was probed, not just the URL, so an
    // incident report can say which matter was targeted.
    expect(rows[0].resource_type).toBe('matter');
    expect(rows[0].resource_id).toBe(IDS.matterGulf);
  });
});

describe('Rule 1/2/3 · tenant, role and client identity are server-resolved', () => {
  it('a Gulf session sees Gulf data and cannot see Ahmed data', async () => {
    const gulf = createAgent(s.app);
    await loginAs(gulf, GULF);
    const res = await gulf.get('/api/client/matters');
    const ids = res.body.data.matters.map((m: any) => m.id);
    expect(ids).toEqual([IDS.matterGulf]);

    expect((await gulf.get(`/api/client/matters/${IDS.matterCommercial}`)).status).toBe(404);
  });

  it('a Najd (other tenant) session is confined to its own tenant', async () => {
    const layla = createAgent(s.app);
    await loginAs(layla, LAYLA);
    const me = await layla.get('/api/auth/session');
    expect(me.body.data.user.email).toBe(LAYLA);
    // No raw tenant or client identifiers are published to the browser at all.
    expect(me.text).not.toContain(IDS.tenantNajd);
    expect(me.text).not.toContain(IDS.clientLayla);
    expect(me.body.data.tenantId).toBeUndefined();
    expect(me.body.data.clientIds).toBeUndefined();

    const matters = await layla.get('/api/client/matters');
    expect(matters.body.data.matters.map((m: any) => m.id)).toEqual([IDS.matterLayla]);

    // Reach into the other tenant by id.
    expect((await layla.get(`/api/client/matters/${IDS.matterCommercial}`)).status).toBe(404);
    expect((await layla.get(`/api/client/matters/${IDS.matterGulf}`)).status).toBe(404);
  });

  it('cannot switch tenant or client by supplying identifiers in a request', async () => {
    await loginAs(s.agent, AHMED);
    const attempts = [
      ['get', `/api/client/matters?tenant_id=${IDS.tenantNajd}`],
      ['get', `/api/client/matters?client_id=${IDS.clientGulf}`],
      ['get', `/api/client/invoices?client_id=${IDS.clientGulf}`],
      ['get', `/api/client/documents?client_id=${IDS.clientGulf}`],
      ['get', `/api/client/dashboard?tenant_id=${IDS.tenantNajd}`],
    ] as const;

    for (const [, url] of attempts) {
      const res = await s.agent.get(url);
      expect(res.status).toBe(200);
      const text = res.text;
      // Whatever the query string says, the response must contain no Gulf data.
      expect(text).not.toContain(IDS.matterGulf);
      expect(text).not.toContain('Corporate Acquisition');
      expect(text).not.toContain('Share Purchase Agreement');
    }
  });

  it('exposes no role that could be echoed back for elevation', async () => {
    await loginAs(s.agent, AHMED);
    const me = await s.agent.get('/api/auth/session');
    const role = me.body.data.user.portalRole;
    expect(['client_primary', 'client_contact']).toContain(role);
    expect(JSON.stringify(me.body)).not.toMatch(/managing_partner|paralegal|compliance|internal_role|"admin"/);
    // The portal role is display-only: it grants nothing, and no internal role
    // or staff identifier is present to echo back.
    expect(me.text).not.toContain(IDS.tenantKgm);
    expect(me.text).not.toContain(IDS.clientAhmed);
  });
});

describe('Rule 5 · internal notes and firm work product are unreachable', () => {
  it('no client endpoint ever returns internal note content', async () => {
    for (const email of [AHMED, GULF, LAYLA]) {
      const agent = createAgent(s.app);
      await loginAs(agent, email);
      const blob = await allClientEndpoints(agent);
      for (const secret of INTERNAL_SECRETS) {
        expect(blob, `${email} leaked "${secret}"`).not.toContain(secret);
      }
    }
  });

  it('matter detail excludes internal status, risk rating and conflict data', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get(`/api/client/matters/${IDS.matterCommercial}`);
    expect(res.status).toBe(200);
    const m = res.body.data;

    // The client-safe lifecycle only.
    expect(m.status).toBe('hearings');
    expect(['opened', 'under_review', 'hearings', 'judgment', 'execution', 'closed']).toContain(m.status);
    for (const banned of ['internal_status', 'risk_rating', 'conflict_cleared', 'internal_notes', 'partner_review']) {
      expect(res.text).not.toContain(banned);
    }
  });

  it('hides internal-only staff while showing the client-facing team', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get(`/api/client/matters/${IDS.matterCommercial}`);
    const names = res.body.data.legalTeam.map((t: any) => t.name);
    expect(names).toContain('Faisal Al-Harbi');
    expect(names).toContain('Noura Al-Qahtani');
    // Compliance is ON the matter but is not client_visible.
    expect(names).not.toContain('Omar Al-Dossary');
    expect(res.text).not.toContain('Omar Al-Dossary');
    expect(res.text).not.toContain('Sara Al-Otaibi');
  });

  it('hides internal-only timeline events', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get(`/api/client/matters/${IDS.matterEmployment}`);
    const titles = res.body.data.timeline.map((t: any) => t.title);
    expect(titles).not.toContain('Internal review checkpoint');
    expect(titles).toContain('Matter opened');
  });

  it('excludes internal lawyer tasks from the deadline list', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get('/api/client/deadlines');
    const titles = res.body.data.deadlines.map((d: any) => d.title);
    expect(titles).toContain('Document submission');
    expect(titles).not.toContain('File memorandum of authority');
    for (const banned of ['assigned_staff_id', 'internal_comment', 'internal_task']) {
      expect(res.text).not.toContain(banned);
    }
  });

  it('cannot read internal notes through any URL shape', async () => {
    await loginAs(s.agent, AHMED);
    // Sub-resources that do not exist must 404, and must not leak.
    for (const url of [
      `/api/client/matters/${IDS.matterCommercial}/notes`,
      `/api/client/matters/${IDS.matterCommercial}/internal-notes`,
      '/api/client/internal-notes',
      '/api/client/notes',
    ]) {
      const res = await s.agent.get(url);
      expect(res.status, url).toBe(404);
      for (const secret of INTERNAL_SECRETS) expect(res.text).not.toContain(secret);
    }
  });

  it('cannot widen the projection with query parameters', async () => {
    // Unknown query parameters are IGNORED, not honoured — the projection is a
    // fixed field list chosen server-side, never negotiated by the caller. A
    // 200 is therefore correct here; what matters is that the response body is
    // byte-for-byte the same as the plain request.
    await loginAs(s.agent, AHMED);
    const base = `/api/client/matters/${IDS.matterCommercial}`;
    const clean = await s.agent.get(base);
    expect(clean.status).toBe(200);

    for (const qs of [
      '?include=internal_notes',
      '?fields=risk_rating,internal_notes,conflict_cleared',
      '?select=*',
      '?expand=internal_notes,timeline.internal',
      '?view=staff',
      '?debug=1',
      '?format=raw',
    ]) {
      const res = await s.agent.get(base + qs);
      expect(res.status, qs).toBe(200);
      expect(res.body.data, qs).toEqual(clean.body.data);
      for (const banned of ['internal_notes', 'risk_rating', 'conflict_cleared', 'internal_status']) {
        expect(res.text, `${qs} leaked ${banned}`).not.toContain(banned);
      }
    }
  });
});

describe('Rules 8/9 · staff management and compliance internals are absent', () => {
  it('every internal surface returns 404 to an authenticated client', async () => {
    await loginAs(s.agent, AHMED);
    const paths = [
      '/admin', '/compliance', '/billing/internal', '/settings/users', '/audit',
      '/internal-matters', '/firm-settings', '/staff', '/internal',
      '/api/internal/matters', '/api/admin/users', '/api/staff', '/api/audit',
      '/api/firm/settings', '/api/client/staff', '/api/client/audit',
      '/api/client/admin', '/api/client/internal', '/api/client/compliance',
    ];
    for (const p of paths) {
      const res = await s.agent.get(p);
      expect(res.status, p).toBe(404);
    }
  });

  it('audits each internal-route attempt', async () => {
    await loginAs(s.agent, AHMED);
    await s.agent.get('/admin');
    await s.agent.get('/audit');
    // The audit write is fired asynchronously by the denial middleware.
    await new Promise((r) => setTimeout(r, 120));
    const rows = await s.db.all<any>(
      `select resource_id from audit_events where action = 'INTERNAL_RESOURCE_ACCESS_ATTEMPT'`);
    const ids = rows.map((r) => r.resource_id);
    expect(ids).toContain('/admin');
    expect(ids).toContain('/audit');
  });
});

describe('Rule 12 · sensitive operations are audited', () => {
  it('records document, invoice and message events', async () => {
    await loginAs(s.agent, AHMED);
    const invoices = await s.agent.get('/api/client/invoices');
    const invoiceId = invoices.body.data.invoices[0].id;
    await s.agent.get(`/api/client/invoices/${invoiceId}`);

    const threads = await s.agent.get('/api/client/messages');
    const threadId = threads.body.data.threads[0].id;
    await s.agent.post(`/api/client/messages/${threadId}`, { body: 'Audit trail check.' });

    await new Promise((r) => setTimeout(r, 80));
    const actions = (await s.db.all<any>(`select action from audit_events`)).map((a) => a.action);
    expect(actions).toContain('INVOICE_VIEWED');
    expect(actions).toContain('MESSAGE_SENT');
    expect(actions).toContain('LOGIN');
  });

  it('writes audit rows that a client cannot read back, update or delete', async () => {
    await loginAs(s.agent, AHMED);
    // No portal endpoint exposes the trail.
    for (const url of ['/api/client/audit', '/api/client/audit-events', '/api/client/security/audit']) {
      expect((await s.agent.get(url)).status).toBe(404);
    }
    // And the table itself refuses mutation.
    await expect(s.db.run(`update audit_events set action = 'LOGIN' where id = 1`))
      .rejects.toThrow(/append-only/i);
    await expect(s.db.run(`delete from audit_events where id = 1`))
      .rejects.toThrow(/append-only/i);
  });
});

describe('unauthenticated access', () => {
  it('refuses every client endpoint without a session', async () => {
    const anon = createAgent(s.app);
    await anon.get('/api/auth/bootstrap');
    const urls = [
      '/api/client/dashboard', '/api/client/matters', '/api/client/hearings',
      '/api/client/deadlines', '/api/client/documents', '/api/client/invoices',
      '/api/client/messages', '/api/client/appointments', '/api/client/notifications',
      '/api/client/profile', '/api/client/security', '/api/client/privacy',
      `/api/client/matters/${IDS.matterCommercial}`,
    ];
    for (const u of urls) {
      const res = await anon.get(u);
      expect(res.status, u).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    }
  });

  it('refuses a forged session cookie', async () => {
    const anon = createAgent(s.app);
    anon.cookies.set('kgm_portal_session', 'forged-session-token-value-that-does-not-exist');
    const res = await anon.get('/api/client/dashboard');
    expect(res.status).toBe(401);
  });

  it('refuses a session token whose row has been deleted', async () => {
    await loginAs(s.agent, AHMED);
    await s.db.run(`delete from client_sessions`);
    expect((await s.agent.get('/api/client/dashboard')).status).toBe(401);
  });
});
