import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserPlayedGamesResponse, UserTitlesResponse } from 'psn-api';

import { categoryToPlatform, parsePlayDuration, toPlayedTitles, toTrophyTitles } from '@/server/games/psn';

/**
 * `parsePlayDuration`, `categoryToPlatform`, `toPlayedTitles`, and
 * `toTrophyTitles` are pure — no mocking needed, just real assertions
 * against hand-computed expected values (see each `describe` block for the
 * arithmetic). `psnConfigured`/`fetchPlayedTitles`/`fetchTrophyTitles`
 * (`psn-client.ts`, the one HTTP boundary) are covered further down against
 * a manually mocked `psn-api` module — see that section's header comment.
 */

describe('parsePlayDuration', () => {
  // 228 + 56/60 + 33/3600 = 228.9425 hours -> x10 = 2289.425 -> rounds to
  // 2289. Verified directly in Node (not copied from the brief's
  // illustrative "2290," which the brief itself flagged as unverified).
  it('parses hours, minutes and seconds', () => {
    expect(parsePlayDuration('PT228H56M33S')).toBe(2289);
  });

  it('parses an hours-only duration', () => {
    expect(parsePlayDuration('PT5H')).toBe(50);
  });

  it('parses a minutes-only duration', () => {
    expect(parsePlayDuration('PT30M')).toBe(5);
  });

  // 3/60 = 0.05 hours -> x10 = 0.5 -> Math.round rounds half up to 1.
  it('rounds to the nearest tenth', () => {
    expect(parsePlayDuration('PT0H3M')).toBe(1);
  });

  it('parses a seconds-only duration', () => {
    // 45/3600 = 0.0125 hours -> x10 = 0.125 -> rounds to 0.
    expect(parsePlayDuration('PT45S')).toBe(0);
  });

  it('returns 0 for an unparseable string rather than NaN', () => {
    expect(parsePlayDuration('nonsense')).toBe(0);
  });

  it('returns 0 for an empty string', () => {
    expect(parsePlayDuration('')).toBe(0);
  });

  it('returns 0 for the zero-length duration "PT"', () => {
    expect(parsePlayDuration('PT')).toBe(0);
  });
});

describe('categoryToPlatform', () => {
  it('maps ps4_game to ps4', () => {
    expect(categoryToPlatform('ps4_game')).toBe('ps4');
  });

  it('maps ps5_native_game to ps5', () => {
    expect(categoryToPlatform('ps5_native_game')).toBe('ps5');
  });

  it('never maps anything to psp', () => {
    for (const category of ['ps4_game', 'ps5_native_game', 'pspc_game', 'unknown', '']) {
      expect(categoryToPlatform(category)).not.toBe('psp');
    }
  });

  it('maps pspc_game to null — its meaning is unconfirmed, never guessed', () => {
    expect(categoryToPlatform('pspc_game')).toBeNull();
  });

  it('returns null for an unrecognised category rather than guessing', () => {
    expect(categoryToPlatform('something_new')).toBeNull();
  });
});

const WELL_FORMED_TITLE = {
  titleId: 'CUSA01433_00',
  name: 'Rocket League®',
  localizedName: 'Rocket League®',
  imageUrl: 'https://image.example/rocket-league.png',
  category: 'ps4_game',
  service: 'none',
  playCount: 100,
  firstPlayedDateTime: '2015-07-10T19:40:19Z',
  lastPlayedDateTime: '2024-08-03T19:28:27.12Z',
  playDuration: 'PT10H30M',
};

describe('toPlayedTitles', () => {
  it('shapes a well-formed response', () => {
    expect(toPlayedTitles({ titles: [WELL_FORMED_TITLE] })).toEqual([
      {
        titleId: 'CUSA01433_00',
        name: 'Rocket League®',
        platform: 'ps4',
        hoursTenths: 105, // 10 + 30/60 = 10.5h -> x10 = 105
        firstPlayedYear: 2015,
        lastPlayedAt: '2024-08-03T19:28:27.12Z',
      },
    ]);
  });

  it('skips a malformed entry rather than throwing', () => {
    expect(toPlayedTitles({ titles: [null, WELL_FORMED_TITLE, { titleId: '', name: 'no id' }, 'garbage'] })).toEqual([
      {
        titleId: 'CUSA01433_00',
        name: 'Rocket League®',
        platform: 'ps4',
        hoursTenths: 105,
        firstPlayedYear: 2015,
        lastPlayedAt: '2024-08-03T19:28:27.12Z',
      },
    ]);
  });

  it('returns [] for a payload with no titles key', () => {
    expect(toPlayedTitles({})).toEqual([]);
  });

  it('returns [] for a non-object payload', () => {
    expect(toPlayedTitles(null)).toEqual([]);
    expect(toPlayedTitles('nope')).toEqual([]);
  });

  it('extracts the year from firstPlayedDateTime', () => {
    const [title] = toPlayedTitles({
      titles: [{ ...WELL_FORMED_TITLE, firstPlayedDateTime: '2015-07-10T19:40:19Z' }],
    });
    expect(title?.firstPlayedYear).toBe(2015);
  });

  it('returns a null year when firstPlayedDateTime is absent', () => {
    const { firstPlayedDateTime: _omit, ...withoutFirstPlayed } = WELL_FORMED_TITLE;
    const [title] = toPlayedTitles({ titles: [withoutFirstPlayed] });
    expect(title?.firstPlayedYear).toBeNull();
  });

  it('maps an unrecognised category to a null platform rather than throwing', () => {
    const [title] = toPlayedTitles({ titles: [{ ...WELL_FORMED_TITLE, category: 'pspc_game' }] });
    expect(title?.platform).toBeNull();
  });
});

function trophyCounts(bronze: number, silver: number, gold: number, platinum: 0 | 1) {
  return { bronze, silver, gold, platinum };
}

const WELL_FORMED_TROPHY_TITLE = {
  npServiceName: 'trophy2',
  npCommunicationId: 'NPWR12345_00',
  trophySetVersion: '01.00',
  trophyTitleName: 'Astro Bot',
  trophyTitleIconUrl: 'https://image.example/astro-bot.png',
  trophyTitlePlatform: 'PS5',
  hasTrophyGroups: false,
  definedTrophies: trophyCounts(24, 12, 3, 1),
  progress: 100,
  earnedTrophies: trophyCounts(24, 12, 3, 1),
  hiddenFlag: false,
  lastUpdatedDateTime: '2024-08-03T19:28:27Z',
};

describe('toTrophyTitles', () => {
  it('sums earned trophies across all four grades', () => {
    const [title] = toTrophyTitles({
      trophyTitles: [{ ...WELL_FORMED_TROPHY_TITLE, earnedTrophies: trophyCounts(10, 5, 2, 1) }],
    });
    expect(title?.earned).toBe(18);
  });

  it('sums defined trophies across all four grades', () => {
    const [title] = toTrophyTitles({
      trophyTitles: [{ ...WELL_FORMED_TROPHY_TITLE, definedTrophies: trophyCounts(24, 12, 3, 1) }],
    });
    expect(title?.total).toBe(40);
  });

  it('reports platinum true only when an actual platinum was earned', () => {
    const [title] = toTrophyTitles({
      trophyTitles: [
        {
          ...WELL_FORMED_TROPHY_TITLE,
          definedTrophies: trophyCounts(24, 12, 3, 1),
          earnedTrophies: trophyCounts(24, 12, 3, 1),
        },
      ],
    });
    expect(title?.platinum).toBe(true);
  });

  it('reports platinum false when the title defines one but it is unearned', () => {
    const [title] = toTrophyTitles({
      trophyTitles: [
        {
          ...WELL_FORMED_TROPHY_TITLE,
          definedTrophies: trophyCounts(24, 12, 3, 1),
          earnedTrophies: trophyCounts(10, 4, 1, 0),
        },
      ],
    });
    expect(title?.platinum).toBe(false);
  });

  it('reports platinum false when the title defines no platinum at all', () => {
    const [title] = toTrophyTitles({
      trophyTitles: [
        {
          ...WELL_FORMED_TROPHY_TITLE,
          definedTrophies: trophyCounts(10, 5, 2, 0),
          earnedTrophies: trophyCounts(10, 5, 2, 0),
        },
      ],
    });
    expect(title?.platinum).toBe(false);
  });

  it('skips a malformed entry rather than throwing', () => {
    expect(
      toTrophyTitles({
        trophyTitles: [
          null,
          { ...WELL_FORMED_TROPHY_TITLE, definedTrophies: undefined },
          { ...WELL_FORMED_TROPHY_TITLE, npCommunicationId: '' },
          WELL_FORMED_TROPHY_TITLE,
        ],
      }),
    ).toEqual([{ npCommunicationId: 'NPWR12345_00', name: 'Astro Bot', earned: 40, total: 40, platinum: true }]);
  });

  it('returns [] for a payload with no trophyTitles key', () => {
    expect(toTrophyTitles({})).toEqual([]);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * `src/server/db/games/psn-client.ts` — the one HTTP boundary.
 *
 * `psn-api`'s exported functions are manually mocked (not automocked) so
 * every test controls exactly what each step of the auth chain and each
 * paginated request resolves or throws, without needing to reproduce Sony's
 * actual OAuth redirect-header wire format. This mirrors testing the
 * DECISION LOGIC in `psn-client.ts`, not psn-api's own internals — those are
 * a third-party library's responsibility, already verified by reading its
 * source (see `psn-client.ts`'s module header) rather than re-tested here.
 *
 * `restoreMocks: true` (vitest.config.ts) calls `.mockRestore()` on every
 * `vi.spyOn` SPY before each test — a no-op on the plain `vi.fn()`s a
 * `vi.mock(factory)` produces, since there is no "original implementation"
 * to restore. These mocks are therefore reset explicitly with
 * `vi.resetAllMocks()` in `afterEach`, alongside `vi.stubEnv` and this
 * module's own module-scope token cache, so one test's queued
 * `mockResolvedValueOnce` calls, default implementation, or call history can
 * never leak into the next.
 * ─────────────────────────────────────────────────────────────────────────────
 */
vi.mock('psn-api', () => ({
  exchangeNpssoForAccessCode: vi.fn(),
  exchangeAccessCodeForAuthTokens: vi.fn(),
  exchangeRefreshTokenForAuthTokens: vi.fn(),
  getUserPlayedGames: vi.fn(),
  getUserTitles: vi.fn(),
}));

const psnApi = await import('psn-api');
const {
  __resetPsnAuthCacheForTests,
  fetchPlayedTitles,
  fetchTrophyTitles,
  psnConfigured,
} = await import('@/server/db/games/psn-client');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  __resetPsnAuthCacheForTests();
});

const NPSSO_INVALID_ERROR = new Error(`
      There was a problem retrieving your PSN access code. Is your NPSSO code valid?
      To get a new NPSSO code, visit https://ca.account.sony.com/api/v1/ssocookie.
    `);

function stubSuccessfulAuth(overrides: { accessToken?: string; refreshToken?: string; expiresIn?: number } = {}): void {
  vi.mocked(psnApi.exchangeNpssoForAccessCode).mockResolvedValue('access-code-1');
  vi.mocked(psnApi.exchangeAccessCodeForAuthTokens).mockResolvedValue({
    accessToken: overrides.accessToken ?? 'access-token-1',
    expiresIn: overrides.expiresIn ?? 3600,
    idToken: 'id-token-1',
    refreshToken: overrides.refreshToken ?? 'refresh-token-1',
    refreshTokenExpiresIn: 5_184_000,
    scope: 'psn:mobile.v2.core psn:clientapp',
    tokenType: 'bearer',
  });
}

/**
 * Builds a `UserPlayedGamesResponse`-shaped mock. The real interface types
 * `titles` as full `psn-api` title objects; test fixtures here are
 * deliberately partial/malformed in places (that's what several `toPlayedTitles`
 * and pagination tests are exercising), so this goes through `unknown` rather
 * than fighting the real type at every call site — `psn-client.ts` itself
 * only ever treats a page's payload as `unknown` before handing it to
 * `toPlayedTitles`, so this mock is no less faithful to the real boundary
 * than that.
 */
function playedGamesPage(titles: unknown[], nextOffset?: number): UserPlayedGamesResponse {
  return {
    titles,
    totalItemCount: titles.length,
    // The real type marks this required; a genuinely-last page still needs
    // SOME value here for the mock to typecheck, so 0 stands in for "no
    // further page" alongside the <= offset guard in psn-client.ts.
    nextOffset: nextOffset ?? 0,
    previousOffset: 0,
  } as unknown as UserPlayedGamesResponse;
}

/** Same rationale as `playedGamesPage`, for `getUserTitles`'s response shape. */
function trophyTitlesPage(trophyTitles: unknown[], nextOffset?: number): UserTitlesResponse {
  return {
    trophyTitles,
    totalItemCount: trophyTitles.length,
    nextOffset: nextOffset ?? 0,
    previousOffset: 0,
  } as unknown as UserTitlesResponse;
}

describe('psnConfigured', () => {
  it('is false when PSN_NPSSO is unset', () => {
    vi.stubEnv('PSN_NPSSO', undefined);
    expect(psnConfigured()).toBe(false);
  });

  it('is false when PSN_NPSSO is the empty string', () => {
    vi.stubEnv('PSN_NPSSO', '');
    expect(psnConfigured()).toBe(false);
  });

  it('is true when PSN_NPSSO is set', () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    expect(psnConfigured()).toBe(true);
  });
});

describe('fetchPlayedTitles — not configured', () => {
  it("returns 'not_configured' and never calls psn-api when PSN_NPSSO is unset", async () => {
    vi.stubEnv('PSN_NPSSO', undefined);

    expect(await fetchPlayedTitles()).toBe('not_configured');
    expect(psnApi.exchangeNpssoForAccessCode).not.toHaveBeenCalled();
  });
});

describe('fetchPlayedTitles — auth failures', () => {
  it("returns 'token_expired' when the NPSSO is rejected by Sony's OAuth exchange", async () => {
    vi.stubEnv('PSN_NPSSO', 'stale-npsso');
    vi.mocked(psnApi.exchangeNpssoForAccessCode).mockRejectedValue(NPSSO_INVALID_ERROR);

    expect(await fetchPlayedTitles()).toBe('token_expired');
  });

  it("returns 'unavailable' on a network error during the NPSSO exchange, not 'token_expired'", async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    vi.mocked(psnApi.exchangeNpssoForAccessCode).mockRejectedValue(new TypeError('fetch failed'));

    expect(await fetchPlayedTitles()).toBe('unavailable');
  });

  it("returns 'unavailable' when exchanging the access code for tokens throws", async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    vi.mocked(psnApi.exchangeNpssoForAccessCode).mockResolvedValue('access-code-1');
    vi.mocked(psnApi.exchangeAccessCodeForAuthTokens).mockRejectedValue(new SyntaxError('Unexpected token'));

    expect(await fetchPlayedTitles()).toBe('unavailable');
  });

  it("returns 'unavailable' when the token response is missing accessToken", async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    vi.mocked(psnApi.exchangeNpssoForAccessCode).mockResolvedValue('access-code-1');
    vi.mocked(psnApi.exchangeAccessCodeForAuthTokens).mockResolvedValue({
      accessToken: '',
      expiresIn: 3600,
      idToken: 'id-token-1',
      refreshToken: 'refresh-token-1',
      refreshTokenExpiresIn: 5_184_000,
      scope: 'psn:mobile.v2.core psn:clientapp',
      tokenType: 'bearer',
    });

    expect(await fetchPlayedTitles()).toBe('unavailable');
  });

  it("returns 'unavailable' when the played-games request itself fails", async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    stubSuccessfulAuth();
    vi.mocked(psnApi.getUserPlayedGames).mockRejectedValue(new TypeError('fetch failed'));

    expect(await fetchPlayedTitles()).toBe('unavailable');
  });
});

describe('fetchPlayedTitles — success and pagination', () => {
  it('maps a single-page response through to real played titles', async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    stubSuccessfulAuth();
    vi.mocked(psnApi.getUserPlayedGames).mockResolvedValue(playedGamesPage([WELL_FORMED_TITLE]));

    const result = await fetchPlayedTitles();
    expect(result).toEqual([
      {
        titleId: 'CUSA01433_00',
        name: 'Rocket League®',
        platform: 'ps4',
        hoursTenths: 105,
        firstPlayedYear: 2015,
        lastPlayedAt: '2024-08-03T19:28:27.12Z',
      },
    ]);
  });

  it('follows nextOffset across multiple pages and stops once no further page is offered', async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    stubSuccessfulAuth();

    const titleA = { ...WELL_FORMED_TITLE, titleId: 'CUSA00001_00', name: 'Title A' };
    const titleB = { ...WELL_FORMED_TITLE, titleId: 'CUSA00002_00', name: 'Title B' };
    const titleC = { ...WELL_FORMED_TITLE, titleId: 'CUSA00003_00', name: 'Title C' };

    vi.mocked(psnApi.getUserPlayedGames)
      .mockResolvedValueOnce(playedGamesPage([titleA], 1))
      .mockResolvedValueOnce(playedGamesPage([titleB], 2))
      .mockResolvedValueOnce(playedGamesPage([titleC])); // nextOffset 0, <= current offset 2 -> stop

    const result = await fetchPlayedTitles();
    expect(result).toEqual([
      expect.objectContaining({ titleId: 'CUSA00001_00' }),
      expect.objectContaining({ titleId: 'CUSA00002_00' }),
      expect.objectContaining({ titleId: 'CUSA00003_00' }),
    ]);
    expect(psnApi.getUserPlayedGames).toHaveBeenCalledTimes(3);
    expect(psnApi.getUserPlayedGames).toHaveBeenNthCalledWith(
      1,
      { accessToken: 'access-token-1' },
      'me',
      { limit: 200, offset: 0 },
    );
    expect(psnApi.getUserPlayedGames).toHaveBeenNthCalledWith(
      2,
      { accessToken: 'access-token-1' },
      'me',
      { limit: 200, offset: 1 },
    );
    expect(psnApi.getUserPlayedGames).toHaveBeenNthCalledWith(
      3,
      { accessToken: 'access-token-1' },
      'me',
      { limit: 200, offset: 2 },
    );
  });

  it('stops after a hard cap of 20 pages when nextOffset never stops advancing', async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    stubSuccessfulAuth();

    vi.mocked(psnApi.getUserPlayedGames).mockImplementation(async (_auth, _accountId, options) => {
      const offset = (options as { offset: number }).offset;
      return playedGamesPage([{ ...WELL_FORMED_TITLE, titleId: `CUSA-${offset}` }], offset + 1);
    });

    const result = await fetchPlayedTitles();
    expect(psnApi.getUserPlayedGames).toHaveBeenCalledTimes(20);
    expect(Array.isArray(result) && result.length).toBe(20);
  });

  it('stops the loop when a page reports a nextOffset that does not advance past the current offset', async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    stubSuccessfulAuth();
    vi.mocked(psnApi.getUserPlayedGames).mockResolvedValue(playedGamesPage([WELL_FORMED_TITLE], 0));

    await fetchPlayedTitles();
    expect(psnApi.getUserPlayedGames).toHaveBeenCalledTimes(1);
  });
});

describe('fetchPlayedTitles — token reuse and refresh', () => {
  it('reuses the cached access token on a second call, never re-exchanging the NPSSO', async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    stubSuccessfulAuth({ expiresIn: 3600 });
    vi.mocked(psnApi.getUserPlayedGames).mockResolvedValue(playedGamesPage([]));

    await fetchPlayedTitles();
    await fetchPlayedTitles();

    expect(psnApi.exchangeNpssoForAccessCode).toHaveBeenCalledTimes(1);
    expect(psnApi.exchangeAccessCodeForAuthTokens).toHaveBeenCalledTimes(1);
  });

  it('refreshes via exchangeRefreshTokenForAuthTokens once the cached token is due for refresh, without a fresh NPSSO exchange', async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    // expiresIn (10s) is well under the 60s safety margin, so the cached
    // token is immediately due for refresh on the very next call.
    stubSuccessfulAuth({ expiresIn: 10 });
    vi.mocked(psnApi.exchangeRefreshTokenForAuthTokens).mockResolvedValue({
      accessToken: 'access-token-2',
      expiresIn: 3600,
      idToken: 'id-token-2',
      refreshToken: 'refresh-token-2',
      refreshTokenExpiresIn: 5_184_000,
      scope: 'psn:mobile.v2.core psn:clientapp',
      tokenType: 'bearer',
    });
    vi.mocked(psnApi.getUserPlayedGames).mockResolvedValue(playedGamesPage([]));

    await fetchPlayedTitles();
    await fetchPlayedTitles();

    expect(psnApi.exchangeNpssoForAccessCode).toHaveBeenCalledTimes(1);
    expect(psnApi.exchangeRefreshTokenForAuthTokens).toHaveBeenCalledWith('refresh-token-1');
    expect(psnApi.getUserPlayedGames).toHaveBeenNthCalledWith(
      2,
      { accessToken: 'access-token-2' },
      'me',
      { limit: 200, offset: 0 },
    );
  });

  it('falls back to a full NPSSO re-exchange when the refresh itself fails', async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    stubSuccessfulAuth({ expiresIn: 10 });
    vi.mocked(psnApi.exchangeRefreshTokenForAuthTokens).mockRejectedValue(new TypeError('fetch failed'));
    vi.mocked(psnApi.getUserPlayedGames).mockResolvedValue(playedGamesPage([]));

    await fetchPlayedTitles();
    // Second call: refresh fails, falls back to re-exchanging the NPSSO,
    // which succeeds again via the same stubbed resolved value.
    const result = await fetchPlayedTitles();

    expect(result).toEqual([]);
    expect(psnApi.exchangeRefreshTokenForAuthTokens).toHaveBeenCalledTimes(1);
    expect(psnApi.exchangeNpssoForAccessCode).toHaveBeenCalledTimes(2);
  });

  it("reports 'token_expired' when a failed refresh falls back to an NPSSO re-exchange that is itself rejected", async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    stubSuccessfulAuth({ expiresIn: 10 });
    vi.mocked(psnApi.exchangeRefreshTokenForAuthTokens).mockRejectedValue(new TypeError('fetch failed'));
    vi.mocked(psnApi.getUserPlayedGames).mockResolvedValue(playedGamesPage([]));

    await fetchPlayedTitles();
    vi.mocked(psnApi.exchangeNpssoForAccessCode).mockRejectedValue(NPSSO_INVALID_ERROR);

    expect(await fetchPlayedTitles()).toBe('token_expired');
  });
});

describe('fetchTrophyTitles', () => {
  it("returns 'not_configured' and never calls psn-api when PSN_NPSSO is unset", async () => {
    vi.stubEnv('PSN_NPSSO', undefined);

    expect(await fetchTrophyTitles()).toBe('not_configured');
    expect(psnApi.getUserTitles).not.toHaveBeenCalled();
  });

  it('maps a single-page response through to real trophy titles', async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    stubSuccessfulAuth();
    vi.mocked(psnApi.getUserTitles).mockResolvedValue(trophyTitlesPage([WELL_FORMED_TROPHY_TITLE]));

    expect(await fetchTrophyTitles()).toEqual([
      { npCommunicationId: 'NPWR12345_00', name: 'Astro Bot', earned: 40, total: 40, platinum: true },
    ]);
  });

  it('follows nextOffset across multiple pages', async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    stubSuccessfulAuth();

    const titleA = { ...WELL_FORMED_TROPHY_TITLE, npCommunicationId: 'NPWR00001_00' };
    const titleB = { ...WELL_FORMED_TROPHY_TITLE, npCommunicationId: 'NPWR00002_00' };

    vi.mocked(psnApi.getUserTitles)
      .mockResolvedValueOnce(trophyTitlesPage([titleA], 1))
      .mockResolvedValueOnce(trophyTitlesPage([titleB]));

    const result = await fetchTrophyTitles();
    expect(result).toEqual([
      expect.objectContaining({ npCommunicationId: 'NPWR00001_00' }),
      expect.objectContaining({ npCommunicationId: 'NPWR00002_00' }),
    ]);
    expect(psnApi.getUserTitles).toHaveBeenCalledTimes(2);
  });

  it("returns 'unavailable' when the titles request itself fails", async () => {
    vi.stubEnv('PSN_NPSSO', 'test-npsso');
    stubSuccessfulAuth();
    vi.mocked(psnApi.getUserTitles).mockRejectedValue(new TypeError('fetch failed'));

    expect(await fetchTrophyTitles()).toBe('unavailable');
  });
});
