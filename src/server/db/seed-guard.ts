/**
 * Refuses synthetic seeding against anything that isn't unambiguously a local
 * database.
 *
 * `pnpm db:seed` was once run by accident against a real Supabase database —
 * an easy mistake right after legitimately running `db:migrate` and
 * `db:provision-owner` against production in the same shell, with
 * `DATABASE_URL` still pointed there. This checks the connection string's own
 * host rather than `NODE_ENV`: an ad-hoc operator shell running production
 * commands frequently has no `NODE_ENV` set at all, so a check gated on
 * `NODE_ENV !== 'production'` would silently pass in exactly the scenario
 * that caused the original mistake. A real deployment's host is never
 * `localhost` — that is true regardless of what environment variables happen
 * to be set.
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The connection string's hostname, or `null` if it cannot be parsed as a URL. */
export function databaseHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function isLocalDatabaseUrl(url: string): boolean {
  const hostname = databaseHostname(url);
  return hostname !== null && LOCAL_HOSTNAMES.has(hostname);
}
