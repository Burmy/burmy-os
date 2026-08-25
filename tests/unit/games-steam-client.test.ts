import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAchievementCounts, fetchOwnedGames } from '@/server/db/games/steam-client';

/**
 * `fetchOwnedGames`/`fetchAchievementCounts` must fail SOFT in every case —
 * missing credentials, a network error, a timeout, a non-200, or a malformed
 * body never throw. Same contract as `games-igdb.test.ts` against `igdb.ts`,
 * and for the same reason: the full test suite must pass with
 * `STEAM_API_KEY`/`STEAM_ID` unset. Unlike `igdb.ts`, `fetchOwnedGames`'s
 * soft failure is NOT always `[]`: a request failure (network error,
 * timeout, non-200, malformed JSON) resolves to `null`, distinguishable
 * from a successful response that genuinely carries zero games (`[]`) —
 * see the assertions below and `steam-client.ts`'s module header.
 *
 * `restoreMocks: true` (vitest.config.ts) resets `vi.fn()` call state between
 * tests but does NOT undo `vi.stubEnv`/`vi.stubGlobal` — unwound explicitly
 * here so one test's fake credentials or fake fetch can never leak into the
 * next.
 */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubCredentials(): void {
  vi.stubEnv('STEAM_API_KEY', 'test-api-key');
  vi.stubEnv('STEAM_ID', '76561198000000000');
}

function fakeJsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function fakeBrokenJsonResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  } as unknown as Response;
}

describe('fetchOwnedGames — missing configuration', () => {
  it('returns [] and never calls fetch when STEAM_API_KEY is unset', async () => {
    vi.stubEnv('STEAM_API_KEY', undefined);
    vi.stubEnv('STEAM_ID', '76561198000000000');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchOwnedGames()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns [] and never calls fetch when STEAM_ID is unset', async () => {
    vi.stubEnv('STEAM_API_KEY', 'test-api-key');
    vi.stubEnv('STEAM_ID', undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchOwnedGames()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns [] when both credentials are the empty string', async () => {
    vi.stubEnv('STEAM_API_KEY', '');
    vi.stubEnv('STEAM_ID', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchOwnedGames()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('fetchOwnedGames — request failures return null, distinct from a genuine zero-games response', () => {
  it('returns null on a network error', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    expect(await fetchOwnedGames()).toBeNull();
  });

  it('returns null on a timeout-shaped rejection', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }),
    );

    expect(await fetchOwnedGames()).toBeNull();
  });

  it('returns null on a non-200 response', async () => {
    stubCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => fakeJsonResponse(403, { error: 'forbidden' })));

    expect(await fetchOwnedGames()).toBeNull();
  });

  it('returns null when the response body fails to parse as JSON', async () => {
    stubCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => fakeBrokenJsonResponse(200)));

    expect(await fetchOwnedGames()).toBeNull();
  });
});

describe('fetchOwnedGames — success path', () => {
  it('maps a well-formed response through to real games', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeJsonResponse(200, {
          response: { game_count: 1, games: [{ appid: 730, name: 'Counter-Strike 2', playtime_forever: 120 }] },
        }),
      ),
    );

    expect(await fetchOwnedGames()).toEqual([{ appid: 730, name: 'Counter-Strike 2', playtimeMinutes: 120 }]);
  });

  it('returns [] for a private-profile shaped response — a successful request, unlike an actual failure', async () => {
    stubCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => fakeJsonResponse(200, { response: {} })));

    expect(await fetchOwnedGames()).toEqual([]);
  });
});

/**
 * `STEAM_ID` may be a vanity name (`steamcommunity.com/id/<name>`), not just
 * a numeric SteamID64 — `.env.example` documents this as resolved
 * automatically, and `scripts/sync-steam-library.mjs` has always done its
 * own resolution before calling `GetOwnedGames`/`GetPlayerAchievements`.
 * This module used to send the raw vanity string straight through as
 * `steamid`, which Steam's API rejects (`400 Missing required routing
 * parameter`) — reproduced against the real API before this fix, with the
 * owner's actual vanity `STEAM_ID`. These tests cover the fix:
 * `resolveSteamId` (module-private) must run first, and any resolution
 * failure must soft-fail to `null` exactly like every other failure mode
 * here — never a throw, and never a request sent with the unresolved name.
 *
 * Resolution is memoized per raw `STEAM_ID` string at module scope (see
 * `resolveSteamId`'s own doc comment) — a cache that outlives any single
 * test in this file. Each test below therefore uses ITS OWN vanity name,
 * never reused across tests, so one test's successful (or failed)
 * resolution can never silently satisfy a later test's assertion via a
 * stale cache hit instead of the fetch behaviour that test actually sets
 * up.
 */
describe('vanity STEAM_ID resolution', () => {
  function fetchCallUrls(fetchSpy: ReturnType<typeof vi.fn>): string[] {
    return fetchSpy.mock.calls.map((call) => String(call[0]));
  }

  it('resolves a vanity STEAM_ID before calling GetOwnedGames, and uses the resolved id', async () => {
    vi.stubEnv('STEAM_API_KEY', 'test-api-key');
    vi.stubEnv('STEAM_ID', 'vanity-basic');
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('ResolveVanityURL')) {
        return fakeJsonResponse(200, { response: { success: 1, steamid: '76561198263587821' } });
      }
      return fakeJsonResponse(200, {
        response: { game_count: 1, games: [{ appid: 730, name: 'Counter-Strike 2', playtime_forever: 60 }] },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchOwnedGames()).toEqual([{ appid: 730, name: 'Counter-Strike 2', playtimeMinutes: 60 }]);

    const urls = fetchCallUrls(fetchSpy);
    expect(urls[0]).toContain('ResolveVanityURL');
    expect(urls[0]).toContain('vanityurl=vanity-basic');
    expect(urls[1]).toContain('GetOwnedGames');
    expect(urls[1]).toContain('steamid=76561198263587821');
  });

  it('never sends the raw vanity name as steamid to GetOwnedGames', async () => {
    vi.stubEnv('STEAM_API_KEY', 'test-api-key');
    vi.stubEnv('STEAM_ID', 'vanity-rawcheck');
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('ResolveVanityURL')) {
        return fakeJsonResponse(200, { response: { success: 1, steamid: '76561198111111111' } });
      }
      return fakeJsonResponse(200, { response: {} });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await fetchOwnedGames();

    const ownedGamesCall = fetchCallUrls(fetchSpy).find((url) => url.includes('GetOwnedGames'));
    expect(ownedGamesCall).toBeDefined();
    expect(ownedGamesCall).not.toContain('steamid=vanity-rawcheck');
  });

  it('returns null, and never calls GetOwnedGames, when the vanity name fails to resolve (success: 42)', async () => {
    vi.stubEnv('STEAM_API_KEY', 'test-api-key');
    vi.stubEnv('STEAM_ID', 'no-such-profile');
    const fetchSpy = vi.fn(async (_url: string) => fakeJsonResponse(200, { response: { success: 42 } }));
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchOwnedGames()).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchCallUrls(fetchSpy)[0]).toContain('ResolveVanityURL');
  });

  it('returns null when the resolve request itself fails (non-2xx)', async () => {
    vi.stubEnv('STEAM_API_KEY', 'test-api-key');
    vi.stubEnv('STEAM_ID', 'vanity-resolve-fails');
    vi.stubGlobal('fetch', vi.fn(async () => fakeJsonResponse(400, { error: 'Missing required routing parameter' })));

    expect(await fetchOwnedGames()).toBeNull();
    expect(await fetchAchievementCounts(730)).toBeNull();
  });

  it('does not re-resolve the vanity name on a second call', async () => {
    vi.stubEnv('STEAM_API_KEY', 'test-api-key');
    vi.stubEnv('STEAM_ID', 'vanity-cache-reuse');
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('ResolveVanityURL')) {
        return fakeJsonResponse(200, { response: { success: 1, steamid: '76561198222222222' } });
      }
      if (url.includes('GetOwnedGames')) return fakeJsonResponse(200, { response: {} });
      return fakeJsonResponse(200, {
        playerstats: { success: true, achievements: [{ apiname: 'A', achieved: 1 }] },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await fetchOwnedGames();
    await fetchAchievementCounts(730);

    const resolveCalls = fetchCallUrls(fetchSpy).filter((url) => url.includes('ResolveVanityURL'));
    expect(resolveCalls).toHaveLength(1);
  });

  it('makes no resolution request at all for an already-numeric SteamID64', async () => {
    stubCredentials(); // STEAM_ID = '76561198000000000', already 17 digits
    const fetchSpy = vi.fn(async () => fakeJsonResponse(200, { response: {} }));
    vi.stubGlobal('fetch', fetchSpy);

    await fetchOwnedGames();

    expect(fetchCallUrls(fetchSpy).some((url) => url.includes('ResolveVanityURL'))).toBe(false);
  });
});

describe('fetchAchievementCounts', () => {
  it('returns null and never calls fetch without credentials', async () => {
    vi.stubEnv('STEAM_API_KEY', undefined);
    vi.stubEnv('STEAM_ID', undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchAchievementCounts(730)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null on a network error', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    expect(await fetchAchievementCounts(730)).toBeNull();
  });

  it('returns null on a non-200 response', async () => {
    stubCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => fakeJsonResponse(500, {})));

    expect(await fetchAchievementCounts(730)).toBeNull();
  });

  it('returns null on the error-shaped body for a no-achievements game', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeJsonResponse(200, { playerstats: { success: false, error: 'Requested app has no stats' } })),
    );

    expect(await fetchAchievementCounts(730)).toBeNull();
  });

  it('maps a well-formed response through to real counts', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeJsonResponse(200, {
          playerstats: {
            success: true,
            achievements: [
              { apiname: 'A', achieved: 1 },
              { apiname: 'B', achieved: 0 },
            ],
          },
        }),
      ),
    );

    expect(await fetchAchievementCounts(730)).toEqual({ unlocked: 1, total: 2 });
  });
});
