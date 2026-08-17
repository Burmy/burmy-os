import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CookieJar, authFetch, harness, resetDatabase, signInViaBootstrapGrant } from './harness';

/**
 * Session cookie attributes.
 *
 * These are asserted rather than trusted because every one of them is a single
 * word that silently undoes a structural protection if it changes — and none of
 * them would break a single feature if they were wrong.
 */

beforeAll(async () => {
  await harness();
});

beforeEach(async () => {
  await resetDatabase();
});

async function sessionCookie(): Promise<string> {
  const jar = new CookieJar();
  await signInViaBootstrapGrant(jar);

  const cookie = jar.rawSetCookies.find((raw) => raw.includes('session_token'));
  if (!cookie) throw new Error(`no session cookie set; got ${jar.rawSetCookies.join(' | ')}`);
  return cookie;
}

describe('session cookie', () => {
  it('is HOST-ONLY — no Domain attribute, ever', async () => {
    // THE assertion in this file. `Domain=.burmy.me` would make the cookie
    // readable by the public portfolio at burmy.me, and the whole reason Burmy
    // lives on its own origin is that an XSS over there must not be able to
    // touch this application. A host-only cookie has no Domain attribute at all.
    expect(await sessionCookie()).not.toMatch(/;\s*domain=/i);
  });

  it('is HttpOnly, so script cannot read it', async () => {
    // Statement descriptions are untrusted text rendered on every screen.
    expect(await sessionCookie()).toMatch(/;\s*httponly/i);
  });

  it('is SameSite=Lax', async () => {
    expect(await sessionCookie()).toMatch(/;\s*samesite=lax/i);
  });

  it('is scoped to the whole app with Path=/', async () => {
    expect(await sessionCookie()).toMatch(/;\s*path=\//i);
  });

  it('carries the burmy prefix rather than a generic name', async () => {
    expect(await sessionCookie()).toMatch(/^burmy\./);
  });

  it('is not Secure in development, where http://localhost would drop it', async () => {
    // Documented asymmetry: production sets `useSecureCookies: true`
    // unconditionally. In development the dev server is plain http and a Secure
    // cookie would simply never be stored, making local sign-in impossible.
    expect(process.env.NODE_ENV).toBe('development');
    expect(await sessionCookie()).not.toMatch(/;\s*secure/i);
  });
});

describe('sign-out', () => {
  it('clears the session cookie and the database row', async () => {
    const jar = new CookieJar();
    await signInViaBootstrapGrant(jar);

    const before = await authFetch('/get-session', { jar });
    expect(await before.json()).toMatchObject({ user: { email: 'owner@burmy.test' } });

    await authFetch('/sign-out', { method: 'POST', body: {}, jar });

    // Server-side storage means this is revocation, not just cookie deletion.
    const { sql } = await harness();
    const rows = await sql<{ n: string }[]>`select count(*)::text as n from "session"`;
    expect(rows[0]?.n).toBe('0');

    const after = await authFetch('/get-session', { jar });
    const body = await after.text();
    expect(body === '' || body === 'null').toBe(true);
  });
});

describe('no Google client is configured in Better Auth', () => {
  it('exposes no social sign-in endpoint', async () => {
    // Google is configured exactly once, in Cloudflare Access. A second client
    // here would collapse two factors into one and create a second allowlist to
    // drift out of sync.
    const response = await authFetch('/sign-in/social', {
      method: 'POST',
      body: { provider: 'google', callbackURL: '/' },
    });

    expect(response.ok).toBe(false);
  });

  it('exposes no email/password sign-in', async () => {
    const response = await authFetch('/sign-in/email', {
      method: 'POST',
      body: { email: 'owner@burmy.test', password: 'whatever' },
    });

    expect(response.ok).toBe(false);
  });

  it('exposes no sign-up route', async () => {
    // Not hidden, not disabled: never registered.
    const response = await authFetch('/sign-up/email', {
      method: 'POST',
      body: { email: 'owner@burmy.test', password: 'whatever', name: 'x' },
    });

    expect(response.ok).toBe(false);
  });

  it('writes no account rows', async () => {
    const jar = new CookieJar();
    await signInViaBootstrapGrant(jar);

    const { sql } = await harness();
    const rows = await sql<{ n: string }[]>`select count(*)::text as n from "account"`;
    // The table exists because Better Auth's core schema includes it. Burmy
    // never writes to it, and a row appearing here in production means someone
    // added a credential provider.
    expect(rows[0]?.n).toBe('0');
  });
});
