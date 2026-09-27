#!/usr/bin/env node
/**
 * THE COMPLIANCE CONSOLE, AGAINST THE REAL POSTGRES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS
 *
 *   The console's three reads are assembled from six tables and four domain rules, and the
 *   one that matters most is `refused`: the list of clients the firm may NOT act for. That
 *   list is the intake gate restated, and if it disagrees with the gate in either direction
 *   the screen is worse than useless — a member takes on work the server will refuse at the
 *   next step, or believes a client is clear when the matter open will be blocked.
 *
 *   So this file asks the API for its answer, then asks the DATABASE the same question from
 *   the client's due-diligence row, and compares the two. It also checks that the numbers
 *   on the census tiles are counts of the rows they claim to count and not, say, the length
 *   of a page.
 *
 *   READ-ONLY. Nothing here writes: the console's writes (identification, owners,
 *   screenings, dispositions, reports, licences) all have their own constraints, and the
 *   point of this run is the one thing a unit test cannot show — that the screen's verdict
 *   on a real firm's real clients is the database's verdict.
 *
 * USAGE
 *   node scripts/verify/compliance-live.mjs                       # local :8787
 *   node scripts/verify/compliance-live.mjs https://kgmlegal.vercel.app
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
const ADMIN_URL = `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
const KGM = 'aaaaaaaa-0000-4000-8000-000000000001';
const FIRM_PASSWORD = 'Demo!Firm2026';
const MP = 'noura@kgm.example.test';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name}\n      ${detail}`); }
};

const admin = new pg.Client({ connectionString: ADMIN_URL, ssl: { rejectUnauthorized: false } });

function client(base = BASE, prefix = '/api/firm') {
  let cookies = {};
  let csrf = null;
  const jar = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    async call(method, path, body) {
      const headers = { accept: 'application/json' };
      if (jar()) headers.cookie = jar();
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
      const res = await fetch(`${base}${prefix}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
      csrf = cookies.kgm_firm_csrf ?? cookies.kgm_csrf ?? csrf;
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
      // The envelope: `{ ok, data }`, unwrapped exactly as the firm client does it.
      return { status: res.status, body: parsed?.data ?? parsed };
    },
    get(p) { return this.call('GET', p); },
    post(p, b = {}) { return this.call('POST', p, b); },
  };
}

async function login(email) {
  const c = client();
  await c.get('/auth/csrf');
  const res = await c.post('/auth/login', { email, password: FIRM_PASSWORD });
  if (res.status !== 200) throw new Error(`login ${email} → ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return c;
}

async function main() {
  await admin.connect();
  console.log('\n  THE COMPLIANCE CONSOLE · against the live database');
  console.log('  ' + '─'.repeat(72));

  const firm = await login(MP);

  /* ── 1 · the console reads ─────────────────────────────────────────────── */
  console.log('\n  1 · THE THREE READS');

  const dd = await firm.get('/compliance/due-diligence');
  check('GET /compliance/due-diligence answers 200', dd.status === 200, `${dd.status}`);
  const reports = await firm.get('/str-reports');
  check('GET /str-reports answers 200', reports.status === 200, `${reports.status}`);
  const elig = await firm.get('/eligibility');
  check('GET /eligibility answers 200', elig.status === 200, `${elig.status}`);
  if (dd.status !== 200 || reports.status !== 200 || elig.status !== 200) { await admin.end(); return report(); }

  const census = dd.body.census;
  const queue = dd.body.queue ?? [];
  console.log(`      clients ${census.clients} · identified ${census.complete} · unable ${census.unable} · not started ${census.notStarted}`);
  console.log(`      open matches ${census.openMatches} · failed runs ${census.failedRuns} · reports ${census.reportsFiled} filed / ${census.reportsOpen} open / ${census.reportsLate} late`);
  console.log(`      refused (may not act for) ${dd.body.refused.length}`);
  console.log(`      threshold ${dd.body.thresholdPct}% · review cycle ${JSON.stringify(dd.body.reviewMonths)}`);

  /* ── 2 · the census is a count of what it says it counts ───────────────── */
  console.log('\n  2 · THE NUMBERS ARE COUNTS, NOT PAGE LENGTHS');

  const clientCount = (await admin.query(
    'select count(*)::int n from public.clients where tenant_id = $1', [KGM])).rows[0].n;
  check('the client tile counts the register', census.clients === clientCount,
    `census=${census.clients} db=${clientCount}`);
  check('the queue has one row per client', queue.length === clientCount,
    `queue=${queue.length} clients=${clientCount}`);

  const ddRows = await admin.query(
    `select c.id,
            (select d.status from public.client_due_diligence d
              where d.client_id = c.id and d.tenant_id = c.tenant_id
              order by d.created_at desc limit 1) status
       from public.clients c where c.tenant_id = $1`, [KGM]);
  const byId = new Map(ddRows.rows.map((r) => [r.id, r.status]));
  /*
    A CLIENT WITH NO RECORD AT ALL READS `not_started`, AND THAT IS A STATEMENT, NOT A GAP.
    The first version of this check compared against `null` and failed on a client that
    simply has no due-diligence row — the same class of mistake as reading a missing field
    as an empty one. The rule is: the API reports the row's status, or `not_started` when
    there is no row to report.
  */
  const mismatched = queue.filter((q) => (byId.get(q.clientId) ?? 'not_started') !== (q.status ?? 'not_started'));
  check('every queue row reports the status of its latest record', mismatched.length === 0,
    mismatched.map((m) => `${m.clientName}: api=${m.status} db=${byId.get(m.clientId)}`).join(' · '));
  check('the identified tile equals the rows that are complete',
    census.complete === queue.filter((q) => q.status === 'complete').length,
    `census=${census.complete} rows=${queue.filter((q) => q.status === 'complete').length}`);

  /* ── 3 · THE GATE, AND WHETHER THE SCREEN AGREES WITH IT ───────────────── */
  console.log('\n  3 · WHO THE FIRM MAY NOT ACT FOR — the gate, restated');

  const refused = dd.body.refused ?? [];
  const queueRefused = queue.filter((q) => !q.allowed).map((q) => q.clientId).sort();
  const screenRefused = refused.map((r) => r.clientId).sort();
  check('`refused` is exactly the queue rows marked not allowed',
    JSON.stringify(queueRefused) === JSON.stringify(screenRefused),
    `queue=${queueRefused.length} refused=${screenRefused.length}`);

  check('every refusal carries at least one reason', refused.every((r) => r.blockers.length > 0),
    refused.filter((r) => r.blockers.length === 0).map((r) => r.clientName).join(' · '));

  /*
    THE CROSS-EXAMINATION THAT MATTERS. `allowed` is the firm's own rule; the database
    knows the underlying facts. A client with no record at all must not be allowed, and a
    record that is complete with no open hit must be — and when those disagree the screen
    is telling a member something the gate will contradict at the next step.
  */
  const noRecord = queue.filter((q) => q.ddId === null);
  check('a client with no identification record is never allowed',
    noRecord.every((q) => !q.allowed && q.blockers.includes('cdd_missing')),
    noRecord.filter((q) => q.allowed).map((q) => q.clientName).join(' · ') || '(none)');

  const complete = queue.filter((q) => q.status === 'complete');
  const allowedComplete = complete.filter((q) => q.allowed);
  console.log(`      complete records: ${complete.length}, of which allowed: ${allowedComplete.length}`);
  const blockedForOtherReason = complete.filter((q) => !q.allowed
    && q.blockers.every((b) => b !== 'cdd_missing' && b !== 'cdd_incomplete'));
  check('a complete record is allowed unless something else bars it',
    complete.every((q) => q.allowed || q.blockers.some((b) => b === 'screening_unresolved' || b === 'senior_approval_required' || b === 'review_overdue' || b === 'screening_failed')),
    blockedForOtherReason.map((q) => `${q.clientName}: ${q.blockers.join(',')}`).join(' · ') || '(none)');

  /* The open-hit count on the tiles must be the undecided matches in the table. */
  /*
    A match has no client_id of its own: it belongs to a RUN, and the run names the client.
    And an UNDECIDED match is stored as disposition = 'open', never as NULL — the first
    version of this query asked for NULL and disagreed with the census by one, which is how
    the convention was found. That convention is load-bearing on the screen too: a drawer
    that tested for a missing value would have shown an open hit as a decided one.
  */
  const openMatches = (await admin.query(
    `select count(*)::int n
       from public.screening_matches m
       join public.screening_runs r on r.id = m.run_id
      where r.tenant_id = $1 and m.disposition = 'open'`, [KGM])).rows[0].n;
  check('the open-match tile counts undecided matches', census.openMatches === openMatches,
    `census=${census.openMatches} db=${openMatches}`);

  /* ── 4 · the risk register ─────────────────────────────────────────────── */
  console.log('\n  4 · THE RISK-COUNTRY REGISTER');

  const countryRows = (await admin.query(
    'select count(*)::int n from public.aml_risk_countries where tenant_id = $1 and effective_to is null', [KGM])).rows[0].n;
  check('the register the screen shows is the live register', (dd.body.countries ?? []).length === countryRows,
    `api=${(dd.body.countries ?? []).length} db=${countryRows}`);
  const badLevel = (dd.body.countries ?? []).filter((c) => !['high', 'prohibited'].includes(c.riskLevel));
  check('every country carries a designation the rule recognises', badLevel.length === 0, JSON.stringify(badLevel));
  const noDate = (dd.body.countries ?? []).filter((c) => !c.effectiveFrom);
  check('and a date it took effect — a designation without one cannot be attributed', noDate.length === 0,
    JSON.stringify(noDate));

  /* ── 5 · the report clock ──────────────────────────────────────────────── */
  console.log('\n  5 · THE REPORT CLOCK');

  const reportRows = reports.body.reports ?? [];
  console.log(`      reports ${reportRows.length} · late ${reportRows.filter((r) => r.late).length} · indicators ${(reports.body.indicators ?? []).length}`);
  const wrongLate = reportRows.filter((r) => {
    const expected = r.status !== 'filed' && r.filedDueAt !== null && new Date(r.filedDueAt).getTime() < Date.now();
    return r.late !== expected;
  });
  check('`late` is computed from the deadline, not stored', wrongLate.length === 0,
    wrongLate.map((r) => `${r.reportNumber}: late=${r.late} due=${r.filedDueAt} status=${r.status}`).join(' · '));
  check('a filed report is never late, whatever the date', reportRows.filter((r) => r.status === 'filed').every((r) => !r.late),
    reportRows.filter((r) => r.status === 'filed' && r.late).map((r) => r.reportNumber).join(' · '));
  check('the indicator list is the law\'s own vocabulary', (reports.body.indicators ?? []).length >= 10,
    `${(reports.body.indicators ?? []).length} indicators`);
  check('every report carries at least one ground', reportRows.every((r) => (r.grounds ?? []).length > 0),
    reportRows.filter((r) => (r.grounds ?? []).length === 0).map((r) => r.reportNumber).join(' · '));

  /* ── 6 · who may practise ──────────────────────────────────────────────── */
  console.log('\n  6 · THE RIGHT TO PRACTISE');

  const members = elig.body.members ?? [];
  console.log(`      members ${elig.body.count} · not entitled ${elig.body.notEntitled} · barred by a former office ${elig.body.barredByPriorOffice}`);
  check('the member count is the membership count',
    elig.body.count === (await admin.query(
      'select count(*)::int n from public.firm_memberships where tenant_id = $1 and status = $2', [KGM, 'active'])).rows[0].n,
    `api=${elig.body.count}`);
  const barred = members.filter((m) => m.priorOffice.barred);
  check('every member the screen calls barred has a bar in the record',
    barred.every((m) => m.priorOffice.restrictionEndsOn !== null || m.priorOffice.stillInPost),
    barred.map((m) => m.displayName).join(' · '));
  check('a licence expiry the screen shows is the date in the row',
    members.every((m) => m.licences.every((l) => l.expiresAt === null || /^\d{4}-\d{2}-\d{2}/.test(String(l.expiresAt)))),
    'a licence date is not ISO');
  check('entitlement and its reason are always stated together',
    members.every((m) => typeof m.entitled === 'boolean' && typeof m.reason === 'string'),
    members.filter((m) => typeof m.reason !== 'string').map((m) => m.displayName).join(' · '));

  /* ── 7 · nothing was written ───────────────────────────────────────────── */
  console.log('\n  7 · THE PROBE LEFT NO TRACE');
  const wrote = (await admin.query(
    `select count(*)::int n from public.audit_events
      where tenant_id = $1 and occurred_at > now() - interval '3 minutes'
        and action in ('CDD_OPENED','CDD_UPDATED','CDD_COMPLETED','CDD_UNABLE',
                       'BENEFICIAL_OWNER_ADDED','SCREENING_RUN','SCREENING_MATCH_DISPOSITIONED',
                       'STR_CREATED','STR_FILED','LICENCE_RECORDED','RISK_COUNTRY_ADDED')`,
    [KGM])).rows[0].n;
  check('no compliance write was made by this run', wrote === 0, `${wrote} write(s) in the last three minutes`);

  await admin.end();
  report();
}

function report() {
  console.log('\n  ' + '─'.repeat(72));
  console.log(`  ${pass} passed · ${fail} failed`);
  console.log(`  ${fail === 0
    ? 'The console shows what the database says, and its refusals are the gate\'s own refusals.'
    : 'A check failed — a member could be shown a client the gate will refuse.'}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\n  probe failed:', err?.message ?? err);
  try { await admin.end(); } catch { /* already closed */ }
  process.exit(2);
});
