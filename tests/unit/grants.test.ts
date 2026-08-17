import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  GRANT_TTL_SECONDS,
  decodeGrantPayload,
  encodeGrantPayload,
  generateGrantToken,
  grantExpiry,
  grantIdentifier,
  grantKindMatches,
} from '@/server/auth/grants';

/**
 * Grant tokens are the only credential that can produce a session without a
 * passkey. Their properties are therefore load-bearing.
 */

describe('generateGrantToken', () => {
  it('produces 256 bits, base64url, URL-safe', () => {
    const token = generateGrantToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    // Must survive being pasted into a query string for candidate-A style flows.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateGrantToken()));
    expect(seen.size).toBe(2000);
  });
});

describe('grantIdentifier', () => {
  it('stores a hash, never the token itself', () => {
    // This is what keeps a database dump — and the nightly off-site backup —
    // from containing a working login credential.
    const token = generateGrantToken();
    const identifier = grantIdentifier(token);

    expect(identifier).not.toContain(token);
    expect(identifier).toBe(
      `burmy-grant:${createHash('sha256').update(token, 'utf8').digest('hex')}`,
    );
  });

  it('is deterministic, so a presented token can be recognized', () => {
    const token = generateGrantToken();
    expect(grantIdentifier(token)).toBe(grantIdentifier(token));
  });

  it('is namespaced so it cannot collide with a WebAuthn challenge', () => {
    // The `verification` table is shared with the passkey plugin's challenges.
    expect(grantIdentifier('x')).toMatch(/^burmy-grant:/);
  });

  it('differs for tokens differing by one character', () => {
    expect(grantIdentifier('token-a')).not.toBe(grantIdentifier('token-b'));
  });
});

describe('grant payloads', () => {
  it('round-trips', () => {
    const payload = {
      kind: 'recovery',
      email: 'owner@burmy.test',
      issuedAt: '2026-08-17T00:00:00.000Z',
    } as const;
    expect(decodeGrantPayload(encodeGrantPayload(payload))).toEqual(payload);
  });

  it('fails closed on anything unexpected', () => {
    // These strings come back out of the database, so a truncated or
    // hand-edited row must decode to null rather than throw further up.
    for (const raw of [
      '',
      'not json',
      '{',
      'null',
      '[]',
      '"string"',
      '123',
      '{}',
      '{"kind":"bootstrap"}',
      '{"kind":"admin","email":"o@b.test","issuedAt":"x"}',
      '{"kind":"bootstrap","email":"","issuedAt":"x"}',
      '{"kind":"bootstrap","email":"o@b.test","issuedAt":""}',
      '{"kind":"bootstrap","email":42,"issuedAt":"x"}',
    ]) {
      expect(decodeGrantPayload(raw), raw).toBeNull();
    }
  });

  it('ignores extra fields rather than trusting them', () => {
    const decoded = decodeGrantPayload(
      '{"kind":"bootstrap","email":"o@b.test","issuedAt":"x","admin":true}',
    );
    expect(decoded).toEqual({ kind: 'bootstrap', email: 'o@b.test', issuedAt: 'x' });
    expect(decoded).not.toHaveProperty('admin');
  });
});

describe('grantKindMatches', () => {
  it('matches only the identical kind', () => {
    // A bootstrap token must never satisfy a recovery redemption, or the two
    // paths — one once-ever, one repeatable — silently become one.
    expect(grantKindMatches('bootstrap', 'bootstrap')).toBe(true);
    expect(grantKindMatches('recovery', 'recovery')).toBe(true);
    expect(grantKindMatches('bootstrap', 'recovery')).toBe(false);
    expect(grantKindMatches('recovery', 'bootstrap')).toBe(false);
  });
});

describe('grantExpiry', () => {
  it('is ten minutes out', () => {
    expect(GRANT_TTL_SECONDS).toBe(600);

    const now = new Date('2026-08-17T12:00:00.000Z');
    expect(grantExpiry(now).toISOString()).toBe('2026-08-17T12:10:00.000Z');
  });

  it('is short enough that scrollback goes stale quickly', () => {
    expect(GRANT_TTL_SECONDS).toBeLessThanOrEqual(900);
  });
});
