/**
 * §20 INVOICES · §21 PAYMENTS · §35 R6/R7 FINANCIAL INTEGRITY
 *
 * The invariant under test: the browser can EXPRESS AN INTENT to pay and can
 * READ what the firm has chosen to show. It can never decide an amount, never
 * mark anything paid, and never see an invoice the firm has not released.
 * Only a signature-verified provider webhook moves money state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { bootStack, loginAs, createAgent, type Stack } from '../helpers.js';
import { config } from '../../server/src/config.js';

let s: Stack;
beforeEach(async () => { s = await bootStack(); });
afterEach(async () => { await s.shutdown(); });

const AHMED = 'ahmed.alsaud@example.test';
const GULF = 'finance@gulfhorizon.example.test';

const INV_SENT = 'd1000000-0000-4000-8000-000000000001';       // Ahmed · 18000 + VAT · unpaid
const INV_PARTIAL = 'd1000000-0000-4000-8000-000000000002';    // Ahmed · 9500 + VAT · 4000 paid
const INV_PAID = 'd1000000-0000-4000-8000-000000000003';       // Ahmed · settled
const INV_INTERNAL = 'd1000000-0000-4000-8000-000000000004';   // Ahmed · pending internal approval
const INV_GULF = 'd1000000-0000-4000-8000-000000000005';       // another client

const money = (n: number) => n.toFixed(2);

/** Signs a webhook body exactly the way the mock provider adapter verifies it. */
function sign(body: string, secret = config.payments.webhookSecret): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** Direct fetch so the signature header can be controlled precisely. */
async function postWebhook(payload: Record<string, unknown>, signature: string | null, provider: string = config.payments.provider) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-signature'] = signature;
  const res = await fetch(`http://127.0.0.1:${s.port}/api/webhooks/payments/${provider}`, {
    method: 'POST', headers, body: raw,
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text };
}

async function invoiceRow(id: string) {
  return s.db.get<any>(
    `select id, total, amount_paid, internal_status, client_status, currency from invoices where id = ?`, [id]);
}

async function startPayment(invoiceId: string, extra: Record<string, unknown> = {}) {
  const res = await s.agent.post(`/api/client/invoices/${invoiceId}/payment`, { provider: 'mada', ...extra });
  expect(res.status).toBe(200);
  return res.body.data as { paymentId: string; amount: string; invoiceId: string; webhookUrl: string };
}

describe('§20 · the invoice list is a projection, not the ledger', () => {
  it('shows Ahmed his released invoices and nothing else', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get('/api/client/invoices');
    expect(res.status).toBe(200);
    const ids = res.body.data.invoices.map((i: any) => i.id);

    expect(ids.sort()).toEqual([INV_SENT, INV_PARTIAL, INV_PAID].sort());
    expect(ids).not.toContain(INV_INTERNAL); // still in internal approval
    expect(ids).not.toContain(INV_GULF);     // another client
    expect(res.text).not.toContain('INV-2026-0149-DRAFT');
    expect(res.text).not.toContain('INV-2026-0170');
  });

  it('exposes a derived client status, never the internal one', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get('/api/client/invoices');
    const byId = Object.fromEntries(res.body.data.invoices.map((i: any) => [i.id, i]));

    expect(byId[INV_SENT].status).toBe('awaiting_payment');
    expect(byId[INV_PARTIAL].status).toBe('partially_paid');
    expect(byId[INV_PAID].status).toBe('paid');

    for (const banned of ['internal_status', 'pending_internal_approval', 'written_off', 'draft', 'failure_reason', 'dunning', 'collection']) {
      expect(res.text, `leaked ${banned}`).not.toContain(banned);
    }
  });

  it('computes VAT and balances server-side in SAR', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get('/api/client/invoices');
    const inv = res.body.data.invoices.find((i: any) => i.id === INV_SENT);

    expect(inv.currency).toBe('SAR');
    expect(inv.vatRate).toBe(0.15);
    expect(inv.subtotal).toBe(money(18000));
    expect(inv.vatAmount).toBe(money(2700));
    expect(inv.total).toBe(money(20700));
    expect(inv.amountPaid).toBe(money(0));
    expect(inv.balanceDue).toBe(money(20700));
  });

  it('reports the outstanding balance the dashboard shows', async () => {
    await loginAs(s.agent, AHMED);
    const dash = await s.agent.get('/api/client/dashboard');
    expect(dash.status).toBe(200);
    // 20700 outstanding + 6925 remaining on the part-paid invoice. The draft
    // invoice in internal approval contributes nothing, and neither does the
    // settled one.
    expect(dash.body.data.outstandingBalance.amount).toBe(money(27625));
    expect(dash.body.data.outstandingBalance.currency).toBe('SAR');
    expect(dash.body.data.counts.unpaidInvoices).toBe(2);
    // The dashboard must not summarize money the firm has not released.
    expect(Number(dash.body.data.outstandingBalance.amount)).toBeLessThan(27625 + 25300);
  });

  it('denies invoice detail across client and internal-approval boundaries', async () => {
    await loginAs(s.agent, AHMED);
    for (const id of [INV_GULF, INV_INTERNAL]) {
      const res = await s.agent.get(`/api/client/invoices/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
    // A Gulf session cannot reach Ahmed's invoices either.
    const gulf = createAgent(s.app);
    await loginAs(gulf, GULF);
    expect((await gulf.get(`/api/client/invoices/${INV_SENT}`)).status).toBe(404);
  });

  it('shows line items on a released invoice only', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get(`/api/client/invoices/${INV_SENT}`);
    expect(res.status).toBe(200);
    expect(res.body.data.lines.length).toBe(2);
    expect(res.body.data.lines[0].descriptionAr).toBeTruthy();
    expect(res.text).not.toContain('Draft line');
  });
});

describe('§20/§35 R6 · invoices are read-only from the portal', () => {
  it('exposes no mutation route for an invoice', async () => {
    await loginAs(s.agent, AHMED);
    const attempts: Array<[string, (u: string, b?: unknown) => Promise<{ status: number }>]> = [
      ['PATCH', (u, b) => s.agent.patch(u, b)],
      ['DELETE', (u) => s.agent.del(u)],
    ];
    for (const [, call] of attempts) {
      expect((await call(`/api/client/invoices/${INV_SENT}`, { total: '0.01' })).status).toBe(404);
      expect((await call(`/api/client/invoices/${INV_SENT}/status`, { status: 'paid' })).status).toBe(404);
      expect((await call(`/api/client/invoices/${INV_SENT}/amount-paid`, { amount: 0 })).status).toBe(404);
    }
    expect((await s.agent.post(`/api/client/invoices/${INV_SENT}/mark-paid`, {})).status).toBe(404);
    expect((await s.agent.post(`/api/client/invoices/${INV_SENT}/void`, {})).status).toBe(404);
    expect((await s.agent.post('/api/client/invoices', {})).status).toBe(404);
  });

  it('cannot change financial state by patching a mutable sibling resource', async () => {
    await loginAs(s.agent, AHMED);
    // Deadlines and preferences are writable; none of them may carry money.
    for (const [url, body] of [
      ['/api/client/profile', { balanceDue: '0.00', totalOutstanding: 0 }],
      ['/api/client/preferences', { unpaidCount: 0 }],
    ] as Array<[string, Record<string, unknown>]>) {
      const res = await s.agent.patch(url, body);
      // Any of these is a correct refusal: the field is unknown (400), the
      // resource is not writable by a client (403), or it is accepted and the
      // money field simply ignored (200). What must never happen is below.
      expect([200, 400, 403]).toContain(res.status);
    }
    const row = await invoiceRow(INV_SENT);
    expect(Number(row.amount_paid)).toBe(0);
    expect(row.client_status).toBe('awaiting_payment');
  });

  it('the database itself refuses a client-driven financial update', async () => {
    // Defence in depth: even a SQL injection or a mis-scoped query cannot set an
    // arbitrary client_status, and only the payments role may touch totals.
    await expect(s.db.run(
      `update invoices set client_status = 'paid' where id = ?`, [INV_SENT],
    )).rejects.toThrow();
  });
});

describe('§21 · the browser may create an intent but never decide the amount', () => {
  it('returns the server-computed balance for an unpaid invoice', async () => {
    await loginAs(s.agent, AHMED);
    const intent = await startPayment(INV_SENT);
    expect(intent.amount).toBe(money(20700));
    expect(intent.invoiceId).toBe(INV_SENT);
    expect(intent.webhookUrl).toBe(`/api/webhooks/payments/${config.payments.provider}`);
  });

  it('refuses protected financial fields outright (§46)', async () => {
    await loginAs(s.agent, AHMED);
    // `total`, `subtotal`, `vat_amount` and `amount_paid` are on the tamper
    // denylist, so the request never reaches the payment logic at all.
    for (const field of ['total', 'subtotal', 'vat_amount', 'amount_paid', 'paid_at']) {
      const res = await s.agent.post(
        `/api/client/invoices/${INV_SENT}/payment`,
        { provider: 'mada', [field]: 0 },
      );
      expect(res.status, field).toBe(403);
      expect(res.body.error.code, field).toBe('field_not_writable');
    }
    const n = await s.db.get<any>(`select count(*) as n from payments`);
    expect(Number(n.n)).toBe(1); // only the seeded payment
  });

  it('ignores financial-looking fields that are not on the denylist', async () => {
    await loginAs(s.agent, AHMED);
    // These are not protected names, so they pass the guard — and must then be
    // ignored by the schema. The amount is recomputed from the ledger either way.
    const intent = await startPayment(INV_SENT, {
      amount: '0.01', discount: 20699.99, currency: 'USD', vat: 0,
      balanceDue: '0.00', clientNote: 'please waive',
    });
    expect(intent.amount).toBe(money(20700));

    const row = await s.db.get<any>(`select amount, currency from payments where id = ?`, [intent.paymentId]);
    expect(Number(row.amount)).toBe(20700);
    expect(row.currency).toBe('SAR');
  });

  it('returns the REMAINING balance for a part-paid invoice', async () => {
    await loginAs(s.agent, AHMED);
    const intent = await startPayment(INV_PARTIAL);
    // 9500 + 1425 VAT = 10925, less the 4000 already paid.
    expect(intent.amount).toBe(money(6925));
  });

  it('refuses to start a payment on a settled invoice', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.post(`/api/client/invoices/${INV_PAID}/payment`, { provider: 'mada' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('mutation_denied');
  });

  it('refuses to start a payment on another client\'s or unreleased invoice', async () => {
    await loginAs(s.agent, AHMED);
    expect((await s.agent.post(`/api/client/invoices/${INV_GULF}/payment`, { provider: 'mada' })).status).toBe(404);
    expect((await s.agent.post(`/api/client/invoices/${INV_INTERNAL}/payment`, { provider: 'mada' })).status).toBe(404);
  });

  it('refuses an unsupported payment method', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.post(`/api/client/invoices/${INV_SENT}/payment`, { provider: 'free_money' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('refuses an intent without CSRF', async () => {
    await loginAs(s.agent, AHMED);
    const count = async () => Number((await s.db.get<any>(`select count(*) as n from payments`)).n);
    const before = await count();

    const res = await s.agent.post(`/api/client/invoices/${INV_SENT}/payment`, { provider: 'mada' }, { csrf: null });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf_failed');
    // No intent row was created behind the refused request.
    expect(await count()).toBe(before);
  });

  it('records PAYMENT_STARTED but changes no financial state', async () => {
    await loginAs(s.agent, AHMED);
    const intent = await startPayment(INV_SENT);
    await new Promise((r) => setTimeout(r, 80));

    const actions = (await s.db.all<any>(`select action from audit_events`)).map((a) => a.action);
    expect(actions).toContain('PAYMENT_STARTED');

    const before = await invoiceRow(INV_SENT);
    expect(Number(before.amount_paid)).toBe(0);
    expect(before.client_status).toBe('awaiting_payment');
    expect(before.internal_status).toBe('sent');

    const p = await s.db.get<any>(`select status from payments where id = ?`, [intent.paymentId]);
    expect(p.status).toBe('intent_created');
  });
});

describe('§21 · only a verified webhook moves money', () => {
  it('settles an invoice on a correctly signed success event', async () => {
    await loginAs(s.agent, AHMED);
    const intent = await startPayment(INV_SENT);

    const payload = {
      event_id: 'evt_ok_1', payment_id: intent.paymentId,
      status: 'succeeded', amount: 20700, currency: 'SAR',
    };
    const raw = JSON.stringify(payload);
    const res = await postWebhook(payload, sign(raw));

    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(true);

    const row = await invoiceRow(INV_SENT);
    expect(Number(row.amount_paid)).toBe(20700);
    expect(row.client_status).toBe('paid');

    const p = await s.db.get<any>(`select status, receipt_number, amount from payments where id = ?`, [intent.paymentId]);
    expect(p.status).toBe('succeeded');
    expect(p.receipt_number).toMatch(/^RCP-\d{4}-\d{5}$/);
    expect(Number(p.amount)).toBe(20700);
  });

  it('refuses an unsigned webhook and changes nothing', async () => {
    await loginAs(s.agent, AHMED);
    const intent = await startPayment(INV_SENT);
    const payload = { event_id: 'evt_nosig', payment_id: intent.paymentId, status: 'succeeded', amount: 20700 };

    const res = await postWebhook(payload, null);
    expect(res.status).toBe(400);

    const row = await invoiceRow(INV_SENT);
    expect(Number(row.amount_paid)).toBe(0);
    expect(row.client_status).toBe('awaiting_payment');
  });

  it('refuses a webhook signed with the wrong secret', async () => {
    await loginAs(s.agent, AHMED);
    const intent = await startPayment(INV_SENT);
    const payload = { event_id: 'evt_badsecret', payment_id: intent.paymentId, status: 'succeeded', amount: 20700 };
    const raw = JSON.stringify(payload);

    const res = await postWebhook(payload, sign(raw, 'attacker-guessed-secret'));
    expect(res.status).toBe(400);
    expect((await invoiceRow(INV_SENT)).client_status).toBe('awaiting_payment');
  });

  it('refuses a signature computed over a DIFFERENT body (bit-flip attack)', async () => {
    await loginAs(s.agent, AHMED);
    const intent = await startPayment(INV_SENT);

    const honest = JSON.stringify({ event_id: 'evt_flip', payment_id: intent.paymentId, status: 'succeeded', amount: 1 });
    const tampered = JSON.stringify({ event_id: 'evt_flip', payment_id: intent.paymentId, status: 'succeeded', amount: 20700 });

    // Sign the 1-riyal body, deliver the 20700-riyal body.
    const res = await postWebhookRaw(tampered, sign(honest));
    expect(res.status).toBe(400);
    expect((await invoiceRow(INV_SENT)).client_status).toBe('awaiting_payment');
  });

  it('audits an invalid signature without processing the payload', async () => {
    await loginAs(s.agent, AHMED);
    const intent = await startPayment(INV_SENT);
    await postWebhook({ event_id: 'evt_audit', payment_id: intent.paymentId, status: 'succeeded', amount: 20700 }, 'deadbeef');
    await new Promise((r) => setTimeout(r, 80));

    const rows = await s.db.all<any>(
      `select action, outcome from audit_events where action in ('WEBHOOK_SIGNATURE_INVALID','WEBHOOK_RECEIVED')`);
    expect(rows.some((r) => r.action === 'WEBHOOK_SIGNATURE_INVALID' && r.outcome === 'denied')).toBe(true);
    // The payload never became a state transition, so it was never "received".
    expect(rows.some((r) => r.action === 'WEBHOOK_RECEIVED')).toBe(false);
  });

  it('clamps a tampered amount to the outstanding balance', async () => {
    await loginAs(s.agent, AHMED);
    const intent = await startPayment(INV_PARTIAL); // 6925 outstanding

    const payload = { event_id: 'evt_overpay', payment_id: intent.paymentId, status: 'succeeded', amount: 999999 };
    const res = await postWebhook(payload, sign(JSON.stringify(payload)));
    expect(res.status).toBe(200);

    const row = await invoiceRow(INV_PARTIAL);
    expect(Number(row.amount_paid)).toBe(10925); // 4000 + 6925, never more
    expect(row.client_status).toBe('paid');
  });

  it('is idempotent — a replayed event cannot double-credit', async () => {
    await loginAs(s.agent, AHMED);
    const intent = await startPayment(INV_PARTIAL);
    const payload = { event_id: 'evt_replay', payment_id: intent.paymentId, status: 'succeeded', amount: 6925 };
    const raw = JSON.stringify(payload);

    const first = await postWebhook(payload, sign(raw));
    expect(first.body.data.applied).toBe(true);

    for (let i = 0; i < 3; i++) {
      const again = await postWebhook(payload, sign(raw));
      expect(again.status).toBe(200);
      expect(again.body.data.applied).toBe(false);
    }

    const row = await invoiceRow(INV_PARTIAL);
    expect(Number(row.amount_paid)).toBe(10925);
    const n = await s.db.get<any>(
      `select count(*) as n from payment_webhook_events where event_id = 'evt_replay'`);
    expect(Number(n.n)).toBe(1);
  });

  it('records a failed payment without touching the invoice', async () => {
    await loginAs(s.agent, AHMED);
    const intent = await startPayment(INV_SENT);
    const payload = {
      event_id: 'evt_failed', payment_id: intent.paymentId,
      status: 'failed', amount: 20700, failure_reason: 'insufficient_funds',
    };
    const res = await postWebhook(payload, sign(JSON.stringify(payload)));
    expect(res.status).toBe(200);

    const row = await invoiceRow(INV_SENT);
    expect(Number(row.amount_paid)).toBe(0);
    expect(row.client_status).toBe('awaiting_payment');

    const p = await s.db.get<any>(`select status, failure_reason from payments where id = ?`, [intent.paymentId]);
    expect(p.status).toBe('failed');
    // The provider's internal reason is recorded server-side…
    expect(p.failure_reason).toBe('insufficient_funds');

    // …and is NOT shown to the client, which sees only a terminal status.
    const list = await s.agent.get('/api/client/invoices');
    expect(list.text).not.toContain('insufficient_funds');
    expect(list.text).not.toContain('failure_reason');
  });

  it('refuses a webhook for an intent that does not exist', async () => {
    await loginAs(s.agent, AHMED);
    await startPayment(INV_SENT);
    const payload = {
      event_id: 'evt_ghost', payment_id: 'eeeeeeee-9999-4999-8999-999999999999',
      status: 'succeeded', amount: 20700,
    };
    const res = await postWebhook(payload, sign(JSON.stringify(payload)));
    expect(res.status).toBe(404);
  });

  it('refuses a malformed provider name and a non-JSON body', async () => {
    // A provider segment that fails the allowlist regex. (Path-traversal
    // strings are normalized away by the HTTP client before they arrive, so a
    // hyphen is the honest test of the guard.)
    expect((await postWebhook({ event_id: 'x' }, 'sig', 'bad-provider')).status).toBe(400);
    expect((await postWebhook({ event_id: 'x' }, 'sig', 'a'.repeat(40))).status).toBe(400);
    // Case is normalized before the allowlist, so 'MOCK' is a real provider and
    // is refused on the signature instead — proving the guard is not the only
    // thing standing between an attacker and the state machine.
    expect((await postWebhook({ event_id: 'x' }, 'sig', 'MOCK')).status).toBe(400);
    const notJson = await fetch(`http://127.0.0.1:${s.port}/api/webhooks/payments/mock`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'x' }, body: '{{{not json',
    });
    expect(notJson.status).toBe(400);
  });

  it('does not let a client POST to the webhook endpoint with their session', async () => {
    // The route is public and signature-gated; holding a valid client session
    // grants nothing here.
    await loginAs(s.agent, AHMED);
    const intent = await startPayment(INV_SENT);
    const payload = { event_id: 'evt_selfpay', payment_id: intent.paymentId, status: 'succeeded', amount: 20700 };

    const res = await s.agent.post('/api/webhooks/payments/mock', payload);
    expect(res.status).toBe(400);
    expect((await invoiceRow(INV_SENT)).client_status).toBe('awaiting_payment');
  });
});

describe('§20 · receipts appear only after money has actually moved', () => {
  it('lists no receipt before payment', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get('/api/client/receipts');
    expect(res.status).toBe(200);
    // ReceiptDto identifies the PAYMENT, not the invoice — a receipt exists only
    // where money actually moved. The seeded dataset has exactly one settled
    // payment, so exactly one receipt, and it is not for the unpaid invoice.
    const numbers = res.body.data.receipts.map((r: any) => r.number);
    expect(numbers).toEqual(['RCP-2026-00091']);
    expect(res.text).not.toContain(INV_SENT);
    expect(res.text).not.toContain('storage_key');
  });

  it('lists a receipt after a verified webhook, and no receipt for a failed payment', async () => {
    await loginAs(s.agent, AHMED);
    const okIntent = await startPayment(INV_SENT);
    await postWebhook(
      { event_id: 'evt_r1', payment_id: okIntent.paymentId, status: 'succeeded', amount: 20700 },
      sign(JSON.stringify({ event_id: 'evt_r1', payment_id: okIntent.paymentId, status: 'succeeded', amount: 20700 })),
    );
    const failIntent = await startPayment(INV_PARTIAL);
    await postWebhook(
      { event_id: 'evt_r2', payment_id: failIntent.paymentId, status: 'failed', amount: 6925 },
      sign(JSON.stringify({ event_id: 'evt_r2', payment_id: failIntent.paymentId, status: 'failed', amount: 6925 })),
    );

    const res = await s.agent.get('/api/client/receipts');
    const paymentIds = res.body.data.receipts.map((r: any) => r.paymentId);
    // ReceiptDto identifies the payment, not the invoice — the client-facing
    // receipt is a property of money that moved.
    expect(paymentIds).toContain(okIntent.paymentId);
    expect(paymentIds).not.toContain(failIntent.paymentId);
    expect(res.body.data.receipts).toHaveLength(2); // seeded one + the new one
    for (const r of res.body.data.receipts) {
      expect(r.currency).toBe('SAR');
      expect(r.number).toMatch(/^RCP-\d{4}-\d{5}$/);
    }
  });
});

/** Raw-body variant, so the delivered bytes can differ from the signed bytes. */
async function postWebhookRaw(raw: string, signature: string | null, provider: string = config.payments.provider) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-signature'] = signature;
  const res = await fetch(`http://127.0.0.1:${s.port}/api/webhooks/payments/${provider}`, {
    method: 'POST', headers, body: raw,
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text };
}

