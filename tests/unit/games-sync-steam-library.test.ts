import { describe, expect, it } from 'vitest';

import {
  buildReport,
  computeSteamDiffs,
  formatSteamFillList,
  isLocalDatabaseUrl,
  parseArgs,
} from '../../scripts/sync-steam-library.mjs';

/**
 * These test the one-off Steam sync script's pure helpers — CLI parsing,
 * diffing, fill-list formatting, report shape, and the local-database guard.
 * The network- and database-touching parts of the script (`main`) are
 * exercised manually against the owner's real Steam account, not here —
 * same split games-backfill-metadata.test.ts uses against
 * backfill-game-metadata.mjs.
 *
 * Every title/appid below is invented for the test, never a real title or
 * account from the owner's library.
 */

describe('isLocalDatabaseUrl', () => {
  it('accepts localhost, loopback IPv4, and both bracketed and bare loopback IPv6', () => {
    expect(isLocalDatabaseUrl('postgres://user:pass@localhost:5432/db')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://user:pass@127.0.0.1:5432/db')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://user:pass@[::1]:5432/db')).toBe(true);
  });

  it('rejects a remote host', () => {
    expect(isLocalDatabaseUrl('postgres://user:pass@db.supabase.co:5432/db')).toBe(false);
  });

  it('fails closed on an unparsable string rather than treating it as local', () => {
    expect(isLocalDatabaseUrl('not a url')).toBe(false);
  });
});

describe('parseArgs', () => {
  const argv0and1 = ['node', 'scripts/sync-steam-library.mjs'];

  it('parses the owner email with no flags, defaulting apply and overwriteHours to false', () => {
    expect(parseArgs([...argv0and1, 'owner@example.com'])).toEqual({
      ownerEmail: 'owner@example.com',
      apply: false,
      overwriteHours: false,
      reportPath: undefined,
    });
  });

  it('recognises --apply and --overwrite-hours independently, in any position', () => {
    expect(parseArgs([...argv0and1, '--apply', 'owner@example.com'])).toMatchObject({
      ownerEmail: 'owner@example.com',
      apply: true,
      overwriteHours: false,
    });
    expect(parseArgs([...argv0and1, 'owner@example.com', '--overwrite-hours'])).toMatchObject({
      ownerEmail: 'owner@example.com',
      apply: false,
      overwriteHours: true,
    });
    expect(parseArgs([...argv0and1, '--apply', '--overwrite-hours', 'owner@example.com'])).toMatchObject({
      apply: true,
      overwriteHours: true,
    });
  });

  it('reads the value following --report as the report path', () => {
    expect(parseArgs([...argv0and1, 'owner@example.com', '--report', '/tmp/out.txt'])).toMatchObject({
      ownerEmail: 'owner@example.com',
      reportPath: '/tmp/out.txt',
    });
  });

  it('leaves ownerEmail undefined when no positional argument is given', () => {
    expect(parseArgs([...argv0and1, '--apply']).ownerEmail).toBeUndefined();
  });
});

describe('computeSteamDiffs', () => {
  const FULLY_EMPTY = { achievementsUnlocked: null, achievementsTotal: null, hoursTenths: null };

  it('reports no diffs when nothing is stored yet', () => {
    expect(computeSteamDiffs(FULLY_EMPTY, { unlocked: 5, total: 10 }, 200)).toEqual({});
  });

  it('reports no diffs when stored values match Steam exactly', () => {
    const current = { achievementsUnlocked: 5, achievementsTotal: 10, hoursTenths: 200 };
    expect(computeSteamDiffs(current, { unlocked: 5, total: 10 }, 200)).toEqual({});
  });

  it('reports a diff for each column that disagrees, independently', () => {
    const current = { achievementsUnlocked: 5, achievementsTotal: 10, hoursTenths: 200 };
    expect(computeSteamDiffs(current, { unlocked: 8, total: 12 }, 350)).toEqual({
      achievementsUnlocked: { stored: 5, steam: 8 },
      achievementsTotal: { stored: 10, steam: 12 },
      hoursTenths: { stored: 200, steam: 350 },
    });
  });

  it('never reports a diff when Steam data is unavailable, even if stored values exist', () => {
    const current = { achievementsUnlocked: 5, achievementsTotal: 10, hoursTenths: 200 };
    expect(computeSteamDiffs(current, null, null)).toEqual({});
  });

  it('reports only the hours diff when achievements data is unavailable', () => {
    const current = { achievementsUnlocked: 5, achievementsTotal: 10, hoursTenths: 200 };
    expect(computeSteamDiffs(current, null, 350)).toEqual({ hoursTenths: { stored: 200, steam: 350 } });
  });
});

describe('formatSteamFillList', () => {
  it('lists every present field in a fixed, readable order, with a human-readable hours figure', () => {
    expect(
      formatSteamFillList({ steamAppid: 1_091_500, achievementsTotal: 45, achievementsUnlocked: 20, hoursTenths: 235 }),
    ).toBe('steam_appid, achievements_total, achievements_unlocked, hours_tenths (23.5h)');
  });

  it('lists only the fields actually present', () => {
    expect(formatSteamFillList({ achievementsTotal: 10 })).toBe('achievements_total');
  });

  it('reports nothing-to-fill for an empty object rather than an empty string', () => {
    expect(formatSteamFillList({})).toBe('(nothing new to fill)');
  });

  it('drops the decimal from hours_tenths when it is a whole number of hours', () => {
    expect(formatSteamFillList({ hoursTenths: 100 })).toBe('hours_tenths (10h)');
  });
});

const ALREADY_MATCHED = {
  id: 'game-1',
  title: 'Cyberpunk 2077',
  matchKind: 'already-matched',
  matchedAppid: 1_091_500,
  matchedSteamName: 'Cyberpunk 2077',
  score: 0,
  achievements: { unlocked: 20, total: 45 },
  achievementsError: undefined,
  fill: { achievementsTotal: 45, achievementsUnlocked: 20 },
  diffs: {},
  hoursTenthsFromSteam: 720,
};

const NEW_HIGH = {
  id: 'game-2',
  title: 'Portal 2',
  matchKind: 'high',
  matchedAppid: 620,
  matchedSteamName: 'Portal 2',
  score: 0,
  achievements: { unlocked: 10, total: 51 },
  achievementsError: undefined,
  fill: { steamAppid: 620, achievementsTotal: 51, achievementsUnlocked: 10, hoursTenths: 80 },
  diffs: {},
  hoursTenthsFromSteam: 80,
};

const NEW_LOW = {
  id: 'game-3',
  title: 'Vice City',
  matchKind: 'low',
  matchedAppid: null,
  matchedSteamName: 'Grand Theft Auto: Vice City Ultimate',
  score: 0.32,
  achievements: null,
  achievementsError: undefined,
  fill: {},
  diffs: {},
  hoursTenthsFromSteam: null,
};

const UNMATCHED = {
  id: 'game-4',
  title: 'An Obscure Import',
  matchKind: 'no-candidates',
  matchedAppid: null,
  matchedSteamName: null,
  score: 0,
  achievements: null,
  achievementsError: undefined,
  fill: {},
  diffs: {},
  hoursTenthsFromSteam: null,
};

const DIFFERS = {
  id: 'game-5',
  title: 'The Witcher 3',
  matchKind: 'already-matched',
  matchedAppid: 292_030,
  matchedSteamName: 'The Witcher 3: Wild Hunt',
  score: 0,
  achievements: { unlocked: 40, total: 78 },
  achievementsError: undefined,
  fill: {},
  diffs: { hoursTenths: { stored: 500, steam: 1_360 } },
  hoursTenthsFromSteam: 1_360,
};

describe('buildReport', () => {
  const baseArgs = {
    steamOnlyGames: [],
    ownedGamesFetchError: undefined,
    ownedGamesCount: 5,
    apply: false,
    overwriteHours: false,
    appliedCount: 0,
    hoursOverwrittenCount: 0,
  };

  it('puts the Steam-only and needs-review sections before the matched section', () => {
    const report = buildReport({ ...baseArgs, results: [ALREADY_MATCHED, NEW_LOW, UNMATCHED] });

    const steamOnlyIndex = report.indexOf('STEAM-OWNED GAMES WITH NO LIBRARY ROW');
    const reviewIndex = report.indexOf('NEEDS YOUR REVIEW');
    const matchedIndex = report.indexOf('MATCHED —');
    expect(steamOnlyIndex).toBeGreaterThanOrEqual(0);
    expect(reviewIndex).toBeGreaterThan(steamOnlyIndex);
    expect(matchedIndex).toBeGreaterThan(reviewIndex);
  });

  it('includes the summary counts', () => {
    const report = buildReport({ ...baseArgs, results: [ALREADY_MATCHED, NEW_HIGH, NEW_LOW, UNMATCHED] });
    expect(report).toContain('Already matched (steam_appid on file):  1');
    expect(report).toContain('Newly matched — high confidence:        1');
    expect(report).toContain('Newly matched — low confidence:         1 (never auto-applied)');
    expect(report).toContain('Unmatched (no Steam candidate found):   1');
  });

  it('lists Steam-owned games with no library row, and marks them never imported', () => {
    const report = buildReport({
      ...baseArgs,
      results: [],
      steamOnlyGames: [{ appid: 730, name: 'Counter-Strike 2', playtimeMinutes: 600 }],
    });
    expect(report).toContain('never imported');
    expect(report).toContain('"Counter-Strike 2" (appid 730, 10h)');
  });

  it('never overwrites achievements_unlocked/achievements_total — always reports "no overwrite flag exists"', () => {
    const differsAchievements = {
      ...DIFFERS,
      diffs: { achievementsUnlocked: { stored: 10, steam: 15 }, achievementsTotal: { stored: 40, steam: 45 } },
    };
    const report = buildReport({ ...baseArgs, results: [differsAchievements], apply: true });
    expect(report).toContain('achievements_unlocked: stored 10, Steam reports 15 — not overwritten');
    expect(report).toContain('achievements_total: stored 40, Steam reports 45 — not overwritten');
  });

  it('reports an hours diff as needing --overwrite-hours when the flag is off', () => {
    const report = buildReport({ ...baseArgs, results: [DIFFERS] });
    expect(report).toContain('pass --overwrite-hours (with --apply) to overwrite');
  });

  it('reports an hours diff as actually overwritten when --overwrite-hours and --apply were both used', () => {
    const report = buildReport({ ...baseArgs, results: [DIFFERS], apply: true, overwriteHours: true });
    expect(report).toContain('OVERWRITTEN this run');
  });

  it('reports an hours diff as "would be overwritten with --apply" for a dry run with --overwrite-hours set', () => {
    const report = buildReport({ ...baseArgs, results: [DIFFERS], apply: false, overwriteHours: true });
    expect(report).toContain('would be overwritten with --apply');
  });

  it('warns when the owned-games fetch itself failed, distinct from a genuine zero-games response', () => {
    const report = buildReport({ ...baseArgs, results: [], ownedGamesFetchError: 'HTTP 500' });
    expect(report).toContain('fetching the Steam owned-games list failed: HTTP 500');
  });

  it('warns about a likely private profile when Steam returns zero games with no fetch error', () => {
    const report = buildReport({ ...baseArgs, results: [], ownedGamesCount: 0 });
    expect(report).toContain('Steam returned 0 owned games');
  });
});
