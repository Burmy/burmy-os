/**
 * What a PSN sync run PROPOSES to change — pure, and deliberately separate
 * from what it eventually writes. Mirrors `sync-plan.ts` (the Steam planner)
 * on purpose: this module produces the exact same `PlannedChange` shape so
 * the existing review screen (`src/features/games/sync/sync-review.tsx`)
 * renders PSN's proposals with no changes of its own to that shape.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `platinum` IS WRITTEN BY PSN, AND ONLY BY PSN — THIS DELIBERATELY REVERSES
 * THE STEAM SYNC'S "NEVER TOUCH PLATINUM" RULE
 *
 * `sync-plan.ts`'s Steam planner never proposes a `platinum` change: Steam
 * has no platinum concept at all, so `commitSyncRun`'s Steam-era whitelist
 * never touched the column and the owner's own manually-recorded flag was
 * the only source of truth. PlayStation's trophy system is the ACTUAL system
 * of record for platinum trophies — Sony, not the owner's memory, knows
 * whether a platinum was earned — so this module is the one and only place
 * in the sync feature that stages a `platinum` change, gated on a confident
 * trophy-title match (see below). Do not "fix" this by making the two
 * planners symmetric; they are correct to disagree, for different games.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TROPHY DATA IS MATCHED BY NAME, NEVER BY ID
 *
 * `titleId` (played-games data) and `npCommunicationId` (trophy data) are
 * two separate identifier spaces with no join key between them but the
 * title's NAME — see `src/server/games/psn.ts`'s module header. The caller
 * (`src/features/games/sync/psn-actions.ts`) resolves that name match with
 * `bestTitleMatchAmong` (`src/server/games/metadata.ts`), which enforces
 * `SIMILARITY_FLOOR`, and passes the result in here as `trophyTitle: null`
 * when nothing confident was found. This module never lowers or re-derives
 * that floor, and never treats a `null` trophy title as "zero trophies" —
 * every trophy-shaped proposal below is gated on `trophyTitle !== null`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { normalizeGameTitle } from './metadata';
import type { PsnPlayedTitle, PsnTrophyTitle } from './psn';
import type { PlannedChange, SyncChangeKind } from './sync-plan';
import type { GamePlatform } from './taxonomy';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG 3a — PSN LEGITIMATELY RETURNS THE SAME REAL GAME MORE THAN ONCE
 *
 * Verified live: "Ghost of Tsushima" appeared THREE times for the owner —
 * `CUSA11456_00` (107h), `CUSA18331_00` (53min), `CUSA18376_00` (2min), all
 * `ps4_game` — edition/regional variants under the same PSN account. Left
 * undeduped, a title with no existing library row stages a SEPARATE
 * `new_game` change per variant (`planNewPsnGameChange` below has no way to
 * know they're "the same" — it only ever sees one title at a time), and the
 * `games_owner_title_platform_idx` unique index — `(owner_id, lower(title),
 * platform)` — means the first insert at commit succeeds and the second
 * throws. That is the exact `500` the owner hit: `insert into "games"`,
 * params naming "Ghost of Tsushima, ps4".
 *
 * `dedupePlayedTitles` runs ONCE, at staging time (`startPsnSyncAction`,
 * before the run's snapshot is stored), so every later consumer — the
 * per-chunk matching loop and the end-of-run `new_game` sweep alike — only
 * ever sees one entry per real game. This is a DIFFERENT problem from the
 * one `src/server/db/games/sync.ts`'s `commitSyncRun` also had to guard
 * against (Bug 3b): a stale RUN whose `new_game` proposal collides with a
 * row a *different*, later-committed run already created. This function
 * only collapses duplicates WITHIN one run's own snapshot.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Collapses played titles that share a normalized name AND platform down to
 * ONE entry — the one with the most playtime (`hoursTenths`), on the theory
 * that the variant with real hours on it is the one the owner actually
 * means, not a launch-window demo click or a regional re-list. See the
 * module-level comment above for the live evidence.
 *
 * Keyed by `(platform, normalizeGameTitle(name))`, not `titleId` — the
 * title ID is exactly what makes each variant look distinct in the first
 * place. `platform` (nullable) is part of the key because the unique index
 * this guards against is itself scoped by platform: two titles with the
 * same name but a genuinely different platform are never the same library
 * row, so they must never collapse into one. Reuses `normalizeGameTitle`
 * (`metadata.ts`) rather than a bespoke lowercase+trim, since that is
 * already this codebase's one normalization for "is this the same game
 * title" comparisons.
 *
 * Map iteration order preserves each surviving key's FIRST-SEEN position —
 * a cosmetic property (this module and its callers never depend on played-
 * title order), not a documented contract.
 */
export function dedupePlayedTitles(titles: readonly PsnPlayedTitle[]): PsnPlayedTitle[] {
  const bestByKey = new Map<string, PsnPlayedTitle>();

  for (const title of titles) {
    const key = `${title.platform ?? ''} ${normalizeGameTitle(title.name)}`;
    const existing = bestByKey.get(key);
    if (existing === undefined || title.hoursTenths > existing.hoursTenths) {
      bestByKey.set(key, title);
    }
  }

  return [...bestByKey.values()];
}

/** The narrow projection of a library row this module needs. */
export interface StoredGameForPsnSync {
  readonly id: string;
  readonly title: string;
  readonly platform: GamePlatform;
  readonly psnTitleId: string | null;
  readonly psnNpCommunicationId: string | null;
  readonly hoursTenths: number | null;
  readonly firstPlayedYear: number | null;
  /** ISO 8601, matching `PsnPlayedTitle.lastPlayedAt` — the caller converts the stored `Date` once, here. */
  readonly lastPlayedAt: string | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly platinum: boolean;
  /**
   * Sum of this game's `game_play_years` rows, or `null` when it has none.
   * Identical role to `StoredGameForSync.playYearTenths` in `sync-plan.ts`.
   */
  readonly playYearTenths: number | null;
}

/**
 * Every change one already-matched library game would receive.
 *
 * `playedTitle` is required — the caller only calls this once it has
 * resolved one (by stored `psnTitleId` if already linked, otherwise by a
 * confident title match; see `psn-actions.ts`). `trophyTitle` is `null`
 * whenever no confident name match was found — that is a correct, expected
 * outcome (a PSP game, or a played title PSN's trophy list genuinely has no
 * counterpart for), never a reason to write zeros.
 */
export function planLinkedPsnGameChanges(
  stored: StoredGameForPsnSync,
  playedTitle: PsnPlayedTitle,
  trophyTitle: PsnTrophyTitle | null,
): PlannedChange[] {
  const changes: PlannedChange[] = [];
  const describe = (kind: SyncChangeKind, payload: Record<string, unknown>): PlannedChange => ({
    kind,
    gameId: stored.id,
    title: stored.title,
    payload,
  });

  // `link` carries whichever identity field(s) are being set for the FIRST
  // time this run — either or both, in one change, so the review screen
  // shows one row per game rather than two near-duplicate ones.
  const linkPayload: Record<string, unknown> = {};
  if (stored.psnTitleId === null) linkPayload.psnTitleId = playedTitle.titleId;
  if (stored.psnNpCommunicationId === null && trophyTitle !== null) {
    linkPayload.psnNpCommunicationId = trophyTitle.npCommunicationId;
  }
  if (Object.keys(linkPayload).length > 0) changes.push(describe('link', linkPayload));

  if (playedTitle.hoursTenths !== stored.hoursTenths) {
    changes.push(
      describe('field_update', { field: 'hoursTenths', from: stored.hoursTenths, to: playedTitle.hoursTenths }),
    );

    // Changing the total leaves any existing per-year split accounting for
    // the OLD number — identical rule to the Steam planner's own reconcile.
    if (stored.playYearTenths !== null && stored.playYearTenths !== playedTitle.hoursTenths) {
      changes.push(
        describe('reconcile', {
          splitTenths: stored.playYearTenths,
          newTotalTenths: playedTitle.hoursTenths,
          differenceTenths: playedTitle.hoursTenths - stored.playYearTenths,
        }),
      );
    }
  }

  // `null` from `categoryToPlatform`/`firstPlayedDateTime`/`lastPlayedDateTime`
  // means "PSN did not tell us something we can use," never "the value is
  // empty" — every proposal below is gated on a non-null PSN value, the same
  // discipline `sync-plan.ts` applies to a `null` Steam field.
  if (playedTitle.firstPlayedYear !== null && playedTitle.firstPlayedYear !== stored.firstPlayedYear) {
    changes.push(
      describe('field_update', {
        field: 'firstPlayedYear',
        from: stored.firstPlayedYear,
        to: playedTitle.firstPlayedYear,
      }),
    );
  }

  if (playedTitle.platform !== null && playedTitle.platform !== stored.platform) {
    changes.push(describe('field_update', { field: 'platform', from: stored.platform, to: playedTitle.platform }));
  }

  if (playedTitle.lastPlayedAt !== null && playedTitle.lastPlayedAt !== stored.lastPlayedAt) {
    changes.push(
      describe('field_update', { field: 'lastPlayedAt', from: stored.lastPlayedAt, to: playedTitle.lastPlayedAt }),
    );
  }

  if (trophyTitle !== null) {
    if (trophyTitle.earned !== stored.achievementsUnlocked) {
      changes.push(
        describe('field_update', {
          field: 'achievementsUnlocked',
          from: stored.achievementsUnlocked,
          to: trophyTitle.earned,
        }),
      );
    }
    if (trophyTitle.total !== stored.achievementsTotal) {
      changes.push(
        describe('field_update', { field: 'achievementsTotal', from: stored.achievementsTotal, to: trophyTitle.total }),
      );
    }
    // See the module header — PSN, and only PSN, may write this column.
    if (trophyTitle.platinum !== stored.platinum) {
      changes.push(describe('field_update', { field: 'platinum', from: stored.platinum, to: trophyTitle.platinum }));
    }
  }

  return changes;
}

/**
 * A PSN played title with no library row at all.
 *
 * Staged, never inserted directly — like every other change it waits for
 * the owner's approval. Unlike Steam's `planNewGameChange`, trophy matching
 * for a brand-new game costs nothing extra to attempt here: both played
 * titles and trophy titles were already fetched ONCE for the whole run (no
 * per-game API call the way Steam's achievement fetch is), so there is no
 * reason to withhold it the way Steam withholds achievements from a new row.
 */
export function planNewPsnGameChange(playedTitle: PsnPlayedTitle, trophyTitle: PsnTrophyTitle | null): PlannedChange {
  const payload: Record<string, unknown> = {
    psnTitleId: playedTitle.titleId,
    hoursTenths: playedTitle.hoursTenths,
    ...(playedTitle.platform !== null ? { platform: playedTitle.platform } : {}),
    ...(playedTitle.firstPlayedYear !== null ? { firstPlayedYear: playedTitle.firstPlayedYear } : {}),
    ...(playedTitle.lastPlayedAt !== null ? { lastPlayedAt: playedTitle.lastPlayedAt } : {}),
    ...(trophyTitle !== null
      ? {
          psnNpCommunicationId: trophyTitle.npCommunicationId,
          achievementsUnlocked: trophyTitle.earned,
          achievementsTotal: trophyTitle.total,
          platinum: trophyTitle.platinum,
        }
      : {}),
  };

  return { kind: 'new_game', gameId: null, title: playedTitle.name, payload };
}
