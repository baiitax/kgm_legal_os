/**
 * THE FIRM DOOR, from the client portal's side.
 *
 * WHY THIS FILE EXISTS
 *   `/login` is the single sign-in screen for the whole product, so it has to be
 *   able to sign a firm member in as well as a client. That means posting to the
 *   firm OS's auth endpoints, which live at the same origin.
 *
 * WHY IT IS NOT A SHARED API CLIENT
 *   The two applications deliberately do not share an auth context, an API
 *   client or a route table, and this file does not change that. It shares no
 *   state with `api/client.ts`: a different CSRF cookie (`kgm_firm_csrf`, not
 *   `kgm_csrf`), a different error vocabulary, a different session cookie, and
 *   no `setUnauthorizedHandler` wiring into the portal's session. It reaches the
 *   firm's API over HTTP exactly as the firm SPA does, and it is used for one
 *   thing only — submitting the sign-in form.
 *
 * WHY THIS DOES NOT WEAKEN THE AUDIENCE BOUNDARY
 *   A form is not an authorization surface. The server decides who may sign in
 *   where, and it decides the same way no matter which page POSTs to it: a firm
 *   credential offered at the client door, or a client credential at the firm
 *   door, is refused with a refusal indistinguishable from a wrong password.
 *   Nothing here can be used to infer which door an account belongs to, because
 *   the caller has to DECLARE the audience before submitting — the page never
 *   guesses it from a server answer.
 */
import { ApiError } from './client';

/** The firm door's base path. Distinct from the portal's `/api/auth/*`. */
const FIRM = '/api/firm/auth';

/** The firm OS's own CSRF cookie name — not the portal's `kgm_csrf`. */
const CSRF_COOKIE = 'kgm_firm_csrf';

/** What the firm door returns on a successful first factor. */
export interface FirmLoginResult {
  readonly authenticated: boolean;
  /** Present instead of `authenticated` when the member must clear a second factor. */
  readonly mfaRequired?: boolean;
  readonly method?: string;
  readonly maskedDestination?: string;
  readonly expiresInMinutes?: number;
}

interface FirmErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown>; requestId?: string };
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Fetches a fresh double-submit token and lets the server set its cookie.
 *
 * Re-fetched per attempt rather than cached: a token that predates a server
 * restart fails as `csrf_failed`, and on a sign-in screen that is
 * indistinguishable from a wrong password — the member retypes a correct
 * password and is refused again. One extra request is cheaper than that.
 */
async function bootstrapCsrf(): Promise<string | null> {
  const res = await fetch(`${FIRM}/csrf`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { data?: { token?: string } } | null;
  // The server may return the token in the body, or only as a cookie.
  return body?.data?.token ?? readCookie(CSRF_COOKIE);
}

async function post<T>(path: string, payload: unknown): Promise<T> {
  const csrf = await bootstrapCsrf();

  let res: Response;
  try {
    res = await fetch(`${FIRM}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // Header name is fixed by the firm door's guard. Sent even when the
        // token is null so a missing cookie surfaces as a CSRF refusal rather
        // than as a silently different request shape.
        'x-csrf-token': csrf ?? '',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Status 0 is the client's convention for "never reached the server",
    // matching how the portal client reports a transport failure.
    throw new ApiError(0, 'network_error', 'Unable to reach the server');
  }

  const body = (await res.json().catch(() => null)) as (FirmErrorBody & { data?: T }) | null;

  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'internal_error',
      body?.error?.message ?? 'Sign-in failed',
      body?.error?.details,
      body?.error?.requestId,
    );
  }

  return (body?.data ?? ({} as T)) as T;
}

/** First factor. Throws `ApiError` on refusal, exactly like the portal's sign-in. */
export function firmSignIn(email: string, password: string, remember: boolean): Promise<FirmLoginResult> {
  return post<FirmLoginResult>('/login', { email, password, remember });
}

/** Second factor, when `firmSignIn` answered `mfaRequired`. */
export function firmSubmitMfa(code: string, remember: boolean): Promise<FirmLoginResult> {
  return post<FirmLoginResult>('/mfa/verify', { code, remember });
}

/**
 * Leaves for the firm application.
 *
 * A full document navigation rather than a client-side route: the firm OS is a
 * separate SPA served at `/firm`, and a router transition would only render
 * this app's own shell at that address. `replace` so the sign-in screen does not
 * sit in history behind a session that can no longer be signed out to.
 *
 * `next` carries the hash the member was trying to reach — the firm OS routes on
 * the hash, so a deep link from a bookmark or a shared link survives the detour
 * through the central sign-in instead of dropping them on the dashboard.
 */
export function enterFirmApp(next?: string | null): void {
  // Only a same-app hash is accepted. Anything else — an absolute URL, a
  // protocol-relative `//evil.example`, a value with a newline — is discarded
  // rather than navigated to, so `?next=` cannot be used to bounce a member off
  // the product from a link they were sent.
  const safe = typeof next === 'string' && /^#[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*$/.test(next) ? next : '';
  window.location.replace(`/firm${safe}`);
}
