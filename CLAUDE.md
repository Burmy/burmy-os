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
7. **The only file Burmy ever touches is the one the owner picks in the browser upload control.**
   No watched folders, no directory scanning, no "import from path", no filesystem polling, no
   configured statement directory — not as a convenience, not as a dev shortcut, not behind a flag.
   The product workflow is manual and monthly: *select or drag a CSV → upload → parse → review →
   import*. Nothing about the app or the development workflow may depend on a local folder existing.
   *(Server-side scratch space for bytes the owner just uploaded is a different thing and is
   permitted — see §21 of the plan. Reading the owner's filesystem is not.)*
8. **Never commit real financial data or secrets.** `.gitignore` is deliberately broad. Parser
   fixtures under `tests/fixtures/finance/` are **redacted from real exports** (amended in M4 — the
   original rule said "synthetic only"); the raw files and the substitution mapping are never
   committed. See `docs/SECURITY.md` for what redaction must guarantee.

---

## Stack

| | |
| --- | --- |
| Framework | Next.js 16.3 (App Router), React 19, TypeScript strict |
| Runtime | Node 24 LTS, pnpm 11 (corepack, pinned in `packageManager`) |
| Database | PostgreSQL 18 + Drizzle ORM 0.45 |
| Auth | Cloudflare Access with Google is the **sole** authentication mechanism. No in-app auth library, no session of Burmy's own, no second factor. |
| UI | Tailwind, shadcn/ui, Lucide |
| Grids | Hand-rolled on the shadcn `Table` primitive, with a thin shared presentation layer in `src/components/finance/`. TanStack Table was originally approved but was never actually installed — the tables in this app are small (dozens of rows, no sort/virtualization need), so it was dropped from the plan during the M8-era UX pass rather than added just because it was once on the list. **Not AG Grid** — its row grouping and pivoting are Enterprise. |
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
  boundary. Unprotected endpoints are an explicit allowlist, exactly one entry: `/api/health`.
  `requireOwner()` verifies the Cloudflare Access JWT and RESOLVES the owner row by verified email —
  it never creates one. See "Owner provisioning" in `docs/SECURITY.md`.
- **The deploy script never restores the database automatically.** On healthcheck failure it rolls
  back the *image* only and leaves Postgres untouched. A failed healthcheck usually means a bad build,
  not bad data, and the database may hold newer writes.
- **BoA deposit exports validate themselves — never bypass that check.** The five-line preamble states
  beginning balance, total credits, total debits and ending balance, and the transaction rows reconcile
  to it TO THE CENT (verified against a real export). `assertDepositTotals` and
  `assertRunningBalances` make a dropped row, an inverted sign or a mis-split amount a loud failure
  instead of a quietly wrong total, on every real import. It is the strongest correctness signal in the
  project; do not downgrade it to a warning.
- **Never let Papa Parse use `header: true` on row one for a BoA deposit export.** Row one is
  `Description,,Summary Amt.` — the summary block, not the transactions. Every subsequent row would be
  keyed by the wrong names and parse as garbage that still looks structurally valid. The header is
  LOCATED by scanning for required columns (`src/server/finance/parse/csv.ts`).
- **Merchant normalization must UNDER-strip, never over-strip.** Stripping too little costs one extra
  review card; stripping too much MERGES TWO DIFFERENT MERCHANTS and moves money between two visible
  grid rows. Hence: the location rule removes the state plus at most ONE city token, and bare trailing
  store numbers are stripped only at 5+ digits (`VIA 313` is a restaurant). Both rules exist because
  an earlier, greedier version failed ten tests at once.
- **Python's text mode translates newlines.** `io.open(path, encoding='utf-8')` silently converts CRLF
  to LF, which made a CRLF fixture hash identically to its LF twin and the recorded checksums wrong.
  Use `newline=''` whenever hashing or comparing files.
- **Fixtures are checksummed.** If one legitimately changes, update its digest in
  `tests/unit/fixture-guard.test.ts` in the SAME commit. The guard exists because `tests/fixtures/` is
  the one directory where a real statement would be committed silently.
- **Drizzle WRAPS driver errors — check the `cause` chain, not `error.code`.** A Postgres
  `unique_violation` arrives as a Drizzle error carrying `query`/`params`, with the real SQLSTATE on
  `error.cause`. A naive `error.code === '23505'` compiles, reads correctly, and silently never
  matches — turning every duplicate-name into an unhandled 500 instead of a field error. Use
  `isUniqueViolation()` in `src/server/db/finance/errors.ts`, which walks the chain. Caught by
  integration tests, not review.
- **Radix needs the CSP nonce, and `style-src` must NOT be relaxed to give it one.** Radix overlays
  (dialog, select, dropdown) inject a real `<style>` element via `react-remove-scroll`, governed by
  `style-src-elem` → `style-src`, which is nonce-only. The fix is `setNonce()` from `get-nonce` in
  `src/features/shell/style-nonce.tsx`, fed the per-request nonce from the `x-nonce` header. Adding
  `'unsafe-inline'` to `style-src` would "fix" it by permitting *any* injected stylesheet — do not.
  Separately, Radix's inline `style="…"` *attributes* genuinely cannot carry a nonce, which is why
  `style-src-attr 'unsafe-inline'` exists as a narrow, documented exception (see `docs/SECURITY.md`).
- **Do not reintroduce `sonner`, and check any new dependency for runtime `<style>` injection.**
  Sonner calls an internal `__insertCSS()` at module evaluation, has zero nonce support and no opt-out,
  so it can never satisfy a nonce-only `style-src`. The in-house `src/components/ui/toast.tsx` replaces
  it. A future `npx shadcn add` that pulls the sonner template back in will also re-add `next-themes` —
  reject both.
- **Playwright runs SERIAL (`fullyParallel: false`, `workers: 1`) and must stay that way.** Every spec
  drives one dev server against one development database and truncates tables to get a known state.
  In parallel, one spec truncating `user` mid-test wipes another spec's owner row and it looks like a
  flaky, unexplained bounce to `/access-denied` rather than the isolation bug it is.
- **A new dependency with an install script breaks EVERY `pnpm <script>`, not just `pnpm install`.**
  pnpm runs a dependency-status check before each script, so an un-acknowledged
  `ERR_PNPM_IGNORED_BUILDS` takes out typecheck, lint, test and build at once — with a stack trace
  ending in `runDepsStatusCheck` that looks nothing like a dependency problem. Fix it in
  `pnpm-workspace.yaml` under **`allowBuilds`**, with an explicit `true`/`false` per package and a
  recorded reason. `ignoredBuiltDependencies` alone does **not** suppress it in pnpm 11.22 — verified
  twice. pnpm also re-injects a placeholder `allowBuilds:` stanza whenever a new such package appears;
  replace the placeholders with real booleans rather than deleting the block.
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
- **Postgres has no `MIN()`/`MAX()` aggregate for `uuid`.** Casting the aggregate's *result* to text
  (`min(id)::text`) still fails — the cast has to happen to the *column*, before aggregation
  (`min(id::text)`), or the query never compiles at all (`function min(uuid) does not exist`). Caught
  by the M5 integration suite the moment a real query ran against real Postgres.
- **A Server Action's own `revalidatePath()` can beat the client state it was supposed to reveal.**
  `commitImportAction` (M5) calls `revalidatePath()`, which re-renders the calling Server Component
  with fresh data — including a `status` prop that had just flipped to `'committed'`. A client
  component checking that prop before its own local "here's what just happened" state showed "already
  committed" instead of the completion summary it just received. If a component holds both a
  server-supplied status prop and a local result-of-my-own-action state, check the local state FIRST.
  Missed by manual testing, caught by the e2e suite.
- **An e2e assertion right after a mutation can pass on OPTIMISTIC state alone — it proves nothing
  about the server.** `useOptimistic` makes a button reflect a change before its Server Action has
  round-tripped, so `expect(...).toBeDisabled()` immediately after the click can be true well before
  the database write lands. `page.reload()` right after that assertion is a race: on a quiet dev
  server the write reliably wins by coincidence, but a heavier spec running immediately before (M5's
  `import.spec.ts`, ahead of `shell.spec.ts`'s categories-reorder test) added enough latency to flip
  it, and the reload fetched the PRE-mutation state. The fix is not a longer timeout or a retry — wait
  for the action's own network response (`page.waitForResponse`, listener attached BEFORE the
  triggering interaction) before trusting a reload to reflect it. Reproduced 3 times in a row before
  the fix, gone in 3 consecutive full-suite runs after.
- **An automated write that "only touches its own fields" can still silently strand a row.** M6's
  retroactive counterpart-match update correctly left `category_id`/`categorization_source` alone on
  the transaction it reclassified — but it ALSO left `review_status` alone, and a transaction with no
  category has `review_status = 'needs_review'` from M5 regardless of whether it now needs a category
  at all (an excluded transfer/card-payment doesn't). The fix is a SQL `CASE`, not a flat `set()`:
  `needs_review → auto`, but an existing `confirmed` is left exactly as it was. The general lesson —
  before shipping "this write only touches columns X and Y," check whether X/Y's CURRENT VALUE was
  computed under an assumption (here: "no category yet decided" was baked into `needs_review`) that
  the new write just falsified without updating the field that encoded it. Caught by an integration
  test asserting the FULL row shape after a retroactive update, not by reviewing the update's own diff.
- **`exactOptionalPropertyTypes` loses precision when SEVERAL conditional spreads are merged into one
  object literal.** The single-spread pattern (`...(cond ? { key } : {})`) documented above is fine on
  its own, but combining four of them into one literal (M7's review filters, built from four
  independently-optional URL params) made `tsc` infer `key: T | undefined` on the merged result anyway
  — even though each spread individually excludes `undefined` correctly. Verified as a real inference
  gap, not a one-off typo: swapping to a mutable local object built with plain `if (cond) obj.key = value`
  statements (a non-`readonly` shape, since the target interface's fields are `readonly`) resolved it
  immediately with no other change. Reach for that pattern directly once more than two or three optional
  fields are being assembled at once — don't spend time trying to coax the merged-spread form into
  typechecking.
- **React's `react-hooks/set-state-in-effect` lint rule fires on the "resync local state from a prop
  that can change underneath you" pattern** — e.g. a client component holding an editable local copy of
  server-fetched rows, where a filter change or `router.refresh()` delivers a NEW array reference as
  props and the local copy needs to follow it. `useEffect(() => setRows(transactions), [transactions])`
  is exactly what the rule exists to catch (cascading renders). The fix is React's own documented
  pattern for this — compare the incoming prop against a tracked "last synced from" value DURING RENDER
  (not in an effect) and call `setState` directly in that branch: `if (transactions !== syncedFrom) {
  setSyncedFrom(transactions); setRows(transactions); }`. This is a conditional `setState` call in the
  component body, which React explicitly permits (it bails out of the in-progress render and restarts)
  — the rule only objects to the SAME thing happening inside `useEffect`.
- **Negative zero recurs whenever money math happens outside `Cents`.** `src/server/finance/grid.ts`
  (M8) deliberately works in plain `number` — it combines already-SQL-summed groups, not raw
  transaction amounts, so routing it through the branded `Cents` type would misrepresent what kind of
  arithmetic it does. `const incomeCents = -incomeCentsRaw` produces `-0` via unary negation whenever a
  month has zero income, the exact class of bug `money.ts` normalizes for at M1 (`wrap()` after every
  operation). A plain-number module gets none of that protection for free. Caught by a unit test
  (`expected -0 to be +0`), not by typecheck or lint — `-0 === 0` is `true`, so only `Object.is` or a
  test asserting the exact serialized/rendered value catches it. Fix at the source with an explicit
  `value === 0 ? 0 : -value` normalization; do not assume `Cents`-free code is exempt from this class of
  bug just because `money.ts` already solved it once.

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
