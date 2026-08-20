import { afterEach, describe, expect, it, vi } from 'vitest';

import { searchGames } from '@/server/db/games/rawg';

/**
 * `searchGames` must fail SOFT in every case — a missing key, a network
 * error, a timeout, a non-200, or a malformed body all resolve to `[]`,
 * never a thrown error. That contract is what lets the owner add a game with
 * no RAWG key configured and no network at all (see `metadata.ts`'s header).
 *
 * `restoreMocks: true` (vitest.config.ts) resets `vi.fn()` call state between
 * tests, but does NOT undo `vi.stubEnv`/`vi.stubGlobal` — those are unwound
 * explicitly here so one test's fake `fetch` or fake API key can never leak
 * into the next.
 */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function fakeJsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

const RAWG_PAYLOAD = {
  results: [
    {
      id: 1,
      name: 'Elden Ring',
      background_image: 'https://media.rawg.io/elden.jpg',
      released: '2022-02-25',
      genres: [{ name: 'Action' }, { name: 'RPG' }],
      developers: [{ name: 'FromSoftware' }],
      publishers: [{ name: 'Bandai Namco' }],
    },
  ],
};

describe('searchGames', () => {
  it('returns [] when RAWG_API_KEY is unset', async () => {
    vi.stubEnv('RAWG_API_KEY', undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await searchGames('Elden Ring')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns [] when RAWG_API_KEY is the empty string', async () => {
    vi.stubEnv('RAWG_API_KEY', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await searchGames('Elden Ring')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns [] for an empty or whitespace-only query without calling fetch', async () => {
    vi.stubEnv('RAWG_API_KEY', 'fake-key');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await searchGames('')).toEqual([]);
    expect(await searchGames('   ')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns [] when fetch rejects with a network error', async () => {
    vi.stubEnv('RAWG_API_KEY', 'fake-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    expect(await searchGames('Elden Ring')).toEqual([]);
  });

  it('returns [] when fetch rejects with an abort/timeout-shaped error', async () => {
    vi.stubEnv('RAWG_API_KEY', 'fake-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }),
    );

    expect(await searchGames('Elden Ring')).toEqual([]);
  });

  it('returns [] on a non-200 response', async () => {
    vi.stubEnv('RAWG_API_KEY', 'fake-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }) as unknown as Response),
    );

    expect(await searchGames('Elden Ring')).toEqual([]);
  });

  it('returns [] when a 200 response body fails to parse as JSON', async () => {
    // Guards the extent of the `try` block in searchGames: it must wrap
    // `response.json()`, not just the `fetch` call itself, or a malformed
    // body would throw instead of degrading to [].
    vi.stubEnv('RAWG_API_KEY', 'fake-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      })) as unknown as typeof fetch,
    );

    expect(await searchGames('Elden Ring')).toEqual([]);
  });

  it('maps a well-formed 200 response through to real suggestions', async () => {
    vi.stubEnv('RAWG_API_KEY', 'fake-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeJsonResponse(RAWG_PAYLOAD)),
    );

    expect(await searchGames('Elden Ring')).toEqual([
      {
        externalId: '1',
        title: 'Elden Ring',
        coverUrl: 'https://media.rawg.io/elden.jpg',
        genre: 'Action, RPG',
        developer: 'FromSoftware',
        publisher: 'Bandai Namco',
      },
    ]);
  });
});
