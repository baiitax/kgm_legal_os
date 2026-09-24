/**
 * §18 DOCUMENT ACCESS · §19 UPLOAD PIPELINE · §35 R10 STORAGE KEYS
 *
 * Documents are the highest-value target in the portal: they are the firm's work
 * product, they are the client's evidence, and they live in object storage that
 * is trivially enumerable if a key is ever guessable. These tests assert that
 * (a) only client-visible documents on the caller's own matters are reachable,
 * (b) the download link is short-lived, session-bound and tamper-evident, and
 * (c) the upload pipeline refuses everything it is supposed to refuse and never
 * lets the browser choose where a file lands.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootStack, loginAs, createAgent, type Stack } from '../helpers.js';
import { IDS } from '../../server/src/db/demo-data.js';
import { config } from '../../server/src/config.js';
import { LocalStorage } from '../../server/src/storage/service.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

let s: Stack;
beforeEach(async () => { s = await bootStack(); });
afterEach(async () => { await s.shutdown(); });

const AHMED = 'ahmed.alsaud@example.test';
const GULF = 'finance@gulfhorizon.example.test';

const DOC_CLAIM = 'c1000000-0000-4000-8000-000000000001';       // Ahmed, visible
const DOC_REQUESTED = 'c1000000-0000-4000-8000-000000000003';   // Ahmed, visible, requested
const DOC_INTERNAL = 'c1000000-0000-4000-8000-000000000004';    // Ahmed's matter, INTERNAL
const DOC_GULF_SPA = 'c1000000-0000-4000-8000-000000000005';    // another client
const DOC_LAYLA = 'c1000000-0000-4000-8000-000000000006';       // another tenant

/** A structurally valid one-page PDF, small enough to build inline. */
function minimalPdf(text = 'KGM test document'): Buffer {
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

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

async function signedUrlFor(docId: string, disposition: 'inline' | 'attachment' = 'attachment') {
  const res = await s.agent.post(`/api/client/documents/${docId}/access-url`, { disposition });
  expect(res.status).toBe(200);
  return res.body.data as { url: string; expiresAt: string; ttlSeconds: number };
}

describe('§18 · document list is projected, not raw', () => {
  it('shows Ahmed only client-visible documents on his own matters', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get('/api/client/documents');
    expect(res.status).toBe(200);
    const ids = res.body.data.documents.map((d: any) => d.id);

    expect(ids).toContain(DOC_CLAIM);
    expect(ids).toContain(DOC_REQUESTED);
    expect(ids).not.toContain(DOC_INTERNAL);   // internal visibility
    expect(ids).not.toContain(DOC_GULF_SPA);   // another client
    expect(ids).not.toContain(DOC_LAYLA);      // another tenant
  });

  it('never returns a storage key, bucket or hash — the browser cannot build a path', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get('/api/client/documents');
    for (const banned of ['storage_key', 'storageKey', 'storage_bucket', 'sha256', 'uploaded_by_staff_id']) {
      expect(res.text, `leaked ${banned}`).not.toContain(banned);
    }
    // The seeded keys embed the tenant and client UUIDs; none may appear.
    expect(res.text).not.toContain('v1/demo-statement-of-claim.pdf');
  });

  it('filters by matter without widening the scope', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.get(`/api/client/documents?matterId=${IDS.matterCommercial}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.documents.map((d: any) => d.id);
    expect(ids).toContain(DOC_CLAIM);
    expect(ids).not.toContain(DOC_INTERNAL);

    // Filtering on a matter that is not yours yields nothing, not an error page
    // that confirms the matter exists.
    const other = await s.agent.get(`/api/client/documents?matterId=${IDS.matterGulf}`);
    expect(other.status).toBe(200);
    expect(other.body.data.documents).toEqual([]);
  });
});

describe('§18 · signed download URLs are short-lived and tamper-evident', () => {
  it('issues a URL with the configured TTL and no absolute storage location', async () => {
    await loginAs(s.agent, AHMED);
    const grant = await signedUrlFor(DOC_CLAIM);

    expect(grant.ttlSeconds).toBe(config.storage.signedUrlTtlSeconds);
    expect(grant.url).toMatch(/^\/api\/client\/documents\/.+\/access\?exp=\d+&disposition=attachment&sig=/);
    expect(grant.url).not.toMatch(/^https?:\/\//);       // relative only — no bucket host
    expect(grant.url).not.toContain('supabase');
    expect(grant.url).not.toContain('statement-of-claim.pdf');

    const ttl = grant.ttlSeconds;
    expect(ttl).toBeLessThanOrEqual(300);                 // minutes, never hours
    expect(Date.parse(grant.expiresAt) - Date.now()).toBeLessThanOrEqual((ttl + 5) * 1000);
  });

  it('serves the bytes with hardening headers and no caching', async () => {
    await loginAs(s.agent, AHMED);
    const grant = await signedUrlFor(DOC_CLAIM);
    const res = await s.agent.get(grant.url);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment/);
    // The real filename travels in RFC 5987 form so Arabic names survive.
    expect(String(res.headers['content-disposition'])).toContain("filename*=UTF-8''");
    expect(res.text.startsWith('%PDF-')).toBe(true);
  });

  it('refuses a tampered signature', async () => {
    await loginAs(s.agent, AHMED);
    const grant = await signedUrlFor(DOC_CLAIM);
    const [base, qs] = grant.url.split('?');
    const params = new URLSearchParams(qs);
    const sig = params.get('sig')!;
    params.set('sig', sig.slice(0, -2) + (sig.endsWith('A') ? 'BB' : 'AA'));

    const res = await s.agent.get(`${base}?${params.toString()}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('token_invalid');
  });

  it('refuses an expired URL', async () => {
    await loginAs(s.agent, AHMED);
    const grant = await signedUrlFor(DOC_CLAIM);
    const [base, qs] = grant.url.split('?');
    const params = new URLSearchParams(qs);
    // Rewinding `exp` invalidates the signature too — both gates must refuse,
    // and the response must not say which one fired.
    params.set('exp', String(Math.floor(Date.now() / 1000) - 120));

    const res = await s.agent.get(`${base}?${params.toString()}`);
    expect(res.status).toBe(403);
  });

  it('refuses a swapped disposition', async () => {
    await loginAs(s.agent, AHMED);
    const grant = await signedUrlFor(DOC_CLAIM, 'attachment');
    const [base, qs] = grant.url.split('?');
    const params = new URLSearchParams(qs);
    params.set('disposition', 'inline');

    // `disposition` is inside the signed payload, so flipping it cannot turn a
    // download grant into an inline-render grant.
    const res = await s.agent.get(`${base}?${params.toString()}`);
    expect(res.status).toBe(403);
  });

  it('refuses a URL replayed after the session it was bound to is gone', async () => {
    await loginAs(s.agent, AHMED);
    const grant = await signedUrlFor(DOC_CLAIM);

    // Sign out, then sign back in: the new session id is different, so the old
    // link is dead even though it has not expired.
    await s.agent.post('/api/auth/logout', {});
    const again = await loginAs(s.agent, AHMED);
    expect(again.status).toBe(200);

    const res = await s.agent.get(grant.url);
    expect([401, 403]).toContain(res.status);
  });

  it('refuses a URL issued to one client when presented by another', async () => {
    await loginAs(s.agent, AHMED);
    const grant = await signedUrlFor(DOC_CLAIM);

    const gulf = createAgent(s.app);
    await loginAs(gulf, GULF);
    const res = await gulf.get(grant.url);
    expect([403, 404]).toContain(res.status);
    expect(res.text.startsWith('%PDF')).toBe(false);
  });

  it('refuses an unauthenticated fetch of a signed URL', async () => {
    await loginAs(s.agent, AHMED);
    const grant = await signedUrlFor(DOC_CLAIM);

    const anon = createAgent(s.app);
    await anon.get('/api/auth/bootstrap');
    expect((await anon.get(grant.url)).status).toBe(401);
  });

  it('denies a grant request for a document the caller cannot see', async () => {
    await loginAs(s.agent, AHMED);
    for (const id of [DOC_GULF_SPA, DOC_LAYLA, DOC_INTERNAL]) {
      const res = await s.agent.post(`/api/client/documents/${id}/access-url`, {});
      expect(res.status, id).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }

    await new Promise((r) => setTimeout(r, 80));
    const denied = await s.db.all<any>(
      `select resource_id from audit_events where action = 'DOCUMENT_ACCESS_DENIED'`);
    const ids = denied.map((d) => d.resource_id);
    expect(ids).toContain(DOC_GULF_SPA);
    expect(ids).toContain(DOC_INTERNAL);
  });

  it('records SIGNED_URL_ISSUED and DOCUMENT_DOWNLOADED', async () => {
    await loginAs(s.agent, AHMED);
    const grant = await signedUrlFor(DOC_CLAIM);
    await s.agent.get(grant.url);
    await new Promise((r) => setTimeout(r, 80));

    const actions = (await s.db.all<any>(`select action from audit_events`)).map((a) => a.action);
    expect(actions).toContain('SIGNED_URL_ISSUED');
    expect(actions).toContain('DOCUMENT_DOWNLOADED');
  });

  it('records DOCUMENT_VIEWED for an inline grant', async () => {
    await loginAs(s.agent, AHMED);
    const grant = await signedUrlFor(DOC_CLAIM, 'inline');
    const res = await s.agent.get(grant.url);
    expect(res.status).toBe(200);
    // Inline PDF previews are sandboxed: no scripts, no same-origin access.
    expect(res.headers['content-security-policy']).toContain('sandbox');
    await new Promise((r) => setTimeout(r, 80));
    const actions = (await s.db.all<any>(`select action from audit_events`)).map((a) => a.action);
    expect(actions).toContain('DOCUMENT_VIEWED');
  });
});

describe('§19 · upload pipeline accepts what it should', () => {
  it('accepts a valid PDF and returns a server-assigned identity', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'evidence', title: 'Signed witness statement' },
      { name: 'witness-statement.pdf', type: 'application/pdf', data: minimalPdf('witness statement') },
    );

    expect(res.status).toBe(201);
    const doc = res.body.data;
    expect(doc.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(doc.status).toBe('available');
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.sizeBytes).toBeGreaterThan(100);
    // The response carries no storage location at all.
    expect(res.text).not.toContain('storage_key');
    expect(res.text).not.toContain('client-documents');
  });

  it('stores the file under a server-generated key with 0600 permissions', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterEmployment, documentType: 'evidence' },
      { name: 'evidence.pdf', type: 'application/pdf', data: minimalPdf('evidence') },
    );
    expect(res.status).toBe(201);

    const row = await s.db.get<any>(
      `select storage_key, storage_bucket, client_id, tenant_id, matter_id, uploaded_by_user_id
         from documents where id = ?`, [res.body.data.id]);
    expect(row).toBeTruthy();

    // Identity comes from the SESSION, never from the request body.
    expect(row.tenant_id).toBe(IDS.tenantKgm);
    expect(row.client_id).toBe(IDS.clientAhmed);
    expect(row.matter_id).toBe(IDS.matterEmployment);
    expect(row.uploaded_by_user_id).toBe(IDS.userAhmed);

    // The key is tenant/client/matter/document scoped — enumerable only by
    // someone who already holds all four ids, which is exactly the owner.
    expect(row.storage_key).toContain(IDS.tenantKgm);
    expect(row.storage_key).toContain(IDS.clientAhmed);
    expect(row.storage_key).toContain(res.body.data.id);

    const storage = s.c.storage as LocalStorage;
    const abs = path.join(storage.rootDir, row.storage_key);
    const stat = await fs.stat(abs);
    // Owner-only. A misconfigured permission here is how document leaks happen.
    expect(stat.mode & 0o077).toBe(0);
    expect(stat.size).toBeGreaterThan(100);
  });

  it('sanitizes a hostile filename without letting it shape the path', async () => {
    await loginAs(s.agent, AHMED);
    const hostile = '../../../../etc/passwd.pdf';
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'other' },
      { name: hostile, type: 'application/pdf', data: minimalPdf() },
    );
    expect([201, 400]).toContain(res.status);

    if (res.status === 201) {
      const row = await s.db.get<any>(`select storage_key from documents where id = ?`, [res.body.data.id]);
      expect(row.storage_key).not.toContain('..');
      expect(row.storage_key).not.toContain('etc/passwd');
      expect(path.isAbsolute(row.storage_key)).toBe(false);

      // Nothing may have escaped the private root.
      const escaped = await fs.stat('/tmp/kgm-portal-test/etc/passwd.pdf').catch(() => null);
      expect(escaped).toBeNull();
    }
  });

  it('fulfils a document request and clears the requested flag', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'contract', fulfillRequestId: DOC_REQUESTED },
      { name: 'supply-agreement-signed.pdf', type: 'application/pdf', data: minimalPdf('signed') },
    );
    expect(res.status).toBe(201);
    const row = await s.db.get<any>(`select requested from documents where id = ?`, [DOC_REQUESTED]);
    expect(Number(row?.requested ?? 1)).toBe(0);
  });
});

describe('§19 · upload pipeline refuses what it must', () => {
  it('refuses an executable', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'other' },
      { name: 'payload.exe', type: 'application/pdf', data: Buffer.from('MZ\x90\x00fake-pe') },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('upload_type_not_allowed');
  });

  it('refuses a dangerous extension even with a PDF body and PDF MIME', async () => {
    await loginAs(s.agent, AHMED);
    for (const name of ['report.pdf.js', 'invoice.html', 'script.svg', 'macro.pdf.vbs']) {
      const res = await s.agent.postMultipart(
        '/api/client/documents/upload',
        { matterId: IDS.matterCommercial, documentType: 'other' },
        { name, type: 'application/pdf', data: minimalPdf() },
      );
      expect(res.status, name).toBe(400);
      expect(res.body.error.code, name).toBe('upload_type_not_allowed');
    }
  });

  it('refuses content that does not match its declared MIME', async () => {
    await loginAs(s.agent, AHMED);
    // Claims to be a PDF, is actually a PNG. Magic-byte sniffing is the gate.
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'other' },
      { name: 'spoofed.pdf', type: 'application/pdf', data: PNG_1PX },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('upload_rejected');
  });

  it('refuses an HTML file declared as text/plain', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'other' },
      { name: 'notes.txt', type: 'text/plain', data: Buffer.from('<html><script>alert(1)</script></html>') },
    );
    expect(res.status).toBe(400);
  });

  it('refuses a MIME type that is not allowlisted at all', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'other' },
      { name: 'app.apk', type: 'application/vnd.android.package-archive', data: Buffer.from('PK\x03\x04junk') },
    );
    expect(res.status).toBe(400);
  });

  it('refuses an empty file', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'other' },
      { name: 'empty.pdf', type: 'application/pdf', data: Buffer.alloc(0) },
    );
    expect(res.status).toBe(400);
  });

  it('refuses an unknown document type', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'internal_strategy' },
      { name: 'x.pdf', type: 'application/pdf', data: minimalPdf() },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('refuses to attach a document to another client\'s matter', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterGulf, documentType: 'evidence' },
      { name: 'planted.pdf', type: 'application/pdf', data: minimalPdf() },
    );
    expect(res.status).toBe(404);

    const planted = await s.db.get<any>(
      `select count(*) as n from documents where matter_id = ? and origin = 'client'`, [IDS.matterGulf]);
    expect(Number(planted.n)).toBe(0);
  });

  it('refuses to attach a document to a matter in another tenant', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterLayla, documentType: 'evidence' },
      { name: 'planted.pdf', type: 'application/pdf', data: minimalPdf() },
    );
    expect(res.status).toBe(404);
  });

  it('refuses a forged tenant/client identity in the multipart body', async () => {
    await loginAs(s.agent, AHMED);
    // §46: a protected field in the payload is REFUSED and audited, not silently
    // stripped. Multipart is not a smuggling channel around the JSON guard.
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      {
        matterId: IDS.matterCommercial, documentType: 'evidence',
        tenant_id: IDS.tenantNajd, client_id: IDS.clientGulf,
        uploaded_by_staff_id: 'f1000000-0000-4000-8000-000000000001',
        client_visibility: 'internal', storage_key: 'attacker/chosen/path.pdf',
      },
      { name: 'forged.pdf', type: 'application/pdf', data: minimalPdf() },
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('field_not_writable');

    // Nothing at all was written.
    const planted = await s.db.get<any>(
      `select count(*) as n from documents where origin = 'client' and title like '%forged%'`);
    expect(Number(planted.n)).toBe(0);
    const stored = await s.db.get<any>(
      `select count(*) as n from documents where storage_key = 'attacker/chosen/path.pdf'`);
    expect(Number(stored.n)).toBe(0);
  });

  it('accepts the same upload once the forged fields are removed', async () => {
    // Proves the refusal above is about the FIELDS, not the request shape.
    await loginAs(s.agent, AHMED);
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'evidence', title: 'forged' },
      { name: 'forged.pdf', type: 'application/pdf', data: minimalPdf() },
    );
    expect(res.status).toBe(201);

    // Identity still comes from the session.
    const row = await s.db.get<any>(
      `select tenant_id, client_id, storage_key, client_visibility, uploaded_by_staff_id
         from documents where id = ?`, [res.body.data.id]);
    expect(row.tenant_id).toBe(IDS.tenantKgm);
    expect(row.client_id).toBe(IDS.clientAhmed);
    expect(row.storage_key).not.toContain('attacker');
    expect(row.uploaded_by_staff_id).toBeFalsy();
  });

  it('refuses an upload with no file part', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.postMultipart(
      '/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'evidence' },
    );
    expect(res.status).toBe(400);
  });

  it('refuses an upload without CSRF', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.post(
      '/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'evidence' },
      { csrf: null },
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf_failed');
  });

  it('audits every rejected upload', async () => {
    await loginAs(s.agent, AHMED);
    await s.agent.postMultipart('/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'other' },
      { name: 'evil.exe', type: 'application/pdf', data: Buffer.from('MZ junk') });
    await s.agent.postMultipart('/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'other' },
      { name: 'spoof.pdf', type: 'application/pdf', data: PNG_1PX });

    await new Promise((r) => setTimeout(r, 80));
    const rows = await s.db.all<any>(
      `select reason_code from audit_events where action = 'DOCUMENT_UPLOAD_REJECTED'`);
    const reasons = rows.map((r) => r.reason_code);
    expect(reasons).toContain('dangerous_extension');
    expect(reasons).toContain('mime_mismatch');
  });

  it('records DOCUMENT_UPLOADED for a successful upload', async () => {
    await loginAs(s.agent, AHMED);
    const res = await s.agent.postMultipart('/api/client/documents/upload',
      { matterId: IDS.matterCommercial, documentType: 'evidence' },
      { name: 'ok.pdf', type: 'application/pdf', data: minimalPdf() });
    expect(res.status).toBe(201);

    await new Promise((r) => setTimeout(r, 80));
    const rows = await s.db.all<any>(
      `select resource_id from audit_events where action = 'DOCUMENT_UPLOADED'`);
    expect(rows.map((r) => r.resource_id)).toContain(res.body.data.id);
  });
});

describe('§18 · there is no route that takes a storage key', () => {
  it('every key-shaped endpoint is absent', async () => {
    await loginAs(s.agent, AHMED);
    const key = `${IDS.tenantKgm}/${IDS.clientAhmed}/${IDS.matterCommercial}/${DOC_CLAIM}/v1/demo-statement-of-claim.pdf`;
    for (const url of [
      `/api/client/storage/${key}`,
      `/api/client/documents/by-key?key=${encodeURIComponent(key)}`,
      `/api/client/files/${encodeURIComponent(key)}`,
      `/api/client/buckets/client-documents/${encodeURIComponent(key)}`,
      `/api/client/download?key=${encodeURIComponent(key)}`,
      '/api/client/documents/raw',
    ]) {
      expect((await s.agent.get(url)).status, url).toBe(404);
    }
  });

  it('a non-UUID document id cannot be used to probe', async () => {
    await loginAs(s.agent, AHMED);
    for (const id of ['../../etc/passwd', '1', 'null', 'undefined', '*', '%2e%2e%2f']) {
      const res = await s.agent.post(`/api/client/documents/${encodeURIComponent(id)}/access-url`, {});
      expect([400, 404], id).toContain(res.status);
    }
  });
});
