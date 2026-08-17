import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Integration tests — real PostgreSQL 18 via Testcontainers.
 *
 * Kept in its own config, and out of `pnpm test`, on purpose: these need a
 * running Docker daemon and take seconds rather than milliseconds. Folding them
 * into the default suite would make the fast feedback loop depend on Docker
 * being up, and a suite that is slow to start is a suite that stops being run.
 *
 *   pnpm test              → unit only, no Docker, ~1s
 *   pnpm test:integration  → this file, needs Docker
 *
 * CI runs both.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    globals: false,
    restoreMocks: true,

    // ONE container for the whole run, shared by every file. Starting Postgres
    // per file would cost more than the tests themselves. Isolation comes from
    // truncating tables between tests instead (see harness.ts) — these suites
    // exercise auth flows against a single-owner schema, so there is no
    // cross-test data to keep apart, only leftover rows to clear.
    fileParallelism: false,

    // Container startup, image pull on a cold machine, and migrations.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
