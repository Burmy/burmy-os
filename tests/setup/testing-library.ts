import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Vitest setup for component tests.
 *
 * `@testing-library/jest-dom` was installed in M1 but never wired up; the first
 * component tests arrive with the M3 app shell, so it is wired now.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This file runs for EVERY unit test, including the framework-free domain suites
 * that run in the `node` environment. Importing the matchers there is harmless —
 * they only extend `expect` — but `cleanup()` unmounts React trees and needs a
 * document. Hence the guard: without it, every money.test.ts case would fail on
 * a missing DOM, which would be a confusing punishment for opting OUT of jsdom.
 *
 * Component tests opt in per file with:
 *   // @vitest-environment jsdom
 * ─────────────────────────────────────────────────────────────────────────────
 */
afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
});
