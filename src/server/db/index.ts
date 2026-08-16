import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * Reuse the client across hot reloads in development. Without this, every edit
 * opens a new pool and Postgres runs out of connections within minutes.
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
    });

  const instance = drizzle(client, { schema });

  if (process.env.NODE_ENV !== 'production') {
    globalForDb.__burmyClient = client;
    globalForDb.__burmyDb = instance;
  }

  return instance;
}

/** Explicit accessor, for code that wants the connection point to be obvious. */
export function getDb(): Db {
  return init();
}

/**
 * Ergonomic handle. Behaves like a normal Drizzle instance but defers the
 * connection until the first property access.
 */
export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(init(), prop, receiver) as unknown;
  },
}) as Db;

export { schema };
