import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CookieJar,
  authFetch,
  countRows,
  findOwner,
  harness,
  insertPasskey,
  issueGrant,
  resetDatabase,
} from './harness';

/**
 * BOOTSTRAP — how the FIRST passkey gets registered.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Milestone 2 implemented and measured BOTH candidates from the plan before
 * choosing. What shipped is the session-first design asserted below; the
 * rejected alternative and the evidence against it are recorded in
 * docs/SECURITY.md, "Bootstrap and recovery".
 *
 * The one-line version: Better Auth's passkey-first registration
 * (`registration.requireSession: false`) works, but it leaves
 * `/passkey/generate-register-options` answering unauthenticated callers
 * FOREVER in exchange for a once-ever operation — and the grant could not be
 * consumed at options-generation time without burning it whenever the browser
 * prompt was dismissed, so one token bought unlimited challenges for its whole
 * TTL. Its implementation has been deleted rather than left behind a flag,
 * because a `requireSession: false` code path in the tree is one edit away from
 * being live.
 *
 * The first test below is the property that decided it.
 *
 * The WebAuthn ceremony itself needs a real authenticator and is covered in
 * tests/e2e/passkey.spec.ts with Chrome's virtual authenticator.
 * ─────────────────────────────────────────────────────────────────────────────
 */

beforeAll(async () => {
  await harness();
});

beforeEach(async () => {
  await resetDatabase();
});

describe('passkey registration is unreachable without a session', () => {
  it('refuses registration options to an anonymous caller, grant or not', async () => {
    // THE decisive property. With `requireSession` left at its default, there is
    // no callback standing between an anonymous request and a user record — the
    // endpoint simply is not there for them.
    const token = await issueGrant('bootstrap');

    const withGrant = await authFetch(
      `/passkey/generate-register-options?context=${encodeURIComponent(token)}`,
    );
    const withoutGrant = await authFetch('/passkey/generate-register-options');

    expect(withGrant.ok).toBe(false);
    expect(withoutGrant.ok).toBe(false);

    // And no owner row was conjured out of an unauthenticated request.
    expect(await countRows('user')).toBe(0);
  });

  it('refuses to verify a registration without a session', async () => {
    const response = await authFetch('/passkey/verify-registration', {
      method: 'POST',
      body: { response: {} },
    });

    expect(response.ok).toBe(false);
    expect(await countRows('passkey')).toBe(0);
  });
});

describe('bootstrap by redeeming a grant', () => {
  it('creates the owner and a session', async () => {
    const jar = new CookieJar();
    const token = await issueGrant('bootstrap');

    const response = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'bootstrap' },
      jar,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });

    const owner = await findOwner();
    expect(owner?.email).toBe('owner@burmy.test');
    expect(await countRows('session')).toBe(1);
    expect(jar.has('burmy')).toBe(true);
  });

  it('then allows enrolment through the ordinary authenticated path', async () => {
    const jar = new CookieJar();
    const token = await issueGrant('bootstrap');

    await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'bootstrap' },
      jar,
    });

    const response = await authFetch('/passkey/generate-register-options', { jar });

    expect(response.status).toBe(200);
    expect((await response.json()) as { challenge?: string }).toHaveProperty('challenge');
  });

  it('is single use', async () => {
    const token = await issueGrant('bootstrap');

    const first = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'bootstrap' },
      jar: new CookieJar(),
    });
    const second = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'bootstrap' },
      jar: new CookieJar(),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(await countRows('verification')).toBe(0);
  });

  it('is refused once a passkey already exists', async () => {
    // Stops a forgotten bootstrap token from becoming a permanent side door.
    // After enrolment, getting back in is RECOVERY and needs a recovery grant.
    const jar = new CookieJar();
    const first = await issueGrant('bootstrap');
    await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token: first, kind: 'bootstrap' },
      jar,
    });

    const owner = await findOwner();
    await insertPasskey(owner!.id, 'existing');

    const second = await issueGrant('bootstrap');
    const response = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token: second, kind: 'bootstrap' },
      jar: new CookieJar(),
    });

    expect(response.status).toBe(401);
  });

  it('refuses a recovery grant presented as bootstrap, and the reverse', async () => {
    const recoveryToken = await issueGrant('recovery');
    const asBootstrap = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token: recoveryToken, kind: 'bootstrap' },
    });
    expect(asBootstrap.status).toBe(401);

    const bootstrapToken = await issueGrant('bootstrap');
    const asRecovery = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token: bootstrapToken, kind: 'recovery' },
    });
    expect(asRecovery.status).toBe(401);

    // Spent either way, so a kind mismatch is not a free probe.
    expect(await countRows('verification')).toBe(0);
  });

  it('refuses a grant minted for a different email', async () => {
    const token = await issueGrant('bootstrap', { email: 'someone-else@elsewhere.test' });

    const response = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'bootstrap' },
    });

    expect(response.status).toBe(401);
    expect(await countRows('user')).toBe(0);
  });

  it('refuses an expired grant', async () => {
    const token = await issueGrant('bootstrap', { expiresAt: new Date(Date.now() - 1000) });

    const response = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'bootstrap' },
    });

    expect(response.status).toBe(401);
  });

  it('returns one indistinguishable failure for every rejection reason', async () => {
    const cases = [
      { token: 'nonexistent', kind: 'bootstrap' as const },
      { token: await issueGrant('recovery'), kind: 'bootstrap' as const },
      {
        token: await issueGrant('bootstrap', { expiresAt: new Date(Date.now() - 1000) }),
        kind: 'bootstrap' as const,
      },
      { token: await issueGrant('bootstrap', { email: 'x@y.test' }), kind: 'bootstrap' as const },
    ];

    const seen = new Set<string>();
    for (const body of cases) {
      const response = await authFetch('/burmy/redeem-grant', { method: 'POST', body });
      seen.add(`${response.status}:${await response.text()}`);
    }

    expect(seen.size).toBe(1);
  });

  it('audits the redemption without recording the token', async () => {
    const token = await issueGrant('bootstrap');
    await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'bootstrap' },
      jar: new CookieJar(),
    });

    const { sql } = await harness();
    const rows = await sql<{ event_type: string; metadata: unknown }[]>`
      select "event_type", "metadata" from "audit_events"
    `;

    expect(rows.map((row) => row.event_type)).toContain('auth.bootstrap.token_redeemed');
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});
