import { describe, expect, it } from 'vitest';

import {
  FILL_COLUMNS,
  describeMerge,
  fillsFor,
  isLocalDatabaseUrl,
  isSynced,
  parseArgs,
  planMerges,
  titleKey,
} from '../../scripts/merge-duplicate-games.mjs';

/**
 * These test the duplicate-merge script's pure helpers. `main()` (database,
 * transactions, DELETE) is exercised by running the script itself against a
 * local database — the same split games-sync-steam-library.test.ts uses.
 *
 * This script is the only one in `scripts/` that deletes rows, so the tests
 * that matter most here are the ones asserting what it REFUSES to touch.
 */

interface Row {
  id: string;
  title: string;
  platform: string;
  platinum: boolean;
  steam_appid: number | null;
  psn_title_id: string | null;
  psn_np_communication_id: string | null;
  [column: string]: unknown;
}

function row(overrides: Partial<Row> & { id: string; title: string }): Row {
  const base: Row = {
    platform: 'ps4',
    platinum: false,
    steam_appid: null,
    psn_title_id: null,
    psn_np_communication_id: null,
    ...(overrides as Partial<Row> & { id: string; title: string }),
  } as Row;
  for (const column of FILL_COLUMNS) {
    if (!(column in base)) base[column] = null;
  }
  return base;
}

const TITLE = 'Uncharted 4: A Thief’s End';

/** The real shape: a hand-typed row with the price, and a PSN-linked row with the hours. */
function pair(overrides: { typed?: Partial<Row>; synced?: Partial<Row> } = {}): Row[] {
  return [
    row({ id: 'typed', title: TITLE, price_cents: 5999, rating: 5, ...overrides.typed }),
    row({
      id: 'synced',
      title: "Uncharted 4: A Thief's End",
      psn_title_id: 'CUSA00341',
      hours_tenths: 220,
      ...overrides.synced,
    }),
  ];
}

describe('isLocalDatabaseUrl', () => {
  it('accepts loopback and rejects everything else', () => {
    expect(isLocalDatabaseUrl('postgres://u:p@localhost:5432/db')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://u:p@db.supabase.co:5432/db')).toBe(false);
    expect(isLocalDatabaseUrl('nonsense')).toBe(false);
  });
});

describe('parseArgs', () => {
  it('defaults to a report', () => {
    expect(parseArgs(['node', 'merge.mjs', 'owner@example.com'])).toEqual({
      ownerEmail: 'owner@example.com',
      apply: false,
      remote: false,
    });
  });

  it('reads both write flags in any order', () => {
    expect(parseArgs(['node', 'merge.mjs', '--remote', 'owner@example.com', '--apply'])).toEqual({
      ownerEmail: 'owner@example.com',
      apply: true,
      remote: true,
    });
  });
});

describe('isSynced', () => {
  it('is true for any of the three sync identifiers', () => {
    expect(isSynced(row({ id: 'a', title: 'A', steam_appid: 1 }))).toBe(true);
    expect(isSynced(row({ id: 'a', title: 'A', psn_title_id: 'CUSA1' }))).toBe(true);
    expect(isSynced(row({ id: 'a', title: 'A', psn_np_communication_id: 'NPWR1' }))).toBe(true);
  });

  it('is false for a hand-typed row', () => {
    expect(isSynced(row({ id: 'a', title: 'A' }))).toBe(false);
  });
});

describe('fillsFor', () => {
  it('carries only the columns the winner is missing', () => {
    const [typed, synced] = pair();
    expect(fillsFor(synced, typed)).toEqual({ price_cents: 5999, rating: 5 });
  });

  it('never replaces a value the sync already wrote', () => {
    const [typed, synced] = pair({ typed: { hours_tenths: 999 }, synced: { hours_tenths: 220 } });
    expect(fillsFor(synced, typed)).not.toHaveProperty('hours_tenths');
  });

  it('fills hours when the synced row has none of its own', () => {
    const [typed, synced] = pair({ typed: { hours_tenths: 999 }, synced: { hours_tenths: null } });
    expect(fillsFor(synced, typed).hours_tenths).toBe(999);
  });

  it("ORs platinum rather than treating false as a value to keep", () => {
    const [typed, synced] = pair({ typed: { platinum: true } });
    expect(fillsFor(synced, typed).platinum).toBe(true);
  });

  it('leaves platinum alone when neither row has one', () => {
    const [typed, synced] = pair();
    expect(fillsFor(synced, typed)).not.toHaveProperty('platinum');
  });
});

describe('planMerges', () => {
  it('merges a hand-typed row into its synced twin', () => {
    const { merges, review } = planMerges(pair());
    expect(review).toEqual([]);
    expect(merges).toHaveLength(1);
    expect(merges[0]?.winner.id).toBe('synced');
    expect(merges[0]?.loser.id).toBe('typed');
  });

  it('matches through the curly apostrophe a spreadsheet inserts', () => {
    // The two titles in `pair()` differ only by U+2019 vs an ASCII quote —
    // which is exactly how this duplicate came to exist.
    expect(titleKey(TITLE)).toBe(titleKey("Uncharted 4: A Thief's End"));
    expect(planMerges(pair()).merges).toHaveLength(1);
  });

  it('leaves a same-title pair on different platforms alone', () => {
    const rows = pair({ synced: { platform: 'ps5' } });
    const { merges, review } = planMerges(rows);
    expect(merges).toEqual([]);
    expect(review).toEqual([]);
  });

  it('refuses a group of three', () => {
    const rows = [...pair(), row({ id: 'third', title: TITLE })];
    const { merges, review } = planMerges(rows);
    expect(merges).toEqual([]);
    expect(review[0]).toContain('3 rows share this title');
  });

  it('refuses a pair where neither copy is synced', () => {
    const rows = pair({ synced: { psn_title_id: null } });
    const { merges, review } = planMerges(rows);
    expect(merges).toEqual([]);
    expect(review[0]).toContain('neither copy is linked');
  });

  it('refuses a pair where both copies are synced', () => {
    const rows = pair({ typed: { steam_appid: 12345 } });
    const { merges, review } = planMerges(rows);
    expect(merges).toEqual([]);
    expect(review[0]).toContain('both copies are linked');
  });

  it('refuses to delete a row that holds collection members', () => {
    const { merges, review } = planMerges(pair(), { holdsMembers: new Set(['typed']) });
    expect(merges).toEqual([]);
    expect(review[0]).toContain('holds collection members');
  });

  it('refuses to delete a row that has trophy rows of its own', () => {
    const { merges, review } = planMerges(pair(), { hasTrophies: new Set(['typed']) });
    expect(merges).toEqual([]);
    expect(review[0]).toContain('trophy rows of its own');
  });

  it('finds nothing in a library with no duplicates', () => {
    const rows = [row({ id: 'a', title: 'Elden Ring' }), row({ id: 'b', title: 'Bloodborne' })];
    expect(planMerges(rows)).toEqual({ merges: [], review: [] });
  });
});

describe('describeMerge', () => {
  it('names the columns being carried across', () => {
    const [merge] = planMerges(pair()).merges;
    expect(describeMerge(merge)).toContain('carrying price_cents, rating');
  });

  it('says so plainly when there is nothing to carry', () => {
    const rows = pair({ typed: { price_cents: null, rating: null } });
    const [merge] = planMerges(rows).merges;
    expect(describeMerge(merge)).toContain('nothing to carry over');
  });
});
