/**
 * KGM LEGAL OS — THE CROSS-AUDIENCE DOOR
 *
 *   node scripts/verify/cross-audience.mjs [base-url]
 *
 * The client portal and the firm OS share one database and one origin, and are
 * separated by an audience check, not by a different login form. This script
 * tries the door from both sides and requires that a refusal be INDISTINGUISHABLE
 * from any other refusal.
 *
 * Why this is a script and not an assertion in the suite
 *   The failure it catches is not a wrong decision — the decision was always
 *   right — but a wrong STATUS. A correct password on an account with no firm
 *   membership wrote a login-attempt outcome the database's CHECK rejected
 *   (migration 0025), the rejection propagated out of the handler, and:
 *
 *     client credentials at the firm login  -> 500 internal_error
 *     unknown account at the firm login     -> 401 invalid_credentials
 *
 *   Two different answers to the same question, produced by a schema mismatch
 *   below the authorization layer. The uniform 401 is a stated requirement of
 *   the flow ("saying so would confirm that this address is a client of the
 *   firm"), and only a live request can show that the requirement holds end to
 *   end.
 */
const BASE = process.argv[2] ?? process.env.KGM_BASE ?? 'https://kgmlegal.vercel.app';

/** One attempt, in a fresh cookie jar so no session leaks between cases. */
async function attempt(endpoint, prefix, email, password) {
  const jar = new Map();
  const absorb = (r) => {
    for (const raw of r.headers.getSetCookie?.() ?? []) {
      const [p] = raw.split(';');
      const i = p.indexOf('=');
      jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  };
  const cookie = () => (jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : '');

  const csrfRes = await fetch(`${BASE}${endpoint}/auth/csrf`, { headers: { accept: 'application/json' } });
  absorb(csrfRes);
  const csrf = jar.get(prefix);

  const res = await fetch(`${BASE}${endpoint}/auth/login`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', cookie: cookie(), 'x-csrf-token': csrf ?? '' },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  let code = null;
  try { code = JSON.parse(text)?.error?.code ?? null; } catch { /* non-JSON */ }
  return { status: res.status, code, body: text.slice(0, 160) };
}

const CASES = [
  {
    name: 'client portal · a firm member\'s credentials',
    endpoint: '/api/client',
    prefix: 'kgm_csrf',
    email: process.env.KGM_FIRM_EMAIL ?? 'noura@kgm.example.test',
    password: process.env.KGM_FIRM_PASSWORD ?? 'Demo!Firm2026',
    want: 401,
  },
  {
    name: 'firm OS · a client\'s credentials',
    endpoint: '/api/firm',
    prefix: 'kgm_firm_csrf',
    email: process.env.KGM_PORTAL_EMAIL ?? 'ahmed.alsaud@example.test',
    password: process.env.KGM_PORTAL_PASSWORD ?? 'Demo!Portal2026',
    want: 401,
  },
  {
    name: 'firm OS · an unknown account (the baseline)',
    endpoint: '/api/firm',
    prefix: 'kgm_firm_csrf',
    email: 'nobody@example.test',
    password: 'not-a-password',
    want: 401,
  },
];

console.log(`\n  KGM LEGAL OS · cross-audience refusals · ${BASE}\n`);
const results = [];
for (const c of CASES) {
  const r = await attempt(c.endpoint, c.prefix, c.email, c.password);
  const ok = r.status === c.want;
  results.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(46)} HTTP ${r.status} ${r.code ?? ''}`);
}
console.log(`\n  ${results.filter(Boolean).length} passed, ${results.filter((x) => !x).length} failed\n`);
process.exit(results.every(Boolean) ? 0 : 1);
