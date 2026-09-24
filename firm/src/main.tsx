/**
 * FIRM OS ENTRY POINT.
 *
 * The one job this file has beyond mounting React is the preloader handoff (§32,
 * §33).
 *
 * The branded preloader is inlined in index.html so it paints before any JS
 * executes. It must not be removed the instant React mounts, because "React
 * mounted" is not the same as "there is something to look at": the session fetch
 * has not resolved yet, and tearing the preloader down at mount would show an
 * empty shell for however long the network takes.
 *
 * So the handoff waits for BOTH:
 *   - the app to have painted (two animation frames after mount), and
 *   - the session to have settled (authenticated, anonymous, or error).
 *
 * and enforces §33's minimum of ~1s so the brand sequence completes rather than
 * being cut off. A preloader that vanishes in 200ms on a fast connection reads as
 * a flash, not as an entrance.
 *
 * The cap matters as much as the minimum: if the session never settles, the
 * preloader must still come down after 6s so the member reaches an error screen
 * rather than staring at a spinner with no way out.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

// Design system styles, in dependency order. tokens first because every later
// sheet resolves against its custom properties; fonts before base because base
// sets the family; primitives last so they can override base where needed.
import '@kgm/ui/styles/tokens.css';
import '@kgm/ui/styles/fonts.css';
import '@kgm/ui/styles/base.css';
import '@kgm/ui/styles/primitives.css';
import '@kgm/ui/brand/logo.css';

const BOOT_ID = 'kgm-boot';
const MIN_BOOT_MS = 1000;
const MAX_BOOT_MS = 6000;

const bootStartedAt = Date.now();

/** Removes the preloader. Idempotent — the timer and the signal can both fire. */
function dismissBoot(): void {
  const el = document.getElementById(BOOT_ID);
  if (!el || el.dataset.hidden === 'true') return;
  // Fade rather than remove, so the transition to the app is the same motion the
  // preloader used to arrive. The element is deleted after the fade, because
  // leaving it mounted keeps a fixed overlay in the stacking order.
  el.dataset.hidden = 'true';
  window.setTimeout(() => el.remove(), 400);
}

/**
 * Signals that the session has settled.
 *
 * Dispatched by the session provider through a window event rather than a shared
 * module flag: this file runs before React and must not import the provider, or
 * the preloader logic would be bundled into the app chunk and the boot sequence
 * would depend on the thing it is waiting for.
 */
window.addEventListener('kgm:session-settled', dismissBoot, { once: true });

const container = document.getElementById('root');
if (!container) {
  // Without a mount point nothing can render, so the preloader has to go —
  // otherwise the failure is invisible behind a spinner that never ends.
  dismissBoot();
  throw new Error('Firm OS: #root mount point is missing');
}

createRoot(container).render(
  /*
    StrictMode double-invokes effects in development. That is kept on
    deliberately: the session provider, the focus traps in the overlays and the
    hash subscription all have cleanup paths, and StrictMode is what proves they
    work. A leak that only appears in development is still a leak.
  */
  <StrictMode>
    <App />
  </StrictMode>,
);

// Minimum display time, so a fast connection still shows the brand sequence.
window.setTimeout(() => {
  // Two frames: one to commit, one to paint. Dismissing after only one can still
  // catch the browser before the first frame is on screen.
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    const elapsed = Date.now() - bootStartedAt;
    if (elapsed >= MIN_BOOT_MS) dismissBoot();
  }));
}, MIN_BOOT_MS);

// Hard cap. If the session never settles, the member still gets out.
window.setTimeout(dismissBoot, MAX_BOOT_MS);
