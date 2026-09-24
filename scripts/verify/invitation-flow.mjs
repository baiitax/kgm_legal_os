/**
 * KGM LEGAL OS — THE INVITATION FRONT DOOR
 *
 *   KGM_ADMIN_URL="postgresql://postgres.<ref>:<pw>@<pooler>:5432/postgres" \
 *     node scripts/verify/invitation-flow.mjs [base-url]
 *
 * This portal is invitation-only, so accepting an invitation is the ONE way an
 * account comes into existence. Nothing else creates a user. It returned 500 on
 * the real database for two reasons at once — `mfa_enabled` written as 0 into a
 * boolean column, and a `client_users` policy whose WITH CHECK was `false` — and
 * neither was visible to the test suite, which never signs anybody up.
 *
 * So this script walks the whole door, and then tries it a second time:
 *
 *   1 · mint an invitation with a known token (only its sha256 is stored, so the
 *       script has to know the token before the row exists)
 *   2 · peek, as the emailed link's landing page does
 *   3 · accept: create the account, link the authorization row, open a session
 *   4 · read the dashboard with that brand-new session
 *   5 · prove ISOLATION at the front door: a matter belonging to a different
 *       client must 404 for the new user
 *   6 · replay the same token, which must be refused — the insert policy requires
 *       an invitation that has not been accepted, so a used link cannot
 *       provision a second account
 *
 * It removes the account and the invitation it created, so it is safe to re-run.
 */
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? process.env.KGM_BASE ?? 'https://kgmlegal.vercel.app';
const ADMIN_URL = process.env.KGM_ADMIN_URL;
if (!ADMIN_URL) {
  console.error('KGM_ADMIN_URL is required — this script mints an invitation, and only the database can do that.');
  process.exit(2);
}

const results = [];
const record = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(44)} ${detail}`);
};

const db = new pg.Client({
  connectionString: ADMIN_URL,
  ssl: { ca: readFileSync(new URL('../../server/certs/supabase-root-2021.crt', import.meta.url), 'utf8'), rejectUnauthorized: true },
});
await db.connect();

console.log(`\n  KGM LEGAL OS · invitation flow · ${BASE}\n`);

// ---- a client to invite into, and a matter that is NOT theirs ----------------
const client = (await db.query(
  `select c.id, c.tenant_id, c.name from clients c order by c.id limit 1`,
)).rows[0];
const foreign = (await db.query(
  `select m.id from matters m where m.client_id <> $1 order by m.id limit 1`,
  [client.id],
)).rows[0];

const TOKEN = `kgm-verify-invite-${randomUUID()}`;
const EMAIL = `verify.invitee.${Date.now()}@example.test`;
const invitationId = randomUUID();
await db.query(
  `insert into client_invitations
     (id, tenant_id, client_id, email, display_name, display_name_ar, portal_role,
      token_hash, token_hint, created_at, expires_at)
   values ($1,$2,$3,$4,$5,$6,'client_contact',$7,$8,now(),now() + interval '7 days')`,
  [invitationId, client.tenant_id, client.id, EMAIL, 'Verification Invitee', 'دعوة تحقق',
   createHash('sha256').update(TOKEN).digest('hex'), TOKEN.slice(-6)],
);

// ---- the browser's half: a cookie jar, CSRF, and the three calls ------------
const jar = new Map();
const absorb = (r) => {
  for (const raw of r.headers.getSetCookie?.() ?? []) {
    const [p] = raw.split(';');
    const i = p.indexOf('=');
    jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
};
const cookie = () => (jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : '');
const call = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: {
      accept: 'application/json',
      cookie: cookie(),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.csrf ? { 'x-csrf-token': opts.csrf } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  absorb(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
};

await call('/api/auth/bootstrap');
const peek = await call(`/api/auth/invite/peek?token=${encodeURIComponent(TOKEN)}`);
record('peek the invitation', peek.status === 200 && peek.json?.data?.email === EMAIL, `HTTP ${peek.status}`);

const csrf = jar.get('kgm_csrf_anon') ?? jar.get('kgm_csrf');
const accept = await call('/api/auth/invite/accept', {
  method: 'POST',
  csrf,
  body: { token: TOKEN, email: EMAIL, password: 'Demo!Portal2026', displayName: 'Verification Invitee', acceptTerms: true },
});
record('accept: account is created', accept.status === 200, `HTTP ${accept.status} ${accept.text.slice(0, 110)}`);

const accepted = accept.status === 200;
let userId = null;
if (accepted) {
  const created = await db.query(`select u.id from users u where u.email = $1`, [EMAIL]);
  userId = created.rows[0]?.id ?? null;

  const dash = await call('/api/client/dashboard');
  record('the new session reads the dashboard', dash.status === 200, `HTTP ${dash.status}`);

  // Isolation must hold from the first request, not after an invitation settles.
  if (foreign) {
    const other = await call(`/api/client/matters/${foreign.id}`);
    record('a matter of another client is 404', other.status === 404, `HTTP ${other.status}`);
  }

  // The token is spent.
  const replay = await call('/api/auth/invite/accept', {
    method: 'POST',
    csrf,
    body: { token: TOKEN, email: EMAIL, password: 'Demo!Portal2026', displayName: 'Replay', acceptTerms: true },
  });
  record('replaying the used token is refused', replay.status >= 400, `HTTP ${replay.status}`);
  const second = userId
    ? await db.query(`select count(*)::int as n from client_users where user_id = $1`, [userId])
    : { rows: [{ n: 0 }] };
  record('no second client link was provisioned', second.rows[0].n === 1, `${second.rows[0].n} link(s)`);
}

// ---- clean up what this run created -----------------------------------------
await db.query(`delete from client_invitations where id = $1`, [invitationId]);
if (userId) await db.query(`delete from users where id = $1`, [userId]);
console.log('\n  cleaned up: the invitation and the verification account');
await db.end();

const passed = results.filter((r) => r.ok).length;
console.log(`\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
