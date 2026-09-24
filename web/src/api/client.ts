/**
 * API client.
 *
 * The server owns every security decision; this file's only job is to speak its
 * protocol correctly. Three things matter here:
 *
 *  1. CSRF is a signed double-submit token. The cookie is readable by JS by
 *     design (`httpOnly: false`); the SESSION cookie is not. The token is echoed
 *     in `X-CSRF-Token` on every state-changing request.
 *
 *  2. A CSRF token is bound to a session. After a password reset, a revocation
 *     or a sign-out, the token the browser holds is stale and the server answers
 *     403 `csrf_failed` while issuing a fresh one. Rather than surfacing that as
 *     a failure, the client re-reads the cookie and retries ONCE. Anything that
 *     still fails is a real error.
 *
 *  3. Nothing about identity is sent. There is no tenant id, client id or role
 *     in any request this client can build — the server resolves all of it from
 *     the session cookie.
 */

export type Lang = 'ar' | 'en';
export type Calendar = 'islamic-umalqura' | 'gregory';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** True when the caller should be sent back to the sign-in screen. */
  get isAuthFailure(): boolean {
    return (
      this.status === 401 ||
      ['unauthenticated', 'session_expired', 'session_revoked', 'account_disabled'].includes(this.code)
    );
  }

  /** True when the account exists but must complete a second factor. */
  get isMfaRequired(): boolean {
    return this.code === 'mfa_required';
  }
}

const CSRF_COOKIE = 'kgm_csrf';

function readCookie(name: string): string | null {
  const pairs = document.cookie ? document.cookie.split(';') : [];
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    if (pair.slice(0, i).trim() === name) {
      return decodeURIComponent(pair.slice(i + 1).trim());
    }
  }
  return null;
}

export interface Envelope<T> {
  ok: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
  requestId?: string;
}

interface CallOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the automatic single retry on a stale CSRF token. */
  noCsrfRetry?: boolean;
}

/** Set by the auth provider so a 401 anywhere can clear the session. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function call<T>(path: string, opts: CallOptions = {}, isRetry = false): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  let payload: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    payload = opts.body; // the browser sets the multipart boundary
  } else if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }

  if (method !== 'GET') {
    const token = readCookie(CSRF_COOKIE);
    if (token) headers['x-csrf-token'] = token;
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: payload,
      credentials: 'same-origin',
      redirect: 'manual',
      signal: opts.signal,
      cache: 'no-store',
    });
  } catch (err) {
    // Network failure. Distinct from an HTTP error so the UI can say "offline"
    // rather than "your credentials are wrong".
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'network', undefined);
  }

  const requestId = res.headers.get('x-request-id') ?? undefined;
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  // A stale CSRF token is a bookkeeping problem, not a user error: the response
  // already carries a fresh cookie, so read it and try once more.
  if (
    res.status === 403 &&
    (json as ErrorEnvelope | null)?.error?.code === 'csrf_failed' &&
    !isRetry &&
    !opts.noCsrfRetry
  ) {
    return call<T>(path, opts, true);
  }

  if (!res.ok) {
    const err = (json as ErrorEnvelope | null)?.error;
    const apiError = new ApiError(
      res.status,
      err?.code ?? 'unknown',
      err?.message ?? res.statusText ?? 'request failed',
      err?.details,
      requestId,
    );
    if (apiError.isAuthFailure && onUnauthorized) onUnauthorized();
    throw apiError;
  }

  const env = json as Envelope<T> | null;
  return (env && 'data' in env ? env.data : (json as T));
}

export const get = <T>(path: string, signal?: AbortSignal) => call<T>(path, { signal });
export const post = <T>(path: string, body?: unknown, signal?: AbortSignal) =>
  call<T>(path, { method: 'POST', body, signal });
export const patch = <T>(path: string, body?: unknown, signal?: AbortSignal) =>
  call<T>(path, { method: 'PATCH', body, signal });
export const del = <T>(path: string, signal?: AbortSignal) =>
  call<T>(path, { method: 'DELETE', signal });

/**
 * Multipart upload. The field names are the ONLY thing the browser chooses;
 * tenant, client, storage key and visibility are all decided server-side.
 */
export function upload(
  path: string,
  file: File,
  fields: Record<string, string | null | undefined>,
  signal?: AbortSignal,
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') form.append(k, v);
  }
  form.append('file', file, file.name);
  return call<{
    id: string;
    title: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
    createdAt: string;
  }>(path, { method: 'POST', body: form, signal });
}

/**
 * Opens a signed document URL. The grant is fetched fresh every time because
 * the URL is short-lived by design — caching it would just produce a 403 later.
 */
export async function openDocument(documentId: string, disposition: 'inline' | 'attachment') {
  const grant = await post<{ url: string; expiresAt: string; ttlSeconds: number; fileName: string }>(
    `/api/client/documents/${encodeURIComponent(documentId)}/access-url`,
    { disposition },
  );
  if (disposition === 'attachment') {
    // A same-origin navigation keeps the download out of JS entirely: no blob,
    // no copy of the bytes in memory, nothing for an XSS payload to exfiltrate.
    window.location.assign(grant.url);
    return grant;
  }
  window.open(grant.url, '_blank', 'noopener,noreferrer');
  return grant;
}
