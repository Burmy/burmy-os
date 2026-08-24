import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAchievementCounts, fetchOwnedGames } from '@/server/db/games/steam-client';

/**
 * `fetchOwnedGames`/`fetchAchievementCounts` must fail SOFT in every case —
 * missing credentials, a network error, a timeout, a non-200, or a malformed
 * body all resolve to `[]`/`null`, never a thrown error. Same contract as
 * `games-igdb.test.ts` against `igdb.ts`, and for the same reason: the full
 * test suite must pass with `STEAM_API_KEY`/`STEAM_ID` unset.
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

describe('fetchOwnedGames — request failures', () => {
  it('returns [] on a network error', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    expect(await fetchOwnedGames()).toEqual([]);
  });

  it('returns [] on a timeout-shaped rejection', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }),
    );

    expect(await fetchOwnedGames()).toEqual([]);
  });

  it('returns [] on a non-200 response', async () => {
    stubCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => fakeJsonResponse(403, { error: 'forbidden' })));

    expect(await fetchOwnedGames()).toEqual([]);
  });

  it('returns [] when the response body fails to parse as JSON', async () => {
    stubCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => fakeBrokenJsonResponse(200)));

    expect(await fetchOwnedGames()).toEqual([]);
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

  it('returns [] for a private-profile shaped response, same as a request failure', async () => {
    stubCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => fakeJsonResponse(200, { response: {} })));

    expect(await fetchOwnedGames()).toEqual([]);
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
