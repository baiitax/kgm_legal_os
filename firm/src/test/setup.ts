/**
 * TEST SETUP.
 *
 * jsdom implements the DOM but not the whole browser. Each stub below exists
 * because a real component calls it, and the failure mode without the stub is a
 * crash in an unrelated test — which reads as "the component is broken" rather
 * than "the environment is incomplete".
 *
 * The stubs are deliberately minimal and honest: matchMedia reports "not light"
 * so the theme resolves to dark (the §06 default), and ResizeObserver does
 * nothing, which leaves the tab strip's overflow flag at its initial value. A
 * stub that faked a specific answer would let a test pass on behaviour the
 * browser would not actually produce.
 */
import '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount between tests. Without this, a portal from one test (an overlay, a
// toast region) is still in document.body when the next test queries it, and
// `getByRole` starts matching elements from a component nobody rendered.
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-rail');
  document.body.innerHTML = '';
  window.location.hash = '';
});

// ---- matchMedia (theme.tsx follows the OS preference) ----
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

// ---- ResizeObserver (MatterTabs measures strip overflow) ----
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// ---- scrollIntoView (the palette keeps the active row visible) ----
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// ---- PointerEvent / hasPointerCapture (focus-trap code paths) ----
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}

// ---- requestAnimationFrame ----
// jsdom provides it, but React's scheduler wants a stable timing source. Pinning
// it to a macrotask keeps `act()` warnings from firing on legitimate async work.
if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(Date.now()), 0)) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => window.clearTimeout(id)) as typeof window.cancelAnimationFrame;
}

// ---- fetch ----
// Every test supplies its own fetch mock. Failing loudly on an unmocked call is
// better than a silent network attempt: a test that hits the real network is not
// a unit test, and in CI it hangs instead of failing.
if (!window.fetch) {
  window.fetch = vi.fn(() => {
    throw new Error('fetch was called without a mock — the test must stub the API');
  }) as unknown as typeof window.fetch;
}

// The preloader lives in index.html, which tests do not load. Components that
// dismiss it query for the element, so it must at least exist as a no-op target.
if (!document.getElementById('kgm-boot')) {
  const boot = document.createElement('div');
  boot.id = 'kgm-boot';
  document.body.appendChild(boot);
}
