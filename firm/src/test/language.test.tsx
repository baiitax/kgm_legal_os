/**
 * LANGUAGE TOGGLE · §Arabic-first, §40
 *
 * The toggle is the one control a member needs when they cannot read the
 * interface they are looking at, so these tests assert the properties that make
 * it usable in exactly that situation — not merely that it renders.
 *
 * The three that matter:
 *   1. Labels are ENDONYMS and never translated. If `t()` rendered them, the
 *      English option would read "الإنجليزية" while the UI is Arabic, and the
 *      control would fail for the person who needs it.
 *   2. The active language is announced via aria-pressed, and the visual state
 *      is driven by that same attribute in CSS, so look and announcement cannot
 *      diverge.
 *   3. Switching flips `<html dir>` and `<html lang>` — direction, not just text.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '@kgm/ui';
import { FIRM_I18N } from '../i18n/dictionary.js';
import { LanguageToggle } from '../components/LanguageToggle.js';

function renderToggle(initialLang: 'ar' | 'en' = 'ar') {
  return render(
    <I18nProvider bundle={FIRM_I18N} initialLang={initialLang}>
      <LanguageToggle />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
});

describe('LanguageToggle', () => {
  it('renders both options with their endonyms, in either starting language', () => {
    /*
      The point of the test: the labels must be IDENTICAL whichever language the
      UI is currently in. A translated label would differ between these two
      renders, which is the failure this guards against.
    */
    for (const start of ['ar', 'en'] as const) {
      const { unmount } = renderToggle(start);
      const arabic = screen.getByRole('button', { name: 'العربية' });
      const english = screen.getByRole('button', { name: 'English' });
      expect(arabic).toBeTruthy();
      expect(english).toBeTruthy();
      unmount();
    }
  });

  it('pins dir and lang per option so the Arabic label never reflows', () => {
    renderToggle('en');
    const arabic = screen.getByRole('button', { name: 'العربية' });
    // Without dir="rtl" the Arabic label inherits LTR from an English document,
    // changing its shaping context so the two states look like different words.
    expect(arabic.getAttribute('dir')).toBe('rtl');
    expect(arabic.getAttribute('lang')).toBe('ar');

    const english = screen.getByRole('button', { name: 'English' });
    expect(english.getAttribute('dir')).toBe('ltr');
    expect(english.getAttribute('lang')).toBe('en');
  });

  it('marks the current language pressed, and only that one', () => {
    renderToggle('ar');
    /*
      Asserted via getAttribute, not toHaveProperty: `aria-pressed` is a content
      ATTRIBUTE, and never surfaces as a JS property on the element. A property
      assertion here would fail on a correct implementation — and, worse, could be
      "fixed" by adding a `ariaPressed` prop that the browser ignores.
    */
    expect(screen.getByRole('button', { name: 'العربية' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('switches the language and flips document direction', () => {
    renderToggle('ar');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');

    fireEvent.click(screen.getByRole('button', { name: 'English' }));

    /*
      Direction, not merely text. §40: switching language must move the whole
      layout, and the i18n runtime owns `<html dir>` so nothing here can drift
      from it.
    */
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    expect(screen.getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'العربية' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('persists the choice so a reload keeps it', () => {
    renderToggle('ar');
    fireEvent.click(screen.getByRole('button', { name: 'English' }));

    const stored = localStorage.getItem('kgm.firm.i18n');
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored as string).lang).toBe('en');
  });

  it('does not rewrite storage when the active option is pressed again', () => {
    renderToggle('en');
    const before = localStorage.getItem('kgm.firm.i18n');
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    const after = localStorage.getItem('kgm.firm.i18n');
    // A no-op press must stay a no-op: same value, no churn.
    expect(after).toBe(before);
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });

  it('exposes a labelled group, not two anonymous buttons', () => {
    renderToggle('ar');
    expect(screen.getByRole('group')).toBeTruthy();
    // The group name comes from the dictionary, so it is localized even though
    // the option labels deliberately are not.
    expect(screen.getByRole('group').getAttribute('aria-label')).toBeTruthy();
  });

  it('renders the compact variant with short forms', () => {
    render(
      <I18nProvider bundle={FIRM_I18N} initialLang="ar">
        <LanguageToggle variant="compact" />
      </I18nProvider>,
    );
    // Short forms are the topbar's, where a 60px row has no room for endonyms.
    expect(screen.getByRole('button', { name: 'ع' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'EN' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'العربية' })).toBeNull();
  });
});
