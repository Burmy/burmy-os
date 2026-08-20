import { randomUUID } from 'node:crypto';

import { inject } from 'vitest';

/**
 * Integration harness: real Postgres, real Cloudflare Access verification.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY EVERYTHING GOES THROUGH `init()` INSTEAD OF TOP-LEVEL IMPORTS
 *
 * `src/server/db` reads `DATABASE_URL` on first use and then caches. A test
 * file that imported an application module before the container's URL was
 * known would cache a client pointed at nothing, and fail in a way that looks
 * like a database bug. So application modules are imported DYNAMICALLY, after
 * the environment is populated, and tests may only reach them through this
 * harness.
 *
 * WHY `NODE_ENV=development` HERE
 *
 * Cloudflare Access is the sole authentication mechanism, and there is no
 * Cloudflare in a test container. Its verification — signature, `aud`, `iss`,
 * `exp`, owner match — is covered exhaustively in tests/unit/access.test.ts
 * against a locally generated key pair, which is the real cryptographic path
 * with only the key source swapped. These suites therefore run in the
 * dev-bypass so they can concentrate on owner resolution and the fail-closed
 * behavior that the bypass would otherwise hide is asserted explicitly in
 * tests/integration/owner-guard.test.ts, which flips NODE_ENV back to
 * production and proves requireOwner() refuses rather than falls through.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const OWNER_EMAIL = 'owner@burmy.test';

interface Harness {
  readonly sql: import('postgres').Sql;
}

let harnessPromise: Promise<Harness> | undefined;

async function init(): Promise<Harness> {
  process.env.DATABASE_URL = inject('databaseUrl');
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  // Next.js's type augmentation marks NODE_ENV readonly; this is a test harness
  // deliberately choosing the dev-bypass, so the cast is explicit rather than hidden.
  (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
  delete process.env.CF_ACCESS_TEAM_DOMAIN;
  delete process.env.CF_ACCESS_AUD;

  const postgres = (await import('postgres')).default;

  return { sql: postgres(process.env.DATABASE_URL, { max: 4 }) };
}

export function harness(): Promise<Harness> {
  harnessPromise ??= init();
  return harnessPromise;
}

/**
 * Wipe every table Burmy writes, including the auth tables inherited from the
 * removed Better Auth integration — they still exist (CLAUDE.md: no
 * destructive migration without a concrete reason) and truncating them costs
 * nothing even though nothing writes to them anymore.
 */
export async function resetDatabase(): Promise<void> {
  const { sql } = await harness();
  // `user` cascades to every finance table via owner_id, so the finance rows go
  // with it — but they are listed explicitly so a future table that is NOT
  // cascade-linked cannot silently start leaking between tests.
  await sql.unsafe(
    'truncate table "audit_events", "rate_limit", "verification", "passkey", "session", "account", ' +
      '"finance_transactions", "finance_import_rows", "finance_import_files", "finance_imports", ' +
      '"finance_categories", "finance_accounts", "games", "user" cascade',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Insert the owner row directly, exactly as scripts/provision-owner.mjs does. */
export async function provisionOwner(email: string = OWNER_EMAIL): Promise<string> {
  const { sql } = await harness();
  const id = randomUUID();
  await sql`
    insert into "user" ("id", "name", "email", "email_verified")
    values (${id}, ${email}, ${email}, true)
  `;
  return id;
}

export async function countRows(table: string): Promise<number> {
  const { sql } = await harness();
  const rows = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from "${table}"`);
  return Number(rows[0]?.n ?? '0');
}

export async function auditEventTypes(): Promise<string[]> {
  const { sql } = await harness();
  const rows = await sql<{ event_type: string }[]>`
    select "event_type" from "audit_events" order by "at" asc
  `;
  return rows.map((row) => row.event_type);
}
