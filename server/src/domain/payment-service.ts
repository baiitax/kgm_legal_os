/**
 * PAYMENT SERVICE (§21).
 *
 *   Client → Payment Intent → Provider → Webhook → Server validation →
 *   Payment record → Invoice state transition → Receipt
 *
 * THE ONE RULE: the browser can create an INTENT. It can never create a
 * RESULT. Only a signature-verified webhook may move money state, and the
 * amount it applies is re-derived from the invoice — never taken from the
 * notification alone.
 *
 * ROLE SEPARATION
 *   In production this service connects as `payments_service`, the only role
 *   with UPDATE on invoices. The portal role (`portal_api`) has no write grant
 *   on invoices at all (migration 0004), so even a bug in a client-facing
 *   handler cannot mark an invoice paid. Configure PAYMENTS_DATABASE_URL to
 *   give this service its own connection.
 */
import crypto from 'node:crypto';
import type { Repo } from '../db/repo.js';
import type { AuditLogger, RequestContextInfo } from '../audit/logger.js';
import type { StorageDriver } from '../storage/service.js';
import { config } from '../config.js';
import { newId, sha256 } from '../lib/crypto.js';
import { badRequest, notFoundOrForbidden } from '../lib/errors.js';
import { toMoney } from '../db/types.js';

export interface PaymentDeps {
  repo: Repo;
  audit: AuditLogger;
  storage: StorageDriver;
}

export interface WebhookEvent {
  eventId: string;
  provider: string;
  intentId: string;
  status: 'succeeded' | 'failed';
  amount: string;
  currency: string;
  failureReason?: string;
}

/**
 * Provider adapters. Each returns the same normalized event shape, so the
 * state machine below does not know or care which PSP is in use.
 */
export function parseWebhook(
  provider: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): WebhookEvent {
  const secret = config.payments.webhookSecret;
  if (!secret && config.env === 'production') {
    throw new Error('PAYMENT_WEBHOOK_SECRET is required in production');
  }

  // ---- Signature verification BEFORE parsing. An unverifiable body is never
  // ---- deserialized into a state transition.
  const expected = computeSignature(provider, rawBody, secret);
  const provided = normalizeSignature(provider, signatureHeader);
  if (!timingSafeCompare(expected, provided)) {
    throw badRequest('token_invalid', 'webhook signature verification failed');
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw badRequest('validation_failed', 'webhook payload is not valid JSON');
  }

  switch (provider) {
    case 'mock': {
      const eventId = String(payload.event_id ?? payload.id ?? '');
      const intentId = String(payload.payment_id ?? payload.intent_id ?? '');
      const status = String(payload.status ?? '') === 'succeeded' ? 'succeeded' : 'failed';
      const amount = toMoney(payload.amount);
      if (!eventId || !intentId) throw badRequest('validation_failed', 'incomplete webhook payload');
      return {
        eventId, provider, intentId, status, amount,
        currency: String(payload.currency ?? 'SAR'),
        failureReason: payload.failure_reason ? String(payload.failure_reason).slice(0, 120) : undefined,
      };
    }
    case 'hyperpay':
    case 'moyasar':
    case 'stripe': {
      // Adapter stubs. Each PSP's envelope differs; each maps to WebhookEvent.
      // Wiring one is a matter of filling in the field names and the signature
      // scheme — the state machine below does not change.
      throw new Error(`payment provider "${provider}" adapter is not yet configured`);
    }
    default:
      throw badRequest('validation_failed', 'unknown payment provider');
  }
}

function computeSignature(provider: string, rawBody: Buffer, secret: string): string {
  if (!secret) return 'unsigned-dev';
  // Providers differ (Stripe signs `t=...,v1=...`; others sign the raw body).
  // The normalized form here is HMAC-SHA256 over the raw bytes.
  void provider;
  return sha256Hmac(rawBody, secret);
}

function sha256Hmac(body: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function normalizeSignature(_provider: string, header: string | undefined): string {
  if (!header) return '';
  // Accept both `sha256=<hex>` and a bare hex digest.
  return header.replace(/^sha256=/i, '').trim().toLowerCase();
}

function timingSafeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export class PaymentService {
  constructor(private readonly d: PaymentDeps) {}

  /**
   * Applies a verified webhook event.
   *
   * Idempotency: (provider, event_id) is unique, so a replayed notification
   * cannot double-credit. The amount applied is min(notified, outstanding) so
   * a tampered notification cannot overpay.
   */
  async applyWebhook(event: WebhookEvent, ctx: RequestContextInfo): Promise<{ applied: boolean; reason?: string }> {
    const { repo, audit } = this.d;

    await audit.tryWrite(
      { action: 'WEBHOOK_RECEIVED', actor: { kind: 'webhook' }, resourceType: 'payment',
        resourceId: event.intentId, metadata: { provider: event.provider, status: event.status } },
      ctx,
    );

    return repo.tx(async () => {
      // Replay guard.
      const dup = await repo.raw.get<{ n: number }>(
        `select count(*) as n from payment_webhook_events where provider = ? and event_id = ?`,
        [event.provider, event.eventId],
      );
      if (Number(dup?.n ?? 0) > 0) {
        return { applied: false, reason: 'duplicate_event' };
      }

      const payment = await repo.raw.get<Record<string, unknown>>(
        `select id, tenant_id, invoice_id, client_id, amount, currency, status
           from payments where id = ?`,
        [event.intentId],
      );
      if (!payment) {
        await repo.raw.run(
          `insert into payment_webhook_events (provider, event_id, signature_valid, payload_hash,
                                               processing_error, received_at)
           values (?, ?, TRUE, ?, ?, ?)`,
          [event.provider, event.eventId, sha256(event.intentId), 'unknown_intent',
           new Date().toISOString()],
        );
        throw notFoundOrForbidden('payment');
      }

      await repo.raw.run(
        `insert into payment_webhook_events (provider, event_id, signature_valid, payload_hash,
                                             received_at)
         values (?, ?, TRUE, ?, ?)`,
        [event.provider, event.eventId, sha256(event.intentId), new Date().toISOString()],
      );

      const invoiceId = String(payment.invoice_id);
      const tenantId = String(payment.tenant_id);
      const clientId = String(payment.client_id);
      const nowIso = new Date().toISOString();

      if (event.status === 'failed') {
        await repo.raw.run(
          `update payments set status = 'failed', failure_reason = ?, webhook_received_at = ?
            where id = ? and status = 'intent_created'`,
          [event.failureReason ?? 'provider_declined', nowIso, event.intentId],
        );
        await audit.tryWrite(
          { action: 'PAYMENT_FAILED', actor: { kind: 'webhook', tenantId, clientId },
            resourceType: 'invoice', resourceId: invoiceId, outcome: 'failure',
            reasonCode: 'provider_declined' }, ctx);
        return { applied: true, reason: 'failed' };
      }

      const invoice = await repo.raw.get<Record<string, unknown>>(
        `select id, total, amount_paid, internal_status, invoice_number, currency
           from invoices where id = ?`,
        [invoiceId],
      );
      if (!invoice) throw notFoundOrForbidden('invoice');

      const total = Number(invoice.total);
      const alreadyPaid = Number(invoice.amount_paid ?? 0);
      const outstanding = Math.max(0, Math.round((total - alreadyPaid) * 100) / 100);

      // The credited amount is clamped to what is actually outstanding.
      const notified = Number(event.amount);
      const credited = Math.min(outstanding, Math.max(0, Math.round(notified * 100) / 100));
      if (credited <= 0) {
        await repo.raw.run(
          `update payments set status = 'succeeded', webhook_received_at = ?, completed_at = ?
            where id = ?`,
          [nowIso, nowIso, event.intentId],
        );
        return { applied: false, reason: 'no_outstanding_balance' };
      }

      const newPaid = Math.round((alreadyPaid + credited) * 100) / 100;
      const fullyPaid = newPaid >= total - 0.001;
      const receiptNumber = `RCP-${new Date().getFullYear()}-${Math.floor(Math.random() * 90000 + 10000)}`;

      await repo.raw.run(
        `update payments
            set status = 'succeeded', amount = ?, webhook_received_at = ?, completed_at = ?,
                receipt_number = ?
          where id = ? and status = 'intent_created'`,
        [credited, nowIso, nowIso, receiptNumber, event.intentId],
      );

      // THE ONLY PLACE invoice financial state changes. client_status is
      // derived, and the database trigger rejects any other value.
      await repo.raw.run(
        `update invoices
            set amount_paid = ?,
                internal_status = ?,
                client_status = ?,
                updated_at = ?
          where id = ?`,
        [
          newPaid,
          fullyPaid ? 'paid' : 'partially_paid',
          fullyPaid ? 'paid' : 'partially_paid',
          nowIso,
          invoiceId,
        ],
      );

      const receiptId = newId();
      const receiptKey = `${tenantId}/${clientId}/financial/${invoiceId}/${receiptId}.pdf`;
      await repo.raw.run(
        `insert into receipts (id, tenant_id, payment_id, invoice_id, client_id,
                               receipt_number, issued_at, amount, currency, storage_key, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [receiptId, tenantId, event.intentId, invoiceId, clientId, receiptNumber,
         nowIso, credited, String(invoice.currency ?? 'SAR'), receiptKey, nowIso],
      );

      // Render a minimal receipt into private storage.
      const pdf = renderReceiptPdf({
        receiptNumber, invoiceNumber: String(invoice.invoice_number),
        amount: credited.toFixed(2), currency: String(invoice.currency ?? 'SAR'),
        issuedAt: nowIso,
      });
      await this.d.storage.put(receiptKey, pdf, 'application/pdf').catch(() => undefined);

      // Notify the payer.
      const users = await repo.raw.all<{ user_id: string }>(
        `select user_id from client_users where client_id = ? and tenant_id = ? and status = 'active'`,
        [clientId, tenantId],
      );
      for (const u of users) {
        await repo.createNotification({
          id: newId(), tenant_id: tenantId, user_id: u.user_id, client_id: clientId,
          category: 'payment', severity: 'info',
          title: `Payment received · ${receiptNumber}`,
          title_ar: `تم استلام الدفعة · ${receiptNumber}`,
          body: `We received ${credited.toFixed(2)} SAR for invoice ${String(invoice.invoice_number)}.`,
          body_ar: `استلمنا ${credited.toFixed(2)} ر.س للفاتورة ${String(invoice.invoice_number)}.`,
          link: `/portal/invoices/${invoiceId}`, matter_id: null, created_at: nowIso,
        });
      }

      await audit.write(
        { action: 'PAYMENT_COMPLETED', actor: { kind: 'webhook', tenantId, clientId },
          resourceType: 'invoice', resourceId: invoiceId,
          metadata: { paymentId: event.intentId, receiptNumber, amountMinor: Math.round(credited * 100), fullyPaid } },
        ctx,
      );

      return { applied: true };
    });
  }
}

/**
 * A minimal, dependency-free PDF receipt. Real deployments would render through
 * the firm's branded template engine; the storage, authorization and audit
 * path around it is identical.
 */
function renderReceiptPdf(input: {
  receiptNumber: string; invoiceNumber: string; amount: string;
  currency: string; issuedAt: string;
}): Buffer {
  const lines = [
    'KGM LEGAL OS - PAYMENT RECEIPT',
    '',
    `Receipt:  ${input.receiptNumber}`,
    `Invoice:  ${input.invoiceNumber}`,
    `Amount:   ${input.amount} ${input.currency}`,
    `Issued:   ${input.issuedAt}`,
    '',
    'This receipt is machine-generated and valid without a signature.',
  ];
  const content = lines.join('\n');

  const stream = `BT /F1 12 Tf 56 760 Td 16 TL\n${lines
    .map((l) => `(${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj T*`)
    .join('\n')}\nET`;

  const objects: string[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  );
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  void content;
  return Buffer.from(pdf, 'latin1');
}
