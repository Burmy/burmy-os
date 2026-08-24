/**
 * Attribution of a game's play time to the YEARS it was actually played.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `games.first_played_year` was doing two unrelated jobs: "when did I start
 * this" and "which year owns these hours." For almost every game those
 * coincide. For a game played across a year boundary — a base game in 2024 and
 * its DLC in 2025 — they do not, and the Yearly Breakdown credited every hour
 * to the start year.
 *
 * `games.hours_tenths` REMAINS THE AUTHORITATIVE TOTAL. The rows here are an
 * attribution OF that total, never a replacement for it. That distinction is
 * load-bearing: Steam and PSN own the total for a linked game and have no
 * concept of years, so the total has to stay a single number they can write.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** One owner-entered "I played N hours of this game in year Y" row. */
export interface PlayYearRow {
  readonly gameId: string;
  readonly year: number;
  readonly hoursTenths: number;
}

/** The narrow projection of a game this module needs. */
export interface AttributableGame {
  readonly id: string;
  readonly firstPlayedYear: number | null;
  readonly hoursTenths: number | null;
}

export interface YearAttribution {
  readonly year: number;
  readonly gameId: string;
  readonly hoursTenths: number;
}

export interface AttributionResult {
  readonly attributions: readonly YearAttribution[];
  /**
   * Total hours that belong to a game but to no year, summed across the
   * library. Positive when splits fall short of their totals (the usual case:
   * a sync raised a total and the split has not been rebalanced yet),
   * negative when a split overshoots.
   *
   * Reported rather than silently absorbed. A number that does not add up must
   * be visible — quietly assigning the remainder to a year would invent an
   * attribution the owner never made, and quietly dropping it would make the
   * yearly totals disagree with the library total for no visible reason.
   */
  readonly unattributedTenths: number;
}

/**
 * Precondition: `games` must not contain two entries with the same `id` —
 * this function keys `rowsByGame` by game id and its callers count distinct
 * games from it, so a duplicated id silently collapses two games into one
 * bucket and under-counts. Real game ids are UUIDs, so production data is
 * safe; this matters only for test fixtures that build multiple games and
 * must remember to give each a distinct `id`.
 */
export function attributeHours(
  games: readonly AttributableGame[],
  playYears: readonly PlayYearRow[],
): AttributionResult {
  const rowsByGame = new Map<string, PlayYearRow[]>();
  for (const row of playYears) {
    const existing = rowsByGame.get(row.gameId);
    if (existing === undefined) rowsByGame.set(row.gameId, [row]);
    else existing.push(row);
  }

  const attributions: YearAttribution[] = [];
  let unattributedTenths = 0;

  for (const game of games) {
    const total = game.hoursTenths ?? 0;
    // Rows for a game id that is not in `games` are ignored entirely — they
    // cannot be attributed to a library that does not contain their game, and
    // counting them would make yearly totals exceed the library total.
    const rows = rowsByGame.get(game.id);

    if (rows === undefined || rows.length === 0) {
      // A retro entry with neither a year nor a split is not year zero — it has
      // no place in a year-by-year comparison and is excluded, matching the
      // long-standing behaviour of `buildYearlyBreakdown`.
      if (game.firstPlayedYear === null) continue;
      attributions.push({ year: game.firstPlayedYear, gameId: game.id, hoursTenths: total });
      continue;
    }

    let splitTenths = 0;
    for (const row of rows) {
      attributions.push({ year: row.year, gameId: game.id, hoursTenths: row.hoursTenths });
      splitTenths += row.hoursTenths;
    }
    unattributedTenths += total - splitTenths;
  }

  return { attributions, unattributedTenths };
}

export interface SplitValidation {
  readonly ok: boolean;
  readonly splitTenths: number;
  readonly totalTenths: number;
  /** `totalTenths - splitTenths`. Positive means hours are unaccounted for. */
  readonly differenceTenths: number;
}

/**
 * An empty split is valid: "no split" is the normal state for ~157 of 160
 * games and means "attribute everything to the first-played year," not
 * "zero hours were played."
 */
export function validateSplit(
  totalTenths: number,
  rows: readonly { readonly hoursTenths: number }[],
): SplitValidation {
  const splitTenths = rows.reduce((sum, row) => sum + row.hoursTenths, 0);
  if (rows.length === 0) {
    return { ok: true, splitTenths: 0, totalTenths, differenceTenths: 0 };
  }
  const differenceTenths = totalTenths - splitTenths;
  return { ok: differenceTenths === 0, splitTenths, totalTenths, differenceTenths };
}
