/**
 * THE FIRM RAIL AND BAR · §10, §12, §16, §17, §50
 *
 * Three changes are asserted here, and each one is a claim about what the
 * navigation surface owes a member:
 *
 *   1. THE RAIL SAYS WHOSE REACH IT DESCRIBES. It is the surface that decides
 *      what a member may open, and it never stated who they were. In a product
 *      that is multi-tenant from day one — where the same person holds a
 *      different role in each firm and a different ring depending on their
 *      licence — a rail that omits the member, the role and the firm is asking
 *      the reader to guess which of their several selves is signed in.
 *
 *   2. BUILT MODULES COME FIRST. Most of this tree is `planned`, and Legal,
 *      Finance and Compliance are entirely so. Interleaved with the four modules
 *      that work, the rail read as a product that is mostly broken. Nothing is
 *      hidden and nothing is dropped: the split is a presentation of the same
 *      authorization-filtered tree, and this test proves both halves are present.
 *
 *   3. THE BAR'S DEFAULT IS PER PERSONA, AND STILL BOUNDED BY AUTHORIZATION.
 *      The bottom bar's first-day order was one array for every member, so a
 *      finance officer and a litigator were given the same three slots. The
 *      persona table changes that default and nothing else: usage still outranks
 *      it, and the authorised set still bounds it — the invariant the existing
 *      `bottomnav.test.tsx` holds, which is why that file still passes untouched.
 *
 * WHAT IS NOT ASSERTED HERE: anything about a member's PERMISSIONS. The rail
 * renders `nav`, which the session provider derives from `member.permissions`;
 * these tests stub the session at the network boundary and then assert only what
 * the rail does with what it was given.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { I18nProvider } from '@kgm/ui';
import { FIRM_I18N } from '../i18n/dictionary.js';
import { AppRail } from '../shell/AppRail.js';
import { BottomNav } from '../shell/BottomNav.js';
import { FirmSessionProvider } from '../auth/FirmSession.js';
import { ThemeProvider } from '../app/theme.js';

const CSS = readFileSync(resolve(__dirname, '../shell/shell.css'), 'utf8');

/* A partner's permission set: everything the chrome can offer, so the assertions
   below are about ORDER and PRESENTATION rather than about filtering — which is
   the other file's job. */
const ALL_PERMISSIONS = [
  'matters.read', 'matters.write', 'clients.read', 'documents.read', 'billing.read',
  'users.read', 'settings.read', 'audit.read', 'compliance.read', 'tasks.read',
];

interface PersonaOptions {
  readonly roles: readonly string[];
  readonly permissions?: readonly string[];
  readonly language?: 'ar' | 'en';
}

function mockSession({ roles, permissions = ALL_PERMISSIONS, language = 'en' }: PersonaOptions) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ ok: status < 400, data }), { status });
    if (u.endsWith('/api/firm/auth/csrf')) return json({ issued: true });
    if (u.endsWith('/api/firm/session')) {
      return json({
        member: {
          membershipId: 'm-nav', userId: 'u-nav', email: 'noura@kgm.example.test',
          displayName: 'Noura Al-Harbi', displayNameAr: 'نورة الحربي',
          jobTitle: 'Managing Partner', jobTitleAr: 'الشريك المدير',
          roles: roles.map((code) => ({ code, name: code, nameAr: code })),
          departments: [{ code: 'LEGAL', name: 'Legal', nameAr: 'الشؤون القانونية', isLead: true }],
          practiceAreas: [], firmWideScope: true,
          permissions: [...permissions],
          ceilings: { financialSar: null, writeoffSar: null, discountPct: null },
        },
        preferences: { language, calendar: 'gregorian' },
        security: { mfaEnabled: true, mfaVerified: true, sessionExpiresAt: null, remembered: false },
        tenants: [{
          membershipId: 'm-nav', tenantId: 't-nav', slug: 'kgm', tenantName: 'KGM Law Firm',
          tenantNameAr: 'شركة كيه جي إم للمحاماة', jobTitle: 'Managing Partner', jobTitleAr: null,
        }],
        activeTenantId: 't-nav',
      });
    }
    return json({}, 404);
  }));
}

function shell(children: React.ReactNode, language: 'ar' | 'en' = 'en') {
  return render(
    <ThemeProvider>
      <I18nProvider bundle={FIRM_I18N} initialLang={language}>
        <FirmSessionProvider>{children}</FirmSessionProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

async function renderRail(options: PersonaOptions) {
  mockSession(options);
  const utils = shell(<AppRail path="/" onNavigate={() => {}} />, options.language ?? 'en');
  // Wait for the TREE, not for the identity block: the block is deliberately
  // absent when the rail is collapsed, and a helper that waited for it would
  // hang on exactly the case this file asserts.
  await waitFor(() => expect(utils.container.querySelector('.kgm-rail__link')).toBeTruthy());
  return utils;
}

async function renderBar(options: PersonaOptions) {
  mockSession(options);
  const utils = shell(
    <BottomNav path="/" onNavigate={() => {}} onOpenMore={() => {}} />,
    options.language ?? 'en',
  );
  await waitFor(() =>
    expect(utils.container.querySelectorAll('.kgm-bottomnav__item').length).toBe(5));
  const labels = [...utils.container.querySelectorAll('.kgm-bottomnav__label')]
    .map((n) => n.textContent?.trim() ?? '');
  return { ...utils, labels, middle: labels.slice(1, 4) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

// ==========================================================================

describe('§12 · the rail states the identity the tree below it depends on', () => {
  it('names the member, the role and the firm', async () => {
    const { container } = await renderRail({ roles: ['MANAGING_PARTNER'] });
    const identity = container.querySelector('.kgm-rail__identity') as HTMLElement;

    expect(identity.querySelector('.kgm-rail__identityname')?.textContent).toBe('Noura Al-Harbi');
    expect(identity.querySelector('.kgm-rail__identityrole')?.textContent).toContain('Managing Partner');
    // The department and the firm, because both change what the tree can reach:
    // a department scopes the counterparties, the firm scopes everything.
    expect(identity.querySelector('.kgm-rail__identityfirm')?.textContent)
      .toBe('Legal · at KGM Law Firm');
  });

  it('renders the Arabic name, role and firm in Arabic, without translating either', async () => {
    const { container } = await renderRail({ roles: ['MANAGING_PARTNER'], language: 'ar' });
    const identity = container.querySelector('.kgm-rail__identity') as HTMLElement;

    expect(identity.querySelector('.kgm-rail__identityname')?.textContent).toBe('نورة الحربي');
    expect(identity.querySelector('.kgm-rail__identityrole')?.textContent).toContain('الشريك المدير');
    // "at" is translated; the firm's own name is not — it is a proper noun.
    expect(identity.querySelector('.kgm-rail__identityfirm')?.textContent)
      .toContain('شركة كيه جي إم للمحاماة');
  });

  it('shows two roles for a member who holds two, rather than picking one', async () => {
    const { container } = await renderRail({ roles: ['MANAGING_PARTNER', 'COMPLIANCE'] });
    const role = container.querySelector('.kgm-rail__identityrole')?.textContent ?? '';
    expect(role).toContain('MANAGING_PARTNER');
    expect(role).toContain('COMPLIANCE');
  });

  it('is hidden when the rail is collapsed, where there is no room for it', async () => {
    window.localStorage.setItem('kgm.firm.rail', 'collapsed');
    const { container } = await renderRail({ roles: ['LAWYER'] });
    expect(container.querySelector('.kgm-rail__identity')).toBeNull();
    // Collapsing hides labels, never items — the tree is still whole.
    expect(container.querySelectorAll('.kgm-rail__link').length).toBeGreaterThan(10);
  });
});

describe('§12 · built modules first, and nothing dropped', () => {
  it('renders every leaf it was given, split and never filtered', async () => {
    const { container } = await renderRail({ roles: ['MANAGING_PARTNER'] });
    const links = [...container.querySelectorAll('.kgm-rail__link')];
    const planned = links.filter((l) => l.getAttribute('data-planned') !== null);
    const built = links.filter((l) => l.getAttribute('data-planned') === null);

    expect(links.length).toBeGreaterThan(10);
    // Both halves exist — a rail that had silently dropped the unbuilt modules
    // would pass a weaker test and fail the product: §50 says nothing is hidden.
    expect(planned.length).toBeGreaterThan(0);
    expect(built.length).toBeGreaterThan(0);
  });

  it('puts the in-development label above the planned block, and only once per group', async () => {
    const { container } = await renderRail({ roles: ['MANAGING_PARTNER'] });
    const dividers = container.querySelectorAll('.kgm-rail__divider');
    expect(dividers.length).toBeGreaterThan(0);
    expect(dividers[0].textContent?.trim()).toBe('In development');

    // Within a group, nothing built follows the divider — that is the whole
    // point of the split, and the assertion a re-order would break.
    const groups = [...container.querySelectorAll('.kgm-rail__group')];
    for (const group of groups) {
      const children = [...group.querySelectorAll('.kgm-rail__list > li')];
      const dividerAt = children.findIndex((li) => li.classList.contains('kgm-rail__divider'));
      if (dividerAt === -1) continue;
      for (const after of children.slice(dividerAt + 1)) {
        const link = after.querySelector('.kgm-rail__link');
        if (link) expect(link.getAttribute('data-planned')).not.toBeNull();
      }
    }
  });

  it('keeps the divider out of the collapsed rail, where a text rule has no room', async () => {
    window.localStorage.setItem('kgm.firm.rail', 'collapsed');
    const { container } = await renderRail({ roles: ['LAWYER'] });
    expect(container.querySelector('.kgm-rail__divider')).toBeNull();
  });

  it('styles the identity block from tokens, so it cannot drift from the design system', () => {
    const block = CSS.slice(CSS.indexOf('.kgm-rail__identity {'));
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toContain('var(--surface-1)');
    expect(rule).toContain('var(--line-soft)');
    // No hardcoded colour: the identity block sits on the rail, which is the one
    // surface that changes between dark and light themes by itself.
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe('§16/§17 · the bottom bar defaults by persona, and only as a default', () => {
  it('gives a lawyer the legal order on their first day', async () => {
    // The persona names Tasks third, and Tasks is `planned` — so the third slot
    // falls to the next reachable module. What is asserted is the ORDER the
    // persona asked for, as far as the built set can honour it.
    const { middle } = await renderBar({ roles: ['LAWYER'] });
    expect(middle).toEqual(['Matters', 'My Work', 'Clients']);
  });

  it('gives an administrator the tools they live in, not the litigation order', async () => {
    // Two personas, same authorised set, different first day. The administrator's
    // order names Users and Settings ahead of Matters; the lawyer's order names
    // the modules a lawyer opens. The bars are genuinely different, which is the
    // entire claim of the persona table.
    const admin = await renderBar({ roles: ['ADMIN'] });
    const lawyer = await renderBar({ roles: ['LAWYER'] });
    expect(admin.middle).toEqual(['Users', 'Settings', 'Audit']);
    expect(lawyer.middle).toEqual(['Matters', 'My Work', 'Clients']);
    expect(admin.middle).not.toEqual(lawyer.middle);
  });

  it('leads a finance officer with the register of who owes, since Billing is not built yet', async () => {
    // The persona names Billing first, and Billing is `planned` — so it is not a
    // candidate at all, and the persona's next reachable module takes the slot.
    // This is the honest behaviour: the default describes the work, the
    // authorized-and-built set decides what can fill it.
    const { middle } = await renderBar({ roles: ['FINANCE'] });
    expect(middle[0]).toBe('Clients');
    expect(middle).not.toContain('Billing');
  });

  it('lets usage override the persona, exactly as it overrides the global order', async () => {
    window.localStorage.setItem('kgm.navuse.m-nav', JSON.stringify({ audit: 40, clients: 1 }));
    const { middle } = await renderBar({ roles: ['FINANCE'] });
    expect(middle[0]).toBe('Audit');
  });

  it('still refuses to promote a module the member may not reach', async () => {
    // The compliance persona names Audit FIRST; this member has no audit
    // permission. The default is consulted after the authorised set, never
    // before it — the same invariant the shared-device test in
    // `bottomnav.test.tsx` holds for usage.
    const { labels, middle } = await renderBar({
      roles: ['COMPLIANCE'],
      permissions: ['matters.read', 'clients.read', 'mywork.read'],
    });
    expect(labels).not.toContain('Audit');
    expect(middle).toEqual(['Clients', 'Matters', 'My Work']);
  });

  it('falls back to the designed order for a role the table does not name', async () => {
    const { middle } = await renderBar({ roles: ['SOMETHING_NEW'] });
    expect(middle).toEqual(['Matters', 'My Work', 'Clients']);
  });
});
