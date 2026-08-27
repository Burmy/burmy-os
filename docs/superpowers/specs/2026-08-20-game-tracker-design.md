# Game Tracker — Design Spec

## Context

Burmy currently has one product module: Finance. `CLAUDE.md` states *"Finance is the only
product module... do not build [other modules]"* — this spec is the owner's explicit decision
to add a second one. `CLAUDE.md` will be updated alongside implementation to describe both
modules instead of contradicting the code.

The source material is a Google Sheet ("Game log", ~100 entries, PS2-era through today) that the
owner has hand-maintained for years: Title/Publisher/Developer/Ownership/Price/Hours/First
Played/Trophies/Rating, plus a manually-updated Year→Games/Hours/Trophies rollup. The goal is a
purpose-built replacement that's easier to look at and easier to keep current — not a spreadsheet
clone.

## Non-negotiable invariants

Mirroring the discipline Finance already applies, adapted to this domain:

1. **Hours, trophy counts, and yearly totals are never hand-maintained.** The `games` table
   stores per-game facts; every yearly/aggregate number (hours per year, games completed per
   year, genre breakdown, etc.) is computed by SQL at read time, the same rule Finance applies to
   money. This is the direct fix for the spreadsheet's manually-updated, already-observed-stale
   rollup table.
2. **Money uses the same signed-cents convention as Finance** (`price_cents`, `bigint`), even
   though Games' price is fully independent of Finance's transactions — for the same reason
   Finance avoids floats: correctness, not habit.
3. **Complete separation from Finance, sharing only the owner boundary.** New tables
   (`game_titles`, no `finance_` prefix collision), new server domain code
   (`src/server/games/`, framework-free, mirroring `src/server/finance/`'s own isolation rule),
   new data-access layer (`src/server/db/games/`), new feature UI (`src/features/games/`), new
   routes (`src/app/(private)/games/`). Finance code must never import from Games code or vice
   versa. Both may use generic shared primitives (`src/components/ui/*`) and both call
   `requireOwner()` — that's the only shared surface.
4. **Same Supabase project, not a separate database.** One owner, one Postgres instance, two
   unrelated sets of tables in it.

## Data model

**`game_titles`** (one row per game the owner owns/wants/has played):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `owner_id` | text | FK → `user(id)`, same pattern as every Finance table |
| `title` | text | required |
| `platform` | `game_platform` enum | `ps5, ps4, psp, steam, pc, other` |
| `developer` | text | nullable |
| `publisher` | text | nullable |
| `ownership` | `game_ownership` enum | `physical, digital`, nullable |
| `price_cents` | bigint | nullable — independent of Finance, typed by hand |
| `status` | `game_status` enum | `backlog, playing, completed, paused_dropped` |
| `rating` | smallint | 1–5, nullable |
| `hours_played` | numeric(6,1) | one field, hand-updated — see "Hours logging" below |
| `first_played_year` | smallint | nullable; sparse for pre-tracking-era entries |
| `achievements_unlocked` | smallint | nullable |
| `achievements_total` | smallint | nullable |
| `cover_url` | text | nullable, fetched from metadata source |
| `genre` | text | nullable, fetched alongside cover art |
| `notes` | text | nullable — freeform, covers edge cases like "6 hrs = DLC, played 2026" |
| `sort_order`, `created_at`, `updated_at` | | standard |

**Hours logging — deliberately simple, not a session log.** One `hours_played` number per game,
edited in place, exactly like the spreadsheet. The spreadsheet's "53 + 6" composite strings
looked like session tracking but weren't — they were the owner keeping a DLC's hours in 2026
visually separate from the base game's hours in 2025, purely for the yearly rollup's sake. A full
session-log table was proposed and explicitly rejected as unneeded complexity; the `notes` field
covers this case in plain language instead of structured data.

**No `play_sessions`, no per-achievement child table.** Achievements are a count
(`unlocked/total`), matching the owner's explicit choice — richer per-achievement tracking (name,
unlock date, rarity) was considered and declined for v1.

## Cover art & metadata

Fetched automatically from a public game database at add-time. **Recommendation: RAWG.io**, not
IGDB — RAWG uses a single API key (env var, no OAuth/token-refresh cycle to maintain), which is
the lower-ceremony choice for a personal single-owner app; IGDB needs a Twitch developer app and
OAuth client-credentials flow for what amounts to the same cover-art-and-genre lookup. Revisit if
RAWG's data quality proves insufficient.

- **Bulk historical import** (the ~100 existing games): auto-match every title against RAWG, then
  surface a short review list of only the *low-confidence* matches for the owner to fix — not 100
  individual confirmations.
- **Adding a game going forward**: type a title, see a small set of thumbnail results, pick the
  right one. One extra click, always correct.

## Screens

- **Games home (`/games`)** — card gallery, default view: cover art grid, filterable by status
  (Backlog/Playing/Completed/Paused-Dropped) and platform. Toggle to a dense table view (matching
  the spreadsheet's own scan-and-sort feel) for the same data.
- **Game detail** — single game's full record, editable in place (status, hours, rating,
  achievements, notes).
- **Stats/Dashboard** — mirrors Finance's dashboard shape (stat cards → charts → callouts), all
  computed live:
  - Stat cards: total games, total hours, average rating, backlog size (with trend), completion
    rate.
  - **Yearly Breakdown** — direct replacement for the spreadsheet's manual Year→Games/Hours/
    Trophies table, computed from `game_titles` grouped by `first_played_year`. This is the
    explicit "year-by-year comparison" the owner asked to keep.
  - Charts: hours played per year, games completed per year, platform split (donut), ownership
    split (donut), rating distribution, genre breakdown.
  - Callouts: most-played game of the year, longest game ever played, most-played
    developer/publisher, best year for gaming.

## Navigation

New top-level sidebar item, "Games," alongside "Finance" and "Settings" — not nested under
either.

## Historical import

All ~100 existing rows are imported, sparse entries included as-is (a 2008 PSP game with only a
rating stays that way — not forced to fill fields it never had). Same "adjust to your own
judgment where notes/data are ambiguous" latitude already used for the Finance historical
backfill.

## Out of scope for v1

- Per-achievement tracking (name/description/unlock date/rarity) — count-only for now, schema
  doesn't preclude adding it later, but nothing is built to anticipate it.
- Any link between a game's price and real Finance transactions.
- Session-by-session play history.
- Wishlist-vs-backlog distinction (both are just `backlog` status for now).
