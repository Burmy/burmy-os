/**
 * Cloudflare Access JWT verification — FACTOR 1.
 *
 * Cloudflare Access authenticates the owner against Google at the edge and
 * forwards a signed assertion. This module verifies that assertion against
 * Cloudflare's JWKS: signature, `aud`, `iss` and `exp`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL, GIVEN ACCESS ALREADY GATED THE REQUEST
 *
 * Because "the request came through the tunnel" is an assumption, not a proof.
 * If the origin is ever reachable another way — a misconfigured tunnel, a
 * second ingress, a container port published by accident — then trusting the
 * *presence* of a header would be trusting an attacker-supplied string. A
 * verified signature is the difference between those two situations.
 *
 * FAILING CLOSED IS THE WHOLE POINT
 *
 * The bypass is gated on `NODE_ENV === 'development'` EXACTLY — never on
 * `!== 'production'`. Those are not the same test: with `NODE_ENV` unset,
 * misspelled, or set to `staging`, the negative form silently disables the
 * outer factor on a real deployment. Anything that is not literally
 * `development` must verify for real, and a deployment that is missing its
 * Access configuration must REFUSE requests rather than serve them
 * unauthenticated. A missing config is an outage; a skipped check is a breach.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * No secret lives here. Access assertions are verified with Cloudflare's PUBLIC
 * keys, which is why this module is safe to run in the proxy's edge runtime.
 */

import { type JWTVerifyGetKey, type KeyObject, createRemoteJWKSet, jwtVerify } from 'jose';

/** The verified owner identity asserted by Cloudflare Access. */
export interface AccessIdentity {
  /** The verified `email` claim. This is the ONLY owner identity input. */
  readonly email: string;
  /** Cloudflare's stable subject id, when present. Audit metadata only. */
  readonly subject: string | null;
}

export interface AccessConfig {
  /** Team domain, e.g. `burmy` or `burmy.cloudflareaccess.com`. */
  readonly teamDomain: string;
  /** The Access application's AUD tag. */
  readonly aud: string;
}

export type AccessMode =
  | { readonly kind: 'enforced'; readonly config: AccessConfig }
  | { readonly kind: 'dev-bypass' };

/**
 * Just the variables this module reads.
 *
 * Deliberately NOT `NodeJS.ProcessEnv`: Next.js augments that type so `NODE_ENV`
 * is both required and readonly, which makes it impossible for a test to pass a
 * partial environment and forces awkward casts at every call site. Naming the
 * four keys is also honest about the module's actual inputs.
 *
 * `process.env` remains assignable to this.
 */
export interface AccessEnv {
  readonly NODE_ENV?: string | undefined;
  readonly CF_ACCESS_TEAM_DOMAIN?: string | undefined;
  readonly CF_ACCESS_AUD?: string | undefined;
  readonly OWNER_EMAIL?: string | undefined;
}

/**
 * The Access configuration is absent or incomplete on a deployment that
 * requires it. Callers MUST refuse the request. Never downgrade this to a
 * warning — that converts a loud outage into a silent hole.
 */
export class AccessMisconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessMisconfiguredError';
  }
}

/** The assertion is absent, malformed, expired, or not for the owner. */
export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

/** Cloudflare forwards the assertion in this header. */
export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/** ...and, for browser navigations, also in this cookie. */
export const ACCESS_JWT_COOKIE = 'CF_Authorization';

/**
 * Normalize whatever form of team domain was configured into the bare hostname.
 *
 * `.env` realistically receives `burmy`, `burmy.cloudflareaccess.com`, or a full
 * URL with a stray trailing slash. All three must resolve to one issuer, since
 * an issuer mismatch fails verification with an error that looks like a key
 * problem and wastes an afternoon.
 */
export function normalizeTeamDomain(raw: string): string {
  let value = raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!value) throw new AccessMisconfiguredError('CF_ACCESS_TEAM_DOMAIN is empty');
  if (!value.includes('.')) value = `${value}.cloudflareaccess.com`;
  return value.toLowerCase();
}

/** The `iss` claim Cloudflare Access signs with. */
export function accessIssuer(teamDomain: string): string {
  return `https://${normalizeTeamDomain(teamDomain)}`;
}

/** Where Cloudflare publishes the public keys for a team. */
export function accessJwksUrl(teamDomain: string): string {
  return `${accessIssuer(teamDomain)}/cdn-cgi/access/certs`;
}

/**
 * Decide whether Access verification is enforced, bypassed, or misconfigured.
 *
 * @throws AccessMisconfiguredError when enforcement is required but unconfigured.
 */
export function resolveAccessMode(env: AccessEnv = process.env): AccessMode {
  if (env.NODE_ENV === 'development') return { kind: 'dev-bypass' };

  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.CF_ACCESS_AUD?.trim();

  // Fail CLOSED. Callers turn this into a refusal, never into a pass-through.
  if (!teamDomain || !aud) {
    throw new AccessMisconfiguredError(
      'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are required outside development',
    );
  }

  return { kind: 'enforced', config: { teamDomain, aud } };
}

/**
 * Remote JWKS sets are cached per team domain.
 *
 * `createRemoteJWKSet` handles its own caching, rotation and cooldown, but only
 * within one instance — rebuilding it per request would fetch Cloudflare's keys
 * on every page load and make the origin's availability depend on it.
 */
const jwksCache = new Map<string, JWTVerifyGetKey>();

function remoteJwks(teamDomain: string): JWTVerifyGetKey {
  const url = accessJwksUrl(teamDomain);
  const cached = jwksCache.get(url);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(new URL(url));
  jwksCache.set(url, jwks);
  return jwks;
}

/**
 * Verify an Access assertion and return the identity it asserts.
 *
 * `keyResolver` is injectable so tests can verify against a locally generated
 * key pair. That is deliberately NOT a production bypass: the signature, `aud`,
 * `iss` and `exp` checks below are the same code either way — only the source of
 * the public key changes. There is no code path that skips verification.
 *
 * @throws AccessDeniedError on any verification failure.
 */
export async function verifyAccessToken(
  token: string | null | undefined,
  config: AccessConfig,
  keyResolver?: JWTVerifyGetKey | KeyObject | CryptoKey | Uint8Array,
): Promise<AccessIdentity> {
  if (!token) throw new AccessDeniedError('missing Access assertion');

  const key = keyResolver ?? remoteJwks(config.teamDomain);

  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      issuer: accessIssuer(config.teamDomain),
      audience: config.aud,
      // `exp` is enforced by jose; a tolerance would widen the replay window of
      // a leaked assertion for no operational benefit on a single-user app.
      clockTolerance: 0,
    }));
  } catch (_cause) {
    // Collapsed deliberately: jose distinguishes bad signature from wrong `aud`
    // from expired, and surfacing which one failed would turn this into a
    // probing oracle. The caller logs a refusal against the request path.
    throw new AccessDeniedError('Access assertion failed verification');
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email) throw new AccessDeniedError('Access assertion carries no email claim');

  return { email, subject: typeof payload.sub === 'string' ? payload.sub : null };
}

/**
 * Pull the assertion out of a request, header first then cookie.
 *
 * Cloudflare sends the header on every proxied request and the cookie on
 * browser navigations. Reading both means a direct-origin request carrying
 * neither is rejected rather than accidentally tolerated.
 */
export function readAccessToken(headers: Headers): string | null {
  const header = headers.get(ACCESS_JWT_HEADER);
  if (header) return header.trim();

  const cookie = headers.get('cookie');
  if (!cookie) return null;

  for (const part of cookie.split(';')) {
    const [rawName, ...rawValue] = part.split('=');
    if (rawName?.trim() === ACCESS_JWT_COOKIE) return rawValue.join('=').trim() || null;
  }

  return null;
}

/** The single allowlisted identity. There is no signup route and no second row. */
export function ownerEmail(env: AccessEnv = process.env): string {
  const email = env.OWNER_EMAIL?.trim().toLowerCase();
  if (!email) throw new AccessMisconfiguredError('OWNER_EMAIL is not set');
  return email;
}

/**
 * Case-insensitive owner comparison.
 *
 * Deliberately exact beyond case: no Gmail dot-folding, no `+tag` stripping, no
 * unicode normalization. Every one of those "helpful" normalizations widens the
 * set of strings that count as the owner, and the allowlist has exactly one
 * member. `Whatever@Example.com` matching `whatever@example.com` is the only
 * leniency worth having, because identity providers vary on case alone.
 */
export function isOwnerEmail(email: string, env: AccessEnv = process.env): boolean {
  return email.trim().toLowerCase() === ownerEmail(env);
}

/**
 * Verify factor 1 for a request and return the asserted owner identity.
 *
 * In development this returns the configured `OWNER_EMAIL` without a network
 * call, because Cloudflare is absent locally by design.
 *
 * @throws AccessMisconfiguredError · AccessDeniedError
 */
export async function requireAccessIdentity(
  headers: Headers,
  env: AccessEnv = process.env,
): Promise<AccessIdentity> {
  const mode = resolveAccessMode(env);

  if (mode.kind === 'dev-bypass') {
    return { email: ownerEmail(env), subject: null };
  }

  const identity = await verifyAccessToken(readAccessToken(headers), mode.config);

  if (!isOwnerEmail(identity.email, env)) {
    // A *verified* identity that is not the owner: Access let through an
    // account the policy should have refused. Worth auditing, not just denying.
    throw new AccessDeniedError('verified Access identity is not the owner');
  }

  return identity;
}
