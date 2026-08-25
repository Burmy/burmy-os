import { afterEach, describe, expect, it, vi } from 'vitest';

import { __resetIgdbTokenCacheForTests, fetchUpcomingGames, igdbConfigured, searchGames } from '@/server/db/games/igdb';

/**
 * `searchGames` must fail SOFT in every case — missing credentials, a
 * network error, a timeout, a non-200, or a malformed body all resolve to
 * `[]`, never a thrown error. That contract is what lets the owner add a
 * game with no IGDB credentials configured and no network at all (see
 * `metadata.ts`'s header).
 *
 * `restoreMocks: true` (vitest.config.ts) resets `vi.fn()` call state between
 * tests, but does NOT undo `vi.stubEnv`/`vi.stubGlobal`, and does NOT touch
 * this module's own module-scope token cache — all three are unwound
 * explicitly here so one test's fake `fetch`, fake credentials, or cached
 * token can never leak into the next.
 */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __resetIgdbTokenCacheForTests();
});

function stubCredentials(): void {
  vi.stubEnv('IGDB_CLIENT_ID', 'test-client-id');
  vi.stubEnv('IGDB_CLIENT_SECRET', 'test-client-secret');
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

function endpointOf(url: unknown): 'token' | 'games' | 'timeToBeat' | 'unknown' {
  const value = String(url);
  if (value.includes('id.twitch.tv')) return 'token';
  if (value.includes('game_time_to_beats')) return 'timeToBeat';
  if (value.includes('api.igdb.com/v4/games')) return 'games';
  return 'unknown';
}

const TOKEN_OK = { access_token: 'test-token', expires_in: 5_587_808 };

const GAME_ROW = {
  id: 1942,
  name: 'The Witcher 3: Wild Hunt',
  cover: { image_id: 'co1wyy' },
  genres: [{ name: 'Role-playing (RPG)' }],
  involved_companies: [{ company: { name: 'CD Projekt RED' }, developer: true, publisher: false }],
  aggregated_rating: 92,
  first_release_date: 1_431_993_600,
  age_ratings: [{ rating_category: { rating: 'M', organization: { name: 'ESRB' } } }],
};

const EXPECTED_SUGGESTION = {
  externalId: '1942',
  title: 'The Witcher 3: Wild Hunt',
  coverUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1wyy.jpg',
  genre: 'Role-playing (RPG)',
  developer: 'CD Projekt RED',
  publisher: null,
  metacritic: 92,
  averagePlaytimeHours: null,
  esrbRating: 'M',
  releaseYear: 2015,
};

describe('searchGames — missing configuration and input', () => {
  it('returns [] and never calls fetch when IGDB_CLIENT_ID is unset', async () => {
    vi.stubEnv('IGDB_CLIENT_ID', undefined);
    vi.stubEnv('IGDB_CLIENT_SECRET', 'test-client-secret');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await searchGames('Elden Ring')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns [] and never calls fetch when IGDB_CLIENT_SECRET is unset', async () => {
    vi.stubEnv('IGDB_CLIENT_ID', 'test-client-id');
    vi.stubEnv('IGDB_CLIENT_SECRET', undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await searchGames('Elden Ring')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns [] when both credentials are the empty string', async () => {
    vi.stubEnv('IGDB_CLIENT_ID', '');
    vi.stubEnv('IGDB_CLIENT_SECRET', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await searchGames('Elden Ring')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns [] for an empty or whitespace-only query without calling fetch', async () => {
    stubCredentials();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await searchGames('')).toEqual([]);
    expect(await searchGames('   ')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('searchGames — token fetch failures', () => {
  it('returns [] when the token request rejects with a network error', async () => {
    stubCredentials();
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchSpy);

    expect(await searchGames('Elden Ring')).toEqual([]);
    // No token, so the games endpoint is never even attempted.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns [] when the token request rejects with a timeout-shaped error', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }),
    );

    expect(await searchGames('Elden Ring')).toEqual([]);
  });

  it('returns [] when the token response is a non-200', async () => {
    stubCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => fakeJsonResponse(401, { message: 'invalid client' })));

    expect(await searchGames('Elden Ring')).toEqual([]);
  });

  it('returns [] when the token response body fails to parse as JSON', async () => {
    stubCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => fakeBrokenJsonResponse(200)));

    expect(await searchGames('Elden Ring')).toEqual([]);
  });

  it('returns [] when the token response is missing access_token or expires_in', async () => {
    stubCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => fakeJsonResponse(200, { token_type: 'bearer' })));

    expect(await searchGames('Elden Ring')).toEqual([]);
  });
});

describe('searchGames — primary /games request failures', () => {
  it('returns [] when the games request rejects with a network error', async () => {
    stubCredentials();
    const fetchSpy = vi.fn(async (url: unknown) => {
      if (endpointOf(url) === 'token') return fakeJsonResponse(200, TOKEN_OK);
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchSpy);

    expect(await searchGames('Elden Ring')).toEqual([]);
  });

  it('returns [] on a non-200, non-401 games response', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (endpointOf(url) === 'token') return fakeJsonResponse(200, TOKEN_OK);
        return fakeJsonResponse(500, { message: 'server error' });
      }),
    );

    expect(await searchGames('Elden Ring')).toEqual([]);
  });

  it('returns [] when the games response body fails to parse as JSON (guards the try block extent)', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (endpointOf(url) === 'token') return fakeJsonResponse(200, TOKEN_OK);
        return fakeBrokenJsonResponse(200);
      }),
    );

    expect(await searchGames('Elden Ring')).toEqual([]);
  });
});

describe('searchGames — success path', () => {
  it('maps a well-formed response through to real suggestions, including playtime from the second call', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const endpoint = endpointOf(url);
        if (endpoint === 'token') return fakeJsonResponse(200, TOKEN_OK);
        if (endpoint === 'games') return fakeJsonResponse(200, [GAME_ROW]);
        if (endpoint === 'timeToBeat') return fakeJsonResponse(200, [{ game_id: 1942, normally: 126_000 }]); // 35h
        throw new Error(`unexpected endpoint for ${String(url)}`);
      }),
    );

    expect(await searchGames('Witcher 3')).toEqual([{ ...EXPECTED_SUGGESTION, averagePlaytimeHours: 35 }]);
  });

  it('a failing time-to-beat call does not blank out an already-successful search', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const endpoint = endpointOf(url);
        if (endpoint === 'token') return fakeJsonResponse(200, TOKEN_OK);
        if (endpoint === 'games') return fakeJsonResponse(200, [GAME_ROW]);
        if (endpoint === 'timeToBeat') throw new TypeError('fetch failed');
        throw new Error(`unexpected endpoint for ${String(url)}`);
      }),
    );

    expect(await searchGames('Witcher 3')).toEqual([EXPECTED_SUGGESTION]);
  });
});

describe('searchGames — 401-triggered refresh and retry', () => {
  it('refreshes the token and retries exactly once after a 401, then succeeds', async () => {
    stubCredentials();
    let tokenCalls = 0;
    let gamesCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const endpoint = endpointOf(url);
        if (endpoint === 'token') {
          tokenCalls += 1;
          return fakeJsonResponse(200, { access_token: `token-${tokenCalls}`, expires_in: 5_587_808 });
        }
        if (endpoint === 'games') {
          gamesCalls += 1;
          // First attempt (with the stale-but-not-yet-expired cached token)
          // comes back 401; the retry, with a freshly fetched token, succeeds.
          if (gamesCalls === 1) return fakeJsonResponse(401, { message: 'invalid token' });
          return fakeJsonResponse(200, [GAME_ROW]);
        }
        // Time-to-beat is irrelevant to this test; fail it softly so the
        // assertion below is only about the games-endpoint retry count.
        return fakeJsonResponse(500, {});
      }),
    );

    expect(await searchGames('Witcher 3')).toEqual([EXPECTED_SUGGESTION]);
    expect(tokenCalls).toBe(2);
    expect(gamesCalls).toBe(2);
  });

  it('does not loop when the retried request also 401s — fails soft after exactly one retry', async () => {
    stubCredentials();
    let tokenCalls = 0;
    let gamesCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const endpoint = endpointOf(url);
        if (endpoint === 'token') {
          tokenCalls += 1;
          return fakeJsonResponse(200, { access_token: `token-${tokenCalls}`, expires_in: 5_587_808 });
        }
        if (endpoint === 'games') {
          gamesCalls += 1;
          return fakeJsonResponse(401, { message: 'invalid token' });
        }
        return fakeJsonResponse(500, {});
      }),
    );

    expect(await searchGames('Witcher 3')).toEqual([]);
    expect(tokenCalls).toBe(2);
    expect(gamesCalls).toBe(2);
  });
});

/**
 * `fetchUpcomingGames` shares `igdbPost`, the token cache, and the games
 * endpoint with `searchGames` above — its own soft-fail contract (missing
 * credentials, network error, non-2xx, malformed JSON -> `[]`, never a
 * throw) is exercised narrowly here rather than repeating every case
 * `searchGames`'s suites already cover for the shared plumbing.
 */
describe('fetchUpcomingGames', () => {
  it('returns [] and never calls fetch when credentials are missing', async () => {
    vi.stubEnv('IGDB_CLIENT_ID', undefined);
    vi.stubEnv('IGDB_CLIENT_SECRET', undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchUpcomingGames()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns [] when the token request fails', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    expect(await fetchUpcomingGames()).toEqual([]);
  });

  it('returns [] on a non-2xx games response', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (endpointOf(url) === 'token') return fakeJsonResponse(200, TOKEN_OK);
        return fakeJsonResponse(500, { message: 'server error' });
      }),
    );

    expect(await fetchUpcomingGames()).toEqual([]);
  });

  it('returns [] when the games response body fails to parse as JSON', async () => {
    stubCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (endpointOf(url) === 'token') return fakeJsonResponse(200, TOKEN_OK);
        return fakeBrokenJsonResponse(200);
      }),
    );

    expect(await fetchUpcomingGames()).toEqual([]);
  });

  it('shapes a well-formed response and sends game_type = 0 / platforms = (167,6) in the request body', async () => {
    stubCredentials();
    let requestedBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (endpointOf(url) === 'token') return fakeJsonResponse(200, TOKEN_OK);
        requestedBody = String(init?.body ?? '');
        return fakeJsonResponse(200, [
          {
            id: 92550,
            name: 'Fable',
            hypes: 402,
            cover: { image_id: 'cobc6d' },
            platforms: [6, 167],
            release_dates: [{ y: 2027, m: 2, date_format: 0, platform: 167 }],
          },
        ]);
      }),
    );

    const games = await fetchUpcomingGames();

    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({ igdbId: 92550, title: 'Fable', hypes: 402 });
    expect(requestedBody).toContain('game_type = 0');
    expect(requestedBody).toContain('platforms = (167,6)');
    expect(requestedBody).toContain('hypes >= 30');
  });
});

/**
 * `igdbConfigured()` is what lets the Upcoming tab tell "not configured"
 * apart from "configured, but nothing came back" — a distinction
 * `fetchUpcomingGames()` alone cannot make, since it returns `[]` for both.
 * See that function's own doc comment.
 */
describe('igdbConfigured', () => {
  it('is false when neither credential is set', () => {
    expect(igdbConfigured()).toBe(false);
  });

  it('is false when only one of the two credentials is set', () => {
    vi.stubEnv('IGDB_CLIENT_ID', 'test-client-id');
    expect(igdbConfigured()).toBe(false);
  });

  it('is true once both credentials are set', () => {
    stubCredentials();
    expect(igdbConfigured()).toBe(true);
  });
});
