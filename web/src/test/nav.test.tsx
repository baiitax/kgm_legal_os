/**
 * THE PORTAL'S NAVIGATION · one model, three surfaces, two roles
 *
 * The redesign exists because of a defect rather than a preference: the portal's
 * bottom bar was a fixed five tabs, the sidebar was a static four-group list, and
 * NINE of the fourteen authenticated destinations could not be reached on a phone
 * at all — hearings, deadlines, messages, appointments, notifications, receipts,
 * security and privacy. Meanwhile the portal held a `client_users.portal_role` in
 * every session and read it in no screen and no route.
 *
 * So the properties asserted here are the ones the redesign is FOR:
 *
 *   1. REACHABILITY. Every destination the member may open is reachable at every
 *      width: as a slot on the bar, or inside the More sheet. This is the defect
 *      itself, and it is asserted over the whole model rather than tab by tab,
 *      so a screen added later is covered without anyone remembering to.
 *   2. HONESTY. A contact is never offered a slot the server would refuse, and a
 *      destination that exists shows up for both roles.
 *   3. PARITY. The route table and the nav are one list. A header that says
 *      "Invoices" while the rail says "Overview" is how two lists drift, and the
 *      old portal had exactly two.
 *   4. THE RULE IS STATED ONCE. The capability sets are the only place the roles
 *      differ; the sidebar, the bar and the sheet are three renderings of them,
 *      and none of the three is allowed an opinion of its own.
 *
 * The companion assertion for the SERVER half of the role rule is in
 * `tests/security/portal-roles.test.ts` — a menu is not a control, so the four
 * money surfaces are refused by the API as well, with an audit row.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { hasMessage, I18nProvider } from '../i18n';
import { AuthProvider } from '../auth';
import {
  ALL_ITEMS, CAPABILITIES, DESTINATIONS, DETAIL_ITEMS, canOpen, capabilitiesFor, findItem,
  groupFor, visibleNav,
} from '../nav';

/* ------------------------------------------------------------ the session -- */

const session = vi.hoisted(() => ({
  role: 'client_primary' as 'client_primary' | 'client_contact',
}));

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    get: vi.fn((path: string) => {
      if (path === '/api/auth/bootstrap') {
        return Promise.resolve({ authenticated: true, product: 'KGM', passwordPolicy: {} });
      }
      if (path === '/api/auth/session') {
        return Promise.resolve({
          authenticated: true,
          user: {
            id: 'u-1',
            email: 'layla.mansour@example.test',
            displayName: 'Layla Mansour',
            displayNameAr: 'ليلى منصور',
            portalRole: session.role,
            jobTitle: 'Legal Affairs',
            clientName: 'Gulf Horizon Trading Co.',
            clientNameAr: 'شركة أفق الخليج التجارية',
          },
          preferences: { language: 'en', calendar: 'gregorian' },
          security: {
            mfaEnabled: false, mfaVerified: true, emailVerified: true,
            sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), remembered: false,
          },
        });
      }
      if (path === '/api/client/notifications') return Promise.resolve({ unreadCount: 3 });
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
  await waitFor(() => expect(document.querySelector('header.topbar')).toBeTruthy());
  return utils;
}

const navIds = (selector: string) =>
  [...document.querySelectorAll(selector)].map((n) => n.getAttribute('data-nav') ?? '');

beforeEach(() => { session.role = 'client_primary'; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// ==========================================================================

describe('the capability model · the portal has two roles and states them once', () => {
  it('gives the account holder the money and the contact the work', () => {
    expect([...capabilitiesFor('client_primary')].sort()).toEqual(
      ['account_admin', 'billing', 'privacy', 'self', 'work'],
    );
    expect([...capabilitiesFor('client_contact')].sort()).toEqual(['privacy', 'self', 'work']);
    expect(CAPABILITIES.client_contact).not.toContain('billing');
  });

  it('resolves an unknown role to the NARROW set, never the wide one', () => {
    // Unreachable today — the database CHECKs the two values — and written this
    // way anyway: a default that widens access is the one default that must
    // never be chosen. A third role added to the database without being added
    // here must not silently become an account holder.
    for (const role of [null, undefined, '', 'client_superuser', 'admin']) {
      expect(capabilitiesFor(role).has('billing')).toBe(false);
      expect(capabilitiesFor(role).has('work')).toBe(true);
    }
  });

  it('hides the money group from a contact and keeps everything else', () => {
    const holder = visibleNav('client_primary').groups.flatMap(({ items }) => items);
    const contact = visibleNav('client_contact').groups.flatMap(({ items }) => items);

    expect(holder.filter((i) => i.capability === 'billing').length).toBe(3);
    expect(contact.some((i) => i.capability === 'billing')).toBe(false);

    // Nothing else moved: the work, the diary and the account are identical.
    const nonBilling = (items: typeof holder) => items.filter((i) => i.capability !== 'billing').map((i) => i.id);
    expect(nonBilling(contact)).toEqual(nonBilling(holder));
  });

  it('drops a group that has nothing left in it', () => {
    // A heading over an empty list is how a menu tells a reader it is broken.
    const contact = visibleNav('client_contact');
    for (const { group, items } of contact.groups) {
      expect(items.length, `group ${group.id} rendered empty`).toBeGreaterThan(0);
    }
    expect(contact.groups.some(({ group }) => group.id === 'account_billing')).toBe(false);
  });

  it('never lets a member open a destination the capability set excludes', () => {
    const contact = visibleNav('client_contact');
    expect(canOpen(contact, '/portal/invoices')).toBe(false);
    expect(canOpen(contact, '/portal/invoices/abc')).toBe(false);
    expect(canOpen(contact, '/portal/matters')).toBe(true);
    expect(canOpen(visibleNav('client_primary'), '/portal/invoices')).toBe(true);
  });
});

describe('the model is one list · routing, titles and labels all come from it', () => {
  it('resolves a detail path to its section, not to the root', () => {
    // `/portal` is a prefix of every path, so a naive match would title every
    // screen "Home" — the longest match is what makes orientation correct.
    // A deep path resolves to its SECTION — which is what the header is asking.
    expect(findItem('/portal/matters/eeeeeeee-0001')?.id).toBe('matters');
    expect(findItem('/portal/messages/abc')?.id).toBe('messages');
    expect(findItem('/portal/invoices/inv-1')?.id).toBe('invoices');
    expect(groupFor('/portal/invoices/inv-1')?.id).toBe('account_billing');
    expect(groupFor('/portal/documents')?.id).toBe('matters');
    expect(findItem('/portal')?.id).toBe('dashboard');
  });

  it('keeps ids and paths unique, and gives every item a label in both languages', () => {
    const ids = ALL_ITEMS.map((i) => i.id);
    const paths = ALL_ITEMS.map((i) => i.to);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);

    // A nav entry whose key is missing from the dictionary renders as its own
    // key — "nav.matters" as a menu label. Checked here rather than trusted,
    // because a missing key is invisible in a language the writer does not read.
    for (const item of ALL_ITEMS) {
      expect(hasMessage(item.labelKey), `missing key ${item.labelKey}`).toBe(true);
    }
  });

  it('separates what the member routes to from what carries a parameter', () => {
    expect(DESTINATIONS.every((i) => !i.to.includes(':'))).toBe(true);
    expect(DETAIL_ITEMS.every((i) => i.to.includes(':'))).toBe(true);
    // Every detail path hangs off a destination, or the route guard would have
    // no section to inherit its capability from.
    for (const detail of DETAIL_ITEMS) {
      const parent = detail.to.split('/').slice(0, -1).join('/');
      expect(DESTINATIONS.some((d) => d.to === parent), `orphan detail ${detail.to}`).toBe(true);
    }
  });
});

describe('every destination is reachable on a phone · the defect this redesign fixes', () => {
  for (const role of ['client_primary', 'client_contact'] as const) {
    it(`covers each destination the ${role} may open, between the bar and the sheet`, async () => {
      session.role = role;
      await harness(<p>body</p>);

      const reachable = visibleNav(role).groups
        .flatMap(({ items }) => items)
        .filter((i) => !i.detail && i.to !== '/portal')
        .map((i) => i.id);
      expect(reachable.length).toBe(role === 'client_primary' ? 12 : 10);

      const inBar = new Set(navIds('.tabbar [data-nav]'));
      expect(inBar.size).toBe(5); // Home + three flexible + More

      // Open More the way a thumb does.
      const more = document.querySelector('.tabbar [data-nav="__more"]') as HTMLElement;
      await act(async () => { fireEvent.click(more); });

      const inSheet = new Set(navIds('.sheet [data-nav]'));
      const unreachable = reachable.filter((id) => !inBar.has(id) && !inSheet.has(id));
      expect(unreachable).toEqual([]);
    });
  }

  it('puts the account actions in the sheet, so sign-out is not only behind an avatar', async () => {
    await harness(<p>body</p>);
    await act(async () => {
      fireEvent.click(document.querySelector('.tabbar [data-nav="__more"]') as HTMLElement);
    });
    const sheet = document.querySelector('.sheet') as HTMLElement;
    expect(sheet).toBeTruthy();
    expect(sheet.textContent).toContain('Sign out');
    expect(sheet.textContent).toContain('All sections');
  });

  it('closes the sheet on Escape and returns focus to the slot that opened it', async () => {
    await harness(<p>body</p>);
    const more = document.querySelector('.tabbar [data-nav="__more"]') as HTMLElement;
    await act(async () => { fireEvent.click(more); });
    expect(document.querySelector('.sheet')).toBeTruthy();

    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
    await waitFor(() => expect(document.querySelector('.sheet')).toBeNull());
    expect(document.activeElement).toBe(more);
  });

  it('moves focus into the sheet, and cycles it rather than letting Tab escape', async () => {
    // A full-height overlay over a page that is still interactive is a layer a
    // keyboard user can tab OUT of and then operate blind. The cycle is the
    // contract the firm's overlay already keeps; this is it arriving here.
    await harness(<p>body</p>);
    await act(async () => {
      fireEvent.click(document.querySelector('.tabbar [data-nav="__more"]') as HTMLElement);
    });
    const sheet = document.querySelector('.sheet') as HTMLElement;
    expect(sheet.contains(document.activeElement)).toBe(true);

    const focusable = [...sheet.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    const last = focusable[focusable.length - 1];
    last.focus();
    await act(async () => { fireEvent.keyDown(document, { key: 'Tab' }); });
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusable[0]);
  });
});

describe('what the bar offers, it may actually open', () => {
  it('never gives a contact a money slot, and does give the holder one', async () => {
    session.role = 'client_contact';
    await harness(<p>body</p>);
    const contactBar = navIds('.tabbar [data-nav]');
    expect(contactBar).not.toContain('invoices');
    expect(contactBar).not.toContain('receipts');
    // The three flexible slots are filled from what remains.
    expect(contactBar.filter((id) => !['__more'].includes(id)).length).toBe(4);

    cleanup();
    session.role = 'client_primary';
    await harness(<p>body</p>);
    const holderBar = navIds('.navlink');
    expect(holderBar).toContain('invoices');
  });

  it('explains the money to a contact instead of hiding it', async () => {
    session.role = 'client_contact';
    await harness(<p>body</p>);
    await act(async () => {
      fireEvent.click(document.querySelector('.tabbar [data-nav="__more"]') as HTMLElement);
    });
    const sheet = document.querySelector('.sheet') as HTMLElement;
    // A destination that vanishes reads as a defect; one that states the rule
    // reads as a rule. The route refuses either way.
    expect(sheet.querySelector('[data-nav="invoices--locked"]')).toBeTruthy();
    expect(sheet.textContent).toContain('This section belongs to the account holder.');
  });
});

describe('the header at every width · orientation and the way out', () => {
  it('says which section the reader is in, and which client they act for', async () => {
    await harness(<p>body</p>, '/portal/matters');
    const header = document.querySelector('header.topbar') as HTMLElement;
    expect(header.querySelector('.topbar__where b')?.textContent).toBe('Matters');
    expect(header.querySelector('.topbar__where small')?.textContent).toBe('Gulf Horizon Trading Co.');
    expect(header.querySelector('.topbar__crumb')?.textContent).toBe('Matters');
  });

  it('titles a detail page by its section rather than by the client name', async () => {
    await harness(<p>body</p>, '/portal/matters/eeeeeeee-0001');
    const header = document.querySelector('header.topbar') as HTMLElement;
    expect(header.querySelector('.topbar__where b')?.textContent).toBe('Matters');
  });

  it('carries the unread count in the accessible name', async () => {
    await harness(<p>body</p>);
    const bell = document.querySelector('header.topbar .icon-btn') as HTMLElement;
    expect(bell.getAttribute('aria-label')).toContain('3');
  });

  it('names the portal role in the rail, and the entity the session acts for', async () => {
    await harness(<p>body</p>);
    const sidebar = document.querySelector('.sidebar') as HTMLElement;
    expect(sidebar.querySelector('.role-chip')?.textContent).toContain('Account holder');
    expect(sidebar.querySelector('.sidebar__entity')?.textContent).toBe('Gulf Horizon Trading Co.');
  });
});
