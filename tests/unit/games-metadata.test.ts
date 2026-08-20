import { describe, expect, it } from 'vitest';

import { buildSearchUrl, toSuggestions } from '@/server/games/metadata';

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
