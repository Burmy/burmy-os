import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CookieJar,
  auditEventTypes,
  authFetch,
  countRows,
  findOwner,
  harness,
  insertPasskey,
  issueGrant,
  resetDatabase,
  signInViaBootstrapGrant,
} from './harness';

/**
 * MILESTONE 2 PROTOTYPE — what happens when EVERY passkey is lost?
 *
 * Better Auth documents nothing here, and the one-time-token plugin does not
 * help: it derives a token FROM an existing session for cross-domain handoff,
 * which is useless when the whole problem is having no way to get a session.
 *
 * Two candidates were considered:
 *
 *   CANDIDATE A — a shell-only grant, minted by scripts/auth-grant.mjs over
 *     SSH-through-Tailscale, never exposed over HTTP, redeemed once.
 *
 *   CANDIDATE B — an offline recovery CODE, generated at onboarding and stored
 *     in a password manager, redeemable over HTTP at any time.
 *
 * B was rejected on a property these tests make concrete: a credential that is
 * valid indefinitely and redeemable from anywhere is a permanent second door
 * with no expiry, and its security rests entirely on the owner never mislaying
 * a printout. A is implemented. See docs/SECURITY.md for the full comparison.
 */

beforeAll(async () => {
  await harness();
});

beforeEach(async () => {
  await resetDatabase();
});

/** Get to "enrolled, then lost everything". */
async function enrolledThenLostAllPasskeys(): Promise<{ userId: string }> {
  const jar = new CookieJar();
  const { userId } = await signInViaBootstrapGrant(jar);
  await insertPasskey(userId, 'phone');
  await insertPasskey(userId, 'laptop');

  const { sql } = await harness();
  // The disaster: both authenticators gone, and the old session with them.
  await sql`delete from "passkey"`;
  await sql`delete from "session"`;

  return { userId };
}

describe('recovery when all passkeys are lost', () => {
  it('mints a working session from a recovery grant', async () => {
    const { userId } = await enrolledThenLostAllPasskeys();
    expect(await countRows('passkey')).toBe(0);
    expect(await countRows('session')).toBe(0);

    const jar = new CookieJar();
    const token = await issueGrant('recovery');

    const response = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'recovery' },
      jar,
    });

    expect(response.status).toBe(200);
    expect(await countRows('session')).toBe(1);

    // Same owner row — recovery must not fork a second identity.
    const owner = await findOwner();
    expect(owner?.id).toBe(userId);
  });

  it('the recovered session can enrol replacement passkeys', async () => {
    // The point of recovery: not just getting in, but getting back to a state
    // where the passkey is the credential again.
    await enrolledThenLostAllPasskeys();

    const jar = new CookieJar();
    const token = await issueGrant('recovery');
    await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'recovery' },
      jar,
    });

    const options = await authFetch('/passkey/generate-register-options', { jar });
    expect(options.status).toBe(200);
    expect((await options.json()) as { challenge?: string }).toHaveProperty('challenge');
  });

  it('is single use', async () => {
    await enrolledThenLostAllPasskeys();
    const token = await issueGrant('recovery');

    const first = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'recovery' },
      jar: new CookieJar(),
    });
    const second = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'recovery' },
      jar: new CookieJar(),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it('survives concurrent redemption attempts — exactly one wins', async () => {
    // `consumeVerificationValue` claims the row inside a transaction via an
    // atomic consume, so a race cannot mint two sessions from one grant.
    await enrolledThenLostAllPasskeys();
    const token = await issueGrant('recovery');

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        authFetch('/burmy/redeem-grant', {
          method: 'POST',
          body: { token, kind: 'recovery' },
          jar: new CookieJar(),
        }),
      ),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await countRows('session')).toBe(1);
  });

  it('expires after its TTL', async () => {
    await enrolledThenLostAllPasskeys();
    const token = await issueGrant('recovery', { expiresAt: new Date(Date.now() - 1000) });

    const response = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'recovery' },
      jar: new CookieJar(),
    });

    expect(response.status).toBe(401);
    expect(await countRows('session')).toBe(0);
  });

  it('revokes every pre-existing session', async () => {
    // The owner is here because their credentials are gone. Any session still
    // alive is forgotten at best.
    const jar = new CookieJar();
    const { userId } = await signInViaBootstrapGrant(jar);
    await insertPasskey(userId, 'one');
    expect(await countRows('session')).toBe(1);

    const token = await issueGrant('recovery');
    await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'recovery' },
      jar: new CookieJar(),
    });

    // The new session, and only the new session.
    expect(await countRows('session')).toBe(1);

    // The old cookie is dead immediately, because sessions live in Postgres.
    const stale = await authFetch('/get-session', { jar });
    const body = await stale.text();
    expect(body === '' || body === 'null').toBe(true);
  });

  it('refuses recovery when no owner exists at all', async () => {
    // Nothing to recover: this is a bootstrap situation, and conflating the two
    // would let a recovery grant create an identity.
    const token = await issueGrant('recovery');

    const response = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'recovery' },
      jar: new CookieJar(),
    });

    expect(response.status).toBe(401);
    expect(await countRows('user')).toBe(0);
  });

  it('is rate limited, and the counters live in Postgres', async () => {
    await enrolledThenLostAllPasskeys();

    // Five attempts per hour on this path. Use wrong tokens so nothing succeeds
    // and the limiter is what stops us.
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await authFetch('/burmy/redeem-grant', {
        method: 'POST',
        body: { token: `wrong-${i}`, kind: 'recovery' },
        jar: new CookieJar(),
      });
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
    // A restart must not clear it — hence `storage: 'database'`.
    expect(await countRows('rate_limit')).toBeGreaterThan(0);

    // And a VALID token is refused too once the limit is hit, which is the
    // property that makes the limiter worth anything.
    const good = await issueGrant('recovery');
    const blocked = await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token: good, kind: 'recovery' },
      jar: new CookieJar(),
    });
    expect(blocked.status).toBe(429);
  });
});

describe('recovery audit trail', () => {
  it('records a redemption, the revocation, and no token material', async () => {
    await enrolledThenLostAllPasskeys();
    const jar = new CookieJar();
    const token = await issueGrant('recovery');

    await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token, kind: 'recovery' },
      jar,
    });

    expect(await auditEventTypes()).toContain('auth.recovery.token_redeemed');
    expect(await auditEventTypes()).toContain('auth.session.revoked');

    const { sql } = await harness();
    const rows = await sql<{ metadata: unknown }[]>`select "metadata" from "audit_events"`;
    const serialized = JSON.stringify(rows);

    // The audit table must never become the place the secret lives.
    expect(serialized).not.toContain(token);
    expect(serialized.toLowerCase()).not.toContain('owner@burmy.test');
  });

  it('records rejections with a reason, without the token', async () => {
    await enrolledThenLostAllPasskeys();

    await authFetch('/burmy/redeem-grant', {
      method: 'POST',
      body: { token: 'definitely-not-valid', kind: 'recovery' },
      jar: new CookieJar(),
    });

    expect(await auditEventTypes()).toContain('auth.recovery.token_rejected');

    const { sql } = await harness();
    const rows = await sql<{ metadata: Record<string, unknown> }[]>`
      select "metadata" from "audit_events" where "event_type" = 'auth.recovery.token_rejected'
    `;
    expect(rows[0]?.metadata).toMatchObject({ reason: 'unknown_or_expired' });
    expect(JSON.stringify(rows)).not.toContain('definitely-not-valid');
  });
});
