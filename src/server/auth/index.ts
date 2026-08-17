/**
 * Better Auth — FACTOR 2, passkeys and the local session.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THERE IS NO GOOGLE CLIENT HERE, AND THERE MUST NEVER BE ONE.
 *
 * Google is configured exactly once, in Cloudflare Access. Configuring it a
 * second time here would create a second allowlist that can drift out of sync
 * with the first, and — worse — would collapse two factors into one: a
 * compromised Google account would then pass both the edge gate and the
 * application. `socialProviders` is explicitly empty and
 * `emailAndPassword.enabled` is explicitly false. Both are stated rather than
 * left to defaults, so that adding a provider is a visible diff.
 *
 * There is also no signup route. Better Auth registers none, because the only
 * credential type enabled is a passkey and the only way to obtain the first one
 * is an out-of-band grant (see grant-plugin.ts).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { passkey } from '@better-auth/passkey';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';

import { getDb } from '@/server/db';
import {
  account,
  passkey as passkeyTable,
  rateLimit,
  session,
  user,
  verification,
} from '@/server/db/schema';
import { burmyGrants } from './grant-plugin';
import { burmyPasskeyPolicy } from './passkey-policy';

/** 7 days, per docs/SECURITY.md. Monthly usage makes re-auth normal anyway. */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;

/** Rolling refresh: touch the session at most once a day. */
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/**
 * 15 minutes.
 *
 * Freshness is measured from `session.createdAt`, which a rolling refresh does
 * NOT move. So a session stops being fresh 15 minutes after sign-in and only
 * becomes fresh again by authenticating anew — which is exactly what
 * "sensitive actions require re-authentication" has to mean to be worth
 * anything.
 */
const SESSION_FRESH_AGE_SECONDS = 60 * 15;

/**
 * The signing secret for session cookies.
 *
 * Better Auth falls back to a BUILT-IN DEFAULT when this is unset, and only
 * warns. On a real deployment that would mean session cookies signed with a
 * publicly known key — anyone could forge one, and both factors would be moot.
 * So production refuses to start without it.
 *
 * Development is allowed to run without one so a fresh clone works before `.env`
 * is filled in; the cookies it signs are worthless either way.
 */
function resolveSecret(): string | undefined {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();

  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error(
      'BETTER_AUTH_SECRET is not set. Refusing to sign session cookies with Better Auth’s default secret.',
    );
  }

  return secret || undefined;
}

function resolveRpId(): string {
  // Passkeys need a secure context. `localhost` qualifies, so dev works without
  // TLS. Production is the apex application host.
  const baseUrl = process.env.BETTER_AUTH_URL;
  if (!baseUrl) return 'localhost';
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'localhost';
  }
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * BOOTSTRAP: prototyped, then chosen. Do not "simplify" this back.
 *
 * Milestone 2 implemented BOTH candidates from the plan and measured them
 * against a real database. `registration.requireSession` is left at its default
 * `true` here as a result — the first passkey is enrolled inside a session
 * obtained by redeeming a single-use bootstrap grant, which is the same
 * mechanism as break-glass recovery.
 *
 * The rejected alternative was Better Auth's passkey-first registration
 * (`requireSession: false` + a `resolveUser` gate). Observed, not assumed:
 *
 *   · It leaves `/passkey/generate-register-options` answering UNAUTHENTICATED
 *     callers permanently, in exchange for a once-ever operation.
 *   · The grant could not be consumed at options-generation time without
 *     burning it whenever the browser prompt was dismissed — so one token
 *     yielded unlimited challenges for its whole 10-minute life.
 *   · It created the owner row from an anonymous request.
 *
 * Full comparison and evidence: docs/SECURITY.md, "Bootstrap and recovery".
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function buildAuthOptions(): BetterAuthOptions {
  const isProduction = process.env.NODE_ENV === 'production';
  const rpID = resolveRpId();
  const secret = resolveSecret();

  return {
    appName: 'Burmy',
    ...(process.env.BETTER_AUTH_URL ? { baseURL: process.env.BETTER_AUTH_URL } : {}),
    ...(secret ? { secret } : {}),

    database: drizzleAdapter(getDb(), {
      provider: 'pg',
      // Explicit map. Passing the whole schema module would also expose every
      // finance table to the adapter's model resolution, and a Better Auth model
      // name colliding with a finance table is not a failure mode worth leaving
      // available.
      schema: { user, session, account, verification, passkey: passkeyTable, rateLimit },
    }),

    // ── Deliberately disabled, stated explicitly ─────────────────────────────
    emailAndPassword: { enabled: false },
    socialProviders: {},

    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      freshAge: SESSION_FRESH_AGE_SECONDS,
    },

    advanced: {
      cookiePrefix: 'burmy',
      // HOST-ONLY. No `domain` key here, ever — a cookie scoped to
      // `.burmy.me` would be readable by the public portfolio at burmy.me and
      // would undo the main reason Burmy lives on its own origin.
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
      },
      // In development the dev server is plain http://localhost, where a
      // `Secure` cookie would simply not be stored. In production it is
      // mandatory rather than inferred.
      ...(isProduction ? { useSecureCookies: true } : {}),
    },

    rateLimit: {
      // Better Auth enables this in production only by default. Burmy enables it
      // everywhere so that the limiter is exercised by the test suite rather
      // than being first tried in production.
      enabled: true,
      // The `rate_limit` TABLE, not per-process memory: a limiter that forgets
      // on restart is not a limiter on the endpoint that mints break-glass
      // sessions.
      storage: 'database',
      window: 60,
      max: 100,
    },

    user: {
      // One row, forever. Nothing in Burmy deletes the owner.
      deleteUser: { enabled: false },
    },

    plugins: [
      passkey({
        rpID,
        rpName: 'Burmy',
        // `registration.requireSession` is deliberately left at its default
        // `true`. The block comment on buildAuthOptions above records the
        // prototype comparison that settled this, and why the alternative was
        // rejected. Flipping it to `false` reopens an unauthenticated endpoint.
      }),

      burmyPasskeyPolicy(),
      burmyGrants(),

      // MUST be last: it wraps the response so Server Actions can set cookies.
      nextCookies(),
    ],
  };
}

function build(): ReturnType<typeof betterAuth> {
  return betterAuth(buildAuthOptions());
}

export type Auth = ReturnType<typeof build>;

/**
 * Constructed LAZILY, on first use — never at module import.
 *
 * `next build` imports every route module to analyze it. Building the auth
 * instance at import time would run `drizzleAdapter(getDb())`, and `getDb()`
 * throws when `DATABASE_URL` is absent — so a production build would require a
 * live database connection string. `src/server/db/index.ts` is careful about
 * exactly this; wiring auth eagerly would have quietly undone it and broken any
 * build environment that does not carry runtime secrets.
 *
 * Cached on `globalThis` in development so hot reloads reuse one instance
 * instead of accumulating connection pools.
 */
const globalForAuth = globalThis as unknown as { __burmyAuth?: Auth };

let cached: Auth | undefined;

function init(): Auth {
  // Module-level cache covers production, where each build of the instance
  // would otherwise re-create the adapter on every request.
  cached ??= globalForAuth.__burmyAuth ?? build();
  if (process.env.NODE_ENV !== 'production') globalForAuth.__burmyAuth = cached;
  return cached;
}

/** Explicit accessor, for code that wants the construction point to be obvious. */
export function getAuth(): Auth {
  return init();
}

/** Ergonomic handle; defers construction until the first property access. */
export const auth = new Proxy({} as Auth, {
  get(_target, prop, receiver) {
    return Reflect.get(init(), prop, receiver) as unknown;
  },
}) as Auth;
