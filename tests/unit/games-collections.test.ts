import { describe, expect, it } from 'vitest';

import {
  type CollectionRow,
  collectionIdsIn,
  countableGames,
  groupByCollection,
} from '@/server/games/collections';

function row(id: string, collectionId: string | null = null): CollectionRow {
  return { id, collectionId };
}

/** The real shape this was built for, in the order the library reads it (by title). */
function nathanDrake(): CollectionRow[] {
  return [
    row('uc1', 'ndc'), // "Uncharted: Drake's Fortune Remastered"
    row('uc2', 'ndc'), // "Uncharted 2: Among Thieves Remastered"
    row('uc3', 'ndc'), // "Uncharted 3: Drake's Deception Remastered"
    row('ndc'), //       "Uncharted: The Nathan Drake Collection"
  ];
}

describe('collectionIdsIn', () => {
  it('names every row some other row points at', () => {
    expect([...collectionIdsIn(nathanDrake())]).toEqual(['ndc']);
  });

  it('is empty for a library with no collections', () => {
    expect([...collectionIdsIn([row('a'), row('b')])]).toEqual([]);
  });

  it('does not treat a row that points at ITSELF as a collection', () => {
    // The write path rejects this; the guard exists so a row reached some
    // other way is still a game rather than a wrapper around nothing.
    expect([...collectionIdsIn([row('a', 'a')])]).toEqual([]);
  });
});

describe('countableGames', () => {
  it('counts the titles inside a collection and not the collection itself', () => {
    expect(countableGames(nathanDrake()).map((r) => r.id)).toEqual(['uc1', 'uc2', 'uc3']);
  });

  it('leaves a library with no collections untouched', () => {
    expect(countableGames([row('a'), row('b')]).map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('groupByCollection', () => {
  it('files members under their collection even when they sort before it', () => {
    const groups = groupByCollection(nathanDrake());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.game.id).toBe('ndc');
    expect(groups[0]?.members.map((r) => r.id)).toEqual(['uc1', 'uc2', 'uc3']);
  });

  it('gives a standalone game a group of its own with no members', () => {
    const groups = groupByCollection([row('elden-ring')]);
    expect(groups).toEqual([{ game: row('elden-ring'), members: [] }]);
  });

  it('preserves input order of the top-level rows', () => {
    const groups = groupByCollection([row('a'), row('uc1', 'ndc'), row('ndc'), row('z')]);
    expect(groups.map((g) => g.game.id)).toEqual(['a', 'ndc', 'z']);
  });

  it('promotes a member whose collection is absent, rather than dropping it', () => {
    // How a filter reaches this: the owner filters to "PS5" and the
    // collection is a PS4 row. The member must not vanish.
    const groups = groupByCollection([row('uc1', 'ndc')]);
    expect(groups.map((g) => g.game.id)).toEqual(['uc1']);
    expect(groups[0]?.members).toEqual([]);
  });

  it('treats a self-referencing row as standalone rather than its own child', () => {
    const groups = groupByCollection([row('a', 'a')]);
    expect(groups).toEqual([{ game: row('a', 'a'), members: [] }]);
  });

  it('loses no row to a two-level chain', () => {
    // A → B → C. The one-level rule makes this unreachable through the UI.
    // B files under C as normal; A, whose parent is itself a member and so
    // has no group of its own, is promoted to top level rather than dropped.
    // The chain is not UNTANGLED — it renders looking wrong, which is the
    // point: all three rows are on screen.
    const groups = groupByCollection([row('a', 'b'), row('b', 'c'), row('c')]);
    expect(groups.map((g) => g.game.id)).toEqual(['c', 'a']);
    expect(groups[0]?.members.map((m) => m.id)).toEqual(['b']);
  });

  it('accounts for every input row exactly once', () => {
    const rows = [...nathanDrake(), row('solo'), row('orphan', 'gone')];
    const groups = groupByCollection(rows);
    const seen = groups.flatMap((g) => [g.game.id, ...g.members.map((m) => m.id)]);
    expect(seen.sort()).toEqual(['ndc', 'orphan', 'solo', 'uc1', 'uc2', 'uc3']);
  });
});
