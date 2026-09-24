/**
 * TEST SETUP — the browser facilities jsdom does not implement.
 *
 * Each stub exists because a real component calls it. The failure mode without
 * one is a crash inside an unrelated test, which reads as "the component is
 * broken" rather than "the environment is incomplete".
 *
 * The stubs answer honestly rather than conveniently: matchMedia reports no
 * preference, which leaves the portal's default theme in place. A stub that
 * faked a specific answer would let a test pass on behaviour a browser would not
 * actually produce.
 */
import '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '';
});

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/*
  A test that reaches the network is not a unit test, and in CI it hangs instead
  of failing. Every test supplies its own stub; this one exists so an unstubbed
  call fails loudly and immediately.
*/
if (!window.fetch) {
  window.fetch = vi.fn(() => {
    throw new Error('fetch was called without a mock — the test must stub the API');
  }) as unknown as typeof window.fetch;
}

// The branded preloader lives in index.html, which tests do not load. Components
// that dismiss it query for the element, so it must exist as a no-op target.
if (!document.getElementById('kgm-boot')) {
  const boot = document.createElement('div');
  boot.id = 'kgm-boot';
  document.body.appendChild(boot);
}
