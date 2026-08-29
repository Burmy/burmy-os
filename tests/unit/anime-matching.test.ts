import { describe, expect, it } from 'vitest';

import {
  type MatchableEntry,
  bestTitleMatch,
  normalizeTitle,
  ordinalMarker,
  similarity,
} from '@/server/anime/matching';

function entry(mediaId: number, romaji: string, english: string | null = null): MatchableEntry {
  return { mediaId, titleRomaji: romaji, titleEnglish: english };
}

const AOT = [
  entry(16498, 'Shingeki no Kyojin', 'Attack on Titan'),
  entry(25777, 'Shingeki no Kyojin Season 2', 'Attack on Titan Season 2'),
  entry(99147, 'Shingeki no Kyojin Season 3', 'Attack on Titan Season 3'),
  entry(131681, 'Shingeki no Kyojin: The Final Season', 'Attack on Titan Final Season'),
];

describe('normalizeTitle', () => {
  it('folds the curly apostrophe a romanisation writes', () => {
    expect(normalizeTitle("Drake’s Fortune")).toBe(normalizeTitle("Drake's Fortune"));
  });

  it('folds the punctuation titles are written both ways with', () => {
    expect(normalizeTitle('Steins;Gate')).toBe(normalizeTitle('Steins Gate'));
    expect(normalizeTitle('Kimi no Na wa.')).toBe(normalizeTitle('Kimi no Na wa'));
    expect(normalizeTitle('Re:Zero kara Hajimeru')).toBe(normalizeTitle('Re Zero kara Hajimeru'));
  });

  it('is case-insensitive and collapses whitespace', () => {
    expect(normalizeTitle('  COWBOY   Bebop ')).toBe('cowboy bebop');
  });
});

describe('ordinalMarker — the hard gate', () => {
  it('reads a season number in any of its written forms', () => {
    expect(ordinalMarker('Shingeki no Kyojin Season 2')).toBe('n2');
    expect(ordinalMarker('Kaguya-sama: Love is War - 2nd Season')).toBe('n2');
    expect(ordinalMarker('Overlord II')).toBe('n2');
    expect(ordinalMarker('Mushoku Tensei 2')).toBe('n2');
  });

  it('treats "Final Season" as its own marker', () => {
    expect(ordinalMarker('Attack on Titan Final Season')).toBe('final');
  });

  it('reports no marker for a bare title', () => {
    expect(ordinalMarker('Shingeki no Kyojin')).toBe('');
    expect(ordinalMarker('Cowboy Bebop')).toBe('');
  });

  it('does not read a number that is part of the title as a season', () => {
    // The trailing rule accepts at most two digits, which is what keeps
    // "Mob Psycho 100" a title and not a season 100.
    expect(ordinalMarker('Mob Psycho 100')).toBe('');
    expect(ordinalMarker('86 Eighty-Six')).toBe('');
    expect(ordinalMarker('Cowboy Bebop')).toBe('');
  });

  it('still tells a numbered title apart from its own sequel', () => {
    // The real pair this protects: both are in the owner's library.
    expect(ordinalMarker('Mob Psycho 100')).not.toBe(ordinalMarker('Mob Psycho 100 II'));
  });

  it('is derived the same way on both sides, so a false marker is harmless', () => {
    // "Gundam 00" picks up a marker it does not deserve — and it does so
    // identically wherever the title appears, so the gate still lets the show
    // match itself. The gate only ever blocks a DISAGREEMENT.
    expect(ordinalMarker('Mobile Suit Gundam 00')).toBe(ordinalMarker('Gundam 00'));
  });

  it('reads Roman numerals as numbers, so III and 3 agree', () => {
    expect(ordinalMarker('Overlord III')).toBe(ordinalMarker('Overlord 3'));
  });
});

describe('similarity', () => {
  it('is 1 for identical strings and 0 for nothing shared', () => {
    expect(similarity('frieren', 'frieren')).toBe(1);
    expect(similarity('abcd', 'wxyz')).toBe(0);
  });

  it('scores a near-identical romanisation high', () => {
    expect(similarity(normalizeTitle('Kimi no Na wa.'), normalizeTitle('Kimi no Na wa'))).toBe(1);
  });

  it('handles a string too short to have bigrams', () => {
    expect(similarity('a', 'a')).toBe(1);
    expect(similarity('a', 'b')).toBe(0);
  });
});

describe('bestTitleMatch — the season trap', () => {
  it('NEVER matches a bare title to a numbered season', () => {
    // THE reason this module exists. These two are 85%+ similar by any string
    // metric and are different shows; linking them would let the next sync
    // overwrite one season's progress with another's.
    expect(bestTitleMatch('Shingeki no Kyojin', [AOT[1]!])).toBeNull();
    expect(bestTitleMatch('Attack on Titan', [AOT[1]!])).toBeNull();
  });

  it('never matches season 2 to season 3', () => {
    expect(bestTitleMatch('Shingeki no Kyojin Season 2', [AOT[2]!])).toBeNull();
  });

  it('never matches a numbered season to the Final Season', () => {
    expect(bestTitleMatch('Shingeki no Kyojin Season 3', [AOT[3]!])).toBeNull();
  });

  it('picks the right season out of a whole franchise', () => {
    const match = bestTitleMatch('Shingeki no Kyojin Season 2', AOT);
    expect(match?.entry.mediaId).toBe(25777);
  });

  it('picks the bare first season out of the same list', () => {
    const match = bestTitleMatch('Attack on Titan', AOT);
    expect(match?.entry.mediaId).toBe(16498);
  });
});

describe('bestTitleMatch — which title it compares against', () => {
  it('matches AniList’s English title when that is what the owner typed', () => {
    const match = bestTitleMatch('Attack on Titan', [entry(16498, 'Shingeki no Kyojin', 'Attack on Titan')]);
    expect(match?.entry.mediaId).toBe(16498);
    expect(match?.exact).toBe(true);
  });

  it('matches the romaji title just as well', () => {
    const match = bestTitleMatch('Shingeki no Kyojin', [entry(16498, 'Shingeki no Kyojin', 'Attack on Titan')]);
    expect(match?.exact).toBe(true);
  });

  it('copes with an entry that has no English title at all', () => {
    const match = bestTitleMatch('Gintama', [entry(918, 'Gintama', null)]);
    expect(match?.entry.mediaId).toBe(918);
  });

  it('matches through punctuation the two sources write differently', () => {
    expect(bestTitleMatch('Steins Gate', [entry(9253, 'Steins;Gate')])?.entry.mediaId).toBe(9253);
    expect(bestTitleMatch('Kimi no Na wa', [entry(21519, 'Kimi no Na wa.')])?.entry.mediaId).toBe(21519);
  });
});

describe('bestTitleMatch — refusing rather than guessing', () => {
  it('returns null when nothing is close enough', () => {
    expect(bestTitleMatch('Cowboy Bebop', [entry(1, 'Neon Genesis Evangelion')])).toBeNull();
  });

  it('does not match a film to the series it belongs to', () => {
    // "One Piece" is a substring of "One Piece Film: Red", and containment is
    // exactly the shortcut this module refuses to take.
    expect(bestTitleMatch('One Piece', [entry(2, 'One Piece Film: Red')])).toBeNull();
  });

  it('returns null for an empty candidate list and for a blank title', () => {
    expect(bestTitleMatch('Frieren', [])).toBeNull();
    expect(bestTitleMatch('   ', AOT)).toBeNull();
  });

  it('reports the better of two near-matches', () => {
    const match = bestTitleMatch('Cowboy Bebop', [entry(1, 'Cowboy Bebopp'), entry(2, 'Cowboy Bebop')]);
    expect(match?.entry.mediaId).toBe(2);
    expect(match?.exact).toBe(true);
  });
});
