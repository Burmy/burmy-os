/**
 * The Anime module's shared vocabulary — the const tuples and label maps every
 * layer reads.
 *
 * Framework-free on purpose, exactly like `src/server/games/taxonomy.ts`: a
 * client component can import these directly without pulling `getDb()` or
 * drizzle into the browser bundle.
 */

export const ANIME_STATUSES = ['watching', 'completed', 'dropped', 'planning'] as const;
export type AnimeStatus = (typeof ANIME_STATUSES)[number];

export const ANIME_FORMATS = ['tv', 'tv_short', 'movie', 'ova', 'ona', 'special', 'music'] as const;
export type AnimeFormat = (typeof ANIME_FORMATS)[number];

export const ANIME_SEASONS = ['winter', 'spring', 'summer', 'fall'] as const;
export type AnimeSeason = (typeof ANIME_SEASONS)[number];

export const ANIME_SOURCES = [
  'original',
  'manga',
  'light_novel',
  'visual_novel',
  'video_game',
  'novel',
  'doujinshi',
  'anime',
  'other',
] as const;
export type AnimeSource = (typeof ANIME_SOURCES)[number];

export const STATUS_LABELS: Record<AnimeStatus, string> = {
  watching: 'Watching',
  completed: 'Completed',
  dropped: 'Dropped',
  planning: 'Planning',
};

export const FORMAT_LABELS: Record<AnimeFormat, string> = {
  tv: 'TV',
  tv_short: 'TV Short',
  movie: 'Movie',
  ova: 'OVA',
  ona: 'ONA',
  special: 'Special',
  music: 'Music',
};

export const SEASON_LABELS: Record<AnimeSeason, string> = {
  winter: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  fall: 'Fall',
};

export const SOURCE_LABELS: Record<AnimeSource, string> = {
  original: 'Original',
  manga: 'Manga',
  light_novel: 'Light novel',
  visual_novel: 'Visual novel',
  video_game: 'Video game',
  novel: 'Novel',
  doujinshi: 'Doujinshi',
  anime: 'Anime',
  other: 'Other',
};

/** `"Spring 2013"`, or `null` when AniList knows neither half. A year without a season still reads usefully. */
export function formatAiring(season: AnimeSeason | null, year: number | null): string | null {
  if (season === null && year === null) return null;
  if (season === null) return String(year);
  if (year === null) return SEASON_LABELS[season];
  return `${SEASON_LABELS[season]} ${year}`;
}

const STATUS_SET: ReadonlySet<string> = new Set(ANIME_STATUSES);
const FORMAT_SET: ReadonlySet<string> = new Set(ANIME_FORMATS);
const SEASON_SET: ReadonlySet<string> = new Set(ANIME_SEASONS);
const SOURCE_SET: ReadonlySet<string> = new Set(ANIME_SOURCES);

export function isAnimeStatus(value: unknown): value is AnimeStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}
export function isAnimeFormat(value: unknown): value is AnimeFormat {
  return typeof value === 'string' && FORMAT_SET.has(value);
}
export function isAnimeSeason(value: unknown): value is AnimeSeason {
  return typeof value === 'string' && SEASON_SET.has(value);
}
export function isAnimeSource(value: unknown): value is AnimeSource {
  return typeof value === 'string' && SOURCE_SET.has(value);
}

/**
 * AniList's six list statuses, folded into this app's four.
 *
 * PAUSED becomes `watching` and REPEATING becomes `completed` — the owner's
 * decision, and `repeat_count` still carries the rewatch signal so nothing
 * about a rewatch is actually lost. An unrecognised status becomes `planning`
 * rather than throwing: a status this app has never heard of must not fail an
 * import of 300 shows.
 */
export function statusFromAniList(value: unknown): AnimeStatus {
  switch (value) {
    case 'CURRENT':
    case 'PAUSED':
      return 'watching';
    case 'COMPLETED':
    case 'REPEATING':
      return 'completed';
    case 'DROPPED':
      return 'dropped';
    default:
      return 'planning';
  }
}

/** AniList `MediaFormat` → this app's. `null` for anything unrecognised — an unknown format is a missing field, never a guess. */
export function formatFromAniList(value: unknown): AnimeFormat | null {
  if (typeof value !== 'string') return null;
  const mapped = value.toLowerCase();
  return isAnimeFormat(mapped) ? mapped : null;
}

/** AniList `MediaSeason` → this app's. `null` for anything unrecognised. */
export function seasonFromAniList(value: unknown): AnimeSeason | null {
  if (typeof value !== 'string') return null;
  const mapped = value.toLowerCase();
  return isAnimeSeason(mapped) ? mapped : null;
}

/**
 * AniList `MediaSource` → this app's.
 *
 * AniList carries values this app deliberately does not enumerate
 * (`WEB_NOVEL`, `LIVE_ACTION`, `GAME`, `COMIC`, `MULTIMEDIA_PROJECT`,
 * `PICTURE_BOOK`). They collapse to `other` rather than being added one at a
 * time: the stats page groups by source, and nine buckets already sit at the
 * edge of useful.
 */
export function sourceFromAniList(value: unknown): AnimeSource | null {
  if (typeof value !== 'string') return null;
  const mapped = value.toLowerCase();
  if (isAnimeSource(mapped)) return mapped;
  return 'other';
}
