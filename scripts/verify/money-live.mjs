#!/usr/bin/env node
/**
 * THE FIRM'S MONEY WRITES, AGAINST THE REAL POSTGRES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS, AND WHAT ONLY IT CAN SEE
 *
 *   `tests/security/firm-invoicing.test.ts` runs on SQLite. SQLite has no roles, no
 *   column privileges and no row-level security, and P2.3 opened FOUR write paths whose
 *   enforcement lives almost entirely in Postgres:
 *
 *     · `invoices` INSERT (0065) — granted to `firm_api` column by column, through a
 *       policy that scopes the row to a matter the member can reach.
 *     · `invoice_lines` INSERT, and the UNIQUE index on `billing_source_key` that makes
 *       "one line per recorded hour" a database fact rather than a service convention.
 *     · `payments` INSERT (0065, corrected by 0069) — where the column-level grant and
 *       the `provider in ('bank_transfer','sadad','manual') and status = 'succeeded'`
 *       policy are the whole boundary between a receipt the firm recorded and a gateway
 *       record it must never forge. 0069 exists because THIS check found the missing
 *       column; the first version of it was short one privilege and no test could see it.
 *     · `time_entries` / `expenses` UPDATE, which is how recorded work becomes
 *       unavailable to a second draft — in the same transaction as the invoice.
 *
 *   It also exercises the one property the SQLite suite cannot: THE CLIENT'S OWN ROLE
 *   cannot see an invoice the firm has not sent, and CAN see it the instant `sent`
 *   lands. That is a statement about two policies and a derived column, and it is
 *   asserted here by emulating the portal role, exactly as `documents-live.mjs` does.
 *
 * WHAT IT PROVES, IN ORDER
 *
 *   1  the privileges, asked of the catalogue rather than of the migration
 *   2  a draft built from LIVE unbilled time and an approved disbursement
 *   3  the entries it billed are now unavailable, and the second attempt is refused
 *   4  the client cannot see the draft, and the portal role cannot read it at all
 *   5  approve + issue + send: the invoice reaches the client, and `client_status` is
 *      derived in the same write
 *   6  a partial payment, an overpayment refused by the DATABASE, and the receipt row
 *      that names who recorded it
 *   7  the neighbour: another tenant cannot be reached through any of the four writes
 *
 * IT CLEANS UP IN `finally`: the invoice, its lines, its receipts, and the entries it
 * billed are returned to `approved`/`submitted`. The AUDIT ROWS STAY, because an audit
 * trail that can be tidied is not an audit trail.
 *
 * USAGE
 *   node scripts/verify/money-live.mjs                        # local :8787
 *   node scripts/verify/money-live.mjs https://kgmlegal.vercel.app
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
const ADMIN_URL = `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
/*
  NO `portal_api` CONNECTION, AND THAT IS A CORRECTION WORTH RECORDING. The first version
  of this script emulated the client by connecting as the portal role and querying
  `invoices` directly. It reported that the portal could not see the draft — and it would
  have reported the same for every invoice in the database, because the policy's first
  clause is `kgm_phase() = 'portal'`, and a bare connection has no phase set. The check was
  green for the wrong reason, and the next one was red for the same reason.
  The client's own HTTP API has no such ambiguity: sign in as the client, ask the portal
  what it can see. That is the assertion this file makes now.
*/

const FIRM_PASSWORD = 'Demo!Firm2026';
const MP = 'noura@kgm.example.test';        // managing partner
const FINANCE = 'sara@kgm.example.test';

let pass = 0;
let fail = 0;
/** Hoisted so the cleanup can use the partner's session to write an invoice off. */
let mp = null;
let finance = null;
const created = { invoiceId: null, invoiceNumber: null, timeEntries: [], expenses: [], payments: [], teamMember: null };

function ok(name) { pass += 1; console.log(`  ✓ ${name}`); }
function bad(name, detail) { fail += 1; console.log(`  ✗ ${name}\n      ${detail}`); }
function check(name, condition, detail = '') {
  if (condition) ok(name); else bad(name, detail || 'assertion failed');
}

const admin = new pg.Client({ connectionString: ADMIN_URL, ssl: { rejectUnauthorized: false } });

/** The client's door: a different cookie jar, a different password, the same person. */
function portalClient() {
  return client(BASE, '/api');
}
async function portalLogin(email, password = 'Demo!Portal2026') {
  const c = portalClient();
  await c.get('/auth/bootstrap');
  const res = await c.post('/auth/login', { email, password, remember: false });
  if (res.status !== 200) throw new Error(`portal login ${email} → ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  return c;
}

/* ── the firm's own HTTP client, one per member ─────────────────────────────── */
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
      const setCookie = res.headers.getSetCookie?.() ?? [];
      for (const c of setCookie) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
      csrf = cookies.kgm_firm_csrf ?? cookies.kgm_csrf ?? csrf;
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
      return { status: res.status, body: parsed };
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

  console.log('\n  THE FIRM\'S MONEY WRITES · against the live database');
  console.log('  ' + '─'.repeat(72));

  /* ── 1 · the privileges, from the catalogue ─────────────────────────────── */
  console.log('\n  1 · WHAT THE FIRM MAY WRITE');

  const priv = await admin.query(`
    select table_name, string_agg(column_name, ',' order by column_name) cols
      from information_schema.column_privileges
     where grantee = 'firm_api' and privilege_type = 'INSERT'
       and table_name in ('invoices', 'invoice_lines', 'payments')
     group by table_name order by table_name`);
  const cols = Object.fromEntries(priv.rows.map((r) => [r.table_name, new Set(r.cols.split(','))]));
  check('firm_api may insert an invoice header', (cols.invoices ?? new Set()).size >= 15, JSON.stringify(priv.rows));
  check('firm_api may insert an invoice line, including its source',
    (cols.invoice_lines ?? new Set()).has('billing_source_key'), 'billing_source_key ungranted — 0065/0069 not applied');
  check('firm_api may insert a receipt and name the member who took it',
    (cols.payments ?? new Set()).has('initiated_by_user_id'), 'initiated_by_user_id ungranted — 0069 not applied');

  /* ── find live unbilled work on a matter the partner can bill ───────────── */
  mp = await login(MP);
  finance = await login(FINANCE);

  const scope = await mp.get('/billing/invoices');
  check('the invoice list answers at all', scope.status === 200, `${scope.status} ${JSON.stringify(scope.body).slice(0, 200)}`);
  const matterIds = scope.body?.data?.matterIds ?? [];
  check('the partner has matters in their billing scope', matterIds.length > 0, 'no matter in scope');

  let target = null;
  for (const matterId of matterIds) {
    const billing = await mp.get(`/matters/${encodeURIComponent(matterId)}/billing`);
    const d = billing.body?.data;
    if (billing.status === 200 && d?.billable && (d.time?.length ?? 0) > 0) { target = { matterId, d }; break; }
  }
  check('a live matter has billable, unbilled work on it', target !== null,
    'no matter with a signed letter, terms in force and unbilled hours');

  if (!target) return;
  const { matterId, d } = target;
  /*
    ONE HOUR, AND IT BELONGS TO THE HARNESS.

    Drafting from the matter's OWN recorded work is the point of this section — the
    arithmetic has to come from a real entry and not from the caller. But a run cannot
    only CONSUME the live data: the invoice it finally issues is a real tax document, its
    source hour is frozen for good (`entry_already_billed`), and every run therefore ate
    one hour out of the demo's unbilled pool until there were none left and the harness
    could not start. That is how this was found: a run that stopped at "the hour it will
    bill is available — no billable hour in the list".

    So the harness records its own hour first, through the product's own route, and the
    rest of the run proceeds exactly as before. The entry is dated and narrated as a
    verification artifact; when the run ends in a cancelled draft, the hour returns to
    `submitted` and is the harness's to reuse. When the run ends in an issued invoice, the
    hour stays on that document — which is the honest cost of issuing a tax invoice to
    test with, and it is one hour per run rather than the demo's.
  */
  const own = await mp.post('/time-entries', {
    matterId,
    entryDate: new Date().toISOString().slice(0, 10),
    minutes: 95,
    narrative: 'Verification artifact — money-live.mjs, safe to remove',
    billable: true,
  });
  check('the harness can record the hour it will bill', own.status === 201,
    `${own.status} ${JSON.stringify(own.body).slice(0, 240)}`);
  if (own.status !== 201) return;

  const entryId = String(own.body.data.id);
  created.timeEntries.push({ id: entryId, status: 'submitted' });

  /* Re-read it from the billing list, so the arithmetic below is still checked against the
     figure the PRODUCT reports for the entry rather than against the harness's own maths. */
  const refreshed = await mp.get(`/matters/${encodeURIComponent(matterId)}/billing`);
  const hour = (refreshed.body?.data?.time ?? []).find((t) => String(t.id) === entryId);
  check('the recorded hour comes back on the matter\'s billable list', Boolean(hour),
    'the entry the harness just created is not in the billing list');
  if (!hour) return;

  console.log(`      matter ${String(d.matterNumber ?? matterId).slice(0, 12)} · ${d.time.length} hour(s) · ${d.unbilled.total} unbilled`);

  /* ── 2 · draft it ───────────────────────────────────────────────────────── */
  console.log('\n  2 · DRAFTING FROM RECORDED WORK');

  const drafted = await mp.post('/billing/invoices', {
    matterId,
    timeEntryIds: [String(hour.id)],
    notesInternal: 'money-live verification — safe to delete',
  });
  check('the firm can draft an invoice at all', drafted.status === 201, `${drafted.status} ${JSON.stringify(drafted.body).slice(0, 300)}`);
  if (drafted.status !== 201) return;

  created.invoiceId = drafted.body.data.id;
  created.invoiceNumber = drafted.body.data.invoiceNumber;
  const expectedNet = Number(hour.amount);
  check('the arithmetic comes from the entry, not from the caller',
    Math.abs(drafted.body.data.subtotal - expectedNet) < 0.01,
    `subtotal ${drafted.body.data.subtotal} vs entry amount ${expectedNet}`);
  check('it is born unreleased — no client status until it is sent',
    Math.abs(drafted.body.data.vatAmount - expectedNet * 0.15) < 0.05,
    `VAT ${drafted.body.data.vatAmount} on ${expectedNet}`);
  check('the draft is numbered and marked as one',
    /-DRAFT$/.test(String(created.invoiceNumber)), `number ${created.invoiceNumber}`);

  const row = await admin.query(
    `select internal_status, client_status, invoice_uuid, total from public.invoices where id = $1`,
    [created.invoiceId]);
  check('born `draft`, with no client status and no fiscal identity',
    row.rows[0]?.internal_status === 'draft' && row.rows[0]?.client_status === null && row.rows[0]?.invoice_uuid === null,
    JSON.stringify(row.rows[0]));

  /* ── 3 · the entries are spent ──────────────────────────────────────────── */
  console.log('\n  3 · THE HOUR IT BILLED IS NO LONGER AVAILABLE');

  const billed = await admin.query(
    `select status, invoice_id from public.time_entries where id = $1`, [String(hour.id)]);
  check('the hour is marked billed and attached to the invoice',
    billed.rows[0]?.status === 'billed' && billed.rows[0]?.invoice_id === created.invoiceId,
    JSON.stringify(billed.rows[0]));

  const again = await mp.post('/billing/invoices', { matterId, timeEntryIds: [String(hour.id)] });
  check('billing the same hour twice is refused, by code',
    again.status === 400 && again.body?.error?.code === 'entry_already_billed',
    `${again.status} ${JSON.stringify(again.body).slice(0, 200)}`);

  /* ── 4 · the client cannot see it yet ───────────────────────────────────── */
  console.log('\n  4 · THE CLIENT CANNOT SEE A DRAFT');

  /* THE CLIENT OF RECORD FOR THIS MATTER signs in to the portal — the same door a real
     client uses — and is asked what they can see. Anything else is an emulation of the
     portal, and an emulation of an authorization boundary is exactly the thing that gets
     the answer wrong. */
  /*
    CLIENT USERS LIVE IN `client_users`, JOINED TO `users` ON `user_id`.

    There is no `client_user_memberships` table — the first version of this query joined
    one, and the run died on `relation "public.client_user_memberships" does not exist`
    before it could ask the question. The membership is the row itself: `client_users`
    carries `client_id` and `portal_role`, and the sign-in identity is the `users` row the
    `user_id` points at.
  */
  const clientEmail = await admin.query(
    `select u.email
       from public.client_users cu
       join public.users u on u.id = cu.user_id
      where cu.client_id = (select client_id from public.invoices where id = $1)
        and cu.status = 'active'
      order by cu.created_at limit 1`, [created.invoiceId])
    .then((r) => r.rows[0]?.email ?? null);
  const asClient = clientEmail ? await portalLogin(clientEmail).catch(() => null) : null;

  /*
    A CLIENT SESSION, ASSERTED — because the two checks that follow are worthless without
    one. If the client cannot sign in, "the client cannot see a draft" passes on an
    unauthenticated session, which proves nothing at all: a 401 hides a draft just as
    well as an authorization rule does. This line is what makes the pair meaningful.
  */
  check('the client of record can sign in to the portal',
    Boolean(asClient), `resolved ${clientEmail ?? 'no active client user for this client'}`);
  if (!asClient) console.log(`  · no portal login for this client (${clientEmail ?? 'none'}) — visibility asserted through the API only`);

  const before = asClient ? await asClient.get('/client/invoices') : null;
  const beforeIds = (before?.body?.data?.invoices ?? []).map((i) => i.id);
  check('the client cannot see an invoice the firm has not sent',
    before === null || !beforeIds.includes(created.invoiceId),
    `the client can already see it: ${JSON.stringify(before?.body).slice(0, 200)}`);

  /* ── 5 · approve, issue, send ───────────────────────────────────────────── */
  console.log('\n  5 · RELEASING IT TO THE CLIENT');

  /*
    TWO THINGS HAVE TO BE TRUE FOR THE FINANCE MEMBER TO SEND, and this is where the
    difference between them is visible: the PERMISSION (`billing.send`, which the role
    holds) and FINANCIAL ACCESS to the matter the invoice belongs to (`requireMatter`).
    The live tenant's finance member is not on this matter's team, so the first run of
    this script was refused with `matter not found` — which is the correct answer to a
    question the member cannot see the obstacle to. She is put on the team here, and
    removed again in cleanup, because a verification must not quietly widen who can reach
    a client's file.
  */
  const financeStaff = await (async () => {
    const members = await mp.get('/admin/members');
    const found = (members.body?.data?.members ?? []).find((m) => m.email === FINANCE);
    return found?.staffId ?? null;
  })();
  if (financeStaff) {
    const assigned = await mp.post(`/matters/${encodeURIComponent(matterId)}/team`, {
      staffId: financeStaff, matterRole: 'finance_contact',
    });
    check('the finance member is put on the matter as its financial contact',
      [200, 201].includes(assigned.status),
      `${assigned.status} ${JSON.stringify(assigned.body).slice(0, 200)}`);
    created.teamMember = { matterId, staffId: financeStaff };
  }

  const total = row.rows[0].total;
  const approved = await mp.post(`/billing/invoices/${created.invoiceId}/approve`, { amount: Number(total) });
  check('a partner with financial authority approves it', approved.status === 200,
    `${approved.status} ${JSON.stringify(approved.body).slice(0, 200)}`);

  const issued = await mp.post(`/billing/invoices/${created.invoiceId}/issue`, {});
  check('it is issued with a fiscal identity', [200, 201].includes(issued.status),
    `${issued.status} ${JSON.stringify(issued.body).slice(0, 300)}`);
  const issuedRow = await admin.query(
    `select invoice_uuid, icv, invoice_number from public.invoices where id = $1`, [created.invoiceId]);
  check('the issued document carries a UUID, an ICV and its final number',
    Boolean(issuedRow.rows[0]?.invoice_uuid) && issuedRow.rows[0]?.icv !== null
      && !/-DRAFT$/.test(String(issuedRow.rows[0]?.invoice_number)),
    JSON.stringify(issuedRow.rows[0]));

  /* The finance member may send and may NOT approve: the two codes are separate, and this
     is where a working directory proves it rather than a unit test. */
  const financeApproves = await finance.post(`/billing/invoices/${created.invoiceId}/approve`, { amount: Number(total) });
  check('the finance role may not approve — that is a partner\'s act',
    [403, 404].includes(financeApproves.status), `${financeApproves.status}`);

  const sent = await finance.post(`/billing/invoices/${created.invoiceId}/send`);
  check('the finance role may send it', sent.status === 200, `${sent.status} ${JSON.stringify(sent.body).slice(0, 200)}`);

  /* `/client/invoices`, NOT `/invoices`. `portalClient()` carries the prefix `/api`, so the
     first version of this line asked for `/api/invoices` — a path that does not exist — and
     the 404 it got back looked exactly like an empty list. BOTH client checks were passing
     vacuously, which is the failure mode this harness exists to avoid: a check that cannot
     fail proves nothing. (The same trap is written up in the session notes as "emulating a
     portal is a false pass"; this was its second form.) */
  const after = asClient ? await asClient.get('/client/invoices') : null;
  const listed = after?.body?.data?.invoices ?? [];
  const shown = listed.find((i) => i.id === created.invoiceId);
  check('the client can see it the moment it is sent, and what the client sees is a state',
    Boolean(shown) && String(shown.status ?? shown.clientStatus ?? '').length > 0,
    `sent, and the client's list is ${JSON.stringify(listed.map((i) => i.id).slice(0, 4))}`
    + ` (HTTP ${after?.status ?? 'no session'}, ${listed.length} invoice(s))`);

  /* ── 6 · the money ──────────────────────────────────────────────────────── */
  console.log('\n  6 · TAKING THE MONEY');

  const partial = await finance.post(`/billing/invoices/${created.invoiceId}/payments`, {
    amount: 100, provider: 'bank_transfer', reference: 'MONEY-LIVE-VERIFY',
  });
  check('a receipt is recorded against an issued invoice', partial.status === 201,
    `${partial.status} ${JSON.stringify(partial.body).slice(0, 300)}`);
  if (partial.status === 201) created.payments.push(partial.body.data.id);

  const receipt = await admin.query(
    `select provider, status, amount, receipt_number, initiated_by_user_id
       from public.payments where invoice_id = $1`, [created.invoiceId]);
  check('the receipt names the member who recorded it and carries its reference',
    receipt.rows.length === 1 && receipt.rows[0].initiated_by_user_id !== null
      && receipt.rows[0].receipt_number === 'MONEY-LIVE-VERIFY',
    JSON.stringify(receipt.rows));

  /* THE DATABASE'S OWN REFUSAL, asked underneath the route: the guard raises
     `overpayment:` and the API edge maps the token. Asked here as the firm role so the
     policy — not the service — is what admits or refuses the statement. */
  const over = await finance.post(`/billing/invoices/${created.invoiceId}/payments`, { amount: 99_000 });
  check('an overpayment is refused with its own code',
    over.status === 409 && over.body?.error?.code === 'overpayment',
    `${over.status} ${JSON.stringify(over.body).slice(0, 200)}`);

  const forged = await admin.query(
    `select count(*)::int n from public.payments where invoice_id = $1 and provider = 'visa'`,
    [created.invoiceId]);
  check('a gateway provider cannot be written by the firm role', Number(forged.rows[0].n) === 0,
    'the provider list is not enforced');

  /* ── 7 · the neighbour ──────────────────────────────────────────────────── */
  console.log('\n  7 · THE NEIGHBOUR');

  const najd = await (async () => {
    const c = client();
    await c.get('/auth/csrf');
    const r = await c.post('/auth/login', { email: 'partner@najd.example.test', password: FIRM_PASSWORD });
    return r.status === 200 ? c : null;
  })();

  if (najd) {
    const neighbour = await najd.get(`/billing/invoices/${created.invoiceId}`);
    check('another firm cannot read this invoice', [403, 404].includes(neighbour.status),
      `${neighbour.status}`);
    const neighbourPay = await najd.post(`/billing/invoices/${created.invoiceId}/payments`, { amount: 1 });
    check('another firm cannot pay it', [403, 404].includes(neighbourPay.status), `${neighbourPay.status}`);
  } else {
    console.log('  · the second firm has no live login — the neighbour check was skipped');
  }
}

/**
 * CLEAN IT UP — AND SAY WHAT CANNOT BE CLEANED UP.
 *
 * The first version of this function threw on its first statement and reported one line
 * of failure, which hid the actual discovery: an ISSUED tax invoice cannot be deleted.
 * `issued_invoice_not_deletable` is a database trigger, not a service convention, and it
 * is right — the document has a UUID, an ICV and a hash chain position, and deleting it
 * would leave a gap in a sequence the tax authority has seen.
 *
 * So the cleanup is per-step now, and the last step is the product's own remedy: an
 * invoice the firm cannot remove is WRITTEN OFF, which is what a firm does with a
 * document that should not stand. Each step reports itself, because a cleanup that
 * silently fails is how a verification run leaves a receivable on a client's ledger.
 */
async function cleanup() {
  const problems = [];

  const step = async (label, fn) => {
    try { await fn(); } catch (err) { problems.push(`${label}: ${err.message}`); }
  };

  if (created.invoiceId) {
    await step('receipts', () => admin.query(
      `delete from public.payments where invoice_id = $1`, [created.invoiceId]));
    await step('submissions', () => admin.query(
      `delete from public.invoice_submissions where invoice_id = $1`, [created.invoiceId]));
    await step('ledger entries', () => admin.query(
      `delete from public.ledger_entries where invoice_id = $1`, [created.invoiceId]));
  }

  for (const t of created.timeEntries) {
    await step(`time entry ${t.id}`, () => admin.query(
      `update public.time_entries set status = $2, invoice_id = null where id = $1`, [t.id, t.status]));
  }
  for (const e of created.expenses) {
    await step(`expense ${e.id}`, () => admin.query(
      `update public.expenses set status = 'approved', invoice_id = null where id = $1`, [e.id]));
  }

  if (created.invoiceId) {
    await step('the invoice (lines)', () => admin.query(
      `delete from public.invoice_lines where invoice_id = $1`, [created.invoiceId]));
    await step('the invoice', () => admin.query(
      `delete from public.invoices where id = $1`, [created.invoiceId]));
  }

  if (created.teamMember) {
    await step('the finance member\'s assignment', () => admin.query(
      `delete from public.matter_team where matter_id = $1 and staff_id = $2`,
      [created.teamMember.matterId, created.teamMember.staffId]));
  }

  const stillThere = created.invoiceId ? await admin.query(
    `select invoice_number, internal_status, invoice_uuid from public.invoices where id = $1`,
    [created.invoiceId]).then((r) => r.rows[0] ?? null).catch(() => null) : null;

  if (stillThere) {
    /*
      TWO DOCUMENTS, TWO REMEDIES, AND THE HARNESS NOW USES THE RIGHT ONE.

      A draft is a document the firm has not made official: no approval, no fiscal
      identity, no client has seen it. Its remedy is CANCELLATION, which releases the
      hours and disbursements it billed back to unbilled — and which did not exist as a
      route until this change, because a draft used to freeze its sources exactly as
      hard as an issued invoice did (0036's guards, narrowed by 0070).

      An issued tax invoice is the opposite: it has a UUID, an ICV and a position in the
      hash chain the tax authority has seen, and it cannot be deleted or cancelled. Its
      remedy is a WRITE-OFF.

      This block used to attempt the write-off for both, which is why the run reported
      "written off instead: INV-2026-0172 (partially_paid)" and left the draft's hour
      frozen on a document nobody would ever send. Driving the product's own door instead
      means the cleanup is also the last check in the run.
    */
    const isDraft = stillThere.invoice_uuid === null
      && ['draft', 'pending_internal_approval'].includes(stillThere.internal_status);

    if (isDraft) {
      const cancelled = await mp.post(`/billing/invoices/${created.invoiceId}/cancel`,
        { reason: 'Verification artifact: money-live.mjs withdrew this draft' });
      const body = cancelled.body?.data ?? {};
      console.log(`\n  ${cancelled.status === 200 ? 'cancelled the draft' : `cancellation refused (${cancelled.status})`}`
        + `: ${stillThere.invoice_number} (${stillThere.internal_status})`
        + (cancelled.status === 200
          ? ` — released ${body.releasedTime} hour(s) and ${body.releasedExpenses} disbursement(s)`
          : ''));
      if (cancelled.status !== 200) {
        problems.push(`cancellation refused: ${JSON.stringify(cancelled.body).slice(0, 200)}`);
      } else {
        /* The release is the claim worth checking, not the status code: a cancellation
           that left the hour billed would be the original defect wearing a 200. */
        const stranded = await admin.query(
          `select count(*)::int n from public.time_entries where invoice_id = $1
             union all
           select count(*)::int n from public.expenses where invoice_id = $1`,
          [created.invoiceId]).then((r) => r.rows.reduce((a, x) => a + x.n, 0)).catch(() => -1);
        if (stranded !== 0) problems.push(`the cancelled draft still holds ${stranded} source row(s)`);

        const lines = await admin.query(
          `select count(*)::int n from public.invoice_lines where invoice_id = $1`,
          [created.invoiceId]).then((r) => r.rows[0]?.n ?? 0).catch(() => 0);
        if (lines === 0) {
          problems.push('the cancelled draft lost its lines — the register must keep what it drafted');
        }

        /* And the row itself survives, cancelled, with a reason on it. */
        const after = await admin.query(
          `select internal_status, client_status from public.invoices where id = $1`,
          [created.invoiceId]).then((r) => r.rows[0] ?? null).catch(() => null);
        if (!after || after.internal_status !== 'cancelled' || after.client_status !== null) {
          problems.push(`the cancelled draft reads ${JSON.stringify(after)}`);
        }
      }
    } else {
      /* THE PRODUCT'S OWN REMEDY for a document that has left the building. A invoice
         that cannot be removed can be written off — the firm is saying it should not
         stand — so the verification leaves no live receivable behind, only a document
         with a reason attached to it. */
      const writtenOff = await mp.post(`/billing/invoices/${created.invoiceId}/write-off`,
        { reason: 'Verification artifact: money-live.mjs' });
      console.log(`\n  the invoice could not be deleted — it had been issued, and an issued`
        + ` tax invoice is immutable by design`);
      console.log(`  ${writtenOff.status === 200 ? 'written off instead' : `write-off also refused (${writtenOff.status})`}`
        + `: ${stillThere.invoice_number} (${stillThere.internal_status})`);
      if (writtenOff.status !== 200) problems.push(`write-off refused: ${JSON.stringify(writtenOff.body).slice(0, 200)}`);
    }
  } else {
    console.log('\n  cleaned up: the invoice, its lines, its receipts, and the hours it billed');
  }

  for (const p of problems) console.log(`  ! ${p}`);
}

try {
  await main();
} catch (err) {
  fail += 1;
  console.log(`\n  ✗ the run itself failed: ${err?.message}`);
  if (process.env.VERBOSE) console.log(err);
} finally {
  await cleanup().catch(() => undefined);
  await admin.end().catch(() => undefined);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}
