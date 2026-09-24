import { defineConfig } from 'vitest/config';

/**
 * FIRM UI TEST CONFIG.
 *
 * Separate from the root vitest.config.ts on purpose. The root suite is the
 * security suite: node environment, forked pools, 60s timeouts for scrypt and
 * rate-limit windows. These tests are the opposite shape — jsdom, React, fast.
 * Merging them would force one environment compromise onto both.
 *
 * WHAT THESE TESTS ARE FOR
 *   The security suite proves the API refuses what it should. Nothing in it
 *   proves the UI agrees. That gap is exactly where §50 fails in practice: the
 *   server is correct, and the interface shows a tab that 404s on click, or a
 *   metric the member was not entitled to see. These tests close the gap by
 *   rendering the real components against canned session payloads and asserting
 *   on what appears.
 *
 *   They are UI-contract tests, not a re-run of the authorization suite. The
 *   server remains the authority; what is asserted here is that the client
 *   projection of it is faithful.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    environment: 'jsdom',
    globals: true,
    testTimeout: 15_000,
    // React 18's act() environment.
    setupFiles: ['./src/test/setup.ts'],
  },
  esbuild: {
    // The app is ESM TypeScript with JSX; vitest needs the JSX transform
    // configured the same way the bundler does.
    jsx: 'automatic',
  },
});
