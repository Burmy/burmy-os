import { describe, expect, it } from 'vitest';

import {
  bestTitleMatch,
  buildSearchQuery,
  buildTimeToBeatQuery,
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
    expect(scoreTitleMatch('Quest of Legends', 'Quest of Legends')).toEqual({ confidence: 'high', distance: 0 });
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

  it('is LOW confidence with a large distance for an unrelated title', () => {
    const score = scoreTitleMatch('Quest of Legends', 'Farming Simulator');
    expect(score.confidence).toBe('low');
    expect(score.distance).toBeGreaterThan(0.5);
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
