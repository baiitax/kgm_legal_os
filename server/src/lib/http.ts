import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { PortalError } from './errors.js';
import { hashIp, normalizeIp } from './crypto.js';

export const REQUEST_ID_HEADER = 'x-request-id';

export function newRequestId(): string {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * Client IP resolution.
 *
 * Behind a trusted reverse proxy the real address is in X-Forwarded-For. We
 * take the FIRST entry only when TRUST_PROXY is enabled, because otherwise a
 * caller can spoof the header and defeat per-IP rate limiting.
 */
export function clientIp(req: Request, trustProxy: boolean): string | null {
  if (trustProxy) {
    const fwd = req.header('x-forwarded-for');
    if (fwd) return normalizeIp(fwd.split(',')[0]);
    const real = req.header('x-real-ip');
    if (real) return normalizeIp(real);
  }
  return req.socket.remoteAddress ? normalizeIp(req.socket.remoteAddress) : null;
}

export function ipHashFor(req: Request, trustProxy: boolean): string | null {
  return hashIp(clientIp(req, trustProxy));
}

/** Coarse, non-reversible locale hint for suspicious-login detection. */
export function geoHint(req: Request): string | null {
  const country = req.header('cf-ipcountry') || req.header('x-vercel-ip-country');
  return country && country !== 'XX' ? country : null;
}

// ---------------------------------------------------------------------------
// User agent parsing — enough to render "iPhone · Safari · Abuja" in the
// Security centre without shipping a heavy UA library.
// ---------------------------------------------------------------------------
export interface UaInfo {
  browser: string;
  os: string;
  deviceLabel: string;
  family: string;
}

export function parseUserAgent(ua: string | undefined | null): UaInfo {
  const s = ua || '';

  let browser = 'Unknown browser';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\//.test(s)) browser = 'Opera';
  else if (/Chrome\//.test(s) && !/Chromium/.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = 'Safari';
  else if (/Firefox\//.test(s)) browser = 'Firefox';

  let os = 'Unknown OS';
  if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Windows NT/.test(s)) os = 'Windows';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';

  let deviceLabel = 'Device';
  if (/iPhone/.test(s)) deviceLabel = 'iPhone';
  else if (/iPad/.test(s)) deviceLabel = 'iPad';
  else if (/Android/.test(s)) deviceLabel = 'Android device';
  else if (/Mac OS X/.test(s)) deviceLabel = 'Mac';
  else if (/Windows NT/.test(s)) deviceLabel = 'Windows PC';
  else if (/Linux/.test(s)) deviceLabel = 'Linux machine';

  return { browser, os, deviceLabel, family: `${os}/${browser}` };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}

export function fail(res: Response, err: PortalError): void {
  res.status(err.status).json({
    ok: false,
    error: {
      code: err.code,
      // A short, stable, English machine message. The UI renders the localized
      // copy from `code`; this string is for developers and logs only.
      message: err.message,
      ...(err.safeDetails ? { details: err.safeDetails } : {}),
      /*
        The client uses this to offer "try again" rather than "contact support". It rides
        OUTSIDE `details` because it is a property of the error, not of the resource, and
        a caller should not have to know which guard produced the refusal to read it.
      */
      ...(err.retryable ? { retryable: true } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Filename sanitization (§19)
// ---------------------------------------------------------------------------
const DANGEROUS_EXT = [
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.ps1', '.psm1', '.sh', '.bash', '.jar', '.app', '.dll', '.so',
  '.dylib', '.hta', '.cpl', '.pif', '.gadget', '.php', '.php3', '.php4', '.php5',
  '.phtml', '.asp', '.aspx', '.jsp', '.cgi', '.pl', '.py', '.rb', '.svg', '.html',
  '.htm', '.xhtml', '.shtml',
];

export interface SanitizedName {
  display: string;
  slug: string;
  ext: string;
}

export function sanitizeFilename(input: string): SanitizedName {
  const raw = String(input || 'file').replace(/[\u0000-\u001f\u007f]/g, '');
  // Strip any path component the client may have tried to smuggle in.
  const base = raw.split(/[\\/]/).pop() || 'file';
  const withoutTraversal = base.replace(/\.\.+/g, '.').replace(/^\.+/, '');
  const trimmed = withoutTraversal.slice(0, 180) || 'file';

  const dot = trimmed.lastIndexOf('.');
  const ext = dot > 0 ? trimmed.slice(dot).toLowerCase() : '';
  const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;

  const display = `${stem}${ext}`.trim() || 'file';
  // The slug is used ONLY for the human-readable tail of a server-generated
  // key. It contributes no directory structure (§35 R10).
  const slug =
    stem
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}\u0600-\u06FF _-]+/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'document';

  return { display, slug, ext };
}

export function isDangerousExtension(ext: string): boolean {
  return DANGEROUS_EXT.includes(ext.toLowerCase());
}

// ---------------------------------------------------------------------------
// Minimal magic-byte sniffing. A client-supplied Content-Type is never trusted;
// the declared MIME must agree with the file's own header bytes.
// ---------------------------------------------------------------------------
const SIGNATURES: { mime: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'application/zip', test: (b) => b.subarray(0, 2).equals(Buffer.from([0x50, 0x4b])) },
];

/** Office Open XML and legacy Office formats are ZIP/OLE containers. */
const CONTAINER_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
]);
const OLE_MIMES = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]);

export function sniffMime(buf: Buffer, declared: string): { ok: boolean; detected: string | null } {
  const sig = SIGNATURES.find((s) => s.test(buf));
  const detected = sig?.mime ?? null;

  if (CONTAINER_MIMES.has(declared)) {
    // OOXML is a ZIP; accept the ZIP signature.
    return { ok: !!detected && (detected === 'application/zip' || detected === declared), detected: detected ?? 'application/zip' };
  }
  if (OLE_MIMES.has(declared)) {
    const ole = buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    return { ok: ole, detected: ole ? declared : null };
  }
  if (declared === 'text/plain' || declared === 'text/csv') {
    // Text must not contain NUL and must not look like markup.
    const head = buf.subarray(0, 2048);
    const hasNul = head.includes(0);
    const looksLikeMarkup = /^\s*<(html|script|svg|xml|!doctype)/i.test(head.toString('utf8'));
    return { ok: !hasNul && !looksLikeMarkup, detected: declared };
  }
  if (declared === 'image/heic') {
    const ftyp = buf.subarray(4, 8).toString('latin1') === 'ftyp';
    return { ok: ftyp, detected: ftyp ? declared : null };
  }
  return { ok: detected === declared, detected };
}

export function relativeTimeLabel(iso: string | null, lang: 'ar' | 'en', now = Date.now()): string {
  if (!iso) return lang === 'ar' ? '—' : '—';
  const diff = now - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return lang === 'ar' ? 'الآن' : 'just now';
  if (mins < 60) return lang === 'ar' ? `قبل ${mins} دقيقة` : `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return lang === 'ar' ? `قبل ${hours} ساعة` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return lang === 'ar' ? `قبل ${days} يوم` : `${days} d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
