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
`platform` are required (`platform` defaults to `other`, `status` to `backlog`); every other column is
nullable, and a bare backlog entry with nothing else filled in is legitimate data, not an incomplete
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
| `status` | enum, not null, default `backlog` | App-reachable: `backlog \| playing \| played \| wanted`. The Postgres type also still contains `paused_dropped`, a dead label kept only because Postgres cannot drop an enum value — see "Lifecycle statuses" below |
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

### Platinum is the owner's own claim by hand — except where PSN sync owns it

`platinum` is a plain `boolean`, edited via a checkbox in the add/edit dialog — not computed from
`achievementsUnlocked === achievementsTotal`. Two reasons: the source spreadsheet only ever recorded
trophies *earned*, never the total, so a platinum could not be derived for any of the 160 imported
games even retroactively; and on Steam, 100% achievement completion is not a platinum at all — the
concept is PlayStation-specific and has no Steam equivalent to derive it from. This is why the Steam
sync (in-app and CLI alike) never touches this column — see "Steam owns hours and achievements for a
linked game" below.

**The in-app PSN sync reverses that rule for a PSN-linked game.** Sony's own trophy list is the actual
system of record for whether a platinum was earned — not the owner's memory — so `psn-plan.ts` is the
one and only place in the sync feature that proposes a `platinum` change, gated on a confident trophy-
title match. See "PlayStation sync" below for the full reasoning; nothing here makes the two sync
engines symmetric, and they are correct to disagree.

The Server Action path (`createGameAction`/`updateGameAction` in `game-actions.ts`) treats this field
differently from every other optional field `parse()` handles: an HTML checkbox submits **no** key in
`FormData` at all when unchecked, so `platinum` is written unconditionally on every submit, in both
create and update, rather than following the create-omits/update-clears-to-null pattern the rest of
`parse()` uses. Gating it behind that pattern would mean a platinum, once set, could never be turned
back off from the editor. This is the hand-editing path only — a PSN sync run writes `platinum`
through the staged `field_update`/commit path described in "PlayStation sync" below, not through this
form submit at all.

---

## Play-year attribution

`first_played_year` was doing two unrelated jobs: "when did I start this" and "which year owns
these hours." For almost every game those coincide. For a game played across a year boundary — a
base game in 2024, its DLC in 2025 — they do not, and crediting every hour to the start year is
wrong: the spreadsheet import recorded exactly this case as a composite string, `"53 + 6"`, that the
schema had no column for.

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
never a replacement for it.** That distinction is load-bearing, not stylistic: Steam and PSN own the
total for a linked game and have no concept of years at all (see "Steam library sync" below), so the
total has to stay a single number an API can write. A game with **no** `game_play_years` rows
attributes everything to `first_played_year` — the behaviour every game already had before this
feature existed, which is why only 3 of 160 games needed anything backfilled (see "Seeding the three
known splits" below).

### The split must sum to the total, or it shows up as a visible gap

`attributeHours` (`src/server/games/play-years.ts` — pure TypeScript, no React, no Next, no
database, same boundary rule as the rest of `src/server/games/`) turns `games` rows plus
`game_play_years` rows into a per-year attribution. When a split's rows don't sum to the game's
`hours_tenths` — the usual cause is a Steam sync raising the total after the split was last edited —
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

### Achievements are not split, and never will be

`buildYearlyBreakdown` attributes hours per year but leaves achievements on `first_played_year`,
unconditionally. No source anywhere — the library, Steam, or PSN — records which year a trophy was
earned in, so splitting them proportionally across a game's played years would fabricate data the
owner never entered. This is a permanent property of the data available, not a gap this feature
happens not to have closed yet.

### Seeding the three known splits

`scripts/seed-play-year-splits.mjs` promoted the only three games whose year split existed anywhere
— as prose in `notes` (e.g. "Imported as \"53 + 6\" across 2025 + 2026") — into real rows: Clair
Obscur: Expedition 33 (2025/53h + 2026/6h), Hollow Knight (2024/37h + 2025/12h), and Lies of P
(2024/52h + 2025/25h). Dry-run by default, `--apply` to write, and it re-verifies each split against
the game's *current* `hours_tenths` before writing — a hand-recovered split that no longer sums to
the live total is refused, not force-written. A one-off script rather than a SQL data migration for
the same reason `fix-game-platforms.mjs` gives: migrations run against both local and production,
where `games.id` values differ, and a title-keyed write inside a migration is fragile.

### Neither Steam nor PSN can ever supply this

Steam's `GetOwnedGames` returns only `playtime_forever` and `playtime_2weeks` — no per-year
breakdown exists in the API at all. PSN's `getUserPlayedGames` (built — see "PlayStation sync" below)
returns a single cumulative `playDuration` per title, same limitation. Per-year attribution is
permanently a hand-entered fact, not something a sync could ever fill in automatically the way it
fills in the total.

---

## Lifecycle statuses

Three VISIBLE states, plus one invisible default, driving the library's filter chips and the
dashboard's backlog/playing/played breakdown:

| Status | Meaning |
| --- | --- |
| `backlog` | Owned, not started |
| `playing` | Currently in progress |
| `played` | Simply been played — the **invisible default**: `StatusBadge` renders no badge at all for it, in either variant |
| `wanted` | Wishlisted, not released or not bought yet — see "Upcoming games" below |

**Real usage is why `played` renders nothing.** Of 180 games, 171 sat in this one status (then called
`completed`) and `playing`/the old `paused_dropped` had never been used at all — a status describing
95% of the library carries no information, so as of migration `0013` it is the library's *default
assumption* rather than a fourth badge to scan past on every card. `played` is a deliberate non-null
SENTINEL, not a nullable column: modelling "no status" as `NULL` would turn every `WHERE status = …`,
every count, and the `wanted` exclusion below into null-aware SQL, real bug surface for what stays a
plain non-null comparison everywhere else.

**`paused_dropped` still exists in the Postgres `game_status` type, but is unreachable from the app.**
It had zero rows at the same audit that motivated the change above, and Postgres has no `DROP VALUE`
for an enum — removing it from the type would mean creating a new type, swapping the column, and
re-pointing the default and its indexes, a fiddly migration for a value nothing ever writes. It was
removed from `GAME_STATUSES` (`src/server/games/taxonomy.ts`) instead, which is what every picker,
filter and `Record<GameStatus, …>` map in the app actually iterates — the dead label in Postgres is
inert. The original reasoning for keeping "paused" and "dropped" as one state, not two, still applies
to whatever the owner wants to say about a `backlog` game they started and set aside: that is a sentence
in `notes`, not a schema decision.

**`wanted` is excluded from every computed number**, in exactly one place: `listGameStatRows`
(`src/server/db/games/games.ts`) filters it out at the query boundary. The six stat functions were
deliberately NOT each given their own filter — six rules is six chances to forget one, and a stat
function added later would silently miss it. Filtering at the read boundary makes every present and
future stat correct by construction. A wishlisted game is also hidden from the Library screen unless
its own chip is active.

**The library's gallery view pins `playing` games first and renders them larger** (`LibraryView`,
`GameGrid`, `GameCard`'s `size` prop) — the one status the owner is actively acting on is also the one
most worth surfacing without scrolling. The table view is untouched: a taller row in a dense list is
noise, not a feature.

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

The stats layer exposes five pure functions, all taking `GameStatRow[]` (a narrower projection of
`Game` — no `notes` or `coverUrl`, since nothing downstream needs them; `priceCents` **is** included,
for the money figures below) as their first argument. Two take a second: `buildYearlyBreakdown` also
takes the owner's `game_play_years` rows, and `findCallouts` also takes `buildYearlyBreakdown`'s own
output — see below and "Play-year attribution" above.

- **`buildLibrarySummary`** — total games, total hours, backlog/playing/played counts, average
  rating (mean of rated games only — unrated games don't pull the average toward zero), platinum
  count, average hours per game (mean over games that HAVE hours logged, not counting an unplayed
  backlog entry as a zero), and average Metacritic (mean over games that have one). There is no
  completion rate: with `completed`/`paused_dropped` gone, `completed / (completed + paused_dropped)`
  has no definition — the old figure was already misleading, pinning to 100% whenever nothing was
  marked dropped regardless of backlog size.
- **`buildFinancialSummary`** — total spend, average price per game (mean over games with a price
  recorded), cost per hour played (total spend ÷ total WHOLE hours, not tenths), backlog count, and
  the money sitting unplayed in the backlog (`priceCents` summed across `backlog`-status games only).
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

The dashboard (`GamesDashboard`, `/games/stats`) groups its stat cards into three rows — **Library**
(games, hours, backlog, completion rate), **Ratings & achievements** (average rating, average
Metacritic, platinum count, average hours per game), and **Money** (total spend, average price,
cost per hour, backlog value) — followed by the Yearly Breakdown table, a **Trends** row of three line
charts (games / hours / trophies per year — a continuous year axis reads as a trend on a line the way
disconnected bars don't; matches the owner's original spreadsheet, which kept exactly these three as
line charts), a **Breakdown** row of four charts (platform / ownership / genre distribution, rating
distribution), and the three-item Highlights row — nothing on that page reads a stored total anywhere.

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

## Steam library sync

`scripts/sync-steam-library.mjs` (2026-08-23) fills in achievements and play time for Steam-platform
games automatically, via the official Steam Web API, replacing hand entry for those columns going
forward. See `.superpowers/sdd/2026-08-20-game-tracker/psn-integration-research.md` for the evaluation
that led here: Steam's API is official, documented, and has a credential that never expires, where the
only PSN options known at the time were scraping PSNProfiles (a scraper of a scraper, actively
resisted by Cloudflare) or driving Sony's own undocumented API by hand through a ~60-day manual
re-authentication chore — PSN stayed a research note here, not code, and this script has no PSN
counterpart. **That changed once `psn-api` (`achievements-app/psn-api`) turned up** — an actively
maintained MIT library calling PlayStation's own official endpoints rather than scraping — which is
what the separate in-app PSN sync below is actually built on; see "PlayStation sync" below for that
integration in full. This script itself was never extended to PSN and stays Steam-only.

### A stable external id, matched once

`games.steam_appid` (migration 0006) is a nullable integer, unique per owner where set. Title matching
against a third-party catalog is the risky part of this whole feature — the owner's titles carry
edition/store noise (`[Launch Edition]`, `(itch)`) that already defeated IGDB's own matcher (see "Cover
art" above) — so a game is matched to a Steam app **at most once**, and the resolved id is persisted.
Every later sync run is an id lookup for that game, never a re-match by title.

### What it fills, and what it deliberately does not

Only `platform = 'steam'` library rows are ever compared against Steam data — matching a PS5/PS4/PSP
title against a Steam appid would be a category error. Within that scope, the sync **fills a column
only where it is currently `null`**: `steam_appid`, `achievements_total`, and
`achievements_unlocked`/`hours_tenths` where empty (`steamSyncFieldsToFill` in
`src/server/games/steam.ts` is the single source of truth for that rule — the sync script's own
`--apply` path never has to remember it separately). A stored value that **differs** from what Steam
reports is always shown in the script's report and never silently overwritten; `hours_tenths` is the
one column with an overwrite path at all (Steam's measured playtime is more accurate than a hand-typed
estimate), gated behind the script's separate, explicit `--overwrite-hours` flag on top of `--apply`.
`achievements_unlocked`/`achievements_total` have no overwrite path — a differing achievement count is
reported and left alone, full stop.

**`platinum` is never touched by this script**, deliberately — see "Platinum is the owner's own claim
by hand — except where PSN sync owns it" above. A Steam game at 100% achievements is not a PlayStation
platinum trophy; the two concepts don't map onto each other, and the script's own header comment says
so explicitly so nobody wires this up by mistake later. (The in-app PSN sync below is the one place
`platinum` IS written automatically — a different engine, on purpose; this script still never touches
it.)

**The 40 PSP games get nothing from this script, ever, and are out of scope by construction** — they
are not `platform = 'steam'` rows, and trophies/achievements postdate the PSP entirely (trophies
launched with PS3 in 2008; PSP has no client-side trophy support). The in-app PSN sync below walks PSP
rows too, but PSN can supply no data for them either, for the same historical reason — see "PSP is
permanently manual" under "PlayStation sync."

A Steam-owned game with no matching library row is listed in the script's report (title, appid, hours)
and **never imported** as a new row — the library is curated by the owner, and importing an entire Steam
account is not this feature's goal.

### Credentials and the dry-run contract

`STEAM_API_KEY`/`STEAM_ID` are optional at the module level, matching IGDB's own contract:
`src/server/db/games/steam-client.ts` never throws on missing credentials, a network error, a timeout, a
non-200, or malformed JSON, and the full test suite passes with neither present. Unlike IGDB, that
soft-failure contract is not a flat "always `[]`": `fetchOwnedGames` returns `null` when the request
itself failed, distinct from `[]` for a successful response that genuinely carries zero games (a private
"Game details" profile, or an account that really owns nothing — Steam's response shape doesn't
distinguish those two; see `toOwnedGames`). The owner's Steam profile "Game details" privacy must be set
to Public, or the API silently returns an empty games list — there is no error response to tell "wrong
credentials" apart from "private profile," which is why the script's report calls this out explicitly
when zero games come back with no fetch error.

`STEAM_ID` accepts either form of Steam's own profile URL — `/profiles/{steamid64}` or
`/id/{vanityname}` — since an owner copying their own profile URL has no way to know `GetOwnedGames`
requires the 17-digit numeric SteamID64. A value that is exactly 17 digits (`isSteamId64` in
`src/server/games/steam.ts`) is used as-is; anything else is treated as a vanity name and resolved to a
SteamID64 via `ISteamUser/ResolveVanityURL/v1` before the sync runs, printing what it resolved to so the
owner can confirm it worked. If the name doesn't resolve (Steam's `success: 42`), the script aborts with
a message pointing at where to find a real SteamID64, rather than sending a malformed id into
`GetOwnedGames`.

`src/server/db/games/steam-client.ts` — the in-app sync's own client, see "In-app Steam sync" below —
resolves a vanity `STEAM_ID` the same way, via the same `buildResolveVanityUrl`/`isSteamId64`/
`toResolvedVanityUrl` building blocks, memoized in-process so a run that calls `fetchAchievementCounts`
dozens of times doesn't re-resolve the name on every call. It soft-fails to `null` on a resolution
problem instead of throwing (matching the rest of this module's contract), where the script aborts —
same split as every other failure mode covered above.

The script itself is a stricter, CLI-level gate on top of the client's soft-failure contract in two
ways: it exits early with an error if either var is unset (the same shape `backfill-game-metadata.mjs`
already uses for `IGDB_CLIENT_ID`/`IGDB_CLIENT_SECRET`), and — unlike the app-side client — it
**aborts with a non-zero exit and writes no report at all** if the owned-games request itself fails
after credentials are present (bad SteamID64, network error, non-2xx, malformed JSON). Silently
continuing with an empty snapshot would match every Steam-platform library row against nothing and print
a confident but meaningless "0 matched, N unmatched" summary — indistinguishable, at a glance, from a
real report saying the owner's whole library is unrecognized by Steam. A script whose only job is
reporting a diff must never produce that report from a request that never actually succeeded.

**The script defaults to a dry run.** No database write happens without the explicit `--apply` flag —
non-negotiable, since this touches data the owner entered by hand. A dry run (or an applied run) always
writes a full human-readable report to a path outside the repo (default: the OS temp directory), listing
every match, every difference, and every Steam-owned game with no library row, so the owner reviews
before trusting `--apply`.

---

## In-app Steam sync

A second, separate Steam integration from the one above: `src/features/games/sync/` drives a sync run
from inside the app itself — click "Sync with Steam" on the Library screen, review a staged diff at
`/games/sync/[runId]`, apply only what's selected. It shares Steam's HTTP client
(`src/server/db/games/steam-client.ts`) and the pure `src/server/games/steam.ts` leaf with
`scripts/sync-steam-library.mjs` above, but everything about WHAT it proposes and HOW it applies is
different — see "The opposite fill rule" below before touching either.

### Chunked and resumable, not one long request

A Server Action has a serverless timeout; walking the owner's whole Steam-platform library in one call
does not fit inside it. `startSteamSyncAction` fetches the owner's Steam library once and snapshots it
into a `game_sync_runs` row; `advanceSteamSyncAction` then processes `CHUNK_SIZE` (5) library games per
call — each matched game costs one `GetPlayerAchievements` request, so a chunk is at most 5 outbound
Steam requests, comfortably inside any timeout. The Sync button (`src/features/games/sync/sync-button.tsx`)
drives this by calling `advanceSteamSyncAction` in a loop, showing "N of M games checked," until a
response reports `done: true`.

**`done` comes from an empty chunk, never from `cursor >= total`.** `total` is a count taken once at run
creation — a snapshot, not a live value — and pagination walks `games.id` by keyset (`id > lastGameId`),
not OFFSET/LIMIT, specifically because `total` can never be trusted to line up with the cursor exactly
(a game added or removed mid-run shifts it). See `advanceSteamSyncAction`'s own doc comment in
`src/features/games/sync/sync-actions.ts` for the two failure modes this fixes, both reproduced against
real Postgres before the fix. `cursor`/`total` exist in `SyncProgress` for the "N of M" label only —
nothing in the engine or the button decides completion by comparing them.

Because the run's state (cursor, staged changes so far) lives in the database the whole time, **closing
the tab mid-run leaves a resumable run**, not a lost one — reopening `/games/sync/[runId]` for a still-
`running` run shows "still in progress," and clicking Sync again from the Library screen is safe (it
starts a fresh run rather than resuming one, since a fresh Steam library snapshot is cheap and correctness
doesn't depend on continuing the exact same run).

### Nothing is written without explicit approval

Every one of `startSteamSyncAction`/`advanceSteamSyncAction` only ever calls `appendSyncChanges` and
`finishSyncRun` (`src/server/db/games/sync.ts`) — neither touches the `games` table. The owner reviews
the staged diff at `/games/sync/[runId]` (`SyncReview`, `src/features/games/sync/sync-review.tsx`),
grouped into "Needs attention," "New games," "Field updates," and "Links," and only `commitSyncRunAction`
— triggered by the review screen's own "Apply N selected changes" button, one explicit click — writes
anything, and only for the changes the owner left checked. A run is immutable once committed: committing
again, or committing a run that never reached `ready`, is refused with a message rather than silently
re-applying.

### Sync never deletes or hides a game

A library game Steam's response doesn't account for is left completely untouched — no write of any kind
reaches its row, and it is never removed from the run's processed set or hidden from the library. This
falls out of the design rather than needing a special case: the sync engine never calls
`createGame`/`updateGame`/`deleteGame` at all, only read functions plus the sync-tables' own append/finish
functions (see the "NO-DELETE INVARIANT" block at the top of `sync-actions.ts`, and its matching
invariant test in `tests/integration/games-sync-actions.test.ts`).

In the owner's real library that means **40 PSP games and 12 Steam-platform games Steam does not own are
permanently manual** — the PSP games because Steam only ever compares `platform = 'steam'` rows (same
scoping rule as the CLI script above), and the 12 because a title with no Steam match simply produces no
change for that game; neither group is ever flagged, deleted, or excluded from view. They stay exactly as
entered, indefinitely, across every future run.

### Steam owns hours and achievements for a linked game

This is the one place the in-app sync and the CLI script actively disagree, by design (see "The opposite
fill rule" below). Once a game is linked (`steamAppid !== null`) — the same provenance signal
`game-card.tsx`'s source mark and the Library's Source filter chip both use, independent of the
`platform` column — Steam's reported hours and achievement counts are treated as authoritative. The
editor (`game-dialog.tsx`) renders `hoursTenths`, `achievementsUnlocked`, and `achievementsTotal`
read-only for a linked game (`steamOwned`, with a "From Steam" hint), and a sync run proposes a
`field_update` change whenever the stored value differs from what Steam reports. A `null` from Steam
(no playtime field, a 400 from `GetPlayerAchievements` on an older title) is never proposed as a change
— see `planLinkedGameChanges` in `src/server/games/sync-plan.ts` — so a temporary API gap can never
overwrite a real recorded number with a zero.

### A changed total raises a reconciliation item, never a re-split

`game_play_years` rows (see "Play-year attribution" above) record which YEARS a game's hours happened
in; only the owner knows that breakdown, and Steam's API has no per-year data to supply it (see the
matching `CLAUDE.md` gotcha). So when a `field_update` changes `hoursTenths` on a game that already has
a play-year split, the sync additionally stages a `reconcile` change — "your recorded years add up to
X, but the new total is Y" — and never touches the split rows itself. `reconcile` changes are staged
`selected: false` regardless of the column's own default (see the "needs-attention items never
pre-selected" rule in `sync.ts`) and apply nothing at commit time even if somehow checked — they name no
`games` column to write. The owner rebalances the split by hand on the game's own page; the sync only
ever surfaces that it's now stale.

### New games are staged pre-selected, but still need a click

A Steam-owned game with no library row at all is staged as a `new_game` change once the run's keyset
walk finishes (an empty chunk) — never inserted directly. `appendSyncChanges` defaults every non-
`reconcile` change to `selected: true`, so a brand-new game shows up pre-checked in the "New games"
group of the review screen, but it is still just a checkbox: nothing lands in `games` until the owner
clicks Apply. Achievements are deliberately not fetched for a `new_game` proposal — the game doesn't
exist in the library yet, and fetching them for every unmatched Steam title would multiply a run's
Steam API cost for rows the owner may well leave unchecked.

### The opposite fill rule

`scripts/sync-steam-library.mjs` still exists, unchanged, for local-only runs — see "Steam library
sync" above — and it follows the **opposite** rule from everything on this page: it fills a column
**only where it is currently `null`** (`steamSyncFieldsToFill` in `src/server/games/steam.ts`), because
its contract is "never overwrite what the owner typed by hand." The in-app sync makes Steam
authoritative for a linked game's hours and achievement counts and proposes an update whenever they
differ, which is why those fields are read-only in the editor. **Both are correct for their own
caller — do not unify them.** See the `CLAUDE.md` gotcha of the same name for what breaks if that line
gets blurred.

### Known limitation: an insert that sorts before the bookmark

Keyset pagination fixes the two failure modes described under "Chunked and resumable" above, but it has
one known gap: a game added to the library mid-run whose `id` happens to sort BEFORE the keyset
bookmark (`lastGameId`) is never seen by that run — the walk has already passed the point in `id`-order
where it would have appeared. It is picked up cleanly on the next run (the next sync starts a fresh
keyset walk from the beginning), so nothing is lost permanently; it just doesn't appear until the owner
syncs again. A game added mid-run whose id sorts AFTER the bookmark is picked up normally, in the same
run.

---

## PlayStation sync

A second, independent in-app sync engine — `src/features/games/sync/psn-actions.ts` and
`src/server/games/psn-plan.ts` — reusing the SAME staging, review, and commit machinery as Steam's
(`game_sync_runs`/`game_sync_changes` with `source: 'psn'`, the same `SyncReview` screen at
`/games/sync/[runId]`), talking to PlayStation via `psn-api`
(`achievements-app/psn-api` — see "Steam library sync" above for why this library, and not an earlier-
rejected scraper, is what made this worth building at all). "Sync with PlayStation" is its own button
on the Library screen, **deliberately separate from "Sync with Steam"** — the owner's explicit choice,
so a dead or expired PSN token can never block a working Steam sync. Everything about chunking,
resumability, the no-delete invariant, and `done` coming from an empty chunk rather than
`cursor >= total` is identical to the Steam engine described above; this section covers only what is
actually different.

### What PSN supplies

Two PSN endpoints, fetched once per run and snapshotted together: `getUserPlayedGames` (play data,
keyed by `titleId`) and `getUserTitles` (trophy data, keyed by `npCommunicationId`). Together they
fill:

- **Play time** — a cumulative `playDuration` ISO-8601 duration, converted to the same tenths-of-an-
  hour unit everything else in Games uses (`parsePlayDuration` in `src/server/games/psn.ts` — not
  `hours.ts`'s minutes-based converter, since PSN's input shape is different; see that function's own
  doc comment).
- **First-played year** — from `firstPlayedDateTime`, the same `first_played_year` column Steam sync
  never touches (Steam's API has no such field at all).
- **PS4-vs-PS5 platform** — from the played title's `category`, mapped through `categoryToPlatform`.
  Only `ps4_game` → `ps4` and `ps5_native_game` → `ps5` are confirmed; every other value, `pspc_game`
  included, maps to `null` (see "An unconfirmed category value" below).
- **Last-played** — `lastPlayedDateTime`, stored on `games.last_played_at`.
- **Trophy counts and platinum** — `earned`/`total` (summing `TrophyCounts`' four grades — `bronze`,
  `silver`, `gold`, and `platinum` as a `0 | 1` flag, never a count, since a title can only ever have
  one platinum) and a `platinum: boolean` derived from `earnedTrophies.platinum === 1`.

A `null` from any of these — a `category` PSN doesn't report, no `lastPlayedDateTime` on a title
that's shown as owned but never actually launched — means "PSN did not tell us something usable," not
"the value is empty," and is never proposed as a change (same discipline `planLinkedGameChanges`
applies to a `null` Steam field).

### Trophy data is matched by NAME, across two identifier spaces with no join key

`titleId` (`CUSA…`, played-game data) and `npCommunicationId` (`NPWR…`, trophy data) are two entirely
separate PSN identifier spaces. **There is no field anywhere in either API response that maps one to
the other** — the only thing they share is the human-readable title name. `psn-actions.ts` resolves
each independently: `resolvePlayedTitle` looks up a stored `psnTitleId` (or falls back to a fresh title
match), and `resolveTrophyTitle` does the same for `psnNpCommunicationId` against `bestTitleMatchAmong`
— the same `SIMILARITY_FLOOR`-gated matcher IGDB and Steam matching both use, never bypassed or
lowered here. Once a game is linked, its STORED id always wins over a fresh match, for both id spaces
independently — the same controller invariant `sync-actions.ts`'s `resolveAppid` documents for Steam.

**A title with no confident trophy-name match gets its play data (hours, platform, first/last played)
and NO trophy data — this is never recorded as "zero trophies earned."** `planLinkedPsnGameChanges`
gates every trophy-shaped proposal (`achievementsUnlocked`, `achievementsTotal`, `platinum`) on
`trophyTitle !== null`; a `null` trophy title produces no trophy-field changes at all, not zeros. See
the matching `CLAUDE.md` gotcha — conflating these two id spaces, or treating an unmatched trophy title
as "confirmed zero," are both real ways to corrupt this data.

### `platinum` is PSN-owned — the one field the two sync engines actively disagree on

See "Platinum is the owner's own claim by hand — except where PSN sync owns it" in "Data model" above
for the full reasoning. In short: Steam has no platinum concept, so the Steam sync (in-app and CLI
alike) never writes this column and the owner's own checkbox is the only source of truth for a
Steam-linked or manually-entered game. PlayStation's trophy system IS the actual system of record for
a platinum trophy — Sony knows whether one was earned, the owner's memory doesn't have to — so
`planLinkedPsnGameChanges` is the one place in the whole sync feature that proposes a `platinum`
`field_update`, gated on a confident trophy-title match like every other trophy field above. The two
planners are correct to disagree; this is not an inconsistency to "fix" toward symmetry.

### The NPSSO token — a real chore, roughly every two months, that cannot be automated

`PSN_NPSSO` is retrieved by hand from `https://ca.account.sony.com/api/v1/ssocookie` while logged in
to PlayStation in a browser, and pasted into the environment. `psn-api` exchanges it for a short-lived
access/refresh token pair that `psn-client.ts` caches in-process and refreshes automatically — but the
NPSSO itself still expires roughly every two months regardless, and refreshing the derived tokens does
nothing to extend it. **This cannot be automated**: it requires an authenticated interactive browser
session against Sony's own login flow, not an API call this codebase could ever drive headlessly.

`psn-client.ts` reports one of three distinct outcomes — `'not_configured' | 'token_expired' |
'unavailable'` — never collapsed into one generic failure:

- **Not configured** (`PSN_NPSSO` unset) — the Library screen's "Sync with PlayStation" button renders
  disabled, with a standing explanation naming `PSN_NPSSO`, exactly like the Steam button's own
  disabled state.
- **Token expired** (Sony's OAuth rejects the NPSSO) — surfaced as its own distinct message at click
  time, naming the ~2-month cadence and the retrieval URL above, because "something went wrong" gives
  the owner no way to know a fresh token is the actual fix.
- **Unavailable** (network error, timeout, non-2xx, malformed response) — "PlayStation did not
  respond, try again."

The full test suite passes with `PSN_NPSSO` unset, the same optional-credential contract IGDB and
Steam both already hold.

### PSP is permanently manual

PlayStation Portable predates PSN's trophy system entirely (trophies launched with the PS3 in 2008;
the PSP has no client-side trophy support at all), so PSN can never return play or trophy data that
GENUINELY belongs to a PSP title under any circumstances. The sync engine still WALKS every
PSP-platform library row rather than filtering them out as an "optimisation" (`PSN_PLATFORMS` in
`src/server/db/games/games.ts` covers `ps5`/`ps4`/`psp` together, on purpose) — each one resolves no
played title, stages nothing, and is left byte-identical, proving the no-delete invariant for exactly
the games the owner is most protective of, rather than leaving it unproven by carving PSP out of the
walk entirely.

**"PSN never returns PSP data" is not, by itself, enough to guarantee that.** Sony has re-released
several PSP-era titles on PS4/PS5 under the IDENTICAL name — "Persona 3 Portable" shipped again on PS5
in 2023 with no change to the title string — so a plain name match against PSN's played-titles list
would score that unrelated re-release as a near-perfect match for the owner's real PSP copy, and
happily stage a `platform` flip (`psp` → `ps5`) straight onto it. `resolvePlayedTitle`
(`src/features/games/sync/psn-actions.ts`) closes this with an explicit guard: an unlinked
(`psnTitleId === null`) row with `platform === 'psp'` skips the name-match fallback entirely and
always resolves to no played title, never falling through to `bestTitleMatchAmong` at all. The same
guard is applied where the engine decides which PSN titles count as "already matched," so a PSP row
can never absorb a genuine PS4/PS5 release and hide it from that run's `new_game` list either. Proven
by two integration tests: the unrelated-response invariant (mutation-tested — see
`tests/integration/games-psn-actions.test.ts`) and a same-titled-re-release collision test seeding a
real "Persona 3 Portable" PSP row against a mocked PS5 title of the same name.

In the owner's real library this means **every PSP game stays permanently hand-maintained,
indefinitely, across every future PSN sync run** — never flagged, never excluded from view, never
relabelled by a same-titled re-release, and never silently skipped in a way that would make its
absence from every run's changes ambiguous with "nothing changed" versus "never checked."

### An unconfirmed category value never becomes a guess

PSN's played-title `category` field includes a `pspc_game` value whose meaning was not confirmed
anywhere in the installed `psn-api` package — no comment, README section, or runtime code says what it
stands for (see `src/server/games/psn.ts`'s module header for the verification that was actually done,
not assumed). `categoryToPlatform` maps only the two confirmed values (`ps4_game` → `ps4`,
`ps5_native_game` → `ps5`); `pspc_game` and every other unrecognized value map to `null` — a signal to
leave the stored platform alone — and **`pspc_game` must never map to `'psp'`**, which would corrupt
the platform of the owner's genuinely-PSP games the moment a PS-title-on-PC entry happened to sync.

### The volume reality: PSN returns more than the owner's curated library

A curated ~160-game library synced against a full PSN played-titles list can come back with several
hundred `new_game` proposals — demos, PS Plus monthly claims, and anything else the account has ever
launched or claimed, none of which the owner necessarily wants added. This is expected, not a bug:
`SyncReview`'s `NEW_GAME_VOLUME_WARNING_THRESHOLD` (100, source-agnostic — a large Steam library could
cross it too) renders the count and a visible warning in the "New games" group header itself, before
the owner scrolls to a single row, and **nothing is written to `games` without the owner's own
"Apply N selected changes" click** — every `new_game` change still has to be individually reviewed and
left checked (or unchecked) like any other staged change; the volume warning does not change what gets
committed, only how hard it is to miss before approving.

---

## Upcoming games and the wishlist

`/games/upcoming` lists anticipated unreleased games from IGDB, grouped by release month, with a
one-click add to the wishlist.

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
earliest qualifying month, with all its platforms listed — never once per release row.

### Fetching

Live on every visit — no cached table, no refresh button. One IGDB request per page load, well inside
the documented 4 requests/second limit. `fetchUpcomingGames()` returns `[]` for missing credentials
AND for any failure, so the page cannot tell those apart; the empty state deliberately does not assert
a cause it cannot know. `igdbConfigured()` is checked separately so "not configured" can be named
precisely.

### Auto-promotion on release

A `wanted` game whose `release_date` has passed is flipped to `backlog` automatically. **This edits
owner data without asking** — a deliberate decision, recorded here so nobody "fixes" it later.

It deliberately does NOT run during the Server Component render: Next forbids mutation there and it
would fire unpredictably. The page counts overdue rows and passes the count down; the client view
fires `promoteReleasedWantedGamesAction()` once on mount only when that count is non-zero. The action
is idempotent, so React Strict Mode's double-mount in development is harmless. No scheduled job is
involved — nothing is deployed yet, so a cron would have nowhere to run.

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
- ~~**A wishlist-vs-backlog distinction.**~~ **Shipped** — see "Upcoming games and the wishlist"
  above. `wanted` is now a real status, distinct from `backlog`, and excluded from every computed
  number.
