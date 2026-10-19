import { describe, expect, it } from 'vitest';

import type { CollectionGroup } from '@/server/games/collections';
import {
  type SortableGame,
  matchesRating,
  matchesYear,
  moveTopLevel,
  sortGroups,
  yearsIn,
} from '@/server/games/library-order';

function game(overrides: Partial<SortableGame> & { readonly id: string }): SortableGame {
  return {
    title: overrides.id,
    collectionId: null,
    hoursTenths: null,
    priceCents: null,
    achievementsUnlocked: null,
    achievementsTotal: null,
    platinum: false,
    rating: null,
    firstPlayedYear: null,
    dlc: [],
    ...overrides,
  };
}

function solo(
  overrides: Partial<SortableGame> & { readonly id: string },
): CollectionGroup<SortableGame> {
  return { game: game(overrides), members: [] };
}

const ids = (groups: readonly CollectionGroup<SortableGame>[]): string[] =>
  groups.map((group) => group.game.id);

describe('sortGroups', () => {
  const library = [
    solo({ id: 'b-rated-3', title: 'Bravo', rating: 3, hoursTenths: 100, firstPlayedYear: 2022 }),
    solo({
      id: 'a-unrated',
      title: 'Alpha',
      rating: null,
      hoursTenths: null,
      firstPlayedYear: null,
    }),
    solo({ id: 'c-rated-5', title: 'Charlie', rating: 5, hoursTenths: 50, firstPlayedYear: 2024 }),
  ];

  it('leaves My order untouched — that order is the data', () => {
    expect(ids(sortGroups(library, 'my-order'))).toEqual(['b-rated-3', 'a-unrated', 'c-rated-5']);
    expect(sortGroups(library, 'my-order')).not.toBe(library);
  });

  it('sorts year, hours and rating descending with the untracked rows last', () => {
    expect(ids(sortGroups(library, 'year'))).toEqual(['c-rated-5', 'b-rated-3', 'a-unrated']);
    expect(ids(sortGroups(library, 'hours'))).toEqual(['b-rated-3', 'c-rated-5', 'a-unrated']);
    expect(ids(sortGroups(library, 'rating'))).toEqual(['c-rated-5', 'b-rated-3', 'a-unrated']);
  });

  it('sorts title ascending and breaks numeric ties on the title', () => {
    expect(ids(sortGroups(library, 'title'))).toEqual(['a-unrated', 'b-rated-3', 'c-rated-5']);
    const tied = [
      solo({ id: 'z', title: 'Zeta', hoursTenths: 100 }),
      solo({ id: 'm', title: 'Mu', hoursTenths: 100 }),
    ];
    expect(ids(sortGroups(tied, 'hours'))).toEqual(['m', 'z']);
  });

  it('sorts a collection on the figure it shows: the members rolled up, plus its own DLC', () => {
    const set: CollectionGroup<SortableGame> = {
      game: game({
        id: 'trilogy',
        title: 'Crysis Remastered Trilogy',
        hoursTenths: null,
        dlc: [
          {
            id: 'dlc',
            gameId: 'trilogy',
            name: 'Pack',
            year: 2022,
            hoursTenths: 10,
            priceCents: null,
            achievementsUnlocked: 2,
            achievementsTotal: null,
          },
        ],
      }),
      members: [
        game({ id: 'c1', collectionId: 'trilogy', hoursTenths: 97, achievementsUnlocked: 34 }),
        game({ id: 'c2', collectionId: 'trilogy', hoursTenths: 133, achievementsUnlocked: 24 }),
      ],
    };
    const standalone = solo({
      id: 'solo',
      title: 'Solo',
      hoursTenths: 200,
      achievementsUnlocked: 50,
    });

    // 97 + 133 + 10 = 240 beats 200; 34 + 24 + 2 = 60 beats 50.
    expect(ids(sortGroups([standalone, set], 'hours'))).toEqual(['trilogy', 'solo']);
    expect(ids(sortGroups([standalone, set], 'trophies'))).toEqual(['trilogy', 'solo']);
  });

  it('keeps an unsplit collection on its own lump', () => {
    const set: CollectionGroup<SortableGame> = {
      game: game({ id: 'ndc', title: 'Nathan Drake', hoursTenths: 442 }),
      members: [game({ id: 'uc1', collectionId: 'ndc' })],
    };
    expect(ids(sortGroups([solo({ id: 'solo', hoursTenths: 300 }), set], 'hours'))).toEqual([
      'ndc',
      'solo',
    ]);
  });

  it('puts a collection last on the rating sort — it has no rating of its own', () => {
    const set: CollectionGroup<SortableGame> = {
      game: game({ id: 'ndc', title: 'Nathan Drake', rating: 5 }),
      members: [game({ id: 'uc1', collectionId: 'ndc', rating: 5 })],
    };
    expect(
      ids(sortGroups([set, solo({ id: 'solo', title: 'Solo', rating: 2 })], 'rating')),
    ).toEqual(['solo', 'ndc']);
  });
});

describe('moveTopLevel', () => {
  const order = ['a', 'b', 'hidden-wanted', 'c', 'd'];

  it('moves the dragged id to where the drop target sits, forwards and backwards', () => {
    expect(moveTopLevel(order, 'a', 'c')).toEqual(['b', 'hidden-wanted', 'c', 'a', 'd']);
    expect(moveTopLevel(order, 'd', 'b')).toEqual(['a', 'd', 'b', 'hidden-wanted', 'c']);
  });

  it('keeps a hidden row in its relative place when the drop happens around it', () => {
    // The owner sees a, b, c, d; dropping a on c lands a after c in the
    // full list, and the hidden row stays between b and c.
    expect(moveTopLevel(order, 'a', 'c')).toEqual(['b', 'hidden-wanted', 'c', 'a', 'd']);
  });

  it('is a no-op for a missing id or a drop on itself', () => {
    expect(moveTopLevel(order, 'a', 'a')).toBe(order);
    expect(moveTopLevel(order, 'zz', 'a')).toBe(order);
    expect(moveTopLevel(order, 'a', 'zz')).toBe(order);
  });
});

describe('filters', () => {
  it('rating: "4+" is at least four, "5" is exactly five, "unrated" is no rating', () => {
    expect(matchesRating(4, '4')).toBe(true);
    expect(matchesRating(5, '4')).toBe(true);
    expect(matchesRating(3, '4')).toBe(false);
    expect(matchesRating(4, '5')).toBe(false);
    expect(matchesRating(null, '4')).toBe(false);
    expect(matchesRating(null, 'unrated')).toBe(true);
    expect(matchesRating(2, 'unrated')).toBe(false);
    expect(matchesRating(null, 'all')).toBe(true);
  });

  it('year: a year, "none" for the retro rows, "all" for everything', () => {
    expect(matchesYear(2024, '2024')).toBe(true);
    expect(matchesYear(2023, '2024')).toBe(false);
    expect(matchesYear(null, '2024')).toBe(false);
    expect(matchesYear(null, 'none')).toBe(true);
    expect(matchesYear(2024, 'none')).toBe(false);
    expect(matchesYear(null, 'all')).toBe(true);
  });

  it('lists the years present, newest first, once each', () => {
    expect(
      yearsIn([
        { firstPlayedYear: 2022 },
        { firstPlayedYear: null },
        { firstPlayedYear: 2026 },
        { firstPlayedYear: 2022 },
      ]),
    ).toEqual([2026, 2022]);
  });
});
