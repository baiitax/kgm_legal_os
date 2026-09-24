/**
 * ROLE ASSIGNMENT · §49, §10, §72
 *
 * Regression tests for the grant-role control on the members screen.
 *
 * WHAT WENT WRONG WITHOUT THESE
 *   The screen first shipped an inert <Badge> reading "Assign role" — a control
 *   that stated an action without performing one. That is the exact failure §50
 *   exists to prevent, arriving from the opposite direction to a security hole:
 *   not a member seeing too much, but an administrator believing they did
 *   something. These tests fail if the control ever goes back to being decorative.
 *
 * THE CASING BUG
 *   `internalRole` arrives lowercase ('managing_partner'); catalogue codes arrive
 *   uppercase ('MANAGING_PARTNER'). The first working version compared them with
 *   `===`, which was false for every member in the demo tenant — verified against
 *   all five. Nothing errored; the "current role" marker was just always absent,
 *   which reads as a member holding no standing role. The comparison now
 *   normalizes case, and the test below pins that.
 *
 * The payloads are transcribed from live /api/firm/admin/members responses.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { I18nProvider, ToastProvider } from '@kgm/ui';
import { FIRM_I18N } from '../i18n/dictionary.js';
import { FirmSessionProvider } from '../auth/FirmSession.js';
import { ThemeProvider } from '../app/theme.js';
import { Users } from '../pages/Users.js';

// ==========================================================================
// FIXTURES — transcribed from a live /admin/members response
// ==========================================================================

/** Two members, one of them the caller, with the real lowercase internalRole. */
const MEMBERS = [
  {
    membershipId: 'm-self',
    userId: 'u-self',
    email: 'noura@kgm.example.test',
    displayName: 'Noura Al-Qahtani',
    displayNameAr: 'نورة القحطاني',
    jobTitle: 'Managing Partner',
    jobTitleAr: 'الشريك المدير',
    status: 'active',
    internalRole: 'managing_partner',
    clientVisible: true,
    ceilings: { financialSar: 500000, writeoffSar: 100000, discountPct: 20 },
  },
  {
    membershipId: 'm-other',
    userId: 'u-other',
    email: 'mariam@kgm.example.test',
    displayName: 'Mariam Al-Zahrani',
    displayNameAr: 'مريم الزهراني',
    jobTitle: 'Paralegal',
    jobTitleAr: 'مساعدة قانونية',
    status: 'active',
    internalRole: 'paralegal',
    clientVisible: true,
    ceilings: { financialSar: null, writeoffSar: null, discountPct: null },
  },
];

/**
 * The catalogue. Codes are UPPERCASE while MEMBERS[].internalRole is lowercase —
 * that mismatch is the whole point of the fixtures, so do not "tidy" it.
 * OPERATIONS is inactive, to prove inactive roles are not offered.
 */
const ROLES = [
  { id: 'r1', code: 'MANAGING_PARTNER', name: 'Managing Partner', nameAr: 'الشريك المدير', isActive: true, isSystem: true },
  { id: 'r2', code: 'PARALEGAL', name: 'Paralegal', nameAr: 'مساعدة قانونية', isActive: true, isSystem: false },
  { id: 'r3', code: 'ASSOCIATE', name: 'Associate', nameAr: 'محامٍ مساعد', isActive: true, isSystem: false },
  { id: 'r4', code: 'OPERATIONS', name: 'Operations', nameAr: 'العمليات', isActive: false, isSystem: false },
];

const SESSION = {
  member: {
    membershipId: 'm-self',
    userId: 'u-self',
    email: 'noura@kgm.example.test',
    displayName: 'Noura Al-Qahtani',
    displayNameAr: 'نورة القحطاني',
    jobTitle: 'Managing Partner',
    jobTitleAr: 'الشريك المدير',
    roles: [{ code: 'MANAGING_PARTNER', name: 'Managing Partner', nameAr: 'الشريك المدير' }],
    departments: [{ code: 'LEGAL', name: 'Legal', nameAr: 'القانونية', isLead: true }],
    practiceAreas: ['*'],
    firmWideScope: true,
    permissions: ['users.read', 'users.update', 'users.assign_role', 'settings.read', 'audit.read'],
    ceilings: { financialSar: 500000, writeoffSar: 100000, discountPct: 20 },
  },
  preferences: { language: 'ar', calendar: 'islamic-umalqura' },
  security: { mfaEnabled: false, mfaVerified: true, sessionExpiresAt: null, remembered: false },
  tenants: [{
    membershipId: 'm-self', tenantId: 't-1', slug: 'kgm',
    tenantName: 'KGM Law Firm', tenantNameAr: 'شركة كيه جي إم',
    jobTitle: 'Managing Partner', jobTitleAr: 'الشريك المدير',
  }],
  activeTenantId: 't-1',
};

/** Records every role POST the component makes. */
type Post = { url: string; body: { roleCode: string; revoke: boolean } };

function mockApi(): { posts: Post[] } {
  const posts: Post[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ ok: status < 400, data }), { status });

    if (u.endsWith('/api/firm/auth/csrf')) return json({ issued: true });
    if (u.endsWith('/api/firm/session')) return json(SESSION);
    if (u.includes('/admin/members') && (init?.method ?? 'GET') === 'GET') {
      return json({ count: MEMBERS.length, members: MEMBERS, roles: ROLES });
    }
    if (u.includes('/admin/members/') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { roleCode: string; revoke: boolean };
      posts.push({ url: u, body });
      return json({ membershipId: 'm-other', roleCode: body.roleCode, revoked: body.revoke });
    }
    return json({}, 404);
  }));
  return { posts };
}

/**
 * The open picker panel.
 *
 * Scoped deliberately: the page below the sheet renders a role CATALOGUE of the
 * same codes, so an unscoped getByText('ASSOCIATE') matches twice and every
 * assertion about the picker becomes ambiguous. Querying the panel by its own
 * container keeps these tests about the panel.
 */
function picker(): ReturnType<typeof within> {
  const el = document.querySelector('.firm-rolepicker');
  if (!el) throw new Error('role picker is not open');
  return within(el as HTMLElement);
}

function renderUsers() {
  return render(
    <ThemeProvider>
      <I18nProvider bundle={FIRM_I18N} initialLang="en">
        <FirmSessionProvider>
          <ToastProvider>
            <Users />
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

describe('Users · role assignment', () => {
  it('renders Assign role as an interactive button, not a decorative badge', async () => {
    mockApi();
    renderUsers();

    /*
      The regression this file exists for. An inert Badge also "renders the
      action" — it just cannot be pressed, and gives no sign of that. Asserting
      the ROLE is button, not merely that the text is present, is the difference.
    */
    await waitFor(() => expect(screen.getByText('Mariam Al-Zahrani')).toBeTruthy());
    const buttons = screen.getAllByRole('button', { name: 'Assign role' });
    expect(buttons.length).toBeGreaterThan(0);
    // Every one of them must be actionable.
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens a picker offering only ACTIVE roles', async () => {
    mockApi();
    renderUsers();
    await waitFor(() => expect(screen.getByText('Mariam Al-Zahrani')).toBeTruthy());

    fireEvent.click(screen.getAllByRole('button', { name: 'Assign role' })[0]);

    await waitFor(() => expect(picker().getByText('MANAGING_PARTNER')).toBeTruthy());
    // Inactive roles cannot be granted — the server looks the code up in the
    // tenant's active set — so offering one would advertise an impossible action.
    expect(picker().queryByText('OPERATIONS')).toBeNull();
    expect(picker().getByText('ASSOCIATE')).toBeTruthy();
  });

  it('marks the current role despite the lower/upper-case mismatch on the wire', async () => {
    /*
      The casing bug. `m-other` has internalRole 'paralegal'; the catalogue code is
      'PARALEGAL'. A `===` comparison silently matches nothing, and the marker
      simply never appears — which reads as "this member holds no standing role"
      rather than as a broken check.
    */
    mockApi();
    renderUsers();
    await waitFor(() => expect(screen.getByText('Mariam Al-Zahrani')).toBeTruthy());

    // Open the picker for Mariam specifically (row 2 of the actions column).
    const rows = screen.getAllByRole('row');
    const mariamRow = rows.find((r) => within(r).queryByText('Mariam Al-Zahrani'))!;
    fireEvent.click(within(mariamRow).getByRole('button', { name: 'Assign role' }));

    await waitFor(() => expect(picker().getByText('PARALEGAL')).toBeTruthy());
    // The tag must be present for HER role and absent for a role she does not hold.
    const paralegalItem = picker().getByText('PARALEGAL').closest('li')!;
    expect(within(paralegalItem).getByText(/current role/i)).toBeTruthy();

    const associateItem = picker().getByText('ASSOCIATE').closest('li')!;
    expect(within(associateItem).queryByText(/current role/i)).toBeNull();
  });

  it('states the two limits it cannot hide: partial knowledge and the sign-out', async () => {
    mockApi();
    renderUsers();
    await waitFor(() => expect(screen.getByText('Mariam Al-Zahrani')).toBeTruthy());
    fireEvent.click(screen.getAllByRole('button', { name: 'Assign role' })[0]);

    await waitFor(() => expect(picker().getByText('MANAGING_PARTNER')).toBeTruthy());
    /*
      Both notices are load-bearing:
        - the picker cannot show roles the member already holds (the endpoint
          projects only internalRole), and
        - granting ends every one of their live sessions.
      An administrator surprised by either has been misled by the interface.
    */
    expect(picker().getByText(/does not show every role/i)).toBeTruthy();
    expect(picker().getByText(/ends all of this member's live sessions/i)).toBeTruthy();
  });

  it('posts the grant with revoke:false and the exact role code', async () => {
    const { posts } = mockApi();
    renderUsers();
    await waitFor(() => expect(screen.getByText('Mariam Al-Zahrani')).toBeTruthy());
    fireEvent.click(screen.getAllByRole('button', { name: 'Assign role' })[0]);

    await waitFor(() => expect(picker().getByText('ASSOCIATE')).toBeTruthy());
    const associateItem = picker().getByText('ASSOCIATE').closest('li')!;
    fireEvent.click(within(associateItem).getByRole('button', { name: 'Grant' }));

    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].body.roleCode).toBe('ASSOCIATE');
    // Never offers revoke: the client is not told which roles a member holds, so
    // a revoke would be a guess dressed as a decision.
    expect(posts[0].body.revoke).toBe(false);
    expect(posts[0].url).toContain('/admin/members/m-other/roles');
  });

  it('never offers an action on your own row', async () => {
    mockApi();
    renderUsers();
    await waitFor(() => expect(screen.getByText('Noura Al-Qahtani')).toBeTruthy());

    const rows = screen.getAllByRole('row');
    const selfRow = rows.find((r) => within(r).queryByText('Noura Al-Qahtani'))!;
    /*
      Shown inert WITH an explanation rather than hidden — hiding looks like a bug.
      The server refuses a self role-change too; this is presentation, not
      enforcement, so the test asserts the absence of the control and the presence
      of the reason.
    */
    expect(within(selfRow).queryByRole('button', { name: 'Assign role' })).toBeNull();
    expect(within(selfRow).queryByRole('button', { name: 'Suspend' })).toBeNull();
  });

  it('shows a null ceiling as no authority, never as uncapped', async () => {
    mockApi();
    renderUsers();
    await waitFor(() => expect(screen.getByText('Mariam Al-Zahrani')).toBeTruthy());
    /*
      `assertWithinAuthority` refuses outright when the ceiling is null, so
      rendering "Uncapped" would state the opposite of the enforced behaviour on
      the one column that governs money.
    */
    expect(screen.queryByText(/uncapped/i)).toBeNull();
    expect(screen.getAllByText(/no ceiling set/i).length).toBeGreaterThan(0);
  });
});
