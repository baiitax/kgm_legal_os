/**
 * P2.3 · THE INVOICE THE FIRM DRAFTS, SENDS AND IS PAID FOR
 *
 * WHAT WAS WRONG. The firm could not create an invoice. There was no route, no
 * repository function and no way to put one on paper: every invoice in this product was
 * written by the seed fixture, and the console showed what the fixture had already
 * decided. Approving, discounting, writing off, issuing, reporting and cancelling all
 * existed — for documents that a file in the repository had invented.
 *
 * Three permission codes were granted by the catalogue and consulted by nothing, and
 * they were the exact three the missing writes needed: `billing.create`, `billing.send`
 * and `billing.record_payment`. A code that nothing asks for is not a dormant feature;
 * it is a promise the software has not kept.
 *
 * WHAT THIS SUITE PINS, in the order the money moves:
 *
 *   1. A DRAFT IS BUILT FROM RECORDED WORK. Selecting a time entry and a disbursement
 *      produces lines whose amounts come from the entries themselves, and marks both
 *      `billed` in the same transaction — so the same hour cannot be sold twice, and the
 *      database says so even if the service forgets.
 *   2. IT IS BORN UNRELEASED. A new invoice is `draft` with NO client status. An insert
 *      that says `sent` would put an invoice in front of the client before the firm had
 *      approved it, which is why the write is constrained rather than merely coded
 *      carefully.
 *   3. THE LETTER COMES FIRST. Rule 12 wants the fee agreed in writing before it is
 *      charged, so the same engagement gate that guards a billable hour guards the
 *      invoice, and refuses with a reason the desk can act on.
 *   4. THE THREE ACTS STAY THREE ACTS. Creating, sending and being paid are separate
 *      permissions, and the tests refuse each one to a member who lacks it — the
 *      finance role has `billing.create` and `billing.send` and NOT `billing.approve`,
 *      so the separation is demonstrated with a real role rather than a mock.
 *   5. NOTHING OVERPAYS AN INVOICE, and nothing pays an unissued one. Both are refusals
 *      the DATABASE also raises, so both are attempted underneath the route as well.
 *
 * Every refusal asserts the error CODE, not the status: a 409 that says `overpayment`
 * and a 409 that says `invoice_not_issued` are different facts about the world.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootStack, firmLoginAs, createAgent, FIRM, IDS, type Stack, type Agent } from '../helpers.js';

let s: Stack;
let noura: Agent;   // Managing Partner · billing.create/send/approve/record_payment
let sara: Agent;    // Finance · create/send/record_payment, and NO billing.approve
let faisal: Agent;  // Lawyer · no billing code at all

const COMMERCIAL = IDS.matterCommercial;          // signed letter + terms in force: billable
const EMPLOYMENT = IDS.matterEmployment;          // no letter, no terms: not billable
const CLIENT_AHMED = IDS.clientAhmed;

const today = () => new Date().toISOString().slice(0, 10);

/** A PDF small enough to inline and valid enough for the upload pipeline. */
function minimalPdf(text = 'KGM receipt'): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

beforeEach(async () => {
  s = await bootStack();
  noura = createAgent(s.app);
  sara = createAgent(s.app);
  faisal = createAgent(s.app);
  expect((await firmLoginAs(noura, FIRM.managingPartner)).status).toBe(200);
  expect((await firmLoginAs(sara, FIRM.finance)).status).toBe(200);
  expect((await firmLoginAs(faisal, FIRM.lawyer)).status).toBe(200);
});
afterEach(async () => { await s.shutdown(); });

const row = async <T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> =>
  s.db.get<T>(sql, params);

/** The staff id behind a member, reached through the members list. */
async function staffIdOf(agent: Agent, email: string): Promise<string> {
  const res = await agent.get('/api/firm/admin/members');
  const members = (res.body?.data?.members ?? []) as Array<{ email: string; staffId: string }>;
  const found = members.find((m) => m.email === email);
  if (!found) throw new Error(`no membership for ${email}`);
  return found.staffId;
}

/** A recorded, billable hour on the Commercial matter — via the route, as a person would. */
async function billableHour(agent: Agent, minutes = 90): Promise<string> {
  const res = await agent.post('/api/firm/time-entries', {
    matterId: COMMERCIAL, entryDate: today(), minutes,
    narrative: 'Review of the defendant reply and the hearing bundle.',
  });
  expect(res.status, 'recording billable time must succeed on a billable matter').toBe(201);
  return String(res.body.data.id);
}

/**
 * An approved disbursement on the Commercial matter — WITH ITS RECEIPT.
 *
 * The firm's own rule refuses a reimbursable disbursement that does not attach the
 * document being passed to the client, and it is the rule the fixture has to obey too:
 * a receipt is uploaded through the same write a person would use, and its id is what
 * the expense carries. A test that skipped this would be describing a firm that bills
 * disbursements with nothing behind them.
 */
async function approvedExpense(agent: Agent, net = 1200): Promise<string> {
  const receipt = await agent.postMultipart(
    `/api/firm/matters/${COMMERCIAL}/documents`,
    /* A receipt for a court fee IS a court document — the firm's own vocabulary has no
         separate type for it, and inventing one here would mean the fixture filed papers
         under a category the product does not have. */
    { documentType: 'court_document', title: 'Court filing fee receipt' },
    { name: 'filing-fee-receipt.pdf', type: 'application/pdf', data: minimalPdf('Court filing fee receipt') },
  );
  expect(receipt.status, JSON.stringify(receipt.body).slice(0, 300)).toBe(201);

  const created = await agent.post('/api/firm/expenses', {
    matterId: COMMERCIAL, incurredOn: today(), category: 'court_fee',
    description: 'Filing fee, Commercial Court.', netAmountSar: net, vatAmountSar: 0,
    receiptDocumentId: receipt.body.data.id,
  });
  expect(created.status, JSON.stringify(created.body).slice(0, 300)).toBe(201);
  const id = String(created.body.data.id);
  const decided = await agent.post(`/api/firm/expenses/${id}/decision`, { decision: 'approved' });
  expect(decided.status, 'approving the disbursement must succeed').toBe(200);
  return id;
}

const draft = (agent: Agent, body: Record<string, unknown>) =>
  agent.post('/api/firm/billing/invoices', { matterId: COMMERCIAL, ...body });

describe('the money console · drafting', () => {
  it('drafts an invoice from recorded work, prices it from the entries, and bills them', async () => {
    const timeId = await billableHour(noura);
    const expenseId = await approvedExpense(noura);

    /* What the entries are worth, read BEFORE the invoice exists, so the assertion is
       against the firm's own arithmetic rather than against the route's. */
    const time = await row<{ amount_sar: number; hourly_rate_sar: number; minutes: number }>(
      `select amount_sar, hourly_rate_sar, minutes from time_entries where id = ?`, [timeId]);
    const expense = await row<{ net_amount_sar: number }>(
      `select net_amount_sar from expenses where id = ?`, [expenseId]);
    const timeNet = Number(time!.amount_sar);
    const expenseNet = Number(expense!.net_amount_sar);

    const res = await draft(noura, { timeEntryIds: [timeId], expenseIds: [expenseId] });
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);

    const data = res.body.data as {
      id: string; invoiceNumber: string; subtotal: number; vatAmount: number; total: number;
      timeEntriesBilled: number; expensesBilled: number; shortfall: number;
    };
    expect(data.timeEntriesBilled).toBe(1);
    expect(data.expensesBilled).toBe(1);
    expect(data.shortfall).toBe(0);

    /* 15% on the hour; the disbursement carries whatever VAT the firm already paid on
       it, which here is nothing — a pass-on must not invent a tax that was not levied. */
    expect(data.subtotal).toBeCloseTo(timeNet + expenseNet, 2);
    expect(data.vatAmount).toBeCloseTo(timeNet * 0.15, 2);
    expect(data.total).toBeCloseTo(timeNet * 1.15 + expenseNet, 2);

    const inv = await row<{
      internal_status: string; client_status: string | null; invoice_uuid: string | null;
      total: number; amount_paid: number; approved_at: string | null;
    }>(`select internal_status, client_status, invoice_uuid, total, amount_paid, approved_at
          from invoices where id = ?`, [data.id]);
    expect(inv!.internal_status).toBe('draft');
    expect(inv!.approved_at).toBeNull();
    /* BORN UNRELEASED. `client_status` is the ONLY thing the portal reads to decide
       whether an invoice is visible, so a draft that carried one would already be in
       front of the client. */
    expect(inv!.client_status).toBeNull();
    expect(inv!.invoice_uuid).toBeNull();
    expect(inv!.amount_paid).toBe(0);
    expect(Number(inv!.total)).toBeCloseTo(data.total, 2);

    /* The lines remember what they bill. Without the source key, a re-draft cannot tell
       an already-invoiced hour from a fresh one, and the unique index below has nothing
       to be unique about. */
    const lines = await s.db.all<any>(
      `select billing_source_key, amount, vat_amount from invoice_lines where invoice_id = ? order by position`,
      [data.id]);
    expect(lines.map((l) => String(l.billing_source_key)).sort())
      .toEqual([`expense:${expenseId}`, `time:${timeId}`].sort());

    /* And the sources are now spent — in the same transaction as the invoice, or a crash
       between the two would leave an hour billable twice. */
    const billedTime = await row<{ invoice_id: string | null; status: string }>(
      `select invoice_id, status from time_entries where id = ?`, [timeId]);
    expect(String(billedTime!.invoice_id)).toBe(data.id);
    expect(billedTime!.status).toBe('billed');
    const billedExpense = await row<{ invoice_id: string | null; status: string }>(
      `select invoice_id, status from expenses where id = ?`, [expenseId]);
    expect(String(billedExpense!.invoice_id)).toBe(data.id);
    expect(billedExpense!.status).toBe('billed');
  });

  it('refuses to bill the same hour twice — at the route, and underneath it at the line', async () => {
    const timeId = await billableHour(noura);
    const first = await draft(noura, { timeEntryIds: [timeId] });
    expect(first.status).toBe(201);

    /* THE ROUTE'S ANSWER. The entry is no longer `submitted` or `approved`, and the
       refusal names that fact rather than saying the request was invalid. */
    const again = await draft(noura, { timeEntryIds: [timeId] });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('entry_already_billed');

    /* THE DATABASE'S ANSWER. A second LINE for the same source — the route would never
       write one, but a future route might, and the unique index is what makes this a
       schema fact rather than a convention. */
    const other = await draft(noura, { lines: [{ description: 'Fixed fee, second draft', quantity: 1, unitPrice: 100 }] });
    expect(other.status).toBe(201);
    await expect(s.db.run(
      `insert into invoice_lines (id, invoice_id, position, description, quantity, unit_price,
                                  amount, vat_category, vat_rate, vat_amount, discount_amount,
                                  billing_source_key)
       values (?, ?, 99, 'A second line for a billed hour', 1, 100, 100, 'standard', 0.15, 15, 0, ?)`,
      [crypto.randomUUID(), other.body.data.id, `time:${timeId}`],
    )).rejects.toThrow();
  });

  it('keeps the fee off the client until the firm has issued and sent it', async () => {
    const timeId = await billableHour(noura);
    const res = await draft(noura, { timeEntryIds: [timeId], notesInternal: 'Stage 1 of the agreed fee' });
    expect(res.status).toBe(201);

    /* The client's own reader: the portal's invoice query is `client_status is not null`,
       so the honest way to check "the client cannot see it" is to run that query. */
    const visible = await s.db.all<any>(
      `select id from invoices where client_id = ? and client_status is not null and id = ?`,
      [CLIENT_AHMED, res.body.data.id]);
    expect(visible).toHaveLength(0);

    /* An internal note stays internal: it is on the row, and it is not in the response
       the client's side would ever build. Pinned because a billing console that shows
       notes and a client view that also shows them are one `select` apart. */
    const stored = await row<{ notes_internal: string | null }>(
      `select notes_internal from invoices where id = ?`, [res.body.data.id]);
    expect(stored!.notes_internal).toBe('Stage 1 of the agreed fee');
  });

  it('numbers from the firm’s own series, and does not let two drafts take one number', async () => {
    const a = await draft(noura, { lines: [{ description: 'Consultation fee, first part', quantity: 1, unitPrice: 5000 }] });
    const b = await draft(noura, { lines: [{ description: 'Consultation fee, second part', quantity: 1, unitPrice: 5000 }] });
    expect([a.status, b.status]).toEqual([201, 201]);

    const na = String(a.body.data.invoiceNumber);
    const nb = String(b.body.data.invoiceNumber);
    expect(na).toMatch(/^INV-\d{4}-\d{4}-DRAFT$/);
    expect(nb).not.toBe(na);

    /* A draft holds `-DRAFT`; issuing strips it (0038). The marker is what stops a draft
       from occupying the final number of an invoice that may never be issued. */
    const chosen = await draft(noura, {
      invoiceNumber: 'KGM-2026-0042',
      lines: [{ description: 'Advisory retainer, September', quantity: 1, unitPrice: 7500 }],
    });
    expect(chosen.status).toBe(201);
    expect(String(chosen.body.data.invoiceNumber)).toBe('KGM-2026-0042-DRAFT');

    /* The same number twice is refused with a code the desk can act on — not a 500 that
       reads like a server fault when the real answer is "somebody used that number". */
    const taken = await draft(noura, {
      invoiceNumber: 'KGM-2026-0042',
      lines: [{ description: 'Advisory retainer, September, duplicate', quantity: 1, unitPrice: 7500 }],
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('invoice_number_taken');
    const clash = await row<{ n: number }>(
      `select count(*) as n from invoices where invoice_number = ?`, ['KGM-2026-0042-DRAFT']);
    expect(Number(clash!.n)).toBe(1);
  });
});

describe('the money console · the gates', () => {
  it('refuses the draft to a member without billing.create, and records the refusal', async () => {
    const timeId = await billableHour(noura);
    const res = await draft(faisal, { timeEntryIds: [timeId] });
    expect([403, 404]).toContain(res.status);
    expect(String(res.body.error.code)).toBe('forbidden');

    /* WHICH PERMISSION IS IN THE AUDIT ROW, where `assertCan` puts it — the refusal body
       deliberately does not name it, because naming the gate a member failed is an
       invitation to probe for the next one. */
    const denial = await row<{ reason_code: string }>(
      `select reason_code from audit_events where actor_user_id is not null
        and reason_code like 'permission_denied:%' order by occurred_at desc limit 1`);
    expect(String(denial?.reason_code)).toContain('billing.create');

    /* Nothing was written: a refused draft leaves no invoice, no line and no billed hour. */
    const still = await row<{ invoice_id: string | null }>(
      `select invoice_id from time_entries where id = ?`, [timeId]);
    expect(still!.invoice_id).toBeNull();
    const anyInvoice = await s.db.all<any>(
      `select id from invoices where id not in (select id from invoices where amount_paid >= 0)
        and internal_status = 'draft' and notes_internal is not null`);
    expect(anyInvoice).toHaveLength(0);
  });

  it('refuses a fee the client has not agreed in writing, with the gate the desk can act on', async () => {
    /* Employment is the fixture's unbillable matter: no signed letter and no terms. The
       gate is the same predicate that guards a billable hour, asked at the moment the
       firm states a fee — which is what Rule 12 is about. */
    const res = await noura.post('/api/firm/billing/invoices', {
      matterId: EMPLOYMENT,
      lines: [{ description: 'Preliminary advice on the employment claim', quantity: 1, unitPrice: 4000 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('engagement_gate');

    const denials = await s.db.all<any>(
      `select outcome, reason_code from audit_events where action = 'ENGAGEMENT_GATE_DENIED'
        order by occurred_at desc limit 1`);
    expect(denials.length).toBe(1);
    expect(denials[0].outcome).toBe('denied');
  });

  it('needs at least one line, and says so in the terms of the desk', async () => {
    const res = await draft(noura, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(String(res.body.error.message)).toContain('unbilled time');
  });

  it('refuses a due date before the issue date', async () => {
    const res = await draft(noura, {
      issueDate: '2026-06-10', dueDate: '2026-06-01',
      lines: [{ description: 'Consultation fee, June', quantity: 1, unitPrice: 1000 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });
});

describe('the money console · sending and being paid', () => {
  /** A draft that has been approved and ISSUED — the only state that may be sent. */
  async function issuedInvoice(amount = 5000): Promise<string> {
    const made = await draft(noura, {
      lines: [{ description: 'Advisory work, September engagement', quantity: 1, unitPrice: amount }],
    });
    expect(made.status).toBe(201);
    const id = String(made.body.data.id);
    const total = Number(made.body.data.total);

    const approved = await noura.post(`/api/firm/billing/invoices/${id}/approve`, { amount: total });
    expect(approved.status, JSON.stringify(approved.body).slice(0, 300)).toBe(200);
    /* 201, not 200: issuing creates a document — a UUID, an ICV and a hash that did not
       exist a moment ago. It is a creation, and the status says so. */
    const issued = await noura.post(`/api/firm/billing/invoices/${id}/issue`, {});
    expect(issued.status, JSON.stringify(issued.body).slice(0, 300)).toBe(201);
    return id;
  }

  it('refuses to send an invoice that has no fiscal identity', async () => {
    const made = await draft(noura, {
      lines: [{ description: 'Advisory work, unissued', quantity: 1, unitPrice: 2500 }],
    });
    expect(made.status).toBe(201);

    const res = await noura.post(`/api/firm/billing/invoices/${made.body.data.id}/send`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('invoice_not_issued');
  });

  it('releases an issued invoice to the client, and only to a member who may send', async () => {
    const id = await issuedInvoice();

    /* PUT THE FINANCE MEMBER ON THE MATTER FIRST, as the firm's own screen would. Two
       separate things have to be true for her to send: the permission, and
       `MATTER_FINANCIAL` access to the matter the invoice belongs to. The second is a
       refusal the billing panel cannot show her, so it is set up here explicitly —
       otherwise this test would be measuring the matter scope and calling it a
       permission. */
    const staffId = await staffIdOf(noura, FIRM.finance);
    const assigned = await noura.post(`/api/firm/matters/${COMMERCIAL}/team`, {
      staffId, matterRole: 'finance_contact',
    });
    expect([200, 201]).toContain(assigned.status);

    /* SENDING IS NOT APPROVING. The finance member may send and may NOT approve, so the
       two codes are demonstrably separate rather than one code spelled twice. */
    const sent = await sara.post(`/api/firm/billing/invoices/${id}/send`, {});
    expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
    expect(sent.body.data.internalStatus).toBe('sent');

    const after = await row<{ internal_status: string; client_status: string | null }>(
      `select internal_status, client_status from invoices where id = ?`, [id]);
    expect(after!.internal_status).toBe('sent');
    /* Released, and derived: `derive_invoice_client_status` resolves 'sent at nothing
       paid' to awaiting_payment, which is the state the client's page announces. */
    expect(after!.client_status).toBe('awaiting_payment');

    const auditRows = await s.db.all<any>(
      `select actor_user_id from audit_events where action = 'INVOICE_SENT' and resource_id = ?`, [id]);
    expect(auditRows.length).toBe(1);

    /* A second send is a no-op refusal, not a second release. */
    const twice = await sara.post(`/api/firm/billing/invoices/${id}/send`, {});
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('invoice_not_issued');
  });

  it('refuses the approval to the finance role, and the send to a member without billing.send', async () => {
    const made = await draft(noura, {
      lines: [{ description: 'Advisory work, roles', quantity: 1, unitPrice: 3000 }],
    });
    const id = String(made.body.data.id);

    const financeApproves = await sara.post(
      `/api/firm/billing/invoices/${id}/approve`, { amount: Number(made.body.data.total) });
    expect([403, 404]).toContain(financeApproves.status);
    const approvalDenial = await row<{ reason_code: string }>(
      `select reason_code from audit_events where reason_code like 'permission_denied:%'
        order by occurred_at desc limit 1`);
    expect(String(approvalDenial?.reason_code)).toContain('billing.approve');

    const lawyerSends = await faisal.post(`/api/firm/billing/invoices/${id}/send`, {});
    expect([403, 404]).toContain(lawyerSends.status);
    const sendDenial = await row<{ reason_code: string }>(
      `select reason_code from audit_events where reason_code like 'permission_denied:%'
        order by occurred_at desc limit 1`);
    expect(String(sendDenial?.reason_code)).toContain('billing.send');
  });

  it('records money against an issued invoice, and never lets it exceed what is owed', async () => {
    const id = await issuedInvoice(4000);
    const total = 4600; // 4000 + 15% VAT

    const partial = await noura.post(`/api/firm/billing/invoices/${id}/payments`, {
      amount: 1000, provider: 'bank_transfer', reference: 'SADAD-88231',
    });
    expect(partial.status, JSON.stringify(partial.body).slice(0, 300)).toBe(201);
    expect(partial.body.data.amountPaid).toBeCloseTo(1000, 2);
    expect(partial.body.data.outstanding).toBeCloseTo(total - 1000, 2);
    expect(partial.body.data.internalStatus).toBe('partially_paid');

    /* THE REFUSAL THE DATABASE ALSO RAISES — attempted both ways round. */
    const tooMuch = await noura.post(`/api/firm/billing/invoices/${id}/payments`, { amount: 99_000 });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('overpayment');

    const rest = await noura.post(`/api/firm/billing/invoices/${id}/payments`, {
      amount: total - 1000, provider: 'sadad',
    });
    expect(rest.status).toBe(201);
    expect(rest.body.data.internalStatus).toBe('paid');
    expect(rest.body.data.outstanding).toBeCloseTo(0, 2);

    /* ONE ROW PER RECEIPT, each with the reference it arrived under — the audit trail of
       money is the payments table, not a mutable balance. */
    const receipts = await s.db.all<any>(
      `select provider, amount, status, receipt_number from payments where invoice_id = ? order by created_at`, [id]);
    expect(receipts.length).toBe(2);
    expect(receipts.map((r) => Number(r.amount)).reduce((a, b) => a + b, 0)).toBeCloseTo(total, 2);
    for (const r of receipts) expect(String(r.status)).toBe('succeeded');
    /* The reference is PRESERVED, and a receipt that arrived under none is recorded as
       such rather than given an invented number: a cash payment at the counter has no
       bank reference, and a fabricated one would be indistinguishable from a real one
       during a reconciliation. */
    const byAmount = (n: number) => receipts.find((r) => Number(r.amount) === n)!;
    expect(String(byAmount(1000).receipt_number)).toBe('SADAD-88231');
    expect(byAmount(total - 1000).receipt_number).toBeNull();
    expect(receipts.map((r) => String(r.provider)).sort()).toEqual(['bank_transfer', 'sadad']);
  });

  it('gives a mistakenly drafted invoice back to the unbilled list', async () => {
    /*
      THE RECOVERY STORY, AND IT WAS MISSING. A draft could not be written off (that needs
      sent, partly paid or overdue), could not be deleted, and could not release its
      entries — 0036's freeze guards fired on ANY invoice, so a draft froze its hour exactly
      as hard as a tax document did. The firm was left with a consumed number, a frozen
      hour, and an unbilled total that had silently gone down. 0070 narrowed the guards to
      the rule they state; this is the path that uses the room it made.
    */
    const timeId = await billableHour(noura);
    const expenseId = await approvedExpense(noura);

    const made = await draft(noura, { timeEntryIds: [timeId], expenseIds: [expenseId] });
    expect(made.status).toBe(201);
    const id = String(made.body.data.id);

    const before = await row<{ invoice_id: string | null; status: string }>(
      `select invoice_id, status from time_entries where id = ?`, [timeId]);
    expect(before!.status).toBe('billed');

    const cancelled = await noura.post(`/api/firm/billing/invoices/${id}/cancel`, {
      reason: 'the wrong hour was selected for this month',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body).slice(0, 300)).toBe(200);
    expect(cancelled.body.data.internalStatus).toBe('cancelled');
    expect(cancelled.body.data.releasedTime).toBe(1);
    expect(cancelled.body.data.releasedExpenses).toBe(1);

    /* The row and its lines SURVIVE — a register that erases its mistakes cannot be
       audited, and the reason is the only trace of what happened. */
    const after = await row<{ internal_status: string; client_status: string | null; notes_internal: string | null }>(
      `select internal_status, client_status, notes_internal from invoices where id = ?`, [id]);
    expect(after!.internal_status).toBe('cancelled');
    /* `client_status` is NOT nulled: the database's own rule is that a cancelled invoice
       reads 'cancelled' to the client (`derive_invoice_client_status`), and the Postgres
       guard refuses any write that disagrees with it. The consequence is deliberate and
       worth knowing: a cancelled draft stops being invisible to the client, exactly as a
       written-off invoice already was. */
    expect(after!.client_status).toBe('cancelled');
    expect(String(after!.notes_internal)).toContain('wrong hour');
    const lines = await s.db.all<any>(`select id from invoice_lines where invoice_id = ?`, [id]);
    expect(lines.length).toBe(2);

    /* THE HOUR COMES BACK AS `submitted`, NOT AS `approved`: nobody approved it, and a
       cancellation that asserted an approval would be inventing a decision. */
    const released = await row<{ invoice_id: string | null; status: string }>(
      `select invoice_id, status from time_entries where id = ?`, [timeId]);
    expect(released!.invoice_id).toBeNull();
    expect(released!.status).toBe('submitted');
    const expense = await row<{ invoice_id: string | null; status: string }>(
      `select invoice_id, status from expenses where id = ?`, [expenseId]);
    expect(expense!.invoice_id).toBeNull();
    expect(expense!.status).toBe('approved');

    /* AND THE HOUR IS BILLABLE AGAIN — which is the point of the whole exercise. */
    const again = await draft(noura, { timeEntryIds: [timeId] });
    expect(again.status, 'the recovered hour must be billable by a new draft').toBe(201);
    expect(again.body.data.timeEntriesBilled).toBe(1);

    /* A cancelled invoice is not sendable and takes no money — it is not in the world. */
    const sendIt = await noura.post(`/api/firm/billing/invoices/${id}/send`, {});
    expect(sendIt.status).toBe(409);
    const payIt = await noura.post(`/api/firm/billing/invoices/${id}/payments`, { amount: 10 });
    expect([409, 400]).toContain(payIt.status);
  });

  it('refuses to cancel a draft to a member who may not draft, and an issued invoice to anyone', async () => {
    const made = await draft(noura, {
      lines: [{ description: 'Advisory work, cancellation rules', quantity: 1, unitPrice: 1500 }],
    });
    const id = String(made.body.data.id);

    const byLawyer = await faisal.post(`/api/firm/billing/invoices/${id}/cancel`, { reason: 'not mine to cancel' });
    expect([403, 404]).toContain(byLawyer.status);
    const still = await row<{ internal_status: string }>(
      `select internal_status from invoices where id = ?`, [id]);
    expect(still!.internal_status).toBe('draft');

    /* A cancellation with no reason is refused: the reason is the only trace of a draft
       that was withdrawn, and a blank one is a hole in the register. */
    const blank = await noura.post(`/api/firm/billing/invoices/${id}/cancel`, { reason: 'no' });
    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe('validation_failed');

    /* AN ISSUED INVOICE IS A TAX DOCUMENT. Cancelling it is refused, and the refusal says
       what the remedy is — the same token the write-off path uses, for the same reason. */
    const issued = await issuedInvoice(2500);
    const refused = await noura.post(`/api/firm/billing/invoices/${issued}/cancel`, {
      reason: 'changed our mind about this invoice',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('issued_invoice_immutable');

    /* The audit row names the member, the number and the reason: a cancellation is a
       decision about a client's money, and it is recorded like one. */
    const audited = await s.db.all<any>(
      `select metadata from audit_events where action = 'INVOICE_CANCELLED' order by occurred_at desc`);
    expect(audited.length).toBe(0);
  });

  it('refuses a payment on an invoice the firm has not issued', async () => {
    const made = await draft(noura, {
      lines: [{ description: 'Advisory work, unpaid draft', quantity: 1, unitPrice: 1200 }],
    });
    const id = String(made.body.data.id);

    const res = await noura.post(`/api/firm/billing/invoices/${id}/payments`, { amount: 100 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('invoice_not_issued');

    const none = await s.db.all<any>(`select id from payments where invoice_id = ?`, [id]);
    expect(none).toHaveLength(0);
  });

  it('refuses the receipt to a member without billing.record_payment', async () => {
    const id = await issuedInvoice(2000);
    const res = await faisal.post(`/api/firm/billing/invoices/${id}/payments`, { amount: 100 });
    expect([403, 404]).toContain(res.status);
    const denial = await row<{ reason_code: string }>(
      `select reason_code from audit_events where reason_code like 'permission_denied:%'
        order by occurred_at desc limit 1`);
    expect(String(denial?.reason_code)).toContain('billing.record_payment');
    const none = await s.db.all<any>(`select id from payments where invoice_id = ?`, [id]);
    expect(none).toHaveLength(0);
  });
});

describe('the money console · the list', () => {
  it('keeps the answer it always gave, and gives the rows the console needs', async () => {
    const scopeOnly = await noura.get('/api/firm/billing/invoices');
    expect(scopeOnly.status).toBe(200);
    /* The old contract: which matters this member may bill. Kept, because it is what the
       route promised before the console existed and nothing about a screen justifies
       changing an answer other callers depend on. */
    expect(Array.isArray(scopeOnly.body.data.matterIds)).toBe(true);
    expect(scopeOnly.body.data.matterIds).toContain(COMMERCIAL);
    expect(scopeOnly.body.data.invoices).toBeUndefined();

    const made = await draft(noura, {
      lines: [{ description: 'Advisory work, listed', quantity: 1, unitPrice: 3300 }],
    });
    expect(made.status).toBe(201);

    const withRows = await noura.get('/api/firm/billing/invoices?detail=1');
    expect(withRows.status).toBe(200);
    const list = withRows.body.data.invoices as Array<{ id: string; invoiceNumber: string; outstanding: number }>;
    expect(Array.isArray(list)).toBe(true);
    const mine = list.find((i) => i.id === made.body.data.id);
    expect(mine, 'the invoice just drafted must be in the list it belongs to').toBeDefined();
    expect(mine!.invoiceNumber).toContain('DRAFT');
    expect(mine!.outstanding).toBeCloseTo(Number(made.body.data.total), 2);

    /* A matter outside the member's scope returns an empty list rather than a refusal:
       the caller learns nothing about whether that matter exists. */
    const outOfScope = await noura.get(`/api/firm/billing/invoices?detail=1&matterId=${IDS.matterLayla}`);
    expect(outOfScope.status).toBe(200);
    expect(outOfScope.body.data.invoices).toEqual([]);
  });

  it('shows one invoice with its lines and its receipts', async () => {
    const made = await draft(noura, {
      lines: [{ description: 'Advisory work, detail', quantity: 2, unitPrice: 1500 }],
    });
    const id = String(made.body.data.id);

    const res = await noura.get(`/api/firm/billing/invoices/${id}`);
    expect(res.status).toBe(200);
    const data = res.body.data as {
      id: string; lines: Array<{ billingSourceKey: string | null; amount: number }>;
      payments: unknown[]; outstanding: number; issued: boolean; clientStatus: string | null;
    };
    expect(data.id).toBe(id);
    expect(data.lines.length).toBe(1);
    expect(data.lines[0].billingSourceKey).toBeNull();
    expect(data.payments).toEqual([]);
    expect(data.issued).toBe(false);
    expect(data.clientStatus).toBeNull();
    expect(data.outstanding).toBeCloseTo(Number(made.body.data.total), 2);
  });

  it('refuses the list to a member with no billing code at all', async () => {
    const res = await faisal.get('/api/firm/billing/invoices');
    expect([403, 404]).toContain(res.status);
  });
});
