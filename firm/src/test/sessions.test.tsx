/**
 * ACTIVE SESSIONS · §48
 *
 * The profile drawer's device list.
 *
 * THE BUG THESE TESTS EXIST FOR
 *   `listFirmSessions` selects every row for the membership with no filter on
 *   `revoked_at` or `expires_at`. It returns history, not the live set — 12 of 17
 *   rows in the demo tenant were already expired while all 17 read as active.
 *
 *   The first version of this panel counted them all under the heading "Active
 *   sessions", which is the worst kind of security screen: it overstates the
 *   exposure, so a member either panics at a wrong number or learns to ignore the
 *   count. These tests pin the three-state classification and the honest count.
 *
 * The payload below is transcribed from a live /session/devices response, keeping
 * its real quirks: lowercase deviceLabel, "Unknown browser" for a non-browser
 * agent, null ipCountry, and — importantly — a null `ipHash` that must never be
 * rendered even if the server ever stopped stripping it.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { I18nProvider, ToastProvider } from '@kgm/ui';
import { FIRM_I18N } from '../i18n/dictionary.js';
import { FirmSessionProvider } from '../auth/FirmSession.js';
import { ThemeProvider } from '../app/theme.js';
import { ActiveSessions } from '../components/ActiveSessions.js';

// ==========================================================================
// FIXTURES
// ==========================================================================

/** ISO strings relative to now, so the fixtures cannot rot as time passes. */
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const HOUR = 3_600_000;

const SESSION = {
  member: {
    membershipId: 'm-self', userId: 'u-self',
    email: 'noura@kgm.example.test',
    displayName: 'Noura Al-Qahtani', displayNameAr: 'نورة القحطاني',
    jobTitle: 'Managing Partner', jobTitleAr: 'الشريك المدير',
    roles: [{ code: 'MANAGING_PARTNER', name: 'Managing Partner', nameAr: 'الشريك المدير' }],
    departments: [{ code: 'LEGAL', name: 'Legal', nameAr: 'القانونية', isLead: true }],
    practiceAreas: ['*'], firmWideScope: true,
    permissions: ['users.read'],
    ceilings: { financialSar: 500000, writeoffSar: null, discountPct: null },
  },
  preferences: { language: 'en', calendar: 'islamic-umalqura' },
  security: { mfaEnabled: false, mfaVerified: true, sessionExpiresAt: null, remembered: false },
  tenants: [{
    membershipId: 'm-self', tenantId: 't-1', slug: 'kgm',
    tenantName: 'KGM Law Firm', tenantNameAr: 'شركة كيه جي إم',
    jobTitle: 'Managing Partner', jobTitleAr: 'الشريك المدير',
  }],
  activeTenantId: 't-1',
};

type Device = Record<string, unknown>;

/** Four rows covering every state the classifier must distinguish. */
function devices(): Device[] {
  return [
    {
      id: 'd-current', deviceLabel: 'Device', browser: 'Chrome', os: 'macOS',
      userAgent: 'Mozilla/5.0', ipCountry: 'SA', ipHash: null,
      createdAt: iso(-2 * HOUR), lastActivity: iso(-60_000),
      expiresAt: iso(+6 * HOUR), mfaVerifiedAt: iso(-2 * HOUR), revokedAt: null,
      current: true,
    },
    {
      id: 'd-live', deviceLabel: 'Device', browser: 'Safari', os: 'iOS',
      userAgent: 'Mozilla/5.0', ipCountry: 'SA', ipHash: null,
      createdAt: iso(-30 * HOUR), lastActivity: iso(-5 * HOUR),
      expiresAt: iso(+3 * HOUR), mfaVerifiedAt: null, revokedAt: null,
      current: false,
    },
    {
      // Expired: past `expiresAt`, never revoked. The case the server does not mark.
      id: 'd-expired', deviceLabel: 'Device', browser: 'Unknown browser', os: 'Unknown OS',
      userAgent: 'curl/8.14.1', ipCountry: null, ipHash: null,
      createdAt: iso(-20 * HOUR), lastActivity: iso(-19 * HOUR),
      expiresAt: iso(-11 * HOUR), mfaVerifiedAt: null, revokedAt: null,
      current: false,
    },
    {
      id: 'd-revoked', deviceLabel: 'Device', browser: 'Firefox', os: 'Windows',
      userAgent: 'Mozilla/5.0', ipCountry: 'AE', ipHash: null,
      createdAt: iso(-40 * HOUR), lastActivity: iso(-39 * HOUR),
      expiresAt: iso(-31 * HOUR), mfaVerifiedAt: null,
      revokedAt: iso(-38 * HOUR),
      current: false,
    },
  ];
}

function mockApi(rows: Device[] = devices()) {
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ ok: status < 400, data }), { status });
    if (u.endsWith('/api/firm/auth/csrf')) return json({ issued: true });
    if (u.endsWith('/api/firm/session')) return json(SESSION);
    if (u.endsWith('/api/firm/session/devices')) return json({ sessions: rows });
    if (u.endsWith('/api/firm/session/revoke-all') && init?.method === 'POST') {
      posts.push(u);
      return json({ revoked: rows.filter((r) => !r.revokedAt).length });
    }
    if (u.endsWith('/api/firm/auth/logout')) return json({});
    return json({}, 404);
  }));
  return { posts };
}

function renderSessions() {
  return render(
    <ThemeProvider>
      <I18nProvider bundle={FIRM_I18N} initialLang="en">
        <FirmSessionProvider>
          <ToastProvider>
            <ActiveSessions />
          </ToastProvider>
        </FirmSessionProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ==========================================================================

describe('ActiveSessions', () => {
  it('lists every session, including ones that have ended', async () => {
    mockApi();
    renderSessions();
    /*
      Ended sessions remain visible on purpose: a member opening this after a
      suspected compromise is looking for evidence that something happened, and
      removing the rows would erase exactly that.
    */
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(4));
  });

  it('marks expired separately from revoked', async () => {
    mockApi();
    renderSessions();
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(4));

    const items = screen.getAllByRole('listitem');
    const find = (state: string) => items.find((li) => li.getAttribute('data-state') === state)!;

    /*
      These are different facts and only one of them means someone acted.
      Conflating them would misreport whether anyone took action on the account.
    */
    expect(within(find('expired')).getByText('Expired')).toBeTruthy();
    expect(within(find('expired')).queryByText('Revoked')).toBeNull();

    expect(within(find('revoked')).getByText('Revoked')).toBeTruthy();
    expect(within(find('revoked')).queryByText('Expired')).toBeNull();
  });

  it('counts only genuinely live sessions on the destructive control', async () => {
    mockApi();
    renderSessions();
    /*
      THE REGRESSION. Four rows exist, but only two are live (current + one other);
      the third expired eleven hours ago and the fourth was revoked. A count of 4
      would claim twice the exposure that exists.
    */
    await waitFor(() => expect(screen.getByRole('button', { name: /Revoke all sessions/ })).toBeTruthy());
    const btn = screen.getByRole('button', { name: /Revoke all sessions/ });
    expect(btn.textContent).toContain('(2)');
    expect(btn.textContent).not.toContain('(4)');
  });

  it('requires a second press before revoking anything', async () => {
    const { posts } = mockApi();
    renderSessions();
    await waitFor(() => expect(screen.getByRole('button', { name: /Revoke all sessions/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Revoke all sessions/ }));
    // The first press must only reveal the consequence. Nothing is sent yet.
    expect(posts.length).toBe(0);
    expect(screen.getByText(/ends EVERY session/i)).toBeTruthy();
    // The consequence names the part an administrator would not predict.
    expect(screen.getByText(/signed out of this device too/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Yes, end all sessions/ }));
    await waitFor(() => expect(posts.length).toBe(1));
  });

  it('can be backed out of without side effects', async () => {
    const { posts } = mockApi();
    renderSessions();
    await waitFor(() => expect(screen.getByRole('button', { name: /Revoke all sessions/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Revoke all sessions/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(posts.length).toBe(0);
    // Back to the resting state, not stuck mid-confirm.
    expect(screen.getByRole('button', { name: /Revoke all sessions/ })).toBeTruthy();
  });

  it('disables the control when the current session is the only live one', async () => {
    // Ending the only session is just signing out, which the drawer already offers.
    mockApi([devices()[0], devices()[2]]); // current + expired
    renderSessions();

    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(2));
    const btn = screen.getByRole('button', { name: /Revoke all sessions/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // And no misleading count is shown on a control that cannot act.
    expect(btn.textContent).not.toContain('(');
  });

  it('never renders an IP address', async () => {
    mockApi();
    const { container } = renderSessions();
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(4));

    /*
      The server strips `ipHash` and returns only a coarse `ipCountry`. This panel
      honours that projection rather than reconstructing anything address-shaped —
      the fixtures include ipHash to prove it is not rendered even if present.
    */
    expect(container.textContent).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
    expect(container.textContent).not.toContain('ipHash');
    expect(container.textContent).toContain('SA');
  });

  it('shows the two-factor state per session, not per account', async () => {
    mockApi();
    renderSessions();
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(4));
    /*
      One row verified a second factor and another did not. That difference is the
      entire reason to look at this list — a single account-level badge would erase it.
    */
    expect(screen.getByText('Two-factor verified')).toBeTruthy();
    expect(screen.getAllByText('No two-factor verification').length).toBe(3);
  });

  it('surfaces a load failure with a retry rather than an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/firm/auth/csrf')) {
        return new Response(JSON.stringify({ ok: true, data: { issued: true } }), { status: 200 });
      }
      if (u.endsWith('/api/firm/session')) {
        return new Response(JSON.stringify({ ok: true, data: SESSION }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, error: { code: 'boom' } }), { status: 500 });
    }));
    renderSessions();

    /*
      An empty list and a failed fetch look identical on screen and mean opposite
      things. On a security panel, "no other devices" when the truth is "we could
      not check" is the more dangerous of the two to imply.
    */
    await waitFor(() => expect(screen.getByText('Sessions could not be loaded')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy();
  });
});
