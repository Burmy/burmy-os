# Roadmap

Living status tracker. Full milestone definitions — goals, dependencies, tests, Definition of Done —
are in `IMPLEMENTATION_PLAN.md` §39.

**Working agreement:** one milestone at a time. Stop and report at the end of each before starting the
next. Never mark anything complete without having run the verification and seen the output.

| | Milestone | Status |
| --- | --- | --- |
| **M1** | Foundation, domain core, protecting what is irreplaceable | ✅ Complete |
| **M2** | Authentication, bootstrap prototype, security baseline | ✅ Complete |
| **M3** | App shell, accounts, categories | ✅ Complete |
| **M4** | Parsing & normalization core *(no UI)* | ✅ Complete |
| M5 | Import pipeline, preview, duplicates | ⚪ Not started |
| M6 | Categorization & classification | ⚪ Not started |
| M7 | Review queue | ⚪ Not started |
| M8 | Monthly grid & drill-down *(the product)* | ⚪ Not started |
| M9 | Transactions table, Excel reconciliation, export | ⚪ Not started |
| M10 | Backup automation, deployment, hardening, launch | ⚪ Not started |

Legend: ⚪ not started · 🔵 in progress · 🟡 blocked · ✅ complete

---

## M1 — Foundation, domain core, protecting what is irreplaceable

**Goal:** the project builds, the schema exists, money arithmetic is proven, and the CSV archive is
safe.

### Environment — verified

| Tool | Version | Status |
| --- | --- | --- |
| Node | v24.19.0 | ✅ matches the container target |
| npm | 11.6.0 | ✅ |
| pnpm | 11.22.0 | ✅ pinned via `packageManager` |
| Docker | 29.7.2 client + server | ✅ daemon responding |
| Docker Compose | v5.3.1 | ✅ |
| Repository visibility | private | ✅ |

### Scope change — historical CSV archive

The owner retains and backs up the original Bank of America CSVs and Excel files themselves.
**This is no longer an M1 deliverable.** Historical months will be uploaded through Burmy's normal
importer once it exists, exactly like a regular monthly import — which is the cleaner outcome anyway,
since it means history goes through the same tested code path as everything else.

**M4 action:** ask the owner for one representative real BoA **checking** CSV, and a **credit-card**
CSV if needed, to verify the actual export schema before writing the adapters.

### Checklist

- [x] Repository cloned
- [x] `.gitignore` hardened **before** the first commit
- [x] `CLAUDE.md`
- [x] `docs/IMPLEMENTATION_PLAN.md` (approved plan of record)
- [x] `docs/ARCHITECTURE.md`
- [x] `docs/SECURITY.md`
- [x] `docs/FINANCE.md`
- [x] `docs/DEPLOYMENT.md`
- [x] `docs/BACKUP_RESTORE.md`
- [x] `docs/ROADMAP.md`
- [x] `src/server/finance/money.ts` — branded `Cents`, all arithmetic
- [x] `tests/unit/money.test.ts` — **74 cases, all passing**
- [x] Repository set to private
- [x] Next.js 16.3 + TypeScript strict + Tailwind 4
- [x] ESLint + Prettier
- [x] Vitest (+ RTL installed for M3 components)
- [x] Playwright config
- [x] `Dockerfile` (base / deps / prod-deps / builder / migrator / runner) + `compose.dev.yml`
- [x] Drizzle client + full schema (§18) — **14 tables**
- [x] `scripts/migrate.mjs` + generated migration `0000_wet_malcolm_colcord.sql`
- [x] Seed script (synthetic — 4 accounts, 11 categories, zero transactions)
- [x] `src/app` shell, `/` → `/finance/monthly`, `/api/health`, `src/proxy.ts`
- ~~Owner's CSV archive backup~~ — **descoped**: owner retains and backs these up; history will be
  uploaded through the normal importer once it exists (M5)

### Verification actually run — M1

| Check | Result |
| --- | --- |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0, no errors or warnings |
| `pnpm test` | ✅ **74/74 passing** |
| `pnpm build` | ✅ exit 0 — 4 routes, Proxy detected |
| `docker compose up postgres` | ✅ postgres:18-alpine healthy |
| Migrations **in container** | ✅ `docker compose run --rm migrate` → complete |
| Schema applied | ✅ 14 tables |
| `PGDATA` path | ✅ `/var/lib/postgresql/18/docker` (PG18 layout) |
| **PG18 persistence** | ✅ after `down && up`: marker row survived, 14 tables survived, 1 migration recorded |
| `/api/health` live | ✅ `200` → `{"ok":true,"database":true,"version":"0.0.0"}` — booleans + version only |
| `.env` gitignored | ✅ matched by `.gitignore:16` |

### Bugs caught during M1

| Found by | Issue |
| --- | --- |
| Vitest | `negate(ZERO)` returned `-0`. `-0 === 0` is true so it hides from casual comparison, but `Object.is`, Map/Set keys and serializers distinguish it. Fixed at the source via a shared `wrap()`; all operations now normalize. Regression tests added. |
| ESLint `no-irregular-whitespace` | **Two regex literals in `money.ts` contained a non-breaking space (U+00A0) instead of a space.** Tests passed only because a later `.trim()` masked it. Replaced with an explicit `/[$\s]/g` (which also covers U+00A0 / U+202F, both of which appear in copied bank data) and pinned with a test. |
| `next build` | `playwright.config.ts` assigned `undefined` to an optional property, rejected by `exactOptionalPropertyTypes`. Fixed by omitting the key rather than relaxing the compiler setting. |
| Docker build | pnpm's build-script policy blocked the image build. Resolved by rewriting the migrator as plain ESM — no TS, no tsx, no esbuild — which also let the migrator image drop to production dependencies only. |
| Docker build | PowerShell's `Set-Content -Encoding utf8` wrote a UTF-8 BOM into `package.json`; pnpm in the container rejected it as `Invalid package.json`. |

---

### Definition of Done — met

- [x] Repository private
- [x] `pnpm typecheck` / `lint` / `test` / `build` all green
- [x] Migrations run from the image, **not** host pnpm
- [x] **Database survives `docker compose down && up`** — PG18 volume path verified, not assumed
- ~~CSV archive verifiably backed up~~ — descoped to the owner

---

## M2 — Authentication, bootstrap prototype, security baseline

**Goal:** only the owner gets in — and can always get back in. **Met.**

### Delivered

- **Cloudflare Access JWT verification** (`src/server/auth/access.ts`) — JWKS with a cached remote key
  set, signature / `aud` / `iss` / `exp`, zero clock tolerance, owner-email match. Bypassed **only**
  when `NODE_ENV` is exactly `development`; anything else missing `CF_ACCESS_*` **refuses traffic**.
- **`requireOwner()`** (`src/server/auth/owner.ts`) — enforces **both** factors itself rather than
  trusting the proxy, so a route the matcher misses is still fully protected. Options for
  `{ fresh }` (sensitive actions) and `{ allowOnboarding }` (the onboarding route only).
- **Better Auth 1.6.29 + `@better-auth/passkey`** — passkeys only. `socialProviders: {}` and
  `emailAndPassword.enabled: false` stated explicitly. No Google client, no signup route.
- **Bootstrap and recovery**, both candidates prototyped and measured, then chosen. One single-use
  10-minute grant mechanism serves both, minted only by `scripts/auth-grant.mjs` over SSH/Tailscale.
  Full comparison in `docs/SECURITY.md`.
- **Two-passkey onboarding gate**, the **last-passkey-cannot-be-deleted** rule, and
  **re-authentication** for passkey removal — all enforced server-side.
- **Nonce-based CSP** per request in `src/proxy.ts`, security headers, database-backed rate limiting,
  `audit_events` wiring.
- **5 new tables** (`session`, `account`, `verification`, `passkey`, `rate_limit`) —
  `drizzle/0001_nappy_ultron.sql`. Purely additive; the M1 `user` table was **reconciled, not
  duplicated**.

### Verification actually run — M2

| Check | Result |
| --- | --- |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0, no errors or warnings |
| `pnpm test` (unit, **Docker-free**) | ✅ **144/144** in ~0.5s |
| `pnpm test:integration` (Testcontainers PG18) | ✅ **64/64** |
| `pnpm test:e2e` (Playwright, virtual authenticator) | ✅ **4/4** |
| `pnpm build` | ✅ exit 0 — 8 routes, Proxy detected |
| Migration applied in container | ✅ 19 tables, 2 migrations recorded |
| Build with **no** runtime secrets | ✅ succeeds — auth is constructed lazily |
| Strict CSP against the running app | ✅ all 18 script tags nonced, 0 unnonced, 0 script violations |
| Entry-point guard test | ✅ **validated by deliberately adding an unguarded route** and watching it fail |
| Grant single-use under concurrency | ✅ 5 parallel redemptions → exactly 1 session |

### Bugs and traps found during M2

Each cost real time; all are now recorded in `CLAUDE.md`.

| Found by | Issue |
| --- | --- |
| Counting tables after migrating | **`docker compose run --rm migrate` against a stale image prints "Migrations complete." and applies nothing.** The Dockerfile copies `drizzle/` into the image. `--build` is mandatory after `pnpm db:generate`. |
| `pnpm db:generate` failing | Testcontainers' transitive deps (`ssh2`, `cpu-features`, `protobufjs`) have blocked install scripts, and an un-acknowledged block makes **every** `pnpm <script>` fail its dependency check. Declined explicitly via `ignoredBuiltDependencies`. |
| `next build` | `export const { GET, POST } = toNextJsHandler(auth.handler)` reads `auth.handler` at import, building the DB adapter at build time and making the build require `DATABASE_URL` + `BETTER_AUTH_SECRET`. Handlers now call `getAuth()` per request. |
| `next build` warning | Better Auth falls back to a **built-in default secret** when `BETTER_AUTH_SECRET` is unset, and only warns. Production now refuses to start. |
| Playwright | One virtual authenticator cannot enrol two passkeys — `excludeCredentials` correctly refuses — and Chrome permits only one `internal` authenticator, so device 2 is `usb`. Both are real WebAuthn behaviour and match what the onboarding copy tells the owner. |
| Playwright + CSP events | 33 CSP violations traced to the **Next.js dev overlay**, not application code. A `style-src-attr 'unsafe-inline'` was added on a wrong hypothesis and **reverted**. |
| `pnpm build` | Sourcing `.env` into the shell exports `NODE_ENV=development`, which makes `next build` resolve development React and die on `/_global-error` with a `useContext` null. |
| `tsc` | Next augments `NodeJS.ProcessEnv` so `NODE_ENV` is required and readonly; the Access module takes a narrow `AccessEnv` instead — which is also what stops the edge bundler inlining `CF_ACCESS_*` at build time. |

### Deliberate deviations from the plan

| Plan said | Shipped | Why |
| --- | --- | --- |
| §39 "prototype both recovery approaches from §13" | §13 named only one recovery candidate; a second (an offline, HTTP-redeemable recovery code) was supplied so the choice was a real comparison | Rejected: a credential valid indefinitely and redeemable from anywhere is a permanent second door whose security rests on never mislaying a printout |
| Integration tests via Testcontainers in the default suite | Split: `pnpm test` is unit-only and Docker-free; `pnpm test:integration` is the container suite | A fast suite that needs a Docker daemon stops being run on every save. CI runs both. |
| CSP "no `unsafe-inline`, no `unsafe-eval`" | No `unsafe-inline` anywhere; `'unsafe-eval'` in **development only** | React Refresh cannot hot reload without it. The production policy is unchanged. |
| `rateLimit` storage unspecified | Database-backed, adding a `rate_limit` table | An in-memory limiter resets on every deploy, and "redeploy to clear the lockout" is not a property the break-glass endpoint should have |

### Known gaps, carried forward honestly

- **Cloudflare Access has never been exercised against real Cloudflare.** Verification is covered by
  unit tests against a locally generated ES256 key pair (the real code path, different key source) and
  by fail-closed integration tests. The genuine end-to-end check — a second Google account refused at
  the edge — is an M10 item because it needs the deployment.
- **Manual real-device passkey verification is outstanding.** The automated ceremony runs against
  Chrome's virtual authenticator, which is real WebAuthn with a software key store, but no physical
  authenticator has been used yet.
- **The proxy runs in the edge runtime.** Next.js 16.3 exposes no runtime option for `proxy.ts`, so
  refusals there are logged rather than written to `audit_events` (the Node-side guard persists those).
  Verified that `CF_ACCESS_*` are read at **runtime**, not inlined at build time, by inspecting the
  compiled chunk.

---

## M3 — App shell, accounts, categories

**Goal:** the owner's taxonomy exists and the app is navigable. **Met.**

### Delivered

- **Owner-scoped finance data access** in `src/server/db/finance/` — every function takes `ownerId`
  first and injects it into the `WHERE`; mutations match on `(ownerId, id)`, never `id` alone.
  `src/server/finance/` stays DB- and I/O-free (`taxonomy.ts` holds the pure rules).
- **App shell**: `(private)` layout with Finance / Settings nav, a `SubNav` for settings sections,
  sign-out, `error.tsx` (surfacing `error.digest` as a correlation id, never a message),
  `loading.tsx`, `not-found.tsx`.
- **shadcn/ui + Lucide initialized** — button, input, label, select, dialog, table, dropdown-menu.
  Its `sonner` toast template was **replaced** with an in-house `Toaster` (sonner injects an unnonced
  `<style>` element at module scope); `next-themes`, installed by the CLI as a side effect of that
  template, was **removed**.
- **Theme: server-side cookie, three states, zero JavaScript.** `system` emits no class so
  `prefers-color-scheme` applies; `light`/`dark` stamp a class during SSR. No inline script, so
  nothing for the CSP to refuse, and no flash.
- **Accounts CRUD** — deactivate/reactivate, never delete (`account_id` is `ON DELETE RESTRICT`).
  `last_four` **rejects** anything but 4 digits rather than truncating. `cash` is absent from the UI.
- **Categories CRUD + archive + reorder** — archive never deletes; duplicate names rejected
  case-insensitively among live rows only; up/down reorder buttons writing one dense sequence per
  request inside a transaction.
- **Passkey management** in Settings, giving M2's `requireOwner({ fresh: true })` and the
  last-passkey rule their first real callers, including the re-authentication prompt on a 403.
- **`pnpm db:seed` fixed** — it now RESOLVES the owner by `OWNER_EMAIL` and never creates or claims an
  auth user, failing loudly with bootstrap instructions when none exists.

### Verification actually run — M3

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0, no errors or warnings |
| `pnpm test` | **181** (domain 170 + components 11) |
| `pnpm test:integration` | **85** (Testcontainers PG18) |
| `pnpm test:e2e` | **14** (Playwright — real Radix overlays + virtual authenticator) |
| `pnpm build` | exit 0 — 12 routes, Proxy detected |
| `pnpm db:seed` | both paths: resolves an existing owner, and fails loudly with instructions when absent |
| Radix under the real CSP | dialog + select open, **zero** violations from application code |

### Bugs and traps found during M3

| Found by | Issue |
| --- | --- |
| Integration tests | **Drizzle WRAPS driver errors.** A Postgres `unique_violation` arrives as a Drizzle error with the SQLSTATE on `error.cause`, so `error.code === '23505'` never matched — every duplicate name would have been an unhandled 500 instead of a field error. `isUniqueViolation()` now walks the cause chain. |
| E2E (CSP events) | **Radix injects a `<style>` ELEMENT**, not only attributes, via `react-remove-scroll`. `style-src-attr` does not cover it. Fixed by feeding the request nonce to `get-nonce`'s `setNonce()` — **`style-src` was NOT relaxed**. |
| E2E (CSP events) | **`sonner` cannot satisfy a nonce-only `style-src` at all.** It injects its stylesheet with an internal `__insertCSS()` at MODULE EVALUATION time, has zero nonce support, and offers no opt-out — so the violation was intermittent, racing chunk load. Replaced with an ~80-line in-house `Toaster` styled with ordinary Tailwind classes, and the dependency removed. Relaxing `style-src` was refused. |
| `pnpm typecheck` | `exactOptionalPropertyTypes` rejected shadcn's generated `dropdown-menu.tsx`, whose `checked` prop is `CheckedState` rather than optional-undefined. The generated component was fixed with a conditional spread; the compiler setting stays on. |
| `pnpm add` | The shadcn CLI installed **`next-themes`** as a dependency of its `sonner` template — the exact library the theme decision rejected. Regenerated the Toaster without it and removed the package. |
| `pnpm <script>` | pnpm re-injected an `allowBuilds:` placeholder on the next install, breaking every script again. `ignoredBuiltDependencies` alone is **not** sufficient in pnpm 11.22; `allowBuilds` with explicit booleans is. |
| Playwright | Specs ran in parallel against one dev server and one database, so a `truncate` in one wiped another's session mid-test. Now `fullyParallel: false, workers: 1`. |
| `pnpm test` | Wiring the RTL/jest-dom setup file globally took the unit suite from ~0.5s to ~4.2s. Split into two Vitest projects by extension: `.test.ts` → node, `.test.tsx` → jsdom. |
| Self-review | A test claiming to cover U+00A0 / U+202F held literal invisible characters. Replaced with named `NBSP` / `NARROW_NBSP` constants — an invisible character in a test is a test nobody can review. |

### Deliberate decisions

| Decision | Choice | Why |
| --- | --- | --- |
| CSP and Radix | `style-src-attr 'unsafe-inline'` **only**; `style-src` stays nonce-only | An attribute cannot carry a nonce; a `<style>` element can. Recorded as a real tradeoff, not a neutral one — see `docs/SECURITY.md`. |
| Theme | Server-read cookie, no `next-themes` | Its flash-prevention inline script is blocked by our nonce-only `script-src`. |
| Toasts | In-house, not `sonner` | Sonner injects an unnonced `<style>` element at module scope with no opt-out. Keeping `style-src` nonce-only was the constraint; ~80 lines of Tailwind was the cheaper side of that trade. |
| Reorder | Up/down buttons | Keyboard accessible by construction, no dependency, and the list changes a few times a year. |
| Data access | `src/server/db/finance/` | Matches `ARCHITECTURE.md`'s layer table and keeps the domain core DB-free. Plan §17's `queries/` sketch corrected. |
| Accounts | Deactivate, never delete | `ON DELETE RESTRICT`, and an account with no history today may have history next month. |

### Known gaps

- **Manual real-device passkey verification is still outstanding** — carried from M2. The automated
  ceremony uses Chrome's virtual authenticator (real WebAuthn with a software key store); no physical
  authenticator has been used. This needs the owner's hands.
- **No mobile device testing.** The shell uses responsive classes but was not opened on a phone.
- Categories `parent_id` remains schema-only, as planned.

---

## M4 — Parsing & normalization core *(no UI)*

**Goal:** the domain heart, provably correct. **Met**, with Tier 1 verification
explicitly descoped by the owner rather than completed.

### Delivered

- **Two stages, kept apart.** `raw bytes → source-specific parse → normalized
  candidate`. Nothing in either stage categorizes, decides duplicates, classifies a
  transaction type, writes to a database, or calls a model. A `NormalizedCandidate`
  is a *candidate* precisely because nothing has yet decided whether it imports.
- **`src/server/finance/parse/`** — `types.ts` (the stage boundary), `csv.ts` (bytes
  → cells, BOM stripping, ≤50k rows, ≤4KB cells), `signature.ts` (header-set hash),
  `normalize.ts` (dates, sign inversion, `Cents`), `index.ts` (detection + composition).
- **`src/server/finance/adapters/`** — `boa-deposit.ts`, `boa-card.ts`, written
  against two real exports rather than documentation.
- **`merchant.ts`** — table-driven and pure, every rule from an observed shape.
- **`dedupe.ts`** — frozen `dedupeKey`, Tier 2 count reconciliation, and the Tier 1
  observation/stability helpers.
- **Redacted fixture corpus** at `tests/fixtures/finance/` — 10 files, consumed as
  raw bytes by the tests, with a guard test and recorded checksums.

### The deposit export validates itself to the cent

The five-line preamble is not decoration. Verified against the real file:

```
parsed credits            = stated Total credits
parsed debits             = stated Total debits
beginning + credits − debits = stated Ending balance
every Running Bal.        = previous balance + row amount
```

A dropped row, an inverted sign, or a thousands separator eaten by a bad split all
become **loud failures** rather than a total that is quietly wrong — on every real
import, forever, not just against fixtures. This is the strongest correctness signal
the project has, and it exists only because a real file was read.

### Confirmation numbers link both legs of a card payment

The checking leg carries `Confirmation# <token>`; the card leg carries
`CONF#<token>` — the same token, opposite signs, a day apart, on two independent
payments. That is far stronger evidence than the keyword-plus-amount-plus-date
signal plan §24 designed, and it only appeared in real data.

M4 **preserves** it and stops there; extracting and matching is M6's job, because
doing it in the parser would put classification inside a stage that must not
classify. A test asserts the linkage survives so a future description "tidy up"
cannot silently destroy it.

Three details that confirm existing decisions: one payment leg predates the checking
window and another postdates the card statement, so **multi-file batching and the
±7-day window are both load-bearing and an unmatched leg is normal**; a third-party
card autopay has no counterpart at all, so it correctly stays a review item; and the
matched legs were dated a day apart, so the window cannot be zero.

### Tier 1 — descoped, documented, and ready

Per the owner's instruction, the overlapping-export verification was skipped rather
than allowed to block M4 or M5.

| Property | Result |
| --- | --- |
| Coverage (card) | **100%** — 40/40 rows, payments included |
| Unique within the sample | **Yes** — 40 distinct 23-digit values |
| Byte-stable across exports | **UNVERIFIED** — needs two overlapping exports |
| Unique database constraint | **None.** Index stays non-unique. |

`source_transaction_id` is captured but nothing reads it: a test asserts that two
rows with different reference numbers but identical account/date/amount/description
still collide on identity, proving **Tier 2 is what is actually running**.
`tierOneCandidateStability()` exists and is unused, so closing this out later is a
function call over two captured sets rather than a parser change.

### Verification actually run — M4

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0, no errors or warnings |
| `pnpm test` | **266** (domain 255 + components 11) |
| `pnpm test:integration` | **85** (Testcontainers PG18) |
| `pnpm test:e2e` | **14** |
| `pnpm build` | exit 0 — 12 routes, Proxy detected |
| Deposit checksum | reconciles to the cent; a mismatch fixture fails loudly |
| Fixture guard | **validated by a negative control** — a file with a Luhn-valid card number and real identifiers was added, all three guards fired, then it was removed |

### Bugs and traps found during M4

| Found by | Issue |
| --- | --- |
| Own test expectations | **Merchant location stripping was greedy.** A lazy prefix in the regex made `TST*HARVEST NAAN - EAS Eastvale TX` strip down to `HARVEST`. Ten tests failed at once. Replaced with a token-based rule that removes the state and **at most one** city token — deliberately conservative, because over-stripping merges distinct merchants and moves money between two visible grid rows, while under-stripping costs one extra review card. |
| Own test expectations | **Bare trailing store-number rule was too aggressive** at 3+ digits: it turned `VIA 313` into `VIA`, merging a restaurant with every other `VIA`. Raised to 5+ digits, matching the observed bare store numbers (5 and 9 digits); hash-marked numbers stay unambiguous at any length. |
| ESLint `no-control-regex` | A regex written via a generator contained literal **0x08 BACKSPACE** bytes instead of `\b` word boundaries — it matched nothing and looked correct. Second time an invisible character has hidden in a regex in this project (after M1's U+00A0). |
| Fixture digest test | **Python's text mode translates newlines.** Reading fixtures with `io.open(..., encoding='utf-8')` made the CRLF fixture hash identically to the LF one, so the checksums were silently wrong. Needs `newline=''`. |
| Own guard design | The first fixture guard flagged any 13–19 digit run, which is red on **correct** data: BoA deposit descriptions carry ACH trace ids and card exports carry 23-digit references. A permanently red guard gets ignored. Replaced with isolated, Luhn-valid, card-length runs, excluding `ID:`-prefixed values. |
| Self-review | The `boa-card-thousands-quoted.csv` fixture contained **no four-figure amount**, so the "thousands separator" fixture exercised no thousands separator. Added a genuine one — and, on the second pass, **prepended** rather than appended it, because appending a later date destroyed the file's strictly-descending order. |

### Deliberate decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Card `transaction_date` | Posted Date populates **both** dates | The column is `NOT NULL` and the grid buckets on it. Inventing an earlier transaction date would be fabricating data. |
| Deposit validation | Totals **and** per-row running balance, both fatal on mismatch | The strongest available correctness signal, and it works on unseen data. |
| Confirmation-number extraction | **Deferred to M6** | The raw description is already retained verbatim for `dedupe_key`, so M6 can extract when it has a use. Adding a field now would be speculative, and interpreting it is classification. |
| Four-figure card amounts | Accept both comma and plain forms | No sample value reached four figures, so the behaviour is an assumption; both fixtures exist so whichever BoA emits, it parses. |
| Merchant location | Exact strip when the format supplies an `Address` hint; otherwise one token | Precision where certainty exists, conservatism where it does not. |
| Fixtures | Redacted from real exports, not synthetic | Synthetic fixtures encode only the author's assumptions about the format M4 exists to stop trusting. Invariant amended in CLAUDE.md and SECURITY.md. |

### Known gaps

- **Tier 1 stability is unverified**, by instruction. No unique constraint exists.
- **Encoding and line endings could not be preserved from the source.** The exports
  arrived through a chat upload, which may normalize both, so the fixtures cannot
  claim byte-fidelity on those two properties. Explicit CRLF and BOM variants exist
  so the parser is tested against both regardless.
- **The generic mapper is detection-only.** An unknown layout is correctly reported
  as `generic` with a stable signature, and then refused with a clear message. The
  column-mapping UI and `finance_format_signatures` persistence are M5.
- **No XLSX.** ExcelJS is gated behind the M9 dependency review, as planned.
- **Manual real-device passkey verification** is still outstanding, carried from M2.

---

## ▶ RESUME HERE — M5: Import pipeline, preview, duplicates

**Get running again:**

```bash
docker compose -f compose.dev.yml up -d postgres
docker compose -f compose.dev.yml run --rm --build migrate    # --build is NOT optional
node scripts/auth-grant.mjs bootstrap    # only if the owner row is absent
pnpm db:seed
pnpm dev
```

### M5 scope

1. Multi-file batch upload with every §21 validation — size, count, extension,
   magic bytes, row cap, cell cap, encoding, date and amount sanity.
2. Temp-file lifecycle with **guaranteed deletion, including on the failure path**.
   Worth considering: uploads are capped at 10 MB, so this stage could stay in
   memory and remove the deletion hazard entirely.
3. **Sanitized** staging — no raw blob, unmapped columns discarded at parse.
4. 60-day expiry, extended on every edit.
5. Preview UI, server-rendered from staged rows.
6. Tier 2 duplicate reconciliation against committed history, plus the file-hash
   pre-check that warns *before* parsing.
7. Atomic commit in one transaction; failure and cleanup paths.
8. The generic column-mapping UI, persisting to `finance_format_signatures`.

### What M4 hands over

- `parseStatement(bytes)` returns `{ format, result, candidates }`. **`result.rows`
  still carries the source fields**, so the pipeline can read the card export's
  `Address` as an exact location hint for `normalizeMerchant` without persisting it.
- `groupByDedupeKey()` and `reconcileCounts()` are pure. M5 supplies
  `committedCount` from the database and owns the decision; `dedupe.ts` only computes.
- The deposit checksum runs inside `parseStatement`, so a bad parse never reaches
  staging.

### Watch out for

- **Every Server Action starts with `await requireOwner()`** —
  `tests/integration/entry-points.test.ts` enumerates the filesystem and will fail
  the suite otherwise.
- **Raw uploads are deleted immediately after parsing, including on the failure
  path**, and never written to `public/` or any statically served path.
- **Only the file the owner selects in the browser** — no watched folders, no
  directory scanning (CLAUDE.md invariant 7).
- Staging stores **no raw jsonb dump**. Unmapped columns are discarded at parse.
- Expiry is **60 days**, not 7. A 7-day sweep would delete an in-progress review
  before a monthly user returned to it.
- If a fixture must change, update its checksum in `tests/unit/fixture-guard.test.ts`
  in the same commit — that is the guard working, not a nuisance.

## Carried forward

Items deliberately deferred to a later milestone, tracked so they are not lost.

| Item | Milestone | Why deferred |
| --- | --- | --- |
| BoA `source_transaction_id` **stability** verification | **Descoped — no milestone** | Coverage (100%) and in-sample uniqueness confirmed in M4; cross-export stability skipped by owner decision so it blocks nothing. No unique constraint. `tierOneCandidateStability()` is written and unused, so closing it out later is a function call. |
| ~~BoA adapter written against a real export~~ | ~~M4~~ | **Done.** Two real exports read; three of the plan's assumptions about the layout were wrong. See `docs/FINANCE.md`. |
| ~~Passkey bootstrap + recovery design~~ | ~~M2~~ | **Done.** Both candidates prototyped and measured; the session-first grant design shipped. See `docs/SECURITY.md`. |
| Cloudflare Access verified against real Cloudflare | M10 | Needs the deployment. Locally covered by unit tests against a real key pair plus fail-closed tests. |
| Manual real-device passkey verification | **M5** | Still outstanding after M4. Automated ceremony passes against Chrome's virtual authenticator; no physical authenticator used yet. |
| **E2E suite shares one database; `workers: 1` is a workaround** | M5 or when the suite slows | All Playwright specs truncate the same development database, so parallel runs wipe each other's sessions mid-test. Serial execution is a **bill not yet due**, not a design decision. Real fix: a database per worker (the integration suite already does this with Testcontainers) plus a per-worker `DATABASE_URL`, then restore `fullyParallel: true`. Acceptable at 14 tests / ~35s; revisit when M5 and M8 add journeys. |
| ExcelJS dependency/security review | M9 | Gate immediately before XLSX work begins |
| Production Docker hardening | M10 | M1 creates the image; M10 hardens the same image |
| Optional AI categorization | Post-V1 | Only if the residual review tail after 2–3 real months justifies it |

---

## Deferred beyond V1

Split transactions · category `parent_id` in the UI · saved filter views · recurring-subscription
detection · refund→purchase linking · Home dashboard · Finance chat · Amazon item-level splitting ·
PDF parsing · multi-currency logic · budgets and category limits.

**All non-Finance modules** — Notes, Files, Sheets, Inbox, Bookmarks, Garage, Receipts, Subscriptions.
