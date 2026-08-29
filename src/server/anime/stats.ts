/**
 * Every number the Anime dashboard shows.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE IS STORED, AND NOTHING HERE IS A SERIES.
 *
 * Every figure is computed from `anime` rows at read time — the invariant
 * Finance states as "never store a total", holding for the same reason: a
 * stored aggregate and the rows it came from can drift, and no step in this app
 * would ever notice.
 *
 * The counting rule is trivial here and that is by design (see `series.ts`): a
 * series lives in a DIFFERENT TABLE, so a function that reads `anime` rows can
 * never accidentally count a franchise as a show. Games needs `countableGames`
 * at every counting call site precisely because a collection IS a `games` row.
 *
 * TIME IS ALWAYS AN ESTIMATE AND MUST ALWAYS BE LABELLED ONE. `durationMinutes`
 * is an average episode length AniList publishes, not a measurement of what the
 * owner watched — skipped openings, a recap episode, a double-length finale all
 * move the real figure. Every caller renders it with a "≈".
 *
 * `null` NEVER BECOMES ZERO. A show with no known episode length contributes no
 * minutes rather than zero minutes, and a group where nothing is known reports
 * `null` — "we don't know" and "none" are different answers, and collapsing
 * them is how a confident wrong number gets onto a dashboard.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pure TypeScript. No React, no Next, no database.
 */

import { type Minutes, episodesWatched, minutesWatched, minutes as toMinutes } from './runtime';
import {
  type AnimeFormat,
  type AnimeSeason,
  type AnimeSource,
  type AnimeStatus,
  FORMAT_LABELS,
  SOURCE_LABELS,
} from './taxonomy';

/** The projection the dashboard reads. A narrow slice of `Anime`, satisfied by it. */
export interface AnimeStatRow {
  readonly id: string;
  readonly titleRomaji: string;
  readonly titleEnglish: string | null;
  readonly status: AnimeStatus;
  readonly format: AnimeFormat | null;
  readonly source: AnimeSource | null;
  readonly episodes: number | null;
  readonly progress: number;
  readonly repeatCount: number;
  readonly durationMinutes: number | null;
  readonly season: AnimeSeason | null;
  readonly seasonYear: number | null;
  readonly studio: string | null;
  readonly genre: string | null;
  readonly coverUrl: string | null;
}

export interface LibrarySummary {
  readonly showCount: number;
  readonly episodesWatched: number;
  readonly minutesWatched: Minutes | null;
  readonly byStatus: Readonly<Record<AnimeStatus, number>>;
  /** Shows with at least one rewatch, and the extra episodes those rewatches account for. */
  readonly rewatchedCount: number;
  readonly rewatchEpisodes: number;
  /** How many shows have no known episode length — the denominator behind every "≈". */
  readonly unknownDurationCount: number;
}

export function buildLibrarySummary(rows: readonly AnimeStatRow[]): LibrarySummary {
  const byStatus: Record<AnimeStatus, number> = { watching: 0, completed: 0, dropped: 0, planning: 0 };
  let episodes = 0;
  let known = 0;
  let total = 0;
  let rewatchedCount = 0;
  let rewatchEpisodes = 0;
  let unknownDurationCount = 0;

  for (const row of rows) {
    byStatus[row.status] += 1;

    const watched = episodesWatched(row.progress, row.repeatCount, row.episodes);
    episodes += watched;

    if (row.repeatCount > 0) {
      rewatchedCount += 1;
      // What the rewatches ALONE account for: the total minus the first pass.
      rewatchEpisodes += watched - row.progress;
    }

    const mins = minutesWatched(row.progress, row.repeatCount, row.episodes, row.durationMinutes);
    if (mins === null) unknownDurationCount += 1;
    else {
      total += mins;
      known += 1;
    }
  }

  return {
    showCount: rows.length,
    episodesWatched: episodes,
    // `null`, not 0, when NOTHING was known. A dashboard reading "0h watched"
    // over a library of 200 shows is a lie; "—" is the truth.
    minutesWatched: known === 0 ? null : toMinutes(total),
    byStatus,
    rewatchedCount,
    rewatchEpisodes,
    unknownDurationCount,
  };
}

/**
 * Completion rate: of the shows the owner actually STARTED, how many did they
 * finish?
 *
 * Planning entries are excluded from both halves, deliberately. A watchlist of
 * 300 things not yet begun would drag the rate toward zero and say nothing
 * about follow-through — the question is "do I finish what I start", and a show
 * never started is not evidence either way. `null` when nothing has been
 * started at all, rather than 0%.
 */
export interface CompletionRates {
  readonly startedCount: number;
  readonly completionRate: number | null;
  readonly dropRate: number | null;
}

export function buildCompletionRates(rows: readonly AnimeStatRow[]): CompletionRates {
  const started = rows.filter((row) => row.status !== 'planning');
  if (started.length === 0) return { startedCount: 0, completionRate: null, dropRate: null };

  const completed = started.filter((row) => row.status === 'completed').length;
  const dropped = started.filter((row) => row.status === 'dropped').length;

  return {
    startedCount: started.length,
    completionRate: (completed / started.length) * 100,
    dropRate: (dropped / started.length) * 100,
  };
}

export interface DistributionSlice {
  readonly label: string;
  readonly count: number;
  /** Episodes watched across the slice — what makes "8 shows" and "620 episodes" tell different stories. */
  readonly episodes: number;
}

function sliceOf(rows: readonly AnimeStatRow[], label: string): DistributionSlice {
  return {
    label,
    count: rows.length,
    episodes: rows.reduce((sum, row) => sum + episodesWatched(row.progress, row.repeatCount, row.episodes), 0),
  };
}

/** Descending by count, then alphabetically — so a redraw with equal counts is stable rather than arbitrary. */
function sortSlices(slices: readonly DistributionSlice[]): DistributionSlice[] {
  return [...slices].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function buildFormatDistribution(rows: readonly AnimeStatRow[]): DistributionSlice[] {
  const groups = new Map<string, AnimeStatRow[]>();
  for (const row of rows) {
    // A missing format is left OUT rather than bucketed as "Unknown": the
    // chart answers "what do I watch", and a row AniList had no format for is
    // an absence of data, not a kind of anime.
    if (row.format === null) continue;
    const label = FORMAT_LABELS[row.format];
    groups.set(label, [...(groups.get(label) ?? []), row]);
  }
  return sortSlices([...groups].map(([label, group]) => sliceOf(group, label)));
}

export function buildSourceDistribution(rows: readonly AnimeStatRow[]): DistributionSlice[] {
  const groups = new Map<string, AnimeStatRow[]>();
  for (const row of rows) {
    if (row.source === null) continue;
    const label = SOURCE_LABELS[row.source];
    groups.set(label, [...(groups.get(label) ?? []), row]);
  }
  return sortSlices([...groups].map(([label, group]) => sliceOf(group, label)));
}

export function buildStudioDistribution(rows: readonly AnimeStatRow[]): DistributionSlice[] {
  const groups = new Map<string, AnimeStatRow[]>();
  for (const row of rows) {
    const studio = row.studio?.trim();
    if (studio === undefined || studio === '') continue;
    groups.set(studio, [...(groups.get(studio) ?? []), row]);
  }
  return sortSlices([...groups].map(([label, group]) => sliceOf(group, label)));
}

/**
 * Splits a comma-joined genre string.
 *
 * The same shape `games.genre` uses and the same reason: one text column,
 * split at read time, rather than a join table for a field nothing queries by.
 * A show counts once in EVERY genre it carries, so these slices deliberately
 * do not sum to the library size — an "Action, Drama" show is both.
 */
export function splitGenres(genre: string | null): readonly string[] {
  if (genre === null) return [];
  return genre
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

export function buildGenreDistribution(rows: readonly AnimeStatRow[]): DistributionSlice[] {
  const groups = new Map<string, AnimeStatRow[]>();
  for (const row of rows) {
    for (const genre of splitGenres(row.genre)) {
      groups.set(genre, [...(groups.get(genre) ?? []), row]);
    }
  }
  return sortSlices([...groups].map(([label, group]) => sliceOf(group, label)));
}

/**
 * Collapses a long tail into one "Other" row.
 *
 * Genre and studio both produce dozens of slices from a real library, and a
 * bar chart with 40 rows is a wall, not a chart. Capping in the DOMAIN rather
 * than in the chart means the number in "Other" is computed once and is the
 * same figure the chart's tooltip reports.
 */
export function capSlices(slices: readonly DistributionSlice[], limit: number): DistributionSlice[] {
  if (slices.length <= limit) return [...slices];

  const head = slices.slice(0, limit);
  const tail = slices.slice(limit);
  return [
    ...head,
    {
      label: `Other (${tail.length})`,
      count: tail.reduce((sum, slice) => sum + slice.count, 0),
      episodes: tail.reduce((sum, slice) => sum + slice.episodes, 0),
    },
  ];
}

export const CHART_SLICE_LIMIT = 8;

export interface EraRow {
  readonly year: number;
  readonly showCount: number;
  readonly episodesWatched: number;
}

/**
 * Shows by the YEAR THEY AIRED, not the year they were watched.
 *
 * This is a question about taste — "which eras of anime do I actually watch" —
 * and the answer must not move when a 2013 show is rewatched in 2026. A
 * watched-per-year breakdown is a different chart and needs the watch log
 * (M4), which is where dated facts live.
 *
 * Undated rows are dropped rather than bucketed into a zero year, which would
 * plant a bar at the far left of every chart.
 */
export function buildAiringEras(rows: readonly AnimeStatRow[]): EraRow[] {
  const byYear = new Map<number, AnimeStatRow[]>();
  for (const row of rows) {
    if (row.seasonYear === null) continue;
    byYear.set(row.seasonYear, [...(byYear.get(row.seasonYear) ?? []), row]);
  }

  return [...byYear]
    .map(([year, group]) => ({
      year,
      showCount: group.length,
      episodesWatched: group.reduce(
        (sum, row) => sum + episodesWatched(row.progress, row.repeatCount, row.episodes),
        0,
      ),
    }))
    .sort((a, b) => a.year - b.year);
}

export interface LeaderboardEntry {
  readonly id: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly episodes: number;
  readonly minutes: Minutes | null;
}

/**
 * The longest sits in the library, by episodes actually watched.
 *
 * By EPISODES rather than by minutes, because minutes are unknown for some
 * rows and a leaderboard that silently omits them would look like a bug. The
 * time estimate rides along per entry, `null` where it is not known.
 */
export function buildLeaderboard(rows: readonly AnimeStatRow[], limit: number): LeaderboardEntry[] {
  return rows
    .map((row) => ({
      id: row.id,
      title: row.titleEnglish ?? row.titleRomaji,
      coverUrl: row.coverUrl,
      episodes: episodesWatched(row.progress, row.repeatCount, row.episodes),
      minutes: minutesWatched(row.progress, row.repeatCount, row.episodes, row.durationMinutes),
    }))
    .filter((entry) => entry.episodes > 0)
    .sort((a, b) => b.episodes - a.episodes || a.title.localeCompare(b.title))
    .slice(0, limit);
}
