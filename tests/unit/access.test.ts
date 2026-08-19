import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ACCESS_JWT_COOKIE,
  ACCESS_JWT_HEADER,
  AccessDeniedError,
  AccessMisconfiguredError,
  accessIssuer,
  accessJwksUrl,
  isOwnerEmail,
  normalizeTeamDomain,
  ownerEmail,
  readAccessToken,
  requireAccessIdentity,
  resolveAccessMode,
  verifyAccessToken,
} from '@/server/auth/access';

/**
 * Cloudflare Access verification — FACTOR 1.
 *
 * These run against a REAL locally generated ES256 key pair, not a mock. Only
 * the source of the public key differs from production; the signature, `aud`,
 * `iss` and `exp` checks are the same code. Mocking `jwtVerify` would have
 * tested that the mock was called, which is worth nothing for a security
 * boundary.
 */

const TEAM = 'burmy-test';
const AUD = 'aud-tag-under-test';
const OWNER = 'owner@burmy.test';
const CONFIG = { teamDomain: TEAM, aud: AUD } as const;

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let otherPrivateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;

  // A second, unrelated key: "signed by somebody else" must fail exactly as
  // hard as "not signed at all".
  otherPrivateKey = (await generateKeyPair('ES256')).privateKey;
});

interface TokenOverrides {
  readonly issuer?: string;
  readonly audience?: string;
  readonly email?: string | null;
  readonly expiresIn?: string;
  readonly signWith?: 'owner' | 'attacker';
  readonly subject?: string;
}

async function mintToken(overrides: TokenOverrides = {}): Promise<string> {
  const jwt = new SignJWT({
    ...(overrides.email === null ? {} : { email: overrides.email ?? OWNER }),
  })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? accessIssuer(TEAM))
    .setAudience(overrides.audience ?? AUD)
    .setExpirationTime(overrides.expiresIn ?? '5m')
    .setSubject(overrides.subject ?? 'cf-subject-123');

  return jwt.sign(overrides.signWith === 'attacker' ? otherPrivateKey : privateKey);
}

describe('normalizeTeamDomain', () => {
  it('accepts the bare team name, the full host, and a URL alike', () => {
    // All three forms realistically end up in .env, and an issuer mismatch
    // surfaces as an opaque key error hours later.
    expect(normalizeTeamDomain('burmy')).toBe('burmy.cloudflareaccess.com');
    expect(normalizeTeamDomain('burmy.cloudflareaccess.com')).toBe('burmy.cloudflareaccess.com');
    expect(normalizeTeamDomain('https://burmy.cloudflareaccess.com/')).toBe(
      'burmy.cloudflareaccess.com',
    );
    expect(normalizeTeamDomain('  HTTPS://Burmy.CloudflareAccess.com  ')).toBe(
      'burmy.cloudflareaccess.com',
    );
  });

  it('rejects an empty value rather than building a garbage issuer', () => {
    expect(() => normalizeTeamDomain('   ')).toThrow(AccessMisconfiguredError);
  });

  it('derives the documented JWKS path', () => {
    expect(accessJwksUrl('burmy')).toBe(
      'https://burmy.cloudflareaccess.com/cdn-cgi/access/certs',
    );
  });
});

describe('verifyAccessToken', () => {
  it('accepts a correctly signed assertion and returns the identity', async () => {
    const identity = await verifyAccessToken(await mintToken(), CONFIG, publicKey);
    expect(identity.email).toBe(OWNER);
    expect(identity.subject).toBe('cf-subject-123');
  });

  it('lowercases the email claim so casing cannot dodge the allowlist', async () => {
    const identity = await verifyAccessToken(
      await mintToken({ email: 'Owner@Burmy.TEST' }),
      CONFIG,
      publicKey,
    );
    expect(identity.email).toBe(OWNER);
  });

  it('rejects a missing assertion', async () => {
    await expect(verifyAccessToken(null, CONFIG, publicKey)).rejects.toThrow(AccessDeniedError);
    await expect(verifyAccessToken('', CONFIG, publicKey)).rejects.toThrow(AccessDeniedError);
  });

  it('rejects an assertion signed by a different key', async () => {
    // The whole reason this module exists: presence of a header is not proof.
    const forged = await mintToken({ signWith: 'attacker' });
    await expect(verifyAccessToken(forged, CONFIG, publicKey)).rejects.toThrow(AccessDeniedError);
  });

  it('rejects a wrong audience — an assertion for another Access app', async () => {
    const otherApp = await mintToken({ audience: 'someone-elses-aud-tag' });
    await expect(verifyAccessToken(otherApp, CONFIG, publicKey)).rejects.toThrow(AccessDeniedError);
  });

  it('rejects a wrong issuer — an assertion from another Cloudflare team', async () => {
    const otherTeam = await mintToken({ issuer: 'https://someone-else.cloudflareaccess.com' });
    await expect(verifyAccessToken(otherTeam, CONFIG, publicKey)).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it('rejects an expired assertion with zero clock tolerance', async () => {
    const expired = await mintToken({ expiresIn: '-1s' });
    await expect(verifyAccessToken(expired, CONFIG, publicKey)).rejects.toThrow(AccessDeniedError);
  });

  it('rejects a verified assertion that carries no email claim', async () => {
    // Signature valid, but there is no identity to authorize — that must fail
    // rather than fall through to an empty-string comparison.
    const anonymous = await mintToken({ email: null });
    await expect(verifyAccessToken(anonymous, CONFIG, publicKey)).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it('rejects a structurally malformed token — not a JWT at all', async () => {
    // Distinct from "tampered payload" below: this string isn't even
    // shaped like a JWT (no three base64url segments), so `jose` throws a
    // PARSE error rather than a verification error. The try/catch in
    // `verifyAccessToken` must collapse that into `AccessDeniedError` too,
    // not let a parser exception escape as an unhandled 500.
    await expect(verifyAccessToken('not-a-jwt-at-all', CONFIG, publicKey)).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(verifyAccessToken('..', CONFIG, publicKey)).rejects.toThrow(AccessDeniedError);
  });

  it('rejects a tampered payload', async () => {
    const token = await mintToken();
    const [header, , signature] = token.split('.');
    const swapped = Buffer.from(JSON.stringify({ email: 'attacker@evil.test' })).toString(
      'base64url',
    );
    await expect(
      verifyAccessToken(`${header}.${swapped}.${signature}`, CONFIG, publicKey),
    ).rejects.toThrow(AccessDeniedError);
  });

  it('does not leak which check failed', async () => {
    // Distinct failure reasons must produce one indistinguishable message, or
    // the endpoint becomes a probing oracle.
    const cases = [
      await mintToken({ signWith: 'attacker' }),
      await mintToken({ audience: 'nope' }),
      await mintToken({ expiresIn: '-1s' }),
    ];

    const messages = new Set<string>();
    for (const token of cases) {
      await verifyAccessToken(token, CONFIG, publicKey).catch((error: unknown) => {
        messages.add(error instanceof Error ? error.message : 'non-error');
      });
    }

    expect(messages.size).toBe(1);
  });

  it('verifies against a JWKS-shaped resolver, as production does', async () => {
    // Production passes a `createRemoteJWKSet` resolver rather than a key
    // object; prove the code path accepts that shape too.
    const jwk = await exportJWK(publicKey);
    const resolver = async () => (await importJWK({ ...jwk, alg: 'ES256' }, 'ES256')) as CryptoKey;

    const identity = await verifyAccessToken(await mintToken(), CONFIG, resolver);
    expect(identity.email).toBe(OWNER);
  });
});

describe('resolveAccessMode — fail closed', () => {
  it('bypasses only when NODE_ENV is exactly "development"', () => {
    expect(resolveAccessMode({ NODE_ENV: 'development' }).kind).toBe('dev-bypass');
  });

  it('enforces when configured', () => {
    const mode = resolveAccessMode({
      NODE_ENV: 'production',
      CF_ACCESS_TEAM_DOMAIN: TEAM,
      CF_ACCESS_AUD: AUD,
    });
    expect(mode).toEqual({ kind: 'enforced', config: { teamDomain: TEAM, aud: AUD } });
  });

  it('THROWS rather than bypassing when production is misconfigured', () => {
    // The single most important assertion in this file. A deployment that cannot
    // verify factor 1 must refuse traffic, not serve it unauthenticated.
    expect(() => resolveAccessMode({ NODE_ENV: 'production' })).toThrow(AccessMisconfiguredError);
    expect(() =>
      resolveAccessMode({ NODE_ENV: 'production', CF_ACCESS_TEAM_DOMAIN: TEAM }),
    ).toThrow(AccessMisconfiguredError);
    expect(() => resolveAccessMode({ NODE_ENV: 'production', CF_ACCESS_AUD: AUD })).toThrow(
      AccessMisconfiguredError,
    );
  });

  it('treats blank-but-present configuration as missing', () => {
    expect(() =>
      resolveAccessMode({
        NODE_ENV: 'production',
        CF_ACCESS_TEAM_DOMAIN: '   ',
        CF_ACCESS_AUD: '  ',
      }),
    ).toThrow(AccessMisconfiguredError);
  });

  it.each(['', 'production', 'test', 'staging', 'Development', 'dev', undefined])(
    'does NOT bypass for NODE_ENV=%o',
    (nodeEnv) => {
      // Guards against the `!== 'production'` spelling, which would silently
      // disable factor 1 whenever NODE_ENV was unset, misspelled or 'staging'.
      const env = nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv };
      expect(() => resolveAccessMode(env)).toThrow(AccessMisconfiguredError);
    },
  );

  it('reads configuration off the passed env object', () => {
    // Not cosmetic: taking `env` as a parameter is what stops the bundler from
    // inlining `process.env.CF_ACCESS_AUD` at build time in the edge proxy.
    // Rewriting these as direct `process.env.X` member accesses would make the
    // built proxy read a value frozen at build time. Verified against the
    // compiled chunk during M2.
    const mode = resolveAccessMode({
      NODE_ENV: 'production',
      CF_ACCESS_TEAM_DOMAIN: 'from-argument',
      CF_ACCESS_AUD: 'also-from-argument',
    });
    expect(mode.kind).toBe('enforced');
  });
});

describe('readAccessToken', () => {
  it('prefers the header', () => {
    const headers = new Headers({ [ACCESS_JWT_HEADER]: 'header-token' });
    expect(readAccessToken(headers)).toBe('header-token');
  });

  it('falls back to the cookie for browser navigations', () => {
    const headers = new Headers({ cookie: `other=1; ${ACCESS_JWT_COOKIE}=cookie-token; x=2` });
    expect(readAccessToken(headers)).toBe('cookie-token');
  });

  it('handles a JWT value containing "=" padding', () => {
    const headers = new Headers({ cookie: `${ACCESS_JWT_COOKIE}=a.b.c==` });
    expect(readAccessToken(headers)).toBe('a.b.c==');
  });

  it('returns null when neither is present', () => {
    expect(readAccessToken(new Headers())).toBeNull();
    expect(readAccessToken(new Headers({ cookie: 'unrelated=1' }))).toBeNull();
  });
});

describe('owner allowlist', () => {
  it('matches case-insensitively', () => {
    const env = { OWNER_EMAIL: 'Owner@Burmy.test' };
    expect(ownerEmail(env)).toBe('owner@burmy.test');
    expect(isOwnerEmail('OWNER@BURMY.TEST', env)).toBe(true);
    expect(isOwnerEmail('  owner@burmy.test  ', env)).toBe(true);
  });

  it('does NOT fold dots or strip +tags', () => {
    // Every such "helpful" normalization widens a one-member allowlist.
    const env = { OWNER_EMAIL: 'owner@burmy.test' };
    expect(isOwnerEmail('own.er@burmy.test', env)).toBe(false);
    expect(isOwnerEmail('owner+admin@burmy.test', env)).toBe(false);
    expect(isOwnerEmail('owner@burmy.test.evil.com', env)).toBe(false);
    expect(isOwnerEmail('attacker@elsewhere.test', env)).toBe(false);
  });

  it('throws when OWNER_EMAIL is unset', () => {
    expect(() => ownerEmail({})).toThrow(AccessMisconfiguredError);
  });
});

describe('requireAccessIdentity', () => {
  // `vi.stubEnv` rather than assigning to `process.env.NODE_ENV`: Next.js's type
  // augmentation makes that property readonly, and it restores cleanly.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the configured owner in development without a network call', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('OWNER_EMAIL', OWNER);

    const identity = await requireAccessIdentity(new Headers());
    expect(identity).toEqual({ email: OWNER, subject: null });
  });

  it('refuses in production when unconfigured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OWNER_EMAIL', OWNER);
    vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', undefined);
    vi.stubEnv('CF_ACCESS_AUD', undefined);

    await expect(requireAccessIdentity(new Headers())).rejects.toThrow(AccessMisconfiguredError);
  });

  // The four tests below exercise ENFORCED mode end to end — resolveAccessMode
  // + verifyAccessToken + the owner-email check, together — against a real
  // locally generated key pair (via the injectable `keyResolver`, never a
  // network call). The two tests above only cover dev-bypass and the
  // unconfigured-refusal path; without these, "a validly-signed assertion for
  // the wrong email" and "a validly-signed assertion for the real owner" were
  // each proven only in PIECES (raw JWT verification here, pure string
  // comparison in "owner allowlist" above) and never as the one call a real
  // request actually makes.
  const ENFORCED_ENV = {
    NODE_ENV: 'production',
    OWNER_EMAIL: OWNER,
    CF_ACCESS_TEAM_DOMAIN: TEAM,
    CF_ACCESS_AUD: AUD,
  };

  it('accepts a validly-signed assertion for the real owner, in enforced mode', async () => {
    const headers = new Headers({ [ACCESS_JWT_HEADER]: await mintToken() });
    const identity = await requireAccessIdentity(headers, ENFORCED_ENV, publicKey);
    expect(identity.email).toBe(OWNER);
  });

  it('rejects a validly-signed assertion for a real but non-owner email', async () => {
    const headers = new Headers({
      [ACCESS_JWT_HEADER]: await mintToken({ email: 'someone-else@burmy.test' }),
    });
    await expect(requireAccessIdentity(headers, ENFORCED_ENV, publicKey)).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it('rejects a request with no Access assertion at all, in enforced mode', async () => {
    await expect(
      requireAccessIdentity(new Headers(), ENFORCED_ENV, publicKey),
    ).rejects.toThrow(AccessDeniedError);
  });

  it('rejects a structurally malformed assertion, in enforced mode', async () => {
    const headers = new Headers({ [ACCESS_JWT_HEADER]: 'garbage' });
    await expect(requireAccessIdentity(headers, ENFORCED_ENV, publicKey)).rejects.toThrow(
      AccessDeniedError,
    );
  });

  /**
   * The full enforced path — real signature verification, real owner-email
   * check — against the injected local key pair rather than a live Cloudflare
   * JWKS. This is the exact function `requireOwner()` (src/server/auth/owner.ts)
   * calls on every single request; `requireOwner()` itself has no keyResolver
   * seam of its own (production must never be reachable with one), so these
   * scenarios are proven here rather than through an integration test that
   * would otherwise have to hit real network to reach the same code path.
   */
  describe('the enforced path, against a real signature', () => {
    it('succeeds for a validly signed assertion belonging to the owner', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('OWNER_EMAIL', OWNER);
      vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', TEAM);
      vi.stubEnv('CF_ACCESS_AUD', AUD);

      const headers = new Headers({ [ACCESS_JWT_HEADER]: await mintToken() });
      const identity = await requireAccessIdentity(headers, process.env, publicKey);
      expect(identity.email).toBe(OWNER);
    });

    it('rejects a validly signed assertion for a different Google account', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('OWNER_EMAIL', OWNER);
      vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', TEAM);
      vi.stubEnv('CF_ACCESS_AUD', AUD);

      const headers = new Headers({
        [ACCESS_JWT_HEADER]: await mintToken({ email: 'someone-else@elsewhere.test' }),
      });
      await expect(requireAccessIdentity(headers, process.env, publicKey)).rejects.toThrow(
        AccessDeniedError,
      );
    });

    it('rejects a forged signature', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('OWNER_EMAIL', OWNER);
      vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', TEAM);
      vi.stubEnv('CF_ACCESS_AUD', AUD);

      const headers = new Headers({ [ACCESS_JWT_HEADER]: await mintToken({ signWith: 'attacker' }) });
      await expect(requireAccessIdentity(headers, process.env, publicKey)).rejects.toThrow(
        AccessDeniedError,
      );
    });

    it('rejects an expired assertion', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('OWNER_EMAIL', OWNER);
      vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', TEAM);
      vi.stubEnv('CF_ACCESS_AUD', AUD);

      const headers = new Headers({ [ACCESS_JWT_HEADER]: await mintToken({ expiresIn: '-1s' }) });
      await expect(requireAccessIdentity(headers, process.env, publicKey)).rejects.toThrow(
        AccessDeniedError,
      );
    });

    it('rejects a request carrying no assertion at all', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('OWNER_EMAIL', OWNER);
      vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', TEAM);
      vi.stubEnv('CF_ACCESS_AUD', AUD);

      await expect(requireAccessIdentity(new Headers(), process.env, publicKey)).rejects.toThrow(
        AccessDeniedError,
      );
    });
  });
});
