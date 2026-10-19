/**
 * DLC — expansions the owner played, recorded as rows on the game they extend.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDITIVE, NOT ATTRIBUTED.
 *
 * The game's own `hoursTenths`, `priceCents`, `achievementsUnlocked` and
 * `achievementsTotal` are the BASE GAME's figures. A DLC row carries its own
 * hours, price and trophies, and every total the app shows outside the panel
 * — library table, every Stats card, leaderboards, cost per hour — is
 * base + every DLC row, computed here at read time. Nothing has to "add up":
 * that is the whole difference from `play-years.ts`, which apportions the
 * base game's own total across years and must sum to it.
 *
 * A missing figure stays missing. `sumDlc` returns `null` for a field no row
 * carries and `gameTotals` returns `null` only when BOTH the base and the DLC
 * side are null — a `0` would read as "tracked, and zero", which is a
 * different fact from "never recorded" (see `stats.ts`, which already keeps
 * those apart for the base figures).
 *
 * Pure TypeScript, no React, no Next, no database — same boundary rule as
 * the rest of `src/server/games/`. Hours stay in tenths (integers) here;
 * formatting is `hours.ts`'s job.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** One DLC row as the data layer returns it. */
export interface GameDlcRow {
  readonly id: string;
  readonly gameId: string;
  readonly name: string;
  /** The year the owner PLAYED it, not its release year. */
  readonly year: number;
  readonly hoursTenths: number | null;
  readonly priceCents: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
}

/** The four additive figures, summed. `null` = no row carried that figure. */
export interface DlcSums {
  readonly hoursTenths: number | null;
  readonly priceCents: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
}

/** The narrow projection of a game `gameTotals` needs — the base figures. */
export interface Totalable {
  readonly hoursTenths: number | null;
  readonly priceCents: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
}

/**
 * `null` + `null` → `null`; otherwise a plain integer sum where a `null` on
 * either side contributes nothing. `-0` can only arise from signed inputs,
 * which no caller produces, but the normalisation costs nothing and this is
 * exactly the class of bug CLAUDE.md records for plain-number modules.
 */
function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  const sum = (a ?? 0) + (b ?? 0);
  return sum === 0 ? 0 : sum;
}

export function sumDlc(rows: readonly GameDlcRow[]): DlcSums {
  let hoursTenths: number | null = null;
  let priceCents: number | null = null;
  let achievementsUnlocked: number | null = null;
  let achievementsTotal: number | null = null;
  for (const row of rows) {
    hoursTenths = addNullable(hoursTenths, row.hoursTenths);
    priceCents = addNullable(priceCents, row.priceCents);
    achievementsUnlocked = addNullable(achievementsUnlocked, row.achievementsUnlocked);
    achievementsTotal = addNullable(achievementsTotal, row.achievementsTotal);
  }
  return { hoursTenths, priceCents, achievementsUnlocked, achievementsTotal };
}

/** Base + every DLC row. With no rows this is the base figures exactly. */
export function gameTotals(game: Totalable, dlc: readonly GameDlcRow[]): DlcSums {
  const sums = sumDlc(dlc);
  return {
    hoursTenths: addNullable(game.hoursTenths, sums.hoursTenths),
    priceCents: addNullable(game.priceCents, sums.priceCents),
    achievementsUnlocked: addNullable(game.achievementsUnlocked, sums.achievementsUnlocked),
    achievementsTotal: addNullable(game.achievementsTotal, sums.achievementsTotal),
  };
}

/** Rows keyed by `gameId`, each group in the order the rows were given. */
export function groupDlcByGame(
  rows: readonly GameDlcRow[],
): ReadonlyMap<string, readonly GameDlcRow[]> {
  const byGame = new Map<string, GameDlcRow[]>();
  for (const row of rows) {
    const existing = byGame.get(row.gameId);
    if (existing === undefined) byGame.set(row.gameId, [row]);
    else existing.push(row);
  }
  return byGame;
}
