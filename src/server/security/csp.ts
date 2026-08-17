/**
 * Content Security Policy — nonce based, generated per request.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS CANNOT LIVE IN next.config.ts
 *
 * A nonce must be unique per response. `next.config.ts` `headers()` emits STATIC
 * strings, so the only CSP expressible there is one with no nonce — which means
 * either `unsafe-inline` or a policy that breaks the framework's own scripts.
 * Per-request state requires the proxy. The static, nonce-free headers (HSTS,
 * nosniff, frame options) stay in next.config.ts where they belong.
 *
 * WHY `'strict-dynamic'`
 *
 * Next.js loads its chunks from scripts it injects itself. Without
 * `'strict-dynamic'` every chunk URL would need enumerating in the policy, which
 * is unmaintainable and silently breaks on every build. With it, a script
 * trusted by nonce may load further scripts, and — importantly — CSP3 browsers
 * IGNORE `'self'` and host allowlists in `script-src`. That is the intended
 * outcome: the nonce becomes the only way in, so an injected
 * `<script src="/whatever">` is refused even though it is same-origin.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Request header carrying the nonce inward, for Server Components to read.
 *
 * The proxy overwrites this on every request, so a client that sends its own
 * `x-nonce` cannot influence what gets rendered.
 */
export const NONCE_HEADER = 'x-nonce';

/**
 * 128 bits of randomness, base64. `crypto` is a global in both the edge and
 * node runtimes, so this works wherever the proxy is executed.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface CspOptions {
  readonly nonce: string;
  /**
   * Development needs `'unsafe-eval'`. React Refresh and the Next dev overlay
   * both evaluate generated code, and without it the dev server cannot hot
   * reload at all. This is a DEVELOPMENT-ONLY relaxation, asserted by test, and
   * it is the single difference between the two policies.
   */
  readonly development: boolean;
}

/**
 * Build the policy string.
 *
 * `object-src 'none'`, `base-uri 'none'` and `frame-ancestors 'none'` are the
 * three directives that `'strict-dynamic'` does not cover and that a nonce
 * cannot protect: a plugin embed, a `<base>` tag rewriting every relative URL,
 * and clickjacking respectively.
 */
export function buildCsp({ nonce, development }: CspOptions): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(development ? ["'unsafe-eval'"] : []),
  ];

  const directives: Array<[string, readonly string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', scriptSrc],

    // <style> ELEMENTS and stylesheet links stay nonce-or-same-origin. This is
    // the directive that matters for injected stylesheets, and it is NOT relaxed.
    ['style-src', ["'self'", `'nonce-${nonce}'`]],

    // ── style ATTRIBUTES: a real, narrow relaxation. Not security-neutral. ───
    //
    // Radix (under shadcn's dialog, select and dropdown-menu) positions floating
    // elements by writing inline `style="…"` attributes from JavaScript. Per
    // CSP3 an attribute has nowhere to carry a nonce, so `style-src-attr` can
    // only ever be satisfied by `'unsafe-inline'` or by per-value hashes — and
    // these values are computed at runtime from viewport geometry, so they are
    // not enumerable. There is no configuration of Radix that avoids this.
    //
    // WHAT THIS COSTS, STATED HONESTLY:
    //
    // Style-attribute injection is not harmless. If an attacker ever controls a
    // style attribute they can overlay or hide UI (clickjacking a confirm
    // button), and they can exfiltrate limited information through attribute
    // selectors and background-image requests. It is genuinely weaker than the
    // nonce-only policy M2 shipped, and it is accepted because the alternative
    // was hand-rolling focus management and overlay a11y for every dialog.
    //
    // WHAT IT DOES NOT COST:
    //
    // Nothing here permits script. `script-src` remains nonce-only with
    // `'strict-dynamic'` and no `'unsafe-inline'` in any environment, so this
    // cannot become code execution. It also does not widen `style-src`, so an
    // injected `<style>` block or remote stylesheet is still refused — most
    // Next.js CSP examples relax `style-src` wholesale, and this deliberately
    // does not.
    //
    // WHY THE RESIDUAL RISK IS SMALL HERE:
    //
    // For this to be reachable, untrusted text would have to flow into a style
    // attribute. React escapes all interpolated output, `dangerouslySetInnerHTML`
    // is banned by lint (`react/no-danger`), and untrusted input in Burmy is
    // bank statement text rendered as text nodes — never as styles.
    //
    // Reviewed at M3, when Radix arrived. Before that the policy was nonce-only
    // and application code produced zero violations; see docs/SECURITY.md for
    // the investigation that established the dev overlay was the only source.
    ['style-src-attr', ["'unsafe-inline'"]],

    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'", 'data:']],
    // Burmy talks to nothing but itself. No analytics, no CDN, no telemetry,
    // and — the point worth stating — no bank and no AI provider in V1.
    ['connect-src', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['object-src', ["'none'"]],
    ['worker-src', ["'self'", 'blob:']],
    ['manifest-src', ["'self'"]],
  ];

  const policy = directives.map(([name, values]) => `${name} ${values.join(' ')}`);

  // Pointless over an http:// dev server; meaningful behind Cloudflare.
  if (!development) policy.push('upgrade-insecure-requests');

  return policy.join('; ');
}
