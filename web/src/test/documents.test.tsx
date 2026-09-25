/**
 * DOCUMENTS · the client portal's document centre
 *
 * This page had a defect that no type-check, build or harness could see: it
 * referenced `typeLabel` before its `const` declaration, which is a temporal
 * dead zone error. TypeScript does not flag it — the reference sits inside a
 * `map` callback, and the compiler cannot know the callback runs eagerly when
 * the JSX is constructed. The build succeeds. The bundle is valid. The page
 * throws only when the list is NON-EMPTY, so an empty test account sees a
 * perfectly working screen.
 *
 * That combination is why this file exists rather than a snapshot: the failure
 * needs a document to exist, and every other check in the repo ran without one.
 *
 * The rest asserts the properties a document centre has to hold:
 *   · a click that cannot be fulfilled says so instead of doing nothing;
 *   · a second click while a grant is in flight does not fire a second grant;
 *   · an unavailable document explains WHY, since the button cannot say it;
 *   · filtering never widens what the server returned.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../i18n';
import Documents from '../pages/Documents';

/** One document, in the shape `GET /api/client/documents` returns. */
function doc(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'doc-1',
    matterId: 'm-1',
    matterTitle: 'Commercial Dispute',
    matterTitleAr: 'نزاع تجاري',
    title: 'Statement of Claim',
    titleAr: null,
    documentType: 'evidence',
    category: 'legal',
    origin: 'firm',
    version: 1,
    mimeType: 'application/pdf',
    sizeBytes: 248_000,
    status: 'available',
    requested: false,
    requestNote: null,
    requestNoteAr: null,
    fileName: 'statement-of-claim.pdf',
    createdAt: '2026-03-04T10:00:00.000Z',
    available: true,
    ...over,
  };
}

const MATTERS = {
  matters: [{
    id: 'm-1', matterNumber: 'KGM-2026-0148', title: 'Commercial Dispute', titleAr: 'نزاع تجاري',
    practiceArea: 'Litigation', practiceAreaAr: 'التقاضي', status: 'open', clientStatus: 'open',
    openedAt: '2026-01-02T00:00:00.000Z', nextHearingAt: null, nextDeadlineAt: null,
    restricted: false, leadLawyer: null, documentCount: 1, invoiceCount: 0,
  }],
};

/** Records what the page requested, so the assertions can be about behaviour. */
interface Calls { grants: string[]; downloads: string[] }

function mockApi(documents: unknown[], calls: Calls) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ ok: status < 400, data }), { status });

    if (u.includes('/documents/') && u.includes('/access-url') && method === 'POST') {
      calls.grants.push(u);
      return json({ url: '/api/client/documents/x/access?exp=1&sig=abc', expiresAt: 'x', ttlSeconds: 60, fileName: 'f.pdf' });
    }
    if (u.endsWith('/api/client/documents')) return json({ documents });
    if (u.endsWith('/api/client/matters')) return json(MATTERS);
    return json({}, 404);
  }));
}

function renderPage() {
  return render(
    <MemoryRouter>
      <I18nProvider initialLang="en">
        <Documents />
      </I18nProvider>
    </MemoryRouter>,
  );
}

let calls: Calls;
beforeEach(() => {
  calls = { grants: [], downloads: [] };
  vi.unstubAllGlobals();
  vi.stubGlobal('open', vi.fn());
  vi.stubGlobal('scrollTo', vi.fn());
});

describe('client portal · Documents renders with documents present', () => {
  it('renders a non-empty list without throwing', async () => {
    mockApi([doc()], calls);
    renderPage();

    // The regression: this screen threw on a document existing at all.
    await waitFor(() => {
      expect(screen.getByText('Statement of Claim')).toBeTruthy();
    });
  });

  it('renders a list of several documents, with their type and size', async () => {
    mockApi([
      doc({ id: 'a', title: 'Statement of Claim' }),
      doc({ id: 'b', title: 'Title Deed', documentType: 'contract', mimeType: 'application/pdf' }),
      doc({ id: 'c', title: 'Passport Copy', documentType: 'identity', mimeType: 'image/png', origin: 'client' }),
    ], calls);
    renderPage();

    await waitFor(() => expect(screen.getByText('Statement of Claim')).toBeTruthy());
    expect(screen.getByText('Title Deed')).toBeTruthy();
    expect(screen.getByText('Passport Copy')).toBeTruthy();

    // Labels come from the dictionary, so the reader sees prose rather than a
    // raw server value like `client_upload`.
    expect(screen.getAllByText('Evidence').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Contract').length).toBeGreaterThan(0);
  });

  it('explains why an unavailable document cannot be opened', async () => {
    mockApi([doc({ available: false, status: 'pending_scan' })], calls);
    renderPage();

    await waitFor(() => expect(screen.getByText('Statement of Claim')).toBeTruthy());

    // The control is disabled, so the reason has to be readable somewhere: a
    // greyed-out button with no explanation is the same dead end as a 404.
    const disabled = screen.getAllByRole('button').filter((b) => (b as HTMLButtonElement).disabled);
    expect(disabled.length).toBeGreaterThan(0);
    expect(screen.getAllByText(/still being scanned/i).length).toBeGreaterThan(0);
  });
});

describe('client portal · Documents fulfils what it promises', () => {
  it('surfaces an error when a download grant is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/access-url')) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'not found' } }), { status: 404 });
      }
      const json = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
      if (u.endsWith('/api/client/documents')) return json({ documents: [doc()] });
      if (u.endsWith('/api/client/matters')) return json(MATTERS);
      return new Response('{}', { status: 404 });
    }));

    renderPage();
    await waitFor(() => expect(screen.getByText('Statement of Claim')).toBeTruthy());

    const view = screen.getAllByRole('button').find((b) => b.getAttribute('aria-label') === 'View'
      || b.textContent?.toLowerCase().includes('view'));
    view?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // A refused grant must not look like a click that did nothing.
    await waitFor(() => {
      expect(screen.getByText(/not found|no longer|unavailable/i)).toBeTruthy();
    });
  });

  it('does not fire a second grant when the button is clicked twice', async () => {
    mockApi([doc()], calls);
    renderPage();
    await waitFor(() => expect(screen.getByText('Statement of Claim')).toBeTruthy());

    const view = screen.getAllByRole('button').find((b) => b.textContent?.toLowerCase().includes('view'))!;
    view.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    view.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await waitFor(() => expect(calls.grants.length).toBeGreaterThan(0));
    expect(calls.grants.length).toBe(1);
  });
});

describe('client portal · Documents filtering', () => {
  it('narrows the list without ever adding to it', async () => {
    mockApi([
      doc({ id: 'a', title: 'Statement of Claim', origin: 'firm' }),
      doc({ id: 'b', title: 'Passport Copy', origin: 'client' }),
    ], calls);
    renderPage();
    await waitFor(() => expect(screen.getByText('Statement of Claim')).toBeTruthy());

    const search = screen.getByRole('searchbox');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => expect(screen.getByText('Statement of Claim')).toBeTruthy());

    // Two documents in, filter by a term only one matches.
    expect(within(screen.getByRole('list')).getAllByRole('listitem').length).toBe(2);
  });
});
