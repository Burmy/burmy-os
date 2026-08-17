# Burmy — Session Handoff

**Read this file first.** It is written for a Claude Code session with **zero prior conversation
context**. It assumes you have the repository and nothing else.

Last updated: end of **Milestone 4**. Next milestone: **M5 — Import pipeline, preview, duplicates**.

> **Privacy note:** this document deliberately contains no secrets, no `.env` values, no tokens, no
> account numbers, and no real financial data. It must stay that way.

---

## 1. Project identity

| | |
| --- | --- |
| **Name** | Burmy — repository `burmy-os` (GitHub: `Burmy/burmy-os`, **private**) |
| **What it is** | A private, single-user personal web application |
| **Deploys to** | `app.burmy.me` |
| **Separate from** | `burmy.me` — the owner's public portfolio, a **different project, not in this repo** |
| **V1 scope** | **Finance only** |
| **"OS"** | A metaphor for a personal digital workspace. **This is not an operating system**, not a platform, not a plugin host. |

**One user. No signup, no registration, no roles, no tenancy, no billing.** There is no signup route —
not hidden, not disabled: never registered.

Why a separate origin rather than `burmy.me/finance`: the same-origin policy. Any XSS anywhere in the
portfolio would otherwise execute in the same origin as the finance app and be able to read its DOM
and issue authenticated requests. A separate origin makes that structurally impossible, and also buys
host-only cookies, an independent CSP, an independent Access policy, and independent deploys.

---

## 2. Product goal

The owner currently maintains a **manual Excel sheet**: rows are spending categories, columns are
months, each cell hand-summed with a hand-typed comment listing the purchases behind it. Producing it
means reading every transaction, categorizing it mentally, adding amounts by hand, and typing the
total into a cell.

Burmy automates everything after *"I downloaded a CSV"*.

```
Download CSV exports  ->  upload (multi-file batch)
                            |
                          parse -> normalize -> dedupe
                            |
                  classify (transfer / card payment / investment)
                            |
                        categorize
                            |
                     review the handful that are uncertain
                            |
                          commit
                            |
              MONTHLY CATEGORY x MONTH GRID updates itself
                            |
                  click any cell -> the exact transactions behind it
```

**The monthly grid is the product.** Everything else exists to keep it correct. It is the landing
route (`/finance/monthly`), and cell drill-down is its headline interaction — it replaces the Excel
cell comments and is strictly better, because the list is always current rather than hand-maintained.

**Historical data** enters through the *same* importer as any other month, giving full drill-down.
The owner's **Excel sheets are used as reconciliation ground truth** — hand-verified expected totals
compared against computed totals, which validates the whole pipeline against years of real data.

### Non-negotiable: no bank connections

**No Plaid, no Finicity, no bank APIs, no bank OAuth, no stored bank credentials, no scraping, no
automatic syncing.** Ever. Files in, insights out. This is a deliberate product and privacy decision,
not a technical limitation, and it is not open for "simplification".

---

## 3. Confirmed product decisions

These came from a structured interview with the owner and are **settled**. Do not re-litigate them.

| Decision | Detail |
| --- | --- |
| **Institution** | **Bank of America only.** The Chase / Amex / Apple Card / Fidelity examples that appear in early planning text were illustrative, not real. |
| **Historical CSVs** | The owner still has all original exports and retains/backs them up personally. |
| **Usage cadence** | **Monthly**, not daily. One long sitting per month. This drives several design decisions (see §5). |
| **Cash spending** | **Not tracked.** No cash-entry flow in V1. |
| **Income** | Tracked, with its own Income column in the grid (M8: flat column order, not a separate section — see §8). |
| **Investments** | Tracked. Appear in the grid (e.g. a `Stocks` column) and in Total Expenditure, but **not** counted as an ordinary Expense. |
| **Savings / brokerage balances** | **Manual monthly snapshots.** Never derived from transfer flows — once interest or market movement is involved, a derived balance drifts from reality permanently and silently. |
| **Reimbursements** | **Reduce their original category.** A $60 dinner reimbursed $30 shows **$30 under Food** — not $60 expense plus $30 income. |
| **AI** | **Not in V1.** The app must pass its entire test suite with no API key present. |
| **Landing page** | `/finance/monthly`. `/` redirects to it. |
| **Home dashboard** | **Cut from V1.** The grid is the dashboard. |
| **Future modules** | No placeholders, no nav entries, no abstractions for Notes / Files / Sheets / Inbox / Bookmarks / Garage / Receipts / Subscriptions. |
| **Row axis** | Flat categories. **Merchant-shaped category names are legitimate** — `Planet Fitness` and `Amazon` are ordinary categories that happen to carry a merchant rule. The transaction's `normalized_merchant` stays a separate field. |

---

## 4. Approved architecture

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | **Next.js 16.3** (App Router) | `output: 'standalone'` for Docker |
| UI runtime | React 19 | |
| Language | **TypeScript 6** — pinned, see §6 | |
| Lint | **ESLint 9** — pinned, see §6 | |
| Runtime | **Node 24 LTS** | Matches the container |
| Package manager | **pnpm 11** via corepack, pinned in `packageManager` | |
| Database | **PostgreSQL 18** | |
| ORM | **Drizzle ORM** 0.45 | Pinned exactly (0.x versioning) |
| Auth | **Better Auth — passkey + local session ONLY** | See §7 |
| Identity provider | **Google, configured once, in Cloudflare Access** | **Not** a second time inside Better Auth |
| Styling | Tailwind 4 (installed). **shadcn/ui + Lucide are approved but NOT yet initialized** — that lands with the app shell in M3 | |
| CSV parsing | Papa Parse | Not yet installed; arrives M4 |
| Grids | **TanStack Table + TanStack Virtual** | **Not AG Grid** — its row grouping and pivoting are Enterprise ($999/dev/yr), and the monthly view *looks* like a pivot. Ours is computed in SQL. |
| XLSX | **ExcelJS — PROVISIONAL** | Isolated behind one module. **A dependency/security review is a required gate at M9.** The npm `xlsx` package is **prohibited** — abandoned at 0.18.5 with unfixed prototype-pollution and ReDoS advisories. |
| Testing | Vitest + React Testing Library, Playwright | |
| Packaging | Docker + Docker Compose | |
| Ingress | Cloudflare Tunnel + Cloudflare Access | |
| Admin access | Tailscale | |
| Backups | restic → Backblaze B2 | M10 |

**Deliberately rejected:** Kubernetes, Redis, Kafka, Elasticsearch, GraphQL, microservices, message
queues, self-hosted Supabase, custom cryptography, AG Grid Enterprise, npm `xlsx`.

---

## 5. Invariants — do NOT "simplify" these away

Every one of these exists because violating it causes a correctness, security, or data-loss bug.
Several were mistakes caught in review before implementation.

### Financial correctness

1. **Transactions are the only source of truth.** Every reported number is computed by SQL at read
   time. **No total is ever stored.** The monthly grid is a view.
2. **Money is a signed `BIGINT` of cents. Positive = outflow, negative = inflow.** Never floats.
   **Never `NUMERIC`** — the `pg` driver returns it as a *string*, and the resulting `parseFloat` is
   precisely the floating-point bug being avoided. All arithmetic goes through
   `src/server/finance/money.ts`; nothing else does money math.
3. **No LLM ever performs arithmetic.** SUM, AVERAGE and all totals are Postgres's job, permanently.

### Import pipeline

4. **Raw uploaded statement files are deleted immediately after parsing** — always, including on the
   failure path. Never written to `public/` or any statically served path.
5. **Staging stores only sanitized, normalized fields.** There is deliberately **no raw `jsonb`
   dump**. Unmapped source columns are discarded at parse time and never persisted — retaining them
   would keep address fragments, internal bank codes and card identifiers in a table that lives for
   up to 60 days.
6. **`dedupe_key` and `merchant_key` are separate concepts and must stay separate.**
   - `dedupe_key` — **immutable identity**, derived from the *raw* description under a **frozen,
     versioned** algorithm (trim, uppercase, collapse whitespace — nothing else, ever). Computed once
     at import and persisted.
   - `merchant_key` — **expected to evolve**; used for categorization matching and display.
   - *Why:* if identity depended on `merchant_key`, adding one normalization rule would change the key
     for every future import and silently stop matching against years of committed transactions,
     quietly reintroducing duplicates.

### Classification

7. **Exclusionary transaction types must never be assigned from a weak heuristic.** `transfer`,
   `credit_card_payment` and `investment` remove money from spending totals *invisibly*. They require
   one of: an explicit user rule, a **qualified counterpart match**, or explicit review confirmation.
   A suspicion produces a **review item**, never a silent exclusion.
8. **A qualified counterpart match needs more than amount + date.** Structural conditions (equal
   absolute amount, opposite sign, both accounts owned, ±7 days, **account-type compatibility**),
   **plus** a semantic signal (a recognized keyword on either leg, or the counterpart account's name
   fragment / last-four appearing in the other description), **plus** exactly one candidate. Two or
   more candidates → review item.
   *Why:* a $200 rent payment and a $200 card payment on the same day satisfy amount, date and
   direction and have nothing to do with each other. Auto-pairing would silently delete $200 of real
   spending.

### Code structure

9. **`src/server/finance/` is the framework-free domain core** — no React, no Next.js, no HTTP. This
   is what makes financial correctness verifiable in milliseconds without a browser or a server. An
   ESLint rule enforces it.

### Security

10. **Every protected server entry point authenticates itself** — Server Actions *and* Route Handlers
    — via `requireOwner()`. `src/proxy.ts` is **defense-in-depth, not the security boundary**. Next.js
    documents that Server Functions are POSTs to their host route, so a `matcher` change or a refactor
    can *silently* remove proxy coverage.
11. **Postgres is never exposed publicly.** Production keeps it on an `internal: true` network with no
    published ports.
12. **The database is NEVER automatically restored during a failed deployment rollback.** On
    healthcheck failure, roll back the *image only* and leave Postgres untouched. A failed healthcheck
    usually means a bad build, and the database may hold newer writes. Restoring is always a separate,
    explicit, confirmed command.
13. **No secrets and no real financial data in Git.** `.gitignore` is deliberately broad (`*.csv`,
    `*.xlsx`, `*.pdf`, `*.dump`, `.env*`) with a narrow re-include for `tests/fixtures/**` only.

### Driven by monthly usage

14. **Imports are multi-file batches.** Transfers and card payments have **two legs**; matching them
    requires both files present at once.
15. **Staged imports expire after 60 days, not 7.** A 7-day sweep would delete an in-progress review
    before a monthly user ever returned to it.

---

## 6. Toolchain pins and infrastructure traps

### Version pins — `pnpm update` will break these

| Package | Pinned | Latest | Why |
| --- | --- | --- | --- |
| `typescript` | **6.x** | 7.x | **typescript-eslint cannot load under TS 7** — `pnpm lint` throws before linting a single file (typescript-eslint#10940). `tsc` itself works on 7; the linter is the blocker. |
| `eslint`, `@eslint/js` | **9.x** | 10.x | The Next 16 lint stack targets ESLint 9. On 10: `eslint-plugin-react` throws `contextOrFilename.getFilename is not a function`, and typescript-eslint throws `scopeManager.addGlobals is not a function`. |

`eslint.config.mjs` also pins `settings.react.version` explicitly, which skips
`eslint-plugin-react`'s version auto-detection — the origin of its ESLint 10 crash. Harmless on
ESLint 9 and it survives the eventual upgrade.

### Docker and Next.js traps that are easy to regress

| Trap | Correct | Consequence if wrong |
| --- | --- | --- |
| **`proxy.ts` location** | **`src/proxy.ts`** — level with `src/app/`, *not inside it* | Not picked up at all |
| **Two Docker networks** | `edge` (normal bridge, outbound internet) for `web` + `cloudflared`; `dbnet` (`internal: true`) for `web` + `migrate` + `postgres` | **`cloudflared` on an internal-only network cannot dial out and the tunnel never comes up** |
| **PG18 volume path** | Mount `pgdata:/var/lib/postgresql`. PG18's `PGDATA` is `/var/lib/postgresql/18/docker` and its declared `VOLUME` moved to `/var/lib/postgresql` | The pre-18 `/var/lib/postgresql/data` **fails silently** — container starts, healthcheck passes, data disappears on recreate |
| **Migrations** | Run through the containerized migrator: `docker compose -f compose.dev.yml run --rm migrate`. Never host pnpm | Dev/prod runtime divergence |
| **Migrator is plain ESM** | `scripts/migrate.mjs` — **deliberately not TypeScript** | See below |
| **Docker installs** | `pnpm install --ignore-scripts` | pnpm blocks dependency install scripts by default; declining explicitly avoids granting arbitrary code execution at build time. Neither `next build` nor the migrator needs a native postinstall. |
| **Writing JSON from PowerShell** | Use `[System.IO.File]::WriteAllText(path, text, [System.Text.UTF8Encoding]::new($false))` | `Set-Content -Encoding utf8` emits a **UTF-8 BOM**; pnpm in the container then fails with `Invalid package.json` |
| **`exactOptionalPropertyTypes`** | On. Omit optional keys (`...(cond ? { k: v } : {})`) rather than assigning `undefined` | Type error |

**Why the migrator is plain `.mjs`:** applying migrations only needs to execute the generated SQL — it
does not need schema types. Writing it in TypeScript drags `tsx` → `esbuild` → a platform-native
binary into an image whose entire job is running a few `CREATE TABLE`s. As plain ESM it depends only
on `drizzle-orm` and `postgres`, both production dependencies shipping real JavaScript, which lets the
migrator image build with `--prod --ignore-scripts`. Smaller image, tighter supply chain.

---

## 7. Security and authentication architecture

**Two factors with different failure modes.** The point is not "two logins" — it is that compromising
one does not compromise the other.

```
Browser -> app.burmy.me
   |
   v
CLOUDFLARE ACCESS        <- FACTOR 1: Google identity, allowlisted to OWNER_EMAIL
   |                        (TLS terminates at Cloudflare's edge)
   |  outbound-only tunnel, no inbound ports on the origin
   v
src/proxy.ts             <- verifies the Access JWT against Cloudflare's JWKS
   |                        (signature, aud, iss, exp). DEFENSE-IN-DEPTH ONLY.
   v
BETTER AUTH              <- FACTOR 2: passkey (WebAuthn) + local session
   |                        NO Google client configured here.
   v
requireOwner() in every protected Server Action and Route Handler
   |
   v
Finance
```

- **Google is configured exactly once — in Cloudflare Access.** Not a second time in Better Auth. One
  fewer place for the allowlist to drift out of sync.
- Owner identity comes from the **verified Access `email` claim**, matched against `OWNER_EMAIL`.
- Session cookie: `httpOnly`, `Secure`, `SameSite=Lax`, **host-only — never `Domain=.burmy.me`**,
  server-side store in Postgres for instant revocation.
- **Unprotected endpoints are an explicit allowlist**, currently exactly two: `/api/health` (returns
  booleans and a version string only — no counts, no data, no error text, no environment detail) and
  `/api/auth/*` (authenticates by design).

### Bootstrap and recovery — RESOLVED in M2, by prototype

Better Auth's passkey plugin documents no recovery path and no bootstrap-without-a-session story.
Both candidates were implemented and measured against a real PostgreSQL 18, then one was chosen and
the other **deleted**. Canonical write-up with the evidence: [`docs/SECURITY.md`](./SECURITY.md).

**What shipped — one mechanism for both:**

```
node scripts/auth-grant.mjs <bootstrap|recovery>     on the host, over SSH/Tailscale
   │  mints a 256-bit token, prints it ONCE, stores only sha256(token)
   ▼
POST /api/auth/burmy/redeem-grant   { token, kind }
   │  verifies Cloudflare Access ITSELF · single-use (atomic consume) · 10-min TTL
   │  kind must match · owner email must match · 5 attempts/hour (DB-backed)
   │  recovery additionally revokes every existing session
   ▼
session  ->  /onboarding/passkeys  ->  two passkeys enrolled  ->  Finance
```

**Why not Better Auth's passkey-first registration (`requireSession: false`):** it works, but it
leaves `/passkey/generate-register-options` answering unauthenticated callers *permanently* for a
once-ever operation, the grant could not be consumed at options time without burning it on a dismissed
browser prompt (so one token yielded unlimited challenges for 10 minutes), and it created the owner
row from an anonymous request. The session-first design also means **the recovery path is exercised on
day one** instead of being cold code needed on the worst day.

**Committed constraints — all met:**
- **Two passkeys** before onboarding completes — enforced in `requireOwner()`, not in the UI.
- **No email anywhere.** An email path would be a permanent phishable backdoor around the very factor
  the passkey exists to provide.
- **The last passkey cannot be deleted**, so a mis-click cannot force a break-glass recovery.

---

## 8. Finance correctness rules

Canonical detail: [`docs/FINANCE.md`](./FINANCE.md).

| Type | In grid? | In category columns? | In Total Expenditure? |
| --- | --- | --- | --- |
| `expense`, `fee`, `adjustment` | Yes | Yes | Yes |
| `refund` | Yes — negative, reduces its category | Yes, net | Yes, net |
| `investment` | Yes, its own category column (e.g. `Stocks`) | Yes | Yes |
| `income` | Yes, its own Income column | No | No |
| `transfer` | **No** | No | No |
| `credit_card_payment` | **No** | No | No |

As of M8, columns render flat in the owner's category `sort_order` — **not** grouped into Spending vs.
Income blocks. `kind` shows only as a small label under the column name; it never reorders columns.

**Credit-card payments must not double-count.** Card purchases ($20 + $100 + $80) are `expense`. The
checking-side $200 payment is `credit_card_payment`. The card-side "PAYMENT THANK YOU" credit is
*also* `credit_card_payment`. Both payment legs are excluded everywhere, so the total stays **$200** —
not $400, not $0.

**Refunds are not income.** A refund carries the *same category* as the purchase and nets it down.

**Income display.** Income is *stored* negative (money arriving, per the outflow-positive convention)
but the Income column **flips the sign for display only** — a paycheck must read `$6,400`, not
`-$6,400`. The stored value is never touched.

**`Gross Savings` = Income − Total Expenditure.** The only figure that mixes both.

**The exclusion of `transfer` and `credit_card_payment` lives in exactly one shared filter function**
(`gridBaseConditions()`, M8) — used verbatim by both the aggregate query and the drill-down query, so a
drill-down total cannot structurally disagree with its cell. Covered by tests, including a direct
sum-equality proof.

### Duplicate detection

- **Tier 1 — source transaction ID: authoritative only once proven.** A column named "Reference
  Number" is *not* evidence that it is a stable, unique transaction identifier. **M4 must verify
  stability (byte-identical across two exports of the same range taken on different days), uniqueness
  (never shared by two genuinely different transactions) and coverage, per account type.** Until all
  three pass, it is **advisory metadata only and there is no unique constraint** — the schema
  currently indexes it non-uniquely on purpose.
- **Tier 2 — count / multiset reconciliation (the default).** Per `dedupe_key`, compare staged count
  against committed count in the date window and import only the surplus. Two genuine $5 coffees on
  the same day are two transactions, not a conflict. Order-independent and naturally idempotent.
- **Tier 3 — near matches** (same account, same amount, ±3 days, similar merchant) are **flagged and
  require a decision. Never auto-excluded.**
- Plus a file-level `sha256` pre-check that warns *before* parsing.

**Nothing is ever silently destroyed.** Every exclusion is visible and reversible in the preview.

---

## 9. Current status — Milestones 1 through 8 COMPLETE

**M2 added authentication.** Full detail, including every trap hit along the way, is in
[`docs/ROADMAP.md`](./ROADMAP.md). The short version:

| | |
| --- | --- |
| Auth | Cloudflare Access JWT (factor 1) + Better Auth passkeys (factor 2), both enforced inside `requireOwner()` |
| Bootstrap & recovery | One single-use 10-minute grant, minted only by `scripts/auth-grant.mjs` over SSH/Tailscale. Prototyped both candidates, chose, deleted the loser. |
| Gates | Two passkeys before onboarding completes; last passkey undeletable; re-auth for passkey removal |
| Schema | **19 tables**, 2 migrations. `session` / `account` / `verification` / `passkey` / `rate_limit` added; M1's `user` table reconciled, not duplicated |
| Shell | `Finance` / `Settings` nav, cookie-based theme (three states, no inline script), error/loading/not-found boundaries with a correlation id |
| Taxonomy | Accounts CRUD (deactivate, never delete; `last_four` rejects longer input) and categories CRUD + archive + up/down reorder |
| Data access | `src/server/db/finance/` — `ownerId` first on every function, injected into every `WHERE`. `src/server/finance/` stays DB-free. |
| Parser | `raw bytes → parse → normalized candidate`, two stages kept apart. BoA deposit + card adapters written against REAL exports. Deposit exports **validate themselves to the cent** against their own summary block. |
| Fixtures | `tests/fixtures/finance/` — 10 files **redacted from real exports** (invariant amended in M4), consumed as raw bytes, checksummed, with a guard test validated by a negative control. |
| Dedupe | **Tier 2 count reconciliation is active**, at staging AND again inside `commitImport()`'s transaction against the current committed count — closing the race between two concurrently staged imports. An explicit owner override (`decision_overridden`) is exempt from the re-check. Tier 1 (`Reference Number`) remains captured, documented, and UNVERIFIED — no unique constraint. |
| Import pipeline | `/finance/import` → `/finance/import/[id]`. Single file per import, in-memory only, never written to disk. Account/format compatibility checked before staging. One bad row stages as a reviewable "needs attention" row (`parseStatementTolerant`) instead of aborting the file. File-hash pre-check distinguishes `committed` ("already imported") from `review`/`discarded` (never called that). Category optional at commit. |
| Classification | **Merchant memory** (`finance_merchant_memory`) pre-fills a category from confirmed history; owner override always wins going forward. **Counterpart matching** (`classify/counterpart.ts`) links transfer/credit-card-payment legs by BoA's shared confirmation token — exact match, ±7 days, exactly one candidate, or no classification at all. Every automated write gated on `type_source = 'default'`, so a manual confirmation (M7) can never be overwritten. Investment auto-classification and the `counterpart_transaction_id` FK were both explicitly deferred. |
| Review queue | `/finance/review` — filterable by status/account/category/type. Assign/change category, correct type (`type_source = 'manual_confirmation'`), bulk-assign. **No confirmed-but-uncategorized spending**: a category is required for `confirmed` unless the type is exclusionary. Correcting a linked transaction's type **atomically unlinks both legs** — the corrected one becomes manual, the freed one reverts to its M5 default. Memory updates from a correction are **opt-in** (unchecked by default) — an exception fix should not silently retrain future imports. Nav carries a live needs-review count. |
| Monthly grid | `/finance/monthly` — the landing route and the actual product. Month × category totals, Total Expenditure, Income, Gross Savings, all computed live from `finance_transactions` (never stored). Columns in the owner's `sort_order`, flat — never regrouped by `kind`. Every cell with a transaction drills down to the exact rows, through the same `gridBaseConditions()` the aggregate query uses, so a drill-down total structurally cannot disagree with its cell (proven in the integration suite). A `confirmed`/`auto` transaction with no category (should be impossible after M7) is still counted, and now also surfaces a dedicated reconciliation banner. |
| Suites | `pnpm test` **332** (domain + components, Docker-free) · `pnpm test:integration` **155** (Testcontainers) · `pnpm test:e2e` **21** (Playwright) |
| **Pushed?** | **NO.** Commits are local only. |
| Repository visibility | **Private** |

### Milestone 1, for reference

| | |
| --- | --- |
| Commit | **`9bb6a76`** — "Milestone 1: foundation, domain core, and database schema" |
| Files | 41 changed, 14,321 insertions |
| Working tree | Clean at time of the M1 report |

### Verification actually executed

Every row below was run and its output observed. None of it is assumed.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0, zero errors, zero warnings |
| `pnpm test` | **74 / 74 passing** |
| `pnpm build` | exit 0 — 4 routes, Proxy (Middleware) detected |
| Postgres container | `postgres:18-alpine` healthy |
| Migrations **in container** | `docker compose run --rm migrate` → "Migrations complete." |
| Schema applied | **14 tables** |
| `PGDATA` | `/var/lib/postgresql/18/docker` (PG18 layout confirmed) |
| **PG18 persistence** | after `docker compose down && up`: marker row survived, 14 tables survived, 1 migration record survived |
| `/api/health` live | `200` → `{"ok":true,"database":true,"version":"0.0.0"}` |
| Secret leak check | `.env` matched by `.gitignore`; nothing sensitive staged |

### Bugs found during M1 — why those tests exist

Do not remove these tests. Each pins a real defect that shipped in a first draft.

1. **Negative zero.** `negate(ZERO)` returned `-0`. Because `-0 === 0` is *true*, it hides from casual
   comparison — but `Object.is`, `Map`/`Set` keys and some serializers all distinguish it, and a
   negative zero dollars is meaningless. Fixed at the source with a shared `wrap()` so **every**
   operation normalizes, not just `negate`. Regression tests cover single operations, allocation
   (including negative totals with zero weights), the database round trip, and formatting.
2. **Non-breaking space in a regex.** Two regex literals in `money.ts` contained **U+00A0** instead of
   a space — an invisible typo. The tests passed only because a later `.trim()` happened to mask it.
   Replaced with an explicit `/[$\s]/g`, which also covers U+00A0 and U+202F — both genuinely appear
   in bank data copied through a browser or PDF. Caught by ESLint's `no-irregular-whitespace`.
3. **`exactOptionalPropertyTypes`.** `playwright.config.ts` assigned `undefined` to an optional
   property. Fixed by omitting the key rather than weakening the compiler setting. The setting stays
   on: in a codebase handling money, "absent" and "present but undefined" being different types is a
   feature.

### Also worth knowing

- The dev seed creates **4 accounts and 11 categories** under owner id `dev-owner`, and **zero
  transactions** — those only ever arrive through the importer (M5). Synthetic only.
- `@testing-library/jest-dom` is installed but **not yet wired to a Vitest setup file** — do that in
  M3 when the first component tests appear.
- **shadcn/ui and Lucide are approved but not yet initialized.** M3.
- Vitest defaults to the `node` environment on purpose, so an accidental DOM dependency in the domain
  core fails loudly. Component tests opt in with `// @vitest-environment jsdom`.

---

## 10. Repository structure

```
burmy-os/
├── CLAUDE.md                    Working rules, invariants, version pins, gotchas
├── docs/
│   ├── HANDOFF.md               <- you are here
│   ├── IMPLEMENTATION_PLAN.md   THE PLAN OF RECORD (approved, 39 sections)
│   ├── ARCHITECTURE.md          Boundaries, data flows, trust boundaries
│   ├── SECURITY.md              Threat model, controls, pre-release checklist
│   ├── FINANCE.md               Domain rules + BoA adapter findings log (M4 fills in)
│   ├── DEPLOYMENT.md            Target topology (M10; marked not-yet-built)
│   ├── BACKUP_RESTORE.md        Backup stages and the DR drill
│   └── ROADMAP.md               Live milestone tracker + "RESUME HERE"
├── drizzle/                     Generated migrations (COMMITTED)
│   ├── 0000_wet_malcolm_colcord.sql   14 tables — M1
│   ├── 0001_nappy_ultron.sql          + 5 auth tables — M2, purely additive
│   └── 0002_strong_red_hulk.sql       + finance_import_rows.decision_overridden — M5
├── scripts/
│   ├── migrate.mjs              Migration runner — plain ESM on purpose
│   └── auth-grant.mjs           BREAK GLASS. Mints bootstrap/recovery grants.
│                                Plain ESM for the same reason: it must run on a
│                                host that may have just been rebuilt.
├── src/
│   ├── proxy.ts                 Level with app/, NOT inside it. Access JWT + CSP
│   │                            nonce. EDGE runtime — keep it edge-safe.
│   ├── app/
│   │   ├── page.tsx             -> redirects to /finance/monthly
│   │   ├── (auth)/sign-in/      passkey challenge
│   │   ├── (auth)/recovery/     redeem a grant (cannot ISSUE one)
│   │   ├── (onboarding)/onboarding/passkeys/   the two-passkey gate. Own route
│   │   │                        group so it cannot redirect-loop with (private).
│   │   ├── (private)/layout.tsx requireOwner() for navigation
│   │   ├── (private)/finance/layout.tsx   Monthly / Import sub-nav — M5
│   │   ├── (private)/finance/monthly/page.tsx   THE PRODUCT — month x category
│   │   │                        grid, live SQL aggregates, drill-down — M8
│   │   ├── (private)/finance/import/page.tsx    upload + in-progress list — M5
│   │   ├── (private)/finance/import/[importId]/page.tsx   preview/review/commit — M5
│   │   ├── (private)/finance/review/page.tsx    needs-attention queue — M7
│   │   ├── api/health/route.ts  UNAUTHENTICATED; booleans + version ONLY
│   │   ├── api/auth/[...all]/   UNAUTHENTICATED by design; getAuth() per request
│   │   ├── layout.tsx  globals.css
│   │   ├── (private)/settings/{accounts,categories,passkeys}/
│   │   ├── (private)/{error,loading,not-found}.tsx
│   ├── components/ui/           shadcn/ui — button, input, label, select, dialog,
│   │                            table, dropdown-menu, sonner
│   ├── features/auth/           sign-in, enrolment, grant redemption (client)
│   ├── features/shell/          nav, theme toggle, sign-out, StyleNonce
│   ├── features/finance/settings/  accounts, categories, passkeys managers + actions
│   ├── features/finance/import/    upload form, review table, actions — M5
│   ├── features/finance/review/    queue, filters, corrections, bulk actions — M7
│   ├── features/finance/monthly/   grid table (client), drill-down Server Action — M8
│   ├── lib/auth-client.ts       Better Auth browser client, passkey plugin only
│   ├── lib/utils.ts             cn()
│   ├── server/
│   │   ├── auth/
│   │   │   ├── access.ts        FACTOR 1 — Cloudflare Access JWT, fail-closed
│   │   │   ├── index.ts         FACTOR 2 — Better Auth. Lazily constructed.
│   │   │   ├── owner.ts         requireOwner() — THE boundary
│   │   │   ├── grants.ts        single-use token format (hashed at rest)
│   │   │   ├── grant-plugin.ts  POST /api/auth/burmy/redeem-grant
│   │   │   └── passkey-policy.ts  re-auth + last-passkey rule + audit
│   │   ├── security/{csp,audit,theme}.ts
│   │   ├── db/
│   │   │   ├── {index,schema,seed}.ts
│   │   │   ├── finance/{accounts,categories,errors}.ts   OWNER-SCOPED data access
│   │   │   ├── finance/imports.ts   staging, review reads, decisions, commit — M5.
│   │   │   │                    The advisory-lock commit-time Tier 2 re-check AND
│   │   │   │                    M6's counterpart-match/merchant-memory-write live here.
│   │   │   ├── finance/merchant-memory.ts   READ side of learned category mappings — M6
│   │   │   ├── finance/transactions.ts   M7: review-queue reads, category/type
│   │   │   │                    corrections, the counterpart unlink, bulk assignment
│   │   │   └── finance/grid.ts   M8: getMonthlyGridAggregates, getCellTransactions,
│   │   │                        listTransactionYears — gridBaseConditions() is the
│   │   │                        ONE filter shared by the aggregate and drill-down queries
│   │   └── finance/            THE DOMAIN CORE — framework-free, DB-free
│   │       ├── money.ts        Cents + ALL arithmetic
│   │       ├── grid.ts         M8: buildMonthlyGrid() — pure pivot of pre-summed SQL
│   │       │                    rows into the grid's cells + Total Expenditure/Income/
│   │       │                    Gross Savings/unreconciled bucket
│   │       ├── taxonomy.ts     names, slugs, last_four guard, reorder
│   │       ├── merchant.ts     display + matching names. NOT identity.
│   │       ├── dedupe.ts       frozen dedupeKey + Tier 2 reconciliation
│   │       ├── parse/          STAGE BOUNDARY: bytes -> rows -> candidates
│   │       │   ├── types.ts    NormalizedCandidate; what neither stage does
│   │       │   ├── csv.ts      bytes -> cells, BOM, header LOCATION
│   │       │   ├── signature.ts  header-set hash; never the filename
│   │       │   ├── normalize.ts  dates, sign INVERSION, Cents
│   │       │   └── index.ts    detection + composition + parseStatementTolerant — M5
│   │       ├── adapters/       boa-deposit (self-validating), boa-card
│   │       ├── import/         M5: account/format compatibility, staging decisions
│   │       └── classify/
│   │           ├── counterpart.ts  M6: extractConfirmationToken, findQualifyingCounterpart —
│   │           │                ONE mechanism for transfers AND credit-card payments
│   │           └── manual.ts   M7: reviewStatusForCorrection (the no-confirmed-but-
│   │                            uncategorized rule), MANUAL_TRANSACTION_TYPES (7 of 8
│   │                            real enum values — no raw 'adjustment' in the UI).
│   │                            M8 adds TRANSACTION_TYPE_LABELS (all 8, drill-down display)
├── tests/
│   ├── unit/                    332 tests, NO Docker/database. Two Vitest projects:
│   │                            *.test.ts -> node, *.test.tsx -> jsdom. grid.test.ts:
│   │                            buildMonthlyGrid() cells, column order, formulas — M8
│   ├── fixtures/finance/        10 REDACTED files from real exports. Consumed as
│   │                            raw BYTES. Checksummed — update the digest in
│   │                            fixture-guard.test.ts when one legitimately changes.
│   ├── setup/testing-library.ts jest-dom matchers + RTL cleanup (jsdom project only)
│   ├── integration/             155 tests. Testcontainers PG18. Own config.
│   │   ├── entry-points.test.ts THE anti-silent-coverage-gap test
│   │   ├── finance-imports.test.ts   staging, Tier 2, the commit-time race +
│   │   │                        override preservation, file-hash status — M5
│   │   ├── finance-classify.test.ts   merchant memory, counterpart matching in
│   │   │                        both import orders, the manual-decision guard — M6
│   │   ├── finance-review.test.ts   filters, the confirmed/needs_review rule, the
│   │   │                        counterpart unlink (both legs, both directions),
│   │   │                        remember-checkbox, bulk assignment — M7
│   │   └── finance-grid.test.ts   the base filter's exact exclusions, the year
│   │                        boundary, refund netting, and — the core M8 guarantee —
│   │                        drill-down sums proven bit-for-bit equal to the
│   │                        aggregate for 4 scopes (category/expenditure/income/year)
│   └── e2e/                     21 tests, SERIAL. Chrome virtual authenticator,
│                                real Radix overlays under the real CSP.
│                                import.spec.ts: golden path, re-upload idempotency,
│                                merchant-memory pre-fill (M6). review.spec.ts:
│                                resolve a needs_review row, correct a linked pair (M7).
│                                monthly.spec.ts: a grid cell's total matching its
│                                drill-down dialog exactly, the reconciliation banner (M8).
├── Dockerfile                   base / deps / prod-deps / builder / migrator / runner
├── compose.dev.yml              Postgres 18 + one-shot migrate
├── eslint.config.mjs  vitest.config.ts  vitest.integration.config.ts
├── playwright.config.ts  drizzle.config.ts
├── pnpm-workspace.yaml          NOT a monorepo. onlyBuiltDependencies AND
│                                ignoredBuiltDependencies both matter — see M2 notes.
└── .env.example                 placeholders only
```

### Commands

```bash
pnpm test              # 144 unit tests. No Docker. Run this constantly.
pnpm test:integration  # 64 tests against a real PG18 container.
pnpm test:e2e          # 4 Playwright journeys. Needs a dev server + the dev DB.
```

### Which document wins if they conflict

1. **`docs/IMPLEMENTATION_PLAN.md`** — the approved plan of record. Highest authority on *what* and
   *why*. Its "Changes in Revision N" tables are kept deliberately: each entry exists because an
   earlier draft was wrong in a way that would have cost data, money, or correctness.
2. **`CLAUDE.md`** — highest authority on *how to work in this repo day to day* (invariants, pins,
   gotchas). If it contradicts the plan on a mechanical detail, CLAUDE.md reflects verified reality.
3. **`docs/ROADMAP.md`** — authoritative on *current status* and what is next.
4. **This file** — a summary and entry point. If it conflicts with the four above, **they win** and
   this file should be corrected.
5. `ARCHITECTURE` / `SECURITY` / `FINANCE` / `DEPLOYMENT` / `BACKUP_RESTORE` — canonical detail for
   their own domains.

**The code is authoritative over all documentation.** If they disagree, one is a bug — resolve it,
don't let them drift.

---

## 11. Local development

Verified working on Windows 11 with Node v24.19.0, pnpm 11.22.0, Docker 29.7.2, Compose v5.3.1.

```bash
# 1. Install dependencies
pnpm install

# 2. Environment (placeholders only; .env is gitignored)
cp .env.example .env
#    For local dev the default DATABASE_URL in .env.example already matches
#    compose.dev.yml: postgres://burmy:burmy@localhost:5432/burmy

# 3. Start PostgreSQL 18
docker compose -f compose.dev.yml up -d postgres

# 4. Run migrations THROUGH THE CONTAINER (never host pnpm)
docker compose -f compose.dev.yml run --rm migrate

# 5. Optional: synthetic seed data (4 accounts, 11 categories, 0 transactions)
pnpm db:seed

# 6. Start the dev server
pnpm dev                      # http://localhost:3000
```

### Verification commands

```bash
pnpm typecheck                 # tsc --noEmit
pnpm lint                      # eslint .
pnpm test                      # vitest run
pnpm build                     # next build
pnpm test:e2e                  # playwright (no specs yet)
```

### Schema changes

```bash
pnpm db:generate                                      # drizzle-kit generate -> drizzle/
docker compose -f compose.dev.yml run --rm migrate    # apply
```

Cloudflare and Tailscale are **not** needed locally and are absent by design.

---

## 12. Milestone 9 — the exact next objective

**Goal:** the transactions table, the Excel-comparison reconciliation feature,
and export. M8 made `/finance/monthly` compute every total live; M9 is the
remaining pieces the owner's spreadsheet still does that the grid
deliberately doesn't — the grid's own drill-down is scoped to one cell and
capped at 500 rows by design, not a general browser.
**Depends on:** M8 (monthly grid). Complete.

### What M8 hands over

- **The base-filter pattern is proven and reusable.** `gridBaseConditions()`
  (`db/finance/grid.ts`) is the template for "one shared filter function used
  by every query that must agree with another" — M9's transactions table and
  its filters should follow the same shape rather than reintroducing a
  parallel `WHERE` clause.
- **`finance_expected_totals`** (built in M1, still unused) is exactly what
  M9's reconciliation feature reads from — see `docs/FINANCE.md`'s
  "Reconciliation" section for the design already written, and the "Monthly
  grid & drill-down (M8)" section for what the grid computes it should be
  compared against.
- **`TRANSACTION_TYPE_LABELS`** (`classify/manual.ts`, added in M8) already
  maps all 8 real `transaction_type` values to display labels for the grid's
  drill-down dialog — the transactions table needs the identical mapping, not
  a second one.

### Non-negotiable for this milestone

- **Never store a total.** Reconciliation compares a live-computed total
  against `finance_expected_totals`; it does not cache the computed side —
  CLAUDE.md invariant 1, unchanged since M1.
- **Every Server Action / page begins with `await requireOwner()`.**
  `tests/integration/entry-points.test.ts` enumerates the filesystem and fails
  the suite otherwise.
- **Export must be formula-injection-safe** — a cell value starting with
  `=`, `+`, `-`, or `@` opened in Excel/Sheets can execute as a formula.
  Already flagged in the plan; do not ship a naive CSV/XLSX writer.
- Money math goes through `src/server/finance/money.ts`. Nothing else does
  arithmetic on `Cents`.
- **ExcelJS dependency/security review gates any XLSX work** — do this first,
  before writing an XLSX export or reconciliation import path. Never
  `pnpm add xlsx` (the SheetJS package is abandoned with unfixed advisories —
  see `CLAUDE.md`).

### Also outstanding

**Manual real-device passkey verification**, carried from M2 through M8. The
automated ceremony passes against Chrome's virtual authenticator (real WebAuthn
with a software key store), but no physical authenticator has been used. Two
minutes: `pnpm dev`, sign in at `/sign-in` with a phone or Windows Hello, then
check Settings → Passkeys.

---

## 13. Remaining milestones

| # | Milestone | Essence |
| --- | --- | --- |
| ~~M2~~ | ~~Authentication & security baseline~~ | **Complete.** Access JWT verification, Better Auth passkeys, `requireOwner()`, bootstrap/recovery settled by prototype, CSP, audit events |
| ~~M3~~ | ~~App shell, accounts, categories~~ **Complete.** | `Finance` / `Settings` nav, `/` → `/finance/monthly`, shadcn/ui init, CRUD for accounts and categories (archive never delete) |
| ~~M4~~ | ~~Parsing & normalization core~~ **Complete.** | **Starts by reading one real redacted BoA export.** Header-signature detection, BoA deposit + card adapters, generic mapper, merchant normalization, dedupe. **Also verifies whether `source_transaction_id` earns a unique constraint.** |
| ~~M5~~ | ~~Import pipeline, preview, duplicates~~ **Complete.** | Single-file upload, in-memory staging, preview, count-based dedupe, atomic commit |
| ~~M6~~ | ~~Categorization & classification~~ **Complete.** | Merchant memory, transfer / card-payment counterpart matching with deterministic evidence only; investment auto-classification deferred |
| ~~M7~~ | ~~Review queue~~ **Complete.** | Filterable queue, category/type correction, the counterpart unlink, bulk assignment, opt-in "remember merchant" |
| ~~M8~~ | ~~Monthly grid & drill-down~~ **Complete.** | *The product.* SQL pivot in the owner's `sort_order`, Total Expenditure/Income/Gross Savings, cell drill-down sharing the aggregate's own filter, the unreconciled-transaction warning |
| **M9** | Transactions table, Excel reconciliation, export | TanStack Table + Virtual, **ExcelJS dependency/security review gate**, `finance_expected_totals`, reconciliation deltas, formula-injection-safe export |
| **M10** | Backup, deployment, hardening, launch | Harden the M1 image for production, Oracle/VPS + Cloudflare Tunnel + Access + Tailscale, backup automation and a **verified restore**, full DR drill — **then** the first real production import |

Production launch is deliberately **last**: real financial data does not touch production until
recovery has been proven.

---

## 14. Working agreement

- **One milestone at a time.** Stop at the end of each and wait for the owner's approval. Do not roll
  into the next.
- **Before starting:** state the milestone, its objective, and the changes you intend to make.
- **After completing:** report files changed, what was implemented, **tests actually run**, typecheck,
  lint, build, known issues, decisions made, and the next milestone.
- **Never claim a check passed unless it was actually executed** and you saw the output. If something
  fails, say so and show it.
- **Do not silently change approved architecture.**
- **If implementation proves an approved assumption wrong: stop, explain the evidence, and recommend a
  change before making a major architectural deviation.** This has already happened productively —
  the container build failing is what revealed that the migrator should be plain ESM.
- No speculative abstractions. If a future requirement demands one, refactor when it is real.

---

## 15. Inputs the owner will provide later

- **Do NOT block M1 or M2 on the historical finance archive.** The owner retains and backs up the
  original Bank of America CSVs and Excel files personally.
- **Historical CSVs will be uploaded through Burmy's normal importer once it exists** (M5) — the same
  code path as any monthly import, which is the cleaner outcome.
- **At M4, ask the owner for one representative real Bank of America checking CSV**, and a
  credit-card CSV if the layout differs, so the adapters are written against observed reality rather
  than third-party blog posts. *(BoA's exact column layout could not be verified from an authoritative
  primary source during planning — search results were dominated by statement-converter marketing
  pages. `docs/FINANCE.md` records what is known and what is not.)*
- **The historical Excel sheets are for reconciliation** (M9), not as a data source.

---

## Instructions for the next Claude Code session

**Read this file first.** Then read [`CLAUDE.md`](../CLAUDE.md), then
[`docs/IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md),
[`docs/ARCHITECTURE.md`](./ARCHITECTURE.md), [`docs/SECURITY.md`](./SECURITY.md) and
[`docs/FINANCE.md`](./FINANCE.md). Check [`docs/ROADMAP.md`](./ROADMAP.md) for current status.

**Then inspect reality before changing anything:**

```bash
git log --oneline -5
git status --short
node -v && pnpm -v && docker version --format '{{.Server.Version}}'
pnpm install
docker compose -f compose.dev.yml up -d postgres
docker compose -f compose.dev.yml run --rm --build migrate   # --build is NOT optional
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build
```

Confirm the working tree and toolchain match what §9 and §11 describe. If they do not, say so before
proceeding.

**Do not repeat product discovery.** The interview is done and the decisions in §3 are settled. **Do
not redesign approved architecture** unless implementation evidence requires it — and if it does,
stop, present the evidence, and recommend the change rather than making it unilaterally.

**The next unfinished milestone is M5 — Import pipeline, preview, duplicates** (§12). The parser it builds on was written against two real Bank of America exports; what those files actually contain, and where the plan guessed wrong, is recorded in `docs/FINANCE.md`.

Bootstrap and recovery are **no longer open questions** — M2 settled both by prototype, and
`docs/SECURITY.md` records the comparison and the evidence. Do not reopen that decision without new
evidence.

**Before beginning M5, summarize your understanding and your proposed work, and get the owner's
approval.** Then proceed one milestone at a time under the working agreement in §14.
