/**
 * Matching a stored show to an AniList entry BY TITLE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS STRICTER THAN THE GAMES MATCHER, AND CANNOT REUSE IT.
 *
 * `src/server/games/metadata.ts` accepts a match at 0.70 similarity, which is
 * right for its data: two different games rarely have near-identical names, and
 * a wrong match there fills in cover art.
 *
 * Anime breaks that assumption completely. "Shingeki no Kyojin" and "Shingeki
 * no Kyojin Season 2" are 85%+ similar by any string metric and are DIFFERENT
 * SHOWS — different episode counts, different progress, different years. A
 * wrong link here is not a wrong cover: the next sync would overwrite one
 * season's progress and status with another's, and the owner would have no way
 * to tell it from a real correction.
 *
 * So the policy has a hard gate that no similarity score can override:
 *
 *   1. ORDINAL GUARD. Extract the season/part marker from each title. If they
 *      disagree — "Season 2" against nothing, "II" against "III" — reject
 *      outright, whatever the score.
 *   2. Then an exact normalised match on EITHER of AniList's titles (romaji or
 *      English) links.
 *   3. Then a similarity at or above `MATCH_FLOOR`, which is deliberately far
 *      higher than the Games floor.
 *   4. Otherwise no match. An unlinked show is a perfectly fine state; a wrongly
 *      linked one is a data-loss bug.
 *
 * Nothing here writes. A match becomes a `link` change the owner approves on
 * the review screen, so the failure mode of being slightly too generous is one
 * visible row to untick, not a silent overwrite.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pure TypeScript. No React, no Next, no HTTP, no database.
 */

/**
 * Well above Games' 0.70, and chosen for a different reason: this is not a
 * "closest guess" threshold but a "these are the same string modulo
 * punctuation and romanisation" one. The ordinal guard above already removes
 * the dangerous near-misses, so what remains for the score to catch is
 * "Kimi no Na wa." vs "Kimi no Na wa" and "Re:Zero kara Hajimeru Isekai
 * Seikatsu" vs "Re Zero kara Hajimeru Isekai Seikatsu".
 */
export const MATCH_FLOOR = 0.9;

/**
 * Lowercase, fold the punctuation a spreadsheet or a romanisation introduces,
 * collapse whitespace.
 *
 * The curly apostrophe fold is the same one `PickerDialog`'s search does and
 * for the same reason: AniList writes `Drake’s` while nobody types U+2019.
 * `:` and `;` go because "Steins;Gate" is written both ways in the wild, and
 * `.` because "Kimi no Na wa." carries a trailing period that means nothing.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replaceAll('’', "'")
    .replace(/[.,:;!?'"()[\]{}\-–—_/\\&+~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The season/part marker a title carries, as a comparable string — or `''`
 * when it carries none.
 *
 * `''` is itself a value that must MATCH only `''`. A bare "Shingeki no Kyojin"
 * has no marker and a "Season 2" has one, so the two can never link, which is
 * the entire point of this function.
 *
 * Deliberately coarse. It does not try to understand "Final Season Part 2"
 * versus "Season 4 Part 2" — it only has to tell markers APART, and two forms
 * of the same season failing to match costs one unlinked row while two
 * different seasons matching costs real data.
 */
export function ordinalMarker(title: string): string {
  const text = title.toLowerCase().replaceAll('’', "'");

  // "Season 3", "Part 2", "Cour 2" — the number is what matters.
  const numbered = /\b(?:season|part|cour)\s*(\d+)\b/.exec(text);
  if (numbered?.[1]) return `n${numbered[1]}`;

  // "2nd Season", "3rd Season".
  const ordinalWord = /\b(\d+)(?:st|nd|rd|th)\s+season\b/.exec(text);
  if (ordinalWord?.[1]) return `n${ordinalWord[1]}`;

  // "Final Season", which is an ordinal in every sense that matters here.
  if (/\bfinal\s+season\b/.test(text)) return 'final';

  // A trailing Roman numeral or bare digit — "Overlord III", "Mushoku Tensei 2".
  const trailing = /\s+([ivx]{1,4}|\d{1,2})$/.exec(text);
  if (trailing?.[1]) return `n${romanToNumber(trailing[1]) ?? trailing[1]}`;

  return '';
}

function romanToNumber(value: string): number | null {
  const digits: Record<string, number> = { i: 1, v: 5, x: 10 };
  let total = 0;
  let previous = 0;
  for (const character of [...value].reverse()) {
    const digit = digits[character];
    if (digit === undefined) return null;
    total += digit < previous ? -digit : digit;
    previous = Math.max(previous, digit);
  }
  return total === 0 ? null : total;
}

/**
 * Sørensen–Dice on character bigrams: 1 for identical, 0 for nothing in common.
 *
 * Bigrams rather than edit distance because they are insensitive to word order
 * and to a long shared prefix, both of which anime titles are full of. A
 * one-or-two-character string has no bigrams, so those fall back to equality.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const pair = a.slice(i, i + 2);
    bigrams.set(pair, (bigrams.get(pair) ?? 0) + 1);
  }

  let shared = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const pair = b.slice(i, i + 2);
    const count = bigrams.get(pair) ?? 0;
    if (count > 0) {
      bigrams.set(pair, count - 1);
      shared += 1;
    }
  }

  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/** The projection the matcher needs from an AniList entry. */
export interface MatchableEntry {
  readonly mediaId: number;
  readonly titleRomaji: string;
  readonly titleEnglish: string | null;
}

export interface TitleMatch<T> {
  readonly entry: T;
  readonly similarity: number;
  /** True when a normalised title matched exactly — reported so the review screen can say which kind of match it is. */
  readonly exact: boolean;
}

/**
 * The best AniList entry for a stored title, or `null`.
 *
 * Compares against BOTH of AniList's titles, because the owner types whichever
 * one they know: "Frieren" is neither "Sousou no Frieren" nor "Frieren: Beyond
 * Journey's End" exactly, and only one of the two is close.
 *
 * Ties keep the earlier candidate, which preserves AniList's own ordering.
 */
export function bestTitleMatch<T extends MatchableEntry>(
  storedTitle: string,
  candidates: readonly T[],
): TitleMatch<T> | null {
  const stored = normalizeTitle(storedTitle);
  if (stored === '') return null;
  const storedOrdinal = ordinalMarker(storedTitle);

  let best: TitleMatch<T> | null = null;

  for (const candidate of candidates) {
    const titles = [candidate.titleRomaji, candidate.titleEnglish].filter(
      (title): title is string => typeof title === 'string' && title.trim() !== '',
    );

    for (const title of titles) {
      // THE HARD GATE. No score gets past a disagreeing season marker.
      if (ordinalMarker(title) !== storedOrdinal) continue;

      const score = similarity(stored, normalizeTitle(title));
      if (score < MATCH_FLOOR) continue;
      if (best !== null && score <= best.similarity) continue;

      best = { entry: candidate, similarity: score, exact: score === 1 };
    }
  }

  return best;
}
