import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAnilistThrottleForTests,
  anilistConfigured,
  fetchActivities,
  fetchAnimeList,
} from '@/server/db/anime/anilist-client';

/**
 * The one HTTP boundary to AniList.
 *
 * THE MOST IMPORTANT TESTS HERE ARE THE NO-CREDENTIAL ONES. They assert that
 * `fetch` is never CALLED, not merely that the return value is empty — that is
 * the mechanism enforcing CLAUDE.md's rule that the full suite passes with no
 * AniList variable present, and the reason it cannot quietly start depending on
 * a real account.
 *
 * The failure paths below are all reachable in production and each is tested
 * separately, because `null` and `[]` mean different things and the whole
 * contract rests on keeping them apart.
 */

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

const LIST_BODY = {
  data: {
    MediaListCollection: {
      lists: [
        {
          entries: [
            {
              progress: 12,
              repeat: 0,
              status: 'CURRENT',
              media: {
                id: 16498,
                title: { romaji: 'Shingeki no Kyojin' },
                episodes: 25,
                duration: 24,
              },
            },
          ],
        },
      ],
    },
  },
};

function activityBody(hasNextPage: boolean, id = 1): unknown {
  return {
    data: {
      Page: {
        pageInfo: { hasNextPage },
        activities: [{ id, createdAt: 1_700_000_000, progress: '7', status: 'watched episode', media: { id: 16498 } }],
      },
    },
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubEnv('ANILIST_USERNAME', 'burmy');
  __resetAnilistThrottleForTests();
});

afterEach(() => {
  // `restoreMocks: true` resets vi.fn() call state but does NOT undo
  // stubEnv/stubGlobal, and does not touch this module's own throttle
  // watermark — all three are unwound explicitly.
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __resetAnilistThrottleForTests();
});

describe('anilistConfigured', () => {
  it('is true only for a real username', () => {
    expect(anilistConfigured()).toBe(true);
  });

  it('is false when unset or blank', () => {
    vi.stubEnv('ANILIST_USERNAME', undefined);
    expect(anilistConfigured()).toBe(false);

    vi.stubEnv('ANILIST_USERNAME', '   ');
    expect(anilistConfigured()).toBe(false);
  });

  it('reads the environment directly and never touches the network', () => {
    // The whole reason this function exists: `[]` cannot distinguish "not
    // configured" from "empty library", so the UI needs a question it can ask
    // without making a request.
    anilistConfigured();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('fetchAnimeList — no credentials', () => {
  it('returns null and NEVER CALLS FETCH when ANILIST_USERNAME is unset', async () => {
    vi.stubEnv('ANILIST_USERNAME', undefined);

    expect(await fetchAnimeList()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats a blank username the same as unset', async () => {
    vi.stubEnv('ANILIST_USERNAME', '   ');

    expect(await fetchAnimeList()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('fetchAnimeList — failure modes', () => {
  it('returns the shaped list on success', async () => {
    fetchSpy.mockResolvedValue(fakeJsonResponse(200, LIST_BODY));

    const list = await fetchAnimeList();
    expect(list).toHaveLength(1);
    expect(list?.[0]?.titleRomaji).toBe('Shingeki no Kyojin');
  });

  it('returns [] — not null — for a genuinely empty library', async () => {
    // A real answer. Distinct from every failure below.
    fetchSpy.mockResolvedValue(fakeJsonResponse(200, { data: { MediaListCollection: { lists: [] } } }));
    expect(await fetchAnimeList()).toEqual([]);
  });

  it('returns null on a non-2xx', async () => {
    fetchSpy.mockResolvedValue(fakeJsonResponse(500, {}));
    expect(await fetchAnimeList()).toBeNull();
  });

  it('returns null on a 429 rather than retrying into a shared rate limit', async () => {
    fetchSpy.mockResolvedValue(fakeJsonResponse(429, {}));

    expect(await fetchAnimeList()).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null for a GraphQL error, which arrives as HTTP 200', async () => {
    // An unknown username lands here, not on the status check — which is why
    // `response.ok` alone is not enough for a GraphQL endpoint.
    fetchSpy.mockResolvedValue(fakeJsonResponse(200, { errors: [{ message: 'User not found' }], data: null }));
    expect(await fetchAnimeList()).toBeNull();
  });

  it('returns null on a network error', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    expect(await fetchAnimeList()).toBeNull();
  });

  it('returns null on a timeout', async () => {
    fetchSpy.mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));
    expect(await fetchAnimeList()).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    fetchSpy.mockResolvedValue(fakeBrokenJsonResponse());
    expect(await fetchAnimeList()).toBeNull();
  });

  it('never throws, whatever comes back', async () => {
    for (const response of [fakeJsonResponse(403, {}), fakeBrokenJsonResponse(200), fakeJsonResponse(200, null)]) {
      fetchSpy.mockResolvedValueOnce(response);
      await expect(fetchAnimeList()).resolves.not.toThrow();
    }
  });
});

describe('fetchActivities', () => {
  it('returns null and never calls fetch with no username', async () => {
    vi.stubEnv('ANILIST_USERNAME', undefined);

    expect(await fetchActivities()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops at the last page', async () => {
    fetchSpy
      .mockResolvedValueOnce(fakeJsonResponse(200, activityBody(true, 1)))
      .mockResolvedValueOnce(fakeJsonResponse(200, activityBody(false, 2)));

    const activities = await fetchActivities();
    expect(activities).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null when the FIRST page fails — nothing was reachable', async () => {
    fetchSpy.mockResolvedValue(fakeJsonResponse(500, {}));
    expect(await fetchActivities()).toBeNull();
  });

  it('keeps a PARTIAL feed when a later page fails', async () => {
    // Different trade from the library: a partial log is genuinely useful and
    // the unique index on anilist_activity_id means the next sync fills the
    // gap. A partial library would look like shows had been deleted.
    fetchSpy
      .mockResolvedValueOnce(fakeJsonResponse(200, activityBody(true, 1)))
      .mockResolvedValueOnce(fakeJsonResponse(503, {}));

    const activities = await fetchActivities();
    expect(activities).toHaveLength(1);
  });

  it('stops at the page cap even if hasNextPage never goes false', async () => {
    // A feed that always claims another page must not become an infinite walk.
    fetchSpy.mockResolvedValue(fakeJsonResponse(200, activityBody(true, 9)));

    const activities = await fetchActivities(3);
    expect(activities).toHaveLength(3);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('stops immediately on an unexpected shape rather than looping', async () => {
    fetchSpy.mockResolvedValue(fakeJsonResponse(200, { data: { Page: {} } }));

    expect(await fetchActivities()).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
