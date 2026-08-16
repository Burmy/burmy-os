/**
 * Development seed — SYNTHETIC DATA ONLY.
 *
 * Never seed from a real statement. Real financial data does not belong in a
 * script that is committed to git, and `.gitignore` blocks *.csv repo-wide
 * precisely so that mistake is hard to make.
 *
 * Idempotent: safe to run repeatedly.
 */

import 'dotenv/config';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

const OWNER_ID = 'dev-owner';
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'dev@example.invalid';

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

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });

  try {
    await db
      .insert(schema.user)
      .values({ id: OWNER_ID, name: 'Dev Owner', email: OWNER_EMAIL, emailVerified: true })
      .onConflictDoNothing();

    const existingAccounts = await db
      .select()
      .from(schema.financeAccounts)
      .where(eq(schema.financeAccounts.ownerId, OWNER_ID));

    if (existingAccounts.length === 0) {
      await db.insert(schema.financeAccounts).values(
        ACCOUNTS.map((a, i) => ({
          ownerId: OWNER_ID,
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
      .where(eq(schema.financeCategories.ownerId, OWNER_ID));

    if (existingCategories.length === 0) {
      await db.insert(schema.financeCategories).values(
        CATEGORIES.map((c, i) => ({
          ownerId: OWNER_ID,
          name: c.name,
          slug: slugify(c.name),
          kind: c.kind,
          sortOrder: i,
        })),
      );
    }

    console.log(`Seeded ${ACCOUNTS.length} accounts and ${CATEGORIES.length} categories.`);
    console.log('No transactions seeded — those arrive through the importer (M5).');
  } catch (error) {
    console.error('Seed failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void main();
