# Games Domain Reference

The rules that make the library correct. When implementation and this document disagree, one of them
is a bug — resolve it, do not paper over it.

---

## The problem being solved

The owner maintained a manual Google Sheet — "Game log" — one row per game, with an hours cell that
sometimes read `"53 + 6"` (53 hours on the base game, 6 more on the DLC, kept visually separate only
so a hand-typed yearly rollup stayed readable) and a separate Year → Games/Hours/Trophies rollup table
computed by hand off to the side.

That rollup had **already drifted out of sync with its own rows by the time it was read** — two
copies of the table in the sheet disagreed with each other. Nobody had touched the formula; the rows
had simply been edited enough times, over enough years, that the hand-maintained summary quietly
stopped matching the data it was supposed to summarize, and nothing would have surfaced that short of
re-adding every row by hand.

Burmy replaces the rollup with a read-time computation and replaces the row data with a one-time
import (`scripts/import-game-log.mjs` — a one-off script, run manually once, never wired into any
product flow or committed as a feature, the same shape as Finance's historical-data scripts).

**Governing invariant: the library is the only source of truth.** Every stat, chart and rollup shown
to the owner is derived from `games` rows at read time. No total, count or year-over-year figure is
ever stored — see "Computed aggregates" below for why that is the module's central design decision,
not an incidental one.

---

## Data model

### The `games` table

One row per game owned, wanted, or played — replacing one line of the spreadsheet. Only `title` and
`platform` are required (`platform` defaults to `other`, `status` to `played`); every other column is
nullable, and a bare entry with nothing else filled in is legitimate data, not an incomplete
row. Pre-2015 PSP/PS2 entries in the source spreadsheet routinely carry a rating and nothing else —
`firstPlayedYear` is genuinely sparse, and that sparseness is preserved rather than backfilled with a
guess.

| Column | Type | Notes |
| --- | --- | --- |
| `title` | text, not null | |
| `platform` | enum, not null, default `other` | `ps5 \| ps4 \| psp \| steam \| pc \| other`. `pc` is displayed as "PC" but is no longer OFFERED in the add/edit picker — see below |
| `developer`, `publisher` | text | |
| `ownership` | enum, nullable | `physical \| digital` |
| `price_cents` | signed bigint | Same convention as `finance_transactions.amount_cents`. No FK to Finance — see "Out of scope" |
| `status` | enum, not null, default `played` | App-reachable: `played \| wanted`. The Postgres type also still contains `backlog`, `playing` and `paused_dropped`, dead labels kept only because Postgres cannot drop an enum value — see "Lifecycle statuses" below |
| `rating` | smallint, nullable | 1–5. Null means "no opinion yet," not zero |
| `hours_tenths` | integer, nullable | Tenths of an hour. 235 = 23.5h. See "Hours" below. The authoritative total — see "Play-year attribution" below for how it's optionally split across years |
| `first_played_year` | smallint, nullable | Sparse by design. Also where hours land by default when no `game_play_years` split exists — see "Play-year attribution" below |
| `achievements_unlocked`, `achievements_total` | smallint, nullable | Counts, not a checklist — see below |
| `cover_url`, `genre` | text, nullable | Populated by hand or from an IGDB suggestion |
| `platinum` | boolean, not null, default `false` | The owner's own claim, not derived from achievement counts — see "Platinum" below |
| `metacritic` | smallint, nullable | IGDB's `aggregated_rating`. Read-only, filled only from a metadata suggestion |
| `average_playtime_hours` | smallint, nullable | IGDB's `game_time_to_beats.normally`, whole hours. A third-party estimate, not the owner's measured time — deliberately not tenths |
| `esrb_rating` | text, nullable | Read-only, filled only from a metadata suggestion |
| `notes` | text, nullable | Free text — carries nuance the schema deliberately doesn't model, e.g. "6h of that was the DLC" |
| `collection_id` | uuid, nullable, FK → `games.id` `ON DELETE SET NULL` | The boxed set this title belongs to. Null for a standalone game AND for a collection row itself — see "Collections" below |

**Uniqueness is case-insensitive per platform**: `(owner_id, lower(title), platform)`. The same title
legitimately appears twice when replayed on a different platform — `Uncharted 4` on PS4 and again on
PS5 are two real rows — but twice on the *same* platform is always a duplicate entry, and the database
enforces that rather than trusting the application to catch it.

### Taxonomy lives apart from data access, on purpose

`GAME_PLATFORMS`, `GAME_OWNERSHIPS`, `GAME_STATUSES` and their display-label maps
(`PLATFORM_LABELS`, `OWNERSHIP_LABELS`, `STATUS_LABELS`) live in `src/server/games/taxonomy.ts` — a
plain, dependency-free module — rather than in `src/server/db/games/games.ts` where the enums are
actually used to type columns. This is a deliberate boundary, not an oversight: a client component
(the add/edit form's platform `<Select>`, a status filter chip) needs these const tuples and label
maps directly, and importing them from the data-access layer would drag `getDb()`/drizzle into the
browser bundle along with them. It is the kind of file someone "tidies up" by merging into the DAL —
don't; the split is what keeps the browser bundle server-code-free.

`PLATFORM_LABELS.steam` reads **"Steam / PC"** — the owner's library has zero `pc` rows in practice
(Steam covers the whole PC library), and `PLATFORM_PICKER_OPTIONS` (`GAME_PLATFORMS` minus `pc`) is
what the add/edit dialog's platform picker actually offers, so a new game can never be filed under a
category that would only duplicate it. `pc` itself is untouched in the enum, the type, and
`PLATFORM_LABELS` (still plain "PC") — dropping a Postgres enum value needs a migration for zero real
rows of benefit, and a hypothetical existing `pc` row must still resolve to a real label rather than
an `undefined` `Record` lookup. The library's filter chips go one step further: a status or platform
with zero games in the library renders no chip at all (not even an inactive, greyed-out "PC 0") —
`LibraryView` filters `GAME_STATUSES`/`GAME_PLATFORMS` down to values with a nonzero count before
mapping them to chips.

### Hours are one number, stored as tenths — never a float

The source spreadsheet's hours cell held values like `0.7` and `532.8`, and summing those as plain
JavaScript numbers reintroduces exactly the bug `finance/money.ts` exists to prevent:
`0.1 + 0.2 !== 0.3`, inside a module whose headline stat is a lifetime hours total. `hours_tenths` is
an integer count of tenths instead, and `src/server/games/hours.ts` is the **only** module that
converts between owner-typed text and the stored integer — the same containment rule `money.ts`
enforces for cents:

```
fromHoursInput("23.5")  -> Hours(235)     -- owner-typed text to tenths, null on anything non-numeric or negative
formatHours(Hours(235)) -> "23.5h"        -- the decimal only appears when it carries information ("53h", not "53.0h")
sumHours([...])         -> Hours          -- exact integer sum, no float ever touches a total
```

`Hours` is a branded `number` (`hours(tenths)` throws if `tenths` is not a whole number), so a caller
cannot pass a raw float in from somewhere else in the codebase and have it typecheck.

Also worth noting from the source data: "53 + 6" in the spreadsheet was never a session log — it meant
"53 hours on the base game, 6 more on the DLC," visually separated only for a human rollup. A
`play_sessions` child table was considered while planning this module and rejected for the same
reason Finance never modeled receipt line items for restaurant tips: the owner logs one number, once,
by hand, and `notes` carries the DLC nuance in plain language instead of a schema.

### Price is independent of Finance, on purpose

`price_cents` uses the same signed-bigint-of-cents convention as `finance_transactions.amount_cents`,
because there was no reason to invent a second money representation. That is where the resemblance
ends: no Games table carries a foreign key into any `finance_*` table, no Games code imports anything
from `src/server/finance/`, and the price a game cost is never reconciled against, subtracted from, or
cross-referenced with an actual purchase transaction. See "Out of scope" below.

### Achievements are a count, not a checklist

`achievements_unlocked` / `achievements_total` are two `smallint` columns, filled in by hand. There is
no per-achievement child table anywhere in the schema — the source spreadsheet's "Trophies" column was
always a single number, never a list, and the module doesn't invent structure the data never had.

### Platinum is the owner's own claim by hand

`platinum` is a plain `boolean`, edited via a toggle button — not computed from
`achievementsUnlocked === achievementsTotal`. The source spreadsheet only ever recorded trophies
*earned*, never the total, so a platinum could not be derived for any imported game; and on Steam,
100% achievements is not a platinum at all. (From late August to 2026-10-18 a PSN sync owned this flag
for PSN-linked games; that sync is gone and the toggle is the only writer again.)

In the panel the toggle (`aria-pressed`, reading "Earned" / "Not earned" beside the Platinum label —
the checkbox it replaced was the smallest control in the panel for the one fact worth showing off)
saves on every click through `updateGameFieldAction('platinum', …)`, with an empty value meaning
"off", so a platinum once set can always be turned back off. `createGameAction`
writes it unconditionally because an unchecked HTML checkbox submits no key in `FormData` at all.

**Earning it fills the count.** Toggling Platinum on also sets `achievements_unlocked` to
`achievements_total` — when a total is known; with none there is nothing to fill up to — because a
platinum means every trophy is earned (owner, 2026-10-19: "the trophies earned should automatically
change to total"). Toggling it off changes nothing else: taking the platinum back says nothing about
how many were earned. The flag itself stays a plain stored claim, not a derivation, for the reasons
above.

---

## Collections

A boxed set — "Uncharted: The Nathan Drake Collection" — is **one purchase wrapping several games the
owner counts separately**. The source spreadsheet drew it as one row with its titles indented beneath,
and this is that shape restored.

### One nullable self-reference, one level deep

`games.collection_id` is a nullable `uuid` referencing `games.id`, `ON DELETE SET NULL`, with a partial
index on `(owner_id, collection_id) WHERE collection_id IS NOT NULL`. It is `NULL` for a standalone
game **and** for a collection row itself — a row is a collection exactly when some other row names it,
never because of a stored flag. There is no `collections` table: a boxed set has a cover, a platform, a
price, a play time and a trophy list, which is precisely a `games` row.

**Deleting a collection does not delete its games.** `SET NULL`, not `CASCADE` — the titles inside are
real games the owner counted, and the wrapper going away must leave three standalone entries, not a
hole in the library.

**Nesting is one level, and three rules enforce it** (`assertCollectionTargetValid`,
`src/server/db/games/games.ts`): a row cannot be its own collection; a collection that is itself inside
one is refused; and a row that already holds members cannot become a member. `listCollectionOptions`
offers exactly the set that will be accepted, so the picker can never present a choice the server
rejects. Every write path goes through the same check, including the table's multi-select — a backfill
that skipped it is how a two-level chain no view can render would get into the database.

### The counting rule, in one sentence

> Anything that counts GAMES excludes collection rows. Anything that sums HOURS, MONEY or TROPHIES
> includes everything.

`src/server/games/collections.ts` is the only home for it (`collectionIdsIn`, `countableGames`,
`groupByCollection`) — pure TypeScript, same framework-free boundary as `stats.ts`, which imports it.

Money needs no rule at all, and that is the point: a title inside a collection carries `NULL` price (one
boxed set was one purchase), so every existing `SUM` and `reduce` already excludes it for free. Only the
COUNTS need the filter, which is why it is applied at a few named call sites rather than at the read
boundary the way `wanted` is — filtering collections out in `listGameStatRows` would take their money
with them. Hours and trophies ROLL UP from the members instead (next section), and every stat reads
them through `collectionAdjustedRows` at that same boundary so nothing is counted twice.

Applied in: `buildLibrarySummary` (`totalGames`, `playedCount`), `buildYearlyBreakdown`
(`startedCount`), the dashboard's
platform and genre distributions, and the Library header's own game count. **Not** applied to the
ownership distribution — that follows the purchase, and one boxed set was one physical or digital
thing. `playedCount` in the yearly breakdown likewise counts the collection once rather than once per
title: hours are attributed to the row that carries them.

### Where the figures live

**Price and ownership** are the set's: one purchase, one figure on the collection row. The panel renders
those two read-only for a member, with the hint "From the collection".

**Rating is the individual title's only.** A collection has no rating of its own (owner, 2026-10-19):
the panel and the table show no rating row for a collection, `updateGameFieldAction` refuses one, and
the average rating and the rating leaderboard run over the countable games. The ratings the sheet
import had left on the wrapper rows were nulled in the 2026-10-19 reconciliation.

**Hours and trophies are the individual title's.** A member carries its own hours (with its own year
split and its own DLC, like any game) and its own trophies, and the collection reports the SUM of what
its members carry — `rollUpHours` and `rollUpTrophies` in `src/server/games/collections.ts`, one
precedence rule for both: if any member carries the figure, the collection's own stored value is
superseded and ignored; while no member carries it, the collection's own lump is shown and labelled as
covering the whole set ("unsplit"). That fallback is what keeps the two Uncharted sets honest — they
were imported as one lump each with no per-game figure anywhere, and stay that way until the owner
types hours on a member. Hours joined trophies in this rule on 2026-10-19 at the owner's request ("I
feel like hours should be individual"); before that a member carried `NULL` hours by design. The
collection's panel shows the rolled-up Hours and Achievements rows read-only ("Added up from the games
in this collection") and First played alone in place of the year rows; the table shows the same
roll-up on the collection's row. Every stat reads through `collectionAdjustedRows`, which nulls a
rolled-up collection's own hours and trophies so the members are counted exactly once.

Taking a game back out of a collection keeps whatever it carried itself and does **not** hand it the
price or an unsplit lump — those were never its own, which is also what `ON DELETE SET NULL` does when
the collection is deleted.

### How the two views render it

The **table** indents members under their collection, which is literally the spreadsheet layout, and
marks the wrapper "3 games". The indent is CSS and says nothing to a screen reader, so a nested row's
button carries an explicit `aria-label` of `"<title> — in <collection>"` — an `sr-only` span beside the
title does not work here, because an accessible name is computed by concatenating child nodes with each
one **trimmed**, which glues the separator to the title ("Remastered— in …").

The **gallery** gives a collection one card with a "3 games" pill and gives its titles no card at all.
Those titles have no cover art and never will — IGDB has art for the collection, not for a remaster that
only ships inside one — so cards for them would be three letter-tiles in a wall of box art. Reading the
titles inside a set is what table view is for. A search that matches a member still surfaces the
collection's card (`LibraryView` keeps a group when the collection **or** any title inside it matches),
so the gallery never silently has nothing for a title the owner typed.

### Linking an already-imported library

`scripts/import-game-log.mjs` wrote every spreadsheet row — including every sparse sub-row — as an
independent `games` row, because the CSV export had already lost the indentation. The relationship has
to be re-stated once, by hand, and that happens in the app: a collection's panel has "Add games"
(`CollectionMembersPanel`), a member's panel has "Part of" (`CollectionField`), and the table's
multi-select files several rows at once. Each path writes `collection_id` and **nothing else** — a
member that carries its own hours, price or trophies keeps them, and the roll-up simply reads the sum.
A CLI with a JSON map (`link-game-collections.mjs`) existed for this until 2026-10-18 and was removed
with the sync tooling; the app's three paths cover a library of this size.

A title the importer flattened into the sheet's one-line form — "Nathan Drake Collection - Uncharted:
Drake's Fortune" — is fixed by hand too: create the collection, rename the row to its own title, file
it. `scripts/diff-game-log.mjs` flags such rows as `possible flattened collection` in its report so
none is missed.

---

## Play-year attribution

`first_played_year` was doing two unrelated jobs: "when did I start this" and "which year owns
these hours." For almost every game those coincide. For a game played across a year boundary they
do not, and crediting every hour to the start year is wrong. (The spreadsheet's `"53 + 6"` rows
were this at first; they turned out to mean base game + DLC and became DLC rows on 2026-10-18 — see
"DLC" below. The split stays for a BASE game genuinely played across two years.)

### The `game_play_years` table

One row per "I played N hours of this game in year Y" (migration `drizzle/0007_nervous_kid_colt.sql`).

| Column | Type | Notes |
| --- | --- | --- |
| `owner_id` | text, not null, FK → `user`, `ON DELETE CASCADE` | |
| `game_id` | uuid, not null, FK → `games`, `ON DELETE CASCADE` | |
| `year` | smallint, not null | |
| `hours_tenths` | integer, not null | Same tenths-of-an-hour convention as `games.hours_tenths` |

Unique on `(game_id, year)` — a game cannot have two rows claiming the same year.

**`games.hours_tenths` remains the authoritative total. These rows are an attribution OF that total,
never a replacement for it.** That distinction is load-bearing, not stylistic: the total is the one number the owner edits (and, until
2026-10-18, the one number a platform sync could write), while the split only says which years. A game with **no** `game_play_years` rows
attributes everything to `first_played_year` — the behaviour every game already had before this
feature existed, which is why only 3 of 160 games needed anything backfilled (see "Seeding the three
known splits" below).

### The split must sum to the total, or it shows up as a visible gap

`attributeHours` (`src/server/games/play-years.ts` — pure TypeScript, no React, no Next, no
database, same boundary rule as the rest of `src/server/games/`) turns `games` rows plus
`game_play_years` rows into a per-year attribution. When a split's rows don't sum to the game's
`hours_tenths` — the usual cause is the total being edited after the split was —
the shortfall (or overshoot) is accumulated into `unattributedTenths` and rendered as its own
"Unattributed" line in the Year by year table (`YearlyBreakdownTable`), never silently absorbed into
a year and never silently dropped. A negative `unattributedTenths` means the split overshoots the
total; the table renders that with a minus sign rather than hiding it.

`validateSplit` runs the same total-vs-split check at edit time, in the `PlayYearsPanel` (a
collapsed-by-default "Split across years" toggle in the add/edit dialog — used by roughly 3 games
out of 160, so it stays out of the way for everyone else) and again server-side in
`createGameAction`/`updateGameAction`. `findDuplicateYear` rejects two rows claiming the same year
in one submission. Both checks run **before either write is attempted** — before `createGame`/
`updateGame` and before `replacePlayYears` — so a mismatched or duplicated split is refused as a
plain field error and never reaches the database, rather than relying on the table's own
`(game_id, year)` unique index to refuse it after the game row has already been committed.

The game row and the split are still two separate writes, not one transaction: `replacePlayYears`
(`src/server/db/games/play-years.ts`) deletes and re-inserts a game's rows inside its own
transaction, but that transaction is separate from the `createGame`/`updateGame` call just before
it. The duplicate-year and sum checks above remove the only reachable way the split write could fail
in normal operation, so closing that window for real would mean widening `createGame`/`updateGame`
to accept play years directly — for a gap that now requires an actual mid-request database fault to
hit at all. If `replacePlayYears` does throw, the game row has already been saved; the action
catches it and reports a field error rather than crashing, which is defense-in-depth, not a rollback.

### Base achievements are not split

`buildYearlyBreakdown` attributes hours per year but leaves a game's own achievements on
`first_played_year`, unconditionally. No source records which year a base-game trophy was earned in,
so splitting them proportionally across a game's played years would fabricate data the owner never
entered. A DLC's trophies are different: they are recorded ON the DLC row, which has a year, and
land in that year — see "DLC" below.

### Seeding the three known splits (superseded)

`scripts/seed-play-year-splits.mjs` promoted the only three games whose year split existed anywhere
— as prose in `notes` (e.g. "Imported as \"53 + 6\" across 2025 + 2026") — into real rows: Clair
Obscur: Expedition 33 (2025/53h + 2026/6h), Hollow Knight (2024/37h + 2025/12h), and Lies of P
(2024/52h + 2025/25h). Dry-run by default, `--apply` to write, and it re-verifies each split against
the game's *current* `hours_tenths` before writing — a hand-recovered split that no longer sums to
the live total is refused, not force-written. A one-off script rather than a SQL data migration for
the same reason `fix-game-platforms.mjs` gives: migrations run against both local and production,
where `games.id` values differ, and a title-keyed write inside a migration is fragile.

All three turned out to be base + DLC, not two years of the base game, and on 2026-10-18 the owner
had them converted: `scripts/convert-split-to-dlc.mjs` (pure, same shape as `diff-game-log.mjs`)
emits the SQL that inserts a `game_dlc` row named `DLC` with the moved year and hours, lowers the base
`hours_tenths` by that amount, and deletes the split. The owner renames the placeholder and fills the
DLC's trophies and price in the panel.

---

## DLC

A DLC is a row on the game it extends (`game_dlc`): name, the year the owner PLAYED it, hours, price
paid, trophies earned and trophies total.

**Additive, never attributed.** The game's own `hours_tenths`, `price_cents` and achievement counts
are the BASE GAME's figures and stay the numbers the owner edits. A DLC row carries its own, and every
total the app shows outside the panel — the library table, every Stats card, the leaderboards, cost
per hour — is base + every DLC row, computed at read time by `gameTotals` in
`src/server/games/dlc.ts`. Nothing has to "add up" to anything; that is the whole difference from the
year split above, which apportions the base total and must sum to it. The owner first chose an
attribution model for DLC and then reversed it: base and DLC figures are two things they record
separately, and a total is what they want to read.

**Year-by-year.** A DLC's hours and trophies are credited to the DLC's own year. It does not count as
a game *started* (`startedCount` is untouched), but its year counts as a year the game was *played*
(`playedCount`). `unattributedTenths` never includes DLC — DLC is not attributed.

**Collections.** A title inside a collection carries its own hours and trophies, so it carries its own
DLC too — the grid is on every game's panel. (Until 2026-10-19 a member carried no hours and the DAL
refused DLC on one; both refusals went with that rule.) A collection gets hours and trophies from its
MEMBERS (`rollUpHours`, `rollUpTrophies`), so a collection's own DLC adds on top of that roll-up:
`gameTotals` is applied after `collectionAdjustedRows`, never before. One rule throughout: DLC
adds to whatever row it is on.

**Nulls stay null.** `sumDlc` returns `null` for a figure no row carries, and `gameTotals` returns
`null` only when both the base and the DLC side are null — a `0` would read as "tracked, and zero",
a different fact from "never recorded", which `stats.ts` already keeps apart for the base figures.

**In the panel** the parts are rows like every other row (`panel/dlc-grid.tsx`): "Base game" and
each DLC's name sit in the grey label column, and their figures line up in the value column under
one small header (Year, Hours, Price, Trophies), so every number has a column heading above it and a
part name beside it — "three more rows", not a separate box. The base game's Year IS First played:
the same column, shown in both places, saved through the same field. Every cell is click-to-edit
in place; nothing opens a modal. A DLC cell saves the WHOLE row (`updateGameDlcAction`, with that
one cell changed; a figure left blank is cleared; name and year can never be blank); a base-game
cell goes through the ordinary per-field action. An x on each DLC row removes it behind a confirm,
and "+ Add DLC" is a plain text line that turns into an inline name + year row saved with a tick
(`createGameDlcAction`). The grid exists only while the game has DLC (or one is being added): with
none, the panel's own rows ARE the base game and "+ Add DLC" is all that shows. While a game has
DLC, the Hours, Price paid and Achievements rows show base + DLC and are read-only — the base is
edited in the grid, so there is one number in one place and never a "… with DLC" suffix. A DLC
name is unique per game, case-insensitively — two of the same name is a typo, not detail. (Two
earlier versions — inline cells on one line, then a small dialog — were rejected on sight: "too
compact", "a modal, the user should remain on the panel", "random numbers, hard to tell what's
what".)

---

## Library order, Sort and the drag

**"My order" is a hand order, seeded from the sheet.** `games.sort_order` holds a position and `0`
means "unplaced". `listGames` orders by `sort_order` first and only then by the sheet keys (shelf →
wanted → first-played year → title), so a library nobody has dragged reads exactly as the sheet did,
and the first drop writes an explicit `1..n` onto every top-level row (`reorderGames`, one statement
inside a transaction that refuses a list not matching the owner's rows one for one). A new game is
inserted at `min(sort_order) − 1` — the top, by the owner's choice. "Reset order" (a quiet line under
the filter bar, shown only once something has been placed) writes `0` everywhere, behind a confirm.
No migration: the column had existed, unused, since the Finance-era schema. Members carry a position
too but it is never read; `groupByCollection` files them under their set in input order.

**The gallery's drag is its own engine** (`library/grid-drag.ts` + the pure `grid-drag-math.ts`,
2026-10-19). It was dnd-kit for a day: dnd-kit re-renders every sortable item through React on every
pointer move and re-measures all of them at lift, which on 181 cards was a 250ms stall on the press,
another when the first card shifted, and a card trailing the pointer — "snappy", and the owner asked
for instant and smooth. The gallery is a UNIFORM grid, which makes the drag arithmetic: the pressed
card itself follows the pointer by an inline transform written in a `requestAnimationFrame` loop,
with no React work per move; the slot under its centre is a formula of the grid measured once at
lift; when that slot changes, only the cards between the hole and the target get a transform (a
zero `translate3d` on the other 170 is what promoted 182 compositor layers in one frame under
dnd-kit — measured, and the cause of the snap). The drop glides the card into its slot, commits the
order in one React update, and a layout effect clears the transforms before the next paint so nothing
jumps. A mouse or pen lifts after 3px (a click still opens the panel); a touch lifts after a 150ms
hold, and a finger that moves first is a scroll; once lifted, `touchmove` is cancelled so the page
stops scrolling under the finger, and the page creeps when the card nears the top or bottom edge.
The keyboard lifts with Space, moves with the arrows, drops with Space or Enter, cancels with
Escape, with an `aria-live` announcement each step. Covers are `draggable={false}` and the card
refuses `dragstart`: a few pixels of movement over an `<img>` otherwise begins the browser's own
drag of the thumbnail and cancels the pointer events the engine runs on — the first card with art
simply would not move.

**The table keeps dnd-kit** (`@dnd-kit/core` + `sortable`): a grip handle at the row start, the set
and its indented titles as one unit, and NO row-shift animation — rows are `<tr>`s and CSS
transforms on table rows are unreliable across browsers, so feedback is the ghost line in hand plus
a 2px inset line on the row the drop would land beside. 181 rows re-rendering per move is fine there
because nothing animates; the gallery is where it was not.

Drag is enabled exactly in My order with no filter or search active — a drop between two cards of
a partial list has no clear meaning for the games off screen — and the line under the bar says
"Clear the filters to reorder." when that is why it is off. The drop is optimistic: the cards move
at once, the action runs behind, and a failure restores the previous order with a toast
(`moveTopLevel` runs on the FULL top-level list, hidden wanted rows included, so they keep their
relative place).

**CSP.** Both engines write inline `style` attributes (transform, transition) and inject no `<style>`
element — dnd-kit verified by grepping the three packages on install — so they live inside the
existing `style-src-attr 'unsafe-inline'` exception and never touch the nonce-only `style-src`.

**Sort and the two newer filters** are pure rules in `src/server/games/library-order.ts`. Sort —
My order, Year, Hours, Rating, Title, Trophies — is a read-only view of the same list and never
rewrites a position; numeric sorts are descending with the untracked rows last and the title as the
tie-break, and a collection sorts on the figure it SHOWS (members rolled up, then its own DLC on
top), with no rating of its own so last on the rating sort. Year (the years present, newest first,
plus "No year") and Rating (5 stars, 4+ … 1+, Unrated) are selects, past the handful-of-options line
that makes a filter a chip; they sit on the filter side of the bar with search and the chips, while
Sort sits on the right beside the Gallery/Table toggle — display controls together, the same
left/right split Finance keeps.

---

## Lifecycle statuses

Two states. One visible, one invisible:

| Status | Meaning |
| --- | --- |
| `played` | In the library — the **invisible default**: `StatusBadge` renders no badge at all for it, in either variant |
| `wanted` | Wishlisted, not bought yet — see "Upcoming games" below |

**Real usage is why `played` renders nothing.** Of 180 games, 171 sat in this one status (then called
`completed`) — a status describing 95% of the library carries no information, so as of migration
`0013` it is the library's *default assumption* rather than a badge to scan past on every card.
`played` is a deliberate non-null SENTINEL, not a nullable column: modelling "no status" as `NULL`
would turn every `WHERE status = …`, every count, and the `wanted` exclusion below into null-aware SQL,
real bug surface for what stays a plain non-null comparison everywhere else.

**`backlog` and `playing` were removed on 2026-10-18**, by owner decision after seven weeks of real
use: "there is no backlog — just played and wanted." They covered six games and one game. The Stats
Backlog card and its "sitting in backlog" hint went with them; a new game defaults to `played`.
Migration `0019` moved every row that held either status to `played`, except Control Resonant,
which the owner put back on the wishlist by hand.

**The word "played" never appears in the UI.** There is no Status row in the panel, no Status column
in the table, no status in a played card's accessible name, and no Status select in the add dialog —
the one choice a new game offers is a checkbox, "Add to wishlist instead". The only transition is
wanted → played, and it is called "Add to library" everywhere (the wishlist card, the panel header),
opening the add dialog pre-filled (see "Your wishlist"). A wishlisted game shows a "Wanted" pill in
the panel header and on its library chip; a played game shows nothing, because it is the default.

**`paused_dropped`, `backlog` and `playing` still exist in the Postgres `game_status` type, but are
unreachable from the app.** Postgres has no `DROP VALUE` for an enum — removing a label would mean
creating a new type, swapping the column, and re-pointing the default and its indexes, a fiddly
migration for values nothing ever writes. They were removed from `GAME_STATUSES`
(`src/server/games/taxonomy.ts`) instead, which is what every picker, filter and
`Record<GameStatus, …>` map in the app actually iterates — the dead labels in Postgres are inert.
Whatever the owner wants to say about a game they started and set aside is a sentence in `notes`,
not a schema decision.

**`wanted` is excluded from every computed number**, in exactly one place: `listGameStatRows`
(`src/server/db/games/games.ts`) filters it out at the query boundary. The stat functions were
deliberately NOT each given their own filter — several rules is several chances to forget one, and a
stat function added later would silently miss it. Filtering at the read boundary makes every present
and future stat correct by construction. A wishlisted game is also hidden from the Library screen
unless its own chip is active.

**The gallery pins and enlarges nothing.** It once sorted `playing` games first and gave them a
larger card; neither the treatment nor the status exists any more. The gallery renders one uniform
card per row, in the order `listGames` already sorted by — the owner's own hand order, seeded from
the original sheet (see "Library order, Sort and the drag"): the PlayStation shelf first with PS5 and
PS4 together, then PSP, then Steam/PC; inside a shelf a wanted game at the top, then newest
first-played year first, the year-less retro rows at the bottom, title breaking ties — until a card
is dragged somewhere else. Editing a game does not move it; a new one lands at the top.

---

## Computed aggregates — nothing is ever stored

`src/server/games/stats.ts` is pure TypeScript — no React, no Next, no database — the same boundary
rule `src/server/finance/` follows, for the same reason: a rollup you can compute and test without a
browser or a server is a rollup you can trust.

**The motivating failure is the spreadsheet's own rollup**, described above: a hand-maintained Year →
Games/Hours/Trophies summary that had silently drifted out of sync with the rows underneath it, to the
point where two copies of the table in the same sheet disagreed with each other. That is the exact
failure mode this module makes structurally impossible — every number the Games dashboard shows is
recomputed from the current `games` rows on every render, so there is no second copy of any total that
could ever fall out of sync with the first.

The stats layer exposes pure functions, all taking `GameStatRow[]` (a narrower projection of `Game`
— no `notes` or `coverUrl`, since nothing downstream needs them; `priceCents` **is** included, for
the money figures below) as their first argument, and every one of them also takes the owner's
`game_dlc` rows, because every figure below is base + DLC (see "DLC"). `buildYearlyBreakdown`
additionally takes the `game_play_years` rows, and `findCallouts` takes `buildYearlyBreakdown`'s own
output — see below and "Play-year attribution" above.

- **`buildLibrarySummary`** — total games, total hours, played count, average
  rating (mean of rated games only — unrated games don't pull the average toward zero), platinum
  count, average hours per game (mean over games that HAVE hours logged, not counting an unplayed
  entry as a zero), and average Metacritic (mean over games that have one). There is no
  completion rate: with `completed`/`paused_dropped` gone, `completed / (completed + paused_dropped)`
  has no definition — the old figure was already misleading, pinning to 100% whenever nothing was
  marked dropped regardless of backlog size.
- **`buildFinancialSummary`** — total spend, average price per game (mean over games with a price
  recorded — on the base OR any DLC), and cost per hour played (total spend ÷ total WHOLE hours, not
  tenths). The backlog count and "money sitting in the backlog" went with the `backlog` status.
  Every average here follows the same "exclude, don't zero-fill" rule as `averageRating` above, and
  every ratio guards its own zero denominator to return `null` rather than `NaN` or `Infinity`.
- **`buildYearlyBreakdown`** — returns `{ rows, unattributedTenths }`. One row per year present in
  the data, newest first, each carrying `startedCount` (games whose `firstPlayedYear` is that year —
  sums to the library total across years, same as the old plain game count did), `playedCount`
  (distinct games with hours *attributed* to that year via `attributeHours` — deliberately does NOT
  sum to the total, since a game played across two years is genuinely played in both), hours,
  achievements (still keyed to `firstPlayedYear`, never split — see "Play-year attribution" above),
  and the hours delta from the previous year present (`null` for the earliest year). A game with no
  `firstPlayedYear` — a retro entry — is **excluded from this breakdown entirely**, not bucketed into
  a fake "year zero": it genuinely has no place in a year-by-year comparison. `unattributedTenths` is
  rendered as its own "Unattributed" line by `YearlyBreakdownTable`, never folded into a year.
- **`buildDistribution`** — a generic key/label counter used three times on the dashboard (platform,
  ownership, genre). Its `percent` is the share of rows that actually *had* a value for that key, not
  a share of the whole library — a game with no genre recorded doesn't silently deflate every genre's
  percentage.
- **`findCallouts`** — longest game and top developer by total hours, each computed over played games
  only (`hoursTenths > 0`), neither year-scoped. `bestYear` takes `buildYearlyBreakdown`'s own
  `YearlyBreakdownRow[]` and picks the max by `hoursTenths`, rather than building a second, independent
  year→hours map off `firstPlayedYear`. An earlier version did build that second map, crediting a
  game's *full* total to a single year — the same bug play-year attribution exists to fix everywhere
  else — and the two callers disagreed: the callout read 591.7h for 2024 while the table, going
  through `attributeHours`, read 579.7h for the same year and the same library. One attribution
  implementation now, not two kept in sync by hand.

`src/server/games/money.ts` is the Games-side sibling of `finance/money.ts`'s formatting half — a
single pure `formatPriceCents` — used only for display of the money figures above. It is NOT imported
from Finance (Games never imports Finance code, full stop); it exists because `priceCents` uses the
same signed-cents convention independently, as already documented under "Price is independent of
Finance" above.

The dashboard (`GamesDashboard`, `/games/stats`) is seven `Section`s holding eight stat cards in
total — **Library** (Games, Hours played, Platinums, Backlog) and **Money** (Total spend, Cost per
hour) — followed by **Year by year** (the Yearly Breakdown table), a **Trends** section of three line
charts (games / hours / trophies per year — a continuous year axis reads as a trend on a line the way
disconnected bars don't; matches the owner's original spreadsheet, which kept exactly these three as
line charts), a **Breakdown** section of four charts (platform / ownership / genre distribution, rating
distribution), a **Top 3** section of four leaderboard cards (most played, highest rated, most
trophies, best value), and a two-card **Highlights** section (most-played developer, best year). There
is no separate "Ratings & achievements" row: average rating and average Metacritic ride as a hint on
the Games card, and average hours per game as a hint on Hours played — a number that only qualifies
another lives in that card's `hint`, never as a card of its own — and there is no completion rate card
at all, for the reason given just above. Nothing on that page reads a stored total anywhere.

---

## Cover art — IGDB, and its soft-failure contract

### Why IGDB and not RAWG

RAWG was the original choice (see git history for the section this replaced), on the reasoning that a
single static API key beat provisioning a Twitch developer application for OAuth. Real usage against
the 160-game library exposed two problems serious enough to reverse that decision:

1. **RAWG has no portrait cover art anywhere in its data model.** `background_image` is a 1280x720
   landscape still. The card frame is `aspect-[3/4]` (portrait), so every cover rendered stretched and
   badly cropped — confirmed live by testing roughly a dozen crop/resize dimension pairs against
   `media.rawg.io`, all of which 404 for a portrait output. There is no fix on RAWG's side; its resize
   CDN only serves a small whitelist of pre-generated landscape-ish sizes.
2. **RAWG's *search* response silently omits `developers`/`publishers` entirely** — not merely empty,
   the keys don't exist on that endpoint. The app's one-call design read them anyway and always got
   `null`, for every real search, from day one.

IGDB fixes both, and does most of it in one call: `cover.image_id` resolves to genuine portrait art
(`t_cover_big`, 264x352 — confirmed live by downloading real bytes and parsing JPEG SOF headers, not
by trusting the URL naming convention), and `involved_companies.company.name` with its own
`.developer`/`.publisher` boolean flags expands the actual company names inline, no second request
needed. The OAuth lifecycle RAWG was chosen to avoid turned out to be the smaller cost — see
`metadata-api-comparison.md` under `.superpowers/sdd/2026-08-20-game-tracker/` for the full comparison
against SteamGridDB, TheGamesDB, Giant Bomb and MobyGames.

### Two HTTP endpoints, one boundary file

`src/server/db/games/igdb.ts` (`searchGames`) is the **only** place in the Games module that makes a
network request — now three requests in the worst case, all from this one file: a Twitch
client-credentials token exchange (cached in module scope for its ~64-day life, refreshed on a 401 in
case a cached token was invalidated server-side before its stated expiry), a POST to IGDB's `/v4/games`
for the primary search, and a POST to `/v4/game_time_to_beats` for the average-playtime figure.

The playtime call is *separate*, not a field on the games query, because IGDB's `Game` schema has no
relation field for it at all — confirmed by fetching `api.igdb.com/v4/igdbapi.proto` live and reading
the full field list. `game_time_to_beats` is its own endpoint, filtered by `game_id`, unlike `cover` or
`involved_companies` which genuinely do expand inline. It is deliberately isolated in its own
try/catch: a failed or slow time-to-beat call only leaves `averagePlaytimeHours` null, and can never
blank out an already-successful primary search the owner is about to pick from.

Everything around the fetches stays pure and unit-testable without a network or a fake server:
`src/server/games/metadata.ts` builds both Apicalypse query bodies and shapes both JSON responses into
`GameSuggestion[]`, entirely defensively (a third-party payload is untrusted shape, not a typed
contract — a missing or wrong-typed field degrades to `null`, never a thrown error). This split mirrors
Finance's own discipline of keeping the domain core free of I/O.

### Search-as-you-type, with a non-clobbering fill rule

The add/edit form searches as the owner types — debounced 300ms, minimum 3 characters, each keystroke
superseding whatever request came before it — rather than the earlier RAWG-era design's explicit
"Find art" button. Picking a result (`applySuggestion` in
`src/features/games/library/game-dialog.tsx`) fills `coverUrl`, `genre`, `developer` and `publisher`
**only into a field that is still empty**: those four are the owner's own hand-editable fields (loaded
from an existing game, typed by hand, or filled by an earlier pick), so a suggestion is never allowed
to silently replace something already there. `metacritic`, `averagePlaytimeHours` and `esrbRating` have
no hand-editable control at all — they are read-only third-party facts displayed for information —
so there is nothing of the owner's to protect and they always take the latest pick's value.

An earlier draft of this module also carried `scoreMatch`/`pickBestMatch` — asymmetric token-overlap
scoring meant to auto-rank results against the owner's typed title, for a bulk auto-match flow that was
descoped before it shipped. Nothing in the live form ever called either function, so both were deleted
(final-review fix wave) rather than kept as code with no production caller — see CLAUDE.md's rule
against speculative abstractions. Git history has the implementation if a future auto-suggest pass
wants the starting point.

### `IGDB_CLIENT_ID`/`IGDB_CLIENT_SECRET` are optional, and their absence is a normal state

Cover-art lookup **fails soft** in every case:

```
no IGDB_CLIENT_ID / IGDB_CLIENT_SECRET configured -> []   (checked first, before even validating the query)
empty/whitespace query                            -> []
Twitch token request fails (network, timeout,
  non-2xx, malformed JSON)                         -> []
/games request fails (network, timeout, non-2xx,
  malformed JSON)                                  -> []
/games request 401s                                -> refreshes the token and retries ONCE, then
                                                        falls back to [] if that also fails
/game_time_to_beats request fails                  -> suggestions still return, averagePlaytimeHours null
```

There is no error state missing credentials can produce — the add/edit form always works, cover art
and its accompanying fields are simply absent, and the owner fills everything in by hand exactly as
before IGDB existed. This mirrors the AI-optional rule in Finance: **the full test suite must pass with
no `IGDB_CLIENT_ID`/`IGDB_CLIENT_SECRET` present.**

---

## Upcoming games and the wishlist

`/games/upcoming` opens with the owner's own wishlist (every `wanted` game — see "Your wishlist"
below), then lists anticipated unreleased games from IGDB, grouped by release month, with a one-click
add to the wishlist.

**`hypes` is the only usable signal, and that is not a preference.** IGDB documents it as "number of
follows a game gets before release." Every other quality field — `total_rating`, `aggregated_rating`,
`rating` and their counts — is review-derived and therefore structurally empty for anything
unreleased, and `follows` is deprecated. `hypes` also stops accumulating at launch, so it stays a
permanent record of pre-release anticipation.

**`HYPE_FLOOR = 30` was calibrated against live data, not guessed.** IGDB publishes no scale for
`hypes`. Measured over the next 12 months (PS5 + PC, main games only): floor 10 → 120 games, 20 → 66,
30 → 45, 50 → 27. At 20 the tail admits genuinely obscure titles; at 30 the tail still holds real
franchise entries; at 50 it thins to roughly two a month and risks empty months. The constant carries
this table in a comment — if you change it, re-measure rather than nudging the number.

### Three IGDB facts that cost real debugging time

- **`category` is dead.** `where category = 0` returns **zero rows** against live IGDB. It has been
  replaced by `game_type`, where `0 = Main Game`. Confirmed by querying `/game_types` directly.
- **`status != (6,7)` is a landmine**, not a safety filter. It looks like "exclude cancelled and
  rumoured," but `status` is unset on virtually every upcoming game and IGDB's `!=` drops null rows
  rather than passing them through — adding it collapsed a real 45-game result to 1. Do not re-add it.
- **IGDB returns `release_dates` rows in the PAST** even when the whole query is `first_release_date >
  now`. A probe produced 2025-03 and 2026-04 buckets for a future-only query, so `groupByMonth`
  rejects any month earlier than the current one.

### Grouping

`src/server/games/upcoming.ts` is pure. `date_format` values are `0` exact, `1` month, `2` year,
`3-6` quarters, `7` TBD. Only `0` and `1` yield a real month; everything else falls into a single
trailing **Later / TBD** group — which is load-bearing, not an edge case: **19 of 45 real games land
there**, because IGDB has only year or quarter precision for them. A game appears once, in its
earliest qualifying month, with all its platforms listed — never once per release row. `excludeOwned`
then drops every candidate whose IGDB id is already in the library (any status) and any month that
empties: a wishlisted game is listed above the feed, and showing it twice said nothing the first copy
did not.

### Fetching

Live on every visit — no cached table, no refresh button. One IGDB request per page load, well inside
the documented 4 requests/second limit. `fetchUpcomingGames()` returns `[]` for missing credentials
AND for any failure, so the page cannot tell those apart; the empty state deliberately does not assert
a cause it cannot know. `igdbConfigured()` is checked separately so "not configured" can be named
precisely.

### Your wishlist — a wanted game stays until the owner moves it

The tab opens with every `wanted` game as cover cards in the same grid as the feed below: released
ones first with an "Out now" pill on the art, then by release date soonest first, then games with no
date, each group alphabetical (`sortWishlist`, pure). Under each cover: the title, `PS5 · Out now` /
`in 11 days` / `Feb 16, 2027` / `No date`, and one action, **"Add to library"**. Clicking the cover
opens the game panel in place, whose header offers the same button.

**"Add to library" is the moment a game enters the library, so it opens the add-game dialog.**
`GameDialog` in `mode="complete"`: title, platform, cover and the IGDB metadata pre-filled from the
row, the status control hidden (it is `played` — that is the point), and the owner types hours, price,
first-played year and rating right then. Submit goes to `completeWishlistGameAction`, which parses
exactly like a create (same schema, same split checks) and writes onto the EXISTING row — never a
duplicate — refusing a row that is no longer `wanted`. Cancel changes nothing. Flipping one column
would have put a figureless game in the library and sent the owner to the panel to fill it anyway.

There used to be an auto-flip: a wanted game whose date passed was silently made `backlog` and
vanished from this tab, because the IGDB feed below only ever lists unreleased titles. So a game
disappeared on the day it came out — the one day the owner most wanted to see it. Removed 2026-10-18
by owner decision: `wanted` means "on my radar, not started" until the owner says otherwise, and
nothing on this tab edits owner data unprompted any more.

**"Out now" is `isReleased`, and it is precision-aware.** A day-precision date counts from the day
itself. A month-precision date (stored as `YYYY-MM-01`) counts only once the whole month is behind us —
that placeholder day is exactly what made the old auto-flip promote a "November 2026" game on 2
November. `formatReleaseCountdown` prints "Out now" in both cases.

### A release date you can type

A hand-added wanted game has no IGDB id and no date, so it sorts last as "No date". The panel offers a
Release date row while a game is `wanted` — `updateGameFieldAction('releaseDate', …)`, validated as
a real calendar day (2026-02-30 is a shape, not a date), stored at `'day'` precision; clearing it
clears both columns. One caveat: `reconcileWishlistReleaseDatesAction` still corrects IGDB-sourced
rows from the feed, so a hand-typed date on an IGDB-sourced row can be overwritten by IGDB's reading.
Hand-added rows have no IGDB id and are never touched.

---

## The game panel

Clicking a cover, a table row, or a wishlist entry opens the game in a 520px panel beside the content
(full-screen on a phone) instead of navigating to a page. `/games/[id]` no longer exists. The panel is
client state held by `GamePanelProvider` in the Games `(tabs)` layout
(`src/features/games/panel/`), so the Library and Upcoming tabs open the same panel in place; closing
is Esc or the X, and switching tabs closes it. There is deliberately no URL for it.

**Non-modal, on purpose.** Built directly on Radix `Dialog` with `modal={false}` — no overlay, no
focus trap, no scroll lock — so the grid stays live and clicking another cover swaps the panel. Three
things Radix would otherwise do for a modal are handled in `game-panel.tsx`: an outside pointer-down
is prevented from dismissing (it is a swap, not a close); Escape inside a text control is prevented so
it cancels only that field, and a second Escape closes; and the panel sits at `z-40` so toasts,
nested dialogs (Confirm, the collection picker), Select content and the mobile nav — all `z-50` —
stay above it. While it is open the page content gets right padding equal to the panel's width, so the
library reflows beside it rather than sitting underneath.

**Data.** The caller hands over the full `Game` it already has, so the header and every scalar row
render on the first frame; `getGamePanelAction` fetches the collection data (members, options,
candidates), and the panel re-fetches itself after every successful save — its copy of the game is
state, not a prop, and the action's own `revalidatePath` only refreshes the page behind it. A swap
from inside the panel (a member, the parent collection) has only an id and shows a skeleton until that
fetch lands. Stale data stays on screen while a re-fetch is in flight; nothing flickers.

**Layout — one column of label/value rows, no section headings at all.** A compact header — cover, the
click-to-edit title with its IGDB search-as-you-type, the platform (plus a "Wanted" pill and an
"Add to library" button for a wishlisted game — `played` is never printed anywhere), and a muted
`Metacritic N · ~Nh to beat` line when IGDB supplied either (ESRB is stored but never shown; the
rating is NOT repeated here — the editable Rating row is the one place it shows) — then three
blocks of rows separated by a little space, no headings: rating, release date while wanted, hours,
first played (with a **+** beside the year that starts a year split — see below), the year rows,
achievement counts, the platinum toggle; platform, ownership, price, genre, developer, publisher;
then the parts grid (see "DLC") and the collection — its members as a list, then a plain
"+ Add games to collection" line, the same shape as the grid's "+ Add DLC", each its own
left-aligned row; then Notes, an ordinary row like every other field; and Remove. **Every row is
the same height (36px)** — a fixed minimum, not padding around content — with no gap between the
three blocks at all (an 8px one was tried and read as "padding under Platinum"); measured in a real browser, because the owner read a 35/40/47px mix
as "inconsistent", correctly. No outlined buttons anywhere in the panel: every action is quiet text
with a plus or a word, by owner decision.

**Years are rows, not an editor.** The split used to hide behind "Split across years" and its own
Save button. Now the + beside First played adds a year row; each year is a row of two editable
cells (year, hours) with an x, and the last has the +. There is no Save: the rows are local drafts
that save themselves the moment they are complete, free of duplicate years and add up to the BASE
game's hours (`play-years-rows.tsx`); until then one short red line says what is off ("Years add
up to 148h; hours are 136h"). Removing the only row clears the split. The owner's
own words after looking at the first version: "white space and double lines", "a lot of 'with DLC'
everywhere", "keep everything consistent"; every row is one line and no value carries a hint now.

**The collection has no heading, no count, no toggle and no empty-state box.** With nothing filed,
"+ Add games to collection" is all there is; with members, they are listed above it, each with its
own remove. A member gets the "Part of" picker instead. (The earlier Show/Hide row was dropped the
day it shipped: "keep the collection and DLC consistent, just have an add games button like the
add DLC button".) Notes is a plain label/value row. Every field keeps its per-field inline
save through `updateGameFieldAction`; a collection member's price and ownership stay read-only ("From
the collection"), while its hours are its own since 2026-10-19 (see "Where the figures live"). Creating a game is still the small modal — a new row needs
only a handful of fields to start.

---

## Loading and click feedback

**The Games `(tabs)` segment has its own `loading.tsx`**, and that is not cosmetic: Next.js does not
prefetch a dynamic route at all unless it has a `loading` boundary, and every route in this app is
dynamic. It is scoped to that segment deliberately — a fallback above the Library/Upcoming/Stats bar
blanked the tabs being clicked. (`[id]` and `sync/[runId]` had their own until both routes were
removed on 2026-10-18.)

**A clicked cover or row opens the panel on the same frame**, so there is no spinner to show any more;
instead the card whose game is open carries a ring (`aria-pressed`) and the table row is highlighted
(`data-active`). See `docs/ARCHITECTURE.md`, "Perceived performance", for the original diagnosis.

---

## What's deliberately out of scope for v1

Each of these was considered and cut, not overlooked:

- **Per-achievement tracking.** `achievements_unlocked`/`achievements_total` are two counts, not a
  child table of individual achievements with their own unlock dates. The source data was never
  shaped that way, and nothing in the module invents structure to match a feature that hasn't been
  asked for.
- **Any link between a game's price and Finance transactions.** `price_cents` is stored and displayed,
  full stop — no join, no reconciliation, no "spent $X on games this year" figure cross-referenced
  against `finance_transactions`. Building that would mean matching a manually-entered price against a
  real purchase transaction, which is exactly the kind of matching/reconciliation logic Finance itself
  treats as a deliberate, separately-scoped feature rather than a byproduct of two tables existing.
- **Session-by-session play history.** Hours are one hand-edited number per game, not a log of
  individual play sessions with dates and durations. See "Hours are one number" above.
- ~~**A wishlist-vs-library distinction.**~~ **Shipped** — see "Upcoming games and the wishlist"
  above. `wanted` is a real status, distinct from `played` (the only other one), and excluded from
  every computed number.
- **Platform syncs and a per-trophy list.** Steam and PSN syncs (staged, reviewed, committed) and a
  `game_trophies` table were built in August 2026, lived in production for seven weeks, and were
  removed on 2026-10-18 by owner decision: re-pasting a PSN token every two months and reviewing staged
  runs cost more attention than the data returned. Hours, achievement counts and platinum are
  hand-entered again. Git history before commit `3324656` has the full implementation if it is ever
  wanted back.
- **A Duplicates screen.** It existed to merge the copies the syncs created (the same purchase under
  PS4 and PS5, a boxed set flattened into its first title). With no sync there is no source of
  duplicates the `(owner, lower(title), platform)` index does not already block; the few flattened
  rows left from the original import are fixed by hand in the app.
