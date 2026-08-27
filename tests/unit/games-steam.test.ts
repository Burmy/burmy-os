import { describe, expect, it } from 'vitest';

import {
  buildAchievementsUrl,
  buildOwnedGamesUrl,
  buildResolveVanityUrl,
  isSteamId64,
  steamSyncFieldsToFill,
  toAchievementCounts,
  buildGlobalRarityUrl,
  toAchievements,
  toGlobalRarity,
  toOwnedGames,
  toResolvedVanityUrl,
} from '@/server/games/steam';

describe('buildOwnedGamesUrl', () => {
  it('targets IPlayerService/GetOwnedGames/v1 with the key, steamid, and both include flags', () => {
    const url = buildOwnedGamesUrl('KEY123', '76561198000000000');
    expect(url).toContain('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?');
    expect(url).toContain('key=KEY123');
    expect(url).toContain('steamid=76561198000000000');
    expect(url).toContain('include_appinfo=1');
    expect(url).toContain('include_played_free_games=1');
  });
});

describe('buildAchievementsUrl', () => {
  it('targets ISteamUserStats/GetPlayerAchievements/v1 with appid, key, and steamid', () => {
    const url = buildAchievementsUrl('KEY123', '76561198000000000', 1_091_500);
    expect(url).toContain(
      'https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?',
    );
    expect(url).toContain('appid=1091500');
    expect(url).toContain('key=KEY123');
    expect(url).toContain('steamid=76561198000000000');
  });
});

describe('buildResolveVanityUrl', () => {
  it('targets ISteamUser/ResolveVanityURL/v1 with the key and vanityurl', () => {
    const url = buildResolveVanityUrl('KEY123', 'burmyyy');
    expect(url).toContain('https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?');
    expect(url).toContain('key=KEY123');
    expect(url).toContain('vanityurl=burmyyy');
  });
});

describe('isSteamId64', () => {
  it('accepts a 17-digit numeric string', () => {
    expect(isSteamId64('76561198263587821')).toBe(true);
  });

  it('rejects a vanity name', () => {
    expect(isSteamId64('burmyyy')).toBe(false);
  });

  it('rejects a numeric string of the wrong length', () => {
    expect(isSteamId64('7656119826358782')).toBe(false); // 16 digits
    expect(isSteamId64('765611982635878212')).toBe(false); // 18 digits
  });

  it('rejects an empty string', () => {
    expect(isSteamId64('')).toBe(false);
  });
});

describe('toResolvedVanityUrl', () => {
  it('resolves a successful response to its steamid', () => {
    const payload = { response: { steamid: '76561198263587821', success: 1 } };
    expect(toResolvedVanityUrl(payload)).toEqual({ steamId: '76561198263587821' });
  });

  it('returns null for success: 42 — Steam\'s documented "no match" code', () => {
    const payload = { response: { success: 42, message: 'No match' } };
    expect(toResolvedVanityUrl(payload)).toBeNull();
  });

  it('returns null for a missing response key, null, or a non-object payload', () => {
    expect(toResolvedVanityUrl({})).toBeNull();
    expect(toResolvedVanityUrl(null)).toBeNull();
    expect(toResolvedVanityUrl('not an object')).toBeNull();
    expect(toResolvedVanityUrl(undefined)).toBeNull();
  });

  it('returns null when success is 1 but steamid is missing or not a string', () => {
    expect(toResolvedVanityUrl({ response: { success: 1 } })).toBeNull();
    expect(toResolvedVanityUrl({ response: { success: 1, steamid: 12345 } })).toBeNull();
    expect(toResolvedVanityUrl({ response: { success: 1, steamid: '' } })).toBeNull();
  });
});

describe('toOwnedGames', () => {
  it('shapes a well-formed GetOwnedGames response', () => {
    const payload = {
      response: {
        game_count: 2,
        games: [
          { appid: 1_091_500, name: 'Cyberpunk 2077', playtime_forever: 720 },
          { appid: 620, name: 'Portal 2', playtime_forever: 0 },
        ],
      },
    };

    expect(toOwnedGames(payload)).toEqual([
      { appid: 1_091_500, name: 'Cyberpunk 2077', playtimeMinutes: 720, lastPlayedAt: null },
      { appid: 620, name: 'Portal 2', playtimeMinutes: 0, lastPlayedAt: null },
    ]);
  });

  /**
   * `rtime_last_played` is Unix SECONDS and was in this response all along —
   * `buildOwnedGamesUrl` already sets `include_appinfo=1`. The parser just
   * never read it until the library needed to sort PSN and Steam games
   * together by recency.
   */
  it('maps rtime_last_played into an ISO lastPlayedAt', () => {
    const payload = {
      response: { games: [{ appid: 620, name: 'Portal 2', playtime_forever: 720, rtime_last_played: 1_756_252_800 }] },
    };

    expect(toOwnedGames(payload)[0]?.lastPlayedAt).toBe('2025-08-27T00:00:00.000Z');
  });

  /**
   * Steam sends `0` for a game you own but have never launched. Reading that
   * as a real timestamp would date it to 1970 and rank it BELOW every game
   * with no date at all, which is the opposite of what `nulls last` in
   * `listGames`'s ordering is there to achieve.
   */
  it('treats rtime_last_played 0 as never-played, not as 1970', () => {
    const payload = {
      response: { games: [{ appid: 620, name: 'Portal 2', playtime_forever: 0, rtime_last_played: 0 }] },
    };

    expect(toOwnedGames(payload)[0]?.lastPlayedAt).toBeNull();
  });

  it('leaves lastPlayedAt null when rtime_last_played is absent or malformed', () => {
    const payload = {
      response: {
        games: [
          { appid: 620, name: 'Portal 2', playtime_forever: 10 },
          { appid: 730, name: 'CS2', playtime_forever: 10, rtime_last_played: 'yesterday' },
        ],
      },
    };

    expect(toOwnedGames(payload).map((g) => g.lastPlayedAt)).toEqual([null, null]);
  });

  it('returns [] for a private-profile response with no games key at all', () => {
    expect(toOwnedGames({ response: {} })).toEqual([]);
  });

  it('returns [] for a missing response key, null, or a non-object payload', () => {
    expect(toOwnedGames({})).toEqual([]);
    expect(toOwnedGames(null)).toEqual([]);
    expect(toOwnedGames('not an object')).toEqual([]);
    expect(toOwnedGames(undefined)).toEqual([]);
  });

  it('skips an entry missing appid or name rather than throwing', () => {
    const payload = {
      response: {
        games: [
          { name: 'No appid', playtime_forever: 10 },
          { appid: 620, playtime_forever: 10 },
          { appid: 730, name: 'Counter-Strike 2', playtime_forever: 50 },
        ],
      },
    };

    expect(toOwnedGames(payload)).toEqual([
      { appid: 730, name: 'Counter-Strike 2', playtimeMinutes: 50, lastPlayedAt: null },
    ]);
  });

  it('defaults a missing or malformed playtime_forever to 0 rather than dropping the game', () => {
    const payload = {
      response: {
        games: [
          { appid: 730, name: 'Counter-Strike 2' },
          { appid: 620, name: 'Portal 2', playtime_forever: 'not a number' },
          { appid: 400, name: 'Portal', playtime_forever: -5 },
        ],
      },
    };

    expect(toOwnedGames(payload)).toEqual([
      { appid: 730, name: 'Counter-Strike 2', playtimeMinutes: 0, lastPlayedAt: null },
      { appid: 620, name: 'Portal 2', playtimeMinutes: 0, lastPlayedAt: null },
      { appid: 400, name: 'Portal', playtimeMinutes: 0, lastPlayedAt: null },
    ]);
  });

  it('skips a non-object entry inside the games array', () => {
    const payload = {
      response: { games: [null, 42, 'garbage', { appid: 620, name: 'Portal 2' }] },
    };
    expect(toOwnedGames(payload)).toEqual([{ appid: 620, name: 'Portal 2', playtimeMinutes: 0, lastPlayedAt: null }]);
  });
});

describe('toAchievementCounts', () => {
  it('counts achieved vs total from a well-formed response', () => {
    const payload = {
      playerstats: {
        success: true,
        achievements: [
          { apiname: 'ACH_1', achieved: 1 },
          { apiname: 'ACH_2', achieved: 0 },
          { apiname: 'ACH_3', achieved: 1 },
        ],
      },
    };

    expect(toAchievementCounts(payload)).toEqual({ unlocked: 2, total: 3 });
  });

  it('returns null for the error-shaped body Steam sends for a no-achievements game (never zero)', () => {
    const payload = { playerstats: { success: false, error: 'Requested app has no stats' } };
    expect(toAchievementCounts(payload)).toBeNull();
  });

  it('returns null when playerstats or achievements is missing entirely', () => {
    expect(toAchievementCounts({})).toBeNull();
    expect(toAchievementCounts({ playerstats: {} })).toBeNull();
    expect(toAchievementCounts({ playerstats: { success: true } })).toBeNull();
    expect(toAchievementCounts(null)).toBeNull();
  });

  it('returns null for an empty achievements array even if success is true', () => {
    expect(toAchievementCounts({ playerstats: { success: true, achievements: [] } })).toBeNull();
  });

  it('accepts a boolean achieved flag defensively, in addition to the documented 1/0', () => {
    const payload = {
      playerstats: {
        success: true,
        achievements: [
          { apiname: 'ACH_1', achieved: true },
          { apiname: 'ACH_2', achieved: false },
        ],
      },
    };

    expect(toAchievementCounts(payload)).toEqual({ unlocked: 1, total: 2 });
  });

  it('skips a non-object entry inside achievements without throwing', () => {
    const payload = { playerstats: { success: true, achievements: [null, { achieved: 1 }] } };
    expect(toAchievementCounts(payload)).toEqual({ unlocked: 1, total: 2 });
  });
});

const FULLY_EMPTY = {
  steamAppid: null,
  achievementsUnlocked: null,
  achievementsTotal: null,
  hoursTenths: null,
  lastPlayedAt: null,
};

describe('steamSyncFieldsToFill', () => {
  it('fills every column when all are currently null and Steam data is available', () => {
    expect(
      steamSyncFieldsToFill(FULLY_EMPTY, 1_091_500, { unlocked: 20, total: 45 }, 1_360),
    ).toEqual({
      steamAppid: 1_091_500,
      achievementsUnlocked: 20,
      achievementsTotal: 45,
      hoursTenths: 1_360,
    });
  });

  it('never fills a column that already holds a value, even when Steam disagrees', () => {
    const current = {
      steamAppid: 999,
      achievementsUnlocked: 10,
      achievementsTotal: 40,
      hoursTenths: 500,
      lastPlayedAt: null,
    };
    expect(steamSyncFieldsToFill(current, 1_091_500, { unlocked: 20, total: 45 }, 1_360)).toEqual(
      {},
    );
  });

  it('fills only the columns that are null, leaving already-set columns untouched', () => {
    const current = {
      steamAppid: 1_091_500,
      achievementsUnlocked: null,
      achievementsTotal: null,
      hoursTenths: 500,
      lastPlayedAt: null,
    };
    expect(steamSyncFieldsToFill(current, 1_091_500, { unlocked: 20, total: 45 }, 1_360)).toEqual({
      achievementsUnlocked: 20,
      achievementsTotal: 45,
    });
  });

  it('fills nothing when no Steam data is available at all', () => {
    expect(steamSyncFieldsToFill(FULLY_EMPTY, null, null, null)).toEqual({});
  });

  it('fills steamAppid alone when only a match was found, no achievements or playtime yet', () => {
    expect(steamSyncFieldsToFill(FULLY_EMPTY, 1_091_500, null, null)).toEqual({
      steamAppid: 1_091_500,
    });
  });
});

/**
 * The detail parser behind persisted Steam achievements. Same payload
 * `toAchievementCounts` reads — deliberately, so the stored count columns and
 * the stored rows can never observe different moments and drift apart.
 */
describe('toAchievements', () => {
  function payload(achievements: readonly unknown[]): unknown {
    return { playerstats: { success: true, achievements } };
  }

  it('maps name, description and unlock state from a real response shape', () => {
    const result = toAchievements(
      payload([
        { apiname: 'CHARMED', achieved: 1, unlocktime: 1_735_010_079, name: 'Charmed', description: 'Acquire your first Charm' },
      ]),
    );

    expect(result).toEqual([
      {
        apiname: 'CHARMED',
        name: 'Charmed',
        description: 'Acquire your first Charm',
        unlocked: true,
        unlockTime: 1_735_010_079,
      },
    ]);
  });

  /**
   * Steam sends an EMPTY STRING for a locked achievement's description, not a
   * missing key. Storing `''` would render as a blank line under the name and
   * read as "described as nothing" rather than "not revealed yet".
   */
  it('normalizes empty name/description strings to null', () => {
    const result = toAchievements(payload([{ apiname: 'ZOTE', achieved: 0, unlocktime: 0, name: 'Rivalry', description: '' }]));

    expect(result?.[0]?.description).toBeNull();
    expect(result?.[0]?.unlocked).toBe(false);
    expect(result?.[0]?.unlockTime).toBe(0);
  });

  it('skips an entry with no usable apiname rather than throwing', () => {
    const result = toAchievements(payload([{ achieved: 1 }, { apiname: '', achieved: 1 }, { apiname: 'OK', achieved: 1 }]));
    expect(result?.map((a) => a.apiname)).toEqual(['OK']);
  });

  /**
   * `null`, not `[]`, and identical to `toAchievementCounts`: "this game
   * defines no achievements" and "Steam did not answer" are different facts,
   * and only the first should ever overwrite what is already stored.
   */
  it('returns null for a failed or empty response, never an empty array', () => {
    expect(toAchievements({ playerstats: { success: false } })).toBeNull();
    expect(toAchievements(payload([]))).toBeNull();
    expect(toAchievements(null)).toBeNull();
  });
});

describe('toGlobalRarity', () => {
  it('keys by apiname, which Steam confusingly labels "name"', () => {
    // Verified against the live endpoint: the `name` field holds the API key
    // (`CHARMED`), not the display name.
    const map = toGlobalRarity({
      achievementpercentages: { achievements: [{ name: 'CHARMED', percent: '76.8' }, { name: 'ZOTE', percent: 4.1 }] },
    });

    expect(map.get('CHARMED')).toBe('76.8');
    expect(map.get('ZOTE')).toBe('4.1');
  });

  /**
   * An empty map, never a throw: rarity is enrichment, and a game whose global
   * stats are unavailable must still get its achievements stored with a null
   * rarity rather than failing the whole sync for that game.
   */
  it('returns an empty map for any unusable payload', () => {
    expect(toGlobalRarity(null).size).toBe(0);
    expect(toGlobalRarity({}).size).toBe(0);
    expect(toGlobalRarity({ achievementpercentages: {} }).size).toBe(0);
  });
});

describe('buildGlobalRarityUrl', () => {
  it('targets the v2 global-percentages endpoint with the gameid', () => {
    expect(buildGlobalRarityUrl(367_520)).toBe(
      'https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=367520',
    );
  });
});
