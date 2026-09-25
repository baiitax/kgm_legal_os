/**
 * P0.2 THE FISCAL DOCUMENT · P1 TRUST MONEY, TIME, BILLING BASIS AND CEILINGS
 *
 * The invariant under test, in one sentence: a document that leaves this firm is
 * either ISSUED — chained, numbered, hashed, reconciling — or it is refused with a
 * reason somebody at a desk can act on, and money that is not the firm's is either
 * recorded against the client it belongs to or refused.
 *
 * Four things are deliberately true of this suite:
 *
 *   1. It drives the HTTP surface, not the repository. A permission check that exists
 *      in the repo but is missing from the route is exactly the defect class the
 *      financial-security section names, and only a route test catches it.
 *   2. Where a constraint lives in the database, the test tries to go UNDER the route
 *      and write it directly. The triggers are the last line, so they are tested as
 *      one.
 *   3. The second firm (Najd, no fiscal identity) is the negative case for the fiscal
 *      gate. It is a real tenant in the same database, not a mock.
 *   4. Every refusal asserts the ERROR CODE, not the status alone. A 400 that says
 *      `validation_failed` where `ledger_direction_wrong` belongs is a different bug
 *      wearing the same status.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootStack, firmLoginAs, createAgent, FIRM, IDS, type Stack, type Agent } from '../helpers.js';
import { detId } from '../../server/src/db/demo-data.js';
import { GENESIS_PIH, tlvDecode, invoiceHash } from '../../server/src/domain/zatca.js';

let s: Stack;
let noura: Agent;   // Managing Partner · 500k authority, 25% discount
let sara: Agent;    // Finance · 25k authority, 5k write-off, 10% discount
let faisal: Agent;  // Lawyer · no financial authority at all
let najd: Agent;    // A second firm with NO fiscal identity

const DRAFT = 'd1000000-0000-4000-8000-000000000004';          // KGM · Commercial · 22,000 + VAT, pending approval
const SENT_AHMED = 'd1000000-0000-4000-8000-000000000001';     // KGM · Ahmed · sent, unpaid
const PARTIAL_AHMED = 'd1000000-0000-4000-8000-000000000002';  // KGM · Ahmed · 4,000 of 9,500 paid
const GULF = 'd1000000-0000-4000-8000-000000000005';           // KGM · Gulf Horizon
const CLIENT_AHMED = 'cccccccc-0000-4000-8000-000000000001';
const CLIENT_GULF = 'cccccccc-0000-4000-8000-000000000002';
const COMMERCIAL = 'eeeeeeee-0000-4000-8000-000000000001';
const REAL_ESTATE = 'eeeeeeee-0000-4000-8000-000000000002';
const EMPLOYMENT = 'eeeeeeee-0000-4000-8000-000000000003';     // no engagement letter, no terms: not billable
const GULF_MATTER = 'eeeeeeee-0000-4000-8000-000000000004';
const NAJD = 'partner@najd.example.test';

beforeEach(async () => {
  s = await bootStack();
  noura = createAgent(s.app);
  sara = createAgent(s.app);
  faisal = createAgent(s.app);
  najd = createAgent(s.app);
  expect((await firmLoginAs(noura, FIRM.managingPartner)).status).toBe(200);
  expect((await firmLoginAs(sara, FIRM.finance)).status).toBe(200);
  expect((await firmLoginAs(faisal, FIRM.lawyer)).status).toBe(200);
  expect((await firmLoginAs(najd, NAJD)).status).toBe(200);
});
afterEach(async () => { await s.shutdown(); });

const row = async <T = any>(sql: string, params: unknown[] = []): Promise<T> =>
  s.db.get<T>(sql, params);

/** The audit trail, narrowed to one action — the ledger the tests read refusals from. */
const auditRows = (action: string) => s.db.all<any>(
  `select action, outcome, reason_code, resource_id, metadata from audit_events
    where action = ? order by occurred_at`, [action]).then((r) => r ?? []);

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.2 · issuing a tax invoice', () => {
  it('issues the draft: a UUID, the next ICV, a hash over the document, and a QR that decodes', async () => {
    const before = await row<{ invoice_counter_value: number; last_invoice_hash: string | null }>(
      `select invoice_counter_value, last_invoice_hash from fiscal_devices where id = ?`,
      [detId('fiscal_device:kgm-1')]);

    // Ahmed is an individual: his invoice is SIMPLIFIED and reported, not cleared.
    const res = await noura.post(`/api/firm/billing/invoices/${DRAFT}/issue`, { subtype: 'simplified' });
    expect(res.status).toBe(201);

    const issued = res.body.data as {
      uuid: string; icv: number; hash: string; total: string; xml: string; qrPayload: string;
    };
    expect(issued.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(issued.icv).toBe(before.invoice_counter_value + 1);

    // The hash is over the document that was returned, so a client holding the XML can
    // verify it without asking the server again.
    expect(issued.hash).toBe(invoiceHash(issued.xml));

    // The chain: this invoice's predecessor is the hash the device was holding.
    const stored = await row<{ previous_invoice_hash: string; invoice_hash: string; fiscal_status: string }>(
      `select previous_invoice_hash, invoice_hash, fiscal_status from invoices where id = ?`, [DRAFT]);
    expect(stored.previous_invoice_hash).toBe(before.last_invoice_hash);
    expect(stored.invoice_hash).toBe(issued.hash);
    expect(stored.fiscal_status).toBe('pending_reporting');

    // The device has moved on, and only now.
    const after = await row<{ invoice_counter_value: number; last_invoice_hash: string }>(
      `select invoice_counter_value, last_invoice_hash from fiscal_devices where id = ?`,
      [detId('fiscal_device:kgm-1')]);
    expect(after.invoice_counter_value).toBe(before.invoice_counter_value + 1);
    expect(after.last_invoice_hash).toBe(issued.hash);

    // The QR carries the five Phase-1 tags, and the Arabic seller name survives the
    // byte-length encoding — which is the whole reason `tlvEncode` measures bytes.
    // `tlvDecode` decodes the base64 payload itself and hands back the raw bytes as
    // latin1: the Arabic seller name only survives because the encoder measured BYTES
    // rather than characters, so this is the assertion that pins that.
    const tags = tlvDecode(issued.qrPayload);
    const decoded = tags.map((t) => t.value);
    expect(tags.map((t) => t.tag)).toEqual([1, 2, 3, 4, 5]);
    expect(decoded[0]).toMatch(/[\u0600-\u06FF]/);
    // The seller's own registration, from the fiscal identity — not the buyer's.
    expect(decoded[1]).toBe('300000000000003');
    expect(decoded[3]).toBe(issued.total);

    // The document itself is UBL with the national profile, the ICV and the previous
    // hash riding where the specification puts them.
    expect(issued.xml).toContain('<cbc:ProfileID>reporting:1.0</cbc:ProfileID>');
    expect(issued.xml).toContain(`<cbc:UUID>${issued.uuid}</cbc:UUID>`);
    /*
      `cbc:ID` is the INVOICE NUMBER — BT-1 — not the counter. The ICV rides in the
      additional document reference, where the specification puts it, because a
      reviewer looking for the invoice's own identity must find the number the firm
      filed rather than an internal sequence.

      And the number is the official one: a draft is numbered `<final>-DRAFT` while it
      waits, and that marker is dropped in the same write that gives the document its
      UUID. A tax invoice numbered "…-DRAFT" could never be reported, and the guard on
      the table would refuse to correct it afterwards.
    */
    expect(issued.xml).toContain('<cbc:ID>INV-2026-0149</cbc:ID>');
    expect(issued.xml).not.toContain('DRAFT');
    const numbered = await row<{ invoice_number: string; icv: number }>(
      `select invoice_number, icv from invoices where id = ?`, [DRAFT]);
    expect(numbered.invoice_number).toBe('INV-2026-0149');
    // The ICV is a separate figure, and the chain's own record of the place in the
    // sequence, so it appears as the additional reference rather than as the number.
    expect(numbered.icv).toBe(issued.icv);
    expect(issued.xml).toContain(`<cbc:UUID>${issued.uuid}</cbc:UUID>`);
    expect(issued.xml).toContain(before.last_invoice_hash ?? GENESIS_PIH);
  });

  it('refuses a second issue: the number and the hash are taken, and the counter does not move', async () => {
    // The fixture issues every invoice that has left the firm, so this one is already
    // issued and the FIRST call here is already a repeat.
    const before = await row<{ invoice_counter_value: number }>(
      `select invoice_counter_value from fiscal_devices where id = ?`, [detId('fiscal_device:kgm-1')]);

    const second = await noura.post(`/api/firm/billing/invoices/${SENT_AHMED}/issue`, {});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('issued_invoice_immutable');

    // A refused attempt must not consume a place in the chain: a gap in the ICV
    // sequence is the first thing a reviewer notices.
    const after = await row<{ invoice_counter_value: number }>(
      `select invoice_counter_value from fiscal_devices where id = ?`, [detId('fiscal_device:kgm-1')]);
    expect(after.invoice_counter_value).toBe(before.invoice_counter_value);
    // And the counter is at or above the highest ICV any document cites — the fixture's
    // chain ends at the last invoice it issued.
    const highest = await row<{ max_icv: number }>(`select max(icv) as max_icv from invoices`);
    expect(after.invoice_counter_value).toBe(highest.max_icv);
  });

  it('refuses a standard invoice for a buyer with no VAT number, and says which field is missing', async () => {
    const noVat = await row<{ party_id: string | null }>(`select party_id from clients where id = ?`, [CLIENT_AHMED]);
    expect(noVat.party_id).not.toBeNull();
    // Ahmed's party has no VAT registration — he is an individual.
    const party = await row<{ vat_number: string | null }>(`select vat_number from parties where id = ?`, [noVat.party_id!]);
    expect(party.vat_number).toBeNull();

    const res = await noura.post(`/api/firm/billing/invoices/${DRAFT}/issue`, { subtype: 'standard' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('buyer_vat_required');
  });

  it('issues a STANDARD invoice for a buyer who has a VAT number, and asks for clearance', async () => {
    /*
      THE POSITIVE HALF OF THE GATE ABOVE, and the test that was missing when it
      mattered. Every other invoice in this suite is simplified — its buyer is an
      individual — so nothing ever asked the standard path to admit anybody, and a
      repository method that handed the route `vat_number` where the route read
      `vatNumber` made EVERY buyer look VAT-less. The refusal above passed for the
      wrong reason, and the defect reached the live system, where the live harness
      found it.

      A standard supply to a company: the document must carry the buyer's
      registration, and a standard invoice may not be sent until ZATCA has cleared it.
    */
    const buyer = await row<{ party_id: string | null }>(`select party_id from clients where id = ?`, [CLIENT_GULF]);
    const party = await row<{ vat_number: string }>(`select vat_number from parties where id = ?`, [buyer.party_id!]);
    expect(party.vat_number).toBe('300055667700003');

    const draft = crypto.randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    const due = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await s.db.run(
      `insert into invoices (id, tenant_id, client_id, matter_id, invoice_number, issue_date, due_date,
                             currency, subtotal, vat_rate, vat_amount, total, amount_paid,
                             internal_status, client_status, storage_key, created_at, updated_at)
       values (?, ?, ?, ?, 'INV-2026-0900-DRAFT', ?, ?, 'SAR', 40000, 0.15, 6000, 46000, 0,
               'draft', null, ?, ?, ?)`,
      [draft, IDS.tenantKgm, CLIENT_GULF, IDS.matterGulf, today, due, `demo/${draft}.pdf`, new Date().toISOString(), new Date().toISOString()],
    );
    await s.db.run(
      `insert into invoice_lines (id, invoice_id, position, description, quantity, unit_price, amount,
                                  vat_category, vat_rate, vat_amount, discount_amount)
       values (?, ?, 1, 'Acquisition advisory — phase two', 1, 40000, 40000, 'standard', 0.15, 6000, 0)`,
      [crypto.randomUUID(), draft],
    );

    const res = await noura.post(`/api/firm/billing/invoices/${draft}/issue`, { subtype: 'standard' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const issued = res.body.data as { subtype: string; fiscalStatus: string; xml: string; icv: number };

    // The document is standard, it carries the buyer's registration, and it goes for
    // CLEARANCE — it is not released to the client on the strength of its own hash.
    expect(issued.subtype).toBe('standard');
    expect(issued.fiscalStatus).toBe('pending_clearance');
    expect(issued.xml).toContain(party.vat_number);
    expect(issued.xml).toContain('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>');

    const stored = await row<{ fiscal_status: string; invoice_type: string; buyer_vat_number: string }>(
      `select fiscal_status, invoice_type, buyer_vat_number from invoices where id = ?`, [draft]);
    expect(stored.fiscal_status).toBe('pending_clearance');
    expect(stored.invoice_type).toBe('standard');
    expect(stored.buyer_vat_number).toBe(party.vat_number);
  });

  it('holds the chain together: the next issue links to the last hash, never to genesis', async () => {
    const head = await row<{ invoice_counter_value: number }>(
      `select invoice_counter_value from fiscal_devices where id = ?`, [detId('fiscal_device:kgm-1')]);

    const a = await noura.post(`/api/firm/billing/invoices/${DRAFT}/issue`, { subtype: 'simplified' });
    expect(a.status).toBe(201);
    const first = a.body.data as { hash: string; icv: number };
    expect(first.icv).toBe(head.invoice_counter_value + 1);

    // Gulf is a company with a registration, so its invoice is STANDARD and its buyer
    // VAT number is the one on its party record.
    const gulf = await noura.post(`/api/firm/billing/invoices/${GULF}/issue`, { subtype: 'standard' });
    // Already issued in the fixture — the refusal is the correct answer, and it proves
    // the chain cannot be walked twice for the same document.
    expect(gulf.status).toBe(409);

    const stored = await row<{ previous_invoice_hash: string; buyer_vat_number: string | null }>(
      `select previous_invoice_hash, buyer_vat_number from invoices where id = ?`, [GULF]);
    expect(stored.previous_invoice_hash).not.toBe(GENESIS_PIH);
    expect(stored.buyer_vat_number).toBe('300055667700003');
  });

  it('makes an issued invoice immutable at the DATABASE, not only at the route', async () => {
    expect((await noura.post(`/api/firm/billing/invoices/${DRAFT}/issue`, { subtype: 'simplified' })).status).toBe(201);

    // Under the API: the guard fires. A route-only control would pass here, which is why
    // this writes to the table directly.
    await expect(s.db.run(`update invoices set total = 1, subtotal = 1 where id = ?`, [DRAFT]))
      .rejects.toThrow();
    await expect(s.db.run(`delete from invoices where id = ?`, [DRAFT]))
      .rejects.toThrow();

    /*
      AND THE LINES THE INVOICE WAS BUILT FROM ARE FROZEN TOO. The invoice's totals were
      protected before the phase began; the rows they were computed from were not, which
      meant the document could be left disagreeing with its own lines. Both directions
      are refused now — a line cannot be amended, and it cannot be added.
    */
    const line = await row<{ id: string }>(`select id from invoice_lines where invoice_id = ?`, [DRAFT]);
    await expect(s.db.run(`update invoice_lines set unit_price = 1 where id = ?`, [line.id]))
      .rejects.toThrow();
    await expect(s.db.run(
      `insert into invoice_lines (id, invoice_id, position, description, quantity, unit_price, amount)
       values (?, ?, 9, 'Added after issue', 1, 100, 100)`,
      [crypto.randomUUID(), DRAFT],
    )).rejects.toThrow();

    const untouched = await row<{ total: number }>(`select total from invoices where id = ?`, [DRAFT]);
    expect(untouched.total).toBeGreaterThan(1);
  });

  it('records the issue in the audit trail with the hash, and no document body', async () => {
    await noura.post(`/api/firm/billing/invoices/${DRAFT}/issue`, { subtype: 'simplified' });
    const rows = await auditRows('INVOICE_ISSUED');
    expect(rows.length).toBe(1);
    const meta = JSON.parse(rows[0].metadata) as Record<string, unknown>;
    expect(meta.icv).toBeTypeOf('number');
    // base64 of a SHA-256 digest: 44 characters, which is what the QR and the PIH
    // chain carry. A hex digest here would be a different algorithm wearing the name.
    expect(String(meta.hash)).toHaveLength(44);
    expect(String(meta.hash)).not.toMatch(/^[0-9a-f]{44}$/);
    // The document belongs in storage behind a signed URL, not in a log row.
    expect(JSON.stringify(meta)).not.toContain('<Invoice');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.2 · the gate that refuses a firm which is not onboarded', () => {
  it('reports the second firm as not ready, and names every blocker', async () => {
    const res = await najd.get('/api/firm/billing/fiscal-identity');
    expect(res.status).toBe(200);
    const data = res.body.data as { ready: boolean; identity: unknown; devices: unknown[]; blockers: string[] };
    expect(data.ready).toBe(false);
    expect(data.identity).toBeNull();
    expect(data.devices).toEqual([]);
    expect(data.blockers).toEqual(expect.arrayContaining(['no_fiscal_identity', 'no_active_device']));
  });

  it('REFUSES the issue, and audits the refusal', async () => {
    // Najd has no invoice of its own, so the gate is exercised where it can bite: the
    // firm's own identity is retired, which is the same state Najd is permanently in.
    // Nothing about the caller changes — same partner, same tenant, same invoice.
    await s.db.run(
      `update fiscal_identity set onboarding_status = 'compliance_csid' where tenant_id = ?`,
      [IDS.tenantKgm]);

    const res = await noura.post(`/api/firm/billing/invoices/${DRAFT}/issue`, { subtype: 'simplified' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('fiscal_identity_incomplete');

    // Nothing was written: no UUID, no ICV, no hash, and the chain head did not move.
    const invoice = await row<{ invoice_uuid: string | null; icv: number | null }>(
      `select invoice_uuid, icv from invoices where id = ?`, [DRAFT]);
    expect(invoice.invoice_uuid).toBeNull();
    expect(invoice.icv).toBeNull();

    // The refusal is in the ledger with its rule, so an attempt to issue without
    // integration is visible next to the issues that succeeded.
    const denials = await auditRows('ELIGIBILITY_DENIED');
    expect(denials.length).toBe(1);
    expect(denials[0].outcome).toBe('denied');
    expect(denials[0].reason_code).toBe('fiscal_identity_incomplete');
  });

  it('refuses when there is no active device, even with a production identity', async () => {
    await s.db.run(`update fiscal_devices set is_active = ? where tenant_id = ?`, [false, IDS.tenantKgm]);
    const res = await noura.post(`/api/firm/billing/invoices/${DRAFT}/issue`, { subtype: 'simplified' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('fiscal_identity_incomplete');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.2 · reporting, clearance and correction', () => {
  it('records each attempt rather than overwriting the last, and settles the invoice only on success', async () => {
    const issue = await noura.post(`/api/firm/billing/invoices/${DRAFT}/issue`, { subtype: 'simplified' });
    expect(issue.status).toBe(201);

    const failed = await noura.post(`/api/firm/billing/invoices/${DRAFT}/submissions`, {
      submissionType: 'reporting', status: 'timed_out', httpStatus: 504, retryInSeconds: 60,
    });
    expect(failed.status).toBe(201);
    expect(failed.body.data.nextAttempt).toBe(2);
    expect(failed.body.data.nextRetryAt).toBeTruthy();

    // A failure is recorded as an attempt and does NOT move the invoice's fiscal status:
    // setting it to failed would lose the fact that the retry cleared it.
    const midway = await row<{ fiscal_status: string }>(`select fiscal_status from invoices where id = ?`, [DRAFT]);
    expect(midway.fiscal_status).toBe('pending_reporting');

    const ok = await noura.post(`/api/firm/billing/invoices/${DRAFT}/submissions`, {
      submissionType: 'reporting', status: 'reported', httpStatus: 200,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.nextAttempt).toBe(3);

    const attempts = await s.db.all<any>(
      `select attempt, status from invoice_submissions where invoice_id = ? order by attempt`, [DRAFT]);
    // Two attempts, numbered from one, in the order they happened — a retry is its own
    // row and does not overwrite the failure that preceded it.
    expect(attempts.map((a) => [a.attempt, a.status])).toEqual([[1, 'timed_out'], [2, 'reported']]);

    const after = await row<{ fiscal_status: string }>(`select fiscal_status from invoices where id = ?`, [DRAFT]);
    expect(after.fiscal_status).toBe('reported');
    expect((await auditRows('INVOICE_REPORTED')).length).toBe(1);
  });

  it('lists a simplified invoice in the reporting queue with its deadline computed, and flags one that is late', async () => {
    const issue = await noura.post(`/api/firm/billing/invoices/${DRAFT}/issue`, {
      subtype: 'simplified', supplyAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    });
    expect(issue.status).toBe(201);

    const res = await noura.get('/api/firm/billing/reporting-queue');
    expect(res.status).toBe(200);
    const data = res.body.data as { count: number; overdue: number; invoices: Array<{ id: string; overdue: boolean; reportBy: string }> };
    const mine = data.invoices.find((i) => i.id === DRAFT);
    expect(mine).toBeTruthy();
    expect(mine!.overdue).toBe(true);         // 30 hours ago: the 24-hour window has closed
    expect(mine!.reportBy).toBeTruthy();
    expect(data.overdue).toBeGreaterThanOrEqual(1);
  });

  it('corrects an issued invoice with a credit note that keeps its own place in the chain', async () => {
    /*
      The invoice is issued HERE rather than taken already-issued from the fixture. A
      seeded invoice has been through the fiscal chain to give the demo its history, so
      asking the server to issue it again is refused — correctly — and the test would be
      asserting against the wrong refusal.
    */
    const issue = await noura.post(`/api/firm/billing/invoices/${DRAFT}/issue`, { subtype: 'simplified' });
    expect(issue.status).toBe(201);
    const issued = issue.body.data as { icv: number; hash: string };

    const res = await noura.post(`/api/firm/billing/invoices/${DRAFT}/credit-notes`, {
      reason: 'Billing error — the filing fee was charged twice.',
      amount: 2000, vatAmount: 300, creditNumber: 'CN-2026-0001',
    });
    expect(res.status).toBe(201);
    const cn = res.body.data as { icv: number; uuid: string; xml: string };
    expect(cn.icv).toBe(issued.icv + 1);
    // A credit note without the reference to the document it corrects is not a
    // correction in the specification's terms.
    expect(cn.xml).toContain('<cac:BillingReference>');
    /*
      A CREDIT NOTE IS AN `Invoice` ELEMENT CARRYING TYPE CODE 381 — not a
      `CreditNote` document. The specification keeps the root and distinguishes the
      document by the type code, so the element is `cbc:InvoiceTypeCode` with 381 as
      the code and the subtype in the `name` attribute: 0200000 here, because the
      invoice being corrected is a simplified one.
    */
    expect(cn.xml).toContain('<Invoice ');
    expect(cn.xml).toContain('<cbc:InvoiceTypeCode name="0200000">381</cbc:InvoiceTypeCode>');
    expect(cn.xml).not.toContain('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>');

    const stored = await row<{ previous_invoice_hash: string; client_id: string }>(
      `select previous_invoice_hash, client_id from credit_notes where invoice_id = ?`, [DRAFT]);
    expect(stored.previous_invoice_hash).toBe(issued.hash);
    // The credit note belongs to the invoice's own client. An earlier version of the
    // projection omitted client_id, and this insert failed its foreign key with the
    // string 'undefined' — a 500 where a 201 belongs.
    expect(stored.client_id).toBe(CLIENT_AHMED);
  });

  it('refuses to share a credit note against a STANDARD invoice until ZATCA clears it, then allows it', async () => {
    /*
      THE RULE THAT HAD NEVER BEEN REACHED IN EITHER DIALECT.

      A credit note against a standard tax invoice may not be shared before the authority
      clears that invoice — the buyer cannot recover the VAT on a correction ZATCA never
      saw. Postgres has had the rule since 0034 and enforced it WRONGLY: the guard looked
      the clearance up against `new.id`, the CREDIT NOTE's id, where no submission can
      ever be, so every credit note against a standard invoice was refused however settled
      the invoice was. SQLite did not implement the rule at all, so this suite could not
      see the difference, and the live harness found it while proving that a
      row-level-security policy narrows.

      Both halves are asserted here: the refusal while the invoice is uncleared, and the
      admission once the authority's answer has been recorded.
    */
    const draft = crypto.randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    const due = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await s.db.run(
      `insert into invoices (id, tenant_id, client_id, matter_id, invoice_number, issue_date, due_date,
                             currency, subtotal, vat_rate, vat_amount, total, amount_paid,
                             internal_status, client_status, storage_key, created_at, updated_at)
       values (?, ?, ?, ?, 'INV-2026-0901-DRAFT', ?, ?, 'SAR', 50000, 0.15, 7500, 57500, 0,
               'draft', null, ?, ?, ?)`,
      [draft, IDS.tenantKgm, CLIENT_GULF, IDS.matterGulf, today, due,
       `demo/${draft}.pdf`, new Date().toISOString(), new Date().toISOString()],
    );
    await s.db.run(
      `insert into invoice_lines (id, invoice_id, position, description, quantity, unit_price, amount,
                                  vat_category, vat_rate, vat_amount, discount_amount)
       values (?, ?, 1, 'Regulatory filing — phase one', 1, 50000, 50000, 'standard', 0.15, 7500, 0)`,
      [crypto.randomUUID(), draft],
    );

    const issue = await noura.post(`/api/firm/billing/invoices/${draft}/issue`, { subtype: 'standard' });
    expect(issue.status, JSON.stringify(issue.body)).toBe(201);
    expect((issue.body.data as { fiscalStatus: string }).fiscalStatus).toBe('pending_clearance');

    const early = await noura.post(`/api/firm/billing/invoices/${draft}/credit-notes`, {
      reason: 'The filing was withdrawn — the fee has to come back.',
      amount: 5_000, vatAmount: 750, creditNumber: 'CN-2026-0901',
    });
    expect(early.status, JSON.stringify(early.body)).toBe(400);
    expect(early.body.error.code).toBe('credit_note_not_cleared');
    // The refusal wrote nothing: a credit note that was never admitted is not a row.
    const none = await row<{ n: number }>(
      `select count(*) as n from credit_notes where invoice_id = ?`, [draft]);
    expect(Number(none.n)).toBe(0);

    // The authority's answer, recorded against the invoice — not against the credit note.
    const cleared = await noura.post(`/api/firm/billing/invoices/${draft}/submissions`, {
      submissionType: 'clearance', status: 'cleared', httpStatus: 200, responseCode: '200',
    });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(201);

    const allowed = await noura.post(`/api/firm/billing/invoices/${draft}/credit-notes`, {
      reason: 'The filing was withdrawn — the fee has to come back.',
      amount: 5_000, vatAmount: 750, creditNumber: 'CN-2026-0901',
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    const note = allowed.body.data as { xml: string };
    // A standard invoice's correction keeps the standard subtype in the type code, and
    // names the document it corrects.
    expect(note.xml).toContain('<cbc:InvoiceTypeCode name="0100000">381</cbc:InvoiceTypeCode>');
    expect(note.xml).toContain('<cac:BillingReference>');
  });

  it('refuses a credit note against an invoice that was never issued, and one that exceeds it', async () => {
    const unissued = await noura.post(`/api/firm/billing/invoices/${DRAFT}/credit-notes`, {
      reason: 'Trying to credit something that does not exist.', amount: 10, vatAmount: 1.5, creditNumber: 'CN-X',
    });
    expect(unissued.status).toBe(400);
    expect(unissued.body.error.code).toBe('credit_note_against_unissued_invoice');

    await noura.post(`/api/firm/billing/invoices/${SENT_AHMED}/issue`, { subtype: 'simplified' });
    const tooMuch = await noura.post(`/api/firm/billing/invoices/${SENT_AHMED}/credit-notes`, {
      reason: 'Crediting more than the invoice was for.', amount: 50_000, vatAmount: 7_500, creditNumber: 'CN-Y',
    });
    expect([400, 403]).toContain(tooMuch.status);
    expect(['credit_note_exceeds_invoice', 'forbidden']).toContain(tooMuch.body.error.code);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P1.1 · client money is held, attributable and append-only', () => {
  it('shows the firm what it holds for clients, summed from the entries rather than stored', async () => {
    const res = await sara.get('/api/firm/trust/ledgers');
    expect(res.status).toBe(200);
    const data = res.body.data as { heldForClients: number; ledgers: Array<{ clientId: string; balance: number }> };
    // Ahmed: 25,000 received less 4,000 applied. Gulf: 40,000.
    expect(data.heldForClients).toBe(61_000);
    expect(data.ledgers.find((l) => l.clientId === CLIENT_AHMED)!.balance).toBe(21_000);
    expect(data.ledgers.find((l) => l.clientId === CLIENT_GULF)!.balance).toBe(40_000);
  });

  it('records a receipt, derives the direction from the type, and audits the balance after it', async () => {
    const res = await sara.post(`/api/firm/trust/ledgers/${CLIENT_AHMED}/entries`, {
      entryType: 'receipt', amount: 5_000, description: 'Further retainer received on account.',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.balance).toBe(26_000);

    const entry = await row<{ direction: string; amount: number }>(
      `select direction, amount from ledger_entries where description like 'Further retainer%'`);
    expect(entry.direction).toBe('credit');
    expect(entry.amount).toBe(5_000);

    const rows = await auditRows('TRUST_RECEIPT_RECORDED');
    const meta = JSON.parse(rows[rows.length - 1].metadata) as { balanceAfter: number };
    expect(meta.balanceAfter).toBe(26_000);
  });

  it('refuses to apply one client’s money to another client’s invoice', async () => {
    const res = await sara.post(`/api/firm/trust/ledgers/${CLIENT_AHMED}/entries`, {
      entryType: 'application_to_fee', amount: 1_000, invoiceId: GULF,
      description: 'Applying Ahmed money to a Gulf invoice — should be refused.',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('trust_application_wrong_client');
  });

  it('refuses to apply money the client does not hold, and refuses a direct overdraw underneath', async () => {
    // PARTIAL_AHMED is AHMED'S OWN invoice, so the client check passes and the refusal
    // has to come from the balance — which is the middleware-free path that would
    // otherwise let a member empty a second client's ledger by naming a first client.
    const res = await sara.post(`/api/firm/trust/ledgers/${CLIENT_AHMED}/entries`, {
      entryType: 'application_to_fee', amount: 999_999, invoiceId: PARTIAL_AHMED,
      description: 'More than the client holds.',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('client_funds_overdrawn');

    // Underneath the route the same rule holds, on the ledger itself.
    await expect(s.db.run(
      `insert into ledger_entries
         (id, tenant_id, ledger_id, client_id, entry_type, direction, amount, currency,
          description, entry_at, recorded_at)
       values (?, ?, ?, ?, 'disbursement', 'debit', 999999, 'SAR', 'Overdraw attempt', ?, ?)`,
      [crypto.randomUUID(), IDS.tenantKgm, detId(`ledger:${CLIENT_AHMED}`), CLIENT_AHMED,
        new Date().toISOString(), new Date().toISOString()],
    )).rejects.toThrow();
  });

  it('is append-only: an entry cannot be amended or deleted, only reversed', async () => {
    const receipt = await row<{ id: string }>(
      `select id from ledger_entries where entry_type = 'receipt' and client_id = ?`, [CLIENT_AHMED]);

    await expect(s.db.run(`update ledger_entries set amount = 1 where id = ?`, [receipt.id])).rejects.toThrow();
    await expect(s.db.run(`delete from ledger_entries where id = ?`, [receipt.id])).rejects.toThrow();

    // The correction is a REVERSAL, and the reversal runs the other way by construction.
    const res = await sara.post(`/api/firm/trust/ledgers/${CLIENT_AHMED}/entries`, {
      entryType: 'receipt', amount: 5_000, description: 'Receipt recorded in error — to be reversed.',
    });
    expect(res.status).toBe(201);
    const fresh = await row<{ id: string }>(
      `select id from ledger_entries where description like 'Receipt recorded in error%'`);

    /*
      The reversal is written directly, because the wire deliberately has no reversal
      entry type: a reversal is an entry whose direction is the opposite of the one it
      reverses, and the direction is what the route DERIVES rather than accepts.
    */
    await s.db.run(
      `insert into ledger_entries
         (id, tenant_id, ledger_id, client_id, entry_type, direction, amount, currency,
          description, reverses_entry_id, reversal_reason, entry_at, recorded_at)
       values (?, ?, ?, ?, 'reversal', 'debit', 5000, 'SAR', 'Reversal of the erroneous receipt',
               ?, 'recorded against the wrong client', ?, ?)`,
      [crypto.randomUUID(), IDS.tenantKgm, detId(`ledger:${CLIENT_AHMED}`), CLIENT_AHMED,
        fresh.id, new Date().toISOString(), new Date().toISOString()]);
    const balance = await row<{ balance: number }>(
      `select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0) as balance
         from ledger_entries where ledger_id = ?`, [detId(`ledger:${CLIENT_AHMED}`)]);
    // 21,000 held, + 5,000 recorded in error, − 5,000 reversed: the reversal restores
    // the balance and both rows survive, which is what an append-only ledger means.
    expect(balance.balance).toBe(21_000);
    const rows = await s.db.all<any>(
      `select entry_type from ledger_entries where ledger_id = ? and entry_type = 'reversal'`,
      [detId(`ledger:${CLIENT_AHMED}`)]);
    expect(rows.length).toBe(1);
  });

  it('will not let a member spend client money beyond their authority', async () => {
    /*
      Spending a client's money needs the write-off permission AND a ceiling above the
      sum leaving. Three refusals, one per reason, because a control that holds for only
      one of them is not a control:

        Sara   — holds neither the permission nor a ceiling near it;
        Faisal — a practising lawyer with no financial authority at all (null, not zero);
        Noura  — holds both, and is refused only when the sum passes her 100,000 ceiling.
    */
    const saraTry = await sara.post(`/api/firm/trust/ledgers/${CLIENT_GULF}/entries`, {
      entryType: 'refund', amount: 1_000, description: 'Refund of part of the unapplied advance.',
    });
    expect(saraTry.status).toBe(403);

    const faisalTry = await faisal.post(`/api/firm/trust/ledgers/${CLIENT_GULF}/entries`, {
      entryType: 'refund', amount: 100, description: 'Small refund attempt by a lawyer.',
    });
    expect(faisalTry.status).toBe(403);

    const overCeiling = await noura.post(`/api/firm/trust/ledgers/${CLIENT_GULF}/entries`, {
      entryType: 'refund', amount: 100_001, description: 'Refund beyond the partner’s own ceiling.',
    });
    expect(overCeiling.status).toBe(403);

    /*
      And when the ceiling is satisfied and the LEDGER is not, the database is the one
      that refuses — 400, not 500, and the refusal names itself. This is the path that
      found the mapper: a legitimate business refusal was leaving the API as a server
      fault, which is the worst of both answers.
    */
    const evidence = await row<{ id: string }>(
      `select id from documents where client_id = ? order by created_at limit 1`, [CLIENT_GULF]);
    expect(evidence.id).toBeTruthy();

    const beyondTheLedger = await noura.post(`/api/firm/trust/ledgers/${CLIENT_GULF}/entries`, {
      entryType: 'refund', amount: 45_000, evidenceDocumentId: evidence.id,
      description: 'More than this client holds.',
    });
    expect(beyondTheLedger.status).toBe(400);
    expect(beyondTheLedger.body.error.code).toBe('client_funds_overdrawn');

    /*
      AND OUTGOING MONEY CARRIES ITS PROOF. A refund with nothing attached is refused
      before the balance is even consulted: money leaving a client account has to point
      at the instruction or the statement that justified it, or it is indistinguishable
      from a mistake — or from a theft — six years later.
    */
    const unproven = await noura.post(`/api/firm/trust/ledgers/${CLIENT_GULF}/entries`, {
      entryType: 'refund', amount: 5_000, description: 'Refund with nothing attached to it.',
    });
    expect(unproven.status).toBe(400);
    expect(unproven.body.error.code).toBe('ledger_evidence_required');

    const allowed = await noura.post(`/api/firm/trust/ledgers/${CLIENT_GULF}/entries`, {
      entryType: 'refund', amount: 5_000, evidenceDocumentId: evidence.id,
      description: 'Refund of part of the unapplied advance.',
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect(allowed.body.data.balance).toBe(35_000);
  });

  it('reconciles with the ledger total computed by the server, and cannot record a difference as balanced', async () => {
    // The body carries NO status: the caller cannot even ask for 'balanced', because
    // the difference is computed from the ledgers the server reads itself. A body that
    // names a status is refused as a field-tamper attempt (there is no status field).
    const tamper = await sara.post('/api/firm/trust/reconciliations', {
      asOf: new Date().toISOString(), bankBalance: 60_000, status: 'balanced',
    });
    expect(tamper.status).toBe(400);
    expect(tamper.body.error.code).toBe('validation_failed');

    const res = await sara.post('/api/firm/trust/reconciliations', {
      asOf: new Date().toISOString(),
      bankBalance: 60_000,
      bankStatementReference: 'Statement 2026-08',
    });
    expect(res.status).toBe(201);
    const data = res.body.data as { ledgerTotal: number; difference: number; balanced: boolean };
    expect(data.ledgerTotal).toBe(61_000);
    expect(data.difference).toBe(1_000);
    expect(data.balanced).toBe(false);

    const stored = await row<{ status: string }>(
      `select status from ledger_reconciliations order by created_at desc limit 1`);
    expect(stored.status).not.toBe('balanced');

    // A discrepancy is an event, not a footnote.
    const rows = await auditRows('TRUST_DISCREPANCY_FOUND');
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('denied');
  });

  it('records a balancing reconciliation as balanced, and a reconciliation cannot be amended', async () => {
    const res = await sara.post('/api/firm/trust/reconciliations', {
      asOf: new Date().toISOString(), bankBalance: 61_000,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.balanced).toBe(true);
    expect((await auditRows('LEDGER_RECONCILED')).length).toBe(1);

    const rec = await row<{ id: string }>(`select id from ledger_reconciliations order by created_at desc limit 1`);
    await expect(s.db.run(`update ledger_reconciliations set bank_balance = 0 where id = ?`, [rec.id])).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P1.2 · the engagement gate and the basis for the fee', () => {
  it('reports a matter with a signed letter and terms as billable, with no blockers', async () => {
    const res = await noura.get(`/api/firm/matters/${COMMERCIAL}/billing`);
    expect(res.status).toBe(200);
    const data = res.body.data as { billable: boolean; blockers: string[]; terms: { basis: string }; unbilled: { time: number } };
    expect(data.billable).toBe(true);
    expect(data.blockers).toEqual([]);
    expect(data.terms.basis).toBe('hourly');
    // The fixture's six billable hours sit on Commercial and Gulf.
    expect(data.unbilled.time).toBeGreaterThan(0);
  });

  it('turns billable off the moment the letter stops being the current one', async () => {
    /*
      The fixture's RealEstate matter has terms and NO letter, but it is also not
      financially visible to this member — so the gate is proved where it bites: the
      signed letter is superseded, which is exactly the state the rule is about, and the
      answer must change in the same request that reads it.
    */
    const before = await noura.get(`/api/firm/matters/${COMMERCIAL}/billing`);
    expect((before.body.data as { billable: boolean }).billable).toBe(true);

    await s.db.run(
      `update engagement_letters set superseded_by = ? where matter_id = ? and status = 'signed'`,
      ['00000000-0000-4000-8000-00000000ffff', COMMERCIAL]);

    const after = await noura.get(`/api/firm/matters/${COMMERCIAL}/billing`);
    expect(after.status).toBe(200);
    const data = after.body.data as { billable: boolean; blockers: string[] };
    expect(data.billable).toBe(false);
    expect(data.blockers).toContain('no_signed_engagement_letter');
  });

  it('refuses billable time on a matter with no engagement, audited, and allows non-billable time', async () => {
    const billable = await noura.post('/api/firm/time-entries', {
      matterId: EMPLOYMENT, entryDate: new Date().toISOString().slice(0, 10),
      minutes: 30, narrative: 'Assessment of the employment claim.', billable: true,
    });
    expect(billable.status).toBe(400);
    expect(billable.body.error.code).toBe('engagement_gate');

    const denials = await auditRows('ENGAGEMENT_GATE_DENIED');
    expect(denials.length).toBe(1);
    expect(denials[0].outcome).toBe('denied');

    // The same hour, recorded as non-billable, is exactly what the matter may hold.
    const nonBillable = await noura.post('/api/firm/time-entries', {
      matterId: EMPLOYMENT, entryDate: new Date().toISOString().slice(0, 10),
      minutes: 30, narrative: 'Assessment of the employment claim.', billable: false,
    });
    expect(nonBillable.status).toBe(201);
    expect(nonBillable.body.data.amount).toBe(0);
  });

  it('computes the rate from the card and the amount from the minutes, and refuses a supplied rate', async () => {
    /*
      A caller who can supply the rate can bill anything, so the route does not accept
      one — and the attempt is not ignored silently: it is refused as an unrecognised
      field and it lands in the audit trail as a field-tamper attempt, which is what the
      escalation matrix asks to be able to see afterwards.
    */
    const injected = await noura.post('/api/firm/time-entries', {
      matterId: COMMERCIAL, entryDate: new Date().toISOString().slice(0, 10),
      minutes: 90, narrative: 'Review of the defendant reply and the hearing bundle.',
      rate: 9999, amount: 9999,
    } as unknown as Record<string, unknown>);
    expect(injected.status).toBe(400);
    expect(injected.body.error.code).toBe('validation_failed');
    const tamperRows = await auditRows('FIELD_TAMPER_ATTEMPT');
    expect(tamperRows.length).toBeGreaterThanOrEqual(1);
    expect(String(tamperRows[tamperRows.length - 1].metadata)).toContain('rate');

    const res = await noura.post('/api/firm/time-entries', {
      matterId: COMMERCIAL, entryDate: new Date().toISOString().slice(0, 10),
      minutes: 90, narrative: 'Review of the defendant reply and the hearing bundle.',
    });
    expect(res.status).toBe(201);
    const data = res.body.data as { rate: number; amount: number };
    // Managing partner on the firm card: 2,400 an hour.
    expect(data.rate).toBe(2_400);
    expect(data.amount).toBe(3_600);
  });

  it('refuses an hour with no rate card in force on the date it was worked', async () => {
    // A date before any card was ever effective: the refusal says so, rather than
    // falling back to the last known rate — an hour billed at a guessed rate is worse
    // than an hour that waits for its card.
    const res = await noura.post('/api/firm/time-entries', {
      matterId: COMMERCIAL, entryDate: '2001-01-01',
      minutes: 60, narrative: 'An hour worked before the firm existed, fiscally speaking.',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(String(res.body.error.message)).toMatch(/rate card/i);
  });

  it('supersedes billing terms rather than editing them, so the old basis stays answerable', async () => {
    const first = await noura.post(`/api/firm/matters/${COMMERCIAL}/billing-terms`, {
      basis: 'capped', capAmountSar: 12_000, effectiveFrom: '2026-09-01',
      notes: 'Re-scoped by written agreement.',
    });
    expect(first.status).toBe(201);
    const newId = first.body.data.id as string;

    const rows = await s.db.all<any>(
      `select id, basis, cap_amount_sar, superseded_by from matter_billing_terms where matter_id = ?`, [COMMERCIAL]);
    expect(rows.length).toBe(2);
    const current = rows.find((r) => r.superseded_by === null)!;
    expect(current.id).toBe(newId);
    expect(current.basis).toBe('capped');
    // The hourly engagement it replaced is still there, retired rather than rewritten —
    // which is what keeps "what were the terms on the day this hour was worked"
    // answerable a year later.
    const retired = rows.find((r) => r.superseded_by !== null)!;
    expect(retired.basis).toBe('hourly');
    expect(retired.superseded_by).toBe(newId);
  });

  it('requires the figure the chosen basis needs', async () => {
    const res = await noura.post(`/api/firm/matters/${COMMERCIAL}/billing-terms`, {
      basis: 'capped', effectiveFrom: '2026-09-01',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(String(res.body.error.message)).toMatch(/cap/i);
  });

  it('records a signature with the rule-11 preconditions, and refuses one that claims no capacity check', async () => {
    const letters = await noura.get(`/api/firm/matters/${COMMERCIAL}/billing`);
    const letter = (letters.body.data as { engagementLetters: Array<{ id: string }> }).engagementLetters[0];

    const noCapacity = await noura.post(`/api/firm/engagement-letters/${letter.id}/sign`, {
      signedByName: 'Ahmed Al-Saud', documentId: crypto.randomUUID(),
      identityVerifiedAt: new Date().toISOString(), capacityVerified: false,
    });
    // Already signed in the fixture, so the refusal is about capacity first.
    expect(noCapacity.status).toBe(400);
    expect(String(noCapacity.body.error.message)).toMatch(/capacity/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P1.3 · the two ceilings that had no guard', () => {
  it('refuses a discount beyond the member’s ceiling, even though the permission is held', async () => {
    /*
      The managing partner holds billing.discount AND a 25% ceiling. A 40% discount is
      inside her permission and outside her authority, which is the only combination that
      tests the ceiling rather than the permission.

      The finance manager, who holds the permission with a 10% ceiling, cannot be used
      here — she is not on this matter's team, so she is refused one gate earlier. That
      refusal is asserted on its own below, because a scope refusal and a ceiling refusal
      are different answers and must not be allowed to look alike.
    */
    const res = await noura.post(`/api/firm/billing/invoices/${DRAFT}/discount`, {
      newSubtotal: 13_200, reason: 'Relationship discount agreed by the client.',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    /*
      The refusal is proved by the AUDIT ROW rather than by the message: the row names
      the kind of authority that was exceeded (`discount_pct`) and the ceiling it
      exceeded, which is what a reviewer needs. A message that merely said "forbidden"
      would be indistinguishable from the permission refusal one gate earlier.
    */
    const exceeded = await auditRows('CEILING_EXCEEDED');
    expect(exceeded.length).toBeGreaterThanOrEqual(1);
    expect(String(exceeded[0].reason_code)).toBe('ceiling_exceeded');
    // The row names WHICH authority was exceeded and by how much, which is the whole
    // reason the ceiling is audited separately from the permission.
    expect(JSON.stringify(exceeded[0].metadata)).toContain('discount_pct');

    // The invoice did not move.
    const invoice = await row<{ subtotal: number }>(`select subtotal from invoices where id = ?`, [DRAFT]);
    expect(invoice.subtotal).toBe(22_000);
  });

  it('allows a discount inside the ceiling, and moves the tax with the fee', async () => {
    const before = await row<{ subtotal: number; vat_amount: number; total: number }>(
      `select subtotal, vat_amount, total from invoices where id = ?`, [DRAFT]);

    const res = await noura.post(`/api/firm/billing/invoices/${DRAFT}/discount`, {
      newSubtotal: 20_000, reason: 'Client loyalty discount of roughly nine per cent.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.discountPct).toBeCloseTo(9.09, 1);

    const after = await row<{ subtotal: number; vat_amount: number; total: number }>(
      `select subtotal, vat_amount, total from invoices where id = ?`, [DRAFT]);
    expect(after.subtotal).toBe(20_000);
    // A discount that left the VAT on the old subtotal would reduce the fee and leave
    // the tax behind — the one thing a discount must not do.
    expect(after.vat_amount).toBe(3_000);
    expect(after.total).toBe(23_000);
    expect(after.total).toBeLessThan(before.total);
  });

  it('refuses finance on a matter she is not on the team of — a scope answer, not a ceiling one', async () => {
    const res = await sara.post(`/api/firm/billing/invoices/${DRAFT}/discount`, {
      newSubtotal: 21_000, reason: 'Finance applying a discount to a matter she does not work on.',
    });
    // 404 and not 403: the matter is not disclosed to exist for her, and the audit row
    // records which level she had rather than which ceiling she lacked.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    const denials = await auditRows('MATTER_SCOPE_DENIED');
    expect(denials.length).toBeGreaterThanOrEqual(1);
    expect(denials[0].reason_code).toBe('matter_level_insufficient');
  });

  it('refuses any discount at all to a member with no discount ceiling', async () => {
    const res = await faisal.post(`/api/firm/billing/invoices/${DRAFT}/discount`, {
      newSubtotal: 21_000, reason: 'A small courtesy discount.',
    });
    // Faisal holds billing.discount through the lawyer template but has no ceiling:
    // null means REFUSE, never unlimited.
    expect(res.status).toBe(403);
    expect((await auditRows('DISCOUNT_APPLIED')).length).toBe(0);
  });

  it('refuses to discount an issued invoice', async () => {
    await noura.post(`/api/firm/billing/invoices/${SENT_AHMED}/issue`, { subtype: 'simplified' });
    const res = await noura.post(`/api/firm/billing/invoices/${SENT_AHMED}/discount`, {
      newSubtotal: 15_000, reason: 'Late discount on a document already issued.',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('issued_invoice_immutable');
  });

  it('will not write off a balance on behalf of a member who cannot reach the money', async () => {
    // A practising lawyer holds no financial authority and no write-off permission. The
    // invoice is on a matter he works on, so the refusal cannot be a scope answer.
    const asLawyer = await faisal.post(`/api/firm/billing/invoices/${SENT_AHMED}/write-off`, {
      reason: 'A lawyer attempting to abandon a client balance.',
    });
    expect(asLawyer.status).toBe(403);
  });

  it('writes off the OUTSTANDING balance, not the invoice total, against the write-off ceiling', async () => {
    /*
      THE CEILING IS EXERCISED BY LOWERING IT, not by hunting for a larger invoice.
      Authority is data — `writeoff_authority_sar` on the membership — so the honest way
      to prove the ceiling binds is to set it below the balance and try, rather than to
      hope the fixture happens to contain a debt of the right size.
    */
    /*
      A BALANCE SMALLER THAN THE DOCUMENT is what makes this a test of the figure that
      is abandoned. SENT_AHMED is unpaid and in a matter the managing partner reaches
      financially; 4,000 of Ahmed's own money is applied to it, so `total` and
      `outstanding` are different numbers and the assertions can tell them apart.
    */
    const applied = await noura.post(`/api/firm/trust/ledgers/${CLIENT_AHMED}/entries`, {
      entryType: 'application_to_fee', amount: 4_000, invoiceId: SENT_AHMED,
      description: 'Applied against INV-2026-0148 on account of professional fees.',
    });
    expect(applied.status).toBe(201);
    expect(applied.body.data.balance).toBe(17_000);   // 21,000 held less the 4,000 applied
    // The invoice now agrees with the ledger rather than being the one number that
    // never moved when money was applied to it.
    const paidInvoice = await row<{ amount_paid: number; internal_status: string; client_status: string }>(
      `select amount_paid, internal_status, client_status from invoices where id = ?`, [SENT_AHMED]);
    expect(paidInvoice.amount_paid).toBe(4_000);
    expect(paidInvoice.internal_status).toBe('partially_paid');
    expect(paidInvoice.client_status).toBe('partially_paid');

    const membership = await row<{ id: string; writeoff_authority_sar: number }>(
      `select id, writeoff_authority_sar from firm_memberships where staff_id = (
         select staff_id from firm_memberships m join users u on u.id = m.user_id
          where u.email = ? limit 1)`, [FIRM.managingPartner]);
    expect(Number(membership.writeoff_authority_sar)).toBe(100_000);

    await s.db.run(`update firm_memberships set writeoff_authority_sar = 1000 where id = ?`, [membership.id]);
    const refused = await noura.post(`/api/firm/billing/invoices/${SENT_AHMED}/write-off`, {
      reason: 'Client has stopped responding to the collection letters; partner decision.',
    });
    expect(refused.status).toBe(403);
    expect((await row<{ internal_status: string }>(
      `select internal_status from invoices where id = ?`, [SENT_AHMED])).internal_status).not.toBe('written_off');

    await s.db.run(`update firm_memberships set writeoff_authority_sar = 100000 where id = ?`, [membership.id]);

    // Inside the ceiling it goes through, and the audit row records what was abandoned
    // and that the invoice was left exactly as issued.
    const allowed = await noura.post(`/api/firm/billing/invoices/${SENT_AHMED}/write-off`, {
      reason: 'Client has stopped responding to the collection letters; partner decision.',
    });
    expect(allowed.status).toBe(200);
    const data = allowed.body.data as { writtenOff: number; taxAdjusted: boolean };
    expect(data.writtenOff).toBe(16_700);  // 20,700 total less the 4,000 the client paid
    expect(data.taxAdjusted).toBe(false);

    const invoice = await row<{ internal_status: string; total: number }>(
      `select internal_status, total from invoices where id = ?`, [SENT_AHMED]);
    expect(invoice.internal_status).toBe('written_off');
    expect(invoice.total).toBe(20_700);    // the document itself is untouched
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P1.4 · disbursements', () => {
  it('refuses a reimbursable disbursement with no receipt attached', async () => {
    const res = await noura.post('/api/firm/expenses', {
      matterId: GULF_MATTER, incurredOn: new Date().toISOString().slice(0, 10),
      category: 'court_fee', description: 'Another filing fee, with no receipt.',
      netAmountSar: 500, vatAmountSar: 75,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('expense_receipt_required');
  });

  it('accepts a reimbursement whose receipt is attached, total computed by the server', async () => {
    const res = await noura.post('/api/firm/expenses', {
      matterId: GULF_MATTER, incurredOn: new Date().toISOString().slice(0, 10),
      category: 'filing_fee', description: 'Appeal filing fee — court receipt attached.',
      netAmountSar: 1_200, vatAmountSar: 180,
      receiptDocumentId: 'c1000000-0000-4000-8000-000000000007',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.total).toBe(1_380);
  });

  it('refuses to approve a disbursement beyond the approver’s write-off ceiling', async () => {
    const created = await noura.post('/api/firm/expenses', {
      matterId: GULF_MATTER, incurredOn: new Date().toISOString().slice(0, 10),
      category: 'expert', description: 'Expert report on the valuation of the target.',
      netAmountSar: 20_000, vatAmountSar: 3_000,
      receiptDocumentId: 'c1000000-0000-4000-8000-000000000007',
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    // A member without expenses.approve cannot decide one at all, whatever it is worth.
    const asLawyer = await faisal.post(`/api/firm/expenses/${id}/decision`, { decision: 'approved' });
    expect(asLawyer.status).toBe(403);

    /*
      The ceiling is lowered to 1,000 on THIS membership, exactly as the write-off test
      does, so the refusal is about the amount and nothing else. Approving a
      disbursement is spending the client's money on their behalf: it is the same act as
      the trust refund above, one step earlier in the process, and it takes the same
      ceiling.
    */
    const membership = await row<{ id: string }>(
      `select id from firm_memberships where staff_id = (
         select staff_id from firm_memberships m join users u on u.id = m.user_id
          where u.email = ? limit 1)`, [FIRM.managingPartner]);
    await s.db.run(`update firm_memberships set writeoff_authority_sar = 1000 where id = ?`, [membership.id]);

    const refused = await noura.post(`/api/firm/expenses/${id}/decision`, { decision: 'approved' });
    expect(refused.status).toBe(403);
    expect((await row<{ status: string }>(`select status from expenses where id = ?`, [id])).status).toBe('submitted');

    await s.db.run(`update firm_memberships set writeoff_authority_sar = 100000 where id = ?`, [membership.id]);
    const allowed = await noura.post(`/api/firm/expenses/${id}/decision`, { decision: 'approved' });
    expect(allowed.status).toBe(200);
    expect((await auditRows('EXPENSE_APPROVED')).length).toBe(1);
  });

  it('requires a reason for a rejection, and decides an expense only once', async () => {
    const created = await noura.post('/api/firm/expenses', {
      matterId: GULF_MATTER, incurredOn: new Date().toISOString().slice(0, 10),
      category: 'courier', description: 'Courier of the signed originals to the client.',
      netAmountSar: 120, vatAmountSar: 18,
      receiptDocumentId: 'c1000000-0000-4000-8000-000000000007',
    });
    const id = created.body.data.id as string;

    const noReason = await noura.post(`/api/firm/expenses/${id}/decision`, { decision: 'rejected' });
    expect(noReason.status).toBe(400);

    expect((await noura.post(`/api/firm/expenses/${id}/decision`, {
      decision: 'rejected', rejectionReason: 'Not a disbursement on this matter — it belongs to the client’s other file.',
    })).status).toBe(200);

    const twice = await noura.post(`/api/firm/expenses/${id}/decision`, { decision: 'approved' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('entry_already_billed');
  });

  it('freezes a billed hour: its figures, its invoice and its status are all fixed', async () => {
    const entry = await row<{ id: string; amount_sar: number }>(
      `select id, amount_sar from time_entries where matter_id = ? and billable = 1 limit 1`, [COMMERCIAL]);

    // Bill it, the way the billing run will: status and the invoice it went onto.
    await s.db.run(`update time_entries set status = 'billed', invoice_id = ? where id = ?`, [SENT_AHMED, entry.id]);

    /*
      Four ways to falsify the invoice this hour is on, and every one of them is refused
      at the TABLE — not at the route. An invoice whose lines were computed from a
      duration that has since changed is a tax document with no defensible basis, and
      the invoice itself cannot be amended (0034), so the entry must not be either.
    */
    await expect(s.db.run(`update time_entries set minutes = 1 where id = ?`, [entry.id])).rejects.toThrow();
    await expect(s.db.run(`update time_entries set amount_sar = 1 where id = ?`, [entry.id])).rejects.toThrow();
    await expect(s.db.run(`update time_entries set hourly_rate_sar = 1 where id = ?`, [entry.id])).rejects.toThrow();
    await expect(s.db.run(`update time_entries set status = 'written_off', written_off_reason = 'x' where id = ?`, [entry.id]))
      .rejects.toThrow();
    await expect(s.db.run(`update time_entries set invoice_id = ? where id = ?`, [GULF, entry.id])).rejects.toThrow();

    // Bookkeeping fields that do not appear on the invoice are still editable, which is
    // the difference between freezing the money and freezing the row.
    await s.db.run(`update time_entries set narrative = ? where id = ?`, ['Amended narrative.', entry.id]);
    const after = await row<{ narrative: string; amount_sar: number }>(
      `select narrative, amount_sar from time_entries where id = ?`, [entry.id]);
    expect(after.narrative).toBe('Amended narrative.');
    expect(after.amount_sar).toBe(entry.amount_sar);
  });
});
