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

    // Nonce or same-origin only — NO `'unsafe-inline'`, and no `style-src-attr`
    // escape hatch either.
    //
    // This was investigated rather than guessed. Loading /sign-in under a
    // nonce-only policy produced 33 violations, and the obvious reading —
    // "React sets inline style attributes, and a nonce can never satisfy
    // `style-src-attr`" — was WRONG. Capturing `securitypolicyviolation` events
    // in the browser showed all 33 were `style-src-elem`, every one sourced from
    // `_next/static/chunks/…next-devtools…`: the development overlay, which does
    // not exist in a production build. Zero came from application code, and zero
    // were `script-src`.
    //
    // So there is nothing to relax. A `style-src-attr 'unsafe-inline'` was tried
    // and reverted, because widening a policy for a problem that does not exist
    // in production is how a CSP quietly stops being worth having. If a future
    // component genuinely needs an inline style attribute it will break loudly,
    // and that is the moment to reconsider — not now.
    ['style-src', ["'self'", `'nonce-${nonce}'`]],

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
