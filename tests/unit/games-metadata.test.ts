import { describe, expect, it } from 'vitest';

import { buildSearchUrl, pickBestMatch, scoreMatch, toSuggestions } from '@/server/games/metadata';

describe('buildSearchUrl', () => {
  it('encodes the query and attaches the key', () => {
    const url = buildSearchUrl('Ghost of Yōtei', 'test-key');
    expect(url).toContain('search=Ghost%20of%20Y%C5%8Dtei');
    expect(url).toContain('key=test-key');
  });
});

describe('toSuggestions', () => {
  it('maps a RAWG payload to the fields the app stores', () => {
    const suggestions = toSuggestions({
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
    });

    expect(suggestions[0]).toEqual({
      externalId: '1',
      title: 'Elden Ring',
      coverUrl: 'https://media.rawg.io/elden.jpg',
      releaseYear: 2022,
      genre: 'Action, RPG',
      developer: 'FromSoftware',
      publisher: 'Bandai Namco',
    });
  });

  it('tolerates missing optional fields rather than throwing', () => {
    const suggestions = toSuggestions({ results: [{ id: 2, name: 'Obscure Game' }] });
    expect(suggestions[0]).toMatchObject({ title: 'Obscure Game', coverUrl: null, genre: null });
  });

  it('returns an empty list for a malformed payload', () => {
    expect(toSuggestions(null)).toEqual([]);
    expect(toSuggestions({})).toEqual([]);
    expect(toSuggestions({ results: 'nope' })).toEqual([]);
  });
});

describe('scoreMatch', () => {
  it('scores an exact case-insensitive match highest', () => {
    expect(scoreMatch('Elden Ring', 'elden ring')).toBe(1);
  });

  it('scores an unrelated title near zero', () => {
    expect(scoreMatch('Elden Ring', 'FIFA 17')).toBeLessThan(0.3);
  });

  it('still scores well when the log title carries a collection prefix', () => {
    // The real spreadsheet has entries shaped exactly like this.
    const score = scoreMatch(
      'Uncharted: Legacy of Thieves Collection - UNCHARTED 4: A Thief’s End',
      'Uncharted 4: A Thief’s End',
    );
    expect(score).toBeGreaterThan(0.5);
  });
});

describe('pickBestMatch', () => {
  it('returns the highest-scoring suggestion with its confidence', () => {
    const best = pickBestMatch('Elden Ring', [
      { externalId: '1', title: 'Elden Ring II', coverUrl: null, releaseYear: null, genre: null, developer: null, publisher: null },
      { externalId: '2', title: 'Elden Ring', coverUrl: null, releaseYear: null, genre: null, developer: null, publisher: null },
    ]);

    expect(best?.suggestion.externalId).toBe('2');
    expect(best?.confidence).toBe(1);
  });

  it('returns null when there are no suggestions at all', () => {
    expect(pickBestMatch('Anything', [])).toBeNull();
  });
});
