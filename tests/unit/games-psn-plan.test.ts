import { describe, expect, it } from 'vitest';

import type { PsnPlayedTitle, PsnTrophyTitle } from '@/server/games/psn';
import {
  dedupePlayedTitles,
  planCollectionMemberTrophyChanges,
  planLinkedPsnGameChanges,
  resolvePsnSyncTargets,
  planNewPsnGameChange,
  type StoredGameForPsnSync,
} from '@/server/games/psn-plan';

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

// ─────────────────────────────────────────────────────────────────────────────
// BUG 3a — three real Ghost of Tsushima variants, verified live on the
// owner's account: CUSA11456_00 (107h), CUSA18331_00 (53min), CUSA18376_00
// (2min), all `ps4_game`. Undeduped, staging would propose three separate
// `new_game` changes for the same real game, and the second insert at
// commit would violate `games_owner_title_platform_idx` — the exact 500
// the owner hit.
// ─────────────────────────────────────────────────────────────────────────────
describe('dedupePlayedTitles', () => {
  const ghostA = playedTitle({ titleId: 'CUSA11456_00', name: 'Ghost of Tsushima', platform: 'ps4', hoursTenths: 1070 });
  const ghostB = playedTitle({ titleId: 'CUSA18331_00', name: 'Ghost of Tsushima', platform: 'ps4', hoursTenths: 9 });
  const ghostC = playedTitle({ titleId: 'CUSA18376_00', name: 'Ghost of Tsushima', platform: 'ps4', hoursTenths: 0 });

  it('collapses three same-name, same-platform variants down to the one with the most playtime', () => {
    const result = dedupePlayedTitles([ghostB, ghostC, ghostA]);
    expect(result).toEqual([ghostA]);
  });

  it('is order-independent — the highest-hours variant always wins regardless of input order', () => {
    expect(dedupePlayedTitles([ghostA, ghostB, ghostC])).toEqual([ghostA]);
    expect(dedupePlayedTitles([ghostC, ghostB, ghostA])).toEqual([ghostA]);
  });

  it('does not collapse the same name on two different platforms', () => {
    const ps4Version = playedTitle({ titleId: 'CUSA00001_00', name: 'Cyberpunk 2077', platform: 'ps4', hoursTenths: 100 });
    const ps5Version = playedTitle({ titleId: 'PPSA00001_00', name: 'Cyberpunk 2077', platform: 'ps5', hoursTenths: 50 });

    const result = dedupePlayedTitles([ps4Version, ps5Version]);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([ps4Version, ps5Version]));
  });

  it('normalizes name casing and whitespace before comparing, via normalizeGameTitle', () => {
    const a = playedTitle({ titleId: 'CUSA00001_00', name: 'GHOST OF TSUSHIMA', platform: 'ps4', hoursTenths: 200 });
    const b = playedTitle({ titleId: 'CUSA00002_00', name: 'ghost   of  tsushima', platform: 'ps4', hoursTenths: 5 });

    expect(dedupePlayedTitles([a, b])).toEqual([a]);
  });

  it('leaves distinctly-named titles untouched', () => {
    const a = playedTitle({ titleId: 'CUSA00001_00', name: 'Bloodborne', platform: 'ps4' });
    const b = playedTitle({ titleId: 'CUSA00002_00', name: 'Control', platform: 'ps4' });

    expect(dedupePlayedTitles([a, b])).toHaveLength(2);
  });

  it('returns [] for an empty list', () => {
    expect(dedupePlayedTitles([])).toEqual([]);
  });
});

/**
 * The trophy-only path for a title inside a collection.
 *
 * The rule this has to keep intact: a member is otherwise invisible to both
 * sync engines so the SET's hours can never be written onto one of its titles
 * and counted twice. Trophies are the one exception, because PSN itself gives
 * The Nathan Drake Collection three separate trophy lists and only one
 * cumulative playDuration. So what matters most below is everything this
 * planner REFUSES to propose.
 */
describe('planCollectionMemberTrophyChanges', () => {
  const member = (overrides: Partial<StoredGameForPsnSync> = {}): StoredGameForPsnSync =>
    stored({
      id: 'uc1',
      title: "Uncharted: Drake's Fortune Remastered",
      psnTitleId: null,
      psnNpCommunicationId: 'NPWR07784_00',
      hoursTenths: null,
      firstPlayedYear: null,
      lastPlayedAt: null,
      achievementsUnlocked: null,
      achievementsTotal: null,
      platinum: false,
      ...overrides,
    });

  it('proposes the three trophy columns and nothing else', () => {
    const changes = planCollectionMemberTrophyChanges(
      member(),
      trophyTitle({ npCommunicationId: 'NPWR07784_00', name: "Uncharted: Drake's Fortune", earned: 48, total: 48 }),
    );

    expect(changes.map((c) => c.payload.field)).toEqual([
      'achievementsUnlocked',
      'achievementsTotal',
      'platinum',
    ]);
  });

  it('NEVER proposes hours, and that is the whole safety property', () => {
    // Hours are the SET's — one purchase, one play time, no API can split
    // them. A member gaining an hours proposal is the double-count the
    // collection-blindness rule exists to prevent.
    const changes = planCollectionMemberTrophyChanges(member(), trophyTitle());
    expect(changes.some((c) => c.payload.field === 'hoursTenths')).toBe(false);
  });

  it('never proposes platform, lastPlayedAt, firstPlayedYear or a psnTitleId link', () => {
    const changes = planCollectionMemberTrophyChanges(member(), trophyTitle());
    const fields = changes.map((c) => c.payload.field);

    expect(fields).not.toContain('platform');
    expect(fields).not.toContain('lastPlayedAt');
    expect(fields).not.toContain('firstPlayedYear');
    // A member has no played title at all, so there is nothing to link it to.
    expect(changes.some((c) => c.kind === 'link')).toBe(false);
    expect(changes.some((c) => c.kind === 'reconcile')).toBe(false);
  });

  it('proposes nothing at all when PSN has no trophy list for it', () => {
    expect(planCollectionMemberTrophyChanges(member(), null)).toEqual([]);
  });

  it('proposes nothing when the stored counts already match', () => {
    const changes = planCollectionMemberTrophyChanges(
      member({ achievementsUnlocked: 48, achievementsTotal: 48, platinum: true }),
      trophyTitle({ earned: 48, total: 48, platinum: true }),
    );
    expect(changes).toEqual([]);
  });

  it('carries the member’s own id and title, not its collection’s', () => {
    const [change] = planCollectionMemberTrophyChanges(member(), trophyTitle({ earned: 48, total: 48 }));
    expect(change?.gameId).toBe('uc1');
    expect(change?.title).toBe("Uncharted: Drake's Fortune Remastered");
  });
});

/**
 * The member/non-member decision, extracted from the sync loop precisely so it
 * could be tested. While it lived inline in a Server Action a mutation that
 * flipped every member into a full name-matched sync passed the entire suite.
 */
describe('resolvePsnSyncTargets', () => {
  const NDC_PLAYED = playedTitle({
    titleId: 'CUSA02320_00',
    name: 'Uncharted: The Nathan Drake Collection',
    hoursTenths: 442,
  });
  const DF_TROPHIES = trophyTitle({
    npCommunicationId: 'NPWR07784_00',
    name: "Uncharted: Drake's Fortune Remastered",
    earned: 48,
    total: 48,
  });

  const memberRow = {
    title: "Uncharted: Drake's Fortune Remastered",
    platform: 'ps4' as const,
    psnTitleId: null,
    psnNpCommunicationId: 'NPWR07784_00',
    collectionId: 'ndc',
  };

  it('gives a member its own trophy list and NO played title', () => {
    expect(resolvePsnSyncTargets(memberRow, [NDC_PLAYED], [DF_TROPHIES])).toEqual({
      played: null,
      trophy: DF_TROPHIES,
    });
  });

  it('refuses to name-match a member against its own collection’s played title', () => {
    // THE PROPERTY. "Uncharted: Drake's Fortune Remastered" scores well
    // against "Uncharted: The Nathan Drake Collection", and a match would
    // stage the SET's 44.2h onto one of its three titles — the double-count
    // the collection-blindness rule exists to prevent.
    const result = resolvePsnSyncTargets(memberRow, [NDC_PLAYED], [DF_TROPHIES]);
    expect(result?.played).toBeNull();
  });

  it('skips a member with no trophy list of its own rather than falling back to a name match', () => {
    expect(
      resolvePsnSyncTargets({ ...memberRow, psnNpCommunicationId: null }, [NDC_PLAYED], [DF_TROPHIES]),
    ).toBeNull();
  });

  it('skips a member whose stored trophy id is not in this run’s snapshot', () => {
    expect(resolvePsnSyncTargets(memberRow, [NDC_PLAYED], [])).toBeNull();
  });

  it('still resolves a standalone game the normal way', () => {
    const standalone = {
      title: 'Bloodborne',
      platform: 'ps4' as const,
      psnTitleId: 'CUSA00552_00',
      psnNpCommunicationId: 'NPWR10388_00',
      collectionId: null,
    };
    const result = resolvePsnSyncTargets(standalone, [playedTitle()], [trophyTitle()]);
    expect(result?.played?.titleId).toBe('CUSA00552_00');
    expect(result?.trophy?.npCommunicationId).toBe('NPWR10388_00');
  });

  it('skips a standalone game PSN does not own', () => {
    const unowned = {
      title: 'Some Physical PS2 Game',
      platform: 'ps4' as const,
      psnTitleId: null,
      psnNpCommunicationId: null,
      collectionId: null,
    };
    expect(resolvePsnSyncTargets(unowned, [NDC_PLAYED], [])).toBeNull();
  });
});
