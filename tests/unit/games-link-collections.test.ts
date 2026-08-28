import { describe, expect, it } from 'vitest';

import {
  buildPlan,
  carriesOwnFigures,
  isLocalDatabaseUrl,
  parseArgs,
  suggestMap,
  titleKey,
} from '../../scripts/link-game-collections.mjs';

/**
 * These test the collections backfill's pure helpers — CLI parsing, title
 * normalization, the plan builder, and the suggestion heuristic. `main()`
 * (database, filesystem) is exercised by running the script itself, the same
 * split games-sync-steam-library.test.ts uses.
 *
 * The Uncharted titles below are the real shape of the problem this script
 * exists for; every figure attached to them is invented.
 */

interface Row {
  id: string;
  title: string;
  collectionId: string | null;
  status: string;
  hoursTenths: number | null;
  priceCents: number | null;
  achievementsUnlocked: number | null;
  achievementsTotal: number | null;
  platinum: boolean;
}

function row(overrides: Partial<Row> & { id: string; title: string }): Row {
  return {
    collectionId: null,
    status: 'played',
    hoursTenths: null,
    priceCents: null,
    achievementsUnlocked: null,
    achievementsTotal: null,
    platinum: false,
    ...overrides,
  };
}

const COLLECTION = 'Uncharted: The Nathan Drake Collection';

function library(overrides: { members?: Partial<Row>[]; collection?: Partial<Row> } = {}): Row[] {
  const [a = {}, b = {}] = overrides.members ?? [];
  return [
    row({ id: 'ndc', title: COLLECTION, hoursTenths: 440, priceCents: 2999, ...overrides.collection }),
    row({ id: 'uc1', title: "Uncharted: Drake's Fortune Remastered", ...a }),
    row({ id: 'uc2', title: 'Uncharted 2: Among Thieves Remastered', ...b }),
  ];
}

const MAP = {
  [COLLECTION]: ["Uncharted: Drake's Fortune Remastered", 'Uncharted 2: Among Thieves Remastered'],
};

describe('isLocalDatabaseUrl', () => {
  it('accepts localhost, loopback IPv4, and bracketed loopback IPv6', () => {
    expect(isLocalDatabaseUrl('postgres://user:pass@localhost:5432/db')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://user:pass@127.0.0.1:5432/db')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://user:pass@[::1]:5432/db')).toBe(true);
  });

  it('rejects a remote host and fails closed on an unparsable string', () => {
    expect(isLocalDatabaseUrl('postgres://user:pass@db.supabase.co:5432/db')).toBe(false);
    expect(isLocalDatabaseUrl('not a url')).toBe(false);
  });
});

describe('parseArgs', () => {
  const argv = (...rest: string[]) => ['node', 'scripts/link-game-collections.mjs', ...rest];

  it('defaults to a dry run with no flags set', () => {
    expect(parseArgs(argv('owner@example.com', '--map', 'map.json'))).toEqual({
      ownerEmail: 'owner@example.com',
      mapPath: 'map.json',
      outPath: undefined,
      suggest: false,
      apply: false,
      remote: false,
    });
  });

  it('reads every flag regardless of order', () => {
    expect(parseArgs(argv('--apply', '--remote', 'owner@example.com', '--out', 'o.json', '--suggest'))).toEqual({
      ownerEmail: 'owner@example.com',
      mapPath: undefined,
      outPath: 'o.json',
      suggest: true,
      apply: true,
      remote: true,
    });
  });
});

describe('titleKey', () => {
  it('folds the transcription noise a title picks up in a spreadsheet', () => {
    expect(titleKey('  Uncharted:  Drake’s   Fortune  ')).toBe("uncharted: drake's fortune");
    expect(titleKey('Ratchet — Clank')).toBe('ratchet - clank');
  });

  it('keeps two genuinely different titles apart', () => {
    expect(titleKey('Uncharted 2')).not.toBe(titleKey('Uncharted 3'));
  });
});

describe('carriesOwnFigures', () => {
  it('is false for the sparse rows this backfill is meant to file', () => {
    expect(carriesOwnFigures(row({ id: 'a', title: 'A' }))).toBe(false);
  });

  it('is true for any of hours, price, achievements or platinum', () => {
    expect(carriesOwnFigures(row({ id: 'a', title: 'A', hoursTenths: 10 }))).toBe(true);
    expect(carriesOwnFigures(row({ id: 'a', title: 'A', priceCents: 1 }))).toBe(true);
    expect(carriesOwnFigures(row({ id: 'a', title: 'A', achievementsUnlocked: 0 }))).toBe(true);
    expect(carriesOwnFigures(row({ id: 'a', title: 'A', achievementsTotal: 0 }))).toBe(true);
    expect(carriesOwnFigures(row({ id: 'a', title: 'A', platinum: true }))).toBe(true);
  });
});

describe('buildPlan', () => {
  it('files every sparse member under its collection', () => {
    const plan = buildPlan(MAP, library());
    expect(plan.problems).toEqual([]);
    expect(plan.links.map((l) => [l.gameId, l.collectionId])).toEqual([
      ['uc1', 'ndc'],
      ['uc2', 'ndc'],
    ]);
  });

  it('matches titles through case, spacing and curly-quote differences', () => {
    const plan = buildPlan(
      { '  uncharted: THE nathan drake collection ': ["Uncharted: Drake’s Fortune Remastered"] },
      library(),
    );
    expect(plan.problems).toEqual([]);
    expect(plan.links.map((l) => l.gameId)).toEqual(['uc1']);
  });

  it('never guesses at a title it cannot resolve', () => {
    const plan = buildPlan({ [COLLECTION]: ['Uncharted 4'] }, library());
    expect(plan.links).toEqual([]);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toContain('no library row');
  });

  it('refuses an ambiguous title rather than picking one', () => {
    // The duplicate rows this codebase already has are exactly why: a fuzzy
    // pick here would file the wrong copy and move hours between two visible
    // rows.
    const rows = [...library(), row({ id: 'uc1-dupe', title: "Uncharted: Drake's Fortune Remastered" })];
    const plan = buildPlan(MAP, rows);
    expect(plan.links.map((l) => l.gameId)).toEqual(['uc2']);
    expect(plan.problems[0]).toContain('share that title');
  });

  it('skips a member that carries figures the collection is supposed to own', () => {
    const plan = buildPlan(MAP, library({ members: [{ hoursTenths: 120 }] }));
    expect(plan.links.map((l) => l.gameId)).toEqual(['uc2']);
    expect(plan.problems[0]).toContain('carries its own hours/price/trophies');
  });

  it('reports an already-filed row instead of writing it again', () => {
    const plan = buildPlan(MAP, library({ members: [{ collectionId: 'ndc' }] }));
    expect(plan.links.map((l) => l.gameId)).toEqual(['uc2']);
    expect(plan.alreadyLinked).toEqual([`Uncharted: Drake's Fortune Remastered → ${COLLECTION}`]);
    expect(plan.problems).toEqual([]);
  });

  it('refuses to move a row out of a different collection', () => {
    const plan = buildPlan(MAP, library({ members: [{ collectionId: 'other' }] }));
    expect(plan.links.map((l) => l.gameId)).toEqual(['uc2']);
    expect(plan.problems[0]).toContain('already in a different collection');
  });

  it('enforces the one-level rule against a collection that is itself a member', () => {
    const plan = buildPlan(MAP, library({ collection: { collectionId: 'elsewhere' } }));
    expect(plan.links).toEqual([]);
    expect(plan.problems[0]).toContain('cannot be nested');
  });

  it('enforces the one-level rule against a member that already holds games', () => {
    const rows = [...library(), row({ id: 'child', title: 'Child', collectionId: 'uc1' })];
    const plan = buildPlan(MAP, rows);
    expect(plan.links.map((l) => l.gameId)).toEqual(['uc2']);
    expect(plan.problems[0]).toContain('already holds games of its own');
  });

  it('refuses a row listed inside itself', () => {
    const plan = buildPlan({ [COLLECTION]: [COLLECTION] }, library());
    expect(plan.links).toEqual([]);
    expect(plan.problems[0]).toContain('listed inside itself');
  });

  it('notes a status mismatch without changing it', () => {
    const plan = buildPlan(MAP, library({ members: [{ status: 'backlog' }] }));
    expect(plan.links.map((l) => l.gameId)).toEqual(['uc1', 'uc2']);
    expect(plan.notes[0]).toContain('backlog');
    expect(plan.notes[0]).toContain('does not change a status');
  });
});

describe('suggestMap', () => {
  it('proposes a group for a title that names itself a collection', () => {
    const suggestion = suggestMap(library());
    expect(Object.keys(suggestion)).toEqual([COLLECTION]);
    expect(suggestion[COLLECTION]).toEqual([
      'Uncharted 2: Among Thieves Remastered',
      "Uncharted: Drake's Fortune Remastered",
    ]);
  });

  it('proposes nothing when no title names itself a collection', () => {
    expect(suggestMap([row({ id: 'a', title: 'Elden Ring' })])).toEqual({});
  });

  it('does not list one candidate collection inside another', () => {
    const rows = [
      ...library(),
      row({ id: 'ugc', title: 'Uncharted: The Greatest Hits Collection' }),
    ];
    const suggestion = suggestMap(rows);
    expect(suggestion[COLLECTION]).not.toContain('Uncharted: The Greatest Hits Collection');
  });
});
