/**
 * Episodes and watch time — the ONLY module that converts between stored
 * numbers and anything a screen displays.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO STORED FACTS, EVERY OTHER FIGURE DERIVED.
 *
 *   progress      episodes into the CURRENT watch
 *   repeatCount   completed rewatches
 *
 *   episodes watched = progress + repeatCount x episodes
 *   minutes watched  = episodes watched x durationMinutes
 *
 * Neither total is stored, for the reason CLAUDE.md's first invariant gives
 * about money: a stored total is a second copy of a fact that can drift from
 * the thing it was derived from, and nothing arbitrates them when they
 * disagree.
 *
 * MINUTES ARE AN ESTIMATE AND ARE LABELLED AS ONE. `durationMinutes` is
 * AniList's average episode length for the show, not a measurement of what was
 * actually watched — openings skipped, a double-length finale, a recap episode
 * all move it. It is the right number to lead a stats page with and the wrong
 * number to reconcile anything against. Same containment rule as
 * `src/server/games/hours.ts` and `src/server/finance/money.ts`: all the
 * arithmetic lives here and nothing else does it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

declare const MINUTES: unique symbol;

/** A whole number of minutes. Branded so a raw `number` cannot be passed where a computed duration is expected. */
export type Minutes = number & { readonly [MINUTES]: true };

export function minutes(value: number): Minutes {
  if (!Number.isInteger(value)) throw new TypeError(`Minutes must be a whole number, got ${value}`);
  return value as Minutes;
}

/**
 * How many episodes have actually been watched, rewatches included.
 *
 * A rewatch of a 24-episode show is 24 more episodes of time genuinely spent —
 * the owner's explicit decision. `episodes` (the show's length) is what a
 * rewatch multiplies, and when AniList does not know it (an airing show with
 * no final count) a rewatch cannot be valued, so only current progress counts.
 * That under-reports rather than inventing a length, which is the right way to
 * be wrong.
 */
export function episodesWatched(
  progress: number,
  repeatCount: number,
  episodes: number | null,
): number {
  const safeProgress = Math.max(0, progress);
  const safeRepeats = Math.max(0, repeatCount);
  if (episodes === null || episodes <= 0) return safeProgress;
  return safeProgress + safeRepeats * episodes;
}

/**
 * Minutes watched, or `null` when the show's episode length is unknown.
 *
 * `null`, never `0`: a show with no duration recorded has an unknown watch
 * time, and reporting it as zero would quietly shrink every total it is summed
 * into. The same "missing data is excluded from an average, never counted as a
 * zero" rule the Games stats layer holds throughout.
 */
export function minutesWatched(
  progress: number,
  repeatCount: number,
  episodes: number | null,
  durationMinutes: number | null,
): Minutes | null {
  if (durationMinutes === null || durationMinutes <= 0) return null;
  return minutes(episodesWatched(progress, repeatCount, episodes) * durationMinutes);
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 60 * 24;

/**
 * A duration a person can feel: `"38d 4h"`, `"9h 36m"`, `"24m"`, `"0m"`.
 *
 * Two units at most, always the two largest that apply. "38 days, 4 hours and
 * 12 minutes" is not more informative than "38d 4h" — at that scale the
 * minutes are noise, and three units make a stat card wrap.
 */
export function formatRuntime(value: Minutes): string {
  const total = Math.max(0, value);

  const days = Math.floor(total / MINUTES_PER_DAY);
  const hours = Math.floor((total % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const mins = total % MINUTES_PER_HOUR;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** Sums durations, skipping the unknown ones. `null` only when NOTHING was known — never a fabricated zero. */
export function sumMinutes(values: readonly (Minutes | null)[]): Minutes | null {
  const known = values.filter((value): value is Minutes => value !== null);
  if (known.length === 0) return null;
  return minutes(known.reduce((total, value) => total + value, 0));
}

/**
 * How far through a show the current watch is, 0–100, or `null` when the show
 * has no known length.
 *
 * Deliberately ignores rewatches: this answers "how much of this is left",
 * which a third rewatch does not change. Clamped at 100 because AniList
 * occasionally carries progress above a stale episode count for an airing show.
 */
export function watchPercent(progress: number, episodes: number | null): number | null {
  if (episodes === null || episodes <= 0) return null;
  return Math.min(100, Math.max(0, (progress / episodes) * 100));
}
