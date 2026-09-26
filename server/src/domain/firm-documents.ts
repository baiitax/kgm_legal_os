/**
 * THE FIRM'S OWN DOCUMENTS — P2.1, AND THE VERSION CHAIN IT IMPLIED — P2.6
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THE PIPELINE IS HERE AND NOT IN THE ROUTE
 *
 *   The portal has uploaded documents since §19, through a pipeline whose every step
 *   is a gate: authorisation → scope → type → size → extension → declared MIME →
 *   magic bytes → malware scan → private storage → row + audit in one transaction.
 *   The firm's side needs the SAME pipeline with three deliberate differences, and
 *   the cheapest way to keep the two in step is to write the second one against the
 *   same primitives (buildStorageKey, scanBuffer, sniffMime, sanitizeFilename) and
 *   say plainly where it differs:
 *
 *     1 · ORIGIN IS 'firm', NOT 'client'. The direction a document travelled is the
 *         first thing a reviewer asks, and `assert_document_readable` already refuses
 *         a client-originated document marked internal — the guard exists because the
 *         two are not interchangeable.
 *
 *     2 · A FIRM DOCUMENT BELONGS TO A MATTER. The portal allows a document with no
 *         matter (a client uploads their CR before any file exists). The firm does
 *         not: 0061's INSERT policy requires `matter_id is not null`, because the
 *         alternative would scope a firm upload through its CLIENT, and 0060 has just
 *         widened the client read path to include clients the firm has no file with.
 *
 *     3 · PRIVILEGE IS DECLARED AT FILING AND IS NOT DECORATION. A document filed as
 *         `advice` is invisible to every member outside the ring from the moment it
 *         exists, cannot be released to the client by the CHECK
 *         `documents_privileged_is_internal`, and can only leave the file through the
 *         P0.5 release ledger. That is asserted by the database, not by this file.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 *   · NO DELETE. Archiving is a state; destruction is a retention decision (P1.5) and
 *     carries a schedule and an authority. A firm that can delete a document with one
 *     call has no record of what it destroyed.
 *   · NO EDIT OF THE BYTES' OWN DESCRIPTION. `sha256`, `size_bytes`, `mime_type`,
 *     `origin`, `version` and `storage_key` are written once. A row whose hash can be
 *     changed is a row whose integrity means nothing, and 0061 does not grant them.
 *   · NO SILENT OVERWRITE. A new version of a document is a NEW ROW pointing at the
 *     one it replaces, so the March version stays readable in April. The chain is
 *     linear: a row may be superseded at most once, and a second successor is a 409
 *     rather than a fork.
 */
import { config } from '../config.js';
import { newId, sha256 } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFoundOrForbidden } from '../lib/errors.js';
import { isDangerousExtension, sanitizeFilename, sniffMime } from '../lib/http.js';
import { buildStorageKey, scanBuffer } from '../storage/service.js';
import type { StorageDriver } from '../storage/service.js';
import type { FirmRepo } from '../db/firm-repo.js';
import type { AuditLogger, RequestContextInfo } from '../audit/logger.js';

/**
 * The document types a FIRM may file.
 *
 * The portal's allowlist (`contract`, `evidence`, `correspondence`, `identity`,
 * `client_upload`, `other`) is the vocabulary for what a client sends. The firm
 * produces a different set — a letter, a court filing, a signed original, an invoice —
 * and `documents.document_type` is a table-wide CHECK that carries both. `client_upload`
 * is absent here on purpose: a firm cannot file a document that claims the client
 * uploaded it, which is the same confusion `assert_document_readable` refuses in the
 * other direction.
 */
export const FIRM_DOCUMENT_TYPES = [
  'firm_letter', 'court_document', 'signed_document', 'contract',
  'evidence', 'correspondence', 'identity', 'other',
] as const;

/**
 * THE PROVENANCE CATEGORIES THE TABLE ADMITS.
 *
 * `documents_category_check` on Postgres allows exactly these six, and — until 0064 — the
 * column's DEFAULT was `'other'`, a value the same CHECK refuses. So a caller who omitted
 * the category got a 500 from a constraint that named a column, not the six words that
 * would have worked, and the column looked as though the database would fill it in.
 *
 * The list lives here so the API answers first, with a 400 that names the alternatives.
 * 'from_firm' is the default for a FIRM filing because that is what the firm's filing is:
 * its provenance. The portal's two — 'uploaded' and 'requested' — are the portal's to write.
 */
export const DOCUMENT_CATEGORIES = [
  'from_firm', 'requested', 'uploaded', 'signed', 'court', 'financial',
] as const;

/** The privilege classes 0054 defines. `none` is the ordinary, non-privileged document. */
export const PRIVILEGE_CLASSES = ['none', 'advice', 'work_product', 'litigation'] as const;

/** The visibility values the firm may set. `internal` is what a privileged row must be. */
export const CLIENT_VISIBILITY = ['visible', 'restricted', 'internal'] as const;

export interface FirmDocumentDeps {
  repo: FirmRepo;
  storage: StorageDriver;
  audit: AuditLogger;
}

export interface FirmPrincipalFacts {
  tenantId: string;
  userId: string;
  membershipId: string;
  staffId: string | null;
}

export interface UploadFile {
  buffer: Buffer;
  originalName: string;
  declaredMime: string;
}

export interface FileDocumentInput {
  matterId: string;
  clientId: string;
  documentType: string;
  title?: string | null;
  titleAr?: string | null;
  category?: string;
  privilegeClass?: string;
  /** The document this one replaces, when filing a new version of an existing one. */
  supersedesDocumentId?: string | null;
}

export class FirmDocumentService {
  constructor(private readonly d: FirmDocumentDeps) {}

  /**
   * FILE A DOCUMENT ON A MATTER.
   *
   * Order is the portal's, and it matters at every step: nothing is written to
   * storage until the bytes have passed every check, and nothing is written to the
   * database until the object is in place. A failure at any step leaves no reachable
   * document behind — the worst case is an orphaned object, which is invisible rather
   * than a document that exists and cannot be read.
   */
  async file(
    p: FirmPrincipalFacts,
    input: FileDocumentInput,
    file: UploadFile,
    ctx: RequestContextInfo,
  ) {
    const documentType = String(input.documentType ?? '');
    if (!(FIRM_DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
      throw badRequest('validation_failed', 'this is not a document type a firm may file', {
        allowed: [...FIRM_DOCUMENT_TYPES],
      });
    }

    /*
      THE CATEGORY IS CHECKED HERE, BEFORE THE INSERT.
      It is a closed vocabulary on the table, and the difference between validating it here
      and letting the constraint refuse it is the difference between a 400 that names the
      six words and a 500 that names `documents_category_check`.
    */
    const category = input.category?.trim() || 'from_firm';
    if (!(DOCUMENT_CATEGORIES as readonly string[]).includes(category)) {
      throw badRequest('validation_failed', 'this is not a document category', {
        allowed: [...DOCUMENT_CATEGORIES],
      });
    }

    const privilegeClass = String(input.privilegeClass ?? 'none');
    if (!(PRIVILEGE_CLASSES as readonly string[]).includes(privilegeClass)) {
      throw badRequest('validation_failed', 'unknown privilege class', {
        allowed: [...PRIVILEGE_CLASSES],
      });
    }

    const appraised = await this.appraise(file, p);
    if (appraised.refused) throw appraised.refused;

    /*
      THE VERSION LINK IS VERIFIED, NOT TRUSTED. A supersedes id from another matter
      would build a chain across two files, and 0056 already taught this project what
      an unverified reference in a privileged ledger costs. The row must be on the
      matter the new document is being filed on, and it must not already have a
      successor — a chain is linear or it is not a chain.
    */
    let version = 1;
    let supersedes: string | null = null;
    if (input.supersedesDocumentId) {
      const prior = await this.d.repo.getMatterDocument(p.tenantId, input.matterId, input.supersedesDocumentId);
      if (!prior) throw notFoundOrForbidden('document', input.supersedesDocumentId);
      if (prior.supersededBy) {
        throw conflict('document_already_superseded',
          'a newer version of this document already exists', { supersededBy: prior.supersededBy });
      }
      version = Number(prior.version) + 1;
      supersedes = prior.id;
    }

    const documentId = newId();
    const storageKey = buildStorageKey({
      tenantId: p.tenantId,
      clientId: input.clientId,
      matterId: input.matterId,
      documentId,
      slug: appraised.name.slug,
      ext: appraised.name.ext,
      version,
    });

    const scan = await scanBuffer(file.buffer, appraised.declared);
    if (scan.status !== 'clean') {
      await this.d.audit.tryWrite(
        {
          action: 'DOCUMENT_UPLOAD_REJECTED',
          actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
          outcome: 'denied',
          reasonCode: scan.status === 'infected' ? 'malware_detected' : 'scan_error',
          resourceType: 'document', resourceId: documentId,
          metadata: { engine: scan.engine, matterId: input.matterId },
        },
        ctx,
      );
      throw badRequest('upload_rejected', 'the file could not be accepted for security reasons');
    }

    await this.d.storage.put(storageKey, file.buffer, appraised.declared);

    const nowIso = new Date().toISOString();
    const title = (input.title?.trim() || appraised.name.display).slice(0, 200);
    /*
      A PRIVILEGED DOCUMENT IS INTERNAL FROM BIRTH — 0054's CHECK says
      `privilege_class = 'none' or client_visibility = 'internal'`, so the value is not
      a preference to be defaulted: it is the only value the row can hold. The
      database would refuse anything else, and the refusal is the point.
    */
    /* Typed `string`, not the literal: the ROUTE reports the released value back on the
       same object after a successful release, and a literal type here would make that
       assignment a compile error rather than the honest thing it is. */
    const clientVisibility: string = 'internal';

    await this.d.repo.insertFirmDocument({
      id: documentId,
      tenantId: p.tenantId,
      clientId: input.clientId,
      matterId: input.matterId,
      storageBucket: config.supabase.documentsBucket,
      storageKey,
      originalFilename: appraised.name.display,
      storedFilename: storageKey.split('/').pop() ?? appraised.name.display,
      title,
      titleAr: input.titleAr?.trim() ? input.titleAr.trim().slice(0, 200) : null,
      documentType,
      category,
      version,
      mimeType: appraised.declared,
      sizeBytes: file.buffer.length,
      sha256: sha256(file.buffer),
      scanResult: scan.detail,
      scannedAt: nowIso,
      clientVisibility,
      privilegeClass,
      uploadedByStaffId: p.staffId,
      supersedesDocumentId: supersedes,
      createdAt: nowIso,
    });

    await this.d.audit.write(
      {
        action: supersedes ? 'DOCUMENT_VERSION_ADDED' : 'DOCUMENT_FILED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'document', resourceId: documentId,
        metadata: {
          matterId: input.matterId, bytes: file.buffer.length, mime: appraised.declared,
          documentType, privilegeClass, clientVisibility, version,
          supersedesDocumentId: supersedes, scanEngine: scan.engine,
        },
      },
      ctx,
    );

    return {
      id: documentId,
      matterId: input.matterId,
      title,
      fileName: appraised.name.display,
      mimeType: appraised.declared,
      sizeBytes: file.buffer.length,
      version,
      documentType,
      privilegeClass,
      clientVisibility,
      supersedesDocumentId: supersedes,
      createdAt: nowIso,
      /* The panel needs to know why the client cannot see it, and the reason differs:
         a privileged document is internal BY LAW, an ordinary one is internal until a
         partner releases it, and the two are not the same sentence. */
      releaseReason: privilegeClass === 'none' ? 'not_released_yet' : 'privileged',
    };
  }

  /**
   * SHARE IT WITH THE CLIENT, OR TAKE IT BACK.
   *
   * The two directions are one route because they are one decision, but they are NOT
   * symmetric and the asymmetry is enforced below: a privileged document can never be
   * released through this door. It leaves the file through the P0.5 ledger, which
   * names a ground — that is القاعدة الحادية والعشرون, and a `PATCH` that quietly set
   * `client_visibility = 'visible'` on the firm's advice would be a disclosure with no
   * ground recorded at all.
   */
  async setClientVisibility(
    p: FirmPrincipalFacts,
    input: { matterId: string; documentId: string; clientVisibility: string; note?: string | null },
    ctx: RequestContextInfo,
  ) {
    const wanted = String(input.clientVisibility ?? '');
    if (!['visible', 'restricted', 'internal'].includes(wanted)) {
      throw badRequest('validation_failed', 'unknown visibility', {
        allowed: ['visible', 'restricted', 'internal'],
      });
    }

    const doc = await this.d.repo.getMatterDocument(p.tenantId, input.matterId, input.documentId);
    if (!doc) throw notFoundOrForbidden('document', input.documentId);

    if (doc.privilegeClass !== 'none' && wanted === 'visible') {
      await this.d.audit.tryWrite(
        {
          action: 'DOCUMENT_ACCESS_DENIED',
          actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
          outcome: 'denied', reasonCode: 'privileged_needs_a_ground',
          resourceType: 'document', resourceId: doc.id,
          metadata: { privilegeClass: doc.privilegeClass, matterId: input.matterId },
        },
        ctx,
      );
      throw forbidden('privileged_needs_a_ground',
        'privileged material leaves the file through the release ledger, which names a ground',
        'privileged_visibility', { alreadyAudited: true });
    }

    /*
      AN ARCHIVED DOCUMENT IS CLOSED. Filing a new version still works (a version is a new
      row, and a document the firm has since replaced can legitimately be archived before
      the replacement lands) but nothing about the archived row itself moves again.
      409 rather than 400: nothing about the REQUEST is wrong — the document is simply in a
      state that refuses this, which is what Conflict means.
    */
    if (doc.status === 'archived') {
      throw conflict('document_archived', 'an archived document cannot be released or restricted');
    }

    const changed = await this.d.repo.updateFirmDocument({
      tenantId: p.tenantId, matterId: input.matterId, documentId: doc.id,
      clientVisibility: wanted, updatedAt: new Date().toISOString(),
    });
    if (!changed) throw notFoundOrForbidden('document', input.documentId);

    await this.d.audit.write(
      {
        action: wanted === 'visible' ? 'DOCUMENT_RELEASED' : 'DOCUMENT_RESTRICTED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'document', resourceId: doc.id,
        metadata: {
          matterId: input.matterId, from: doc.clientVisibility, to: wanted,
          privilegeClass: doc.privilegeClass, version: doc.version,
          note: input.note?.slice(0, 200) ?? null,
        },
      },
      ctx,
    );

    return { id: doc.id, clientVisibility: wanted, changed: true };
  }

  /**
   * RE-FILE: correct the title or the classification, never the bytes.
   *
   * A document's name is metadata the firm may be wrong about. Its contents are not —
   * a corrected document is a new VERSION, and this method refuses to pretend
   * otherwise by accepting a title and nothing else.
   */
  async refile(
    p: FirmPrincipalFacts,
    input: {
      matterId: string; documentId: string;
      title?: string | null; titleAr?: string | null;
      documentType?: string | null; category?: string | null;
    },
    ctx: RequestContextInfo,
  ) {
    const doc = await this.d.repo.getMatterDocument(p.tenantId, input.matterId, input.documentId);
    if (!doc) throw notFoundOrForbidden('document', input.documentId);

    /*
      ARCHIVING HAS TO MEAN SOMETHING, AND IT DID NOT.
      
      This check was missing, and the live harness is what found it: the partner archived a
      filing, then re-filed it, and the re-file SUCCEEDED. `setClientVisibility` refused an
      archived document from the day it was written; `refile` silently did not. The
      asymmetry is the classic shape of this bug — the rule was written down in one method
      and assumed in the other.
      
      What it would have cost: `status = 'archived'` is a promise that the row is settled.
      Archive is the firm's ONLY removal (0061 grants no DELETE anywhere), so a document
      that can still be edited after archiving has no settled state at all, and the audit
      trail's last word on it is wrong.
    */
    if (doc.status === 'archived') {
      throw conflict('document_archived', 'an archived document cannot be re-filed');
    }

    if (input.documentType && !(FIRM_DOCUMENT_TYPES as readonly string[]).includes(input.documentType)) {
      throw badRequest('validation_failed', 'this is not a document type a firm may file');
    }
    if (input.category && !(DOCUMENT_CATEGORIES as readonly string[]).includes(input.category)) {
      throw badRequest('validation_failed', 'this is not a document category', {
        allowed: [...DOCUMENT_CATEGORIES],
      });
    }

    const changed = await this.d.repo.updateFirmDocument({
      tenantId: p.tenantId, matterId: input.matterId, documentId: doc.id,
      title: input.title?.trim() ? input.title.trim().slice(0, 200) : undefined,
      titleAr: input.titleAr === undefined ? undefined
        : (input.titleAr?.trim() ? input.titleAr.trim().slice(0, 200) : null),
      documentType: input.documentType ?? undefined,
      category: input.category ?? undefined,
      updatedAt: new Date().toISOString(),
    });
    if (!changed) throw badRequest('nothing_to_update', 'no document fields were supplied');

    await this.d.audit.write(
      {
        action: 'DOCUMENT_REFILED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'document', resourceId: doc.id,
        /* Fields, never values — the same rule the matter report follows. */
        metadata: {
          matterId: input.matterId,
          fields: Object.keys({ title: input.title, titleAr: input.titleAr,
            documentType: input.documentType, category: input.category })
            .filter((k) => (input as Record<string, unknown>)[k] !== undefined),
        },
      },
      ctx,
    );
    return { id: doc.id, changed: true };
  }

  /** Archive. Not delete: the row, the bytes and the chain all stay. */
  async archive(
    p: FirmPrincipalFacts,
    input: { matterId: string; documentId: string; reason?: string | null },
    ctx: RequestContextInfo,
  ) {
    const doc = await this.d.repo.getMatterDocument(p.tenantId, input.matterId, input.documentId);
    if (!doc) throw notFoundOrForbidden('document', input.documentId);

    const changed = await this.d.repo.updateFirmDocument({
      tenantId: p.tenantId, matterId: input.matterId, documentId: doc.id,
      status: 'archived',
      /* Archiving a released document also takes it out of the client's reach: the
         portal's own policy requires `status = 'available'`, so an archived row stops
         being readable without a second decision being taken here. Stated because a
         reader of this method would otherwise think the two are independent. */
      updatedAt: new Date().toISOString(),
    });
    if (!changed) throw notFoundOrForbidden('document', input.documentId);

    await this.d.audit.write(
      {
        action: 'DOCUMENT_ARCHIVED',
        actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
        resourceType: 'document', resourceId: doc.id,
        metadata: {
          matterId: input.matterId, version: doc.version,
          wasClientVisible: doc.clientVisibility === 'visible',
          reason: input.reason?.slice(0, 200) ?? null,
        },
      },
      ctx,
    );
    return { id: doc.id, status: 'archived' };
  }

  /**
   * The bytes, for a member who may read them.
   *
   * THE READ IS LOGGED, and not only in the audit trail: `document_access_log` is the
   * table the portal already writes on every open, and the firm's reads belong in the
   * same log or the answer to "who has seen this file" has two halves in two places.
   */
  async read(
    p: FirmPrincipalFacts,
    input: { matterId: string; documentId: string; disposition: 'inline' | 'attachment' },
    ctx: RequestContextInfo,
  ) {
    const doc = await this.d.repo.getMatterDocument(p.tenantId, input.matterId, input.documentId);
    if (!doc) throw notFoundOrForbidden('document', input.documentId);

    let body: Buffer;
    try {
      body = await this.d.storage.get(String(doc.storageKey));
    } catch {
      await this.d.audit.tryWrite(
        {
          action: 'DOCUMENT_ACCESS_DENIED',
          actor: { kind: 'firm_member', userId: p.userId, tenantId: p.tenantId },
          outcome: 'denied', reasonCode: 'storage_object_missing',
          resourceType: 'document', resourceId: doc.id,
        },
        ctx,
      );
      throw notFoundOrForbidden('document', input.documentId);
    }

    /*
      THE ACCESS HISTORY, APPENDED BEFORE THE BYTES LEAVE.
      `accessor_kind` is the CHECK's own vocabulary — 'client' | 'staff' | 'system' —
      and a firm member is 'staff'. The first draft of this wrote 'firm_member', which
      is not a word the table knows; a word that reads better and does not exist is
      still a 500 on the first read. `accessor_id` is the user, the same identity space
      the portal records for its own accessors, so one question — "who?" — has one
      answer whatever the audience.
    */
    await this.d.repo.logDocumentAccess({
      tenantId: p.tenantId, documentId: doc.id, accessorKind: 'staff',
      accessorId: p.userId, action: input.disposition === 'inline' ? 'viewed' : 'downloaded',
      ipHash: ctx.ipHash, createdAt: new Date().toISOString(),
    });

    return {
      body,
      mimeType: String(doc.mimeType),
      fileName: String(doc.originalFilename),
      sha256: String(doc.sha256),
      disposition: input.disposition,
      clientVisibility: doc.clientVisibility,
      privilegeClass: doc.privilegeClass,
    };
  }

  /**
   * The shared front half of the pipeline: size, extension, declared MIME, magic bytes.
   *
   * Extracted so the ordinary filing path and the new-version path cannot drift: the
   * second one is the same pipeline with a different `supersedes`, and a validation
   * step that existed on one path and not the other would be exactly the kind of gap
   * this project keeps finding by running against the real database.
   */
  private async appraise(file: UploadFile, p: FirmPrincipalFacts) {
    if (!file?.buffer || file.buffer.length === 0) {
      throw badRequest('upload_rejected', 'the file is empty');
    }
    if (file.buffer.length > config.uploads.maxBytes) {
      throw badRequest('upload_too_large', 'the file exceeds the maximum size', {
        maxBytes: config.uploads.maxBytes,
      });
    }

    const name = sanitizeFilename(file.originalName);
    if (isDangerousExtension(name.ext)) {
      throw badRequest('upload_type_not_allowed', 'this file type is not accepted');
    }
    if (!config.uploads.allowedExt.has(name.ext.toLowerCase())) {
      throw badRequest('upload_type_not_allowed', 'this file type is not accepted', {
        allowed: [...config.uploads.allowedExt],
      });
    }

    const declared = (file.declaredMime || '').toLowerCase().split(';')[0].trim();
    if (!config.uploads.allowedMime.has(declared)) {
      throw badRequest('upload_type_not_allowed', 'this file type is not accepted');
    }
    const sniff = sniffMime(file.buffer, declared);
    if (!sniff.ok) {
      throw badRequest('upload_rejected', 'the file contents do not match its declared type');
    }
    return { declared, name, refused: null as null, staffId: p.staffId };
  }
}
