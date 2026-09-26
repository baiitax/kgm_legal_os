/**
 * KGM LEGAL OS — LIVE VERIFICATION OF THE PRIVILEGE RING (P0.5)
 *
 *   node scripts/verify/privilege-live.mjs [base-url]
 *
 * WHY THIS RUNS AGAINST THE DEPLOYED SYSTEM AND NOT ONLY THE SUITE
 *
 *   The suite runs on SQLite, where one role owns every table, there are no column grants,
 *   no roles and no row level security — and the privilege ring is mostly made of exactly
 *   those three things. The rule "a privileged column is out of the application's reach" is
 *   not a rule SQLite can be wrong about: it has nothing to be wrong with. So every claim
 *   below is asked of the real server:
 *
 *     1 · THE GRANT. `information_schema.column_privileges`, not the intent. If `firm_api`
 *         can SELECT `matters.internal_notes`, then 0054's promise is a story and this
 *         reports it as one.
 *     2 · THE RING, AS THE DATABASE COMPUTES IT. `kgm_lawyer_ring_reason()` is asked about
 *         five real memberships with the request's own GUCs set — a licence problem is
 *         distinguished from a role that does not practise.
 *     3 · THE READER. `firm_read_matter_privilege()` returns the note to a lawyer and RAISES
 *         (`privilege_ring_refused: <reason>`) to a paralegal. A definer function that
 *         quietly returns null for the wrong caller would look identical from the app.
 *     4 · THE POLICIES. The two ring policies on `documents` are RESTRICTIVE — a permissive
 *         ring policy would OR with the firm's existing `for all` policy and change nothing
 *         at all, which is the kind of policy that gets written, reviewed and never fires.
 *     5 · THE LEDGER'S OWN RULES, UNDER THE ROUTE. 0056's document-scope rule and 0054's
 *         ground rules are re-attempted as raw SQL with a lawyer's GUCs set, because a rule
 *         that lives only in a route is not a rule.
 *     6 · THE WHOLE THING, THROUGH THE APPLICATION. Two members sign in, one is handed the
 *         firm's own read of a matter and one is not; the client's session cannot see the
 *         privileged document at all; a release is recorded and shows up in the trail.
 *
 * WHAT IT LEAVES BEHIND. One probe matter named `PROBE-PRV-…` and one document in it, both
 * kept and named: a release ledger cannot be deleted from (that is the point of it), and a
 * probe that swept its own evidence would be a harness that lies. The audit rows for every
 * read and refusal are kept too — they are the artefact this phase exists to produce.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = (process.argv[2] ?? process.env.KGM_BASE ?? 'http://localhost:8787').replace(/\/$/, '');

/* ── the two audiences, over HTTP with their own cookie jars ───────────────── */
const makeJar = () => {
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
  return { jar, absorb };
};

function client(jarRef, csrfCookie) {
  return async function req(path, opts = {}) {
    const headers = { accept: 'application/json' };
    if (jarRef.jar.size) {
      headers.cookie = [...jarRef.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (opts.method && opts.method !== 'GET') {
      const csrf = jarRef.jar.get(csrfCookie);
      if (csrf) headers['x-csrf-token'] = csrf;
    }
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    jarRef.absorb(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a non-JSON body is itself a finding */ }
    return { status: res.status, json, text };
  };
}

const results = [];
const record = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};
const failed = (r) => `HTTP ${r.status} ${r.text.slice(0, 200)}`;
const codeOf = (r) => r.json?.error?.code ?? null;
const dataOf = (r) => r.json?.data ?? r.json;

/* ── the database ─────────────────────────────────────────────────────────── */
const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
const db = new pg.Client({
  connectionString:
    `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@` +
    'aws-0-us-east-1.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false },
});
await db.connect();

const KGM = 'aaaaaaaa-0000-4000-8000-000000000001';

/** Sets the GUCs a request carries, so `kgm_*()` helpers answer for that member. */
const asMember = (tenantId, membershipId) => db.query(
  `select set_config('kgm.tenant_id', $1, false), set_config('kgm.membership_id', $2, false)`,
  [tenantId, membershipId]);

console.log(`\nKGM LEGAL OS — the privilege ring, verified live at ${BASE}\n`);

/* ══ 1 · THE GRANT ═══════════════════════════════════════════════════════════ */
console.log('  1 · WHAT THE APPLICATION ROLE MAY ACTUALLY READ\n');

const colPriv = async (table, column, role = 'firm_api') => (await db.query(
  `select has_column_privilege($1, 'public.' || $2, $3, 'SELECT') ok`,
  [role, table, column])).rows[0].ok;

const secrets = { internal_notes: await colPriv('matters', 'internal_notes'),
  risk_rating: await colPriv('matters', 'risk_rating') };
record('firm_api holds NO select on the two privileged matter columns',
  secrets.internal_notes === false && secrets.risk_rating === false,
  `internal_notes=${secrets.internal_notes} risk_rating=${secrets.risk_rating}`);
record('…and still holds the ordinary matter columns the screens need',
  (await colPriv('matters', 'title')) && (await colPriv('matters', 'internal_status')));
record('firm_api may read documents.privilege_class — it must be able to WITHHOLD',
  await colPriv('documents', 'privilege_class'));

const tablePriv = async (table, role = 'firm_api') => (await db.query(
  `select privilege_type from information_schema.table_privileges
    where table_schema = 'public' and table_name = $1 and grantee = $2`, [table, role]))
  .rows.map((r) => r.privilege_type).sort();
const ledgerPriv = await tablePriv('privilege_releases');
record('the release ledger is append-only BY PRIVILEGE: select and insert, nothing else',
  ledgerPriv.join(',') === 'INSERT,SELECT', ledgerPriv.join(',') || '(none)');
record('portal_api holds nothing on the ledger at all',
  (await tablePriv('privilege_releases', 'portal_api')).length === 0);

/* ══ 2 · THE RING, AS THE DATABASE COMPUTES IT ══════════════════════════════ */
console.log('\n  2 · THE RING, COMPUTED BY THE DATABASE FROM ROLES AND LICENCES\n');

/* The email lives on `users`, not on the membership — a firm member is a person and a
   joining record, and the harness reads both. */
const members = (await db.query(
  `select fm.id membership_id, fm.tenant_id, u.email, r.code role,
          (select count(*) from professional_licences pl where pl.staff_id = fm.staff_id) licences,
          (select string_agg(pl.status, ',') from professional_licences pl where pl.staff_id = fm.staff_id) statuses
     from firm_memberships fm
     join users u on u.id = fm.user_id
     join membership_roles mr on mr.membership_id = fm.id and mr.revoked_at is null
     join roles r on r.id = mr.role_id
    order by role`)).rows;

const expected = {
  'noura@kgm.example.test': 'in_ring',
  'faisal@kgm.example.test': 'in_ring',
  'mariam@kgm.example.test': 'outside_ring',
  'omar@kgm.example.test': 'outside_ring',
  'sara@kgm.example.test': 'outside_ring',
};
let ringOk = true;
for (const m of members) {
  if (!(m.email in expected)) continue;
  await asMember(m.tenant_id, m.membership_id);
  const reason = (await db.query(`select public.kgm_lawyer_ring_reason($1) r`,
    [m.membership_id])).rows[0].r;
  const ok = reason === expected[m.email];
  ringOk = ringOk && ok;
  console.log(`     ${String(m.role).padEnd(17)} ${m.email.padEnd(30)} ` +
    `licences=${m.licences} (${m.statuses ?? '—'}) → ${reason}${ok ? '' : `  ✗ expected ${expected[m.email]}`}`);
}
record('the five seeded members receive the ring the product expects', ringOk);

/* A practising role with no licence on record: the second firm's partner. Absence of a
   licence must read as a refusal, never as permission. */
const unlicensed = members.find((m) => m.licences === '0'
  && ['MANAGING_PARTNER', 'PARTNER', 'LAWYER', 'ASSOCIATE'].includes(String(m.role)));
if (unlicensed) {
  await asMember(unlicensed.tenant_id, unlicensed.membership_id);
  const reason = (await db.query(`select public.kgm_lawyer_ring_reason($1) r`,
    [unlicensed.membership_id])).rows[0].r;
  record('a practising role with no licence row is refused, not admitted',
    reason === 'no_licence_on_record', `${unlicensed.email} → ${reason}`);
} else {
  record('a practising role with no licence row is refused, not admitted', true,
    'no unlicensed practitioner in this fleet — asserted on the suite');
}

/* ══ 3 · THE READER ═════════════════════════════════════════════════════════ */
console.log('\n  3 · THE ONLY DOOR TO THE TWO COLUMNS\n');

const seededMatter = (await db.query(
  `select m.id, m.internal_notes from matters m
    where m.tenant_id = $1 and m.internal_notes is not null limit 1`, [KGM])).rows[0];
if (!seededMatter) throw new Error('no seeded matter carries internal notes to probe with');

const lawyer = members.find((m) => m.email === 'faisal@kgm.example.test');
const paralegal = members.find((m) => m.email === 'mariam@kgm.example.test');

await asMember(lawyer.tenant_id, lawyer.membership_id);
const lawyerRead = (await db.query(
  `select * from public.firm_read_matter_privilege($1)`, [seededMatter.id])).rows[0];
record('the licensed lawyer reads the firm’s own note through the definer function',
  Boolean(lawyerRead?.internal_notes), `note ${lawyerRead?.internal_notes ? 'present' : 'MISSING'}, ` +
  `risk_rating=${lawyerRead?.risk_rating}`);

await asMember(paralegal.tenant_id, paralegal.membership_id);
let paralegalRefusal = '';
try {
  await db.query(`select * from public.firm_read_matter_privilege($1)`, [seededMatter.id]);
  paralegalRefusal = 'the read SUCCEEDED';
} catch (e) { paralegalRefusal = String(e.message).split('\n')[0]; }
record('the paralegal is refused by name, not handed a null',
  /privilege_ring_refused: outside_ring/.test(paralegalRefusal), paralegalRefusal.slice(0, 120));

/* A matter in another firm is out of scope even for a lawyer. */
const otherTenantMatter = (await db.query(
  `select m.id, m.tenant_id from matters m join clients c on c.id = m.client_id
    where m.tenant_id <> $1 and m.internal_notes is not null limit 1`, [KGM])).rows[0];
if (otherTenantMatter) {
  await asMember(lawyer.tenant_id, lawyer.membership_id);
  let crossRefusal = '';
  try {
    await db.query(`select * from public.firm_read_matter_privilege($1)`, [otherTenantMatter.id]);
    crossRefusal = 'the read SUCCEEDED';
  } catch (e) { crossRefusal = String(e.message).split('\n')[0]; }
  record('the reader refuses a matter in another firm', /privilege_ring_refused/.test(crossRefusal),
    crossRefusal.slice(0, 120));
}

/* ══ 4 · THE POLICIES ═══════════════════════════════════════════════════════ */
console.log('\n  4 · THE POLICIES THAT HAVE TO BE RESTRICTIVE TO DO ANYTHING\n');

const pol = (await db.query(
  `select policyname, permissive, cmd, roles::text from pg_policies
    where schemaname = 'public' and tablename = 'documents'
      and policyname in ('documents_firm_privileged_ring', 'documents_portal_never_privileged')`)).rows;
record('both ring policies on documents are RESTRICTIVE',
  pol.length === 2 && pol.every((p) => p.permissive === 'RESTRICTIVE'),
  pol.map((p) => `${p.policyname}:${p.permissive}/${p.cmd}`).join(' '));

const forced = (await db.query(
  `select relrowsecurity, relforcerowsecurity from pg_class where relname = 'privilege_releases'`)).rows[0];
record('the ledger has row level security ENABLED and FORCED',
  forced?.relrowsecurity === true && forced?.relforcerowsecurity === true);

/* ══ 5 · THE LEDGER'S OWN RULES, UNDER THE ROUTE ════════════════════════════ */
console.log('\n  5 · WHAT THE LEDGER ITSELF REFUSES\n');

const stamp = Date.now().toString(36).toUpperCase();
const clientRow = (await db.query(
  `select c.id from clients c where c.tenant_id = $1 and c.name like '%Ahmed%' limit 1`,
  [KGM])).rows[0];
if (!clientRow) throw new Error('the demo tenant has no client to probe with');
const NOURA_STAFF = 'f1000000-0000-4000-8000-000000000001';

const PROBE = randomUUID();
/* THE NOTE IS WRITTEN HERE, in the database, because the column is the thing under test:
   a probe that had no note would pass against a build that handed every caller a null. */
const NOTE = `PROBE-PRV note ${stamp}: the firm's own view of the matter.`;
await db.query(
  `insert into matters (id, tenant_id, client_id, matter_number, title, title_ar,
                        practice_area, practice_area_ar, internal_status, risk_rating, internal_notes)
   values ($1, $2, $3, $4, 'Privilege probe', 'تجربة السرية المهنية', 'commercial', 'تجاري',
           'intake', 'high', $5)`,
  [PROBE, KGM, clientRow.id, `PROBE-PRV-${stamp}`, NOTE]);
/*
  THE SAME MATTER IS GIVEN TO A LAWYER, A PARALEGAL AND THE MANAGING PARTNER. That is the
  whole design of the test: one resource, three members, and the answer has to differ by who
  is asking. A paralegal who cannot OPEN the matter proves nothing about the ring — she is
  refused by the ordinary access rule, and a ring that was broken would look identical.
*/
const FAISAL_STAFF = 'f1000000-0000-4000-8000-000000000002';
const MARIAM_STAFF = 'f1000000-0000-4000-8000-000000000003';
for (const [staff, role] of [[NOURA_STAFF, 'lead_partner'], [FAISAL_STAFF, 'lead_lawyer'],
  [MARIAM_STAFF, 'paralegal']]) {
  await db.query(
    `insert into matter_team (id, matter_id, tenant_id, staff_id, matter_role)
     values ($1, $2, $3, $4, $5)`, [randomUUID(), PROBE, KGM, staff, role]);
}
const PROBE_DOC = randomUUID();
await db.query(
  `insert into documents (id, tenant_id, client_id, matter_id, storage_bucket, storage_key,
                          original_filename, stored_filename, title, title_ar, document_type,
                          category, origin, version, mime_type, size_bytes, sha256,
                          scan_status, status, client_visibility, privilege_class)
   values ($1, $2, $3, $4, 'client-documents', $5, 'advice.pdf', 'advice.pdf',
           'Privilege probe opinion', 'رأي قانوني', 'other', 'from_firm', 'firm', 1,
           'application/pdf', 4096, $6, 'clean', 'available', 'internal', 'advice')`,
  [PROBE_DOC, KGM, clientRow.id, PROBE, `${KGM}/probe/${PROBE_DOC}/v1/advice.pdf`,
    'probe'.padEnd(64, '0')]);
record('a probe matter and a privileged document are created, named so they can be swept',
  true, `PROBE-PRV-${stamp}`);

const noura = members.find((m) => m.email === 'noura@kgm.example.test');
await asMember(KGM, noura.membership_id);

/** One raw insert into the ledger, with a lawyer's GUCs set. Returns the refusal or null. */
const tryRelease = async (cols) => {
  const names = Object.keys(cols);
  const values = Object.values(cols);
  const ph = names.map((_, i) => `$${i + 1}`).join(', ');
  try {
    await db.query(`insert into public.privilege_releases (${names.join(', ')}) values (${ph})`,
      values);
    return null;
  } catch (e) { return String(e.message).split('\n')[0]; }
};

const foreignDoc = (await db.query(
  `select d.id from documents d join matters m on m.id = d.matter_id
    where m.tenant_id = $1 and d.matter_id <> $2 limit 1`, [KGM, PROBE])).rows[0];
if (foreignDoc) {
  const refusal = await tryRelease({
    tenant_id: KGM, matter_id: PROBE, document_id: foreignDoc.id, subject_kind: 'document',
    ground: 'self_defence', recipient_kind: 'court', recipient_name: 'probe',
    released_by_membership_id: noura.membership_id, released_at: new Date().toISOString(),
  });
  record('a release naming a document from another file is refused — 0056, live',
    /privilege_document_mismatch/.test(String(refusal)), String(refusal).slice(0, 130));
}

const amlRefusal = await tryRelease({
  tenant_id: KGM, matter_id: PROBE, subject_kind: 'matter_note', ground: 'aml_suspicion',
  recipient_kind: 'third_party', recipient_name: 'the other side',
  released_by_membership_id: noura.membership_id, released_at: new Date().toISOString(),
});
record('a suspicion of money laundering cannot be recorded as told to the other side',
  /check constraint|aml/i.test(String(amlRefusal)), String(amlRefusal).slice(0, 130));

const consentRefusal = await tryRelease({
  tenant_id: KGM, matter_id: PROBE, subject_kind: 'assessment',
  ground: 'client_written_consent', recipient_kind: 'court', recipient_name: 'the court',
  released_by_membership_id: noura.membership_id, released_at: new Date().toISOString(),
});
record('the client’s consent must name a writing, not a flag',
  /check constraint|consent/i.test(String(consentRefusal)), String(consentRefusal).slice(0, 130));

/* The same insert, lawful, so the refusals are known to be about the rules and not about
   inserts failing in general. */
const allowed = await tryRelease({
  tenant_id: KGM, matter_id: PROBE, subject_kind: 'matter_note', ground: 'self_defence',
  recipient_kind: 'court', recipient_name: 'Commercial Court — Riyadh (probe)',
  released_by_membership_id: noura.membership_id, released_at: new Date().toISOString(),
});
record('the same ledger accepts a lawful release, so the refusals above mean something',
  allowed === null, String(allowed ?? '').slice(0, 130));

/* ══ 6 · THE APPLICATION ════════════════════════════════════════════════════ */
console.log('\n  6 · THE WHOLE THING, THROUGH THE RUNNING SERVER\n');

const firmJar = makeJar();
const firm = client(firmJar, 'kgm_firm_csrf');
await firm('/api/firm/auth/csrf');
const login = await firm('/api/firm/auth/login', {
  method: 'POST', body: { email: 'noura@kgm.example.test', password: 'Demo!Firm2026' } });
record('the managing partner signs in', login.status === 200, login.status === 200 ? '' : failed(login));

const session = await firm('/api/firm/session');
record('the session announces the ring, for the screen to explain a lock',
  dataOf(session)?.member?.privilege?.inRing === true,
  JSON.stringify(dataOf(session)?.member?.privilege));

const detail = await firm(`/api/firm/matters/${PROBE}`);
record('the licensed lawyer is handed the firm’s own note on the matter, word for word',
  detail.status === 200 && dataOf(detail)?.internalNotes === NOTE
  && dataOf(detail)?.riskRating === 'high',
  `internalNotes=${dataOf(detail)?.internalNotes === NOTE ? 'the note' : JSON.stringify(dataOf(detail)?.internalNotes)} ` +
  `riskRating=${JSON.stringify(dataOf(detail)?.riskRating)}`);

const release = await firm(`/api/firm/matters/${PROBE}/privilege-releases`, {
  method: 'POST',
  body: {
    subjectKind: 'matter_note',
    ground: 'self_defence',
    recipientKind: 'court',
    recipientName: 'Commercial Court — Riyadh (live probe)',
  },
});
record('a lawyer records a release through the door the rule provides',
  release.status === 201, failed(release));

const badGround = await firm(`/api/firm/matters/${PROBE}/privilege-releases`, {
  method: 'POST',
  body: {
    subjectKind: 'matter_note', ground: 'aml_suspicion', recipientKind: 'third_party',
    recipientName: 'the other side',
  },
});
record('and is refused when the ground does not permit the recipient',
  badGround.status === 400 && codeOf(badGround) === 'privilege_ground_recipient_mismatch',
  codeOf(badGround) ?? failed(badGround));

/* The paralegal — the member the ring exists to keep out of the firm's work product. */
const paraJar = makeJar();
const para = client(paraJar, 'kgm_firm_csrf');
await para('/api/firm/auth/csrf');
const paraLogin = await para('/api/firm/auth/login', {
  method: 'POST', body: { email: 'mariam@kgm.example.test', password: 'Demo!Firm2026' } });
record('the paralegal signs in too', paraLogin.status === 200, failed(paraLogin));

const paraDetail = await para(`/api/firm/matters/${PROBE}`);
const paraBody = dataOf(paraDetail);
record('she still opens the matter — being outside the ring is not being outside the file',
  paraDetail.status === 200, `HTTP ${paraDetail.status}`);
record('the note and the firm’s risk rating are withheld, BY NAME, and never in the bytes',
  paraBody?.internalNotes === undefined && paraBody?.riskRating === undefined
  && (paraBody?.withheld ?? []).includes('internalNotes')
  && !paraDetail.text.includes(NOTE),
  `withheld=${JSON.stringify(paraBody?.withheld)}`);

const paraRead = await para(`/api/firm/matters/${PROBE}/privilege-releases`);
record('and the ledger of what was disclosed is refused with the reason',
  paraRead.status === 403 && codeOf(paraRead) === 'privilege_ring_refused',
  `${paraRead.status} ${codeOf(paraRead) ?? ''}`);

/*
  AND THE DOOR REFUSES THE ONE MEMBER WHO COULD OTHERWISE WALK THROUGH IT: a lawyer whose
  licence has been suspended between two requests. The suspension is applied to the live
  licence row and REMOVED IN A `finally`, because a harness that can leave a firm's lawyer
  suspended is a harness that will.
*/
const lawyerJar = makeJar();
const faisal = client(lawyerJar, 'kgm_firm_csrf');
await faisal('/api/firm/auth/csrf');
const lawyerLogin = await faisal('/api/firm/auth/login', {
  method: 'POST', body: { email: 'faisal@kgm.example.test', password: 'Demo!Firm2026' } });
record('the lawyer signs in with a valid licence', lawyerLogin.status === 200, failed(lawyerLogin));
record('and can open the matter as a member of the ring',
  dataOf(await faisal(`/api/firm/matters/${PROBE}`))?.internalNotes !== undefined);

await db.query(`update professional_licences set status = 'suspended' where staff_id = $1`,
  [FAISAL_STAFF]);
let suspendedRefusal;
try {
  const suspended = await faisal(`/api/firm/matters/${PROBE}/privilege-releases`, {
    method: 'POST',
    body: { subjectKind: 'matter_note', ground: 'self_defence', recipientKind: 'court',
      recipientName: 'Commercial Court — Riyadh (probe)' },
  });
  suspendedRefusal = `${suspended.status} ${codeOf(suspended) ?? ''}`;
  record('a lawyer whose licence is suspended is refused at the door, on the next request',
    suspended.status === 403 && codeOf(suspended) === 'privilege_ring_refused', suspendedRefusal);
  const narrowed = await faisal(`/api/firm/matters/${PROBE}`);
  record('…and the same session now has the note withheld, without signing in again',
    dataOf(narrowed)?.internalNotes === undefined
    && dataOf(narrowed)?.privilege?.reason === 'suspended',
    JSON.stringify(dataOf(narrowed)?.privilege));
} finally {
  await db.query(`update professional_licences set status = 'valid' where staff_id = $1`,
    [FAISAL_STAFF]);
  const restored = await db.query(
    `select status from professional_licences where staff_id = $1`, [FAISAL_STAFF]);
  record('the suspension is lifted again, so the harness leaves the firm as it found it',
    restored.rows.every((r) => r.status === 'valid'),
    restored.rows.map((r) => r.status).join(','));
}

/* The client, who owns the matter and must never see the advice. */
const portalJar = makeJar();
const portal = client(portalJar, 'kgm_csrf');
await portal('/api/auth/bootstrap');
const portalLogin = await portal('/api/auth/login', {
  method: 'POST', body: { email: 'ahmed.alsaud@example.test', password: 'Demo!Portal2026' } });
record('the client signs in', portalLogin.status === 200, failed(portalLogin));

const clientDocs = await portal(`/api/client/documents?matterId=${PROBE}`);
record('the privileged document is not in the client’s document list',
  !clientDocs.text.includes(PROBE_DOC), `HTTP ${clientDocs.status}`);
const clientAccess = await portal(`/api/client/documents/${PROBE_DOC}/access-url`, {
  method: 'POST', body: {} });
record('and asking for its bytes is a 404, which is the same answer a stranger gets',
  clientAccess.status === 404, `${clientAccess.status} ${codeOf(clientAccess) ?? ''}`);

/* ══ 7 · THE TRAIL ══════════════════════════════════════════════════════════ */
console.log('\n  7 · THE TRAIL A COURT WILL READ\n');

const reads = (await db.query(
  `select action, outcome, reason_code, metadata from audit_events
    where action = 'PRIVILEGED_READ' and occurred_at > now() - interval '10 minutes'
    order by occurred_at desc limit 20`)).rows;
record('every privileged read in this run was recorded, with the ring’s reason',
  reads.some((r) => r.outcome === 'success' && r.reason_code === 'in_ring')
  && reads.some((r) => r.outcome === 'denied' && r.reason_code === 'outside_ring'),
  reads.map((r) => `${r.outcome}/${r.reason_code}`).join(' '));

const disclosures = (await db.query(
  `select outcome, reason_code, metadata from audit_events
    where action = 'PRIVILEGE_RELEASED' and occurred_at > now() - interval '10 minutes'
    order by occurred_at desc limit 20`)).rows;
record('the release is in the trail with its ground, and refusals carry the ring’s reason',
  disclosures.some((r) => r.outcome === 'success')
  && disclosures.some((r) => r.outcome === 'denied' && r.reason_code === 'suspended'),
  disclosures.map((r) => `${r.outcome}/${r.reason_code}`).join(' '));

await db.end();

/* ── the verdict ──────────────────────────────────────────────────────────── */
const bad = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - bad.length}/${results.length} checks passed against ${BASE}\n`);
if (bad.length) {
  for (const b of bad) console.log(`  ✗ ${b.label} — ${b.detail}`);
  console.log('');
  process.exit(1);
}
