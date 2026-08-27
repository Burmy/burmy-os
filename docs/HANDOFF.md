# Handoff — Games module, 2026-08-25

Written at the end of a long session so the next one can pick up cold. **Read
`CLAUDE.md` first** (invariants, stack, gotchas), then this. `docs/GAMES.md`
is canonical for the Games domain; where it and the code disagree, the code
wins and the doc is a bug.

---

## Where things stand

| | |
| --- | --- |
| Branch | `feat/game-tracker`, **85 commits ahead of `main`**, unmerged, unpushed |
| HEAD | `2d34899` |
| Migrations | 14 on disk, 14 applied to local dev |
| Gate | typecheck, lint, **1062 unit + 296 integration**, build — all green |
| Library | 170 played · 1 playing · 9 backlog · 2 wanted |
| Deployed | **Nothing.** M10 never happened — Supabase has no games tables at all |

Credentials in `.env` and all working: `IGDB_CLIENT_ID`/`SECRET`,
`STEAM_API_KEY`/`STEAM_ID`, `PSN_NPSSO`. `RAWG_API_KEY` is dead — RAWG was
replaced by IGDB; the var is vestigial.

---

## What got built

**Play-year attribution.** `games.hours_tenths` stays the authoritative total;
`game_play_years` rows are an optional attribution of it saying *which years*.
Fixed 43 hours that were credited to the wrong year.

**In-app Steam sync.** Stage → review → commit, modelled on the Finance import
flow. Chunked with keyset pagination; `done` comes from an empty chunk.

**PSN sync.** Via `psn-api` (official endpoints). Play time, first-played,
PS4-vs-PS5 platform, trophies, platinum.

**Upcoming tab + wishlist.** IGDB `hypes >= 30`, next 12 months, PS5+PC,
grouped by month with a Later/TBD bucket.

**Then five fixes from real use:** the status-model rework, shared UI
primitives across Finance and Games, a stats-page redesign, IGDB enrichment of
synced games, and a Games section in Settings.

---

## Gotchas that cost real debugging time

These were all found the hard way. Do not rediscover them.

### IGDB

- **`category` is dead.** `where category = 0` returns **zero rows** against
  live IGDB. Use `game_type` (`0 = Main Game`), confirmed by querying
  `/game_types` directly.
- **`status != (6,7)` is a landmine**, not a safety filter. `status` is unset
  on virtually every upcoming game and IGDB's `!=` drops nulls — adding it
  collapsed a real 45-game result to **1**. Do not re-add it.
- **IGDB returns `release_dates` rows in the PAST** even for a strictly
  future-only query. `groupByMonth` rejects months before the current one.
- `hypes` is the ONLY pre-release signal — every rating field is empty before
  launch. `HYPE_FLOOR = 30` was calibrated against live data (10→120 games,
  20→66, 30→45, 50→27); re-measure if you change it, don't nudge it.

### PSN

- **`titleId` (`CUSA…`) and `npCommunicationId` (`NPWR…`) are different
  identifier spaces** with no join key but the game's name. That is why
  `games` carries both columns.
- **The title-ID prefix encodes the platform**: `CUSA` = PS4, `PPSA` = PS5.
  This is what recovers the platform for the 13 titles PSN reports as
  `category: unknown` (real games — Cyberpunk PS4, Control, inFAMOUS).
- **PSN returns media apps as played games.** `ps4_videoservice_web_app` and
  `ps4_nongame_mini_app` — Netflix at 357h, YouTube at 642h. Filtered out by a
  pattern rule (category containing `app`, or `not_found`), not a fixed list.
- **One game can appear under several title IDs.** Ghost of Tsushima returned
  three (107h, 53min, 2min). Deduped at staging, keeping the most playtime.
- **PSP is permanently manual and structurally protected.** An unlinked
  `platform === 'psp'` row skips name-matching entirely, because
  `categoryToPlatform` can never return `psp`. Without that guard, Sony's PS5
  re-release of *Persona 3 Portable* would relabel the PSP copy.
- The NPSSO expires roughly every 60 days and must be re-pasted by hand.
  Token age is tracked by fingerprinting the token onto successful runs.

### Postgres / Drizzle

- **`drizzle-kit generate` produced a DESTRUCTIVE type swap** for the
  `completed` → `played` enum rename — drop and recreate, whose `USING` cast
  would have failed on all 171 existing rows. `drizzle/0013_*.sql` is
  hand-written as `ALTER TYPE … RENAME VALUE`. **Always read generated SQL for
  enum changes.**
- `paused_dropped` is still in the Postgres enum, deliberately — Postgres has
  no `DROP VALUE`, and a type swap wasn't worth it for a value with zero rows.
  It's removed from `GAME_STATUSES` so it's unreachable.
- **An error inside a transaction poisons it.** A plain try/catch around one
  failing `INSERT` still leaves every later statement failing.
  `commitSyncRun` uses a **SAVEPOINT per insert**. `ON CONFLICT DO NOTHING`
  was rejected — three unique indexes can't share one conflict target.
- **A staged run is a snapshot and can go stale.** The library moves under it,
  so commit skips a `new_game` that now exists and reports the skip count.
- **Migrations must be applied to the dev DB, not just Testcontainers.** One
  bug this session was purely a forgotten `pnpm db:migrate` — integration
  tests build a fresh database and pass regardless.

### Recharts / UI

- The default bar-chart tooltip cursor is an **opaque `#ccc` rectangle
  spanning the full plot height**. `TOOLTIP_STYLES` now carries
  `cursor: false`.
- `games.genre` is **one text column holding a comma-joined list**. Bucketing
  by exact string made each genre *combination* its own bar. Split at read
  time; do not migrate the column.
- `Record<GameStatus, …>` maps are exhaustive — typecheck forces every status
  surface when the enum changes. That's deliberate.
- `src/lib/format-date.ts` imports from `@/server/finance/grid`. **Games must
  never use it** — `CLAUDE.md` forbids the two modules importing each other.

---

## Design decisions the owner made — do not silently revisit

- **`played` renders no badge.** It's a non-null sentinel, not a nullable
  column, so counts and filters stay simple non-null SQL.
- **Steam owns hours and achievements for linked games** — read-only in the
  editor, no per-field override.
- **PSN owns `platinum`**, reversing Steam's "never touch platinum" rule.
  Sony is the system of record for PlayStation trophies.
- **Sync never deletes or hides a game.** 40 PSP and 12 unmatched Steam games
  can never appear in any API response. Named integration tests enforce this.
- **Nothing is written without explicit approval** — every change stages first.
- **`wanted` is excluded from stats in exactly one place**: `listGameStatRows`.
  Not in the six stat functions — one rule can't be forgotten, six can.
- **A `wanted` game auto-flips to `backlog`** once its release date passes.
  This edits data unprompted, deliberately. It runs from a client mount
  effect, never a Server Component render.
- Upcoming is fetched **live on every visit** — no cached table.
- Separate Steam and PSN sync buttons, so a dead PSN token never blocks Steam.

---

## Outstanding

**Immediate**

1. **Eight stale `ready` sync runs sit in the dev database.** Two contain
   Netflix and YouTube as games, staged before that filter existed —
   committing one would put them in the library. The owner planned a **reset
   sync**: cancel or ignore these and run fresh.
2. Nothing has been merged or pushed. 85 commits on `feat/game-tracker`.

**Known, accepted**

- PSN sync has never been verified end-to-end against a *committed* run — every
  run so far was staged and reviewed, never committed.
- A game inserted mid-run whose id sorts before the keyset bookmark is skipped
  until the next run. Accepted over the duplicate-staging it replaced.
- An interactive IGDB search landing during an enrichment run can briefly
  exceed 4 req/s. Worst case is one empty autocomplete; `igdbPost` soft-fails.
- `docs/ROADMAP.md`, `ARCHITECTURE.md` and `SECURITY.md` still don't mention
  Games at all.
- M10 (deployment) remains unstarted. Supabase has the Finance schema only.

**Deferred minors** are recorded in the commit messages of the branch rather
than a separate list.

---

## Working notes

- `pnpm db:migrate` after pulling — integration tests won't tell you it's
  needed.
- **Never run `pnpm test:e2e` against the dev database.** It truncates tables
  and has already destroyed real data once.
- Scoping a test run: `npx vitest run --project domain <name>` —
  `pnpm test --project X -- name` does NOT scope.
- Docker Desktop must be running for anything touching Postgres.
