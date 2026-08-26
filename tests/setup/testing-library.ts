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

/**
 * jsdom does not implement `ResizeObserver` at all (by design — it has no
 * real layout engine to observe). Radix's `Checkbox` mounts a hidden native
 * "bubble input" (so a checked/unchecked state posts through real FormData —
 * see the Games platinum checkbox) and unconditionally calls
 * `@radix-ui/react-use-size`'s `useSize`, which constructs a `ResizeObserver`
 * on mount with no feature-detection. Without this polyfill, EVERY component
 * test that renders a `<Checkbox>` throws `ReferenceError: ResizeObserver is
 * not defined` — first caught by `games-library-view.test.tsx` opening the
 * game editor dialog. The observer's real behavior (reporting size changes)
 * is never asserted on in this suite, so a no-op stub is sufficient; this is
 * not testing layout, only that the component tree mounts.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverPolyfill {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverPolyfill as unknown as typeof ResizeObserver;
}

/**
 * jsdom does not implement `Element.prototype.scrollIntoView` either (same
 * "no real layout engine" reason as `ResizeObserver` above). Radix's
 * `Select` calls it to bring the current/selected item into view whenever
 * the content mounts already open — harmless to no-op here since these
 * tests never assert on scroll position, only that the select opens and a
 * pick commits. First caught by `games-game-page.test.tsx`'s inline
 * Select-editing tests (`InlineEditSelect` opens with `defaultOpen`, unlike
 * the click-to-open selects elsewhere that happened not to hit this path).
 */
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView === 'undefined') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}
