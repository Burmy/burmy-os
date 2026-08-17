'use client';

import { setNonce } from 'get-nonce';

/**
 * Hand the per-request CSP nonce to Radix's style-injection layer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NEEDED, AND WHY IT IS NOT `style-src 'unsafe-inline'`
 *
 * Radix dialogs and selects lock body scroll through `react-remove-scroll`, which
 * creates a real `<style>` ELEMENT at runtime. That is governed by
 * `style-src-elem`, which falls back to `style-src` — and Burmy's `style-src` is
 * nonce-only. So opening a dialog produced `style-src-elem` violations sourced
 * from a vendor chunk, and the scroll lock silently did not apply.
 *
 * The easy fix would have been adding `'unsafe-inline'` to `style-src`. That was
 * refused: it would permit ANY injected stylesheet, which is a materially bigger
 * hole than the `style-src-attr` relaxation M3 accepted for inline style
 * attributes (an attribute cannot carry a nonce; a `<style>` element can).
 *
 * `react-style-singleton` reads its nonce from the `get-nonce` package, so telling
 * it the request's nonce makes the injected tag legitimate under the existing
 * policy. `<style>` elements stay nonce-controlled, exactly as intended.
 *
 * FOUND BY TEST, not by review: tests/e2e/shell.spec.ts opens a real dialog and
 * asserts zero violations from application code.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Called during render rather than in an effect because Radix can create its style
 * tag as soon as an overlay opens, which may be before effects from a parent have
 * settled. `setNonce` is an idempotent module-level assignment, so calling it on
 * every render is harmless.
 */
export function StyleNonce({ nonce }: { readonly nonce: string }): null {
  if (nonce) setNonce(nonce);
  return null;
}
