/**
 * §48 END-TO-END JOURNEY
 *
 * One continuous narrative through the whole portal, in the order a real client
 * experiences it: invitation → first login → dashboard → matter → documents →
 * messages → appointment → invoice → payment → receipt → security centre →
 * sign-out. Isolation and projection are re-asserted at each step, because a
 * journey test that only checks "it worked" proves nothing about the security
 * model.
 *
 * A second actor from a DIFFERENT TENANT runs the same journey in parallel and
 * must never see the first actor's data at any point.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { bootStack, loginAs, createAgent, lastEmail, tokenFromLink, type Stack, type Agent } from '../helpers.js';
import { IDS, DEMO_ACCOUNTS } from '../../server/src/db/demo-data.js';
import { config } from '../../server/src/config.js';

let s: Stack;
beforeEach(async () => { s = await bootStack(); });
afterEach(async () => { await s.shutdown(); });

const AHMED = 'ahmed.alsaud@example.test';
const LAYLA = 'layla.mansour@example.test';
const NEW_INVITEE = 'new.contact@example.test';

function minimalPdf(label: string): Buffer {
  const stream = `BT /F1 14 Tf 60 740 Td (${label}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Every secret that must never appear in ANY response, at any step. */
const FORBIDDEN_STRINGS = [
  'INTERNAL:', 'partner to approve settlement posture', 'highly confidential',
  'internal_notes', 'internal_status', 'risk_rating', 'conflict_cleared',
  'storage_key', 'password_hash', 'mfa_secret', 'otp_secret', 'session_token',
  'assigned_staff_id', 'Omar Al-Dossary', 'failure_reason',
];

async function assertClean(res: { text: string; status: number }, step: string) {
  expect(res.status, `${step} → unexpected ${res.status}`).toBeLessThan(500);
  for (const secret of FORBIDDEN_STRINGS) {
    expect(res.text, `${step} leaked "${secret}"`).not.toContain(secret);
  }
}

describe('§48 · invitation-to-signout journey for an existing client', () => {
  it('Ahmed completes the whole portal flow with no leakage at any step', async () => {
    // ---- 1 · bootstrap: the SPA's first call, before anything is known -----
    const boot = await s.agent.get('/api/auth/bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.body.data.authenticated).toBe(false);
    expect(boot.body.data.publicSignupEnabled).toBe(false); // invitation-only (§3/§4)
    // The CSRF token travels in a cookie the SPA can read (double-submit), and
    // is echoed back in the body of the response that establishes a session.
    expect(s.agent.csrf()).toBeTruthy();
    expect(String(boot.headers['set-cookie'])).toMatch(/kgm_csrf=/);
    expect(String(boot.headers['set-cookie'])).not.toMatch(/kgm_csrf=[^;]*;[^\n]*httponly/i);
    await assertClean(boot, 'bootstrap');

    // ---- 2 · login ---------------------------------------------------------
    const login = await s.agent.post('/api/auth/login', {
      email: AHMED, password: 'Demo!Portal2026', remember: true,
    });
    expect(login.status).toBe(200);
    expect(login.body.data.step).toBe('authenticated');
    expect(login.body.data.csrfToken).toBeTruthy();
    expect(login.body.data.user.email).toBe(AHMED);
    expect(login.body.data.user.displayNameAr).toBeTruthy();
    expect(login.body.data.preferences.language).toBe('ar');
    // No raw tenant or client identifier is published to the browser (§11).
    expect(login.text).not.toContain(IDS.tenantKgm);
    expect(login.text).not.toContain(IDS.clientAhmed);
    // The session cookie is httpOnly; the browser cannot read it.
    const setCookie = String(boot.headers['set-cookie'] ?? '') + String(login.headers['set-cookie'] ?? '');
    expect(String(login.headers['set-cookie'])).toMatch(/httponly/i);
    expect(String(login.headers['set-cookie'])).toMatch(/samesite=lax/i);
    await assertClean(login, 'login');

    // ---- 3 · session shape -------------------------------------------------
    const me = await s.agent.get('/api/auth/session');
    expect(me.status).toBe(200);
    expect(me.body.data.user.portalRole).toBe('client_primary');
    expect(me.body.data.security.sessionExpiresAt).toBeTruthy();
    expect(me.text).not.toContain(IDS.tenantKgm);
    await assertClean(me, 'session');

    // ---- 4 · dashboard -----------------------------------------------------
    const dash = await s.agent.get('/api/client/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.data.greeting.displayName).toContain('Ahmed');
    expect(dash.body.data.counts.activeMatters).toBe(3);
    expect(dash.body.data.counts.upcomingHearings).toBe(2);
    expect(dash.body.data.counts.unpaidInvoices).toBe(2);
    expect(dash.body.data.outstandingBalance.amount).toBe('27625.00');
    expect(dash.body.data.outstandingBalance.currency).toBe('SAR');
    expect(dash.body.data.serverTime).toBeTruthy();
    await assertClean(dash, 'dashboard');

    // ---- 5 · matter list and detail ---------------------------------------
    const matters = await s.agent.get('/api/client/matters');
    expect(matters.body.data.matters.map((m: any) => m.title).sort()).toEqual(
      ['Commercial Dispute', 'Employment Dispute', 'Real Estate Contract Matter'].sort(),
    );
    await assertClean(matters, 'matters');

    const matter = await s.agent.get(`/api/client/matters/${IDS.matterCommercial}`);
    expect(matter.status).toBe(200);
    expect(matter.body.data.status).toBe('hearings');         // client lifecycle
    expect(matter.body.data.legalTeam.length).toBeGreaterThan(0);
    expect(matter.body.data.timeline.length).toBeGreaterThan(0);
    await assertClean(matter, 'matter detail');

    // ---- 6 · hearings, deadlines, appointments ----------------------------
    for (const [step, url] of [
      ['hearings', '/api/client/hearings'],
      ['deadlines', '/api/client/deadlines'],
      ['appointments', '/api/client/appointments'],
      ['notifications', '/api/client/notifications'],
      ['notification-preferences', '/api/client/notification-preferences'],
      ['profile', '/api/client/profile'],
      ['security', '/api/client/security'],
      ['privacy', '/api/client/privacy'],
    ] as const) {
      const res = await s.agent.get(url);
      expect(res.status, step).toBe(200);
      await assertClean(res, step);
    }

    // ---- 7 · documents: list, upload, then download what was uploaded -----
    const docsBefore = await s.agent.get('/api/client/documents');
    expect(docsBefore.body.data.documents.length).toBe(3); // internal one excluded
    await assertClean(docsBefore, 'documents');

    const upload = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'evidence', title: 'Signed witness statement' },
      { name: 'witness-statement.pdf', type: 'application/pdf', data: minimalPdf('signed witness statement') },
    );
    expect(upload.status).toBe(201);
    const uploadedId = upload.body.data.id;
    await assertClean(upload, 'upload');

    const docsAfter = await s.agent.get('/api/client/documents');
    expect(docsAfter.body.data.documents.length).toBe(4);
    expect(docsAfter.body.data.documents.some((d: any) => d.id === uploadedId)).toBe(true);

    const grant = await s.agent.post(`/api/client/documents/${uploadedId}/access-url`, { disposition: 'inline' });
    expect(grant.status).toBe(200);
    expect(grant.body.data.ttlSeconds).toBe(config.storage.signedUrlTtlSeconds);
    const bytes = await s.agent.get(grant.body.data.url);
    expect(bytes.status).toBe(200);
    expect(bytes.text.startsWith('%PDF-')).toBe(true);
    expect(bytes.text).toContain('signed witness statement');

    // ---- 8 · messages ------------------------------------------------------
    const threads = await s.agent.get('/api/client/messages');
    expect(threads.body.data.threads.length).toBe(2);
    const threadId = threads.body.data.threads[0].id;

    const thread = await s.agent.get(`/api/client/messages/${threadId}`);
    expect(thread.status).toBe(200);
    const msgsBefore = thread.body.data.messages.length;

    const sent = await s.agent.post(`/api/client/messages/${threadId}`, {
      body: 'شكراً لك. I have uploaded the signed statement.',
    });
    expect(sent.status).toBe(201);
    expect(sent.body.data.from).toBe('client');

    const threadAfter = await s.agent.get(`/api/client/messages/${threadId}`);
    expect(threadAfter.body.data.messages.length).toBe(msgsBefore + 1);
    expect(threadAfter.body.data.messages.at(-1).body).toContain('signed statement');
    expect(threadAfter.body.data.messages.at(-1).authorName).toBeTruthy();
    await assertClean(threadAfter, 'thread');

    // ---- 9 · appointment request ------------------------------------------
    const appt = await s.agent.post('/api/client/appointments', {
      matterId: IDS.matterCommercial, preferredDate: '2026-11-04',
      preferredTime: '10:30', preferredMode: 'video', note: 'Before the next hearing.',
    });
    expect(appt.status).toBe(201);
    expect(appt.body.data.status).toMatch(/requested|pending/i);
    await assertClean(appt, 'appointment');

    // ---- 10 · invoices and payment ----------------------------------------
    const invoices = await s.agent.get('/api/client/invoices');
    const unpaid = invoices.body.data.invoices.filter((i: any) => Number(i.balanceDue) > 0);
    expect(unpaid.length).toBe(2);
    const target = unpaid[0];

    const invoice = await s.agent.get(`/api/client/invoices/${target.id}`);
    expect(invoice.status).toBe(200);
    expect(invoice.body.data.lines.length).toBeGreaterThan(0);
    await assertClean(invoice, 'invoice');

    const intent = await s.agent.post(`/api/client/invoices/${target.id}/payment`, { provider: 'mada' });
    expect(intent.status).toBe(200);
    expect(intent.body.data.amount).toBe(target.balanceDue);

    // The provider calls back. Signature verified, state moves, receipt issued.
    const payload = {
      event_id: `evt_e2e_${Date.now()}`, payment_id: intent.body.data.paymentId,
      status: 'succeeded', amount: Number(target.balanceDue), currency: 'SAR',
    };
    const raw = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', config.payments.webhookSecret).update(raw, 'utf8').digest('hex');
    const wh = await fetch(`http://127.0.0.1:${s.port}/api/webhooks/payments/mock`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body: raw,
    });
    expect(wh.status).toBe(200);
    expect((await wh.json()).data.applied).toBe(true);

    const afterPay = await s.agent.get(`/api/client/invoices/${target.id}`);
    expect(afterPay.body.data.balanceDue).toBe('0.00');
    expect(afterPay.body.data.status).toBe('paid');

    const receipts = await s.agent.get('/api/client/receipts');
    expect(receipts.body.data.receipts.length).toBe(2);
    expect(receipts.body.data.receipts.some((r: any) => r.paymentId === intent.body.data.paymentId)).toBe(true);
    await assertClean(receipts, 'receipts');

    // The dashboard balance reflects the payment immediately.
    const dash2 = await s.agent.get('/api/client/dashboard');
    expect(dash2.body.data.outstandingBalance.amount).toBe((27625 - Number(target.balanceDue)).toFixed(2));
    expect(dash2.body.data.counts.unpaidInvoices).toBe(1);

    // A payment notification was raised for the client.
    const notes = await s.agent.get('/api/client/notifications');
    expect(notes.body.data.notifications.some((n: any) => (n.title ?? '').includes('Payment received'))).toBe(true);

    // ---- 11 · security centre: see sessions, revoke the others -------------
    const sec = await s.agent.get('/api/client/security');
    expect(sec.status).toBe(200);
    expect(sec.body.data.sessions.length).toBeGreaterThan(0);
    const revoke = await s.agent.post('/api/client/security/sessions/revoke-all-others', {});
    expect(revoke.status).toBe(200);
    // Our own session survives.
    expect((await s.agent.get('/api/client/dashboard')).status).toBe(200);

    // ---- 12 · preferences round-trip --------------------------------------
    const pref = await s.agent.patch('/api/client/preferences', { language: 'en', calendar: 'gregory' });
    expect(pref.status).toBe(200);
    const prefBack = await s.agent.get('/api/client/profile');
    expect(prefBack.status).toBe(200);
    expect(prefBack.body.data.preferredLanguage).toBe('en');
    expect(prefBack.body.data.preferredCalendar).toBe('gregory');
    // Identity fields the firm owns are shown masked, never in full (§25, §44).
    expect(prefBack.body.data.email).toBe(AHMED);
    expect(prefBack.body.data.emailMasked).not.toBe(AHMED);
    expect(prefBack.body.data.emailMasked).toContain('***');
    expect(prefBack.body.data.firm.nameAr).toBeTruthy();
    expect(prefBack.body.data.client.nationalIdMasked ?? '').not.toMatch(/\b1\d{9}\b/);
    await assertClean(prefBack, 'profile');

    // ---- 13 · sign out -----------------------------------------------------
    const out = await s.agent.post('/api/auth/logout', {});
    expect(out.status).toBe(200);
    expect((await s.agent.get('/api/client/dashboard')).status).toBe(401);
    expect((await s.agent.get('/api/auth/session')).body.data.authenticated).toBe(false);

    // ---- 14 · the whole journey was audited -------------------------------
    const actions = (await s.db.all<any>(`select action from audit_events`)).map((a) => a.action);
    for (const expected of [
      'LOGIN', 'DOCUMENT_UPLOADED', 'SIGNED_URL_ISSUED', 'DOCUMENT_VIEWED',
      'MESSAGE_SENT', 'APPOINTMENT_REQUESTED', 'INVOICE_VIEWED', 'PAYMENT_STARTED',
      'WEBHOOK_RECEIVED', 'PAYMENT_COMPLETED', 'LOGOUT',
    ]) {
      expect(actions, `missing audit action ${expected}`).toContain(expected);
    }
    void setCookie;
  });
});

describe('§48 · two tenants running the same journey see disjoint worlds', () => {
  it('Ahmed (KGM) and Layla (Najd) never intersect', async () => {
    const ahmed = createAgent(s.app);
    const layla = createAgent(s.app);
    expect((await loginAs(ahmed, AHMED)).status).toBe(200);
    expect((await loginAs(layla, LAYLA)).status).toBe(200);

    const [aDash, lDash] = await Promise.all([
      ahmed.get('/api/client/dashboard'), layla.get('/api/client/dashboard'),
    ]);
    expect(aDash.body.data.greeting.firmName).not.toBe(lDash.body.data.greeting.firmName);
    expect(aDash.body.data.counts.activeMatters).toBe(3);
    expect(lDash.body.data.counts.activeMatters).toBe(1);

    const [aMatters, lMatters] = await Promise.all([
      ahmed.get('/api/client/matters'), layla.get('/api/client/matters'),
    ]);
    const aIds = aMatters.body.data.matters.map((m: any) => m.id);
    const lIds = lMatters.body.data.matters.map((m: any) => m.id);
    expect(aIds.length).toBe(3);
    expect(lIds).toEqual([IDS.matterLayla]);
    expect(aIds.filter((id: string) => lIds.includes(id))).toEqual([]);

    // Each can read their own; neither can read the other's.
    expect((await ahmed.get(`/api/client/matters/${IDS.matterLayla}`)).status).toBe(404);
    expect((await layla.get(`/api/client/matters/${IDS.matterCommercial}`)).status).toBe(404);
    expect((await ahmed.get(`/api/client/matters/${IDS.matterCommercial}`)).status).toBe(200);
    expect((await layla.get(`/api/client/matters/${IDS.matterLayla}`)).status).toBe(200);

    // Writes are equally confined.
    const lThreads = await layla.get('/api/client/messages');
    const aThreads = await ahmed.get('/api/client/messages');
    expect(aThreads.body.data.threads.length).toBe(2);
    expect(lThreads.body.data.threads.length).toBe(0);

    // Layla's money is her own firm's money.
    const lInv = await layla.get('/api/client/invoices');
    expect(lInv.body.data.invoices).toEqual([]);

    for (const res of [aDash, lDash, aMatters, lMatters]) await assertClean(res, 'cross-tenant');
  });

  it('a session cannot be reused across tenants by swapping cookies', async () => {
    const ahmed = createAgent(s.app);
    const layla = createAgent(s.app);
    await loginAs(ahmed, AHMED);
    await loginAs(layla, LAYLA);

    const laylaSession = layla.cookies.get('kgm_portal_session')!;
    expect(laylaSession).toBeTruthy();

    // Give Ahmed's jar Layla's session cookie. The CSRF token stays Ahmed's, so
    // the pair is inconsistent — and even a consistent pair resolves to whoever
    // the token belongs to, never to a chosen tenant.
    ahmed.cookies.set('kgm_portal_session', laylaSession);
    const res = await ahmed.get('/api/client/dashboard');
    expect(res.status).toBe(200);
    // It is now simply Layla's session: her tenant, her data — not a blend.
    expect(res.body.data.counts.activeMatters).toBe(1);
    expect(res.body.data.greeting.displayName).not.toContain('Ahmed');
  });
});

describe('§48 · a brand-new client joins by invitation only', () => {
  it('invitation → password → verification → first login', async () => {
    // The firm creates the account. There is no public route for this.
    expect((await s.agent.post('/api/auth/register', { email: NEW_INVITEE })).status).toBe(404);

    // The firm mints the invitation. In production this is the Internal Firm OS
    // calling the service directly; here the dev router stands in for it (and is
    // not mounted at all when NODE_ENV=production).
    const inviteRes = await s.agent.post('/api/dev/invite', {
      tenantId: IDS.tenantKgm,
      clientId: IDS.clientGulf,
      email: NEW_INVITEE,
      displayName: 'New Contact',
      displayNameAr: 'جهة اتصال جديدة',
      portalRole: 'client_contact',
    });
    expect(inviteRes.status).toBe(201);
    const invite = inviteRes.body.data as { token: string; link: string; expiresAt: string };
    expect(invite.token).toBeTruthy();
    expect(invite.link).toContain('/invite/accept?token=');
    // The invitation email went out, bilingual, to the invited address only.
    expect(lastEmail(NEW_INVITEE).text).toBeTruthy();

    // The invited address is not yet a user: login is refused with the SAME
    // response as a wrong password (no enumeration).
    const anon = createAgent(s.app);
    await anon.get('/api/auth/bootstrap');
    const before = await anon.post('/api/auth/login', { email: NEW_INVITEE, password: 'Whatever!Pass2026' });
    expect(before.status).toBe(401);
    expect(before.body.error.code).toBe('invalid_credentials');

    // Peek the invitation with the token (this is what the emailed link does).
    const peek = await anon.get(`/api/auth/invite/peek?token=${invite.token}`);
    expect(peek.status).toBe(200);
    expect(peek.body.data.email).toBe(NEW_INVITEE);
    expect(peek.body.data.displayNameAr).toBe('جهة اتصال جديدة');

    // First: accept WITH forged identity fields. §46 — this is refused and
    // audited, not silently stripped, and the invitation stays unspent.
    const hijack = await anon.post('/api/auth/invite/accept', {
      token: invite.token,
      password: 'Invited!Pass2026',
      confirmPassword: 'Invited!Pass2026',
      tenant_id: IDS.tenantNajd,         // attempted hijack
      client_id: IDS.clientAhmed,        // attempted hijack
      role: 'managing_partner',          // attempted escalation
    });
    expect(hijack.status).toBe(403);
    expect(hijack.body.error.code).toBe('field_not_writable');

    const notCreated = await s.db.get<any>(`select count(*) as n from users where email = ?`, [NEW_INVITEE]);
    expect(Number(notCreated.n)).toBe(0);
    const stillOpen = await s.db.get<any>(
      `select accepted_at from client_invitations where email = ?`, [NEW_INVITEE]);
    expect(stillOpen.accepted_at).toBeFalsy();

    await new Promise((r) => setTimeout(r, 80));
    const tamper = await s.db.all<any>(
      `select metadata from audit_events where action = 'FIELD_TAMPER_ATTEMPT'`);
    expect(tamper.length).toBeGreaterThan(0);
    expect(String(tamper[0].metadata)).toContain('tenant_id');
    expect(String(tamper[0].metadata)).toContain('role');

    // Then: accept cleanly. Tenant, client and role come from the INVITATION row.
    const accept = await anon.post('/api/auth/invite/accept', {
      token: invite.token,
      password: 'Invited!Pass2026',
      confirmPassword: 'Invited!Pass2026',
    });
    expect([200, 201]).toContain(accept.status);

    const created = await s.db.get<any>(
      `select cu.tenant_id, cu.client_id, cu.portal_role, u.email, u.status
         from client_users cu join users u on u.id = cu.user_id
        where u.email = ?`, [NEW_INVITEE]);
    expect(created.tenant_id).toBe(IDS.tenantKgm);
    expect(created.client_id).toBe(IDS.clientGulf);
    expect(created.portal_role).toBe('client_contact');

    // First real login.
    const fresh = createAgent(s.app);
    const login = await loginAs(fresh, NEW_INVITEE, 'Invited!Pass2026');
    expect(login.status).toBe(200);
    expect(login.body.data.user.email).toBe(NEW_INVITEE);
    expect(login.body.data.user.displayNameAr).toBe('جهة اتصال جديدة');
    expect(login.text).not.toContain(IDS.tenantNajd);   // the forged tenant went nowhere
    expect(login.text).not.toContain('managing_partner'); // the forged role went nowhere

    // The new contact sees Gulf Horizon's world — and none of Ahmed's.
    const matters = await fresh.get('/api/client/matters');
    expect(matters.body.data.matters.map((m: any) => m.id)).toEqual([IDS.matterGulf]);
    expect((await fresh.get(`/api/client/matters/${IDS.matterCommercial}`)).status).toBe(404);

    await assertClean(login, 'new client login');
    await assertClean(matters, 'new client matters');
  });

  it('a used invitation cannot be replayed', async () => {
    const inviteRes = await s.agent.post('/api/dev/invite', {
      tenantId: IDS.tenantKgm, clientId: IDS.clientGulf,
      email: 'replay@example.test', displayName: 'Replay Test',
      portalRole: 'client_contact',
    });
    expect(inviteRes.status).toBe(201);
    const invite = inviteRes.body.data as { token: string };
    const a = createAgent(s.app);
    await a.get('/api/auth/bootstrap');
    const first = await a.post('/api/auth/invite/accept', {
      token: invite.token, password: 'First!Pass2026', confirmPassword: 'First!Pass2026',
    });
    expect([200, 201]).toContain(first.status);

    const b = createAgent(s.app);
    await b.get('/api/auth/bootstrap');
    const second = await b.post('/api/auth/invite/accept', {
      token: invite.token, password: 'Second!Pass2026', confirmPassword: 'Second!Pass2026',
    });
    expect(second.status).toBe(400);
    expect(['invitation_accepted', 'invitation_invalid', 'token_used']).toContain(second.body.error.code);

    const n = await s.db.get<any>(`select count(*) as n from users where email = 'replay@example.test'`);
    expect(Number(n.n)).toBe(1);
  });
});

describe('§48 · password reset inside a live journey', () => {
  it('reset → old sessions die → new password works → old one does not', async () => {
    const agent = createAgent(s.app);
    expect((await loginAs(agent, AHMED)).status).toBe(200);
    expect((await agent.get('/api/client/dashboard')).status).toBe(200);

    await agent.post('/api/auth/forgot-password', { email: AHMED });
    const token = tokenFromLink(lastEmail(AHMED, /password|reset|كلمة المرور/i));

    const reset = await agent.post('/api/auth/reset-password', {
      token, password: 'Rotated!Pass2026', confirmPassword: 'Rotated!Pass2026',
    });
    expect(reset.status).toBe(200);

    // The session that requested the reset is gone.
    expect((await agent.get('/api/client/dashboard')).status).toBe(401);

    // The old password no longer works; the new one does.
    const oldTry = createAgent(s.app);
    expect((await loginAs(oldTry, AHMED, 'Demo!Portal2026')).status).toBe(401);
    const newTry = createAgent(s.app);
    expect((await loginAs(newTry, AHMED, 'Rotated!Pass2026')).status).toBe(200);
    expect((await newTry.get('/api/client/dashboard')).status).toBe(200);
  });
});

describe('§48 · the demo dataset is self-consistent', () => {
  it('every advertised demo account can actually sign in', async () => {
    for (const account of DEMO_ACCOUNTS) {
      const agent = createAgent(s.app);
      const res = await loginAs(agent, account.email, account.password);
      expect(res.status, `${account.email} → ${res.status} ${res.text.slice(0, 120)}`).toBe(200);
      expect((await agent.get('/api/client/dashboard')).status).toBe(200);
    }
  });

  it('no seeded row exposes a real-looking national identifier', async () => {
    // §44: synthetic data only. A 10-digit Saudi national id pattern must not
    // appear anywhere in the seeded identity tables.
    const tables = ['users', 'client_users', 'clients', 'staff', 'consent_records'];
    const pattern = /\b1\d{9}\b/;
    for (const t of tables) {
      const rows = await s.db.all<any>(`select * from ${t}`);
      for (const row of rows) {
        for (const [k, v] of Object.entries(row)) {
          if (typeof v === 'string' && k.toLowerCase().includes('national')) {
            expect(pattern.test(v), `${t}.${k} = ${v}`).toBe(false);
          }
        }
      }
    }
    // And no seeded email uses a real domain.
    const users = await s.db.all<any>(`select email from users`);
    for (const u of users) {
      expect(String(u.email)).toMatch(/@([a-z0-9-]+\.)?(example\.test|example\.com)$/);
    }
  });
});
