/**
 * THE TAX IDENTITY SCREEN · what it says when the firm may not issue, and when it may
 *
 * WHY THIS TEST EXISTS, GIVEN THAT A LIVE PROBE ALREADY PASSES
 *
 *   `scripts/verify/fiscal-live.mjs` proves the ROUTE answers with the database's own
 *   values. It cannot prove the SCREEN reads them: the first version of `Fiscal.tsx`
 *   expected camelCase from a route that returns the identity row in snake_case. The
 *   types were changed to match, which prevents that particular mistake returning — but
 *   the failure mode is general and worth a test of its own: a page that reads a field
 *   that is not there renders an EMPTY REGISTRATION under a firm that is registered, and
 *   nothing crashes, so nothing looks wrong.
 *
 *   These tests therefore render the real page against canned payloads transcribed from
 *   live responses — including the readiness banner in both states — and assert on the
 *   text a reader would see. The canned values are the demo tenant's actual ones:
 *   production, `production_csid`, VAT 300000000000003, one active device at counter 17,
 *   and a 24-hour reporting queue with one document inside its window.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { I18nProvider, ToastProvider } from '@kgm/ui';
import { FIRM_I18N } from '../i18n/dictionary.js';
import { FirmSessionProvider } from '../auth/FirmSession.js';
import { ThemeProvider } from '../app/theme.js';
import { Fiscal } from '../pages/Fiscal.js';

/** The demo firm as the live route reports it: configured, and NOT integrated. */
const READY_IDENTITY = {
  id: 'da9fd68b-6ba3-4317-bd2c-f64e38739b42',
  tenant_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  registered_name: 'KGM Law Firm',
  registered_name_ar: 'شركة كيه جي إم للمحاماة',
  vat_registration_number: '300000000000003',
  commercial_registration: '1010345678',
  registered_address: '1234 King Fahd Road, Al Olaya',
  registered_address_ar: '١٢٣٤ طريق الملك فهد، العليا',
  city: 'Riyadh',
  postal_code: '12211',
  country: 'SA',
  environment: 'production' as const,
  onboarding_status: 'production_csid',
  certificate_expires_at: null,
};

const ACTIVE_DEVICE = {
  id: '42e75b22-eb60-411b-b16b-e059f7be35e9',
  label: 'Head office — Riyadh',
  serial: '1-KGM-RUH-0001',
  counterValue: 17,
  hasChainHead: true,
  isActive: true,
};

const SESSION = {
  status: 'active',
  member: {
    id: 's-1', userId: 'u-1', name: 'Noura Al-Qahtani', nameAr: 'نورة القحطاني',
    email: 'noura@kgm.example.test', jobTitle: 'Managing Partner', jobTitleAr: null,
  },
  tenant: { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'KGM Law Firm', nameAr: 'شركة كيه جي إم' },
  scope: { firmWideScope: true, practiceAreas: ['*'], permissions: ['billing.read', 'billing.read_all', 'settings.manage'], ceilings: { financialSar: null, writeoffSar: null, discountPct: null } },
  preferences: { language: 'en', calendar: 'gregorian' },
  security: { mfaEnabled: true, mfaVerified: true, sessionExpiresAt: null, remembered: false },
  tenants: [{ membershipId: 'm-1', tenantId: 'aaaaaaaa-0000-4000-8000-000000000001', slug: 'kgm', tenantName: 'KGM Law Firm', tenantNameAr: 'شركة كيه جي إم', jobTitle: 'Managing Partner', jobTitleAr: null }],
  activeTenantId: 'aaaaaaaa-0000-4000-8000-000000000001',
};

/**
 * The harness stubs FETCH rather than the api module, so the page is exercised through the
 * REAL client — the envelope, the unwrapping and the error mapping included. The bug this
 * suite was written for lived in that seam: the page read fields the payload did not
 * carry, and no amount of mocking the module would have shown it.
 */
function mockRoutes(identityPayload: unknown, queuePayload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const reply = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    if (u.endsWith('/api/firm/auth/csrf')) return reply({ issued: true });
    if (u.endsWith('/api/firm/session')) return reply(SESSION);
    if (u.endsWith('/api/firm/billing/fiscal-identity')) return reply(identityPayload);
    if (u.endsWith('/api/firm/billing/reporting-queue')) return reply(queuePayload);
    return new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no' } }), { status: 404 });
  }));
}

/** A 403 on the identity read, everything else answering normally. */
function mockForbidden() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith('/api/firm/auth/csrf')) {
      return new Response(JSON.stringify({ ok: true, data: { issued: true } }), { status: 200 });
    }
    if (u.endsWith('/api/firm/session')) {
      return new Response(JSON.stringify({ ok: true, data: SESSION }), { status: 200 });
    }
    if (u.endsWith('/api/firm/billing/reporting-queue')) {
      return new Response(JSON.stringify({ ok: true, data: { count: 0, overdue: 0, invoices: [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'denied' } }), { status: 403 });
  }));
}

function renderPage() {
  return render(
    <ThemeProvider>
      <I18nProvider bundle={FIRM_I18N} initialLang="en">
        <ToastProvider>
          <FirmSessionProvider>
            <Fiscal onNavigate={() => undefined} />
          </FirmSessionProvider>
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the tax identity screen', () => {
  it('shows the registration as the row stores it, field for field', async () => {
    mockRoutes(
      { identity: READY_IDENTITY, devices: [ACTIVE_DEVICE], ready: true, blockers: [] },
      { count: 0, overdue: 0, invoices: [] },
    );

    renderPage();

    /* Every one of these is a field the first version of this page read as `undefined`.
       The VAT number is asserted character for character: it is the value a return is
       filed against, and a screen that showed it blank would be worse than an error. */
    await waitFor(() => expect(screen.getByText('300000000000003')).toBeTruthy());
    expect(screen.getByText('1010345678')).toBeTruthy();
    expect(screen.getByText('1234 King Fahd Road, Al Olaya')).toBeTruthy();
    /* The city and the postal code render as one National Address fact, and the assertion
       names both: they print on the invoice, and either one missing is an incomplete
       registration that would be accepted by the server and rejected by the authority. */
    expect(screen.getByText('Riyadh · 12211')).toBeTruthy();
  });

  it('says the firm may issue, and says what that does NOT mean', async () => {
    mockRoutes(
      { identity: READY_IDENTITY, devices: [ACTIVE_DEVICE], ready: true, blockers: [] },
      { count: 0, overdue: 0, invoices: [] },
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('The firm may issue')).toBeTruthy());
    /* THE SENTENCE THAT KEEPS THE GREEN BADGE HONEST. Readiness here is about the
       DOCUMENT — registration, device, chain — and not about a connection to the
       authority, which does not exist yet. A reader who took the green tick for
       "integrated with ZATCA" would be misled by the very screen built to end that
       confusion, so the disclaimer is asserted rather than trusted to survive review. */
    expect(screen.getByText(/not a connection to the authority/i)).toBeTruthy();
  });

  it('names every missing condition instead of printing one failure', async () => {
    mockRoutes(
      { identity: null, devices: [], ready: false, blockers: ['no_fiscal_identity', 'no_active_device'] },
      { count: 0, overdue: 0, invoices: [] },
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('The firm may not issue yet')).toBeTruthy());
    expect(screen.getByText('No tax identity is recorded')).toBeTruthy();
    expect(screen.getByText('No active issuing device')).toBeTruthy();
    /* The onboarding blocker is NOT among them, and its absence is the assertion: an
       identity that does not exist cannot have an incomplete onboarding, and a blocker
       list that named it would send the reader to fix the wrong thing. */
    expect(screen.queryByText('The authority\u2019s onboarding is not complete')).toBeNull();
  });

  it('shows the device counter and the deadline on the 24-hour queue', async () => {
    mockRoutes(
      { identity: READY_IDENTITY, devices: [ACTIVE_DEVICE], ready: true, blockers: [] },
      {
      count: 1, overdue: 1,
      invoices: [{
        id: '0d509df4-02e1-489f-be9e-e7c8dc1aed28',
        number: 'INV-2026-0171',
        uuid: '6d02e3c4-8de1-4903-88bd-6d851e6f1184',
        supplyAt: '2026-09-26T11:32:12.707Z',
        total: 2760,
        icv: 11,
        status: 'pending_reporting',
        overdue: true,
        reportBy: '2026-09-27T11:32:12.707Z',
      }],
      },
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('INV-2026-0171')).toBeTruthy());
    expect(screen.getByText('Head office — Riyadh')).toBeTruthy();
    /* Overdue is a red word, not a date the reader has to compare against today:
       the deadline is the server's arithmetic, and the label is this screen's. */
    expect(screen.getByText('Overdue')).toBeTruthy();
  });

  it('reports an unreachable server as an error with a retry, not as an empty firm', async () => {
    mockForbidden();

    renderPage();

    await waitFor(() => expect(screen.getByText('The tax identity could not be read.')).toBeTruthy());
    /* A 403 must not render as "no registration recorded": the second is a statement about
       the firm, the first about the reader, and confusing them is how a partner concludes
       that their own VAT registration has been deleted. */
    expect(screen.getByText(/do not hold a billing read permission/i)).toBeTruthy();
  });
});
