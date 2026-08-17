'use client';

import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/react';

/**
 * Browser-side Better Auth client.
 *
 * Only the passkey plugin is registered, mirroring the server. There is no
 * social plugin because there is no Google client in Better Auth — Google is
 * configured exactly once, in Cloudflare Access.
 *
 * No `baseURL`: the client defaults to the current origin, which is what we
 * want. Hardcoding one would let a stray build point the browser's auth calls
 * at the wrong host.
 */
export const authClient = createAuthClient({
  plugins: [passkeyClient()],
});

export const { signIn, signOut, useSession } = authClient;
