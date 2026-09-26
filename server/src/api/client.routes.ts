/**
 * CLIENT PORTAL API (§36).
 *
 * Every route here is behind `requireClient`, which means a Principal resolved
 * from the session cookie, with tenant and client ids taken from client_users.
 * No route accepts a tenant_id, client_id, role or permission from the request.
 *
 * The route list is the contract. If an endpoint is not here, it does not exist
 * for a client — there is no generic table endpoint, no PostgREST passthrough,
 * no "query anything" surface.
 */
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Container } from '../container.js';
import { ah, csrfGuard, requireAccountHolder, requireClient, uploadRateLimit, tamperGuard } from '../auth/middleware.js';
import { ok } from '../lib/http.js';
import { requestInfo } from '../audit/logger.js';
import { badRequest } from '../lib/errors.js';
import { config } from '../config.js';

/**
 * Multer with memory storage and a hard byte ceiling. The limit is enforced by
 * multer BEFORE our handler runs, so an oversized body is rejected without
 * being buffered — and it never touches a temp directory on disk.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.uploads.maxBytes,
    files: 1,
    fields: 10,
    fieldNameSize: 100,
    headerPairs: 100,
  },
});

export function clientRouter(c: Container): Router {
  const r = Router();
  const ctxOf = (req: Parameters<typeof requestInfo>[0]) => requestInfo(req, c.trustProxy);
  /** Shorthand so every mutating route reads the same way. */
  const guard = (exempt?: string[]) => tamperGuard(c, exempt) as never;
  /**
   * The money, and who may see it. Mounted on every billing route below.
   *
   * Filtering the sidebar is not a control, and this project has already
   * rejected "hide functionality" as a posture: a contact whose menu omits
   * Invoices must not be able to GET them either. The gate lives here rather
   * than in the service so that the route table reads as the contract it is —
   * you can see, on one line per route, which role each surface answers to.
   */
  const holder = requireAccountHolder(c);

  // Everything below requires a fully authorized client principal.
  r.use(requireClient(c));

  // =========================================================================
  // DASHBOARD
  // =========================================================================
  r.get('/dashboard', ah(async (req, res) => {
    ok(res, await c.clients.dashboard(req.principal!));
  }));

  // =========================================================================
  // MATTERS (§12, §13, §14)
  // =========================================================================
  r.get('/matters', ah(async (req, res) => {
    ok(res, { matters: await c.clients.listMatters(req.principal!) });
  }));

  r.get('/matters/:id', ah(async (req, res) => {
    ok(res, await c.clients.getMatter(req.principal!, String(req.params.id), ctxOf(req)));
  }));

  // =========================================================================
  // HEARINGS & DEADLINES (§15, §16)
  // =========================================================================
  r.get('/hearings', ah(async (req, res) => {
    ok(res, { hearings: await c.clients.listHearings(req.principal!) });
  }));

  r.get('/deadlines', ah(async (req, res) => {
    ok(res, { deadlines: await c.clients.listDeadlines(req.principal!) });
  }));

  r.patch('/deadlines/:id', csrfGuard(), guard(['status']), ah(async (req, res) => {
    const body = z.object({ status: z.string().min(1).max(40) }).safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request');
    ok(res, await c.clients.updateDeadlineStatus(
      req.principal!, String(req.params.id), body.data.status, ctxOf(req)));
  }));

  // =========================================================================
  // DOCUMENTS (§17, §18, §19)
  // =========================================================================
  r.get('/documents', ah(async (req, res) => {
    const query = {
      matterId: typeof req.query.matterId === 'string' ? req.query.matterId : undefined,
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
    };
    ok(res, { documents: await c.clients.listDocuments(req.principal!, query) });
  }));

  /**
   * Issues a short-lived, session-bound URL. The client asks for a grant; the
   * server decides. There is no route that takes a storage key.
   */
  r.post('/documents/:id/access-url', csrfGuard(), guard(), ah(async (req, res) => {
    const body = z.object({ disposition: z.enum(['inline', 'attachment']).optional() }).safeParse(req.body ?? {});
    if (!body.success) throw badRequest('validation_failed', 'invalid request');
    ok(res, await c.clients.issueDocumentAccess(
      req.principal!, String(req.params.id), body.data.disposition ?? 'attachment', ctxOf(req)));
  }));

  /**
   * The bytes. Signature verified AND authorization re-checked. Streams with
   * Content-Disposition and nosniff; never cached by a shared proxy.
   */
  r.get('/documents/:id/access', ah(async (req, res) => {
    const out = await c.clients.readDocumentBytes(
      req.principal!,
      String(req.params.id),
      {
        exp: String(req.query.exp ?? ''),
        sig: String(req.query.sig ?? ''),
        disposition: String(req.query.disposition ?? 'attachment'),
      },
      ctxOf(req),
    );

    const filenameRfc5987 = encodeURIComponent(out.fileName).replace(/['()]/g, '');
    res.setHeader('content-type', out.mimeType);
    res.setHeader('content-length', String(out.body.length));
    res.setHeader(
      'content-disposition',
      `${out.disposition}; filename="document"; filename*=UTF-8''${filenameRfc5987}`,
    );
    res.setHeader('cache-control', 'no-store, max-age=0');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive');
    res.setHeader('etag', `"${out.sha256}"`);
    if (out.disposition === 'inline' && out.mimeType === 'application/pdf') {
      // Sandboxed inline preview: no script, no same-origin access.
      res.setHeader('content-security-policy', "sandbox; default-src 'none'");
    }
    res.status(200).end(out.body);
  }));

  r.post('/documents/upload', csrfGuard(), uploadRateLimit(c), upload.single('file'),
    guard(), ah(async (req, res) => {
      const meta = z
        .object({
          matterId: z.string().uuid().nullable().optional(),
          documentType: z.string().min(1).max(40),
          title: z.string().min(1).max(200).optional(),
          titleAr: z.string().min(1).max(200).optional(),
          fulfillRequestId: z.string().uuid().optional(),
        })
        .safeParse({
          matterId: req.body?.matterId === '' ? null : req.body?.matterId,
          documentType: req.body?.documentType,
          title: req.body?.title,
          titleAr: req.body?.titleAr,
          fulfillRequestId: req.body?.fulfillRequestId,
        });
      if (!meta.success) throw badRequest('validation_failed', 'invalid upload metadata', {
        fields: meta.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });

      const file = req.file;
      if (!file) throw badRequest('upload_rejected', 'no file was provided');

      const out = await c.clients.uploadDocument(
        req.principal!,
        meta.data,
        { buffer: file.buffer, originalName: file.originalname, declaredMime: file.mimetype },
        ctxOf(req),
      );
      ok(res, out, 201);
    }));

  // =========================================================================
  // INVOICES & PAYMENTS (§20, §21)
  // =========================================================================
  r.get('/invoices', holder, ah(async (req, res) => {
    ok(res, { invoices: await c.clients.listInvoices(req.principal!) });
  }));

  r.get('/invoices/:id', holder, ah(async (req, res) => {
    ok(res, await c.clients.getInvoice(req.principal!, String(req.params.id), ctxOf(req)));
  }));

  /**
   * Creates an intent. It cannot mark anything paid — see PaymentService.
   * There is deliberately no PATCH/PUT/POST route that writes invoice state.
   */
  r.post('/invoices/:id/payment', holder, csrfGuard(), guard(), ah(async (req, res) => {
    const body = z
      .object({ provider: z.string().min(1).max(40).optional(), idempotencyKey: z.string().min(8).max(120).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) throw badRequest('validation_failed', 'invalid request');
    ok(res, await c.clients.startPayment(req.principal!, String(req.params.id), body.data, ctxOf(req)));
  }));

  r.get('/receipts', holder, ah(async (req, res) => {
    ok(res, { receipts: await c.clients.listReceipts(req.principal!) });
  }));

  // =========================================================================
  // MESSAGES (§22)
  // =========================================================================
  r.get('/messages', ah(async (req, res) => {
    ok(res, { threads: await c.clients.listThreads(req.principal!) });
  }));

  r.get('/messages/:threadId', ah(async (req, res) => {
    ok(res, await c.clients.getThread(req.principal!, String(req.params.threadId), ctxOf(req)));
  }));

  r.post('/messages/:threadId', csrfGuard(), guard(), ah(async (req, res) => {
    const body = z.object({ body: z.string().trim().min(1).max(4000) }).safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request');
    ok(res, await c.clients.sendMessage(
      req.principal!, String(req.params.threadId), body.data.body, ctxOf(req)), 201);
  }));

  // =========================================================================
  // APPOINTMENTS (§23)
  // =========================================================================
  r.get('/appointments', ah(async (req, res) => {
    ok(res, await c.clients.listAppointments(req.principal!));
  }));

  r.post('/appointments', csrfGuard(), guard(), ah(async (req, res) => {
    const body = z
      .object({
        matterId: z.string().uuid().nullable().optional(),
        typeId: z.string().uuid().optional(),
        preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        preferredTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        preferredMode: z.enum(['in_person', 'video', 'phone']).optional(),
        note: z.string().max(1000).optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request', {
      fields: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    ok(res, await c.clients.requestAppointment(req.principal!, body.data, ctxOf(req)), 201);
  }));

  r.post('/appointments/:id/cancel', csrfGuard(), guard(), ah(async (req, res) => {
    const body = z.object({ reason: z.string().max(500).optional() }).safeParse(req.body ?? {});
    if (!body.success) throw badRequest('validation_failed', 'invalid request');
    ok(res, await c.clients.cancelAppointment(
      req.principal!, String(req.params.id), body.data.reason ?? '', ctxOf(req)));
  }));

  // =========================================================================
  // NOTIFICATIONS (§24)
  // =========================================================================
  r.get('/notifications', ah(async (req, res) => {
    ok(res, await c.clients.listNotifications(req.principal!));
  }));

  r.post('/notifications/:id/read', csrfGuard(), guard(), ah(async (req, res) => {
    ok(res, await c.clients.markNotificationRead(req.principal!, String(req.params.id), ctxOf(req)));
  }));

  r.post('/notifications/read-all', csrfGuard(), guard(), ah(async (req, res) => {
    ok(res, await c.clients.markAllNotificationsRead(req.principal!));
  }));

  r.get('/notification-preferences', ah(async (req, res) => {
    ok(res, { preferences: await c.clients.listNotificationPreferences(req.principal!) });
  }));

  r.patch('/notification-preferences/:category', csrfGuard(), guard(), ah(async (req, res) => {
    const body = z.object({ inApp: z.boolean(), email: z.boolean() }).safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request');
    ok(res, await c.clients.updateNotificationPreference(
      req.principal!, String(req.params.category), body.data.inApp, body.data.email, ctxOf(req)));
  }));

  // =========================================================================
  // PROFILE & PREFERENCES (§25, §28)
  // =========================================================================
  r.get('/profile', ah(async (req, res) => {
    ok(res, await c.clients.getProfile(req.principal!));
  }));

  /**
   * Writable fields are an allowlist. Anything else — including tenant_id,
   * client_id, role, permissions, status, national_id and identity_verified —
   * is refused with a FIELD_TAMPER_ATTEMPT audit event rather than silently
   * dropped (§46).
   */
  r.patch('/profile', csrfGuard(), guard(), ah(async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw badRequest('validation_failed', 'invalid request');
    }
    // An empty body means the endpoint received a content-type it does not parse
    // (form-encoded, text, or nothing). Answering 200 would tell a caller that
    // the update succeeded when nothing was read at all.
    if (Object.keys(req.body as Record<string, unknown>).length === 0) {
      throw badRequest('validation_failed', 'no writable fields were provided');
    }
    ok(res, await c.clients.updateProfile(req.principal!, req.body as Record<string, unknown>, ctxOf(req)));
  }));

  r.patch('/preferences', csrfGuard(), guard(), ah(async (req, res) => {
    const body = z
      .object({
        language: z.enum(['ar', 'en']).optional(),
        calendar: z.enum(['islamic-umalqura', 'gregory']).optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request');
    ok(res, await c.clients.updatePreferences(req.principal!, body.data, ctxOf(req)));
  }));

  // =========================================================================
  // SECURITY CENTRE (§26)
  // =========================================================================
  r.get('/security', ah(async (req, res) => {
    ok(res, await c.clients.securityOverview(req.principal!, req));
  }));

  r.post('/security/sessions/:id/revoke', csrfGuard(), guard(), ah(async (req, res) => {
    ok(res, await c.clients.revokeSession(req.principal!, String(req.params.id), ctxOf(req)));
  }));

  r.post('/security/sessions/revoke-all-others', csrfGuard(), guard(), ah(async (req, res) => {
    ok(res, await c.clients.revokeAllOtherSessions(req.principal!, ctxOf(req)));
  }));

  r.post('/security/devices/:id/revoke', csrfGuard(), guard(), ah(async (req, res) => {
    ok(res, await c.clients.revokeDevice(req.principal!, String(req.params.id), ctxOf(req)));
  }));

  // =========================================================================
  // PRIVACY CENTRE (§27)
  // =========================================================================
  r.get('/privacy', ah(async (req, res) => {
    ok(res, await c.clients.privacyOverview(req.principal!));
  }));

  /**
   * Account deletion is a REQUEST that goes to compliance review. There is no
   * DELETE route for the account: retention obligations are assessed by a
   * human, not by the person asking (§27).
   */
  r.post('/privacy/requests', csrfGuard(), guard(), ah(async (req, res) => {
    const body = z
      .object({ requestType: z.string().min(1).max(40), details: z.string().max(2000).optional() })
      .safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request');
    ok(res, await c.clients.submitPrivacyRequest(req.principal!, body.data, ctxOf(req)), 201);
  }));

  r.post('/privacy/requests/:id/withdraw', csrfGuard(), guard(), ah(async (req, res) => {
    ok(res, await c.clients.withdrawPrivacyRequest(req.principal!, String(req.params.id), ctxOf(req)));
  }));

  r.post('/privacy/consent', csrfGuard(), guard(), ah(async (req, res) => {
    const body = z
      .object({ purpose: z.string().min(1).max(40), consented: z.boolean() })
      .safeParse(req.body);
    if (!body.success) throw badRequest('validation_failed', 'invalid request');
    ok(res, await c.clients.recordConsent(req.principal!, body.data.purpose, body.data.consented, ctxOf(req)));
  }));

  return r;
}
