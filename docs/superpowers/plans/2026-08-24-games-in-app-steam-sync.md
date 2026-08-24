# In-App Steam Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the terminal-only Steam enrichment script with a Sync button in the app that stages every proposed change for review before writing anything.

**Architecture:** A sync run is a persisted row processed in small client-driven chunks, so no single request approaches a serverless timeout and progress is real. Each chunk matches a few library games against the owner's Steam library and stages proposed changes; nothing is written to `games` until the owner approves a staged run. Ownership of hours and achievement counts moves to Steam for linked games, which makes those fields read-only in the editor and is what finally answers "what came from Steam and what did I type?"

**Tech Stack:** Next.js 16.3 App Router (Server Actions), React 19, Drizzle 0.45, PostgreSQL 18, Vitest, Testcontainers.

**Spec:** `docs/superpowers/specs/2026-08-23-games-sync-and-play-years-design.md` (Part 2)

## Global Constraints

- **Sync NEVER deletes a game.** No sync path may issue `DELETE` against `games`, nor mark one inactive, hidden, or archived. A library row the API does not know about is skipped and left byte-identical. **40 PSP games and 12 unmatched Steam-platform games can never appear in any Steam response** — a "mirror the API" reading would destroy a quarter of the library. This is invariant 1 of the spec and must have a named integration test.
- **No sync writes without owner approval.** Every run stages its changes and commits only on an explicit approval action. There is no silent-apply path.
- **No low-confidence match is ever auto-applied.** `bestTitleMatchAmong` already enforces `SIMILARITY_FLOOR = 0.7` and returns `null` below it. Do not lower, bypass, or re-implement that floor.
- **`STEAM_API_KEY` and `STEAM_ID` are optional and their absence is a normal state.** The UI degrades to "not configured"; no request path throws. **The full test suite must pass with neither variable present.**
- **Hours are integer TENTHS of an hour, never floats.** All conversion goes through `src/server/games/hours.ts` and nothing else does hours math.
- **`games.hours_tenths` is the authoritative total; `game_play_years` rows only say which years it happened in.** A sync that changes the total makes an existing split stale — that is a reconciliation item for review, never a silent re-split.
- **`src/server/games/` must stay framework-free** — pure TypeScript, no React, no Next, no HTTP, no database imports. `steam.ts` and `metadata.ts` must additionally stay dependency-free LEAF modules, because `scripts/*.mjs` import them directly under bare `node`.
- **Every protected server entry point calls `await requireOwner()` itself.** A layout guard does not protect Server Actions.
- **`exactOptionalPropertyTypes` is on.** Never assign `undefined` to an optional property; omit the key. Past two or three optional fields, use a mutable local object with plain `if (cond) obj.key = value` — merged conditional spreads lose type precision in this codebase.
- **Drizzle index callbacks return an ARRAY:** `(t) => [ index(...), uniqueIndex(...) ]`.
- **Drizzle WRAPS driver errors** — the real SQLSTATE is on `error.cause`. Use `isUniqueViolation()` from `src/server/db/games/errors.ts`; `error.code === '23505'` silently never matches.
- **`updatedAt` is set manually in application code** — there is no DB trigger.
- Vitest projects split by extension: `.test.ts` → `domain` (node), `.test.tsx` → `components` (jsdom). Scope with `npx vitest run --project domain <name>`; `pnpm test --project X -- name` does NOT scope.
- Integration tests import application modules dynamically inside `beforeAll`, after `await harness()`.
- **Never run `pnpm test:e2e`** — it truncates the owner's real development database.
- Gate before any task is done: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration`.

---

### Task 1: Pure sync planning

**Files:**
- Create: `src/server/games/sync-plan.ts`
- Test: `tests/unit/games-sync-plan.test.ts`

**Interfaces:**
- Consumes: `OwnedSteamGame`, `AchievementCounts` (types) from `src/server/games/steam.ts`; `minutesToHoursTenths` from `src/server/games/hours.ts`.
- Produces:
  - `type SyncChangeKind = 'link' | 'field_update' | 'new_game' | 'reconcile'`
  - `interface StoredGameForSync { readonly id: string; readonly title: string; readonly steamAppid: number | null; readonly hoursTenths: number | null; readonly achievementsUnlocked: number | null; readonly achievementsTotal: number | null; readonly playYearTenths: number | null }`
  - `interface PlannedChange { readonly kind: SyncChangeKind; readonly gameId: string | null; readonly title: string; readonly payload: Record<string, unknown> }`
  - `function planLinkedGameChanges(stored: StoredGameForSync, appid: number, achievements: AchievementCounts | null, steamHoursTenths: number | null): PlannedChange[]`
  - `function planNewGameChange(owned: OwnedSteamGame): PlannedChange`

**Why a new module rather than extending `steam.ts`:** `steam.ts` must stay a dependency-free leaf so `scripts/sync-steam-library.mjs` can `node`-import it. This module imports from it, so it cannot live there. It also encodes a **different rule** from the script's: the script fills only NULL columns (`steamSyncFieldsToFill`), whereas the in-app sync makes Steam authoritative for linked games and proposes an update whenever Steam's value differs. Both rules are correct for their own caller — do not unify them, and do not change `steamSyncFieldsToFill`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/games-sync-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  type StoredGameForSync,
  planLinkedGameChanges,
  planNewGameChange,
} from '@/server/games/sync-plan';

function stored(overrides: Partial<StoredGameForSync> = {}): StoredGameForSync {
  return {
    id: 'g1',
    title: 'Hollow Knight',
    steamAppid: 367520,
    hoursTenths: 490,
    achievementsUnlocked: 30,
    achievementsTotal: 63,
    playYearTenths: null,
    ...overrides,
  };
}

describe('planLinkedGameChanges', () => {
  it('proposes nothing when Steam agrees with everything stored', () => {
    const changes = planLinkedGameChanges(stored(), 367520, { unlocked: 30, total: 63 }, 490);
    expect(changes).toEqual([]);
  });

  it('proposes a link when the game had no appid yet', () => {
    const changes = planLinkedGameChanges(
      stored({ steamAppid: null }),
      367520,
      { unlocked: 30, total: 63 },
      490,
    );
    const link = changes.find((c) => c.kind === 'link');
    expect(link).toBeDefined();
    expect(link?.payload).toMatchObject({ steamAppid: 367520 });
  });

  it('proposes a field update when Steam hours differ from stored', () => {
    const changes = planLinkedGameChanges(stored({ hoursTenths: 490 }), 367520, null, 510);
    const update = changes.find((c) => c.kind === 'field_update');
    expect(update?.payload).toMatchObject({ field: 'hoursTenths', from: 490, to: 510 });
  });

  it('proposes a field update when stored hours are null', () => {
    const changes = planLinkedGameChanges(stored({ hoursTenths: null }), 367520, null, 510);
    const update = changes.find((c) => c.kind === 'field_update');
    expect(update?.payload).toMatchObject({ field: 'hoursTenths', from: null, to: 510 });
  });

  it('proposes achievement updates for each count that differs', () => {
    const changes = planLinkedGameChanges(
      stored({ achievementsUnlocked: 30, achievementsTotal: 63 }),
      367520,
      { unlocked: 34, total: 63 },
      490,
    );
    const fields = changes.filter((c) => c.kind === 'field_update').map((c) => c.payload['field']);
    expect(fields).toEqual(['achievementsUnlocked']);
  });

  it('proposes NOTHING for a null achievements payload rather than writing zeros', () => {
    // A 400 from GetPlayerAchievements on an older title must never be read as
    // "this game has zero achievements" — that would wipe a real recorded count.
    const changes = planLinkedGameChanges(stored(), 367520, null, 490);
    expect(changes).toEqual([]);
  });

  it('proposes nothing for a null steam playtime rather than zeroing hours', () => {
    const changes = planLinkedGameChanges(stored(), 367520, { unlocked: 30, total: 63 }, null);
    expect(changes).toEqual([]);
  });

  it('raises a reconcile item when changing hours would strand an existing split', () => {
    // Stored total 490 with a split accounting for all 490. Steam says 510, so
    // the split now accounts for 20 tenths less than the total.
    const changes = planLinkedGameChanges(
      stored({ hoursTenths: 490, playYearTenths: 490 }),
      367520,
      null,
      510,
    );
    const reconcile = changes.find((c) => c.kind === 'reconcile');
    expect(reconcile?.payload).toMatchObject({ splitTenths: 490, newTotalTenths: 510, differenceTenths: 20 });
  });

  it('raises no reconcile item when the game has no split', () => {
    const changes = planLinkedGameChanges(
      stored({ hoursTenths: 490, playYearTenths: null }),
      367520,
      null,
      510,
    );
    expect(changes.some((c) => c.kind === 'reconcile')).toBe(false);
  });

  it('raises no reconcile item when hours are unchanged, even with a split present', () => {
    const changes = planLinkedGameChanges(
      stored({ hoursTenths: 490, playYearTenths: 490 }),
      367520,
      null,
      490,
    );
    expect(changes).toEqual([]);
  });

  it('carries the game id and title on every change it produces', () => {
    const changes = planLinkedGameChanges(
      stored({ id: 'g9', title: 'Hades', steamAppid: null, hoursTenths: 100 }),
      1145360,
      { unlocked: 14, total: 49 },
      280,
    );
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change.gameId).toBe('g9');
      expect(change.title).toBe('Hades');
    }
  });
});

describe('planNewGameChange', () => {
  it('describes a Steam-owned game that has no library row', () => {
    const change = planNewGameChange({ appid: 50, name: 'Half-Life: Opposing Force', playtimeMinutes: 438 });

    expect(change.kind).toBe('new_game');
    expect(change.gameId).toBeNull();
    expect(change.title).toBe('Half-Life: Opposing Force');
    expect(change.payload).toMatchObject({ steamAppid: 50, hoursTenths: 73, platform: 'steam' });
  });

  it('records zero hours for a never-played owned game rather than omitting them', () => {
    const change = planNewGameChange({ appid: 1449560, name: 'Metro Exodus Enhanced Edition', playtimeMinutes: 0 });
    expect(change.payload).toMatchObject({ hoursTenths: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project domain games-sync-plan`
Expected: FAIL — cannot resolve `@/server/games/sync-plan`.

- [ ] **Step 3: Write the implementation**

Create `src/server/games/sync-plan.ts`:

```ts
/**
 * What a Steam sync run PROPOSES to change — pure, and deliberately separate
 * from what it eventually writes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `steamSyncFieldsToFill`
 *
 * `src/server/games/steam.ts`'s `steamSyncFieldsToFill` fills only columns that
 * are currently NULL, because the CLI script's contract is "never overwrite what
 * the owner typed." The in-app sync has the opposite contract, chosen
 * deliberately: for a game linked to a Steam app, Steam OWNS hours and
 * achievement counts, the editor renders them read-only, and a divergence is
 * proposed as an update.
 *
 * Both rules are correct for their own caller. Do not unify them, and do not
 * change `steamSyncFieldsToFill` — the script still ships and still fills nulls.
 *
 * This module cannot live in `steam.ts` regardless: that file is a
 * dependency-free LEAF so `scripts/sync-steam-library.mjs` can import it
 * directly under bare `node`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { minutesToHoursTenths } from './hours';
import type { AchievementCounts, OwnedSteamGame } from './steam';

export type SyncChangeKind = 'link' | 'field_update' | 'new_game' | 'reconcile';

/** The narrow projection of a library row this module needs. */
export interface StoredGameForSync {
  readonly id: string;
  readonly title: string;
  readonly steamAppid: number | null;
  readonly hoursTenths: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  /**
   * Sum of this game's `game_play_years` rows, or `null` when it has none.
   * Only used to decide whether changing the total strands an existing split —
   * this module never edits a split, it only reports that one needs attention.
   */
  readonly playYearTenths: number | null;
}

export interface PlannedChange {
  readonly kind: SyncChangeKind;
  /** Null only for `new_game`, which by definition has no library row yet. */
  readonly gameId: string | null;
  readonly title: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Every change one already-matched library game would receive.
 *
 * `null` from Steam means "Steam did not tell us," never "the value is zero."
 * A 400 from `GetPlayerAchievements` on an older title, or a missing playtime
 * field, must never be written as 0 — that would erase a real recorded count.
 * Hence every proposal below is gated on a non-null Steam value.
 */
export function planLinkedGameChanges(
  stored: StoredGameForSync,
  appid: number,
  achievements: AchievementCounts | null,
  steamHoursTenths: number | null,
): PlannedChange[] {
  const changes: PlannedChange[] = [];
  const describe = (kind: SyncChangeKind, payload: Record<string, unknown>): PlannedChange => ({
    kind,
    gameId: stored.id,
    title: stored.title,
    payload,
  });

  if (stored.steamAppid === null) {
    changes.push(describe('link', { steamAppid: appid }));
  }

  if (steamHoursTenths !== null && steamHoursTenths !== stored.hoursTenths) {
    changes.push(
      describe('field_update', { field: 'hoursTenths', from: stored.hoursTenths, to: steamHoursTenths }),
    );

    // Changing the total leaves any existing per-year split accounting for the
    // OLD number. The owner rebalances; the sync never guesses which year the
    // difference belongs to.
    if (stored.playYearTenths !== null && stored.playYearTenths !== steamHoursTenths) {
      changes.push(
        describe('reconcile', {
          splitTenths: stored.playYearTenths,
          newTotalTenths: steamHoursTenths,
          differenceTenths: steamHoursTenths - stored.playYearTenths,
        }),
      );
    }
  }

  if (achievements !== null) {
    if (achievements.unlocked !== stored.achievementsUnlocked) {
      changes.push(
        describe('field_update', {
          field: 'achievementsUnlocked',
          from: stored.achievementsUnlocked,
          to: achievements.unlocked,
        }),
      );
    }
    if (achievements.total !== stored.achievementsTotal) {
      changes.push(
        describe('field_update', {
          field: 'achievementsTotal',
          from: stored.achievementsTotal,
          to: achievements.total,
        }),
      );
    }
  }

  return changes;
}

/**
 * A Steam-owned game with no library row at all.
 *
 * Staged, never inserted directly — like every other change it waits for the
 * owner's approval. Achievements are deliberately NOT fetched for these: the
 * game does not exist yet, and one API call per unknown Steam title would
 * multiply a run's cost for rows the owner may well decline.
 */
export function planNewGameChange(owned: OwnedSteamGame): PlannedChange {
  return {
    kind: 'new_game',
    gameId: null,
    title: owned.name,
    payload: {
      steamAppid: owned.appid,
      hoursTenths: minutesToHoursTenths(owned.playtimeMinutes),
      platform: 'steam',
    },
  };
}
```

**Before writing this, read `src/server/games/steam.ts`'s `OwnedSteamGame` interface and use its REAL field names.** The test above assumes `appid`, `name`, `playtimeMinutes`; if the actual interface differs, the interface is authoritative — fix the test, not the source.

- [ ] **Step 4: Run to verify the tests pass**

Run: `npx vitest run --project domain games-sync-plan`
Expected: PASS, 13 tests.

- [ ] **Step 5: Confirm the leaf boundary is intact**

Run: `grep -n "^import" src/server/games/steam.ts`
Expected: NO output. `steam.ts` must still have zero imports, or `scripts/sync-steam-library.mjs` breaks under bare `node`.

Then: `node --input-type=module -e "import('./src/server/games/steam.ts').then(() => console.log('leaf ok'))"` — if this errors, the leaf property is broken.

- [ ] **Step 6: Run the full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/server/games/sync-plan.ts tests/unit/games-sync-plan.test.ts
git commit -m "feat(games): pure Steam sync change planning"
```

---

### Task 2: Sync run schema and data access

**Files:**
- Modify: `src/server/db/schema.ts`
- Create: `drizzle/0008_*.sql` (generated)
- Create: `src/server/db/games/sync.ts`
- Test: `tests/integration/games-sync.test.ts`

**Interfaces:**
- Consumes: `PlannedChange`, `SyncChangeKind` (Task 1).
- Produces:
  - `interface SyncRun { readonly id: string; readonly source: 'steam' | 'psn'; readonly status: SyncRunStatus; readonly cursor: number; readonly total: number; readonly errorMessage: string | null }`
  - `type SyncRunStatus = 'running' | 'ready' | 'committed' | 'failed' | 'cancelled'`
  - `interface SyncChange extends PlannedChange { readonly id: string; readonly selected: boolean }`
  - `function createSyncRun(ownerId: string, source: 'steam', total: number, steamLibrary: unknown): Promise<SyncRun>`
  - `function getSyncRun(ownerId: string, runId: string): Promise<SyncRun | null>`
  - `function getSyncRunLibrary(ownerId: string, runId: string): Promise<unknown>`
  - `function appendSyncChanges(ownerId: string, runId: string, changes: readonly PlannedChange[], nextCursor: number): Promise<void>`
  - `function finishSyncRun(ownerId: string, runId: string, status: SyncRunStatus, errorMessage?: string): Promise<void>`
  - `function listSyncChanges(ownerId: string, runId: string): Promise<SyncChange[]>`
  - `function setSyncChangeSelected(ownerId: string, changeId: string, selected: boolean): Promise<void>`

- [ ] **Step 1: Add the enums and tables to the schema**

In `src/server/db/schema.ts`, after `gamePlayYears`, add:

```ts
export const gameSyncSourceEnum = pgEnum('game_sync_source', ['steam', 'psn']);
export const gameSyncRunStatusEnum = pgEnum('game_sync_run_status', [
  'running',
  'ready',
  'committed',
  'failed',
  'cancelled',
]);

/**
 * One Steam (later: PSN) sync run.
 *
 * Processed in small client-driven chunks rather than one long request, so no
 * single call approaches a serverless timeout and progress is real rather than
 * a spinner. `cursor` is how many library games have been processed; `total` is
 * how many there are. A run persists, so closing the tab mid-sync leaves a
 * resumable run rather than a lost one.
 */
export const gameSyncRuns = pgTable(
  'game_sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    source: gameSyncSourceEnum('source').notNull(),
    status: gameSyncRunStatusEnum('status').notNull().default('running'),
    cursor: integer('cursor').notNull().default(0),
    total: integer('total').notNull().default(0),
    /**
     * The owner's Steam library as fetched ONCE at the start of the run —
     * appid, name and playtime only. Held here so each chunk does not re-fetch
     * the whole list, and so a resumed run matches against exactly the same
     * snapshot it started with rather than a library that moved underneath it.
     * Transient run state, discarded with the run.
     */
    steamLibrary: jsonb('steam_library'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('game_sync_runs_owner_status_idx').on(t.ownerId, t.status)],
);

/**
 * One proposed change staged by a run. Nothing here has been written to
 * `games` — that happens only when the owner approves the run.
 *
 * `payload` carries both the proposed value and the value it would replace, so
 * the review screen shows a real before/after rather than just a target.
 */
export const gameSyncChanges = pgTable(
  'game_sync_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => gameSyncRuns.id, { onDelete: 'cascade' }),
    /** Null for `new_game` — that change has no library row yet, by definition. */
    gameId: uuid('game_id').references(() => games.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    selected: boolean('selected').notNull().default(true),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('game_sync_changes_run_idx').on(t.runId)],
);
```

`jsonb`, `boolean`, `integer`, `index`, `pgEnum`, `text`, `timestamp` and `uuid` are all already imported at the top of `schema.ts` — verified. No import changes should be needed; if your editor suggests otherwise, check before adding a duplicate.

- [ ] **Step 2: Generate and apply the migration**

```bash
pnpm db:generate
docker compose -f compose.dev.yml up -d postgres
pnpm db:migrate
```

**Read the generated `drizzle/0008_*.sql` before continuing.** Confirm: both enums created; `game_sync_runs` and `game_sync_changes` created; `game_sync_changes.run_id` and `owner_id` cascade; `game_id` cascades. If `pnpm db:migrate` fails with ECONNREFUSED, Docker Desktop is not running.

- [ ] **Step 3: Write the failing integration tests**

Create `tests/integration/games-sync.test.ts` following the exact harness pattern in `tests/integration/games-play-years.test.ts` (dynamic imports inside `beforeAll` after `await harness()`, `resetDatabase()` in `beforeEach`, a local `makeOwner` helper).

```ts
describe('sync run data access', () => {
  it('creates a run in the running state with a cursor of zero', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const run = await sync.createSyncRun(owner, 'steam', 47, [{ appid: 1, name: 'A', playtimeMinutes: 0 }]);

    expect(run).toMatchObject({ source: 'steam', status: 'running', cursor: 0, total: 47 });
  });

  it('round-trips the steam library snapshot', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const library = [{ appid: 367520, name: 'Hollow Knight', playtimeMinutes: 2940 }];
    const run = await sync.createSyncRun(owner, 'steam', 1, library);

    expect(await sync.getSyncRunLibrary(owner, run.id)).toEqual(library);
  });

  it('appends changes and advances the cursor together', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');
    const run = await sync.createSyncRun(owner, 'steam', 10, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [{ kind: 'link', gameId, title: 'Hollow Knight', payload: { steamAppid: 367520 } }],
      5,
    );

    expect((await sync.getSyncRun(owner, run.id))?.cursor).toBe(5);
    expect(await sync.listSyncChanges(owner, run.id)).toHaveLength(1);
  });

  it('stages a new_game change with a null gameId', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const run = await sync.createSyncRun(owner, 'steam', 1, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [{ kind: 'new_game', gameId: null, title: 'Forza Horizon 6', payload: { steamAppid: 2483190 } }],
      1,
    );

    const [change] = await sync.listSyncChanges(owner, run.id);
    expect(change).toMatchObject({ kind: 'new_game', gameId: null, selected: true });
  });

  it('never returns another owner run or its changes', async () => {
    const mine = await makeOwner('mine@example.invalid');
    const theirs = await makeOwner('theirs@example.invalid');
    const theirRun = await sync.createSyncRun(theirs, 'steam', 1, []);
    await sync.appendSyncChanges(theirs, theirRun.id, [
      { kind: 'new_game', gameId: null, title: 'Theirs', payload: {} },
    ], 1);

    expect(await sync.getSyncRun(mine, theirRun.id)).toBeNull();
    expect(await sync.listSyncChanges(mine, theirRun.id)).toEqual([]);
  });

  it('refuses to append to another owner run', async () => {
    const mine = await makeOwner('mine@example.invalid');
    const theirs = await makeOwner('theirs@example.invalid');
    const theirRun = await sync.createSyncRun(theirs, 'steam', 1, []);

    await sync.appendSyncChanges(mine, theirRun.id, [
      { kind: 'new_game', gameId: null, title: 'Injected', payload: {} },
    ], 1);

    expect(await sync.listSyncChanges(theirs, theirRun.id)).toEqual([]);
    expect((await sync.getSyncRun(theirs, theirRun.id))?.cursor).toBe(0);
  });

  it('refuses to toggle another owner change', async () => {
    const mine = await makeOwner('mine@example.invalid');
    const theirs = await makeOwner('theirs@example.invalid');
    const theirRun = await sync.createSyncRun(theirs, 'steam', 1, []);
    await sync.appendSyncChanges(theirs, theirRun.id, [
      { kind: 'new_game', gameId: null, title: 'Theirs', payload: {} },
    ], 1);
    const [change] = await sync.listSyncChanges(theirs, theirRun.id);

    await sync.setSyncChangeSelected(mine, change!.id, false);

    const [after] = await sync.listSyncChanges(theirs, theirRun.id);
    expect(after?.selected).toBe(true);
  });

  it('marks a run finished with an error message', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const run = await sync.createSyncRun(owner, 'steam', 1, []);

    await sync.finishSyncRun(owner, run.id, 'failed', 'Steam did not respond');

    const after = await sync.getSyncRun(owner, run.id);
    expect(after).toMatchObject({ status: 'failed', errorMessage: 'Steam did not respond' });
  });

  it('cascades its changes away when the run is deleted', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const run = await sync.createSyncRun(owner, 'steam', 1, []);
    await sync.appendSyncChanges(owner, run.id, [
      { kind: 'new_game', gameId: null, title: 'X', payload: {} },
    ], 1);

    const { sql } = await harness();
    await sql`delete from game_sync_runs where id = ${run.id}`;

    expect(await sync.listSyncChanges(owner, run.id)).toEqual([]);
  });
});
```

Add a `makeGame` helper identical to the one in `tests/integration/games-play-years.test.ts`.

- [ ] **Step 4: Run to verify failure**

Run: `pnpm test:integration -- games-sync`
Expected: FAIL — cannot resolve `@/server/db/games/sync`.

- [ ] **Step 5: Write the data access layer**

Create `src/server/db/games/sync.ts`. Every function takes `ownerId` first and scopes every query by it, matching `src/server/db/games/play-years.ts`. `appendSyncChanges` must do the insert and the cursor update in ONE transaction, with an ownership pre-check on the run inside that transaction (a run belonging to someone else is a silent no-op, never a write) — mirror the ownership pre-check pattern in `replacePlayYears`. `setSyncChangeSelected` filters on `ownerId` in its `WHERE`. Import `getDb` from `@/server/db` (NOT `@/server/db/client`, which does not exist).

- [ ] **Step 6: Run the tests, then prove the ownership checks are not vacuous**

Run: `pnpm test:integration -- games-sync`
Expected: PASS, 9 tests.

Then temporarily delete the ownership pre-check from `appendSyncChanges` and re-run. **The "refuses to append to another owner run" test must FAIL.** If it still passes, the assertion is vacuous — strengthen it (query the table without an owner filter and assert zero rows) before restoring the check. Report this result.

- [ ] **Step 7: Run the full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
git add src/server/db/schema.ts src/server/db/games/sync.ts drizzle/ tests/integration/games-sync.test.ts
git commit -m "feat(games): sync run and staged change tables"
```

---

### Task 3: The chunked sync engine

**Files:**
- Create: `src/features/games/sync/sync-actions.ts`
- Test: `tests/integration/games-sync-actions.test.ts`

**Interfaces:**
- Consumes: Task 1's `planLinkedGameChanges`/`planNewGameChange`; Task 2's data access; `fetchOwnedGames`/`fetchAchievementCounts` from `src/server/db/games/steam-client.ts`; `bestTitleMatchAmong` from `src/server/games/metadata.ts`; `minutesToHoursTenths` from `src/server/games/hours.ts`.
- Produces:
  - `interface SyncProgress { readonly runId: string; readonly cursor: number; readonly total: number; readonly done: boolean; readonly changeCount: number }`
  - `async function startSteamSyncAction(): Promise<ActionResult & { readonly runId?: string }>`
  - `async function advanceSteamSyncAction(runId: string): Promise<SyncProgress | { readonly error: string }>`
  - `async function isSteamConfiguredAction(): Promise<boolean>`

**Chunk size:** process **5** library games per `advanceSteamSyncAction` call. Each matched game costs one `fetchAchievementCounts` call, so a chunk is at most 5 outbound requests — comfortably inside any serverless timeout while keeping the run short enough to feel live.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/games-sync-actions.test.ts`. Mock `next/headers` and `next/cache` exactly as `tests/integration/games-actions.test.ts` does (read its header comment — it explains why both are needed). Additionally mock the Steam client so no real network call happens:

```ts
const fetchOwnedGames = vi.fn(async (): Promise<unknown[] | null> => []);
const fetchAchievementCounts = vi.fn(async (_appid: number) => null);

vi.mock('@/server/db/games/steam-client', () => ({ fetchOwnedGames, fetchAchievementCounts }));
```

Tests to write:

```ts
it('refuses to start when Steam credentials are absent', async () => {
  fetchOwnedGames.mockResolvedValueOnce(null);
  const result = await actions.startSteamSyncAction();
  expect(result.ok).toBe(false);
});

it('creates a run covering every Steam-platform library game', async () => {
  // Seed 3 steam games and 2 psp games; total must be 3, not 5.
});

it('leaves a library game Steam does not own completely untouched', async () => {
  // THE INVARIANT TEST. Seed a steam-platform game called 'Twisted Metal 2'
  // with known hours/achievements; have fetchOwnedGames return an unrelated
  // library. Run the sync to completion, commit nothing, and assert the games
  // row is byte-identical — every column, not just the four syncable ones.
});

it('stages a link for a game matched by title for the first time', async () => {});

it('stages a field update when Steam hours differ', async () => {});

it('stages a new_game for a Steam-owned game with no library row', async () => {});

it('never stages a match below the similarity floor', async () => {
  // 'Bloody Roar 2' against a library containing only 'Portal 2' must produce
  // no link at all — this is the exact false match the floor exists to stop.
});

it('advances the cursor by the chunk size and reports done at the end', async () => {});

it('marks the run ready when the cursor reaches the total', async () => {});

it('is resumable — a second advance continues from the stored cursor', async () => {});
```

Fill in each body concretely; do not leave a test with an empty body.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:integration -- games-sync-actions`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the actions**

`startSteamSyncAction`:
1. `await requireOwner()`.
2. `fetchOwnedGames()`. A `null` return means credentials missing or the request failed — return `fail('Steam is not configured, or did not respond.')`. **Never throw**; the soft-fail contract is non-negotiable.
3. Count the owner's Steam-platform games. Create the run with that `total` and the fetched library snapshot.
4. Return `{ ok: true, runId }`.

`advanceSteamSyncAction(runId)`:
1. `await requireOwner()`.
2. Load the run; if missing, or not `running`, return an error object.
3. Load the library snapshot and the next 5 Steam-platform games ordered stably by `id` (a stable order is what makes the cursor meaningful across calls — do NOT order by title, which can change mid-run).
4. For each: resolve the appid — use the stored `steamAppid` if present, otherwise `bestTitleMatchAmong(game.title, library, (o) => o.name)`. A `null` match means Steam does not own it: **stage nothing and move on.**
5. For a resolved appid, `fetchAchievementCounts(appid)` and compute `minutesToHoursTenths` from the snapshot entry.
6. `planLinkedGameChanges(...)` and collect.
7. `appendSyncChanges(owner, runId, changes, newCursor)`.
8. When the cursor reaches the total, compute the Steam-owned games whose appid appears in no library row and stage a `planNewGameChange` for each, then `finishSyncRun(..., 'ready')`.
9. Return progress.

**`playYearTenths`** for each game comes from summing that game's `game_play_years` rows — fetch them for the chunk in ONE query, not per game.

Wrap the whole body in try/catch; on an unexpected failure call `finishSyncRun(..., 'failed', message)` so a dead run does not sit in `running` forever.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:integration -- games-sync-actions`
Expected: PASS.

- [ ] **Step 5: Prove the no-delete invariant holds**

The "leaves a library game Steam does not own completely untouched" test must compare the FULL row before and after, not a subset. Confirm by temporarily adding a stray `UPDATE games SET title = title || '!'` inside the chunk loop and checking the test fails; then remove it. Report the result.

- [ ] **Step 6: Confirm the suite passes with no Steam credentials**

```bash
env -u STEAM_API_KEY -u STEAM_ID pnpm test
env -u STEAM_API_KEY -u STEAM_ID pnpm test:integration
```
Both must pass. This is a hard constraint, not a nicety.

- [ ] **Step 7: Run the full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
git add src/features/games/sync tests/integration/games-sync-actions.test.ts
git commit -m "feat(games): chunked Steam sync engine staging changes for review"
```

---

### Task 4: The review screen and commit

**Files:**
- Create: `src/app/(private)/games/sync/[runId]/page.tsx`
- Create: `src/features/games/sync/sync-review.tsx`
- Modify: `src/features/games/sync/sync-actions.ts` (add the commit action)
- Modify: `src/server/db/games/sync.ts` (add the commit)
- Test: `tests/integration/games-sync-commit.test.ts`, `tests/unit/games-sync-review.test.tsx`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  - `function commitSyncRun(ownerId: string, runId: string): Promise<{ readonly applied: number; readonly created: number }>`
  - `async function commitSyncRunAction(runId: string): Promise<ActionResult>`
  - `function SyncReview(props: { readonly run: SyncRun; readonly changes: readonly SyncChange[] }): React.ReactElement`

- [ ] **Step 1: Write the failing commit integration tests**

Create `tests/integration/games-sync-commit.test.ts`:

```ts
it('applies only selected changes', async () => {});
it('creates a game for a selected new_game change', async () => {});
it('does not create a game for a deselected new_game change', async () => {});
it('leaves every game not named by a change byte-identical', async () => {});
it('marks the run committed', async () => {});
it('rejects committing a run twice', async () => {});
it('rejects committing another owner run', async () => {});
it('applies all changes in one transaction — a failure applies none', async () => {});
it('never issues a delete against games', async () => {});
```

Fill in each body concretely. For the last one, assert by counting `games` rows before and after a commit that includes updates and creations — the count may only rise.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:integration -- games-sync-commit`

- [ ] **Step 3: Implement `commitSyncRun`**

In `src/server/db/games/sync.ts`. One transaction. For each SELECTED change, ordered `link` → `field_update` → `new_game` (a link must land before an update that assumes it):
- `link` → set `steam_appid`.
- `field_update` → set the single named column to `payload.to`. **Whitelist the field name against the four syncable columns** (`hoursTenths`, `achievementsUnlocked`, `achievementsTotal`, `steamAppid`); a payload naming any other column is a bug and must throw, never be interpolated into SQL.
- `new_game` → insert a game with `platform: 'steam'`, `status` derived as `hoursTenths > 0 ? 'completed' : 'backlog'`, and the staged appid/hours.
- `reconcile` → **applies nothing.** It is an advisory item telling the owner their split needs rebalancing. Skip it at commit; it exists only for the review screen.

Then set the run `committed` and stamp `updatedAt`. A run already `committed` throws — re-committing must not double-apply.

- [ ] **Step 4: Run the commit tests**

Run: `pnpm test:integration -- games-sync-commit`
Expected: PASS.

- [ ] **Step 5: Build the review screen**

`src/app/(private)/games/sync/[runId]/page.tsx` — `await requireOwner()`, load the run and its changes, render `SyncReview`. A run belonging to someone else, or a missing run, renders `notFound()`.

`src/features/games/sync/sync-review.tsx` — a client component grouping changes under four headings, in this order:
1. **Needs attention** — `reconcile` items and anything the run flagged. **Never pre-selected**, and rendered first so it cannot be missed.
2. **New games** — pre-selected, each showing title and hours.
3. **Field updates** — showing a real before → after.
4. **Links** — title → appid.

Each row has a checkbox calling `setSyncChangeSelectedAction`. A "Apply N selected changes" button calls `commitSyncRunAction`. Reuse the existing `Table` primitive and the selection idiom already in `src/features/finance/import/review-table.tsx` rather than inventing a second review idiom — read that file first.

**Do not use `useOptimistic` for the commit button's disabled state.** This codebase has a documented bug where an e2e assertion passed on optimistic state alone; the button must reflect the server's response.

- [ ] **Step 6: Write the component tests**

Create `tests/unit/games-sync-review.test.tsx`:

```tsx
it('renders needs-attention items first', () => {});
it('leaves reconcile items unselected by default', () => {});
it('pre-selects new games', () => {});
it('shows a real before and after for a field update', () => {});
it('disables the apply button when nothing is selected', () => {});
it('renders an empty state when a run produced no changes', () => {});
```

Fill in each body concretely.

- [ ] **Step 7: Run the gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
git add src/app/\(private\)/games/sync src/features/games/sync src/server/db/games/sync.ts tests/
git commit -m "feat(games): Steam sync review screen and commit"
```

---

### Task 5: Provenance — Steam-owned fields become read-only

**Files:**
- Modify: `src/features/games/library/game-dialog.tsx`
- Modify: `src/features/games/library/game-card.tsx`
- Modify: `src/features/games/library/library-view.tsx`
- Modify: `src/features/games/game-actions.ts`
- Test: `tests/unit/games-game-dialog.test.tsx`, `tests/integration/games-actions.test.ts`

**Interfaces:**
- Consumes: `Game.steamAppid` (already present).
- Produces: no new exports; behavioural change only.

This is the task that answers the owner's original question — *"I am confused what is from Steam and what is from my manual entry."* Because a Steam-owned field cannot be typed into, the UI says where the number came from by construction rather than with a decorative badge.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/games-game-dialog.test.tsx`:

```tsx
describe('GameDialog Steam provenance', () => {
  it('renders hours read-only for a Steam-linked game', () => {
    render(<GameDialog game={game({ steamAppid: 367520 })} open onOpenChange={() => {}} />);
    expect(screen.getByLabelText('Hours played')).toBeDisabled();
  });

  it('labels the field with its source', () => {
    render(<GameDialog game={game({ steamAppid: 367520 })} open onOpenChange={() => {}} />);
    expect(screen.getByText(/from steam/i)).toBeInTheDocument();
  });

  it('keeps hours editable for a game with no Steam link', () => {
    render(<GameDialog game={game({ steamAppid: null })} open onOpenChange={() => {}} />);
    expect(screen.getByLabelText('Hours played')).not.toBeDisabled();
  });

  it('keeps the play-year split editable even when the total is Steam-owned', () => {
    // Steam knows the total; only the owner knows which year it happened in.
    render(<GameDialog game={game({ steamAppid: 367520, playYears: [{ year: 2024, hoursTenths: 490 }] })} open onOpenChange={() => {}} />);
    expect(screen.getByLabelText('Year')).not.toBeDisabled();
  });

  it('keeps achievement counts read-only for a Steam-linked game', () => {});
  it('keeps rating, status and notes editable for a Steam-linked game', () => {});
});
```

In `tests/integration/games-actions.test.ts`, add the server-side half — **a disabled input is a UI affordance, not a security boundary**:

```ts
it('ignores a submitted hours value for a Steam-linked game', async () => {
  // Craft FormData with a different hours value for a game that has a
  // steamAppid, submit it through updateGameAction, and assert the stored
  // hours are UNCHANGED. A disabled input can be re-enabled in devtools.
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project components games-game-dialog` and `pnpm test:integration -- games-actions`

- [ ] **Step 3: Implement**

In `game-dialog.tsx`: derive `const steamOwned = game?.steamAppid !== null && game?.steamAppid !== undefined`. Pass `disabled={steamOwned}` to the Hours, Achievements earned and Achievements total fields, and render a small "from Steam" label beside each. The `Field` component may not accept `disabled` — check, and thread it through if not. **Leave the play-year panel fully editable.**

In `game-actions.ts`: when the target game has a `steamAppid`, drop `hoursTenths`, `achievementsUnlocked` and `achievementsTotal` from the parsed input before writing, so a forged submission cannot change them. Document why with a one-line comment.

In `game-card.tsx` and `library-view.tsx`: add a small source mark (Steam / Manual) and a Source filter facet. Follow the existing filter-chip idiom in `library-view.tsx`; do not introduce a new one.

- [ ] **Step 4: Run the tests, then the gate, then commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
git add src/features/games tests/
git commit -m "feat(games): Steam-owned fields render read-only with their source"
```

---

### Task 6: Entry point, docs, and the CLI script's continued life

**Files:**
- Modify: `src/app/(private)/games/(tabs)/layout.tsx`
- Modify: `src/features/games/library/library-view.tsx` (or wherever the page header lives)
- Modify: `docs/GAMES.md`
- Modify: `CLAUDE.md`
- Modify: `.env.example`

- [ ] **Step 1: Add the Sync entry point**

A "Sync with Steam" button on the Library screen. It calls `startSteamSyncAction`, then drives `advanceSteamSyncAction` in a loop showing "N of M games checked", and navigates to `/games/sync/[runId]` when the run reports `done`.

When `isSteamConfiguredAction()` returns false, render the button **disabled with an explanation** naming `STEAM_API_KEY` and `STEAM_ID` — never hidden, and never throwing.

- [ ] **Step 2: Document in `docs/GAMES.md`**

A "Steam sync" section covering: runs are chunked and resumable; nothing is written without approval; **sync never deletes or hides a game, and the 40 PSP plus 12 unmatched Steam-platform games are permanently manual**; hours and achievement counts are Steam-owned for linked games and read-only in the editor; a changed total raises a reconciliation item rather than re-splitting play years; and that `scripts/sync-steam-library.mjs` still exists for local-only runs with the opposite fill-nulls-only rule.

- [ ] **Step 3: Add the `CLAUDE.md` gotcha**

> - **The in-app Steam sync and `scripts/sync-steam-library.mjs` deliberately follow OPPOSITE rules, and unifying them is a bug.** The script fills only columns that are currently `NULL` (`steamSyncFieldsToFill`) because its contract is "never overwrite what the owner typed." The in-app sync makes Steam authoritative for a linked game's hours and achievement counts and proposes an update whenever they differ, which is why those fields render read-only in the editor. Both are correct for their own caller. `sync-plan.ts` exists as a separate module precisely because `steam.ts` must stay a dependency-free leaf for the script to `node`-import it.

- [ ] **Step 4: Update `.env.example`**

Confirm `STEAM_API_KEY` and `STEAM_ID` are present with a comment noting `STEAM_ID` may be a vanity name (e.g. `burmyyy`) and is resolved automatically.

- [ ] **Step 5: Manual verification against the real library**

With the dev server running, click Sync. Expected against the owner's real data: **47 Steam-platform games processed, 35 already linked, 12 never matched (correct — Steam does not own them), 3 new games staged** (Half-Life: Opposing Force, Metro Exodus Enhanced Edition, Forza Horizon 6). Confirm the 40 PSP games are untouched and absent from the run entirely. Report the actual counts.

- [ ] **Step 6: Gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build
git add .
git commit -m "docs(games): record the in-app Steam sync model"
```

---

## Self-Review

**Spec coverage (Part 2):**

| Spec requirement | Task |
|---|---|
| Client-driven chunking, no serverless timeout | 3 |
| `game_sync_runs` / `game_sync_changes` with before/after payload | 2 |
| Review at `/games/sync/[runId]`, four groups | 4 |
| New games pre-selected; needs-attention never pre-selected | 4 |
| Commit applies only selected changes, in one transaction | 4 |
| Run immutable once committed | 4 |
| Hours/achievements read-only for Steam-linked games | 5 |
| Source mark and Source filter in the library | 5 |
| Reconciliation item when a total change strands a split | 1 (planning), 4 (display) |
| CLI script kept, local-only guard intact | 6 |
| Credentials optional, UI degrades, suite passes without them | 3, 6 |
| **Sync never deletes** | 3 (named test), 4 (named test) |
| No low-confidence auto-apply | 1, 3 |

**Type consistency:** `PlannedChange` (Task 1) is stored by `appendSyncChanges` (Task 2), returned as `SyncChange` (Task 2) with `id`/`selected` added, rendered by `SyncReview` (Task 4), and applied by `commitSyncRun` (Task 4). `SyncRunStatus` is defined once in Task 2 and used unchanged after.

**Deliberate gaps:** PSN is Part 3 — the `game_sync_source` enum includes `'psn'` because the spec names it and Part 3 is approved work, but nothing in this plan reads or writes that value. No PSN code is written here.

**Known risk carried from Part 1:** `commitSyncRun` changing `hours_tenths` on a game with play-year rows makes the split stale by design. Part 1 surfaces that as the `Unattributed` line on the stats page; Task 4 additionally raises it as a review item. Neither re-splits automatically, and that is the intended behaviour, not an omission.
