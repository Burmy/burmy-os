import { describe, expect, it } from 'vitest';

import { NONCE_HEADER, buildCsp, generateNonce } from '@/server/security/csp';

/**
 * The CSP is the last line against XSS in an app that renders untrusted bank
 * descriptions on every screen. These tests pin the properties that make it
 * worth having — chiefly that the development-only relaxation cannot reach
 * production.
 */

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name ?? '', values];
    }),
  );
}

describe('generateNonce', () => {
  it('produces 128 bits, base64 encoded', () => {
    const nonce = generateNonce();
    expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
  });

  it('never repeats', () => {
    // A reused nonce is a reusable injection point.
    const seen = new Set(Array.from({ length: 2000 }, () => generateNonce()));
    expect(seen.size).toBe(2000);
  });

  it('contains nothing that would terminate a CSP directive', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateNonce()).not.toMatch(/[;\s']/);
    }
  });
});

describe('buildCsp — production', () => {
  const policy = buildCsp({ nonce: 'TESTNONCE', development: false });
  const parsed = directives(policy);

  it('carries the nonce on scripts and styles', () => {
    expect(parsed.get('script-src')).toContain("'nonce-TESTNONCE'");
    expect(parsed.get('style-src')).toContain("'nonce-TESTNONCE'");
  });

  it('uses strict-dynamic so chunk URLs need no allowlist', () => {
    expect(parsed.get('script-src')).toContain("'strict-dynamic'");
  });

  it('never allows unsafe-eval', () => {
    expect(policy).not.toContain('unsafe-eval');
  });

  it('keeps SCRIPTS nonce-only — no unsafe-inline in script-src', () => {
    // The single most important assertion here. Script execution is the thing a
    // CSP exists to control.
    expect(parsed.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('allows unsafe-inline NOWHERE, in any directive', () => {
    // Investigated, not assumed. A nonce-only style-src produced 33 violations
    // on /sign-in, and capturing `securitypolicyviolation` events showed every
    // one was `style-src-elem` from the Next.js DEV OVERLAY — absent in a
    // production build. Nothing in application code needed a relaxation, so a
    // `style-src-attr 'unsafe-inline'` was tried and reverted.
    expect(policy).not.toContain('unsafe-inline');

    // And no `-attr` escape hatch crept in either.
    expect(parsed.has('style-src-attr')).toBe(false);
    expect(parsed.has('script-src-attr')).toBe(false);
  });

  it('requires a nonce for <style> elements and stylesheet links', () => {
    expect(parsed.get('style-src')).toEqual(["'self'", "'nonce-TESTNONCE'"]);
  });

  it('locks down the directives a nonce cannot protect', () => {
    expect(parsed.get('object-src')).toEqual(["'none'"]);
    expect(parsed.get('base-uri')).toEqual(["'none'"]);
    expect(parsed.get('frame-ancestors')).toEqual(["'none'"]);
    expect(parsed.get('frame-src')).toEqual(["'none'"]);
  });

  it('permits no third-party origins at all', () => {
    // Burmy talks to itself. No CDN, no analytics, no bank, no AI provider.
    expect(policy).not.toMatch(/https?:\/\//);
    expect(parsed.get('connect-src')).toEqual(["'self'"]);
    expect(parsed.get('default-src')).toEqual(["'self'"]);
  });

  it('upgrades insecure requests behind Cloudflare', () => {
    expect(policy).toContain('upgrade-insecure-requests');
  });
});

describe('buildCsp — development', () => {
  const policy = buildCsp({ nonce: 'DEVNONCE', development: true });
  const parsed = directives(policy);

  it('allows unsafe-eval, without which HMR cannot run', () => {
    expect(parsed.get('script-src')).toContain("'unsafe-eval'");
  });

  it('still refuses inline SCRIPT', () => {
    // The dev relaxation is scoped to eval. Inline script stays blocked so a
    // violation shows up locally rather than in production.
    expect(parsed.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('omits upgrade-insecure-requests on plain-http localhost', () => {
    expect(policy).not.toContain('upgrade-insecure-requests');
  });

  it('differs from production in exactly one token', () => {
    const dev = buildCsp({ nonce: 'N', development: true });
    const prod = buildCsp({ nonce: 'N', development: false });

    const devTokens = new Set(dev.split(/[;\s]+/).filter(Boolean));
    const prodTokens = new Set(prod.split(/[;\s]+/).filter(Boolean));

    const onlyInDev = [...devTokens].filter((token) => !prodTokens.has(token));
    const onlyInProd = [...prodTokens].filter((token) => !devTokens.has(token));

    expect(onlyInDev).toEqual(["'unsafe-eval'"]);
    expect(onlyInProd).toEqual(['upgrade-insecure-requests']);
  });
});

describe('nonce header', () => {
  it('uses the conventional name so the framework and app agree', () => {
    expect(NONCE_HEADER).toBe('x-nonce');
  });
});
