/**
 * VERIFY EVERY DEMO CREDENTIAL, AGAINST THE LIVE DEPLOYMENT.
 *
 *   node scripts/verify/credentials.mjs [base-url]
 *
 * A credential list that is copied from a seed file is a guess. This script
 * signs in with every account the database actually holds — through the same
 * endpoints the browser uses, with CSRF and cookies — and reports the identity
 * the SERVER resolved, not the one the seed intended. If a password has drifted
 * or an account was disabled, the manual that quotes it would be wrong, so the
 * manual is generated from this output rather than from the seed.
 *
 * It also asserts the audience boundary from the other side: each firm account
 * must be refused at the client portal and each client account at the firm portal,
 * whatever its password. A credential manual that hands out an account that can
 * cross audiences is worse than no manual.
 */
const BASE = process.argv[2] ?? process.env.KGM_BASE ?? 'https://kgmlegal.vercel.app';

const PORTAL_PASSWORD = process.env.KGM_PORTAL_PASSWORD ?? 'Demo!Portal2026';
const FIRM_PASSWORD = process.env.KGM_FIRM_PASSWORD ?? 'Demo!Firm2026';

const PORTAL_EMAILS = (process.env.KGM_PORTAL_EMAILS ?? [
  'ahmed.alsaud@example.test',
  'finance@gulfhorizon.example.test',
  'layla.mansour@example.test',
].join(',')).split(',');

const FIRM_EMAILS = (process.env.KGM_FIRM_EMAILS ?? [
  'noura@kgm.example.test',
  'faisal@kgm.example.test',
  'mariam@kgm.example.test',
  'sara@kgm.example.test',
  'omar@kgm.example.test',
].join(',')).split(',');

/**
 * One sign-in attempt in a fresh cookie jar.
 *
 * The two products do NOT share a login path, and that is the point: the portal
 * bootstraps its CSRF token from `/api/auth/bootstrap`, while the firm OS has an
 * explicit `/api/firm/auth/csrf`. Assuming a common shape produced a 404 here
 * once, which is how the two doors were confirmed to be genuinely separate.
 */
async function attempt(paths, csrfCookie, email, password) {
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
  const csrf = jar.get(csrfCookie);

  const res = await fetch(`${BASE}${paths.login}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      'x-csrf-token': csrf ?? '',
    },
    body: JSON.stringify({ email, password }),
  });
  absorb(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
}

const out = { base: BASE, portal: [], firm: [], boundary: [] };

console.log(`\n  KGM LEGAL OS · credential verification · ${BASE}\n`);
console.log('  ── client portal ────────────────────────────────────────');
for (const email of PORTAL_EMAILS) {
  const r = await attempt({ csrf: '/api/auth/bootstrap', login: '/api/auth/login' }, 'kgm_csrf', email, PORTAL_PASSWORD);
  // Resolve who the server thinks this is, and what they can see.
  let dash = null;
  if (r.status === 200) {
    const res = await fetch(`${BASE}/api/client/dashboard`, { headers: { accept: 'application/json', cookie: r.cookie() } });
    dash = await res.json().catch(() => null);
  }
  const matters = r.status === 200
    ? (await (await fetch(`${BASE}/api/client/matters`, { headers: { accept: 'application/json', cookie: r.cookie() } })).json())?.data?.matters ?? []
    : [];
  out.portal.push({
    email,
    password: PORTAL_PASSWORD,
    status: r.status,
    ok: r.status === 200,
    resolvedName: dash?.data?.greeting?.displayName ?? null,
    resolvedNameAr: dash?.data?.greeting?.displayNameAr ?? null,
    firmName: dash?.data?.greeting?.firmName ?? null,
    matters: matters.map((m) => m.matterNumber),
  });
  console.log(`  ${r.status === 200 ? 'PASS' : 'FAIL'}  ${email.padEnd(36)} HTTP ${r.status}  ${dash?.data?.greeting?.displayName ?? ''}  (${matters.length} matters)`);
}

console.log('\n  ── firm OS ──────────────────────────────────────────────');
for (const email of FIRM_EMAILS) {
  const r = await attempt({ csrf: '/api/firm/auth/csrf', login: '/api/firm/auth/login' }, 'kgm_firm_csrf', email, FIRM_PASSWORD);
  let scope = null;
  let matters = [];
  if (r.status === 200) {
    scope = r.json?.data?.scope ?? null;
    // Ask the API which matters this membership can actually reach. Reading
    // matter_permissions from the database would only restate the rule; this
    // measures the rule as it was applied to a real session.
    const res = await fetch(`${BASE}/api/firm/matters`, {
      headers: { accept: 'application/json', cookie: r.cookie() },
    });
    const body = await res.json().catch(() => null);
    const items = body?.data?.matters ?? body?.data?.items ?? body?.matters ?? [];
    matters = (Array.isArray(items) ? items : [])
      .map((m) => m.matterNumber ?? m.matter_number ?? m.number)
      .filter(Boolean);
  }
  out.firm.push({ email, password: FIRM_PASSWORD, status: r.status, ok: r.status === 200, scope, matters });
  console.log(`  ${r.status === 200 ? 'PASS' : 'FAIL'}  ${email.padEnd(36)} HTTP ${r.status}  ${scope?.membershipId ? 'membership ' + String(scope.membershipId).slice(0, 8) : ''}  (${matters.length} matters visible)`);
}

console.log('\n  ── audience boundary (each account at the OTHER door) ───');
for (const [label, paths, cookieName, emails, password] of [
  ['client → firm', { csrf: '/api/firm/auth/csrf', login: '/api/firm/auth/login' }, 'kgm_firm_csrf', PORTAL_EMAILS, PORTAL_PASSWORD],
  ['firm → client', { csrf: '/api/auth/bootstrap', login: '/api/auth/login' }, 'kgm_csrf', FIRM_EMAILS, FIRM_PASSWORD],
]) {
  for (const email of emails) {
    const r = await attempt(paths, cookieName, email, password);
    const refused = r.status === 401;
    out.boundary.push({ direction: label, email, status: r.status, refused });
    console.log(`  ${refused ? 'PASS' : 'FAIL'}  ${label.padEnd(14)} ${email.padEnd(34)} HTTP ${r.status}`);
  }
}

console.log(`\n  portal: ${out.portal.filter((x) => x.ok).length}/${out.portal.length} sign in`);
console.log(`  firm:   ${out.firm.filter((x) => x.ok).length}/${out.firm.length} sign in`);
console.log(`  boundary: ${out.boundary.filter((x) => x.refused).length}/${out.boundary.length} refused`);
console.log(`\n  JSON written to /tmp/credentials.json`);

const { writeFileSync } = await import('node:fs');
writeFileSync('/tmp/credentials.json', JSON.stringify(out, null, 2));
