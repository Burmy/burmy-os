# Games Play-Year Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute a game's hours to the years they were actually played, so the Yearly Breakdown stops crediting 43 hours to the wrong year.

**Architecture:** A new `game_play_years` child table stores optional per-year hour rows. `games.hours_tenths` remains the authoritative total; the rows are an *attribution* of it. A game with no rows attributes everything to `first_played_year` — today's exact behaviour, so 157 of 160 games need no migration. A new pure module `src/server/games/play-years.ts` owns attribution and split validation; `buildYearlyBreakdown` consumes it.

**Tech Stack:** TypeScript strict, Drizzle ORM 0.45, PostgreSQL 18, React 19, Vitest, Testcontainers.

**Spec:** `docs/superpowers/specs/2026-08-23-games-sync-and-play-years-design.md` (Part 1)

## Global Constraints

- **Hours are integer TENTHS of an hour, never floats.** All conversion goes through `src/server/games/hours.ts` and nothing else does hours math (`CLAUDE.md`).
- **`src/server/games/` must stay framework-free** — pure TypeScript, no React, no Next, no HTTP.
- **Every protected server entry point calls `await requireOwner()` itself.**
- **`exactOptionalPropertyTypes` is on.** Never assign `undefined` to an optional property; omit the key. Once more than two or three optional fields are assembled at once, use a mutable local object with plain `if (cond) obj.key = value` statements rather than merged conditional spreads — merged spreads lose precision and infer `T | undefined`.
- **Drizzle index callbacks return an ARRAY:** `(t) => [ index(...), uniqueIndex(...) ]`.
- **Drizzle WRAPS driver errors.** Never test `error.code === '23505'`; use `isUniqueViolation()` from `src/server/db/finance/errors.ts`, which walks the `cause` chain.
- **`updatedAt` is set manually in application code** — there is no DB trigger.
- **Postgres has no `MIN()`/`MAX()` for `uuid`.** Cast the column, not the aggregate result: `min(id::text)`.
- **Vitest projects split by extension:** `.test.ts` → `domain` (node), `.test.tsx` → `components` (jsdom). To scope a run use `npx vitest run --project domain <name>` — `pnpm test --project domain -- <name>` does NOT scope correctly.
- **Integration tests must import application modules dynamically inside `beforeAll`, after `await harness()`.**
- **Never run `pnpm test:e2e` against the local dev database** — it truncates tables and has already destroyed real data once.
- Quality gate before any task is considered done: `pnpm typecheck && pnpm lint && pnpm test`.

---

### Task 1: Pure attribution domain module

**Files:**
- Create: `src/server/games/play-years.ts`
- Test: `tests/unit/games-play-years.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `interface PlayYearRow { readonly gameId: string; readonly year: number; readonly hoursTenths: number }`
  - `interface AttributableGame { readonly id: string; readonly firstPlayedYear: number | null; readonly hoursTenths: number | null }`
  - `interface YearAttribution { readonly year: number; readonly gameId: string; readonly hoursTenths: number }`
  - `interface AttributionResult { readonly attributions: readonly YearAttribution[]; readonly unattributedTenths: number }`
  - `function attributeHours(games: readonly AttributableGame[], playYears: readonly PlayYearRow[]): AttributionResult`
  - `interface SplitValidation { readonly ok: boolean; readonly splitTenths: number; readonly totalTenths: number; readonly differenceTenths: number }`
  - `function validateSplit(totalTenths: number, rows: readonly { readonly hoursTenths: number }[]): SplitValidation`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/games-play-years.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  type AttributableGame,
  type PlayYearRow,
  attributeHours,
  validateSplit,
} from '@/server/games/play-years';

function game(overrides: Partial<AttributableGame> = {}): AttributableGame {
  return { id: 'game-1', firstPlayedYear: 2024, hoursTenths: 490, ...overrides };
}

describe('attributeHours', () => {
  it('attributes all hours to firstPlayedYear when a game has no split rows', () => {
    const result = attributeHours([game({ id: 'g1', firstPlayedYear: 2024, hoursTenths: 490 })], []);

    expect(result.attributions).toEqual([{ year: 2024, gameId: 'g1', hoursTenths: 490 }]);
    expect(result.unattributedTenths).toBe(0);
  });

  it('uses the split rows instead of firstPlayedYear when they exist', () => {
    const rows: PlayYearRow[] = [
      { gameId: 'g1', year: 2024, hoursTenths: 370 },
      { gameId: 'g1', year: 2025, hoursTenths: 120 },
    ];

    const result = attributeHours([game({ id: 'g1', firstPlayedYear: 2024, hoursTenths: 490 })], rows);

    expect(result.attributions).toEqual([
      { year: 2024, gameId: 'g1', hoursTenths: 370 },
      { year: 2025, gameId: 'g1', hoursTenths: 120 },
    ]);
    expect(result.unattributedTenths).toBe(0);
  });

  it('excludes a game with no year and no split rows rather than bucketing it at year zero', () => {
    const result = attributeHours([game({ id: 'g1', firstPlayedYear: null })], []);

    expect(result.attributions).toEqual([]);
  });

  it('still attributes a game with no firstPlayedYear when it has explicit split rows', () => {
    const rows: PlayYearRow[] = [{ gameId: 'g1', year: 2019, hoursTenths: 80 }];

    const result = attributeHours([game({ id: 'g1', firstPlayedYear: null, hoursTenths: 80 })], rows);

    expect(result.attributions).toEqual([{ year: 2019, gameId: 'g1', hoursTenths: 80 }]);
  });

  it('treats a null total as zero hours', () => {
    const result = attributeHours([game({ id: 'g1', firstPlayedYear: 2020, hoursTenths: null })], []);

    expect(result.attributions).toEqual([{ year: 2020, gameId: 'g1', hoursTenths: 0 }]);
  });

  it('reports the remainder when a split does not account for the whole total', () => {
    // Steam moved the total to 51.0h; the owner's split still says 37 + 12 = 49.0h.
    const rows: PlayYearRow[] = [
      { gameId: 'g1', year: 2024, hoursTenths: 370 },
      { gameId: 'g1', year: 2025, hoursTenths: 120 },
    ];

    const result = attributeHours([game({ id: 'g1', hoursTenths: 510 })], rows);

    expect(result.unattributedTenths).toBe(20);
  });

  it('reports a NEGATIVE remainder when a split over-accounts for the total', () => {
    const rows: PlayYearRow[] = [{ gameId: 'g1', year: 2024, hoursTenths: 600 }];

    const result = attributeHours([game({ id: 'g1', hoursTenths: 490 })], rows);

    expect(result.unattributedTenths).toBe(-110);
  });

  it('ignores split rows belonging to a game not in the list', () => {
    const rows: PlayYearRow[] = [{ gameId: 'ghost', year: 2024, hoursTenths: 999 }];

    const result = attributeHours([game({ id: 'g1', firstPlayedYear: 2024, hoursTenths: 490 })], rows);

    expect(result.attributions).toEqual([{ year: 2024, gameId: 'g1', hoursTenths: 490 }]);
    expect(result.unattributedTenths).toBe(0);
  });

  it('sums remainders across several games', () => {
    const games = [game({ id: 'g1', hoursTenths: 510 }), game({ id: 'g2', hoursTenths: 200 })];
    const rows: PlayYearRow[] = [
      { gameId: 'g1', year: 2024, hoursTenths: 490 },
      { gameId: 'g2', year: 2024, hoursTenths: 150 },
    ];

    expect(attributeHours(games, rows).unattributedTenths).toBe(70);
  });
});

describe('validateSplit', () => {
  it('accepts a split that sums exactly to the total', () => {
    expect(validateSplit(490, [{ hoursTenths: 370 }, { hoursTenths: 120 }])).toEqual({
      ok: true,
      splitTenths: 490,
      totalTenths: 490,
      differenceTenths: 0,
    });
  });

  it('rejects a split that falls short and reports the shortfall', () => {
    expect(validateSplit(510, [{ hoursTenths: 370 }, { hoursTenths: 120 }])).toEqual({
      ok: false,
      splitTenths: 490,
      totalTenths: 510,
      differenceTenths: 20,
    });
  });

  it('rejects a split that overshoots and reports a negative difference', () => {
    expect(validateSplit(490, [{ hoursTenths: 600 }])).toEqual({
      ok: false,
      splitTenths: 600,
      totalTenths: 490,
      differenceTenths: -110,
    });
  });

  it('treats an empty split as valid — no split means no constraint', () => {
    expect(validateSplit(490, []).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project domain games-play-years`
Expected: FAIL — cannot resolve `@/server/games/play-years`.

- [ ] **Step 3: Write the implementation**

Create `src/server/games/play-years.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project domain games-play-years`
Expected: PASS, 13 tests.

- [ ] **Step 5: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass; test count rises by 13.

- [ ] **Step 6: Commit**

```bash
git add src/server/games/play-years.ts tests/unit/games-play-years.test.ts
git commit -m "feat(games): pure play-year attribution and split validation"
```

---

### Task 2: Schema, migration, and data access

**Files:**
- Modify: `src/server/db/schema.ts` (add `gamePlayYears` after the `games` table)
- Create: `drizzle/0007_*.sql` (generated)
- Create: `src/server/db/games/play-years.ts`
- Test: `tests/integration/games-play-years.test.ts`

**Interfaces:**
- Consumes: `PlayYearRow` from Task 1.
- Produces:
  - `function listPlayYears(ownerId: string): Promise<PlayYearRow[]>`
  - `function listPlayYearsForGame(ownerId: string, gameId: string): Promise<PlayYearRow[]>`
  - `function replacePlayYears(ownerId: string, gameId: string, rows: readonly { readonly year: number; readonly hoursTenths: number }[]): Promise<void>`

- [ ] **Step 1: Add the table to the schema**

In `src/server/db/schema.ts`, immediately after the `games` table definition, add:

```ts
/**
 * Optional per-year attribution of a game's play time.
 *
 * A game with NO rows here attributes all of `games.hours_tenths` to
 * `games.first_played_year` — the behaviour every game had before this table
 * existed, which is why ~157 of 160 rows needed no backfill.
 *
 * `games.hours_tenths` stays the authoritative total; these rows only say
 * WHICH YEARS it happened in. See src/server/games/play-years.ts.
 */
export const gamePlayYears = pgTable(
  'game_play_years',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    year: smallint('year').notNull(),
    hoursTenths: integer('hours_tenths').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per game per year — two rows for the same year would be an
    // ambiguous split, not extra detail.
    uniqueIndex('game_play_years_game_year_idx').on(t.gameId, t.year),
    index('game_play_years_owner_idx').on(t.ownerId),
  ],
);
```

`ownerId` is carried explicitly even though it is reachable through `gameId`, matching every other table in this app so data access stays owner-scoped without a join.

- [ ] **Step 2: Generate and apply the migration**

```bash
pnpm db:generate
docker compose -f compose.dev.yml up -d postgres
pnpm db:migrate
```

Expected: a new `drizzle/0007_*.sql` containing `CREATE TABLE "game_play_years"`, a unique index on `(game_id, year)`, and both foreign keys with `ON DELETE CASCADE`. **Read the generated SQL before continuing** and confirm the cascades are present — a missing cascade turns a game delete into a foreign-key error.

If `pnpm db:migrate` fails with `ECONNREFUSED`, Docker Desktop is not running. Start it and retry.

- [ ] **Step 3: Write the failing integration tests**

Create `tests/integration/games-play-years.test.ts`:

```ts
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * The play-year data access layer against real PostgreSQL 18. Integration
 * rather than unit because everything worth proving here belongs to the
 * database: the (game_id, year) unique index, owner scoping in every WHERE,
 * and the cascade from `games`.
 */

type PlayYears = typeof import('@/server/db/games/play-years');
type Games = typeof import('@/server/db/games/games');

let playYears: PlayYears;
let games: Games;

beforeAll(async () => {
  await harness();
  [playYears, games] = await Promise.all([
    import('@/server/db/games/play-years'),
    import('@/server/db/games/games'),
  ]);
});

beforeEach(async () => {
  await resetDatabase();
});

async function makeOwner(email: string): Promise<string> {
  const { sql } = await harness();
  const { randomUUID } = await import('node:crypto');
  const id = randomUUID();
  await sql`
    insert into "user" ("id", "name", "email", "email_verified")
    values (${id}, ${email}, ${email}, true)
  `;
  return id;
}

async function makeGame(ownerId: string, title: string): Promise<string> {
  const created = await games.createGame(ownerId, {
    title,
    platform: 'steam',
    status: 'completed',
    hours: 490,
    platinum: false,
  });
  return created.id;
}

describe('play-year data access', () => {
  it('round-trips a split for one game', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');

    await playYears.replacePlayYears(owner, gameId, [
      { year: 2024, hoursTenths: 370 },
      { year: 2025, hoursTenths: 120 },
    ]);

    const rows = await playYears.listPlayYearsForGame(owner, gameId);
    expect(rows).toEqual([
      { gameId, year: 2024, hoursTenths: 370 },
      { gameId, year: 2025, hoursTenths: 120 },
    ]);
  });

  it('replaces rather than appends on a second call', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');

    await playYears.replacePlayYears(owner, gameId, [{ year: 2024, hoursTenths: 490 }]);
    await playYears.replacePlayYears(owner, gameId, [
      { year: 2024, hoursTenths: 370 },
      { year: 2025, hoursTenths: 120 },
    ]);

    expect(await playYears.listPlayYearsForGame(owner, gameId)).toHaveLength(2);
  });

  it('clears a split when handed an empty list', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');

    await playYears.replacePlayYears(owner, gameId, [{ year: 2024, hoursTenths: 490 }]);
    await playYears.replacePlayYears(owner, gameId, []);

    expect(await playYears.listPlayYearsForGame(owner, gameId)).toEqual([]);
  });

  it('never returns another owner rows', async () => {
    const mine = await makeOwner('mine@example.invalid');
    const theirs = await makeOwner('theirs@example.invalid');
    const myGame = await makeGame(mine, 'Hollow Knight');
    const theirGame = await makeGame(theirs, 'Lies of P');

    await playYears.replacePlayYears(mine, myGame, [{ year: 2024, hoursTenths: 370 }]);
    await playYears.replacePlayYears(theirs, theirGame, [{ year: 2024, hoursTenths: 520 }]);

    const all = await playYears.listPlayYears(mine);
    expect(all).toEqual([{ gameId: myGame, year: 2024, hoursTenths: 370 }]);
  });

  it('refuses to write a split onto another owner game', async () => {
    const mine = await makeOwner('mine@example.invalid');
    const theirs = await makeOwner('theirs@example.invalid');
    const theirGame = await makeGame(theirs, 'Lies of P');

    await playYears.replacePlayYears(mine, theirGame, [{ year: 2024, hoursTenths: 370 }]);

    expect(await playYears.listPlayYearsForGame(theirs, theirGame)).toEqual([]);
  });

  it('cascades away when its game is deleted', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');
    await playYears.replacePlayYears(owner, gameId, [{ year: 2024, hoursTenths: 370 }]);

    await games.deleteGame(owner, gameId);

    expect(await playYears.listPlayYears(owner)).toEqual([]);
  });

  it('orders rows by year ascending', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');

    await playYears.replacePlayYears(owner, gameId, [
      { year: 2025, hoursTenths: 120 },
      { year: 2023, hoursTenths: 10 },
      { year: 2024, hoursTenths: 370 },
    ]);

    expect((await playYears.listPlayYearsForGame(owner, gameId)).map((r) => r.year)).toEqual([2023, 2024, 2025]);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm test:integration -- games-play-years`
Expected: FAIL — cannot resolve `@/server/db/games/play-years`.

- [ ] **Step 5: Write the data access layer**

Create `src/server/db/games/play-years.ts`:

```ts
import { and, asc, eq } from 'drizzle-orm';

import { getDb } from '@/server/db/client';
import { gamePlayYears, games } from '@/server/db/schema';
import type { PlayYearRow } from '@/server/games/play-years';

/** Every split row the owner has, for the stats page's single query. */
export async function listPlayYears(ownerId: string): Promise<PlayYearRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      gameId: gamePlayYears.gameId,
      year: gamePlayYears.year,
      hoursTenths: gamePlayYears.hoursTenths,
    })
    .from(gamePlayYears)
    .where(eq(gamePlayYears.ownerId, ownerId))
    .orderBy(asc(gamePlayYears.gameId), asc(gamePlayYears.year));

  return rows;
}

export async function listPlayYearsForGame(ownerId: string, gameId: string): Promise<PlayYearRow[]> {
  const db = getDb();
  return db
    .select({
      gameId: gamePlayYears.gameId,
      year: gamePlayYears.year,
      hoursTenths: gamePlayYears.hoursTenths,
    })
    .from(gamePlayYears)
    .where(and(eq(gamePlayYears.ownerId, ownerId), eq(gamePlayYears.gameId, gameId)))
    .orderBy(asc(gamePlayYears.year));
}

/**
 * Delete-then-insert rather than a diff. A split is at most a handful of rows
 * and is always edited as a whole in the UI, so reconciling row-by-row would
 * be more code for no behavioural difference. Wrapped in a transaction so a
 * failed insert cannot leave the game with no split at all.
 *
 * The game is re-checked against `ownerId` inside the transaction: passing a
 * game id belonging to someone else must be a silent no-op, never a write.
 */
export async function replacePlayYears(
  ownerId: string,
  gameId: string,
  rows: readonly { readonly year: number; readonly hoursTenths: number }[],
): Promise<void> {
  const db = getDb();

  await db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: games.id })
      .from(games)
      .where(and(eq(games.id, gameId), eq(games.ownerId, ownerId)))
      .limit(1);

    if (owned.length === 0) return;

    await tx
      .delete(gamePlayYears)
      .where(and(eq(gamePlayYears.ownerId, ownerId), eq(gamePlayYears.gameId, gameId)));

    if (rows.length === 0) return;

    await tx.insert(gamePlayYears).values(
      rows.map((row) => ({
        ownerId,
        gameId,
        year: row.year,
        hoursTenths: row.hoursTenths,
      })),
    );
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test:integration -- games-play-years`
Expected: PASS, 7 tests.

- [ ] **Step 7: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`

- [ ] **Step 8: Commit**

```bash
git add src/server/db/schema.ts src/server/db/games/play-years.ts drizzle/ tests/integration/games-play-years.test.ts
git commit -m "feat(games): game_play_years table and owner-scoped data access"
```

---

### Task 3: Feed attribution into the yearly breakdown

**Files:**
- Modify: `src/server/games/stats.ts` (`YearlyBreakdownRow`, `buildYearlyBreakdown`)
- Modify: `tests/unit/games-stats.test.ts`
- Modify: `src/features/games/dashboard/games-dashboard.tsx`
- Modify: `src/features/games/dashboard/charts/games-per-year-chart.tsx`
- Modify: `src/features/games/dashboard/yearly-breakdown-table.tsx`
- Modify: `src/app/(private)/games/(tabs)/stats/page.tsx`

**Interfaces:**
- Consumes: `attributeHours`, `PlayYearRow` (Task 1); `listPlayYears` (Task 2).
- Produces:
  - `interface YearlyBreakdownRow { readonly year: number; readonly startedCount: number; readonly playedCount: number; readonly hoursTenths: number; readonly achievements: number; readonly hoursChangeTenths: number | null }`
  - `interface YearlyBreakdown { readonly rows: readonly YearlyBreakdownRow[]; readonly unattributedTenths: number }`
  - `function buildYearlyBreakdown(rows: readonly GameStatRow[], playYears: readonly PlayYearRow[]): YearlyBreakdown`

**Note on the rename:** `gameCount` becomes `startedCount`. This is deliberate rather than additive — leaving a field called `gameCount` next to a new `playedCount` would leave every future reader guessing which one it is. The rename is what forces `games-per-year-chart.tsx` to be looked at, which is correct: that chart has always plotted games *started* per year.

**Note on achievements:** achievements stay attributed to `firstPlayedYear`, unsplit. There is no per-year achievement data anywhere — not in the library, not from Steam, not from PSN — so splitting them would require inventing it. This is a real limitation and is commented as such in the code, not silently glossed.

- [ ] **Step 1: Update the stats unit tests to the new shape**

In `tests/unit/games-stats.test.ts`, replace the entire `describe('buildYearlyBreakdown', ...)` block with:

```ts
describe('buildYearlyBreakdown', () => {
  it('groups games, hours, and achievements by year, newest first', () => {
    const { rows } = buildYearlyBreakdown(
      [
        game({ id: 'a', firstPlayedYear: 2022, hoursTenths: 100, achievementsUnlocked: 5 }),
        game({ id: 'b', firstPlayedYear: 2023, hoursTenths: 200, achievementsUnlocked: 7 }),
        game({ id: 'c', firstPlayedYear: 2023, hoursTenths: 50, achievementsUnlocked: 1 }),
      ],
      [],
    );

    expect(rows.map((r) => r.year)).toEqual([2023, 2022]);
    expect(rows[0]).toMatchObject({ year: 2023, startedCount: 2, playedCount: 2, hoursTenths: 250, achievements: 8 });
    expect(rows[1]).toMatchObject({ year: 2022, startedCount: 1, playedCount: 1, hoursTenths: 100, achievements: 5 });
  });

  it('excludes a game with no first-played year', () => {
    const { rows } = buildYearlyBreakdown([game({ firstPlayedYear: null })], []);
    expect(rows).toEqual([]);
  });

  it('treats null hours and null achievements as zero', () => {
    const { rows } = buildYearlyBreakdown(
      [game({ firstPlayedYear: 2020, hoursTenths: null, achievementsUnlocked: null })],
      [],
    );
    expect(rows[0]).toMatchObject({ year: 2020, hoursTenths: 0, achievements: 0 });
  });

  it('reports hours in the year they were played, not the year the game started', () => {
    // The bug this whole feature exists to fix: 37h in 2024, 12h in 2025.
    const { rows } = buildYearlyBreakdown(
      [game({ id: 'hk', firstPlayedYear: 2024, hoursTenths: 490, achievementsUnlocked: 3 })],
      [
        { gameId: 'hk', year: 2024, hoursTenths: 370 },
        { gameId: 'hk', year: 2025, hoursTenths: 120 },
      ],
    );

    expect(rows.map((r) => [r.year, r.hoursTenths])).toEqual([
      [2025, 120],
      [2024, 370],
    ]);
  });

  it('counts a split game as started once but played in every year it touched', () => {
    const { rows } = buildYearlyBreakdown(
      [game({ id: 'hk', firstPlayedYear: 2024, hoursTenths: 490 })],
      [
        { gameId: 'hk', year: 2024, hoursTenths: 370 },
        { gameId: 'hk', year: 2025, hoursTenths: 120 },
      ],
    );

    const byYear = new Map(rows.map((r) => [r.year, r]));
    expect(byYear.get(2024)).toMatchObject({ startedCount: 1, playedCount: 1 });
    expect(byYear.get(2025)).toMatchObject({ startedCount: 0, playedCount: 1 });
  });

  it('keeps achievements on the start year even when hours are split', () => {
    const { rows } = buildYearlyBreakdown(
      [game({ id: 'hk', firstPlayedYear: 2024, hoursTenths: 490, achievementsUnlocked: 9 })],
      [
        { gameId: 'hk', year: 2024, hoursTenths: 370 },
        { gameId: 'hk', year: 2025, hoursTenths: 120 },
      ],
    );

    const byYear = new Map(rows.map((r) => [r.year, r]));
    expect(byYear.get(2024)?.achievements).toBe(9);
    expect(byYear.get(2025)?.achievements).toBe(0);
  });

  it('surfaces hours a split fails to account for', () => {
    const { unattributedTenths } = buildYearlyBreakdown(
      [game({ id: 'hk', firstPlayedYear: 2024, hoursTenths: 510 })],
      [{ gameId: 'hk', year: 2024, hoursTenths: 490 }],
    );

    expect(unattributedTenths).toBe(20);
  });

  it('computes the year-over-year change from attributed hours', () => {
    const { rows } = buildYearlyBreakdown(
      [
        game({ id: 'a', firstPlayedYear: 2022, hoursTenths: 100 }),
        game({ id: 'b', firstPlayedYear: 2023, hoursTenths: 250 }),
      ],
      [],
    );

    const byYear = new Map(rows.map((r) => [r.year, r]));
    expect(byYear.get(2022)?.hoursChangeTenths).toBeNull();
    expect(byYear.get(2023)?.hoursChangeTenths).toBe(150);
  });
});
```

The shared `game()` helper in that file does not set `id` per call; add `id` to its `overrides` usage as shown above (it already spreads `overrides`, so passing `id` works with no helper change).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project domain games-stats`
Expected: FAIL — `buildYearlyBreakdown` takes one argument and returns an array.

- [ ] **Step 3: Rewrite `buildYearlyBreakdown`**

In `src/server/games/stats.ts`, add the import at the top:

```ts
import { type PlayYearRow, attributeHours } from './play-years';
```

Replace the `YearlyBreakdownRow` interface and the `buildYearlyBreakdown` function with:

```ts
export interface YearlyBreakdownRow {
  readonly year: number;
  /** Games whose `firstPlayedYear` is this year. Sums to the library total across years. */
  readonly startedCount: number;
  /**
   * Distinct games with hours attributed to this year. Deliberately does NOT
   * sum to the library total: a game played across two years is genuinely
   * played in both, and counting it once would hide that.
   */
  readonly playedCount: number;
  readonly hoursTenths: number;
  readonly achievements: number;
  /** Hours vs the previous year present in the data. Null for the earliest year. */
  readonly hoursChangeTenths: number | null;
}

export interface YearlyBreakdown {
  readonly rows: readonly YearlyBreakdownRow[];
  /** See `AttributionResult.unattributedTenths`. Rendered as its own line, never folded into a year. */
  readonly unattributedTenths: number;
}

/**
 * Year → games/hours/achievements, newest first. No `currentYear` parameter —
 * this module has no notion of "today"; a caller that wants to highlight the
 * in-progress year passes it in separately when rendering these rows, not
 * when building them.
 *
 * Hours come from `attributeHours`, so a game played across two years lands in
 * both. Achievements do NOT: they stay on `firstPlayedYear` because no source
 * anywhere — the library, Steam, or PSN — records which year a trophy was
 * earned in, and splitting them proportionally would fabricate data.
 */
export function buildYearlyBreakdown(
  rows: readonly GameStatRow[],
  playYears: readonly PlayYearRow[],
): YearlyBreakdown {
  const { attributions, unattributedTenths } = attributeHours(rows, playYears);

  const byYear = new Map<
    number,
    { startedCount: number; playedGames: Set<string>; hoursTenths: number; achievements: number }
  >();

  function bucket(year: number): {
    startedCount: number;
    playedGames: Set<string>;
    hoursTenths: number;
    achievements: number;
  } {
    const existing = byYear.get(year);
    if (existing !== undefined) return existing;
    const created = { startedCount: 0, playedGames: new Set<string>(), hoursTenths: 0, achievements: 0 };
    byYear.set(year, created);
    return created;
  }

  for (const attribution of attributions) {
    const target = bucket(attribution.year);
    target.hoursTenths += attribution.hoursTenths;
    target.playedGames.add(attribution.gameId);
  }

  for (const row of rows) {
    // A retro entry with no year is not year zero — it has no place in a
    // year-by-year comparison and is excluded rather than bucketed.
    if (row.firstPlayedYear === null) continue;
    const target = bucket(row.firstPlayedYear);
    target.startedCount += 1;
    target.achievements += row.achievementsUnlocked ?? 0;
  }

  const ascending = [...byYear.entries()].sort((a, b) => a[0] - b[0]);

  const built = ascending
    .map(([year, data], index) => {
      const previous = index === 0 ? null : ascending[index - 1]![1];
      return {
        year,
        startedCount: data.startedCount,
        playedCount: data.playedGames.size,
        hoursTenths: data.hoursTenths,
        achievements: data.achievements,
        hoursChangeTenths: previous === null ? null : data.hoursTenths - previous.hoursTenths,
      };
    })
    .sort((a, b) => b.year - a.year);

  return { rows: built, unattributedTenths };
}
```

- [ ] **Step 4: Run to verify the domain tests pass**

Run: `npx vitest run --project domain games-stats games-play-years`
Expected: PASS.

- [ ] **Step 5: Update the three consumers**

`src/app/(private)/games/(tabs)/stats/page.tsx` — fetch splits alongside the rows:

```tsx
import type { Metadata } from 'next';

import { GamesDashboard } from '@/features/games/dashboard/games-dashboard';
import { requireOwner } from '@/server/auth/owner';
import { listGameStatRows } from '@/server/db/games/games';
import { listPlayYears } from '@/server/db/games/play-years';

export const metadata: Metadata = { title: 'Game stats — Burmy' };

export default async function GamesStatsPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const [rows, playYears] = await Promise.all([
    listGameStatRows(owner.userId),
    listPlayYears(owner.userId),
  ]);

  // The clock is read HERE and passed down, so every pure function below stays
  // reproducible and testable without mocking time.
  const currentYear = new Date().getUTCFullYear();

  return <GamesDashboard rows={rows} playYears={playYears} currentYear={currentYear} />;
}
```

`src/features/games/dashboard/games-dashboard.tsx` — accept and forward the new prop. Add to the imports:

```tsx
import type { PlayYearRow } from '@/server/games/play-years';
```

Change the signature and the `buildYearlyBreakdown` call:

```tsx
export function GamesDashboard({
  rows,
  playYears,
  currentYear,
}: {
  readonly rows: readonly GameStatRow[];
  readonly playYears: readonly PlayYearRow[];
  readonly currentYear: number;
}): React.ReactElement {
  const summary = buildLibrarySummary(rows);
  const financial = buildFinancialSummary(rows);
  const yearly = buildYearlyBreakdown(rows, playYears);
  const callouts = findCallouts(rows);
```

Then every existing use of `yearly` as an array becomes `yearly.rows`. Search the file for `yearly` and update each site — the charts and the table all take `rows={yearly}` today and must become `rows={yearly.rows}`. Pass the remainder to the table:

```tsx
<YearlyBreakdownTable
  rows={yearly.rows}
  unattributedTenths={yearly.unattributedTenths}
  currentYear={currentYear}
/>
```

`src/features/games/dashboard/charts/games-per-year-chart.tsx` — the field rename. Change the `YAxis` domain and the `Line`'s `dataKey`:

```tsx
domain={computeChartDomain(data.map((row) => row.startedCount))}
```

and the `<Line ... dataKey="gameCount" ... />` becomes `dataKey="startedCount"`. Update the tooltip's label if it names the field. Leave the chart's meaning unchanged — it has always shown games started per year.

- [ ] **Step 6: Update the yearly breakdown table**

Rewrite `src/features/games/dashboard/yearly-breakdown-table.tsx`'s props, totals, header, and body to carry both counts and the remainder:

```tsx
export function YearlyBreakdownTable({
  rows,
  unattributedTenths,
  currentYear,
}: {
  readonly rows: readonly YearlyBreakdownRow[];
  readonly unattributedTenths: number;
  readonly currentYear: number;
}): React.ReactElement {
```

Totals — note `playedCount` is deliberately NOT summed into a library total, because a game spanning two years appears in both years and the sum would exceed the library size:

```tsx
  const totals = rows.reduce(
    (sum, row) => ({
      startedCount: sum.startedCount + row.startedCount,
      hoursTenths: sum.hoursTenths + row.hoursTenths,
      achievements: sum.achievements + row.achievements,
    }),
    { startedCount: 0, hoursTenths: 0, achievements: 0 },
  );
```

Header gains one column:

```tsx
<TableHead className="text-right">Started</TableHead>
<TableHead className="text-right">Played</TableHead>
```

replacing the single `Games` head, with `title` attributes explaining the difference so the distinction is legible without reading the design doc:

```tsx
<TableHead className="text-right" title="Games first played this year">Started</TableHead>
<TableHead className="text-right" title="Games with hours recorded in this year, including ones started earlier">Played</TableHead>
```

Body cells follow the same order (`row.startedCount`, then `row.playedCount`). The totals row shows `totals.startedCount` under Started and an em dash under Played, because that column does not total meaningfully.

Immediately before the `Total` row, render the remainder only when it is non-zero:

```tsx
{unattributedTenths === 0 ? null : (
  <TableRow className="text-muted-foreground">
    <TableCell className="text-sm italic" title="Hours recorded on a game whose year-by-year split does not add up to its total">
      Unattributed
    </TableCell>
    <TableCell className="tabular text-right">—</TableCell>
    <TableCell className="tabular text-right">—</TableCell>
    <TableCell className="tabular text-right">
      {unattributedTenths < 0 ? '−' : ''}
      {formatHours(hours(Math.abs(unattributedTenths)))}
    </TableCell>
    <TableCell />
    <TableCell className="tabular text-right">—</TableCell>
  </TableRow>
)}
```

Check the final cell count against the header — the table has Year, Started, Played, Hours, vs. prev, Achievements = six columns, and every row including `Total` must have six cells or the table will render misaligned.

- [ ] **Step 7: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass. If `typecheck` reports `yearly` used as an array anywhere, a `yearly.rows` site was missed in Step 5.

- [ ] **Step 8: Verify in the browser**

```bash
pnpm dev
```

Open `/games/stats`. Expected: the Yearly Breakdown shows Started and Played columns, both identical for every year (no splits exist yet — that is Task 5), no Unattributed row, and the same hours totals as before this task. **If any number changed, that is a bug** — with no split rows in the database, attribution must be byte-identical to the old behaviour.

- [ ] **Step 9: Commit**

```bash
git add src/server/games/stats.ts src/features/games/dashboard src/app/\(private\)/games tests/unit/games-stats.test.ts
git commit -m "feat(games): attribute yearly hours to the years actually played"
```

---

### Task 4: The split editor panel

**Files:**
- Create: `src/features/games/library/play-years-panel.tsx`
- Modify: `src/features/games/library/game-dialog.tsx`
- Modify: `src/features/games/game-actions.ts`
- Modify: `src/server/db/games/games.ts` (`Game` gains `playYears`)
- Test: `tests/unit/games-play-years-panel.test.tsx`

**Interfaces:**
- Consumes: `validateSplit` (Task 1), `replacePlayYears` / `listPlayYearsForGame` (Task 2).
- Produces:
  - `function PlayYearsPanel(props: { readonly value: readonly PlayYearDraft[]; readonly onChange: (next: readonly PlayYearDraft[]) => void; readonly totalTenths: number }): React.ReactElement`
  - `interface PlayYearDraft { readonly year: string; readonly hours: string }`
  - FormData contract: the dialog sets a single `playYears` key to `JSON.stringify(PlayYearDraft[])`.

**Why a JSON field rather than indexed inputs:** a repeatable list of pairs has no clean native FormData representation, and the alternative (`playYears[0][year]` style names) would need bespoke parsing in `parse()` that is far more code than one `JSON.parse` behind a zod schema. The dialog already sets several keys explicitly via `formData.set` (`platform`, `status`, `coverUrl`, …), so this follows the file's existing pattern.

- [ ] **Step 1: Write the failing component tests**

Create `tests/unit/games-play-years-panel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { type PlayYearDraft, PlayYearsPanel } from '@/features/games/library/play-years-panel';

function setup(value: PlayYearDraft[], totalTenths: number) {
  const onChange = vi.fn();
  render(<PlayYearsPanel value={value} onChange={onChange} totalTenths={totalTenths} />);
  return { onChange };
}

describe('PlayYearsPanel', () => {
  it('shows no rows and no warning when the split is empty', () => {
    setup([], 490);
    expect(screen.queryByLabelText(/year/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('adds a row when the add control is used', async () => {
    const user = userEvent.setup();
    const { onChange } = setup([], 490);

    await user.click(screen.getByRole('button', { name: /add a year/i }));

    expect(onChange).toHaveBeenCalledWith([{ year: '', hours: '' }]);
  });

  it('warns when the split does not add up to the total', () => {
    setup([{ year: '2024', hours: '37' }, { year: '2025', hours: '12' }], 510);

    expect(screen.getByRole('alert')).toHaveTextContent(/2h/);
  });

  it('shows no warning when the split matches the total exactly', () => {
    setup([{ year: '2024', hours: '37' }, { year: '2025', hours: '12' }], 490);

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warns when the split overshoots the total', () => {
    setup([{ year: '2024', hours: '60' }], 490);

    expect(screen.getByRole('alert')).toHaveTextContent(/over/i);
  });

  it('removes the row the owner asked to remove, not the last one', async () => {
    const user = userEvent.setup();
    const { onChange } = setup([{ year: '2024', hours: '37' }, { year: '2025', hours: '12' }], 490);

    await user.click(screen.getAllByRole('button', { name: /remove/i })[0]!);

    expect(onChange).toHaveBeenCalledWith([{ year: '2025', hours: '12' }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project components games-play-years-panel`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the panel**

Create `src/features/games/library/play-years-panel.tsx`:

```tsx
'use client';

import { Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatHours, fromHoursInput, hours } from '@/server/games/hours';
import { validateSplit } from '@/server/games/play-years';

/** Draft state is TEXT, not numbers — a half-typed "2" must not become year 2. */
export interface PlayYearDraft {
  readonly year: string;
  readonly hours: string;
}

/**
 * Optional per-year breakdown of a game's hours.
 *
 * Used by roughly 3 games out of 160, so it stays collapsed and out of the way
 * by default (the dialog owns that). The total remains the single number the
 * owner edits normally; these rows only say WHICH YEARS it happened in, which
 * is why the sum is validated against the total rather than replacing it.
 */
export function PlayYearsPanel({
  value,
  onChange,
  totalTenths,
}: {
  readonly value: readonly PlayYearDraft[];
  readonly onChange: (next: readonly PlayYearDraft[]) => void;
  readonly totalTenths: number;
}): React.ReactElement {
  const parsed = value.map((row) => ({ hoursTenths: fromHoursInput(row.hours) ?? 0 }));
  const validation = validateSplit(totalTenths, parsed);

  function update(index: number, patch: Partial<PlayYearDraft>): void {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="space-y-2">
      {value.map((row, index) => (
        // Index-keyed deliberately: these rows have no stable id until saved,
        // and reordering is not possible in this UI — only add and remove.
        <div key={index} className="flex items-end gap-2">
          <div className="w-28 space-y-1">
            <Label htmlFor={`play-year-${index}`} className="text-xs">
              Year
            </Label>
            <Input
              id={`play-year-${index}`}
              value={row.year}
              onChange={(event) => update(index, { year: event.target.value })}
              placeholder="2025"
              inputMode="numeric"
            />
          </div>
          <div className="w-28 space-y-1">
            <Label htmlFor={`play-hours-${index}`} className="text-xs">
              Hours
            </Label>
            <Input
              id={`play-hours-${index}`}
              value={row.hours}
              onChange={(event) => update(index, { hours: event.target.value })}
              placeholder="12"
              inputMode="decimal"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove year ${row.year === '' ? index + 1 : row.year}`}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}

      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, { year: '', hours: '' }])}>
          <Plus className="mr-1 size-4" />
          Add a year
        </Button>
        {value.length === 0 ? null : (
          <span className="text-muted-foreground text-xs">
            {formatHours(hours(validation.splitTenths))} of {formatHours(hours(totalTenths))}
          </span>
        )}
      </div>

      {validation.ok ? null : (
        <p role="alert" className="text-destructive text-xs">
          {validation.differenceTenths > 0
            ? `${formatHours(hours(validation.differenceTenths))} not yet assigned to a year.`
            : `Split is over the total by ${formatHours(hours(Math.abs(validation.differenceTenths)))}.`}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `npx vitest run --project components games-play-years-panel`
Expected: PASS, 6 tests.

- [ ] **Step 5: Load existing splits with the game**

In `src/server/db/games/games.ts`, add `playYears` to the `Game` interface:

```ts
  readonly playYears: readonly { readonly year: number; readonly hoursTenths: number }[];
```

and populate it in `getGame` and `listGames` with a single grouped query rather than one per game (N+1). In `listGames`, after the games are fetched:

```ts
  const splits = await listPlayYears(ownerId);
  const byGame = new Map<string, { year: number; hoursTenths: number }[]>();
  for (const row of splits) {
    const existing = byGame.get(row.gameId);
    if (existing === undefined) byGame.set(row.gameId, [{ year: row.year, hoursTenths: row.hoursTenths }]);
    else existing.push({ year: row.year, hoursTenths: row.hoursTenths });
  }
```

then attach `playYears: byGame.get(row.id) ?? []` when mapping each row. Import `listPlayYears` from `./play-years`.

- [ ] **Step 6: Wire the panel into the dialog**

In `src/features/games/library/game-dialog.tsx`:

Add the imports:

```tsx
import { type PlayYearDraft, PlayYearsPanel } from './play-years-panel';
import { toHoursInput } from '@/server/games/hours';
```

(`toHoursInput` and `hours` are already imported in this file — do not duplicate the import.)

Add state, seeded from the game's existing split:

```tsx
const [playYears, setPlayYears] = useState<readonly PlayYearDraft[]>(
  (game?.playYears ?? []).map((row) => ({ year: String(row.year), hours: toHoursInput(hours(row.hoursTenths)) })),
);
const [showSplit, setShowSplit] = useState((game?.playYears ?? []).length > 0);
```

Render it under the Hours field, collapsed by default:

```tsx
<div className="sm:col-span-2">
  {showSplit ? (
    <PlayYearsPanel
      value={playYears}
      onChange={setPlayYears}
      totalTenths={fromHoursInput(hoursFieldValue)?.valueOf() ?? 0}
    />
  ) : (
    <Button type="button" variant="link" size="sm" className="px-0" onClick={() => setShowSplit(true)}>
      Split across years
    </Button>
  )}
</div>
```

The Hours `Field` is currently uncontrolled (`defaultValue`). The panel needs its live value to validate against, so convert that one field to controlled state (`hoursFieldValue` / `setHoursFieldValue`, seeded exactly as its `defaultValue` is today) and pass `value`/`onChange` instead of `defaultValue`. Leave every other `Field` uncontrolled.

In `submit`, add:

```tsx
formData.set('playYears', JSON.stringify(playYears.filter((row) => row.year.trim() !== '')));
```

Filtering empty-year rows here means an owner who clicks "Add a year" and changes their mind does not submit a junk row.

- [ ] **Step 7: Parse and persist in the action**

In `src/features/games/game-actions.ts`, add a schema next to `gameSchema`:

```ts
const playYearsSchema = z
  .array(
    z.object({
      year: z.coerce.number().int().min(1970).max(2100),
      // Whitespace-only must be a validation failure, NOT a silent 0 — a
      // fabricated zero is exactly the bug class this project has hit before.
      hours: z.string().trim().min(1),
    }),
  )
  .max(30);
```

In `parse()`, read and convert it:

```ts
  const rawPlayYears = text(formData, 'playYears');
  let playYears: { year: number; hoursTenths: number }[] = [];
  if (rawPlayYears !== undefined) {
    const drafts = playYearsSchema.parse(JSON.parse(rawPlayYears));
    playYears = drafts.map((draft) => {
      const tenths = fromHoursInput(draft.hours);
      if (tenths === null) throw new Error(`"${draft.hours}" is not a valid number of hours`);
      return { year: draft.year, hoursTenths: tenths };
    });
  }
```

Return `playYears` alongside the parsed `GameInput` (widen the function's return type to `{ input: GameInput; playYears: ... }` and update both call sites), then after `createGame`/`updateGame` succeeds call:

```ts
await replacePlayYears(owner.userId, saved.id, playYears);
```

Validate the sum before writing and return a field error rather than persisting an inconsistent split:

```ts
const validation = validateSplit(input.hours ?? 0, playYears);
if (!validation.ok) {
  return { ok: false, error: 'The year-by-year split must add up to the total hours.' };
}
```

Match the exact shape of this file's existing error returns — check how `createGameAction` returns its failures and mirror it rather than inventing a new shape.

- [ ] **Step 8: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`

- [ ] **Step 9: Verify by hand**

```bash
pnpm dev
```

Open `/games/library`, edit **Hollow Knight**, click "Split across years", add `2024 / 37` and `2025 / 12`, and save. Expected: saves cleanly (37 + 12 = 49 = its total). Reopen it — the split is still there. Now change one to `2024 / 30` and save: expected a validation error, not a write. Check `/games/stats`: 2025 now shows 12 more hours and 2024 shows 12 fewer.

- [ ] **Step 10: Commit**

```bash
git add src/features/games src/server/db/games/games.ts tests/unit/games-play-years-panel.test.tsx
git commit -m "feat(games): per-year hours split editor"
```

---

### Task 5: Seed the three known splits

**Files:**
- Create: `scripts/seed-play-year-splits.mjs`

**Interfaces:**
- Consumes: the `game_play_years` table (Task 2).
- Produces: nothing importable — a one-off operational script.

This is a script rather than a SQL data migration because migrations run against both local and production, where `games.id` values differ, and a title-keyed `UPDATE` inside a migration is fragile. It follows the established shape of `scripts/fix-game-platforms.mjs` and `scripts/backfill-game-metadata.mjs`: plain ESM, dry-run by default, localhost-only guard, `import.meta.url` entry-point guard.

- [ ] **Step 1: Read an existing script for its exact conventions**

Read `scripts/fix-game-platforms.mjs` end to end. Copy its argument parsing, its `LOCAL_HOSTNAMES` guard, its dry-run/`--apply` handling, and its reporting style rather than inventing new ones.

- [ ] **Step 2: Write the script**

Create `scripts/seed-play-year-splits.mjs`. The data, recovered from each game's `notes` and verified to sum to its stored total:

```js
/**
 * The three games whose sheet entry recorded hours as a composite string
 * ("53 + 6") because it spanned a year boundary. The import preserved that
 * only as prose in `notes`; this promotes it to real per-year rows.
 *
 * Each split is asserted against the game's stored total before writing — if
 * a total has changed since these were recorded, the script refuses that game
 * rather than writing a split that does not add up.
 */
const SPLITS = [
  { title: 'Clair Obscur: Expedition 33', years: [[2025, 530], [2026, 60]] },
  { title: 'Hollow Knight', years: [[2024, 370], [2025, 120]] },
  { title: 'Lies of P', years: [[2024, 520], [2025, 250]] },
];
```

Matching is by exact title against the owner's games. For each: look up the game, sum the split, compare to `hours_tenths`, and skip with a loud message on mismatch or a missing game. Report every decision. Under `--apply`, delete any existing rows for that game and insert the new ones in a transaction.

- [ ] **Step 3: Dry run**

```bash
node --env-file-if-exists=.env scripts/seed-play-year-splits.mjs "$(grep '^OWNER_EMAIL=' .env | cut -d= -f2)"
```

Expected: three games matched, each split summing to its stored total (59.0h, 49.0h, 77.0h), no writes.

- [ ] **Step 4: Apply**

```bash
node --env-file-if-exists=.env scripts/seed-play-year-splits.mjs "$(grep '^OWNER_EMAIL=' .env | cut -d= -f2)" --apply
```

- [ ] **Step 5: Verify the numbers moved**

```bash
docker compose -f compose.dev.yml exec -T postgres psql -U burmy -d burmy -c "
SELECT g.title, p.year, p.hours_tenths/10.0 AS hours
FROM game_play_years p JOIN games g ON g.id = p.game_id
ORDER BY g.title, p.year;"
```

Expected: six rows totalling 43 hours moved out of 2024/2025 and into 2025/2026.

Then open `/games/stats` and confirm the Yearly Breakdown reflects it: 2026 gains 6 hours, 2025 nets +6 − 53 + 12 + 25, 2024 loses 12 + 25. **No Unattributed row should appear** — every split sums exactly.

- [ ] **Step 6: Run the full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add scripts/seed-play-year-splits.mjs
git commit -m "feat(games): one-off script seeding the three known year splits"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/GAMES.md`
- Modify: `CLAUDE.md` (Gotchas section)

- [ ] **Step 1: Document the model in `docs/GAMES.md`**

Add a section, "Play-year attribution," stating: `games.hours_tenths` is the authoritative total; `game_play_years` rows are an optional attribution of it; a game with no rows attributes everything to `first_played_year`; the sum must equal the total and a mismatch surfaces as an Unattributed line rather than being absorbed; achievements are *not* split, because no source records the year a trophy was earned.

- [ ] **Step 2: Add the gotcha to `CLAUDE.md`**

Add one bullet to the Gotchas list:

> - **`games.hours_tenths` is the authoritative total; `game_play_years` only says WHICH YEARS it happened in.** Neither Steam nor PSN can supply a per-year breakdown (Steam gives `playtime_forever` and `playtime_2weeks`; PSN gives one cumulative `playDuration`), so the total has to stay a single number an API can write while the split stays owner-entered. Do not "normalize" this by deriving the total from the rows — a sync would then have nowhere to write, and 157 of 160 games have no rows at all.

- [ ] **Step 3: Commit**

```bash
git add docs/GAMES.md CLAUDE.md
git commit -m "docs(games): record the play-year attribution model"
```

---

## Self-Review

**Spec coverage** — every Part 1 requirement maps to a task:

| Spec requirement | Task |
|---|---|
| `game_play_years` table with owner_id and cascades | 2 |
| `hours_tenths` remains the authoritative total | 1 (documented), 6 (recorded) |
| No rows → attribute to `first_played_year` | 1 |
| Split must sum to the total; editor rejects a mismatch | 1, 4 |
| API changes total → reconciliation surfaced, not guessed | 1, 3 (Unattributed line) |
| Optional collapsed "Split across years" panel | 4 |
| Split stays editable even when the total is API-owned | 4 (panel is independent of the total field's editability) |
| Started / Played as separate columns | 3 |
| Hours = attributed hours | 1, 3 |
| Seed the three known splits via a script, not a migration | 5 |
| Unit, integration, and component test coverage | 1, 2, 3, 4 |

**Type consistency** — `PlayYearRow` (`gameId`/`year`/`hoursTenths`) is defined in Task 1 and used unchanged in Tasks 2, 3, and 4. `PlayYearDraft` (`year`/`hours`, both strings) is UI-only and never crosses into the domain. `buildYearlyBreakdown` returns `YearlyBreakdown` (Task 3) and every consumer is updated in the same task.

**Known deliberate gaps, carried into later parts of the spec:**
- Steam-linked games do not yet render hours read-only — that is Part 2, which is where provenance is introduced.
- The reconciliation item in the sync review is Part 2. Part 1 delivers only the Unattributed line on the stats page, which is what makes the mismatch visible in the meantime.
