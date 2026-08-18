#!/usr/bin/env node
/**
 * Provision the single owner row in `user`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Cloudflare Access authenticates the owner's Google account at the edge; it
 * does not create database rows. `requireOwner()` (src/server/auth/owner.ts)
 * only ever RESOLVES the owner by verified email — it never inserts one, on
 * purpose: an incoming request, however well authenticated, must not be able
 * to conjure a database row into existence on its own. So the very first row
 * has to come from somewhere else. This script is that somewhere else: a
 * deliberate, out-of-band, operator-run step, once per deployment.
 *
 * Idempotent — safe to run again. A second run against an already-provisioned
 * OWNER_EMAIL changes nothing.
 *
 *   node scripts/provision-owner.mjs
 *
 * WHY PLAIN ESM AND NOT TYPESCRIPT
 *
 * Same reasoning as scripts/migrate.mjs and scripts/auth-grant.mjs: this needs
 * only `postgres` and `node:crypto`, both already production dependencies.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'node:crypto';

async function main() {
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
    const existing = await sql`select "id" from "user" where "email" = ${email} limit 1`;

    if (existing[0]) {
      console.log(`Owner already provisioned: ${existing[0].id} <${email}>`);
      return;
    }

    const id = randomUUID();
    await sql`
      insert into "user" ("id", "name", "email", "email_verified")
      values (${id}, ${email}, ${email}, true)
    `;

    console.log(`Owner provisioned: ${id} <${email}>`);
    console.log('Cloudflare Access + this database row is now the entire login path.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
