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
| `platform` | enum, not null, default `other` | `ps5 \| ps4 \| psp \| steam \| pc \| other` |
| `developer`, `publisher` | text | |
| `ownership` | enum, nullable | `physical \| digital` |
| `price_cents` | signed bigint | Same convention as `finance_transactions.amount_cents`. No FK to Finance — see "Out of scope" |
| `status` | enum, not null, default `backlog` | `backlog \| playing \| completed \| paused_dropped` |
| `rating` | smallint, nullable | 1–5. Null means "no opinion yet," not zero |
| `hours_tenths` | integer, nullable | Tenths of an hour. 235 = 23.5h. See "Hours" below |
| `first_played_year` | smallint, nullable | Sparse by design |
| `achievements_unlocked`, `achievements_total` | smallint, nullable | Counts, not a checklist — see below |
| `cover_url`, `genre` | text, nullable | Populated by hand or from a RAWG suggestion |
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

The stats layer exposes four pure functions, all operating on `GameStatRow[]` (a narrower projection
of `Game` — no `notes`, `coverUrl` or `priceCents`, since nothing downstream needs them):

- **`buildLibrarySummary`** — total games, total hours, backlog/playing/completed counts, average
  rating (mean of rated games only — unrated games don't pull the average toward zero), and the
  started-games-only completion rate above.
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

The dashboard (`GamesDashboard`, `/games/stats`) renders five stat cards, a Yearly Breakdown table, six
charts (hours per year, games per year, platform / ownership / genre distribution, rating
distribution), and a three-item Highlights row from exactly these four functions — nothing in that
page reads a stored total anywhere.

---

## Cover art — RAWG, and its soft-failure contract

### Why RAWG and not IGDB

Both APIs expose the same cover-art-and-genre data for a personal-library use case. RAWG authenticates
with a single API key in an environment variable; IGDB requires registering a Twitch developer
application and running an OAuth client-credentials exchange with token refresh. For a single-owner
app that calls this a few times a month, the OAuth lifecycle is pure operational cost — a second
credential to provision, rotate and keep alive — with no benefit RAWG's flat API key doesn't already
provide. RAWG was picked on that basis alone.

### The one HTTP boundary

`src/server/db/games/rawg.ts` (`searchGames`) is the **only** place in the Games module that makes a
network request. Everything around it stays pure and unit-testable without a network or a fake server:
`src/server/games/metadata.ts` builds the RAWG query URL and shapes the JSON response into
`GameSuggestion[]`, entirely defensively (a third-party payload is untrusted shape, not a typed
contract — a missing or wrong-typed field degrades to `null`, never a thrown error). This split
mirrors Finance's own discipline of keeping the domain core free of I/O.

The add/edit form is a manual search-and-pick, not an automatic best-match fill: the owner types a
title, triggers a lookup, sees the raw RAWG result list, and clicks one to apply it (`applySuggestion`
in `src/features/games/library/game-dialog.tsx`). An earlier draft of this module also carried
`scoreMatch`/`pickBestMatch` — asymmetric token-overlap scoring meant to auto-rank RAWG results against
the owner's typed title, for a bulk auto-match flow that was descoped before it shipped. Nothing in the
live form ever called either function, so both were deleted (final-review fix wave) rather than kept as
code with no production caller — see CLAUDE.md's rule against speculative abstractions. Git history has
the implementation if a future auto-suggest pass wants the starting point.

### `RAWG_API_KEY` is optional, and its absence is a normal state

Cover-art lookup **fails soft** in every case:

```
no RAWG_API_KEY configured   -> []   (checked first, before even validating the query)
empty/whitespace query       -> []
request timeout (5s)         -> []
non-2xx response              -> []
malformed/unexpected JSON    -> []   (toSuggestions degrades field-by-field rather than throwing)
```

There is no error state a missing key can produce — the add/edit form always works, cover art is
simply absent, and the owner fills the field in by hand exactly as before RAWG existed. This mirrors
the AI-optional rule in Finance: **the full test suite must pass with no `RAWG_API_KEY` present.**

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
