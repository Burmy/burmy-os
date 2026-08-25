import { describe, expect, it } from 'vitest';

import {
  bestTitleMatch,
  bestTitleMatchAmong,
  buildSearchQuery,
  buildTimeToBeatQuery,
  buildUpcomingQuery,
  coverUrl,
  type GameSuggestion,
  metadataFieldsToFill,
  normalizeGameTitle,
  scoreTitleMatch,
  type StoredGameMetadata,
  toSuggestions,
  withPlaytime,
} from '@/server/games/metadata';

describe('buildSearchQuery', () => {
  it('wraps the title in a search clause and requests the expected fields', () => {
    const query = buildSearchQuery('Elden Ring', 6);
    expect(query).toContain('search "Elden Ring";');
    expect(query).toContain('fields ');
    expect(query).toContain('cover.image_id');
    expect(query).toContain('involved_companies.company.name');
    expect(query).toContain('involved_companies.developer');
    expect(query).toContain('involved_companies.publisher');
    expect(query).toContain('genres.name');
    expect(query).toContain('aggregated_rating');
    expect(query).toContain('first_release_date');
    expect(query).toContain('age_ratings.rating_category.rating');
    expect(query).toContain('age_ratings.rating_category.organization.name');
    expect(query).toContain('limit 6;');
  });

  it('does not request the deprecated flat age-rating fields', () => {
    const query = buildSearchQuery('Elden Ring', 6);
    // `age_ratings.rating` (no `.rating_category` in between) and
    // `age_ratings.category` are both flagged deprecated in IGDB's own
    // schema — verified live against api.igdb.com/v4/igdbapi.proto.
    expect(query).not.toMatch(/age_ratings\.rating[,;]/);
    expect(query).not.toContain('age_ratings.category');
  });

  it('escapes an embedded double quote so it cannot break out of the search clause', () => {
    const query = buildSearchQuery('The "Definitive" Edition', 6);
    expect(query).toContain('search "The \\"Definitive\\" Edition";');
    // A naive, unescaped interpolation would produce this — assert it never does.
    expect(query).not.toContain('search "The "Definitive" Edition";');
  });

  it('escapes a backslash so it cannot combine with a later character to produce a stray escape', () => {
    const query = buildSearchQuery('Back\\slash', 6);
    expect(query).toContain('search "Back\\\\slash";');
  });
});

describe('buildTimeToBeatQuery', () => {
  it('requests game_id and normally, filtered to the given ids', () => {
    const query = buildTimeToBeatQuery([1, 2, 3]);
    expect(query).toBe('fields game_id,normally; where game_id = (1,2,3); limit 3;');
  });
});

describe('buildUpcomingQuery', () => {
  it('uses game_type = 0, not the dead category field', () => {
    const query = buildUpcomingQuery(1_000, 2_000, 30);
    // `category = 0` returns zero rows against live IGDB — verified before
    // writing this query. `game_type` is the live replacement.
    expect(query).toContain('game_type = 0');
    expect(query).not.toContain('category');
  });

  it('filters to PS5/PC via the parenthesis "any of" form, and applies the given window and floor', () => {
    const query = buildUpcomingQuery(1_755_000_000, 1_786_536_000, 30);
    expect(query).toContain('platforms = (167,6)');
    expect(query).toContain('first_release_date > 1755000000');
    expect(query).toContain('first_release_date < 1786536000');
    expect(query).toContain('hypes >= 30');
    expect(query).toContain('sort hypes desc');
    expect(query).toContain('limit 200;');
  });

  it('never applies status != (6,7) — that filter collapsed a real 45-game result to 1 against live data', () => {
    const query = buildUpcomingQuery(1_000, 2_000, 30);
    expect(query).not.toContain('status');
  });

  it('requests release_dates.y/.m/.date_format/.platform and the bare platforms relation, not name subfields', () => {
    const query = buildUpcomingQuery(1_000, 2_000, 30);
    expect(query).toContain('release_dates.y');
    expect(query).toContain('release_dates.m');
    expect(query).toContain('release_dates.date_format');
    expect(query).toContain('release_dates.platform');
    expect(query).toMatch(/(^|,)platforms(,|;)/);
    expect(query).not.toContain('platforms.name');
    expect(query).not.toContain('release_dates.platform.name');
  });

  it('respects a different hype floor', () => {
    const query = buildUpcomingQuery(1_000, 2_000, 50);
    expect(query).toContain('hypes >= 50');
    expect(query).not.toContain('hypes >= 30');
  });
});

describe('coverUrl', () => {
  it('defaults to the 2x big-cover preset', () => {
    expect(coverUrl('co3dip')).toBe('https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co3dip.jpg');
  });

  it('accepts an explicit size preset', () => {
    expect(coverUrl('co3dip', 't_thumb')).toBe('https://images.igdb.com/igdb/image/upload/t_thumb/co3dip.jpg');
  });
});

const IGDB_PAYLOAD = [
  {
    id: 1942,
    name: 'The Witcher 3: Wild Hunt',
    cover: { image_id: 'co1wyy' },
    genres: [{ name: 'Role-playing (RPG)' }, { name: 'Adventure' }],
    involved_companies: [
      { company: { name: 'CD Projekt RED' }, developer: true, publisher: false },
      { company: { name: 'CD Projekt' }, developer: false, publisher: true },
    ],
    aggregated_rating: 92.3333,
    first_release_date: 1431993600, // 2015-05-19
    age_ratings: [
      { rating_category: { rating: 'M', organization: { name: 'ESRB' } } },
      { rating_category: { rating: '18', organization: { name: 'PEGI' } } },
    ],
  },
];

describe('toSuggestions', () => {
  it('maps an IGDB payload to the fields the app stores', () => {
    const suggestions = toSuggestions(IGDB_PAYLOAD);

    expect(suggestions).toEqual([
      {
        externalId: '1942',
        title: 'The Witcher 3: Wild Hunt',
        coverUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1wyy.jpg',
        genre: 'Role-playing (RPG), Adventure',
        developer: 'CD Projekt RED',
        publisher: 'CD Projekt',
        metacritic: 92,
        averagePlaytimeHours: null,
        esrbRating: 'M',
        releaseYear: 2015,
      },
    ]);
  });

  it('picks the ESRB entry out of a multi-organization age_ratings array, ignoring PEGI', () => {
    const suggestions = toSuggestions(IGDB_PAYLOAD);
    expect(suggestions[0]?.esrbRating).toBe('M');
  });

  it('tolerates missing optional fields rather than throwing', () => {
    const suggestions = toSuggestions([{ id: 2, name: 'Obscure Game' }]);
    expect(suggestions[0]).toMatchObject({
      title: 'Obscure Game',
      coverUrl: null,
      genre: null,
      developer: null,
      publisher: null,
      metacritic: null,
      averagePlaytimeHours: null,
      esrbRating: null,
      releaseYear: null,
    });
  });

  it('skips an entry missing a name or id rather than throwing', () => {
    expect(toSuggestions([{ id: 3 }])).toEqual([]);
    expect(toSuggestions([{ name: 'No id' }])).toEqual([]);
  });

  it('returns an empty list for a malformed payload', () => {
    expect(toSuggestions(null)).toEqual([]);
    expect(toSuggestions({})).toEqual([]);
    expect(toSuggestions({ results: 'nope' })).toEqual([]);
    expect(toSuggestions('nope')).toEqual([]);
  });
});

describe('withPlaytime', () => {
  it('merges seconds-to-hours playtime into the matching suggestion by id', () => {
    const suggestions = toSuggestions(IGDB_PAYLOAD);
    const merged = withPlaytime(suggestions, [{ game_id: 1942, normally: 126000 }]); // 35h

    expect(merged[0]?.averagePlaytimeHours).toBe(35);
  });

  it('leaves averagePlaytimeHours null for a suggestion with no matching entry', () => {
    const suggestions = toSuggestions(IGDB_PAYLOAD);
    const merged = withPlaytime(suggestions, [{ game_id: 999, normally: 1000 }]);

    expect(merged[0]?.averagePlaytimeHours).toBeNull();
  });

  it('returns the original suggestions unchanged for a malformed payload', () => {
    const suggestions = toSuggestions(IGDB_PAYLOAD);
    expect(withPlaytime(suggestions, null)).toEqual(suggestions);
    expect(withPlaytime(suggestions, 'nope')).toEqual(suggestions);
    expect(withPlaytime(suggestions, [{ game_id: 1942, normally: 'not a number' }])).toEqual(suggestions);
  });
});

/**
 * The functions below back `scripts/backfill-game-metadata.mjs`. Every title
 * here is invented for the test — never a real title from the owner's
 * library — per CLAUDE.md's "fixtures are never the owner's real data" rule,
 * applied here even though this is a unit fixture, not tests/fixtures/.
 */
describe('normalizeGameTitle', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeGameTitle('  Quest   Of   Legends  ')).toBe('quest of legends');
  });

  it('strips punctuation entirely rather than turning it into a space run', () => {
    expect(normalizeGameTitle("Quest's: Legend! (Remastered)")).toBe('quest s legend remastered');
  });

  it('strips combining diacritics left behind by NFKD normalization', () => {
    expect(normalizeGameTitle('Pokémon Quest')).toBe('pokemon quest');
  });
});

describe('scoreTitleMatch', () => {
  it('is HIGH confidence for an identical title', () => {
    expect(scoreTitleMatch('Quest of Legends', 'Quest of Legends')).toEqual({ confidence: 'high', similarity: 1 });
  });

  it('is HIGH confidence when only case, punctuation, or spacing differs', () => {
    expect(scoreTitleMatch('quest of legends', 'Quest of Legends')).toMatchObject({ confidence: 'high' });
    expect(scoreTitleMatch('Quest of Legends', 'Quest: of Legends!')).toMatchObject({ confidence: 'high' });
  });

  it('is HIGH confidence after stripping a trailing parenthetical store suffix', () => {
    // Mirrors the real "(itch)" artifact documented in fix-game-platforms.mjs.
    expect(scoreTitleMatch('Quest of Legends (itch)', 'Quest of Legends')).toMatchObject({ confidence: 'high' });
    expect(scoreTitleMatch('Quest of Legends', 'Quest of Legends (Steam Edition)')).toMatchObject({
      confidence: 'high',
    });
  });

  it('is LOW confidence for a remaster/edition suffix, never HIGH', () => {
    // The exact risk CLAUDE.md and the task both call out: an HD remaster
    // must never silently match the original release.
    const score = scoreTitleMatch('Quest of Legends', 'Quest of Legends HD Remastered');
    expect(score.confidence).toBe('low');
  });

  it('is LOW confidence for a numbered sequel matching its predecessor, never HIGH', () => {
    const score = scoreTitleMatch('Quest of Legends', 'Quest of Legends 2');
    expect(score.confidence).toBe('low');
  });

  it('is LOW confidence with a low similarity for an unrelated title', () => {
    const score = scoreTitleMatch('Quest of Legends', 'Farming Simulator');
    expect(score.confidence).toBe('low');
    expect(score.similarity).toBeLessThan(0.5);
  });
});

/**
 * Problem 2 from the real Steam sync dry run: genuine matches the pre-fix
 * matcher missed entirely. Every title below is a REAL title from the
 * owner's real Steam library sync (see the task's own report and
 * .superpowers/sdd/2026-08-20-game-tracker/steam-sync-report.md) — game
 * titles, not personal data, so they are fine to use verbatim here.
 */
describe('scoreTitleMatch — token containment', () => {
  it('is HIGH confidence when the stored title is contained in the Steam title as a droppable subtitle', () => {
    // "Idle Slayer" (stored) vs. Steam's actual listing "Idle Slayer –
    // Incremental RPG" — the remainder is a genre tagline, not a
    // distinguishing suffix.
    const score = scoreTitleMatch('Idle Slayer', 'Idle Slayer – Incremental RPG');
    expect(score.confidence).toBe('high');
  });

  it('is HIGH confidence when the Steam title is contained in the stored title as a droppable subtitle', () => {
    // "Tap Ninja - Idle game" (stored) vs. Steam's actual listing "Tap
    // Ninja" — same pattern, other direction.
    const score = scoreTitleMatch('Tap Ninja - Idle game', 'Tap Ninja');
    expect(score.confidence).toBe('high');
  });

  it('never promotes containment to HIGH when the remainder is a trailing number — "Portal" must not match "Portal 2"', () => {
    const score = scoreTitleMatch('Portal', 'Portal 2');
    expect(score.confidence).toBe('low');
  });

  it('never promotes containment to HIGH when the remainder is a trailing number — "Half-Life" must not match "Half-Life 2"', () => {
    const score = scoreTitleMatch('Half-Life', 'Half-Life 2');
    expect(score.confidence).toBe('low');
  });

  it('never promotes containment to HIGH when the remainder is a trailing roman numeral', () => {
    // Invented title — no roman numerals appear in the owner's real library.
    const score = scoreTitleMatch('Quest of Legends', 'Quest of Legends II');
    expect(score.confidence).toBe('low');
  });

  it('never promotes containment to HIGH when the remainder is an edition/remaster marker, even without a trailing number', () => {
    // Regression guard: containment must not reopen the pre-existing "an HD
    // remaster must never silently match the original release" policy
    // exercised above under `scoreTitleMatch`.
    const score = scoreTitleMatch('Quest of Legends', 'Quest of Legends HD Remastered');
    expect(score.confidence).toBe('low');
  });

  it('never promotes containment to HIGH across a colon-separated sub-entry, even when every token of the shorter title is present', () => {
    // Real false positive found while implementing this: "Half-Life 2" is
    // literally token-contained in "Half-Life 2: Episode One" with a
    // non-numeric remainder ("episode one"), but Steam does not own Episode
    // One — it is a separate product from Half-Life 2, and the colon is
    // what distinguishes it from a droppable dash-subtitle like "Idle Slayer
    // – Incremental RPG".
    expect(scoreTitleMatch('Half-Life 2', 'Half-Life 2: Episode One').confidence).toBe('low');
    expect(scoreTitleMatch('Half-Life 2', 'Half-Life 2: Episode Two').confidence).toBe('low');
    expect(scoreTitleMatch('Half-Life 2', 'Half-Life 2: Lost Coast').confidence).toBe('low');
    expect(scoreTitleMatch('Portal 2', 'Portal Stories: Mel').confidence).toBe('low');
  });

  it('never promotes containment to HIGH for a single generic word, even when it is a literal prefix', () => {
    const score = scoreTitleMatch('War', 'War Thunder');
    expect(score.confidence).toBe('low');
  });
});

describe('scoreTitleMatch — abbreviations', () => {
  it('is HIGH confidence for "Game of the Year" vs. "GOTY"', () => {
    const score = scoreTitleMatch('Borderlands Game of the Year', 'Borderlands GOTY');
    expect(score.confidence).toBe('high');
  });

  it('is HIGH confidence for "Game of the Year Enhanced" vs. "GOTY Enhanced"', () => {
    const score = scoreTitleMatch('Borderlands Game of the Year Enhanced', 'Borderlands GOTY Enhanced');
    expect(score.confidence).toBe('high');
  });

  it('does not cross-match the abbreviated title against the wrong edition', () => {
    // "Borderlands Game of the Year" must match plain "Borderlands GOTY",
    // not the Enhanced one — exercised at the bestTitleMatchAmong level
    // below where both are real candidates in the same list.
    const score = scoreTitleMatch('Borderlands Game of the Year', 'Borderlands GOTY Enhanced');
    expect(score.confidence).toBe('low');
  });
});

function suggestion(overrides: Partial<GameSuggestion> & { title: string }): GameSuggestion {
  return {
    externalId: '1',
    coverUrl: null,
    genre: null,
    developer: null,
    publisher: null,
    metacritic: null,
    averagePlaytimeHours: null,
    esrbRating: null,
    releaseYear: null,
    ...overrides,
  };
}

describe('bestTitleMatch', () => {
  it('returns null for an empty candidate list — "no match" is distinct from "low confidence"', () => {
    expect(bestTitleMatch('Quest of Legends', [])).toBeNull();
  });

  it('picks the exact match over closer-looking but inexact candidates', () => {
    const candidates = [
      suggestion({ externalId: '10', title: 'Quest of Legends II' }),
      suggestion({ externalId: '11', title: 'Quest of Legends' }),
      suggestion({ externalId: '12', title: 'Quest of Legends Remastered' }),
    ];
    const match = bestTitleMatch('Quest of Legends', candidates);
    expect(match?.suggestion.externalId).toBe('11');
    expect(match?.score.confidence).toBe('high');
  });

  it('picks the lowest-distance candidate when nothing is an exact match', () => {
    const candidates = [
      suggestion({ externalId: '20', title: 'Farming Simulator' }),
      suggestion({ externalId: '21', title: 'Quest of Legend' }), // one character off
    ];
    const match = bestTitleMatch('Quest of Legends', candidates);
    expect(match?.suggestion.externalId).toBe('21');
    expect(match?.score.confidence).toBe('low');
  });
});

describe('bestTitleMatchAmong', () => {
  // Exercises the generic form `bestTitleMatch` itself wraps, against a
  // shape that has nothing to do with GameSuggestion — the whole reason it
  // exists is so a candidate shape like a Steam-owned game (`{ appid, name,
  // playtimeMinutes }`, no `title` field at all) never has to be coerced
  // into a fake GameSuggestion just to reuse the scoring policy. See
  // src/server/games/steam.ts's header for why the Steam sync uses this
  // directly instead of a duplicate loop.
  interface SteamLikeCandidate {
    readonly appid: number;
    readonly name: string;
  }

  const candidates: SteamLikeCandidate[] = [
    { appid: 1, name: 'Grand Theft Auto: Vice City' },
    { appid: 2, name: 'Grand Theft Auto: San Andreas' },
  ];
  const titleOf = (candidate: SteamLikeCandidate): string => candidate.name;

  it('returns null for an empty candidate list', () => {
    expect(bestTitleMatchAmong('Anything', [], titleOf)).toBeNull();
  });

  it('finds an identical-after-normalization title as HIGH confidence', () => {
    const match = bestTitleMatchAmong('grand theft auto vice city', candidates, titleOf);
    expect(match?.candidate.appid).toBe(1);
    expect(match?.score.confidence).toBe('high');
  });

  it('matches after stripping a trailing parenthetical from the stored title', () => {
    const match = bestTitleMatchAmong('Grand Theft Auto: Vice City (itch)', candidates, titleOf);
    expect(match?.candidate.appid).toBe(1);
    expect(match?.score.confidence).toBe('high');
  });

  it('reports LOW confidence for a close-but-not-identical title, never auto-promoted to high', () => {
    const match = bestTitleMatchAmong('Grand Theft Auto Vice City HD', candidates, titleOf);
    expect(match?.candidate.appid).toBe(1);
    expect(match?.score.confidence).toBe('low');
  });
});

/**
 * Problem 1 from the real Steam sync dry run: `bestTitleMatchAmong` used to
 * always return SOMETHING while `candidates` was non-empty, so a title Steam
 * genuinely does not own still came back as a LOW-confidence match against
 * an unrelated closest neighbour. `SIMILARITY_FLOOR` fixes that. Every title
 * (both stored and Steam-owned) below is REAL, taken directly from the
 * owner's real 47-row Steam library sync dry run — see the task's own
 * report and .superpowers/sdd/2026-08-20-game-tracker/steam-sync-report.md.
 * `candidates` below is a representative slice of the 38 real Steam-owned
 * titles from that run — enough to exercise every family (Half-Life,
 * Portal, Borderlands, Slay the Spire) where a wrong match risked attaching
 * the wrong achievements to the wrong library row.
 */
describe('bestTitleMatchAmong — similarity floor (no match at all)', () => {
  const realSteamLibrary = [
    'Portal',
    'Portal 2',
    'Half-Life',
    'Half-Life 2',
    'Half-Life 2: Deathmatch',
    'Half-Life: Blue Shift',
    'Half-Life: Source',
    'Half-Life Deathmatch: Source',
    'Half-Life: Opposing Force',
    'Team Fortress Classic',
    'Slay the Spire',
    'Slay the Spire 2',
    'Borderlands GOTY',
    'Borderlands GOTY Enhanced',
    'Idle Slayer – Incremental RPG',
    'Tap Ninja',
    'Metro Exodus',
    'Metro 2033 Redux',
    'Metro: Last Light Redux',
  ] as const;
  const titleOf = (title: string): string => title;

  it.each([
    'Bloody Roar 2',
    'Grand Theft Auto: San Andreas',
    'Grand Theft Auto: Vice City (itch)',
    'Pocket Tanks',
    'Twisted Metal 2',
    'Half-Life 2: Episode One',
    'Half-Life 2: Episode Two',
    'Half-Life 2: Lost Coast',
    'Team Fortress 2',
    'Portal Reloaded',
    'Portal Stories: Mel',
    'The Perfect Tower II',
  ])('reports "%s" as no match at all — Steam does not own it', (storedTitle) => {
    expect(bestTitleMatchAmong(storedTitle, realSteamLibrary, titleOf)).toBeNull();
  });

  it.each([
    ['Borderlands Game of the Year', 'Borderlands GOTY'],
    ['Borderlands Game of the Year Enhanced', 'Borderlands GOTY Enhanced'],
    ['Idle Slayer', 'Idle Slayer – Incremental RPG'],
    ['Tap Ninja - Idle game', 'Tap Ninja'],
  ])('still reports "%s" as a HIGH match against "%s", never swallowed by the floor', (storedTitle, expectedSteamTitle) => {
    const match = bestTitleMatchAmong(storedTitle, realSteamLibrary, titleOf);
    expect(match?.score.confidence).toBe('high');
    expect(match?.candidate).toBe(expectedSteamTitle);
  });
});

describe('metadataFieldsToFill', () => {
  const emptyCurrent: StoredGameMetadata = {
    coverUrl: null,
    genre: null,
    metacritic: null,
    averagePlaytimeHours: null,
    esrbRating: null,
  };

  it('fills every null column when the suggestion has values for all of them', () => {
    const fill = metadataFieldsToFill(
      emptyCurrent,
      suggestion({
        title: 'Quest of Legends',
        coverUrl: 'https://images.igdb.com/x.jpg',
        genre: 'RPG',
        metacritic: 88,
        averagePlaytimeHours: 40,
        esrbRating: 'T',
      }),
    );
    expect(fill).toEqual({
      coverUrl: 'https://images.igdb.com/x.jpg',
      genre: 'RPG',
      metacritic: 88,
      averagePlaytimeHours: 40,
      esrbRating: 'T',
    });
  });

  it('never includes a column the owner already has a value for, even if IGDB disagrees', () => {
    const current: StoredGameMetadata = {
      ...emptyCurrent,
      genre: 'Action', // owner-supplied or already-backfilled; must never be overwritten
    };
    const fill = metadataFieldsToFill(
      current,
      suggestion({ title: 'Quest of Legends', genre: 'RPG', metacritic: 88 }),
    );
    expect(fill).toEqual({ metacritic: 88 });
    expect(fill.genre).toBeUndefined();
  });

  it('omits a field the suggestion has no value for, rather than writing null', () => {
    const fill = metadataFieldsToFill(emptyCurrent, suggestion({ title: 'Quest of Legends', genre: 'RPG' }));
    expect(fill).toEqual({ genre: 'RPG' });
  });

  it('returns an empty object when every column is already filled', () => {
    const current: StoredGameMetadata = {
      coverUrl: 'https://images.igdb.com/x.jpg',
      genre: 'RPG',
      metacritic: 88,
      averagePlaytimeHours: 40,
      esrbRating: 'T',
    };
    const fill = metadataFieldsToFill(
      current,
      suggestion({
        title: 'Quest of Legends',
        coverUrl: 'https://images.igdb.com/y.jpg',
        genre: 'Action',
        metacritic: 70,
        averagePlaytimeHours: 10,
        esrbRating: 'M',
      }),
    );
    expect(fill).toEqual({});
  });
});
