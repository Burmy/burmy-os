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

/**
 * The `/v4/games` query body for the "Upcoming games" tab, Apicalypse plain
 * text. Every constant baked into this query's SHAPE (as opposed to the
 * three values callers supply — the time window and the hype floor) was
 * verified against the live IGDB API before being written, not assumed from
 * documentation or from the original design plan:
 *
 *   - `category = 0` ("main_game") returns ZERO ROWS against live IGDB
 *     today — `category` is dead. `game_type = 0` is the live replacement,
 *     confirmed by querying `/game_types` directly: 0 = Main Game (the
 *     other fourteen values are DLC/expansion/bundle/remaster/port/mod/
 *     etc. — exactly what this tab wants excluded).
 *   - `platforms = (167,6)` — parenthesis form, "any of" — confirmed live.
 *     167 = PlayStation 5, 6 = PC.
 *   - `hypes` ("Number of follows a game gets before release") is the only
 *     live, non-empty pre-release quality signal — `total_rating`,
 *     `aggregated_rating` and `rating` are structurally empty pre-release,
 *     and `follows` is deprecated. IGDB publishes no documented scale for
 *     it; the floor is a calibrated constant on the caller's side (see
 *     `HYPE_FLOOR` in `src/server/db/games/igdb.ts`), not baked in here.
 *   - The plan this module was built from also proposed `status != (6,7)`
 *     to exclude cancelled/rumored titles. A live probe at hype floor 30
 *     showed `status` is simply UNSET on essentially every upcoming game
 *     (all top 45 by hype, including Grand Theft Auto VI and Fable) — and
 *     Apicalypse's `!=` EXCLUDES rows where the field is null rather than
 *     passing them through, the opposite of what a naive SQL-NULL mental
 *     model predicts. Adding that filter collapsed the same 45-game result
 *     down to 1. It is deliberately NOT in this query — do not re-add it
 *     without re-verifying live.
 *
 * `platforms` and `release_dates.platform` are both requested WITHOUT a
 * `.name` subfield: an unexpanded IGDB relation field returns a raw numeric
 * id, which is all `toUpcomingGames` (`src/server/games/upcoming.ts`) needs
 * — the app's own `PLATFORM_LABELS` (taxonomy.ts) supplies display text for
 * `ps5`/`pc`, so no IGDB-authored label string is ever parsed. `release_dates`
 * is requested as `.y`/`.m`/`.date_format` (not the unix `.date`) so month
 * bucketing reads IGDB's own pre-split calendar fields directly — avoiding
 * the timezone drift a UNIX-seconds→calendar conversion would risk.
 *
 * `sort hypes desc` matters beyond display order: `limit 200` caps the
 * response, so if a 12-month, floor-N window ever exceeds 200 real
 * candidates, the highest-hype (least likely to be filler) games are the
 * ones kept.
 */
export function buildUpcomingQuery(nowSeconds: number, horizonSeconds: number, hypeFloor: number): string {
  const fields = [
    'name',
    'hypes',
    'cover.image_id',
    'platforms',
    'release_dates.y',
    'release_dates.m',
    'release_dates.date_format',
    'release_dates.platform',
  ].join(',');
  return (
    `fields ${fields}; ` +
    `where first_release_date > ${nowSeconds} & first_release_date < ${horizonSeconds} ` +
    `& game_type = 0 & platforms = (167,6) & hypes >= ${hypeFloor}; ` +
    `sort hypes desc; limit 200;`
  );
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
 * MATCHING A STORED TITLE AGAINST AN IGDB/STEAM SEARCH RESULT
 *
 * Used by `scripts/backfill-game-metadata.mjs` (IGDB) and
 * `scripts/sync-steam-library.mjs` (Steam). Kept here rather than duplicated
 * in each script because title matching against a third-party catalog is
 * genuinely error-prone — an HD remaster can match a PSP original, a
 * numbered sequel can match its predecessor, an episodic spin-off can match
 * its base game — and getting the confidence classification right is worth a
 * real, unit-tested function, not inline script logic nobody exercises
 * against a fixture.
 *
 * HIGH confidence is granted for four things, checked in this order, and
 * NOTHING else:
 *
 *   1. Normalized titles are IDENTICAL.
 *   2. Identical after stripping a single trailing parenthetical from either
 *      side (the owner's own data has store-suffix artifacts like "(itch)" —
 *      see fix-game-platforms.mjs's identical `stripTrailingParenthetical`,
 *      duplicated there for the same reason every script in this repo stays
 *      self-contained).
 *   3. Identical after collapsing a known ABBREVIATION (`TITLE_ABBREVIATIONS`
 *      below, e.g. "Game of the Year" <-> "GOTY") — a tiny, explicit,
 *      commented list. General acronym inference is deliberately NOT
 *      attempted; a false abbreviation expansion would be exactly the kind
 *      of wrong-game match this whole function exists to prevent.
 *   4. TOKEN CONTAINMENT: every token of the shorter (post-abbreviation)
 *      title appears in the longer one, and the leftover ("remainder")
 *      tokens read as a droppable subtitle, not a distinguishing one — e.g.
 *      "Idle Slayer" vs. "Idle Slayer – Incremental RPG", "Tap Ninja" vs.
 *      "Tap Ninja - Idle game". Four guards keep this conservative
 *      (`isTokenContainmentMatch`):
 *        - the shorter title must carry at least two tokens — a single
 *          generic word ("Doom") is too common to treat as "contained";
 *        - a remainder token that is a number or roman numeral is a
 *          DISTINGUISHING token, never droppable — "Portal" must never match
 *          "Portal 2", nor "Half-Life" match "Half-Life 2";
 *        - a remainder token naming a known edition/remaster variant
 *          (`EDITION_MARKER_WORDS`: "hd", "remastered", …) is likewise never
 *          droppable — this is the pre-existing "an HD remaster must never
 *          silently match the original release" policy, preserved verbatim;
 *        - a colon in EITHER raw title disables containment entirely. In
 *          this app's real library, a colon overwhelmingly introduces a
 *          separately-titled sub-entry ("Half-Life 2: Episode One", "Portal
 *          Stories: Mel", "Metro: Last Light Redux" are each their own real
 *          Steam product) where a dash/en-dash instead overwhelmingly
 *          introduces a droppable storefront genre tagline ("Idle Slayer -
 *          Incremental RPG"). Verified empirically against the owner's real
 *          47-row Steam library dry run: without this guard, "Half-Life 2:
 *          Episode One" (which Steam does NOT own) falsely token-contained
 *          "Half-Life 2" (which Steam DOES own) and would have attached
 *          Half-Life 2's achievements to the wrong library row.
 *
 * Everything else is LOW confidence, ranked by a Levenshtein-based
 * `similarity` (see `TitleMatchScore`) — close-but-not-exact, a remaster/
 * edition suffix, a roman-numeral-vs-digit mismatch, a colon-subtitle
 * difference. LOW is never auto-applied by either script.
 *
 * `bestTitleMatchAmong` additionally enforces `SIMILARITY_FLOOR`: even the
 * single best LOW candidate is discarded entirely ("no match found", not
 * "low confidence, here's the closest guess") once its similarity falls
 * below the floor — see that constant for the empirical evidence behind the
 * chosen value.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface TitleMatchScore {
  readonly confidence: 'high' | 'low';
  /**
   * 1 = identical (or treated-as-equivalent) titles. 0 = maximally
   * different. HIGHER IS BETTER — deliberately a similarity, not a distance,
   * so nothing reading a report has to remember which direction is good (an
   * earlier `distance` field had exactly that ambiguity: a report printed
   * "0.62" for a bad match and "0.43" for a good one, i.e. lower was better,
   * while the field's own name suggested the opposite). Never used on its
   * own to grant HIGH confidence — see `scoreTitleMatch`.
   */
  readonly similarity: number;
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
 * A tiny, explicit, commented list of known title abbreviations — the one
 * form of "these mean the same thing" this module allows itself. General
 * acronym inference is deliberately NOT attempted: it is too easy to invent
 * a false positive between two unrelated games that happen to share
 * initials. Applied as a long-form -> short-form collapse so both sides of a
 * comparison land on the same canonical text regardless of which form either
 * title happens to use. Every `long` entry must already be lowercase,
 * alnum-and-space-only text (the shape `normalizeGameTitle` produces), since
 * it is matched with a plain word-boundary regex, not re-normalized.
 */
const TITLE_ABBREVIATIONS: ReadonlyArray<readonly [long: string, short: string]> = [
  // "Borderlands Game of the Year" <-> "Borderlands GOTY" (and "... GOTY Enhanced").
  ['game of the year', 'goty'],
];

/** Collapses every known long-form phrase in `normalized` to its short form — see `TITLE_ABBREVIATIONS`. */
function collapseAbbreviations(normalized: string): string {
  let result = normalized;
  for (const [long, short] of TITLE_ABBREVIATIONS) {
    result = result.replace(new RegExp(`\\b${long}\\b`, 'g'), short);
  }
  return result;
}

/**
 * Remainder tokens that mark a genuinely different edition/version of the
 * SAME base title — never a droppable descriptor. This is what keeps token
 * containment (`isTokenContainmentMatch` below) from reintroducing the exact
 * risk this module has always guarded against: "an HD remaster can match a
 * PSP original." Small and explicit on purpose, same philosophy as
 * `TITLE_ABBREVIATIONS`.
 */
const EDITION_MARKER_WORDS = new Set([
  'hd',
  'remaster',
  'remastered',
  'remake',
  'definitive',
  'anniversary',
  'deluxe',
  'goty',
  'redux',
  'enhanced',
  'complete',
  'ultimate',
]);

/**
 * Roman numerals actually used for game sequels, up to XII. Deliberately NOT
 * full roman-numeral parsing — a general pattern like `/^m*(cm|cd|d?c*)…$/`
 * also matches ordinary English words such as "mix", which would make an
 * unrelated remainder token wrongly "distinguishing" or (worse) wrongly
 * droppable.
 */
const ROMAN_NUMERAL_TOKENS = new Set(['ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii']);

/**
 * Every real droppable-tagline match this module has ever seen (`Idle
 * Slayer – Incremental RPG`, `Tap Ninja - Idle game`) introduces the
 * tagline with a dash. A bare, space-appended remainder word with no dash
 * is far more likely a genuine subtitle/name than a storefront tagline —
 * see the real false positive this guards against in
 * `isTokenContainmentMatch`'s own doc comment.
 */
const DASH_CHARACTERS = /[-–—]/;

/**
 * A trailing number or roman numeral distinguishes a sequel/entry from its
 * predecessor and must never be treated as a droppable descriptor — see the
 * containment guards in `isTokenContainmentMatch`.
 */
function isDistinguishingToken(token: string): boolean {
  return /^\d+$/.test(token) || ROMAN_NUMERAL_TOKENS.has(token);
}

/**
 * Token containment: is the shorter of the two (space-tokenized) titles
 * fully contained, token-for-token, in the longer one, with a remainder that
 * reads as a droppable descriptor rather than a distinguishing suffix? See
 * the "MATCHING…" header above for the full policy and the real false
 * positive (Half-Life 2 / Half-Life 2: Episode One) that motivated the colon
 * guard. `rawStored`/`rawCandidate` are the ORIGINAL, un-normalized titles —
 * normalization strips the colon this function needs to see.
 */
function isTokenContainmentMatch(
  rawStored: string,
  rawCandidate: string,
  normalizedStored: string,
  normalizedCandidate: string,
): boolean {
  if (rawStored.includes(':') || rawCandidate.includes(':')) return false;

  const storedTokens = normalizedStored.split(' ').filter(Boolean);
  const candidateTokens = normalizedCandidate.split(' ').filter(Boolean);
  if (storedTokens.length === 0 || candidateTokens.length === 0) return false;

  const storedIsLonger = storedTokens.length > candidateTokens.length;
  const [shorter, longer] = storedIsLonger ? [candidateTokens, storedTokens] : [storedTokens, candidateTokens];
  const rawLonger = storedIsLonger ? rawStored : rawCandidate;
  // A single generic word ("Doom", "War") is too common to safely treat as
  // "contained" in anything that happens to start with it.
  if (shorter.length < 2) return false;

  const longerSet = new Set(longer);
  if (!shorter.every((token) => longerSet.has(token))) return false;

  const shorterSet = new Set(shorter);
  const remainder = longer.filter((token) => !shorterSet.has(token));
  if (remainder.some((token) => isDistinguishingToken(token) || EDITION_MARKER_WORDS.has(token))) return false;
  if (remainder.length === 0) return true;

  // A real false positive found live: the owner wishlisted "God of War
  // Laufey" (a real, distinct upcoming title) and it token-contained the
  // owner's actual "God of War" (2018) playthrough at HIGH confidence —
  // "Laufey" is neither a number, a roman numeral, nor a known edition
  // marker, so nothing above caught it. Require a dash actually
  // introducing the remainder before treating it as a droppable tagline.
  return DASH_CHARACTERS.test(rawLonger);
}

/**
 * Scores one candidate title against the title stored in `games`. See the
 * section header above for the full confidence policy.
 */
export function scoreTitleMatch(storedTitle: string, candidateTitle: string): TitleMatchScore {
  const normalizedStored = normalizeGameTitle(storedTitle);
  const normalizedCandidate = normalizeGameTitle(candidateTitle);
  if (normalizedStored === normalizedCandidate) return { confidence: 'high', similarity: 1 };

  const strippedStored = normalizeGameTitle(stripTrailingParenthetical(storedTitle));
  const strippedCandidate = normalizeGameTitle(stripTrailingParenthetical(candidateTitle));
  if (strippedStored !== '' && strippedStored === strippedCandidate) {
    return { confidence: 'high', similarity: 1 };
  }

  const abbreviatedStored = collapseAbbreviations(strippedStored || normalizedStored);
  const abbreviatedCandidate = collapseAbbreviations(strippedCandidate || normalizedCandidate);
  if (abbreviatedStored !== '' && abbreviatedStored === abbreviatedCandidate) {
    return { confidence: 'high', similarity: 0.95 };
  }

  if (isTokenContainmentMatch(storedTitle, candidateTitle, abbreviatedStored, abbreviatedCandidate)) {
    return { confidence: 'high', similarity: 0.9 };
  }

  const distance = levenshteinDistance(normalizedStored, normalizedCandidate);
  const maxLength = Math.max(normalizedStored.length, normalizedCandidate.length, 1);
  return { confidence: 'low', similarity: 1 - distance / maxLength };
}

export interface BestTitleMatch {
  readonly suggestion: GameSuggestion;
  readonly score: TitleMatchScore;
}

export interface BestMatchAmong<T> {
  readonly candidate: T;
  readonly score: TitleMatchScore;
}

/**
 * The similarity floor below which even the single best candidate is
 * discarded entirely — "no match found," not "low confidence, here's the
 * closest guess." Without this, `bestTitleMatchAmong` always returns
 * SOMETHING as long as `candidates` is non-empty, which is exactly Problem 1
 * from the real Steam sync dry run: titles Steam genuinely does not own
 * (e.g. "Bloody Roar 2", "Grand Theft Auto: San Andreas", "Pocket Tanks")
 * were reported as LOW-confidence matches against an unrelated closest
 * neighbour ("Portal 2", "Slay the Spire", "Portal").
 *
 * Chosen empirically against the owner's real 47-row Steam library dry run
 * (`.superpowers/sdd/2026-08-20-game-tracker/steam-sync-report.md`'s
 * predecessor run), not picked a priori. Every one of the 16 titles that
 * scored LOW under the pre-floor scoring resolves, under the current
 * `scoreTitleMatch` policy, to either HIGH (via abbreviation/containment —
 * genuine matches like "Idle Slayer" / "Tap Ninja") or a plain-edit-distance
 * fallback that Steam genuinely does not own. The highest similarity among
 * that second group is "Team Fortress 2" vs. the real, but WRONG, Steam-owned
 * "Team Fortress Classic" — 0.67 (both titles share the "Team Fortress"
 * prefix, but Steam does not own Team Fortress 2 on this account). 0.70 is
 * the smallest round number above that observed worst case, so it excludes
 * every genuine non-match in the real data while never being reached for a
 * genuine one — every genuine match clears HIGH confidence (similarity >=
 * 0.90) via one of `scoreTitleMatch`'s four HIGH paths, never by relying on
 * this floor.
 */
const SIMILARITY_FLOOR = 0.7;

/**
 * Generic form of `bestTitleMatch` below: picks the single best-scoring
 * candidate out of ANY list, given a way to read a comparable title off each
 * one. "Best" is the highest `similarity` (1 = exact); ties keep whichever
 * candidate came first in `candidates` (the source API's own relevance
 * order). Returns `null` for an empty candidate list, OR when the single
 * best candidate's similarity falls below `SIMILARITY_FLOOR` — "no match
 * found" is a distinct, separately-reported outcome from "matched, but low
 * confidence."
 *
 * Exists here — not duplicated as a second copy of this loop in
 * `src/server/games/steam.ts` — because `steam.ts` is deliberately a LEAF
 * module (no imports of its own): `scripts/sync-steam-library.mjs` needs to
 * `node`-import it directly the same way `scripts/backfill-game-metadata.mjs`
 * already does for this file (see that script's header for why a directly
 * `node`-imported `.ts` file can only safely import OTHER extensionless
 * relative `.ts` files if the whole chain stays leaf-to-leaf — Node's native
 * ESM resolver requires an explicit, resolvable extension at every hop, and
 * a bare relative specifier like `./metadata` has none). `bestTitleMatch`
 * itself is kept below as a thin, IGDB-shaped wrapper so its existing
 * callers and tests are untouched.
 */
export function bestTitleMatchAmong<T>(
  storedTitle: string,
  candidates: readonly T[],
  titleOf: (candidate: T) => string,
): BestMatchAmong<T> | null {
  let best: BestMatchAmong<T> | null = null;
  for (const candidate of candidates) {
    const score = scoreTitleMatch(storedTitle, titleOf(candidate));
    if (best === null || score.similarity > best.score.similarity) {
      best = { candidate, score };
    }
  }
  if (best !== null && best.score.similarity < SIMILARITY_FLOOR) return null;
  return best;
}

/**
 * Picks the single best-scoring candidate out of an IGDB search result list.
 * Thin wrapper over `bestTitleMatchAmong` — see that function for the actual
 * policy (lowest distance wins, `null` for an empty list).
 */
export function bestTitleMatch(storedTitle: string, candidates: readonly GameSuggestion[]): BestTitleMatch | null {
  const match = bestTitleMatchAmong(storedTitle, candidates, (candidate) => candidate.title);
  return match === null ? null : { suggestion: match.candidate, score: match.score };
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

/**
 * A brand-new game has no library row yet, so every one of the five
 * backfillable columns starts unset — the sync enrichment phase's own
 * "current" for `metadataFieldsToFill` (`src/features/games/sync/sync-actions.ts`'s
 * `advanceSyncEnrichmentAction`), exactly the same call `scripts/backfill-game-
 * metadata.mjs` makes per EXISTING game, just with every field guaranteed
 * null rather than possibly already set.
 */
const NO_STORED_METADATA: StoredGameMetadata = {
  coverUrl: null,
  genre: null,
  metacritic: null,
  averagePlaytimeHours: null,
  esrbRating: null,
};

/**
 * The metadata a brand-new, not-yet-inserted game should be enriched with:
 * the single best IGDB `suggestion` for `title`, applied ONLY when it clears
 * HIGH confidence — identical gate to `scripts/backfill-game-metadata.mjs`'s
 * `--apply` policy (see `scoreTitleMatch`'s doc comment for the full
 * confidence rule, and `SIMILARITY_FLOOR` for why even the best LOW match is
 * discarded). Returns an EMPTY `MetadataFill` (no keys), never `null`, for
 * "no suggestions," "no confident match," or "not configured" alike — the
 * caller (`markNewGameChangeEnriched`, `src/server/db/games/sync.ts`) merges
 * this straight into a payload patch with no extra branch, and an empty fill
 * is exactly what should be written when nothing was found: the new game
 * stays a letter-tile placeholder, precisely today's un-enriched behaviour.
 */
export function resolveNewGameMetadataFill(title: string, suggestions: readonly GameSuggestion[]): MetadataFill {
  const match = bestTitleMatch(title, suggestions);
  if (match === null || match.score.confidence !== 'high') return {};
  return metadataFieldsToFill(NO_STORED_METADATA, match.suggestion);
}
