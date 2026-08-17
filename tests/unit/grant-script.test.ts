import { describe, expect, it } from 'vitest';

import {
  GRANT_TTL_SECONDS as TS_TTL,
  encodeGrantPayload as tsEncode,
  generateGrantToken as tsGenerate,
  grantIdentifier as tsIdentifier,
} from '@/server/auth/grants';

/**
 * DRIFT GUARD.
 *
 * `scripts/auth-grant.mjs` is plain ESM — deliberately, so break-glass recovery
 * needs nothing but `postgres` and `node:crypto` on a host that may have just
 * been rebuilt (same reasoning as scripts/migrate.mjs). The cost of that choice
 * is a duplicated token format: the script cannot import the TypeScript module.
 *
 * If the two ever disagree, recovery fails at the exact moment it is needed and
 * nothing else would notice — the script would happily write a row that the
 * server can never recognize. So this test imports BOTH implementations and
 * asserts they agree.
 */

const script = await import('../../scripts/auth-grant.mjs');

describe('scripts/auth-grant.mjs matches src/server/auth/grants.ts', () => {
  it('derives an identical identifier for the same token', () => {
    for (let i = 0; i < 50; i += 1) {
      const token = tsGenerate();
      expect(script.grantIdentifier(token)).toBe(tsIdentifier(token));
    }
  });

  it('agrees on identifiers for awkward token values', () => {
    for (const token of ['', 'a', '=', 'ünïcödé', 'x'.repeat(512), '{"json":true}']) {
      expect(script.grantIdentifier(token)).toBe(tsIdentifier(token));
    }
  });

  it('encodes the payload identically', () => {
    // Byte-identical matters: the server JSON-parses whatever the script wrote.
    const payload = {
      kind: 'recovery',
      email: 'owner@burmy.test',
      issuedAt: '2026-08-17T00:00:00.000Z',
    } as const;
    expect(script.encodeGrantPayload(payload)).toBe(tsEncode(payload));
  });

  it('agrees on the TTL', () => {
    expect(script.GRANT_TTL_SECONDS).toBe(TS_TTL);
  });

  it('generates tokens of the same shape', () => {
    const token = script.generateGrantToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('does not mint anything merely by being imported', () => {
    // The direct-invocation guard uses pathToFileURL; if it were wrong on
    // Windows this import would have tried to reach a database.
    expect(typeof script.grantIdentifier).toBe('function');
  });
});
