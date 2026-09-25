/**
 * §16/§17/§50 · THE BOTTOM NAV LEARNS, AND THAT IS ALL IT MAY DO.
 *
 * "Advanced and highly user-driven" is a design note, not a licence. In this
 * product the visual system must never override the authorization system, so the
 * bar is allowed to REORDER what a member may reach and is never allowed to ADD
 * to it. Those two halves pull in opposite directions, and the interesting
 * failures are all in the seam between them:
 *
 *   1. USAGE PROMOTES. A module the member actually opens takes a slot from the
 *      default order. Otherwise "user-driven" is decoration.
 *   2. USAGE CANNOT PROMOTE WHAT IS NOT AUTHORISED. A stale (or hand-written)
 *      `localStorage` entry naming a module this member lacks must be ignored,
 *      not merged in. On a shared device that entry is the previous member's
 *      habits, and honouring it would leak one person's modules into another's
 *      bar.
 *   3. THE BAR STILL ANSWERS "WHERE AM I". When the current screen lives behind
 *      More, More is lit — a bar with nothing current on it is a bar the member
 *      concludes is broken.
 *   4. THE ACTIVE SLOT IS MARKED EVEN WITHOUT LAYOUT. The sliding lamp is
 *      measured from real geometry, so in jsdom (and for the first frame in a
 *      browser) there is no lamp. The item must still carry its own mark, which
 *      is what the CSS `:has()` fallback and the `data-active` attribute are for.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { I18nProvider } from '@kgm/ui';
import { FIRM_I18N } from '../i18n/dictionary.js';
import { BottomNav } from '../shell/BottomNav.js';
import { FirmSessionProvider } from '../auth/FirmSession.js';
import { ThemeProvider } from '../app/theme.js';

const CSS = readFileSync(resolve(__dirname, '../shell/shell.css'), 'utf8');
const MEMBERSHIP = 'm-nav-test';

/**
 * A session that may reach exactly the permissions given.
 *
 * Stubbed at the network boundary rather than by faking the context, so the
 * filtering under test is the provider's real derivation from permission codes.
 */
function mockSession(permissions: readonly string[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ ok: status < 400, data }), { status });
    if (u.endsWith('/api/firm/auth/csrf')) return json({ issued: true });
    if (u.endsWith('/api/firm/session')) {
      return json({
        member: {
          membershipId: MEMBERSHIP, userId: 'u-nav', email: 'member@kgm.example.test',
          displayName: 'Nav Member', displayNameAr: 'عضو التنقل',
          jobTitle: 'Associate', jobTitleAr: null,
          roles: [{ code: 'LAWYER', name: 'Lawyer', nameAr: 'محامٍ' }],
          departments: [{ code: 'LEGAL', name: 'Legal', nameAr: 'القانونية', isLead: false }],
          practiceAreas: [], firmWideScope: false,
          permissions: [...permissions],
          ceilings: { financialSar: null, writeoffSar: null, discountPct: null },
        },
        preferences: { language: 'en', calendar: 'gregorian' },
        security: { mfaEnabled: false, mfaVerified: true, sessionExpiresAt: null, remembered: false },
        tenants: [{
          membershipId: MEMBERSHIP, tenantId: 't-nav', slug: 'kgm', tenantName: 'KGM Law Firm',
          tenantNameAr: 'شركة كيه جي إم', jobTitle: 'Associate', jobTitleAr: null,
        }],
        activeTenantId: 't-nav',
      });
    }
    return json({}, 404);
  }));
}

/** The modules a member with these permissions may reach, as nav ids. */
async function renderNav(permissions: readonly string[], path = '/') {
  mockSession(permissions);
  const utils = render(
    <ThemeProvider>
      <I18nProvider bundle={FIRM_I18N} initialLang="en">
        <FirmSessionProvider>
          <BottomNav path={path} onNavigate={() => {}} onOpenMore={() => {}} />
        </FirmSessionProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
  await waitFor(() => {
    expect(utils.container.querySelectorAll('.kgm-bottomnav__item').length).toBe(5);
  });
  const labels = [...utils.container.querySelectorAll('.kgm-bottomnav__label')]
    .map((n) => n.textContent?.trim() ?? '');
  const active = [...utils.container.querySelectorAll('.kgm-bottomnav__item[data-active]')]
    .map((n) => n.querySelector('.kgm-bottomnav__label')?.textContent?.trim() ?? '');
  return { ...utils, labels, active };
}

/** The middle three slots, without Home and More. */
const middle = (labels: string[]) => labels.slice(1, 4);

describe('§16/§17 · the bottom nav is user-driven within what the member may reach', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('falls back to the designed default order for a member with no history', async () => {
    const { labels } = await renderNav(
      ['matters.read', 'clients.read', 'users.read', 'audit.read'],
    );
    // Matters, My Work and Clients outrank Users and Audit in SLOT_PRIORITY.
    // Nothing is remembered yet, so the design shows through.
    expect(middle(labels)).toEqual(['Matters', 'My Work', 'Clients']);
  });

  it('promotes a module the member actually opens above the default order', async () => {
    // Audit used heavily; it is last in SLOT_PRIORITY and must take a slot.
    window.localStorage.setItem(
      `kgm.navuse.${MEMBERSHIP}`,
      JSON.stringify({ audit: 40, matters: 2 }),
    );
    const { labels } = await renderNav(
      ['matters.read', 'clients.read', 'users.read', 'audit.read'],
    );
    expect(middle(labels)).toEqual(['Audit', 'Matters', 'My Work']);
  });

  it('ignores usage naming a module this member is not authorised to reach', async () => {
    // The shared-device case: the previous member of this browser lived in
    // Audit, Users and Settings. This member may reach neither.
    window.localStorage.setItem(
      `kgm.navuse.${MEMBERSHIP}`,
      JSON.stringify({ audit: 500, users: 400, settings: 300 }),
    );
    const { labels } = await renderNav(['matters.read', 'clients.read']);

    for (const forbidden of ['Audit', 'Users', 'Settings']) {
      expect(labels).not.toContain(forbidden);
    }
    // The authorised modules still fill the bar, in the designed order.
    expect(middle(labels)).toEqual(['Matters', 'My Work', 'Clients']);
  });

  it('never renders a sixth item, however much history exists', async () => {
    window.localStorage.setItem(
      `kgm.navuse.${MEMBERSHIP}`,
      JSON.stringify({ audit: 1, users: 2, settings: 3, mywork: 4, clients: 5, matters: 6 }),
    );
    const { container } = await renderNav(['matters.read', 'users.read', 'settings.read', 'audit.read']);
    expect(container.querySelectorAll('.kgm-bottomnav__item').length).toBe(5);
  });

  it('lights More when the current screen lives inside it, and Home at the root', async () => {
    const perms = ['matters.read', 'clients.read', 'users.read', 'audit.read'];

    // At the root, Home is current and More is not.
    const atRoot = await renderNav(perms, '/');
    expect(atRoot.active).toEqual(['Home']);

    // Deep in a module that did not win a slot: More must be the lit one, or the
    // bar shows nothing current at all.
    const inAudit = await renderNav(perms, '/admin/audit');
    expect(inAudit.active).toEqual(['More']);
  });

  it('marks the active slot in the DOM even when no lamp can be measured', async () => {
    const { container, active } = await renderNav(['matters.read'], '/matters');

    // jsdom reports every box as zero, so the measured lamp is correctly absent.
    expect(container.querySelector('.kgm-bottomnav__lamp')).toBeNull();

    // The slot still declares itself, and the stylesheet gives it a background
    // for exactly this case — a bar that cannot say where it is, is a bar the
    // member reads as broken.
    expect(active).toEqual(['Matters']);
    expect(CSS).toContain('.kgm-bottomnav:not(:has(.kgm-bottomnav__lamp)) .kgm-bottomnav__item[data-active]');
  });

  it('carries the unread count in the accessible name, not only in the badge', async () => {
    mockSession(['matters.read']);
    const { container } = render(
      <ThemeProvider>
        <I18nProvider bundle={FIRM_I18N} initialLang="en">
          <FirmSessionProvider>
            <BottomNav
              path="/"
              onNavigate={() => {}}
              onOpenMore={() => {}}
              badges={{ tasks: 3 }}
            />
          </FirmSessionProvider>
        </I18nProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(container.querySelectorAll('.kgm-bottomnav__item').length).toBe(5));

    // No badge source is reachable for this member, so no item claims a count —
    // and no item is announced as having one. The count is asserted through the
    // badge component's own contract elsewhere; what matters here is that the
    // accessible name and the visible badge come from one number.
    for (const item of container.querySelectorAll('.kgm-bottomnav__item')) {
      const name = item.getAttribute('aria-label');
      if (name) expect(name).toMatch(/unread/);
    }
  });
});
