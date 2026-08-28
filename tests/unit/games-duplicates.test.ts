import { describe, expect, it } from 'vitest';

import {
  type DuplicateCandidate,
  describeFills,
  fillsFor,
  findDuplicates,
  flattenedCollectionName,
  flattenedMemberName,
  isSynced,
  titleKey,
} from '@/server/games/duplicates';

/**
 * Every fixture here is the shape of a real row in the owner's library. The
 * two pairs that matter:
 *
 *   Uncharted: Legacy of Thieves Collection   PS4  hand-typed, rating + price
 *   UNCHARTED: Legacy of Thieves Collection   PS5  PSN-linked, platinum
 *
 *   Uncharted: The Nathan Drake Collection - Uncharted: Drake's Fortune…  (flattened)
 *   Uncharted™: The Nathan Drake Collection                                (the real set)
 *
 * The tests that matter MOST are the ones asserting what this REFUSES to
 * merge: it deletes a row, so an over-eager match destroys data.
 */

function game(overrides: Partial<DuplicateCandidate> & { id: string; title: string }): DuplicateCandidate {
  return {
    platform: 'ps4',
    collectionId: null,
    steamAppid: null,
    psnTitleId: null,
    psnNpCommunicationId: null,
    ownership: null,
    priceCents: null,
    rating: null,
    notes: null,
    genre: null,
    developer: null,
    publisher: null,
    coverUrl: null,
    firstPlayedYear: null,
    hoursTenths: null,
    achievementsUnlocked: null,
    achievementsTotal: null,
    platinum: false,
    metacritic: null,
    ...overrides,
  };
}

const typedLot = game({
  id: 'lot-ps4',
  title: 'Uncharted: Legacy of Thieves Collection',
  platform: 'ps4',
  hoursTenths: 420,
  priceCents: 3999,
  rating: 5,
  achievementsUnlocked: 101,
});
const syncedLot = game({
  id: 'lot-ps5',
  title: 'UNCHARTED: Legacy of Thieves Collection',
  platform: 'ps5',
  psnNpCommunicationId: 'NPWR21075_00',
  hoursTenths: 429,
  achievementsUnlocked: 101,
  achievementsTotal: 101,
  platinum: true,
});

describe('titleKey', () => {
  it('folds the case and trademark difference between the two Legacy of Thieves rows', () => {
    expect(titleKey(typedLot.title)).toBe(titleKey(syncedLot.title));
  });

  it('folds a curly apostrophe, trademark marks and dash styles', () => {
    expect(titleKey('Uncharted™: Drake’s Fortune')).toBe("uncharted: drake's fortune");
    expect(titleKey('Ratchet — Clank')).toBe('ratchet - clank');
  });

  it('keeps genuinely different titles apart', () => {
    // Under-strip, never over-strip: merging two real games would move data
    // between two rows the owner can see.
    expect(titleKey('Uncharted 2')).not.toBe(titleKey('Uncharted 3'));
    expect(titleKey('Uncharted: The Lost Legacy')).not.toBe(titleKey('Uncharted: Legacy of Thieves Collection'));
  });
});

describe('flattenedCollectionName', () => {
  it('reads the collection name off the owner’s mashed import row', () => {
    expect(
      flattenedCollectionName("Uncharted: The Nathan Drake Collection - Uncharted: Drake's Fortune Remastered"),
    ).toBe('Uncharted: The Nathan Drake Collection');
  });

  it('does NOT split a hyphenated title', () => {
    // The separator is a SPACED hyphen. "Spider-Man" and "Ratchet-Clank" are
    // single titles and tearing them in half would invent a collection.
    expect(flattenedCollectionName('Marvel’s Spider-Man')).toBeNull();
    expect(flattenedCollectionName('Ratchet-Clank')).toBeNull();
  });

  it('is null for an ordinary title and for a leading separator', () => {
    expect(flattenedCollectionName('Elden Ring')).toBeNull();
    expect(flattenedCollectionName(' - Orphaned')).toBeNull();
  });

  it('reads the GAME half too — the title the merge has to restore', () => {
    expect(
      flattenedMemberName("Uncharted: The Nathan Drake Collection - Uncharted: Drake's Fortune Remastered"),
    ).toBe("Uncharted: Drake's Fortune Remastered");
    expect(flattenedMemberName('Elden Ring')).toBeNull();
    expect(flattenedMemberName('Something - ')).toBeNull();
  });
});

describe('isSynced', () => {
  it('is true for any of the three provider links', () => {
    expect(isSynced(game({ id: 'a', title: 'A', steamAppid: 1 }))).toBe(true);
    expect(isSynced(game({ id: 'a', title: 'A', psnTitleId: 'CUSA1' }))).toBe(true);
    expect(isSynced(game({ id: 'a', title: 'A', psnNpCommunicationId: 'NPWR1' }))).toBe(true);
  });

  it('is false for a hand-typed row', () => {
    expect(isSynced(game({ id: 'a', title: 'A' }))).toBe(false);
  });
});

describe('fillsFor', () => {
  it('carries only what the winner is missing', () => {
    expect(fillsFor(syncedLot, typedLot)).toEqual({ priceCents: 3999, rating: 5 });
  });

  it('never overwrites a value the winner already has', () => {
    // The synced row's 429 tenths must survive; the typed row's 420 is stale.
    expect(fillsFor(syncedLot, typedLot)).not.toHaveProperty('hoursTenths');
  });

  it('does not treat platinum as fillable', () => {
    // `false` is a real value, so a null-only fill rule can never carry it.
    // It is OR-ed by the plan instead.
    expect(fillsFor(syncedLot, typedLot)).not.toHaveProperty('platinum');
  });
});

describe('findDuplicates — the cross-platform pair', () => {
  it('finds the pair the merge script cannot, because it keys on title alone', () => {
    const { merges, review } = findDuplicates([typedLot, syncedLot]);

    expect(review).toEqual([]);
    expect(merges).toHaveLength(1);
    expect(merges[0]?.kind).toBe('same-title');
    expect(merges[0]?.winner.id).toBe('lot-ps5');
    expect(merges[0]?.loser.id).toBe('lot-ps4');
  });

  it('surfaces BOTH platforms so the merge has to choose', () => {
    // The owner owns the PS4 copy and played it on PS5. Neither platform is
    // automatically right — `psn.ts` documents the same account holding
    // Cyberpunk as a genuine CUSA/PPSA pair — so it is a decision, not a rule.
    expect(findDuplicates([typedLot, syncedLot]).merges[0]?.platforms).toEqual(['ps5', 'ps4']);
  });

  it('reports one platform when both rows agree', () => {
    const samePlatform = { ...syncedLot, platform: 'ps4' as const };
    expect(findDuplicates([typedLot, samePlatform]).merges[0]?.platforms).toEqual(['ps4']);
  });

  it('ORs platinum across the pair', () => {
    expect(findDuplicates([typedLot, syncedLot]).merges[0]?.platinum).toBe(true);
  });

  it('carries the typed row’s rating and price onto the synced winner', () => {
    expect(findDuplicates([typedLot, syncedLot]).merges[0]?.fills).toEqual({ priceCents: 3999, rating: 5 });
  });
});

describe('findDuplicates — the flattened collection row', () => {
  const flattened = game({
    id: 'mashed',
    title: "Uncharted: The Nathan Drake Collection - Uncharted: Drake's Fortune Remastered",
    hoursTenths: 440,
    achievementsUnlocked: 154,
    rating: 2,
  });
  const collection = game({
    id: 'ndc',
    title: 'Uncharted™: The Nathan Drake Collection',
    hoursTenths: 442,
  });

  it('matches the mashed row to the real collection', () => {
    const { merges } = findDuplicates([flattened, collection]);

    expect(merges).toHaveLength(1);
    expect(merges[0]?.kind).toBe('flattened-collection');
    expect(merges[0]?.winner.id).toBe('ndc');
    expect(merges[0]?.loser.id).toBe('mashed');
  });

  it('keeps the collection even though NEITHER row is synced', () => {
    // The forced winner. Sync status cannot decide this pair, but the shape
    // of the titles can: one of them is a real collection name and the other
    // is that name with a game glued to it.
    expect(findDuplicates([flattened, collection]).review).toEqual([]);
  });

  it('moves the 154 achievements onto the collection, where the rollup can replace them', () => {
    expect(findDuplicates([flattened, collection]).merges[0]?.fills).toEqual({
      achievementsUnlocked: 154,
      rating: 2,
    });
  });

  it('ignores a flattened-looking row that is already inside a collection', () => {
    const member = { ...flattened, collectionId: 'ndc' };
    expect(findDuplicates([member, collection]).merges).toEqual([]);
  });

  it('does not guess when two rows could be the named collection', () => {
    const twin = game({ id: 'ndc2', title: 'Uncharted: The Nathan Drake Collection' });
    const { merges } = findDuplicates([flattened, collection, twin]);
    expect(merges.some((m) => m.kind === 'flattened-collection')).toBe(false);
  });

  it('does not propose anything when the named collection is absent', () => {
    expect(findDuplicates([flattened]).merges).toEqual([]);
  });

  it('does not ALSO propose the mashed row against its own twin', () => {
    // REGRESSION. The importer can emit the same mashed title twice. The
    // flattened pass claims it first (merging it into the real collection);
    // without the claimed-row guard the same-title pass would then propose a
    // SECOND merge for a row the first one deletes — a card that cannot work
    // whichever order the owner clicks them in.
    // The twin is SYNCED, so the same-title pass would produce a real merge
    // rather than a review entry — which is the only way the collision is
    // observable in `merges` at all.
    const twin = { ...flattened, id: 'mashed-2', psnTitleId: 'CUSA02320_00' };
    const { merges } = findDuplicates([flattened, twin, collection]);

    const touched = merges.flatMap((m) => [m.winner.id, m.loser.id]);
    expect(new Set(touched).size).toBe(touched.length);
    expect(merges.filter((m) => m.loser.id === 'mashed' || m.winner.id === 'mashed')).toHaveLength(1);
  });
});

describe('findDuplicates — what it refuses', () => {
  it('refuses a group of three', () => {
    const third = game({ id: 'lot-3', title: 'Uncharted: Legacy of Thieves Collection' });
    const { merges, review } = findDuplicates([typedLot, syncedLot, third]);

    expect(merges).toEqual([]);
    expect(review[0]?.reason).toContain('3 rows share this title');
  });

  it('refuses a pair where both copies are linked', () => {
    const alsoSynced = { ...typedLot, steamAppid: 1659420 };
    const { merges, review } = findDuplicates([alsoSynced, syncedLot]);

    expect(merges).toEqual([]);
    expect(review[0]?.reason).toContain('Both copies are linked');
  });

  it('refuses a pair where neither copy is linked', () => {
    const alsoTyped = { ...syncedLot, psnNpCommunicationId: null };
    const { merges, review } = findDuplicates([typedLot, alsoTyped]);

    expect(merges).toEqual([]);
    expect(review[0]?.reason).toContain('Neither copy is linked');
  });

  it('refuses to delete a row that holds collection members', () => {
    const { merges, review } = findDuplicates([typedLot, syncedLot], {
      holdsMembers: new Set(['lot-ps4']),
    });

    expect(merges).toEqual([]);
    expect(review[0]?.reason).toContain('holds games of its own');
  });

  it('refuses to delete a row with its own stored trophies', () => {
    const { merges, review } = findDuplicates([typedLot, syncedLot], {
      hasTrophies: new Set(['lot-ps4']),
    });

    expect(merges).toEqual([]);
    expect(review[0]?.reason).toContain('its own stored trophies');
  });

  it('finds nothing in a library with no duplicates', () => {
    const clean = [
      game({ id: 'a', title: 'Elden Ring' }),
      game({ id: 'b', title: 'Uncharted: The Lost Legacy' }),
      game({ id: 'c', title: 'Hades' }),
    ];
    expect(findDuplicates(clean)).toEqual({ merges: [], review: [] });
  });
});

describe('findDuplicates — the owner’s whole Uncharted shelf', () => {
  // All seven rows from the real screenshot, at once. Both pairs are found,
  // the three genuinely distinct titles are left alone, and no row appears in
  // two proposals.
  const shelf: DuplicateCandidate[] = [
    typedLot,
    syncedLot,
    game({ id: 'lost', title: 'Uncharted: The Lost Legacy' }),
    game({
      id: 'mashed',
      title: "Uncharted: The Nathan Drake Collection - Uncharted: Drake's Fortune Remastered",
      achievementsUnlocked: 154,
    }),
    game({ id: 'ndc', title: 'Uncharted™: The Nathan Drake Collection', hoursTenths: 442 }),
    game({ id: 'uc2', title: 'Uncharted 2: Among Thieves Remastered', collectionId: 'ndc' }),
    game({ id: 'uc3', title: "Uncharted 3: Drake's Deception Remastered", collectionId: 'ndc' }),
  ];

  it('finds exactly the two real duplicates', () => {
    const { merges, review } = findDuplicates(shelf);

    expect(review).toEqual([]);
    expect(merges.map((m) => m.kind).sort()).toEqual(['flattened-collection', 'same-title']);
  });

  it('never proposes the same row in two merges', () => {
    // A second card acting on a row the first card deleted cannot work.
    const { merges } = findDuplicates(shelf);
    const touched = merges.flatMap((m) => [m.winner.id, m.loser.id]);
    expect(new Set(touched).size).toBe(touched.length);
  });

  it('leaves the three genuinely distinct titles alone', () => {
    const { merges } = findDuplicates(shelf);
    const touched = new Set(merges.flatMap((m) => [m.winner.id, m.loser.id]));
    for (const id of ['lost', 'uc2', 'uc3']) expect(touched.has(id)).toBe(false);
  });
});

describe('describeFills', () => {
  it('names the columns in the owner’s words, not the schema’s', () => {
    // This sentence sits directly above a delete button. `priceCents` and
    // `achievementsUnlocked` are column names and have no business there.
    const [plan] = findDuplicates([typedLot, syncedLot]).merges;
    expect(describeFills(plan!)).toBe('Carries over price, rating.');
    expect(describeFills(plan!)).not.toContain('Cents');
  });

  it('describes the flattened merge in the same words', () => {
    const flattened = game({
      id: 'mashed',
      title: 'Uncharted: The Nathan Drake Collection - Drake’s Fortune',
      achievementsUnlocked: 154,
      rating: 2,
    });
    const collection = game({ id: 'ndc', title: 'Uncharted™: The Nathan Drake Collection' });
    const [plan] = findDuplicates([flattened, collection]).merges;

    expect(describeFills(plan!)).toBe('Carries over rating, achievements.');
  });

  it('mentions platinum only when the merge is what supplies it', () => {
    const winnerHasPlatinum = { ...syncedLot, platinum: true };
    const loserHasPlatinum = { ...typedLot, platinum: true, priceCents: null, rating: null };

    expect(describeFills(findDuplicates([loserHasPlatinum, { ...syncedLot, platinum: false }]).merges[0]!)).toContain(
      'platinum',
    );
    expect(describeFills(findDuplicates([typedLot, winnerHasPlatinum]).merges[0]!)).not.toContain('platinum');
  });

  it('says so plainly when there is nothing to carry', () => {
    const bare = game({ id: 'bare', title: 'Uncharted: Legacy of Thieves Collection' });
    expect(describeFills(findDuplicates([bare, syncedLot]).merges[0]!)).toContain('Nothing to carry over');
  });
});

/**
 * The count-preserving half of a flattened merge.
 *
 * A flattened row is a standalone game, so it counts. Merging it into the
 * collection deletes it — and without creating the title it names, the owner's
 * Uncharted shelf silently drops from three games to two. Three is the number
 * they keep; it is the reason collections exist at all.
 */
describe('findDuplicates — restoring the game a flattened merge would delete', () => {
  const flattened = game({
    id: 'mashed',
    title: "Uncharted: The Nathan Drake Collection - Uncharted: Drake's Fortune Remastered",
    achievementsUnlocked: 154,
  });
  const collection = game({ id: 'ndc', title: 'Uncharted™: The Nathan Drake Collection' });

  it('names the title the merge has to create', () => {
    expect(findDuplicates([flattened, collection]).merges[0]?.createsMember).toBe(
      "Uncharted: Drake's Fortune Remastered",
    );
  });

  it('creates nothing when that title is ALREADY in the library', () => {
    // Re-creating it would collide on (owner, title, platform), and the game
    // is not missing in the first place.
    const existing = game({ id: 'df', title: "Uncharted: Drake's Fortune Remastered" });
    const plan = findDuplicates([flattened, collection, existing]).merges.find(
      (m) => m.kind === 'flattened-collection',
    );
    expect(plan?.createsMember).toBeNull();
  });

  it('matches an existing title through the same folding the search uses', () => {
    // Stored with a curly apostrophe, as the spreadsheet wrote it.
    const existing = game({ id: 'df', title: 'Uncharted: Drake’s Fortune Remastered' });
    const plan = findDuplicates([flattened, collection, existing]).merges.find(
      (m) => m.kind === 'flattened-collection',
    );
    expect(plan?.createsMember).toBeNull();
  });

  it('is null for a plain same-title merge, which deletes no countable game', () => {
    // Both rows in a cross-platform pair are the same game; one survives, so
    // the count is unchanged and there is nothing to restore.
    expect(findDuplicates([typedLot, syncedLot]).merges[0]?.createsMember).toBeNull();
  });
});
