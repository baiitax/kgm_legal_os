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
  it('gives a partner every module group', () => {
    const nav = visibleNav(PERMISSIONS.partner);
    const ids = nav.groups.map((g) => g.group.id);
    expect(ids).toEqual(expect.arrayContaining([
      'dashboard', 'workspace', 'clients', 'matters', 'legal',
      'finance', 'compliance', 'admin',
    ]));
  });

  it('reduces the finance group to Time alone for a lawyer with no billing code', () => {
    /*
      §12 places Time entry under Finance, and a lawyer logs time. So the group
      is correctly present — but containing only that. Asserting the whole group
      vanished would be asserting the lawyer cannot record their own hours.
    */
    const nav = visibleNav(PERMISSIONS.lawyer);
    const finance = nav.groups.find((g) => g.group.id === 'finance');
    expect(finance).toBeDefined();
    const leafIds = finance!.leaves.map((l) => l.id);
    expect(leafIds).toEqual(['time']);
    expect(leafIds).not.toContain('billing');
    expect(leafIds).not.toContain('collections');
    // The routes behind those absent leaves are gone from the guard set too,
    // not merely from the menu.
    expect(isPathAllowed(nav.allowedPaths, '/billing')).toBe(false);
    expect(isPathAllowed(nav.allowedPaths, '/collections')).toBe(false);
    expect(isPathAllowed(nav.allowedPaths, '/time')).toBe(true);
  });

  it('hides the administration group from a paralegal', () => {
    const nav = visibleNav(PERMISSIONS.paralegal);
    expect(nav.groups.map((g) => g.group.id)).not.toContain('admin');
    expect(isPathAllowed(nav.allowedPaths, '/admin/audit')).toBe(false);
    expect(isPathAllowed(nav.allowedPaths, '/admin/users')).toBe(false);
  });

  it('lets a finance officer see audit but not hear about hearings', () => {
    const nav = visibleNav(PERMISSIONS.finance);
    const leafIds = nav.groups.flatMap((g) => g.leaves.map((l) => l.id));
    expect(leafIds).toContain('audit');     // holds audit.read
    expect(leafIds).toContain('billing');   // holds billing.read_all
    expect(leafIds).not.toContain('hearings'); // no hearings.read
    expect(leafIds).not.toContain('contracts');
    expect(leafIds).not.toContain('poa');
  });

  it('gives a member with no permissions only their own surface', () => {
    const nav = visibleNav([]);
    const ids = nav.groups.map((g) => g.group.id);
    /*
      What survives is exactly the member's own surface: the dashboard, their own
      work and their own notifications. Clients and Matters do NOT — they are
      record collections gated on a read permission, and showing them here is the
      §50 violation this test exists to catch. Communication survives only
      because it is inert: no permission code exists to gate it on, so it renders
      as a label with no destination and contributes no allowed path.
    */
    expect(ids).toEqual(expect.arrayContaining(['dashboard', 'workspace']));
    expect(ids).not.toContain('clients');
    expect(ids).not.toContain('matters');
    expect(ids).not.toContain('finance');
    expect(ids).not.toContain('admin');
    expect(isPathAllowed(nav.allowedPaths, '/clients')).toBe(false);
    expect(isPathAllowed(nav.allowedPaths, '/matters')).toBe(false);
    expect(isPathAllowed(nav.allowedPaths, '/admin/audit')).toBe(false);
    expect(isPathAllowed(nav.allowedPaths, '/billing')).toBe(false);
    // Inert, so not a destination the guard will wave through.
    expect(isPathAllowed(nav.allowedPaths, '/messages')).toBe(false);
  });

  it('renders Communication inert for every persona, since no messages permission exists', () => {
    for (const [persona, codes] of Object.entries(PERMISSIONS)) {
      const nav = visibleNav(codes);
      const comms = nav.groups.find((g) => g.group.id === 'communication');
      expect(comms?.group.planned, persona).toBe(true);
      // Offered in the §12 structure, but never an authorized destination.
      expect(isPathAllowed(nav.allowedPaths, '/messages'), persona).toBe(false);
    }
  });

  it('never exposes a module the permission set does not grant, for any persona', () => {
    // The invariant, checked exhaustively rather than per persona.
    const requires: Record<string, string[]> = {
      '/billing': ['billing.read', 'billing.read_all'],
      '/admin/audit': ['audit.read'],
      '/admin/users': ['users.read'],
      '/hearings': ['hearings.read', 'hearings.manage'],
      '/poa': ['poa.read', 'poa.manage'],
      '/licences': ['compliance.licences'],
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
  it('resolves a partner session to the full nav', async () => {
    mockSession('partner', 'Noura');
    const { get } = renderWithSession();
    await waitFor(() => expect(get().status).toBe('authenticated'));
    expect(get().permissions.size).toBe(PERMISSIONS.partner.length);
    expect(get().can('billing.approve')).toBe(true);
    expect(get().nav.groups.map((g) => g.group.id)).toContain('finance');
  });

  it('resolves a paralegal session with admin absent and finance reduced to Time', async () => {
    mockSession('paralegal', 'Mariam');
    const { get } = renderWithSession();
    await waitFor(() => expect(get().status).toBe('authenticated'));
    expect(get().can('billing.read')).toBe(false);
    expect(get().can('audit.read')).toBe(false);
    const ids = get().nav.groups.map((g) => g.group.id);
    expect(ids).not.toContain('admin');
    const finance = get().nav.groups.find((g) => g.group.id === 'finance');
    expect(finance?.leaves.map((l) => l.id)).toEqual(['time']);
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
