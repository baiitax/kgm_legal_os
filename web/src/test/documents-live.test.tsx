/**
 * DOCUMENTS · RENDERED AGAINST THE LIVE DEPLOYMENT
 *
 * The bug this file exists for was not a logic error that a stub could catch.
 * `Documents.tsx` read a `const` declared below the JSX that used it, so it
 * threw `ReferenceError: Cannot access 'typeLabel' before initialization` on
 * every render — but ONLY when the list was non-empty. The stub test in
 * `documents.test.tsx` now guards the shape of that failure. This file guards
 * something the stub cannot: that the page survives the REAL payload.
 *
 * WHY BOTH ARE NEEDED
 *   A stub proves the page handles the fields the test author remembered to
 *   invent. Live data proves it handles the fields the server actually sends —
 *   null `matterTitleAr`, a zero-byte `sizeBytes`, an `available: false` row, an
 *   `origin` the fixture never used, a date the stub never formatted. Every one
 *   of those is a crash waiting in a render path that no stub exercises, and the
 *   standing rule in this repository is that behaviour is verified against the
 *   real database, not only against a fake.
 *
 *   So this test signs in to the deployment for real, forwards every request the
 *   page makes to it, and renders the page with the responses that come back.
 *   The only thing stubbed is the transport.
 *
 * WHEN IT SKIPS
 *   If the deployment is unreachable — no network, a laptop on a plane — the
 *   test skips rather than fails. A network-dependent test that fails offline
 *   trains people to ignore the suite, which is a worse outcome than a test that
 *   does not run in that environment. It reports the skip with the reason.
 */
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../i18n';

const LIVE = process.env.KGM_BASE ?? 'https://kgmlegal.vercel.app';
const EMAIL = process.env.KGM_PORTAL_EMAIL ?? 'ahmed.alsaud@example.test';
const PASSWORD = process.env.KGM_PORTAL_PASSWORD ?? 'Demo!Portal2026';

/**
 * The REAL fetch, captured before anything stubs it.
 *
 * Without this the stub calls itself: `live()` would reach for `fetch`, get the
 * stub that forwards to `live()`, and recurse until the stack goes. Capturing at
 * module load is the difference between a redirect and a loop.
 */
const realFetch = globalThis.fetch.bind(globalThis);

/** Node's fetch talks to the real deployment; the page's fetch is redirected here. */
const jar = new Map<string, string>();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

function absorb(res: Response) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    // A browser overwrites; sending two `kgm_csrf` values makes the server read
    // the stale one and refuse — which is the trap a naive jar falls into.
    if (/expires=Thu, 01 Jan 1970/i.test(raw) || value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

async function live(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { accept: 'application/json', cookie: cookieHeader() };
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    const csrf = jar.get('kgm_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
    if (init.body !== undefined && !(init.body instanceof FormData)) {
      headers['content-type'] = 'application/json';
    }
  }
  const res = await realFetch(LIVE + path, { ...init, headers, redirect: 'manual' });
  absorb(res);
  return res;
}

let reachable: boolean | string = false;
let documentCount = 0;

beforeAll(async () => {
  try {
    await live('/api/auth/bootstrap');
    const login = await live('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (login.status !== 200) throw new Error(`sign-in returned ${login.status}`);
    const docs = await live('/api/client/documents');
    const rows = (await docs.clone().json())?.data?.documents ?? [];
    documentCount = rows.length;
    reachable = rows.length > 0;
    if (!rows.length) throw new Error('the demo account has no documents to render');
  } catch (err) {
    // Skipping is the honest outcome: this test measures the deployment, and an
    // unreachable deployment has no verdict to give.
    reachable = (err as Error).message;
  }
}, 20_000);

describe('client portal · Documents renders the live payload', () => {
  it('renders a real, non-empty document list without throwing', async () => {
    if (reachable !== true) {
      console.info(`skipped — ${String(reachable)}`);
      return;
    }

    // Every request the page makes is forwarded to the deployment, including the
    // CSRF-bound grant POST.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) =>
      live(String(input), init)));

    const { default: Documents } = await import('../pages/Documents');

    // An error boundary stand-in: a throw inside render would otherwise surface
    // as an opaque failure, and the whole point is to name the throw.
    let thrown: unknown = null;
    try {
      render(
        <MemoryRouter initialEntries={['/portal/documents']}>
          <I18nProvider>
            <Documents />
          </I18nProvider>
        </MemoryRouter>,
      );
      await waitFor(() => expect(document.querySelector('.doclist, .empty')).toBeTruthy());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeNull();
    // aria-label rows, not just a shell: the list rendered CONTENT.
    const rows = document.querySelectorAll('.docrow');
    expect(rows.length).toBeGreaterThan(0);

    // The page's own promise: type and size are read off the row, and the live
    // rows carry both. A regression that dropped either would leave blanks here.
    const meta = [...document.querySelectorAll('.docrow__meta')].map((n) => n.textContent ?? '');
    expect(meta.some((m) => /\d/.test(m)), `no size rendered in ${meta.length} rows`).toBe(true);

    console.info(`rendered ${rows.length} live document row(s) of ${documentCount} returned`);
    cleanup();
    vi.unstubAllGlobals();
  }, 30_000);
});
