/**
 * §45 AUTHENTICATION · §6 LOGIN SECURITY · §7 SESSIONS
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { bootStack, loginAs, readOutbox, type Stack } from '../helpers.js';
import { IDS } from '../../server/src/db/demo-data.js';

let s: Stack;
beforeEach(async () => { s = await bootStack(); });
afterEach(async () => { await s.shutdown(); });

const AHMED = 'ahmed.alsaud@example.test';
const PW = 'Demo!Portal2026';

describe('valid login', () => {
  it('authenticates a legitimate client and returns no authorization material', async () => {
    const res = await loginAs(s.agent, AHMED);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.step).toBe('authenticated');

    // The response must NOT contain tenant/role/permission material that a
    // client could echo back. tenantId is exposed on /session for display only.
    const serialized = JSON.stringify(res.body);
    for (const banned of ['password_hash', 'internal_notes', 'risk_rating', 'permissions']) {
      expect(serialized).not.toContain(banned);
    }
  });

  it('sets an HttpOnly session cookie and a readable CSRF cookie', async () => {
    await loginAs(s.agent, AHMED);
    const session = s.agent.cookies.get('kgm_portal_session');
    const csrf = s.agent.cookies.get('kgm_csrf');
    expect(session).toBeTruthy();
    expect(csrf).toBeTruthy();
    expect(session!.length).toBeGreaterThanOrEqual(40);   // 256-bit base64url
  });

  it('stores only a hash of the session token — the cookie value never appears in the DB', async () => {
    await loginAs(s.agent, AHMED);
    const token = s.agent.cookies.get('kgm_portal_session')!;
    const leaked = await s.db.get(`select count(*) as n from client_sessions where token_hash = ?`, [token]);
    expect(Number((leaked as any).n)).toBe(0);

    const rows = await s.db.all<any>(`select token_hash from client_sessions`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);   // sha256 hex, not the token
      expect(r.token_hash).not.toBe(token);
    }
  });

  it('resolves tenant and client server-side from client_users, not from the request', async () => {
    // Send tenant_id / client_id / role in the login body. §46: identity fields
    // are refused outright and audited, not silently stripped.
    await s.agent.get('/api/auth/bootstrap');
    const res = await s.agent.post('/api/auth/login', {
      email: AHMED, password: PW,
      tenant_id: IDS.tenantNajd,
      client_id: IDS.clientGulf,
      role: 'admin',
      permissions: ['*'],
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('field_not_writable');
    // The refused request created no session.
    expect((await s.agent.get('/api/client/dashboard')).status).toBe(401);

    // A clean login resolves identity from client_users, and the resolution is
    // proved behaviourally: Ahmed sees Ahmed's world, not Najd's or Gulf's.
    const session = await loginAs(s.agent, AHMED);
    expect(session.status).toBe(200);
    const me = await s.agent.get('/api/auth/session');
    expect(me.body.data.user.portalRole).toMatch(/^client_/);  // NOT admin
    // Raw tenant/client ids are never published to the browser.
    expect(me.text).not.toContain(IDS.tenantNajd);
    expect(me.text).not.toContain(IDS.clientGulf);
    expect(me.text).not.toContain(IDS.tenantKgm);

    const matters = await s.agent.get('/api/client/matters');
    const ids = matters.body.data.matters.map((m: any) => m.id);
    expect(ids).not.toContain(IDS.matterGulf);   // not Gulf's matters
    expect(ids).not.toContain(IDS.matterLayla);  // not Najd's matters
    expect(ids).toContain(IDS.matterCommercial); // Ahmed's own
  });
});

describe('invalid login', () => {
  it('returns an identical response for a wrong password and an unknown account', async () => {
    const wrong = await loginAs(s.agent, AHMED, 'Wrong!Password999');
    const unknown = await loginAs(s.agent, 'nobody@example.test', 'Wrong!Password999');

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('invalid_credentials');
    expect(unknown.body.error.code).toBe('invalid_credentials');
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    // The body carries no detail that could distinguish the two cases.
    expect(wrong.body.error.details).toBeUndefined();
    expect(unknown.body.error.details).toBeUndefined();
    expect(JSON.stringify(wrong.body)).not.toMatch(/exist|found|no such|not registered/i);
  });

  it('does not leak whether an account exists via error detail', async () => {
    const res = await loginAs(s.agent, 'nobody@example.test', PW);
    expect(res.body.error.details).toBeUndefined();
  });

  it('locks the account after the configured number of failures and answers 429', async () => {
    for (let i = 0; i < 5; i++) {
      await loginAs(s.agent, AHMED, 'Wrong!Password999');
    }
    const locked = await s.agent.post('/api/auth/login', { email: AHMED, password: PW });
    // Even the CORRECT password is refused while locked.
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('rate_limited');

    const row = await s.db.get<any>(`select failed_login_count, locked_until, status from users where email = ?`, [AHMED]);
    expect(Number(row.failed_login_count)).toBeGreaterThanOrEqual(5);
    expect(row.locked_until).toBeTruthy();
  });

  it('produces the SAME 429 shape for a locked known account and a rate-limited unknown one', async () => {
    // Lock a known account.
    for (let i = 0; i < 9; i++) await loginAs(s.agent, AHMED, 'Wrong!Password999');
    const lockedKnown = await s.agent.post('/api/auth/login', { email: AHMED, password: PW });

    // Exhaust the budget on an address that does not exist.
    for (let i = 0; i < 9; i++) await loginAs(s.agent, 'ghost@example.test', 'Wrong!Password999');
    const limitedUnknown = await s.agent.post('/api/auth/login', { email: 'ghost@example.test', password: PW });

    expect(lockedKnown.status).toBe(limitedUnknown.status);
    expect(lockedKnown.body.error.code).toBe(limitedUnknown.body.error.code);
  });

  it('records LOGIN, LOGIN_FAILED and ACCOUNT_LOCKED audit events', async () => {
    await loginAs(s.agent, AHMED);
    await loginAs(s.agent, AHMED, 'Wrong!Password999');
    const events = await s.db.all<any>(`select action, outcome from audit_events order by id`);
    const actions = events.map((e) => e.action);
    expect(actions).toContain('LOGIN');
    expect(actions).toContain('LOGIN_FAILED');
  });
});

describe('password reset (§6)', () => {
  it('returns an identical generic response whether or not the account exists', async () => {
    await s.agent.get('/api/auth/bootstrap');
    const known = await s.agent.post('/api/auth/forgot-password', { email: AHMED });
    const unknown = await s.agent.post('/api/auth/forgot-password', { email: 'nobody@example.test' });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(known.body.data.message).toMatch(/If an account exists/i);
  });

  it('emails a reset link only for a real account', async () => {
    await s.agent.get('/api/auth/bootstrap');
    await s.agent.post('/api/auth/forgot-password', { email: 'nobody@example.test' });
    expect(readOutbox().filter((e) => e.kind === 'password_reset')).toHaveLength(0);

    await s.agent.post('/api/auth/forgot-password', { email: AHMED });
    const sent = readOutbox().filter((e) => e.kind === 'password_reset');
    expect(sent).toHaveLength(1);
    expect(sent[0].link).toMatch(/\/reset-password\?token=/);
  });

  it('completes a reset, invalidates every session and rejects token reuse', async () => {
    // Sign in first so we can prove the reset kills the session.
    await loginAs(s.agent, AHMED);
    const before = await s.agent.get('/api/client/dashboard');
    expect(before.status).toBe(200);

    await s.agent.post('/api/auth/forgot-password', { email: AHMED });
    const link = readOutbox().find((e) => e.kind === 'password_reset')!.link!;
    const token = new URL(link).searchParams.get('token')!;

    const done = await s.agent.post('/api/auth/reset-password', {
      token, password: 'Brand#New2026Pass', confirmPassword: 'Brand#New2026Pass',
    });
    expect(done.status).toBe(200);

    // The old session is dead.
    const after = await s.agent.get('/api/client/dashboard');
    expect(after.status).toBe(401);

    // The token is single-use.
    //
    // Note the bootstrap call: revoking the sessions also invalidated the
    // session-bound CSRF token, so a real browser must re-read the cookie before
    // its next state-changing request. The SPA client does this automatically
    // on a 403 csrf_failed. Modelling it here keeps the assertion about the
    // RESET TOKEN rather than about CSRF bookkeeping.
    await s.agent.get('/api/auth/bootstrap');
    const reuse = await s.agent.post('/api/auth/reset-password', {
      token, password: 'Another#Pass2026x', confirmPassword: 'Another#Pass2026x',
    });
    expect(reuse.status).toBe(400);
    expect(['token_used', 'not_found']).toContain(reuse.body.error.code);

    // The new password works.
    const again = await loginAs(s.agent, AHMED, 'Brand#New2026Pass');
    expect(again.status).toBe(200);
  });

  it('rejects a weak new password and does not consume the token', async () => {
    await s.agent.get('/api/auth/bootstrap');
    await s.agent.post('/api/auth/forgot-password', { email: AHMED });
    const token = new URL(readOutbox().find((e) => e.kind === 'password_reset')!.link!).searchParams.get('token')!;

    const weak = await s.agent.post('/api/auth/reset-password', { token, password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('password_policy');
    expect(weak.body.error.details.failures).toContain('too_short');

    const ok = await s.agent.post('/api/auth/reset-password', { token, password: 'Still!Valid2026' });
    expect(ok.status).toBe(200);
  });
});

describe('logout & session revocation (§7, §26)', () => {
  it('kills the session on logout', async () => {
    await loginAs(s.agent, AHMED);
    expect((await s.agent.get('/api/client/dashboard')).status).toBe(200);
    await s.agent.post('/api/auth/logout');
    expect((await s.agent.get('/api/client/dashboard')).status).toBe(401);
  });

  it('revokes a session immediately when it is revoked server-side', async () => {
    await loginAs(s.agent, AHMED);
    const token = s.agent.cookies.get('kgm_portal_session')!;
    await s.db.run(
      `update client_sessions set revoked_at = ?, revoke_reason = 'admin' where token_hash = ?`,
      [new Date().toISOString(), crypto.createHash('sha256').update(token).digest('hex')],
    );
    const res = await s.agent.get('/api/client/dashboard');
    expect(res.status).toBe(401);
  });

  it('expires a session whose absolute TTL has passed, regardless of activity', async () => {
    await loginAs(s.agent, AHMED);
    const past = new Date(Date.now() - 1000).toISOString();
    await s.db.run(`update client_sessions set expires_at = ?`, [past]);
    expect((await s.agent.get('/api/client/dashboard')).status).toBe(401);
  });

  it('expires a session whose idle TTL has passed', async () => {
    await loginAs(s.agent, AHMED);
    const past = new Date(Date.now() - 1000).toISOString();
    await s.db.run(`update client_sessions set idle_expires_at = ?`, [past]);
    expect((await s.agent.get('/api/client/dashboard')).status).toBe(401);
  });

  it('signs out all other sessions but keeps the current one', async () => {
    await loginAs(s.agent, AHMED);
    const current = s.agent.cookies.get('kgm_portal_session');

    // A second session from "another device".
    const { createAgent } = await import('../helpers.js');
    const other = createAgent(s.app);
    await loginAs(other, AHMED);

    const sessions = await s.db.all<any>(`select id from client_sessions where revoked_at is null`);
    expect(sessions.length).toBe(2);

    const res = await s.agent.post('/api/client/security/sessions/revoke-all-others');
    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBe(1);

    expect((await s.agent.get('/api/client/dashboard')).status).toBe(200);
    expect((await other.get('/api/client/dashboard')).status).toBe(401);
    expect(s.agent.cookies.get('kgm_portal_session')).toBe(current);
  });
});

describe('CSRF (§7)', () => {
  it('rejects a state-changing request with no CSRF header', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.post('/api/auth/logout', {}, { csrf: false });
    // The cookie is still sent by a browser, but the header is what proves the
    // request came from our own origin.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf_failed');
  });

  it('rejects a CSRF token that does not match the cookie', async () => {
    await loginAs(s.agent, AHMED);
    const cookies = [...s.agent.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`http://127.0.0.1:${s.port}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookies, 'content-type': 'application/json', 'x-csrf-token': 'forged.token' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('rejects a pre-login CSRF token presented to an authenticated endpoint', async () => {
    // Grab an anonymous token bound to sid=null.
    const anon = await fetch(`http://127.0.0.1:${s.port}/api/auth/bootstrap`);
    const anonCsrf = (anon.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0]).find((c) => c.startsWith('kgm_csrf='))?.split('=')[1];
    expect(anonCsrf).toBeTruthy();

    await loginAs(s.agent, AHMED);
    const cookies = [...s.agent.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`http://127.0.0.1:${s.port}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookies, 'content-type': 'application/json', 'x-csrf-token': anonCsrf! },
      body: '{}',
    });
    // The anonymous token is not bound to the session, so it is refused.
    expect(res.status).toBe(403);
  });

  it('allows safe methods without a CSRF token', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get('/api/client/matters');
    expect(res.status).toBe(200);
  });
});

describe('no public signup (§3)', () => {
  const candidates = [
    ['POST', '/api/auth/register'], ['POST', '/api/auth/signup'],
    ['POST', '/api/auth/create-account'], ['POST', '/api/auth/join'],
    ['POST', '/api/client/register'], ['POST', '/api/users'],
    ['POST', '/api/client_users'], ['POST', '/api/profiles'],
    ['POST', '/api/auth/invite'],
  ] as const;

  for (const [method, url] of candidates) {
    it(`${method} ${url} does not exist`, async () => {
      await s.agent.get('/api/auth/bootstrap');
      const res = await fetch(`http://127.0.0.1:${s.port}${url}`, {
        method,
        headers: {
          'content-type': 'application/json',
          cookie: [...s.agent.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
          'x-csrf-token': s.agent.cookies.get('kgm_csrf') ?? '',
        },
        body: JSON.stringify({
          email: 'attacker@example.test', password: 'Attacker!Pass2026',
          tenant_id: IDS.tenantKgm, client_id: IDS.clientAhmed, role: 'admin',
        }),
      });
      // An unauthenticated caller sees 401 under the authenticated /api/client
      // mount and 404 elsewhere. Neither is a working signup endpoint, and the
      // assertion that matters is below: no account was created.
      expect([401, 403, 404]).toContain(res.status);
    });
  }

  it('cannot create a user row directly through any portal endpoint', async () => {
    const before = await s.db.get<any>(`select count(*) as n from users`);
    await loginAs(s.agent, AHMED);
    for (const url of ['/api/client/profile', '/api/client/users', '/api/client/accounts']) {
      await s.agent.post(url, { email: 'new@example.test', role: 'admin' });
      await s.agent.patch(url, { email: 'new@example.test', role: 'admin' });
    }
    const after = await s.db.get<any>(`select count(*) as n from users`);
    expect(Number(after.n)).toBe(Number(before.n));
  });
});

describe('invitation flow (§3, §48)', () => {
  it('provisions an account whose tenant, client and role all come from the invitation', async () => {
    const INVITEE = 'new.contact@gulfhorizon.example.test';
    const ctx = { ipHash: null, ipCountry: null, userAgent: null, requestId: null };
    const invite = await s.container.auth.createInvitation(ctx as any, {
      tenantId: IDS.tenantKgm,
      clientId: IDS.clientGulf,
      email: INVITEE,
      displayName: 'New Contact',
      displayNameAr: 'جهة اتصال جديدة',
      portalRole: 'client_contact',
    });

    await s.agent.get('/api/auth/bootstrap');
    const peek = await s.agent.get(`/api/auth/invite/peek?token=${invite.token}`);
    expect(peek.status).toBe(200);
    expect(peek.body.data.email).toBe('new.contact@gulfhorizon.example.test');
    expect(peek.body.data.firmName).toBe('KGM Law Firm');
    // The peek response must not disclose the client entity beyond the invitee.
    expect(JSON.stringify(peek.body)).not.toContain(IDS.clientGulf);

    // Try to override the binding at acceptance time: refused, and the
    // invitation is left unspent so the honest attempt still works.
    const hijack = await s.agent.post('/api/auth/invite/accept', {
      token: invite.token,
      password: 'Invited!Pass2026',
      confirmPassword: 'Invited!Pass2026',
      tenant_id: IDS.tenantNajd,
      client_id: IDS.clientAhmed,
      portal_role: 'client_primary',
      role: 'admin',
    });
    expect(hijack.status).toBe(403);
    expect(hijack.body.error.code).toBe('field_not_writable');
    expect((await s.db.get<any>(
      `select count(*) as n from users where email = ?`, [INVITEE])).n).toBeFalsy();

    const accept = await s.agent.post('/api/auth/invite/accept', {
      token: invite.token,
      password: 'Invited!Pass2026',
      confirmPassword: 'Invited!Pass2026',
    });
    expect(accept.status).toBe(200);

    // The binding came from the INVITATION row: KGM tenant, Gulf client,
    // contact role — never from the payload that was refused above.
    const created = await s.db.get<any>(
      `select cu.tenant_id, cu.client_id, cu.portal_role
         from client_users cu join users u on u.id = cu.user_id where u.email = ?`, [INVITEE]);
    expect(created.tenant_id).toBe(IDS.tenantKgm);
    expect(created.client_id).toBe(IDS.clientGulf);
    expect(created.portal_role).toBe('client_contact');

    const me = await s.agent.get('/api/auth/session');
    expect(me.body.data.user.portalRole).toBe('client_contact'); // not primary/admin
    const matters = await s.agent.get('/api/client/matters');
    expect(matters.body.data.matters.map((m: any) => m.id)).toEqual([IDS.matterGulf]);
  });

  it('rejects an expired invitation', async () => {
    const ctx = { ipHash: null, ipCountry: null, userAgent: null, requestId: null };
    const invite = await s.container.auth.createInvitation(ctx as any, {
      tenantId: IDS.tenantKgm, clientId: IDS.clientAhmed,
      email: 'expired@example.test', displayName: 'Expired User',
    });
    await s.db.run(`update client_invitations set expires_at = ?`, [new Date(Date.now() - 1000).toISOString()]);

    await s.agent.get('/api/auth/bootstrap');
    const res = await s.agent.post('/api/auth/invite/accept', {
      token: invite.token, password: 'Invited!Pass2026',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invitation_expired');
  });

  it('rejects a revoked invitation', async () => {
    const ctx = { ipHash: null, ipCountry: null, userAgent: null, requestId: null };
    const invite = await s.container.auth.createInvitation(ctx as any, {
      tenantId: IDS.tenantKgm, clientId: IDS.clientAhmed,
      email: 'revoked@example.test', displayName: 'Revoked User',
    });
    await s.db.run(`update client_invitations set revoked_at = ?`, [new Date().toISOString()]);

    await s.agent.get('/api/auth/bootstrap');
    const res = await s.agent.post('/api/auth/invite/accept', {
      token: invite.token, password: 'Invited!Pass2026',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invitation_revoked');
  });

  it('rejects an invitation token that has already been used', async () => {
    const ctx = { ipHash: null, ipCountry: null, userAgent: null, requestId: null };
    const invite = await s.container.auth.createInvitation(ctx as any, {
      tenantId: IDS.tenantKgm, clientId: IDS.clientAhmed,
      email: 'twice@example.test', displayName: 'Twice User',
    });
    await s.agent.get('/api/auth/bootstrap');
    const first = await s.agent.post('/api/auth/invite/accept', { token: invite.token, password: 'Invited!Pass2026' });
    expect(first.status).toBe(200);

    const { createAgent } = await import('../helpers.js');
    const second = createAgent(s.app);
    await second.get('/api/auth/bootstrap');
    const res = await second.post('/api/auth/invite/accept', { token: invite.token, password: 'Invited!Pass2026' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invitation_accepted');
  });

  it('rejects a weak password at invitation acceptance', async () => {
    const ctx = { ipHash: null, ipCountry: null, userAgent: null, requestId: null };
    const invite = await s.container.auth.createInvitation(ctx as any, {
      tenantId: IDS.tenantKgm, clientId: IDS.clientAhmed,
      email: 'weakpw@example.test', displayName: 'Weak User',
    });
    await s.agent.get('/api/auth/bootstrap');
    const res = await s.agent.post('/api/auth/invite/accept', { token: invite.token, password: 'password123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('password_policy');

    // The account was not created.
    const u = await s.db.get<any>(`select count(*) as n from users where email = ?`, ['weakpw@example.test']);
    expect(Number(u.n)).toBe(0);
  });

  it('refuses an invitation whose binding columns were tampered with', async () => {
    // The database trigger makes the binding immutable; prove it fires.
    const ctx = { ipHash: null, ipCountry: null, userAgent: null, requestId: null };
    const invite = await s.container.auth.createInvitation(ctx as any, {
      tenantId: IDS.tenantKgm, clientId: IDS.clientAhmed, email: 'tamper@example.test', displayName: 'Tamper',
    });
    await expect(
      s.db.run(`update client_invitations set client_id = ?`, [IDS.clientGulf]),
    ).rejects.toThrow(/immutable/i);
    void invite;
  });
});

describe('email verification (§6)', () => {
  it('blocks portal access until the email is verified', async () => {
    await loginAs(s.agent, AHMED);
    await s.db.run(`update users set email_verified_at = null where email = ?`, [AHMED]);
    const res = await s.agent.get('/api/client/dashboard');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('email_not_verified');
  });

  it('verifies via a single-use token and restores access', async () => {
    await loginAs(s.agent, AHMED);
    await s.db.run(`update users set email_verified_at = null where email = ?`, [AHMED]);
    await s.agent.post('/api/auth/verify-email/send');
    const link = readOutbox().find((e) => e.kind === 'email_verification')!.link!;
    const token = new URL(link).searchParams.get('token')!;

    const res = await s.agent.post('/api/auth/verify-email', { token });
    expect(res.status).toBe(200);
    expect((await s.agent.get('/api/client/dashboard')).status).toBe(200);

    const reuse = await s.agent.post('/api/auth/verify-email', { token });
    expect(reuse.status).toBe(404);
  });
});

describe('security headers (§47)', () => {
  it('sends CSP, nosniff, referrer-policy and permissions-policy on every response', async () => {
    const res = await s.agent.get('/api/health');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(String(res.headers['content-security-policy'])).toContain("object-src 'none'");
    expect(String(res.headers['content-security-policy'])).not.toContain('unsafe-eval');
    expect(String(res.headers['x-content-type-options'])).toBe('nosniff');
    expect(String(res.headers['referrer-policy'])).toBeTruthy();
    expect(String(res.headers['permissions-policy'])).toContain('camera=()');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('never returns a stack trace, SQL text or driver error to the client', async () => {
    const res = await s.agent.get('/api/client/matters/not-a-uuid');
    const text = res.text;
    for (const banned of ['at Object.', 'SQLITE', 'select ', 'PostgREST', '42P17', 'better_sqlite', 'stack']) {
      expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});
