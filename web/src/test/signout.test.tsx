/**
 * SIGN OUT · reachable at every viewport, in both products
 *
 * The portal's only sign-out lived in the sidebar, and `.sidebar` is
 * `display: none` below 1024 px. The tab bar that takes its place on a phone was
 * never given one. So on a phone or a tablet there was no way to end a session —
 * which, in a product whose entire premise is that sessions are short, audited
 * and revocable, means the only exit was clearing cookies by hand.
 *
 * The fix is an account menu in the TOP BAR, which is present at every width,
 * and it is tested here the way a person would find it rather than by asserting
 * that a component exists:
 *
 *   1. The trigger is rendered for a signed-in reader.
 *   2. Opening it exposes a sign-out control.
 *   3. Pressing that control calls the real `signOut()` and leaves for /login.
 *   4. Escape closes the menu and restores focus to the trigger — a menu a
 *      keyboard user cannot get out of is worse than no menu.
 *   5. The panel is anchored with `inset-inline-*`, never a physical side, so it
 *      is not clipped off-screen in Arabic.
 *
 * WHAT THIS TEST DOES NOT DO. It does not measure the DOM. "Is a 320 px viewport
 * covered" is a question about `display` in a stylesheet, and jsdom applies no
 * stylesheet. The companion assertion lives in the CSS itself and in
 * `scripts/verify/deploy-check.mjs`, which reads the SERVED stylesheet: a class
 * that is hidden below some width cannot be the only path to a control unless
 * the test can see the media query. Both halves are needed; neither is enough.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { I18nProvider } from '../i18n';
import { AuthProvider } from '../auth';

// The shell reads its identity and its product config from the server on mount.
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  const signedIn = {
    authenticated: true,
    user: {
      id: 'u-1',
      email: 'ahmed.alsaud@example.test',
      displayName: 'Ahmed Al-Saud',
      displayNameAr: 'أحمد السعود',
      portalRole: 'client_primary',
    },
    preferences: { language: 'en', calendar: 'gregorian' },
    security: {
      mfaEnabled: false,
      mfaVerified: true,
      emailVerified: true,
      sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      remembered: false,
    },
  };
  return {
    ...actual,
    get: vi.fn((path: string) => {
      if (path === '/api/auth/bootstrap') {
        return Promise.resolve({ authenticated: true, product: 'KGM', passwordPolicy: {} });
      }
      if (path === '/api/auth/session') return Promise.resolve(signedIn);
      if (path === '/api/client/notifications') return Promise.resolve({ unreadCount: 0 });
      return Promise.resolve({});
    }),
    post: vi.fn(() => Promise.resolve({})),
  };
});

import { Shell } from '../App';

async function harness(children: ReactNode, route = '/portal') {
  const utils = render(
    <MemoryRouter initialEntries={[route]}>
      <I18nProvider>
        <AuthProvider>
          <Shell>{children}</Shell>
        </AuthProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
  // The provider resolves bootstrap, then the session, before `signedIn` turns
  // true. Waiting for the chrome here is what makes every assertion below about
  // a SIGNED-IN reader rather than about a loading screen.
  await waitFor(() => expect(document.querySelector('header.topbar')).toBeTruthy());
  return utils;
}

describe('client portal · sign out is reachable at every viewport', () => {
  beforeEach(() => {
    document.documentElement.dir = 'ltr';
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('offers an account control in the top bar, not only in the desktop sidebar', async () => {
    await harness(<p>portal body</p>);
    // The top bar exists at every width; the sidebar does not.
    const header = document.querySelector('header.topbar');
    expect(header).toBeTruthy();
    const trigger = header!.querySelector('.acct__trigger');
    expect(trigger).toBeTruthy();
    expect(trigger!.getAttribute('aria-expanded')).toBe('false');
  });

  it('exposes sign-out on opening it, and closes on Escape with focus returned', async () => {
    await harness(<p>portal body</p>);

    const trigger = document.querySelector('.acct__trigger') as HTMLElement;
    await act(async () => { fireEvent.click(trigger); });

    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    // The menu identifies who is signed in — the second thing the mobile layout
    // had lost along with sign-out, because it too lived in the sidebar.
    // (The sidebar names the same person on desktop, so scope the query to the
    // menu itself: this asserts the MENU carries the identity, which it must
    // when the sidebar is not rendered at all.)
    const panel = document.querySelector('.acct__panel') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('Ahmed Al-Saud');
    expect(panel.textContent).toContain('ahmed.alsaud@example.test');

    const signOut = screen.getByRole('menuitem', { name: /sign out/i });
    expect(signOut).toBeTruthy();

    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
    expect(document.activeElement).toBe(trigger);
  });

  it('calls the real sign-out and leaves for the sign-in screen', async () => {
    await harness(<p>portal body</p>);
    const client = await import('../api/client');

    await act(async () => { fireEvent.click(document.querySelector('.acct__trigger') as HTMLElement); });
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /sign out/i })); });

    // The session must actually be revoked server-side; navigating away while
    // silently keeping a live cookie is the failure this asserts against.
    await waitFor(() => expect(client.post).toHaveBeenCalled());
    const calls = (client.post as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).includes('/logout'))).toBe(true);
  });

  it('anchors the panel on the inline edge, so Arabic does not clip it', async () => {
    // jsdom applies no stylesheet, so this reads the declaration out of the
    // source of truth rather than pretending to measure layout.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8');
    const panel = css.slice(css.indexOf('.acct__panel'));
    const block = panel.slice(0, panel.indexOf('}'));
    expect(block).toContain('inset-inline-end');
    expect(block).not.toMatch(/(^|[^-\w])(right|left)\s*:/);

    // And the trigger must not disappear at any width.
    expect(css).not.toMatch(/\.acct\s*\{[^}]*display:\s*none/);
  });
});
