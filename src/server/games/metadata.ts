/**
 * Game metadata shaping — cover art, genre, developer, publisher, and the
 * critic-score/playtime/ESRB fields IGDB adds over the previous RAWG source.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IGDB AND NOT RAWG
 *
 * See docs/GAMES.md for the full writeup. In short: RAWG's `background_image`
 * is a 1280x720 landscape still with no portrait alternative anywhere in its
 * CDN, which rendered stretched and blurry in this app's `aspect-[3/4]` card
 * frame; and RAWG's *search* response silently omits `developers`/
 * `publishers` entirely (not merely empty — the keys don't exist), so those
 * fields always came back null from the one call this app made. IGDB solves
 * both: genuine portrait cover art (`t_cover_big`, 264x352, confirmed live by
 * parsing real JPEG SOF headers) and every field this module wants, mostly in
 * a single POST to `/v4/games` via Apicalypse's server-side relation
 * expansion.
 *
 * This module is PURE — it builds query bodies and URLs and shapes responses
 * but never performs a request. The fetch (and the Twitch OAuth exchange)
 * live in `src/server/db/games/igdb.ts` so the logic below stays testable
 * without a network or a fake server.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface GameSuggestion {
  readonly externalId: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly genre: string | null;
  readonly developer: string | null;
  readonly publisher: string | null;
  readonly metacritic: number | null;
  readonly averagePlaytimeHours: number | null;
  readonly esrbRating: string | null;
  readonly releaseYear: number | null;
}

/**
 * The `/v4/games` query body, Apicalypse plain text.
 *
 * Fields requested in one call: name, cover, involved companies (with the
 * `developer`/`publisher` boolean flags so the right company can be read off
 * without guessing from array position — a real weakness in RAWG's flat
 * arrays), genre, aggregated critic score, release date, and the ESRB-capable
 * age rating via the CURRENT (non-deprecated) `rating_category` relation.
 *
 * `age_ratings.rating` and `age_ratings.category` are both flagged
 * `deprecated = true` in IGDB's own published schema — verified live
 * 2026-08-20 by fetching `https://api.igdb.com/v4/igdbapi.proto` directly —
 * and were replaced by `age_ratings.rating_category` (an `AgeRatingCategory`
 * relation exposing `.rating`, e.g. `"M"`) plus that relation's own
 * `.organization` (an `AgeRatingOrganization` relation exposing `.name`, e.g.
 * `"ESRB"`). Using the deprecated flat fields would keep working today but
 * is exactly the kind of silent field-rename risk this module was told to
 * check for rather than assume.
 *
 * Time-to-beat is deliberately NOT in this list. The same live-fetched proto
 * shows IGDB's `Game` message has no relation field for it at all — unlike
 * `cover` or `involved_companies`, `game_time_to_beats` is a wholly separate
 * endpoint keyed by `game_id`, not an inline expansion. Bundling an invalid
 * field name into this query would 400 the ENTIRE search (losing cover art,
 * genre, developer, publisher — everything), not just the playtime figure,
 * so it is queried separately via `buildTimeToBeatQuery` below and merged in
 * with `withPlaytime`, isolated so its own failure can never blank the rest.
 */
export function buildSearchQuery(title: string, limit: number): string {
  const escaped = escapeApicalypseString(title);
  const fields = [
    'name',
    'cover.image_id',
    'involved_companies.company.name',
    'involved_companies.developer',
    'involved_companies.publisher',
    'genres.name',
    'aggregated_rating',
    'first_release_date',
    'age_ratings.rating_category.rating',
    'age_ratings.rating_category.organization.name',
  ].join(',');
  return `search "${escaped}"; fields ${fields}; limit ${limit};`;
}

/**
 * The `/v4/game_time_to_beats` query body. Batched across every candidate id
 * from one search, so autocomplete still costs at most two IGDB requests per
 * keystroke, not one per suggestion. `normally` is IGDB's whole-playthrough
 * estimate, in SECONDS (confirmed against a real integration that documents
 * converting the same field "from seconds to minutes" — IGDB's own schema
 * carries no unit comment).
 */
export function buildTimeToBeatQuery(gameIds: readonly number[]): string {
  return `fields game_id,normally; where game_id = (${gameIds.join(',')}); limit ${gameIds.length};`;
}

/** Escapes a string for Apicalypse's double-quoted `search "..."` clause. */
function escapeApicalypseString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Builds a cover-art URL for a given IGDB `image_id`. `t_cover_big_2x`
 * (528x704) is used for stored art — the cards render at `aspect-[3/4]` and
 * the 2x asset keeps them crisp on high-DPI displays (verified live: true
 * portrait, confirmed by parsing real JPEG SOF headers rather than trusting
 * the URL naming convention).
 */
export function coverUrl(imageId: string, size = 't_cover_big_2x'): string {
  return `https://images.igdb.com/igdb/image/upload/${size}/${imageId}.jpg`;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Finds the company name in `involved_companies` whose boolean `flag` is true. */
function companyByFlag(entries: unknown, flag: 'developer' | 'publisher'): string | null {
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record === null || record[flag] !== true) continue;
    const name = readString(asRecord(record.company)?.name);
    if (name !== null) return name;
  }
  return null;
}

function joinGenres(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const names = value
    .map((entry) => readString(asRecord(entry)?.name))
    .filter((name): name is string => name !== null);
  return names.length === 0 ? null : names.join(', ');
}

/** The ESRB entry's rating string (e.g. `"M"`), via the current `rating_category` relation. */
function esrbRatingFrom(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const category = asRecord(asRecord(entry)?.rating_category);
    if (category === null) continue;
    const organizationName = readString(asRecord(category.organization)?.name);
    if (organizationName !== 'ESRB') continue;
    const rating = readString(category.rating);
    if (rating !== null) return rating;
  }
  return null;
}

/** `first_release_date` arrives as a UNIX-seconds timestamp from the JSON/Apicalypse transport. */
function releaseYearFrom(value: unknown): number | null {
  const seconds = readNumber(value);
  if (seconds === null) return null;
  const year = new Date(seconds * 1000).getUTCFullYear();
  return Number.isFinite(year) ? year : null;
}

/**
 * Shapes a `/v4/games` JSON response into `GameSuggestion[]`. Defensive by
 * construction, since a third-party payload is untrusted shape, not a typed
 * contract — a missing or wrong-typed field degrades to `null`, never a
 * thrown error. `averagePlaytimeHours` always starts `null` here; it is
 * filled in afterward by `withPlaytime`, since it comes from IGDB's separate
 * `game_time_to_beats` endpoint, not this one.
 */
export function toSuggestions(payload: unknown): GameSuggestion[] {
  if (!Array.isArray(payload)) return [];

  return payload.flatMap((entry): GameSuggestion[] => {
    const record = asRecord(entry);
    if (record === null || typeof record.name !== 'string' || record.id === undefined) return [];

    const imageId = readString(asRecord(record.cover)?.image_id);
    const aggregatedRating = readNumber(record.aggregated_rating);

    return [
      {
        externalId: String(record.id),
        title: record.name,
        coverUrl: imageId === null ? null : coverUrl(imageId),
        genre: joinGenres(record.genres),
        developer: companyByFlag(record.involved_companies, 'developer'),
        publisher: companyByFlag(record.involved_companies, 'publisher'),
        metacritic: aggregatedRating === null ? null : Math.round(aggregatedRating),
        averagePlaytimeHours: null,
        esrbRating: esrbRatingFrom(record.age_ratings),
        releaseYear: releaseYearFrom(record.first_release_date),
      },
    ];
  });
}

/**
 * Merges a `/v4/game_time_to_beats` payload into suggestions already built by
 * `toSuggestions`. Kept as a separate step, not folded into `toSuggestions`
 * itself, because the two payloads come from two different IGDB endpoints and
 * two different fetches — see `buildSearchQuery`'s header for why time-to-beat
 * can't be requested inline. Defensive the same way: any entry that doesn't
 * cleanly map to a known game id and a numeric `normally` is skipped, not
 * thrown on.
 */
export function withPlaytime(
  suggestions: readonly GameSuggestion[],
  timeToBeatPayload: unknown,
): GameSuggestion[] {
  const hoursByGameId = new Map<string, number>();
  if (Array.isArray(timeToBeatPayload)) {
    for (const entry of timeToBeatPayload) {
      const record = asRecord(entry);
      if (record === null) continue;
      const gameId = record.game_id;
      const seconds = readNumber(record.normally);
      if ((typeof gameId !== 'number' && typeof gameId !== 'string') || seconds === null) continue;
      hoursByGameId.set(String(gameId), Math.round(seconds / 3600));
    }
  }
  if (hoursByGameId.size === 0) return [...suggestions];

  return suggestions.map((suggestion) => {
    const hoursValue = hoursByGameId.get(suggestion.externalId);
    return hoursValue === undefined ? suggestion : { ...suggestion, averagePlaytimeHours: hoursValue };
  });
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * MATCHING A STORED TITLE AGAINST AN IGDB SEARCH RESULT
 *
 * Used by `scripts/backfill-game-metadata.mjs`, the one-off script that fills
 * cover art/genre/metacritic/playtime/ESRB for games already sitting in the
 * library. Kept here rather than inline in the script because title matching
 * against a third-party catalog is genuinely error-prone — an HD remaster can
 * match a PSP original, a numbered sequel can match its predecessor — and
 * getting the confidence classification right is worth a real, unit-tested
 * function, not inline script logic nobody exercises against a fixture.
 *
 * The policy is deliberately conservative: HIGH confidence requires the
 * normalized titles to be IDENTICAL, either directly or after stripping a
 * single trailing parenthetical from either side (the owner's own data has
 * store-suffix artifacts like "(itch)" — see fix-game-platforms.mjs's
 * identical `stripTrailingParenthetical`, duplicated there for the same
 * reason every script in this repo stays self-contained). Anything else — a
 * close-but-not-exact title, a remaster/edition suffix, a roman-numeral-vs-
 * digit mismatch, a colon-subtitle difference — is LOW confidence and is
 * never auto-applied by the backfill script. The edit-distance ratio below
 * exists only so the script can pick the single best candidate out of
 * several IGDB search results to show the owner; it never promotes a fuzzy
 * match to HIGH, no matter how small the distance.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface TitleMatchScore {
  readonly confidence: 'high' | 'low';
  /** 0 = identical after normalization. Larger = less similar. Never used to grant HIGH confidence. */
  readonly distance: number;
}

/** Lowercases, strips diacritics and punctuation, collapses whitespace. */
export function normalizeGameTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritical marks left behind by NFKD
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Strips a single trailing parenthetical, e.g. `"Vice City (itch)" -> "Vice City"`. */
function stripTrailingParenthetical(title: string): string {
  return title.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Classic Levenshtein edit distance between two strings. Used only as a
 * ranking signal to pick the closest candidate among several IGDB results —
 * never to grant HIGH confidence, see `scoreTitleMatch`. Iterative two-row
 * form (no recursion, no full matrix) since titles are short and this may
 * run over several IGDB candidates per game across 160 games.
 */
function levenshteinDistance(a: string, b: string): number {
  let previousRow: number[] = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const currentRow: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (previousRow[j] ?? 0) + 1;
      const insertion = (currentRow[j - 1] ?? 0) + 1;
      const substitution = (previousRow[j - 1] ?? 0) + cost;
      currentRow.push(Math.min(deletion, insertion, substitution));
    }
    previousRow = currentRow;
  }

  return previousRow[b.length] ?? 0;
}

/**
 * Scores one IGDB candidate title against the title stored in `games`. See
 * the section header above for the confidence policy: HIGH only for an
 * identical normalized title (direct, or after stripping one trailing
 * parenthetical from either side); everything else is LOW.
 */
export function scoreTitleMatch(storedTitle: string, candidateTitle: string): TitleMatchScore {
  const normalizedStored = normalizeGameTitle(storedTitle);
  const normalizedCandidate = normalizeGameTitle(candidateTitle);
  if (normalizedStored === normalizedCandidate) return { confidence: 'high', distance: 0 };

  const strippedStored = normalizeGameTitle(stripTrailingParenthetical(storedTitle));
  const strippedCandidate = normalizeGameTitle(stripTrailingParenthetical(candidateTitle));
  if (strippedStored !== '' && strippedStored === strippedCandidate) {
    return { confidence: 'high', distance: 0 };
  }

  const distance = levenshteinDistance(normalizedStored, normalizedCandidate);
  const maxLength = Math.max(normalizedStored.length, normalizedCandidate.length, 1);
  return { confidence: 'low', distance: distance / maxLength };
}

export interface BestTitleMatch {
  readonly suggestion: GameSuggestion;
  readonly score: TitleMatchScore;
}

/**
 * Picks the single best-scoring candidate out of an IGDB search result list.
 * "Best" is the lowest `distance` (0 = exact); ties keep whichever candidate
 * IGDB returned first (its own relevance order). Returns `null` for an empty
 * candidate list — "no match found" is a distinct, separately-reported
 * outcome from "matched, but low confidence."
 */
export function bestTitleMatch(storedTitle: string, candidates: readonly GameSuggestion[]): BestTitleMatch | null {
  let best: BestTitleMatch | null = null;
  for (const suggestion of candidates) {
    const score = scoreTitleMatch(storedTitle, suggestion.title);
    if (best === null || score.distance < best.score.distance) {
      best = { suggestion, score };
    }
  }
  return best;
}

/** The five columns the backfill script is allowed to touch, as currently stored. */
export interface StoredGameMetadata {
  readonly coverUrl: string | null;
  readonly genre: string | null;
  readonly metacritic: number | null;
  readonly averagePlaytimeHours: number | null;
  readonly esrbRating: string | null;
}

/** Only the columns that should actually be written — see `metadataFieldsToFill`. */
export interface MetadataFill {
  readonly coverUrl?: string;
  readonly genre?: string;
  readonly metacritic?: number;
  readonly averagePlaytimeHours?: number;
  readonly esrbRating?: string;
}

/**
 * Which of the five backfillable columns should actually be written for one
 * game: only a column that is CURRENTLY NULL in the database, and only when
 * the matched IGDB suggestion has a real (non-null) value for it. Never
 * includes a column the owner already has a value for, regardless of what
 * IGDB returns — this is the code-level enforcement of CLAUDE.md's "only
 * fill columns that are currently NULL" requirement, so the backfill script
 * itself never has to remember that rule at every call site.
 *
 * Built with `if` statements into a mutable local object, not conditional
 * spreads — `exactOptionalPropertyTypes` loses precision once more than two
 * or three optional fields are assembled from independent conditions in one
 * object literal (see CLAUDE.md's gotcha on M7's review filters); this is
 * the same fix applied here for the same reason. `MetadataFill`'s own fields
 * are `readonly` (it's a return-value contract), so building it needs a
 * separate mutable shape, per that same documented pattern.
 */
export function metadataFieldsToFill(current: StoredGameMetadata, suggestion: GameSuggestion): MetadataFill {
  const fill: { -readonly [K in keyof MetadataFill]: MetadataFill[K] } = {};
  if (current.coverUrl === null && suggestion.coverUrl !== null) fill.coverUrl = suggestion.coverUrl;
  if (current.genre === null && suggestion.genre !== null) fill.genre = suggestion.genre;
  if (current.metacritic === null && suggestion.metacritic !== null) fill.metacritic = suggestion.metacritic;
  if (current.averagePlaytimeHours === null && suggestion.averagePlaytimeHours !== null) {
    fill.averagePlaytimeHours = suggestion.averagePlaytimeHours;
  }
  if (current.esrbRating === null && suggestion.esrbRating !== null) fill.esrbRating = suggestion.esrbRating;
  return fill;
}
