/**
 * Development seed — SYNTHETIC DATA ONLY.
 *
 * Never seed from a real statement. Real financial data does not belong in a
 * script that is committed to git, and `.gitignore` blocks *.csv repo-wide
 * precisely so that mistake is hard to make.
 *
 * Idempotent: safe to run repeatedly.
 *
 * Refuses to run unless `DATABASE_URL` points at localhost — see
 * `./seed-guard.ts`. This has nothing to do with `NODE_ENV`, on purpose.
 *

 * ─────────────────────────────────────────────────────────────────────────────
 * THIS SCRIPT NEVER CREATES OR CLAIMS AN AUTH USER.
 *
 * It used to, with a hardcoded id of `dev-owner`, which broke the moment M2
 * introduced real authentication: whichever of seeding or owner-provisioning
 * ran second collided with the `email` unique constraint the other had
 * already claimed.
 *
 * `scripts/provision-owner.mjs` owns creating the row now (see
 * `requireOwner()` in `src/server/auth/owner.ts`, which only ever RESOLVES it
 * by email and never inserts one). This script only ever RESOLVES it too, and
 * refuses to run if it is absent. Owning identity in two places is how the two
 * disagree.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import 'dotenv/config';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';
import { databaseHostname, isLocalDatabaseUrl } from './seed-guard';

/** Mirrors the shape of the owner's real sheet: categories AND merchant-shaped rows. */
const CATEGORIES: Array<{ name: string; kind: 'spending' | 'income' | 'investment' }> = [
  { name: 'Mortgage', kind: 'spending' },
  { name: 'Car Payment', kind: 'spending' },
  { name: 'Gas', kind: 'spending' },
  { name: 'Food', kind: 'spending' },
  { name: 'Travel', kind: 'spending' },
  { name: 'Amazon', kind: 'spending' },
  { name: 'Shopping', kind: 'spending' },
  { name: 'Planet Fitness', kind: 'spending' },
  { name: 'Apple Storage', kind: 'spending' },
  { name: 'Stocks', kind: 'investment' },
  { name: 'Paycheck', kind: 'income' },
];

const ACCOUNTS: Array<{
  name: string;
  type: 'checking' | 'savings' | 'credit_card' | 'brokerage';
}> = [
  { name: 'BoA Checking', type: 'checking' },
  { name: 'BoA Savings', type: 'savings' },
  { name: 'BoA Credit Card', type: 'credit_card' },
  { name: 'Brokerage', type: 'brokerage' },
];

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function explainNonLocalDatabase(url: string): void {
  const hostname = databaseHostname(url);
  console.error('');
  console.error(
    hostname
      ? `  DATABASE_URL does not point at a local database (host: "${hostname}").`
      : '  DATABASE_URL could not be parsed as a connection string.',
  );
  console.error('');
  console.error('  db:seed inserts SYNTHETIC data and must never run against a real');
  console.error('  deployment — this guard exists because that mistake has happened before.');
  console.error('');
  console.error('  If this is local development, DATABASE_URL should point at localhost,');
  console.error('  matching compose.dev.yml / .env.example.');
  console.error('');
}

function explainMissingOwner(email: string): void {
  console.error('');
  console.error(`  No owner row found for OWNER_EMAIL=${email}.`);
  console.error('');
  console.error('  Burmy has no signup route, and this script will not invent an');
  console.error('  identity. Provision the owner first:');
  console.error('');
  console.error('    node scripts/provision-owner.mjs');
  console.error('');
  console.error('  then re-run `pnpm db:seed`.');
  console.error('');
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!email) {
    console.error('OWNER_EMAIL is not set');
    process.exit(1);
  }

  if (!isLocalDatabaseUrl(url)) {
    explainNonLocalDatabase(url);
    process.exit(1);
  }

  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });

  try {
    // RESOLVE, never create. scripts/provision-owner.mjs owns this row.
    const owners = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1);

    const ownerId = owners[0]?.id;
    if (!ownerId) {
      explainMissingOwner(email);
      process.exitCode = 1;
      return;
    }

    const existingAccounts = await db
      .select()
      .from(schema.financeAccounts)
      .where(eq(schema.financeAccounts.ownerId, ownerId));

    if (existingAccounts.length === 0) {
      await db.insert(schema.financeAccounts).values(
        ACCOUNTS.map((a, i) => ({
          ownerId,
          name: a.name,
          type: a.type,
          institution: 'Bank of America',
          sortOrder: i,
        })),
      );
    }

    const existingCategories = await db
      .select()
      .from(schema.financeCategories)
      .where(eq(schema.financeCategories.ownerId, ownerId));

    if (existingCategories.length === 0) {
      await db.insert(schema.financeCategories).values(
        CATEGORIES.map((c, i) => ({
          ownerId,
          name: c.name,
          slug: slugify(c.name),
          kind: c.kind,
          sortOrder: i,
        })),
      );
    }

    console.log(`Seeded ${ACCOUNTS.length} accounts and ${CATEGORIES.length} categories.`);
    console.log(`Owner resolved by email: ${ownerId}`);
    console.log('No transactions seeded — those arrive through the importer (M5).');
  } catch (error) {
    console.error('Seed failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void main();
