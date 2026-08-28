# Roadmap

Living status tracker and the project's sole history record. Milestones 1–9 are complete; each
section below documents its own goals, deviations, and Definition of Done as it shipped.

**Working agreement:** one milestone at a time. Stop and report at the end of each before starting the
next. Never mark anything complete without having run the verification and seen the output.

| | Milestone | Status |
| --- | --- | --- |
| **M1** | Foundation, domain core, protecting what is irreplaceable | ✅ Complete |
| **M2** | Authentication, bootstrap prototype, security baseline | ✅ Complete |
| **M3** | App shell, accounts, categories | ✅ Complete |
| **M4** | Parsing & normalization core *(no UI)* | ✅ Complete |
| **M5** | Import pipeline, preview, duplicates | ✅ Complete |
| **M6** | Categorization & classification | ✅ Complete |
| **M7** | Review queue | ✅ Complete |
| **M8** | Monthly grid & drill-down *(the product)* | ✅ Complete |
| **M9** | Transactions ledger, reconciliation & export | ✅ Complete |
| M10 | Deployment, hardening, launch | 🔵 In progress — architecture simplified to Netlify + Supabase (the earlier VPS self-host path was removed from the repo in a follow-up cleanup, recoverable from git history); Cloudflare Access retained via a proxied `app.burmy.me` record; awaiting the actual external rollout |

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
signal originally planned, and it only appeared in real data.

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

## M5 — Import pipeline, preview, duplicates

**Goal:** the owner's actual monthly workflow — upload a CSV, see what's new versus
already-imported, categorize, commit — working end to end, without the
infrastructure M1's schema anticipated but M5 does not yet need.

**Course-corrected from the original plan** (owner decision, before implementation):
single file per import, not a multi-file batch — batching existed only so
transfer/card-payment counterpart matching could see both legs at once, and that
matching is M6's. In memory only, never a temp file on disk — the plan's own note
that a 10 MB cap makes the deletion hazard moot turned out correct. No generic
mapper UI or `finance_format_signatures` persistence, no owner-facing
transaction-type picker. All confirmed explicitly out of scope; see FINANCE.md
"Import pipeline (M5)" for what shipped instead.

**Work:** `src/server/finance/import/compatibility.ts` (account/format check,
pure) and `import/staging.ts` (`planStagedDecisions`, `defaultTransactionType`,
pure) — both framework-free, per the `src/server/finance/` boundary.
`parse/index.ts` gained `parseStatementTolerant()`, additive alongside
`parseStatement()`, so one bad row no longer aborts a whole file. Repository layer
in `src/server/db/finance/imports.ts`: staging, the review-page reads, per-row
decision/category updates, commit, discard, and the file-hash pre-check. Server
Actions in `src/features/finance/import/actions.ts`. UI at
`/finance/import` (upload + in-progress list) and `/finance/import/[id]`
(preview/review/commit), plus a `finance/layout.tsx` sub-nav so the screen is
actually reachable.

**Three adjustments requested during review, before implementation started:**

1. **Account/format compatibility**, checked before staging — see FINANCE.md.
2. **Commit-time Tier 2 re-check.** Reconciling once at staging is not enough
   under concurrency: two imports staged close together can each see "0
   committed" for the same key. `commitImport()` re-runs the identical pure
   reconciliation a second time, inside the commit transaction (serialized per
   owner via `pg_advisory_xact_lock`), against the current committed count — and
   an explicit owner override (`decision_overridden`) is honoured unconditionally,
   never demoted by the re-check. One small, deliberate schema addition:
   `finance_import_rows.decision_overridden boolean`.
3. **Status-aware file-hash messaging.** Only a `committed` prior upload is ever
   called "already imported" — `review` and `discarded` matches get their own
   honest sentence.

Plus one UI requirement: the preview shows the normalized merchant AND the raw
statement description beneath it, so a categorization decision is made from the
actual statement text.

**Bugs found by the test suites, not by review:**

- **`MIN(uuid)` does not exist in Postgres.** The "sample committed transaction id"
  query cast the aggregate's *result* to text (`MIN(id)::text`) instead of casting
  the *column* before aggregating (`MIN(id::text)`) — compiled, and every
  integration test touching a duplicate immediately failed with `function min(uuid)
  does not exist`. Caught the moment `getCommittedCounts` ran against real
  Postgres.
- **A Server Action's own `revalidatePath` beat the client's post-commit state.**
  `commitImportAction` calls `revalidatePath()`, which re-renders the review page's
  Server Component with the now-`committed` status — and the review table checked
  that `status` prop before its local "just committed" result state, so the
  success summary flashed and was immediately replaced by "already committed."
  Found by the e2e test, not by manual review; fixed by checking the local commit
  result first.

**Tests:** unit — compatibility, staging decision-planning (including that a
genuine same-day repeat purchase still defaults to new, and that the surplus pick
is deterministic by row order), `parseStatementTolerant`'s per-row collection
versus `parseStatement`'s unchanged behaviour. Integration — staging, Tier 2 at
staging, the commit-time race demotion AND the override-survives-a-second-race
case (both reproduced directly against Postgres, not mocked), file-hash messaging
by status, cross-owner isolation, `updateRowDecision`'s guards. E2E — the golden
path against the real redacted `boa-deposit-2026-05.csv` fixture (upload,
categorize, commit, verify the committed category server-side) followed by a
re-upload of the identical file proving zero new transactions; a second spec
proves the account/format mismatch is refused before staging.

**DoD:** a redacted real BoA export uploads, previews with new/duplicate/failed
correctly distinguished, categorizes, commits; the same file re-uploaded commits
nothing new. `pnpm test:e2e` — all 16 tests, including the pre-existing M3 suite
— passes as a complete run, confirmed repeatedly; see "Carried forward" for the
one test race that surfaced and was fixed.

## M6 — Categorization & classification

**Goal:** reduce the owner's manual review after import — obvious transactions
categorize/classify themselves, uncertain ones stay `needs_review`. Narrowly
scoped to that one goal, by owner instruction; not a rules engine, not a
reconciliation framework.

**Two mechanisms, both deterministic, no schema migration:**

1. **Merchant memory** (`finance_merchant_memory`, built in M1, unused until
   now) — a category confirmed once, whether by owner pick or accepted
   suggestion, is remembered and pre-fills the same merchant next time. The
   owner's current choice always overwrites what's remembered.
2. **Counterpart matching** (`classify/counterpart.ts`, new) — the M4-discovered
   confirmation-token linkage, used for both transfers and credit-card
   payments as ONE mechanism: same owner, same token (exact), amount the exact
   negation of the other leg's, different account, ±7 days, `type_source`
   still `'default'`, and exactly one qualifying candidate — anything else is
   no match, never a guess.

**Two scope changes made during review, before implementation:**

1. **Investment auto-classification deferred entirely.** The account-type-based
   path (`brokerage` account → every transaction is `investment`) was proposed
   and then cut: it's currently unreachable (no adapter imports into a
   `brokerage` account) and might not stay semantically correct once real
   usage exists. Left for a later milestone with a concrete case.
2. **No FK migration for `counterpart_transaction_id`.** The column already
   existed, unconstrained, from M1. Application-level `type_source = 'default'`
   guards plus the integration suite were judged sufficient for V1; a
   migration purely for architectural neatness was explicitly rejected.

**The "never overwrite a manual decision" requirement**, verified directly: every
automated write is gated on `type_source = 'default'`. M7's still-unbuilt manual
correction UI will set `type_source = 'manual_confirmation'` — from that instant,
this milestone's code can never touch that transaction's type again, through the
exact same guard, with zero code changes needed when M7 ships. A test forces this
scenario directly (a transaction's `type_source` set to `'manual_confirmation'`
ahead of an otherwise-qualifying import) and confirms it survives untouched.

**A real bug the integration suite caught, not review:** the retroactive
counterpart update (reclassifying an already-committed transaction from a prior
import) touched only `transaction_type`/`type_source`/`counterpart_transaction_id`
— correctly leaving category state alone — but that also meant a transaction with
`review_status = 'needs_review'` (no category, nothing to review at staging time)
stayed stuck at `needs_review` forever, even though it was now correctly excluded
and needed no owner attention at all. Fixed with a SQL `CASE`: `needs_review` moves
to `auto`, but an existing `confirmed` is left exactly as it was — the fix couldn't
just flip the field unconditionally without risking exactly the manual-overwrite
problem the whole milestone is about avoiding.

**Tests:** unit — `extractConfirmationToken` (both BoA forms, case-insensitivity,
no-match), `dateWindow` (month/year boundaries), `findQualifyingCounterpart` (every
disqualifying case: wrong token via ILIKE substring collision, wrong sign, wrong
magnitude, ambiguous, ambiguous is null not a guess), `reviewStatusFor`. Integration
— memory upsert/override, both counterpart-match import orders, transfer (non-card)
matching, ambiguous match classifies nothing, cross-owner isolation, the
manual-decision-survives guard, re-upload idempotency still holds with
classification composed in. E2E — a merchant confirmed in a prior session pre-fills
its category with zero owner interaction, computed via the real normalizer rather
than a guessed key.

**DoD:** `pnpm typecheck` / `lint` / `test` (306) / `test:integration` (119) /
`test:e2e` (17, two consecutive full runs) / `build` all green — actually run.

## M7 — Review queue

**Goal:** `needs attention → fix it → confirmed`. A practical cleanup screen,
not a second classification subsystem — M7 adds no automatic classification
of its own; every write it makes is the owner acting.

**`/finance/review`**, filterable by status/account/category/type (URL search
params, so a filtered view is shareable and survives a refresh). Three owner
actions: assign/change a category, correct a transaction's type, bulk-assign
a category to several selected rows. Zero schema changes — every field M7
needed (`review_status`, `categorization_source`, `type_source`,
`counterpart_transaction_id`) was already sitting in M1's schema, unused
until now.

**One change made during review, before implementation:** no
confirmed-but-uncategorized spending. `reviewStatusForCorrection()`
(`classify/manual.ts`) requires a category before `confirmed`, unless the
type is one of the three exclusionary ones (which never need a spending
category at all). This removed the originally-proposed generic "mark
reviewed without categorizing" action entirely — once the rule applies
consistently, there was no concrete case left needing it. Income was
deliberately NOT carved out as an exception, on the reasoning that M8 doesn't
exist yet to say whether its total needs per-category breakdown; applying one
uniform rule now and narrowing it later if warranted was judged safer than
guessing.

**The counterpart unlink**, exactly as proposed: correcting the type of a
linked transaction atomically breaks the pair on BOTH sides in one
transaction — the corrected leg becomes `manual_confirmation`, the freed leg
reverts to its plain M5 sign-based default with `type_source = 'default'` and
its own `review_status` recomputed via M6's `reviewStatusFor` (reverting, not
being corrected). No stale, one-way, or contradictory link is left in any
test scenario, including both import orders and an id-ownership check.

**Merchant memory from a correction is opt-in**, per the approved design: a
per-row "Remember for future imports" checkbox, unchecked by default, next to
the category picker — a review-queue fix is plausibly a one-off exception, and
should not silently retrain future imports unless the owner says so
explicitly. Bulk assignment never writes to memory at all, regardless.

**The manual type picker exposes 7 of the 8 real `transaction_type` values** —
`adjustment` excluded as a raw enum value with no clear owner-facing meaning,
per instruction not to expose one "merely because it exists." The same list
drives both the Select's options and the Server Action's Zod validation.

**The needs-review nav badge** — approved as a single `count(*)` — now marks
`/finance/review` in the Finance sub-nav ("Review (3)"), so there is a
visible, no-click answer to "is there anything to do."

**Tests:** unit — `isExclusionaryType`, `reviewStatusForCorrection` (including
the exclusionary-type-needs-no-category case), `merchantKeyFrom` rederiving
exactly what `normalizeMerchant` computed internally. Integration — every
filter combination, the confirmed/needs_review transition in both directions
(assigning AND clearing a category), the remember-checkbox both states, the
counterpart unlink verified on both legs with a category-bearing freed leg
kept at its own correct status, a bystander transaction proven untouched,
cross-owner isolation on every action. E2E — resolving a needs_review row
through the real UI and watching it leave the queue; correcting one leg of a
seeded matched pair through the real Type selector and confirming the unlink
in the database.

**DoD:** `pnpm typecheck` / `lint` / `test` (316) / `test:integration` (140) /
`test:e2e` (19, two consecutive full runs) / `build` all green — actually run.

## M8 — Monthly grid & drill-down (the product)

**Goal:** recreate the useful part of the owner's spreadsheet inside Burmy —
month × category totals, Total Expenditure, Income, Gross Savings, every
number clickable to the exact transactions behind it. `/finance/monthly`
replaces the M3 taxonomy placeholder and becomes the app's landing route.

**Two changes made during proposal review, before implementation**, both by
explicit owner instruction: (1) **column order is authoritative** — the grid
renders categories in the owner's `sort_order`, flat, never regrouped into
Spending/Investment/Income blocks (the original FINANCE.md mockup's blocked,
collapsible layout was overturned in favor of one simple table); `kind`
appears only as a small non-reordering label. (2) **the invariant-violation
case is surfaced, not just theoretically included** — a `confirmed`/`auto`
transaction with no category (should be impossible after M7, but not
provably so for old or future-buggy data) is still counted in Total
Expenditure/Income, and now also triggers a dedicated reconciliation banner
(count, amount, link to Review) rather than relying on Total Expenditure's
own drill-down to make it discoverable.

**The whole guarantee is one shared function.** `gridBaseConditions()`
(`db/finance/grid.ts`) builds the `WHERE` for both the aggregate query and
the drill-down query — not two copies of an equivalent filter — so a
drill-down total cannot structurally disagree with the grid cell that opened
it. Proven directly, not just by code inspection: the integration suite runs
both queries for the same scope and asserts the sums are bit-for-bit equal,
for a category cell, Total Expenditure, Income, and the year-Total row.

**A real `-0` bug, caught by the unit suite before it ever reached a
database.** `computeRowTotals()` (`server/finance/grid.ts`) works in plain
`number`, not the branded `Cents` type — `-incomeCentsRaw` produces negative
zero when a month has no income at all, the same failure class `money.ts`
was built to prevent in M1. Fixed by normalizing at the source
(`incomeCentsRaw === 0 ? 0 : -incomeCentsRaw`). Now a documented gotcha in
`CLAUDE.md` so it isn't rediscovered a third time.

**Tests:** unit — `buildMonthlyGrid()`'s cell summing, column ordering
(direct proof `sort_order` survives interleaved kinds), archived-with/without
-history column inclusion, the three summary formulas including negative
Gross Savings, the unreconciled bucket, and the year-Total row reconciling
exactly against its twelve months. Integration, against real Postgres — the
base filter's exact exclusions, the year-boundary edge (Dec 31 vs the next
Jan 1), refund netting, cross-owner isolation, and the drill-down/aggregate
equality proof above for four distinct scopes. E2E — a category cell's total
matching its drill-down dialog exactly (with a `needs_review` sibling row
confirmed absent from both), and the reconciliation banner appearing and
linking to a categoryless charge's own drill-down.

**DoD:** `pnpm typecheck` / `lint` / `test` (332) / `test:integration` (155)
/ `test:e2e` (21, two consecutive full runs) / `build` all green — actually
run.

## Post-M8, out of band — authentication simplified to Cloudflare Access + Google only

Not a numbered milestone: a deliberate product/security-model change the owner
requested directly, between accepting M8 and starting M9, after using the app
with real statements for the first time.

**What changed:** Burmy's M2-era two-factor design (Cloudflare Access + an
in-app Better Auth passkey) was replaced with Cloudflare Access alone —

```
app.burmy.me → Cloudflare Access / Google → Burmy application
```

Removed entirely: `better-auth` and `@better-auth/passkey` (dependencies and
all code — `server/auth/{index,grant-plugin,passkey-policy,grants}.ts`,
`/api/auth/[...all]`, `/sign-in`, `/recovery`, `/onboarding/passkeys`,
`/settings/passkeys`, `scripts/auth-grant.mjs`, the passkey/grant test suites).
`requireOwner()` (`src/server/auth/owner.ts`) is now a thin wrapper: verify the
Access JWT via `requireAccessIdentity()` (unchanged — this already confirmed
the verified email matched `OWNER_EMAIL`), then **resolve** (never create) the
matching `user` row. A new `scripts/provision-owner.mjs` is the one-time,
out-of-band operator step that used to be "redeem a bootstrap grant." Full
detail: `docs/SECURITY.md`, "Authentication" and "Former design: Cloudflare
Access + passkey (removed)".

**The `session`/`account`/`verification`/`passkey`/`rate_limit` tables were
kept, not dropped** — no destructive migration for tidiness alone, per
CLAUDE.md. They are unused; `src/server/db/schema.ts` documents this in place.

**Tests:** `tests/unit/access.test.ts` gained the crypto-level proofs
`requireOwner()` used to need an integration test for — wrong Google email,
forged signature, expired token — all against the real ES256 verification path
via `requireAccessIdentity`'s new test-only `keyResolver` parameter, the same
injection seam `verifyAccessToken` already had. `tests/integration/
owner-guard.test.ts` was rewritten around dev-bypass, "resolve never create,"
and fail-closed. `tests/e2e/passkey.spec.ts` was replaced by `auth.spec.ts`
(a provisioned owner reaches `/finance/monthly` directly, no sign-in step; an
unprovisioned owner sees `/access-denied`, not a passkey prompt) and
`csp.spec.ts` (the CSP proofs that used to live in the same file, which are
about `src/proxy.ts` and apply regardless of how authentication works — kept
intact, not lost, just relocated).

**DoD:** `pnpm typecheck` / `lint` / `test` (319) / `test:integration` (109) /
`test:e2e` (21, two consecutive full runs) / `build` all green — actually run.

## M9 — Transactions ledger, reconciliation & export

**Goal:** a place to inspect, search, correct, reconcile, and export the
transaction ledger behind the monthly grid, without touching M1–M8
accounting behavior. **Met.**

**Course-corrected from the original plan** (owner decision, before
implementation, via a written proposal): TanStack Table was **not**
installed — confirmed already dropped during the post-M8 UX pass, see that
section above — so the ledger table is hand-rolled on the same shadcn
`Table` + `Money`/`StatusBadge` primitives as every other table in the app.
`finance_expected_totals` (the Excel-diff reconciliation table, built in M1,
still unused) was **deliberately not wired up** — see "Reconciliation scope"
below. XLSX/ExcelJS was **not added**; CSV alone covers the need, so the
plan's M9 dependency-review gate for ExcelJS was never triggered.

**Four adjustments the owner made when approving the proposal, before
implementation:**

1. **Transactions stays inside Finance**, not a third sidebar destination —
   `nav.tsx`'s own comment ("two destinations, adding a third should require
   a real second module") stays true. Reached via a secondary "Transactions"
   button next to "Import statement" on `/finance/monthly`, with a
   `← Finance` back-link on the page itself, matching Review's convention.
2. **No "View in Transactions" link from Monthly's drill-down.** The
   proposed mapping was not actually exact: M8's category/Income cells apply
   `confirmed`/`auto` plus the full exclusion rule set, while Transactions
   defaults to every status and type. Rather than invent a special
   reporting-scope filter just to make the link exact, it was cut. M8 itself
   — `gridBaseConditions()`, the aggregate/drill-down equality guarantee —
   is completely untouched.
3. **The reconciliation strip stays to three counts**: total in the current
   filter, needs-review count, and a transfer/credit-card-payment row count
   excluded from Monthly — **no dollar amount at all**, see below. A generic
   filtered dollar total was cut too — summing income, expense, refunds and
   transfers into one signed number is not a meaningful figure and risked
   reading as competing with Monthly's own totals.
4. **One shared, owner-scoped filter/condition helper** (`ledgerConditions()`
   in `db/finance/transactions.ts`) is reused, unmodified, by the paginated
   listing, the reconciliation summary, and the CSV export — not three
   independent implementations of the same filter semantics.

**Work:** `src/server/finance/export/csv.ts` (new, pure, framework-free) —
RFC 4180 quoting plus a formula-injection guard (`=`/`+`/`-`/`@`-leading
free-text cells get a `'` prefix; the Amount column is deliberately exempt,
since it is generated by `toDecimalString()` and blanket-sanitizing it would
prefix every negative amount and break the column as a number). Additive
functions in `db/finance/transactions.ts`: `listTransactionsLedger` (paginated,
`LIMIT`/`OFFSET`, 100 rows/page), `getLedgerSummary`, `listTransactionsForExport`
(unpaginated, capped at `LEDGER_EXPORT_ROW_LIMIT = 20,000` with an
`exceedsLimit` flag the caller must act on — never a silent truncation).
`/finance/transactions` (Server Component, filters live in the URL, same
reasoning as Review) and `/finance/transactions/export` (a GET Route
Handler, not a Server Action, so a plain `<a href>` gives the browser a
native download — the first protected Route Handler in the app; see "Bugs
found" below). Historical corrections reuse M7's `updateTransactionCategory`
/ `updateTransactionType` **completely unmodified** — the counterpart
unlink, `type_source = 'manual_confirmation'`, and opt-in remember-merchant
semantics all carry over with zero new business logic, verified directly
against the same both-sides assertions M7's own suite makes.

**Reconciliation scope — mostly already covered, said so rather than
building more:** M4's BoA checksum validation, M5's Tier 2 count
reconciliation (staging + commit-time re-check), and M8's
aggregate/drill-down bit-for-bit equality proof already substantiate most of
what a reconciliation feature would exist to prove. What M9 adds is the
three-count summary strip above, computed from the exact same filter
conditions as the visible rows and the export — so it cannot structurally
disagree with either. The `finance_expected_totals` Excel-diff feature
(import the owner's hand-verified totals, compute category×month deltas)
remains unbuilt: wiring it up would mean a second small import pipeline,
closer to "a new accounting subsystem" than the three guarantees already in
place justify. The schema is still there, unused, ready if a concrete need
shows up later.

**The excluded-amount figure went through two fixes, the second one after
the owner had already accepted the milestone.** The first draft summed
signed `amount_cents` over `transfer`/`credit_card_payment` rows — caught
before it ever shipped, by re-deriving the SQL by hand, not by a failing
test: a credit-card-payment pair is two rows with **opposite signs** (the
checking-side outflow, the card-side "payment thank you" inflow are the
same real dollars, moving once), so a signed sum cancels toward zero
exactly when both legs are in scope. Fixed by summing `ABS(amount_cents)`
instead, and shipped that way in the accepted commit. The owner then caught
a SECOND, subtler problem in real use: `SUM(ABS(...))` avoids the
cancellation but then **double-counts** the pair — a real $675 linked
payment reads as $1,350 excluded, since both legs contribute their full
magnitude. Rather than build pair-matching/netting logic to recover the
true $675 (explicitly rejected — that is real reconciliation logic this
page does not attempt), the fix removes the dollar amount entirely:
`getLedgerSummary()` now reports `excludedCount`, a plain row count, with
no paired amount. The general lesson, now in CLAUDE.md: for this table's
data shape, there is no cheap `SUM` vs `ABS` choice that produces a
correct dollar figure for a linked pair — only netting does, and netting
is out of scope here by design.

**A real gap found in `tests/integration/entry-points.test.ts` itself,
never previously exercised:** its "unauthenticated invocation, with the
proxy bypassed" check calls a Route Handler's exported `GET` directly, no
Next.js server around it — which is exactly how it should prove
`requireOwner()` still refuses even with the proxy out of the picture. But
`requireOwner()` reads `next/headers`, which needs Next's own
request-scoped storage, present for every request Next actually serves but
absent when a plain `import()` calls the function directly. Through M8 this
path was untested in practice — `protectedHandlers.length` was asserted to
be exactly `0`, meaning no protected Route Handler had ever existed for it
to run against. `/finance/transactions/export` is the first one, and it
surfaced the gap immediately: the direct call throws
`"headers was called outside a request scope"` before ever reaching
`toAuthErrorResponse()`. Fixed by accepting that specific thrown error as
equally valid proof of refusal (the handler still never reached a 200 with
data — a testing-environment limitation, not a security gap), and updating
the final count to `1`. Documented in CLAUDE.md.

**Tests:** unit (`export-csv.test.ts`) — the formula-injection guard for
every dangerous leading character, RFC 4180 quoting of commas/quotes/
newlines, the Amount column's deliberate exemption from sanitization,
`humanizeEnum`. Integration (`finance-transactions.test.ts`, new, 19 cases)
— every filter combination including `uncategorized` and case-insensitive
merchant/description search, pagination across a 150-row bulk-seeded set,
owner isolation on listing/summary/export, archived-category names still
resolving, the excluded-amount ABS fix directly, a historical category
correction and a historical linked-pair type correction both proven to
match M7's own truth table and unlink guarantee exactly, an edit reflected
immediately in `getMonthlyGridAggregates` with no extra plumbing,
needs-review/exclusionary rows present in the ledger while absent from the
grid in the same test, export row-count/summed-amount correctness against a
direct SQL sum (including a full DB → CSV text round trip), export
filtering, and the 20,001-row export cap failing visibly via a real
`generate_series` bulk insert rather than a mocked limit. E2E
(`transactions.spec.ts`, new, 3 journeys) — reaching Transactions from
Finance as a subpage (sidebar link count still exactly 2), filtering and
searching with a shareable URL, correcting a historical category and
watching Monthly's total change on next load, and exporting a real CSV
download that reflects an applied filter and excludes what the filter
excludes.

**DoD:** `pnpm typecheck` / `lint` / `test` (342) / `test:integration` (128)
/ `test:e2e` (27, two consecutive full runs) / `build` all green — actually
run.

## M10 — Backup automation, deployment, hardening, launch

> **Complete.** The app is deployed and live at `https://app.burmy.me` — see `docs/DEPLOYMENT.md`,
> which is the canonical record of the production architecture and carries the two items still
> outstanding (no backup has been taken of the live database, and the restore-verification procedure
> has never been run against Supabase).
>
> The commands that used to sit here as "get running again" referenced a Docker `migrate` service that
> was deleted in the minimalism pass below. The current ones are in `CLAUDE.md`, "Commands", which is
> the single place they are maintained.

M9 closed out the last owner-facing feature gap: a full searchable ledger,
its own lightweight reconciliation summary, and CSV export, all built on the
existing M1–M8 schema with zero migrations. M10 is infrastructure, not a
feature milestone — hardening the M1 image for production, standing up
`app.burmy.me` behind Cloudflare Tunnel + Access, backup automation with a
**verified restore**, all completed **before** the first real production
import.

**Simplified mid-milestone (owner decision):** the production target is now
`VPS + Cloudflare Access with Google + Burmy-OS/Postgres + Backblaze B2
backups` — nothing more, unless a concrete blocker shows up. Tailscale,
healthchecks.io, automated weekly restore verification, and quarterly DR
drills — all present in the first draft of this milestone — are deferred
for V1. Nothing was deleted: each is clearly labeled `[OPTIONAL]` where it
still lives in the repo, with the two-line command to opt in later. See
`docs/DEPLOYMENT.md`, "Deferred for V1" for the exact list.

**Repo-side work is done and locally tested; external infrastructure is not
provisioned yet.** Split deliberately, per owner instruction, so nothing
external gets touched before the plan was reviewed in detail:

**Done, locally verified against real (synthetic) data:**
- Production `compose.yml` — `edge`/`dbnet` split, no published ports
  anywhere, secrets scoped by consumer (five `.env.<scope>` files, never one
  blanket file — `web` never sees B2/restic/Tunnel credentials). Unchanged
  by the simplification — Tailscale was never a compose service.
- `Dockerfile`: `provision-owner.mjs` added to the `migrator` stage (needed
  by `deploy.sh`'s idempotent-every-deploy provisioning step).
- Docker hardening actually exercised against the real built `runner` image
  for the first time in this project — `read_only: true` + `tmpfs: [/tmp]`,
  `init: true`, `stop_grace_period` — confirmed working (`touch /app/x`
  fails, `/tmp` succeeds, `/api/health` responds). Found and fixed a real
  latent bug along the way: `output: 'standalone'` + pnpm doesn't reliably
  trace `@swc/helpers`, and the image crash-looped on `MODULE_NOT_FOUND`
  until `@swc/helpers` was promoted to a direct dependency and
  `outputFileTracingIncludes` forced it into the traced output — see
  CLAUDE.md. Dev has always run via `pnpm dev` on the host, so nothing
  before this ever actually started the `runner` image.
- `scripts/{provision,deploy,backup,maintenance,restore,
  restore-verify-weekly,verify,check-host}.sh`, all executable, all
  `bash -n`-clean. Backup/maintenance/restore/verify exercised end to end
  against a real local restic repository and real seeded Postgres data (no
  B2 credentials needed for this — `RESTIC_REPOSITORY` just points at a
  local path): dump → manifest → restic backup → restic restore → pg_restore
  → manifest comparison, all correct, plaintext dump/manifest confirmed
  removed after every run regardless of outcome. `deploy.sh`'s image
  tag/retag/rollback/prune logic tested in isolation with simulated deploys
  — caught and fixed a real bug where pruning sorted by the TAG STRING
  (meaningless for a git SHA) instead of actual build time. `check-host.sh`
  caught and fixed a real `df -P` column-parsing bug (breaks when the
  filesystem name itself contains a space). `provision.sh` **rewritten**
  around plain key-based SSH (Tailscale removed entirely — install, auth
  key, `tailscale0`-bound `ufw` rule, all gone); reviewed carefully but
  **not** exercised — no way to test `ufw`/`sshd` changes against a real
  remote host locally; the first real run against the actual VPS is the
  test.
- `deploy/systemd/*.{service,timer}` — nightly backup and weekly maintenance
  are `[REQUIRED]` and enabled by `provision.sh`; weekly restore-verify and
  the daily host check are `[OPTIONAL]`, shipped but **not** enabled by
  default (owner decision — see "Simplified" above).
- `.github/workflows/ci.yml` — test-only, no production secrets, no deploy
  capability: typecheck/lint/unit/integration/e2e/build on every push and PR.
  Unchanged by the simplification.
- **Read-only DNS investigation for `app.burmy.me`** (no account access, no
  mutation, refined over two passes): `burmy.me` is hosted on **Netlify**,
  using Netlify's own DNS product (built on NS1, hence the `nsone.net`
  nameservers) — not a Cloudflare zone today. The first pass proposed
  delegating only the `app` subdomain to Cloudflare via an NS record inside
  Netlify's DNS panel — **withdrawn**: Cloudflare's subdomain-only/partial
  (CNAME) setup is Enterprise-only, not available on the Free plan this
  project assumes. The corrected strategy in `docs/DEPLOYMENT.md`, "DNS
  strategy for app.burmy.me": move `burmy.me`'s full DNS authority to
  Cloudflare while Netlify keeps hosting the site exactly as today — every
  Netlify-facing record reproduced in Cloudflare, DNS-only (not proxied),
  verified record-for-record, **before** the Namecheap nameserver change,
  with a full migration checklist and a public-lookup-grounded record
  inventory (apex/`www` A records confirmed; no MX/TXT/DMARC found — needs
  Netlify-dashboard confirmation before treating that as final). `app.burmy.me`
  itself is created only after the migrated site is verified healthy. **No
  DNS, Cloudflare, Netlify, or Namecheap change has been made.**
- Docs updated to match what was actually built and the simplified scope:
  `docs/DEPLOYMENT.md` (image-versioning design, secrets-scoping table,
  corrected OCI sizing, the DNS investigation above, "VPS administration",
  "Deferred for V1"), `docs/BACKUP_RESTORE.md` (nightly/weekly split,
  plaintext-handling change, healthchecks.io marked optional, one manual
  restore proof required instead of automated weekly verification,
  explicit DR dependency ordering), `docs/SECURITY.md` (checklist and
  Network section updated for plain SSH).

**NOT done — external, manual, stopped deliberately before touching them:**
DNS decision for `app.burmy.me` (needs the owner's choice between the two
options above), VPS provisioning, Cloudflare Tunnel/Access configuration,
Backblaze B2 bucket/keys, and therefore the real production deploy and the
13-point launch checklist. No Tailscale account and no healthchecks.io
account are needed under the simplified scope. See `docs/DEPLOYMENT.md`,
"External setup" for the exact remaining manual steps and "Launch
checklist" for what still needs proving before real financial data touches
production.

### Architecture simplification (2026-08-18): the VPS is dropped

Everything above this subsection describes the VPS-era plan as it was
actually built and locally tested — none of it was wrong, and none of it
was deleted. What changed is which of it is the *default* path.

**What happened externally, in order:** the Cloudflare DNS migration
described above was completed for real (zone Active, Namecheap pointed at
Cloudflare's nameservers) — see `docs/DEPLOYMENT.md`, "External state" for
the exact record set. Cloudflare Zero Trust Free + Google as the identity
provider + a Burmy-OS Access application were configured and a live Google
auth test succeeded. Then VPS provisioning was attempted against Oracle
Cloud's Always Free `VM.Standard.A1.Flex` (2 OCPU/12 GB as planned, then
retried at 1 OCPU/6 GB) — capacity was unavailable in every availability
domain both times. **No VPS was ever created; nothing was ever deployed to
Oracle.**

**The decision, once capacity failed:** reconsidering that Burmy-OS has
exactly one user with light, occasional usage, an always-on VPS (Linux
maintenance, Docker host, `ufw`/SSH hardening, Postgres administration,
`cloudflared`, systemd timers, a restic→B2 backup pipeline) was judged to
be infrastructure sized for a problem this app doesn't have. The new
default production target: **Netlify (hosting) + Supabase (managed
Postgres) + Cloudflare (DNS; proxied for `app.burmy.me` only)**. Dropping
the VPS/Tunnel raised one real question — Cloudflare Access has no request
path to sit in without either a Tunnel or a proxied record — resolved by
owner decision to keep Access exactly as configured and proxy just the
`app.burmy.me` record once its Netlify deployment is verified healthy, in
that order (Netlify needs the record DNS-only first to provision its own
HTTPS). Full detail — target topology, the corrected order-sensitive
rollout sequence, environment variables, the Supabase connection-pooling
code change, migration workflow, and a simplified backup strategy — now
lives in `docs/DEPLOYMENT.md`, which was restructured around this as the
primary path.

**What this did NOT require changing:** no application code assumed a VPS
existed — `src/server/finance/` already parsed uploads in memory only
(never touched disk), and `scripts/migrate.mjs`/`provision-owner.mjs` were
already plain Node scripts with no Docker dependency of their own. The one
real code change was `src/server/db/index.ts`'s connection caching, which
had a latent bug (never cached in production, regardless of hosting
target) that Supabase's connection ceiling made worth fixing now rather
than discovering under real traffic later.

**Everything VPS-shaped stays in the repo, fully intact, as an optional
self-hosting path** — `compose.yml`, the `Dockerfile`, every
`scripts/*.sh`, the `deploy/systemd/*` units — documented under
`docs/DEPLOYMENT.md`'s "Optional: self-hosting on a VPS," not deleted, not
half-maintained as dead weight either: it's the same code M10 already
built and tested, just no longer the thing a fresh deploy reaches for
first.

### Repository cleanup (2026-08-18): the VPS-only files are gone

**Superseded by a follow-up pass, same day.** The paragraph immediately
above described a deliberate choice to keep the VPS-era files around as a
documented optional path. On review, the owner decided that was the wrong
call for a single-maintainer repo: an "optional" path nobody was going to
exercise or keep updated is drift risk, not a feature. So it was removed —
`compose.yml`, `scripts/{provision,deploy,backup,maintenance,restore,
restore-verify-weekly,verify,check-host}.sh`, `deploy/systemd/*`, the VPS-only
`.env.*.example` templates, and the corresponding sections of
`docs/DEPLOYMENT.md`/`docs/SECURITY.md`/`docs/BACKUP_RESTORE.md`/
`docs/ARCHITECTURE.md`. The `Dockerfile` was simplified from five stages to
three (`base`/`prod-deps`/`migrator`), keeping only what local dev's
`compose.dev.yml` migrator actually uses. None of it is lost — `git log -p`
has the full multi-target `Dockerfile`, the production `compose.yml`, and
every script, if self-hosting is ever revisited. The repository's current,
actual shape is: local dev = Next.js + local Postgres (optionally via
`compose.dev.yml`); production = Cloudflare Access → Netlify → Supabase;
backup = a manual logical Postgres dump. No shadow production architecture.

### Aggressive minimalism pass (2026-08-19): the Dockerfile is gone too

**Superseded, same subsection, one day later.** The three-stage `Dockerfile` described just above
turned out to be redundant, not minimal: its one remaining job — running `scripts/migrate.mjs` inside
a built image — was already exactly what `node scripts/migrate.mjs` does directly on the host, which
CI and the manual production migration step (`docs/DEPLOYMENT.md`) had been doing all along with zero
Docker involved. Building an image to do the same thing a second, more complicated way had no current
value, so the `Dockerfile` and `compose.dev.yml`'s `migrate` service were deleted; `pnpm db:migrate`
(now `node --env-file-if-exists=.env scripts/migrate.mjs`, so it picks up local `.env` automatically)
replaced `docker compose run --rm --build migrate` in every doc and script that mentioned it.
`compose.dev.yml` now runs exactly one service — `postgres`, for local dev isolation — which is the
only genuine reason Docker is still involved in local development at all (integration tests don't use
it either; they provision their own throwaway Postgres via Testcontainers). `next.config.ts`'s
`output: 'standalone'` and its `@swc/helpers` tracing workaround, both added solely to fix a crash in
the now-long-gone Docker `runner` image, were removed along with `@swc/helpers` as a direct dependency.
`.dockerignore` had nothing left to ignore for and was deleted too.

## M11 — Finance dashboard

Replaced the bare M8 year grid as Finance's landing view. Commits `045519a`, `87df72b`, `920cfbe`.

### Delivered

- **Headline stat cards** for the selected month — Income, Expenses, Net, Savings rate, Average daily
  spending, Transaction count — each with a month-over-month comparison.
- **Charts** (Recharts, the one new dependency): income-vs-expense trend, net cashflow, category
  breakdown and category trend, largest expenses.
- **A "This Year" tab** — Year Overview with a Jan–Dec horizontal stacked bar and an annual category
  donut that falls back to a horizontal bar past 7 categories. Reuses `getCategoryTotalsForWindow`
  with full-year bounds; no new query.
- **One consolidated toolbar** — title, month/year navigation, Month/This Year mode, Transactions,
  Import statement — replacing two separate rows. Desktop container widened 1152px → 1600px on the
  private layout, so Transactions and Review benefited too.
- **New DB layer** (`db/finance/grid.ts`): `getMonthlyTotalsAllTime`, `getCategoryTotalsForWindow`,
  `getDailyTotalsForMonth`, `getTopExpensesForMonth`, sharing a `dashboardBaseConditions()` filter
  deliberately duplicated from — not coupled to — M8's `gridBaseConditions()`, the precedent M9's
  `ledgerConditions()` had already set.
- **New pure domain module** `server/finance/dashboard.ts` for month math, comparisons, trends and
  category breakdowns. The category-totals/monthly-totals reconciliation is proven in an integration
  test, not asserted in prose.

The year grid itself was untouched, just relabeled "Full year grid" beneath the new dashboard.

### Bugs and traps found during M11

Both are in CLAUDE.md's gotcha list, which is the canonical copy:

- **`formatInflow()` double-flips an already-flipped aggregate.** `getMonthlyTotalsAllTime` sign-flips
  income to a positive display figure at the DB boundary; calling `formatInflow` on that rendered
  `-$6,400.00` for a real paycheck. Nothing catches this statically — the types do not distinguish a
  raw `Cents` from an already-display-flipped one. Found by seeding data and looking at the screen.
- **A flex item's default `min-width` is `auto`, not `0`.** The dashboard sitting above the monthly
  grid pushed `<body>` to 979px on a 390px viewport, despite the table having its own
  `overflow-x-auto`. Every flex boundary in the chain needed `min-w-0` independently — fixing `<main>`
  alone was not enough.

---

## Post-M11 — four rounds of Finance changes driven by real daily use

Not a milestone. Five to six specific friction points at a time, surfaced by the owner actually using
the app on real data, fixed and shipped in rounds. Recorded because the *reasons* are the useful part.

- **Round 1 (`d5357b7`)** — one-click BoA Checking + Credit Card account quick-start (manual form
  entry before any import worked was the first thing in the way); card-payment detection moved so
  `PAYMENT FROM CHK…` rows stop displaying as ordinary spending during review, instead of being
  classified only at commit; unified import review; status text that explains *why* a row landed where
  it did; collapsible nav so Transactions/Review stay reachable when nothing needs review.
- **Round 2 (`be4b881`)** — sidebar collapse and tab switching felt slow. Root cause was real: the
  collapse toggle blocked on a Server Action doing a full `revalidatePath('/', 'layout')` for a purely
  visual change, and every tab click re-verified the JWT and re-queried the owner row up to three times
  with no caching. Fixed with a client-instant toggle plus fire-and-forget persistence, `cache()`
  around `requireOwner()`/`getNeedsReviewCount()`, and a scoped `loading.tsx`. Account management was
  removed outright; full inline transaction editing and bulk remember-merchant were added.
- **Round 3 (`e1e79ab`, `3b937c2`)** — Settings became a real landing page again; the browser's native
  `confirm()` for discarding an import was replaced with a real dialog; categories can now be truly
  deleted when they have zero transactions; the year grid got a Columns toggle; **income no longer
  requires a category** to leave `needs_review` or count toward the grid's Income total — the total is
  summed by `transaction_type`, not category, so requiring one was pure friction.
- **Round 4 (`76494dd`, `0d74f9c`)** — Recharts tooltip readability; the Yearly Breakdown's synthetic
  bucket renamed from "Other" (indistinguishable from a real category with that name) to "Other
  categories", with the cap removed so every real category gets its own series; the palette expanded
  from 6 to 16 colors. `0d74f9c` also fixed a latent `merchantKeyFrom` bug — it strips everything
  outside `[A-Z0-9]`, which is correct for a bank CSV arriving in caps but collapsed a
  lowercase-edited merchant name to capitals only, and would have mis-categorized the paycheck.

---

## The Games module — the second, and final, product module

Merged as `674af16`. Roughly 50 commits of work, built on a `feat/game-tracker` branch, replacing a
manually-maintained spreadsheet of ~185 games the same way Finance replaced one of transactions.

`docs/GAMES.md` is canonical for everything below; this section exists so the roadmap is not silent
about half the application.

### Delivered

| Area | What shipped |
| --- | --- |
| Schema | `games`, `game_play_years`, `game_trophies`, `game_sync_runs`, `game_sync_changes` — migrations `0004`–`0016` |
| Library | Gallery (cover-wall) and table views, filters, search, recency sort |
| Per-game page | Inline per-field editing, trophy list, play-year split |
| Stats | Distributions, yearly breakdown, leaderboards, trophy sections |
| Upcoming | Wishlist (`wanted` status) with IGDB release dates and countdowns |
| Cover art | IGDB, replacing RAWG — which has no portrait art anywhere in its data model |
| Steam sync | In-app (staged, reviewed, committed) plus a separate CLI script with the OPPOSITE fill rule |
| PlayStation sync | In-app, via an unofficial API behind a ~2-monthly manual token chore |
| Trophies | Full per-trophy persistence with rarity, tiers, and earned dates |
| Collections | Boxed sets — see the next section |

### The four invariants this module added

Each cost real debugging and each is in CLAUDE.md:

1. **Hours are tenths of an hour in an integer, never a float** — containment in
   `src/server/games/hours.ts`, exactly like `money.ts`.
2. **Every external credential is optional and fails soft** — IGDB, Steam and PSN all return `[]`/
   `null` rather than throwing, and the full test suite must pass with none of them set.
3. **`games.hours_tenths` is the authoritative total; `game_play_years` only says WHICH YEARS** —
   neither Steam nor PSN can supply a per-year breakdown, so the total must stay a single number an
   API can write while the split stays owner-entered.
4. **`titleId` and `npCommunicationId` are different PSN identifier spaces** with no field in either
   response mapping one to the other — which is why `games` has two separate nullable columns rather
   than one.

### Known gaps, carried forward honestly

- **The two sync engines deliberately disagree**, and unifying them would be a bug: the CLI script
  fills only `NULL` columns ("never overwrite what the owner typed"), while the in-app sync makes Steam
  authoritative for a linked game's hours and achievements.
- **PSP is permanently manual.** No API covers it.
- **The NPSSO token expires roughly every two months** and there is no way to detect it except by
  attempting a sync. This cannot be automated.

---

## Collections (2026-08-28)

A boxed set — "Uncharted: The Nathan Drake Collection" — is one purchase wrapping several games the
owner counts separately. The spreadsheet drew it as one row with its titles indented underneath;
`import-game-log.mjs` flattened that into independent rows because the CSV export had already lost the
indentation, so three games showed as three art-less duplicates of a set that already had a cover.

Migration `0016`: one nullable self-referential FK (`games.collection_id`, `ON DELETE SET NULL`) plus a
partial index. No new table — a boxed set has a cover, a platform, a price, a play time and a trophy
list, which is precisely a `games` row.

**The rule, and it is one sentence:** anything that COUNTS games excludes collection rows; anything
that SUMS hours, money or trophies includes everything. `src/server/games/collections.ts` owns it.

Also shipped: nested rendering in both library views, a "Games in this collection" section on the
collection's own page, blindness to members in both sync engines (`NOT_A_COLLECTION_MEMBER` — without
it, an exact-title match would write hours onto a member the collection already accounts for), and two
report-by-default scripts — `link-game-collections.mjs` (the backfill) and `merge-duplicate-games.mjs`
(the synced-copy-wins duplicate merge).

**Outstanding: the backfill has not been run.** It needs an explicit map of which titles belong to
which collection, which is knowledge that lives in the owner's original spreadsheet, not in the data.
Until it runs, `collection_id` is `NULL` on every row and the feature is inert — correct, tested, and
doing nothing.

---

## Post-launch rounds (2026-08-28)

Same shape as the post-M11 rounds above — real use, specific complaints, fixed in rounds. Recorded
because the reasoning is the reusable part.

### Round A — three URL/cache bugs

- **`?category=<non-uuid>` returned a 500** on both `/finance/transactions` and `/finance/review`: the
  raw param reached a `uuid` column comparison, and Postgres answers a bad one by raising `22P02`.
  `/finance/review` had a worse version — `type` was a bare `as TransactionType` cast, so
  `?type=garbage` reached an *enum* comparison. `readStatus` sitting beside them had always validated;
  these two never did. `src/lib/uuid.ts` now holds the shape check, deliberately a regex rather than
  `z.string().uuid()` because `filters.ts` is imported by a client component.
- **Cache invalidation was wrong in both directions.** Review revalidated only `/finance/review`; the
  ledger's actions revalidated transactions and monthly but never review — even though assigning a
  category is what removes a row from the queue. Each file was right about its own page and wrong
  about the others, which is what a per-feature list does. One shared
  `revalidateTransactionSurfaces()` now covers all three.
- **`Page NaN of 3`** — the client re-read `?page` with `Number()`, and `NaN` survives
  `Math.floor`/`max`/`min`. Fixing it surfaced a fourth thing: importing `LEDGER_PAGE_SIZE` from the
  DAL into that client component pulls `postgres` into the browser bundle and fails the build with
  `Can't resolve 'fs'` — which is exactly why the page size had been a hardcoded `100` there.

### Round B — statement coverage

The dashboard was confidently wrong about the current month, every month: statements arrive mid-cycle
(card ~27th, checking ~15th), so August reported a −70.4% savings rate from two weeks of data.

A month is now reportable only when every active account has a transaction on or after its last day.
Derived from the transactions, never configured — a stored close-day lies exactly when a statement is
late. `/finance/monthly` defaults to `month − 1`, an uncovered month shows no stat cards at all, and
trend charts drop the uncovered tail. Full rule and its two accepted costs in `docs/FINANCE.md`,
"Statement coverage".

The import sheet also gained an "Already imported" list — it showed only STAGED imports, so "did I
already do August's card statement?" could only be answered by leaving the page.

### Round C — perceived performance

*"The transitions between pages are very laggy, and there is no indication."* Measured first, and the
measurement moved the answer: the database is not the bottleneck and cannot become one at this size
(18 MB; the two slowest queries in the app are trophy aggregates at ~109ms and ~66ms, everything else
under 20ms). What costs time is the serverless round trip; what made it *feel* worse was silence.

Two findings, both in `docs/ARCHITECTURE.md`, "Perceived performance":

1. **A dynamic route with no `loading.tsx` is not prefetched at all** — Next 16's documented behavior,
   and every route here is dynamic. Only two segments had one, and the shared fallback sat above the
   sub-nav, so switching Games tabs blanked the tabs. Every segment now has its own, shaped like the
   route it stands in for.
2. **`loading.tsx` does nothing for a same-route navigation**, which is most of them — every filter
   and period change pushes a query string on the route you are already on. `useNavigate` wraps those
   in `startTransition` and the pending flag is rendered locally, next to the control that caused it.

---

## ▶ RESUME HERE

**State as of 2026-08-28:** deployed, live, and in daily use on real data. Both product modules —
Finance and Games — are built. There is no next milestone; work is driven by what real use turns up,
in the round-based shape established above.

**The four things actually outstanding, in priority order:**

1. **No backup exists of the live database.** See `docs/DEPLOYMENT.md`, "Backup strategy". The restore
   procedure has only ever been verified against local dev, on a different Postgres major version, with
   five rows in it. This is the highest-value unfinished item in the project.
2. **Migration `0016` is committed but not applied to production.** Take a backup first — that is
   exactly the trigger item 1 exists for.
3. **The collections backfill needs its map**, per the section above.
4. **Confirm the Netlify function region actually took effect.** `netlify.toml` now pins `us-east-2`
   to match Supabase, but region pinning may be plan-gated — read the deploy log rather than assuming.
   Worth tens of milliseconds, not hundreds; see that file's own comment for the honest sizing.

---

## Carried forward

Items deliberately deferred to a later milestone, tracked so they are not lost.

| Item | Milestone | Why deferred |
| --- | --- | --- |
| BoA `source_transaction_id` **stability** verification | **Descoped — no milestone** | Coverage (100%) and in-sample uniqueness confirmed in M4; cross-export stability skipped by owner decision so it blocks nothing. No unique constraint. `tierOneCandidateStability()` is written and unused, so closing it out later is a function call. |
| ~~BoA adapter written against a real export~~ | ~~M4~~ | **Done.** Two real exports read; three of the plan's assumptions about the layout were wrong. See `docs/FINANCE.md`. |
| ~~Passkey bootstrap + recovery design~~ | ~~M2~~ | **Done.** Both candidates prototyped and measured; the session-first grant design shipped. See `docs/SECURITY.md`. |
| ~~Cloudflare Access verified against real Cloudflare~~ | ~~M10~~ | **Done.** `app.burmy.me` is proxied and Access gates it; the app is reachable only through a Google sign-in against the exact-email Allow policy. |
| ~~Manual real-device passkey verification~~ | ~~M9~~ | **Moot.** The passkey plugin this item was tracking was removed entirely in the post-M8 Cloudflare-Access-only auth change — see that section above. There is no passkey ceremony left to verify on a real device. |
| ~~Categories-reorder e2e test intermittently failed when run after `import.spec.ts`~~ | ~~M5~~ | **Done — root cause was not shared database state.** `shell.spec.ts`'s reorder test asserted `toBeDisabled()` (true instantly via `useOptimistic`, before the Server Action round-trips) and then called `page.reload()` with no wait for the mutation to actually persist. Under a quiet dev server the write reliably landed first by coincidence; the heavier `import.spec.ts` running immediately before added just enough latency to the shared dev-server process to flip that coincidence, and the reload fetched the PRE-reorder order (confirmed by screenshot: "Mortgage, Gas" instead of "Gas, Mortgage"). Fixed by making the test wait for the reorder Server Action's response before reloading — a missing synchronization point the test always had, now closed, not a data-isolation problem. `resetAll()` in both e2e files also now lists the M5 import tables explicitly, matching `tests/integration/harness.ts`'s existing discipline, as defense in depth. Confirmed with three consecutive full-suite runs, 16/16 green each time. |
| **E2E suite shares one database; `workers: 1` remains a real architectural simplification** | M9 or when the suite slows further | Not urgent — the specific flake above is fixed, not papered over. But a shared dev-server process across all specs means a heavy spec can still shift timing enough to expose a genuinely un-synchronized test elsewhere, which is what happened here. Real fix, if the suite outgrows this: a database per worker plus a per-worker `DATABASE_URL`, then restore `fullyParallel: true`. |
| ~~ExcelJS dependency/security review~~ | ~~M9~~ | **Moot — XLSX import was never built.** There is no ExcelJS dependency and no XLSX adapter. CSV via Papa Parse covers every real export the owner has. The review gate stands if XLSX is ever picked up; there is nothing to review until then. |
| ~~Production Docker hardening~~ | ~~M10~~ | **Moot — there is no production image.** The Dockerfile was deleted in the minimalism pass above and production is Netlify (serverless). `compose.dev.yml` runs one `postgres` service for local dev and nothing else. |
| Optional AI categorization | Post-V1 | Only if the residual review tail after 2–3 real months justifies it. As of 32 months / ~1,048 transactions, nothing awaits review and the 87 uncategorized rows are all transfers, card payments and income — types that legitimately have no category. On this evidence the tail does not justify it. |
| **A backup of the live database** | **Now** | Never taken. See `docs/DEPLOYMENT.md`, "Backup strategy" — the policy is written and has never been executed. |
| **The collections backfill map** | **Now** | Needs the original spreadsheet's parent/child grouping, which only the owner has. Until then `collection_id` is `NULL` on every row. |
| Postgres major-version mismatch between production and local/CI | When a migration needs an 18-only feature | Supabase runs 17.x; `compose.dev.yml` and CI pin `postgres:18-alpine`. Nothing in the schema depends on the difference today, which is why this is recorded rather than fixed. |

---

## Deferred beyond V1

Split transactions · category `parent_id` in the UI · saved filter views · recurring-subscription
detection · refund→purchase linking · Finance chat · Amazon item-level splitting · PDF parsing ·
multi-currency logic · budgets and category limits.

"Home dashboard" was on this list and has since been **built** — as the Finance dashboard (M11), on
`/finance/monthly` rather than as a separate top-level destination. Games has its own equivalent on
`/games`. Neither is a cross-module home screen, and neither should become one.

**Every module that is not Finance or Games is permanently out of scope** — Notes, Files, Sheets,
Inbox, Bookmarks, Garage, Receipts, Subscriptions. This is stronger than "deferred": CLAUDE.md forbids
building them, forbids building abstractions in anticipation of them, and forbids a shared "module
framework" for the two that exist. Finance and Games deliberately share nothing but generic UI
primitives and the owner auth boundary.
