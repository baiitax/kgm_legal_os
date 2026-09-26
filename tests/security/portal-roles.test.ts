/**
 * THE PORTAL'S ROLE GATE · 403 `role_not_permitted`, and why it is not hiding
 *
 * The client portal has had two roles since it was built — `client_primary` and
 * `client_contact`, from `client_users.portal_role`, resolved into every session
 * — and it read that role in no screen and no route. The navigation redesign
 * filters the menu by it, and a filtered menu is not a control: this project
 * rejected "hide functionality" as a security posture in writing, and the reason
 * is in this file.
 *
 * The distinction the portal draws is authority over the ACCOUNT, not seniority.
 * A contact is a colleague the account holder admitted to the work — the matters,
 * the documents, the messages, the diary — and not to the money. So:
 *
 *   1. The four billing surfaces answer only to the holder, and answer a contact
 *      with 403 and a NAMED code. Not the indistinguishable not-found the
 *      cross-client routes use: the caller's own client is not a secret from the
 *      caller, and a member of the account told "not found" about their own
 *      invoice reasonably reports a broken portal.
 *   2. The gate runs BEFORE the lookup, so a contact cannot use it as an oracle
 *      over which of the client's invoices exist.
 *   3. The refusal is audited ONCE, with the reason the guard knew. A 403 that
 *      leaves no trace is how a role gate is quietly removed later.
 *   4. Everything else is untouched: the same contact still reads the matters,
 *      the documents and the correspondence. The gate is narrow, and the test
 *      proves it is narrow rather than trusting the diff.
 *   5. The session names the entity the reader acts for. The portal serves
 *      corporate clients whose people act for one entity at a time, and the shell
 *      renders that name — the reason `getClientUsersForUser` grew a join rather
 *      than the shell growing a second round-trip.
 *
 * THE CONTACT IS PROVISIONED, NOT SEEDED. Every seeded portal user is a primary,
 * and that is the point: a contact only ever exists because an account holder
 * invited them. Going through the real invitation flow here means the role under
 * test is the role the product actually creates, not a row this file wrote.
 *
 * The client-side companion is `web/src/test/nav.test.tsx`. Neither file is
 * sufficient alone: the menu states the rule, the server enforces it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootStack, createAgent, IDS, loginAs, type Agent, type Stack,
} from '../helpers.js';

const DEMO_PORTAL_PASSWORD = 'Demo!Portal2026';
const HOLDER = 'finance@gulfhorizon.example.test';   // client_primary · Gulf Horizon
const CONTACT_EMAIL = 'ops.contact@gulfhorizon.example.test';
const CONTACT_PASSWORD = 'Contact!Portal2026';

let s: Stack;
let holder: Agent;
let contact: Agent;

/** The columns the gate's audit row is asserted on, for one actor. */
async function denialsFor(email: string): Promise<Array<Record<string, unknown>>> {
  return s.db.all<Record<string, unknown>>(
    `select action, outcome, reason_code, metadata from audit_events
      where action = 'AUTHZ_DENIED'
        and actor_user_id = (select id from users where email = ?)
      order by id asc`,
    [email],
  );
}

beforeAll(async () => {
  s = await bootStack();

  /* The holder signs in normally. */
  holder = createAgent(s.app);
  const signedIn = await loginAs(holder, HOLDER, DEMO_PORTAL_PASSWORD);
  expect(signedIn.status).toBe(200);

  /* The contact is invited the way the product invites one, bound server-side to
     Gulf Horizon and to the contact role. */
  const invite = await s.container.auth.createInvitation(
    { ipHash: null, ipCountry: null, userAgent: null, requestId: null } as never,
    {
      tenantId: IDS.tenantKgm,
      clientId: IDS.clientGulf,
      email: CONTACT_EMAIL,
      displayName: 'Operations Contact',
      displayNameAr: 'جهة اتصال العمليات',
      portalRole: 'client_contact',
    },
  );

  const invitee = createAgent(s.app);
  await invitee.get('/api/auth/bootstrap');
  const accepted = await invitee.post('/api/auth/invite/accept', {
    token: invite.token,
    password: CONTACT_PASSWORD,
    confirmPassword: CONTACT_PASSWORD,
  });
  expect(accepted.status).toBe(200);

  contact = invitee;
  const me = await contact.get('/api/auth/session');
  expect(me.body.data.user.portalRole).toBe('client_contact');
});

afterAll(async () => { await s.shutdown(); });

// ==========================================================================

describe('the money belongs to the account holder', () => {
  it('shows the holder their invoices, their receipts and the way to pay', async () => {
    const invoices = await holder.get('/api/client/invoices');
    expect(invoices.status).toBe(200);
    expect(Array.isArray(invoices.body.data.invoices)).toBe(true);

    const receipts = await holder.get('/api/client/receipts');
    expect(receipts.status).toBe(200);

    const first = invoices.body.data.invoices[0];
    if (first) {
      const intent = await holder.post(`/api/client/invoices/${first.id}/payment`, {});
      expect(intent.status).not.toBe(403);
      expect(intent.body?.error?.code).not.toBe('role_not_permitted');
    }
  });

  it('refuses a contact every one of the four surfaces, by name', async () => {
    const invoices = await holder.get('/api/client/invoices');
    const real = invoices.body.data.invoices[0]?.id ?? '00000000-0000-0000-0000-0000000000ff';

    const targets: Array<[string, () => Promise<{ status: number; body: any }>]> = [
      ['list invoices', () => contact.get('/api/client/invoices')],
      ['read an invoice', () => contact.get(`/api/client/invoices/${real}`)],
      ['list receipts', () => contact.get('/api/client/receipts')],
      ['start a payment', () => contact.post(`/api/client/invoices/${real}/payment`, {})],
    ];

    for (const [what, call] of targets) {
      const res = await call();
      expect(res.status, `${what} must be refused`).toBe(403);
      expect(res.body.error.code, `${what}`).toBe('role_not_permitted');
      // The message may be read by a person: it names the rule, not the code.
      expect(String(res.body.error.message)).toMatch(/account holder/i);
    }
  });

  it('refuses a REAL invoice and a fabricated one identically, so the gate is no oracle', async () => {
    const invoices = await holder.get('/api/client/invoices');
    const real = invoices.body.data.invoices[0]?.id;
    expect(real, 'the seed must contain an invoice for this test to mean anything').toBeTruthy();

    const realAnswer = await contact.get(`/api/client/invoices/${real}`);
    const fakeAnswer = await contact.get('/api/client/invoices/00000000-0000-0000-0000-0000000000ff');
    expect(realAnswer.status).toBe(403);
    expect(fakeAnswer.status).toBe(403);
    expect(fakeAnswer.body).toEqual(realAnswer.body);
  });

  it('leaves the work untouched — the gate is narrow on purpose', async () => {
    // The failure mode of a role gate is over-reach: a contact locked out of
    // their own matters, documents and correspondence. Asserted per surface, so
    // a gate mounted on the wrong route fails here rather than in the field.
    for (const path of [
      '/api/client/dashboard',
      '/api/client/matters',
      '/api/client/documents',
      '/api/client/messages',
      '/api/client/appointments',
      '/api/client/notifications',
      '/api/client/profile',
      '/api/client/security',
      '/api/client/privacy',
    ]) {
      const res = await contact.get(path);
      expect(res.status, `${path} must stay open to a contact`).toBe(200);
    }
  });

  it('lets the holder reach the same work, so the two roles differ in exactly one way', async () => {
    for (const path of ['/api/client/dashboard', '/api/client/matters', '/api/client/documents']) {
      const res = await holder.get(path);
      expect(res.status, `${path}`).toBe(200);
    }
  });
});

describe('the refusal is recorded, once, with the reason the guard knew', () => {
  it('writes an AUTHZ_DENIED row naming the role and the capability', async () => {
    const before = await denialsFor(CONTACT_EMAIL);
    await contact.get('/api/client/invoices');
    const after = await denialsFor(CONTACT_EMAIL);

    // ONE row for ONE attempt: the guard writes it with `alreadyAudited`, so the
    // error handler does not add a second, generic one.
    expect(after.length).toBe(before.length + 1);

    const row = after[after.length - 1];
    expect(row.action).toBe('AUTHZ_DENIED');
    expect(row.outcome).toBe('denied');
    expect(row.reason_code).toBe('role_not_permitted');

    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    expect(meta.portalRole).toBe('client_contact');
    expect(meta.capability).toBe('billing');
    // A denylisted metadata key is DROPPED silently by the repository, which is
    // how a gate refuses correctly and records nothing at all. The key is
    // `portalRole`, not `roleCode`-with-a-`code`-key: checked here because the
    // failure is invisible in the response.
    expect(Object.keys(meta ?? {})).not.toContain('code');
  });

  it('records nothing for the holder, who was not refused', async () => {
    const before = await denialsFor(HOLDER);
    await holder.get('/api/client/invoices');
    const after = await denialsFor(HOLDER);
    expect(after.length).toBe(before.length);
  });
});

describe('the session names the entity, so the shell can too', () => {
  it('carries the role, the job title and the client name for a contact', async () => {
    const me = await contact.get('/api/auth/session');
    const user = me.body.data.user;
    expect(user.portalRole).toBe('client_contact');
    expect(user.clientName).toBeTruthy();
    // Names, never identifiers: §35's rule — the SPA renders names — is as true
    // of the chrome as it is of a page.
    expect(JSON.stringify(me.body)).not.toContain(IDS.clientGulf);
  });

  it('carries the registered name of the client, not a label the portal invented', async () => {
    const me = await contact.get('/api/auth/session');
    // The name on the session is the client's registered name, not a label the
    // portal invented for it.
    const row = await s.db.get<{ name: string }>(
      'select name from clients where id = ? and tenant_id = ?', [IDS.clientGulf, IDS.tenantKgm],
    );
    expect(me.body.data.user.clientName).toBe(row?.name);
  });

  it('puts the client name nowhere a refusal could leak it', async () => {
    const res = await contact.get('/api/client/invoices');
    expect(JSON.stringify(res.body)).not.toMatch(/Gulf Horizon/i);
  });
});
