import { defineConfig } from 'vitest/config';

/**
 * CLIENT PORTAL UI TEST CONFIG.
 *
 * Separate from the root vitest.config.ts, which is the security suite: node
 * environment, forked pools, long timeouts for scrypt and rate-limit windows.
 * These tests are the opposite shape — jsdom, React, fast. Merging them would
 * force one environment compromise onto the other.
 *
 * Separate from firm/vitest.config.ts too, and deliberately so: the two products
 * share presentational primitives and nothing else, so they do not share a test
 * harness either. A shared harness would be the first place the separation
 * quietly stopped being true.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    environment: 'jsdom',
    globals: true,
    testTimeout: 15_000,
    setupFiles: ['./src/test/setup.ts'],
  },
  esbuild: {
    jsx: 'automatic',
  },
});
