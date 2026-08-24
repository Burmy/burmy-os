/**
 * What a Steam sync run PROPOSES to change — pure, and deliberately separate
 * from what it eventually writes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `steamSyncFieldsToFill`
 *
 * `src/server/games/steam.ts`'s `steamSyncFieldsToFill` fills only columns that
 * are currently NULL, because the CLI script's contract is "never overwrite what
 * the owner typed." The in-app sync has the opposite contract, chosen
 * deliberately: for a game linked to a Steam app, Steam OWNS hours and
 * achievement counts, the editor renders them read-only, and a divergence is
 * proposed as an update.
 *
 * Both rules are correct for their own caller. Do not unify them, and do not
 * change `steamSyncFieldsToFill` — the script still ships and still fills nulls.
 *
 * This module cannot live in `steam.ts` regardless: that file is a
 * dependency-free LEAF so `scripts/sync-steam-library.mjs` can import it
 * directly under bare `node`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { minutesToHoursTenths } from './hours';
import type { AchievementCounts, OwnedSteamGame } from './steam';

export type SyncChangeKind = 'link' | 'field_update' | 'new_game' | 'reconcile';

/** The narrow projection of a library row this module needs. */
export interface StoredGameForSync {
  readonly id: string;
  readonly title: string;
  readonly steamAppid: number | null;
  readonly hoursTenths: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  /**
   * Sum of this game's `game_play_years` rows, or `null` when it has none.
   * Only used to decide whether changing the total strands an existing split —
   * this module never edits a split, it only reports that one needs attention.
   */
  readonly playYearTenths: number | null;
}

export interface PlannedChange {
  readonly kind: SyncChangeKind;
  /** Null only for `new_game`, which by definition has no library row yet. */
  readonly gameId: string | null;
  readonly title: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Every change one already-matched library game would receive.
 *
 * `null` from Steam means "Steam did not tell us," never "the value is zero."
 * A 400 from `GetPlayerAchievements` on an older title, or a missing playtime
 * field, must never be written as 0 — that would erase a real recorded count.
 * Hence every proposal below is gated on a non-null Steam value.
 */
export function planLinkedGameChanges(
  stored: StoredGameForSync,
  appid: number,
  achievements: AchievementCounts | null,
  steamHoursTenths: number | null,
): PlannedChange[] {
  const changes: PlannedChange[] = [];
  const describe = (kind: SyncChangeKind, payload: Record<string, unknown>): PlannedChange => ({
    kind,
    gameId: stored.id,
    title: stored.title,
    payload,
  });

  if (stored.steamAppid === null) {
    changes.push(describe('link', { steamAppid: appid }));
  }

  if (steamHoursTenths !== null && steamHoursTenths !== stored.hoursTenths) {
    changes.push(
      describe('field_update', { field: 'hoursTenths', from: stored.hoursTenths, to: steamHoursTenths }),
    );

    // Changing the total leaves any existing per-year split accounting for the
    // OLD number. The owner rebalances; the sync never guesses which year the
    // difference belongs to.
    if (stored.playYearTenths !== null && stored.playYearTenths !== steamHoursTenths) {
      changes.push(
        describe('reconcile', {
          splitTenths: stored.playYearTenths,
          newTotalTenths: steamHoursTenths,
          differenceTenths: steamHoursTenths - stored.playYearTenths,
        }),
      );
    }
  }

  if (achievements !== null) {
    if (achievements.unlocked !== stored.achievementsUnlocked) {
      changes.push(
        describe('field_update', {
          field: 'achievementsUnlocked',
          from: stored.achievementsUnlocked,
          to: achievements.unlocked,
        }),
      );
    }
    if (achievements.total !== stored.achievementsTotal) {
      changes.push(
        describe('field_update', {
          field: 'achievementsTotal',
          from: stored.achievementsTotal,
          to: achievements.total,
        }),
      );
    }
  }

  return changes;
}

/**
 * A Steam-owned game with no library row at all.
 *
 * Staged, never inserted directly — like every other change it waits for the
 * owner's approval. Achievements are deliberately NOT fetched for these: the
 * game does not exist yet, and one API call per unknown Steam title would
 * multiply a run's cost for rows the owner may well decline.
 */
export function planNewGameChange(owned: OwnedSteamGame): PlannedChange {
  return {
    kind: 'new_game',
    gameId: null,
    title: owned.name,
    payload: {
      steamAppid: owned.appid,
      hoursTenths: minutesToHoursTenths(owned.playtimeMinutes),
      platform: 'steam',
    },
  };
}
