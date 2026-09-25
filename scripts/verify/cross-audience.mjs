/**
 * KGM LEGAL OS — THE CROSS-AUDIENCE DOOR
 *
 *   node scripts/verify/cross-audience.mjs [base-url]
 *
 * The client portal and the firm OS share one database and one origin, and are
 * separated by an audience check rather than by a different login form. So the
 * SHAPE of a refusal is the only thing standing between a caller and a map of
 * who has an account where. This script tries both doors and requires that a
 * valid credential presented at the wrong one be INDISTINGUISHABLE from a
 * password that is simply wrong.
 *
 * Why the assertion is equality, not "a refusal"
 *   Both doors have been wrong here, in opposite directions, and neither was
 *   caught by the test suite — which had never presented valid credentials for
 *   an account belonging at the other door:
 *
 *     firm OS    client credentials -> 500 internal_error   (migration 0025: a
 *                login-attempt vocabulary the CHECK rejected)
 *     client     firm credentials   -> 403 forbidden        (an explicit
 *                "no active portal access" thrown AFTER the password verified)
 *
 *   against 401 invalid_credentials for an unknown account. A 403 or a 500 where
 *   a 401 belongs says: this address exists, and the password is right.
 *
 * A NOTE ON THE PATHS
 *   The two doors are not symmetrical — the portal bootstraps its CSRF token
 *   from /api/auth/bootstrap, the firm OS from /api/firm/auth/csrf — so each case
 *   names its own paths. An earlier version derived both from a single prefix,
 *   which made the portal cases POST to a route that does not exist; the
 *   catch-all 401 there produced a PASS for the wrong reason, and the script was
 *   quietly asserting nothing about the door it named.
 */
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? process.env.KGM_BASE ?? 'https://kgmlegal.vercel.app';

const PORTAL = { door: 'portal', csrf: '/api/auth/bootstrap', login: '/api/auth/login', cookie: 'kgm_csrf' };
const FIRM = { door: 'firm', csrf: '/api/firm/auth/csrf', login: '/api/firm/auth/login', cookie: 'kgm_firm_csrf' };

const CASES = [
  // ---- the baselines, measured first: what a WRONG credential looks like ----
  {
    door: 'portal', paths: PORTAL, baseline: true,
    name: 'portal · unknown account (baseline)',
    email: 'nobody@example.test', password: 'not-a-password',
  },
  {
    door: 'firm', paths: FIRM, baseline: true,
    name: 'firm · unknown account (baseline)',
    email: 'nobody@example.test', password: 'not-a-password',
  },
  // ---- the real doors, which must match their baselines exactly ----
  {
    door: 'portal', paths: PORTAL,
    name: "portal · a firm member's credentials",
    email: process.env.KGM_FIRM_EMAIL ?? 'noura@kgm.example.test',
    password: process.env.KGM_FIRM_PASSWORD ?? 'Demo!Firm2026',
  },
  {
    door: 'firm', paths: FIRM,
    name: "firm · a client's credentials",
    email: process.env.KGM_PORTAL_EMAIL ?? 'ahmed.alsaud@example.test',
    password: process.env.KGM_PORTAL_PASSWORD ?? 'Demo!Portal2026',
  },
  // ---- and a wrong password on a REAL account, which must also match ----
  {
    door: 'portal', paths: PORTAL,
    name: 'portal · a real client, wrong password',
    email: process.env.KGM_PORTAL_EMAIL ?? 'ahmed.alsaud@example.test',
    password: 'definitely-not-the-password',
  },
  {
    door: 'firm', paths: FIRM,
    name: 'firm · a real member, wrong password',
    email: process.env.KGM_FIRM_EMAIL ?? 'noura@kgm.example.test',
    password: 'definitely-not-the-password',
  },
];

/** One attempt, in a fresh cookie jar so no session leaks between cases. */
async function attempt(paths, email, password) {
  const jar = new Map();
  const absorb = (r) => {
    for (const raw of r.headers.getSetCookie?.() ?? []) {
      const [p] = raw.split(';');
      const i = p.indexOf('=');
      jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  };
  const csrfRes = await fetch(`${BASE}${paths.csrf}`, { headers: { accept: 'application/json' } });
  absorb(csrfRes);

  const res = await fetch(`${BASE}${paths.login}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      'x-csrf-token': jar.get(paths.cookie) ?? '',
    },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, code: body?.error?.code ?? null, message: body?.error?.message ?? null };
}

/** The full observable answer, so equality means equality of everything. */
const shape = (r) => `${r.status} | ${r.code} | ${r.message}`;

console.log(`\n  KGM LEGAL OS · cross-audience refusals · ${BASE}\n`);

const baseline = {};
const results = [];
const checks = [];

for (const c of CASES) {
  const r = await attempt(c.paths, c.email, c.password);
  const s = shape(r);

  let ok;
  let note = '';
  if (c.baseline) {
    // A baseline is only useful if it is itself the uniform refusal.
    ok = r.status === 401 && r.code === 'invalid_credentials';
    baseline[c.door] = r;
    note = ok ? '(reference)' : 'baseline is not 401 invalid_credentials';
  } else {
    const ref = baseline[c.door];
    ok = ref ? s === shape(ref) : r.status === 401;
    note = ok ? '' : `differs from ${c.door} baseline`;
  }

  results.push(ok);
  checks.push({ name: c.name, door: c.door, status: r.status, code: r.code, message: r.message, ok, note });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(40)} HTTP ${r.status} ${r.code ?? ''} ${note}`);
}

const passed = results.filter(Boolean).length;
console.log(`\n  ${passed} passed, ${results.length - passed} failed`);
console.log(`  a valid credential at the wrong door answers exactly like a wrong one\n`);

// The credential manual cites this run. Writing the outcome to disk means the
// document quotes a measurement instead of repeating a claim.
writeFileSync('/tmp/cross-audience.json', JSON.stringify({
  base: BASE,
  ranAt: new Date().toISOString(),
  passed,
  failed: results.length - passed,
  baselines: Object.fromEntries(Object.entries(baseline).map(([k, v]) => [k, shape(v)])),
  checks,
}, null, 2));

process.exit(results.every(Boolean) ? 0 : 1);
