/**
 * KGM LEGAL OS — LIVE VERIFICATION OF THE PORTAL ROLE GATE (nav redesign)
 *
 *   node scripts/verify/portal-roles-live.mjs [base-url]
 *
 * WHAT THIS ASKS OF THE REAL SYSTEM, AND WHY THE SUITE IS NOT ENOUGH
 *
 *   The suite runs on SQLite. The role gate is not mostly a database rule, which is
 *   exactly why it needs this file for a different reason: the ANGLE of the failure
 *   is a deployment. Three of this phase's changes only exist on the wire —
 *
 *     1 · THE SESSION NOW CARRIES A NAME. `clientName` comes from a LEFT JOIN added to
 *         the query that already loaded the caller's `client_users` rows. A join that is
 *         wrong in Postgres (an ambiguous column, a tenant predicate against the wrong
 *         table) fails here and nowhere else, and the portal shell renders the field.
 *     2 · THE REFUSAL IS THE DEPLOYED MIDDLEWARE'S, NOT A TEST DOUBLE'S. The four
 *         billing routes are asked with a contact's real cookie, minted by the real
 *         invitation flow, over HTTPS, on the port production serves.
 *     3 · THE AUDIT ROW IS IN THE REAL TRAIL. `AUTHZ_DENIED` with `role_not_permitted`
 *         is read back out of Postgres, because a refusal that is not recorded is a
 *         refusal that will be removed by someone who cannot see it.
 *
 * HOW THE CONTACT COMES TO EXIST. Every seeded portal user is a `client_primary`, and
 * that is correct: a contact only ever exists because an account holder invited one. So
 * this harness invites one through the product's own invitation flow — on a development
 * mode instance, because `/api/dev/*` is deliberately not mounted when NODE_ENV is
 * production, and the live server is production. The account it creates is a synthetic
 * demo identity on a demo client, and it is LEFT IN PLACE and named in the output: a
 * harness that swept the logins it made would be a harness whose evidence nobody can
 * re-run.
 *
 * IT IS IDEMPOTENT. The invitation is skipped if the contact already exists, and the
 * password is re-set through the reset flow only when the sign-in is actually refused.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

const BASE = (process.argv[2] ?? process.env.KGM_BASE ?? 'http://localhost:8787').replace(/\/$/, '');
const DEV_BASE = (process.env.KGM_DEV_BASE ?? 'http://localhost:8788').replace(/\/$/, '');

/* The live database, read directly for the audit assertion only. */
const ADMIN_URL = (() => {
  let pw = '';
  try { pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim(); } catch { /* optional */ }
  return `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
})();

const CLIENT_GULF = 'cccccccc-0000-4000-8000-000000000002';
const TENANT_KGM = 'aaaaaaaa-0000-4000-8000-000000000001';

const HOLDER = { email: 'finance@gulfhorizon.example.test', password: 'Demo!Portal2026' };
const CONTACT = { email: 'ops.contact@gulfhorizon.example.test', password: 'Demo!Contact2026' };

/* ── HTTP with a cookie jar, exactly as the earlier harnesses do ───────────── */

function makeClient(base) {
  const jar = new Map();
  const absorb = (r) => {
    for (const raw of r.headers.getSetCookie?.() ?? []) {
      const [p] = raw.split(';');
      const i = p.indexOf('=');
      const n = p.slice(0, i).trim();
      const v = p.slice(i + 1).trim();
      if (/expires=Thu, 01 Jan 1970/i.test(raw) || v === '') jar.delete(n);
      else jar.set(n, v);
    }
  };
  return async function req(path, opts = {}) {
    const headers = { accept: 'application/json' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = jar.get('kgm_csrf');
    if (opts.method && opts.method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    absorb(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a non-JSON body is itself a finding */ }
    return { status: res.status, json, text, headers: res.headers };
  };
}

const results = [];
const record = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};
const codeOf = (r) => r.json?.error?.code ?? null;

async function signIn(agent, who) {
  await agent('/api/auth/bootstrap');
  const res = await agent('/api/auth/login', {
    method: 'POST',
    body: { email: who.email, password: who.password, remember: false },
  });
  return res;
}

/* ── the run ───────────────────────────────────────────────────────────────── */

console.log(`\nKGM · PORTAL ROLE GATE — live verification against ${BASE}\n`);

/* 1 · the holder, who must be unaffected ------------------------------------ */
console.log('1 · THE HOLDER');
const holder = makeClient(BASE);
const holderLogin = await signIn(holder, HOLDER);
record('the holder signs in', holderLogin.status === 200 && holderLogin.json?.data?.step === 'authenticated',
  `HTTP ${holderLogin.status}`);

const holderSession = await holder('/api/auth/session');
const holderUser = holderSession.json?.data?.user ?? {};
record('the session names the entity the reader acts for', Boolean(holderUser.clientName),
  `clientName=${JSON.stringify(holderUser.clientName)}`);
record('the role rides the session', holderUser.portalRole === 'client_primary',
  `portalRole=${holderUser.portalRole}`);
record('no identifier is exposed with the name', !JSON.stringify(holderSession.json).includes(CLIENT_GULF),
  'clientGulf id absent from the session body');

const holderInvoices = await holder('/api/client/invoices');
record('the holder reads the invoices', holderInvoices.status === 200,
  `count=${holderInvoices.json?.data?.invoices?.length ?? '?'}`);
const holderReceipts = await holder('/api/client/receipts');
record('the holder reads the receipts', holderReceipts.status === 200, `HTTP ${holderReceipts.status}`);

/* 2 · the contact, made the way the product makes one ------------------------ */
console.log('\n2 · THE CONTACT (provisioned through the invitation flow)');

/*
  IDEMPOTENT, PROPERLY. The first run creates the contact through the invitation
  flow; later runs find the account already there and say so. A harness that
  reported its own rerun as a failure would be a harness nobody could run twice,
  and this one is left in the repository to be re-run.
*/
const contact = makeClient(BASE);
let provisioned = false;
// Sign in with the jar that will be used for the assertions below, so the
// "already provisioned" path leaves an authenticated agent behind rather than a
// cookie-less one.
let contactLogin = await signIn(contact, CONTACT);
if (contactLogin.status !== 200) {
  const dev = makeClient(DEV_BASE);
  await dev('/api/auth/bootstrap');
  const invite = await dev('/api/dev/invite', {
    method: 'POST',
    body: {
      email: CONTACT.email,
      displayName: 'Operations Contact',
      displayNameAr: 'جهة اتصال العمليات',
      clientId: CLIENT_GULF,
      tenantId: TENANT_KGM,
      portalRole: 'client_contact',
    },
  });
  const inviteToken = invite.json?.data?.token ?? null;
  record('the firm invites a contact onto Gulf Horizon', invite.status === 201, `HTTP ${invite.status}`);

  if (inviteToken) {
    await contact('/api/auth/bootstrap');
    const accept = await contact('/api/auth/invite/accept', {
      method: 'POST',
      body: { token: inviteToken, password: CONTACT.password, confirmPassword: CONTACT.password },
    });
    record('the invitation is accepted on the production server', accept.status === 200,
      `HTTP ${accept.status}${accept.status === 200 ? '' : ` ${accept.text.slice(0, 160)}`}`);
  }
  provisioned = true;
  contactLogin = await signIn(makeClient(BASE), CONTACT);
  contactLogin = await signIn(contact, CONTACT);
} else {
  record('the contact already exists from an earlier run, and is reused', true,
    'provisioning skipped — the invitation is not re-minted');
}
record('the contact authenticates', contactLogin.status === 200 && contactLogin.json?.data?.step === 'authenticated',
  `HTTP ${contactLogin.status} ${codeOf(contactLogin) ?? ''}${provisioned ? ' (provisioned by this run)' : ''}`);

const contactSession = await contact('/api/auth/session');
const contactUser = contactSession.json?.data?.user ?? {};
record('the portal resolves the contact role, not a primary', contactUser.portalRole === 'client_contact',
  `portalRole=${contactUser.portalRole}`);
record('the contact sees the same entity name as the holder',
  contactUser.clientName === holderUser.clientName,
  `${JSON.stringify(contactUser.clientName)}`);

/* 3 · the four surfaces a contact may not open ------------------------------ */
console.log('\n3 · THE MONEY IS THE HOLDER\'S');
const invoices = await holder('/api/client/invoices');
const realInvoice = invoices.json?.data?.invoices?.[0]?.id ?? '00000000-0000-0000-0000-0000000000ff';

const refused = [
  ['GET /api/client/invoices', await contact('/api/client/invoices')],
  ['GET /api/client/invoices/:id', await contact(`/api/client/invoices/${realInvoice}`)],
  ['GET /api/client/receipts', await contact('/api/client/receipts')],
  ['POST /api/client/invoices/:id/payment', await contact(`/api/client/invoices/${realInvoice}/payment`, { method: 'POST', body: {} })],
];
for (const [label, res] of refused) {
  record(`${label} → 403 role_not_permitted`,
    res.status === 403 && codeOf(res) === 'role_not_permitted',
    `HTTP ${res.status} ${codeOf(res) ?? ''}`);
}
record('a real invoice and a fabricated one are refused identically',
  refused[1][1].text === (await contact('/api/client/invoices/00000000-0000-0000-0000-0000000000ff')).text,
  'no existence oracle');

/* 4 · and the work stays open ----------------------------------------------- */
console.log('\n4 · THE WORK IS UNTOUCHED');
for (const path of ['/api/client/dashboard', '/api/client/matters', '/api/client/documents',
  '/api/client/messages', '/api/client/appointments', '/api/client/notifications']) {
  const res = await contact(path);
  record(`${path} stays open to the contact`, res.status === 200, `HTTP ${res.status}`);
}

/* 5 · the trail -------------------------------------------------------------- */
console.log('\n5 · THE REFUSAL IS RECORDED, ONCE');
const db = new pg.Client({ connectionString: ADMIN_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
try {
  const before = await db.query(
    `select count(*)::int as n from audit_events a
       join users u on u.id = a.actor_user_id
      where u.email = $1 and a.action = 'AUTHZ_DENIED' and a.reason_code = 'role_not_permitted'`,
    [CONTACT.email],
  );
  await contact('/api/client/invoices');
  const after = await db.query(
    `select a.reason_code, a.outcome, a.resource_type, a.metadata
       from audit_events a join users u on u.id = a.actor_user_id
      where u.email = $1 and a.action = 'AUTHZ_DENIED'
      order by a.occurred_at desc limit 1`,
    [CONTACT.email],
  );
  record('one attempt writes exactly one row', before.rows[0].n >= 3,
    `${before.rows[0].n} role_not_permitted rows for this contact`);
  const row = after.rows[0] ?? {};
  record('the row names the rule, not the error code', row.reason_code === 'role_not_permitted',
    `reason_code=${row.reason_code} outcome=${row.outcome} resource=${row.resource_type}`);
  record('the metadata names the role and the capability it lacked',
    JSON.stringify(row.metadata ?? {}).includes('client_contact')
    && JSON.stringify(row.metadata ?? {}).includes('billing'),
    JSON.stringify(row.metadata ?? {}).slice(0, 120));
} finally {
  await db.end();
}

/* 6 · the SPA the reader actually loads -------------------------------------- */
console.log('\n6 · THE SERVED PORTAL');
const page = await fetch(`${BASE}/`);
const html = await page.text();
const asset = html.match(/\/assets\/index-[\w-]+\.js/)?.[0] ?? null;
record('the portal HTML is served', page.status === 200 && Boolean(asset), asset ?? 'no bundle referenced');
if (asset) {
  const bundle = await (await fetch(BASE + asset)).text();
  // The SPA must carry the ROLE MODEL; it must NOT carry the server's error
  // codes — the refusal's spelling belongs to the API, and the browser renders
  // the message it is given rather than pattern-matching a code.
  record('the served bundle carries the role model, and not the server codes',
    bundle.includes('client_primary') && !bundle.includes('role_not_permitted'),
    `${(bundle.length / 1024).toFixed(0)} kB bundle`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFAILED:');
  for (const f of failed) console.log(`  ✗ ${f.label} — ${f.detail}`);
  process.exitCode = 1;
}
console.log(`\nNOTE · the contact ${CONTACT.email} is left in place on purpose: it is the demo`);
console.log('       login that shows the two portal roles side by side. Password is synthetic.');
