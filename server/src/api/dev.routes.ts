/**
 * DEVELOPMENT-ONLY ROUTES.
 *
 * These exist because the demo has no real mailbox and no real Internal Firm
 * OS. They let a reviewer walk the §48 journey end to end:
 *
 *   GET  /api/dev/outbox         read the emails the server "sent"
 *   POST /api/dev/invite         mint an invitation as the firm would
 *   POST /api/dev/webhook/simulate   fire a signed payment webhook
 *   GET  /api/dev/audit          read the audit trail (a firm-side capability)
 *
 * THE ROUTER IS NOT MOUNTED IN PRODUCTION. `app.ts` refuses to attach it when
 * NODE_ENV=production, so there is no flag to forget and no env var to flip.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Container } from '../container.js';
import { ah } from '../auth/middleware.js';
import { ok } from '../lib/http.js';
import { requestInfo } from '../audit/logger.js';
import { badRequest } from '../lib/errors.js';
import { readOutbox, clearOutbox } from '../auth/email.js';
import { config } from '../config.js';
import { IDS, DEMO_ACCOUNTS } from '../db/demo-data.js';
import { sha256 } from '../lib/crypto.js';

export function devRouter(c: Container): Router {
  const r = Router();
  const ctxOf = (req: Parameters<typeof requestInfo>[0]) => requestInfo(req, c.trustProxy);

  r.get('/outbox', (_req, res) => {
    ok(res, { emails: readOutbox() });
  });

  r.post('/outbox/clear', (_req, res) => {
    clearOutbox();
    ok(res, { cleared: true });
  });

  /** Firm-side invitation, mirroring what the Internal Firm OS would do. */
  r.post('/invite', ah(async (req, res) => {
    const body = z
      .object({
        email: z.string().email(),
        displayName: z.string().min(2).max(120),
        displayNameAr: z.string().max(120).optional(),
        clientId: z.string().uuid().optional(),
        tenantId: z.string().uuid().optional(),
        portalRole: z.enum(['client_primary', 'client_contact']).optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request');

    const out = await c.auth.createInvitation(ctxOf(req), {
      tenantId: body.data.tenantId ?? IDS.tenantKgm,
      clientId: body.data.clientId ?? IDS.clientAhmed,
      email: body.data.email,
      displayName: body.data.displayName,
      displayNameAr: body.data.displayNameAr,
      portalRole: body.data.portalRole ?? 'client_contact',
    });
    ok(res, out, 201);
  }));

  /**
   * Simulates a provider webhook with a VALID signature, so the payment journey
   * can be completed in the demo. In production the PSP calls the real endpoint
   * and this route does not exist.
   */
  r.post('/webhook/simulate', ah(async (req, res) => {
    const body = z
      .object({
        paymentId: z.string().uuid(),
        status: z.enum(['succeeded', 'failed']).default('succeeded'),
        amount: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request');

    const payload = {
      event_id: `evt_${crypto.randomUUID()}`,
      payment_id: body.data.paymentId,
      status: body.data.status,
      amount: body.data.amount,
      currency: 'SAR',
    };
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const secret = config.payments.webhookSecret || '';
    const signature = secret
      ? crypto.createHmac('sha256', secret).update(raw).digest('hex')
      : 'unsigned-dev';

    ok(res, {
      curl:
        `curl -X POST ${config.auth.portalBaseUrl}/api/webhooks/payments/mock \\\n` +
        `  -H 'content-type: application/json' \\\n` +
        `  -H 'x-signature: ${signature}' \\\n` +
        `  --data-raw '${JSON.stringify(payload)}'`,
      payload,
      signature,
    });
  }));

  /**
   * Firm-side audit read. Deliberately NOT under /api/client: the portal role
   * has no SELECT on audit_events, and a client session is never authorized to
   * call this even in development.
   */
  r.get('/audit', ah(async (req, res) => {
    const limitN = Math.min(Number(req.query.limit ?? 100), 500);
    const action = typeof req.query.action === 'string' ? req.query.action : null;
    const outcome = typeof req.query.outcome === 'string' ? req.query.outcome : null;

    const where: string[] = [];
    const params: unknown[] = [];
    if (action) { where.push('action = ?'); params.push(action); }
    if (outcome) { where.push('outcome = ?'); params.push(outcome); }

    const rows = await c.repo.raw.all(
      `select id, occurred_at, actor_kind, actor_user_id, action, resource_type,
              resource_id, outcome, reason_code, ip_country, request_id, metadata
         from audit_events
        ${where.length ? `where ${where.join(' and ')}` : ''}
        order by id desc limit ?`,
      [...params, limitN],
    );
    ok(res, {
      count: rows.length,
      events: rows.map((e) => ({
        id: Number(e.id),
        occurredAt: String(e.occurred_at),
        actorKind: String(e.actor_kind),
        action: String(e.action),
        resourceType: e.resource_type ? String(e.resource_type) : null,
        resourceId: e.resource_id ? String(e.resource_id) : null,
        outcome: String(e.outcome),
        reasonCode: e.reason_code ? String(e.reason_code) : null,
        ipCountry: e.ip_country ? String(e.ip_country) : null,
        requestId: e.request_id ? String(e.request_id) : null,
        metadata: typeof e.metadata === 'string' ? safeJson(e.metadata) : e.metadata,
      })),
    });
  }));

  r.get('/accounts', (_req, res) => {
    ok(res, {
      accounts: DEMO_ACCOUNTS.map((a) => ({ email: a.email, password: a.password, who: a.who })),
      tenants: { kgm: IDS.tenantKgm, najd: IDS.tenantNajd },
      clients: { ahmed: IDS.clientAhmed, gulf: IDS.clientGulf, layla: IDS.clientLayla },
      matters: {
        commercial: IDS.matterCommercial, realEstate: IDS.matterRealEstate,
        employment: IDS.matterEmployment, gulf: IDS.matterGulf, layla: IDS.matterLayla,
      },
      note: 'Synthetic data only (§44). No real identifiers appear in this dataset.',
      fingerprint: sha256('demo').slice(0, 12),
    });
  });

  return r;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
