import { describe, expect, it } from 'vitest';

import {
  type StoredGameForSync,
  planLinkedGameChanges,
  planNewGameChange,
} from '@/server/games/sync-plan';

function stored(overrides: Partial<StoredGameForSync> = {}): StoredGameForSync {
  return {
    id: 'g1',
    title: 'Hollow Knight',
    steamAppid: 367520,
    hoursTenths: 490,
    achievementsUnlocked: 30,
    achievementsTotal: 63,
    playYearTenths: null,
    lastPlayedAt: null,
    ...overrides,
  };
}

describe('planLinkedGameChanges', () => {
  it('proposes nothing when Steam agrees with everything stored', () => {
    const changes = planLinkedGameChanges(stored(), 367520, { unlocked: 30, total: 63 }, 490);
    expect(changes).toEqual([]);
  });

  it('proposes a link when the game had no appid yet', () => {
    const changes = planLinkedGameChanges(
      stored({ steamAppid: null }),
      367520,
      { unlocked: 30, total: 63 },
      490,
    );
    const link = changes.find((c) => c.kind === 'link');
    expect(link).toBeDefined();
    expect(link?.payload).toMatchObject({ steamAppid: 367520 });
  });

  it('proposes a field update when Steam hours differ from stored', () => {
    const changes = planLinkedGameChanges(stored({ hoursTenths: 490 }), 367520, null, 510);
    const update = changes.find((c) => c.kind === 'field_update');
    expect(update?.payload).toMatchObject({ field: 'hoursTenths', from: 490, to: 510 });
  });

  it('proposes a field update when stored hours are null', () => {
    const changes = planLinkedGameChanges(stored({ hoursTenths: null }), 367520, null, 510);
    const update = changes.find((c) => c.kind === 'field_update');
    expect(update?.payload).toMatchObject({ field: 'hoursTenths', from: null, to: 510 });
  });

  it('proposes achievement updates for each count that differs', () => {
    const changes = planLinkedGameChanges(
      stored({ achievementsUnlocked: 30, achievementsTotal: 63 }),
      367520,
      { unlocked: 34, total: 63 },
      490,
    );
    const fields = changes.filter((c) => c.kind === 'field_update').map((c) => c.payload['field']);
    expect(fields).toEqual(['achievementsUnlocked']);
  });

  it('proposes NOTHING for a null achievements payload rather than writing zeros', () => {
    // A 400 from GetPlayerAchievements on an older title must never be read as
    // "this game has zero achievements" — that would wipe a real recorded count.
    const changes = planLinkedGameChanges(stored(), 367520, null, 490);
    expect(changes).toEqual([]);
  });

  it('proposes nothing for a null steam playtime rather than zeroing hours', () => {
    const changes = planLinkedGameChanges(stored(), 367520, { unlocked: 30, total: 63 }, null);
    expect(changes).toEqual([]);
  });

  it('raises a reconcile item when changing hours would strand an existing split', () => {
    // Stored total 490 with a split accounting for all 490. Steam says 510, so
    // the split now accounts for 20 tenths less than the total.
    const changes = planLinkedGameChanges(
      stored({ hoursTenths: 490, playYearTenths: 490 }),
      367520,
      null,
      510,
    );
    const reconcile = changes.find((c) => c.kind === 'reconcile');
    expect(reconcile?.payload).toMatchObject({
      splitTenths: 490,
      newTotalTenths: 510,
      differenceTenths: 20,
    });
  });

  it('raises no reconcile item when the game has no split', () => {
    const changes = planLinkedGameChanges(
      stored({ hoursTenths: 490, playYearTenths: null }),
      367520,
      null,
      510,
    );
    expect(changes.some((c) => c.kind === 'reconcile')).toBe(false);
  });

  it('raises no reconcile item when hours are unchanged, even with a split present', () => {
    const changes = planLinkedGameChanges(
      stored({ hoursTenths: 490, playYearTenths: 490 }),
      367520,
      null,
      490,
    );
    expect(changes).toEqual([]);
  });

  it('carries the game id and title on every change it produces', () => {
    const changes = planLinkedGameChanges(
      stored({ id: 'g9', title: 'Hades', steamAppid: null, hoursTenths: 100 }),
      1145360,
      { unlocked: 14, total: 49 },
      280,
    );
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change.gameId).toBe('g9');
      expect(change.title).toBe('Hades');
    }
  });
});

describe('planNewGameChange', () => {
  it('describes a Steam-owned game that has no library row', () => {
    const change = planNewGameChange({
      appid: 50,
      name: 'Half-Life: Opposing Force',
      playtimeMinutes: 438,
      lastPlayedAt: null,
    });

    expect(change.kind).toBe('new_game');
    expect(change.gameId).toBeNull();
    expect(change.title).toBe('Half-Life: Opposing Force');
    expect(change.payload).toMatchObject({ steamAppid: 50, hoursTenths: 73, platform: 'steam' });
  });

  it('records zero hours for a never-played owned game rather than omitting them', () => {
    const change = planNewGameChange({
      appid: 1449560,
      name: 'Metro Exodus Enhanced Edition',
      playtimeMinutes: 0,
      lastPlayedAt: null,
    });
    expect(change.payload).toMatchObject({ hoursTenths: 0 });
  });
});
