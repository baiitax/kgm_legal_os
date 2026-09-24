/**
 * CLIENT DOMAIN SERVICE (§36, §49).
 *
 * This is the layer that decides what a client may do. It sits between the HTTP
 * routes and the repository, and it is where §35's twelve rules are actually
 * implemented:
 *
 *   R1  tenant is taken from the Principal, never from input
 *   R2  role is taken from client_users, never from input
 *   R3  client ids come from client_users, never from input
 *   R4  every read is filtered by those client ids in SQL
 *   R5  internal notes have no method in the repository at all
 *   R6  no method here can write invoice state; only the webhook path can
 *   R7  audit is insert-only at the driver level
 *   R8/R9 staff and compliance surfaces are not mounted on this process
 *   R10 storage keys are generated here, never accepted from input
 *   R11 every mutation re-checks ownership and rejects unwritable fields
 *   R12 every sensitive operation writes an audit event in the same tx
 */
import type { Repo } from '../db/repo.js';
import type { SessionManager } from '../auth/session.js';
import type { AuditLogger, RequestContextInfo } from '../audit/logger.js';
import type { Principal } from '../auth/session.js';
import type { StorageDriver } from '../storage/service.js';
import { config } from '../config.js';
import { newId, sha256 } from '../lib/crypto.js';
import { PortalError, badRequest, forbidden, notFoundOrForbidden } from '../lib/errors.js';
import { FORBIDDEN_FIELDS } from './protected-fields.js';
import { isDangerousExtension, sanitizeFilename, sniffMime } from '../lib/http.js';
import {
  buildStorageKey, scanBuffer, signAccessUrl, verifyAccessSignature,
} from '../storage/service.js';
import type { Disposition } from '../storage/service.js';
import * as dto from './dto.js';
import { toBool, toIso } from '../db/types.js';
import type { Param } from '../db/types.js';

export interface Deps {
  repo: Repo;
  sessions: SessionManager;
  audit: AuditLogger;
  storage: StorageDriver;
}

export function assertNoForbiddenFields(
  body: unknown,
  allowed: Set<string>,
  ctx: RequestContextInfo,
  deps: Deps,
  principal: Principal | null,
  resource: string,
): void {
  if (!body || typeof body !== 'object') return;
  const offered = Object.keys(body as Record<string, unknown>);
  const tamper = offered.filter((k) => FORBIDDEN_FIELDS.has(k.toLowerCase().replace(/-/g, '_')));
  const unknown = offered.filter(
    (k) => !allowed.has(k) && !FORBIDDEN_FIELDS.has(k.toLowerCase().replace(/-/g, '_')),
  );

  if (tamper.length) {
    void deps.audit.tryWrite(
      {
        action: 'FIELD_TAMPER_ATTEMPT',
        actor: principal
          ? { kind: 'client_user', userId: principal.userId, tenantId: principal.tenantId, clientId: principal.primaryClientId }
          : { kind: 'anonymous' },
        outcome: 'denied',
        reasonCode: 'protected_field_in_payload',
        resourceType: resource,
        metadata: { fields: tamper.slice(0, 20) },
      },
      ctx,
    );
    throw forbidden('field_not_writable', 'this field cannot be set from the client portal',
      'protected_field_in_payload', { alreadyAudited: true });
  }
  if (unknown.length) {
    throw badRequest('validation_failed', 'unknown fields in request', {
      fields: unknown.slice(0, 20),
    });
  }
}

export class ClientService {
  constructor(private readonly d: Deps) {}

  private get repo() { return this.d.repo; }
  private get audit() { return this.d.audit; }

  // =========================================================================
  // DASHBOARD (§10, §11)
  // =========================================================================
  async dashboard(p: Principal) {
    const [counts, balance, hearings, deadlines, matters] = await Promise.all([
      this.repo.dashboardCounts(p.tenantId, p.clientIds),
      this.repo.outstandingBalance(p.tenantId, p.clientIds),
      this.repo.listHearings(p.tenantId, p.clientIds),
      this.repo.listDeadlines(p.tenantId, p.clientIds),
      this.repo.listMatters(p.tenantId, p.clientIds),
    ]);

    const now = Date.now();
    const upcoming = hearings
      .filter((h) => h.client_status === 'upcoming' && new Date(String(h.scheduled_at)).getTime() > now)
      .sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)))
      .slice(0, 3)
      .map(dto.hearing);

    const openDeadlines = deadlines
      .map((r) => dto.deadline(r, now))
      .filter((d) => d.status === 'open' || d.status === 'in_progress' || d.overdue)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .slice(0, 4);

    const unread = await this.repo.countUnreadNotifications(p.userId, p.tenantId);

    const nextHearingByMatter = new Map<string, string>();
    for (const h of hearings) {
      const mid = String(h.matter_id);
      const at = toIso(h.scheduled_at);
      if (!at || new Date(at).getTime() <= now) continue;
      if (h.client_status !== 'upcoming') continue;
      const existing = nextHearingByMatter.get(mid);
      if (!existing || at < existing) nextHearingByMatter.set(mid, at);
    }

    return {
      greeting: {
        displayName: p.clientUser.displayName,
        displayNameAr: p.clientUser.displayNameAr ?? p.clientUser.displayName,
        firmName: (await this.repo.getTenant(p.tenantId))?.name as string,
        firmNameAr: (await this.repo.getTenant(p.tenantId))?.name_ar as string,
      },
      counts: {
        activeMatters: counts.matters,
        upcomingHearings: counts.upcomingHearings,
        openDeadlines: counts.openDeadlines,
        unpaidInvoices: counts.unpaidInvoices,
        unreadNotifications: unread,
      },
      outstandingBalance: { amount: balance, currency: 'SAR' },
      matters: matters
        .slice(0, 4)
        .map((m) => dto.matterSummary(m, nextHearingByMatter.get(String(m.id)) ?? null)),
      upcomingHearings: upcoming,
      deadlines: openDeadlines,
      serverTime: new Date(now).toISOString(),
    };
  }

  // =========================================================================
  // MATTERS (§12, §13, §14)
  // =========================================================================
  async listMatters(p: Principal) {
    const [matters, hearings] = await Promise.all([
      this.repo.listMatters(p.tenantId, p.clientIds),
      this.repo.listHearings(p.tenantId, p.clientIds),
    ]);
    const now = Date.now();
    const next = new Map<string, string>();
    for (const h of hearings) {
      const at = toIso(h.scheduled_at);
      if (!at || new Date(at).getTime() <= now) continue;
      if (h.client_status !== 'upcoming' || !toBool(h.client_visible)) continue;
      const mid = String(h.matter_id);
      const cur = next.get(mid);
      if (!cur || at < cur) next.set(mid, at);
    }
    return matters.map((m) => dto.matterSummary(m, next.get(String(m.id)) ?? null));
  }

  /**
   * §35 R4 — the matter id comes from the URL, but the query is scoped to the
   * principal's client ids. A matter belonging to another client returns
   * exactly the same 404 as a matter that does not exist, so the endpoint
   * cannot be used to probe for ids.
   */
  async getMatter(p: Principal, matterId: string, ctx: RequestContextInfo) {
    const matter = await this.repo.getMatter(matterId, p.tenantId, p.clientIds);
    if (!matter) {
      await this.audit.tryWrite(
        { action: 'AUTHZ_DENIED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          outcome: 'denied', reasonCode: 'matter_not_in_scope', resourceType: 'matter', resourceId: matterId },
        ctx,
      );
      throw notFoundOrForbidden('matter', matterId);
    }

    const [team, timeline, hearings, deadlines, documents, invoices, threads] = await Promise.all([
      this.repo.listMatterTeam(matterId, p.tenantId, p.clientIds),
      this.repo.listTimeline(matterId, p.tenantId, p.clientIds),
      this.repo.listHearings(p.tenantId, p.clientIds, matterId),
      this.repo.listDeadlines(p.tenantId, p.clientIds, matterId),
      this.repo.listDocuments(p.tenantId, p.clientIds, { matterId }),
      this.repo.listInvoices(p.tenantId, p.clientIds),
      this.repo.listThreads(p.tenantId, p.clientIds),
    ]);

    const now = Date.now();
    const nextHearing = hearings
      .filter((h) => h.client_status === 'upcoming' && new Date(String(h.scheduled_at)).getTime() > now)
      .sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)))[0];

    return {
      ...dto.matterSummary(matter, nextHearing ? toIso(nextHearing.scheduled_at) : null),
      // The client-safe lifecycle only. internal_status is not in the SELECT.
      lifecycle: ['opened', 'under_review', 'hearings', 'judgment', 'execution', 'closed'],
      legalTeam: team.map(dto.teamMember),
      timeline: timeline.map(dto.timelineEvent),
      hearings: hearings.map(dto.hearing),
      deadlines: deadlines.map((r) => dto.deadline(r, now)),
      documents: documents.map(dto.document),
      invoices: invoices.filter((i) => String(i.matter_id) === matterId).map(dto.invoice),
      threads: threads.filter((t) => String(t.matter_id) === matterId).map(dto.thread),
    };
  }

  // =========================================================================
  // HEARINGS & DEADLINES (§15, §16)
  // =========================================================================
  async listHearings(p: Principal) {
    const rows = await this.repo.listHearings(p.tenantId, p.clientIds);
    return rows.map(dto.hearing);
  }

  async listDeadlines(p: Principal) {
    const rows = await this.repo.listDeadlines(p.tenantId, p.clientIds);
    return rows.map((r) => dto.deadline(r));
  }

  /**
   * The only deadline mutation a client may make: advancing the client_status
   * of a client_action deadline they own. The repository enforces the lane,
   * the tenancy, the client scope and the permitted target states.
   */
  async updateDeadlineStatus(p: Principal, deadlineId: string, status: string, ctx: RequestContextInfo) {
    if (!['in_progress', 'submitted', 'completed'].includes(status)) {
      throw badRequest('validation_failed', 'invalid status');
    }
    const res = await this.d.repo.tx(async () => {
      const r = await this.repo.updateDeadlineClientStatus(deadlineId, p.tenantId, p.clientIds, status);
      if (r.changes === 0) return 0;
      await this.audit.write(
        { action: 'PROFILE_UPDATED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          resourceType: 'deadline', resourceId: deadlineId, metadata: { status } }, ctx);
      return r.changes;
    });
    if (res === 0) throw notFoundOrForbidden('deadline', deadlineId);
    return { updated: true };
  }

  // =========================================================================
  // DOCUMENTS (§17, §18, §19)
  // =========================================================================
  async listDocuments(p: Principal, query: { matterId?: string; category?: string }) {
    // A matterId filter is still scoped: the repository ANDs it with clientIds.
    const rows = await this.repo.listDocuments(p.tenantId, p.clientIds, {
      matterId: query.matterId,
      category: query.category,
    });
    return rows.map(dto.document);
  }

  /**
   * Issues a short-lived, session-bound grant to read one document's bytes.
   * The authorization check runs again here, on every request — a valid URL
   * from a minute ago is worthless if access has since been withdrawn.
   */
  async issueDocumentAccess(
    p: Principal,
    documentId: string,
    disposition: Disposition,
    ctx: RequestContextInfo,
  ) {
    const doc = await this.repo.getReadableDocument(documentId, p.tenantId, p.clientIds);
    if (!doc) {
      await this.d.repo.tx(() =>
        this.audit.write(
          { action: 'DOCUMENT_ACCESS_DENIED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
            outcome: 'denied', reasonCode: 'document_not_readable', resourceType: 'document', resourceId: documentId },
          ctx,
        ),
      );
      await this.repo.logDocumentAccess({
        document_id: documentId, tenant_id: p.tenantId, accessor_kind: 'client',
        accessor_id: p.userId, action: 'access_denied', ip_hash: ctx.ipHash,
        created_at: new Date().toISOString(),
      }).catch(() => undefined);
      throw notFoundOrForbidden('document', documentId);
    }

    const { url, expiresAt } = signAccessUrl({
      documentId, sessionId: p.sessionId, disposition,
      ttlSeconds: config.storage.signedUrlTtlSeconds,
    });

    await this.d.repo.tx(async () => {
      await this.repo.logDocumentAccess({
        document_id: documentId, tenant_id: p.tenantId, accessor_kind: 'client',
        accessor_id: p.userId, action: 'signed_url_issued', ip_hash: ctx.ipHash,
        created_at: new Date().toISOString(),
      });
      await this.audit.write(
        { action: 'SIGNED_URL_ISSUED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          resourceType: 'document', resourceId: documentId,
          metadata: { disposition, ttlSeconds: config.storage.signedUrlTtlSeconds } }, ctx);
    });

    return {
      url,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      ttlSeconds: config.storage.signedUrlTtlSeconds,
      fileName: String(doc.original_filename),
      mimeType: String(doc.mime_type),
      sizeBytes: Number(doc.size_bytes),
    };
  }

  /**
   * Streams the bytes after re-verifying the signature AND re-running the full
   * authorization check. Two independent gates on one download.
   */
  async readDocumentBytes(
    p: Principal,
    documentId: string,
    params: { exp: string; sig: string; disposition: string },
    ctx: RequestContextInfo,
  ) {
    const sig = verifyAccessSignature({
      documentId, sessionId: p.sessionId, exp: params.exp,
      disposition: params.disposition, sig: params.sig,
    });
    if (!sig.ok) {
      await this.audit.tryWrite(
        { action: 'DOCUMENT_ACCESS_DENIED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          outcome: 'denied', reasonCode: sig.reason ?? 'bad_signature', resourceType: 'document', resourceId: documentId }, ctx);
      throw forbidden('token_invalid', 'this link is no longer valid');
    }

    const doc = await this.repo.getReadableDocument(documentId, p.tenantId, p.clientIds);
    if (!doc) throw notFoundOrForbidden('document', documentId);

    // Integrity failure: the row exists but the bytes do not. This must never
    // surface as a 500 with a storage stack trace — it is reported as the same
    // indistinguishable "not available" a client sees for any other miss, and
    // the detail goes to the audit trail where an operator can act on it.
    let body: Buffer;
    try {
      body = await this.d.storage.get(String(doc.storage_key));
    } catch (err) {
      await this.audit.tryWrite(
        { action: 'DOCUMENT_ACCESS_DENIED',
          actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          outcome: 'denied', reasonCode: 'storage_object_missing',
          resourceType: 'document', resourceId: documentId,
          metadata: { storageError: err instanceof Error ? err.message.slice(0, 200) : 'unknown' } },
        ctx,
      );
      throw notFoundOrForbidden('document', documentId);
    }
    const disposition = params.disposition as Disposition;

    await this.d.repo.tx(async () => {
      await this.repo.logDocumentAccess({
        document_id: documentId, tenant_id: p.tenantId, accessor_kind: 'client',
        accessor_id: p.userId, action: disposition === 'inline' ? 'viewed' : 'downloaded',
        ip_hash: ctx.ipHash, created_at: new Date().toISOString(),
      });
      await this.audit.write(
        { action: disposition === 'inline' ? 'DOCUMENT_VIEWED' : 'DOCUMENT_DOWNLOADED',
          actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          resourceType: 'document', resourceId: documentId,
          metadata: { bytes: body.length, version: Number(doc.version) } }, ctx);
    });

    return {
      body,
      mimeType: String(doc.mime_type),
      fileName: String(doc.original_filename),
      disposition,
      sha256: String(doc.sha256),
    };
  }

  /**
   * Upload pipeline (§19). Every step is a gate; failure at any step leaves no
   * reachable document behind.
   *
   *   authorization → matter scope → type/size/MIME/magic-byte validation →
   *   server-generated key → private storage → malware scan → row insert →
   *   audit → notify the assigned team
   */
  async uploadDocument(
    p: Principal,
    input: { matterId?: string | null; documentType: string; title?: string; titleAr?: string; fulfillRequestId?: string },
    file: { buffer: Buffer; originalName: string; declaredMime: string },
    ctx: RequestContextInfo,
  ) {
    // 1 · The matter must be in scope. A client cannot attach a document to a
    //     matter they cannot see.
    if (input.matterId) {
      const matter = await this.repo.getMatter(input.matterId, p.tenantId, p.clientIds);
      if (!matter) throw notFoundOrForbidden('matter', input.matterId);
    }

    // 2 · Type must be one the firm recognises.
    const ALLOWED_TYPES = new Set([
      'contract', 'evidence', 'correspondence', 'identity', 'client_upload', 'other',
    ]);
    if (!ALLOWED_TYPES.has(input.documentType)) {
      throw badRequest('validation_failed', 'invalid document type', { allowed: [...ALLOWED_TYPES] });
    }

    // 3 · Size.
    if (!file.buffer || file.buffer.length === 0) {
      throw badRequest('upload_rejected', 'the file is empty');
    }
    if (file.buffer.length > config.uploads.maxBytes) {
      await this.audit.tryWrite(
        { action: 'DOCUMENT_UPLOAD_REJECTED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          outcome: 'denied', reasonCode: 'too_large', metadata: { bytes: file.buffer.length } }, ctx);
      throw badRequest('upload_too_large', 'the file exceeds the maximum size', {
        maxBytes: config.uploads.maxBytes,
      });
    }

    // 4 · Filename sanitization + extension allowlist. The client never
    //     influences the storage path beyond a slug tail.
    const name = sanitizeFilename(file.originalName);
    if (isDangerousExtension(name.ext)) {
      await this.audit.tryWrite(
        { action: 'DOCUMENT_UPLOAD_REJECTED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          outcome: 'denied', reasonCode: 'dangerous_extension', resourceType: 'filename',
          metadata: { ext: name.ext.slice(0, 12) } }, ctx);
      throw badRequest('upload_type_not_allowed', 'this file type is not accepted');
    }
    if (!config.uploads.allowedExt.has(name.ext.toLowerCase())) {
      throw badRequest('upload_type_not_allowed', 'this file type is not accepted', {
        allowed: [...config.uploads.allowedExt],
      });
    }

    // 5 · Declared MIME must be allowlisted AND agree with the file's own
    //     magic bytes. A spoofed Content-Type is rejected here.
    const declared = (file.declaredMime || '').toLowerCase().split(';')[0].trim();
    if (!config.uploads.allowedMime.has(declared)) {
      throw badRequest('upload_type_not_allowed', 'this file type is not accepted');
    }
    const sniff = sniffMime(file.buffer, declared);
    if (!sniff.ok) {
      await this.audit.tryWrite(
        { action: 'DOCUMENT_UPLOAD_REJECTED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          outcome: 'denied', reasonCode: 'mime_mismatch',
          metadata: { declared: declared.slice(0, 80), detected: (sniff.detected ?? 'none').slice(0, 80) } }, ctx);
      throw badRequest('upload_rejected', 'the file contents do not match its declared type');
    }

    // 6 · Server-generated identity and storage key (§35 R10).
    const documentId = newId();
    const storageKey = buildStorageKey({
      tenantId: p.tenantId,
      clientId: p.primaryClientId,
      matterId: input.matterId ?? null,
      documentId,
      slug: name.slug,
      ext: name.ext,
      version: 1,
    });

    // 7 · Malware scan BEFORE the row exists, so an infected file is never
    //     describable, listable or downloadable.
    const scan = await scanBuffer(file.buffer, declared);
    if (scan.status !== 'clean') {
      await this.audit.tryWrite(
        { action: 'DOCUMENT_UPLOAD_REJECTED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          outcome: 'denied', reasonCode: scan.status === 'infected' ? 'malware_detected' : 'scan_error',
          resourceType: 'document', resourceId: documentId,
          metadata: { engine: scan.engine } }, ctx);
      throw badRequest('upload_rejected', 'the file could not be accepted for security reasons');
    }

    // 8 · Private storage.
    await this.d.storage.put(storageKey, file.buffer, declared);

    // 9 · Row + audit + request fulfilment, in one transaction.
    const nowIso = new Date().toISOString();
    const title = (input.title || name.display).slice(0, 200);
    await this.d.repo.tx(async () => {
      await this.repo.insertDocument({
        id: documentId, tenant_id: p.tenantId, client_id: p.primaryClientId,
        matter_id: input.matterId, storage_bucket: config.supabase.documentsBucket,
        storage_key: storageKey, original_filename: name.display,
        stored_filename: storageKey.split('/').pop() ?? name.display,
        title, title_ar: input.titleAr ? String(input.titleAr).slice(0, 200) : null,
        document_type: input.documentType,
        category: input.fulfillRequestId ? 'requested' : 'uploaded',
        origin: 'client', mime_type: declared, size_bytes: file.buffer.length,
        sha256: sha256(file.buffer), scanned_at: nowIso, requested: false,
        uploaded_by_user_id: p.userId, created_at: nowIso,
      });

      if (input.fulfillRequestId) {
        // Only clears the flag if the request belongs to this client's scope.
        await this.repo.fulfillDocumentRequest(input.fulfillRequestId, p.tenantId, p.clientIds);
      }

      await this.repo.logDocumentAccess({
        document_id: documentId, tenant_id: p.tenantId, accessor_kind: 'client',
        accessor_id: p.userId, action: 'upload_completed', ip_hash: ctx.ipHash,
        created_at: nowIso,
      });

      await this.audit.write(
        { action: 'DOCUMENT_UPLOADED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          resourceType: 'document', resourceId: documentId,
          metadata: { bytes: file.buffer.length, mime: declared, matterId: input.matterId, scanEngine: scan.engine } }, ctx);
    });

    // 10 · The assigned team is notified through the firm's internal channel.
    //      The portal records the event; the Internal Firm OS consumes it.
    return {
      id: documentId,
      title,
      fileName: name.display,
      mimeType: declared,
      sizeBytes: file.buffer.length,
      status: 'available',
      createdAt: nowIso,
    };
  }

  // =========================================================================
  // INVOICES & PAYMENTS (§20, §21)
  // =========================================================================
  async listInvoices(p: Principal) {
    const rows = await this.repo.listInvoices(p.tenantId, p.clientIds);
    return rows.map(dto.invoice);
  }

  async getInvoice(p: Principal, invoiceId: string, ctx: RequestContextInfo) {
    const row = await this.repo.getInvoice(invoiceId, p.tenantId, p.clientIds);
    if (!row) {
      await this.audit.tryWrite(
        { action: 'AUTHZ_DENIED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          outcome: 'denied', reasonCode: 'invoice_not_in_scope', resourceType: 'invoice', resourceId: invoiceId }, ctx);
      throw notFoundOrForbidden('invoice', invoiceId);
    }
    const [lines, payments, receipt] = await Promise.all([
      this.repo.listInvoiceLines(invoiceId, p.tenantId, p.clientIds),
      this.repo.listPaymentsForInvoice(invoiceId, p.tenantId, p.clientIds),
      this.repo.getReceiptForInvoice(invoiceId, p.tenantId, p.clientIds),
    ]);

    await this.audit.tryWrite(
      { action: 'INVOICE_VIEWED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
        resourceType: 'invoice', resourceId: invoiceId }, ctx);

    return {
      ...dto.invoice(row),
      lines: lines.map(dto.invoiceLine),
      payments: payments.map(dto.payment),
      receipt: receipt ? dto.receipt(receipt) : null,
      // The client may read state but never write it (§35 R6).
      payable: ['awaiting_payment', 'partially_paid', 'overdue'].includes(String(row.client_status)),
    };
  }

  /**
   * Creates a payment INTENT. It never marks anything paid.
   *
   *   Client → Payment Intent → Provider → Webhook → Server validation →
   *   Payment record → Invoice state transition → Receipt
   *
   * The browser receives a provider client secret and an amount to display.
   * The authoritative amount is recomputed here from the invoice; a client
   * cannot pay a different figure by editing the request.
   */
  async startPayment(
    p: Principal,
    invoiceId: string,
    input: { provider?: string; idempotencyKey?: string },
    ctx: RequestContextInfo,
  ) {
    const row = await this.repo.getInvoice(invoiceId, p.tenantId, p.clientIds);
    if (!row) throw notFoundOrForbidden('invoice', invoiceId);

    const status = String(row.client_status);
    if (!['awaiting_payment', 'partially_paid', 'overdue'].includes(status)) {
      throw badRequest('mutation_denied', 'this invoice cannot be paid in its current state');
    }

    // Authoritative amount: balance due, recomputed server-side.
    const balance = Math.round((Number(row.total) - Number(row.amount_paid)) * 100) / 100;
    if (balance <= 0) {
      throw badRequest('mutation_denied', 'this invoice has no outstanding balance');
    }

    const provider = (input.provider ?? 'mada').toLowerCase();
    const ALLOWED_PROVIDERS = new Set(['mada', 'apple_pay', 'visa', 'mastercard', 'bank_transfer', 'sadad']);
    if (!ALLOWED_PROVIDERS.has(provider)) {
      throw badRequest('validation_failed', 'unsupported payment method', { allowed: [...ALLOWED_PROVIDERS] });
    }

    const paymentId = newId();
    const idempotencyKey = (input.idempotencyKey || newId()).slice(0, 120);
    const nowIso = new Date().toISOString();

    await this.d.repo.tx(async () => {
      await this.repo.createPaymentIntent({
        id: paymentId, tenant_id: p.tenantId, invoice_id: invoiceId,
        client_id: p.primaryClientId, initiated_by_user_id: p.userId,
        provider, idempotency_key: idempotencyKey, amount: balance, created_at: nowIso,
      });
      await this.audit.write(
        { action: 'PAYMENT_STARTED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          resourceType: 'invoice', resourceId: invoiceId,
          metadata: { paymentId, provider, amountMinor: Math.round(balance * 100) } }, ctx);
    });

    // Provider adapter. The mock returns a deterministic client secret so the
    // journey can be completed in the demo via the webhook simulator.
    const clientSecret = sha256(`${paymentId}:${config.payments.webhookSecret || 'mock'}`).slice(0, 32);

    return {
      paymentId,
      invoiceId,
      amount: balance.toFixed(2),
      currency: 'SAR',
      provider,
      clientSecret,
      // The webhook URL is public by necessity but signature-verified.
      webhookUrl: `/api/webhooks/payments/${config.payments.provider}`,
      expiresInMinutes: 30,
      demoMode: config.payments.provider === 'mock',
    };
  }

  async listReceipts(p: Principal) {
    const invoices = await this.repo.listInvoices(p.tenantId, p.clientIds);
    const out: dto.ReceiptDto[] = [];
    for (const inv of invoices) {
      const r = await this.repo.getReceiptForInvoice(String(inv.id), p.tenantId, p.clientIds);
      if (r) out.push(dto.receipt(r));
    }
    return out;
  }

  // =========================================================================
  // MESSAGES (§22)
  // =========================================================================
  async listThreads(p: Principal) {
    const threads = await this.repo.listThreads(p.tenantId, p.clientIds);
    // Unread counts come from the read ledger, not from a mutable column on the
    // message: messages are immutable, so the ledger is the only honest source.
    const result: (dto.ThreadDto & { unreadCount: number })[] = [];
    for (const t of threads) {
      const msgs = await this.repo.listMessages(String(t.id), p.tenantId, p.clientIds, p.userId);
      const unread = msgs.filter((m) => m.sender_kind === 'staff' && !toBool(m.read_by_me)).length;
      result.push({ ...dto.thread(t), unreadCount: unread });
    }
    return result;
  }

  async getThread(p: Principal, threadId: string, ctx: RequestContextInfo) {
    const t = await this.repo.getThread(threadId, p.tenantId, p.clientIds);
    if (!t) throw notFoundOrForbidden('conversation', threadId);
    const msgs = await this.repo.listMessages(threadId, p.tenantId, p.clientIds, p.userId);
    await this.repo.markThreadRead(threadId, p.tenantId, p.clientIds, p.userId);
    await this.audit.tryWrite(
      { action: 'MESSAGE_READ', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
        resourceType: 'thread', resourceId: threadId }, ctx);
    return { thread: dto.thread(t), messages: msgs.map(dto.message) };
  }

  async sendMessage(
    p: Principal,
    threadId: string,
    body: string,
    ctx: RequestContextInfo,
  ) {
    const text = String(body ?? '').trim();
    if (!text) throw badRequest('validation_failed', 'message body is required');
    if (text.length > 4000) throw badRequest('validation_failed', 'message is too long');

    // The thread must belong to this client. sender_user_id is the principal,
    // never a value from the request.
    const t = await this.repo.getThread(threadId, p.tenantId, p.clientIds);
    if (!t) throw notFoundOrForbidden('conversation', threadId);

    const id = newId();
    const nowIso = new Date().toISOString();
    await this.d.repo.tx(async () => {
      await this.repo.insertMessage({
        id, thread_id: threadId, tenant_id: p.tenantId, sender_user_id: p.userId,
        sender_display_name: p.clientUser.displayName, body: text, created_at: nowIso,
      });
      await this.audit.write(
        { action: 'MESSAGE_SENT', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          resourceType: 'thread', resourceId: threadId,
          metadata: { messageId: id, chars: text.length } }, ctx);
    });

    return { id, body: text, createdAt: nowIso, from: 'client' as const, authorName: p.clientUser.displayName, read: true };
  }

  // =========================================================================
  // APPOINTMENTS (§23)
  // =========================================================================
  async listAppointments(p: Principal) {
    const [rows, types] = await Promise.all([
      this.repo.listAppointments(p.tenantId, p.clientIds),
      this.repo.listAppointmentTypes(p.tenantId),
    ]);
    return { appointments: rows.map(dto.appointment), types: types.map(dto.appointmentType) };
  }

  async requestAppointment(
    p: Principal,
    input: {
      matterId?: string | null; typeId?: string; preferredDate: string;
      preferredTime: string; preferredMode?: string; note?: string;
    },
    ctx: RequestContextInfo,
  ) {
    if (input.matterId) {
      const m = await this.repo.getMatter(input.matterId, p.tenantId, p.clientIds);
      if (!m) throw notFoundOrForbidden('matter', input.matterId);
    }
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!dateRe.test(input.preferredDate)) throw badRequest('validation_failed', 'invalid date');
    if (!timeRe.test(input.preferredTime)) throw badRequest('validation_failed', 'invalid time');

    const when = new Date(`${input.preferredDate}T${input.preferredTime}:00Z`).getTime();
    if (!Number.isFinite(when) || when < Date.now() - 3_600_000) {
      throw badRequest('validation_failed', 'the requested time is in the past');
    }
    if (when > Date.now() + 365 * 86_400_000) {
      throw badRequest('validation_failed', 'the requested time is too far in the future');
    }

    const modes = new Set(['in_person', 'video', 'phone']);
    const mode = modes.has(input.preferredMode ?? '') ? String(input.preferredMode) : 'in_person';

    const types = await this.repo.listAppointmentTypes(p.tenantId);
    const type = types.find((t) => String(t.id) === input.typeId) ?? types[0];
    if (!type) throw badRequest('validation_failed', 'no appointment types are available');

    const id = newId();
    const nowIso = new Date().toISOString();
    await this.d.repo.tx(async () => {
      await this.repo.createAppointment({
        id, tenant_id: p.tenantId, client_id: p.primaryClientId,
        matter_id: input.matterId ?? null, requested_by_user_id: p.userId,
        type_id: String(type.id), type_label: String(type.label),
        type_label_ar: String(type.label_ar),
        preferred_date: input.preferredDate, preferred_time: input.preferredTime,
        preferred_mode: mode, client_note: input.note ? String(input.note).slice(0, 1000) : null,
        created_at: nowIso,
      });
      await this.audit.write(
        { action: 'APPOINTMENT_REQUESTED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          resourceType: 'appointment', resourceId: id,
          metadata: { mode, matterId: input.matterId ?? null } }, ctx);
      await this.repo.createNotification({
        id: newId(), tenant_id: p.tenantId, user_id: p.userId, client_id: p.primaryClientId,
        category: 'appointment', severity: 'info',
        title: 'Appointment requested', title_ar: 'تم طلب موعد',
        body: 'Your request has been sent to the firm for confirmation.',
        body_ar: 'تم إرسال طلبك إلى الشركة للموافقة عليه.',
        link: '/portal/appointments', matter_id: input.matterId ?? null, created_at: nowIso,
      });
    });

    return { id, status: 'requested', createdAt: nowIso };
  }

  async cancelAppointment(p: Principal, appointmentId: string, reason: string, ctx: RequestContextInfo) {
    const res = await this.d.repo.tx(async () => {
      const r = await this.repo.cancelAppointment(appointmentId, p.tenantId, p.clientIds, String(reason || '').slice(0, 500));
      if (r.changes === 0) return 0;
      await this.audit.write(
        { action: 'APPOINTMENT_CANCELLED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          resourceType: 'appointment', resourceId: appointmentId }, ctx);
      return r.changes;
    });
    if (res === 0) {
      // Either it does not exist, it is not theirs, or it is already confirmed
      // and needs the firm to reschedule it. All three are the same 404.
      throw notFoundOrForbidden('appointment', appointmentId);
    }
    return { cancelled: true };
  }

  // =========================================================================
  // NOTIFICATIONS (§24)
  // =========================================================================
  async listNotifications(p: Principal) {
    const [rows, unread] = await Promise.all([
      this.repo.listNotifications(p.userId, p.tenantId),
      this.repo.countUnreadNotifications(p.userId, p.tenantId),
    ]);
    return { notifications: rows.map(dto.notification), unreadCount: unread };
  }

  async markNotificationRead(p: Principal, id: string, ctx: RequestContextInfo) {
    const res = await this.repo.markNotificationRead(id, p.userId, p.tenantId);
    if (res.changes) {
      await this.audit.tryWrite(
        { action: 'NOTIFICATION_READ', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId },
          resourceType: 'notification', resourceId: id }, ctx);
    }
    const unread = await this.repo.countUnreadNotifications(p.userId, p.tenantId);
    return { unreadCount: unread };
  }

  async markAllNotificationsRead(p: Principal) {
    const res = await this.repo.markAllNotificationsRead(p.userId, p.tenantId);
    return { markedRead: res.changes, unreadCount: 0 };
  }

  async listNotificationPreferences(p: Principal) {
    const rows = await this.repo.listNotificationPreferences(p.userId);
    return rows.map(dto.notificationPreference);
  }

  async updateNotificationPreference(
    p: Principal, category: string, inApp: boolean, email: boolean, ctx: RequestContextInfo,
  ) {
    const res = await this.repo.updateNotificationPreference(p.userId, category, inApp, email);
    if (res.changes === 0) {
      // Either unknown category or a locked one (security notifications).
      throw badRequest('mutation_denied', 'this preference cannot be changed');
    }
    await this.audit.tryWrite(
      { action: 'PREFERENCES_UPDATED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'notification_preference', resourceId: category,
        metadata: { inApp, email } }, ctx);
    return { updated: true };
  }

  // =========================================================================
  // PROFILE & PREFERENCES (§25, §28)
  // =========================================================================
  async getProfile(p: Principal) {
    const [user, client, tenant] = await Promise.all([
      this.repo.getUserById(p.userId),
      this.repo.getClient(p.primaryClientId, p.tenantId),
      this.repo.getTenant(p.tenantId),
    ]);
    if (!user || !client) throw notFoundOrForbidden('profile');
    const links = await this.repo.getClientUsersForUser(p.userId);
    const cu = links.find((l) => String(l.client_id) === p.primaryClientId) ?? links[0];
    return dto.profile({ user, clientUser: cu, client, tenant });
  }

  /**
   * Only these fields are writable by a client. Everything else — name,
   * client_type, national_id, identity_verified, tenant_id, portal_role —
   * belongs to the firm (§25, §35 R11).
   */
  async updateProfile(
    p: Principal,
    patch: Record<string, unknown>,
    ctx: RequestContextInfo,
  ) {
    const allowed = new Set(['displayName', 'displayNameAr', 'jobTitle', 'phone', 'addressLine', 'city', 'country']);
    for (const k of Object.keys(patch)) {
      if (!allowed.has(k)) {
        const snake = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).toLowerCase();
        assertNoForbiddenFields({ [snake]: patch[k] }, new Set<string>(), ctx, this.d, p, 'profile');
        throw badRequest('validation_failed', 'unknown field', { field: k });
      }
    }

    const countries = new Set(['SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'EG', 'JO', 'GB', 'US', 'OTHER']);
    if (patch.country !== undefined && !countries.has(String(patch.country))) {
      throw badRequest('validation_failed', 'invalid country code');
    }
    if (patch.phone !== undefined) {
      const phone = String(patch.phone).trim();
      if (phone && !/^\+?[0-9 ()-]{6,20}$/.test(phone)) {
        throw badRequest('validation_failed', 'invalid phone number');
      }
    }
    if (patch.displayName !== undefined) {
      const n = String(patch.displayName).trim();
      if (n.length < 2 || n.length > 120) throw badRequest('validation_failed', 'invalid name');
    }

    const changed: string[] = [];
    const cuPatch: Record<string, Param> = {};
    const clientPatch: Record<string, Param> = {};

    if (patch.displayName !== undefined) { cuPatch.display_name = String(patch.displayName).trim(); changed.push('displayName'); }
    if (patch.displayNameAr !== undefined) { cuPatch.display_name_ar = String(patch.displayNameAr).trim().slice(0, 120); changed.push('displayNameAr'); }
    if (patch.jobTitle !== undefined) { cuPatch.job_title = String(patch.jobTitle).trim().slice(0, 120); changed.push('jobTitle'); }
    if (patch.phone !== undefined) {
      cuPatch.phone = String(patch.phone).trim().slice(0, 24);
      clientPatch.phone = cuPatch.phone;
      changed.push('phone');
    }
    if (patch.addressLine !== undefined) { clientPatch.address_line = String(patch.addressLine).trim().slice(0, 200); changed.push('addressLine'); }
    if (patch.city !== undefined) { clientPatch.city = String(patch.city).trim().slice(0, 80); changed.push('city'); }
    if (patch.country !== undefined) { clientPatch.country = String(patch.country); changed.push('country'); }

    if (!changed.length) throw badRequest('validation_failed', 'no changes supplied');

    await this.d.repo.tx(async () => {
      if (Object.keys(cuPatch).length) {
        await this.repo.updateClientUserDisplay(p.clientUser.id, p.userId, cuPatch);
      }
      if (Object.keys(clientPatch).length) {
        await this.repo.updateClientProfile(p.primaryClientId, p.tenantId, clientPatch);
      }
      await this.audit.write(
        { action: 'PROFILE_UPDATED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          resourceType: 'profile', resourceId: p.userId, metadata: { fields: changed } }, ctx);
    });

    return { updated: changed };
  }

  async updatePreferences(
    p: Principal,
    patch: { language?: 'ar' | 'en'; calendar?: 'islamic-umalqura' | 'gregory' },
    ctx: RequestContextInfo,
  ) {
    const update: Record<string, Param> = {};
    if (patch.language === 'ar' || patch.language === 'en') update.preferred_language = patch.language;
    if (patch.calendar === 'islamic-umalqura' || patch.calendar === 'gregory') {
      update.preferred_calendar = patch.calendar;
    }
    if (!Object.keys(update).length) throw badRequest('validation_failed', 'no valid preference supplied');

    await this.d.repo.tx(async () => {
      await this.repo.updateUser(p.userId, update);
      await this.audit.write(
        { action: 'PREFERENCES_UPDATED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId },
          resourceType: 'preferences', metadata: update }, ctx);
    });
    return { ...update };
  }

  // =========================================================================
  // SECURITY CENTRE (§26)
  // =========================================================================
  async securityOverview(p: Principal, req: { header: (n: string) => string | undefined }) {
    const [user, sessions, devices, alerts] = await Promise.all([
      this.repo.getUserById(p.userId),
      this.d.sessions.list(p.userId, p.sessionId),
      this.d.sessions.listDevices(p.userId),
      this.repo.listSecurityAlerts(p.userId, 20),
    ]);
    if (!user) throw notFoundOrForbidden('profile');

    const ua = String(req.header('user-agent') ?? '');
    return {
      password: {
        lastChangedAt: toIso(user.password_updated_at),
        // Age in days drives the "consider updating" nudge; no hard expiry is
        // imposed because NIST guidance favours rotation on compromise only.
        ageDays: user.password_updated_at
          ? Math.floor((Date.now() - new Date(String(user.password_updated_at)).getTime()) / 86_400_000)
          : null,
        minLength: config.auth.passwordMinLength,
      },
      mfa: {
        enabled: toBool(user.mfa_enabled),
        method: user.mfa_method ? String(user.mfa_method) : null,
        enabledAt: toIso(user.mfa_enabled_at),
        availableMethods: ['totp', 'email_otp'],
        plannedMethods: ['sms_otp', 'webauthn'],
      },
      sessions: sessions.map((s) => dto.session({ ...s, mfaVerifiedAt: s.mfaVerifiedAt })),
      devices: devices.map((d) => dto.device(d)),
      alerts: alerts.map(dto.securityAlert),
      lastLoginAt: toIso(user.last_login_at),
      emailVerified: Boolean(user.email_verified_at),
      currentDeviceLabel: ua ? `${ua.includes('iPhone') ? 'iPhone' : 'Device'}` : 'Device',
    };
  }

  async revokeSession(p: Principal, sessionId: string, ctx: RequestContextInfo) {
    const okSession = await this.d.sessions.destroyBySessionId(p.userId, sessionId);
    if (!okSession) throw notFoundOrForbidden('session');
    await this.audit.write(
      { action: 'SESSION_REVOKED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'session', resourceId: sessionId, metadata: { self: sessionId === p.sessionId } }, ctx);
    return { revoked: true };
  }

  async revokeAllOtherSessions(p: Principal, ctx: RequestContextInfo) {
    const n = await this.d.sessions.destroyAllOthers(p.userId, p.sessionId);
    await this.audit.write(
      { action: 'LOGOUT_ALL_OTHERS', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'user', resourceId: p.userId, metadata: { revoked: n } }, ctx);
    return { revoked: n };
  }

  async revokeDevice(p: Principal, deviceId: string, ctx: RequestContextInfo) {
    const ok = await this.d.sessions.revokeDevice(p.userId, deviceId);
    if (!ok) throw notFoundOrForbidden('device');
    await this.audit.write(
      { action: 'DEVICE_UNTRUSTED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'device', resourceId: deviceId }, ctx);
    return { revoked: true };
  }

  // =========================================================================
  // PRIVACY CENTRE (§27)
  // =========================================================================
  async privacyOverview(p: Principal) {
    const [requests, consents] = await Promise.all([
      this.repo.listPrivacyRequests(p.userId, p.tenantId),
      this.repo.listConsents(p.userId),
    ]);
    return {
      requests: requests.map(dto.privacyRequest),
      consents: consents.map(dto.consent),
      // Retention is a fact the client is entitled to know.
      retention: {
        policyVersion: '2026-01',
        // Matter files are retained under professional-obligation rules; an
        // erasure request therefore goes to compliance review, not to a delete.
        matterFileRetention: 'Retained for the period required by professional obligation and applicable law.',
        matterFileRetentionAr: 'يتم الاحتفاظ بملفات القضايا للمدة التي تتطلبها الالتزامات المهنية والأنظمة المعمول بها.',
        deletionIsRequestOnly: true,
      },
    };
  }

  async submitPrivacyRequest(
    p: Principal,
    input: { requestType: string; details?: string },
    ctx: RequestContextInfo,
  ) {
    const types = new Set(['access', 'rectification', 'erasure', 'portability', 'restriction', 'objection']);
    if (!types.has(input.requestType)) {
      throw badRequest('validation_failed', 'invalid request type', { allowed: [...types] });
    }
    // One open request of each type is enough.
    const existing = await this.repo.listPrivacyRequests(p.userId, p.tenantId);
    if (existing.some((r) => String(r.request_type) === input.requestType && ['submitted', 'under_review', 'retention_assessment'].includes(String(r.status)))) {
      throw new PortalError(409, 'conflict', 'a request of this type is already in progress');
    }

    const id = newId();
    const nowIso = new Date().toISOString();
    await this.d.repo.tx(async () => {
      await this.repo.createPrivacyRequest({
        id, tenant_id: p.tenantId, user_id: p.userId, client_id: p.primaryClientId,
        request_type: input.requestType, details: input.details ? String(input.details).slice(0, 2000) : null,
        due_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), created_at: nowIso,
      });
      await this.repo.recordConsent({
        id: newId(), tenant_id: p.tenantId, user_id: p.userId, purpose: 'portal_access',
        consented: true, policy_version: '2026-01', ip_hash: ctx.ipHash, recorded_at: nowIso,
      });
      await this.audit.write(
        { action: 'PRIVACY_REQUEST_SUBMITTED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId, clientId: p.primaryClientId },
          resourceType: 'privacy_request', resourceId: id,
          metadata: { requestType: input.requestType } }, ctx);
      await this.repo.createNotification({
        id: newId(), tenant_id: p.tenantId, user_id: p.userId, client_id: p.primaryClientId,
        category: 'system', severity: 'info',
        title: 'Privacy request received', title_ar: 'تم استلام طلب الخصوصية',
        body: 'Your request has been sent for compliance review.',
        body_ar: 'تم إرسال طلبك إلى مراجعة الامتثال.',
        link: '/portal/privacy', created_at: nowIso,
      });
    });

    return { id, status: 'submitted', createdAt: nowIso, reviewByDays: 30 };
  }

  async withdrawPrivacyRequest(p: Principal, id: string, ctx: RequestContextInfo) {
    const res = await this.repo.withdrawPrivacyRequest(id, p.userId, p.tenantId);
    if (res.changes === 0) throw notFoundOrForbidden('request');
    await this.audit.write(
      { action: 'PRIVACY_REQUEST_SUBMITTED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'privacy_request', resourceId: id, outcome: 'success',
        reasonCode: 'withdrawn' }, ctx);
    return { withdrawn: true };
  }

  async recordConsent(p: Principal, purpose: string, consented: boolean, ctx: RequestContextInfo) {
    const purposes = new Set(['portal_access', 'marketing', 'analytics', 'document_delivery', 'sms_notifications']);
    if (!purposes.has(purpose)) throw badRequest('validation_failed', 'invalid purpose');
    await this.d.repo.tx(async () => {
      await this.repo.recordConsent({
        id: newId(), tenant_id: p.tenantId, user_id: p.userId, purpose,
        consented, policy_version: '2026-01', ip_hash: ctx.ipHash,
        recorded_at: new Date().toISOString(),
      });
      await this.audit.write(
        { action: 'CONSENT_RECORDED', actor: { kind: 'client_user', userId: p.userId, tenantId: p.tenantId },
          resourceType: 'consent', resourceId: purpose, metadata: { consented } }, ctx);
    });
    return { recorded: true };
  }
}
