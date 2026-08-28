# CLAUDE.md — Burmy

Private, single-user personal web application. Deployed to `app.burmy.me`. The public portfolio at
`burmy.me` is a **separate** project and is not in this repository.

**Two product modules: Finance and Games.** "OS" is a metaphor for a personal workspace — this is
not an operating system and not a platform. Do not build Notes, Files, Sheets, Inbox, Bookmarks,
Garage, Receipts or Subscriptions. Do not build abstractions in anticipation of them, and do not
build a shared "module framework" for the two that exist — they deliberately share nothing but
generic UI primitives and the owner auth boundary.

`docs/FINANCE.md` is the canonical Finance-domain reference (money model, categorization, dedup,
reconciliation); `docs/GAMES.md` is canonical for the Games domain. `docs/ARCHITECTURE.md`,
`docs/SECURITY.md`, `docs/DEPLOYMENT.md` and `docs/BACKUP_RESTORE.md` are canonical for their own
areas. `docs/ROADMAP.md` is authoritative on current milestone status. If any of these disagree with
the code, the code is authoritative — that's a bug to resolve, not a discrepancy to document around.

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
| Database | PostgreSQL + Drizzle ORM 0.45. **Local dev and CI pin `postgres:18-alpine`; production (Supabase) runs 17.x** — Supabase picks its own version, so every migration is written and tested one major ahead of where it lands. Nothing in the schema depends on the difference today; see `docs/DEPLOYMENT.md`. |
| Auth | Cloudflare Access with Google is the **sole** authentication mechanism. No in-app auth library, no session of Burmy's own, no second factor. |
| UI | Tailwind, shadcn/ui, Lucide |
| Grids | Hand-rolled on the shadcn `Table` primitive, with a thin shared presentation layer in `src/components/finance/`. TanStack Table was originally approved but was never actually installed — the tables in this app are small (dozens of rows, no sort/virtualization need), so it was dropped from the plan during the M8-era UX pass rather than added just because it was once on the list. **Not AG Grid** — its row grouping and pivoting are Enterprise. |
| Parsing | Papa Parse (CSV). XLSX import was planned but never built — there is no ExcelJS dependency and no XLSX adapter; don't assume one exists. |
| Testing | Vitest + React Testing Library, Playwright, Testcontainers (integration tests only — see Commands) |
| Infra | **Production:** Netlify (hosting) + Supabase (managed Postgres) + Cloudflare (DNS; proxied for `app.burmy.me` only, DNS-only for `burmy.me`/`www.burmy.me`). Auth stays Cloudflare Access, unchanged — see `docs/DEPLOYMENT.md`, "Authentication." **Local dev:** Docker Compose (`compose.dev.yml`) runs one `postgres` service — the entire remaining Docker surface in the repo. Migrations run as a plain host script (`pnpm db:migrate`), identical to what CI and production both do; there is no Dockerfile and no migrator image. The earlier self-hosted VPS/Cloudflare Tunnel/restic→B2 path was removed (2026-08-18) once Netlify + Supabase proved viable; it is fully recoverable from git history if self-hosting is ever revisited, but nothing in the working tree depends on it. |

---

## Commands

```bash
pnpm dev                              # dev server
pnpm typecheck && pnpm lint           # must both pass before any milestone closes
pnpm test                             # Vitest
pnpm test:e2e                         # Playwright
pnpm build                            # production build

docker compose -f compose.dev.yml up -d postgres  # local database
pnpm db:migrate                       # apply migrations — same script CI and production both run
pnpm db:seed                          # synthetic fixtures — refuses to run off localhost
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
- **`scripts/migrate.mjs` is plain ESM on purpose — do not convert it to TypeScript.** Applying
  migrations only needs to execute the generated SQL, so writing it in TS would drag
  tsx → esbuild → a platform-native binary into a script whose whole job is running a few
  `CREATE TABLE`s. As `.mjs` it needs only production dependencies and runs identically on the host,
  in CI, and in production — `node scripts/migrate.mjs` (or `pnpm db:migrate` locally), no build step.
- **Never write JSON config with PowerShell `Set-Content -Encoding utf8`** — it emits a UTF-8 BOM, and
  `pnpm` then fails to parse it with `Invalid package.json`. Use
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
- **`tests/integration/entry-points.test.ts`'s direct-invocation check needs a `try/catch`, not a bare
  call, for any protected Route Handler.** It proves a Route Handler still refuses when the proxy is
  bypassed by importing the module and calling the exported `GET`/`POST` directly — no Next.js server
  around it. `requireOwner()` reads `next/headers`, which needs Next's own request-scoped storage,
  present for every request Next actually serves but **absent** when a plain `import()` calls the
  function directly, so the bare call throws `"headers was called outside a request scope"` before ever
  reaching `toAuthErrorResponse()`. Through M8 this was never actually exercised —
  `protectedHandlers.length` was asserted to be `0`, meaning no protected Route Handler existed yet.
  `/finance/transactions/export` (M9) is the first one. Fixed by accepting that specific thrown error as
  equally valid proof of refusal (the handler still never reached a 200 with data — a
  testing-environment limitation, not a security gap) and updating the expected count. If you add
  another protected Route Handler and this test starts throwing instead of asserting a status code, this
  is why — it is not a new security hole.
- **A credit-card-payment/transfer PAIR is two rows for one real movement of money, and there is no
  cheap way to turn "two rows" back into "one dollar figure."** The checking-side payment (outflow,
  positive) and the card-side "payment thank you" credit (inflow, negative) are the SAME $200 moving
  once — a plain `SUM()` across both legs cancels to $0 (hides real excluded spending); `SUM(ABS(...))`
  avoids the cancellation but then DOUBLE-COUNTS the pair (a real $675 payment reads as $1,350).
  M9's first draft of the Transactions reconciliation strip shipped the `ABS` version, then the owner
  caught the double-counting after accepting the milestone and asked for a narrow fix. `getLedgerSummary()`
  (`db/finance/transactions.ts`) now reports `excludedCount` — a plain row count — with **no paired dollar
  amount at all**, by explicit decision: netting the pair back to the true $675 would mean matching legs,
  which is real reconciliation logic this page deliberately does not build. If a future feature genuinely
  needs a dollar figure for `transaction_type IN ('transfer', 'credit_card_payment')`, that is pair-matching
  work, not a `SUM`/`ABS` choice — do not reach for either as a shortcut.
- **`formatInflow()` expects a still-negative, RAW stored value — calling it on a figure that is
  already sign-flipped double-flips it back negative.** `getMonthlyTotalsAllTime()` (M11) sign-flips
  income to a positive display figure at the DB boundary itself, exactly like M8's `GridRowTotals
  .incomeCents` already does (both are documented "never re-negate this"). The Finance dashboard's
  Income stat card first wrote `formatInflow(cents(summary.incomeCents))` anyway and rendered
  `-$6,400.00` for a real paycheck. The fix is the same one `MonthlyGridTable`'s own local `money()`
  helper already uses for exactly this reason: plain `format(cents(value), { signed: true })` on an
  already-flipped aggregate. `formatInflow` is only correct on a raw, still-negative stored value —
  a single transaction row, not a pre-summed monthly/YTD total. Caught only by seeding synthetic data
  and looking at the running dev server, not by typecheck, lint, or any test — the types don't
  distinguish "raw" `Cents` from "already display-flipped" `Cents`, so nothing catches this statically.
- **A flex item's default `min-width` is `auto`, not `0` — a wide descendant several levels down can
  force the ENTIRE flex chain wider than the viewport even though it sits inside its own
  `overflow-x-auto` container.** `src/app/(private)/layout.tsx`'s sidebar/content flex chain had no
  `min-w-0` anywhere, so the M8 monthly grid table (which the M11 dashboard now sits above, with more
  categories visible than before) pushed `<body>` to 979px on a 390px mobile viewport instead of
  scrolling inside its own `Table` primitive's `overflow-x-auto` wrapper — confirmed via
  `document.body.scrollWidth` in a real headless-browser check, not by reading the JSX. Fixing `<main>`
  alone was not sufficient; the intermediate `flex-col` wrapper between `<main>` and the outer sidebar
  row needed `min-w-0` too — every flex boundary in the chain defaults to `min-width: auto`
  independently, so each one needs the override, not just the one closest to the wide content.
- **`pnpm db:seed` was once run against the real Supabase database by accident**, right after
  legitimately running `db:migrate`/`db:provision-owner` against it in the same shell — an easy
  mistake once `DATABASE_URL` is already pointed at production for those two commands. Fixed by
  `src/server/db/seed-guard.ts`: `db:seed` now refuses to run unless `DATABASE_URL`'s host is
  `localhost`/`127.0.0.1`/`::1`. Deliberately NOT a `NODE_ENV` check — an ad-hoc operator shell running
  production commands often has no `NODE_ENV` set at all, so a `NODE_ENV !== 'production'` gate would
  have silently passed in exactly the scenario that caused the original mistake.
- **Games stores play time as TENTHS OF AN HOUR in an integer, never a float.** The source
  spreadsheet holds values like `0.7` and `532.8`; summing those as JS numbers reintroduces
  `0.1 + 0.2 !== 0.3` in a module whose headline stat is a lifetime hours total. All conversion
  happens in `src/server/games/hours.ts` and nothing else does hours math — the same containment
  rule `money.ts` has.
- **`IGDB_CLIENT_ID`/`IGDB_CLIENT_SECRET` are optional and their absence is a normal state, not an
  error.** Cover-art lookup fails soft and returns `[]` on missing credentials, a Twitch token-fetch
  failure, a timeout, a non-200, or malformed JSON — a 401 from IGDB refreshes the token and retries
  the request exactly once, never in a loop. The full test suite must pass with neither var present,
  exactly like the AI-optional rule for Finance. IGDB replaced RAWG (2026-08-20): RAWG has no portrait
  cover art anywhere in its data model and its search response silently omits `developers`/
  `publishers`; see `docs/GAMES.md`, "Cover art — IGDB, and its soft-failure contract."
- **`STEAM_API_KEY`/`STEAM_ID` are optional too, same contract as IGDB's pair above.**
  `src/server/db/games/steam-client.ts` fails soft (`[]`/`null`, never a throw) on missing
  credentials, a network error, a timeout, a non-200, or malformed JSON, and the full test suite must
  pass with neither present. `scripts/sync-steam-library.mjs` (2026-08-23) exits early with an error
  if either is unset, since there's nothing useful it can do without them — see `docs/GAMES.md`,
  "Steam library sync." The in-app sync (2026-08-24, `src/features/games/sync/`) consumes the same
  pair through a real app request path, and degrades instead of exiting: `isSteamConfiguredAction`
  checks the environment directly (never inferred from a fetch result — see its own doc comment) so
  the Library screen's Sync button renders disabled with a visible explanation naming both vars,
  never hidden and never thrown. See `docs/GAMES.md`, "In-app Steam sync."
- **The in-app Steam sync and `scripts/sync-steam-library.mjs` deliberately follow OPPOSITE rules,
  and unifying them is a bug.** The script fills only columns that are currently `NULL`
  (`steamSyncFieldsToFill`) because its contract is "never overwrite what the owner typed." The
  in-app sync makes Steam authoritative for a linked game's hours and achievement counts and proposes
  an update whenever they differ, which is why those fields render read-only in the editor. Both are
  correct for their own caller. `sync-plan.ts` exists as a separate module precisely because
  `steam.ts` must stay a dependency-free leaf for the script to `node`-import it.
- **`games.hours_tenths` is the authoritative total; `game_play_years` only says WHICH YEARS it
  happened in.** Neither Steam nor PSN can supply a per-year breakdown (Steam gives
  `playtime_forever` and `playtime_2weeks`; PSN gives one cumulative `playDuration`), so the total
  has to stay a single number an API can write while the split stays owner-entered. Do not
  "normalize" this by deriving the total from the rows — a sync would then have nowhere to write,
  and 157 of 160 games have no rows at all. See `docs/GAMES.md`, "Play-year attribution."
- **`titleId` and `npCommunicationId` are different PSN identifier spaces and must never be
  conflated.** `titleId` (`CUSA…`) identifies played-game data (`getUserPlayedGames`);
  `npCommunicationId` (`NPWR…`) identifies trophy data (`getUserTitles`) — there is no field in
  either PSN response that maps one to the other. `psn-actions.ts` joins them only by NAME, via the
  same `bestTitleMatchAmong`/`SIMILARITY_FLOOR` matcher IGDB and Steam matching already use, which is
  exactly why `games` has two separate nullable columns (`psn_title_id`, `psn_np_communication_id`)
  instead of one: a game can resolve one without the other. A title with no confident trophy-name
  match gets play data and NO trophy fields proposed at all — never a zero. See `docs/GAMES.md`,
  "PlayStation sync."
- **Collections: anything that COUNTS games excludes collection rows; anything that SUMS hours, money
  or trophies includes everything.** A boxed set is one `games` row wrapping several titles via a
  nullable self-FK (`games.collection_id`), so counting it alongside its own three titles reports four
  games where there are three. The sums need no rule at all — a title inside a collection carries NULL
  hours, NULL price and `platinum = false`, so every existing `SUM` already excludes it for free. The
  rule lives in `src/server/games/collections.ts` and nowhere else. Both sync engines are blind to
  members (`NOT_A_COLLECTION_MEMBER`): without that, a Steam/PSN exact-title match would write hours
  onto a member that the collection already accounts for. See `docs/GAMES.md`, "Collections."
- **A RUNTIME import from a `server/db/**` module into a client component drags `postgres` into the
  browser bundle and fails the build with `Can't resolve 'fs'`.** `import type` from the same module is
  fine — types are erased — which is why `transactions-table.tsx` has always imported `LedgerPage`,
  `LedgerFilters` and friends from `@/server/db/finance/transactions` without trouble. Importing the
  VALUE `LEDGER_PAGE_SIZE` from it pulled the whole DAL in. The failure names `postgres/src/index.js`
  and `fs`, not your import, so it reads like a dependency problem; the import trace underneath it is
  the part that identifies the real cause. This is why the page size was a hardcoded literal `100` in
  that component in the first place — a shared constant is the obvious-looking fix and is the one that
  breaks. Compute the derived number on the server and pass it down as a prop instead. A constant BOTH
  sides genuinely need belongs in a pure module (`src/server/finance/`, `src/server/games/`,
  `src/lib/`), never in the DAL. Same reason `src/lib/uuid.ts` uses a regex rather than
  `z.string().uuid()`: `filters.ts` is imported by a client component, so a runtime `zod` import there
  would ship zod to the browser to check a string shape.
- **A dynamic route with no `loading.tsx` is NOT PREFETCHED AT ALL — and every route in this app is
  dynamic.** Next 16's own docs (`node_modules/next/dist/docs/01-app/02-guides/prefetching.md`): "a
  static route is prefetched in full, while a dynamic route is skipped unless it has a `loading.js`
  boundary." The build output is the check — every route printing `ƒ` is dynamic. A missing
  `loading.tsx` therefore costs BOTH the skeleton and the prefetch, and the second loss is invisible:
  the page still works, it is just never warmed. Put one in every route SEGMENT, not just at the top of
  a subtree — a fallback one level too high replaces the sub-nav along with the content, so switching
  tabs blanks the very tabs being clicked. `src/components/ui/page-skeleton.tsx` holds the shared
  shapes; a route whose layout is genuinely unique builds its own from `Skeleton`.
- **`loading.tsx` does nothing for a navigation that stays on the SAME route, which is most of them.**
  Changing the month, the year, a category filter or a status chip pushes a new query string on the
  route you are already on. No segment boundary is crossed, so no fallback renders, and the page shows
  the PREVIOUS month's numbers until the server answers — with nothing on screen acknowledging the
  click. That is the majority of interaction in Finance and it was completely silent. Route those
  pushes through `useNavigate()` (`src/lib/use-navigate.ts`), which wraps them in `startTransition` so
  React reports a real pending flag, and render it locally: a spinner on the control, `FilterBar`'s
  `pending` line, a spinner on the row that was clicked. Local rather than one global top bar, which
  was tried and is worse — on a 1600px layout it puts the feedback where the eye is not, and it cannot
  say WHICH control is working.
- **A partial month produces arithmetically correct numbers that are completely wrong.** Statements
  arrive mid-cycle (card ~27th, checking ~15th), so the current month is never finished, and the
  dashboard happily reported a −70.4% savings rate and "↓56% vs Jul" from two weeks of data. A month is
  reportable only when EVERY active account has a transaction on or after its last day
  (`isMonthCovered`, `src/server/finance/dashboard.ts`) — derived from the transactions, never from a
  configured statement-close day, because a configured day lies exactly when a statement is late. The
  page defaults to `month − 1`, an uncovered month shows no stat cards at all, and trend charts drop
  the uncovered tail. It is conservative by design, and that cost is accepted.
- **"The owner can just go change the setting" is not a fix — especially when there is no screen to
  change it on.** The rule above originally judged every `is_active = true` account, and its own doc
  comment named the consequence (a dormant account freezes every later month) while calling the remedy
  `is_active = false`. Shipped that way, a retired "Historical (2024–2025)" account ending 1 Dec 2025
  made EVERY month of 2026 read "not fully imported", stopped the trend charts eight months short, and
  zeroed the Year Overview above a grid showing a full year of real numbers — and there is no Accounts
  UI in this app, so the documented remedy was unreachable. `partitionCoverage()` now derives dormancy
  from the data (`DORMANT_AFTER_DAYS = 75`, measured against the newest transaction in the LEDGER, not
  against today — see `docs/FINANCE.md`). When a rule's failure mode is written down as "the owner
  should notice and reconfigure," check first whether the data already answers it and whether the
  configuration surface even exists.
- **A pure-function test suite does not tell you the page renders.** Both bugs above were correct
  functions producing correct values that composed into a screen contradicting itself — 1,267 unit
  tests, a clean typecheck, a clean lint, and no test anywhere rendered `FinanceDashboard`. Same class
  as the `formatInflow` double-flip, which also reached the running app. A screen with an
  all-or-nothing branch (`MonthNotReady`/`YearNotReady`) needs a render test per BRANCH, asserting
  which block is on screen — see `tests/unit/finance-dashboard-view.test.tsx`, whose two regression
  cases fail against the shipped code.
- **A conditional SPREAD into JSX bypasses TypeScript's excess-property check, so a prop that does
  not exist is silently dropped.** `{...(cond ? { hint: 'x' } : {})}` on a component with no `hint`
  prop compiles clean, lints clean, and renders nothing — excess-property checking only applies to
  direct object literals, never to a spread. The M12 collections work used it to label a collection's
  unsplit trophy figure and the label simply never appeared; `InlineEditField` only had
  `disabledHint`, which renders exclusively in the read-only branch. Caught by looking at the running
  page, not by any check. The same pattern is used ALL OVER this codebase for
  `exactOptionalPropertyTypes` (and is correct for that), so the risk is specific: when a conditional
  spread introduces a prop name you have not used on that component before, confirm the prop exists.
- **An accessible name is computed by concatenating child nodes with each one TRIMMED, so an
  `sr-only` span cannot carry a leading separator.** `{title}<span class="sr-only"> — in {parent}</span>`
  renders and reads correctly on screen, and `textContent` is right, but the computed name comes out
  `"Remastered— in Uncharted…"` — the space is stripped before the join. `getByRole('button', { name })`
  then fails against a string that looks byte-identical to what's on the page, which reads as a test
  bug rather than the markup defect it is. Put the whole string in an explicit `aria-label` instead,
  keeping the visible text a prefix of it (WCAG 2.5.3). Diagnose this class of failure by passing a
  FUNCTION as `name` and capturing what it receives — the accessible name is the only thing that
  matters and it is not what the DOM dump shows you.

---

## Layout

```
src/proxy.ts              Access JWT verification, security headers, CSP nonce
src/app/                  routes; / redirects to /finance/monthly (the landing view)
src/features/finance/     Finance UI
src/features/games/       Games UI
src/components/ui/        shared primitives, incl. page-skeleton.tsx (route-shaped loading fallbacks)
src/lib/                  framework-free helpers usable from BOTH server and client (uuid, use-navigate)
src/server/finance/       DOMAIN CORE — pure TS, no React, no Next, no HTTP
src/server/games/         GAMES DOMAIN CORE — pure TS, no React, no Next, no HTTP
src/server/db/games/      owner-scoped data access + the one HTTP boundary (igdb.ts)
src/server/{auth,db,security}/
drizzle/                  migrations (committed)
tests/fixtures/           SYNTHETIC statements only
scripts/                  migrate.mjs, provision-owner.mjs — plain host-run Node scripts
docs/                     the approved plan and supporting documents
```

**`src/server/finance/` and `src/server/games/` must stay framework-free.** Money math, merchant
normalization, deduplication, categorization and classification are all testable without a browser or
a server; hours conversion, taxonomy and stats aggregation hold the same property for Games. That is
what makes financial (and library) correctness verifiable — protect this boundary.

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
