/**
 * Payment provider webhooks (§21).
 *
 * Mounted with express.raw BEFORE express.json so the exact bytes can be
 * signature-verified. A webhook that does not verify is rejected before it is
 * even parsed — an unverifiable body never becomes a state transition.
 */
import { Router } from 'express';
import type { Container } from '../container.js';
import { ah } from '../auth/middleware.js';
import { ok } from '../lib/http.js';
import { requestInfo } from '../audit/logger.js';
import { config } from '../config.js';
import { parseWebhook } from '../domain/payment-service.js';
import { limit, keys } from '../auth/ratelimit.js';
import { PortalError } from '../lib/errors.js';

export function webhookRouter(c: Container): Router {
  const r = Router();

  r.post('/payments/:provider', ah(async (req, res) => {
    const provider = String(req.params.provider).toLowerCase();
    if (!/^[a-z_]{2,32}$/.test(provider)) {
      throw new PortalError(400, 'validation_failed', 'invalid provider');
    }

    // Public endpoints get the tightest budget of all.
    const ip = req.ip ?? 'unknown';
    const budget = limit(keys.webhook(ip), 60, 60);
    if (budget.limited) {
      res.setHeader('retry-after', String(budget.retryAfterSeconds));
      throw new PortalError(429, 'rate_limited', 'too many webhook deliveries');
    }

    const ctx = requestInfo(req, c.trustProxy);
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));

    if (raw.length === 0 || raw.length > 256 * 1024) {
      throw new PortalError(400, 'validation_failed', 'invalid webhook body');
    }

    const signature = req.header('x-signature') ?? req.header('stripe-signature') ?? req.header('x-webhook-signature');

    let event;
    try {
      event = parseWebhook(provider, raw, signature ?? undefined);
    } catch (err) {
      await c.audit.tryWrite(
        { action: 'WEBHOOK_SIGNATURE_INVALID', actor: { kind: 'webhook' }, outcome: 'denied',
          reasonCode: err instanceof PortalError ? err.code : 'parse_error' }, ctx);
      throw err;
    }

    const result = await c.payments.applyWebhook(event, ctx);
    // The provider is told only that we received it. Internal reasons stay
    // server-side so the endpoint cannot be used to probe invoice state.
    ok(res, { received: true, applied: result.applied, provider: config.payments.provider });
  }));

  return r;
}
