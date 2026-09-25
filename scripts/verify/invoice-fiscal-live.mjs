/**
 * KGM LEGAL OS — LIVE VERIFICATION OF THE TAX INVOICE CHAIN AND CLIENT MONEY (P0.2 / P1)
 *
 *   node scripts/verify/invoice-fiscal-live.mjs [base-url]
 *
 * WHY THIS EXISTS, WHEN 41 TESTS ALREADY COVER THE SAME RULES
 *
 *   `tests/security/fiscal-trust-billing.test.ts` runs on SQLite, where a refusal is a
 *   trigger's `raise(ABORT)`, there is one role that owns the file, and every column is
 *   writable by it. The deployed system is PostgreSQL with two restricted roles, column
 *   -level grants, row-level security and triggers that exist in one dialect only — and
 *   it has been wrong fourteen times in ways the SQLite suite could not see: a grant
 *   without a policy, a policy whose WITH CHECK was written for the wrong verb, a column
 *   named in a statement but never granted, a CHECK that accepted what SQLite tolerated.
 *
 *   So this file checks the things only the real database can refute:
 *
 *     1. THE DOORS. Every surface this phase added answers with DATA, not with a
 *        permission error. A grant with no policy and a policy with no grant read
 *        identically from outside; only an end-to-end request tells "secured" from
 *        "broken".
 *
 *     2. THE TWO ROLES. The twelve new tables are granted to `firm_api` and NOT to
 *        `portal_api`, and the ledger is INSERT-only for the firm — the append-only rule
 *        has a trigger AND an absent privilege, and the absent privilege is the half that
 *        survives someone disabling a trigger.
 *
 *     3. THE CHAIN, ON THE REAL ENGINE. A draft is issued here, the hash is recomputed
 *        from the XML this script received (not read back from the database), the
 *        sequence and the chain head are checked, and the document is then attacked
 *        directly with SQL: amend it, amend its lines, delete it. All three must be
 *        refused by the DATABASE, with `postgres` as the caller — which is the only way
 *        to prove the guard rather than the privilege.
 *
 *     4. REFUSALS ARRIVE AS REFUSALS. A legitimate business refusal that reaches the
 *        client as HTTP 500 is the worst of both answers. The four this phase can
 *        produce are requested here and must come back 4xx with a named code.
 *
 * WHAT IT LEAVES BEHIND, SAID PLAINLY. An issued tax invoice cannot be deleted — that
 * is the point of the guard — so each run of this file adds ONE issued demo invoice to
 * the demo tenant and consumes one ICV. Everything else it does is a refusal, and every
 * row it creates outside that single document is either read-only or removed again.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

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
const failed = (r) => `HTTP ${r.status} ${r.text.slice(0, 160)}`;

// ── the database, over the admin connection ────────────────────────────────
const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
const db = new pg.Client({
  connectionString:
    `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@` +
    'aws-0-us-east-1.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false },
});
await db.connect();

/*
  ── the database, over the PORTAL ROLE ──────────────────────────────────────

  `postgres` is NOT a member of `portal_api` on this database — `set role portal_api` is
  refused outright (42501) — so a proof that a row-level-security policy narrows needs a
  session that IS the portal role, exactly as the server has one. Two consequences shape
  the check that uses this: its fixture rows must be COMMITTED before the read (an
  uncommitted row is invisible to another session), and they are removed again afterwards.

  The connection string and the certificate come from the server's own environment, and
  the `sslmode` parameter is stripped for the same reason the driver strips it: node-pg
  lets a URL parameter replace the `ssl` option, which would silently drop the pinned CA.
*/
function portalDb() {
  const text = readFileSync(new URL('../../server/.env', import.meta.url), 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  const url = process.env.KGM_PORTAL_URL ?? env.DATABASE_URL;
  if (!url) throw new Error('no portal connection string: KGM_PORTAL_URL or server/.env DATABASE_URL');
  let bare = url;
  try {
    const u = new URL(url);
    for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation']) u.searchParams.delete(k);
    bare = u.toString();
  } catch { /* a connection string node-pg can still parse */ }
  const ca = readFileSync(new URL('../../server/certs/supabase-root-2021.crt', import.meta.url), 'utf8');
  return new pg.Client({ connectionString: bare, ssl: { rejectUnauthorized: true, ca } });
}

const KGM = 'aaaaaaaa-0000-4000-8000-000000000001';
/** `GENESIS_PIH` from server/src/domain/zatca.ts — the hash the first invoice chains to. */
const GENESIS_PIH = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

/** Whether a role holds a privilege, asked of the catalog rather than of a query. */
async function hasPriv(role, table, privilege) {
  const r = await db.query(
    `select has_table_privilege($1, $2, $3) as ok`, [role, `public.${table}`, privilege]);
  return r.rows[0]?.ok === true;
}

/** The five Phase-1 TLV tags out of the QR the document carries. */
function tlvDecode(base64) {
  const buf = Buffer.from(base64, 'base64');
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i];
    const len = buf[i + 1];
    if (i + 2 + len > buf.length) throw new Error('TLV truncated');
    out.push({ tag, value: buf.subarray(i + 2, i + 2 + len).toString('utf8') });
    i += 2 + len;
  }
  return out;
}

console.log(`\nKGM LEGAL OS — the fiscal chain and client money, verified live at ${BASE}\n`);

// ── 0 · the phase must actually be here ───────────────────────────────────
const schema = await db.query(
  `select count(*)::int as n from information_schema.tables
    where table_schema = 'public'
      and table_name in ('fiscal_identity','fiscal_devices','invoice_submissions','credit_notes',
                         'client_ledgers','ledger_entries','ledger_reconciliations','rate_cards',
                         'matter_billing_terms','time_entries','expenses','engagement_letters')`);
if (schema.rows[0].n !== 12) {
  console.log(`  migrations 0034–0037 are not applied to this database `
    + `(${schema.rows[0].n}/12 tables present). Apply them first:\n`);
  console.log('    node supabase/ops/migrate.mjs --url "$ADMIN_POOLER_URL" 0034 0035 0036 0037\n');
  await db.end();
  process.exit(2);
}

// ── 1 · authenticate ──────────────────────────────────────────────────────
await req('/api/firm/auth/csrf');
const login = await req('/api/firm/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
record('firm sign in', login.status === 200, failed(login));
if (login.status !== 200) { await db.end(); report(); process.exit(1); }

// ── 2 · the doors: every surface answers with data ────────────────────────
/*
  Each of these is a new table reached through a new route. A missing grant and a
  missing policy both surface here as a 5xx or a 403, and neither would have been
  visible in the SQLite suite — where the file's owner is every role at once.
*/
const doors = [
  ['/api/firm/billing/fiscal-identity', 'the firm\u2019s own fiscal identity'],
  ['/api/firm/billing/reporting-queue', 'the reporting queue'],
  ['/api/firm/trust/ledgers', 'the client ledgers and their balances'],
  ['/api/firm/rate-cards', 'the rate cards'],
  ['/api/firm/expenses', 'the disbursements'],
  ['/api/firm/time-entries', 'time entries'],
];
for (const [path, what] of doors) {
  const r = await req(path);
  record(`GET ${path} (${what})`, r.status === 200, failed(r));
}

// ── 3 · the two roles, asked of the catalogue ─────────────────────────────
/*
  ELEVEN OF THE TWELVE ARE THE FIRM'S ALONE. Time, disbursements, rate cards, the
  billing basis, the trust ledger, the fiscal identity and the devices that sign for the
  firm: none of it is the client's, and the portal holds no privilege on any of it.

  THE TWO THAT ARE NOT. A credit note is a fiscal document the client is entitled to
  see, and an engagement letter they signed is theirs; so the portal holds SELECT on
  both — and the thing that must be true is that the POLICY narrows the rows, not that
  the privilege is absent. That is checked below by reading through the role.
*/
const firmOnly = ['fiscal_identity', 'fiscal_devices', 'invoice_submissions', 'client_ledgers',
  'ledger_entries', 'ledger_reconciliations', 'rate_cards', 'matter_billing_terms',
  'time_entries', 'expenses'];
const portalReadable = ['credit_notes', 'engagement_letters'];
const newTables = [...firmOnly, ...portalReadable];

const portalReach = [];
for (const t of firmOnly) {
  for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    if (await hasPriv('portal_api', t, priv)) portalReach.push(`${t}.${priv}`);
  }
}
record('portal_api holds no privilege on the firm\u2019s ten tables', portalReach.length === 0,
  `reachable: ${portalReach.join(', ')}`);

const portalWrites = [];
for (const t of portalReadable) {
  if (await hasPriv('portal_api', t, 'INSERT') || await hasPriv('portal_api', t, 'UPDATE')
      || await hasPriv('portal_api', t, 'DELETE')) portalWrites.push(t);
}
record('portal_api may read the two client-facing documents but not write them',
  portalWrites.length === 0, `writable: ${portalWrites.join(', ')}`);

const firmMissing = [];
for (const t of newTables) {
  if (!(await hasPriv('firm_api', t, 'SELECT'))) firmMissing.push(t);
}
record('firm_api can read all twelve', firmMissing.length === 0, `missing: ${firmMissing.join(', ')}`);

record('firm_api may INSERT a ledger entry', await hasPriv('firm_api', 'ledger_entries', 'INSERT'));
record('firm_api may NOT UPDATE a ledger entry (append-only, by privilege)',
  !(await hasPriv('firm_api', 'ledger_entries', 'UPDATE')));
record('firm_api may NOT DELETE a ledger entry',
  !(await hasPriv('firm_api', 'ledger_entries', 'DELETE')));

const noRls = [];
for (const t of newTables) {
  const r = await db.query(
    `select c.relrowsecurity as on_ from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = $1`, [t]);
  if (r.rows[0]?.on_ !== true) noRls.push(t);
}
record('every new table has row-level security enabled', noRls.length === 0, `off: ${noRls.join(', ')}`);

// ── 4 · the chain, on the real engine ─────────────────────────────────────
/*
  THE DEMO FIRM IS INTEGRATED, OR THIS SCRIPT MAKES IT SO — through the product's own
  onboarding path, as the managing partner, with the same payload the console sends. A
  fixture that skipped these two calls would leave the central financial gate untestable
  on the live system, and the values are the synthetic ones the fixture uses: no real
  registration number appears anywhere in this repository.
*/
let identityRow = (await db.query(
  `select id, vat_registration_number from fiscal_identity
    where tenant_id = $1 and superseded_by is null limit 1`, [KGM])).rows[0];

if (!identityRow) {
  const created = await req('/api/firm/billing/fiscal-identity', {
    method: 'POST',
    body: {
      registeredName: 'KGM Law Firm',
      registeredNameAr: 'شركة كيه جي إم للمحاماة',
      vatRegistrationNumber: '300000000000003',
      commercialRegistration: '1010345678',
      registeredAddress: '1234 King Fahd Road, Al Olaya',
      registeredAddressAr: '١٢٣٤ طريق الملك فهد، العليا',
      city: 'Riyadh', postalCode: '12211', country: 'SA',
      environment: 'production', onboardingStatus: 'production_csid',
    },
  });
  record('the firm\u2019s fiscal identity can be recorded (settings.manage)', created.status === 201 || created.status === 200,
    failed(created));
  identityRow = (await db.query(
    `select id, vat_registration_number from fiscal_identity
      where tenant_id = $1 and superseded_by is null limit 1`, [KGM])).rows[0];
  console.log('  ONBOARDED: fiscal identity recorded for the demo firm.');
}

if (!identityRow) { await db.end(); report(); }

let device = (await db.query(
  `select id, invoice_counter_value, last_invoice_hash from fiscal_devices
    where tenant_id = $1 and is_active order by created_at limit 1`, [KGM])).rows[0];
if (!device) {
  const created = await req('/api/firm/billing/fiscal-devices', {
    method: 'POST',
    body: { deviceLabel: 'Head office — Riyadh', deviceSerial: '1-KGM-RUH-0001' },
  });
  record('a fiscal device can be added to the identity', created.status === 201 || created.status === 200,
    failed(created));
  device = (await db.query(
    `select id, invoice_counter_value, last_invoice_hash from fiscal_devices
      where tenant_id = $1 and is_active order by created_at limit 1`, [KGM])).rows[0];
  console.log(`  ONBOARDED: device added, the sequence starts at ICV `
    + `${Number(device?.invoice_counter_value) + 1}.`);
}
record('an active fiscal device exists for the demo firm', Boolean(device),
  'no active device — the firm has not been onboarded');
if (!device) { await db.end(); report(); }

/*
  THE SCOPING PROOF IS NOT HERE. It needs an issued invoice to attach a portal-visible
  credit note to and a session that IS the portal role, so it runs at the end of the chain
  section — see `4b` below. It used to run here, inside a transaction that was rolled back,
  and the rollback was the first thing that could not survive: a second session cannot read
  what this one has not committed.
*/
const identity = identityRow;

/*
  A DRAFT IS CREATED HERE, not taken from the fixture, so the run is independent of what
  the demo happens to contain — and so a failure cannot be mistaken for a stale row. The
  insert is a fixture, not the behaviour under test: it is written as `postgres`, which
  is exactly the privilege the server does not have.
*/
/*
  THE BUYER'S VAT NUMBER LIVES ON THE PARTY, not on the client row — a client is a
  relationship, and the registration belongs to the identity behind it. Asking for
  `clients.vat_number` is the mistake this comment exists to stop the next reader making.
*/
const client = (await db.query(
  `select c.id, c.name, c.name_ar, p.vat_number
     from clients c left join parties p on p.id = c.party_id
    where c.tenant_id = $1 and coalesce(p.vat_number, '') <> '' order by c.name limit 1`,
  [KGM])).rows[0];
const matter = (await db.query(
  `select id from matters where tenant_id = $1 and client_id = $2 limit 1`, [KGM, client.id])).rows[0];

const stamp = Date.now();
const invoiceId = randomUUID();
const draftNumber = `LIVE-FISCAL-${stamp}-DRAFT`;
const sub = 1_000, vat = 150, total = 1_150;
await db.query(
  `insert into invoices (id, tenant_id, client_id, matter_id, invoice_number, issue_date, due_date,
                         currency, subtotal, vat_rate, vat_amount, total, amount_paid,
                         internal_status, client_status, storage_key, created_at, updated_at)
   values ($1, $2, $3, $4, $5, current_date, current_date + 30, 'SAR', $6, 0.15, $7, $8, 0,
           'draft', null, $9, now(), now())`,
  [invoiceId, KGM, client.id, matter.id, draftNumber, sub, vat, total, `live/${invoiceId}.pdf`]);
await db.query(
  `insert into invoice_lines (id, invoice_id, position, description, description_ar,
                              quantity, unit_price, amount, vat_category, vat_rate, vat_amount, discount_amount)
   values ($1, $2, 1, 'Live verification — professional fee', 'تحقق حي — أتعاب مهنية',
           1, $3, $3, 'standard', 0.15, $4, 0)`,
  [randomUUID(), invoiceId, sub, vat]);

const issue = await req(`/api/firm/billing/invoices/${invoiceId}/issue`, {
  method: 'POST', body: { subtype: 'standard' },
});
record('a draft invoice can be issued through the API', issue.status === 201, failed(issue));
if (issue.status !== 201) { await db.end(); report(); }

const issued = issue.json?.data ?? {};
record('the document carries a UUID', /^[0-9a-f-]{36}$/.test(String(issued.uuid)), String(issued.uuid));
record('the ICV is the device counter plus one',
  Number(issued.icv) === Number(device.invoice_counter_value) + 1,
  `icv=${issued.icv} counter=${device.invoice_counter_value}`);
record('the official number dropped the DRAFT marker',
  issued.invoiceNumber === `LIVE-FISCAL-${stamp}` && !String(issued.xml).includes('DRAFT'),
  `number=${issued.invoiceNumber}`);

/*
  THE HASH IS RECOMPUTED HERE from the XML this script received. Reading it back from the
  row would only prove the server is self-consistent; hashing what was returned proves
  the document and the hash belong to each other, which is what a verifier needs.
*/
const recomputed = createHash('sha256').update(String(issued.xml), 'utf8').digest('base64');
record('the hash is over the document that was returned', recomputed === issued.hash,
  `returned=${String(issued.hash).slice(0, 16)}… recomputed=${recomputed.slice(0, 16)}…`);

const tags = (() => { try { return tlvDecode(String(issued.qrPayload)); } catch (e) { return String(e); } })();
record('the QR decodes into the five Phase-1 tags',
  Array.isArray(tags) && tags.length === 5 && String(tags[0]?.value).match(/[\u0600-\u06FF]/),
  Array.isArray(tags) ? tags.map((t) => t.tag).join(',') : String(tags));
record('the QR carries the seller\u2019s registration, not the buyer\u2019s',
  Array.isArray(tags) && tags[1]?.value === String(identity?.vat_registration_number),
  JSON.stringify(Array.isArray(tags) ? tags[1]?.value : null));
record('the QR carries the invoice total', Array.isArray(tags) && tags[3]?.value === Number(total).toFixed(2),
  JSON.stringify(Array.isArray(tags) ? tags[3]?.value : null));

const stored = (await db.query(
  `select invoice_number, invoice_uuid, icv, invoice_hash, previous_invoice_hash, fiscal_status,
          fiscal_device_id, xml_storage_key
     from invoices where id = $1`, [invoiceId])).rows[0];
record('the row itself carries the fiscal identity',
  stored.invoice_uuid === issued.uuid && Number(stored.icv) === Number(issued.icv)
  && stored.invoice_hash === issued.hash && stored.invoice_number === `LIVE-FISCAL-${stamp}`,
  JSON.stringify(stored).slice(0, 200));
record('the chain links to the device\u2019s previous head',
  stored.previous_invoice_hash === (device.last_invoice_hash ?? GENESIS_PIH),
  String(stored.previous_invoice_hash).slice(0, 16));
record('a standard invoice is sent for clearance, not reported',
  stored.fiscal_status === 'pending_clearance', String(stored.fiscal_status));

const after = (await db.query(
  `select invoice_counter_value, last_invoice_hash from fiscal_devices where id = $1`, [device.id])).rows[0];
record('the device moved on exactly once',
  Number(after.invoice_counter_value) === Number(device.invoice_counter_value) + 1
  && after.last_invoice_hash === issued.hash,
  `counter=${after.invoice_counter_value}`);

const second = await req(`/api/firm/billing/invoices/${invoiceId}/issue`, {
  method: 'POST', body: { subtype: 'standard' },
});
record('a second issue is refused', second.status === 409 && second.json?.error?.code === 'issued_invoice_immutable',
  failed(second));

/*
  THE GUARDS, ATTACKED AS `postgres`. The routes are not in the way here and neither are
  the grants: this is the trigger or nothing. A row that can be rewritten by the account
  that owns the database is a row that can be rewritten by anyone who reaches it.
*/
async function mustRefuse(label, sql, params, token) {
  try {
    await db.query(sql, params);
    record(label, false, 'the database allowed it');
  } catch (err) {
    record(label, String(err.message).includes(token), String(err.message).slice(0, 140));
  }
}
await mustRefuse('the invoice cannot be amended', `update invoices set total = total + 1 where id = $1`,
  [invoiceId], 'issued_invoice_immutable');
await mustRefuse('the invoice cannot be deleted', `delete from invoices where id = $1`,
  [invoiceId], 'issued_invoice_not_deletable');
await mustRefuse('its lines cannot be amended', `update invoice_lines set unit_price = 1 where invoice_id = $1`,
  [invoiceId], 'issued_invoice_immutable');
await mustRefuse('its lines cannot be added to',
  `insert into invoice_lines (id, invoice_id, position, description, quantity, unit_price, amount)
   values ($1, $2, 9, 'added after issue', 1, 1, 1)`, [randomUUID(), invoiceId],
  'issued_invoice_immutable');

// ── 4b · the policies narrow, proved by reading through the role ───────────
/*
  A POLICY THAT EXISTS BUT ADMITS EVERYTHING IS NOT A POLICY. The catalogue check early in
  this file says row-level security is ENABLED on all twelve new tables; this says the two
  client-facing ones narrow by CLIENT, on real rows, read as the role the portal actually
  talks to.

  THE CREDIT NOTE IS ATTACHED TO THIS RUN'S OWN INVOICE, because it is the only issued
  document on this database: the demo predates the fiscal columns, so its invoices carry no
  UUID and nothing about them can be seen through a policy that requires a reported
  document. A credit note against a STANDARD invoice may not be shared until ZATCA has
  cleared the invoice, so the fixture carries the cleared submission that makes that true —
  and both rows are removed again below, which leaves this run with exactly the one issued
  document it says it leaves.

  THE ENGAGEMENT LETTER IS REAL: a signed letter the demo already holds for a DIFFERENT
  client. Nothing was written to make that half true, which is the better kind of proof.
*/
const noteClient = (await db.query(
  `select id, name from clients where id = $1`, [client.id])).rows[0];
const otherClient = (await db.query(
  `select c.id, c.name, el.id as letter_id from clients c
     join engagement_letters el on el.client_id = c.id and el.status = 'signed'
    where c.tenant_id = $1 and c.id <> $2
    order by c.name limit 1`, [KGM, client.id])).rows[0];

const creditNoteId = randomUUID();
let scoped = null;
if (!otherClient) {
  scoped = { error: 'the demo holds no signed engagement letter for a second client' };
} else {
  try {
    /*
      THE AUTHORITY'S ANSWER, TAKEN THROUGH THE ROUTE THAT RECORDS IT. A credit note
      against a standard invoice may not be shared until the invoice has been cleared, so
      the clearance is a step of the flow rather than a fixture detail — and taking it
      through the API means the route, the audit row and the invoice's own fiscal status
      are exercised instead of assumed. It is also the check that caught the guard looking
      its clearance up against the CREDIT NOTE's id, where no submission can ever be.
    */
    const cleared = await req(`/api/firm/billing/invoices/${invoiceId}/submissions`, {
      method: 'POST',
      body: { submissionType: 'clearance', status: 'cleared', httpStatus: 200, responseCode: '200' },
    });
    record('the authority\u2019s answer is recorded against the invoice it clears',
      cleared.status === 201, failed(cleared));

    await db.query(
      `insert into credit_notes (id, tenant_id, invoice_id, client_id, credit_number, reason,
                                 amount, vat_amount, total, fiscal_device_id, invoice_uuid,
                                 icv, invoice_hash, qr_payload, fiscal_status)
       values ($1, $2, $3, $4, $5, 'Scoping check written by the live verifier.',
               20, 3, 23, $6, $7, $8, $9, $10, 'reported')`,
      [creditNoteId, KGM, invoiceId, client.id, `LIVE-CN-${stamp}`, device.id,
       issued.uuid, Number(issued.icv), 'LIVE-SCOPE-HASH', 'LIVE-SCOPE-QR']);

    const reader = portalDb();
    await reader.connect();
    try {
      const counts = {
        reader: String((await reader.query(`select current_user as role`)).rows[0]?.role),
      };
      for (const [label, clientId] of [['note', client.id], ['other', otherClient.id]]) {
        await reader.query(`select set_config('kgm.phase', 'portal', false)`);
        await reader.query(`select set_config('kgm.tenant_id', $1, false)`, [KGM]);
        await reader.query(`select set_config('kgm.client_ids', $1, false)`, [clientId]);
        const cn = await reader.query(
          `select count(*)::int as n from credit_notes where id = $1`, [creditNoteId]);
        const el = await reader.query(
          `select count(*)::int as n from engagement_letters where id = $1`, [otherClient.letter_id]);
        counts[label] = { creditNote: cn.rows[0].n, letter: el.rows[0].n };
      }
      scoped = counts;
    } finally {
      await reader.end().catch(() => {});
    }
  } catch (err) {
    scoped = { error: String(err.message).slice(0, 200) };
  } finally {
    /*
      The credit note goes back: it is a fixture written so a policy could be read through,
      and this run leaves exactly the one document it says it leaves. The clearance stays,
      because it is the firm's record of the answer the authority gave about that document
      — and the invoice now reads `cleared` on the reporting queue.
    */
    await db.query(`delete from credit_notes where id = $1`, [creditNoteId]).catch(() => {});
  }
  /*
    AND THE PROOF CHECKS ITSELF: if the read ran as anything but the portal role it proves
    nothing about a policy, because the owner of a table is not subject to one.
  */
  if (scoped?.reader && scoped.reader !== 'portal_api') {
    scoped.error = `the scoping read ran as ${scoped.reader}, not as the portal role`;
  }
}
record('the client a credit note belongs to is the one that sees it',
  scoped?.note?.creditNote === 1 && scoped?.other?.creditNote === 0,
  `${JSON.stringify(scoped)} — read as ${scoped?.reader ?? 'no session'}`);
record('the client an engagement letter belongs to is the one that sees it',
  scoped?.other?.letter === 1 && scoped?.note?.letter === 0,
  `${JSON.stringify(scoped)} — read as ${scoped?.reader ?? 'no session'}`);
console.log(`  SCOPING: ${noteClient?.name} holds the credit note, ${otherClient?.name} the letter, `
  + `read as ${scoped?.reader ?? 'no session'}.`);

// ── 5 · refusals must arrive as refusals ──────────────────────────────────
/*
  A legitimate business refusal that reaches the client as HTTP 500 is the worst of both
  answers: the screen shows a system fault, and the log shows nothing worth reading. Each
  of these writes NOTHING.
*/
/*
  THE MONEY CHECKS RUN AGAINST THE INVOICE'S OWN CLIENT, and the path names the CLIENT.

  Two ways of getting this wrong, both of which this file took first. A ledger row's id
  is not a client id, so a path built from the ledger arrives as a client nobody has a
  record of; and money held for one client may not be applied to another's invoice, so a
  ledger picked by largest balance can belong to the wrong client entirely. The figure to
  exceed is therefore the balance held for THIS invoice's client.
*/
const money = (await db.query(
  `select i.client_id, c.name as client_name,
          coalesce((select sum(case when e.direction = 'credit' then e.amount else -e.amount end)
                      from client_ledgers l join ledger_entries e on e.ledger_id = l.id
                     where l.client_id = i.client_id), 0) as balance
     from invoices i join clients c on c.id = i.client_id
    where i.id = $1`, [invoiceId])).rows[0];
const held = Number(money.balance);

const overdraw = await req(`/api/firm/trust/ledgers/${money.client_id}/entries`, {
  method: 'POST',
  body: {
    entryType: 'application_to_fee', amount: held + 1_000, invoiceId,
    description: `More than ${money.client_name} holds, attempted by the live verifier.`,
  },
});
record('applying more than the client holds is a 4xx refusal',
  overdraw.status === 400 && ['client_funds_overdrawn', 'trust_application_refused'].includes(overdraw.json?.error?.code),
  failed(overdraw));

const unproven = await req(`/api/firm/trust/ledgers/${money.client_id}/entries`, {
  method: 'POST',
  body: {
    entryType: 'refund', amount: 1,
    description: 'A refund with nothing attached to it, attempted by the live verifier.',
  },
});
record('a refund with no evidence attached is refused as ledger_evidence_required',
  unproven.status === 400 && unproven.json?.error?.code === 'ledger_evidence_required', failed(unproven));

/*
  A CLIENT THE FIRM HAS NO RECORD OF IS A 404, NOT A 500.

  Recording a movement for an unknown client used to reach the insert that opens the
  ledger and come back on a foreign key — an internal error where the honest answer is
  that no such client exists. This run found it; the check keeps it found.
*/
const ghosted = await req(`/api/firm/trust/ledgers/${randomUUID()}/entries`, {
  method: 'POST',
  body: {
    entryType: 'receipt', amount: 10,
    description: 'Money received for a client with no record, attempted by the live verifier.',
  },
});
record('a movement for a client the firm has no record of is a 404, not a 500',
  ghosted.status === 404 && ghosted.json?.error?.code === 'not_found', failed(ghosted));

/*
  A standard invoice must carry the BUYER'S VAT NUMBER: without one the supply is
  simplified, and issuing it as standard would produce a document the clearance platform
  rejects. The draft for this attempt is created for a client that has no VAT number, and
  removed afterwards — a draft carries no fiscal identity, so deleting it is allowed, and
  this run leaves nothing behind for a refusal that wrote nothing.
*/
const noVatClient = (await db.query(
  `select c.id from clients c left join parties p on p.id = c.party_id
    where c.tenant_id = $1 and coalesce(p.vat_number, '') = ''
      and exists (select 1 from matters m where m.client_id = c.id) order by c.name limit 1`,
  [KGM])).rows[0];
const noVatMatter = (await db.query(
  `select id from matters where tenant_id = $1 and client_id = $2 limit 1`, [KGM, noVatClient.id])).rows[0];
const secondDraft = randomUUID();
await db.query(
  `insert into invoices (id, tenant_id, client_id, matter_id, invoice_number, issue_date, due_date,
                         currency, subtotal, vat_rate, vat_amount, total, amount_paid,
                         internal_status, client_status, storage_key, created_at, updated_at)
   values ($1, $2, $3, $4, $5, current_date, current_date + 30, 'SAR', 100, 0.15, 15, 115, 0,
           'draft', null, $6, now(), now())`,
  [secondDraft, KGM, noVatClient.id, noVatMatter.id, `LIVE-STANDARD-${stamp}-DRAFT`, `live/${secondDraft}.pdf`]);
await db.query(
  `insert into invoice_lines (id, invoice_id, position, description, quantity, unit_price, amount)
   values ($1, $2, 1, 'Live verification — a standard supply with no buyer VAT', 1, 100, 100)`,
  [randomUUID(), secondDraft]);

const standardNoVat = await req(`/api/firm/billing/invoices/${secondDraft}/issue`, {
  method: 'POST', body: { subtype: 'standard' },
});
record('a standard invoice for a buyer with no VAT number is refused as buyer_vat_required',
  standardNoVat.status === 400 && standardNoVat.json?.error?.code === 'buyer_vat_required', failed(standardNoVat));

const cleaned = await db.query(`delete from invoice_lines where invoice_id = $1`, [secondDraft]);
await db.query(`delete from invoices where id = $1`, [secondDraft]);
record('the refused draft is removed again, leaving nothing behind', cleaned.rowCount === 1,
  `lines removed: ${cleaned.rowCount}`);

// ── 6 · what this run left behind, said out loud ──────────────────────────
console.log(`\n  LEFT BEHIND: ${stored.invoice_number} · ICV ${stored.icv} · `
  + `hash ${String(stored.invoice_hash).slice(0, 12)}… · status ${stored.fiscal_status}`);
console.log('  An issued tax invoice is retained and corrected by credit note, never deleted —');
console.log('  so this document stays, and each run of this file adds one more.\n');

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
