import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CookieJar,
  auditEventTypes,
  authFetch,
  countRows,
  harness,
  insertPasskey,
  resetDatabase,
  signInViaBootstrapGrant,
} from './harness';

/**
 * Burmy's policy on top of the passkey plugin — enforced SERVER-SIDE.
 *
 * All three of these are things the plugin does NOT do by default, and all three
 * are asserted here rather than trusted to a disabled button. A UI that hides an
 * action is a preference; a server that refuses it is a control.
 */

beforeAll(async () => {
  await harness();
});

beforeEach(async () => {
  await resetDatabase();
});

async function signedInWithPasskeys(count: number): Promise<{
  jar: CookieJar;
  userId: string;
  passkeyIds: string[];
}> {
  const jar = new CookieJar();
  const { userId } = await signInViaBootstrapGrant(jar);

  const passkeyIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    passkeyIds.push(await insertPasskey(userId, `device-${i + 1}`));
  }

  return { jar, userId, passkeyIds };
}

describe('removing a passkey requires re-authentication', () => {
  it('allows removal with a fresh session', async () => {
    const { jar, passkeyIds } = await signedInWithPasskeys(2);

    const response = await authFetch('/passkey/delete-passkey', {
      method: 'POST',
      body: { id: passkeyIds[0] },
      jar,
    });

    expect(response.status).toBe(200);
    expect(await countRows('passkey')).toBe(1);
    expect(await auditEventTypes()).toContain('auth.passkey.removed');
  });

  it('REFUSES removal with a stale session', async () => {
    // Better Auth guards this endpoint with `sessionMiddleware`, which accepts
    // any valid session — including a week-old one on a device that walked away.
    // Deleting a credential is exactly what an opportunist does with a borrowed
    // unlocked laptop, so Burmy adds a freshness requirement.
    const { jar, passkeyIds } = await signedInWithPasskeys(2);

    const { sql } = await harness();
    await sql`update "session" set "created_at" = now() - interval '16 minutes'`;

    const response = await authFetch('/passkey/delete-passkey', {
      method: 'POST',
      body: { id: passkeyIds[0] },
      jar,
    });

    expect(response.status).toBe(403);
    expect(await countRows('passkey')).toBe(2);
    expect(await auditEventTypes()).toContain('auth.reauth.failure');
  });

  it('refuses removal with no session at all', async () => {
    const { passkeyIds } = await signedInWithPasskeys(2);

    const response = await authFetch('/passkey/delete-passkey', {
      method: 'POST',
      body: { id: passkeyIds[0] },
      jar: new CookieJar(),
    });

    expect(response.ok).toBe(false);
    expect(await countRows('passkey')).toBe(2);
  });
});

describe('the last passkey cannot be deleted', () => {
  it('refuses when only one remains', async () => {
    // Recovery deliberately requires Tailscale, an SSH key and a terminal. A
    // single mis-click must not be able to send the owner there.
    const { jar, passkeyIds } = await signedInWithPasskeys(1);

    const response = await authFetch('/passkey/delete-passkey', {
      method: 'POST',
      body: { id: passkeyIds[0] },
      jar,
    });

    expect(response.status).toBe(400);
    expect(await countRows('passkey')).toBe(1);
  });

  it('allows going from two down to one', async () => {
    // Two → one is allowed; the onboarding gate then asks for a replacement.
    // One → zero is not. The gate and this rule are different controls.
    const { jar, passkeyIds } = await signedInWithPasskeys(2);

    const first = await authFetch('/passkey/delete-passkey', {
      method: 'POST',
      body: { id: passkeyIds[0] },
      jar,
    });
    expect(first.status).toBe(200);

    const second = await authFetch('/passkey/delete-passkey', {
      method: 'POST',
      body: { id: passkeyIds[1] },
      jar,
    });
    expect(second.status).toBe(400);
    expect(await countRows('passkey')).toBe(1);
  });
});

describe('passkey listing', () => {
  it('requires a session', async () => {
    await signedInWithPasskeys(2);

    const response = await authFetch('/passkey/list-user-passkeys', { jar: new CookieJar() });

    expect(response.ok).toBe(false);
  });

  it('never returns anything resembling a private key', async () => {
    const { jar } = await signedInWithPasskeys(2);

    const response = await authFetch('/passkey/list-user-passkeys', { jar });
    expect(response.status).toBe(200);

    const body = await response.text();
    // A stored `publicKey` is public by definition — it authenticates, it does
    // not decrypt. The private key never leaves the authenticator, which is the
    // whole reason a passkey is a different factor from a Google password.
    expect(body.toLowerCase()).not.toContain('privatekey');
    expect(body.toLowerCase()).not.toContain('private_key');
  });
});
