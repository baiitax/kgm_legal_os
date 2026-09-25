/**
 * §16/§18 · THE BOTTOM NAV MUST NOT SHRINK, SPILL OR LIE.
 *
 * jsdom performs no layout, so a test here cannot measure the bar. What it can
 * do — and what the bug actually was — is assert the declarations the layout
 * depends on, and assert the consequences that are observable in the DOM:
 *
 *  1. THE PILL IS CENTRED BY ONE EDGE AND A TRANSFORM.
 *     `inset-inline: 50%` sets both ends, which resolves a fixed box with
 *     `width: auto` to zero width; the five items then overflowed a background
 *     that had no width to give. `translate: -50%` could not rescue it, because
 *     it offsets by half of a box whose width was zero. This is a one-line
 *     declaration with a silent, layout-only failure, which is exactly the kind
 *     a stylesheet test should pin.
 *
 *  2. THE ITEMS MAY SHRINK, AND THE LABELS TRUNCATE.
 *     `min-inline-size: 56px` on every item demanded 280px plus gaps and padding
 *     inside a pill capped 28px narrower than that on a 320px phone. Items that
 *     cannot shrink and cannot fit spill out of the rounded background. The
 *     floor is now raised only where there is room for it.
 *
 *  3. A PLANNED MODULE IS NEVER A DESTINATION.
 *     Every nav leaf that is not `planned` must have a screen, and every leaf
 *     that IS planned must be inert. A nav that offers a link the app cannot
 *     render is the "0 functioning page" complaint: it is not a missing feature,
 *     it is a promise the interface made and broke.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { I18nProvider } from '@kgm/ui';
import { FIRM_I18N } from '../i18n/dictionary.js';
import { NAV_TREE } from '../app/nav.js';
import { BottomNav } from '../shell/BottomNav.js';
import { FirmSessionProvider } from '../auth/FirmSession.js';
import { ThemeProvider } from '../app/theme.js';

const CSS = readFileSync(resolve(__dirname, '../shell/shell.css'), 'utf8');
const APP = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

/**
 * The declaration block for a selector, so assertions read as CSS and not regex.
 *
 * Comments are stripped first. Several of the rules below carry a comment that
 * names the very declaration that was removed — "`inset-inline: 50%` sets both
 * ends" — and matching against the raw text would fail on the explanation rather
 * than on the code.
 */
function rule(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  return stripComments(CSS.slice(start, CSS.indexOf('}', start)));
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every permission the nav tree knows about, so the mock session unlocks all of it. */
const EVERY_PERMISSION = [...new Set(NAV_TREE.flatMap((g) => [
  ...g.permissions,
  ...g.leaves.flatMap((l) => l.permissions),
]))];

/**
 * A minimal authenticated session, so the nav resolves to the same tree a
 * signed-in member would see. Stubbed at the network boundary rather than by
 * faking the context: the filtering under test lives in the provider's
 * derivation from the server's permission codes.
 */
function mockSession() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ ok: status < 400, data }), { status });
    if (u.endsWith('/api/firm/auth/csrf')) return json({ issued: true });
    if (u.endsWith('/api/firm/session')) {
      // The shape below is transcribed from a live /api/firm/auth/login response
      // (see authorization.test.tsx, which keeps the same fixture). Keeping the
      // two identical matters: a fixture that drifts from the server's payload
      // makes this test pass on data the product never produces.
      return json({
        member: {
          membershipId: 'm-all', userId: 'u-all', email: 'all@kgm.example.test',
          displayName: 'All Permissions', displayNameAr: 'كل الصلاحيات',
          jobTitle: 'Test', jobTitleAr: null,
          roles: [{ code: 'MANAGING_PARTNER', name: 'Managing Partner', nameAr: 'شريك منتدب' }],
          departments: [{ code: 'LEGAL', name: 'Legal', nameAr: 'القانونية', isLead: false }],
          practiceAreas: ['*'], firmWideScope: true,
          permissions: [...EVERY_PERMISSION],
          ceilings: { financialSar: null, writeoffSar: null, discountPct: null },
        },
        preferences: { language: 'ar', calendar: 'islamic-umalqura' },
        security: { mfaEnabled: true, mfaVerified: true, sessionExpiresAt: null, remembered: false },
        tenants: [{
          membershipId: 'm-all', tenantId: 't-1', slug: 'kgm', tenantName: 'KGM Law Firm',
          tenantNameAr: 'شركة كيه جي إم', jobTitle: 'Test', jobTitleAr: null,
        }],
        activeTenantId: 't-1',
      });
    }
    return json({}, 404);
  }));
}

describe('§16 · the floating bottom nav', () => {
  it('is centred by one edge, not by both', () => {
    const pill = rule('.kgm-bottomnav');
    expect(pill).toContain('inset-inline-start: 50%');
    // The defect: both ends set, which collapses the box to zero width.
    expect(pill).not.toMatch(/inset-inline:\s*50%/);
    expect(pill).toContain('translate: -50% 0');
  });

  it('lets the items shrink, and puts the comfortable floor back only when it fits', () => {
    const item = rule('.kgm-bottomnav__item');
    expect(item).toContain('min-inline-size: 0');

    // The 56px floor returns at 420px, where five of them plus chrome fit.
    const wide = CSS.slice(CSS.indexOf('@media (min-width: 420px)'));
    expect(wide).toContain('min-inline-size: 56px');

    // The pill may use nearly the full viewport; a cap tighter than the items'
    // own minimum is what forced the overflow.
    const pill = rule('.kgm-bottomnav');
    expect(pill).toContain('max-inline-size: calc(100vw - 12px)');
  });

  it('truncates a label rather than letting it wrap and change the bar height', () => {
    const label = rule('.kgm-bottomnav__label');
    expect(label).toContain('text-overflow: ellipsis');
    expect(label).toContain('white-space: nowrap');
    expect(label).toContain('overflow: hidden');
  });

  it('docks to an edge in short landscape, where a floating pill costs too much height', () => {
    expect(CSS).toContain('@media (max-width: 899px) and (max-height: 480px)');
    const docked = CSS.slice(CSS.indexOf('@media (max-width: 899px) and (max-height: 480px)'));
    expect(docked).toContain('inset-block-end: 0');
    expect(docked).toContain('translate: none');
    expect(docked).toContain('safe-area-inset-bottom');
  });

  beforeEach(() => { vi.unstubAllGlobals(); });

  it('renders every label inside the truncating wrapper, and only reachable slots', async () => {
    mockSession();

    const { container } = render(
      <ThemeProvider>
        <I18nProvider bundle={FIRM_I18N} initialLang="en">
          <FirmSessionProvider>
            <BottomNav path="/" onNavigate={() => {}} onOpenMore={() => {}} />
          </FirmSessionProvider>
        </I18nProvider>
      </ThemeProvider>,
    );

    // The bar is derived from the permission-filtered nav, so it appears once
    // the session resolves rather than on first paint.
    await waitFor(() => {
      expect(container.querySelectorAll('.kgm-bottomnav__item').length).toBe(5);
    });

    const items = [...container.querySelectorAll('.kgm-bottomnav__item')];
    // Five slots: Home, three flexible, More — §16's fixed shape.
    expect(items.length).toBe(5);

    // Every item wraps its text, or one long translation would wrap and the
    // pill would change height between screens.
    for (const item of items) {
      const label = item.querySelector('.kgm-bottomnav__label');
      expect(label).toBeTruthy();
      expect(label!.textContent!.trim().length).toBeGreaterThan(0);
    }

    // §50: no slot may be a module the app cannot render. Home and More are
    // controls, not destinations, so only the middle three are checked.
    const flexible = items.slice(1, 4);
    for (const slot of flexible) {
      expect(slot.getAttribute('data-planned')).toBeNull();
    }
  });
});

describe('§50 · the nav only offers destinations the app can render', () => {
  /**
   * Every path the router answers. Read from App.tsx rather than restated, so
   * adding a screen without adding it to the nav — or the reverse — fails here.
   */
  const ROUTED = new Set(
    [...APP.matchAll(/case '([^']+)':/g)].map((m) => m[1]).concat(['/', '/matters/:id']),
  );

  /**
   * Enumerated from the nav TREE, not from a regex over its source.
   *
   * A text scan has to guess where an entry ends, and it guessed wrong in both
   * directions: a comment long enough to push `planned: true` out of the window
   * made a planned group look live, and a short leaf borrowed the `planned` flag
   * of the entry after it. The tree is the data the rail actually renders, so
   * asking it is both simpler and the thing under test.
   */
  const LEAVES = NAV_TREE.flatMap((group) => [
    // A childless group is itself a destination.
    ...(group.leaves.length === 0 ? [{ to: group.to ?? '/', planned: !!group.planned }] : []),
    ...group.leaves.map((leaf) => ({ to: leaf.to, planned: !!leaf.planned })),
  ]);

  it('finds the nav leaves it is meant to be checking', () => {
    expect(LEAVES.length).toBeGreaterThan(20);
    expect(ROUTED.size).toBeGreaterThan(4);
  });

  it('has a screen for every module the nav presents as reachable', () => {
    const broken = LEAVES
      .filter((leaf) => !leaf.planned && !ROUTED.has(leaf.to))
      .map((leaf) => leaf.to);
    // A non-planned leaf with no route is a link that goes nowhere, which is
    // exactly what a member experiences as "the page does not work".
    expect(broken).toEqual([]);
  });

  it('does not mark a module planned that the app can actually render', () => {
    const needlessly = LEAVES
      .filter((leaf) => leaf.planned && ROUTED.has(leaf.to))
      .map((leaf) => leaf.to);
    // The opposite drift: a working screen hidden behind an "in development"
    // badge, which reads as a missing feature and is worse than the dead link.
    expect(needlessly).toEqual([]);
  });
});
