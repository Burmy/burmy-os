# Handoff — Games module

Written so the next session can pick up cold. **Read `CLAUDE.md` first** (invariants, stack,
gotchas), then this. `docs/GAMES.md` is canonical for the Games domain; where it and the code
disagree, the code wins and the doc is a bug.

**The gotchas below are the reason this file still exists.** They were all found the hard way and
none of them has expired. The status sections at the top and bottom are maintained; treat anything not
explicitly dated as describing the module's design rather than a moment in time.

---

## Where things stand (2026-10-18)

| | |
| --- | --- |
| Branch | `feat/games-simplify` — the simplification pass (see `docs/ROADMAP.md`, "Games simplification"), not yet merged |
| Migrations | 21 on disk (`0000`–`0020`). Production is at `0018` (verified against the live journal 2026-10-18). **`0019` is additive (DLC table, two statuses) and goes on BEFORE the deploy; `0020` drops the sync/trophy tables and must wait until the new code is live** |
| Gate | typecheck, lint, 1357 unit, 209 integration, build — all green on the branch |
| Deployed | **Live** at `https://app.burmy.me` from the Aug 29 commit, behind Cloudflare Access |

Credentials: `IGDB_CLIENT_ID`/`SECRET` (optional; cover art and the Upcoming feed). `STEAM_API_KEY`,
`STEAM_ID`, `PSN_NPSSO` and `RAWG_API_KEY` are all dead — delete them from `.env` and Netlify.

---

## What the module is now

**Library** — a cover wall (gallery) and a dense table, filters and search, ordered last-edited
first. Clicking a cover or row opens **the game panel** beside the grid — non-modal, one column of
single-line rows with no section headings (Notes aside), every field inline-editable, re-fetching
itself after each save. There is no per-game page. Creating a game is still the small modal; a
wishlisted game's "Add to library" opens the same modal pre-filled.

**Collections** — a boxed set is one `games` row that other rows point at (`collection_id`); counts
exclude the wrapper, sums include everything. Linked in the app from either end, or several at once
from the table.

**Upcoming** — "Your wishlist" as cover cards (every wanted game, released first with "Out now" on
the art, an "Add to library" button that opens the add dialog pre-filled) above IGDB's next-12-months
feed, which hides anything already in the library. A wanted game stays wanted until the owner moves
it; a hand-added one can be given a release date in the panel.

**Stats** — computed at read time from the rows: library and money cards (plus "Trophies earned" from
the hand-entered counts), year by year, trends, breakdowns, Top 3, highlights.

**DLC** — rows on a game (name, year played, hours, price, trophies), ADDITIVE to the base figures;
every total the app shows is base + DLC, including the panel's rows (read-only while DLC exists; the
base is edited on its own line through a small dialog). Two statuses only: `played` and `wanted`,
and the word "played" is never printed. See `docs/GAMES.md`, "DLC" and "Lifecycle statuses".

**Removed 2026-10-18, by owner decision:** the Steam and PSN syncs, the per-trophy list, the
Duplicates screen, the Settings → Games section. Git history before `3324656` has the implementations.

---

## Gotchas that cost real debugging time

### IGDB

- **`category` is dead.** `where category = 0` returns **zero rows** against live IGDB. Use
  `game_type` (`0 = Main Game`), confirmed by querying `/game_types` directly.
- **`status != (6,7)` is a landmine**, not a safety filter. `status` is unset on virtually every
  upcoming game and IGDB's `!=` drops nulls — adding it collapsed a real 45-game result to **1**. Do
  not re-add it.
- **IGDB returns `release_dates` rows in the PAST** even for a strictly future-only query.
  `groupByMonth` rejects months before the current one.
- `hypes` is the ONLY pre-release signal — every rating field is empty before launch. `HYPE_FLOOR =
  30` was calibrated against live data (10→120 games, 20→66, 30→45, 50→27); re-measure if you change
  it, don't nudge it.

### The panel (Radix, non-modal)

- Radix still dismisses a non-modal dialog on any outside pointer-down — `onInteractOutside` is
  prevented so clicking another cover swaps instead of closing.
- Escape is caught by a document-level CAPTURE listener before the focused input sees it —
  `onEscapeKeyDown` is prevented when the target is a text control, so Esc cancels the field and a
  second Esc closes the panel.
- The panel is `z-40` on purpose: toasts, nested dialogs, Select content and the mobile nav are
  `z-50` and must sit above it.
- The panel's copy of the game is state, not a prop — a save's `revalidatePath` refreshes the page
  behind, not the panel, which is why it re-fetches after every `ok`.

### Postgres / Drizzle

- **`drizzle-kit generate` produced a DESTRUCTIVE type swap** for the `completed` → `played` enum
  rename. `drizzle/0013_*.sql` is hand-written as `ALTER TYPE … RENAME VALUE`. **Always read generated
  SQL for enum changes.** (`0019`, a pure drop, generated cleanly — read it anyway.)
- `paused_dropped` is still in the Postgres enum, deliberately — Postgres has no `DROP VALUE`. It's
  removed from `GAME_STATUSES` so it's unreachable.
- **Migrations must be applied to the dev DB, not just Testcontainers.** `pnpm db:migrate` after
  pulling — integration tests build a fresh database and pass regardless.
- **Applying a migration through the Supabase MCP** means writing the Drizzle journal row by hand —
  hash of the file text, `created_at` = the journal `when`. See `docs/DEPLOYMENT.md`.

### Recharts / UI

- The default bar-chart tooltip cursor is an **opaque `#ccc` rectangle spanning the full plot
  height**. `TOOLTIP_STYLES` carries `cursor: false`.
- `games.genre` is **one text column holding a comma-joined list**. Split at read time; do not
  migrate the column.
- `Record<GameStatus, …>` maps are exhaustive — typecheck forces every status surface when the enum
  changes. That's deliberate.
- Nothing in `src/lib/` may import from `src/server/{finance,games,anime}/`.

---

## Design decisions the owner made — do not silently revisit

- **`played` renders no badge.** It's a non-null sentinel, not a nullable column.
- **Only `played` and `wanted`, and "played" is never shown.** `backlog` and `playing` were removed
  on 2026-10-18 ("there is no backlog"); no Status row, column or select anywhere. Do not propose a
  third state or a visible "Played".
- **The panel has no section headings, no value hints, no outlined buttons and no modals for
  editing.** Owner feedback across three rounds: "white space and double lines", "a lot of 'with
  DLC' everywhere", "I don't like the outlines", "the user should remain on the panel", "random
  numbers, hard to tell what's what". One label/value row per field, Notes included; DLC as labelled rows
  edited in place (part names in the label column, figures under a small header; the base game's
  year is First played); every row 36px, no block gaps; years as
  rows with a plus beside First played; the collection is a members list plus "+ Add games to
  collection", no toggle.
- **DLC adds; the year split attributes.** Never derive the base figures from DLC rows or make DLC
  "add up" to anything.
- **No syncs, no trophy list.** Hours, achievement counts and platinum are hand-entered. Do not
  propose re-adding Steam or PSN; the owner removed them after seven weeks of real use.
- **The panel has no URL.** Chosen over a deep link; closing is Esc, the X, or a route change.
- **Side by side, not an overlay.** The grid stays live and clicking another cover swaps the panel.
- **`wanted` is excluded from stats in exactly one place**: `listGameStatRows`.
- **A `wanted` game is never auto-flipped.** It stays on the wishlist, marked "Out now" once released,
  until the owner changes its status. (This reversed an earlier decision.)
- **Library order is last edited first.**
- Upcoming is fetched **live on every visit** — no cached table.
- **Collections only, no series/franchise concept.** Anime has a series table; Games deliberately does
  not.

---

## Outstanding (2026-10-18)

See `docs/ROADMAP.md`, "▶ RESUME HERE", for the order-sensitive sequence: Control Resonant by hand →
`0019` → the split-to-DLC SQL → merge and deploy → `0020` → reconcile the sheet.

- **No backup exists of the live Supabase database** — still the highest-priority gap; for Games there
  is no CSV archive to re-import from.
- **The sheet reconciliation has not run** (`scripts/diff-game-log.mjs`); collections are unlinked in
  production until the owner links them in the app.
- Anime has never run against the live AniList API.
- The Netlify function-region pin is unconfirmed.

---

## Working notes

- `pnpm db:migrate` after pulling — integration tests won't tell you it's needed.
- **Never run `pnpm test:e2e` against the dev database.** It truncates tables and has already
  destroyed real data once.
- Scoping a test run: `npx vitest run --project domain <name>` — `pnpm test --project X -- name` does
  NOT scope.
- Docker Desktop must be running for anything touching Postgres.
- Two Supabase MCPs can be present: the locally configured `supabase` server is signed into a different
  organization (SKAIL Org) and cannot see this project; the claude.ai Supabase connector is signed into
  Burmy's Org and can. Check `list_organizations` before trusting either.
