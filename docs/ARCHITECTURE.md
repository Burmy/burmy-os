# Architecture

Explains how the pieces fit and where the boundaries are. `docs/FINANCE.md` and `docs/GAMES.md` explain
the two domains' rules in depth; `docs/ROADMAP.md` explains what was decided and why, milestone by
milestone; `docs/DEPLOYMENT.md` is canonical for the running production system.

---

## Shape

One Next.js application on Netlify, one managed PostgreSQL database on Supabase. No microservices, no
queues, no cache tier, no message bus, no host of our own to run or patch. A single-user application
that is opened roughly once a month does not need any of that, and every component omitted is one that
cannot break, leak, or bill.

```
Browser ──HTTPS──▶ Cloudflare (TLS terminates here, Access gates on Google — proxied DNS record)
                        │
                        │ ordinary HTTPS to a public origin — no tunnel, no inbound port to manage
                        ▼
                   Netlify (builds and runs the Next.js app; requireOwner() re-verifies
                            the Access JWT at every protected entry point, independent of
                            whether Cloudflare's edge was actually in the path)
                        │
                        │ TLS — pooled connection (runtime) / direct connection (migrations)
                        ▼
                   Supabase (managed Postgres 17.x, Supavisor pooler)
```

**Postgres 17, not 18** — Supabase picks its own version. Local dev and CI both pin `postgres:18-alpine`,
so every migration is written and tested one major version ahead of where it lands. Nothing in the
schema depends on the difference today; see `docs/DEPLOYMENT.md`, "Production runs a different Postgres
MAJOR version", for why that is recorded rather than fixed.

Netlify is the only hop between Cloudflare and the database. There is no VPS, no Docker host, and no
network of our own to segment — the trust boundary that used to be an `internal: true` Docker network
is now just "only the app's own environment variables can reach Supabase's connection strings," since
neither ever reaches the browser.

---

## The boundary that matters

```
src/server/finance/     ← pure TypeScript. No React. No Next.js. No HTTP. No I/O beyond the repo layer.
src/server/games/       ← the same rule, held to just as strictly.
```

Money arithmetic, merchant normalization, deduplication, categorization and transfer classification
live in the first. Hours conversion, taxonomy, play-year attribution, stats aggregation, the collection
counting rule, and the pure request/response shaping for IGDB, Steam and PSN live in the second. All of
them take plain data and return plain data.

This is not architectural taste. It is what makes financial correctness *verifiable*: the logic that
decides whether $200 is counted once or twice can be exercised in a unit test that runs in
milliseconds, with no browser, no server, and no database. If that logic ever needs a React context or
a `Request` object to run, the boundary has been breached and the tests become integration tests —
slower, flakier, and less likely to be written.

Everything else is arranged around it:

| Layer | Responsibility | May depend on |
| --- | --- | --- |
| `src/server/finance/` | Domain logic and arithmetic. **No Drizzle, no database, no I/O.** | Nothing framework-related |
| `src/server/db/` | Drizzle schema and connection | Domain types |
| `src/server/games/` | Games domain logic — hours, taxonomy, stats, collections, sync planning. **Same rule: no Drizzle, no database, no HTTP.** | Nothing framework-related |
| `src/server/db/finance/` | **Owner-scoped data access.** Every function takes an `ownerId` and injects it into the `WHERE`; mutations match on `(ownerId, id)`, never `id` alone. Routes and actions never build queries. | Drizzle, domain types |
| `src/server/db/games/` | The same, for Games — **plus the module's only outbound HTTP** (`igdb.ts`, `steam-client.ts`, `psn-client.ts`) | Drizzle, domain types, `fetch` |
| `src/server/{auth,security}/` | Owner guard, CSP, headers, audit | Next.js request APIs |
| `src/features/finance/` | Finance UI — components, grids, review flow | Domain types, server actions |
| `src/features/games/` | Games UI — library, game page, stats, sync review | Domain types, server actions |
| `src/app/` | Routing, layouts, Server Actions, Route Handlers | Everything above |
| `src/proxy.ts` | Access JWT verification, headers, CSP nonce | Next.js only |

Dependencies point inward. The domain core knows nothing about what is above it.

**Outbound HTTP is confined to `db/games/`, and only there.** Finance makes no external calls at all —
CLAUDE.md's "no bank connections, ever" is absolute. Games talks to three third-party APIs, and each
client is a leaf that fails soft: a missing credential, a timeout, a non-200 or malformed JSON all
produce `[]`/`null`, never a throw, so no page can break because IGDB was slow. The pure URL-building
and response-shaping for each lives in `server/games/` where it can be tested without a network; only
the `fetch` itself lives in `db/games/`.

**The two feature modules share nothing but generic UI primitives and the auth boundary**, deliberately
— see "Extensibility" below.

**Why data access is `db/finance/` and not `finance/queries/`** (settled in M3): the domain core's
value is that it can be exercised without a database. Putting queries inside it would mean the money
rules, merchant normalization and deduplication could only be tested against a live Postgres — slower,
flakier, and less likely to be written. An earlier sketch in the plan's §17 showed a `queries/`
directory under `finance/`; that has been corrected.

---

## Data flow: an import

The one flow worth understanding end to end.

```
1. UPLOAD      One file, one account, per import — never a multi-file batch.
               Validated, held only in memory as the request's own bytes — never written to disk,
               never to any statically served path. Nothing to delete because nothing was written.

2. HASH        Already-committed file_sha256? Warn before parsing.

3. PARSE       Papa Parse, streaming over the in-memory bytes. Adapter chosen by HEADER SIGNATURE,
               not filename. Unmapped source columns are DISCARDED HERE and never persisted.

4. NORMALIZE   Dates, sign convention asserted (not assumed), merchant normalized, Cents.

5. STAGE       → finance_import_rows, sanitized shape, single DB transaction.

6. DEDUPE      Source id if proven reliable; otherwise count reconciliation
               against committed history.

7. CLASSIFY    Transfers / card payments / investments — a batch is single-account by
               construction, so both legs of a pair can never be in the same import.
               Matched against COMMITTED history only (±7 days), in either import order,
               including a retroactive update to an already-committed transaction from a
               prior import. Ambiguity produces a review item.

8. CATEGORIZE  rules → merchant memory → history → source category → heuristics → review.

9. PREVIEW     Server-rendered from staged rows. Survives refresh, deploy, device change.

10. REVIEW     Edits mutate staged rows only. expires_at extended on each edit (60-day window).

11. COMMIT     One DB transaction: staged → finance_transactions, merchant memory updated,
               transient staging columns dropped.
```

Staging in Postgres rather than memory is what makes steps 6–10 survivable. A 500-row import
is not lost to a refresh, a deploy, or a phone locking — which matters a great deal when the app is
used once a month in a single long sitting.

---

## Data flow: a reported number

```
finance_transactions
        │
        │  WHERE owner_id = ? AND date range
        │  AND transaction_type IN (expense, refund, fee, adjustment, investment, income)
        │        ↑
        │        └── transfer and credit_card_payment are absent BY DESIGN.
        │            This single clause is the entire double-counting guarantee.
        ▼
  GROUP BY category, month  →  SUM(amount_cents)
        │
        ▼
  Pivot in TypeScript — one flat column per category, in the owner's own
  configured sort_order. NEVER regrouped into Spending/Investment/Income
  blocks (an owner instruction that overrides the original mockup);
  category.kind shows only as a small non-reordering label for context.
  Income is sign-flipped for DISPLAY only.
        │
        ▼
  Total Expenditure · Income · Gross Savings (Income − Total Expenditure)
```

Nothing is cached. Nothing is stored. ~40 categories × 12 months is a trivial query, and computing it
fresh removes an entire class of staleness bugs.

---

## Why a separate origin

`app.burmy.me`, not `burmy.me/finance`.

The decisive reason is the same-origin policy. At `burmy.me/finance`, any XSS anywhere in the
portfolio — a stale dependency, an embed, a widget — executes in the same origin as the finance
application and can read its DOM and issue authenticated requests. A separate origin makes that
structurally impossible.

It also buys host-only cookies, an independent CSP, an independent Access policy, and independent
deploys.

**Never set a cookie with `Domain=.burmy.me` in either property.** That single mistake undoes most of
the benefit.

---

## Extensibility — the prediction, and what actually happened

This section used to say: *"Burmy may one day gain other modules. The only architectural commitment
made for that possibility is placement… Adding a second module means adding a directory and a nav
entry. When a real second module exists and its real requirements are known, we refactor with knowledge
instead of guessing now."*

**A second module now exists, and the prediction held.** Games was added as `features/games/`,
`server/games/` and `server/db/games/` plus a nav entry. Nothing generic had to be built for it, and
nothing generic was.

**What the modules actually share, in full:** the `src/components/ui/` primitives (button, table,
dialog, chip, stat card, and — promoted there once a second module needed each — `inline-edit-row`,
`picker-dialog` and the tone-based `status-badge`), the `src/lib/` helpers (`cn`, `useNavigate`,
`format-date`, `relative-time`, `uuid`), the `(private)` layout and sidebar,
`src/server/db/index.ts`'s connection, `requireOwner()`, and the CSP/header work in `src/proxy.ts`.
That is the complete list.

Promotion rather than duplication is the rule for a primitive with **zero knowledge of the module it
started in**. Promoting one into `components/ui/` or `lib/` is not the shared module framework the
rule forbids; one feature module importing another is, and the promotions are what make that
unnecessary. The test is knowledge, not resemblance: a Games card and an Anime card resemble each
other and encode different constraints, so they stay two files.

`src/lib/` may never import from `src/server/{finance,games,anime}/`. It did once — `format-date.ts`
took `MONTH_ABBREVIATIONS` from `@/server/finance/grid`, which put a Finance import in every other
module's bundle behind an innocuous date helper, and is documented in `server/games/release-date.ts`
as the reason that module refused to reuse it.

**What they deliberately do NOT share, despite the surface similarity:** both count things, both
aggregate, both have a stats page, both have a filterable table, both have a "sync/import then review
then commit" flow. None of that is abstracted. Games has its own `hours.ts` mirroring `money.ts`'s
containment rule rather than a shared `QuantityKit`; its own stats module rather than a shared
aggregation engine; its own sync review screens rather than a shared staging framework. Each pair looks
like duplication and is not — the constraints differ (money is signed cents where positive means
outflow; hours are unsigned tenths), and a shared abstraction would have to model both, which means
modelling neither well.

**There is still no module registry, no plugin system, no generic repository.** CLAUDE.md now makes
this a rule rather than a preference: do not build a shared module framework for the two that exist,
and do not build a shared module framework for the modules that exist.

**Amended 2026-08-29:** a third module, Anime, was added at the owner's request; this section
previously read "and do not build a third module". The prohibition that survives is the one about
COUPLING, not about count: no generic module registry, no abstraction two modules both instantiate,
no shared feature layer. Anime shares `src/components/ui/`, the `(private)` layout, `getDb()`,
`requireOwner()` and `src/proxy.ts` with the other two, and nothing beyond that.

---

## Trust boundaries

Stated plainly, because the reassuring version would be false:

- **Cloudflare terminates TLS** and can technically inspect full application HTTP content — including
  transaction data in responses and uploaded file bodies. This is inherent to the reverse-proxy model.
- **Netlify runs the application** and can technically inspect requests and responses passing through
  its platform, plus whatever it logs. It never receives a database credential beyond the pooled
  runtime connection string, and never receives the direct/migration connection string at all — that
  one lives only in the operator's own shell, never in Netlify's environment-variable store.
- **Supabase hosts the database** with the same category of at-rest/in-memory access any managed
  Postgres provider has to the data it stores.
- **Google** sees an identity assertion at the Access layer and no financial data.
- **IGDB (via Twitch OAuth), Steam and Sony** each receive game titles and identifiers from the Games
  module, and Steam and Sony additionally tie those requests to the owner's real account on their
  platform. Every one of these is **optional** — the module works fully with no credentials set — and
  none of them ever receives Finance data, because Finance makes no outbound calls at all. Sony's is an
  *unofficial* API accessed with a browser token; it can change or break without notice, which is why
  its failure path is a visible message rather than an exception.

The architecture buys "no host to patch, no inbound ports of our own, an identity gate, low cost" in
exchange for trusting Cloudflare in transit, Netlify to run the app honestly, and Supabase with the
data at rest. This should be an informed trade, not an assumption — see git history for the earlier
self-hosted VPS design, which traded these platform trusts for operational burden instead.

---

## Perceived performance — why navigation felt slow, and what was done

Real usage: *"the transitions between pages and everything is very laggy or slow, also there is no
indication."* Measured rather than guessed, and the measurement moved the answer.

**The database is not the bottleneck and cannot become one at this size.** 18 MB, ~1,100 transactions,
185 games, 6,137 trophies. Supabase's performance advisors report nothing above INFO. Of the app's own
queries, the two slowest are trophy aggregates on `/games/stats` at ~109ms and ~66ms mean; **everything
else is under 20ms.** Adding indexes to a table Postgres can scan in a millisecond would be theatre.

What actually costs time is the **serverless round trip** — a Netlify function invocation, cold most of
the time for a single-user app that scales to zero — and what made that time feel worse than it is was
the app saying nothing while it elapsed.

### The prefetch rule that was being missed

From Next.js 16's own docs: *without Cache Components, a static route is prefetched in full, while a
**dynamic route is skipped unless it has a `loading.js` boundary**.* Every route in this app is dynamic
(`ƒ` in the build output). Only two segments had a `loading.tsx`, so for the rest the nearest boundary
was `(private)/loading.tsx` — above the sub-nav.

Two consequences, both visible:

- **Switching Games tabs blanked the tabs themselves.** The fallback lived above the `(tabs)` layout, so
  Library → Stats replaced the sub-nav along with the content. Finance did not have this problem,
  because it alone had a segment-scoped fallback.
- **The fallback looked like no page in the app** — a title bar and a grey block — so every navigation
  flashed to something unrelated and then flashed again to real content: two layout shifts where there
  should be none.

Every segment now has its own fallback, shaped like the route it stands in for
(`src/components/ui/page-skeleton.tsx`). A fallback that matches the page reads as the page arriving,
not as a different screen interrupting — the same latency, a different experience.

### The silence `loading.tsx` cannot fix

A route-level fallback only appears when a navigation crosses a **segment** boundary. Most interaction
in Finance does not: changing the month, the year, a category filter or a status chip pushes a new query
string on the **same** route. No boundary, no fallback, and the previous month's numbers stay on screen
until the server answers.

`src/lib/use-navigate.ts` wraps those pushes in `startTransition` so React reports them as pending for
exactly as long as the server takes. Callers render that locally: a spinner beside the month navigator,
a thin indeterminate line under `FilterBar`, a spinner on the game card or table row that was clicked.

**Local, not one global progress bar** — that was the first design and it is worse: a bar at the top of
the viewport is further from the control than the control is from the pointer, so on a wide screen the
feedback appears where the eye is not, and it cannot say *which* of several controls is working.

And because even a transition takes a moment to begin, the two navs use `useLinkStatus` (Next's own hook
for exactly this) to acknowledge a click inside the `<Link>` itself, before the router has done anything.

### What was deliberately NOT done

- **No Suspense streaming of the page shells.** Tempting, and it would help a cold full page load. But
  each page's queries already run through one `Promise.all` against a pool of 10, so a render waits
  roughly one round trip, not the sum of its queries — and on a client-side navigation the shell is
  already on screen, so there is nothing for streaming to reveal earlier. The win would be small and the
  refactor is not.
- **No caching of query results.** Every number in this app is computed at read time, on purpose
  (CLAUDE.md invariant 1). Caching totals to make a page feel faster is the exact trade this project
  exists to refuse.
- **No index tuning.** See above — there is nothing to tune at 18 MB.
