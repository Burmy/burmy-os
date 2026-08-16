import { sql } from 'drizzle-orm';

import { getDb } from '@/server/db';

/**
 * Liveness and readiness probe.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS ONE OF ONLY TWO UNAUTHENTICATED ENDPOINTS IN BURMY.
 * (The other is /api/auth/*, which authenticates by design.)
 *
 * Because it is reachable without a session, the response body is restricted to
 * BOOLEANS AND A VERSION STRING. Never add row counts, table names, error text,
 * environment details, connection strings, or timings that could fingerprint
 * the deployment. See docs/SECURITY.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  let database = false;

  try {
    await getDb().execute(sql`select 1`);
    database = true;
  } catch {
    // Deliberately swallowed. The reason a database is unreachable is exactly
    // the kind of detail that must not leak from an unauthenticated endpoint.
    // Operators read the container logs; the internet reads `false`.
    database = false;
  }

  const body = {
    ok: database,
    database,
    version: process.env.npm_package_version ?? '0.0.0',
  };

  return Response.json(body, {
    status: database ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
