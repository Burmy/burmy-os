/**
 * Migration runner — plain ESM, deliberately NOT TypeScript.
 *
 * Runs directly on whatever host invokes it — `node scripts/migrate.mjs` (or
 * `pnpm db:migrate` locally) — identically in CI, local development, and the
 * manual production migration step (see docs/DEPLOYMENT.md). No Docker image,
 * no build step, nothing to keep in sync.
 *
 * Why plain .mjs rather than TypeScript via tsx:
 *
 *   Applying migrations only needs to read the generated SQL in drizzle/ and
 *   execute it. It does not need the schema types, so dragging in
 *   tsx -> esbuild -> a platform-native binary just to run a few
 *   `CREATE TABLE` statements would be needless weight for what this does.
 *
 *   As plain ESM it depends on nothing but `drizzle-orm` and `postgres`, both
 *   already production dependencies.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

// A dedicated single connection: migrations must not share the app pool, and
// `max: 1` keeps DDL strictly sequential.
const client = postgres(url, { max: 1, onnotice: () => {} });

try {
  console.log('Running migrations...');
  await migrate(drizzle(client), { migrationsFolder: './drizzle' });
  console.log('Migrations complete.');
} catch (error) {
  // Log the message only. A migration error can echo column values back, and
  // this database holds financial data.
  console.error('Migration failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
} finally {
  await client.end();
}
