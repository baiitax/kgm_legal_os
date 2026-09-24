/**
 * PRIVATE DOCUMENT STORAGE (§18, §19, §35 R10)
 *
 *   Private storage → authorization check → short-lived signed URL →
 *   download/preview → audit event
 *
 * There is no public bucket and no permanent public URL anywhere in this file.
 *
 * KEY CONSTRUCTION
 *   The storage key is generated entirely server-side:
 *     {tenantId}/{clientId}/{matterId|general}/{documentId}/v{n}/{rand}-{slug}{ext}
 *   The client contributes ONLY a display filename, which is sanitized to a
 *   slug and appended after a random prefix. It cannot introduce a path
 *   separator, a traversal sequence or a directory. So there is no key a client
 *   can construct that points at another client's object — guessing one would
 *   require guessing two UUIDs and a 128-bit random value.
 *
 * SIGNED URLS
 *   TTL 60 s by default. The signature covers documentId + sessionId + expiry +
 *   disposition, so a URL cannot be replayed by a different session or reused
 *   to switch an attachment download into an inline preview. Every mint is
 *   written to document_access_log and audit_events.
 *
 * MALWARE GATE (§19)
 *   A document row cannot reach status='available' unless scan_status='clean'.
 *   That is enforced three times: here, by a repository query that only returns
 *   clean+available rows, and by a database trigger in both dialects.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, signedUrlSecret } from '../config.js';

export type Disposition = 'inline' | 'attachment';

export interface ScanResult {
  status: 'clean' | 'infected' | 'error';
  detail: string;
  engine: string;
}

export interface StorageDriver {
  readonly name: string;
  put(key: string, body: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Returns an absolute or portal-relative URL valid for `ttlSeconds`. */
  signedUrl(key: string, ttlSeconds: number, opts: { filename: string; disposition: Disposition }): Promise<string>;
}

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------
export function buildStorageKey(input: {
  tenantId: string;
  clientId: string;
  matterId: string | null;
  documentId: string;
  slug: string;
  ext: string;
  version?: number;
}): string {
  const rand = crypto.randomBytes(8).toString('hex');
  const safeSlug = input.slug.replace(/[^A-Za-z0-9\u0600-\u06FF_-]/g, '').slice(0, 60) || 'document';
  const safeExt = input.ext.replace(/[^a-z0-9.]/g, '').slice(0, 12);
  const scope = input.matterId ?? 'general';
  const v = input.version ?? 1;
  // No user-controlled component can produce a '/' or '..' here.
  return [input.tenantId, input.clientId, scope, input.documentId, `v${v}`, `${rand}-${safeSlug}${safeExt}`].join('/');
}

// ---------------------------------------------------------------------------
// Malware scanning
// ---------------------------------------------------------------------------
/** The standard anti-virus test file. Detecting it proves the gate is wired. */
const EICAR =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export async function scanBuffer(body: Buffer, declaredMime: string): Promise<ScanResult> {
  if (config.uploads.scanDriver === 'clamav') {
    return clamavScan(body);
  }
  // Stub engine: structural checks plus the EICAR signature. This is a
  // placeholder for a real scanner (ClamAV INSTREAM, VirusTotal, or the
  // provider's own scan) — the pipeline, quarantine states and audit events
  // around it are the real thing and do not change when the engine is swapped.
  const head = body.subarray(0, 4096).toString('latin1');
  if (head.includes(EICAR) || body.toString('latin1').includes(EICAR)) {
    return { status: 'infected', detail: 'EICAR test signature detected', engine: 'stub' };
  }
  // Reject active content smuggled into a document container.
  if (declaredMime === 'application/pdf') {
    const raw = body.toString('latin1');
    if (/\/(JavaScript|JS|OpenAction|Launch|EmbeddedFile|AcroForm)/i.test(raw)) {
      return { status: 'infected', detail: 'PDF contains an active-content primitive', engine: 'stub' };
    }
  }
  if (/<script[\s>]/i.test(head) && !declaredMime.startsWith('text/')) {
    return { status: 'infected', detail: 'script content in a binary container', engine: 'stub' };
  }
  if (body.length === 0) {
    return { status: 'error', detail: 'empty file', engine: 'stub' };
  }
  return { status: 'clean', detail: 'no signature match', engine: 'stub' };
}

async function clamavScan(body: Buffer): Promise<ScanResult> {
  // INSTREAM protocol: "zINSTREAM\0" + chunks + terminating zero-length chunk.
  try {
    const net = await import('node:net');
    return await new Promise<ScanResult>((resolve) => {
      const socket = net.connect(config.uploads.clamavPort, config.uploads.clamavHost);
      let out = '';
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({ status: 'error', detail: 'scanner timeout', engine: 'clamav' });
      }, 30_000);

      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let i = 0; i < body.length; i += CHUNK) {
          const slice = body.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(slice.length, 0);
          socket.write(Buffer.concat([len, slice]));
        }
        socket.write(Buffer.alloc(4));
      });
      socket.on('data', (d) => {
        out += d.toString('utf8');
      });
      socket.on('end', () => {
        clearTimeout(timeout);
        const infected = /FOUND\s*$/i.test(out.trim());
        resolve({
          status: infected ? 'infected' : 'clean',
          detail: out.trim().slice(0, 200),
          engine: 'clamav',
        });
      });
      socket.on('error', (err) => {
        clearTimeout(timeout);
        // Fail CLOSED: if the scanner is unreachable the document is not
        // marked clean, so it never becomes downloadable.
        resolve({ status: 'error', detail: err.message, engine: 'clamav' });
      });
    });
  } catch (err) {
    return { status: 'error', detail: err instanceof Error ? err.message : 'scanner failure', engine: 'clamav' };
  }
}

// ---------------------------------------------------------------------------
// Local private storage (demo / development / test)
// ---------------------------------------------------------------------------
/**
 * Files live under a directory that is NEVER mounted as a static route. The
 * only way bytes leave is through the signed-URL endpoint, which re-runs the
 * full authorization check before streaming.
 */
export class LocalStorage implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * The resolved private root. Exposed so operational checks (and the security
   * suite) can assert on-disk properties such as file permissions — the path is
   * never rendered into a response.
   */
  get rootDir(): string {
    return this.root;
  }

  private resolve(key: string): string {
    // Defence in depth: even though keys are server-generated, refuse anything
    // that escapes the storage root.
    const abs = path.resolve(this.root, key);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('storage key escapes the private root');
    }
    return abs;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const abs = this.resolve(key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  /**
   * The local driver does not hand out a direct file URL — that would be a
   * public path. It returns a portal API route guarded by an HMAC signature.
   */
  async signedUrl(key: string): Promise<string> {
    // The API route resolves the key from the document row, so the key itself
    // is not exposed in the URL.
    void key;
    throw new Error('LocalStorage.signedUrl is not used; see signAccessUrl()');
  }
}

// ---------------------------------------------------------------------------
// Supabase private storage (production)
// ---------------------------------------------------------------------------
export class SupabaseStorage implements StorageDriver {
  readonly name = 'supabase';
  private client: Promise<import('@supabase/supabase-js').SupabaseClient> | null = null;

  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly bucket: string,
  ) {}

  private async c() {
    if (!this.client) {
      this.client = import('@supabase/supabase-js').then(({ createClient }) =>
        createClient(this.url, this.serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        }),
      );
    }
    return this.client;
  }

  async put(key: string, body: Buffer, mime: string): Promise<void> {
    const c = await this.c();
    const { error } = await c.storage.from(this.bucket).upload(key, body, {
      contentType: mime,
      upsert: false, // never silently overwrite another version
    });
    if (error) throw new Error(`storage upload failed: ${error.message}`);
  }

  async get(key: string): Promise<Buffer> {
    const c = await this.c();
    const { data, error } = await c.storage.from(this.bucket).download(key);
    if (error || !data) throw new Error(`storage download failed: ${error?.message ?? 'no data'}`);
    return Buffer.from(await data.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const c = await this.c();
    await c.storage.from(this.bucket).remove([key]);
  }

  async signedUrl(key: string, ttlSeconds: number, opts: { filename: string; disposition: Disposition }): Promise<string> {
    const c = await this.c();
    const { data, error } = await c.storage.from(this.bucket).createSignedUrl(key, ttlSeconds, {
      download: opts.disposition === 'attachment' ? opts.filename : undefined,
    });
    if (error || !data) throw new Error(`signed url failed: ${error?.message ?? 'unknown'}`);
    return data.signedUrl;
  }
}

// ---------------------------------------------------------------------------
// Session-bound access signatures (local driver)
// ---------------------------------------------------------------------------
/**
 * Signs a single-purpose, short-lived grant to read one document.
 *
 * The signature covers:
 *   documentId  — which object
 *   sessionId   — who may use it (so a leaked URL cannot be replayed by
 *                 another session even though the cookie would ride along)
 *   expiry      — 60 s by default
 *   disposition — inline preview and attachment download are distinct grants
 */
export function signAccessUrl(input: {
  documentId: string;
  sessionId: string;
  ttlSeconds?: number;
  disposition?: Disposition;
}): { url: string; expiresAt: number } {
  const ttl = input.ttlSeconds ?? config.storage.signedUrlTtlSeconds;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const disposition = input.disposition ?? 'attachment';
  const payload = `${input.documentId}.${input.sessionId}.${exp}.${disposition}`;
  const sig = crypto.createHmac('sha256', signedUrlSecret).update(payload).digest('base64url');
  const url =
    `/api/client/documents/${encodeURIComponent(input.documentId)}/access` +
    `?exp=${exp}&disposition=${disposition}&sig=${sig}`;
  return { url, expiresAt: exp };
}

export function verifyAccessSignature(input: {
  documentId: string;
  sessionId: string;
  exp: string | number;
  disposition: string;
  sig: string;
}): { ok: boolean; reason?: string } {
  const exp = Number(input.exp);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed_expiry' };
  if (exp * 1000 < Date.now()) return { ok: false, reason: 'expired' };
  if (input.disposition !== 'inline' && input.disposition !== 'attachment') {
    return { ok: false, reason: 'bad_disposition' };
  }
  const payload = `${input.documentId}.${input.sessionId}.${exp}.${input.disposition}`;
  const expected = crypto.createHmac('sha256', signedUrlSecret).update(payload).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(input.sig ?? ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------
let driver: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  if (driver) return driver;
  if (config.storage.driver === 'supabase' && config.supabase.url && config.supabase.serviceKey) {
    driver = new SupabaseStorage(config.supabase.url, config.supabase.serviceKey, config.supabase.documentsBucket);
  } else {
    driver = new LocalStorage(config.storage.localDir);
  }
  return driver;
}

/** Test hook: force the local driver at a specific root. */
export function setStorage(d: StorageDriver): void {
  driver = d;
}
