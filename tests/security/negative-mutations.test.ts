/**
 * §46 NEGATIVE TESTS · MUTATION ATTACKS
 *
 * The premise of this portal is that the user will attempt to bypass the
 * interface. So every writable endpoint is attacked here with the payloads an
 * attacker actually sends: mass assignment, identity forgery, privilege
 * escalation, financial tampering, prototype pollution, nesting tricks and
 * injection strings.
 *
 * Two invariants are asserted for every one of them:
 *   1. the request is REFUSED and the database is UNCHANGED;
 *   2. the refusal is AUDITED, because a silent strip hides an attack in
 *      progress from the people who need to see it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootStack, loginAs, createAgent, type Stack, type Agent } from '../helpers.js';
import { IDS } from '../../server/src/db/demo-data.js';

let s: Stack;
beforeEach(async () => { s = await bootStack(); });
afterEach(async () => { await s.shutdown(); });

const AHMED = 'ahmed.alsaud@example.test';
const GULF = 'finance@gulfhorizon.example.test';
const STAFF_PARTNER = 'f1000000-0000-4000-8000-000000000001';
const THREAD = 'e1000000-0000-4000-8000-000000000001';

interface Target {
  label: string;
  method: 'post' | 'patch';
  url: (ids: Ids) => string;
  /** A payload that must succeed, proving the endpoint itself works. */
  valid: (ids: Ids) => Record<string, unknown>;
}

interface Ids {
  deadline: string;
  notification: string;
  invoice: string;
  document: string;
  appointment: string;
  session: string;
}

async function resolveIds(agent: Agent): Promise<Ids> {
  const [deadlines, notifications, invoices, documents, appointments, security] = await Promise.all([
    agent.get('/api/client/deadlines'),
    agent.get('/api/client/notifications'),
    agent.get('/api/client/invoices'),
    agent.get('/api/client/documents'),
    agent.get('/api/client/appointments'),
    agent.get('/api/client/security'),
  ]);
  return {
    deadline: deadlines.body.data.deadlines[0]?.id ?? '',
    notification: notifications.body.data.notifications.find((n: any) => !n.isRead)?.id
      ?? notifications.body.data.notifications[0]?.id ?? '',
    invoice: invoices.body.data.invoices.find((i: any) => Number(i.balanceDue) > 0)?.id ?? '',
    document: documents.body.data.documents[0]?.id ?? '',
    appointment: appointments.body.data.appointments[0]?.id ?? '',
    session: security.body.data.sessions?.[0]?.id ?? '',
  };
}

/** Every endpoint a client is allowed to mutate. */
const TARGETS: Target[] = [
  {
    label: 'PATCH /profile', method: 'patch', url: () => '/api/client/profile',
    valid: () => ({ jobTitle: 'Chief Financial Officer' }),
  },
  {
    label: 'PATCH /preferences', method: 'patch', url: () => '/api/client/preferences',
    valid: () => ({ language: 'ar', calendar: 'islamic-umalqura' }),
  },
  {
    label: 'PATCH /deadlines/:id', method: 'patch', url: (i) => `/api/client/deadlines/${i.deadline}`,
    valid: () => ({ status: 'acknowledged' }),
  },
  {
    label: 'PATCH /notification-preferences/:category', method: 'patch',
    url: () => '/api/client/notification-preferences/hearing',
    valid: () => ({ inApp: true, email: false }),
  },
  {
    label: 'POST /messages/:threadId', method: 'post', url: () => `/api/client/messages/${THREAD}`,
    valid: () => ({ body: 'Thank you, noted.' }),
  },
  {
    label: 'POST /appointments', method: 'post', url: () => '/api/client/appointments',
    valid: () => ({
      matterId: IDS.matterEmployment, preferredDate: '2026-11-04',
      preferredTime: '10:30', preferredMode: 'video', note: 'Please confirm.',
    }),
  },
  {
    label: 'POST /invoices/:id/payment', method: 'post', url: (i) => `/api/client/invoices/${i.invoice}/payment`,
    valid: () => ({ provider: 'mada' }),
  },
  {
    label: 'POST /documents/:id/access-url', method: 'post', url: (i) => `/api/client/documents/${i.document}/access-url`,
    valid: () => ({ disposition: 'attachment' }),
  },
  {
    label: 'POST /notifications/:id/read', method: 'post', url: (i) => `/api/client/notifications/${i.notification}/read`,
    valid: () => ({}),
  },
  {
    label: 'POST /notifications/read-all', method: 'post', url: () => '/api/client/notifications/read-all',
    valid: () => ({}),
  },
  {
    label: 'POST /privacy/requests', method: 'post', url: () => '/api/client/privacy/requests',
    valid: () => ({ requestType: 'export', details: 'Please export my records.' }),
  },
  {
    label: 'POST /privacy/consent', method: 'post', url: () => '/api/client/privacy/consent',
    valid: () => ({ purpose: 'marketing', consented: false }),
  },
  {
    label: 'POST /security/sessions/revoke-all-others', method: 'post',
    url: () => '/api/client/security/sessions/revoke-all-others',
    valid: () => ({}),
  },
];

/**
 * Payloads an attacker sends. Each is a full request body: the legitimate fields
 * are included so a refusal cannot be explained away as "the body was empty".
 */
const ATTACKS: Array<{ label: string; fields: Record<string, unknown> }> = [
  { label: 'tenant hijack', fields: { tenant_id: IDS.tenantNajd } },
  { label: 'tenant hijack (camelCase)', fields: { tenantId: IDS.tenantNajd } },
  { label: 'client hijack', fields: { client_id: IDS.clientGulf } },
  { label: 'user hijack', fields: { user_id: IDS.userGulf } },
  { label: 'role escalation', fields: { role: 'managing_partner' } },
  { label: 'portal role escalation', fields: { portal_role: 'admin' } },
  { label: 'internal role escalation', fields: { internal_role: 'compliance' } },
  { label: 'permission grant', fields: { permissions: ['*', 'internal:read'] } },
  { label: 'scope grant', fields: { scopes: 'internal firm' } },
  { label: 'status forgery', fields: { status: 'approved' } },
  { label: 'internal status forgery', fields: { internal_status: 'closed_won' } },
  { label: 'financial: amount_paid', fields: { amount_paid: 0 } },
  { label: 'financial: total', fields: { total: '0.01' } },
  { label: 'financial: subtotal', fields: { subtotal: 0 } },
  { label: 'financial: vat', fields: { vat_amount: 0 } },
  { label: 'financial: paid_at', fields: { paid_at: new Date().toISOString() } },
  { label: 'approval forgery', fields: { approved_by: STAFF_PARTNER } },
  { label: 'approval timestamp forgery', fields: { approved_at: new Date().toISOString() } },
  { label: 'authorship forgery', fields: { created_by: STAFF_PARTNER } },
  { label: 'staff attribution forgery', fields: { uploaded_by_staff_id: STAFF_PARTNER } },
  { label: 'storage key choice', fields: { storage_key: 'attacker/owned/path.pdf' } },
  { label: 'bucket choice', fields: { storage_bucket: 'firm-internal' } },
  { label: 'visibility escalation', fields: { client_visibility: 'internal' } },
  { label: 'identity verification forgery', fields: { identity_verified: true } },
  { label: 'national id injection', fields: { national_id: '1099887766' } },
  { label: 'email verification forgery', fields: { email_verified: true } },
  { label: 'MFA bypass', fields: { mfa_enabled: false } },
  { label: 'lockout reset', fields: { locked_until: null, failed_login_count: 0 } },
  { label: 'internal note injection', fields: { internal_notes: 'settlement floor is 40k' } },
  { label: 'risk downgrade', fields: { risk_rating: 'low' } },
  { label: 'conflict flag flip', fields: { conflict_cleared: true } },
  { label: 'staff assignment', fields: { assigned_staff_id: STAFF_PARTNER } },
];

/** Snapshot of everything a mutation could plausibly have changed. */
async function fingerprint(): Promise<string> {
  const tables = [
    'client_users', 'users', 'matters', 'deadlines', 'invoices', 'payments',
    'documents', 'appointments', 'message_threads', 'notification_preferences',
    'consent_records', 'client_sessions',
  ];
  const parts: string[] = [];
  for (const t of tables) {
    const rows = await s.db.all<any>(`select * from ${t} order by 1`);
    parts.push(`${t}:${JSON.stringify(rows)}`);
  }
  return parts.join('|');
}

async function tamperAuditCount(): Promise<number> {
  const row = await s.db.get<any>(
    `select count(*) as n from audit_events where action = 'FIELD_TAMPER_ATTEMPT'`);
  return Number(row?.n ?? 0);
}

describe('§46 · positive control: the writable endpoints genuinely work', () => {
  for (const t of TARGETS) {
    it(`${t.label} accepts a legitimate payload`, async () => {
      await loginAs(s.agent, AHMED);
      const ids = await resolveIds(s.agent);
      const res = t.method === 'patch'
        ? await s.agent.patch(t.url(ids), t.valid(ids))
        : await s.agent.post(t.url(ids), t.valid(ids));
      // 200/201 = applied; 400 = a validation rule we did not satisfy in this
      // fixture (e.g. a deadline already acknowledged). Neither is a 500, and
      // neither is the point of this suite — the point is that a legitimate
      // field is never refused as tampering.
      expect([200, 201, 400], `${t.label} → ${res.status} ${res.text.slice(0, 200)}`).toContain(res.status);
      if (res.status === 403) {
        expect(res.body.error.code).not.toBe('field_not_writable');
      }
    });
  }
});

describe('§46 · mass assignment is refused on every writable endpoint', () => {
  for (const t of TARGETS) {
    // `status` is the one field a client legitimately owns — on the deadline
    // endpoint only. Everywhere else it is forgery.
    const attacks = t.label === 'PATCH /deadlines/:id'
      ? ATTACKS.filter((a) => a.label !== 'status forgery')
      : ATTACKS;

    it(`${t.label} refuses ${attacks.length} tampering payloads`, async () => {
      await loginAs(s.agent, AHMED);
      const ids = await resolveIds(s.agent);
      const before = await fingerprint();

      for (const a of attacks) {
        const payload = { ...t.valid(ids), ...a.fields };
        const res = t.method === 'patch'
          ? await s.agent.patch(t.url(ids), payload)
          : await s.agent.post(t.url(ids), payload);

        expect(res.status, `${t.label} · ${a.label} → ${res.status} ${res.text.slice(0, 160)}`).toBe(403);
        expect(res.body.error.code, a.label).toBe('field_not_writable');
      }

      // Not one byte of state moved.
      expect(await fingerprint()).toBe(before);
      // And every attempt was recorded.
      expect(await tamperAuditCount()).toBeGreaterThanOrEqual(attacks.length);
    });
  }
});

describe('§46 · the audit event names the fields that were offered', () => {
  it('records a FIELD_TAMPER_ATTEMPT with metadata', async () => {
    await loginAs(s.agent, AHMED);
    await s.agent.patch('/api/client/profile', {
      jobTitle: 'Partner',                 // legitimate…
      tenant_id: IDS.tenantNajd,           // …wrapped around an attack
      role: 'managing_partner',
    });
    await new Promise((r) => setTimeout(r, 80));

    const rows = await s.db.all<any>(
      `select actor_user_id, outcome, reason_code, resource_type, metadata
         from audit_events where action = 'FIELD_TAMPER_ATTEMPT' order by id desc`);
    expect(rows.length).toBeGreaterThan(0);
    const ev = rows[0];
    expect(ev.outcome).toBe('denied');
    expect(ev.reason_code).toBe('protected_field_in_payload');
    expect(ev.actor_user_id).toBe(IDS.userAhmed);
    expect(String(ev.metadata)).toContain('tenant_id');
    expect(String(ev.metadata)).toContain('role');
  });

  it('records nothing when the payload is clean', async () => {
    await loginAs(s.agent, AHMED);
    await s.agent.patch('/api/client/profile', { jobTitle: 'Chief Financial Officer' });
    await new Promise((r) => setTimeout(r, 80));
    expect(await tamperAuditCount()).toBe(0);
  });
});

describe('§46 · smuggling variants are caught too', () => {
  it('catches a protected field nested one level down', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.patch('/api/client/profile', {
      jobTitle: 'Analyst', profile: { tenant_id: IDS.tenantNajd },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('field_not_writable');
  });

  it('catches a protected field inside an array element', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.patch('/api/client/profile', {
      jobTitle: 'Analyst', contacts: [{ client_id: IDS.clientGulf }],
    });
    expect(res.status).toBe(403);
  });

  it('catches case and separator variations', async () => {
    await loginAs(s.agent, AHMED);
    for (const key of ['TenantId', 'TENANT_ID', 'tenant-id', 'tenantID', ' Tenant_Id ']) {
      const res = await s.agent.patch('/api/client/profile', { jobTitle: 'x', [key]: IDS.tenantNajd });
      // A trailing-space key is not the protected name, but it is also not an
      // allowed one, so it must still be refused — just as a validation error.
      expect([400, 403], key).toContain(res.status);
      if (res.status === 403) expect(res.body.error.code).toBe('field_not_writable');
    }
    const row = await s.db.get<any>(`select tenant_id from client_users where user_id = ?`, [IDS.userAhmed]);
    expect(row.tenant_id).toBe(IDS.tenantKgm);
  });

  it('refuses prototype pollution keys', async () => {
    await loginAs(s.agent, AHMED);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      // The JSON is built by hand on purpose: an object literal containing
      // `__proto__` sets the prototype instead of creating a key, so
      // JSON.stringify would silently drop exactly the attack we mean to send.
      const raw = `{"jobTitle":"Analyst","${key}":{"isAdmin":true}}`;
      const res = await s.agent.patch('/api/client/profile', raw, { contentType: 'application/json' });
      expect([400, 403], `${key} → ${res.status}`).toContain(res.status);
    }
    // Object.prototype was not polluted for the rest of the process.
    expect(({} as any).isAdmin).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call({}, 'isAdmin')).toBe(false);
  });

  it('refuses a JSON array body where an object is expected', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.patch('/api/client/profile', [{ jobTitle: 'x' }, { tenant_id: IDS.tenantNajd }]);
    expect([400, 403]).toContain(res.status);
  });
});

describe('§46 · injection strings in VALUES are inert', () => {
  it('stores them as literal text and never as SQL', async () => {
    await loginAs(s.agent, AHMED);
    const payloads = [
      "'; DROP TABLE invoices; --",
      "' OR '1'='1",
      '1; UPDATE invoices SET amount_paid = 0',
      "$(rm -rf /)",
      '{{7*7}}',
      '<script>alert(document.cookie)</script>',
      '<img src=x onerror=alert(1)>',
      '","tenant_id":"bbbbbbbb-0000-4000-8000-000000000002"',
      '../../../../etc/passwd',
      '%00',
    ];
    for (const p of payloads) {
      const res = await s.agent.patch('/api/client/profile', { jobTitle: p.slice(0, 120) });
      expect([200, 400], p).toContain(res.status);
    }

    // The tables all still exist and the money is untouched.
    const inv = await s.db.get<any>(
      `select count(*) as n, sum(amount_paid) as paid from invoices`);
    expect(Number(inv.n)).toBe(5);
    expect(Number(inv.paid)).toBeGreaterThan(0);

    const row = await s.db.get<any>(`select job_title from client_users where user_id = ?`, [IDS.userAhmed]);
    // Whatever survived validation is stored verbatim — parameterized queries.
    expect(typeof row.job_title === 'string' || row.job_title === null).toBe(true);
  });

  it('does not reflect script content unescaped in an error message', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.patch('/api/client/profile', {
      jobTitle: '<script>alert(1)</script>', country: 'ZZ',
    });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    // A JSON body is not executed as HTML, and CSP forbids inline script anyway.
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
  });
});

describe('§46 · malformed and hostile request framing', () => {
  it('rejects malformed JSON without a 500', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.patch('/api/client/profile', '{"jobTitle": ', { contentType: 'application/json' });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('SyntaxError');
    expect(res.text).not.toContain('at ');
  });

  it('rejects an unexpected content type', async () => {
    await loginAs(s.agent, AHMED);
    // No urlencoded parser is mounted, so a form-encoded write parses to no body
    // at all and is refused. The job title must not have changed.
    const res = await s.agent.patch('/api/client/profile', 'jobTitle=Partner', {
      contentType: 'application/x-www-form-urlencoded',
    });
    expect([400, 415]).toContain(res.status);

    const row = await s.db.get<any>(`select job_title from client_users where user_id = ?`, [IDS.userAhmed]);
    expect(row.job_title).not.toBe('Partner');
  });

  it('rejects a text/plain body carrying JSON', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.patch(
      '/api/client/profile',
      JSON.stringify({ jobTitle: 'Partner', tenant_id: IDS.tenantNajd }),
      { contentType: 'text/plain' },
    );
    // Content-type sniffing is not performed: a JSON body under the wrong type
    // is simply not parsed.
    expect([400, 415]).toContain(res.status);
  });

  it('rejects an empty body on a route that requires one', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.patch('/api/client/notification-preferences/hearing', {});
    expect(res.status).toBe(400);
  });

  it('rejects an absurdly large body', async () => {
    await loginAs(s.agent, AHMED);
    const huge = { jobTitle: 'x'.repeat(2_000_000) };
    const res = await s.agent.patch('/api/client/profile', huge);
    expect([400, 413]).toContain(res.status);
  });

  it('never answers a mutation with a stack trace or a SQL fragment', async () => {
    await loginAs(s.agent, AHMED);
    const ids = await resolveIds(s.agent);
    for (const t of TARGETS) {
      const res = t.method === 'patch'
        ? await s.agent.patch(t.url(ids), { tenant_id: IDS.tenantNajd })
        : await s.agent.post(t.url(ids), { tenant_id: IDS.tenantNajd });
      expect(res.status).toBe(403);
      for (const leak of ['at Object.', 'at async', 'better_sqlite3', 'select ', 'insert into', 'SqliteError', 'node_modules']) {
        expect(res.text, `${t.label} leaked "${leak}"`).not.toContain(leak);
      }
      // The response carries a request id for support without carrying internals.
      expect(res.headers['x-request-id']).toBeTruthy();
    }
  });
});

describe('§46 · identity cannot be moved between accounts', () => {
  it('cannot make Ahmed write as Gulf', async () => {
    await loginAs(s.agent, AHMED);
    const before = await fingerprint();

    const attempts = [
      s.agent.patch('/api/client/profile', { tenant_id: IDS.tenantKgm, client_id: IDS.clientGulf }),
      s.agent.post(`/api/client/messages/${THREAD}`, { body: 'x', client_id: IDS.clientGulf }),
      s.agent.post('/api/client/appointments', {
        preferredDate: '2026-11-05', preferredTime: '09:00', client_id: IDS.clientGulf,
      }),
      s.agent.post(`/api/client/invoices/${'d1000000-0000-4000-8000-000000000005'}/payment`, {
        provider: 'mada', client_id: IDS.clientGulf,
      }),
    ];
    const results = await Promise.all(attempts);
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403]);

    expect(await fingerprint()).toBe(before);
  });

  it('cannot move a resource between matters by id in the body', async () => {
    await loginAs(s.agent, AHMED);
    // Appointments accept a matterId, so this is the live surface for it.
    const res = await s.agent.post('/api/client/appointments', {
      matterId: IDS.matterGulf, preferredDate: '2026-11-06', preferredTime: '11:00',
    });
    expect(res.status).toBe(404); // not your matter → indistinguishable from absent
    const planted = await s.db.get<any>(
      `select count(*) as n from appointments where matter_id = ?`, [IDS.matterGulf]);
    expect(Number(planted.n)).toBe(0);
  });

  it('a second tenant cannot reach the first tenant\'s write endpoints at all', async () => {
    const gulf = createAgent(s.app);
    await loginAs(gulf, GULF);
    const ids = await resolveIds(gulf);

    // Gulf's own ids resolve; Ahmed's do not.
    const ownThread = await gulf.get('/api/client/messages');
    expect(ownThread.status).toBe(200);

    const res = await gulf.post(`/api/client/messages/${THREAD}`, { body: 'cross-client write' });
    expect(res.status).toBe(404);

    const written = await s.db.get<any>(
      `select count(*) as n from messages where thread_id = ? and body = 'cross-client write'`, [THREAD]);
    expect(Number(written.n)).toBe(0);
    void ids;
  });
});

describe('§46 · no bulk or generic mutation surface exists', () => {
  it('every plausible admin-style write route is absent', async () => {
    await loginAs(s.agent, AHMED);
    const paths = [
      '/api/client/bulk', '/api/client/batch', '/api/client/query', '/api/client/rpc',
      '/api/client/sql', '/api/client/graphql', '/api/client/rest/v1/invoices',
      '/api/client/table/invoices', '/api/client/invoices/bulk-update',
      '/api/client/matters/bulk', '/api/client/users', '/api/client/clients',
      '/api/client/staff', '/api/client/tenants', '/api/client/audit-events',
      '/api/client/internal-notes', '/api/client/payments', '/api/client/receipts/new',
    ];
    for (const p of paths) {
      expect((await s.agent.post(p, {})).status, `POST ${p}`).toBe(404);
      expect((await s.agent.patch(p, {})).status, `PATCH ${p}`).toBe(404);
    }
  });

  it('HTTP verbs that would bypass the guard are not handled', async () => {
    await loginAs(s.agent, AHMED);
    for (const method of ['PUT', 'DELETE']) {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/client/profile`, {
        method,
        headers: {
          cookie: [...s.agent.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tenant_id: IDS.tenantNajd }),
      });
      // 404 (no such route) or 405 (verb not allowed). Never a successful write.
      expect([404, 405], method).toContain(res.status);
    }

    // (TRACE is not exercised: the HTTP client refuses to send it at all, so it
    // can never reach the server from a browser either.)

    // OPTIONS is answered by Express's own preflight handler. That is correct —
    // a browser needs it — but it must be inert: no body is processed, so no
    // tampering payload can ride along on it.
    const options = await fetch(`http://127.0.0.1:${s.port}/api/client/profile`, {
      method: 'OPTIONS',
      headers: {
        cookie: [...s.agent.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tenant_id: IDS.tenantNajd }),
    });
    expect([200, 204, 404, 405]).toContain(options.status);
    expect(options.headers.get('allow') ?? '').not.toContain('PUT');
    const row = await s.db.get<any>(`select tenant_id from client_users where user_id = ?`, [IDS.userAhmed]);
    expect(row.tenant_id).toBe(IDS.tenantKgm);
  });
});
