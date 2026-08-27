# Games: Play-Year Attribution, In-App Sync, and PSN — Design

## Context

The Games module (`docs/GAMES.md`) currently holds 160 hand-curated games imported from a Google
Sheet, plus a Steam enrichment path that runs as a local-only CLI script
(`scripts/sync-steam-library.mjs`). Real usage surfaced three separate gaps:

1. The Yearly Breakdown attributes every hour to `first_played_year`, so a game played across two
   years reports all its hours in the first. **43 hours currently sit in the wrong year.**
2. Steam enrichment requires a terminal, a running Docker Postgres, and a hand-typed command. The
   owner wants a button.
3. PlayStation — 113 of 160 games — has no integration at all, and the PS4/PS5 split was
   reconstructed from spreadsheet cell background colours rather than from real data.

This document specifies all three. They are sequenced, not simultaneous: Part 1 has no external
dependencies, Part 3 reuses infrastructure built in Part 2.

### Library composition (measured 2026-08-23)

| Platform | Games | Linked to an external API |
|---|---|---|
| steam | 47 | 35 |
| ps4 | 45 | 0 |
| psp | 40 | 0 — permanently unlinkable |
| ps5 | 28 | 0 |

---

## Non-negotiable invariants

These are correctness rules for this feature set, in the same spirit as the invariants in
`CLAUDE.md`. Violating one is a bug, not a preference.

1. **Sync never deletes a game, ever.** No sync path may issue `DELETE` against `games`, and no
   sync may mark a game inactive, hidden, or archived. A row the API does not know about is skipped
   and left byte-identical. This is not a soft guideline: **40 PSP games and 12 unmatched Steam
   games can never appear in any API response**, and a "mirror the API" reading of sync would
   destroy a quarter of the library. The current Steam script already has this property (verified:
   no delete path exists in it); this makes it a rule rather than an accident.
2. **Sync never invents a game's identity.** A staged link between a library row and an external
   game is either high-confidence by the existing matcher (`SIMILARITY_FLOOR = 0.70` in
   `src/server/games/metadata.ts`) or it is presented for review. No low-confidence match is ever
   auto-applied — the rule the Steam script already enforces.
3. **No sync writes without owner approval.** Every run stages its intended changes and commits
   only on an explicit approval action. There is no "apply silently" path.
4. **External credentials remain optional and soft-failing.** `STEAM_API_KEY`, `STEAM_ID` and the
   new `PSN_NPSSO` are all optional. Their absence is a normal state, the UI degrades to "not
   configured," and **the full test suite must pass with none of them present** — the same contract
   IGDB and Steam already hold (`CLAUDE.md`).
5. **Hours stay integer tenths of an hour.** All conversion goes through `src/server/games/hours.ts`
   and nothing else does hours math, including the new ISO-8601 duration parsing for PSN.
6. **`src/server/games/` stays framework-free.** Duration parsing, year attribution, and provenance
   derivation are pure functions with no React, Next, or HTTP.

---

## Shared model: provenance

The owner's stated confusion — *"i am confused what is from steam and what is from my manual
entry"* — is solved structurally rather than with a decorative badge.

**A game is linked when it carries an external id.** No new provenance column is required; source is
derived:

| Condition | Source | Hours & achievement counts |
|---|---|---|
| `steam_appid IS NOT NULL` | Steam | Owned by Steam — **read-only in the editor** |
| `psn_entitlement_id IS NOT NULL` | PlayStation | Owned by PSN — **read-only in the editor** |
| neither | Manual | Fully editable, as today |

This follows directly from the owner's decision that **Steam always wins, with no per-field
override**. Because an API-owned field cannot be typed into, the UI answers "where did this number
come from?" by construction — the field is disabled and labelled with its source. An earlier design
round assumed a `manual_overrides` column would be needed to track hand-edits; that decision
removes the need for it entirely, and it is deliberately **not** built.

Provenance is surfaced in three places:

- **Library card / table row** — a small source mark (Steam, PlayStation, or Manual).
- **Game editor** — API-owned fields render read-only with a "from Steam" / "from PlayStation" label.
- **Filters** — the existing filter chip row gains a Source facet, so "show me everything still
  manual" is one click. This is how the owner audits the 40 PSP and 12 unmatched entries.

### What happens to a manual entry the API does not have

Nothing. It is not staged, not flagged, not touched. It keeps its manual status and stays fully
editable forever. PSP games are the permanent case; the 12 Steam-platform games Steam does not own
(the GTA titles, the Half-Life 2 episodes, Team Fortress 2, Bloody Roar 2, Twisted Metal 2, Pocket
Tanks) are the already-observed case, unchanged across two applied syncs.

---

## Part 1 — Per-year hour attribution

**Depends on nothing. Build first.**

### Problem

`buildYearlyBreakdown` (`src/server/games/stats.ts:113`) sums `row.hoursTenths` into the bucket for
`row.firstPlayedYear`. `first_played_year` is therefore doing two unrelated jobs: *when did I start
this* and *which year owns these hours*. For 157 games those coincide. For three they do not:

| Game | Platform | Stored year | Total | True split |
|---|---|---|---|---|
| Clair Obscur: Expedition 33 | ps5 | 2025 | 59h | 53 (2025) + 6 (2026) |
| Hollow Knight | steam | 2024 | 49h | 37 (2024) + 12 (2025) |
| Lies of P | ps5 | 2024 | 77h | 52 (2024) + 25 (2025) |

The sheet encoded this as `"53 + 6"` strings, which the import preserved only as prose in `notes`.

**Neither Steam nor PSN can ever supply this.** Steam's `GetOwnedGames` returns only
`playtime_forever` and `playtime_2weeks`; PSN's `getUserPlayedGames` returns a single cumulative
`playDuration`. Per-year attribution is permanently hand-entered, for a handful of games. The design
is sized accordingly.

### Data model

```sql
create table game_play_years (
  id            uuid primary key default gen_random_uuid(),
  owner_id      text not null references "user"(id) on delete cascade,
  game_id       uuid not null references games(id) on delete cascade,
  year          smallint not null,
  hours_tenths  integer  not null check (hours_tenths >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (game_id, year)
);
```

`owner_id` is carried explicitly, matching every other table in the app, so data access stays
owner-scoped without relying on a join through `games`.

### Attribution rule

- A game with **≥1** `game_play_years` row uses those rows as its attribution.
- A game with **no** rows attributes all of `hours_tenths` to `first_played_year` — exactly today's
  behaviour, so 157 games need no migration and no backfill.
- **`games.hours_tenths` remains the authoritative total.** The split rows are an *attribution of*
  that total, not a replacement for it. This matters because Steam and PSN own the total for linked
  games and have no concept of years.

### The reconciliation rule

The sum of a game's play-year rows must equal `hours_tenths`. Two ways it can break:

- **Owner edits the split** — validated in the editor; a split that does not sum is a form error and
  cannot be saved.
- **An API changes the total underneath a split** — Hollow Knight is the live case: Steam owns its
  49h total, and a sync that moves it to 51h leaves the 37+12 split stale. Per the owner's decision
  (*"Steam owns the total, I adjust"*), the sync **applies the new total** and raises a
  reconciliation item in the sync review: *"Hollow Knight: total is now 51.0h, your split accounts
  for 49.0h — 2.0h unattributed."* The owner rebalances. The app never silently guesses which year
  the extra hours belong to.

Until reconciled, unattributed hours are reported in the Yearly Breakdown under an explicit
`Unattributed` line rather than being quietly dropped or quietly assigned. A number that does not
add up must be visible, not rounded away.

### Editor UI

`hours` stays the single number the owner edits for the ~157 normal games. A collapsed **"Split
across years"** control expands to a small repeatable year + hours list. The running sum is shown
against the total with a live mismatch warning.

For an API-linked game the total is read-only (see Provenance) but **the split remains editable** —
Steam knows the total, only the owner knows which year it happened in.

### Stats changes

`buildYearlyBreakdown` takes play-year attribution rows rather than deriving years from games alone.
The Yearly Breakdown table gains a column, per the owner's choice of *both*:

| Column | Meaning |
|---|---|
| **Started** | games whose `first_played_year` is this year — today's count, unchanged |
| **Played** | distinct games with attributed hours in this year |
| **Hours** | sum of hours attributed to this year — **the number this whole part exists to fix** |
| Trophies | unchanged |

`Started` still sums to the library total across years; `Played` deliberately does not, because a
game spanning two years is genuinely played in both. Both columns are labelled in the UI so the
difference is legible without remembering this document.

### Seeding the three known splits

The three splits are recoverable from the `notes` text and verified to sum correctly (53+6=59,
37+12=49, 52+25=77). This is done by a one-off script following the established precedent of
`scripts/fix-game-platforms.mjs` and `scripts/backfill-game-metadata.mjs` — **not** a SQL data
migration, because migrations run in both local and production against different `games.id` values
and title-keyed `UPDATE`s in a migration are fragile. Dry-run by default, `--apply` to write, same
contract as the existing scripts.

### Testing

- Unit (`src/server/games/stats.ts`): a game with no play-year rows attributes to `first_played_year`;
  a split game attributes to each year; `Started` vs `Played` diverge for a spanning game;
  unattributed remainder is reported, not swallowed. Zero-hour and null-year rows stay excluded.
- Unit (validation): split sums matching / not matching the total.
- Integration: `game_play_years` cascade on game delete; the `(game_id, year)` unique constraint;
  owner scoping.
- Component: the split panel's live sum and mismatch warning.

---

## Part 2 — In-app Steam sync

**Depends on Part 1** only for the reconciliation item type. Build second.

### Execution model

The existing script makes ~47 throttled Steam calls per run. Netlify's synchronous function timeout
(10s default) cannot hold that; background functions allow 15 minutes but are a separate build
target from the Next.js runtime and return no result to the caller.

**Chosen approach: client-driven chunking.** The button creates a sync run, then the client calls a
Server Action repeatedly, each call processing a small batch of games (~5) and returning progress,
until the run reports complete.

Rationale over a background function:

- Every request stays far inside the timeout, on any host, with no platform-specific function
  wiring and no divergence between local dev and production.
- Progress is real and incremental rather than a spinner over an opaque 202.
- The run row persists, so closing the tab mid-sync leaves a resumable run rather than a lost one.
- It sidesteps an unverified assumption about mixing raw Netlify functions with the OpenNext Next.js
  runtime — a risk that would otherwise need a spike before this part could be estimated at all.

Throttling between Steam calls is preserved inside each batch.

### Data model

```sql
create type game_sync_source as enum ('steam', 'psn');
create type game_sync_run_status as enum ('running', 'ready', 'committed', 'failed', 'cancelled');

create table game_sync_runs (
  id           uuid primary key default gen_random_uuid(),
  owner_id     text not null references "user"(id) on delete cascade,
  source       game_sync_source not null,
  status       game_sync_run_status not null default 'running',
  cursor       integer not null default 0,   -- games processed, drives chunking
  total        integer not null default 0,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table game_sync_changes (
  id           uuid primary key default gen_random_uuid(),
  owner_id     text not null references "user"(id) on delete cascade,
  run_id       uuid not null references game_sync_runs(id) on delete cascade,
  game_id      uuid references games(id) on delete cascade,  -- null for a new game
  kind         text not null,      -- 'link' | 'field_update' | 'new_game' | 'reconcile'
  selected     boolean not null default true,
  payload      jsonb not null,     -- proposed values + the current values they replace
  created_at   timestamptz not null default now()
);
```

`game_sync_changes.payload` records both the proposed value and the value it would replace, so the
review screen can show a real before/after and the commit can detect if the row changed underneath
the run.

### Review and commit

Route: `/games/sync/[runId]`. Changes are grouped:

- **New games** — Steam-owned games with no library row. Pre-selected, per the owner's decision to
  add automatically; still visible and deselectable, because the write happens only on approval.
- **Field updates** — hours and achievement counts diverging from Steam.
- **Links** — a library row matched to a Steam appid for the first time.
- **Needs attention** — reconciliation items (Part 1) and any match the matcher scored below the
  confidence floor. Never pre-selected.

Commit applies only selected changes in one transaction, then marks the run `committed`. A run is
immutable once committed.

This mirrors the Finance import flow's stage → review → commit shape, which the owner already knows,
rather than inventing a second review idiom.

### Behaviour changes to existing surfaces

- Game editor: `hours`, `achievementsUnlocked`, `achievementsTotal` become **read-only for
  Steam-linked games**, labelled with their source. The play-year split stays editable.
- Library: source mark per game; new Source filter facet.
- `scripts/sync-steam-library.mjs` is **kept**, not deleted — it remains the way to run a sync
  against a local database without the app running, and its local-only guard stays. The in-app path
  is additive.

### Credentials

`STEAM_API_KEY` and `STEAM_ID` move from script-only to also being read by the app. Absent
credentials: the Sync button renders disabled with an explanation, and no request path throws. The
existing vanity-name resolution (`STEAM_ID` may be a vanity name like `burmyyy`, not a SteamID64) is
reused as-is from `src/server/games/steam.ts`.

### Testing

- Unit: chunk cursor advancement; change-set construction from a stubbed Steam response; the
  no-credentials path producing a disabled state rather than an error.
- Integration: a full run staged and committed against real Postgres; **a run whose Steam response
  omits a library game leaves that game byte-identical** (invariant 1, asserted directly); commit
  applies only selected changes; a committed run rejects a second commit.
- Component: review grouping, pre-selection rules, and that "needs attention" items are never
  pre-selected.

---

## Part 3 — PSN integration

**Depends on Part 2's staging, review, and commit infrastructure.** Build third.

### Library choice

The library the owner proposed — `leonardoalemax/psn-profile-api` — is **rejected on evidence**:
created 2021-01-25 at 23:40 UTC with its final commit at 23:58 the same night, 18 stars, and it
scrapes psnprofiles.com HTML. Eighteen minutes of work, abandoned for five and a half years, against
a site whose markup has certainly changed.

**Chosen: `psn-api`** (`achievements-app/psn-api`) — MIT, 415 stars, last commit 2026-08-15, and it
calls official PlayStation endpoints rather than scraping.

### Authentication, and its permanent cost

`psn-api` authenticates from an **NPSSO token** the owner retrieves manually from
`https://ca.account.sony.com/api/v1/ssocookie` while logged in to PlayStation in a browser. Derived
access tokens last hours and refresh automatically; **the NPSSO itself expires after roughly two
months and must be re-fetched by hand.**

This cannot be automated and is the single largest ongoing cost of this part. Design consequences:

- `PSN_NPSSO` is an env var, optional like every other credential.
- Expiry is a **first-class, named state**, not a generic failure: the PSN sync surface reports
  "PlayStation token expired — paste a new one" with the retrieval URL, distinct from a network
  error or an empty result.
- PSN gets its **own** sync button, separate from Steam's (the owner's explicit choice), precisely
  so a dead PSN token never blocks a working Steam sync.

### What PSN supplies

`getUserPlayedGames` returns per game:

| Field | Maps to |
|---|---|
| `playDuration` (ISO-8601, e.g. `PT228H56M33S`) | `hours_tenths`, via a new parser in `hours.ts` |
| `firstPlayedDateTime` | `first_played_year` |
| `lastPlayedDateTime` | new `last_played_at` — enables true recently-played sorting |
| `category` (`ps4_game` / `ps5_native_game` / `pspc_game`) | `platform` |
| `playCount` | not stored — no product use today (YAGNI) |

Trophy endpoints supply earned counts by grade and platinum status.

**`category` replaces colour-derived platform data.** The PS4/PS5 split for 73 games was
reconstructed from spreadsheet cell background colours; PSN reports it authoritatively. This is a
straight upgrade in data quality and is applied like any other field update — staged, reviewed,
committed.

> **Open item for implementation, not assumed here:** `pspc_game` is believed to mean PlayStation-on-PC
> rather than PSP. It must be confirmed against a real response before any mapping is written, because
> guessing wrong would mis-platform games. It is explicitly **not** mapped to `psp`.

### Schema additions

```sql
alter table games add column psn_entitlement_id text;
alter table games add column psn_np_communication_id text;  -- trophy set id
alter table games add column last_played_at timestamptz;
create unique index games_psn_entitlement_id_owner_idx
  on games (owner_id, psn_entitlement_id) where psn_entitlement_id is not null;
```

Partial unique index, matching the `steam_appid` precedent from migration 0006.

### Platinum

PSN becomes authoritative for `platinum` on PlayStation-linked games, per the owner's "everything it
knows." **This is a deliberate reversal** of the Steam sync's rule that platinum is never touched by
automation — justified because PSN is the actual system of record for PlayStation trophies, where
Steam has no concept of them. Hand-tracked platinum values on PSN-linked games will be overwritten
by Sony's record. Staged and reviewable like everything else.

### Volume, and the risk the owner accepted

PSN's played-games list includes demos, PS Plus monthly claims, and anything ever launched. A
curated 160-game library may return **several hundred** entries. The owner chose the full mirror
knowingly after this was raised. Mitigations, none of which override that choice:

- The review gate shows the entire list before anything is written; the run can be cancelled.
- New games are grouped and countable, so "412 new games" is visible before approval, not after.
- Invariant 1 still holds: nothing existing is removed regardless of what PSN returns.

### Duplicate risk

PSN auto-add plus 73 existing hand-entered PlayStation rows means a match failure produces a
duplicate (a second "Lies of P") rather than a link. Mitigation: PSN games are matched against
existing library rows with the same matcher and confidence floor used for Steam, and any suspected
link below the floor is staged under **Needs attention** as *"this looks like your existing entry —
link instead of adding?"* rather than silently creating a row.

### Testing

- Unit: ISO-8601 duration → tenths, including hours-only, minutes-only, and second-rounding cases;
  `category` → platform mapping; `firstPlayedDateTime` → year; expired-token detection distinguished
  from network failure.
- Integration: PSN run staged and committed; **PSP games untouched by a PSN run** (invariant 1,
  asserted directly — this is the owner's stated fear and deserves a named test);
  duplicate-suspicion routing to review rather than insertion.
- The whole suite passes with `PSN_NPSSO` unset.

---

## Out of scope

- Per-achievement detail (name, unlock date, rarity). Counts only, as in the original Games spec.
- Xbox, GOG, Epic, or any third platform.
- Automatic/scheduled syncing. Both syncs are owner-triggered; PSN's two-month token makes unattended
  scheduling actively misleading.
- Any link between game price and Finance transactions.
- Automating NPSSO retrieval. It requires an authenticated browser session and cannot be done
  server-side.

## Sequencing

1. **Part 1** — no external dependencies, fixes 43 misattributed hours, deliverable on its own.
2. **Part 2** — builds the staging/review/commit infrastructure.
3. **Part 3** — consumes that infrastructure; highest external risk, gated behind a manual token.

Each part gets its own implementation plan and ships independently.

## Deployment note

`docs/ROADMAP.md` records that **nothing has been deployed** — M10 is still awaiting external
rollout, and Supabase has no `games` table (migrations 0004–0006 unapplied). The owner's "prod is the
priority" applies to how this is *built* (no localhost-only assumptions, credentials read from env,
chunking that survives a serverless timeout), but none of it can be exercised in production until
M10 completes. All three parts are testable locally in the meantime.
