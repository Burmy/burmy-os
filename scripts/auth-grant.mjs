#!/usr/bin/env node
/**
 * Mint a bootstrap or break-glass recovery grant.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE BREAK-GLASS PATH. It is deliberately awkward.
 *
 *   Requires: Tailscale membership · an SSH key · shell access on the host ·
 *             the database password.
 *
 *   Provides: one short-lived (10 minute), single-use token, printed ONCE to
 *             this terminal.
 *
 * It is never exposed over HTTP, never emailed, and never rendered by the
 * application. An email-based recovery path would be a permanent phishable
 * backdoor around the very factor the passkey exists to provide, so there isn't
 * one — the trade is that recovery requires the operator to be the operator.
 *
 *   node scripts/auth-grant.mjs bootstrap    # the very first passkey
 *   node scripts/auth-grant.mjs recovery     # every passkey lost
 *
 * WHY PLAIN ESM AND NOT TYPESCRIPT
 *
 * Same reasoning as scripts/migrate.mjs: this needs only `postgres` and
 * `node:crypto`, both already production dependencies. Writing it in TypeScript
 * would drag tsx → esbuild → a platform-native binary into the recovery path —
 * and the recovery path is exactly where a missing optional binary must not be
 * able to stop you. It has to run on a host that may have just been rebuilt.
 *
 * The token format is duplicated from src/server/auth/grants.ts rather than
 * imported (that file is TypeScript). tests/unit/grant-script.test.ts imports
 * BOTH and asserts they agree, so the duplication cannot silently drift.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Keep these three in lockstep with src/server/auth/grants.ts. */
const GRANT_PREFIX = 'burmy-grant';
export const GRANT_TTL_SECONDS = 600;

export function generateGrantToken() {
  return randomBytes(32).toString('base64url');
}

export function grantIdentifier(token) {
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  return `${GRANT_PREFIX}:${digest}`;
}

export function encodeGrantPayload(payload) {
  return JSON.stringify(payload);
}

async function main() {
  const kind = process.argv[2];

  if (kind !== 'bootstrap' && kind !== 'recovery') {
    console.error('Usage: node scripts/auth-grant.mjs <bootstrap|recovery>');
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(2);
  }

  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!email) {
    console.error('OWNER_EMAIL is not set.');
    process.exit(2);
  }

  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const token = generateGrantToken();
    const expiresAt = new Date(Date.now() + GRANT_TTL_SECONDS * 1000);

    // Only the SHA-256 of the token is stored. A database dump — or the nightly
    // off-site backup — therefore never contains a usable credential.
    await sql`
      insert into "verification" ("id", "identifier", "value", "expires_at")
      values (
        ${randomUUID()},
        ${grantIdentifier(token)},
        ${encodeGrantPayload({ kind, email, issuedAt: new Date().toISOString() })},
        ${expiresAt}
      )
    `;

    console.log('');
    console.log(`  Burmy ${kind} grant`);
    console.log('  ─────────────────────────────────────────────────────────────');
    console.log(`  token    ${token}`);
    console.log(`  expires  ${expiresAt.toISOString()}  (${GRANT_TTL_SECONDS / 60} minutes)`);
    console.log('');
    console.log('  Single use. Redeem at:');
    console.log(`    POST /api/auth/burmy/redeem-grant  {"token":"…","kind":"${kind}"}`);
    console.log('');
    console.log('  You must still pass Cloudflare Access with the owner Google');
    console.log('  identity — this token replaces the passkey, not the outer gate.');
    console.log('');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run when invoked directly, so the format helpers above can be imported
// by the drift test without minting anything.
//
// `pathToFileURL` rather than string-concatenating `file://`: on Windows the
// naive form produces `file://C:\Users\...`, which never equals `import.meta.url`
// — the guard would silently always be false and the script would do nothing.
if (process.argv[1]) {
  const { pathToFileURL } = await import('node:url');
  if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
}
