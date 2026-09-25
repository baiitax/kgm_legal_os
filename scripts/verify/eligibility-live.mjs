/**
 * KGM LEGAL OS — LIVE VERIFICATION OF THE ELIGIBILITY LAYER (phase P-1)
 *
 *   node scripts/verify/eligibility-live.mjs [base-url]
 *
 * WHY THIS EXISTS, WHEN THE SUITE ALREADY PROVES THE RULES
 *   tests/security/eligibility.test.ts runs on SQLite, where a refusal is a
 *   trigger's `raise(ABORT)` and every table is readable by the single role that
 *   owns the file. The deployed system is PostgreSQL with row-level security and
 *   two restricted roles, and it has now been wrong eleven times in ways SQLite
 *   could not see: grants without policies, policies whose WITH CHECK was written
 *   for the wrong verb, CHECK constraints on a vocabulary, triggers that exist in
 *   one dialect only.
 *
 *   So the four things this file checks are precisely the four that only the real
 *   database can refute:
 *
 *     1. GRANTS + POLICIES. The four new tables are granted to `firm_api` and not
 *        to `portal_api`, and every one has a policy that ADMITS a legitimate
 *        read. A grant with no policy reads as a permission error, and a policy
 *        with no grant reads as the same error, so only an end-to-end request
 *        distinguishes "secured" from "broken".
 *
 *     2. THE AUDIT VOCABULARY. `audit_events.action` is a CHECK constraint built
 *        from the TypeScript union by migration 0023. MATTER_VIEWED had never been
 *        written to this database. If the constraint were not recreated, the read
 *        would succeed and the audit row would be silently rejected inside
 *        tryWrite — the exact failure mode the design chose to accept for reads,
 *        and therefore the one nothing else would notice.
 *
 *     3. THE GATE ON A REAL WRITE. A suspended licence must stop a real matter
 *        grant through the real RLS-enforced UPDATE, not merely change a reason
 *        string.
 *
 *     4. THE SINGLE-FIRM GUARD. Article 16 is enforced by a trigger against a
 *        real second tenant row.
 *
 * It restores what it changes — a licence suspended here is set back to valid, a
 * granted access is revoked — so it is safe to re-run against production.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

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
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

const results = [];
const record = (label, ok, detail = '') => results.push({ label, ok, detail });
const failed = (r) => `HTTP ${r.status} ${r.text.slice(0, 140)}`;

// ── the database, over the admin connection ────────────────────────────────
const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
const db = new pg.Client({
  connectionString:
    `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@` +
    'aws-0-us-east-1.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false },
});
await db.connect();

const KGM = 'aaaaaaaa-0000-4000-8000-000000000001';
const NAJD = 'bbbbbbbb-0000-4000-8000-000000000002';

console.log(`\nKGM LEGAL OS — eligibility layer, verified live at ${BASE}\n`);

// ── 0 · authenticate ──────────────────────────────────────────────────────
await req('/api/firm/auth/csrf');
const login = await req('/api/firm/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
record('firm sign in', login.status === 200, failed(login));
if (login.status !== 200) { report(); process.exit(1); }

// ── 1 · grants + policies admit a legitimate read ─────────────────────────
const elig = await req('/api/firm/eligibility');
record('GET /api/firm/eligibility (grant + policy admit firm_api)', elig.status === 200, failed(elig));
const members = elig.json?.data?.members ?? [];
record('the register returns every member', members.length === 5, `got ${members.length}`);

const noura = members.find((m) => m.email === 'noura@kgm.example.test');
const mariam = members.find((m) => m.email === 'mariam@kgm.example.test');
const sara = members.find((m) => m.email === 'sara@kgm.example.test');
record('a licensed lawyer reads as entitled', noura?.entitled === true && noura?.reason === 'valid',
  JSON.stringify(noura?.reason));
record('her licence is named', noura?.licences?.[0]?.licenceNumber === 'SA-BAR-11482',
  JSON.stringify(noura?.licences?.[0]?.licenceNumber));
record('a paralegal is not gated', mariam?.requiresLicence === false && mariam?.entitled === true,
  `requiresLicence=${mariam?.requiresLicence} entitled=${mariam?.entitled}`);
record('a finance manager is not gated', sara?.requiresLicence === false && sara?.entitled === true,
  `requiresLicence=${sara?.requiresLicence}`);

// ── 1b · the portal must NOT reach any of it ──────────────────────────────
/*
  The two products share a database and share nothing else. The diligence tables
  are granted to firm_api alone; this asserts through the DATABASE rather than
  through the API, because a portal route that does not exist yet is not evidence
  that the role is denied.
*/
/*
  `has_table_privilege` rather than `information_schema.role_table_grants`, and
  the difference is not cosmetic: the view shows a grant only when the current
  user is the grantor, the grantee or a member of the grantee role. Connected as
  an admin that is not a member of `portal_api`, it returns ZERO ROWS for a role
  that holds every privilege on every table — so an earlier version of this check
  passed by being blind, which is worse than failing.
*/
const tables = ['professional_licences', 'prior_office', 'tenant_relationships', 'eligibility_checks'];

/*
  COLUMN-level, and that is the whole subtlety: every grant in 0027 and 0028 is
  `grant select (col, …)`. `has_table_privilege` answers about TABLE grants and
  returns false for a role that can read every column you care about — so the
  check has to ask `has_column_privilege`, and the earlier version of this line
  passed and failed for the wrong reasons in turn.
*/
const reachable = await db.query(`
  select c.relname as table_name,
         count(*) filter (where has_column_privilege($1, c.oid, a.attname, 'SELECT'))::int as readable,
         count(*) filter (where has_column_privilege($1, c.oid, a.attname, 'INSERT'))::int as writable
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where c.relname = any($2::text[])
   group by c.relname order by c.relname`, ['portal_api', tables]);
const portalTotal = reachable.rows.reduce((n, r) => n + r.readable + r.writable, 0);
record('portal_api can touch NO column of the eligibility tables', portalTotal === 0,
  reachable.rows.map((r) => `${r.table_name}:${r.readable}r/${r.writable}w`).join(' '));

const firmReach = await db.query(`
  select c.relname as table_name,
         count(*) filter (where has_column_privilege($1, c.oid, a.attname, 'SELECT'))::int as readable
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where c.relname = any($2::text[])
   group by c.relname order by c.relname`, ['firm_api', tables]);
const unreadable = firmReach.rows.filter((r) => r.readable === 0).map((r) => r.table_name);
record('firm_api can read all four', unreadable.length === 0, unreadable.join(', '));

const noPolicy = await db.query(`
  select t.name from unnest(array['professional_licences','prior_office',
                                 'tenant_relationships','eligibility_checks']) as t(name)
   where not exists (select 1 from pg_policies p where p.tablename = t.name)`);
record('every new table has at least one policy', noPolicy.rowCount === 0,
  noPolicy.rows.map((r) => r.name).join(', '));

// ── 2 · MATTER_VIEWED reaches the audit table ─────────────────────────────
/*
  Read a matter, then look for the row. This is the only place the CHECK
  constraint built from the TypeScript union is exercised on the real database:
  if the vocabulary does not contain MATTER_VIEWED, the read still returns 200 and
  tryWrite swallows the violation — so absence here is the whole finding.
*/
const matterList = await req('/api/firm/matters');
const matters = matterList.json?.data?.matters ?? [];
record('GET /api/firm/matters', matters.length > 0 && matterList.status === 200, failed(matterList));

const opened = await req(`/api/firm/matters/${matters[0].id}`);
record('GET /api/firm/matters/:id', opened.status === 200, failed(opened));

const seen = await db.query(
  `select reason_code, resource_id, occurred_at from audit_events
    where action = 'MATTER_VIEWED' and resource_id = $1 and tenant_id = $2
    order by occurred_at desc limit 1`, [matters[0].id, KGM]);
record('MATTER_VIEWED is written in PostgreSQL (CHECK vocabulary accepts it)',
  seen.rowCount === 1, seen.rowCount ? '' : 'no audit row — the action was rejected');
record('the audit row records the ACCESS LEVEL, not merely the fact of a look',
  /^access_level:/.test(seen.rows[0]?.reason_code ?? ''), seen.rows[0]?.reason_code ?? '(none)');

// ── 3 · the gate refuses a real grant, on a real update ───────────────────
const faisalId = members.find((m) => m.email === 'faisal@kgm.example.test')?.membershipId;
const mariamId = mariam?.membershipId;
const matterId = matters[0].id;

const suspend = await req(`/api/firm/eligibility/${faisalId}/licences`, {
  method: 'POST',
  body: {
    licenceNumber: 'SA-BAR-20917',
    status: 'suspended',
    statusReference: 'قرار لجنة التأديب 1447/218 — automated verification',
  },
});
record('POST suspend a licence', suspend.status === 200, failed(suspend));
record('suspension withdraws entitlement in the live database',
  suspend.json?.data?.eligibility?.entitled === false &&
  suspend.json?.data?.eligibility?.reason === 'suspended',
  JSON.stringify(suspend.json?.data?.eligibility?.reason));

const refused = await req(`/api/firm/matters/${matterId}/access`, {
  method: 'POST',
  body: { membershipId: faisalId, accessLevel: 'view', reason: 'Automated verification' },
});
record('the gate refuses the matter grant to a suspended lawyer',
  refused.status === 404, failed(refused));

const evidence = await db.query(
  `select outcome, evidence from eligibility_checks
    where subject_kind = 'matter_assignment' and subject_id = $1
    order by evaluated_at desc limit 1`, [matterId]);
record('the refusal is recorded as evidence, naming the rule',
  evidence.rowCount === 1 && evidence.rows[0].outcome === 'fail',
  evidence.rowCount ? '' : 'nothing recorded');

// The refusal must not be a wall: the same grant to an entitled member succeeds.
// Without this, a gate that refuses EVERYONE would pass every check above.
const admitted = await req(`/api/firm/matters/${matterId}/access`, {
  method: 'POST',
  body: { membershipId: mariamId, accessLevel: 'operational', reason: 'Automated verification' },
});
record('the same grant to an entitled member is ADMITTED', admitted.status === 200, failed(admitted));
await req(`/api/firm/matters/${matterId}/access`, {
  method: 'POST',
  body: { membershipId: mariamId, accessLevel: 'none', reason: 'Automated verification cleanup' },
});

// ── 3b · the CREATE branches of the two writes ────────────────────────────
/*
  The suspension above took the UPDATE branch of `upsertLicence`, because the
  licence was already there. The INSERT branch — the one that names `id`,
  `created_at`, `updated_at` and `verified_at` — is exercised only by recording a
  licence for someone who has none, and it is the branch that returned 500 in
  production while every test passed.

  Mariam is a paralegal, so this deliberately grants her a licence: the gate does
  not require one for her, and the row is removed afterwards.
*/
const created = await req(`/api/firm/eligibility/${mariamId}/licences`, {
  method: 'POST',
  body: { licenceNumber: 'SA-BAR-VERIFY-0001', status: 'valid', expiresAt: '2030-01-01' },
});
record('POST a NEW licence (the INSERT branch)', created.status === 200, failed(created));
record('recording a licence for a non-practising role does not gate her',
  created.json?.data?.eligibility?.entitled === true, JSON.stringify(created.json?.data?.eligibility));

const office = await req(`/api/firm/eligibility/${mariamId}/prior-office`, {
  method: 'POST',
  body: {
    officeKind: 'government_body', institution: 'وزارة التجارة — automated verification',
    startedOn: '2005-01-01', endedOn: '2010-01-01',
  },
});
record('POST a prior office (the INSERT branch)', office.status === 200, failed(office));
record('an elapsed window does not bar her', office.json?.data?.barred === false,
  JSON.stringify(office.json?.data));

// ── 4 · Article 16, against a real second tenant ──────────────────────────
let guardFired = false;
let guardMessage = '';
try {
  await db.query(
    `insert into firm_memberships
       (id, tenant_id, user_id, staff_id, status, joined_at, created_at, updated_at)
     select 'ffffffff-0000-4000-8000-0000000fffff', $1, m.user_id, m.staff_id,
            'active', now(), now(), now()
       from firm_memberships m
      where m.tenant_id = $2 and m.user_id = 'dddddddd-0000-4000-8000-000000000011'`,
    [NAJD, KGM]);
} catch (err) {
  guardFired = true;
  guardMessage = err.message;
}
record('a second ACTIVE membership at another firm is refused by the database',
  guardFired && /Article 16/i.test(guardMessage), guardMessage.slice(0, 150));

// Negative control: same lawyer, same second firm, NOT active — must be admitted,
// because that history is what the conflict checks need.
let leftOk = false;
try {
  await db.query(
    `insert into firm_memberships
       (id, tenant_id, user_id, staff_id, status, joined_at, created_at, updated_at)
     select 'fffffffe-0000-4000-8000-0000000fffff', $1, m.user_id, m.staff_id,
            'left', now(), now(), now()
       from firm_memberships m
      where m.tenant_id = $2 and m.user_id = 'dddddddd-0000-4000-8000-000000000011'`,
    [NAJD, KGM]);
  leftOk = true;
} catch (err) {
  guardMessage = err.message;
}
record('a LEFT membership at another firm stays recordable', leftOk, guardMessage.slice(0, 150));

// ── restore ───────────────────────────────────────────────────────────────
await db.query(`delete from firm_memberships where id = 'fffffffe-0000-4000-8000-0000000fffff'`);
await db.query(`delete from professional_licences where licence_number = 'SA-BAR-VERIFY-0001'`);
await db.query(`delete from prior_office where institution like 'وزارة التجارة%automated%'`);
const restore = await req(`/api/firm/eligibility/${faisalId}/licences`, {
  method: 'POST',
  body: { licenceNumber: 'SA-BAR-20917', status: 'valid', expiresAt: '2026-11-30' },
});
record('licence restored to valid', restore.status === 200 &&
  restore.json?.data?.eligibility?.entitled === true, failed(restore));

await db.end();
report();

function report() {
  const pass = results.filter((r) => r.ok).length;
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.ok || !r.detail ? '' : `  — ${r.detail}`}`);
  }
  console.log(`\n  ${pass}/${results.length} checks passed\n`);
  if (pass !== results.length) process.exit(1);
}
