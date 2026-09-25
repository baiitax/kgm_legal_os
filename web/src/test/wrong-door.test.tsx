/**
 * WRONG DOOR · what the portal says when the credentials are not its own
 *
 * A member of the firm signing in at the client portal is refused. That
 * refusal is correct and must stay indistinguishable from a wrong password —
 * anything that varies with whether the account is real is an existence
 * oracle, and the portal door has already shipped that defect once (a 403
 * thrown after the password verified).
 *
 * But correct and comprehensible are different things. The screen that
 * reported the refusal headed it "The request could not be completed", which
 * describes a broken service. A reader who has been handed a credential list
 * does not conclude "I am at the wrong door"; they conclude the deployment is
 * broken, and go looking for the bug. That is what these tests pin down:
 *
 *   1. A refused sign-in is headed as a failed sign-in, not as a fault.
 *   2. A genuine fault keeps the fault heading — the fix must not overreach.
 *   3. The sign-in screen always offers the other door, before anything is
 *      typed and independently of what was entered. The helpful-looking
 *      alternative — reveal the firm door only after a refusal — would restore
 *      the oracle, so the link being unconditionally present is the security
 *      property, not just a nicety.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider, useI18n } from '../i18n';
import { ErrorAlert } from '../components/ui';
import { ApiError } from '../api/client';
import Login from '../pages/Login';
import { accountsFor, passwordFor } from '../lib/demoAccounts';

// The sign-in screen asks the server for its bootstrap (product name, password
// policy) before rendering its form. Stub it: this test is about the copy and
// the footer, not the boot request.
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    get: vi.fn(() => Promise.resolve({
      product: { name: 'KGM LEGAL OS' },
      passwordPolicy: { minLength: 12 },
    })),
  };
});

vi.mock('../auth', () => ({
  useAuth: () => ({
    session: { authenticated: false },
    status: 'anonymous',
    // Faithful to the real hook: no pending challenge is `null`, not absent.
    mfa: null,
    boot: { product: { name: 'KGM LEGAL OS' }, passwordPolicy: { minLength: 12 } },
    signIn: vi.fn(),
    submitMfa: vi.fn(),
    resendMfa: vi.fn(),
    cancelMfa: vi.fn(),
    signOut: vi.fn(),
  }),
}));

function Probe({ code }: { code: string }) {
  const { errorTitle, errorText } = useI18n();
  return (
    <div>
      <span data-testid="title">{errorTitle(code)}</span>
      <span data-testid="body">{errorText(code)}</span>
    </div>
  );
}

function renderWithI18n(node: React.ReactNode, lang: 'ar' | 'en' = 'en') {
  return render(<I18nProvider initialLang={lang}>{node}</I18nProvider>);
}

describe('client portal · the wrong door', () => {
  it('heads a refused sign-in as a failed sign-in, not as a broken request', () => {
    const { getByTestId } = renderWithI18n(<Probe code="invalid_credentials" />);
    expect(getByTestId('title').textContent).toBe('Sign-in failed');
    // The body is the deliberately non-committal line: it must not report which
    // half of the pair was wrong, or whether the account exists at all.
    expect(getByTestId('body').textContent).toBe('That email and password combination is not correct.');
    cleanup();
  });

  it('keeps the fault heading for failures that really are faults', () => {
    const { getByTestId } = renderWithI18n(<Probe code="internal_error" />);
    expect(getByTestId('title').textContent).toBe('The request could not be completed');
    cleanup();

    const unknown = renderWithI18n(<Probe code="something_the_server_invented_tomorrow" />);
    expect(unknown.getByTestId('title').textContent).toBe('The request could not be completed');
    cleanup();
  });

  it('heads a locked account and a rate limit as themselves', () => {
    const locked = renderWithI18n(<Probe code="account_locked" />);
    expect(locked.getByTestId('title').textContent).toBe('Account locked');
    cleanup();

    const limited = renderWithI18n(<Probe code="rate_limited" />);
    expect(limited.getByTestId('title').textContent).toBe('Too many attempts');
    cleanup();
  });

  it('titles the refusal in the interface language', () => {
    const { getByTestId } = renderWithI18n(<Probe code="invalid_credentials" />, 'ar');
    expect(getByTestId('title').textContent).toBe('تعذّر تسجيل الدخول');
    cleanup();
  });

  it('renders the refusal through ErrorAlert with the same heading', () => {
    const error = new ApiError(401, 'invalid_credentials', 'invalid email or password');
    renderWithI18n(<ErrorAlert error={error} />);
    expect(screen.getByText('Sign-in failed')).toBeTruthy();
    expect(screen.getByText('That email and password combination is not correct.')).toBeTruthy();
    cleanup();
  });

  it('declares the audience as a single control rather than guessing it', async () => {
    const { container } = renderWithI18n(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    // One radio group, two options: a screen reader hears one control, arrow
    // keys move between the doors without JavaScript, and there is no state in
    // which neither door is chosen.
    const radios = container.querySelectorAll('input[name="audience"]');
    expect(radios.length).toBe(2);
    expect([...radios].map((r) => (r as HTMLInputElement).value)).toEqual(['client', 'firm']);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);

    // And the choice is visible as text, not only as a checked box.
    expect(container.textContent).toContain('Client');
    expect(container.textContent).toContain('Firm staff');

    // Nothing has been refused, and nothing has been typed: the screen offers
    // both doors up front. A hint that appeared only after a refusal would
    // disclose that the address was real and the password correct.
    expect(container.querySelector('.alert--error')).toBeNull();
    cleanup();
  });

  it('opens on the firm door when the firm OS sends the reader here', () => {
    // The firm app redirects a signed-out member to /login?as=firm, so the
    // audience has to come from the URL as well as from the control.
    const original = window.location.search;
    window.history.replaceState({}, '', '/login?as=firm');
    try {
      const { container } = renderWithI18n(
        <MemoryRouter>
          <Login />
        </MemoryRouter>,
      );
      const checked = [...container.querySelectorAll('input[name="audience"]')]
        .find((r) => (r as HTMLInputElement).checked) as HTMLInputElement;
      expect(checked.value).toBe('firm');
      cleanup();
    } finally {
      window.history.replaceState({}, '', `/login${original}`);
    }
  });

  it('lists each audience its own credentials and never the other', () => {
    // The list is what the manual documents, so the two must not drift.
    expect(accountsFor('client').map((a) => a.email)).toEqual([
      'ahmed.alsaud@example.test',
      'finance@gulfhorizon.example.test',
      'layla.mansour@example.test',
    ]);
    expect(accountsFor('firm').map((a) => a.email)).toEqual([
      'noura@kgm.example.test',
      'faisal@kgm.example.test',
      'mariam@kgm.example.test',
      'omar@kgm.example.test',
      'sara@kgm.example.test',
    ]);
    // A cross-audience password would make every account work at both doors.
    expect(passwordFor('client')).not.toBe(passwordFor('firm'));
  });
});
