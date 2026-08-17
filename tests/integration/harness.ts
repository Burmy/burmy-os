import { inject } from 'vitest';

/**
 * Integration harness: real Postgres, real Better Auth, real HTTP semantics.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY EVERYTHING GOES THROUGH `init()` INSTEAD OF TOP-LEVEL IMPORTS
 *
 * `src/server/db` and `src/server/auth` both read `DATABASE_URL` on first use
 * and then cache. A test file that did `import { auth } from '@/server/auth'`
 * would evaluate that module before the container's URL was known, cache a
 * client pointed at nothing, and fail in a way that looks like a database bug.
 * So the application modules are imported DYNAMICALLY, after the environment is
 * populated, and tests may only reach them through this harness.
 *
 * WHY `NODE_ENV=development` HERE
 *
 * Factor 1 is Cloudflare Access, and there is no Cloudflare in a test container.
 * Its verification — signature, `aud`, `iss`, `exp`, owner match — is covered
 * exhaustively in tests/unit/access.test.ts against a locally generated key
 * pair, which is the real cryptographic path with only the key source swapped.
 * These suites therefore run in the dev-bypass so they can concentrate on
 * factor 2, sessions, grants, onboarding and rate limiting.
 *
 * The fail-closed behaviour that the bypass would otherwise hide is asserted
 * explicitly in tests/integration/fail-closed.test.ts, which flips `NODE_ENV`
 * and proves the endpoints refuse rather than fall through.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const OWNER_EMAIL = 'owner@burmy.test';
export const NON_OWNER_EMAIL = 'someone-else@elsewhere.test';
export const BASE_URL = 'http://localhost:3000';

interface Harness {
  readonly auth: {
    handler: (request: Request) => Promise<Response>;
  };
  readonly sql: import('postgres').Sql;
}

let harnessPromise: Promise<Harness> | undefined;

async function init(): Promise<Harness> {
  process.env.DATABASE_URL = inject('databaseUrl');
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.BETTER_AUTH_URL = BASE_URL;
  process.env.BETTER_AUTH_SECRET = 'integration-test-secret-not-a-real-one-0123456789';
  // Next.js's type augmentation marks NODE_ENV readonly; this is a test harness
  // deliberately choosing the dev-bypass, so the cast is explicit rather than hidden.
  (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
  delete process.env.CF_ACCESS_TEAM_DOMAIN;
  delete process.env.CF_ACCESS_AUD;

  const [{ getAuth }, postgres] = await Promise.all([
    import('@/server/auth'),
    import('postgres').then((m) => m.default),
  ]);

  return {
    auth: getAuth(),
    sql: postgres(process.env.DATABASE_URL, { max: 4 }),
  };
}

export function harness(): Promise<Harness> {
  harnessPromise ??= init();
  return harnessPromise;
}

/**
 * Wipe every table Better Auth or Burmy writes.
 *
 * `rate_limit` is included deliberately: the grant endpoint allows five attempts
 * per hour, so without this the sixth test in a run would fail for the wrong
 * reason. The one test that DOES care about the limiter exhausts it on purpose
 * after a reset.
 */
export async function resetDatabase(): Promise<void> {
  const { sql } = await harness();
  // `user` cascades to every finance table via owner_id, so the finance rows go
  // with it — but they are listed explicitly so a future table that is NOT
  // cascade-linked cannot silently start leaking between tests.
  await sql.unsafe(
    'truncate table "audit_events", "rate_limit", "verification", "passkey", "session", "account", ' +
      '"finance_transactions", "finance_import_rows", "finance_import_files", "finance_imports", ' +
      '"finance_categories", "finance_accounts", "user" cascade',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A cookie jar, because session behaviour IS the thing under test
// ─────────────────────────────────────────────────────────────────────────────

export class CookieJar {
  private readonly cookies = new Map<string, string>();
  /** Raw `Set-Cookie` values, kept so attributes can be asserted. */
  readonly rawSetCookies: string[] = [];

  capture(response: Response): void {
    const values = response.headers.getSetCookie();
    for (const raw of values) {
      this.rawSetCookies.push(raw);
      const [pair] = raw.split(';');
      if (!pair) continue;
      const index = pair.indexOf('=');
      if (index <= 0) continue;

      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();

      // An expired cookie is a deletion. Honouring that is what makes
      // "sign-out actually signs out" observable here.
      if (/(^|;)\s*max-age=0\b/i.test(raw) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  has(namePrefix: string): boolean {
    return [...this.cookies.keys()].some((name) => name.startsWith(namePrefix));
  }

  clear(): void {
    this.cookies.clear();
    this.rawSetCookies.length = 0;
  }
}

export interface AuthRequestInit {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly jar?: CookieJar;
  readonly headers?: Record<string, string>;
  /** Defaults to BASE_URL; WebAuthn verification checks it. */
  readonly origin?: string | null;
}

/**
 * Call a Better Auth endpoint the way the browser would.
 *
 * Deliberately goes through `auth.handler(new Request(...))` rather than calling
 * `auth.api.*` directly: the HTTP layer is where cookies, origin checks and the
 * rate limiter live, and those are precisely the behaviours being asserted.
 */
export async function authFetch(path: string, init: AuthRequestInit = {}): Promise<Response> {
  const { auth } = await harness();
  const method = init.method ?? 'GET';

  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set('origin', init.origin ?? BASE_URL);
  if (init.jar) {
    const cookie = init.jar.header();
    if (cookie) headers.set('cookie', cookie);
  }
  if (init.body !== undefined) headers.set('content-type', 'application/json');

  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );

  init.jar?.capture(response);
  return response;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint a grant exactly as `scripts/auth-grant.mjs` does.
 *
 * The script's own format is cross-checked against `src/server/auth/grants.ts`
 * in tests/unit/grant-script.test.ts, so this helper cannot drift from the real
 * operator path without that test failing.
 */
export async function issueGrant(
  kind: 'bootstrap' | 'recovery',
  options: { readonly email?: string; readonly expiresAt?: Date } = {},
): Promise<string> {
  const { sql } = await harness();
  const [{ generateGrantToken, grantIdentifier, encodeGrantPayload, grantExpiry }, { randomUUID }] =
    await Promise.all([import('@/server/auth/grants'), import('node:crypto')]);

  const token = generateGrantToken();

  await sql`
    insert into "verification" ("id", "identifier", "value", "expires_at")
    values (
      ${randomUUID()},
      ${grantIdentifier(token)},
      ${encodeGrantPayload({ kind, email: options.email ?? OWNER_EMAIL, issuedAt: new Date(0).toISOString() })},
      ${options.expiresAt ?? grantExpiry()}
    )
  `;

  return token;
}

export async function findOwner(): Promise<{ id: string; email: string } | null> {
  const { sql } = await harness();
  const rows = await sql<{ id: string; email: string }[]>`
    select "id", "email" from "user" limit 1
  `;
  return rows[0] ?? null;
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

/**
 * Insert a passkey row directly.
 *
 * Real WebAuthn ceremonies need an authenticator, which is Playwright's job
 * (tests/e2e, via the CDP virtual authenticator). What these suites need is a
 * user who *has* n credentials, so that the two-passkey onboarding gate and the
 * "never delete your last passkey" rule can be exercised. Writing the row is the
 * honest way to reach that state without pretending to do crypto.
 */
export async function insertPasskey(userId: string, label: string): Promise<string> {
  const { sql } = await harness();
  const { randomUUID } = await import('node:crypto');
  const id = randomUUID();

  await sql`
    insert into "passkey"
      ("id", "name", "public_key", "user_id", "credential_id",
       "counter", "device_type", "backed_up", "transports")
    values
      (${id}, ${label}, ${`pk-${label}`}, ${userId}, ${`cred-${id}`},
       0, 'singleDevice', false, 'internal')
  `;

  return id;
}

/** Establish a real session by redeeming a bootstrap grant. */
export async function signInViaBootstrapGrant(jar: CookieJar): Promise<{ userId: string }> {
  const token = await issueGrant('bootstrap');
  const response = await authFetch('/burmy/redeem-grant', {
    method: 'POST',
    body: { token, kind: 'bootstrap' },
    jar,
  });

  if (!response.ok) {
    throw new Error(`bootstrap redemption failed: ${response.status} ${await response.text()}`);
  }

  const owner = await findOwner();
  if (!owner) throw new Error('no owner row after bootstrap');
  return { userId: owner.id };
}
