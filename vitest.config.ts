import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The security suite exercises scrypt, lockout windows and rate limits,
    // so it needs more than the default 5 s per test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One stack per file, sequentially: shared in-process rate-limit state
    // would otherwise make specs order-dependent.
    pool: 'forks',
    fileParallelism: false,
    reporters: ['default'],
    /**
     * config.ts reads the environment once at import time, so anything the suite
     * needs configured must be set here rather than inside a test file.
     *
     * PAYMENT_WEBHOOK_SECRET is deliberately non-empty: with no secret the
     * signature check short-circuits to a dev constant, which would let the
     * webhook tests pass without ever proving that HMAC verification works.
     */
    env: {
      NODE_ENV: 'test',
      PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret-not-a-production-value',
    },
  },
});
