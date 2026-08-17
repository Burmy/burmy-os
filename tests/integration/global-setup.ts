import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import postgres from 'postgres';

/**
 * Starts one PostgreSQL 18 container for the whole integration run and applies
 * the committed migrations to it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE REAL MIGRATIONS AND NOT `drizzle-kit push`
 *
 * Because the thing worth testing is the schema that will actually exist in
 * production, and that is whatever `drizzle/*.sql` produces. Pushing the schema
 * straight from `schema.ts` would test the TypeScript model against itself and
 * would not notice a migration that fails to apply, or a hand-edited migration
 * that has drifted from the model. Applying the SQL in order is the same thing
 * `scripts/migrate.mjs` does in the container.
 *
 * The image is pinned to `postgres:18-alpine` — the same tag as
 * compose.dev.yml. Testing against a different major than production ships
 * would defeat the point.
 * ─────────────────────────────────────────────────────────────────────────────
 */

let container: StartedPostgreSqlContainer | undefined;

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'drizzle');

async function applyMigrations(connectionUri: string): Promise<number> {
  const entries = await readdir(MIGRATIONS_DIR);

  // Lexicographic order IS chronological order: drizzle-kit prefixes files with
  // a zero-padded, monotonically increasing index (0000_, 0001_, ...).
  const files = entries.filter((name) => name.endsWith('.sql')).sort();

  const sql = postgres(connectionUri, { max: 1 });
  try {
    for (const file of files) {
      const contents = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');

      // drizzle-kit separates statements it must not batch with this marker.
      // Honour it rather than sending the file as one string — a `CREATE TYPE`
      // followed by a table that uses it has to be two round trips.
      for (const statement of contents.split('--> statement-breakpoint')) {
        const trimmed = statement.trim();
        if (trimmed) await sql.unsafe(trimmed);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  return files.length;
}

export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('burmy_test')
    .withUsername('burmy')
    .withPassword('burmy')
    .start();

  const uri = container.getConnectionUri();
  const applied = await applyMigrations(uri);

  // Workers are separate processes, so `process.env` set here does not reach
  // them. `provide`/`inject` is the supported channel.
  project.provide('databaseUrl', uri);
  project.provide('migrationsApplied', applied);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
    migrationsApplied: number;
  }
}
