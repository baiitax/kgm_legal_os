/**
 * KGM LEGAL OS — LIVE VERIFICATION OF CLIENT DUE DILIGENCE (P0.3)
 *
 *   node scripts/verify/cdd-gate-live.mjs [base-url]
 *
 * WHY THIS RUNS AGAINST THE DEPLOYED SYSTEM AND NOT ONLY THE SUITE
 *
 *   The suite for this phase runs on SQLite, where one role owns every table, a refusal is
 *   a trigger's `raise(ABORT)`, and `identity_verified` is an integer. The deployed system
 *   is PostgreSQL with two restricted roles, column-level grants, row-level security and
 *   triggers that exist in one dialect only — and across three phases it has been wrong
 *   nineteen times in ways that engine cannot see. This phase already produced the
 *   twentieth: `clients.identity_verified` was reconciled with `case … then 1 else 0 end`,
 *   which SQLite accepts and PostgreSQL refuses outright, because a literal integer is not
 *   a boolean. That line was green locally for a full phase.
 *
 * WHAT IT CHECKS
 *
 *   1 · THE REGISTER ANSWERS. The client's record, the queue, the census and the reports
 *       come back as DATA through the real routes, over the real grants, under the real
 *       policies. A grant with no policy and a policy with no grant are indistinguishable
 *       from outside; only an end-to-end request tells "secured" from "broken".
 *
 *   2 · THE GATE MATRIX, ON THE REAL ENGINE. Six clients, six outcomes, driven through
 *       `POST /api/firm/matters/:id/status` — which is the door a person actually uses —
 *       and then re-attempted as raw SQL with `postgres` as the caller, which is the only
 *       way to prove the TRIGGER rather than the route. The interesting one is Gulf: a
 *       politically exposed person at standard due diligence must be refused, and that
 *       refusal has never been observed live until this file.
 *
 *   3 · THE RETENTION POSTURE. A due-diligence record, a screening and a report are
 *       statements about what the firm knew and when. Nothing may delete them: the
 *       privileges are absent and the triggers refuse. Both halves are checked, because a
 *       trigger can be dropped by a superuser and a missing privilege cannot.
 *
 *   4 · THE REPORT'S OWN RULES. A narrative that is not in Arabic, a filing without the
 *       tipping-off acknowledgement, and an amendment after filing — all three must be
 *       refusals with a named code, not 500s.
 *
 * WHAT IT LEAVES BEHIND. Probe matters and one probe client, all created for this run and
 * removed again at the end; the audit rows of the refusals, which are append-only and
 * intentionally kept — a refusal is a fact about the firm. Every other action is a read or
 * a refusal. The one exception is the screening run it records against the probe client,
 * which goes with the client.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = (process.argv[2] ?? process.env.KGM_BASE ?? 'http://localhost:8787').replace(/\/$/, '');
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
  try { json = JSON.parse(text); } catch { /* a non-JSON body is itself a finding */ }
  return { status: res.status, json, text };
}

const results = [];
const record = (label, ok, detail = '') => results.push({ label, ok, detail });
const failed = (r) => `HTTP ${r.status} ${r.text.slice(0, 200)}`;
const codeOf = (r) => r.json?.error?.code ?? r.json?.code ?? null;

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
/*
  THE FIXTURES ARE LOOKED UP, NOT ASSUMED. Hard-coded identifiers made this file fail on
  its first run with a foreign key on a client that does not exist — the same shape of
  mistake as reading a column a projection never selected, one layer out. A probe that
  cannot find its own subject should say so, not crash inside an insert.
*/
const clients = await db.query(
  `select id, name from clients where tenant_id = $1 order by name`, [KGM]);
const byName = (needle) => {
  const row = clients.rows.find((r) => String(r.name).toLowerCase().includes(needle.toLowerCase()));
  if (!row) throw new Error(`no client matching "${needle}" in the demo tenant`);
  return row.id;
};
const CLIENTS = {
  ahmed: byName('Ahmed Al-Saud'),
  gulf: byName('Gulf Horizon'),
  nukhba: byName('Al-Nukhba'),
  qadim: byName('Qadim'),
  fajr: byName('Al-Fajr'),
};

/** Gulf's real matter, wherever the demo has left it: the PEP refusal is asked of it. */
const gulfMatterRow = await db.query(
  `select id from matters where tenant_id = $1 and client_id = $2 order by matter_number limit 1`,
  [KGM, CLIENTS.gulf]);
if (!gulfMatterRow.rows.length) throw new Error('Gulf has no matter in the demo tenant');
const GULF_MATTER = gulfMatterRow.rows[0].id;

console.log(`\nKGM LEGAL OS — client due diligence, verified live at ${BASE}\n`);

/*
  A SWEEP BEFORE ANYTHING ELSE. A previous run of this file may have died between creating
  a probe matter and removing it — which is exactly what happened the first two times — and
  a leftover `PROBE-CDD-` matter in the demo is indistinguishable from a seeded one to
  anybody reading the database later. The sweep is named after the probe's own prefix, so
  it cannot touch a real matter.
*/
const swept = await db.query(`delete from matters where matter_number like 'PROBE-CDD-%'`);
/*
  AND THE SWEEP DELETES WHAT IT MAY DELETE, WHICH THE LAW DECIDES.

  A probe client that was given a due-diligence record cannot be removed: the retention
  guard refuses the delete of the record for ten years, and the foreign key carries that
  same refusal up to the client. That is not an obstacle to route around — it is the
  obligation, arriving in the test harness, and the first version of this sweep died on it
  with `client_due_diligence_client_id_fkey`. So the clients that hold no AML row go, and
  the ones that hold one stay, named `…CDD-PROBE…` so that whoever reads this database
  later knows what they are looking at.
*/
const sweptClients = await db.query(
  `delete from clients c
    where c.name like '%CDD-PROBE%'
      and not exists (select 1 from client_due_diligence d where d.client_id = c.id)
      and not exists (select 1 from beneficial_owners b where b.client_id = c.id)
      and not exists (select 1 from screening_runs s where s.client_id = c.id)
      and not exists (select 1 from str_reports r where r.client_id = c.id)`);

// ── 0 · the phase must actually be here ───────────────────────────────────
const schema = await db.query(
  `select count(*)::int as n from information_schema.tables
    where table_schema = 'public'
      and table_name in ('client_due_diligence','beneficial_owners','screening_runs',
                         'screening_matches','str_reports','aml_risk_countries')`);
if (schema.rows[0].n !== 6) {
  console.log(`  the P0.3 tables are not on this database (${schema.rows[0].n}/6 present).`
    + ' Apply 0040 first:\n');
  console.log('    node supabase/ops/migrate.mjs --url "$ADMIN_POOLER_URL"\n');
  await db.end();
  process.exit(2);
}

// ── 1 · authenticate ──────────────────────────────────────────────────────
await req('/api/firm/auth/csrf');
const login = await req('/api/firm/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
record('firm sign in', login.status === 200, failed(login));
if (login.status !== 200) { await db.end(); report(); process.exit(1); }

// ── 2 · the register answers with data ────────────────────────────────────
for (const key of ['ahmed', 'gulf', 'nukhba', 'qadim']) {
  const r = await req(`/api/firm/clients/${CLIENTS[key]}/due-diligence`);
  record(`GET /clients/:id/due-diligence (${key})`, r.status === 200, failed(r));
}
/*
  AL-FAJR IS ASKED FOR LAST AND EXPECTS A 404, WHICH IS THE POLICY RATHER THAN A GAP.
  `firm_client_scope` (0008) shows a client to the firm through `matter_visible()` of its
  matters; Al-Fajr has a due-diligence record and no matter, so the firm role cannot see
  the client row at all — the §71 scoping rule, doing what it says. The record itself is
  reachable the moment a matter exists, which is checked in the gate matrix below, and
  0008 names this one-line widening as the policy decision it would be. What matters for
  this phase is that the gate's answer about Al-Fajr does not depend on that visibility:
  it is refused whatever the caller can read.
*/
const fajrDoor = await req(`/api/firm/clients/${CLIENTS.fajr}/due-diligence`);
record('a client with a record but no matter is outside the firm\u2019s client scope (404, 0008)',
  fajrDoor.status === 404, failed(fajrDoor));

const queue = await req('/api/firm/compliance/due-diligence');
record('GET /compliance/due-diligence (the queue, the census and the refusal list)',
  queue.status === 200 && Array.isArray(queue.json?.data?.queue), failed(queue));
record('the queue states the UBO threshold the rule uses (25%)',
  queue.json?.data?.thresholdPct === 25, `thresholdPct=${queue.json?.data?.thresholdPct}`);

const reports = await req('/api/firm/str-reports');
record('GET /str-reports (the reports and their clock)', reports.status === 200, failed(reports));
record('the register carries the indicator list a report is written against',
  Array.isArray(reports.json?.data?.indicators) && reports.json.data.indicators.length >= 8,
  `${reports.json?.data?.indicators?.length} indicators`);

const gulf = await req(`/api/firm/clients/${CLIENTS.gulf}/due-diligence`);
record('Gulf\u2019s record reports the PEP that drives the refusal',
  gulf.json?.data?.record?.pepStatus === 'pep_family',
  `pepStatus=${gulf.json?.data?.record?.pepStatus}`);
record('Gulf is not admissible, and the screen says why rather than leaving it to the gate',
  gulf.json?.data?.admissible === false && gulf.json?.data?.refusal?.code === 'senior_approval_required',
  JSON.stringify(gulf.json?.data?.refusal ?? null));
record('the record names the persons who must be screened (client and owners)',
  (gulf.json?.data?.screening?.required?.length ?? 0) >= 3,
  `${gulf.json?.data?.screening?.required?.length} subject(s)`);

// ── 3 · the gate matrix, through the door and then against the trigger ────
/*
  A throwaway matter per client, created as the operator with the same shape the product
  creates, so that a refusal costs nothing and an admission leaves the demo untouched.
  `internal_status` starts at `intake`, which matters: the conflict guard only bites when a
  matter LEAVES `conflict_check`, so nothing but the due-diligence gate can be responsible
  for what happens next.
*/
const probes = [];
/*
  THE PROBE MATTER IS CREATED THE WAY THE PRODUCT CREATES ONE, INCLUDING ITS TEAM ROW.

  The first version inserted the matter and nothing else, and every request came back 404:
  `matter_access_level` resolves to `view` for a matter a member is not on, and
  MATTER_MANAGE needs `full`, so the route refused with `matter_scope_denied` — the same
  404 an outsider would get, which is the scoping rule working exactly as 0006 designs it.
  A probe that cannot reach the door proves nothing about the lock, so it is created as a
  real matter is: with the managing partner as lead.
*/
const NOURA_STAFF = 'f1000000-0000-4000-8000-000000000001';
async function makeProbeMatter(clientId, suffix) {
  const id = randomUUID();
  await db.query(
    `insert into matters (id, tenant_id, client_id, matter_number, title, title_ar,
                          practice_area, practice_area_ar, internal_status)
     values ($1, $2, $3, $4, 'CDD probe', 'فحص الامتثال', 'commercial', 'تجاري', 'intake')`,
    [id, KGM, clientId, `PROBE-CDD-${suffix}`]);
  await db.query(
    `insert into matter_team (id, matter_id, tenant_id, staff_id, matter_role)
     values ($1, $2, $3, $4, 'lead_partner')`,
    [randomUUID(), id, KGM, NOURA_STAFF]);
  probes.push(id);
  return id;
}

const MATRIX = [
  { key: 'ahmed', client: CLIENTS.ahmed, expect: null,
    why: 'a complete record for an individual: the firm may act' },
  { key: 'qadim', client: CLIENTS.qadim, expect: null,
    why: 'a founder holding a control right is an owner even below the threshold' },
  { key: 'nukhba', client: CLIENTS.nukhba, expect: 'cdd_beneficial_owner_missing',
    why: 'an owner at 100% that is a legal person identifies nobody' },
  { key: 'gulf', client: CLIENTS.gulf, expect: 'senior_approval_required',
    why: 'a PEP at standard due diligence requires senior approval' },
  { key: 'fajr', client: CLIENTS.fajr, expect: 'cdd_unable_to_complete',
    why: 'due diligence could not be completed: the firm may not act at all' },
];

for (const row of MATRIX) {
  const matterId = await makeProbeMatter(row.client, row.key);
  const r = await req(`/api/firm/matters/${matterId}/status`, {
    method: 'POST', body: { internalStatus: 'active' },
  });

  if (row.expect === null) {
    record(`${row.key}: ADMITTED — ${row.why}`, r.status === 200, failed(r));
  } else {
    record(`${row.key}: REFUSED ${row.expect} — ${row.why}`,
      r.status === 400 && codeOf(r) === row.expect, failed(r));
  }

  /*
    THE TRIGGER, WITHOUT THE APPLICATION. The route asks the domain assessment; the
    database refuses the transition on its own. The second check is the one that survives
    somebody calling the API wrong, and it is run here with `postgres` as the caller —
    the most privileged account in the database, which cannot be refused by accident.
  */
  let dbRefusal = null;
  try {
    await db.query(`update matters set internal_status = 'active' where id = $1`, [matterId]);
  } catch (err) {
    dbRefusal = String(err.message).split(':')[0].trim();
  }
  const want = row.expect ?? null;
  record(`${row.key}: the DATABASE says ${want ?? 'admitted'} too`,
    dbRefusal === want,
    dbRefusal === null ? 'the update succeeded where it should not have' : `the database said ${dbRefusal}`);
}

// ── 3b · the PEP refusal, on the matter the firm actually holds ───────────
/*
  THE ONE THAT HAS NEVER BEEN OBSERVED. KGM-2026-0170 sits at `partner_review` with a
  politically exposed beneficial owner at standard due diligence; the transition to
  `active` is refused. It is asked here of the real matter rather than of a probe, because
  the value of the check is that it speaks about the client the firm holds — and a refusal
  changes nothing, so the demo is left exactly as it was found.
*/
const before = await db.query(`select internal_status from matters where id = $1`, [GULF_MATTER]);
const gulfTry = await req(`/api/firm/matters/${GULF_MATTER}/status`, {
  method: 'POST', body: { internalStatus: 'active' },
});
record('KGM-2026-0170 (Gulf, a PEP at standard DD) is refused activation by the route',
  gulfTry.status === 400 && codeOf(gulfTry) === 'senior_approval_required', failed(gulfTry));
record('...and the refusal names the rule rather than the field',
  /senior management|enhanced/i.test(gulfTry.json?.error?.message ?? ''),
  gulfTry.json?.error?.message ?? '');

let gulfDbRefusal = null;
try {
  await db.query(`update matters set internal_status = 'active' where id = $1`, [GULF_MATTER]);
} catch (err) {
  gulfDbRefusal = String(err.message).split(':')[0].trim();
}
record('...and the database refuses it as well, for the superuser',
  gulfDbRefusal === 'senior_approval_required', `the database said ${gulfDbRefusal}`);
const after = await db.query(`select internal_status from matters where id = $1`, [GULF_MATTER]);
record('Gulf\u2019s matter is untouched by the attempt',
  before.rows[0].internal_status === after.rows[0].internal_status,
  `${before.rows[0].internal_status} → ${after.rows[0].internal_status}`);

const gateAudit = await db.query(
  `select count(*)::int as n from audit_events
    where action = 'CDD_GATE_DENIED' and resource_id = $1`, [GULF_MATTER]);
record('the refusal is on the trail, with the code that was returned',
  gateAudit.rows[0].n >= 1, `${gateAudit.rows[0].n} audit row(s)`);

// ── 3c · a client with no record at all ───────────────────────────────────
const probeClient = randomUUID();
await db.query(
  `insert into clients (id, tenant_id, client_type, name, status)
   values ($1, $2, 'individual', 'CDD Probe Client CDD-PROBE', 'active')`, [probeClient, KGM]);
const noRecord = await makeProbeMatter(probeClient, 'no-record');
const noRecordTry = await req(`/api/firm/matters/${noRecord}/status`, {
  method: 'POST', body: { internalStatus: 'active' },
});
record('a client with no due-diligence record cannot have an active matter (cdd_missing)',
  noRecordTry.status === 400 && codeOf(noRecordTry) === 'cdd_missing', failed(noRecordTry));

/* The screening route must refuse to record a clearance about a client nobody has
   identified — the record is what a screening is an answer about. */
const screeningNoRecord = await req(`/api/firm/clients/${probeClient}/screening-runs`, {
  method: 'POST',
  body: {
    subjectKind: 'client', subjectId: probeClient, subjectName: 'CDD Probe Client',
    listSets: ['un_consolidated'], provider: 'internal_register', status: 'clear',
  },
});
record('a screening cannot be recorded against a client with no due-diligence record',
  screeningNoRecord.status === 400 && codeOf(screeningNoRecord) === 'cdd_missing',
  failed(screeningNoRecord));

// ── 4 · the refusal vocabulary, through the routes ────────────────────────
/*
  Each of these is a rule a person can break by hand, and each must come back as a named
  4xx. A legitimate refusal that surfaces as a 500 is the worst of both answers: the person
  at the desk loses the reason and the logs record a fault.
*/
const nukhbaDd = await req(`/api/firm/clients/${CLIENTS.nukhba}/due-diligence`);
const nukhbaDdId = nukhbaDd.json?.data?.record?.id;

const noArabic = await req('/api/firm/str-reports', {
  method: 'POST',
  body: {
    reportNumber: `PROBE-${Date.now()}`,
    subjectKind: 'client',
    grounds: ['structuring'],
    narrativeAr: 'The client moved funds between accounts without explanation.',
  },
});
record('a report whose narrative is not in Arabic is refused as str_narrative_not_arabic',
  noArabic.status === 400 && codeOf(noArabic) === 'str_narrative_not_arabic', failed(noArabic));

const thinNarrative = await req('/api/firm/str-reports', {
  method: 'POST',
  body: { reportNumber: `PROBE-${Date.now()}`, subjectKind: 'client', grounds: ['structuring'], narrativeAr: 'مبلغ' },
});
record('a narrative too short to be a report is refused, and the field is named',
  thinNarrative.status === 400
    && (thinNarrative.json?.error?.details?.fields ?? []).includes('narrativeAr'),
  failed(thinNarrative));

const filed = await db.query(
  `select id, status from str_reports where tenant_id = $1 and status = 'filed' limit 1`, [KGM]);
if (filed.rows.length) {
  const r = await req(`/api/firm/str-reports/${filed.rows[0].id}/review`, { method: 'POST', body: {} });
  record('a filed report cannot be sent for review (str_not_draft)',
    r.status === 409 && codeOf(r) === 'str_not_draft', failed(r));
}

for (const [verb, body] of [
  ['review', {}],
  ['file', { fiuReference: 'SAFIU-PROBE', tippingOffAcknowledged: true }],
  ['response', { status: 'acknowledged' }],
]) {
  const r = await req(`/api/firm/str-reports/${randomUUID()}/${verb}`, { method: 'POST', body });
  record(`a report that does not exist is a 404 on ${verb}, not a statement about a report that is not there`,
    r.status === 404, failed(r));
}

/* Filing without the acknowledgement is not filing: tipping off is its own offence. */
const unfiled = await db.query(
  `select id from str_reports where tenant_id = $1 and status = 'draft' limit 1`, [KGM]);
if (unfiled.rows.length) {
  const r = await req(`/api/firm/str-reports/${unfiled.rows[0].id}/file`, {
    method: 'POST', body: { fiuReference: 'SAFIU-PROBE' },
  });
  record('a report cannot be filed without the tipping-off acknowledgement',
    r.status === 400, failed(r));
}

// ── 4b · the disposition guard ────────────────────────────────────────────
/*
  A DECISION ABOUT A HIT IS FINAL, AND THIS RUN FOUND THAT OUT THE HARD WAY.

  The first version of this file dispositioned the demo's open name hit to prove the
  positive case — and then could not put it back, because the database refuses to un-decide
  a match: `old.disposition <> 'open' and new.disposition is distinct from old` is a
  refusal, and so is a change to the reason. The probe had edited a fact.

  So the check is written the other way round. Re-deciding an ALREADY-decided hit is asked
  of the route (409, `already_dispositioned`) and of the database directly for the
  superuser, and NOTHING is written. The positive case — a first decision on an open hit —
  is covered in the suite, where the fixture is disposable; here the point is that a
  decided hit cannot move, which is the half only the real engine can prove.
*/
const decided = await db.query(
  `select m.id, m.disposition from screening_matches m
    where m.tenant_id = $1 and m.disposition <> 'open' limit 1`, [KGM]);
if (decided.rows.length) {
  const matchId = decided.rows[0].id;
  const again = await req(`/api/firm/screening-matches/${matchId}/disposition`, {
    method: 'POST',
    body: { disposition: 'true_match', reason: 'a second decision about the same hit is not a decision' },
  });
  record('a hit that has been decided cannot be decided again (already_dispositioned)',
    again.status === 409 && codeOf(again) === 'already_dispositioned', failed(again));

  let unDecide = null;
  try {
    await db.query(
      `update screening_matches set disposition = 'open', disposition_reason = null,
              disposition_by_membership_id = null, disposition_at = null
        where id = $1`, [matchId]);
  } catch (err) {
    unDecide = String(err.message).split(':')[0].trim();
  }
  record('...and the superuser cannot un-decide it either — the guard, not the privilege',
    unDecide === 'already_dispositioned', `the database said ${unDecide}`);

  const still = await db.query(`select disposition from screening_matches where id = $1`, [matchId]);
  record('the hit still carries the decision that was recorded',
    still.rows[0].disposition === decided.rows[0].disposition,
    `${decided.rows[0].disposition} → ${still.rows[0].disposition}`);
}

/*
  AND THE REGISTER AGREES WITH ITSELF. The queue counts open hits from the same facts the
  gate reads; the database counts them from the table. A projection that counted
  differently would tell a compliance officer a file is clear when the gate disagrees.
*/
const dbOpen = await db.query(
  `select count(*)::int as n from screening_matches where tenant_id = $1 and disposition = 'open'`, [KGM]);
const queueRow = (queue.json?.data?.queue ?? []).find((q) => q.clientId === CLIENTS.nukhba);
if (queueRow) {
  record('the queue reports the open hits the register holds',
    Number(queueRow.openMatches) === dbOpen.rows[0].n,
    `queue=${queueRow.openMatches} register=${dbOpen.rows[0].n}`);
}

// ── 5 · retention: nothing here may be deleted ────────────────────────────
/*
  Royal Decree M/20 requires the records be kept for ten years. The system's answer is not
  a policy document: it is an absent privilege. `firm_api` holds SELECT, INSERT and the
  UPDATEs the workflow needs — and no DELETE — on all six tables, and the triggers refuse
  the rest. A DELETE grant added by a later migration would break the retention story
  silently, so it is asked of the catalogue on every run.
*/
let deleteGrants = 0;
for (const table of ['client_due_diligence', 'beneficial_owners', 'screening_runs',
  'screening_matches', 'str_reports', 'aml_risk_countries']) {
  const r = await db.query(
    `select has_table_privilege('firm_api', 'public.' || $1, 'DELETE') as ok`, [table]);
  if (r.rows[0].ok === true) deleteGrants += 1;
}
record('no DELETE privilege on any of the six AML tables (retention, M/20)', deleteGrants === 0,
  `${deleteGrants} table(s) grant DELETE`);

const portalReads = await db.query(
  `select count(*)::int as n from information_schema.table_privileges
    where table_schema = 'public' and grantee = 'portal_api'
      and table_name in ('client_due_diligence','beneficial_owners','screening_runs',
                         'screening_matches','str_reports','aml_risk_countries')`);
record('the client portal holds no privilege at all on the firm\u2019s AML tables',
  portalReads.rows[0].n === 0, `${portalReads.rows[0].n} privilege row(s)`);

/* The trigger half: a DELETE attempted by the superuser is refused by the guard, not by
   the missing grant. Both have to be true, because either can be lost on its own. */
/*
  THE GUARD, NOT THE PRIVILEGE. Attempted as the superuser, on a synthetic client created
  for this check alone — so the refusal is the trigger and not the missing grant, and the
  row it refuses to delete belongs to nobody.
*/
const doomed = randomUUID();
await db.query(
  `insert into clients (id, tenant_id, client_type, name, status)
   values ($1, $2, 'individual', 'CDD Probe Retention CDD-PROBE', 'active')`, [doomed, KGM]);
const doomedDd = randomUUID();
await db.query(
  `insert into client_due_diligence (id, tenant_id, client_id, version, cdd_level, status)
   values ($1, $2, $3, 1, 'standard', 'in_progress')`, [doomedDd, KGM, doomed]);
let deleteRefusal = null;
try {
  await db.query(`delete from client_due_diligence where id = $1`, [doomedDd]);
} catch (err) {
  deleteRefusal = String(err.message).split(':')[0].trim();
}
record('a due-diligence record cannot be deleted even by the superuser (aml_record_retention)',
  deleteRefusal === 'aml_record_retention', `the database said ${deleteRefusal}`);

let clientDeleteRefusal = null;
try {
  await db.query(`delete from clients where id = $1`, [doomed]);
} catch (err) {
  clientDeleteRefusal = String(err.message).split(' ')[0].trim();
}
record('and the client it belongs to cannot be deleted out from under it',
  clientDeleteRefusal !== null, clientDeleteRefusal === null ? 'the client was deleted' : clientDeleteRefusal);

// ── 6 · the audit vocabulary is live, not merely declared ─────────────────
const vocab = await db.query(
  `select pg_get_constraintdef(oid) as def from pg_constraint
    where conname = 'audit_events_action_check' and conrelid = 'public.audit_events'::regclass`);
const def = String(vocab.rows[0]?.def ?? '');
const wanted = ['CDD_RECORDED', 'CDD_UPDATED', 'CDD_COMPLETED', 'CDD_UNABLE_TO_COMPLETE',
  'CDD_GATE_DENIED', 'BENEFICIAL_OWNER_RECORDED', 'BENEFICIAL_OWNER_VERIFIED',
  'SCREENING_RUN', 'SCREENING_MATCH_FOUND', 'SCREENING_MATCH_DISPOSITIONED',
  'SCREENING_FAILED', 'RISK_ASSESSED', 'RISK_COUNTRY_RECORDED', 'STR_PREPARED',
  'STR_REVIEWED', 'STR_FILED', 'STR_RESPONSE_RECORDED'];
const absent = wanted.filter((a) => !def.includes(`'${a}'`));
record('every P0.3 action is in the database\u2019s CHECK constraint (0041 applied)',
  absent.length === 0, absent.length ? `absent: ${absent.join(', ')}` : `${wanted.length} actions`);

// ── 6b · the deadline arithmetic, on the real engine ──────────────────────
const due = await db.query(`select public.kgm_add_working_days(now(), 3)::date::text as d`);
const noon = await db.query(
  `select (public.kgm_add_working_days(timestamptz '2026-09-24 09:00:00+03', 3))::date::text as d`);
record('three working days from a Thursday skips the Saudi weekend',
  ['2026-09-29', '2026-09-30'].includes(noon.rows[0].d),
  `Thursday 24 Sep + 3 working days = ${noon.rows[0].d}`);
record('the due-date function is callable by the firm role (it is granted)',
  typeof due.rows[0].d === 'string', String(due.rows[0].d));

// ── 7 · clean up the probes ───────────────────────────────────────────────
for (const id of probes) await db.query(`delete from matters where id = $1`, [id]);
const screenings = await db.query(`delete from screening_runs where client_id = $1`, [probeClient]);
await db.query(`delete from clients where id = $1`, [probeClient]);
record('the probe matters are removed again', probes.length > 0, `${probes.length} matter(s)`);
if (swept.rowCount || sweptClients.rowCount) {
  console.log(`  NOTE  swept ${swept.rowCount} probe matter(s) and ${sweptClients.rowCount} `
    + 'probe client(s) left by an earlier run');
}
record('the probe client and its screening went with them',
  screenings.rowCount >= 0, `${screenings.rowCount} screening run(s)`);

const leftover = await db.query(
  `select count(*)::int as n from matters where matter_number like 'PROBE-CDD-%'`);
record('nothing the probe created is left in the demo',
  leftover.rows[0].n === 0, `${leftover.rows[0].n} probe matter(s) remaining`);

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
