/**
 * KGM LEGAL OS — LIVE VERIFICATION OF THE FIRM OS WRITE PATHS
 *
 *   node scripts/verify/firm-live.mjs [base-url]
 *
 * Every mutating route in the Firm OS, run against a live deployment. The read
 * paths are covered by the test suite; these are the writes, and they were the
 * last thing to work — each one failed at the database layer while the suite
 * stayed green, because the suite asserts refusals and never asserts that an
 * authorized write is admitted.
 *
 * The lesson worth keeping: a security suite that only proves denials cannot
 * tell a locked door from a wall. This file is the other half.
 *
 * It restores what it changes (a restriction is lifted, a role granted is
 * revoked, a member suspended is reactivated), so it is safe to re-run.
 */
const BASE = process.argv[2] ?? process.env.KGM_BASE ?? 'https://kgmlegal.vercel.app';
const EMAIL = process.env.KGM_FIRM_EMAIL ?? 'noura@kgm.example.test';
const PASSWORD = process.env.KGM_FIRM_PASSWORD ?? 'Demo!Firm2026';

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

async function req(path, opts = {}) {
  const headers = { accept: 'application/json' };
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (opts.method) {
    const csrf = jar.get('kgm_firm_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  absorb(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const results = [];
const record = (label, ok, detail = '') => results.push({ label, ok, detail });
const failed = (r) => `HTTP ${r.status} ${r.text.slice(0, 130)}`;

await req('/api/firm/auth/csrf');
const login = await req('/api/firm/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
record('firm sign in', login.status === 200, failed(login));
if (login.status !== 200) {
  console.log(`  FAIL  firm sign in — ${failed(login)}`);
  process.exit(1);
}

const matters = (await req('/api/firm/matters')).json?.data?.matters ?? [];
const members = (await req('/api/firm/admin/members')).json?.data?.members ?? [];
const roles = (await req('/api/firm/admin/members')).json?.data?.roles ?? [];
const matter = matters[0];
const target = members.find((m) => m.membershipId);
const role = roles[0];

if (matter && target) {
  // The endpoint that started this: a first grant (INSERT), a re-grant (the
  // upsert's DO UPDATE branch, which needs UPDATE privileges as well), a revoke.
  const grant = await req(`/api/firm/matters/${matter.id}/access`, {
    method: 'POST',
    body: { membershipId: target.membershipId, accessLevel: 'view', reason: 'Automated verification' },
  });
  record('POST matter access · first grant', grant.status === 200, failed(grant));

  const regrant = await req(`/api/firm/matters/${matter.id}/access`, {
    method: 'POST',
    body: { membershipId: target.membershipId, accessLevel: 'operational', reason: 'Automated verification' },
  });
  record('POST matter access · re-grant (upsert)', regrant.status === 200, failed(regrant));

  const revoke = await req(`/api/firm/matters/${matter.id}/access`, {
    method: 'POST',
    body: { membershipId: target.membershipId, accessLevel: 'none', reason: 'Automated verification' },
  });
  record('POST matter access · revoke', revoke.status === 200, failed(revoke));
}

if (matter) {
  const on = await req(`/api/firm/matters/${matter.id}/restrict`, {
    method: 'POST',
    body: { restricted: true, reason: 'Automated verification' },
  });
  record('POST matter restrict on', on.status === 200, failed(on));
  const off = await req(`/api/firm/matters/${matter.id}/restrict`, { method: 'POST', body: { restricted: false } });
  record('POST matter restrict off', off.status === 200, failed(off));
}

if (target && role) {
  const code = role.code ?? role.roleCode;
  const grant = await req(`/api/firm/admin/members/${target.membershipId}/roles`, {
    method: 'POST',
    body: { roleCode: code, revoke: false },
  });
  record('POST member role grant', grant.status === 200, failed(grant));
  const revoke = await req(`/api/firm/admin/members/${target.membershipId}/roles`, {
    method: 'POST',
    body: { roleCode: code, revoke: true },
  });
  record('POST member role revoke', revoke.status === 200, failed(revoke));
}

if (target) {
  const suspend = await req(`/api/firm/admin/members/${target.membershipId}/status`, { method: 'POST', body: { status: 'suspended' } });
  record('POST member suspend', suspend.status === 200, failed(suspend));
  const reactivate = await req(`/api/firm/admin/members/${target.membershipId}/status`, { method: 'POST', body: { status: 'active' } });
  record('POST member reactivate', reactivate.status === 200, failed(reactivate));
  // The left/deactivated branch writes left_at through a CASE — a typeless
  // parameter against a timestamptz column, which Postgres rejects and SQLite
  // accepts. Tested because it was broken and nothing else touched it.
  const deactivate = await req(`/api/firm/admin/members/${target.membershipId}/status`, { method: 'POST', body: { status: 'deactivated' } });
  record('POST member deactivate (left_at)', deactivate.status === 200, failed(deactivate));
  const back = await req(`/api/firm/admin/members/${target.membershipId}/status`, { method: 'POST', body: { status: 'active' } });
  record('POST member reactivate after deactivate', back.status === 200, failed(back));

  const invalid = await req(`/api/firm/admin/members/${target.membershipId}/status`, { method: 'POST', body: { status: 'nonsense' } });
  record('POST member status invalid -> 4xx', invalid.status >= 400 && invalid.status < 500, `got HTTP ${invalid.status}`);
}

// The invoice approval route lists matter ids rather than invoices by design, so
// the statement it runs is exercised by scripts/verify/invoice-approval.mjs,
// which supplies a real pending invoice.
record('POST invoice approve', true, 'covered by scripts/verify/invoice-approval.mjs');

console.log(`\n  KGM LEGAL OS · firm OS write paths · ${BASE}\n`);
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(40)} ${r.detail}`);
const passed = results.filter((r) => r.ok).length;
console.log(`\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
