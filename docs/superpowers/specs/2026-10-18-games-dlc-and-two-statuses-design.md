# Games: DLC rows, two statuses, wishlist cards, panel polish — design

Date: 2026-10-18. Branch: `feat/games-simplify` (folded into the existing PR by owner decision).
Decided in a grill-me interview with the owner; every "owner" line below is theirs, every "builder"
line is a call made by the designer that the owner has seen and can veto.

## Intent

The owner looked at the simplified Games module running locally and asked for five things:

1. Upcoming's "Your wishlist" as cover cards, like the IGDB feed beneath it, not a list.
2. No `backlog`. On reflection, no `playing` either: **a game is either `wanted` or `played`.**
3. The panel shows the rating twice, labels Notes twice, and the platinum checkbox is too small.
4. The empty "Games in this collection" block should be hidden behind a button.
5. DLC. "Split across years is usually for DLCs that come out next year" — the owner wants both:
   the existing year split of a game's own hours, AND first-class DLC rows that carry their own
   year, hours, price and trophies, with totals shown.

## Goals

- A DLC is recorded once, on the game, with name, year played, hours, price paid, trophies earned
  and trophies total. Every total the app shows (library table, cards, Stats, leaderboards, cost
  per hour) is base + DLC, computed at read time. The panel is the one place that shows base and
  total side by side.
- The year-by-year table credits a DLC's hours and trophies to the DLC's own year.
- Two statuses. New games default to `played`. The wishlist's "Mark as played" opens the same
  modal as "Add game", pre-filled, so the owner fills in hours/price/year/rating at the moment the
  game enters the library.
- Panel: rating shown once, Notes labelled once, a real platinum toggle, collection block
  collapsed when empty.

## Non-goals and anti-goals

- No per-DLC platinum (owner). Platinum stays one flag per game.
- No per-DLC cover art, platform, ownership or status. A DLC is a row on a game, not a game.
- No attribution rule for DLC. Nothing about DLC "must add up"; it adds. (The owner first chose
  attribution and then reversed it; the reversal is final.)
- Do not derive the game's base figures from anything. `games.hours_tenths`, `price_cents`,
  `achievements_unlocked/total` stay the owner's own base-game numbers.
- Do not drop enum values from Postgres (impossible without a type swap). `backlog`, `playing`
  and `paused_dropped` stay in `game_status` and become unreachable from the app, the pattern
  `paused_dropped` already set.
- Do not touch Anime or Finance.

## Data model

### `game_dlc` (new table, migration 0019)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `owner_id` | text → `user.id` cascade | owner scoping, like every Games table |
| `game_id` | uuid → `games.id` cascade | the game it extends |
| `name` | text not null | "Shadow of the Erdtree" |
| `year` | smallint not null | **the year the owner played it**, not its release year (builder) |
| `hours_tenths` | integer null | same unit rule as `games.hours_tenths` (`hours.ts` only) |
| `price_cents` | integer null | same unit rule as `games.price_cents` |
| `achievements_unlocked` | smallint null | |
| `achievements_total` | smallint null | |
| `created_at`, `updated_at` | timestamptz | |

Indexes: `(owner_id)`; unique `(game_id, lower(name))` — two DLCs of the same name on one game is
a typo, not detail (builder).

A collection MEMBER cannot carry DLC (owner-approved builder call): its hours and price live on
the collection row, so DLC goes there too. The panel hides the DLC group for a member; the server
action refuses an insert on a member; `assertCollectionTargetValid` additionally refuses filing a
game that already has DLC rows into a collection, with a message that says to move the DLC first.

**Trophies on a collection's DLC add on top of the member roll-up (owner).** Today
`rollUpTrophies`/`trophyAdjustedRows` give a collection the SUM of its members' counts and the
panel renders the collection's own achievement rows read-only ("Added up from the games in this
collection"). With DLC the collection's trophy figure is `members + its DLC rows`; `gameTotals` is
applied AFTER `trophyAdjustedRows`, never before, and the read-only rows show the combined number
with the same "with DLC" suffix as any other total. One rule throughout: DLC adds to whatever row
it is on.

### Statuses

`GAME_STATUSES = ['played', 'wanted']`. `STATUS_LABELS` loses two keys; every
`Record<GameStatus, …>` map in the app is forced by typecheck. `games.status` default becomes
`'played'` (schema + migration). `StatusBadge` renders only for `wanted` (it already renders
nothing for `played`).

Production data (owner decided per row): Control Resonant → `wanted`; Crysis 2 Remastered,
Crysis 3 Remastered, Marvel's Wolverine, Metro Exodus Enhanced Edition, Wolfenstein: The Old
Blood (all `backlog`) and Marvel Tokon (`playing`) → `played`. Control Resonant is a one-row
hand UPDATE through the MCP before deploy (the old code handles `wanted` fine). The rest is a
generic `UPDATE games SET status = 'played' WHERE status IN ('backlog', 'playing')` inside
migration 0019, so CI, local and production all converge the same way.

### Migrations, and why the order flips

Today the branch's `0019_violet_doctor_doom` is the DROP migration (trophy/sync tables, link
columns, four types). It must run AFTER the new code is deployed (old code reads those tables).
The DLC table and the status fix must run BEFORE the new code is deployed (new code reads
`game_dlc`; new code has no `backlog`). Drizzle's migrator applies journal entries strictly in
`when` order and skips anything older than the newest applied, so the additive migration must be
numbered first:

- **0019** — additive: `CREATE TABLE game_dlc` + indexes, `ALTER TABLE games ALTER COLUMN status
  SET DEFAULT 'played'`, the status UPDATE. Safe to apply to production while the OLD code is live.
- **0020** — the drops, moved verbatim from today's 0019 but every statement made idempotent
  (`DROP TABLE IF EXISTS`, `DROP INDEX IF EXISTS`, `DROP COLUMN IF EXISTS`, `DROP TYPE IF EXISTS`).
  Applied to production only after the deploy.

Builder mechanics: delete today's 0019 (sql, snapshot, journal entry), run `drizzle-kit generate`
once against the final `schema.ts` (it emits drops + create in one file), hand-split that file into
the two above, write both journal entries (0020's `when` = 0019's + 1000), keep the generated
snapshot as `0020_snapshot.json` and copy it as `0019_snapshot.json` (drizzle-kit diffs against
the newest snapshot only). Record this in `docs/DEPLOYMENT.md` next to the MCP recipe. The local
dev database already has the old 0019 applied: delete its journal row, run `pnpm db:migrate`; the
IF EXISTS forms make 0020 a no-op there. Testcontainers and CI start from zero and are unaffected.

### Converting the three imported splits into DLC rows (owner)

The sheet's `"53 + 6"` notation meant "base + DLC", and the one-off seed turned all three such rows
into year splits. The owner has confirmed all three are DLC: Clair Obscur: Expedition 33 (6.0h,
2026), Lies of P (25.0h, 2025), Hollow Knight (12.0h, 2025). Conversion, per game:

- insert one `game_dlc` row named `DLC` (placeholder — the owner renames it and fills trophies and
  price in the panel) with the DLC year and the moved hours;
- lower `games.hours_tenths` by the moved tenths (Clair Obscur: 599 → 539);
- delete the game's `game_play_years` rows — the single row left would only restate
  `first_played_year`, and Clair Obscur's pre-existing 0.9h gap then attributes cleanly.

This is title-keyed data, so per `docs/GAMES.md` it is a one-off, not a migration:
`scripts/convert-split-to-dlc.mjs` is a pure emitter in the `diff-game-log.mjs` mould (JSON map of
title → year in, SQL out, no database access, unit-tested), applied locally with `psql` and to
production through the MCP after 0019 exists there. The trophies-per-year and year-by-year numbers
for 2025/2026 do not change (the hours just move from an attributed split to a DLC row in the same
year).

Production sequence becomes: hand-UPDATE Control Resonant → apply 0019 → apply the conversion SQL →
merge/deploy → smoke-test → apply 0020. Phase 5 in the roadmap is rewritten accordingly.

## Domain core (`src/server/games/`, pure)

- `dlc.ts` (new): `GameDlcRow` type; `sumDlc(rows)` → `{ hoursTenths, priceCents,
  achievementsUnlocked, achievementsTotal }` with null-aware sums (no rows priced → `null`, not 0,
  same convention as the stat builders); `gameTotals(game, dlcRows)` → the base+DLC figures used
  everywhere outside the panel. All hours math still goes through `hours.ts`.
- `stats.ts`: every builder that reads `hoursTenths`, `priceCents` or achievement counts takes DLC
  rows as an input (alongside `playYears`, which `buildYearlyBreakdown` already takes) and uses
  `gameTotals`. `buildYearlyBreakdown`: a DLC's hours and `achievements_unlocked` go to the DLC's
  `year`; the DLC's `game_id` is added to that year's `playedGames`; `startedCount` is untouched;
  `unattributedTenths` is untouched (DLC is never attributed). `buildLibrarySummary` loses
  `backlogCount`/`playingCount`; `buildFinancialSummary` loses `backlogCount`/`backlogValueCents`;
  `averagePriceCents` divides total spend by games that have a price on the base OR any DLC
  (builder). Leaderboards and callouts use totals.
- `taxonomy.ts`: two statuses.
- `collections.ts`: unchanged rule; the "member has no figures" statement now covers DLC too.

## Data access (`src/server/db/games/`)

- `dlc.ts` (new): `listDlc(ownerId)`, `listDlcForGame(ownerId, gameId)`, `createDlc`,
  `updateDlcField`, `deleteDlc` — owner-scoped, same shape as `play-years.ts`. `createDlc` refuses
  a `game_id` whose row has a non-null `collection_id`.
- `Game` gains `readonly dlc: readonly GameDlc[]`, loaded the way `playYears` already is, so the
  library grid/table and the panel have it without a second round trip. `GameStatRow` stays scalar;
  the Stats page passes `listDlc(owner)` to the builders beside `listPlayYears(owner)`.

## Server actions

- `dlc-actions.ts` (new, in `src/features/games/`): `createGameDlcAction(gameId, formData)`,
  `updateGameDlcFieldAction(dlcId, field, value)`, `deleteGameDlcAction(dlcId)`. Each calls
  `await requireOwner()` first. Note: `tests/integration/entry-points.test.ts` walks `src/app`
  only, so it does NOT enumerate feature action files (none of the existing Games/Finance/Anime
  action files are counted either). Widening that security test to `src/features/**` is a
  separate task, recorded in the roadmap, not done here; the new actions' own integration test
  asserts each one refuses without an owner. Field schemas mirror
  `GAME_FIELD_SCHEMAS`: `name` (1–300), `year` (1970–2100), `hours` (same parser as the game's),
  `priceDollars`, `achievementsUnlocked`, `achievementsTotal`. `revalidatePath('/games', 'layout')`.
- `completeWishlistGameAction(gameId, formData)` in `game-actions.ts`: parses exactly like
  `createGameAction` (including the play-year split and its checks), then updates the EXISTING row
  with `status = 'played'` and replaces its play years. Refuses if the row is not `wanted`.
- `createGameAction` default status → `played`.

## UI

### Upcoming — wishlist cards

`WishlistSection` renders the same grid as `MonthSection` (`grid-cols-2 … 2xl:grid-cols-5`,
`gap-6`), ordered by `sortWishlist` as today. Each card: the library's `FoilCard` cover with the
wishlist frost treatment; "OUT NOW" as the on-art pill the library card already uses for its
countdown (released games), nothing on-art otherwise; under the cover: title, then
`PS5 · Out now` / `in 11 days` / `Feb 16, 2027` / `No date`, then a small "Mark as played" button.
Clicking the cover opens the panel. The dropdown and the list markup go.

### "Mark as played" → the Add-game dialog in complete mode

`GameDialog` gains `mode: 'create' | 'complete'` with `game: Game` when completing. Complete mode:
title `Marvel's Wolverine` in the dialog heading ("Add to library"), title/platform/cover/
genre/developer/publisher pre-filled from the row (still editable), status control hidden and
fixed to `played`, the rest of the fields empty for the owner to fill, submit calls
`completeWishlistGameAction`. Cancel changes nothing. The dialog's "create-only" doc comment is
rewritten: editing an existing game is still the panel's job; completing a wishlist entry is the
"add to library" moment and belongs here. Where the dialog is mounted for the wishlist is the
builder's call (it is a client component; `WishlistSection` can own one instance and the selected
game).

### Panel

- Header `MetaLine`: `platform · status · N games`; the rating stars are removed from it. The
  editable Rating row stays.
- Progress: unchanged rows, plus when the game has DLC the Hours, Achievements earned/total rows
  show the base value with a muted suffix `· 59h with DLC` (builder; exact wording the builder's).
- **DLC group** (new, after Progress, hidden for a collection member): one compact row per DLC —
  name · year · hours · price · `earned/total` — every cell click-to-edit via the same inline-edit
  controls the rest of the panel uses, a remove control per row (ConfirmDialog, like Remove game),
  an "Add DLC" button that adds a row in edit state with name and year required, and a totals line
  `Total · 59h · $75.98 · 52/66 trophies` under the rows (base + DLC). Empty state: just the
  "Add DLC" button, no explanatory box.
- Details: Price paid row gets the same muted `· $75.98 with DLC` suffix when DLC exists.
- Collection: for a non-member, the `CollectionMembersPanel` is wrapped in a group whose header
  carries a Show/Hide button; collapsed by default when `members.length === 0`, open when it has
  members. The "Part of" picker for a member is unchanged and always visible.
- Notes: group heading only; the field has no row label (`InlineEditField` without `label`, or a
  visually-hidden one for a11y — builder).
- Platinum: a toggle button (`aria-pressed`) with the trophy mark and the word "Platinum", filled
  with the platinum treatment when on, outline when off. Saves on click exactly as the checkbox did.
- Status select: two options.

### Library and Stats

- `GameTable`'s hours and `earned / total` cells show totals via `gameTotals` (it has no price
  column). `GameCard` shows no figures at all and is unchanged.
- Stats: the Backlog card and the "sitting in backlog" hint are removed (the grid has one fewer
  card). "Trophies earned", Library hours, Total spend, Cost per hour, Year by year, the
  trophies-per-year chart, Top 3 and Highlights all include DLC.
- Library filter chips: unchanged (the only status chip is already Wanted).

## Tests

- Unit: `games-dlc.test.ts` (sums, totals, null handling, negative-zero guard), `games-stats`
  (DLC in every builder; year-by-year puts DLC in its own year; started count untouched; two
  statuses), `games-taxonomy`, `games-status-badge`, `games-game-panel` (DLC group, add/edit/
  remove, totals line, hidden for member, platinum toggle, no header stars, collection toggle),
  `games-wishlist-section` (cards, OUT NOW pill, Mark as played opens the dialog), `games-game-dialog`
  (complete mode pre-fill, status hidden, calls the complete action), `games-game-table`/
  `games-game-card` (totals), `games-dashboard` (no Backlog card).
- Integration: `games-dlc.test.ts` (DAL: owner scoping, cascade on game delete, member refusal,
  unique name), `games-dlc-actions.test.ts` (each action refuses without an owner; field
  validation; member refusal surfaces as a field error), `games-actions` (complete action: refuses
  non-wanted, sets played, replaces split), `games.test.ts` (status default, collection refusal
  with DLC).
- The 10 test files that mention `'backlog'`/`'playing'` are updated.
- Real browser (dev server, local DB): wishlist grid at 1440/390, Mark as played round trip,
  DLC add/edit/remove and totals, panel at 390px still `scrollWidth === 390`.

## Docs

`docs/GAMES.md`: new "DLC" section (additive model, why not attribution, member rule, year =
played year), "Lifecycle statuses" rewritten for two states, panel section updated, wishlist
section updated for cards and the complete flow. `CLAUDE.md`: the collections gotcha gains the
DLC clause; the statuses sentence in GAMES.md's summary. `docs/DEPLOYMENT.md`: the migration
split and the IF EXISTS note. `docs/ROADMAP.md` + `docs/HANDOFF.md`: the new production
sequence. `docs/superpowers/specs/` keeps this file.

## Left to the builder

- Exact inline-edit control composition for a five-cell DLC row at 390px (wrap or two lines).
- Whether `GameDialog`'s complete mode reuses its form state via props or a key reset.
- Wording of the muted "with DLC" suffixes and the totals line.
- Whether `Game.dlc` is loaded with a second query grouped in JS (as `playYears`) or a lateral join.
