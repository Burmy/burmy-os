import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Default to `node`. The finance domain core is pure TypeScript with no DOM
    // and must stay that way — running it in jsdom would hide an accidental
    // browser dependency. Component tests opt in with:
    //   // @vitest-environment jsdom
    environment: 'node',
    // UNIT ONLY, and deliberately so: `pnpm test` must run with no Docker
    // daemon, no database and no network. It is the suite that runs on every
    // save, and the moment it needs a container it stops being run that often.
    // Integration tests live in `pnpm test:integration`
    // (vitest.integration.config.ts).
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'tests/integration/**'],
    globals: false,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/server/finance/**'],
      reporter: ['text', 'html'],
    },
  },
});
