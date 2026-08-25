import { describe, expect, it } from 'vitest';

import type { PsnPlayedTitle, PsnTrophyTitle } from '@/server/games/psn';
import { type StoredGameForPsnSync, planLinkedPsnGameChanges, planNewPsnGameChange } from '@/server/games/psn-plan';

function stored(overrides: Partial<StoredGameForPsnSync> = {}): StoredGameForPsnSync {
  return {
    id: 'g1',
    title: 'Bloodborne',
    platform: 'ps4',
    psnTitleId: 'CUSA00552_00',
    psnNpCommunicationId: 'NPWR10388_00',
    hoursTenths: 900,
    firstPlayedYear: 2015,
    lastPlayedAt: '2015-07-10T19:40:19.000Z',
    achievementsUnlocked: 30,
    achievementsTotal: 39,
    platinum: true,
    playYearTenths: null,
    ...overrides,
  };
}

function playedTitle(overrides: Partial<PsnPlayedTitle> = {}): PsnPlayedTitle {
  return {
    titleId: 'CUSA00552_00',
    name: 'Bloodborne',
    platform: 'ps4',
    hoursTenths: 900,
    firstPlayedYear: 2015,
    lastPlayedAt: '2015-07-10T19:40:19.000Z',
    ...overrides,
  };
}

function trophyTitle(overrides: Partial<PsnTrophyTitle> = {}): PsnTrophyTitle {
  return {
    npCommunicationId: 'NPWR10388_00',
    name: 'Bloodborne',
    earned: 30,
    total: 39,
    platinum: true,
    ...overrides,
  };
}

describe('planLinkedPsnGameChanges', () => {
  it('proposes nothing when PSN agrees with everything stored', () => {
    const changes = planLinkedPsnGameChanges(stored(), playedTitle(), trophyTitle());
    expect(changes).toEqual([]);
  });

  it('proposes a link with psnTitleId when the game had no PSN identity yet', () => {
    const changes = planLinkedPsnGameChanges(
      stored({ psnTitleId: null, psnNpCommunicationId: null }),
      playedTitle(),
      null,
    );
    const link = changes.find((c) => c.kind === 'link');
    expect(link).toBeDefined();
    expect(link?.payload).toEqual({ psnTitleId: 'CUSA00552_00' });
  });

  it('bundles psnTitleId and psnNpCommunicationId into ONE link when both are new', () => {
    const changes = planLinkedPsnGameChanges(
      stored({ psnTitleId: null, psnNpCommunicationId: null }),
      playedTitle(),
      trophyTitle(),
    );
    const linkChanges = changes.filter((c) => c.kind === 'link');
    expect(linkChanges).toHaveLength(1);
    expect(linkChanges[0]?.payload).toEqual({
      psnTitleId: 'CUSA00552_00',
      psnNpCommunicationId: 'NPWR10388_00',
    });
  });

  it('proposes a link with only psnNpCommunicationId when the title id was already stored', () => {
    const changes = planLinkedPsnGameChanges(
      stored({ psnTitleId: 'CUSA00552_00', psnNpCommunicationId: null }),
      playedTitle(),
      trophyTitle(),
    );
    const link = changes.find((c) => c.kind === 'link');
    expect(link?.payload).toEqual({ psnNpCommunicationId: 'NPWR10388_00' });
  });

  it('proposes no link at all once both identities are already stored', () => {
    const changes = planLinkedPsnGameChanges(stored(), playedTitle(), trophyTitle());
    expect(changes.some((c) => c.kind === 'link')).toBe(false);
  });

  it('proposes a field update when PSN hours differ from stored', () => {
    const changes = planLinkedPsnGameChanges(stored({ hoursTenths: 800 }), playedTitle({ hoursTenths: 900 }), null);
    const update = changes.find((c) => c.kind === 'field_update' && c.payload.field === 'hoursTenths');
    expect(update?.payload).toMatchObject({ field: 'hoursTenths', from: 800, to: 900 });
  });

  it('proposes a field update when stored hours are null', () => {
    const changes = planLinkedPsnGameChanges(stored({ hoursTenths: null }), playedTitle({ hoursTenths: 900 }), null);
    const update = changes.find((c) => c.kind === 'field_update' && c.payload.field === 'hoursTenths');
    expect(update?.payload).toMatchObject({ field: 'hoursTenths', from: null, to: 900 });
  });

  it('proposes a firstPlayedYear update only when PSN reports one that differs', () => {
    const changes = planLinkedPsnGameChanges(
      stored({ firstPlayedYear: 2014 }),
      playedTitle({ firstPlayedYear: 2015 }),
      null,
    );
    const update = changes.find((c) => c.kind === 'field_update' && c.payload.field === 'firstPlayedYear');
    expect(update?.payload).toMatchObject({ field: 'firstPlayedYear', from: 2014, to: 2015 });
  });

  it('proposes nothing for a null firstPlayedYear rather than clearing a stored one', () => {
    const changes = planLinkedPsnGameChanges(
      stored({ firstPlayedYear: 2014 }),
      playedTitle({ firstPlayedYear: null }),
      null,
    );
    expect(changes.some((c) => c.kind === 'field_update' && c.payload.field === 'firstPlayedYear')).toBe(false);
  });

  it('proposes a platform update when PSN resolves a category that differs from stored', () => {
    const changes = planLinkedPsnGameChanges(stored({ platform: 'ps4' }), playedTitle({ platform: 'ps5' }), null);
    const update = changes.find((c) => c.kind === 'field_update' && c.payload.field === 'platform');
    expect(update?.payload).toMatchObject({ field: 'platform', from: 'ps4', to: 'ps5' });
  });

  it('never proposes a platform update from a null category (e.g. pspc_game) rather than clearing the stored platform', () => {
    const changes = planLinkedPsnGameChanges(stored({ platform: 'ps4' }), playedTitle({ platform: null }), null);
    expect(changes.some((c) => c.kind === 'field_update' && c.payload.field === 'platform')).toBe(false);
  });

  it('proposes a lastPlayedAt update when PSN reports a different timestamp', () => {
    const changes = planLinkedPsnGameChanges(
      stored({ lastPlayedAt: '2020-01-01T00:00:00.000Z' }),
      playedTitle({ lastPlayedAt: '2026-08-01T00:00:00.000Z' }),
      null,
    );
    const update = changes.find((c) => c.kind === 'field_update' && c.payload.field === 'lastPlayedAt');
    expect(update?.payload).toMatchObject({
      field: 'lastPlayedAt',
      from: '2020-01-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    });
  });

  it('proposes achievement updates for each trophy count that differs', () => {
    const changes = planLinkedPsnGameChanges(
      stored({ achievementsUnlocked: 30, achievementsTotal: 39 }),
      playedTitle(),
      trophyTitle({ earned: 34, total: 39 }),
    );
    const fields = changes.filter((c) => c.kind === 'field_update').map((c) => c.payload['field']);
    expect(fields).toEqual(['achievementsUnlocked']);
  });

  it('proposes nothing trophy-shaped when no confident trophy title matched, even with differing stored counts', () => {
    // A title with no confident trophy match gets its play data and NO
    // trophy data — this must never be read as "zero trophies."
    const changes = planLinkedPsnGameChanges(
      stored({ achievementsUnlocked: 30, achievementsTotal: 39, platinum: true }),
      playedTitle(),
      null,
    );
    expect(changes.some((c) => c.payload['field'] === 'achievementsUnlocked')).toBe(false);
    expect(changes.some((c) => c.payload['field'] === 'achievementsTotal')).toBe(false);
    expect(changes.some((c) => c.payload['field'] === 'platinum')).toBe(false);
  });

  it('proposes a platinum update when PSN reports a platinum status that differs from stored', () => {
    const changes = planLinkedPsnGameChanges(
      stored({ platinum: false }),
      playedTitle(),
      trophyTitle({ platinum: true }),
    );
    const update = changes.find((c) => c.kind === 'field_update' && c.payload.field === 'platinum');
    expect(update?.payload).toMatchObject({ field: 'platinum', from: false, to: true });
  });

  it('proposes no platinum update when the matched trophy title agrees with stored', () => {
    const changes = planLinkedPsnGameChanges(stored({ platinum: true }), playedTitle(), trophyTitle({ platinum: true }));
    expect(changes.some((c) => c.payload['field'] === 'platinum')).toBe(false);
  });

  it('raises a reconcile item when changing hours would strand an existing split', () => {
    const changes = planLinkedPsnGameChanges(
      stored({ hoursTenths: 900, playYearTenths: 900 }),
      playedTitle({ hoursTenths: 950 }),
      null,
    );
    const reconcile = changes.find((c) => c.kind === 'reconcile');
    expect(reconcile?.payload).toMatchObject({ splitTenths: 900, newTotalTenths: 950, differenceTenths: 50 });
  });

  it('raises no reconcile item when the game has no split', () => {
    const changes = planLinkedPsnGameChanges(
      stored({ hoursTenths: 900, playYearTenths: null }),
      playedTitle({ hoursTenths: 950 }),
      null,
    );
    expect(changes.some((c) => c.kind === 'reconcile')).toBe(false);
  });

  it('raises no reconcile item when hours are unchanged, even with a split present', () => {
    const changes = planLinkedPsnGameChanges(
      stored({ hoursTenths: 900, playYearTenths: 900 }),
      playedTitle({ hoursTenths: 900 }),
      null,
    );
    expect(changes).toEqual([]);
  });

  it('carries the game id and title on every change it produces', () => {
    const changes = planLinkedPsnGameChanges(
      stored({ id: 'g9', title: 'Demon’s Souls', psnTitleId: null, psnNpCommunicationId: null, hoursTenths: 100 }),
      playedTitle({ hoursTenths: 400 }),
      trophyTitle({ earned: 10, total: 40 }),
    );
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change.gameId).toBe('g9');
      expect(change.title).toBe('Demon’s Souls');
    }
  });
});

describe('planNewPsnGameChange', () => {
  it('describes a PSN-owned title with no library row, including trophy data when matched', () => {
    const change = planNewPsnGameChange(
      playedTitle({ titleId: 'CUSA99999_00', name: 'Returnal', platform: 'ps5', hoursTenths: 300, firstPlayedYear: 2023 }),
      trophyTitle({ npCommunicationId: 'NPWR99999_00', earned: 12, total: 48, platinum: false }),
    );

    expect(change.kind).toBe('new_game');
    expect(change.gameId).toBeNull();
    expect(change.title).toBe('Returnal');
    expect(change.payload).toMatchObject({
      psnTitleId: 'CUSA99999_00',
      hoursTenths: 300,
      platform: 'ps5',
      firstPlayedYear: 2023,
      psnNpCommunicationId: 'NPWR99999_00',
      achievementsUnlocked: 12,
      achievementsTotal: 48,
      platinum: false,
    });
  });

  it('omits trophy fields entirely when no confident trophy title matched', () => {
    const change = planNewPsnGameChange(playedTitle({ titleId: 'CUSA11111_00', name: 'Some Demo' }), null);

    expect(change.payload).not.toHaveProperty('psnNpCommunicationId');
    expect(change.payload).not.toHaveProperty('achievementsUnlocked');
    expect(change.payload).not.toHaveProperty('achievementsTotal');
    expect(change.payload).not.toHaveProperty('platinum');
  });

  it('omits platform when PSN resolved no usable category', () => {
    const change = planNewPsnGameChange(playedTitle({ platform: null }), null);
    expect(change.payload).not.toHaveProperty('platform');
  });

  it('records zero hours for a never-played owned title rather than omitting them', () => {
    const change = planNewPsnGameChange(playedTitle({ hoursTenths: 0 }), null);
    expect(change.payload).toMatchObject({ hoursTenths: 0 });
  });
});
