# Games DLC rows + two statuses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class DLC rows to Games (additive hours/price/trophies, own year), reduce statuses to `played`/`wanted`, render the wishlist as cover cards whose "Mark as played" opens the pre-filled add dialog, and polish the panel (rating once, Notes once, platinum toggle, collapsible collection block).

**Architecture:** A new `game_dlc` table (migration 0019, additive) feeds a pure `dlc.ts` that computes base+DLC totals; every Stats builder takes DLC rows beside play-year rows; `Game` carries `dlc` the way it carries `playYears`. The existing drop migration moves to 0020 and becomes idempotent. Statuses shrink at `taxonomy.ts` and typecheck forces every `Record<GameStatus, …>` site.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict (`exactOptionalPropertyTypes`), Drizzle 0.45 + postgres.js, Radix via `radix-ui`, Vitest (`domain` + `components` projects), Testcontainers integration tests.

**Spec:** `docs/superpowers/specs/2026-10-18-games-dlc-and-two-statuses-design.md`

## Global Constraints

- All hours math through `src/server/games/hours.ts`; tenths are integers, never floats; normalise `-0` (`value === 0 ? 0 : value`).
- Money is integer cents; `priceDollars` form field → `Math.round(dollars * 100)` as `game-actions.ts` already does.
- `src/server/games/**` stays framework-free (no Drizzle, no Next, no React). Client components `import type` only from `src/server/db/games/**`.
- Every Server Action starts with `await requireOwner()`, then `revalidatePath('/games', 'layout')` on success.
- Pending flags across a Server Action call use `try/catch/finally`.
- Conditional spreads only for `exactOptionalPropertyTypes`; never to pass a prop you have not confirmed exists.
- `GAME_STATUSES = ['played', 'wanted']`; the Postgres enum keeps its old labels, unreachable.
- DLC `year` = year played. DLC on a collection MEMBER is refused everywhere. DLC trophies on a collection add on top of the member roll-up (`gameTotals` after `trophyAdjustedRows`).
- Migration order: 0019 additive (`game_dlc`, status default, status UPDATE), 0020 drops with `IF EXISTS`. Never `apply_migration` on production; raw SQL + journal row.
- Never run `pnpm test:e2e` against the local dev database.
- Prettier is not enforced on Markdown; it IS on TS/TSX (`pnpm lint`).

## Review Focus

1. A DLC with hours but a game with `hours_tenths = null` — totals must read as the DLC hours, not `null` and not `NaN`. (Task 3 test `sums a DLC onto a null base`.)
2. Deleting a game cascades its DLC rows; deleting a DLC row re-fetches the panel and lowers the totals line. (Task 5 cascade test; Task 7 delete test.)
3. Filing a game that already has DLC into a collection must be refused with a readable error, not a 500. (Task 5 test `refuses a collection target when the game has DLC`.)
4. "Mark as played" on a row that is no longer `wanted` (edited in another tab) must fail softly. (Task 6 test `refuses a game that is not wanted`.)
5. The DLC year must be rejected outside 1970–2100 and the name must be non-empty after trim. (Task 6 schema tests.)

---

### Task 1: Two statuses

**Files:**
- Modify: `src/server/games/taxonomy.ts:18-80` (`GAME_STATUSES`, `STATUS_LABELS`, doc comment)
- Modify: `src/components/games/status-badge.tsx` (drop `backlog`/`playing` entries and the `playing` guard)
- Modify: `src/server/games/stats.ts:75-120, 208-240, 298-322` (remove `backlogCount`, `playingCount`, `backlogValueCents`)
- Modify: `src/features/games/dashboard/games-dashboard.tsx:163-182` (remove the Backlog card and the Cost-per-hour `hint`)
- Modify: `src/features/games/panel/game-panel.tsx:47-52` (`STATUS_OPTIONS = ['wanted', 'played']`)
- Modify: `src/features/games/library/game-dialog.tsx:87` (default `'played'`), `src/features/games/game-actions.ts:158` (`?? 'played'`)
- Modify: `src/features/games/upcoming/wishlist-section.tsx:22` (`QUICK_STATUSES = ['played']` — temporary; Task 8 replaces the component)
- Modify: `src/server/db/schema.ts:865` (`.default('played')`), `src/server/db/games/errors.ts:25` (comment)
- Test: the 10 files `grep -rl "'backlog'\|'playing'" tests` lists, plus `tests/unit/games-dashboard.test.tsx`

**Interfaces:**
- Produces: `GameStatus = 'played' | 'wanted'`; `LibrarySummary` without `backlogCount`/`playingCount`; `FinancialSummary` without `backlogCount`/`backlogValueCents`.

- [ ] **Step 1: Change `GAME_STATUSES` to `['played', 'wanted']` and `STATUS_LABELS` to match; run `pnpm typecheck` and fix every error it reports in the files above** — the `Record<GameStatus, …>` maps are the checklist.
- [ ] **Step 2: Update the 10 status-referencing tests** so no fixture uses `backlog`/`playing`; in `games-stats.test.ts` delete the backlog/playing assertions; in `games-dashboard.test.tsx` assert `screen.queryByText('Backlog')` is null and no "sitting in backlog" text renders; in `games-taxonomy.test.ts` assert `GAME_STATUSES` equals `['played', 'wanted']`.
- [ ] **Step 3: Run `pnpm typecheck && pnpm lint && pnpm test`** — expected: all green.
- [ ] **Step 4: Commit** — `refactor(games): two statuses — played and wanted`.

### Task 2: Schema and the migration split

**Files:**
- Modify: `src/server/db/schema.ts` (new `gameDlc` table after `gamePlayYears`; `games.status` default)
- Delete: `drizzle/0019_violet_doctor_doom.sql`, `drizzle/meta/0019_snapshot.json`, its `_journal.json` entry
- Create: `drizzle/0019_<generated>.sql` (additive), `drizzle/0020_<name>.sql` (drops, `IF EXISTS`), snapshots for both, two journal entries
- Modify: `docs/DEPLOYMENT.md` (one paragraph under the MCP recipe: why 0019/0020 are hand-split and 0020 is idempotent)

**Interfaces:**
- Produces: `gameDlc` Drizzle table: `id uuid pk`, `ownerId text → user.id cascade`, `gameId uuid → games.id cascade`, `name text notNull`, `year smallint notNull`, `hoursTenths integer null`, `priceCents integer null`, `achievementsUnlocked smallint null`, `achievementsTotal smallint null`, `createdAt`, `updatedAt`; indexes `game_dlc_owner_idx(owner_id)`, unique `game_dlc_game_name_idx(game_id, lower(name))`.

- [ ] **Step 1: Add `gameDlc` to `schema.ts` with a doc comment stating the additive model and the member rule; set `games.status` default to `'played'`.**
- [ ] **Step 2: Remove the old 0019 files and journal entry; run `pnpm db:generate`.** Expected: one new `0019_*.sql` containing the three `DROP TABLE`, two `DROP INDEX`, four `DROP COLUMN`, four `DROP TYPE`, the `CREATE TABLE "game_dlc"`, its two indexes, and `ALTER TABLE "games" ALTER COLUMN "status" SET DEFAULT 'played'`. Anything touching `game_status`, `game_platform` or `anime_*` means snapshot drift — stop.
- [ ] **Step 3: Hand-split.** 0019 keeps the `CREATE TABLE`, both `CREATE … INDEX` for `game_dlc`, the `ALTER COLUMN … SET DEFAULT`, and appends `UPDATE "games" SET "status" = 'played', "updated_at" = now() WHERE "status" IN ('backlog', 'playing');`. 0020 holds the drops with `IF EXISTS` on every `DROP TABLE`, `DROP INDEX`, `DROP COLUMN`, `DROP TYPE`; delete the three `DISABLE ROW LEVEL SECURITY` lines outright (RLS was never enabled on those tables, and `ALTER TABLE` has no `IF EXISTS` form that drizzle emits). Journal: 0020 entry `idx 20`, `when` = 0019's `when` + 1000, `breakpoints: true`; copy the generated snapshot to `0019_snapshot.json` and keep it as `0020_snapshot.json` with its `id`/`prevId` fields adjusted so 0020's `prevId` is 0019's `id`.
- [ ] **Step 4: Local database.** `docker compose -f compose.dev.yml exec postgres psql -U <user from .env> -d <db> -c "delete from drizzle.__drizzle_migrations where created_at = 1792358073216;"` then `pnpm db:migrate`. Expected: 0019 applies (table created, 0 or more rows updated), 0020 applies as no-ops.
- [ ] **Step 5: Run `pnpm test:integration`** (Testcontainers applies 0000–0020 from scratch). Expected: green.
- [ ] **Step 6: Commit** — `feat(games): game_dlc table (0019, additive); drops become 0020 and idempotent`.

### Task 3: Pure DLC totals

**Files:**
- Create: `src/server/games/dlc.ts`
- Test: `tests/unit/games-dlc.test.ts` (project `domain`)

**Interfaces:**
- Produces:
  ```ts
  export interface GameDlcRow { readonly id: string; readonly gameId: string; readonly name: string; readonly year: number; readonly hoursTenths: number | null; readonly priceCents: number | null; readonly achievementsUnlocked: number | null; readonly achievementsTotal: number | null }
  export interface DlcSums { readonly hoursTenths: number | null; readonly priceCents: number | null; readonly achievementsUnlocked: number | null; readonly achievementsTotal: number | null }
  export function sumDlc(rows: readonly GameDlcRow[]): DlcSums            // null when no row has that field
  export interface Totalable { readonly hoursTenths: number | null; readonly priceCents: number | null; readonly achievementsUnlocked: number | null; readonly achievementsTotal: number | null }
  export function gameTotals<T extends Totalable>(game: T, dlc: readonly GameDlcRow[]): DlcSums   // base + sums; null only when BOTH sides null
  export function groupDlcByGame(rows: readonly GameDlcRow[]): ReadonlyMap<string, readonly GameDlcRow[]>
  ```

- [ ] **Step 1: Write failing tests:** `sums a DLC onto a null base` (base `hoursTenths: null`, one DLC 60 → `60`); `returns null when neither side has a value`; `adds price and both achievement counts`; `ignores rows for other games in groupDlcByGame`; `never returns negative zero` (`Object.is(result.hoursTenths, 0)` after base 0 + no DLC).
- [ ] **Step 2: Run `npx vitest run --project domain games-dlc`** — expected FAIL (module not found).
- [ ] **Step 3: Implement `dlc.ts`** with the signatures above; sums via plain integer addition.
- [ ] **Step 4: Run the test** — expected PASS. **Step 5: Commit** — `feat(games): pure DLC totals`.

### Task 4: Stats include DLC

**Files:**
- Modify: `src/server/games/stats.ts` (`buildYearlyBreakdown`, `buildLibrarySummary`, `buildTrophyTotals`, `buildFinancialSummary`, `findCallouts`, `buildLeaderboard`)
- Modify: `src/features/games/dashboard/games-dashboard.tsx:62-80`, `src/app/(private)/games/(tabs)/stats/page.tsx:12-20`
- Modify: `src/features/games/dashboard/trophies-per-year-chart.tsx` only if it computes from rows rather than from `yearly.rows` (check; if it reads `yearly`, nothing to do)
- Test: `tests/unit/games-stats.test.ts`, `tests/unit/games-dashboard.test.tsx`

**Interfaces:**
- Consumes: `gameTotals`, `groupDlcByGame`, `GameDlcRow` (Task 3); `listDlc` (Task 5 — until then the page passes `[]`).
- Produces: every builder gains a trailing `dlc: readonly GameDlcRow[]` parameter (`buildYearlyBreakdown(rows, playYears, dlc)`, `buildLibrarySummary(rows, dlc)`, `buildTrophyTotals(rows, dlc)`, `buildFinancialSummary(rows, dlc)`, `findCallouts(rows, dlc, …)`, `buildLeaderboard(rows, dlc, metric, …)`); `GamesDashboard` gains `readonly dlc: readonly GameDlcRow[]`.

- [ ] **Step 1: Write failing tests** in `games-stats.test.ts`: `yearly: a DLC's hours and trophies land in the DLC year, not first-played year` (game 2024 50h/10 trophies, DLC 2025 6h/4 → 2024 row 50h/10, 2025 row 6h/4, `startedCount` 2024=1, 2025=0, `playedCount` 2025=1); `library total hours include DLC`; `trophies earned include DLC`; `total spend and cost per hour include DLC price`; `averagePriceCents counts a game priced only through its DLC`; `leaderboard hours use totals`; `a collection's DLC trophies add on top of the member roll-up` (collection with two members 5+5, DLC 3 → 13).
- [ ] **Step 2: Run `npx vitest run --project domain games-stats`** — expected FAIL on arity/values.
- [ ] **Step 3: Implement.** In `buildYearlyBreakdown`, after the attribution loop: for each DLC row whose `gameId` is in `rows`, `bucket(dlc.year).hoursTenths += dlc.hoursTenths ?? 0`, `.achievements += dlc.achievementsUnlocked ?? 0`, `.playedGames.add(dlc.gameId)`. Elsewhere replace direct reads of `row.hoursTenths`/`priceCents`/`achievements*` with `gameTotals(row, byGame.get(row.id) ?? [])`, applied to the rows AFTER `trophyAdjustedRows`.
- [ ] **Step 4: Thread `dlc` through `GamesDashboard` and the Stats page** (`listDlc(owner.userId)` in the `Promise.all`; stub `[]` until Task 5 lands if executing out of order — do not leave the stub in the commit).
- [ ] **Step 5: Run `pnpm typecheck && pnpm test`** — green. **Step 6: Commit** — `feat(games): stats count DLC hours, price and trophies`.

### Task 5: DLC data access and `Game.dlc`

**Files:**
- Create: `src/server/db/games/dlc.ts`
- Modify: `src/server/db/games/games.ts` (`Game.dlc`, `rowToGame`, `listGames`, `getGame`, `updateGame` return path, `assertCollectionTargetValid`, `listGameStatRows` untouched)
- Modify: `src/server/db/games/errors.ts` (new `GameHasDlcError`, `DlcOnCollectionMemberError` with user-readable messages)
- Test: `tests/integration/games-dlc.test.ts`, `tests/integration/games.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type { GameDlcRow } from '@/server/games/dlc';    // the DAL returns the domain row type; no second type
  export async function listDlc(ownerId: string): Promise<GameDlcRow[]>
  export async function listDlcForGame(ownerId: string, gameId: string): Promise<GameDlcRow[]>
  export interface DlcInput { readonly name: string; readonly year: number; readonly hoursTenths?: number | null; readonly priceCents?: number | null; readonly achievementsUnlocked?: number | null; readonly achievementsTotal?: number | null }
  export async function createDlc(ownerId: string, gameId: string, input: DlcInput): Promise<GameDlcRow>   // throws DlcOnCollectionMemberError when the game has collection_id
  export async function updateDlc(ownerId: string, dlcId: string, patch: Partial<DlcInput>): Promise<GameDlcRow>
  export async function deleteDlc(ownerId: string, dlcId: string): Promise<void>
  ```
  `Game` gains `readonly dlc: readonly GameDlcRow[]`, loaded in `listGames` with one `listDlc` call grouped by `groupDlcByGame`, and in `getGame`/`updateGame` with `listDlcForGame`.

- [ ] **Step 1: Write failing integration tests:** owner scoping (`listDlc` for owner B sees nothing of A); `createDlc` on a collection member throws `DlcOnCollectionMemberError`; unique name per game surfaces as `isUniqueViolation`; deleting the game cascades (`listDlcForGame` empty); `assertCollectionTargetValid` refuses filing a game that has DLC (`GameHasDlcError`); `getGame(...).dlc` returns the rows ordered by `year asc, name asc`.
- [ ] **Step 2: Run `pnpm test:integration -- games-dlc`** — expected FAIL.
- [ ] **Step 3: Implement** following `play-years.ts` (owner-scoped `where`, `updatedAt: new Date()` on update; `createDlc` checks `games.collectionId` inside the same transaction).
- [ ] **Step 4: Run `pnpm test:integration`** — green (also unblocks Task 4's page wiring). **Step 5: Commit** — `feat(games): DLC data access; Game carries its DLC rows`.

### Task 6: Actions — DLC and "complete wishlist game"

**Files:**
- Create: `src/features/games/dlc-actions.ts`
- Modify: `src/features/games/game-actions.ts` (add `completeWishlistGameAction`; reuse `parse(formData, 'update')`, `findDuplicateYear`, `validateSplit`, `replacePlayYears`)
- Test: `tests/integration/games-dlc-actions.test.ts`, `tests/integration/games-actions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // dlc-actions.ts ('use server')
  export type DlcFieldKey = 'name' | 'year' | 'hours' | 'priceDollars' | 'achievementsUnlocked' | 'achievementsTotal';
  export async function createGameDlcAction(gameId: string, formData: FormData): Promise<ActionResult>      // fields: name, year, optional hours/priceDollars/achievements*
  export async function updateGameDlcFieldAction(dlcId: string, field: DlcFieldKey, value: string): Promise<ActionResult>  // '' clears a nullable field; name/year cannot be cleared
  export async function deleteGameDlcAction(dlcId: string): Promise<ActionResult>
  // game-actions.ts
  export async function completeWishlistGameAction(gameId: string, formData: FormData): Promise<ActionResult>  // refuses unless current status === 'wanted'; writes status 'played'
  ```
  Field schemas: `name` `z.string().trim().min(1).max(300)`, `year` `z.coerce.number().int().min(1970).max(2100)`, `hours` parsed with the same helper `game-actions.ts` uses for the game's hours, `priceDollars` `min(0).max(10_000)`, achievements `int().min(0).max(10_000)`.

- [ ] **Step 1: Write failing tests:** each action returns `{ ok: false }`/throws without an owner (same harness `games-actions.test.ts` uses); `createGameDlcAction` rejects blank name and year 1969; member refusal surfaces as `{ ok: false, error }` containing "collection"; `updateGameDlcFieldAction(id, 'hours', '')` sets `hoursTenths` null; `completeWishlistGameAction` on a `played` row returns `{ ok: false }`; on a `wanted` row sets `status 'played'`, hours/price/year from the form, and replaces play years.
- [ ] **Step 2: Run the two files** — expected FAIL. **Step 3: Implement.** **Step 4: Run `pnpm test:integration`** — green. **Step 5: Commit** — `feat(games): DLC actions; complete a wishlist game from the add dialog`.

### Task 7: Panel — DLC group, totals, platinum toggle, rating once, Notes once, collapsible collection; table totals

**Files:**
- Create: `src/features/games/panel/dlc-group.tsx` (client)
- Modify: `src/features/games/panel/game-panel.tsx` (`MetaLine` loses `RatingStars`; Progress rows get suffixes; `<DlcGroup>` after Progress when `!isCollectionMember`; Details Price suffix; collection wrapper with Show/Hide; Notes without `label`; platinum toggle replaces `Checkbox`)
- Modify: `src/features/games/library/game-table.tsx:214-226` (totals via `gameTotals(game, game.dlc)`)
- Test: `tests/unit/games-game-panel.test.tsx`, `tests/unit/games-game-table.test.tsx`

**Interfaces:**
- Consumes: `gameTotals`, `GameDlcRow` (Task 3); the three DLC actions (Task 6); `InlineEditField`/`InlineEditSelect`/`ROW_CLASS` (`src/components/ui/inline-edit-row.tsx`); `ConfirmDialog`; `useGamePanel().refresh` pattern already used after saves.
- Produces: `DlcGroup({ gameId, dlc, base, onChanged }: { readonly gameId: string; readonly dlc: readonly GameDlcRow[]; readonly base: Totalable; readonly onChanged: () => void })` rendering `Group title="DLC"`, one row per DLC with cells name · year · hours · price · `earned/total`, a per-row remove (ConfirmDialog → `deleteGameDlcAction`), an "Add DLC" button that shows a two-field inline form (name, year) submitting `createGameDlcAction`, and a totals line `Total · {hours} · {price} · {earned}/{total} trophies` from `gameTotals(base, dlc)` (segments omitted when null). `PlatinumToggle({ on, onToggle })`: a `<button aria-pressed>` with `Trophy` and the text "Platinum", using `PlatinumBadge`'s gradient classes when on and `variant="outline"` when off.

- [ ] **Step 1: Write failing component tests:** header has no `RatingStars` (`queryByLabelText(/rating/i)` outside the Rating row is null); `getAllByText('Notes')` length 1; platinum renders a button with `aria-pressed="true"` when `platinum: true` and calls `updateGameFieldAction(id, 'platinum', '')` when clicked; collection block hidden by default for `members: []` and a button named `Show collection` reveals `Add games`; expanded by default with one member; DLC group lists a row `Shadow of the Erdtree · 2025 · 6.0h · $39.99 · 10/12`, totals line reads base+DLC, absent for a collection member; Add DLC form submits name+year and calls `createGameDlcAction`; remove calls `deleteGameDlcAction` after confirm; Progress Hours row shows `· 59.0h with DLC` when DLC exists and nothing when not. Table test: hours cell shows the total.
- [ ] **Step 2: Run `npx vitest run --project components games-game-panel games-game-table`** — expected FAIL.
- [ ] **Step 3: Implement** `dlc-group.tsx` and the panel edits; keep every pending flag in `try/catch/finally`; `hint`/`displayValue` only via props `InlineEditField` declares.
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`** — green. **Step 5: Commit** — `feat(games): DLC in the panel; platinum toggle; one rating, one Notes label; collapsible collection`.

### Task 8: Wishlist cards and the complete-mode dialog

**Files:**
- Modify: `src/features/games/upcoming/wishlist-section.tsx` (rewrite body: grid of `WishlistCard`; owns `<GameDialog mode="complete" game={…}>` state)
- Modify: `src/features/games/library/game-dialog.tsx` (props `mode?: 'create' | 'complete'`, `game?: Game`; heading `Add to library` in complete mode; pre-fill; status control hidden; submit → `completeWishlistGameAction`; doc comment rewritten)
- Modify: `src/features/games/library/game-card.tsx` only to export the on-art pill class or extract `CoverTile` if the wishlist card would otherwise duplicate >20 lines (builder's call)
- Test: `tests/unit/games-wishlist-section.test.tsx`, `tests/unit/games-game-dialog.test.tsx` (new)

**Interfaces:**
- Consumes: `FoilCard` (`tone: 'wishlist' | 'platinum' | null` — confirm the `FoilTone` union in `foil-card.tsx`), `formatReleaseCountdown`, `isReleased`, `sortWishlist`, `completeWishlistGameAction` (Task 6), `useGamePanel().openGame`.
- Produces: `WishlistSection` keeps its props `{ games, now? }`; `GameDialog({ open, onOpenChange, mode = 'create', game })` where `game` is required when `mode === 'complete'` (model as a discriminated union of the props).

- [ ] **Step 1: Write failing tests:** section renders one `data-slot="wishlist-card"` per game in `sortWishlist` order; a released game shows an on-art `Out now` pill and the line `PS5 · Out now`; clicking the cover button (name = title) calls `openGame(game)`; clicking `Mark as played` opens a dialog titled `Add to library` whose title input equals the game's title and which has no status control; submitting it calls `completeWishlistGameAction(game.id, formData)`; cancel calls nothing. Dialog test: `mode="create"` still defaults status `played` and calls `createGameAction`.
- [ ] **Step 2: Run the two files** — expected FAIL. **Step 3: Implement.** Grid: `grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5`. Pre-fill in complete mode by keying the dialog on `game.id` so `useState` initialisers read the props (no effect).
- [ ] **Step 4: Run `pnpm typecheck && pnpm lint && pnpm test`** — green. **Step 5: Commit** — `feat(games): wishlist as cover cards; Mark as played opens the pre-filled add dialog`.

### Task 9: Split-to-DLC conversion script

**Files:**
- Create: `scripts/convert-split-to-dlc.mjs` (pure; `node scripts/convert-split-to-dlc.mjs <map.json> --out <file.sql>`), `scripts/README` line if one exists
- Test: `tests/unit/games-convert-split-to-dlc.test.ts`

**Interfaces:**
- Produces: `renderConversionSql(entries: readonly { title: string; year: number }[]): string` — for each entry, one `DO $$`-free, plain-SQL block keyed by `title` and `year`: a CTE selecting `(game_id, owner_id, hours_tenths)` from `games JOIN game_play_years`, `INSERT INTO game_dlc (owner_id, game_id, name, year, hours_tenths) SELECT owner_id, game_id, 'DLC', <year>, hours_tenths FROM moved`, `UPDATE games SET hours_tenths = hours_tenths - (SELECT hours_tenths FROM moved), updated_at = now() WHERE id = (SELECT game_id FROM moved)`, `DELETE FROM game_play_years WHERE game_id = (SELECT game_id FROM moved)`; the whole file wrapped in `BEGIN; … COMMIT;` with a header comment; `sqlLiteral` reused from `diff-game-log.mjs`. Map for this run: Clair Obscur: Expedition 33 → 2026, Lies of P → 2025, Hollow Knight → 2025.

- [ ] **Step 1: Write failing tests:** three entries produce three blocks; a title with a quote is escaped; output starts with `BEGIN;` and ends with `COMMIT;`; the `UPDATE` subtracts (regex `hours_tenths - \(`).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Apply locally:** `node scripts/convert-split-to-dlc.mjs <map> --out /tmp-in-scratchpad.sql` then `psql` it against the local DB; open the panel for Clair Obscur and confirm `53.9h`, one DLC row `DLC · 2026 · 6.0h`, no split. **Step 6: Commit** — `feat(scripts): convert-split-to-dlc — emit the SQL that turns an imported "+N" split into a DLC row`.

### Task 10: Docs

**Files:**
- Modify: `docs/GAMES.md` (new "DLC" section after "Play-year attribution"; "Lifecycle statuses" rewritten for two states; panel and wishlist sections; "Seeding the three known splits" becomes past tense with the conversion noted), `CLAUDE.md` (collections gotcha + DLC clause; statuses mention), `docs/DEPLOYMENT.md` (done in Task 2), `docs/ROADMAP.md` ("Games simplification" section gains the DLC/status items; RESUME block: hand-UPDATE Control Resonant → 0019 → conversion SQL → merge/deploy → 0020; a line that `entry-points.test.ts` should one day walk `src/features/**` action files), `docs/HANDOFF.md` (migrations row: 21 on disk; statuses; DLC)
- [ ] **Step 1: Write the sections.** **Step 2: `pnpm lint`.** **Step 3: Commit** — `docs: DLC rows, two statuses, wishlist cards`.

### Task 11: Gate and real-browser check

- [ ] **Step 1: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build`** — all green; paste counts into the final report.
- [ ] **Step 2: Browser (dev server on the local DB, Playwright script in `test-results/`):** `/games/upcoming` at 1440 and 390 shows the card grid, `document.body.scrollWidth === 390`; Mark as played opens the dialog pre-filled; a DLC add/edit/remove round trip in the panel changes the totals line; `/games/stats` has no Backlog card; zero non-devtools CSP violations.
- [ ] **Step 3: Push.** `git push origin feat/games-simplify`.

### Production (after the PR is green; owner-gated, not part of the branch)

1. `UPDATE games SET status = 'wanted', updated_at = now() WHERE title = 'Control Resonant' AND status = 'backlog';` through the MCP.
2. Apply 0019 (raw SQL + journal row with its `when` and the committed file's sha256).
3. Apply the conversion SQL from Task 9 through the MCP; verify the three games' hours and DLC rows.
4. Owner merges; Netlify deploys; owner smoke-tests Library, Upcoming (cards + Mark as played), Stats, the panel's DLC group.
5. Apply 0020 the same way; post-check `to_regclass('public.game_trophies')` is null and `select typname from pg_type where typname like 'game_%'` lists only `game_platform`, `game_ownership`, `game_status`.
