import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CookieJar,
  auditEventTypes,
  harness,
  insertPasskey,
  resetDatabase,
  signInViaBootstrapGrant,
} from './harness';

/**
 * `requireOwner()` — the security boundary itself.
 *
 * `next/headers` is mocked because it is Next.js's request-scoped accessor and
 * there is no request scope in a Vitest worker. Everything else is real: a real
 * Postgres, a real Better Auth session established by really redeeming a grant,
 * real cookies. The mock supplies the request headers and nothing more.
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

/** Sign in and point the mocked request headers at the resulting cookie. */
async function signIn(): Promise<{ userId: string; jar: CookieJar }> {
  const jar = new CookieJar();
  const { userId } = await signInViaBootstrapGrant(jar);
  requestHeaders.current = new Headers({ cookie: jar.header() });
  return { userId, jar };
}

describe('requireOwner — factor 2', () => {
  it('rejects a request with no session', async () => {
    await expect(owner.requireOwner()).rejects.toThrow(owner.UnauthorizedError);
    expect(await auditEventTypes()).toContain('auth.entry_point.unauthenticated');
  });

  it('rejects a forged session cookie', async () => {
    requestHeaders.current = new Headers({
      cookie: 'burmy.session_token=not-a-real-signed-token',
    });
    await expect(owner.requireOwner()).rejects.toThrow(owner.UnauthorizedError);
  });

  it('accepts the owner once onboarding is complete', async () => {
    const { userId } = await signIn();
    await insertPasskey(userId, 'phone');
    await insertPasskey(userId, 'laptop');

    const context = await owner.requireOwner();

    expect(context.userId).toBe(userId);
    expect(context.email).toBe('owner@burmy.test');
    expect(context.passkeyCount).toBe(2);
    expect(context.onboardingComplete).toBe(true);
  });

  it('rejects a valid session whose user is not the owner', async () => {
    // Belt and braces: the email is re-checked on EVERY request, not just at
    // session creation, so changing OWNER_EMAIL invalidates the old identity at
    // once rather than whenever the session happens to expire.
    const { userId } = await signIn();
    await insertPasskey(userId, 'a');
    await insertPasskey(userId, 'b');

    const { sql } = await harness();
    await sql`update "user" set "email" = 'someone-else@elsewhere.test' where "id" = ${userId}`;

    await expect(owner.requireOwner()).rejects.toThrow(owner.UnauthorizedError);
    expect(await auditEventTypes()).toContain('auth.access.non_owner');
  });

  it('sees a revoked session die immediately', async () => {
    const { userId } = await signIn();
    await insertPasskey(userId, 'a');
    await insertPasskey(userId, 'b');
    await expect(owner.requireOwner()).resolves.toBeTruthy();

    const { sql } = await harness();
    await sql`delete from "session"`;

    // Server-side session storage is what buys this. A stateless signed token
    // would still be honoured until it expired.
    await expect(owner.requireOwner()).rejects.toThrow(owner.UnauthorizedError);
  });
});

describe('requireOwner — the two-passkey onboarding gate', () => {
  it('blocks with zero passkeys', async () => {
    await signIn();
    await expect(owner.requireOwner()).rejects.toThrow(owner.OnboardingIncompleteError);
  });

  it('still blocks with only one', async () => {
    // One passkey is a single point of failure whose recovery needs SSH and
    // Tailscale. The second one costs twenty seconds now.
    const { userId } = await signIn();
    await insertPasskey(userId, 'only');

    await expect(owner.requireOwner()).rejects.toThrow(owner.OnboardingIncompleteError);
  });

  it('reports how many are enrolled, so the UI can say so', async () => {
    const { userId } = await signIn();
    await insertPasskey(userId, 'only');

    await owner.requireOwner().catch((error: unknown) => {
      expect(error).toBeInstanceOf(owner.OnboardingIncompleteError);
      expect((error as InstanceType<OwnerModule['OnboardingIncompleteError']>).passkeyCount).toBe(1);
    });
  });

  it('lets the onboarding route itself through', async () => {
    const { userId } = await signIn();

    const context = await owner.requireOwner({ allowOnboarding: true });

    expect(context.userId).toBe(userId);
    expect(context.onboardingComplete).toBe(false);
    expect(context.passkeyCount).toBe(0);
  });

  it('requires MIN_PASSKEYS to be 2 — the gate is not a suggestion', () => {
    expect(owner.MIN_PASSKEYS).toBe(2);
  });
});

describe('requireOwner — sensitive-action re-authentication', () => {
  it('accepts a fresh session', async () => {
    const { userId } = await signIn();
    await insertPasskey(userId, 'a');
    await insertPasskey(userId, 'b');

    await expect(owner.requireOwner({ fresh: true })).resolves.toBeTruthy();
  });

  it('refuses a session older than the freshness window', async () => {
    const { userId } = await signIn();
    await insertPasskey(userId, 'a');
    await insertPasskey(userId, 'b');

    const { sql } = await harness();
    // 16 minutes: past the 15-minute window. Freshness is measured from
    // createdAt, which the rolling refresh does not move — so an old session
    // never silently becomes fresh again.
    await sql`update "session" set "created_at" = now() - interval '16 minutes'`;

    await expect(owner.requireOwner({ fresh: true })).rejects.toThrow(owner.ReauthRequiredError);

    // ...while ordinary access still works. Re-auth gates the dangerous action,
    // it does not sign the owner out.
    await expect(owner.requireOwner()).resolves.toBeTruthy();
    expect(await auditEventTypes()).toContain('auth.reauth.failure');
  });
});

describe('requireOwner — fail closed', () => {
  it('refuses everything when factor 1 cannot be verified', async () => {
    const { userId } = await signIn();
    await insertPasskey(userId, 'a');
    await insertPasskey(userId, 'b');
    await expect(owner.requireOwner()).resolves.toBeTruthy();

    const env = process.env as Record<string, string | undefined>;
    const savedNodeEnv = env.NODE_ENV;
    try {
      // A production deployment missing CF_ACCESS_* must serve nothing, even to
      // a perfectly valid session. An outage beats an origin quietly serving
      // financial data without the outer gate.
      env.NODE_ENV = 'production';
      delete process.env.CF_ACCESS_TEAM_DOMAIN;
      delete process.env.CF_ACCESS_AUD;

      await expect(owner.requireOwner()).rejects.toThrow(owner.SecurityUnavailableError);
      expect(await auditEventTypes()).toContain('auth.access.misconfigured');
    } finally {
      env.NODE_ENV = savedNodeEnv;
    }
  });
});

describe('toAuthErrorResponse', () => {
  it('maps guard failures to bodiless responses', async () => {
    expect(owner.toAuthErrorResponse(new owner.UnauthorizedError())?.status).toBe(401);
    expect(owner.toAuthErrorResponse(new owner.ReauthRequiredError())?.status).toBe(403);
    expect(owner.toAuthErrorResponse(new owner.OnboardingIncompleteError(1))?.status).toBe(403);
    expect(owner.toAuthErrorResponse(new owner.SecurityUnavailableError())?.status).toBe(503);

    const response = owner.toAuthErrorResponse(new owner.UnauthorizedError());
    expect(await response?.text()).toBe('');
  });

  it('passes genuine bugs through instead of flattening them into a 401', () => {
    // A TypeError reported as "Unauthorized" is a debugging trap.
    expect(owner.toAuthErrorResponse(new TypeError('genuine bug'))).toBeNull();
  });
});
