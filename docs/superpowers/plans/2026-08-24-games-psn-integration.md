# PSN Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring PlayStation play time, first-played dates, PS4-vs-PS5 platform and trophy counts into the library, reusing the staging and review machinery the Steam sync already has.

**Architecture:** `psn-api` (official PSN endpoints, MIT) behind one soft-failing client module, a pure mapping module for its data shapes, and a chunked engine that stages changes into the same `game_sync_runs`/`game_sync_changes` tables the Steam sync uses. The review screen and commit are reused as-is with `source: 'psn'`.

**Tech Stack:** `psn-api`, Next.js 16.3 Server Actions, Drizzle 0.45, PostgreSQL 18, Vitest, Testcontainers.

**Spec:** `docs/superpowers/specs/2026-08-23-games-sync-and-play-years-design.md` (Part 3)

## Verified API facts — do not re-derive, and do not assume beyond these

Every item below was checked against `achievements-app/psn-api`'s real source on 2026-08-24. **Four of them correct errors in the spec.** Where something is still unverified it says so explicitly — verify it before writing code that depends on it.

| Fact | Detail |
|---|---|
| Auth flow | `exchangeNpssoForAccessCode(npsso)` → `exchangeAccessCodeForAuthTokens(code)` → `{ accessToken, refreshToken, expiresIn, … }`. Also `exchangeRefreshTokenForAuthTokens`. |
| Played games | `getUserPlayedGames(auth, accountId, options?)` returns `{ titles: [...], totalItemCount, nextOffset, previousOffset }` — **PAGINATED.** The spec did not account for this. |
| Title fields | `titleId`, `name`, `localizedName`, `imageUrl`, `category`, `service`, `playCount`, `firstPlayedDateTime`, `lastPlayedDateTime`, `playDuration` |
| **Spec correction 1** | The identifier is **`titleId`**, NOT `entitlement_id`. The spec's `psn_entitlement_id` column name is wrong — use `psn_title_id`. |
| Trophy titles | `getUserTitles(auth, accountId)` returns `TrophyTitle[]`: `npServiceName`, **`npCommunicationId`**, `trophySetVersion`, `trophyTitleName`, `trophyTitleIconUrl`, `trophyTitlePlatform`, `hasTrophyGroups`, `definedTrophies`, `progress`, `earnedTrophies`, `hiddenFlag`, `lastUpdatedDateTime` |
| **Spec correction 2 — the big one** | **`titleId` and `npCommunicationId` are DIFFERENT identifier spaces** (`CUSA…` vs `NPWR…`). There is no join key between played-games and trophy data except the **name**. Trophy counts and platinum therefore require a name match, with all the risk that carries. The spec assumed one id. |
| **Spec correction 3** | `TrophyCounts`' exact shape was NOT verified. It is referenced by `definedTrophies`/`earnedTrophies` and is expected to be `{bronze, silver, gold, platinum}`. **Verify before use** — read `src/models/trophy-counts.model.ts` in the installed package. |
| **Spec correction 4** | `psn-api`'s package.json has a **`prepare: "vite build"`** script. `prepare` does not run for a registry install, only a git install — but if `pnpm install` reports `ERR_PNPM_IGNORED_BUILDS`, fix it in `pnpm-workspace.yaml` under `allowBuilds` with an explicit boolean and a recorded reason (see the CLAUDE.md gotcha; it takes out typecheck, lint, test and build at once, not just install). |
| NPSSO lifetime | Obtained manually from `https://ca.account.sony.com/api/v1/ssocookie` while logged in. Access tokens last hours; **the NPSSO itself expires after roughly two months** and must be re-pasted by hand. |
| `category` values | `ps4_game`, `ps5_native_game`, `pspc_game` observed. **`pspc_game` is BELIEVED to mean PlayStation-on-PC, not PSP — this is UNVERIFIED.** Confirm against a real response before mapping it. It must NEVER map to `psp`. |

## Global Constraints

- **Sync NEVER deletes a game.** No PSN path may `DELETE` from `games` or mark one hidden. **40 PSP games predate PSN's trophy system and can never appear in any response** — they are permanently manual. Named integration test required.
- **No sync writes without owner approval.** PSN reuses the existing stage → review → commit flow; nothing bypasses it.
- **`PSN_NPSSO` is optional and its absence is a normal state.** The UI degrades to "not configured"; no request path throws. **The full test suite must pass with it unset.**
- **Token expiry is a first-class named state**, not a generic failure — the UI must say "PlayStation token expired, paste a new one" with the retrieval URL, distinctly from a network error.
- Hours are integer TENTHS; all conversion through `src/server/games/hours.ts`.
- `src/server/games/` stays framework-free. `steam.ts` and `metadata.ts` stay dependency-free LEAF modules — `scripts/*.mjs` import them under bare `node`.
- Every protected server entry point calls `await requireOwner()` itself.
- `exactOptionalPropertyTypes` is on; omit keys rather than assigning `undefined`.
- Drizzle index callbacks return an ARRAY. Drizzle wraps driver errors — the SQLSTATE is on `error.cause`.
- Never run `pnpm test:e2e` — it truncates the owner's real database.
- Gate: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration`.

## Standing limitation for this whole plan

**No `PSN_NPSSO` is configured, so nothing here can be verified end-to-end against real PlayStation data.** Every task must therefore be provable by unit and integration tests with the client mocked, and the whole feature must degrade cleanly to "not configured". The first real run happens when the owner pastes a token. Do not fake a token, and do not skip a verification step silently — say it could not be run.

---

### Task 1: PSN client and pure mapping

**Files:**
- Modify: `package.json` (add `psn-api`)
- Create: `src/server/games/psn.ts` (pure)
- Create: `src/server/db/games/psn-client.ts` (the one HTTP boundary)
- Test: `tests/unit/games-psn.test.ts`

**Interfaces produced:**
- `src/server/games/psn.ts` (pure, no imports outside `src/server/games/`):
  - `function parsePlayDuration(iso: string): number` — ISO-8601 duration → integer tenths of an hour
  - `function categoryToPlatform(category: string): GamePlatform | null`
  - `interface PsnPlayedTitle { readonly titleId: string; readonly name: string; readonly platform: GamePlatform | null; readonly hoursTenths: number; readonly firstPlayedYear: number | null; readonly lastPlayedAt: string | null }`
  - `function toPlayedTitles(payload: unknown): PsnPlayedTitle[]` — defensive, skips malformed entries, never throws
  - `interface PsnTrophyTitle { readonly npCommunicationId: string; readonly name: string; readonly earned: number; readonly total: number; readonly platinum: boolean }`
  - `function toTrophyTitles(payload: unknown): PsnTrophyTitle[]`
- `src/server/db/games/psn-client.ts`:
  - `function psnConfigured(): boolean`
  - `type PsnFailure = 'not_configured' | 'token_expired' | 'unavailable'`
  - `function fetchPlayedTitles(): Promise<PsnPlayedTitle[] | PsnFailure>`
  - `function fetchTrophyTitles(): Promise<PsnTrophyTitle[] | PsnFailure>`

- [ ] **Step 1: Add the dependency**

```bash
pnpm add psn-api
pnpm typecheck
```

If `pnpm install` prints `ERR_PNPM_IGNORED_BUILDS`, add `psn-api` to `pnpm-workspace.yaml`'s `allowBuilds` with an explicit `false` and the reason "registry install; its `prepare` script is a source build we do not need." Do not delete a placeholder stanza pnpm adds — replace the placeholder with a real boolean.

- [ ] **Step 2: Write the failing pure tests**

Create `tests/unit/games-psn.test.ts`. Cover:

```ts
describe('parsePlayDuration', () => {
  it('parses hours, minutes and seconds', () => {
    expect(parsePlayDuration('PT228H56M33S')).toBe(2290); // 228.94h → 2289.4 → rounds to 2289? verify
  });
  it('parses an hours-only duration', () => expect(parsePlayDuration('PT5H')).toBe(50));
  it('parses a minutes-only duration', () => expect(parsePlayDuration('PT30M')).toBe(5));
  it('rounds to the nearest tenth', () => expect(parsePlayDuration('PT0H3M')).toBe(1)); // 0.05h → 1 tenth
  it('returns 0 for an unparseable string rather than NaN', () => expect(parsePlayDuration('nonsense')).toBe(0));
  it('returns 0 for an empty string', () => expect(parsePlayDuration('')).toBe(0));
});
```

**Compute each expected value yourself from the algorithm before writing it down** — `PT228H56M33S` is 228 + 56/60 + 33/3600 hours; work out the exact tenths and use that number. Do not copy the illustrative value above without checking it.

```ts
describe('categoryToPlatform', () => {
  it('maps ps4_game to ps4', () => expect(categoryToPlatform('ps4_game')).toBe('ps4'));
  it('maps ps5_native_game to ps5', () => expect(categoryToPlatform('ps5_native_game')).toBe('ps5'));
  it('never maps anything to psp', () => {
    for (const c of ['ps4_game', 'ps5_native_game', 'pspc_game', 'unknown']) {
      expect(categoryToPlatform(c)).not.toBe('psp');
    }
  });
  it('returns null for an unrecognised category rather than guessing', () => {
    expect(categoryToPlatform('something_new')).toBeNull();
  });
});
```

`pspc_game` maps to `null` until its meaning is confirmed — a `null` platform means "PSN did not tell us something we can use", and the engine leaves the stored platform alone. **Never map it to `psp`.**

```ts
describe('toPlayedTitles', () => {
  it('shapes a well-formed response', () => { /* one real-shaped title object */ });
  it('skips a malformed entry rather than throwing', () => { /* titles: [null, {...valid}] */ });
  it('returns [] for a payload with no titles key', () => expect(toPlayedTitles({})).toEqual([]));
  it('extracts the year from firstPlayedDateTime', () => { /* '2015-07-10T19:40:19Z' → 2015 */ });
  it('returns a null year when firstPlayedDateTime is absent', () => {});
});

describe('toTrophyTitles', () => {
  it('sums earned trophies across all four grades', () => {});
  it('sums defined trophies across all four grades', () => {});
  it('reports platinum true only when an actual platinum was earned', () => {});
  it('reports platinum false when the title defines one but it is unearned', () => {});
  it('reports platinum false when the title defines no platinum at all', () => {});
  it('skips a malformed entry rather than throwing', () => {});
});
```

Fill every body with real assertions.

**Before writing `toTrophyTitles`, read `TrophyCounts`' real definition** in `node_modules/psn-api/dist` or the installed source. If it is not `{bronze, silver, gold, platinum}`, the shape in the code is authoritative and these tests must match it.

- [ ] **Step 3: Run to verify failure, then implement `src/server/games/psn.ts`**

`parsePlayDuration` parses ISO-8601 with a regex over `PT(\d+H)?(\d+M)?(\d+S)?` and converts to tenths via a single rounded computation. It must not import from `hours.ts` if that would break the pure-leaf rule — check whether `hours.ts` is itself a leaf (it is) and import `minutesToHoursTenths` only if the arithmetic genuinely maps to minutes; otherwise do the tenths conversion here and document why, since this is a duration string, not a minute count.

- [ ] **Step 4: Implement the client**

`src/server/db/games/psn-client.ts` holds the only HTTP boundary. It must:
- Return `'not_configured'` when `PSN_NPSSO` is unset — a distinct value, not `null`, because the UI has to tell that apart from a failure. **This is the mistake the Steam client's `[]`-vs-`null` ambiguity caused in Part 2; do not repeat it.**
- Exchange the NPSSO for tokens on first use and memoize them for the process lifetime, refreshing with `exchangeRefreshTokenForAuthTokens` when the access token expires.
- Return `'token_expired'` when the NPSSO itself is rejected — the ~2-month expiry — so the UI can say "paste a new token."
- Return `'unavailable'` for a network error, timeout, non-2xx or malformed JSON. **Never throw.**
- **Follow pagination**: `getUserPlayedGames` returns `nextOffset`; keep requesting until the pages are exhausted, with a hard cap (say 20 pages) so a malformed `nextOffset` cannot loop forever.
- Resolve the account id once via `getProfileFromUserName` (or the `'me'` convention if the library supports it — verify which).

- [ ] **Step 5: Gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
env -u PSN_NPSSO pnpm test   # must also pass
git add package.json pnpm-lock.yaml src/server/games/psn.ts src/server/db/games/psn-client.ts tests/unit/games-psn.test.ts
git commit -m "feat(games): PSN client and pure mapping"
```

---

### Task 2: Schema for PSN identity

**Files:**
- Modify: `src/server/db/schema.ts`
- Create: `drizzle/0010_*.sql` (generated)
- Modify: `src/server/db/games/games.ts` (`Game` gains the new fields)
- Test: `tests/integration/games.test.ts` (extend)

Add to `games`:

```ts
psnTitleId: text('psn_title_id'),
psnNpCommunicationId: text('psn_np_communication_id'),
lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
```

and a partial unique index mirroring the `steamAppid` precedent:

```ts
uniqueIndex('games_owner_psn_title_id_idx')
  .on(t.ownerId, t.psnTitleId)
  .where(sql`${t.psnTitleId} is not null`),
```

**`psn_title_id` is text, not a number** — PSN ids look like `CUSA12345_00`. **`psn_np_communication_id` is a SEPARATE identifier space** (`NPWR12345_00`) used only for trophy data; both are stored because there is no join between them but the name.

Update `Game` and `rowToGame`. Adding required fields to `Game` will break existing test fixtures — grep for files constructing a full `Game` (`tests/unit/games-game-dialog.test.tsx`, `tests/unit/games-library-view.test.tsx`, `tests/unit/games-game-table.test.tsx` at least) and add the new fields as `null` there.

Integration tests: the partial unique index rejects two rows with the same `psn_title_id` for one owner but allows many nulls; owner scoping holds.

- [ ] Steps: add to schema → `pnpm db:generate` → read the SQL → `pnpm db:migrate` → write tests → implement → gate → commit `feat(games): PSN identity columns`.

---

### Task 3: The PSN sync engine

**Files:**
- Create: `src/server/games/psn-plan.ts` (pure)
- Create: `src/features/games/sync/psn-actions.ts`
- Modify: `src/server/db/games/sync.ts` (commit support for PSN fields)
- Test: `tests/unit/games-psn-plan.test.ts`, `tests/integration/games-psn-actions.test.ts`

**Reuses wholesale:** `game_sync_runs`/`game_sync_changes` with `source: 'psn'`, `appendSyncChanges`, `finishSyncRun`, `listSyncChanges`, `commitSyncRun`, and the review screen. Do NOT build a second staging or review mechanism.

`psn-plan.ts` mirrors `sync-plan.ts`'s shape and produces the same `PlannedChange` objects, so the existing review UI renders PSN changes with no changes of its own. It plans:
- `link` — first-time `psn_title_id` (and `psn_np_communication_id` when a trophy title matched)
- `field_update` — `hoursTenths`, `firstPlayedYear`, `platform`, `lastPlayedAt`, `achievementsUnlocked`, `achievementsTotal`, `platinum`
- `reconcile` — when a changed total strands an existing play-year split, identical to Steam's rule
- `new_game` — a PSN title with no library row

**`platinum` is written by PSN and only by PSN.** This deliberately reverses the Steam sync's "never touch platinum" rule, because Sony is the actual system of record for PlayStation trophies. Document that at the call site.

**Trophy matching is by NAME**, because `titleId` and `npCommunicationId` do not join. Use `bestTitleMatchAmong` with its existing `SIMILARITY_FLOOR` — do not lower or bypass it. A title with no confident trophy match gets its play data and no trophy data, which is correct and must not be treated as "zero trophies."

**Extend `commitSyncRun`'s field whitelist** to include the new columns. The whitelist is the security boundary — a payload naming anything outside it must still throw.

Engine shape mirrors the Steam one: keyset pagination over the owner's PlayStation-platform games by `id`, 5 per chunk, `done` from an empty chunk, `finishSyncRun('failed', …)` on an unexpected error.

**Volume warning to implement, not just document:** the owner chose a full mirror, and PSN returns demos and PS Plus claims. When a run stages more than 100 `new_game` changes, the review screen's group header must state the count prominently so "412 new games" is visible before approval, not after. This is the safety valve for a decision the owner made knowingly.

Tests must include the named no-delete invariant test: **a PSN run leaves all 40 PSP games byte-identical and absent from the run.**

---

### Task 4: Entry point, token handling, and docs

**Files:**
- Modify: the Library screen (PSN sync button beside the Steam one)
- Modify: `src/features/games/sync/sync-review.tsx` (PSN-aware labels)
- Modify: `docs/GAMES.md`, `CLAUDE.md`, `.env.example`

- **A separate PSN button**, per the owner's explicit choice, precisely so a dead PSN token never blocks a working Steam sync.
- **Token-expired is its own UI state**: "PlayStation token expired — get a new one from `https://ca.account.sony.com/api/v1/ssocookie` while logged in to PlayStation, and set `PSN_NPSSO`." Distinct from "not configured" and from "PlayStation did not respond."
- `docs/GAMES.md` gains a "PlayStation sync" section: what PSN supplies, that platinum is PSN-owned (reversing the Steam rule and why), that trophy data is name-matched across two id spaces, the ~2-month token chore, and that PSP is permanently manual.
- `CLAUDE.md` gotcha: **`titleId` and `npCommunicationId` are different identifier spaces and must never be conflated** — played-game data and trophy data join only by name, which is why both columns exist.
- `.env.example` gains `PSN_NPSSO` with the retrieval URL and the expiry note.

**Manual verification cannot be run without a token.** Say so explicitly in the report rather than skipping it. Confirm instead that with `PSN_NPSSO` unset the button renders disabled with its explanation and no request path throws.

---

## Self-Review

**Spec coverage:** client + mapping (1), identity columns (2), engine + commit + platinum + volume warning (3), UI + token state + docs (4). Reconciliation, no-delete, review reuse, and credential-optionality are constraints carried across all four.

**Corrections this plan makes to the spec, all verified against source:** `psn_title_id` not `psn_entitlement_id`; `getUserPlayedGames` is paginated; `titleId` and `npCommunicationId` are separate id spaces joined only by name; `psn-api` ships a `prepare` script.

**Deliberately unverified and flagged, not assumed:** `TrophyCounts`' exact shape, and whether `pspc_game` means PlayStation-on-PC. Both must be confirmed in code before use; `pspc_game` maps to `null` until then and never to `psp`.

**Known risk carried:** with no NPSSO configured, nothing is verifiable end-to-end. Everything is provable by mocked tests and must degrade cleanly to "not configured."
