# CLAUDE.md — Burmy

Private, single-user personal web application. Deployed to `app.burmy.me`. The public portfolio at
`burmy.me` is a **separate** project and is not in this repository.

**Finance is the only product module.** "OS" is a metaphor for a personal workspace — this is not an
operating system and not a platform. Do not build Notes, Files, Sheets, Inbox, Bookmarks, Garage,
Receipts or Subscriptions. Do not build abstractions in anticipation of them.

The full approved plan is `docs/IMPLEMENTATION_PLAN.md`. Read it before making architectural changes.

---

## Non-negotiable invariants

Violating any of these is a correctness or security bug, not a style preference.

1. **Transactions are the only source of truth.** Every reported number — monthly total, category
   total, average, net — is computed by SQL at read time. **Never store a total.** The monthly grid
   is a view.
2. **Money is a signed `BIGINT` of cents. Positive = outflow.** Never floats. Never `NUMERIC` (the
   `pg` driver returns it as a string, and the resulting `parseFloat` is the exact bug we are
   avoiding). All arithmetic goes through `src/server/finance/money.ts`. Nothing else does money math.
3. **No bank connections. Ever.** No Plaid, no bank APIs, no OAuth to a financial institution, no
   scraping, no stored bank credentials. Files in, insights out.
4. **No LLM ever performs arithmetic.** SUM, AVERAGE, and all totals are Postgres's job, permanently.
   AI is optional, off by default, and the app must pass its full test suite with no API key present.
5. **Exclusionary transaction types require deterministic evidence.** `transfer`,
   `credit_card_payment` and `investment` remove money from spending totals *invisibly*. They may only
   be assigned via an explicit user rule, a qualified counterpart match, or explicit review
   confirmation — **never** a graded heuristic. A suspicion produces a review item, not an exclusion.
6. **Raw uploaded statements are deleted immediately after parsing**, including on the failure path.
   Never write an upload to `public/` or any statically served path.
7. **Never commit real financial data or secrets.** `.gitignore` is deliberately broad. Test fixtures
   are synthetic only.

---

## Stack

| | |
| --- | --- |
| Framework | Next.js 16.3 (App Router), React 19, TypeScript strict |
| Runtime | Node 24 LTS, pnpm 11 (corepack, pinned in `packageManager`) |
| Database | PostgreSQL 18 + Drizzle ORM 0.45 |
| Auth | Better Auth — **passkey plugin only**. Google is configured *once*, in Cloudflare Access. |
| UI | Tailwind, shadcn/ui, Lucide |
| Grids | TanStack Table + Virtual. **Not AG Grid** — its row grouping and pivoting are Enterprise. |
| Parsing | Papa Parse (CSV), ExcelJS (XLSX, provisional) |
| Testing | Vitest + React Testing Library, Playwright |
| Infra | Docker Compose, Cloudflare Tunnel + Access, Tailscale, restic → Backblaze B2 |

---

## Commands

```bash
pnpm dev                              # dev server
pnpm typecheck && pnpm lint           # must both pass before any milestone closes
pnpm test                             # Vitest
pnpm test:e2e                         # Playwright
pnpm build                            # production build

docker compose up -d postgres         # local database
docker compose run --rm migrate       # migrations run IN the image, never host pnpm
pnpm db:seed                          # synthetic fixtures
```

---

## Deliberate version pins — do NOT bump without checking

Both of these are held BELOW latest on purpose. `pnpm update` will happily break them.

| Package | Pinned | Latest | Why |
| --- | --- | --- | --- |
| `typescript` | **6.x** | 7.x | **typescript-eslint does not support TS 7.0.** With TS 7 installed, `pnpm lint` cannot even load — it throws before linting a single file. Tracking: typescript-eslint#10940. `tsc` itself works fine on 7; the linter is the blocker. |
| `eslint` + `@eslint/js` | **9.x** | 10.x | The Next 16 lint stack targets ESLint 9. On ESLint 10, `eslint-plugin-react` 7.37.5 (via `eslint-config-next`) throws `contextOrFilename.getFilename is not a function`, and typescript-eslint 8 throws `scopeManager.addGlobals is not a function`. |

`eslint.config.mjs` also pins `settings.react.version` explicitly — that skips
`eslint-plugin-react`'s version auto-detection, which is where its ESLint-10 crash originates.
Harmless on ESLint 9, and it means the config survives the eventual upgrade.

## Gotchas that have already cost us

These are verified, not folklore. Do not "fix" them back.

- **`src/proxy.ts`, not `src/app/proxy.ts`.** Next.js 16 renamed `middleware` to `proxy`; the file
  must sit level with `app/`, not inside it.
- **Postgres 18 changed its Docker volume layout.** `PGDATA` is `/var/lib/postgresql/18/docker` and
  the declared `VOLUME` is `/var/lib/postgresql`. Mounting the pre-18 `/var/lib/postgresql/data`
  **starts cleanly, reports healthy, and silently loses the data** on recreate.
- **`cloudflared` must NOT be on an `internal: true` network.** It dials out to Cloudflare. Two
  networks: `edge` (external, for `cloudflared` + `web`) and `dbnet` (`internal: true`, for `web` +
  `migrate` + `postgres`).
- **Never `pnpm add xlsx`.** The npm SheetJS package is abandoned at 0.18.5 with unfixed prototype
  pollution and ReDoS advisories. Use ExcelJS.
- **`dedupe_key` and `merchant_key` are different things and must stay that way.** `dedupe_key` is
  immutable identity from the *raw* description under a frozen versioned algorithm, computed once and
  persisted. `merchant_key` is expected to evolve. Deriving identity from `merchant_key` would mean
  one new normalization rule silently breaks duplicate matching against all existing history.
- **Every protected server entry point calls `await requireOwner()` itself** — Server Actions and
  Route Handlers alike. Next.js documents that Server Functions are POSTs to their host route, so a
  `matcher` change can silently drop proxy coverage. `src/proxy.ts` is defense-in-depth, not the
  boundary. Unprotected endpoints are an explicit allowlist: `/api/health`, `/api/auth/*`.
- **The deploy script never restores the database automatically.** On healthcheck failure it rolls
  back the *image* only and leaves Postgres untouched. A failed healthcheck usually means a bad build,
  not bad data, and the database may hold newer writes.
- **Never `export NODE_ENV=development` before `pnpm build`.** Sourcing `.env` into the shell
  (`set -a; . ./.env`) does exactly that, and `next build` then resolves the *development* React
  build during prerender and dies with `TypeError: Cannot read properties of null (reading
  'useContext')` on `/_global-error`. The error names a page you never wrote, so it reads like a
  framework bug. Next reads `.env` itself — do not pre-export it. (Exporting it is fine for
  `pnpm test:e2e`, which needs `DATABASE_URL` and `OWNER_EMAIL` at runtime.)
- **A nonce can never satisfy `style-src-attr`, but that is NOT why a strict CSP reports style
  violations here.** Under a nonce-only `style-src`, `/sign-in` reports ~33 `style-src-elem`
  violations in **development only** — every one sourced from `_next/static/chunks/…next-devtools…`,
  the dev overlay, which is absent from a production build. Do **not** add `'unsafe-inline'` or a
  `style-src-attr` exception for it; the policy is correct and application code produces zero
  violations. Diagnose CSP problems by capturing `securitypolicyviolation` DOM events
  (`effectiveDirective` + `sourceFile`), not by reading console text — the console message names the
  fallback directive and sends you after the wrong cause.
- **Adding a migration requires rebuilding the migrator image — `--build` is not optional.** The
  Dockerfile copies `drizzle/` *into* the image, so `docker compose run --rm migrate` against a stale
  image prints **"Migrations complete." and applies nothing**. It is a silent no-op: exit 0, reassuring
  output, schema unchanged. Always
  `docker compose -f compose.dev.yml run --rm --build migrate` after `pnpm db:generate`, and verify by
  counting tables rather than trusting the message. This cost real time during M2.
- **`scripts/migrate.mjs` is plain ESM on purpose — do not convert it to TypeScript.** Applying
  migrations only needs to execute the generated SQL, so writing it in TS would drag
  tsx → esbuild → a platform-native binary into an image whose whole job is running a few
  `CREATE TABLE`s. As `.mjs` it needs only production dependencies, letting the migrator image build
  with `--prod --ignore-scripts`.
- **Docker builds use `pnpm install --ignore-scripts`.** pnpm blocks dependency install scripts by
  default; rather than granting arbitrary code execution at build time, we decline them explicitly.
  Neither `next build` nor the migrator needs a native postinstall. If a dependency ever genuinely
  does, that is a decision to revisit in the Dockerfile — not a default to inherit.
- **Never write JSON config with PowerShell `Set-Content -Encoding utf8`** — it emits a UTF-8 BOM, and
  `pnpm` inside the container fails with `Invalid package.json`. Use
  `[System.IO.File]::WriteAllText(path, text, [System.Text.UTF8Encoding]::new($false))`.
- **`exactOptionalPropertyTypes` is on.** Assigning `undefined` to an optional property is an error;
  omit the key instead (`...(cond ? { key: value } : {})`). This caught a real issue in
  `playwright.config.ts` and it stays on.

---

## Layout

```
src/proxy.ts              Access JWT verification, security headers, CSP nonce
src/app/                  routes; / redirects to /finance/monthly (the landing view)
src/features/finance/     Finance UI
src/server/finance/       DOMAIN CORE — pure TS, no React, no Next, no HTTP
src/server/{auth,db,security}/
drizzle/                  migrations (committed)
tests/fixtures/           SYNTHETIC statements only
scripts/                  provision, deploy, backup, restore, verify-restore
docs/                     the approved plan and supporting documents
```

**`src/server/finance/` must stay framework-free.** Money math, merchant normalization, deduplication,
categorization and classification are all testable without a browser or a server. That is what makes
financial correctness verifiable — protect this boundary.

---

## Working agreement

- **One milestone at a time.** Stop and report at the end of each; do not roll into the next.
- **Never claim a test, typecheck, lint or build passed without running it** and seeing the output.
  If something fails, say so and show it.
- Report honestly: what was implemented, files changed, what ran, known issues, next milestone.
- No speculative abstractions. If a future requirement demands one, refactor when it is real.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
