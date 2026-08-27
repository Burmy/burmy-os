/**
 * The unified trophy/achievement shape, shared by PlayStation and Steam.
 *
 * Pure and framework-free, like every other module under `src/server/games/`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS TYPE LIVES HERE AND NOT IN `psn.ts`.
 *
 * It used to live in `psn.ts`, whose own comment already anticipated this move
 * ("the one field a hypothetical future Steam achievement source would also
 * carry"). Now that Steam achievements are persisted alongside PSN trophies in
 * one table, neither source module can own the shape: `psn.ts` has no business
 * describing Steam data, and `steam.ts` must not gain an import at all — it is
 * a dependency-free LEAF so `scripts/sync-steam-library.mjs` can `node`-import
 * it directly (see `sync-plan.ts`'s header for the full reasoning).
 *
 * So `steam.ts` keeps its own `SteamAchievement` shape and the mapping into
 * this one happens a layer up, in the sync action that already imports both.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type TrophySource = 'psn' | 'steam';

/** PlayStation only. Steam has no tier concept and inventing one would misrepresent its data. */
export type TrophyTier = 'bronze' | 'silver' | 'gold' | 'platinum';

const TROPHY_TIERS: readonly TrophyTier[] = ['bronze', 'silver', 'gold', 'platinum'];

export function isTrophyTier(value: unknown): value is TrophyTier {
  return typeof value === 'string' && (TROPHY_TIERS as readonly string[]).includes(value);
}

export interface Trophy {
  readonly source: TrophySource;
  /** PSN `trophyId`, or Steam `apiname`. Unique only WITHIN one game — see the table's unique index. */
  readonly id: string;
  /** PSN `trophyGroupId` (`"default"` for the base game, `"001"`/`"002"`… for DLC). Null for Steam. */
  readonly groupId: string | null;
  /** Null for Steam. */
  readonly tier: TrophyTier | null;
  readonly hidden: boolean;
  readonly name: string | null;
  readonly description: string | null;
  readonly iconUrl: string | null;
  readonly earned: boolean;
  /** ISO 8601, and null whenever `earned` is false. */
  readonly earnedAt: string | null;
  /** Tenths of a percent — `225` is 22.5%. See `rarityToTenths`. */
  readonly rarityTenths: number | null;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * RARITY IS TENTHS OF A PERCENT, IN AN INTEGER. NOTHING ELSE DOES THIS MATH.
 *
 * Both APIs hand back a one-decimal STRING — PSN `trophyEarnedRate: "22.5"`,
 * Steam `percent: "76.8"`. Storing that as `NUMERIC` is forbidden by CLAUDE.md
 * for the reason that bites everywhere: the `pg` driver returns `NUMERIC` as a
 * string, and the `parseFloat` that inevitably follows is the exact class of
 * bug this project exists to avoid. Games already solved the identical problem
 * for play time (`hours.ts`, tenths of an hour in an integer); rarity gets the
 * same treatment and the same containment rule — conversion happens in this
 * module and nowhere else.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Percent -> tenths. `null` for anything that isn't a real percentage, never
 * `0` — "unreported" and "nobody on earth has this" are different facts, and
 * conflating them would sort every unknown-rarity trophy to the very top of
 * the "rarest earned" list, ahead of the genuinely rare ones.
 *
 * The empty string is checked explicitly because `Number('')` is `0`, not
 * `NaN` — a `Number.isFinite` guard alone silently turns a missing value into
 * a confident 0%. Caught by this module's own test, not by review.
 */
export function rarityToTenths(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(raw) || raw < 0 || raw > 100) return null;
  return Math.round(raw * 10);
}

/** Tenths -> a display string, one decimal place. `formatRarity(225)` is `"22.5%"`. */
export function formatRarity(rarityTenths: number | null): string | null {
  if (rarityTenths === null) return null;
  return `${(rarityTenths / 10).toFixed(1)}%`;
}

/**
 * Steam's `unlocktime` is Unix SECONDS, with `0` meaning "never unlocked"
 * rather than 1970 — the identical sentinel `rtime_last_played` uses in
 * `steam.ts`. Reading it as a real timestamp would date every locked
 * achievement to 1970 and pollute "earned recently" with the whole library.
 */
export function unlockTimeToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const at = new Date(value * 1000);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** How many trophies remain before a title is complete. */
export function remainingCount(earned: number, total: number): number {
  return Math.max(0, total - earned);
}
