# Game Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Games module to Burmy — a library, tracker, and stats dashboard replacing the owner's hand-maintained Google Sheet game log.

**Architecture:** A second product module that structurally mirrors Finance without sharing any of its code. New Postgres tables (`games`), new framework-free domain layer (`src/server/games/`), new owner-scoped data-access layer (`src/server/db/games/`), new feature UI (`src/features/games/`), new routes (`src/app/(private)/games/`). The only surfaces shared with Finance are generic UI primitives (`src/components/ui/*`), the `requireOwner()` auth boundary, and the `--color-chart-cat-*` CSS tokens. Every aggregate (hours per year, games per year, genre splits) is computed by SQL/pure functions at read time — never stored.

**Tech Stack:** Next.js 16.3 App Router, React 19, TypeScript strict, Drizzle ORM 0.45 + PostgreSQL 18, Tailwind + shadcn/ui, recharts 3.10, Vitest (domain + components projects), Testcontainers for integration, RAWG.io for game metadata.

**Spec:** `docs/superpowers/specs/2026-08-20-game-tracker-design.md`

## Global Constraints

- **Games code never imports Finance code, and Finance never imports Games.** Shared surfaces are exactly: `src/components/ui/*`, `@/server/auth/owner`, `@/lib/utils`, `@/server/db` (`getDb`), and the `--color-chart-cat-*` CSS tokens in `globals.css`.
- **`src/server/games/` must stay framework-free** — pure TypeScript, no React, no Next, no HTTP, no database. Same rule `CLAUDE.md` applies to `src/server/finance/`.
- **Never store an aggregate.** Yearly totals, hours-per-year, completion rates, genre splits are all computed at read time.
- **Money is signed BIGINT cents** (`price_cents`). Never floats, never `NUMERIC`.
- **Every server entry point calls `await requireOwner()` as the first line of its body.** `tests/integration/entry-points.test.ts` enumerates the filesystem and fails the suite otherwise; the unprotected allowlist stays exactly `['/api/health']`.
- **`ownerId` is the first parameter of every data-access function** and appears in every `WHERE`.
- **`exactOptionalPropertyTypes` is on.** Never assign `undefined` to an optional property — omit the key via conditional spread: `...(cond ? { key } : {})`. When assembling more than ~3 optional fields, build a mutable local object with `if (cond) obj.key = value` instead (documented inference gap in `CLAUDE.md`).
- **`updatedAt: new Date()` must be set manually on every UPDATE** — there is no database trigger.
- **Tests use explicit vitest imports** (`import { describe, expect, it } from 'vitest'`); `globals: false`.
- **`.test.ts` runs in the `domain` (node) project; `.test.tsx` runs in the `components` (jsdom) project.** Extension picks the project.
- **Commit `drizzle/*.sql` AND `drizzle/meta/*` together** in the same commit as the schema change.
- Do NOT run `pnpm test:e2e` against the local dev database without explicit confirmation — its `resetAll()` truncates real owner data (see `feedback_e2e_shared_dev_db_data_loss` memory).

---

### Task 1: Schema, enums, and migration

**Files:**
- Modify: `src/server/db/schema.ts` (Enums block ~line 36-117; append new table after the finance tables)
- Modify: `tests/integration/harness.ts:65-75` (truncate list)
- Modify: `vitest.config.ts:67` (coverage include)
- Create: `drizzle/0004_*.sql` + `drizzle/meta/0004_snapshot.json` (generated)

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `games` table with `$inferSelect`/`$inferInsert` types; `gamePlatformEnum`, `gameOwnershipEnum`, `gameStatusEnum` exported from `@/server/db/schema`.

- [ ] **Step 1: Add the three enums to the Enums block in `src/server/db/schema.ts`**

Place these at the end of the existing banner-delimited Enums section (after the finance enums, before the tables):

```ts
// ── Games ───────────────────────────────────────────────────────────────────

/** Where a game was played. `other` covers retro/emulated/misc without inventing a taxonomy. */
export const gamePlatformEnum = pgEnum('game_platform', ['ps5', 'ps4', 'psp', 'steam', 'pc', 'other']);

export const gameOwnershipEnum = pgEnum('game_ownership', ['physical', 'digital']);

/**
 * Lifecycle. `paused_dropped` is deliberately ONE state, not two: the
 * difference between "I'll come back" and "I won't" is a sentence in `notes`,
 * not a schema decision, and splitting it would put two nearly-identical
 * buckets in every filter.
 */
export const gameStatusEnum = pgEnum('game_status', ['backlog', 'playing', 'completed', 'paused_dropped']);
```

- [ ] **Step 2: Add the `games` table at the end of `src/server/db/schema.ts`**

```ts
// ─────────────────────────────────────────────────────────────────────────────
// Games
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row per game owned, wanted, or played. Replaces a hand-maintained
 * spreadsheet.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOURS ARE ONE NUMBER, NOT A SESSION LOG.
 *
 * The source spreadsheet wrote "53 + 6" in an hours cell — which looks like
 * session tracking but is not. It meant "53 hours on the base game in 2025, 6
 * on the DLC in 2026", kept visually separate only so a manual yearly rollup
 * stayed readable. A `play_sessions` table was considered and REJECTED: the
 * owner logs a total, once, by hand. `notes` carries the DLC nuance in plain
 * language.
 *
 * `firstPlayedYear` is nullable and genuinely sparse — pre-2015 PSP/PS2 entries
 * carry a rating and nothing else. That is data, not an omission to backfill.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const games = pgTable(
  'games',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    platform: gamePlatformEnum('platform').notNull().default('other'),
    developer: text('developer'),
    publisher: text('publisher'),
    ownership: gameOwnershipEnum('ownership'),
    /** Signed cents, same convention as finance. Independent of finance_transactions by design. */
    priceCents: bigint('price_cents', { mode: 'number' }),
    status: gameStatusEnum('status').notNull().default('backlog'),
    /** 1-5. Nullable: an unplayed backlog entry has no opinion yet. */
    rating: smallint('rating'),
    /** Tenths of an hour, stored as an integer so no float ever touches a total. 235 = 23.5h. */
    hoursTenths: integer('hours_tenths'),
    firstPlayedYear: smallint('first_played_year'),
    achievementsUnlocked: smallint('achievements_unlocked'),
    achievementsTotal: smallint('achievements_total'),
    coverUrl: text('cover_url'),
    genre: text('genre'),
    notes: text('notes'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Case-insensitive uniqueness per platform: the same title legitimately
    // exists twice when replayed on a different platform (PS4 then PS5), but
    // twice on ONE platform is always a duplicate entry.
    uniqueIndex('games_owner_title_platform_idx').on(t.ownerId, sql`lower(${t.title})`, t.platform),
    index('games_owner_idx').on(t.ownerId),
    index('games_owner_status_idx').on(t.ownerId, t.status),
    index('games_owner_year_idx').on(t.ownerId, t.firstPlayedYear),
  ],
);
```

Note `hoursTenths` (integer) rather than `numeric` — the spreadsheet has `0.7`, `0.8`, `532.8`; storing tenths as an integer keeps every sum exact and mirrors the money-as-cents discipline. Conversion helpers land in Task 2.

- [ ] **Step 3: Add the games table to the integration truncate list**

In `tests/integration/harness.ts`, inside `resetDatabase()`, add `"games", ` to the truncate list immediately before `"user"`:

```ts
  await sql.unsafe(
    'truncate table "audit_events", "rate_limit", "verification", "passkey", "session", "account", ' +
      '"finance_transactions", "finance_import_rows", "finance_import_files", "finance_imports", ' +
      '"finance_categories", "finance_accounts", "games", "user" cascade',
  );
```

- [ ] **Step 4: Add the games domain to coverage in `vitest.config.ts`**

Change the coverage `include` (line ~67) from `['src/server/finance/**']` to:

```ts
      include: ['src/server/finance/**', 'src/server/games/**'],
```

- [ ] **Step 5: Generate and inspect the migration**

```bash
docker compose -f compose.dev.yml up -d postgres
pnpm db:generate
```

Read the generated `drizzle/0004_*.sql`. Expected: three `CREATE TYPE` statements, one `CREATE TABLE "games"`, four `CREATE INDEX`/`CREATE UNIQUE INDEX`. It must be purely additive — no `ALTER`/`DROP` against any `finance_*` table. If `drizzle-kit` prompts about a rename, answer "create" — never accept a rename against an existing table.

- [ ] **Step 6: Apply it locally and verify**

```bash
pnpm db:migrate
docker compose -f compose.dev.yml exec -T postgres psql -U burmy -d burmy -c "\d games"
```

Expected: table exists with all 18 columns and 4 indexes.

- [ ] **Step 7: Run the gates**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass. (No new tests yet — this task's deliverable is schema.)

- [ ] **Step 8: Commit**

```bash
git add src/server/db/schema.ts tests/integration/harness.ts vitest.config.ts drizzle/
git commit -m "feat(games): add games table, enums, and migration"
```

---

### Task 2: Pure domain layer — hours, stats, and yearly breakdown

**Files:**
- Create: `src/server/games/hours.ts`
- Create: `src/server/games/stats.ts`
- Test: `tests/unit/games-hours.test.ts`
- Test: `tests/unit/games-stats.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions, no imports from Task 1)
- Produces:
  - `hours.ts`: `type Hours` (branded number, tenths); `hours(tenths: number): Hours`; `fromHoursInput(text: string): Hours | null`; `formatHours(h: Hours): string`; `sumHours(values: readonly Hours[]): Hours`
  - `stats.ts`: `interface GameStatRow`; `interface YearlyBreakdownRow`; `buildYearlyBreakdown(rows, currentYear): YearlyBreakdownRow[]`; `buildLibrarySummary(rows): LibrarySummary`; `buildDistribution<K>(rows, keyOf, labelOf): DistributionSlice[]`; `findCallouts(rows): Callouts`

- [ ] **Step 1: Write the failing test for hours conversion**

Create `tests/unit/games-hours.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { formatHours, fromHoursInput, hours, sumHours } from '@/server/games/hours';

describe('fromHoursInput', () => {
  it('parses a whole number of hours into tenths', () => {
    expect(fromHoursInput('53')).toBe(530);
  });

  it('parses one decimal place exactly', () => {
    expect(fromHoursInput('0.7')).toBe(7);
    expect(fromHoursInput('532.8')).toBe(5328);
  });

  it('rounds beyond one decimal place rather than storing a float', () => {
    expect(fromHoursInput('1.26')).toBe(13);
  });

  it('returns null for junk, empty, and negative input', () => {
    expect(fromHoursInput('')).toBeNull();
    expect(fromHoursInput('abc')).toBeNull();
    expect(fromHoursInput('-5')).toBeNull();
  });
});

describe('formatHours', () => {
  it('drops the decimal when the value is a whole number of hours', () => {
    expect(formatHours(hours(530))).toBe('53h');
  });

  it('keeps one decimal for a partial hour', () => {
    expect(formatHours(hours(7))).toBe('0.7h');
  });

  it('renders zero without a sign or decimal', () => {
    expect(formatHours(hours(0))).toBe('0h');
  });
});

describe('sumHours', () => {
  it('adds tenths exactly, with no floating-point drift', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004. In tenths it is simply 3.
    expect(sumHours([hours(1), hours(2)])).toBe(3);
  });

  it('returns zero for an empty list', () => {
    expect(sumHours([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm test --project domain -- games-hours
```

Expected: FAIL — cannot resolve `@/server/games/hours`.

- [ ] **Step 3: Implement `src/server/games/hours.ts`**

```ts
/**
 * Play time, stored and summed as TENTHS OF AN HOUR.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY TENTHS AND NOT A FLOAT
 *
 * The source spreadsheet records values like `0.7`, `0.8`, and `532.8`. Summing
 * those as JavaScript numbers reintroduces exactly the class of bug the money
 * layer exists to prevent — `0.1 + 0.2 !== 0.3`. An integer count of tenths
 * sums exactly, and one decimal place is the finest granularity the owner has
 * ever recorded.
 *
 * This module is the ONLY place that converts between display text and stored
 * tenths. Nothing else does hours math.
 * ─────────────────────────────────────────────────────────────────────────────
 */

declare const HOURS: unique symbol;

/** An integer count of tenths of an hour. 235 = 23.5 hours. */
export type Hours = number & { readonly [HOURS]: true };

export function hours(tenths: number): Hours {
  if (!Number.isInteger(tenths)) throw new Error(`Hours must be whole tenths, received ${tenths}`);
  return tenths as Hours;
}

/**
 * Parse owner-typed text ("53", "0.7", "23.5") into tenths.
 * Returns null for anything that is not a non-negative number — the caller
 * decides whether that is a validation error or simply an empty field.
 */
export function fromHoursInput(text: string): Hours | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;

  return hours(Math.round(parsed * 10));
}

/** `53h`, `0.7h`, `0h` — the decimal appears only when it carries information. */
export function formatHours(value: Hours): string {
  const whole = Math.trunc(value / 10);
  const remainder = value % 10;
  return remainder === 0 ? `${whole}h` : `${(value / 10).toFixed(1)}h`;
}

export function sumHours(values: readonly Hours[]): Hours {
  return hours(values.reduce<number>((total, value) => total + value, 0));
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
pnpm test --project domain -- games-hours
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Write the failing test for stats**

Create `tests/unit/games-stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  type GameStatRow,
  buildDistribution,
  buildLibrarySummary,
  buildYearlyBreakdown,
  findCallouts,
} from '@/server/games/stats';

function game(overrides: Partial<GameStatRow>): GameStatRow {
  return {
    id: 'game-1',
    title: 'Elden Ring',
    platform: 'ps5',
    ownership: 'physical',
    developer: 'FromSoftware, Inc.',
    publisher: 'Bandai Namco Entertainment',
    genre: 'Action RPG',
    status: 'completed',
    rating: 5,
    hoursTenths: 1360,
    firstPlayedYear: 2022,
    achievementsUnlocked: 42,
    achievementsTotal: 42,
    ...overrides,
  };
}

describe('buildYearlyBreakdown', () => {
  it('groups games, hours, and achievements by year, newest first', () => {
    const rows = buildYearlyBreakdown(
      [
        game({ id: 'a', firstPlayedYear: 2024, hoursTenths: 450, achievementsUnlocked: 45 }),
        game({ id: 'b', firstPlayedYear: 2024, hoursTenths: 230, achievementsUnlocked: 63 }),
        game({ id: 'c', firstPlayedYear: 2025, hoursTenths: 640, achievementsUnlocked: 54 }),
      ],
      2026,
    );

    expect(rows.map((r) => r.year)).toEqual([2025, 2024]);
    expect(rows[1]!).toMatchObject({ year: 2024, gameCount: 2, hoursTenths: 680, achievements: 108 });
  });

  it('excludes games with no year — a sparse retro entry is not year zero', () => {
    const rows = buildYearlyBreakdown([game({ firstPlayedYear: null })], 2026);
    expect(rows).toEqual([]);
  });

  it('treats missing hours and achievements as zero rather than skipping the game', () => {
    const rows = buildYearlyBreakdown(
      [game({ firstPlayedYear: 2020, hoursTenths: null, achievementsUnlocked: null })],
      2026,
    );
    expect(rows[0]!).toMatchObject({ year: 2020, gameCount: 1, hoursTenths: 0, achievements: 0 });
  });

  it('reports change versus the previous year so the UI never recomputes it', () => {
    const rows = buildYearlyBreakdown(
      [
        game({ id: 'a', firstPlayedYear: 2023, hoursTenths: 1000 }),
        game({ id: 'b', firstPlayedYear: 2024, hoursTenths: 1500 }),
      ],
      2026,
    );

    const y2024 = rows.find((r) => r.year === 2024)!;
    expect(y2024.hoursChangeTenths).toBe(500);
    const y2023 = rows.find((r) => r.year === 2023)!;
    expect(y2023.hoursChangeTenths).toBeNull();
  });
});

describe('buildLibrarySummary', () => {
  it('counts totals across the whole library regardless of year', () => {
    const summary = buildLibrarySummary([
      game({ id: 'a', status: 'completed', hoursTenths: 500, rating: 5 }),
      game({ id: 'b', status: 'backlog', hoursTenths: null, rating: null }),
      game({ id: 'c', status: 'paused_dropped', hoursTenths: 100, rating: 3 }),
    ]);

    expect(summary.totalGames).toBe(3);
    expect(summary.totalHoursTenths).toBe(600);
    expect(summary.backlogCount).toBe(1);
  });

  it('averages rating over rated games only, ignoring unrated ones', () => {
    const summary = buildLibrarySummary([
      game({ id: 'a', rating: 5 }),
      game({ id: 'b', rating: 3 }),
      game({ id: 'c', rating: null }),
    ]);
    expect(summary.averageRating).toBe(4);
  });

  it('has no average rating at all when nothing is rated', () => {
    expect(buildLibrarySummary([game({ rating: null })]).averageRating).toBeNull();
  });

  it('computes completion rate over STARTED games, excluding the backlog', () => {
    // 2 completed, 1 dropped, 1 never started -> 2/3, not 2/4.
    const summary = buildLibrarySummary([
      game({ id: 'a', status: 'completed' }),
      game({ id: 'b', status: 'completed' }),
      game({ id: 'c', status: 'paused_dropped' }),
      game({ id: 'd', status: 'backlog' }),
    ]);
    expect(summary.completionRatePercent).toBeCloseTo(66.67, 1);
  });

  it('has no completion rate when nothing has been started', () => {
    expect(buildLibrarySummary([game({ status: 'backlog' })]).completionRatePercent).toBeNull();
  });
});

describe('buildDistribution', () => {
  it('counts by key, largest first, and labels each slice', () => {
    const slices = buildDistribution(
      [game({ id: 'a', platform: 'ps5' }), game({ id: 'b', platform: 'ps5' }), game({ id: 'c', platform: 'steam' })],
      (g) => g.platform,
      (key) => key.toUpperCase(),
    );

    expect(slices).toEqual([
      { key: 'ps5', label: 'PS5', count: 2, percent: (2 / 3) * 100 },
      { key: 'steam', label: 'STEAM', count: 1, percent: (1 / 3) * 100 },
    ]);
  });

  it('skips rows whose key is null instead of inventing an "unknown" bucket', () => {
    expect(buildDistribution([game({ genre: null })], (g) => g.genre, (k) => k)).toEqual([]);
  });
});

describe('findCallouts', () => {
  it('finds the longest game by hours', () => {
    const callouts = findCallouts([
      game({ id: 'a', title: 'Short', hoursTenths: 100 }),
      game({ id: 'b', title: 'Long', hoursTenths: 1700 }),
    ]);
    expect(callouts.longestGame?.title).toBe('Long');
  });

  it('finds the most-played developer by summed hours, not by game count', () => {
    // Two short FromSoftware games vs one very long Rockstar game.
    const callouts = findCallouts([
      game({ id: 'a', developer: 'FromSoftware, Inc.', hoursTenths: 100 }),
      game({ id: 'b', developer: 'FromSoftware, Inc.', hoursTenths: 100 }),
      game({ id: 'c', developer: 'Rockstar Games', hoursTenths: 1700 }),
    ]);
    expect(callouts.topDeveloper?.name).toBe('Rockstar Games');
    expect(callouts.topDeveloper?.hoursTenths).toBe(1700);
  });

  it('finds the best year by hours played', () => {
    const callouts = findCallouts([
      game({ id: 'a', firstPlayedYear: 2022, hoursTenths: 4640 }),
      game({ id: 'b', firstPlayedYear: 2023, hoursTenths: 4380 }),
    ]);
    expect(callouts.bestYear?.year).toBe(2022);
  });

  it('returns nulls rather than throwing on an empty library', () => {
    const callouts = findCallouts([]);
    expect(callouts.longestGame).toBeNull();
    expect(callouts.topDeveloper).toBeNull();
    expect(callouts.bestYear).toBeNull();
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

```bash
pnpm test --project domain -- games-stats
```

Expected: FAIL — cannot resolve `@/server/games/stats`.

- [ ] **Step 7: Implement `src/server/games/stats.ts`**

```ts
/**
 * Every number the Games dashboard shows, derived from the library at read
 * time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE IS EVER STORED.
 *
 * The spreadsheet this module replaces kept a hand-maintained Year →
 * Games/Hours/Trophies rollup, and it had already drifted out of sync with its
 * own rows by the time it was imported — two copies of the table disagreed.
 * That is the failure mode this module exists to make impossible: the rollup is
 * a function of the library, recomputed on every render.
 *
 * Pure TypeScript. No React, no Next, no database — same boundary rule as
 * `src/server/finance/`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type GamePlatform = 'ps5' | 'ps4' | 'psp' | 'steam' | 'pc' | 'other';
export type GameOwnership = 'physical' | 'digital';
export type GameStatus = 'backlog' | 'playing' | 'completed' | 'paused_dropped';

/** The projection every stat function reads. Deliberately narrower than the full row. */
export interface GameStatRow {
  readonly id: string;
  readonly title: string;
  readonly platform: GamePlatform;
  readonly ownership: GameOwnership | null;
  readonly developer: string | null;
  readonly publisher: string | null;
  readonly genre: string | null;
  readonly status: GameStatus;
  readonly rating: number | null;
  readonly hoursTenths: number | null;
  readonly firstPlayedYear: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
}

export interface YearlyBreakdownRow {
  readonly year: number;
  readonly gameCount: number;
  readonly hoursTenths: number;
  readonly achievements: number;
  /** Hours vs the previous year present in the data. Null for the earliest year. */
  readonly hoursChangeTenths: number | null;
}

export interface LibrarySummary {
  readonly totalGames: number;
  readonly totalHoursTenths: number;
  readonly backlogCount: number;
  readonly playingCount: number;
  readonly completedCount: number;
  /** Mean of rated games only, 1-5. Null when nothing is rated. */
  readonly averageRating: number | null;
  /** Completed / (completed + paused_dropped), 0-100. Null when nothing has been started. */
  readonly completionRatePercent: number | null;
}

export interface DistributionSlice {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /** Share of the rows that HAD a key, 0-100. */
  readonly percent: number;
}

export interface Callouts {
  readonly longestGame: { readonly title: string; readonly hoursTenths: number } | null;
  readonly topDeveloper: { readonly name: string; readonly hoursTenths: number } | null;
  readonly bestYear: { readonly year: number; readonly hoursTenths: number } | null;
}

/**
 * Year → games/hours/achievements, newest first. `currentYear` is accepted so
 * a caller can highlight the in-progress year without this module reading a
 * clock — a pure function that calls `new Date()` is not reproducible.
 */
export function buildYearlyBreakdown(
  rows: readonly GameStatRow[],
  currentYear: number,
): YearlyBreakdownRow[] {
  const byYear = new Map<number, { gameCount: number; hoursTenths: number; achievements: number }>();

  for (const row of rows) {
    // A retro entry with no year is not year zero — it has no place in a
    // year-by-year comparison and is excluded rather than bucketed.
    if (row.firstPlayedYear === null) continue;

    const bucket = byYear.get(row.firstPlayedYear) ?? { gameCount: 0, hoursTenths: 0, achievements: 0 };
    byYear.set(row.firstPlayedYear, {
      gameCount: bucket.gameCount + 1,
      hoursTenths: bucket.hoursTenths + (row.hoursTenths ?? 0),
      achievements: bucket.achievements + (row.achievementsUnlocked ?? 0),
    });
  }

  const ascending = [...byYear.entries()].sort((a, b) => a[0] - b[0]);

  return ascending
    .map(([year, bucket], index) => {
      const previous = index === 0 ? null : ascending[index - 1]![1];
      return {
        year,
        gameCount: bucket.gameCount,
        hoursTenths: bucket.hoursTenths,
        achievements: bucket.achievements,
        hoursChangeTenths: previous === null ? null : bucket.hoursTenths - previous.hoursTenths,
      };
    })
    .sort((a, b) => b.year - a.year)
    .map((row) => (row.year === currentYear ? row : row));
}

export function buildLibrarySummary(rows: readonly GameStatRow[]): LibrarySummary {
  const rated = rows.filter((row) => row.rating !== null);
  const completed = rows.filter((row) => row.status === 'completed').length;
  const dropped = rows.filter((row) => row.status === 'paused_dropped').length;
  const started = completed + dropped;

  return {
    totalGames: rows.length,
    totalHoursTenths: rows.reduce((total, row) => total + (row.hoursTenths ?? 0), 0),
    backlogCount: rows.filter((row) => row.status === 'backlog').length,
    playingCount: rows.filter((row) => row.status === 'playing').length,
    completedCount: completed,
    averageRating:
      rated.length === 0 ? null : rated.reduce((sum, row) => sum + (row.rating ?? 0), 0) / rated.length,
    // Over STARTED games only: a 40-game backlog you never touched should not
    // read as a 5% completion rate.
    completionRatePercent: started === 0 ? null : (completed / started) * 100,
  };
}

export function buildDistribution(
  rows: readonly GameStatRow[],
  keyOf: (row: GameStatRow) => string | null,
  labelOf: (key: string) => string,
): DistributionSlice[] {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === '') continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return [];

  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: labelOf(key), count, percent: (count / total) * 100 }))
    .sort((a, b) => b.count - a.count);
}

export function findCallouts(rows: readonly GameStatRow[]): Callouts {
  const played = rows.filter((row) => (row.hoursTenths ?? 0) > 0);

  const longest = played.reduce<GameStatRow | null>(
    (best, row) => (best === null || (row.hoursTenths ?? 0) > (best.hoursTenths ?? 0) ? row : best),
    null,
  );

  const developerHours = new Map<string, number>();
  for (const row of played) {
    if (row.developer === null || row.developer === '') continue;
    developerHours.set(row.developer, (developerHours.get(row.developer) ?? 0) + (row.hoursTenths ?? 0));
  }
  const topDeveloperEntry = [...developerHours.entries()].sort((a, b) => b[1] - a[1])[0];

  const yearHours = new Map<number, number>();
  for (const row of played) {
    if (row.firstPlayedYear === null) continue;
    yearHours.set(row.firstPlayedYear, (yearHours.get(row.firstPlayedYear) ?? 0) + (row.hoursTenths ?? 0));
  }
  const bestYearEntry = [...yearHours.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    longestGame: longest === null ? null : { title: longest.title, hoursTenths: longest.hoursTenths ?? 0 },
    topDeveloper:
      topDeveloperEntry === undefined ? null : { name: topDeveloperEntry[0], hoursTenths: topDeveloperEntry[1] },
    bestYear: bestYearEntry === undefined ? null : { year: bestYearEntry[0], hoursTenths: bestYearEntry[1] },
  };
}
```

- [ ] **Step 8: Run the stats tests**

```bash
pnpm test --project domain -- games-stats
```

Expected: PASS, 15 tests.

- [ ] **Step 9: Run the gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/server/games tests/unit/games-hours.test.ts tests/unit/games-stats.test.ts
git commit -m "feat(games): pure domain layer for hours and library stats"
```

---

### Task 3: Data-access layer

**Files:**
- Create: `src/server/db/games/errors.ts`
- Create: `src/server/db/games/games.ts`
- Test: `tests/integration/games.test.ts`

**Interfaces:**
- Consumes: `games` table + enums from `@/server/db/schema` (Task 1); `GameStatRow` from `@/server/games/stats` (Task 2)
- Produces:
  - `errors.ts`: `class DuplicateGameError extends Error { readonly duplicateTitle: string }`, `class GameNotFoundError extends Error`, `function isUniqueViolation(error: unknown): boolean`
  - `games.ts`: `interface Game`, `interface GameInput`, `listGames(ownerId, options?): Promise<Game[]>`, `getGame(ownerId, id): Promise<Game>`, `createGame(ownerId, input): Promise<Game>`, `updateGame(ownerId, id, input): Promise<Game>`, `deleteGame(ownerId, id): Promise<void>`, `listGameStatRows(ownerId): Promise<GameStatRow[]>`

- [ ] **Step 1: Create `src/server/db/games/errors.ts`**

Games gets its own error module rather than importing Finance's — the errors are domain-named, and the modules must not depend on each other. The cause-chain walk in `isUniqueViolation` is copied deliberately; see its comment.

```ts
/**
 * Errors the games data-access layer raises.
 *
 * Deliberately NOT imported from `src/server/db/finance/errors.ts`: Games and
 * Finance share no code by design, and these errors carry games-specific
 * payloads. The duplicated `isUniqueViolation` below is the one piece of real
 * repetition, and it is repeated on purpose rather than creating a shared
 * module that couples the two.
 */

/** Postgres `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505';

export class DuplicateGameError extends Error {
  // `duplicateTitle`, not `title` — `Error.name` is the error TYPE and must not
  // be shadowed by the offending value.
  constructor(readonly duplicateTitle: string) {
    super(`"${duplicateTitle}" is already in your library on that platform`);
    this.name = 'DuplicateGameError';
  }
}

/**
 * The row does not exist, or belongs to someone else. One error for both, so a
 * crafted id cannot be used to probe for another owner's rows.
 */
export class GameNotFoundError extends Error {
  constructor() {
    super('Game not found');
    this.name = 'GameNotFoundError';
  }
}

/**
 * Drizzle WRAPS driver errors — the SQLSTATE lives on the `cause` chain, not on
 * `error.code`. A naive `error.code === '23505'` compiles, reads correctly, and
 * silently never matches, turning every duplicate title into an unhandled 500.
 * Bounded loop so a self-referential cause cannot spin forever.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}
```

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration/games.test.ts`. Note the mandatory dynamic-import pattern — a static top-level import of any `@/server/…` module caches a database client pointed at nothing.

```ts
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * The owner-scoped games data-access layer, against a real PostgreSQL 18.
 *
 * These are integration tests rather than unit tests because the behaviour
 * being verified belongs to the DATABASE: the partial unique index on
 * (owner_id, lower(title), platform), owner scoping in every WHERE, and the
 * cascade from `user`. A mocked client would only prove the mock matches my
 * assumptions about Postgres, which is the assumption most worth testing.
 */

type Games = typeof import('@/server/db/games/games');
type Errors = typeof import('@/server/db/games/errors');

let games: Games;
let errors: Errors;

beforeAll(async () => {
  await harness();
  [games, errors] = await Promise.all([
    import('@/server/db/games/games'),
    import('@/server/db/games/errors'),
  ]);
});

beforeEach(async () => {
  await resetDatabase();
});

/** Create a user row directly — this suite is about games data, not auth. */
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

describe('createGame', () => {
  it('creates a game with only a title and platform, leaving everything else null', async () => {
    const owner = await makeOwner('owner@burmy.test');

    const created = await games.createGame(owner, { title: 'Bloodborne', platform: 'ps4' });

    expect(created.title).toBe('Bloodborne');
    expect(created.status).toBe('backlog');
    expect(created.hoursTenths).toBeNull();
    expect(created.rating).toBeNull();
  });

  it('rejects the same title twice on one platform', async () => {
    const owner = await makeOwner('owner@burmy.test');
    await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });

    await expect(games.createGame(owner, { title: 'elden ring', platform: 'ps5' })).rejects.toBeInstanceOf(
      errors.DuplicateGameError,
    );
  });

  it('allows the same title on a DIFFERENT platform — a real replay, not a duplicate', async () => {
    const owner = await makeOwner('owner@burmy.test');
    await games.createGame(owner, { title: 'Elden Ring', platform: 'ps4' });

    const onPs5 = await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });
    expect(onPs5.platform).toBe('ps5');
  });
});

describe('updateGame', () => {
  it('updates the fields given and refreshes updated_at', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const created = await games.createGame(owner, { title: 'Prey', platform: 'ps5' });

    const updated = await games.updateGame(owner, created.id, {
      title: 'Prey',
      platform: 'ps5',
      status: 'completed',
      hoursTenths: 240,
      rating: 3,
    });

    expect(updated.status).toBe('completed');
    expect(updated.hoursTenths).toBe(240);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('throws GameNotFoundError for an id that does not exist', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const { randomUUID } = await import('node:crypto');

    await expect(
      games.updateGame(owner, randomUUID(), { title: 'Nope', platform: 'ps5' }),
    ).rejects.toBeInstanceOf(errors.GameNotFoundError);
  });
});

describe('deleteGame', () => {
  it('removes the row', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const created = await games.createGame(owner, { title: 'Multiversus', platform: 'ps5' });

    await games.deleteGame(owner, created.id);

    expect(await games.listGames(owner)).toEqual([]);
  });
});

describe('listGameStatRows', () => {
  it('returns the narrow projection the stats layer consumes', async () => {
    const owner = await makeOwner('owner@burmy.test');
    await games.createGame(owner, {
      title: 'Ghost of Tsushima',
      platform: 'ps4',
      status: 'completed',
      hoursTenths: 1080,
      firstPlayedYear: 2020,
      rating: 5,
      achievementsUnlocked: 69,
    });

    const rows = await games.listGameStatRows(owner);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Ghost of Tsushima',
      hoursTenths: 1080,
      firstPlayedYear: 2020,
      rating: 5,
    });
  });
});

describe('cross-owner isolation', () => {
  it('never returns another owner’s games', async () => {
    const mine = await makeOwner('mine@burmy.test');
    const theirs = await makeOwner('theirs@burmy.test');
    await games.createGame(theirs, { title: 'Their Game', platform: 'ps5' });

    expect(await games.listGames(mine)).toEqual([]);
    expect(await games.listGameStatRows(mine)).toEqual([]);
  });

  it('refuses to read, update, or delete across owners', async () => {
    const mine = await makeOwner('mine@burmy.test');
    const theirs = await makeOwner('theirs@burmy.test');
    const theirGame = await games.createGame(theirs, { title: 'Their Game', platform: 'ps5' });

    await expect(games.getGame(mine, theirGame.id)).rejects.toBeInstanceOf(errors.GameNotFoundError);
    await expect(
      games.updateGame(mine, theirGame.id, { title: 'Hijacked', platform: 'ps5' }),
    ).rejects.toBeInstanceOf(errors.GameNotFoundError);
    await expect(games.deleteGame(mine, theirGame.id)).rejects.toBeInstanceOf(errors.GameNotFoundError);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
pnpm test:integration -- games
```

Expected: FAIL — cannot resolve `@/server/db/games/games`.

- [ ] **Step 4: Implement `src/server/db/games/games.ts`**

```ts
/**
 * Owner-scoped data access for `games`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `ownerId` IS THE FIRST PARAMETER OF EVERY FUNCTION AND GOES INTO EVERY WHERE.
 *
 * Same rule Finance's data-access layer follows. There is exactly one owner
 * today, which is precisely why the discipline has to be structural rather than
 * remembered: nothing about a single-owner database will fail loudly the day a
 * query forgets its scope.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { and, asc, desc, eq } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { games as gamesTable } from '@/server/db/schema';
import type { GameOwnership, GamePlatform, GameStatRow, GameStatus } from '@/server/games/stats';
import { DuplicateGameError, GameNotFoundError, isUniqueViolation } from './errors';

export const GAME_PLATFORMS = ['ps5', 'ps4', 'psp', 'steam', 'pc', 'other'] as const;
export const GAME_OWNERSHIPS = ['physical', 'digital'] as const;
export const GAME_STATUSES = ['backlog', 'playing', 'completed', 'paused_dropped'] as const;

/** Display labels. The enum values are storage; these are what a human reads. */
export const PLATFORM_LABELS: Record<GamePlatform, string> = {
  ps5: 'PS5',
  ps4: 'PS4',
  psp: 'PSP',
  steam: 'Steam',
  pc: 'PC',
  other: 'Other',
};

export const STATUS_LABELS: Record<GameStatus, string> = {
  backlog: 'Backlog',
  playing: 'Playing',
  completed: 'Completed',
  paused_dropped: 'Paused / Dropped',
};

export interface Game {
  readonly id: string;
  readonly title: string;
  readonly platform: GamePlatform;
  readonly developer: string | null;
  readonly publisher: string | null;
  readonly ownership: GameOwnership | null;
  readonly priceCents: number | null;
  readonly status: GameStatus;
  readonly rating: number | null;
  readonly hoursTenths: number | null;
  readonly firstPlayedYear: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly coverUrl: string | null;
  readonly genre: string | null;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Only `title` and `platform` are required — a backlog entry may know nothing else yet. */
export interface GameInput {
  readonly title: string;
  readonly platform: GamePlatform;
  readonly developer?: string | null;
  readonly publisher?: string | null;
  readonly ownership?: GameOwnership | null;
  readonly priceCents?: number | null;
  readonly status?: GameStatus;
  readonly rating?: number | null;
  readonly hoursTenths?: number | null;
  readonly firstPlayedYear?: number | null;
  readonly achievementsUnlocked?: number | null;
  readonly achievementsTotal?: number | null;
  readonly coverUrl?: string | null;
  readonly genre?: string | null;
  readonly notes?: string | null;
}

function rowToGame(row: typeof gamesTable.$inferSelect): Game {
  return {
    id: row.id,
    title: row.title,
    platform: row.platform as GamePlatform,
    developer: row.developer,
    publisher: row.publisher,
    ownership: row.ownership as GameOwnership | null,
    priceCents: row.priceCents,
    status: row.status as GameStatus,
    rating: row.rating,
    hoursTenths: row.hoursTenths,
    firstPlayedYear: row.firstPlayedYear,
    achievementsUnlocked: row.achievementsUnlocked,
    achievementsTotal: row.achievementsTotal,
    coverUrl: row.coverUrl,
    genre: row.genre,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ListGamesOptions {
  readonly status?: GameStatus;
  readonly platform?: GamePlatform;
}

export async function listGames(ownerId: string, options: ListGamesOptions = {}): Promise<Game[]> {
  const filters = [eq(gamesTable.ownerId, ownerId)];
  if (options.status !== undefined) filters.push(eq(gamesTable.status, options.status));
  if (options.platform !== undefined) filters.push(eq(gamesTable.platform, options.platform));

  const rows = await getDb()
    .select()
    .from(gamesTable)
    .where(and(...filters))
    // Newest-played first, then alphabetical — the order the library grid reads
    // best in, and stable for games sharing a year.
    .orderBy(desc(gamesTable.firstPlayedYear), asc(gamesTable.title));

  return rows.map(rowToGame);
}

export async function getGame(ownerId: string, id: string): Promise<Game> {
  const rows = await getDb()
    .select()
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, id)))
    .limit(1);

  const row = rows[0];
  if (!row) throw new GameNotFoundError();
  return rowToGame(row);
}

export async function createGame(ownerId: string, input: GameInput): Promise<Game> {
  try {
    const rows = await getDb()
      .insert(gamesTable)
      .values({ ownerId, ...input })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Game insert returned no row');
    return rowToGame(row);
  } catch (error) {
    // Let the DATABASE decide uniqueness. A pre-check plus an insert is a race;
    // the unique index is not.
    if (isUniqueViolation(error)) throw new DuplicateGameError(input.title);
    throw error;
  }
}

export async function updateGame(ownerId: string, id: string, input: GameInput): Promise<Game> {
  try {
    const rows = await getDb()
      .update(gamesTable)
      // `updatedAt` is set by hand on every write — there is no DB trigger.
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, id)))
      .returning();

    const row = rows[0];
    if (!row) throw new GameNotFoundError();
    return rowToGame(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateGameError(input.title);
    throw error;
  }
}

export async function deleteGame(ownerId: string, id: string): Promise<void> {
  const deleted = await getDb()
    .delete(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, id)))
    .returning();

  if (!deleted[0]) throw new GameNotFoundError();
}

/**
 * The narrow projection `src/server/games/stats.ts` consumes. Selecting columns
 * explicitly rather than reusing `listGames` keeps the stats layer's input
 * shape from silently widening every time a display field is added.
 */
export async function listGameStatRows(ownerId: string): Promise<GameStatRow[]> {
  const rows = await getDb()
    .select({
      id: gamesTable.id,
      title: gamesTable.title,
      platform: gamesTable.platform,
      ownership: gamesTable.ownership,
      developer: gamesTable.developer,
      publisher: gamesTable.publisher,
      genre: gamesTable.genre,
      status: gamesTable.status,
      rating: gamesTable.rating,
      hoursTenths: gamesTable.hoursTenths,
      firstPlayedYear: gamesTable.firstPlayedYear,
      achievementsUnlocked: gamesTable.achievementsUnlocked,
      achievementsTotal: gamesTable.achievementsTotal,
    })
    .from(gamesTable)
    .where(eq(gamesTable.ownerId, ownerId));

  return rows.map((row) => ({
    ...row,
    platform: row.platform as GamePlatform,
    ownership: row.ownership as GameOwnership | null,
    status: row.status as GameStatus,
  }));
}
```

- [ ] **Step 5: Run the integration tests**

```bash
pnpm test:integration -- games
```

Expected: PASS, 10 tests. Requires Docker running.

- [ ] **Step 6: Run the full gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
git add src/server/db/games tests/integration/games.test.ts
git commit -m "feat(games): owner-scoped data-access layer with integration tests"
```

---

### Task 4: Server Actions

**Files:**
- Create: `src/features/games/action-result.ts`
- Create: `src/features/games/game-actions.ts`
- Test: covered by Task 3's integration tests plus `tests/integration/entry-points.test.ts` (already enforces `requireOwner`)

**Interfaces:**
- Consumes: `createGame`/`updateGame`/`deleteGame` and `GAME_*` const tuples from `@/server/db/games/games`; `DuplicateGameError`/`GameNotFoundError` from `@/server/db/games/errors`; `fromHoursInput` from `@/server/games/hours`
- Produces: `type ActionResult`, `ok()`, `fail()`; `createGameAction(formData): Promise<ActionResult>`, `updateGameAction(id, formData): Promise<ActionResult>`, `deleteGameAction(id): Promise<ActionResult>`, `setGameStatusAction(id, status): Promise<ActionResult>`

- [ ] **Step 1: Create `src/features/games/action-result.ts`**

Its own copy, not an import from Finance — Finance has five copies of this file for the same reason, each with a feature-specific `field` union.

```ts
/**
 * The shape every Games Server Action returns.
 *
 * Expected failures (a duplicate title, a bad rating) come back as DATA so the
 * form can show a field error without the route's error boundary replacing what
 * the owner typed. Unexpected failures — `requireOwner()` rejecting, the
 * database being unreachable — still THROW, so a security refusal never gets
 * flattened into something that renders like a typo.
 */
export type ActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly field?: 'title' | 'hours' | 'rating' };

export function ok(): ActionResult {
  return { ok: true };
}

export function fail(error: string, field?: 'title' | 'hours' | 'rating'): ActionResult {
  // `exactOptionalPropertyTypes` is on — spread the key in conditionally rather
  // than assigning `undefined`.
  return { ok: false, error, ...(field ? { field } : {}) };
}
```

- [ ] **Step 2: Create `src/features/games/game-actions.ts`**

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { DuplicateGameError, GameNotFoundError } from '@/server/db/games/errors';
import {
  GAME_OWNERSHIPS,
  GAME_PLATFORMS,
  GAME_STATUSES,
  type GameInput,
  createGame,
  deleteGame,
  updateGame,
} from '@/server/db/games/games';
import { fromHoursInput } from '@/server/games/hours';
import { type ActionResult, fail, ok } from './action-result';

/**
 * Server Actions for the games library.
 *
 * Every one begins with `await requireOwner()`. Next.js handles Server
 * Functions as POSTs to the route where they are used, so proxy coverage is
 * defense-in-depth and never the boundary — see `src/server/auth/owner.ts`.
 */

const idSchema = z.string().uuid();

const gameSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(300),
  platform: z.enum(GAME_PLATFORMS),
  developer: z.string().trim().max(300).optional(),
  publisher: z.string().trim().max(300).optional(),
  ownership: z.enum(GAME_OWNERSHIPS).optional(),
  status: z.enum(GAME_STATUSES),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  hours: z.string().optional(),
  firstPlayedYear: z.coerce.number().int().min(1970).max(2100).optional(),
  achievementsUnlocked: z.coerce.number().int().min(0).max(10_000).optional(),
  achievementsTotal: z.coerce.number().int().min(0).max(10_000).optional(),
  priceDollars: z.coerce.number().min(0).max(10_000).optional(),
  coverUrl: z.string().url().max(2000).optional(),
  genre: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
});

function toResult(error: unknown): ActionResult {
  if (error instanceof DuplicateGameError) {
    return fail(
      `"${error.duplicateTitle}" is already in your library on that platform. The same game on a different platform is fine.`,
      'title',
    );
  }
  if (error instanceof GameNotFoundError) return fail(error.message);
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const path = issue?.path[0];
    const field = path === 'title' || path === 'hours' || path === 'rating' ? path : undefined;
    return fail(issue?.message ?? 'That input is not valid', field);
  }
  // Anything unrecognized is a real fault, not user input. Let it throw.
  throw error;
}

/** Empty-string form fields become `undefined`, not `''`, before validation. */
function text(formData: FormData, key: string): string | undefined {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Build the DAL input. More than three optional fields are assembled here, so
 * this uses a mutable local object rather than merged conditional spreads —
 * merging many spreads makes `tsc` infer `T | undefined` under
 * `exactOptionalPropertyTypes` even though each spread is individually correct
 * (documented inference gap in CLAUDE.md).
 */
function parse(formData: FormData): GameInput {
  const raw = gameSchema.parse({
    title: text(formData, 'title') ?? '',
    platform: text(formData, 'platform') ?? 'other',
    developer: text(formData, 'developer'),
    publisher: text(formData, 'publisher'),
    ownership: text(formData, 'ownership'),
    status: text(formData, 'status') ?? 'backlog',
    rating: text(formData, 'rating'),
    hours: text(formData, 'hours'),
    firstPlayedYear: text(formData, 'firstPlayedYear'),
    achievementsUnlocked: text(formData, 'achievementsUnlocked'),
    achievementsTotal: text(formData, 'achievementsTotal'),
    priceDollars: text(formData, 'priceDollars'),
    coverUrl: text(formData, 'coverUrl'),
    genre: text(formData, 'genre'),
    notes: text(formData, 'notes'),
  });

  const input: {
    -readonly [K in keyof GameInput]: GameInput[K];
  } = { title: raw.title, platform: raw.platform, status: raw.status };

  if (raw.developer !== undefined) input.developer = raw.developer;
  if (raw.publisher !== undefined) input.publisher = raw.publisher;
  if (raw.ownership !== undefined) input.ownership = raw.ownership;
  if (raw.rating !== undefined) input.rating = raw.rating;
  if (raw.firstPlayedYear !== undefined) input.firstPlayedYear = raw.firstPlayedYear;
  if (raw.achievementsUnlocked !== undefined) input.achievementsUnlocked = raw.achievementsUnlocked;
  if (raw.achievementsTotal !== undefined) input.achievementsTotal = raw.achievementsTotal;
  if (raw.coverUrl !== undefined) input.coverUrl = raw.coverUrl;
  if (raw.genre !== undefined) input.genre = raw.genre;
  if (raw.notes !== undefined) input.notes = raw.notes;

  if (raw.hours !== undefined) {
    const tenths = fromHoursInput(raw.hours);
    if (tenths === null) throw new z.ZodError([{ code: 'custom', path: ['hours'], message: 'Hours must be a number like 23 or 23.5' }]);
    input.hoursTenths = tenths;
  }

  // Dollars in the form, cents in the database — never a float in storage.
  if (raw.priceDollars !== undefined) input.priceCents = Math.round(raw.priceDollars * 100);

  return input;
}

export async function createGameAction(formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await createGame(owner.userId, parse(formData));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/games');
  revalidatePath('/games/stats');
  return ok();
}

export async function updateGameAction(id: string, formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await updateGame(owner.userId, idSchema.parse(id), parse(formData));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/games');
  revalidatePath('/games/stats');
  return ok();
}

export async function deleteGameAction(id: string): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await deleteGame(owner.userId, idSchema.parse(id));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/games');
  revalidatePath('/games/stats');
  return ok();
}

/**
 * Status-only change, for the one-click control on a library card. Kept
 * separate from `updateGameAction` so moving a game to "Playing" does not
 * require round-tripping every other field back through the form.
 */
export async function setGameStatusAction(
  id: string,
  status: (typeof GAME_STATUSES)[number],
): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    const parsedStatus = z.enum(GAME_STATUSES).parse(status);
    const { getGame } = await import('@/server/db/games/games');
    const existing = await getGame(owner.userId, idSchema.parse(id));
    await updateGame(owner.userId, existing.id, {
      title: existing.title,
      platform: existing.platform,
      status: parsedStatus,
    });
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/games');
  revalidatePath('/games/stats');
  return ok();
}
```

- [ ] **Step 3: Verify the entry-point guard still passes**

```bash
pnpm test:integration -- entry-points
```

Expected: PASS. This test enumerates `src/app` and every Server Action file, and fails if any lacks `requireOwner()`.

- [ ] **Step 4: Run gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/features/games
git commit -m "feat(games): server actions for create, update, delete, and status"
```

---

### Task 5: RAWG metadata client

**Files:**
- Create: `src/server/games/metadata.ts` (pure: URL building + response shaping, no fetch)
- Create: `src/server/db/games/rawg.ts` (the HTTP boundary)
- Create: `src/features/games/metadata-actions.ts`
- Modify: `.env.example`
- Test: `tests/unit/games-metadata.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks
- Produces:
  - `metadata.ts`: `interface RawgGame`, `interface GameSuggestion`, `buildSearchUrl(query, apiKey): string`, `toSuggestions(payload: unknown): GameSuggestion[]`, `scoreMatch(query: string, candidate: string): number`, `pickBestMatch(query, suggestions): { suggestion, confidence } | null`
  - `rawg.ts`: `searchGames(query: string): Promise<GameSuggestion[]>`
  - `metadata-actions.ts`: `searchGameMetadataAction(query: string): Promise<GameSuggestion[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/games-metadata.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { buildSearchUrl, pickBestMatch, scoreMatch, toSuggestions } from '@/server/games/metadata';

describe('buildSearchUrl', () => {
  it('encodes the query and attaches the key', () => {
    const url = buildSearchUrl('Ghost of Yōtei', 'test-key');
    expect(url).toContain('search=Ghost%20of%20Y%C5%8Dtei');
    expect(url).toContain('key=test-key');
  });
});

describe('toSuggestions', () => {
  it('maps a RAWG payload to the fields the app stores', () => {
    const suggestions = toSuggestions({
      results: [
        {
          id: 1,
          name: 'Elden Ring',
          background_image: 'https://media.rawg.io/elden.jpg',
          released: '2022-02-25',
          genres: [{ name: 'Action' }, { name: 'RPG' }],
          developers: [{ name: 'FromSoftware' }],
          publishers: [{ name: 'Bandai Namco' }],
        },
      ],
    });

    expect(suggestions[0]).toEqual({
      externalId: '1',
      title: 'Elden Ring',
      coverUrl: 'https://media.rawg.io/elden.jpg',
      releaseYear: 2022,
      genre: 'Action, RPG',
      developer: 'FromSoftware',
      publisher: 'Bandai Namco',
    });
  });

  it('tolerates missing optional fields rather than throwing', () => {
    const suggestions = toSuggestions({ results: [{ id: 2, name: 'Obscure Game' }] });
    expect(suggestions[0]).toMatchObject({ title: 'Obscure Game', coverUrl: null, genre: null });
  });

  it('returns an empty list for a malformed payload', () => {
    expect(toSuggestions(null)).toEqual([]);
    expect(toSuggestions({})).toEqual([]);
    expect(toSuggestions({ results: 'nope' })).toEqual([]);
  });
});

describe('scoreMatch', () => {
  it('scores an exact case-insensitive match highest', () => {
    expect(scoreMatch('Elden Ring', 'elden ring')).toBe(1);
  });

  it('scores an unrelated title near zero', () => {
    expect(scoreMatch('Elden Ring', 'FIFA 17')).toBeLessThan(0.3);
  });

  it('still scores well when the log title carries a collection prefix', () => {
    // The real spreadsheet has entries shaped exactly like this.
    const score = scoreMatch(
      'Uncharted: Legacy of Thieves Collection - UNCHARTED 4: A Thief’s End',
      'Uncharted 4: A Thief’s End',
    );
    expect(score).toBeGreaterThan(0.5);
  });
});

describe('pickBestMatch', () => {
  it('returns the highest-scoring suggestion with its confidence', () => {
    const best = pickBestMatch('Elden Ring', [
      { externalId: '1', title: 'Elden Ring II', coverUrl: null, releaseYear: null, genre: null, developer: null, publisher: null },
      { externalId: '2', title: 'Elden Ring', coverUrl: null, releaseYear: null, genre: null, developer: null, publisher: null },
    ]);

    expect(best?.suggestion.externalId).toBe('2');
    expect(best?.confidence).toBe(1);
  });

  it('returns null when there are no suggestions at all', () => {
    expect(pickBestMatch('Anything', [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm test --project domain -- games-metadata
```

Expected: FAIL — cannot resolve `@/server/games/metadata`.

- [ ] **Step 3: Implement `src/server/games/metadata.ts`**

```ts
/**
 * Game metadata shaping — cover art, genre, developer, publisher.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY RAWG AND NOT IGDB
 *
 * Both expose the same cover-art-and-genre data. RAWG authenticates with a
 * single API key in an env var; IGDB requires a Twitch developer application
 * and an OAuth client-credentials exchange with token refresh. For a
 * single-owner personal app that calls this a few times a month, the OAuth
 * lifecycle is pure operational cost with no benefit.
 *
 * This module is PURE — it builds URLs and shapes responses but never performs
 * a request. The fetch lives in `src/server/db/games/rawg.ts` so the matching
 * logic below stays testable without a network or a fake server.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RAWG_SEARCH_ENDPOINT = 'https://api.rawg.io/api/games';

export interface GameSuggestion {
  readonly externalId: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly releaseYear: number | null;
  readonly genre: string | null;
  readonly developer: string | null;
  readonly publisher: string | null;
}

export function buildSearchUrl(query: string, apiKey: string): string {
  const url = new URL(RAWG_SEARCH_ENDPOINT);
  url.searchParams.set('search', query);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('page_size', '6');
  return url.toString();
}

function firstName(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const entry = value[0];
  if (typeof entry !== 'object' || entry === null) return null;
  const name = (entry as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function joinNames(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const names = value
    .map((entry) =>
      typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string'
        ? (entry as { name: string }).name
        : null,
    )
    .filter((name): name is string => name !== null);
  return names.length === 0 ? null : names.join(', ');
}

/** Defensive by construction: a third-party payload is untrusted shape, not a typed contract. */
export function toSuggestions(payload: unknown): GameSuggestion[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((entry): GameSuggestion[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.id === undefined) return [];

    const released = typeof record.released === 'string' ? Number(record.released.slice(0, 4)) : NaN;

    return [
      {
        externalId: String(record.id),
        title: record.name,
        coverUrl: typeof record.background_image === 'string' ? record.background_image : null,
        releaseYear: Number.isFinite(released) ? released : null,
        genre: joinNames(record.genres),
        developer: firstName(record.developers),
        publisher: firstName(record.publishers),
      },
    ];
  });
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * 0-1 similarity by token overlap, scored against the CANDIDATE's tokens.
 *
 * Deliberately asymmetric: the owner's log contains entries like "Uncharted:
 * Legacy of Thieves Collection - UNCHARTED 4: A Thief's End", where the extra
 * collection prefix is noise. Scoring "how much of the candidate did the query
 * cover" rather than plain Jaccard keeps that entry matching "Uncharted 4: A
 * Thief's End" instead of being penalized for the prefix.
 */
export function scoreMatch(query: string, candidate: string): number {
  const queryTokens = new Set(normalize(query).split(' ').filter(Boolean));
  const candidateTokens = normalize(candidate).split(' ').filter(Boolean);
  if (candidateTokens.length === 0 || queryTokens.size === 0) return 0;

  const covered = candidateTokens.filter((token) => queryTokens.has(token)).length;
  return covered / candidateTokens.length;
}

export function pickBestMatch(
  query: string,
  suggestions: readonly GameSuggestion[],
): { readonly suggestion: GameSuggestion; readonly confidence: number } | null {
  let best: { suggestion: GameSuggestion; confidence: number } | null = null;

  for (const suggestion of suggestions) {
    const confidence = scoreMatch(query, suggestion.title);
    if (best === null || confidence > best.confidence) best = { suggestion, confidence };
  }

  return best;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
pnpm test --project domain -- games-metadata
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Implement the HTTP boundary `src/server/db/games/rawg.ts`**

```ts
/**
 * The one place a game-metadata HTTP request happens.
 *
 * Isolated from `src/server/games/metadata.ts` so all the URL building and
 * response shaping stays pure and unit-testable. Failure is ALWAYS soft: cover
 * art is a nicety, and a RAWG outage must never block adding a game to the
 * library.
 */

import { buildSearchUrl, toSuggestions, type GameSuggestion } from '@/server/games/metadata';

const TIMEOUT_MS = 5_000;

export async function searchGames(query: string): Promise<GameSuggestion[]> {
  const apiKey = process.env.RAWG_API_KEY;
  // Not configured is a normal state, not an error: the app is fully usable
  // without cover art, and the test suite must pass with no key present.
  if (apiKey === undefined || apiKey === '') return [];
  if (query.trim() === '') return [];

  try {
    const response = await fetch(buildSearchUrl(query, apiKey), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return [];
    return toSuggestions(await response.json());
  } catch {
    // Network error, timeout, or malformed JSON — all mean "no suggestions",
    // never a thrown error that would break the add-game form.
    return [];
  }
}
```

- [ ] **Step 6: Create `src/features/games/metadata-actions.ts`**

```ts
'use server';

import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { searchGames } from '@/server/db/games/rawg';
import type { GameSuggestion } from '@/server/games/metadata';

/** Cover-art lookup for the add/edit form. `requireOwner()` first, like every Server Action. */
export async function searchGameMetadataAction(query: string): Promise<GameSuggestion[]> {
  await requireOwner();
  const parsed = z.string().trim().min(2).max(200).safeParse(query);
  if (!parsed.success) return [];
  return searchGames(parsed.data);
}
```

- [ ] **Step 7: Document the env var**

Add to `.env.example`:

```bash
# Game metadata (cover art, genre, developer) from https://rawg.io/apidocs
# OPTIONAL — the Games module works fully without it, just without cover art.
# The test suite must pass with this unset.
RAWG_API_KEY=
```

- [ ] **Step 8: Run gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/server/games/metadata.ts src/server/db/games/rawg.ts src/features/games/metadata-actions.ts .env.example tests/unit/games-metadata.test.ts
git commit -m "feat(games): RAWG metadata lookup with pure matching logic"
```

---

### Task 6: Navigation and route shell

**Files:**
- Modify: `src/features/shell/nav.tsx:3` (icon import), `:9-19` (doc comment), `:20-23` (LINKS)
- Create: `src/app/(private)/games/(tabs)/layout.tsx`
- Create: `src/app/(private)/games/(tabs)/library/page.tsx` (placeholder, filled in Task 7)
- Create: `src/app/(private)/games/(tabs)/stats/page.tsx` (placeholder, filled in Task 8)
- Create: `src/app/(private)/games/page.tsx` (redirect to `/games/library`)
- Modify: `tests/integration/entry-points.test.ts` (`PURE_REDIRECT_PAGE_ALLOWLIST`)

**Interfaces:**
- Consumes: `SubNav` from `@/features/shell/nav`; `requireOwner` from `@/server/auth/owner`
- Produces: routes `/games`, `/games/library`, `/games/stats`

- [ ] **Step 1: Add the Games nav entry**

In `src/features/shell/nav.tsx`, line 3, add the icon:

```tsx
import { Gamepad2, Settings, Table2 } from 'lucide-react';
```

Replace the `LINKS` const and its doc comment (lines ~9-23) — the existing comment says *"Two destinations. That is the whole application"*, which this change makes false:

```tsx
/**
 * Three destinations: Finance, Games, Settings.
 *
 * Finance and Games are the two product modules; Settings is separated from
 * them by a rule below. There is no Home dashboard — each module's own landing
 * view IS its home. A fourth entry should require a real third module, not an
 * anticipated one.
 */
const LINKS = [
  { href: '/finance/monthly', label: 'Finance', Icon: Table2, match: '/finance' },
  { href: '/games/library', label: 'Games', Icon: Gamepad2, match: '/games' },
  { href: '/settings', label: 'Settings', Icon: Settings, match: '/settings' },
] as const;
```

Games goes BEFORE Settings deliberately: the separator `<hr>` at `nav.tsx:55` renders via `label === 'Settings'`, so keeping Settings last preserves the rule's position with no change to that logic.

- [ ] **Step 2: Create the tabs layout `src/app/(private)/games/(tabs)/layout.tsx`**

```tsx
import { SubNav } from '@/features/shell/nav';
import { requireOwner } from '@/server/auth/owner';

/**
 * Library / Stats — the two Games screens that share a persistent tab bar.
 *
 * `requireOwner()` here is defense-in-depth alongside the page-level calls each
 * page makes itself. A layout guard alone would not protect a page's Server
 * Actions (see CLAUDE.md), so this does not replace those calls.
 */
export default async function GamesTabsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  await requireOwner();

  const links = [
    { href: '/games/library', label: 'Library' },
    { href: '/games/stats', label: 'Stats' },
  ];

  return (
    <div className="space-y-6">
      <SubNav links={links} />
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Create the redirect at `src/app/(private)/games/page.tsx`**

```tsx
import { redirect } from 'next/navigation';

/** `/games` has no content of its own — the library is the landing view. */
export default function GamesIndexPage(): never {
  redirect('/games/library');
}
```

- [ ] **Step 4: Add the redirect page to the entry-points allowlist**

In `tests/integration/entry-points.test.ts`, add `'/games'` to `PURE_REDIRECT_PAGE_ALLOWLIST` alongside the existing `'/finance/import'` entry. A page whose entire body is `redirect()` reaches no data and needs no owner check.

- [ ] **Step 5: Create placeholder pages so the routes resolve**

`src/app/(private)/games/(tabs)/library/page.tsx`:

```tsx
import type { Metadata } from 'next';

import { requireOwner } from '@/server/auth/owner';
import { listGames } from '@/server/db/games/games';

export const metadata: Metadata = { title: 'Games — Burmy' };

export default async function GamesLibraryPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const games = await listGames(owner.userId);

  return (
    <div>
      <h1 className="text-xl font-semibold">Library</h1>
      <p className="text-muted-foreground mt-1 text-sm">{games.length} games</p>
    </div>
  );
}
```

`src/app/(private)/games/(tabs)/stats/page.tsx`:

```tsx
import type { Metadata } from 'next';

import { requireOwner } from '@/server/auth/owner';
import { listGameStatRows } from '@/server/db/games/games';

export const metadata: Metadata = { title: 'Game stats — Burmy' };

export default async function GamesStatsPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const rows = await listGameStatRows(owner.userId);

  return (
    <div>
      <h1 className="text-xl font-semibold">Stats</h1>
      <p className="text-muted-foreground mt-1 text-sm">{rows.length} games tracked</p>
    </div>
  );
}
```

- [ ] **Step 6: Verify routing and the entry-point guard**

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm test:integration -- entry-points
```

Expected: build lists `/games`, `/games/library`, `/games/stats`; entry-points passes.

- [ ] **Step 7: Commit**

```bash
git add src/features/shell/nav.tsx "src/app/(private)/games" tests/integration/entry-points.test.ts
git commit -m "feat(games): nav entry, tab shell, and route skeleton"
```

---

### Task 7: Library UI — card gallery, table view, and the game editor

**Files:**
- Create: `src/components/games/status-badge.tsx`
- Create: `src/components/games/rating-stars.tsx`
- Create: `src/features/games/library/game-card.tsx`
- Create: `src/features/games/library/game-grid.tsx`
- Create: `src/features/games/library/game-table.tsx`
- Create: `src/features/games/library/library-view.tsx`
- Create: `src/features/games/library/game-dialog.tsx`
- Modify: `src/app/(private)/games/(tabs)/library/page.tsx`
- Test: `tests/unit/games-library-view.test.tsx`

**Interfaces:**
- Consumes: `Game`, `PLATFORM_LABELS`, `STATUS_LABELS`, `GAME_STATUSES` from `@/server/db/games/games`; `formatHours`, `hours` from `@/server/games/hours`; actions from `@/features/games/game-actions`; `searchGameMetadataAction` from `@/features/games/metadata-actions`
- Produces: `<LibraryView games={...} />` — the whole library screen, owning view-mode and filter state

- [ ] **Step 1: Create the two presentational primitives**

`src/components/games/status-badge.tsx`:

```tsx
import { cn } from '@/lib/utils';
import type { GameStatus } from '@/server/games/stats';

const STYLES: Record<GameStatus, string> = {
  backlog: 'bg-muted text-muted-foreground',
  playing: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  completed: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  paused_dropped: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

const LABELS: Record<GameStatus, string> = {
  backlog: 'Backlog',
  playing: 'Playing',
  completed: 'Completed',
  paused_dropped: 'Paused',
};

export function StatusBadge({ status }: { readonly status: GameStatus }): React.ReactElement {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STYLES[status])}>
      {LABELS[status]}
    </span>
  );
}
```

`src/components/games/rating-stars.tsx`:

```tsx
import { Star } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Read-only 1-5 display. Renders nothing at all when unrated — an empty row of
 * hollow stars reads as "rated zero", which is a different claim from "not yet
 * rated".
 */
export function RatingStars({ rating }: { readonly rating: number | null }): React.ReactElement | null {
  if (rating === null) return null;

  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((position) => (
        <Star
          key={position}
          aria-hidden
          className={cn(
            'size-3.5',
            position <= rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30',
          )}
        />
      ))}
    </span>
  );
}
```

- [ ] **Step 2: Write the failing component test**

Create `tests/unit/games-library-view.test.tsx` (`.tsx` → runs in the jsdom `components` project):

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const setGameStatusAction = vi.fn(async () => ({ ok: true as const }));
const deleteGameAction = vi.fn(async () => ({ ok: true as const }));
const createGameAction = vi.fn(async () => ({ ok: true as const }));
const updateGameAction = vi.fn(async () => ({ ok: true as const }));

vi.mock('@/features/games/game-actions', () => ({
  setGameStatusAction,
  deleteGameAction,
  createGameAction,
  updateGameAction,
}));

vi.mock('@/features/games/metadata-actions', () => ({
  searchGameMetadataAction: vi.fn(async () => []),
}));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { LibraryView } = await import('@/features/games/library/library-view');

type Game = Parameters<typeof LibraryView>[0]['games'][number];

function game(overrides: Partial<Game>): Game {
  return {
    id: 'game-1',
    title: 'Elden Ring',
    platform: 'ps5',
    developer: 'FromSoftware, Inc.',
    publisher: 'Bandai Namco',
    ownership: 'physical',
    priceCents: 6565,
    status: 'completed',
    rating: 5,
    hoursTenths: 1360,
    firstPlayedYear: 2022,
    achievementsUnlocked: 42,
    achievementsTotal: 42,
    coverUrl: null,
    genre: 'Action RPG',
    notes: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('LibraryView', () => {
  it('renders every game in the default gallery view', () => {
    render(<LibraryView games={[game({ id: 'a', title: 'Elden Ring' }), game({ id: 'b', title: 'Prey' })]} />);

    expect(screen.getByText('Elden Ring')).toBeInTheDocument();
    expect(screen.getByText('Prey')).toBeInTheDocument();
  });

  it('switches to a table view without losing any games', async () => {
    render(<LibraryView games={[game({ id: 'a', title: 'Elden Ring' })]} />);

    await userEvent.click(screen.getByRole('button', { name: /table view/i }));

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Elden Ring')).toBeInTheDocument();
  });

  it('filters by status', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Finished Game', status: 'completed' }),
          game({ id: 'b', title: 'Queued Game', status: 'backlog' }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^backlog/i }));

    expect(screen.getByText('Queued Game')).toBeInTheDocument();
    expect(screen.queryByText('Finished Game')).not.toBeInTheDocument();
  });

  it('shows a searchable count that reflects the active filter', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Finished Game', status: 'completed' }),
          game({ id: 'b', title: 'Queued Game', status: 'backlog' }),
        ]}
      />,
    );

    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'Queued');

    expect(screen.getByText('Queued Game')).toBeInTheDocument();
    expect(screen.queryByText('Finished Game')).not.toBeInTheDocument();
  });

  it('tells the owner the library is empty rather than rendering a blank grid', () => {
    render(<LibraryView games={[]} />);
    expect(screen.getByText(/no games yet/i)).toBeInTheDocument();
  });

  it('formats hours as the owner writes them, not as raw tenths', () => {
    render(<LibraryView games={[game({ hoursTenths: 1360 })]} />);
    expect(screen.getByText('136h')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
pnpm test --project components -- games-library-view
```

Expected: FAIL — cannot resolve `@/features/games/library/library-view`.

- [ ] **Step 4: Implement `src/features/games/library/game-card.tsx`**

```tsx
'use client';

import Image from 'next/image';
import { Gamepad2 } from 'lucide-react';

import { RatingStars } from '@/components/games/rating-stars';
import { StatusBadge } from '@/components/games/status-badge';
import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import { PLATFORM_LABELS } from '@/server/db/games/games';
import { formatHours, hours } from '@/server/games/hours';

/**
 * One game in the gallery. Cover art is the primary affordance; everything else
 * is secondary metadata layered beneath it. Games with no cover fall back to a
 * typographic tile rather than a broken-image box — roughly half the historical
 * library predates cover art being available at all.
 */
export function GameCard({
  game,
  onOpen,
}: {
  readonly game: Game;
  readonly onOpen: (game: Game) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => onOpen(game)}
      className={cn(
        'group focus-visible:ring-ring flex flex-col overflow-hidden rounded-lg border text-left',
        'transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:outline-none',
      )}
    >
      <div className="bg-muted relative aspect-[3/4] w-full overflow-hidden">
        {game.coverUrl === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center">
            <Gamepad2 className="text-muted-foreground/40 size-8" aria-hidden />
            <span className="text-muted-foreground line-clamp-3 text-xs font-medium">{game.title}</span>
          </div>
        ) : (
          <Image
            src={game.coverUrl}
            alt=""
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 200px"
            className="object-cover transition-transform group-hover:scale-[1.03]"
          />
        )}
        <div className="absolute top-2 left-2">
          <StatusBadge status={game.status} />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <span className="line-clamp-2 text-sm font-medium">{game.title}</span>
        <span className="text-muted-foreground text-xs">
          {PLATFORM_LABELS[game.platform]}
          {game.firstPlayedYear === null ? '' : ` · ${game.firstPlayedYear}`}
        </span>
        <div className="mt-auto flex items-center justify-between pt-2">
          <RatingStars rating={game.rating} />
          {game.hoursTenths === null ? null : (
            <span className="text-muted-foreground tabular text-xs">
              {formatHours(hours(game.hoursTenths))}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
```

- [ ] **Step 5: Implement `src/features/games/library/game-grid.tsx` and `game-table.tsx`**

`game-grid.tsx`:

```tsx
'use client';

import type { Game } from '@/server/db/games/games';
import { GameCard } from './game-card';

export function GameGrid({
  games,
  onOpen,
}: {
  readonly games: readonly Game[];
  readonly onOpen: (game: Game) => void;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
      {games.map((game) => (
        <GameCard key={game.id} game={game} onOpen={onOpen} />
      ))}
    </div>
  );
}
```

`game-table.tsx`:

```tsx
'use client';

import { RatingStars } from '@/components/games/rating-stars';
import { StatusBadge } from '@/components/games/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Game } from '@/server/db/games/games';
import { PLATFORM_LABELS } from '@/server/db/games/games';
import { formatHours, hours } from '@/server/games/hours';

/**
 * The dense view — deliberately close to the spreadsheet this replaces, because
 * scanning and comparing 100 rows is a genuinely different task from browsing,
 * and a card grid is bad at it.
 */
export function GameTable({
  games,
  onOpen,
}: {
  readonly games: readonly Game[];
  readonly onOpen: (game: Game) => void;
}): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Platform</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Hours</TableHead>
          <TableHead className="text-right">Year</TableHead>
          <TableHead className="text-right">Achievements</TableHead>
          <TableHead>Rating</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {games.map((game) => (
          <TableRow
            key={game.id}
            className="cursor-pointer"
            onClick={() => onOpen(game)}
          >
            <TableCell className="font-medium">{game.title}</TableCell>
            <TableCell className="text-muted-foreground">{PLATFORM_LABELS[game.platform]}</TableCell>
            <TableCell>
              <StatusBadge status={game.status} />
            </TableCell>
            <TableCell className="tabular text-right">
              {game.hoursTenths === null ? '—' : formatHours(hours(game.hoursTenths))}
            </TableCell>
            <TableCell className="tabular text-right">{game.firstPlayedYear ?? '—'}</TableCell>
            <TableCell className="tabular text-right">
              {game.achievementsUnlocked === null
                ? '—'
                : `${game.achievementsUnlocked}${game.achievementsTotal === null ? '' : ` / ${game.achievementsTotal}`}`}
            </TableCell>
            <TableCell>
              <RatingStars rating={game.rating} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 6: Implement `src/features/games/library/library-view.tsx`**

```tsx
'use client';

import { LayoutGrid, Plus, Rows3 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import { GAME_STATUSES, STATUS_LABELS } from '@/server/db/games/games';
import type { GameStatus } from '@/server/games/stats';
import { GameDialog } from './game-dialog';
import { GameGrid } from './game-grid';
import { GameTable } from './game-table';

type ViewMode = 'gallery' | 'table';
type StatusFilter = GameStatus | 'all';

/**
 * The library screen. Owns view mode, status filter, and search — all client
 * state, because every one of them is a pure re-render of data already loaded,
 * and round-tripping to the server to hide a card would be latency for nothing.
 */
export function LibraryView({ games }: { readonly games: readonly Game[] }): React.ReactElement {
  const [view, setView] = useState<ViewMode>('gallery');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Game | null>(null);
  const [creating, setCreating] = useState(false);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return games.filter((game) => {
      if (status !== 'all' && game.status !== status) return false;
      if (needle === '') return true;
      return (
        game.title.toLowerCase().includes(needle) ||
        (game.developer ?? '').toLowerCase().includes(needle) ||
        (game.publisher ?? '').toLowerCase().includes(needle)
      );
    });
  }, [games, status, search]);

  const counts = useMemo(() => {
    const byStatus = new Map<GameStatus, number>();
    for (const game of games) byStatus.set(game.status, (byStatus.get(game.status) ?? 0) + 1);
    return byStatus;
  }, [games]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Library</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {visible.length === games.length
              ? `${games.length} game${games.length === 1 ? '' : 's'}`
              : `${visible.length} of ${games.length} games`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-md border p-0.5">
            <Button
              variant={view === 'gallery' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7"
              aria-label="Gallery view"
              aria-pressed={view === 'gallery'}
              onClick={() => setView('gallery')}
            >
              <LayoutGrid className="size-4" />
            </Button>
            <Button
              variant={view === 'table' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7"
              aria-label="Table view"
              aria-pressed={view === 'table'}
              onClick={() => setView('table')}
            >
              <Rows3 className="size-4" />
            </Button>
          </div>

          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            Add game
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label="Search games"
          placeholder="Search title, developer, publisher…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-8 max-w-64"
        />

        <div className="flex flex-wrap gap-1">
          <FilterChip label="All" count={games.length} active={status === 'all'} onClick={() => setStatus('all')} />
          {GAME_STATUSES.map((value) => (
            <FilterChip
              key={value}
              label={STATUS_LABELS[value]}
              count={counts.get(value) ?? 0}
              active={status === value}
              onClick={() => setStatus(value)}
            />
          ))}
        </div>
      </div>

      {games.length === 0 ? (
        <p className="text-muted-foreground py-16 text-center text-sm">
          No games yet. Add your first one to start the library.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground py-16 text-center text-sm">
          No games match this filter.
        </p>
      ) : view === 'gallery' ? (
        <GameGrid games={visible} onOpen={setEditing} />
      ) : (
        <GameTable games={visible} onOpen={setEditing} />
      )}

      <GameDialog
        key={editing?.id ?? (creating ? 'create' : 'closed')}
        game={editing}
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      />
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
  readonly onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active ? 'bg-foreground text-background border-transparent' : 'text-muted-foreground hover:bg-muted',
      )}
    >
      {label}
      <span className="ml-1.5 opacity-60">{count}</span>
    </button>
  );
}
```

- [ ] **Step 7: Implement `src/features/games/library/game-dialog.tsx`**

The add/edit form. It wires `searchGameMetadataAction` to a title lookup that fills cover/genre/developer/publisher, and posts to `createGameAction`/`updateGameAction`.

```tsx
'use client';

import Image from 'next/image';
import { Search, Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import type { Game } from '@/server/db/games/games';
import {
  GAME_OWNERSHIPS,
  GAME_PLATFORMS,
  GAME_STATUSES,
  PLATFORM_LABELS,
  STATUS_LABELS,
} from '@/server/db/games/games';
import type { GameSuggestion } from '@/server/games/metadata';
import { createGameAction, deleteGameAction, updateGameAction } from '../game-actions';
import { searchGameMetadataAction } from '../metadata-actions';

/**
 * Add or edit one game.
 *
 * Metadata lookup is opt-in per game via the Search button rather than firing
 * on every keystroke: it is a third-party network call, the owner often knows
 * the exact title already, and an unprompted autocomplete that silently
 * overwrites a hand-typed developer field is worse than a button.
 */
export function GameDialog({
  game,
  open,
  onOpenChange,
}: {
  readonly game: Game | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [platform, setPlatform] = useState(game?.platform ?? 'ps5');
  const [status, setStatus] = useState(game?.status ?? 'backlog');
  const [ownership, setOwnership] = useState(game?.ownership ?? '');
  const [coverUrl, setCoverUrl] = useState(game?.coverUrl ?? '');
  const [genre, setGenre] = useState(game?.genre ?? '');
  const [developer, setDeveloper] = useState(game?.developer ?? '');
  const [publisher, setPublisher] = useState(game?.publisher ?? '');
  const [title, setTitle] = useState(game?.title ?? '');
  const [suggestions, setSuggestions] = useState<readonly GameSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pending, startTransition] = useTransition();
  const [searching, startSearch] = useTransition();

  function lookUp(): void {
    startSearch(async () => {
      const results = await searchGameMetadataAction(title);
      setSuggestions(results);
      if (results.length === 0) toast.error('No matches found — fill the details in by hand.');
    });
  }

  function applySuggestion(suggestion: GameSuggestion): void {
    setTitle(suggestion.title);
    if (suggestion.coverUrl !== null) setCoverUrl(suggestion.coverUrl);
    if (suggestion.genre !== null) setGenre(suggestion.genre);
    if (suggestion.developer !== null) setDeveloper(suggestion.developer);
    if (suggestion.publisher !== null) setPublisher(suggestion.publisher);
    setSuggestions([]);
  }

  function submit(formData: FormData): void {
    formData.set('platform', platform);
    formData.set('status', status);
    formData.set('ownership', ownership);
    formData.set('coverUrl', coverUrl);

    startTransition(async () => {
      const result = game === null
        ? await createGameAction(formData)
        : await updateGameAction(game.id, formData);

      if (result.ok) {
        toast.success(game === null ? 'Game added' : 'Game updated');
        onOpenChange(false);
        return;
      }
      setError(result.error);
    });
  }

  function remove(): void {
    if (game === null) return;
    startTransition(async () => {
      const result = await deleteGameAction(game.id);
      if (result.ok) {
        toast.success(`${game.title} removed`);
        onOpenChange(false);
        return;
      }
      toast.error(result.error);
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* `sm:max-w-2xl`, not the unprefixed form: DialogContent's own base class
            is `sm:max-w-lg`, and Tailwind emits responsive variants AFTER their
            unprefixed counterparts regardless of className order, so an
            unprefixed override silently loses at any viewport >=640px. */}
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{game === null ? 'Add game' : game.title}</DialogTitle>
          </DialogHeader>

          <form action={submit} className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <div className="flex gap-2">
                <Input
                  id="title"
                  name="title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  autoFocus
                />
                <Button type="button" variant="outline" onClick={lookUp} disabled={searching || title.trim().length < 2}>
                  <Search className="size-4" />
                  {searching ? 'Searching…' : 'Find art'}
                </Button>
              </div>
              {error === null ? null : (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              )}
            </div>

            {suggestions.length === 0 ? null : (
              <ul className="grid grid-cols-3 gap-2 rounded-md border p-2 sm:grid-cols-6">
                {suggestions.map((suggestion) => (
                  <li key={suggestion.externalId}>
                    <button
                      type="button"
                      onClick={() => applySuggestion(suggestion)}
                      className="hover:ring-ring block w-full overflow-hidden rounded text-left hover:ring-2"
                    >
                      <span className="bg-muted relative block aspect-[3/4] w-full">
                        {suggestion.coverUrl === null ? null : (
                          <Image src={suggestion.coverUrl} alt="" fill sizes="120px" className="object-cover" />
                        )}
                      </span>
                      <span className="line-clamp-2 p-1 text-xs">{suggestion.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <FieldSelect
                id="platform"
                label="Platform"
                value={platform}
                onChange={(value) => setPlatform(value as typeof platform)}
                options={GAME_PLATFORMS.map((value) => ({ value, label: PLATFORM_LABELS[value] }))}
              />
              <FieldSelect
                id="status"
                label="Status"
                value={status}
                onChange={(value) => setStatus(value as typeof status)}
                options={GAME_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }))}
              />
              <Field id="hours" label="Hours played" defaultValue={game?.hoursTenths === null || game === null ? '' : String(game.hoursTenths / 10)} placeholder="23.5" />
              <Field id="firstPlayedYear" label="First played (year)" defaultValue={game?.firstPlayedYear ?? ''} placeholder="2026" />
              <Field id="rating" label="Rating (1-5)" defaultValue={game?.rating ?? ''} placeholder="4" />
              <FieldSelect
                id="ownership"
                label="Ownership"
                value={ownership}
                onChange={setOwnership}
                options={[{ value: '', label: 'Not set' }, ...GAME_OWNERSHIPS.map((value) => ({ value, label: value === 'physical' ? 'Physical' : 'Digital' }))]}
              />
              <Field id="achievementsUnlocked" label="Achievements earned" defaultValue={game?.achievementsUnlocked ?? ''} placeholder="42" />
              <Field id="achievementsTotal" label="Achievements total" defaultValue={game?.achievementsTotal ?? ''} placeholder="54" />
              <Field id="priceDollars" label="Price paid" defaultValue={game?.priceCents == null ? '' : (game.priceCents / 100).toFixed(2)} placeholder="59.99" />
              <Field id="genre" label="Genre" value={genre} onChange={setGenre} placeholder="Action RPG" />
              <Field id="developer" label="Developer" value={developer} onChange={setDeveloper} />
              <Field id="publisher" label="Publisher" value={publisher} onChange={setPublisher} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Input id="notes" name="notes" defaultValue={game?.notes ?? ''} placeholder="e.g. 6 hrs of that was the DLC in 2026" />
            </div>

            <DialogFooter className="justify-between sm:justify-between">
              {game === null ? (
                <span />
              ) : (
                <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(true)} disabled={pending}>
                  <Trash2 className="size-4" />
                  Remove
                </Button>
              )}
              <Button type="submit" disabled={pending}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Remove "${game?.title}"?`}
        description="This deletes the entry and its history from your library. This can't be undone."
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
      />
    </>
  );
}

function Field({
  id,
  label,
  defaultValue,
  value,
  onChange,
  placeholder,
}: {
  readonly id: string;
  readonly label: string;
  readonly defaultValue?: string | number;
  readonly value?: string;
  readonly onChange?: (value: string) => void;
  readonly placeholder?: string;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        {...(value === undefined ? { defaultValue } : { value, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange?.(e.target.value) })}
        {...(placeholder === undefined ? {} : { placeholder })}
      />
    </div>
  );
}

function FieldSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: ReadonlyArray<{ value: string; label: string }>;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <Label htmlFor={`${id}-trigger`}>{label}</Label>
      {/* Radix Select does not post a native form value — the parent form sets it on FormData before submit. */}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={`${id}-trigger`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
```

- [ ] **Step 8: Wire the real page**

Replace `src/app/(private)/games/(tabs)/library/page.tsx`:

```tsx
import type { Metadata } from 'next';

import { LibraryView } from '@/features/games/library/library-view';
import { requireOwner } from '@/server/auth/owner';
import { listGames } from '@/server/db/games/games';

export const metadata: Metadata = { title: 'Games — Burmy' };

export default async function GamesLibraryPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const games = await listGames(owner.userId);

  return <LibraryView games={games} />;
}
```

- [ ] **Step 9: Configure the image host**

RAWG serves cover art from `media.rawg.io`. Add to `next.config.ts`'s `images.remotePatterns`:

```ts
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'media.rawg.io' }],
  },
```

If `images` already exists in the config, add the pattern to the existing array rather than replacing the block.

- [ ] **Step 10: Run the component tests**

```bash
pnpm test --project components -- games-library-view
```

Expected: PASS, 6 tests.

- [ ] **Step 11: Run the full gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
git add src/components/games src/features/games/library "src/app/(private)/games" next.config.ts tests/unit/games-library-view.test.tsx
git commit -m "feat(games): library gallery, table view, and game editor"
```

---

### Task 8: Stats dashboard

**Files:**
- Create: `src/features/games/dashboard/chart-utils.ts`
- Create: `src/features/games/dashboard/charts/hours-per-year-chart.tsx`
- Create: `src/features/games/dashboard/charts/games-per-year-chart.tsx`
- Create: `src/features/games/dashboard/charts/distribution-chart.tsx`
- Create: `src/features/games/dashboard/charts/rating-distribution-chart.tsx`
- Create: `src/features/games/dashboard/yearly-breakdown-table.tsx`
- Create: `src/features/games/dashboard/games-dashboard.tsx`
- Modify: `src/app/(private)/games/(tabs)/stats/page.tsx`
- Test: `tests/unit/games-chart-utils.test.ts`

**Interfaces:**
- Consumes: `buildYearlyBreakdown`, `buildLibrarySummary`, `buildDistribution`, `findCallouts`, `GameStatRow` from `@/server/games/stats`; `formatHours`, `hours` from `@/server/games/hours`; `listGameStatRows` from `@/server/db/games/games`
- Produces: `<GamesDashboard rows={...} currentYear={...} />`

- [ ] **Step 1: Write the failing test for chart utils**

Create `tests/unit/games-chart-utils.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { categoryColor, computeChartDomain, formatAxisHours } from '@/features/games/dashboard/chart-utils';

describe('formatAxisHours', () => {
  it('renders whole hours compactly', () => {
    expect(formatAxisHours(5320)).toBe('532h');
  });

  it('renders zero as 0h rather than an empty label', () => {
    expect(formatAxisHours(0)).toBe('0h');
  });
});

describe('categoryColor', () => {
  it('cycles through the palette rather than running out', () => {
    expect(categoryColor(0)).toBe(categoryColor(16));
    expect(categoryColor(0)).not.toBe(categoryColor(1));
  });
});

describe('computeChartDomain', () => {
  it('always folds zero into the domain so bars share a baseline', () => {
    expect(computeChartDomain([500, 900])).toEqual([0, 900]);
  });

  it('pads a degenerate single-value domain instead of repeating one tick', () => {
    const [min, max] = computeChartDomain([100, 100]);
    expect(max).toBeGreaterThan(min);
  });

  it('handles an empty series without producing NaN', () => {
    const [min, max] = computeChartDomain([]);
    expect(Number.isFinite(min)).toBe(true);
    expect(Number.isFinite(max)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm test --project domain -- games-chart-utils
```

Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement `src/features/games/dashboard/chart-utils.ts`**

A Games-owned copy rather than an import from Finance's version — the two modules must not depend on each other, and the axis formatter is hours here, dollars there. The `--color-chart-cat-*` CSS tokens are generic and shared.

```ts
import { formatHours, hours } from '@/server/games/hours';

/** Cycles the 16-color palette defined in `globals.css`. Shared tokens, module-local helper. */
const CHART_COLORS = [
  'var(--color-chart-cat-1)', 'var(--color-chart-cat-2)', 'var(--color-chart-cat-3)',
  'var(--color-chart-cat-4)', 'var(--color-chart-cat-5)', 'var(--color-chart-cat-6)',
  'var(--color-chart-cat-7)', 'var(--color-chart-cat-8)', 'var(--color-chart-cat-9)',
  'var(--color-chart-cat-10)', 'var(--color-chart-cat-11)', 'var(--color-chart-cat-12)',
  'var(--color-chart-cat-13)', 'var(--color-chart-cat-14)', 'var(--color-chart-cat-15)',
  'var(--color-chart-cat-16)',
] as const;

export function categoryColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length]!;
}

/** Axis + tooltip label for a tenths-of-an-hour value. */
export function formatAxisHours(tenths: number): string {
  return formatHours(hours(Math.round(tenths)));
}

/**
 * A domain that always includes zero and never degenerates to a single value.
 * Recharts prints the same tick label five times when `dataMin === dataMax`.
 */
export function computeChartDomain(values: readonly number[]): [number, number] {
  if (values.length === 0) return [0, 10];

  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  if (max === min) return [min, min + 10];
  return [min, max];
}

/** The shared tooltip styling every Games chart uses. */
export const TOOLTIP_STYLES = {
  contentStyle: {
    background: 'var(--color-popover)',
    color: 'var(--color-popover-foreground)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    fontSize: 13,
  },
  // Recharts colors each item's text with the series fill, which is not
  // guaranteed readable against the popover background — force the theme
  // foreground. Same fix carried across every chart in this app.
  itemStyle: { color: 'var(--color-popover-foreground)' },
  labelStyle: { color: 'var(--color-popover-foreground)' },
} as const;
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
pnpm test --project domain -- games-chart-utils
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Implement the four chart components**

`src/features/games/dashboard/charts/hours-per-year-chart.tsx`:

```tsx
'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type { YearlyBreakdownRow } from '@/server/games/stats';
import { TOOLTIP_STYLES, computeChartDomain, formatAxisHours } from '../chart-utils';

export function HoursPerYearChart({
  rows,
}: {
  readonly rows: readonly YearlyBreakdownRow[];
}): React.ReactElement {
  if (rows.length === 0) {
    return <p className="text-muted-foreground py-12 text-center text-sm">No years with play time yet.</p>;
  }

  // Oldest-first reads correctly on a time axis, even though the table below
  // is newest-first (a table is scanned, an axis is read left to right).
  const data = [...rows].sort((a, b) => a.year - b.year);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="year" tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }} tickLine={false} axisLine={false} />
        <YAxis
          tickFormatter={formatAxisHours}
          domain={computeChartDomain(data.map((row) => row.hoursTenths))}
          tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <Tooltip formatter={(value) => [formatAxisHours(Number(value)), 'Played']} {...TOOLTIP_STYLES} />
        <Bar dataKey="hoursTenths" fill="var(--color-chart-cat-1)" radius={[3, 3, 0, 0]} maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  );
}
```

`src/features/games/dashboard/charts/games-per-year-chart.tsx` — identical structure, `dataKey="gameCount"`, `fill="var(--color-chart-cat-2)"`, tooltip formatter `(value) => [String(value), 'Games']`, and no `tickFormatter` on the Y axis.

`src/features/games/dashboard/charts/distribution-chart.tsx` (reused for platform, ownership, and genre):

```tsx
'use client';

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type { DistributionSlice } from '@/server/games/stats';
import { TOOLTIP_STYLES, categoryColor } from '../chart-utils';

/**
 * Horizontal bars, not a donut — a donut degrades badly past ~6 slices, and
 * genre counts routinely exceed that.
 */
export function DistributionChart({
  slices,
  emptyMessage,
}: {
  readonly slices: readonly DistributionSlice[];
  readonly emptyMessage: string;
}): React.ReactElement {
  if (slices.length === 0) {
    return <p className="text-muted-foreground py-12 text-center text-sm">{emptyMessage}</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(120, slices.length * 32 + 20)}>
      <BarChart data={[...slices]} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 4 }} barCategoryGap={8}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={110}
          tick={{ fontSize: 12, fill: 'var(--color-foreground)' }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          formatter={(value, _name, item) => {
            const percent = (item?.payload as DistributionSlice | undefined)?.percent ?? 0;
            return [`${value} (${percent.toFixed(0)}%)`, 'Games'];
          }}
          {...TOOLTIP_STYLES}
        />
        <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={22}>
          {slices.map((slice, index) => (
            <Cell key={slice.key} fill={categoryColor(index)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
```

`src/features/games/dashboard/charts/rating-distribution-chart.tsx` — a `BarChart` over five fixed buckets (`1★`–`5★`), `dataKey="count"`, `fill="var(--color-chart-cat-4)"`, built from `buildDistribution(rows, (g) => g.rating === null ? null : String(g.rating), (k) => `${k}★`)` then sorted ascending by key so the axis reads 1→5 rather than by frequency.

- [ ] **Step 6: Implement `src/features/games/dashboard/yearly-breakdown-table.tsx`**

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatHours, hours } from '@/server/games/hours';
import type { YearlyBreakdownRow } from '@/server/games/stats';

/**
 * The direct replacement for the spreadsheet's hand-maintained Year →
 * Games/Hours/Trophies table. Computed from the library on every render, so it
 * cannot drift the way the original did.
 */
export function YearlyBreakdownTable({
  rows,
  currentYear,
}: {
  readonly rows: readonly YearlyBreakdownRow[];
  readonly currentYear: number;
}): React.ReactElement {
  if (rows.length === 0) {
    return <p className="text-muted-foreground py-8 text-center text-sm">No years to compare yet.</p>;
  }

  const totals = rows.reduce(
    (sum, row) => ({
      gameCount: sum.gameCount + row.gameCount,
      hoursTenths: sum.hoursTenths + row.hoursTenths,
      achievements: sum.achievements + row.achievements,
    }),
    { gameCount: 0, hoursTenths: 0, achievements: 0 },
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Year</TableHead>
          <TableHead className="text-right">Games</TableHead>
          <TableHead className="text-right">Hours</TableHead>
          <TableHead className="text-right">vs. prev</TableHead>
          <TableHead className="text-right">Achievements</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.year}>
            <TableCell className={cn('font-medium', row.year === currentYear && 'text-foreground')}>
              {row.year}
              {row.year === currentYear ? <span className="text-muted-foreground ml-2 text-xs">in progress</span> : null}
            </TableCell>
            <TableCell className="tabular text-right">{row.gameCount}</TableCell>
            <TableCell className="tabular text-right">{formatHours(hours(row.hoursTenths))}</TableCell>
            <TableCell
              className={cn(
                'tabular text-right text-xs',
                row.hoursChangeTenths === null
                  ? 'text-muted-foreground'
                  : row.hoursChangeTenths >= 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-destructive',
              )}
            >
              {row.hoursChangeTenths === null
                ? '—'
                : `${row.hoursChangeTenths >= 0 ? '+' : '−'}${formatHours(hours(Math.abs(row.hoursChangeTenths)))}`}
            </TableCell>
            <TableCell className="tabular text-right">{row.achievements}</TableCell>
          </TableRow>
        ))}
        <TableRow className="bg-muted/40 border-t-2 font-semibold">
          <TableCell>Total</TableCell>
          <TableCell className="tabular text-right">{totals.gameCount}</TableCell>
          <TableCell className="tabular text-right">{formatHours(hours(totals.hoursTenths))}</TableCell>
          <TableCell />
          <TableCell className="tabular text-right">{totals.achievements}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 7: Implement `src/features/games/dashboard/games-dashboard.tsx`**

Assembles stat cards, the yearly table, the charts, and the callouts. It is a Server Component — it computes from `rows` and renders; only the charts inside it are client components.

```tsx
import { formatHours, hours } from '@/server/games/hours';
import {
  type GameStatRow,
  buildDistribution,
  buildLibrarySummary,
  buildYearlyBreakdown,
  findCallouts,
} from '@/server/games/stats';
import { PLATFORM_LABELS } from '@/server/db/games/games';
import type { GamePlatform } from '@/server/games/stats';
import { DistributionChart } from './charts/distribution-chart';
import { GamesPerYearChart } from './charts/games-per-year-chart';
import { HoursPerYearChart } from './charts/hours-per-year-chart';
import { RatingDistributionChart } from './charts/rating-distribution-chart';
import { YearlyBreakdownTable } from './yearly-breakdown-table';

export function GamesDashboard({
  rows,
  currentYear,
}: {
  readonly rows: readonly GameStatRow[];
  readonly currentYear: number;
}): React.ReactElement {
  const summary = buildLibrarySummary(rows);
  const yearly = buildYearlyBreakdown(rows, currentYear);
  const callouts = findCallouts(rows);

  const platforms = buildDistribution(rows, (row) => row.platform, (key) => PLATFORM_LABELS[key as GamePlatform]);
  const ownership = buildDistribution(rows, (row) => row.ownership, (key) => (key === 'physical' ? 'Physical' : 'Digital'));
  const genres = buildDistribution(rows, (row) => row.genre, (key) => key);

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Games" value={String(summary.totalGames)} />
        <StatCard label="Hours played" value={formatHours(hours(summary.totalHoursTenths))} />
        <StatCard
          label="Average rating"
          value={summary.averageRating === null ? '—' : `${summary.averageRating.toFixed(1)} / 5`}
        />
        <StatCard label="Backlog" value={String(summary.backlogCount)} hint={`${summary.playingCount} in progress`} />
        <StatCard
          label="Completion rate"
          value={summary.completionRatePercent === null ? '—' : `${summary.completionRatePercent.toFixed(0)}%`}
          hint="of games started"
        />
      </div>

      <Section title="Year by year" description="Every number here is computed from your library, not stored.">
        <YearlyBreakdownTable rows={yearly} currentYear={currentYear} />
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Hours per year">
          <HoursPerYearChart rows={yearly} />
        </Section>
        <Section title="Games per year">
          <GamesPerYearChart rows={yearly} />
        </Section>
        <Section title="Platforms">
          <DistributionChart slices={platforms} emptyMessage="No platforms recorded yet." />
        </Section>
        <Section title="Physical vs digital">
          <DistributionChart slices={ownership} emptyMessage="No ownership recorded yet." />
        </Section>
        <Section title="Genres">
          <DistributionChart slices={genres} emptyMessage="No genres yet — add cover art to fill these in." />
        </Section>
        <Section title="Ratings">
          <RatingDistributionChart rows={rows} />
        </Section>
      </div>

      <Section title="Highlights">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            label="Longest game"
            value={callouts.longestGame?.title ?? '—'}
            hint={callouts.longestGame === null ? undefined : formatHours(hours(callouts.longestGame.hoursTenths))}
          />
          <StatCard
            label="Most-played developer"
            value={callouts.topDeveloper?.name ?? '—'}
            hint={callouts.topDeveloper === null ? undefined : formatHours(hours(callouts.topDeveloper.hoursTenths))}
          />
          <StatCard
            label="Best year"
            value={callouts.bestYear === null ? '—' : String(callouts.bestYear.year)}
            hint={callouts.bestYear === null ? undefined : formatHours(hours(callouts.bestYear.hoursTenths))}
          />
        </div>
      </Section>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}): React.ReactElement {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
      <p className="mt-2 truncate text-2xl font-semibold" title={value}>
        {value}
      </p>
      {hint === undefined ? null : <p className="text-muted-foreground mt-1 text-xs">{hint}</p>}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {description === undefined ? null : (
        <p className="text-muted-foreground mt-1 mb-3 text-xs">{description}</p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}
```

- [ ] **Step 8: Wire the stats page**

Replace `src/app/(private)/games/(tabs)/stats/page.tsx`:

```tsx
import type { Metadata } from 'next';

import { GamesDashboard } from '@/features/games/dashboard/games-dashboard';
import { requireOwner } from '@/server/auth/owner';
import { listGameStatRows } from '@/server/db/games/games';

export const metadata: Metadata = { title: 'Game stats — Burmy' };

export default async function GamesStatsPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const rows = await listGameStatRows(owner.userId);

  // The clock is read HERE and passed down, so every pure function below stays
  // reproducible and testable without mocking time.
  const currentYear = new Date().getUTCFullYear();

  return <GamesDashboard rows={rows} currentYear={currentYear} />;
}
```

- [ ] **Step 9: Run the gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
git add src/features/games/dashboard "src/app/(private)/games" tests/unit/games-chart-utils.test.ts
git commit -m "feat(games): stats dashboard with yearly breakdown and charts"
```

---

### Task 9: Historical import from the Google Sheet

**Files:**
- Create: `scripts/import-game-log.mjs` (one-off, run manually, NOT committed as a product feature)
- Modify: `.gitignore` (ensure the exported sheet file cannot be committed)

**Interfaces:**
- Consumes: the `games` table directly via `postgres` (same approach as `scripts/migrate.mjs` — plain ESM, no build step)
- Produces: ~100 rows in `games` for the owner

**Context for the implementer:** The source is the owner's "Game log" Google Sheet, ~100 rows, columns `Title, Publisher, Developer, Ownership, Price, Hours, First Played, Trophies, Rating`. Known data shapes that MUST be handled:
- `Hours` can be `"53 + 6"` — sum the parts into one total.
- `First Played` can be `"2024 + 2025"` — take the FIRST year (when it was started).
- Rows where every field but Title and Rating is `"-"` — pre-2015 retro entries. Import them with nulls, not zeros.
- Sub-rows for collections (e.g. `Uncharted 2: Among Thieves Remastered` carries only a year) — these are separate games sharing one purchase. Import each as its own row with its own year, `price_cents` null.
- Titles contain non-ASCII (`Ghost of Yōtei`, `Drake’s Fortune`) — the script must be UTF-8 clean end to end.

- [ ] **Step 1: Export the sheet and place it locally**

The owner exports "Game log" from Google Sheets as CSV to a path outside the repo, or to the repo root where `.gitignore` already excludes `*.csv` and `*.xlsx`. Verify before proceeding:

```bash
git check-ignore -v "Game log.csv"
```

Expected: a `.gitignore` line matches. If it does not, STOP and add one — this file must never be committed (CLAUDE.md invariant 8).

- [ ] **Step 2: Write `scripts/import-game-log.mjs`**

Plain ESM, like `scripts/migrate.mjs` — no TypeScript, no build step, production dependencies only.

```js
/**
 * One-off import of the owner's historical "Game log" spreadsheet.
 *
 * Run manually, once. Not wired into any product flow, not a feature. Reads a
 * CSV the owner exported by hand and writes `games` rows.
 *
 * Safety: refuses to run against anything but a local database, and refuses to
 * run if the games table already has rows (re-running would duplicate the
 * library, and the unique index would half-fail partway through).
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import postgres from 'postgres';

const [, , csvPath, ownerEmail] = process.argv;

if (!csvPath || !ownerEmail) {
  console.error('Usage: node scripts/import-game-log.mjs <path-to-csv> <owner-email>');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const host = new URL(databaseUrl.replace(/^postgres(ql)?:\/\//, 'http://')).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`Refusing to run against non-local host "${host}". Import locally, then migrate the data deliberately.`);
  process.exit(1);
}

const PLATFORM_BY_HINT = [
  [/psp|playstation portable/i, 'psp'],
  [/ps4|playstation 4/i, 'ps4'],
  [/steam|pc/i, 'steam'],
];

/** Split a CSV line honouring quoted fields — titles contain commas. */
function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i += 1; }
      else inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

/** "53 + 6" -> 590 tenths. "-" / "" -> null. */
function parseHoursTenths(raw) {
  if (!raw || raw === '-') return null;
  const parts = raw.split('+').map((part) => Number(part.trim())).filter((n) => Number.isFinite(n));
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((sum, n) => sum + n, 0) * 10);
}

/** "2024 + 2025" -> 2024 (when it was STARTED). "-" -> null. */
function parseFirstYear(raw) {
  if (!raw || raw === '-') return null;
  const first = Number(raw.split('+')[0].trim());
  return Number.isInteger(first) && first > 1970 && first < 2100 ? first : null;
}

function parseInteger(raw) {
  if (!raw || raw === '-') return null;
  const parts = raw.split('+').map((part) => Number(part.trim())).filter((n) => Number.isFinite(n));
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((sum, n) => sum + n, 0));
}

function parsePriceCents(raw) {
  if (!raw || raw === '-') return null;
  const parts = raw.replace(/\$/g, '').split('+').map((p) => Number(p.trim())).filter((n) => Number.isFinite(n));
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((sum, n) => sum + n, 0) * 100);
}

function guessPlatform(title, firstYear) {
  for (const [pattern, platform] of PLATFORM_BY_HINT) {
    if (pattern.test(title)) return platform;
  }
  // The retro block (no year recorded at all) is the PSP-era library.
  if (firstYear === null) return 'psp';
  if (firstYear <= 2020) return 'ps4';
  return 'ps5';
}

const sql = postgres(databaseUrl, { max: 1 });

try {
  const [owner] = await sql`select id from "user" where email = ${ownerEmail} limit 1`;
  if (!owner) {
    console.error(`No user row for ${ownerEmail}. Provision the owner first.`);
    process.exit(1);
  }

  const [{ count }] = await sql`select count(*)::int as count from games where owner_id = ${owner.id}`;
  if (count > 0) {
    console.error(`Refusing to import: ${count} games already exist. Clear them first if this is a re-run.`);
    process.exit(1);
  }

  const raw = await readFile(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = lines.findIndex((line) => /^\s*"?Title"?\s*,/i.test(line));
  if (header === -1) {
    console.error('Could not find the header row (expected a line starting with "Title,").');
    process.exit(1);
  }

  let imported = 0;
  let skipped = 0;

  for (const line of lines.slice(header + 1)) {
    const [title, publisher, developer, ownership, price, hoursText, yearText, trophies, rating] = splitCsvLine(line);
    if (!title || title === '-') { skipped += 1; continue; }

    const firstPlayedYear = parseFirstYear(yearText);
    const hoursTenths = parseHoursTenths(hoursText);
    const ratingValue = parseInteger(rating);

    await sql`
      insert into games (
        owner_id, title, platform, developer, publisher, ownership, price_cents,
        status, rating, hours_tenths, first_played_year, achievements_unlocked, notes
      ) values (
        ${owner.id}, ${title}, ${guessPlatform(title, firstPlayedYear)},
        ${developer && developer !== '-' ? developer : null},
        ${publisher && publisher !== '-' ? publisher : null},
        ${/^physical$/i.test(ownership) ? 'physical' : /^digital$/i.test(ownership) ? 'digital' : null},
        ${parsePriceCents(price)},
        ${hoursTenths === null ? 'backlog' : 'completed'},
        ${ratingValue !== null && ratingValue >= 1 && ratingValue <= 5 ? ratingValue : null},
        ${hoursTenths},
        ${firstPlayedYear},
        ${parseInteger(trophies)},
        ${hoursText && hoursText.includes('+') ? `Imported as "${hoursText}" across ${yearText}` : null}
      )
      on conflict do nothing
    `;
    imported += 1;
  }

  console.log(`Imported ${imported} games (${skipped} rows skipped).`);
} finally {
  await sql.end();
}
```

- [ ] **Step 3: Run the import against local**

```bash
node --env-file-if-exists=.env scripts/import-game-log.mjs "Game log.csv" <owner-email>
```

- [ ] **Step 4: Reconcile against the source**

The spreadsheet's own yearly rollup is the check. Compare the app's computed Yearly Breakdown against it:

```bash
docker compose -f compose.dev.yml exec -T postgres psql -U burmy -d burmy -c "
SELECT first_played_year AS year, count(*) AS games, sum(hours_tenths)/10.0 AS hours, sum(achievements_unlocked) AS achievements
FROM games WHERE first_played_year IS NOT NULL
GROUP BY first_played_year ORDER BY first_played_year;"
```

Expected: the counts and hours match the sheet's rollup within rounding. **The sheet's own rollup is known to have drifted** — two copies of it disagree in the source. Where they differ, the computed value from the rows is correct; note any discrepancy for the owner rather than "fixing" the data to match a stale total.

- [ ] **Step 5: Delete the CSV and confirm the tree is clean**

```bash
rm "Game log.csv"
git status --short
```

Expected: no CSV, no unexpected files. Real personal data must not linger in the working tree.

- [ ] **Step 6: Commit the script only**

```bash
git add scripts/import-game-log.mjs
git commit -m "chore(games): one-off historical game log import script"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md` (module scope, layout, gotchas)
- Create: `docs/GAMES.md`

- [ ] **Step 1: Correct the module-scope claim in `CLAUDE.md`**

Replace the paragraph that currently reads *"**Finance is the only product module.**..."* with:

```markdown
**Two product modules: Finance and Games.** "OS" is a metaphor for a personal workspace — this is
not an operating system and not a platform. Do not build Notes, Files, Sheets, Inbox, Bookmarks,
Garage, Receipts or Subscriptions. Do not build abstractions in anticipation of them, and do not
build a shared "module framework" for the two that exist — they deliberately share nothing but
generic UI primitives and the owner auth boundary.

`docs/FINANCE.md` is canonical for the Finance domain; `docs/GAMES.md` for Games.
```

- [ ] **Step 2: Add the Games paths to the Layout section of `CLAUDE.md`**

```
src/features/games/        Games UI
src/server/games/          GAMES DOMAIN CORE — pure TS, no React, no Next, no HTTP
src/server/db/games/       owner-scoped data access + the one HTTP boundary (rawg.ts)
```

And extend the framework-free note to cover both: `**`src/server/finance/` and `src/server/games/` must stay framework-free.**`

- [ ] **Step 3: Add the two Games gotchas worth recording**

Append to the "Gotchas that have already cost us" list:

```markdown
- **Games stores play time as TENTHS OF AN HOUR in an integer, never a float.** The source
  spreadsheet holds values like `0.7` and `532.8`; summing those as JS numbers reintroduces
  `0.1 + 0.2 !== 0.3` in a module whose headline stat is a lifetime hours total. All conversion
  happens in `src/server/games/hours.ts` and nothing else does hours math — the same containment
  rule `money.ts` has.
- **`RAWG_API_KEY` is optional and its absence is a normal state, not an error.** Cover-art lookup
  fails soft and returns `[]` on a missing key, a timeout, a non-200, or malformed JSON. The full
  test suite must pass with no key present, exactly like the AI-optional rule for Finance.
```

- [ ] **Step 4: Write `docs/GAMES.md`**

Cover: the data model and why hours are tenths; the four lifecycle statuses and why paused/dropped is one; why every aggregate is computed rather than stored (with the drifted-spreadsheet-rollup story as the motivating evidence); the RAWG choice and its soft-failure contract; and what is deliberately out of scope for v1 (per-achievement tracking, Finance linkage, session history, wishlist-vs-backlog).

- [ ] **Step 5: Final full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/GAMES.md
git commit -m "docs(games): document the Games module and update module scope"
```

---

## Self-Review Notes

Checked against the spec:

- **Data model** → Task 1 (all 18 columns, 3 enums, 4 indexes). One deliberate deviation: `hours_played numeric(6,1)` in the spec became `hours_tenths integer` in this plan, because a `numeric` returns as a *string* through the `pg` driver — the exact failure `CLAUDE.md` calls out for money — and float summation would drift on the `0.7`/`532.8` values the real data contains. The spec's intent (one hand-edited hours number, one decimal place) is preserved exactly.
- **Hours are one number, not a session log** → Task 1 schema comment, Task 2 `hours.ts`, Task 7 form field.
- **Achievements as a count** → Task 1 (`achievements_unlocked`/`achievements_total`), no child table anywhere.
- **Price independent of Finance** → Task 1 `price_cents`, Task 4 dollars→cents conversion, no import of any `finance_*` module in any Games file.
- **Cover art from a game database** → Task 5 (RAWG), Task 7 (per-game search-and-pick).
- **Card gallery default + table toggle** → Task 7.
- **Stat cards, charts, callouts, Yearly Breakdown** → Task 8, all six charts and three callouts from the spec.
- **Nav as a top-level item** → Task 6.
- **Historical import, sparse rows included** → Task 9.
- **`CLAUDE.md` updated rather than left contradicting the code** → Task 10.
- **Out-of-scope items** stay unbuilt: no per-achievement table, no Finance linkage, no session history, no wishlist/backlog split.

Type consistency verified across tasks: `GameStatRow`/`GamePlatform`/`GameOwnership`/`GameStatus` are defined once in `src/server/games/stats.ts` (Task 2) and imported by the DAL (Task 3), actions (Task 4), and UI (Tasks 7-8). `Hours` and `formatHours`/`hours()` are defined once in `src/server/games/hours.ts` (Task 2) and used by Tasks 7, 8. `GameSuggestion` is defined once in `src/server/games/metadata.ts` (Task 5) and consumed by Tasks 5 and 7.
