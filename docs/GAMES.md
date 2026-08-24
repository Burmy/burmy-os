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
| `status` | enum, not null, default `backlog` | `backlog \| playing \| completed \| paused_dropped` |
| `rating` | smallint, nullable | 1–5. Null means "no opinion yet," not zero |
| `hours_tenths` | integer, nullable | Tenths of an hour. 235 = 23.5h. See "Hours" below |
| `first_played_year` | smallint, nullable | Sparse by design |
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

### Platinum is the owner's own claim, never derived

`platinum` is a plain `boolean`, edited via a checkbox in the add/edit dialog — not computed from
`achievementsUnlocked === achievementsTotal`. Two reasons: the source spreadsheet only ever recorded
trophies *earned*, never the total, so a platinum could not be derived for any of the 160 imported
games even retroactively; and on Steam, 100% achievement completion is not a platinum at all — the
concept is PlayStation-specific and has no Steam equivalent to derive it from.

The Server Action path (`createGameAction`/`updateGameAction` in `game-actions.ts`) treats this field
differently from every other optional field `parse()` handles: an HTML checkbox submits **no** key in
`FormData` at all when unchecked, so `platinum` is written unconditionally on every submit, in both
create and update, rather than following the create-omits/update-clears-to-null pattern the rest of
`parse()` uses. Gating it behind that pattern would mean a platinum, once set, could never be turned
back off from the editor.

---

## Lifecycle statuses

Four states, driving the library's filter chips and the dashboard's backlog/playing/completed
breakdown:

| Status | Meaning |
| --- | --- |
| `backlog` | Owned or wanted, not started |
| `playing` | Currently in progress |
| `completed` | Finished |
| `paused_dropped` | Started, then set aside — for any reason |

**`paused_dropped` is deliberately ONE state, not two.** The difference between "I'll come back to
this" and "I'm never finishing this" is a sentence in `notes`, not a fact worth a schema column and a
permanent extra branch in every filter, chart and status-count query in the module. Splitting it would
buy two nearly-identical buckets everywhere a status is grouped, for a distinction the owner can
already express in free text when it matters.

`completionRatePercent` (in `buildLibrarySummary`, see below) is computed over **started** games only
— `completed / (completed + paused_dropped)` — specifically so a forty-game backlog the owner hasn't
touched yet doesn't read as a 5% completion rate. Games still sitting in `backlog` or `playing` are
excluded from both sides of that ratio.

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

The stats layer exposes five pure functions, all operating on `GameStatRow[]` (a narrower projection
of `Game` — no `notes` or `coverUrl`, since nothing downstream needs them; `priceCents` **is**
included, for the money figures below):

- **`buildLibrarySummary`** — total games, total hours, backlog/playing/completed counts, average
  rating (mean of rated games only — unrated games don't pull the average toward zero), the
  started-games-only completion rate above, platinum count, average hours per game (mean over games
  that HAVE hours logged, not counting an unplayed backlog entry as a zero), and average Metacritic
  (mean over games that have one).
- **`buildFinancialSummary`** — total spend, average price per game (mean over games with a price
  recorded), cost per hour played (total spend ÷ total WHOLE hours, not tenths), backlog count, and
  the money sitting unplayed in the backlog (`priceCents` summed across `backlog`-status games only).
  Every average here follows the same "exclude, don't zero-fill" rule as `averageRating` above, and
  every ratio guards its own zero denominator to return `null` rather than `NaN` or `Infinity`.
- **`buildYearlyBreakdown`** — one row per `firstPlayedYear` present in the data, newest first, each
  carrying its own game count, hours, achievements, and the hours delta from the previous year present
  (`null` for the earliest year — there is nothing to compare it to). A game with no
  `firstPlayedYear` — a retro entry — is **excluded from this breakdown entirely**, not bucketed into
  a fake "year zero": it genuinely has no place in a year-by-year comparison.
- **`buildDistribution`** — a generic key/label counter used three times on the dashboard (platform,
  ownership, genre). Its `percent` is the share of rows that actually *had* a value for that key, not
  a share of the whole library — a game with no genre recorded doesn't silently deflate every genre's
  percentage.
- **`findCallouts`** — longest game by hours, the developer with the most cumulative hours across
  their games, and the year with the most hours played, each computed over played games only
  (`hoursTenths > 0`).

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
PSN equivalent would mean either scraping PSNProfiles (a scraper of a scraper, actively resisted by
Cloudflare) or driving Sony's own undocumented API through a ~60-day manual re-authentication chore —
PSN stayed a research note, not code.

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

**`platinum` is never touched by this script**, deliberately — see "Platinum is the owner's own claim,
never derived" above. A Steam game at 100% achievements is not a PlayStation platinum trophy; the two
concepts don't map onto each other, and the script's own header comment says so explicitly so nobody
wires this up by mistake later.

**The 40 PSP games get nothing from this, ever, and are out of scope by construction** — they are not
`platform = 'steam'` rows, and trophies/achievements postdate the PSP entirely (trophies launched with
PS3 in 2008; PSP has no client-side trophy support). The PSN side of the original research (28 PS5 + 45
PS4 games) was evaluated and set aside as a recurring ~60-day manual chore not worth the product surface
for a single-user tool — see the research doc for the full reasoning. It was never built.

A Steam-owned game with no matching library row is listed in the script's report (title, appid, hours)
and **never imported** as a new row — the library is curated by the owner, and importing an entire Steam
account is not this feature's goal.

### Credentials and the dry-run contract

`STEAM_API_KEY`/`STEAM_ID` are optional at the module level, matching IGDB's own contract:
`src/server/db/games/steam-client.ts` fails soft (`[]`/`null`, never a throw) on missing credentials, a
network error, a timeout, a non-200, or malformed JSON, and the full test suite passes with neither
present. The owner's Steam profile "Game details" privacy must be set to Public, or the API silently
returns an empty games list — there is no error response to tell "wrong credentials" apart from "private
profile," which is why the script's report calls this out explicitly when zero games come back.

The script itself is a stricter, CLI-level gate on top of that soft-failure contract: it exits early
with an error if either var is unset, since there is nothing useful a sync run can do without them —
the same shape `backfill-game-metadata.mjs` already uses for `IGDB_CLIENT_ID`/`IGDB_CLIENT_SECRET`.

**The script defaults to a dry run.** No database write happens without the explicit `--apply` flag —
non-negotiable, since this touches data the owner entered by hand. A dry run (or an applied run) always
writes a full human-readable report to a path outside the repo (default: the OS temp directory), listing
every match, every difference, and every Steam-owned game with no library row, so the owner reviews
before trusting `--apply`.

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
- **A wishlist-vs-backlog distinction.** `backlog` covers both "I own this and haven't started" and
  "I want this and don't own it yet" — there is no `ownership`-gated split between the two. The
  source spreadsheet didn't track wanted-but-unowned games as a distinct category, and the four-status
  lifecycle above doesn't currently model it either.
