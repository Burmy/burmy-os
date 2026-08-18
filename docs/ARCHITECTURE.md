# Architecture

Companion to `IMPLEMENTATION_PLAN.md`. That document explains *what* we decided and *why*; this one
explains how the pieces fit and where the boundaries are.

---

## Shape

One Next.js application, one PostgreSQL database, one VPS, three containers. No microservices, no
queues, no cache tier, no message bus. A single-user application that is opened roughly once a month
does not need any of that, and every component omitted is one that cannot break, leak, or bill.

```
Browser ──HTTPS──▶ Cloudflare (TLS terminates here, Access gates on Google)
                        │
                        │ outbound-only tunnel — no inbound ports on the origin
                        ▼
                   ┌─────────────────── VPS ───────────────────┐
   network: edge   │  cloudflared ──▶ web (Next.js)            │
   (outbound OK)   │                    │                      │
                   │  ──────────────────┼───────────────────   │
   network: dbnet  │                    ▼                      │
   (internal:true) │  migrate ──▶  postgres 18 ──▶ pgdata      │
                   └───────────────────────────────────────────┘
                              │ nightly
                              ▼
                   pg_dump → restic (AES) → Backblaze B2
```

`web` is the only service on both networks. `postgres` has no route to or from the internet.
`cloudflared` can dial out but has no path to the database.

---

## The boundary that matters

```
src/server/finance/     ← pure TypeScript. No React. No Next.js. No HTTP. No I/O beyond the repo layer.
```

Money arithmetic, merchant normalization, deduplication, categorization and transfer classification
all live here. They take plain data and return plain data.

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
| `src/server/db/finance/` | **Owner-scoped data access.** Every function takes an `ownerId` and injects it into the `WHERE`; mutations match on `(ownerId, id)`, never `id` alone. Routes and actions never build queries. | Drizzle, domain types |
| `src/server/{auth,security}/` | Sessions, owner guard, CSP, headers, audit | Next.js request APIs |
| `src/features/finance/` | Finance UI — components, grids, review flow | Domain types, server actions |
| `src/app/` | Routing, layouts, Server Actions, Route Handlers | Everything above |
| `src/proxy.ts` | Access JWT verification, headers, CSP nonce | Next.js only |

Dependencies point inward. The domain core knows nothing about what is above it.

**Why data access is `db/finance/` and not `finance/queries/`** (settled in M3): the domain core's
value is that it can be exercised without a database. Putting queries inside it would mean the money
rules, merchant normalization and deduplication could only be tested against a live Postgres — slower,
flakier, and less likely to be written. An earlier sketch in the plan's §17 showed a `queries/`
directory under `finance/`; that has been corrected.

---

## Data flow: an import

The one flow worth understanding end to end.

```
1. UPLOAD      Multi-file batch (checking + card + savings together).
               Validated, written to a 0600 temp file outside the webroot.

               ── Why multi-file: transfers and credit-card payments have TWO legs.
                  Matching them requires both files present in one batch.

2. HASH        Already-committed file_sha256? Warn before parsing.

3. PARSE       Papa Parse, streaming. Adapter chosen by HEADER SIGNATURE, not filename.
               Unmapped source columns are DISCARDED HERE and never persisted.

4. NORMALIZE   Dates, sign convention asserted (not assumed), merchant normalized, Cents.

5. STAGE       → finance_import_rows, sanitized shape, single DB transaction.

6. DELETE      The temp file. Always. Including on the failure path.

7. DEDUPE      Source id if proven reliable; otherwise count reconciliation
               against committed history.

8. CLASSIFY    Transfers / card payments / investments — matched against this batch
               AND committed history (±7 days). Ambiguity produces a review item.

9. CATEGORIZE  rules → merchant memory → history → source category → heuristics → review.

10. PREVIEW    Server-rendered from staged rows. Survives refresh, deploy, device change.

11. REVIEW     Edits mutate staged rows only. expires_at extended on each edit (60-day window).

12. COMMIT     One DB transaction: staged → finance_transactions, merchant memory updated,
               transient staging columns dropped.
```

Staging in Postgres rather than memory is what makes steps 7–11 survivable. A 500-row import
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
  Pivot in TypeScript, split sections on category.kind
        │
        ├─ kind = spending|investment  →  Spending section
        └─ kind = income               →  Income section (sign flipped for DISPLAY only)
        │
        ▼
  Expenses · Investments · Total Outflow · Total Income · Net
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

## Extensibility, deliberately unbuilt

Burmy may one day gain other modules. The only architectural commitment made for that possibility is
*placement*: Finance lives in `features/finance/` and `server/finance/` rather than smeared across
generic directories, and genuinely shared concerns (auth, layout, db connection, security, audit) sit
at application level because they are shared *today*.

There is no module registry, no plugin system, no generic repository, no `UniversalModuleEngine`.
Adding a second module means adding a directory and a nav entry. When a real second module exists and
its real requirements are known, we refactor with knowledge instead of guessing now.

---

## Trust boundaries

Stated plainly, because the reassuring version would be false:

- **Cloudflare terminates TLS** and can technically inspect full application HTTP content — including
  transaction data in responses and uploaded file bodies. This is inherent to the reverse-proxy model.
- **The VPS provider hosts the entire application and database** with hypervisor-level access to
  memory and disk. Block-volume encryption protects against physical drive theft, not against the
  provider.
- **Google** sees an identity assertion at the Access layer and no financial data.
- **Backblaze B2** sees opaque restic blobs; encryption keys never leave the VPS.
- **SSH access** is ordinary key-based SSH, not a VPN mesh (simplified during M10 — see
  `docs/DEPLOYMENT.md`) — encrypted end to end by the SSH protocol itself; the VPS provider's own
  hypervisor-level access above is the operative trust boundary here, not the network path.

The architecture buys "no inbound ports, no exposed database, an identity gate, $0/month" in exchange
for trusting Cloudflare in transit and the VPS provider at rest. Alternatives exist (self-hosting
removes the provider) and are documented in the plan with their costs. This should be an informed
trade, not an assumption.
