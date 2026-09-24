/**
 * LANGUAGE TOGGLE · the client portal
 *
 * The audience here is even less forgiving than the firm's. A client signing in
 * for the first time has no training, no colleague to ask, and no reason to
 * expect an Arabic-first interface — the switch is the only way in for a reader
 * who cannot read the language the portal opens in.
 *
 * So these tests assert the properties that make the control usable in that
 * situation, not merely that it renders:
 *
 *   1. The labels are ENDONYMS and never translated. If `t()` rendered them, the
 *      English option would read "الإنجليزية" while the UI is Arabic, and the
 *      control would fail for exactly the person who needs it.
 *   2. Both full labels are present in the default variant. Short forms ("ع",
 *      "EN") are not a choice a reader can act on without literacy in the
 *      current script — the failing this replaced.
 *   3. `dir` and `lang` are pinned per option, so the Arabic label keeps its
 *      shaping context inside an English document.
 *   4. Switching flips `<html dir>` and `<html lang>`: direction, not just text.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { LanguageToggle } from '../components/LanguageToggle';

// The component persists the choice through the session, so the auth module is
// mocked rather than mounted: mounting it would make the test depend on the
// boot request, and this test is about the control.
const patchMock = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, patch: patchMock };
});

let authenticated = false;
vi.mock('../auth', () => ({
  useAuth: () => ({ session: { authenticated } }),
}));

function renderToggle(initialLang: 'ar' | 'en' = 'ar', variant?: 'segmented' | 'compact') {
  return render(
    <I18nProvider initialLang={initialLang}>
      <LanguageToggle variant={variant} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  authenticated = false;
  patchMock.mockClear();
  localStorage.clear();
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
});

describe('client portal · LanguageToggle', () => {
  it('renders both options with their endonyms, in either starting language', () => {
    /*
      The point: the labels must be IDENTICAL whichever language the interface is
      currently in. A translated label would differ between these two renders,
      which is the failure this guards against.
    */
    for (const start of ['ar', 'en'] as const) {
      const { unmount } = renderToggle(start);
      expect(screen.getByRole('button', { name: 'العربية' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'English' })).toBeTruthy();
      unmount();
    }
  });

  it('labels the options in full, not as "ع"/"EN"', () => {
    /*
      Regression guard. The control used to show two abbreviations, which is
      unusable for a reader who does not recognise the script — and this is the
      portal the client sees before anyone has explained anything to them.
    */
    renderToggle('ar');
    expect(screen.queryByRole('button', { name: 'ع' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'EN' })).toBeNull();
  });

  it('pins dir and lang per option so the Arabic label never reflows', () => {
    renderToggle('en');
    const arabic = screen.getByRole('button', { name: 'العربية' });
    expect(arabic.getAttribute('dir')).toBe('rtl');
    expect(arabic.getAttribute('lang')).toBe('ar');

    const english = screen.getByRole('button', { name: 'English' });
    expect(english.getAttribute('dir')).toBe('ltr');
    expect(english.getAttribute('lang')).toBe('en');
  });

  it('marks the current language pressed, and only that one', () => {
    renderToggle('ar');
    /*
      Asserted via getAttribute: `aria-pressed` is a content attribute and never
      surfaces as a JS property. A property assertion would fail on a correct
      implementation and invite a fake `ariaPressed` prop that browsers ignore.
    */
    expect(screen.getByRole('button', { name: 'العربية' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('switches the language and flips document direction', () => {
    renderToggle('ar');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');

    fireEvent.click(screen.getByRole('button', { name: 'English' }));

    // Direction, not merely text: the layout has to move for a reader whose
    // script runs the other way.
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    expect(screen.getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('does not write preferences for a signed-out visitor', () => {
    // Before authentication the choice is local, and there is no session to
    // attach it to. Attempting the write would 401 on every press.
    renderToggle('ar');
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('persists the choice to the client\'s preferences once signed in', () => {
    authenticated = true;
    renderToggle('ar');
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(patchMock).toHaveBeenCalledWith('/api/client/preferences', { language: 'en' });
  });

  it('treats a press on the active option as a no-op', () => {
    authenticated = true;
    renderToggle('en');
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    // No redundant write, and no direction churn.
    expect(patchMock).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });

  it('exposes a labelled group, not two anonymous buttons', () => {
    renderToggle('ar');
    const group = screen.getByRole('group');
    // The group's name IS localized even though the option labels deliberately
    // are not.
    expect(group.getAttribute('aria-label')).toBe('تبديل اللغة');
  });

  it('localizes the group name in English too', () => {
    renderToggle('en');
    expect(screen.getByRole('group').getAttribute('aria-label')).toBe('Switch language');
  });

  it('renders the compact variant with short forms, for the topbar', () => {
    renderToggle('ar', 'compact');
    expect(screen.getByRole('button', { name: 'ع' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'EN' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'العربية' })).toBeNull();
  });
});
