import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests. NO Docker, NO database, NO network.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO PROJECTS, SPLIT BY FILE EXTENSION.
 *
 *   *.test.ts   -> `domain`     · node environment, no setup, no jsdom
 *   *.test.tsx  -> `components` · jsdom + jest-dom matchers + RTL cleanup
 *
 * The split is not tidiness. Loading React Testing Library and jest-dom costs
 * several seconds of setup, and applying that to every file took the suite from
 * ~0.5s to ~4.2s — measured. This is the suite that runs on every save, and the
 * money core's whole value is that it can be exercised in milliseconds without a
 * browser. So the framework-free tests get a framework-free runner.
 *
 * Keeping `environment: 'node'` for `.test.ts` also means an accidental DOM
 * dependency in the domain core fails loudly instead of silently working.
 *
 * (M1 used a single project with a `// @vitest-environment jsdom` opt-in
 * comment. The extension now decides, so that comment is no longer needed.)
 *
 * To run only the fast half:  pnpm test --project domain
 * ─────────────────────────────────────────────────────────────────────────────
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: false,
    restoreMocks: true,

    projects: [
      {
        extends: true,
        test: {
          name: 'domain',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          globals: false,
          restoreMocks: true,
        },
      },
      {
        extends: true,
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['tests/unit/**/*.test.tsx'],
          setupFiles: ['tests/setup/testing-library.ts'],
          globals: false,
          restoreMocks: true,
        },
      },
    ],

    coverage: {
      provider: 'v8',
      include: ['src/server/finance/**', 'src/server/games/**'],
      reporter: ['text', 'html'],
    },
  },
});
