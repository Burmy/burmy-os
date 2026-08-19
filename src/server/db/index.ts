import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * Reuse the client across hot reloads in development, and across invocations
 * within the same warm serverless instance in production. Without this,
 * every call to `getDb()` opens a brand-new pool that is never closed —
 * fatal against Supabase's connection ceiling under real traffic, not just
 * a dev-mode HMR problem. (Previously gated on `NODE_ENV !== 'production'`,
 * which meant PRODUCTION never cached at all — see CLAUDE.md.)
 */
const globalForDb = globalThis as unknown as {
  __burmyClient?: ReturnType<typeof postgres>;
  __burmyDb?: Db;
};

/**
 * Connect lazily, on first query — NOT at module import.
 *
 * `next build` imports route modules to analyze them. Connecting at import time
 * would make every production build require a live database and a populated
 * DATABASE_URL, which is both wrong and a genuine deployment footgun.
 */
function init(): Db {
  if (globalForDb.__burmyDb) return globalForDb.__burmyDb;

  const url = process.env.DATABASE_URL;
  if (!url) {
    // Fail loudly and specifically. A missing DATABASE_URL is a deployment
    // error; discovering it mid-request means discovering it during an import.
    throw new Error('DATABASE_URL is not set');
  }

  const client =
    globalForDb.__burmyClient ??
    postgres(url, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      // Required whenever `DATABASE_URL` might point through Supabase's
      // Supavisor pooler in transaction mode (the mode serverless functions
      // should use) — prepared statements aren't valid across pooled
      // connections, since a later query in the "same" prepared statement can
      // land on a different underlying Postgres connection. Harmless against
      // a direct, unpooled connection (local dev, migrations): it only
      // disables an optimization, never changes correctness.
      prepare: false,
    });

  const instance = drizzle(client, { schema });

  globalForDb.__burmyClient = client;
  globalForDb.__burmyDb = instance;

  return instance;
}

export function getDb(): Db {
  return init();
}
