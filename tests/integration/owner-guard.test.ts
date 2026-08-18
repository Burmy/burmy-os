import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { OWNER_EMAIL, auditEventTypes, countRows, harness, provisionOwner, resetDatabase } from './harness';

/**
 * `requireOwner()` — the security boundary itself.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Cloudflare Access with Google is the SOLE authentication mechanism (see
 * docs/SECURITY.md, "Authentication"). There is no session, no passkey, no
 * second factor — every request re-verifies the Access JWT and re-resolves the
 * owner row from scratch. `next/headers` is mocked because it is Next.js's
 * request-scoped accessor and there is no request scope in a Vitest worker.
 * Everything else is real: a real Postgres, a real provisioned owner row.
 *
 * WHERE THE CRYPTOGRAPHIC PROOFS LIVE
 *
 * `requireOwner()` never itself verifies a JWT signature — it delegates that
 * entirely to `requireAccessIdentity()` in `server/auth/access.ts`. Wrong
 * Google email, forged signature, and expired-token rejection are all proven
 * there (tests/unit/access.test.ts), against a real locally generated ES256
 * key pair via the same `keyResolver` injection production never uses. This
 * file proves the layer ABOVE that: what `requireOwner()` does with whatever
 * `requireAccessIdentity()` decides — dev-bypass, owner resolution, and the
 * fail-closed behavior the bypass would otherwise hide.
 *
 * The harness runs in the `development` dev-bypass (see harness.ts), which
 * always asserts the CONFIGURED owner email and never touches the network —
 * exactly why the crypto-dependent scenarios above are unit tests instead.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const requestHeaders = { current: new Headers() };

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(requestHeaders.current),
}));

type OwnerModule = typeof import('@/server/auth/owner');
let owner: OwnerModule;

beforeAll(async () => {
  await harness();
  owner = await import('@/server/auth/owner');
});

beforeEach(async () => {
  await resetDatabase();
  requestHeaders.current = new Headers();
});

describe('requireOwner — the dev-bypass path', () => {
  it('rejects when the owner has not been provisioned', async () => {
    await expect(owner.requireOwner()).rejects.toThrow(owner.UnauthorizedError);
    expect(await auditEventTypes()).toContain('auth.entry_point.unauthenticated');
  });

  it('accepts a provisioned owner and resolves their row', async () => {
    const userId = await provisionOwner();

    const context = await owner.requireOwner();

    expect(context.userId).toBe(userId);
    expect(context.email).toBe(OWNER_EMAIL);
  });

  it('does not require a session, cookie, or any prior sign-in step', async () => {
    // No cookie, no Authorization header — just the dev-bypass and a
    // provisioned row. This is the whole point: nothing here is stateful, and
    // there is no "no Better Auth/passkey session required" case to prove
    // separately, because there is no such mechanism left to accidentally
    // depend on.
    await provisionOwner();
    requestHeaders.current = new Headers();

    await expect(owner.requireOwner()).resolves.toBeTruthy();
  });
});

describe('requireOwner — resolve, never create', () => {
  it('never inserts a user row on the owner-authenticated path', async () => {
    expect(await countRows('user')).toBe(0);

    await expect(owner.requireOwner()).rejects.toThrow(owner.UnauthorizedError);

    // Still zero: an Access-authenticated request must never be able to
    // conjure the owner row into existence on its own. Provisioning is
    // scripts/provision-owner.mjs's job, run out of band.
    expect(await countRows('user')).toBe(0);
  });
});

describe('requireOwner — fail closed', () => {
  it('refuses everything when Access cannot be verified — missing config in production', async () => {
    await provisionOwner();
    await expect(owner.requireOwner()).resolves.toBeTruthy();

    const env = process.env as Record<string, string | undefined>;
    const savedNodeEnv = env.NODE_ENV;
    try {
      // A production deployment missing CF_ACCESS_* must serve nothing, even
      // to a request that would otherwise resolve a real owner row. An outage
      // beats an origin quietly serving financial data without the outer gate.
      env.NODE_ENV = 'production';
      delete process.env.CF_ACCESS_TEAM_DOMAIN;
      delete process.env.CF_ACCESS_AUD;

      await expect(owner.requireOwner()).rejects.toThrow(owner.SecurityUnavailableError);
      expect(await auditEventTypes()).toContain('auth.access.misconfigured');
    } finally {
      env.NODE_ENV = savedNodeEnv;
    }
  });

  it('refuses in production with no Access assertion present at all — no network required to fail', async () => {
    // Configured but no header/cookie: `readAccessToken` returns null and
    // `verifyAccessToken` refuses BEFORE attempting a JWKS fetch, so this
    // rejects deterministically without depending on real network access —
    // unlike a validly-signed-but-wrong-owner assertion, which needs a real
    // signature check and is therefore proven in tests/unit/access.test.ts
    // instead, via the injectable key resolver.
    await provisionOwner();

    const env = process.env as Record<string, string | undefined>;
    const savedNodeEnv = env.NODE_ENV;
    try {
      env.NODE_ENV = 'production';
      env.CF_ACCESS_TEAM_DOMAIN = 'burmy-test';
      env.CF_ACCESS_AUD = 'aud-tag-under-test';
      requestHeaders.current = new Headers();

      await expect(owner.requireOwner()).rejects.toThrow(owner.UnauthorizedError);
      expect(await auditEventTypes()).toContain('auth.entry_point.unauthenticated');
    } finally {
      env.NODE_ENV = savedNodeEnv;
    }
  });
});

describe('toAuthErrorResponse', () => {
  it('maps guard failures to bodiless responses', async () => {
    expect(owner.toAuthErrorResponse(new owner.UnauthorizedError())?.status).toBe(401);
    expect(owner.toAuthErrorResponse(new owner.SecurityUnavailableError())?.status).toBe(503);

    const response = owner.toAuthErrorResponse(new owner.UnauthorizedError());
    expect(await response?.text()).toBe('');
  });

  it('passes genuine bugs through instead of flattening them into a 401', () => {
    // A TypeError reported as "Unauthorized" is a debugging trap.
    expect(owner.toAuthErrorResponse(new TypeError('genuine bug'))).toBeNull();
  });
});
