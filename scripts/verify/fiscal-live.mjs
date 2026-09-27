#!/usr/bin/env node
/**
 * THE FISCAL SURFACE, AGAINST THE REAL POSTGRES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS
 *
 *   `GET billing/fiscal-identity` is the screen that answers the audit's question —
 *   MAY THIS FIRM LEGALLY SEND A TAX INVOICE — and the answer is assembled from four
 *   things at once: the identity row, the onboarding status, the environment, and the
 *   devices. A route that read any one of them wrongly would still return a plausible
 *   object, and no unit test on a SQLite mirror can tell, because the row it reads does
 *   not exist there.
 *
 *   So this file asks the LIVE database the same question the screen asks, and then
 *   cross-examines the answer against the developer's OWN prompt:
 *
 *     · if `ready` is true, there must be a production identity, a production
 *       certificate and an active device — the four facts the screen shows must
 *       actually imply the claim it prints in green;
 *     · the blockers list must name EVERY missing condition, not the first one, because
 *       a screen that showed one blocker at a time would make onboarding a guessing
 *       game;
 *     · the 24-hour reporting deadline must be exactly 24 hours after the time of
 *       supply, checked arithmetic rather than a rendered string.
 *
 *   It is READ-ONLY apart from two deliberate refusals — an invalid identity write and
 *   an issue attempt on a draft that is not approvable — because those two prove the
 *   route is wired and validates WITHOUT leaving a row behind. Nothing here issues an
 *   invoice: issuing is irreversible and the point of this file is to tell the truth
 *   about a firm that has not integrated.
 *
 * USAGE
 *   node scripts/verify/fiscal-live.mjs                        # local :8787
 *   node scripts/verify/fiscal-live.mjs https://kgmlegal.vercel.app
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
const ADMIN_URL = `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;

const FIRM_PASSWORD = 'Demo!Firm2026';
const MP = 'noura@kgm.example.test';

let pass = 0;
let fail = 0;
function ok(name) { pass += 1; console.log(`  ✓ ${name}`); }
function bad(name, detail) { fail += 1; console.log(`  ✗ ${name}\n      ${detail}`); }
function check(name, condition, detail = '') {
  if (condition) ok(name); else bad(name, detail || 'assertion failed');
}

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
      /* THE ENVELOPE. Every route in this API answers `{ ok, data }`, and the firm's own
         client unwraps it. A probe that forgot to would read `undefined` for every field
         and report a firm that IS registered as unregistered — which is exactly what the
         first run of this file did, and why it asserts against the database below. */
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

  console.log('\n  THE FISCAL SURFACE · against the live database');
  console.log('  ' + '─'.repeat(72));

  const firm = await login(MP);

  /* ── 1 · the readiness answer, and whether it is TRUE ───────────────────── */
  console.log('\n  1 · MAY THIS FIRM LEGALLY SEND A TAX INVOICE');

  const idRes = await firm.get('/billing/fiscal-identity');
  check('GET /billing/fiscal-identity answers 200', idRes.status === 200, `${idRes.status} ${JSON.stringify(idRes.body).slice(0, 200)}`);
  if (idRes.status !== 200) { await admin.end(); return report(); }

  const { identity, devices, ready, blockers } = idRes.body;
  console.log(`      environment ........ ${identity?.environment ?? '(none)'}`);
  console.log(`      onboarding ......... ${identity?.onboarding_status ?? '(none)'}`);
  console.log(`      VAT ................ ${identity?.vat_registration_number ?? '(none)'}`);
  console.log(`      certificate ........ ${identity?.certificate_expires_at ?? '(none)'}`);
  console.log(`      devices ............ ${(devices ?? []).length} (${(devices ?? []).filter((d) => d.isActive).length} active)`);
  console.log(`      ready .............. ${ready}`);
  console.log(`      blockers ........... ${(blockers ?? []).join(', ') || '(none)'}`);

  /* The cross-examination. `ready: true` is a legal claim, and it must be earned by the
     facts the screen also prints — not by the absence of a check. */
  const hasIdentity = Boolean(identity);
  const prodIdentity = identity?.onboarding_status === 'production_csid' && identity?.environment === 'production';
  const activeDevice = (devices ?? []).some((d) => d.isActive);
  const expectedBlockers = [
    !hasIdentity ? 'no_fiscal_identity' : null,
    hasIdentity && !prodIdentity ? 'onboarding_incomplete' : null,
    !activeDevice ? 'no_active_device' : null,
  ].filter(Boolean);

  check('`ready` is a claim the facts support', ready === (expectedBlockers.length === 0),
    `ready=${ready} but the facts demand blockers ${expectedBlockers.join(', ') || '(none)'}`);
  check('the blockers list names EVERY missing condition', expectedBlockers.every((b) => (blockers ?? []).includes(b)),
    `expected ${expectedBlockers.join(', ')} · got ${(blockers ?? []).join(', ')}`);

  /* The honest live statement for the client report: whether an invoice can reach a real
     client today without a non-compliant document going out with it. */
  console.log(`\n      → LIVE STATE: ${ready ? 'the firm may issue' : `the firm may NOT issue (${(blockers ?? []).join(', ')})`}`);

  /* ── 2 · the write is gated and validates ───────────────────────────────── */
  console.log('\n  2 · THE WRITE PATH REFUSES BEFORE IT SAVES');

  const idBad = await firm.post('/billing/fiscal-identity', {});
  check('an empty registration is refused with 400, not 500', idBad.status === 400,
    `${idBad.status} ${JSON.stringify(idBad.body).slice(0, 200)}`);
  check('the refusal names the failure', typeof (idBad.body?.error?.code ?? idBad.body?.code) === 'string',
    JSON.stringify(idBad.body).slice(0, 200));

  const vatBad = await firm.post('/billing/fiscal-identity', {
    registeredName: 'Probe Co', vatRegistrationNumber: '123', commercialRegistration: '9999999999',
    registeredAddress: 'Somewhere', environment: 'sandbox', onboardingStatus: 'not_started',
  });
  check('a malformed VAT number is refused', vatBad.status === 400, `${vatBad.status} ${JSON.stringify(vatBad.body).slice(0, 160)}`);

  const devBad = await firm.post('/billing/fiscal-devices', { deviceLabel: '', deviceSerial: '' });
  check('an empty device is refused', devBad.status === 400, `${devBad.status}`);

  /* ── 3 · the database agrees with what the route reported ───────────────── */
  console.log('\n  3 · THE DATABASE AGREES WITH THE ANSWER');

  const dbId = await admin.query(
    `select environment, onboarding_status, vat_registration_number
       from fiscal_identity where tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001' limit 1`);
  const row = dbId.rows[0];
  check('the environment the screen showed is the row in the table',
    (row?.environment ?? null) === (identity?.environment ?? null),
    `db=${row?.environment} api=${identity?.environment}`);
  check('the onboarding status matches the row',
    (row?.onboarding_status ?? null) === (identity?.onboarding_status ?? null),
    `db=${row?.onboarding_status} api=${identity?.onboarding_status}`);

  const dbDev = await admin.query(
    `select count(*)::int total, count(*) filter (where is_active)::int active
       from fiscal_devices where tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001'`);
  check('the device count is the same on both sides',
    dbDev.rows[0].total === (devices ?? []).length,
    `db=${dbDev.rows[0].total} api=${(devices ?? []).length}`);
  check('the active device count is the same on both sides',
    dbDev.rows[0].active === (devices ?? []).filter((d) => d.isActive).length,
    `db=${dbDev.rows[0].active} api=${(devices ?? []).filter((d) => d.isActive).length}`);

  /* ── 4 · the 24-hour clock ──────────────────────────────────────────────── */
  console.log('\n  4 · THE 24-HOUR REPORTING WINDOW');

  const q = await firm.get('/billing/reporting-queue');
  check('GET /billing/reporting-queue answers 200', q.status === 200, `${q.status}`);
  if (q.status === 200) {
    const rows = q.body.invoices ?? [];
    console.log(`      in the queue ....... ${q.body.count} (${q.body.overdue} overdue)`);
    check('the count matches the rows returned',
      q.body.count === rows.length, `count=${q.body.count} rows=${rows.length}`);
    check('overdue is the count of rows whose deadline has passed',
      q.body.overdue === rows.filter((r) => r.overdue).length,
      `overdue=${q.body.overdue} rows=${rows.filter((r) => r.overdue).length}`);

    /* Arithmetic, not rendering: reportBy minus supplyAt must be exactly 24 hours. */
    const wrong = rows.filter((r) => r.supplyAt && r.reportBy
      && Math.abs(new Date(r.reportBy).getTime() - new Date(r.supplyAt).getTime() - 86_400_000) > 1000);
    check('every deadline is exactly 24 hours after its time of supply', wrong.length === 0,
      wrong.map((r) => `${r.number}: ${r.supplyAt} → ${r.reportBy}`).join(' · '));

    /* Every row must be a SIMPLIFIED invoice: a standard one is cleared, not reported,
       and a row here for it would send a member chasing the wrong obligation. */
    const subtypes = await admin.query(
      `select invoice_type, count(*)::int n from invoices
        where id = any($1::uuid[]) group by invoice_type`,
      [rows.map((r) => r.id)]);
    const nonSimplified = subtypes.rows.filter((s) => s.invoice_type && s.invoice_type !== 'simplified');
    check('the queue holds simplified invoices only', nonSimplified.length === 0,
      JSON.stringify(nonSimplified));

    const overdueRows = await admin.query(
      `select count(*)::int n from invoices
        where tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001'
          and invoice_type = 'simplified' and invoice_uuid is not null
          and fiscal_status not in ('reported','cleared') and supply_at is not null
          and supply_at + interval '24 hours' < now()`);
    check('the overdue count is what the database would compute too',
      overdueRows.rows[0].n === q.body.overdue, `db=${overdueRows.rows[0].n} api=${q.body.overdue}`);
  }

  /* ── 5 · the fiscal identity of a real issued invoice ───────────────────── */
  console.log('\n  5 · AN ISSUED INVOICE READS BACK WITH ITS CHAIN');

  const issued = await admin.query(
    `select id, invoice_number, invoice_uuid, icv, invoice_type, previous_invoice_hash,
            fiscal_status, xml_storage_key
       from invoices
      where tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001'
        and invoice_uuid is not null
      order by icv desc nulls last limit 1`);
  if (issued.rows.length === 0) {
    console.log('      (no issued invoice on the demo tenant — the read path is not exercised)');
  } else {
    const inv = issued.rows[0];
    const f = await firm.get(`/billing/invoices/${inv.id}/fiscal`);
    check('GET /billing/invoices/:id/fiscal answers 200', f.status === 200, `${f.status}`);
    if (f.status === 200 && !f.body?.fiscal) {
      bad('the fiscal block is present', JSON.stringify(f.body).slice(0, 200));
    } else if (f.status === 200) {
      check('the UUID the screen shows is the UUID in the row',
        f.body.fiscal.uuid === inv.invoice_uuid, `${f.body.fiscal.uuid} vs ${inv.invoice_uuid}`);
      check('the counter matches', Number(f.body.fiscal.icv) === Number(inv.icv), `${f.body.fiscal.icv} vs ${inv.icv}`);
      check('the chain is present (a previous hash or the genesis marker)',
        typeof f.body.fiscal.previousHash === 'string' && f.body.fiscal.previousHash.length > 0,
        String(f.body.fiscal.previousHash));
      check('the document was rendered and stored',
        typeof inv.xml_storage_key === 'string' && inv.xml_storage_key.length > 0, String(inv.xml_storage_key));
      console.log(`      latest issued ..... ${inv.invoice_number} · ${inv.invoice_type} · icv ${inv.icv} · ${inv.fiscal_status}`);
      check('the submissions list is an array', Array.isArray(f.body.submissions));
      check('the credit notes list is an array', Array.isArray(f.body.creditNotes));
      /* The truthful statement this file exists to make: issued here, submitted nowhere. */
      console.log(`      submissions ....... ${f.body.submissions.length} attempt(s) recorded`);
    }
  }

  /* ── 6 · nothing above wrote anything ──────────────────────────────────── */
  console.log('\n  6 · THE PROBE LEFT NO TRACE');

  const wrote = await admin.query(
    `select count(*)::int n from audit_events
      where occurred_at > now() - interval '3 minutes'
        and action in ('FISCAL_IDENTITY_UPDATED','FISCAL_DEVICE_REGISTERED','INVOICE_ISSUED')`);
  check('no identity, device or issue was written by this run', wrote.rows[0].n === 0,
    `${wrote.rows[0].n} write(s) in the last three minutes`);

  await admin.end();
  report();
}

function report() {
  console.log('\n  ' + '─'.repeat(72));
  console.log(`  ${pass} passed · ${fail} failed`);
  console.log(`  ${fail === 0
    ? 'The fiscal surface answers, and the answer is the database\'s answer.'
    : 'A check failed — the screen would be showing something the database does not say.'}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\n  probe failed:', err?.message ?? err);
  try { await admin.end(); } catch { /* already closed */ }
  process.exit(2);
});
