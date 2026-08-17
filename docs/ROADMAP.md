# Roadmap

Living status tracker. Full milestone definitions — goals, dependencies, tests, Definition of Done —
are in `IMPLEMENTATION_PLAN.md` §39.

**Working agreement:** one milestone at a time. Stop and report at the end of each before starting the
next. Never mark anything complete without having run the verification and seen the output.

| | Milestone | Status |
| --- | --- | --- |
| **M1** | Foundation, domain core, protecting what is irreplaceable | ✅ Complete |
| **M2** | Authentication, bootstrap prototype, security baseline | ✅ Complete |
| M3 | App shell, accounts, categories | ⚪ Not started |
| M4 | Parsing & normalization core *(no UI)* | ⚪ Not started |
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

## ▶ RESUME HERE — M3: App shell, accounts, categories

**Get running again:**

```bash
docker compose -f compose.dev.yml up -d postgres
docker compose -f compose.dev.yml run --rm --build migrate    # --build is NOT optional
pnpm dev
```

**First run against an empty database** — mint a bootstrap grant, then redeem it at `/recovery`:

```bash
node scripts/auth-grant.mjs bootstrap
```

### M3 scope

1. `(private)` layout with `Finance` / `Settings` nav; responsive; theme; error and loading states.
2. **Initialize shadcn/ui + Lucide** — approved in the plan, not yet installed.
3. CRUD for `finance_accounts`.
4. CRUD + archive + reorder for `finance_categories` with `kind`.
5. Wire `@testing-library/jest-dom` to a Vitest setup file — the first component tests land here.

### Watch out for

- **Every Server Action must call `await requireOwner()`.** `tests/integration/entry-points.test.ts`
  enumerates the filesystem and fails the suite otherwise — that is the test working, not a nuisance.
- Pages under `(private)` should call `requireOwner()` directly too, because from M3 they need the
  returned owner id to scope queries. The layout guard is for navigation, not for data.
- Sensitive actions (bulk delete, full export, changing `OWNER_EMAIL`) use
  `requireOwner({ fresh: true })`.
- Do not bump `typescript` past 6 or `eslint` past 9 — see the pin table in `CLAUDE.md`.

### Ask the owner at M4 — not before

One representative **real Bank of America checking CSV**, plus a **credit-card CSV** if the layout
differs, so adapters are written against observed reality rather than third-party blog posts. The
same milestone decides whether any identifier column is stable, unique and well-covered enough to
earn a unique constraint (§23 Tier 1).

---

## Carried forward

Items deliberately deferred to a later milestone, tracked so they are not lost.

| Item | Milestone | Why deferred |
| --- | --- | --- |
| BoA `source_transaction_id` verification (stability / uniqueness / coverage) | M4 | Requires real overlapping exports. No unique constraint until proven. |
| BoA adapter written against a real redacted export | M4 | Column layout unverified from primary sources |
| ~~Passkey bootstrap + recovery design~~ | ~~M2~~ | **Done.** Both candidates prototyped and measured; the session-first grant design shipped. See `docs/SECURITY.md`. |
| Cloudflare Access verified against real Cloudflare | M10 | Needs the deployment. Locally covered by unit tests against a real key pair plus fail-closed tests. |
| Manual real-device passkey verification | M3 | Automated ceremony passes against Chrome's virtual authenticator; no physical authenticator used yet. |
| ExcelJS dependency/security review | M9 | Gate immediately before XLSX work begins |
| Production Docker hardening | M10 | M1 creates the image; M10 hardens the same image |
| Optional AI categorization | Post-V1 | Only if the residual review tail after 2–3 real months justifies it |

---

## Deferred beyond V1

Split transactions · category `parent_id` in the UI · saved filter views · recurring-subscription
detection · refund→purchase linking · Home dashboard · Finance chat · Amazon item-level splitting ·
PDF parsing · multi-currency logic · budgets and category limits.

**All non-Finance modules** — Notes, Files, Sheets, Inbox, Bookmarks, Garage, Receipts, Subscriptions.
