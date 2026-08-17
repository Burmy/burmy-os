# Burmy — Session Handoff

**Read this file first.** It is written for a Claude Code session with **zero prior conversation
context**. It assumes you have the repository and nothing else.

Last updated: end of **Milestone 2**. Next milestone: **M3 — App shell, accounts, categories**.

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
| **Income** | Tracked, with its own monthly grid section. |
| **Investments** | Tracked. Appear in the grid (e.g. a `Stocks` row) and in Total Outflow, but **not** in Expenses. |
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

| Type | In grid? | In Expenses? | In Total Outflow? |
| --- | --- | --- | --- |
| `expense`, `fee`, `adjustment` | Yes (Spending) | Yes | Yes |
| `refund` | Yes (Spending) — negative, reduces its category | Yes, net | Yes, net |
| `investment` | Yes (Spending, e.g. `Stocks`) | **No** | **Yes** |
| `income` | Yes (**Income section**) | No | No |
| `transfer` | **No** | No | No |
| `credit_card_payment` | **No** | No | No |

**Credit-card payments must not double-count.** Card purchases ($20 + $100 + $80) are `expense`. The
checking-side $200 payment is `credit_card_payment`. The card-side "PAYMENT THANK YOU" credit is
*also* `credit_card_payment`. Both payment legs are excluded everywhere, so the total stays **$200** —
not $400, not $0.

**Refunds are not income.** A refund carries the *same category* as the purchase and nets it down.

**Income display.** Income is *stored* negative (money arriving, per the outflow-positive convention)
but the Income section **flips the sign for display only** — a paycheck must read `$6,400`, not
`-$6,400`. The stored value is never touched.

**`Net` = Total Income − Total Outflow.** The only row that mixes the two sections.

**The exclusion of `transfer` and `credit_card_payment` lives in exactly one SQL `IN` clause.** That
single clause is the entire double-counting guarantee, and it is covered by tests.

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

## 9. Current status — Milestones 1 and 2 COMPLETE

**M2 added authentication.** Full detail, including every trap hit along the way, is in
[`docs/ROADMAP.md`](./ROADMAP.md). The short version:

| | |
| --- | --- |
| Auth | Cloudflare Access JWT (factor 1) + Better Auth passkeys (factor 2), both enforced inside `requireOwner()` |
| Bootstrap & recovery | One single-use 10-minute grant, minted only by `scripts/auth-grant.mjs` over SSH/Tailscale. Prototyped both candidates, chose, deleted the loser. |
| Gates | Two passkeys before onboarding completes; last passkey undeletable; re-auth for passkey removal |
| Schema | **19 tables**, 2 migrations. `session` / `account` / `verification` / `passkey` / `rate_limit` added; M1's `user` table reconciled, not duplicated |
| Suites | `pnpm test` **144** unit (Docker-free, ~0.5s) · `pnpm test:integration` **64** (Testcontainers) · `pnpm test:e2e` **4** (Playwright virtual authenticator) |
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
│   └── 0001_nappy_ultron.sql          + 5 auth tables — M2, purely additive
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
│   │   ├── (private)/finance/monthly/page.tsx   placeholder until M8
│   │   ├── api/health/route.ts  UNAUTHENTICATED; booleans + version ONLY
│   │   ├── api/auth/[...all]/   UNAUTHENTICATED by design; getAuth() per request
│   │   ├── layout.tsx  globals.css
│   ├── features/auth/           sign-in, enrolment, grant redemption (client)
│   ├── lib/auth-client.ts       Better Auth browser client, passkey plugin only
│   ├── server/
│   │   ├── auth/
│   │   │   ├── access.ts        FACTOR 1 — Cloudflare Access JWT, fail-closed
│   │   │   ├── index.ts         FACTOR 2 — Better Auth. Lazily constructed.
│   │   │   ├── owner.ts         requireOwner() — THE boundary
│   │   │   ├── grants.ts        single-use token format (hashed at rest)
│   │   │   ├── grant-plugin.ts  POST /api/auth/burmy/redeem-grant
│   │   │   └── passkey-policy.ts  re-auth + last-passkey rule + audit
│   │   ├── security/{csp,audit}.ts
│   │   ├── db/{index,schema,seed}.ts
│   │   └── finance/money.ts     THE DOMAIN CORE — framework-free
├── tests/
│   ├── unit/                    144 tests. NO Docker, NO database, ~0.5s.
│   ├── integration/             64 tests. Testcontainers PG18. Own config.
│   │   └── entry-points.test.ts THE anti-silent-coverage-gap test
│   └── e2e/passkey.spec.ts      4 tests. Chrome virtual authenticator.
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

## 12. Milestone 3 — the exact next objective

**Goal:** the owner's taxonomy exists and the app is navigable.
**Depends on:** M2 (complete).

### Work

1. `(private)` layout with `Finance` / `Settings` nav; responsive; theme; error and loading states.
2. **Initialize shadcn/ui + Lucide** — approved in the plan, installed in neither M1 nor M2.
3. CRUD for `finance_accounts` (checking, savings, credit card, brokerage). `last_four` is optional and
   is the only account-number fragment ever stored.
4. CRUD + archive + reorder for `finance_categories`, with `kind` (spending | income | investment).
   **Archive, never delete** — history must stay intact.
5. Wire `@testing-library/jest-dom` to a Vitest setup file; the first component tests land here.
6. Do the outstanding **manual real-device passkey check** (see §9 / ROADMAP "known gaps").

### Non-negotiable, inherited from M2

- **Every Server Action starts with `await requireOwner()`.**
  `tests/integration/entry-points.test.ts` enumerates `src/app/**/route.ts` and every `'use server'`
  file from the filesystem, and fails the suite if one is neither guarded nor on the two-item
  allowlist. That test has been validated by deliberately adding an unguarded route and watching it
  fail. It is doing its job, not being awkward.
- **Pages under `(private)` should also call `requireOwner()` directly**, because from M3 they need the
  returned owner id to scope their queries. The layout guard exists for navigation, not for data.
- **Sensitive actions use `requireOwner({ fresh: true })`** — bulk delete, full export, changing
  `OWNER_EMAIL`. Freshness is 15 minutes from session creation, and a rolling refresh does not reset
  it, so it genuinely means "authenticated recently".
- **Every Finance query goes through a data-access layer that takes an owner id** and injects the
  `WHERE` clause. Routes and actions never build queries directly.

### Tests required

- Archiving a category preserves history and frees the name for reuse.
- Duplicate category names are rejected case-insensitively among live rows only.
- Accounts and categories are owner-scoped.
- The new Server Actions reject unauthenticated invocation (the enumeration test does this
  automatically once they exist).

### Definition of Done

- The owner's real category list can be entered.
- The shell works on desktop and mobile.
- `pnpm typecheck` / `lint` / `test` / `test:integration` / `build` all green — **actually run**.

---

## 13. Remaining milestones

| # | Milestone | Essence |
| --- | --- | --- |
| **M2** | Authentication & security baseline | Access JWT verification, Better Auth passkeys, `requireOwner()`, bootstrap/recovery prototype, CSP, audit events |
| **M3** | App shell, accounts, categories | `Finance` / `Settings` nav, `/` → `/finance/monthly`, shadcn/ui init, CRUD for accounts and categories (archive never delete) |
| **M4** | Parsing & normalization core *(no UI)* | **Starts by reading one real redacted BoA export.** Header-signature detection, BoA deposit + card adapters, generic mapper, merchant normalization, dedupe. **Also verifies whether `source_transaction_id` earns a unique constraint.** |
| **M5** | Import pipeline, preview, duplicates | Multi-file batch upload, sanitized staging, 60-day expiry, preview, count-based dedupe, atomic commit |
| **M6** | Categorization & classification | Rules, merchant memory, history, source-category mapping; transfer / card-payment / investment detection with deterministic evidence only |
| **M7** | Review queue | Keyboard-first, bulk actions, merchant grouping, "remember merchant", separate duplicate and transfer passes |
| **M8** | **Monthly grid & drill-down** | *The product.* SQL pivot, Spending + Income sections, subtotals and Net, cell drill-down replacing Excel comments |
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
docker compose -f compose.dev.yml run --rm migrate
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Confirm the working tree and toolchain match what §9 and §11 describe. If they do not, say so before
proceeding.

**Do not repeat product discovery.** The interview is done and the decisions in §3 are settled. **Do
not redesign approved architecture** unless implementation evidence requires it — and if it does,
stop, present the evidence, and recommend the change rather than making it unilaterally.

**The next unfinished milestone is M2 — Authentication** (§12). Note especially that bootstrap and
recovery are *intentionally* unresolved and must be settled by a working prototype, not an assumption.

**Before beginning M2, summarize your understanding and your proposed work, and get the owner's
approval.** Then proceed one milestone at a time under the working agreement in §14.
