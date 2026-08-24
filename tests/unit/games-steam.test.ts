import { describe, expect, it } from 'vitest';

import {
  bestSteamTitleMatch,
  buildAchievementsUrl,
  buildOwnedGamesUrl,
  toAchievementCounts,
  toOwnedGames,
  type OwnedSteamGame,
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
    expect(url).toContain('https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?');
    expect(url).toContain('appid=1091500');
    expect(url).toContain('key=KEY123');
    expect(url).toContain('steamid=76561198000000000');
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
      { appid: 1_091_500, name: 'Cyberpunk 2077', playtimeMinutes: 720 },
      { appid: 620, name: 'Portal 2', playtimeMinutes: 0 },
    ]);
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

    expect(toOwnedGames(payload)).toEqual([{ appid: 730, name: 'Counter-Strike 2', playtimeMinutes: 50 }]);
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
      { appid: 730, name: 'Counter-Strike 2', playtimeMinutes: 0 },
      { appid: 620, name: 'Portal 2', playtimeMinutes: 0 },
      { appid: 400, name: 'Portal', playtimeMinutes: 0 },
    ]);
  });

  it('skips a non-object entry inside the games array', () => {
    const payload = { response: { games: [null, 42, 'garbage', { appid: 620, name: 'Portal 2' }] } };
    expect(toOwnedGames(payload)).toEqual([{ appid: 620, name: 'Portal 2', playtimeMinutes: 0 }]);
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

describe('bestSteamTitleMatch', () => {
  const candidates: OwnedSteamGame[] = [
    { appid: 1, name: 'Grand Theft Auto: Vice City', playtimeMinutes: 100 },
    { appid: 2, name: 'Grand Theft Auto: San Andreas', playtimeMinutes: 200 },
  ];

  it('finds an identical-after-normalization title as the best match', () => {
    const match = bestSteamTitleMatch('grand theft auto vice city', candidates);
    expect(match?.game.appid).toBe(1);
    expect(match?.score.confidence).toBe('high');
  });

  it('matches after stripping a trailing parenthetical from the stored title', () => {
    const match = bestSteamTitleMatch('Grand Theft Auto: Vice City (itch)', candidates);
    expect(match?.game.appid).toBe(1);
    expect(match?.score.confidence).toBe('high');
  });

  it('reports LOW confidence for a close-but-not-identical title, never auto-promoted to high', () => {
    const match = bestSteamTitleMatch('Grand Theft Auto Vice City HD', candidates);
    expect(match?.game.appid).toBe(1);
    expect(match?.score.confidence).toBe('low');
  });

  it('returns null for an empty candidate list', () => {
    expect(bestSteamTitleMatch('Anything', [])).toBeNull();
  });
});
