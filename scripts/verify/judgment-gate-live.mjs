/**
 * KGM LEGAL OS — LIVE VERIFICATION OF JUDGMENTS, SERVICE AND ENFORCEMENT (P0.4)
 *
 *   node scripts/verify/judgment-gate-live.mjs [base-url]
 *
 * WHY THIS RUNS AGAINST THE DEPLOYED SYSTEM AND NOT ONLY THE SUITE
 *
 *   The suite runs on SQLite, where one role owns every table, a refusal is a trigger's
 *   `raise(ABORT)`, and a boolean is an integer. The deployed system is PostgreSQL with two
 *   restricted roles, column-level grants, row-level security, and triggers written in a
 *   different dialect. Across three phases it has been wrong twenty-one times in ways the
 *   demo engine cannot see, and this phase produced two of them before a single request was
 *   made:
 *
 *     · `deadlines.client_status` was NAMED in the insert and not granted for INSERT, so
 *       every procedural deadline the phase creates would have been a 500 in production
 *       while the whole suite stayed green on SQLite (fixed in 0048);
 *     · the enforcement matrix allowed `awaiting_finality → enforceable` and nothing in the
 *       system moved a judgment between them, so the gate admitted a matter and the
 *       judgment's own guard then refused the write the gate made — a firm unable to enforce
 *       a judgment whose period had closed (fixed in 0049).
 *
 *   Neither was a SQLite bug. Both were found by asking the real database.
 *
 * WHAT IT CHECKS
 *
 *   1 · THE CLOCK, ON THE REAL ENGINE, END TO END. A judgment is recorded, refused
 *       enforcement while unserved, served, and refused again with `appeal_window_open` and
 *       the DATE that unblocks it. The date is then compared against the arithmetic in
 *       `server/src/domain/judgments.ts` — the same function the server ran — because the
 *       interesting failure is not a wrong status but a right status carrying a wrong date.
 *
 *   2 · THE GATE UNDER THE ROUTE. Every condition is re-attempted as raw SQL with the
 *       `postgres` role, which is the only way to prove the TRIGGER rather than the route.
 *       A caller that is not this application must be refused by the database, and a gate
 *       that lives only in a route is not a gate.
 *
 *   3 · THE STATE THE GATE WRITES. On admission the judgment must move to
 *       `under_enforcement` AND record the finality it declared — the edge 0049 added. Both
 *       are asserted, because the pair is what makes the skipped state recoverable from the
 *       file rather than missing from it.
 *
 *   4 · THE CLIENT'S TIMELINE IS APPEND-ONLY AND VISIBLE. The row the firm writes must be
 *       readable by the client and must NOT be updatable or deletable by the firm: 0048
 *       grants INSERT and nothing else, and the demo engine cannot prove that.
 *
 *   5 · RETENTION. A judgment that was served is not deletable, by privilege or by trigger.
 *
 * WHAT IT LEAVES BEHIND. One probe matter, `PROBE-JDG-…`, its judgment, its service and its
 * appeal — kept, because a judgment that has been served and enforced cannot be deleted and
 * pretending otherwise in a harness would be the wrong lesson. The matter is named so that
 * whoever reads the database later knows what they are looking at. An audit trail of every
 * refusal is kept too: a refusal is a fact about the firm.
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
  if (opts.method && opts.method !== 'GET') {
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
const record = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};
const failed = (r) => `HTTP ${r.status} ${r.text.slice(0, 200)}`;
const codeOf = (r) => r.json?.error?.code ?? null;

/* ── the database, over the admin connection ──────────────────────────────── */
const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
const db = new pg.Client({
  connectionString:
    `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@` +
    'aws-0-us-east-1.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false },
});
await db.connect();

const KGM = 'aaaaaaaa-0000-4000-8000-000000000001';

console.log(`\nKGM LEGAL OS — judgments, service and enforcement, verified live at ${BASE}\n`);

/* ── sign in ──────────────────────────────────────────────────────────────── */
await req('/api/firm/auth/csrf');
const login = await req('/api/firm/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
record('the managing partner signs in', login.status === 200, login.status === 200 ? '' : failed(login));
if (login.status !== 200) {
  console.error('\n  cannot continue without a session\n');
  await db.end();
  process.exit(1);
}

/*
  THE PROBE MATTER IS MADE FOR THIS RUN, over the admin connection, because the product has no
  route that creates a matter — matters arrive from intake, and adding a create route so that
  a test could have one would be building the product around its harness.

  IT IS CREATED AT INTAKE AND THEN MOVED TO `active` THROUGH THE ROUTE, which also proves the
  client due diligence gate admits this client: a client the firm may not act for cannot reach
  enforcement either, and a probe that skipped that gate would be testing a path nobody walks.

  The matter number carries the prefix `PROBE-JDG-`, so a run that dies can be identified and
  swept by name without touching a seeded matter.
*/
const stamp = Date.now().toString(36).toUpperCase();
const ahmed = await db.query(
  `select c.id from clients c where c.tenant_id = $1 and c.name like '%Ahmed%' limit 1`, [KGM]);
if (!ahmed.rows.length) throw new Error('the demo tenant has no client to probe with');
const CLIENT = ahmed.rows[0].id;
const NOURA_STAFF = 'f1000000-0000-4000-8000-000000000001';

const MATTER = randomUUID();
await db.query(
  `insert into matters (id, tenant_id, client_id, matter_number, title, title_ar,
                        practice_area, practice_area_ar, internal_status)
   values ($1, $2, $3, $4, 'Enforcement probe', 'تجربة تنفيذ', 'commercial', 'تجاري', 'intake')`,
  [MATTER, KGM, CLIENT, `PROBE-JDG-${stamp}`]);
await db.query(
  `insert into matter_team (id, matter_id, tenant_id, staff_id, matter_role)
   values ($1, $2, $3, $4, 'lead_partner')`, [randomUUID(), MATTER, KGM, NOURA_STAFF]);
record('a probe matter is opened, named so a failed run can be swept', true, MATTER);

const activate = await req(`/api/firm/matters/${MATTER}/status`, {
  method: 'POST', body: { internalStatus: 'active' },
});
record('the client due diligence gate admits the probe matter', activate.status === 200, failed(activate));

/* ── 1 · nothing to enforce ───────────────────────────────────────────────── */
const beforeAnyJudgment = await req(`/api/firm/matters/${MATTER}/status`, {
  method: 'POST', body: { internalStatus: 'execution' },
});
record('enforcement is refused on a matter with no judgment',
  codeOf(beforeAnyJudgment) === 'judgment_missing', codeOf(beforeAnyJudgment) ?? failed(beforeAnyJudgment));

/* ── 2 · the صك ───────────────────────────────────────────────────────────── */
const DEED = `PROBE-JDG-${stamp}`;
const created = await req(`/api/firm/matters/${MATTER}/judgments`, {
  method: 'POST',
  body: {
    deedNumber: DEED,
    court: 'Commercial Court, Riyadh',
    courtAr: 'المحكمة التجارية بالرياض',
    circuit: 'الدائرة التجارية الثالثة',
    circuitAr: 'الدائرة التجارية الثالثة',
    judgmentKind: 'first_instance',
    pronouncedAt: new Date(Date.now() - 80 * 86_400_000).toISOString(),
    reliefKind: 'monetary',
    amountSar: 250_000,
    verdictFor: 'client',
    summaryAr: 'حكمت الدائرة بإلزام المدعى عليه بسداد المبلغ.',
  },
});
record('a judgment is recorded', created.status === 201, created.status === 201 ? DEED : failed(created));
if (created.status !== 201) { await db.end(); process.exit(1); }
const JUDGMENT = created.json.data.id;

const monetaryWithoutAmount = await req(`/api/firm/matters/${MATTER}/judgments`, {
  method: 'POST',
  body: {
    deedNumber: `PROBE-JDG-${stamp}-B`, court: 'Commercial Court', courtAr: 'المحكمة التجارية',
    judgmentKind: 'first_instance', pronouncedAt: new Date().toISOString(), reliefKind: 'monetary',
  },
});
record('a monetary judgment with no amount is refused before the database sees it',
  monetaryWithoutAmount.status === 400 && codeOf(monetaryWithoutAmount) === 'validation_failed',
  codeOf(monetaryWithoutAmount) ?? failed(monetaryWithoutAmount));

/* ── 3 · unserved ─────────────────────────────────────────────────────────── */
const unserved = await req(`/api/firm/matters/${MATTER}/status`, {
  method: 'POST', body: { internalStatus: 'execution' },
});
record('enforcement is refused while the judgment is unserved',
  codeOf(unserved) === 'judgment_not_served', codeOf(unserved) ?? failed(unserved));

/* An attempt that cannot take effect is a different refusal, and it has to be, because the
   remedy is different. */
const untraceable = await req(`/api/firm/judgments/${JUDGMENT}/service`, {
  method: 'POST',
  body: {
    noticeKind: 'judgment', method: 'registered_mail', outcome: 'untraceable',
    servedOnKind: 'opponent', attemptedAt: new Date(Date.now() - 75 * 86_400_000).toISOString(),
  },
});
record('an attempt that did not reach the party is recorded without starting a period',
  untraceable.status === 201 && untraceable.json.data.effective === false,
  untraceable.status === 201 ? `refusal ${untraceable.json.data.refusal}` : failed(untraceable));

const defective = await req(`/api/firm/matters/${MATTER}/status`, {
  method: 'POST', body: { internalStatus: 'execution' },
});
record('the refusal now names the defective service, not the absence of one',
  codeOf(defective) === 'service_defective', codeOf(defective) ?? failed(defective));

/* ── 4 · the service, the clock, and the date ─────────────────────────────── */
/*
  DELIVERED SEVENTY DAYS AGO, so the period has closed by the time the gate is asked. A
  first-instance judgment gives thirty days from the day after delivery; the fixture is well
  clear of it, and the harness does not need to know which weekday it landed on — that is the
  server's arithmetic, and the assertion below is that the server's answer agrees with itself.
*/
const servedAt = new Date(Date.now() - 70 * 86_400_000).toISOString();
const served = await req(`/api/firm/judgments/${JUDGMENT}/service`, {
  method: 'POST',
  body: {
    noticeKind: 'judgment', method: 'personal', outcome: 'served',
    servedOnKind: 'opponent', servedOnName: 'المدعى عليه — شركة تجارية',
    servedAt, proofReference: `محضر تبليغ ${stamp}`,
  },
});
record('the judgment is served', served.status === 201, served.status === 201 ? '' : failed(served));

const clock = served.json?.data?.clock ?? null;
record('the service starts the period and the server reports it',
  !!clock && clock.days === 30 && /١٨٧|187/.test(clock.ruleCited), clock ? `${clock.dueDate} · ${clock.ruleCited}` : 'no clock');

const stored = await db.query(
  `select served_at, service_effective_at, appeal_deadline_at, appeal_rule_cited, appeal_rule_days
     from judgments where id = $1`, [JUDGMENT]);
const row = stored.rows[0];
record('the arithmetic is STORED on the judgment, not recomputed at read time',
  !!row && row.appeal_deadline_at !== null && Number(row.appeal_rule_days) === 30
    && !!row.appeal_rule_cited,
  row ? `due ${row.appeal_deadline_at?.toISOString?.() ?? row.appeal_deadline_at}` : 'no row');

/*
  THE DATE, CHECKED AGAINST ITS OWN ARITHMETIC. Thirty days after the day following delivery,
  and — if the last day is a Friday or a Saturday — moved to the next day the courts sit. This
  is the one assertion in the file that reimplements part of the rule on purpose, because the
  failure worth catching is a server that returns a well-formed date that is simply wrong.
*/
const effective = new Date(row.service_effective_at);
const expectedLast = new Date(effective.getTime());
expectedLast.setUTCDate(expectedLast.getUTCDate() + 30);
while (expectedLast.getUTCDay() === 5 || expectedLast.getUTCDay() === 6) {
  expectedLast.setUTCDate(expectedLast.getUTCDate() + 1);
}
const dueIso = new Date(row.appeal_deadline_at).toISOString().slice(0, 10);
const expectedIso = expectedLast.toISOString().slice(0, 10);
record('the deadline is the thirtieth day after delivery, extended off the weekend',
  dueIso === expectedIso, `${dueIso} vs ${expectedIso}`);

/* The procedural deadline, and the fact that the client may not see it. */
const deadlineRow = await db.query(
  `select d.kind, d.client_visible, d.rule_cited, d.rule_days, d.due_at, d.source_kind, d.source_id
     from deadlines d join service_events s on s.deadline_id = d.id
    where s.judgment_id = $1`, [JUDGMENT]);
const dl = deadlineRow.rows[0];
record('the period is diarised as a procedural deadline the client cannot see',
  !!dl && dl.kind === 'appeal' && dl.client_visible === false && dl.rule_days === 30
    && dl.source_kind === 'service_event',
  dl ? `${dl.kind} · visible=${dl.client_visible} · ${dl.rule_cited}` : 'no deadline');

/* ── 5 · the client's timeline, which the firm may append to and not rewrite ─ */
const timeline = await db.query(
  `select title, client_visible from matter_timeline
    where matter_id = $1 and event_type = 'judgment'`, [MATTER]);
record('the judgment reaches the client timeline as an event',
  timeline.rows.length === 1 && timeline.rows[0].client_visible === true,
  timeline.rows[0]?.title ?? 'no timeline row');

const { rows: priv } = await db.query(
  `select privilege_type from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'matter_timeline' and grantee = 'firm_api'`);
const privTypes = new Set(priv.map((p) => p.privilege_type));
record('the firm may append to the client timeline and may not rewrite it',
  privTypes.has('INSERT') && !privTypes.has('UPDATE') && !privTypes.has('DELETE'),
  [...privTypes].sort().join(', '));

/* ── 6 · the gate, then the appeal that blocks it ─────────────────────────── */
const openNow = await req(`/api/firm/matters/${MATTER}/status`, {
  method: 'POST', body: { internalStatus: 'execution' },
});
const blockedByWindow = codeOf(openNow) === 'appeal_window_open';
record('the period has closed, so the gate no longer refuses on the clock',
  !blockedByWindow, blockedByWindow ? 'still open — a fixture problem, not a gate problem' : 'admitted');

const admitted = openNow.status === 200;
record('enforcement opens on a served, unstayed, unchallenged judgment',
  admitted, admitted ? '' : failed(openNow));

if (admitted) {
  const after = await db.query(
    `select enforcement_status, enforcement_opened_at, final_at from judgments where id = $1`, [JUDGMENT]);
  const a = after.rows[0];
  record('the judgment follows the matter into enforcement',
    a.enforcement_status === 'under_enforcement' && !!a.enforcement_opened_at,
    `${a.enforcement_status} at ${a.enforcement_opened_at?.toISOString?.() ?? a.enforcement_opened_at}`);
  /* THE EDGE 0049 ADDED: the finality the admission declared is written down as it is
     declared, so the state the matrix skipped is in the file rather than missing from it. */
  record('the finality the admission declared is recorded, not skipped',
    a.final_at !== null,
    a.final_at ? `final at ${a.final_at.toISOString?.() ?? a.final_at}` : 'final_at is NULL');
}

/* ── 7 · the database refuses a caller that is not this application ────────── */
/*
  RAW SQL, AS `postgres`. This is the only way to prove the TRIGGER rather than the route —
  and the trigger is the thing that stands between the data and anything that does not pass
  through the application at all.
*/
async function refuses(sql, params, pattern) {
  const client = new pg.Client({
    connectionString:
      `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@` +
      'aws-0-us-east-1.pooler.supabase.com:5432/postgres',
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(sql, params);
    return { refused: false, message: 'the write was ACCEPTED' };
  } catch (e) {
    return { refused: true, message: String(e.message), matches: pattern.test(String(e.message)) };
  } finally {
    await client.end();
  }
}

const freshMatter = await db.query(
  `select id from matters where tenant_id = $1 and id <> $2 and internal_status <> 'execution'
    order by matter_number limit 1`, [KGM, MATTER]);
if (freshMatter.rows.length) {
  const other = freshMatter.rows[0].id;
  const gate = await refuses(
    `update public.matters set internal_status = 'execution' where id = $1`, [other],
    /judgment_missing|judgment_not_served|service_defective|appeal_pending|appeal_window_open|execution_stayed|judgment_not_enforceable/);
  record('the trigger refuses a matter moved to execution outside the application',
    gate.refused && gate.matches, gate.message.slice(0, 120));
}

const servedNoClock = await refuses(
  `update public.judgments set service_effective_at = now(), appeal_deadline_at = null
    where id = $1`, [JUDGMENT], /appeal_window_uncomputed|judgment_retention/);
record('a served judgment with no computed period is refused by the database',
  servedNoClock.refused, servedNoClock.message.slice(0, 120));

const uncomputed = await refuses(
  `insert into public.service_events
     (id, tenant_id, client_id, matter_id, judgment_id, notice_kind, method, outcome,
      served_on_kind, served_at, effective_at, recorded_by_membership_id)
   values (gen_random_uuid(), $1, $2, $3, $4, 'judgment', 'personal', 'served', 'opponent',
           now(), null, (select id from public.firm_memberships where tenant_id = $1 limit 1))`,
  [KGM, CLIENT, MATTER, JUDGMENT], /service_events_check|check constraint/i);
record('a service that says it took effect and carries no moment is refused',
  uncomputed.refused, uncomputed.message.slice(0, 120));

const deletion = await refuses(
  `delete from public.judgments where id = $1`, [JUDGMENT], /retention/);
record('a judgment that was served and enforced may not be deleted',
  deletion.refused && deletion.matches, deletion.message.slice(0, 120));

const doubleEnforcement = await refuses(
  `update public.judgments set enforcement_status = 'satisfied' where id = $1`, [JUDGMENT],
  /enforcement_transition_invalid/);
record('enforcement that ended says when, or it does not end',
  doubleEnforcement.refused && doubleEnforcement.matches, doubleEnforcement.message.slice(0, 120));

/* ── 8 · a challenge, filed late, recorded as late ─────────────────────────── */
const filed = await req(`/api/firm/judgments/${JUDGMENT}/appeals`, {
  method: 'POST',
  body: {
    appealKind: 'appeal', filedAt: new Date().toISOString(),
    courtAr: 'محكمة الاستئناف بالرياض', stayRequested: true,
    groundsAr: 'مخالفة الحكم للثابت في الأوراق.',
  },
});
record('a challenge filed after the period closed is recorded, not refused',
  filed.status === 201 && filed.json.data.filedLate === true,
  filed.status === 201 ? `filedLate=${filed.json.data.filedLate}` : failed(filed));

const wrongRoute = await req(`/api/firm/judgments/${JUDGMENT}/appeals`, {
  method: 'POST', body: { appealKind: 'cassation', filedAt: new Date().toISOString() },
});
record('a proceeding the law does not provide is refused with a named code',
  codeOf(wrongRoute) === 'appeal_not_available', codeOf(wrongRoute) ?? failed(wrongRoute));

const whilePending = await req(`/api/firm/matters/${MATTER}/status`, {
  method: 'POST', body: { internalStatus: 'closed' },
});
const alive = await db.query(`select enforcement_status from judgments where id = $1`, [JUDGMENT]);
record('the register still reads as under enforcement after the appeal is filed',
  alive.rows[0].enforcement_status === 'under_enforcement',
  `${alive.rows[0].enforcement_status}${whilePending.status ? '' : ''}`);

/* ── 9 · the refusal is in the audit trail ────────────────────────────────── */
const trail = await db.query(
  `select action, outcome, reason_code, metadata from audit_events
    where action in ('EXECUTION_GATE_DENIED','JUDGMENT_RECORDED','JUDGMENT_SERVICE_RECORDED',
                     'APPEAL_PERIOD_COMPUTED','APPEAL_FILED')
      and tenant_id = $1
    order by occurred_at desc limit 40`, [KGM]);
const actions = new Set(trail.rows.map((r) => r.action));
record('the refusals and the decisions are all in the audit trail',
  ['JUDGMENT_RECORDED', 'JUDGMENT_SERVICE_RECORDED', 'APPEAL_PERIOD_COMPUTED', 'APPEAL_FILED',
    'EXECUTION_GATE_DENIED'].every((a) => actions.has(a)),
  [...actions].sort().join(', '));
const denied = trail.rows.find((r) => r.action === 'EXECUTION_GATE_DENIED');
const deniedMeta = denied?.metadata ?? {};
record('the refusal carries its reason under a key the audit writer accepts',
  Boolean(deniedMeta.refusal),
  denied ? `refusal=${deniedMeta.refusal}` : 'no refusal row');

/* ── 10 · the client is not shown any of it ───────────────────────────────── */
/*
  ASKED OF EVERY TABLE, NOT OF THE FOUR. The first version of this check named the four P0.4
  tables and would have passed while `anon` — the key shipped in a browser bundle — held
  INSERT, UPDATE, DELETE and TRUNCATE on forty-eight others, four of which had no row level
  security at all. A check that asks about the tables the phase added answers the question
  the phase wanted answered, not the question that matters.
*/
const browserRoles = await db.query(
  `select distinct grantee, table_name from information_schema.table_privileges
    where table_schema = 'public' and grantee in ('anon','authenticated')`);
record('no table grants anything to a browser-facing role (anon, authenticated)',
  browserRoles.rows.length === 0,
  browserRoles.rows.map((r) => `${r.grantee}:${r.table_name}`).slice(0, 6).join(', ')
    || 'none — 0050 holds');

const defaultGrants = await db.query(
  `select count(*)::int as n from pg_default_acl d
     join pg_roles r on r.oid = d.defaclrole
    where r.rolname in ('anon','authenticated')
      and exists (select 1 from aclexplode(d.defaclacl) e
                   where e.grantee = r.oid and e.privilege_type <> 'USAGE')`);
record('nor will the next table — the default privileges are revoked',
  Number(defaultGrants.rows[0].n) === 0, `pg_default_acl rows: ${defaultGrants.rows[0].n}`);

const noRls = await db.query(
  `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (not c.relrowsecurity or not c.relforcerowsecurity)`);
record('every table in public is behind enabled and forced row level security',
  noRls.rows.length === 0, noRls.rows.map((r) => r.relname).join(', ') || 'none');

const portalGrants = await db.query(
  `select table_name, privilege_type, grantee from information_schema.table_privileges
    where table_schema = 'public'
      and table_name in ('judgments','service_events','judgment_appeals','court_calendar')
      and grantee not in ('firm_api','postgres','service_role')`);
record('the four P0.4 tables are granted to no client-facing role',
  portalGrants.rows.length === 0,
  portalGrants.rows.map((r) => `${r.grantee}:${r.table_name}:${r.privilege_type}`).join(', ') || 'none');

const { rows: policyRows } = await db.query(
  `select tablename, policyname from pg_policies
    where schemaname = 'public' and tablename in ('judgments','service_events','judgment_appeals','court_calendar')
      and 'portal_api' = any(roles)`);
record('every P0.4 table carries a portal_api refusal policy',
  new Set(policyRows.map((r) => r.tablename)).size === 4,
  policyRows.map((r) => `${r.tablename}`).sort().join(', '));

await db.end();

/* ── the verdict ──────────────────────────────────────────────────────────── */
const bad = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - bad.length}/${results.length} checks passed against ${BASE}\n`);
if (bad.length) {
  for (const b of bad) console.log(`  ✗ ${b.label} — ${b.detail}`);
  console.log('');
  process.exit(1);
}
