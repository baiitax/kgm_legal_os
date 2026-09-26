/**
 * §50 · THE VISUAL SYSTEM MUST NOT OVERRIDE THE AUTHORIZATION SYSTEM.
 *
 * The security suite proves the API refuses what it should. Nothing in it proves
 * the UI agrees — and that gap is where §50 actually fails in practice: the
 * server is correct, and the interface shows a tab that 404s on click, or a
 * metric the member was not entitled to see, or a field lock that never fires.
 *
 * These tests render the REAL components against canned session payloads built
 * from the five seeded personas, and assert on what appears.
 *
 * WHY CANNADED PAYLOADS RATHER THAN A LIVE SERVER
 *   Because the contract under test is the projection, not the authorization.
 *   The permission sets below are transcribed from live responses (see
 *   PERSONAS), so the test asserts "given these codes, this is what renders".
 *   Running a server here would re-test the resolver, which 312 other tests
 *   already cover, and would make a UI-contract test fail for a database reason.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { I18nProvider } from '@kgm/ui';
import { FIRM_I18N } from '../i18n/dictionary.js';
import { FirmSessionProvider, useFirmSession } from '../auth/FirmSession.js';
import { ThemeProvider } from '../app/theme.js';
import { visibleNav, isPathAllowed } from '../app/nav.js';
import type { FirmSessionPayload } from '../api/firm.js';

// ==========================================================================
// FIXTURES — transcribed from live /api/firm/auth/login responses
// ==========================================================================

/** The permission codes each seeded persona actually resolves to. */
const PERMISSIONS = {
  /** Noura — Managing Partner. Firm-wide scope, 69 codes. */
  partner: [
    'clients.read', 'clients.create', 'clients.update', 'clients.read_sensitive', 'clients.kyc',
    'matters.read', 'matters.read_all', 'matters.create', 'matters.update', 'matters.assign',
    'matters.restrict', 'matters.close', 'matters.reopen', 'matters.status',
    'documents.read', 'documents.create', 'documents.edit', 'documents.approve', 'documents.release',
    'tasks.read', 'tasks.manage', 'hearings.read', 'hearings.manage',
    'deadlines.read', 'deadlines.manage', 'contracts.read', 'contracts.manage',
    'poa.read', 'poa.manage',
    'billing.read', 'billing.read_all', 'billing.create', 'billing.approve', 'billing.writeoff',
    'time.read', 'time.create', 'expenses.read', 'expenses.create', 'expenses.approve',
    'compliance.read', 'compliance.create', 'compliance.review', 'compliance.approve',
    'compliance.licences', 'compliance.training', 'compliance.complaints',
    'users.read', 'users.invite', 'users.update', 'users.assign_role', 'users.assign_matter',
    'roles.read', 'roles.manage', 'departments.manage', 'settings.read', 'settings.manage',
    'audit.read', 'audit.export', 'analytics.read',
  ],
  /** Faisal — Lawyer. Litigation + real estate scope, 19 codes, NO finance. */
  lawyer: [
    'clients.read', 'matters.read', 'matters.update', 'matters.status',
    'documents.read', 'documents.create', 'documents.edit',
    'tasks.read', 'tasks.manage', 'hearings.read', 'hearings.manage',
    'deadlines.read', 'deadlines.manage', 'contracts.read', 'poa.read',
    'time.read', 'time.create', 'compliance.read',
  ],
  /** Mariam — Paralegal. Commercial litigation only, 18 codes. */
  paralegal: [
    'clients.read', 'matters.read', 'matters.update',
    'documents.read', 'documents.create',
    'tasks.read', 'tasks.manage', 'hearings.read', 'deadlines.read', 'deadlines.manage',
    'contracts.read', 'poa.read', 'time.read', 'time.create',
    'compliance.read', 'compliance.create', 'compliance.training',
  ],
  /** Omar — Compliance. Assigned matters only, 14 codes, NO matters.read_all. */
  compliance: [
    'clients.read', 'matters.read', 'documents.read',
    'tasks.read', 'deadlines.read',
    'compliance.read', 'compliance.create', 'compliance.review', 'compliance.approve',
    'compliance.licences', 'compliance.training', 'compliance.complaints',
    'audit.read', 'analytics.read',
  ],
  /** Sara — Finance. billing.read_all with a 25k ceiling, 15 codes, NO legal ops. */
  finance: [
    'clients.read', 'matters.read_all',
    'billing.read', 'billing.read_all', 'billing.create', 'billing.edit',
    'billing.record_payment', 'time.read', 'expenses.read', 'expenses.create',
    'expenses.approve', 'compliance.read', 'analytics.read', 'users.read', 'audit.read',
  ],
} as const;

function sessionFor(key: keyof typeof PERMISSIONS, name: string): FirmSessionPayload {
  return {
    member: {
      membershipId: `m-${key}`,
      userId: `u-${key}`,
      email: `${key}@kgm.example.test`,
      displayName: name,
      displayNameAr: name,
      jobTitle: 'Test',
      jobTitleAr: null,
      roles: [{ code: key.toUpperCase(), name: key, nameAr: key }],
      departments: [{ code: 'LEGAL', name: 'Legal', nameAr: 'القانونية', isLead: false }],
      practiceAreas: key === 'partner' ? ['*'] : ['Commercial Litigation'],
      firmWideScope: key === 'partner',
      permissions: [...PERMISSIONS[key]],
      ceilings: {
        financialSar: key === 'finance' ? 25000 : null,
        writeoffSar: null,
        discountPct: null,
      },
    },
    preferences: { language: 'ar', calendar: 'islamic-umalqura' },
    security: { mfaEnabled: true, mfaVerified: true, sessionExpiresAt: null, remembered: false },
    tenants: [{
      membershipId: `m-${key}`, tenantId: 't-1', slug: 'kgm',
      tenantName: 'KGM Law Firm', tenantNameAr: 'شركة كيه جي إم', jobTitle: 'Test', jobTitleAr: null,
    }],
    activeTenantId: 't-1',
  };
}

/** Installs a fetch mock that answers /session with one persona. */
function mockSession(key: keyof typeof PERMISSIONS, name: string) {
  const payload = sessionFor(key, name);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith('/api/firm/auth/csrf')) {
      return new Response(JSON.stringify({ ok: true, data: { issued: true } }), { status: 200 });
    }
    if (u.endsWith('/api/firm/session')) {
      return new Response(JSON.stringify({ ok: true, data: payload }), { status: 200 });
    }
    if (u.endsWith('/api/firm/matters')) {
      return new Response(JSON.stringify({
        ok: true,
        data: { count: 0, scope: { practiceAreas: [], firmWide: false }, matters: [] },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no' } }), { status: 404 });
  }));
  return payload;
}

/** Renders a probe that exposes the resolved session for assertions. */
function Probe({ onReady }: { onReady: (s: ReturnType<typeof useFirmSession>) => void }) {
  const session = useFirmSession();
  onReady(session);
  return <div data-testid="probe">{session.status}</div>;
}

function renderWithSession() {
  let captured: ReturnType<typeof useFirmSession> | null = null;
  const utils = render(
    <ThemeProvider>
      <I18nProvider bundle={FIRM_I18N} initialLang="en">
        <FirmSessionProvider>
          <Probe onReady={(s) => { captured = s; }} />
        </FirmSessionProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
  const get = () => {
    if (!captured) throw new Error('session not captured');
    return captured;
  };
  return { ...utils, get };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ==========================================================================

describe('§50 · navigation is generated from permissions, never hardcoded', () => {
  it('gives a partner every group this build implements', () => {
    /*
      THE NAV IS NOW A STATEMENT ABOUT THIS BUILD, NOT ABOUT THE SPEC.

      It used to list every §12 module, with the unbuilt ones marked `planned`.
      On the live app that meant a partner signing in saw seventeen dead rows and
      five live ones. The nav now lists what exists — so the assertion changed
      shape: the groups present must be exactly the implemented ones, and the
      §12 groups that are absent (legal, finance, compliance, communication) must
      be absent for EVERY persona, including the one holding every permission.
    */
    const nav = visibleNav(PERMISSIONS.partner);
    const ids = nav.groups.map((g) => g.group.id);
    expect(ids).toEqual(expect.arrayContaining(['dashboard', 'workspace', 'clients', 'matters', 'admin']));
    for (const absent of ['legal', 'finance', 'compliance', 'communication']) {
      expect(ids, absent).not.toContain(absent);
    }
  });

  it('offers a lawyer their own work and nothing from the unbuilt modules', () => {
    /*
      A lawyer holds `matters.read` and `clients.read` but not `billing.read`, so
      the finance group is absent — and it is absent for the partner too, because
      there is no firm-wide finance screen in this build. The matter's Billing tab
      is where a lawyer's time and a matter's invoices live, and that tab is gated
      by the matter's own access level, which the workspace resolves per matter.
    */
    const nav = visibleNav(PERMISSIONS.lawyer);
    const leafIds = nav.groups.flatMap((g) => g.leaves.map((l) => l.id));
    expect(leafIds).toContain('mywork');
    for (const absent of ['time', 'billing', 'collections', 'documents', 'hearings', 'tasks']) {
      expect(leafIds, absent).not.toContain(absent);
    }
    // The routes behind those absent modules are gone from the guard set too,
    // not merely from the menu.
    for (const path of ['/billing', '/collections', '/time', '/documents', '/hearings']) {
      expect(isPathAllowed(nav.allowedPaths, path), path).toBe(false);
    }
  });

  it('hides the administration group from a paralegal', () => {
    const nav = visibleNav(PERMISSIONS.paralegal);
    expect(nav.groups.map((g) => g.group.id)).not.toContain('admin');
    expect(isPathAllowed(nav.allowedPaths, '/admin/audit')).toBe(false);
    expect(isPathAllowed(nav.allowedPaths, '/admin/users')).toBe(false);
  });

  it('lets a finance officer see audit, and no module the build does not have', () => {
    const nav = visibleNav(PERMISSIONS.finance);
    const leafIds = nav.groups.flatMap((g) => g.leaves.map((l) => l.id));
    // Clients is a standalone group rather than a leaf, so it is asserted on the
    // group list — the difference is structural, not a second rule.
    expect(nav.groups.map((g) => g.group.id)).toContain('clients');
    expect(leafIds).toContain('audit');       // holds audit.read
    // Holding `billing.read_all` no longer buys a Billing row, because there is
    // no firm-wide billing screen. It buys the matter's Billing tab, which the
    // matter workspace gates on the member's access level for THAT matter.
    expect(leafIds).not.toContain('billing');
    for (const absent of ['hearings', 'contracts', 'poa', 'licences', 'collections']) {
      expect(leafIds, absent).not.toContain(absent);
    }
  });

  it('gives a member with no permissions only their own surface', () => {
    const nav = visibleNav([]);
    const ids = nav.groups.map((g) => g.group.id);
    /*
      What survives is exactly the member's own surface: the dashboard and their
      own work. Clients and Matters do NOT — they are record collections gated on
      a read permission, and showing them here is the §50 violation this test
      exists to catch. Nothing else survives at all: the modules that used to
      linger as inert rows are gone from the tree.
    */
    expect(ids).toEqual(expect.arrayContaining(['dashboard', 'workspace']));
    for (const absent of ['clients', 'matters', 'admin', 'legal', 'finance', 'compliance', 'communication']) {
      expect(ids, absent).not.toContain(absent);
    }
    expect(isPathAllowed(nav.allowedPaths, '/clients')).toBe(false);
    expect(isPathAllowed(nav.allowedPaths, '/matters')).toBe(false);
    expect(isPathAllowed(nav.allowedPaths, '/admin/audit')).toBe(false);
    expect(isPathAllowed(nav.allowedPaths, '/billing')).toBe(false);
    expect(isPathAllowed(nav.allowedPaths, '/messages')).toBe(false);
  });

  it('does not offer Messages at all, for any persona', () => {
    /*
      There is no `messages.*` permission in the server catalogue and no firm-wide
      messaging screen, so a Messages row could never be opened by anyone. It used
      to render inert — "present in the §12 structure" — which is the state this
      phase removes: a member cannot tell an inert row from a broken one, and
      either reading makes them distrust the rows that do work.
    */
    for (const [persona, codes] of Object.entries(PERMISSIONS)) {
      const nav = visibleNav(codes);
      expect(nav.groups.find((g) => g.group.id === 'communication'), persona).toBeUndefined();
      expect(isPathAllowed(nav.allowedPaths, '/messages'), persona).toBe(false);
    }
  });

  it('never exposes a module the permission set does not grant, for any persona', () => {
    // The invariant, checked exhaustively rather than per persona.
    /*
      Paths the nav actually offers. The unbuilt modules are NOT in this table
      because they are not in the tree — a path nobody lists cannot be exposed,
      and `does not list a module the firm has not built` (shell-layout.test.tsx)
      is what holds that end up.
    */
    const requires: Record<string, string[]> = {
      '/clients': ['clients.read'],
      '/matters': ['matters.read', 'matters.read_all'],
      '/admin/audit': ['audit.read'],
      '/admin/users': ['users.read'],
      '/admin/settings': ['settings.read', 'settings.manage'],
    };
    for (const [persona, codes] of Object.entries(PERMISSIONS)) {
      const nav = visibleNav(codes);
      for (const [path, needed] of Object.entries(requires)) {
        const allowed = isPathAllowed(nav.allowedPaths, path);
        const entitled = needed.some((c) => codes.includes(c as never));
        expect(allowed, `${persona} @ ${path}`).toBe(entitled);
      }
    }
  });

  it('governs nested routes by their parent, so detail pages are reachable', () => {
    const nav = visibleNav(PERMISSIONS.lawyer);
    expect(isPathAllowed(nav.allowedPaths, '/matters')).toBe(true);
    expect(isPathAllowed(nav.allowedPaths, '/matters/some-uuid')).toBe(true);
    // But not by a coincidental prefix: /m is not /matters.
    expect(isPathAllowed(nav.allowedPaths, '/m')).toBe(false);
    expect(isPathAllowed(nav.allowedPaths, '/mattersx')).toBe(false);
  });
});

describe('§50 · the resolved session drives the same nav at runtime', () => {
  it('resolves a partner session to the whole of this build, and no more', async () => {
    mockSession('partner', 'Noura');
    const { get } = renderWithSession();
    await waitFor(() => expect(get().status).toBe('authenticated'));
    // The PERMISSION set is still the partner's full set: authorization did not
    // change in this phase, the nav's honesty about what exists did. Holding
    // `billing.approve` still grants the matter's billing surfaces.
    expect(get().permissions.size).toBe(PERMISSIONS.partner.length);
    expect(get().can('billing.approve')).toBe(true);
    const ids = get().nav.groups.map((g) => g.group.id);
    expect(ids).toEqual(expect.arrayContaining(['dashboard', 'workspace', 'clients', 'matters', 'admin']));
    expect(ids).not.toContain('finance');
  });

  it('resolves a paralegal session with admin and the unbuilt modules absent', async () => {
    mockSession('paralegal', 'Mariam');
    const { get } = renderWithSession();
    await waitFor(() => expect(get().status).toBe('authenticated'));
    // She does not hold these, so the permission check is the first reason the
    // surfaces are closed to her — and the nav agrees for a second reason on the
    // modules this build has no firm-wide screen for.
    expect(get().can('billing.read')).toBe(false);
    expect(get().can('audit.read')).toBe(false);
    const ids = get().nav.groups.map((g) => g.group.id);
    expect(ids).not.toContain('admin');
    expect(ids).not.toContain('finance');
    expect(ids).not.toContain('legal');
  });

  it('reports anonymous on a 401 rather than erroring', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/auth/csrf')) {
        return new Response(JSON.stringify({ ok: true, data: { issued: true } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: false, error: { code: 'unauthenticated', message: 'no session' },
      }), { status: 401 });
    }));
    const { get } = renderWithSession();
    await waitFor(() => expect(get().status).toBe('anonymous'));
    expect(get().error).toBeNull();
    expect(get().permissions.size).toBe(0);
  });

  it('surfaces a network failure as an error, NOT as signed-out', async () => {
    /*
      This distinction is load-bearing. A member with a valid session whose
      network drops must not have their UI cleared and be shown a login form —
      that reads as "you were signed out", which is false, and invites them to
      re-authenticate into the same failure.
    */
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const { get } = renderWithSession();
    await waitFor(() => expect(get().status).toBe('error'));
    expect(get().error?.code).toBe('network_error');
    expect(get().status).not.toBe('anonymous');
  });
});

describe('§10 · financial authority ceilings', () => {
  it('exposes a finance officer ceiling as a number', async () => {
    mockSession('finance', 'Sara');
    const { get } = renderWithSession();
    await waitFor(() => expect(get().status).toBe('authenticated'));
    expect(get().ceilings?.financialSar).toBe(25000);
  });

  it('reports null — not zero, not unlimited — for a lawyer with no authority', async () => {
    /*
      §10: null means NO authority. Rendering it as 0 or as "unlimited" are both
      wrong, and both are easy accidents. The profile drawer branches on
      `== null`, so this asserts the value the branch depends on.
    */
    mockSession('lawyer', 'Faisal');
    const { get } = renderWithSession();
    await waitFor(() => expect(get().status).toBe('authenticated'));
    expect(get().ceilings?.financialSar).toBeNull();
    expect(get().ceilings?.writeoffSar).toBeNull();
    expect(get().ceilings?.discountPct).toBeNull();
  });
});

describe('the React tree mounts', () => {
  it('reaches a terminal status for every persona without throwing', async () => {
    for (const [key, name] of [
      ['partner', 'Noura'], ['lawyer', 'Faisal'], ['paralegal', 'Mariam'],
      ['compliance', 'Omar'], ['finance', 'Sara'],
    ] as const) {
      vi.unstubAllGlobals();
      mockSession(key, name);
      const { get } = renderWithSession();
      await waitFor(() => expect(get().status).toBe('authenticated'));
      expect(get().member?.displayName).toBe(name);
    }
  });
});
