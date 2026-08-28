import { describe, expect, it } from 'vitest';

import {
  type CollectionRow,
  collectionIdsIn,
  countableGames,
  groupByCollection,
  rollUpTrophies,
  trophyAdjustedRows,
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

// ─────────────────────────────────────────────────────────────────────────────
// Trophies — the rollup that replaced "a collection has one trophy list"
// ─────────────────────────────────────────────────────────────────────────────

function trophies(
  unlocked: number | null,
  total: number | null,
  platinum = false,
): { achievementsUnlocked: number | null; achievementsTotal: number | null; platinum: boolean } {
  return { achievementsUnlocked: unlocked, achievementsTotal: total, platinum };
}

const NONE = trophies(null, null);

describe('rollUpTrophies', () => {
  it('sums the members when they carry their own trophies', () => {
    // PSN's real shape for the Nathan Drake Collection: three separate trophy
    // lists, one per remastered game, each with its own platinum.
    expect(
      rollUpTrophies(NONE, [trophies(48, 48, true), trophies(50, 50, true), trophies(56, 56, true)]),
    ).toEqual({ unlocked: 154, total: 154, platinum: true, unsplit: false });
  });

  it('falls back to the collection’s own lump when no member has any', () => {
    // The owner's imported row: 154 achievements on the set, with no idea
    // which game earned them. Still shown — flagged rather than hidden.
    expect(rollUpTrophies(trophies(154, null), [NONE, NONE, NONE])).toEqual({
      unlocked: 154,
      total: null,
      platinum: false,
      unsplit: true,
    });
  });

  it('stops being unsplit the moment one member carries trophies', () => {
    // The precedence rule doing its job: no stored flag to go stale, the
    // fallback simply stops applying.
    const summary = rollUpTrophies(trophies(154, null), [trophies(48, 48), NONE, NONE]);
    expect(summary.unsplit).toBe(false);
    expect(summary.unlocked).toBe(48);
  });

  it('is not unsplit when the collection has nothing either', () => {
    expect(rollUpTrophies(NONE, [NONE])).toEqual({
      unlocked: null,
      total: null,
      platinum: false,
      unsplit: false,
    });
  });

  it('keeps null distinct from zero', () => {
    // "Nobody linked this to a trophy list" and "0 of 42 earned" are
    // different facts and must not collapse into each other.
    expect(rollUpTrophies(NONE, [NONE, NONE]).unlocked).toBeNull();
    expect(rollUpTrophies(NONE, [trophies(0, 42)]).unlocked).toBe(0);
  });

  it('sums only the members that have data, ignoring the untracked ones', () => {
    expect(rollUpTrophies(NONE, [trophies(48, 48), NONE, trophies(50, 50)]).unlocked).toBe(98);
  });

  it('needs EVERY member platinumed before the set counts as platinum', () => {
    expect(rollUpTrophies(NONE, [trophies(48, 48, true), trophies(20, 50, false)]).platinum).toBe(false);
    expect(rollUpTrophies(NONE, [trophies(48, 48, true), trophies(50, 50, true)]).platinum).toBe(true);
  });

  it('counts a platinum-only member as carrying data', () => {
    // `platinum` with no counts is a real state — the owner ticks it by hand.
    expect(rollUpTrophies(trophies(154, null), [trophies(null, null, true)]).unsplit).toBe(false);
  });
});

describe('trophyAdjustedRows', () => {
  function row(
    id: string,
    collectionId: string | null,
    t: { achievementsUnlocked: number | null; achievementsTotal: number | null; platinum: boolean },
  ) {
    return { id, collectionId, ...t };
  }

  it('zeroes a collection whose members carry the trophies', () => {
    // THE DOUBLE-COUNT. Members are still in the array carrying 48+50+56, so
    // the collection must contribute nothing or the same 154 is counted twice.
    const rows = [
      row('ndc', null, trophies(154, null)),
      row('uc1', 'ndc', trophies(48, 48, true)),
      row('uc2', 'ndc', trophies(50, 50, true)),
      row('uc3', 'ndc', trophies(56, 56, true)),
    ];

    const adjusted = trophyAdjustedRows(rows);
    const total = adjusted.reduce((sum, r) => sum + (r.achievementsUnlocked ?? 0), 0);

    expect(total).toBe(154);
    expect(adjusted.find((r) => r.id === 'ndc')?.achievementsUnlocked).toBeNull();
  });

  it('leaves an unsplit collection’s own figure in place', () => {
    // Nothing else holds these 154, so dropping them would lose real data.
    const rows = [
      row('ndc', null, trophies(154, null)),
      row('uc1', 'ndc', trophies(null, null, false)),
    ];

    const adjusted = trophyAdjustedRows(rows);
    expect(adjusted.find((r) => r.id === 'ndc')?.achievementsUnlocked).toBe(154);
    expect(adjusted.reduce((sum, r) => sum + (r.achievementsUnlocked ?? 0), 0)).toBe(154);
  });

  it('clears a rolled-up collection’s platinum so it is not counted twice', () => {
    const rows = [
      row('ndc', null, trophies(154, null, true)),
      row('uc1', 'ndc', trophies(48, 48, true)),
    ];
    expect(trophyAdjustedRows(rows).find((r) => r.id === 'ndc')?.platinum).toBe(false);
  });

  it('is a no-op for a library with no collections', () => {
    const rows = [row('a', null, trophies(10, 20)), row('b', null, trophies(5, 5, true))];
    expect(trophyAdjustedRows(rows)).toEqual(rows);
  });

  it('leaves standalone games untouched', () => {
    const rows = [
      row('ndc', null, trophies(154, null)),
      row('uc1', 'ndc', trophies(48, 48)),
      row('elden', null, trophies(42, 42, true)),
    ];
    expect(trophyAdjustedRows(rows).find((r) => r.id === 'elden')).toEqual(rows[2]);
  });
});
