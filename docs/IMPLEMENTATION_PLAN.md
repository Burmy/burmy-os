# Burmy (`burmy-os`) — Finance-First Implementation Plan

**Status: APPROVED.** Revision 4, incorporating four rounds of review corrections.
Implementation proceeds one milestone at a time, stopping for review at the end of each.

> This document is the authoritative plan of record. The "Changes in Revision N" tables below are kept
> deliberately — they record *why* several non-obvious decisions were made, and each one exists because
> an earlier draft was wrong in a way that would have cost data, money, or correctness.

---

## Context

Burmy is a **private, single-user web application** at `app.burmy.me`, separate from the public
portfolio at `burmy.me`. The repository `Burmy/burmy-os` is empty and currently public.

Today the owner maintains a manual Excel sheet: **rows are spending categories, columns are months**,
each cell a hand-summed total with a hand-typed comment listing the purchases behind it.

**Intended outcome:** upload statement exports → Burmy categorizes and computes → the monthly grid
maintains itself, and every cell drills down to the exact transactions behind it.

**Hard constraint:** no bank connections. Files in, insights out.

**Confirmed context from the interview:** Bank of America is the only institution; all original CSVs
still exist; usage is **monthly**, not daily; the monthly grid is the primary view; reimbursements
reduce their category; savings/brokerage balances are manual monthly snapshots; income, investments
and balances are tracked, cash spending is not.

---

## Changes in Revision 2

| # | Correction | Effect |
| --- | --- | --- |
| 1 | **Oracle PAYG does not documentably prevent idle reclamation** | Verified against Oracle's docs — the claim is **not** there. Oracle is now treated as reclaimable regardless of account type. §15 rewritten. |
| 2 | Paid-fallback pricing must be current | Re-checked; Hetzner's own page is JS-rendered and unreadable — flagged as third-party-sourced, verify at purchase. DO/Vultr added. |
| 3 | Do not configure Google OAuth twice | Better Auth now does **passkey + local session only**. Owner identity comes from the verified Access JWT. §13 rewritten. |
| 4 | Prototype owner bootstrap/recovery before locking break-glass | Break-glass is now an explicit prototype-then-decide step, not a pre-committed design. |
| 5 | Privacy matrix was misleading | Removed "Cloudflare sees traffic but not meaning" and "nobody receives a complete picture". §10 rewritten to state that Cloudflare terminates TLS and can see application content, and the VPS provider hosts everything. |
| 6 | `import_rows.raw` jsonb | Replaced with a minimal sanitized staging shape; source detail deleted after commit. |
| 7 | Persistent `occurrence_index` | Replaced with **count/multiset reconciliation** plus **source transaction IDs** where BoA provides them. |
| 8 | Transfer/card-payment matching | Now matches staged rows against **both** the current batch **and** already-committed transactions across a date window. |
| 9 | Type thresholds | Exclusionary types (transfer, card payment, investment) now require **deterministic evidence**, never a graded heuristic. |
| 10 | 7-day staged-import sweep | **Was broken** against monthly usage. Now 60 days or explicit discard. |
| 11 | Postgres 17 | → **PostgreSQL 18.6** (released 13 Aug 2026; 18 is the current major). |
| 12 | ExcelJS | Now provisional and isolated, with a dependency/security review gate when XLSX work begins. |
| 13 | Backup sequencing | CSV archive backed up **immediately**; restic/VPS automation moved to just before the first production import instead of interrupting early feature work. |
| 14 | Secrets in backups | Secrets and recovery credentials live in the password manager / offline process, **not** bundled into Finance backups. |
| 15 | Host-installed pnpm for migrations | Migrations now run **through the container image**. |
| 16 | Custom `owner_id` lint rule | Removed. Ownership enforced by data-access APIs + integration tests. |
| 17 | Home dashboard | Dropped for V1. **`/finance/monthly` is the landing experience.** |
| 18 | 20 phases | Collapsed to **10 milestones**. |
| 19 | Launch timing | Production launch moved **after** transactions, export, reconciliation, hardening and backup/restore. |

## Changes in Revision 3

| # | Correction | Effect |
| --- | --- | --- |
| 20 | `proxy.ts` location | **Verified:** Next.js docs place it at the project root or inside `src`, level with `app`. Moved from `src/app/proxy.ts` to **`src/proxy.ts`**. |
| 21 | Docker networking was broken | `internal: true` on the only network would have **prevented `cloudflared` from dialing out at all**. Split into an externally-connected `edge` network and an `internal: true` `dbnet`. §16 rewritten. |
| 22 | Postgres 18 volume layout | **Verified breaking change:** PG18's image sets `PGDATA=/var/lib/postgresql/18/docker` and declares `VOLUME /var/lib/postgresql`. A volume mounted at the pre-18 `/var/lib/postgresql/data` **silently fails to persist**. Corrected. |
| 23 | Auto-restore on failed healthcheck | **Removed — it was dangerous.** A transient app fault would have destroyed newer writes. Rollback now touches the image only; DB recovery is always an explicit human decision. §35 rewritten. |
| 24 | Dedupe identity coupled to `merchant_key` | Separated. Dedupe now uses an **immutable, versioned key derived from the raw description**; `merchant_key` evolves freely for categorization. §23 rewritten. |
| 25 | Transfer matching too weak | Equal amount + date + direction **can no longer auto-pair**. A semantic signal and a unique candidate are now both required. §24 rewritten. |
| 26 | Income UI undefined | Now specified exactly — a second grid section, sign-flipped, with `Total Income` and a `Net` row. §20 and §26. |
| 27 | Arbitrary 80% categorization DoD | Replaced with fixture correctness plus a **measured** learning-loop property: merchants confirmed in month 1 require zero review in month 2. |
| 28 | Server Function auth (found while verifying `proxy.ts`) | Next.js docs warn that Server Functions are POSTs to their host route, so a matcher change can **silently drop proxy coverage**. Auth is now verified **inside every Server Action**; the proxy is defense-in-depth, not the boundary. |

## Changes in Revision 4 — final, plan approved

| # | Correction | Effect |
| --- | --- | --- |
| 29 | §11 diagram still showed the obsolete single `burmy_net` | Redrawn to the corrected `edge` + internal `dbnet` split, matching §16. |
| 30 | **Monthly SQL excluded `income`** while the Income section was sourced from the same result — the Income rows would always have been empty | `income` added to the type list; sections split downstream on `category.kind`. Income/Net calculations now have their own test row in §36. |
| 31 | Auth rule was scoped to Server Actions only | Generalized to **every protected server entry point**, Route Handlers included, with an explicit unprotected allowlist (`/api/health`, `/api/auth/*`) and a requirement that health exposes no sensitive information. |
| 32 | `source_transaction_id` trusted on the strength of a column name | **Gated on M4 verification** of stability, uniqueness and coverage against real overlapping exports, per account type. **No unique constraint in the initial schema.** Tier 2 does all the work until proven otherwise. |
| 33 | Docker image ownership across milestones was ambiguous | **M1 creates** the image and compose stack that containerized migrations require; **M10 hardens that same image** for production. One image evolving, not two. |

---

## 1. Executive Summary

Build **one Next.js 16 application + one PostgreSQL 18 database**, owner-only, in Docker Compose,
fronted by Cloudflare Tunnel + Access, on a VPS, with encrypted off-site backups. Recurring cost
**$0/month** on Oracle Always Free, with a rehearsed migration to a ~$5/month paid host.

Finance is a **derivation engine**. Transactions are the only source of truth; every number is
computed by SQL at read time. Nothing is stored as a total. No LLM performs arithmetic.

Three interview findings shape the design:

1. **Bank of America is the only institution.** Adapter scope collapses to two shapes plus a generic
   fallback.
2. **All original CSVs exist**, so history imports as real, drillable transactions. The §42 aggregate
   layer is deleted. The Excel sheets become **hand-verified ground truth** for a reconciliation view.
3. **Usage is monthly.** Imports must be multi-file batches (both legs of a transfer must be present
   to match), the review queue must work in one long sitting, and **staged imports must survive
   between visits** — which is why the original 7-day sweep was a defect.

The dominant risk is not technical. It is the window between "months of hand-categorized history
exists" and "a restore has been tested."

---

## 2. Product Definition

**Burmy now:** `Finance` and `Settings`. `/` redirects to `/finance/monthly`. There is no Home
dashboard in V1 — the monthly grid *is* the landing experience.

**Why Finance is V1:** it is the only module backed by a real, painful, recurring manual process.

**Extensibility without overengineering:** by *placement*, not abstraction. Finance logic lives in
`src/features/finance/` and `src/server/finance/`. Auth, layout, DB connection, security middleware,
settings and audit live at application level because they are shared concerns *today*. No module
registry, no plugin system, no generic repository. Adding a second module means adding a directory
and a nav entry.

---

## 3. V1 Scope

| Area | In V1 |
| --- | --- |
| Auth | Google at Cloudflare Access; **Better Auth passkey + local session** in-app (no second Google config) |
| Accounts | CRUD for logical accounts (checking, savings, credit card, brokerage) |
| Categories | Flat, owner-defined, merchant-shaped names allowed; archive/reorder; `parent_id` in schema, unused in UI |
| Import | Multi-file CSV batch → sanitized staging in Postgres → preview → commit; BoA deposit + BoA card adapters + generic mapper with saved signatures |
| Correctness | Count-based duplicate reconciliation, transfer pairing across batch **and** history, card-payment handling, investments, refunds reducing categories |
| Categorization | Rules → merchant memory → history → source category → heuristics → Needs Review. **No AI in V1.** |
| Review | Keyboard-driven queue, bulk confirm, merchant learning |
| Reporting | **Monthly grid with cell drill-down** (landing view); transactions table |
| Balances | Manual monthly snapshots |
| Reconciliation | Excel totals as expected values; computed-vs-expected deltas |
| Export | CSV + XLSX, formula-injection safe |
| Ops | Docker Compose, Cloudflare Tunnel + Access, Tailscale, encrypted backups, **tested** restore, scripted operations |

---

## 4. V1.1

Split transactions; category `parent_id` surfaced for rollups; saved filter views; recurring-subscription
detection; optional AI for the residual review tail; refund→purchase linking; a Home dashboard if one
is ever missed.

## 5. Deferred

All non-Finance modules — Notes, Files, Sheets, Inbox, Bookmarks, Garage, Receipts, Subscriptions.
Finance chat. Amazon item-level splitting. PDF parsing. Multi-currency logic. Budgets and category
limits (**assumption: out of V1**; the product is retrospective by design).

## 6. Out of Scope

Bank connections of any kind. Multi-user, organizations, roles, billing, registration, marketing
pages. Kubernetes, Redis, Kafka, Elasticsearch, GraphQL, microservices, queues, self-hosted Supabase.
Custom cryptography. Storing full account numbers. Retaining raw statement files.

---

## 7. Decision Register

### CONFIRMED

**From the specification** — `app.burmy.me` private, `burmy.me` separate; Finance only; no bank
connections; transactions are the source of truth; single user, no signup; Postgres + Docker Compose +
one app; AI optional and never authoritative; CSV first; raw uploads deleted after parsing.

**From the interview** — monthly grid is primary; flat categories with merchant-shaped names; track
income, investments, savings balances (not cash); **Bank of America only**; all original CSVs exist;
balances are manual snapshots; reimbursements reduce their category; Oracle Always Free chosen with
risk accepted; **passkey at the app layer**; reconciliation ships in V1; every operation scripted;
usage is monthly.

**From this review** — Postgres 18; no second Google OAuth; `/finance/monthly` is the landing;
sanitized staging; count-based dedupe; deterministic thresholds for exclusionary types; 60-day staged
retention; migrations via container; no custom lint rule; launch after hardening.

### RECOMMENDED

Next.js 16.3 App Router · Node 24 LTS · pnpm · Better Auth 1.6 (passkey only) · Drizzle + **PostgreSQL
18.6** · signed `BIGINT` cents · TanStack Table + Virtual · purpose-built monthly grid with SQL pivot ·
Papa Parse · ExcelJS (**provisional**, review gated) · repo private before first commit.

### NEEDS DECISION

None blocking. Four items asked twice and unanswered; **proceeding on assumptions**, each cheap to
revise: volume (150–400/mo), Excel comment contents (merchant+amount lists), budgets (out of V1),
mobile scope (grid read, review queue, single-transaction edit).

### DEFERRED

See §5.

---

## 8. Final Recommended Tech Stack

| Technology | Purpose | Why | Alternatives | Cost | Risk |
| --- | --- | --- | --- | --- | --- |
| **Next.js 16.3** | Framework | App Router, Server Actions, official self-hosting (`output: 'standalone'`); single instance is exactly our case | Remix, SvelteKit | Free | Major-version churn; pin |
| **Node 24 LTS / TypeScript** | Runtime | LTS to Apr 2028 | Node 26 | Free | None |
| **PostgreSQL 18.6** | Database | Current major (18.6 released 13 Aug 2026); exact integer math, real transactions | SQLite | Free | Major upgrades need dump/restore — scripted |
| **Drizzle ORM** | Data access | SQL-shaped and typed; no magic hiding aggregate semantics | Prisma, Kysely | Free | 0.x versioning; pin exactly |
| **Better Auth 1.6** (passkey plugin only) | App session | Absorbed Auth.js; owns its tables in our Postgres | Auth.js (maintenance-only) | Free | Recovery undocumented → prototyped, not assumed (§13) |
| **Tailwind + shadcn/ui + Lucide** | UI | Compact, copy-in, no lock-in | MUI, Mantine | Free | None |
| **TanStack Table + Virtual** | Transactions grid | MIT, headless, **no feature cliff**; one row model drives desktop grid and mobile cards | AG Grid Community | Free | Headless = ~1–2 days more hand-built UX |
| **Papa Parse** | CSV | RFC-4180 correct, streaming | csv-parse | Free | None |
| **ExcelJS** *(provisional)* | XLSX | MIT; npm `xlsx` is abandoned with unfixed CVEs | SheetJS via own CDN, `write-excel-file` | Free | **Slow-moving upstream — formal dependency/security review before XLSX work begins (M9)**; isolated behind one module so it is replaceable |
| **Zod** | Validation | Boundary validation, inferred types | Valibot | Free | None |
| **Vitest / RTL / Playwright** | Testing | Fast domain math; 3 E2E journeys only | Jest | Free | None |
| **Docker + Compose** | Packaging | Portability — the VPS stays disposable | Podman | Free | arm64 on Oracle |
| **Cloudflare Tunnel + Access** | Ingress + outer gate | No inbound ports; identity gate free ≤50 users | Tailscale Funnel | Free | **Terminates TLS — see §10** |
| **Tailscale** | Admin access | SSH without exposing :22; free 6 users / unlimited devices | Plain WireGuard | Free | Control-plane dependency |
| **restic + Backblaze B2** | Backups | Client-side encryption, dedup; first 10 GB free | borg, rsync.net | Free | Restore must be *tested* |

**Explicitly rejected:** AG Grid Enterprise ($999/dev/yr — row grouping and pivoting are paid, and the
monthly view *looks* like a pivot; ours is computed in SQL). npm `xlsx`. Redis, Kubernetes, GraphQL,
queues.

---

## 9. Cost Analysis

**Minimum viable / Recommended: $0.00/month** (~$12/yr domain)

| Service | Purpose | Free tier | $/mo |
| --- | --- | --- | --- |
| Oracle Always Free | VPS | Up to 2 OCPU / 12 GB ARM, 200 GB, 10 TB egress | $0 |
| Cloudflare DNS + Tunnel | Ingress | Unlimited | $0 |
| Cloudflare Access | Outer gate | ≤50 users | $0 |
| Tailscale Personal | Admin | 6 users, unlimited devices | $0 |
| GitHub | Private repo + CI | Unlimited private repos | $0 |
| Backblaze B2 | Backups | First 10 GB (we need ~0.1 GB) | $0 |
| Google (via Cloudflare Access) | Identity | Free | $0 |

**Paid fallback — pricing is third-party-sourced and must be confirmed at purchase.** Hetzner's own
pricing page is JavaScript-rendered and could not be read directly in this session.

| Option | Spec | Region | ~$/mo (unverified) |
| --- | --- | --- | --- |
| Hetzner CX22 | 2 vCPU x86 / 4 GB / 40 GB / 1 TB | Ashburn, Hillsboro | ~$4.59 |
| Hetzner CPX11 | 2 vCPU / 2 GB / 40 GB | Ashburn, Hillsboro | ~$5.93 |
| Vultr High Frequency | 2 vCPU / 2 GB / 64 GB NVMe | US | ~$12 |
| DigitalOcean Basic | 2 vCPU / 2 GB / 60 GB | US | ~$18 |

**Future upgrade:** ~$8–10/mo for a larger instance, plus <$0.50/mo if AI is ever enabled. Backups
stay $0.

---

## 10. External Services / Privacy Matrix

**Stated plainly:** two parties have technical access to complete financial data.

| Party | What they can technically access | Why | Disableable? |
| --- | --- | --- | --- |
| **Cloudflare** | **Terminates TLS at the edge, so it can technically inspect full application HTTP content** — page responses containing transactions and balances, uploaded statement file bodies, and API payloads. Also holds Access identity (the owner's Google email) and authentication logs. This is inherent to the reverse-proxy model, not a misconfiguration. | Ingress without exposed ports; outer identity gate | Yes, at a cost. **Tailscale Funnel terminates TLS on the origin**, removing Cloudflare from the plaintext path — but it drops the Access gate and is bandwidth-constrained. Direct exposure with Caddy/Let's Encrypt also removes it, at the cost of opening inbound ports. |
| **VPS provider (Oracle, or the fallback)** | **Hosts the entire application and database.** Hypervisor-level access to VM memory and disk. Block-volume encryption protects against physical drive theft, **not** against the provider. They can technically read everything, including the database in plaintext. | Compute | Only by self-hosting on owned hardware. Switching provider changes *who* has this access, never *whether* someone does. |
| **Google** | The owner's identity assertion (email, subject id) during Cloudflare Access sign-in. **No financial data.** | Identity provider for Access | Yes — Access supports one-time-PIN email instead of Google |
| **Backblaze B2** | **Opaque restic blobs only.** Encryption happens on the VPS; keys never leave it. B2 cannot read backup contents. | Off-site backup | Yes — any restic target |
| **Tailscale** | Device identity, public keys, coordination metadata. **Not traffic** — WireGuard is end-to-end encrypted between nodes. | Admin network | Yes — plain WireGuard |
| **GitHub** | Source code only. No secrets, no statements, no data. | Version control + CI | Yes — self-hosted git |
| **OpenAI** | *Not used in V1.* If ever enabled: one merchant string, one amount, and the allowed category names, for a single unknown transaction. Never account numbers, balances, addresses, history, or files. | Residual categorization | Yes — off by default; app fully functional without it |

**The honest tradeoff:** this architecture buys "no inbound ports, no exposed database, an identity
gate, and $0/month" in exchange for trusting Cloudflare in transit and the VPS provider at rest. That
is a reasonable trade for a personal finance app, but it should be an informed choice, not an
assumption.

---

## 11. Production Architecture

```
                              Browser (owner)
                                    │  HTTPS
                                    ▼
                    ┌───────────────────────────────┐
                    │        CLOUDFLARE EDGE        │
                    │  DNS · TLS terminates HERE    │
                    │  WAF · rate limiting          │
                    │                               │
                    │  ┌─────────────────────────┐  │
                    │  │ ACCESS  (outer gate)    │  │
                    │  │ Google OAuth            │  │  ← FACTOR 1
                    │  │ allowlist: owner email  │  │
                    │  └─────────────────────────┘  │
                    └───────────────┬───────────────┘
                                    │ outbound-only tunnel
                                    │ (no inbound ports open)
════════════════════════════════════╪══════════════════════════════
                          VPS       │
                                    ▼
      ╔═══════════ network: edge ═══════════╗   bridge — outbound internet
      ║   ┌────────────┐                    ║   (cloudflared MUST dial out)
      ║   │ cloudflared│  no published ports║
      ║   └─────┬──────┘                    ║
      ║         │ http://web:3000           ║
      ║   ┌─────▼──────────────────┐        ║
      ║   │  web  (Next.js 16)     │        ║
      ║   │  standalone · non-root │        ║
      ║   │  src/proxy.ts verifies │        ║
      ║   │  the Access JWT        │        ║
      ║   │  ┌──────────────────┐  │        ║
      ║   │  │ BETTER AUTH      │  │        ║  ← FACTOR 2
      ║   │  │ passkey + session│  │        ║
      ║   │  │ (no Google here) │  │        ║
      ║   │  └──────────────────┘  │        ║
      ╚═══╪════════╪═══════════════╪════════╝
          │        │ web bridges both networks
      ╔═══╪════════▼═══ network: dbnet ═════╗   internal: true
      ║   │   ┌──────────┐                  ║   no route off-host, in or out
      ║   │   │ migrate  │ one-shot, exits 0║   (cloudflared is NOT on this net)
      ║   │   └────┬─────┘                  ║
      ║   │        │ 5432 — never published ║
      ║   │   ┌────▼───────┐                ║
      ║   └──▶│postgres 18 │──▶ pgdata:     ║
      ║       └────┬───────┘  /var/lib/     ║
      ║            │          postgresql    ║  ← PG18 layout, NOT /data
      ╚════════════╪═════════════════════════╝
                              │ nightly
                    ┌─────────▼──────────┐
                    │ pg_dump → restic   │──▶ Backblaze B2
                    │ → verify restore   │    (opaque blobs)
                    └────────────────────┘
        Secrets & recovery credentials live OFFLINE, not in this backup path.

        ufw default-deny · SSH bound to the Tailscale interface only
        Owner's PC ──▶ Tailscale ──▶ VPS (SSH, admin, deploys)
```

**Two independent factors, two different failure modes.** A compromised Google account passes Access
and is stopped by the passkey. A stolen device with a passkey is stopped by Access.

---

## 12. Local Development Architecture

No Cloudflare, no Tailscale, no VPS.

```
  pnpm dev ──▶ localhost:3000 ──▶ docker: postgres:18 on 5432
                    │
                    └── Better Auth, rpID = "localhost"
                        Passkeys work — localhost is a secure context
                        Access JWT verification bypassed only when NODE_ENV=development
```

```bash
git clone git@github.com:Burmy/burmy-os.git && cd burmy-os
pnpm install
cp .env.example .env            # placeholders only
docker compose up -d postgres
docker compose run --rm migrate                # migrations run IN the image, never host pnpm
pnpm db:seed                    # synthetic accounts, categories, fake statements
pnpm dev
```

**Migrations always run through the container image**, never host-installed pnpm — so the migration
runtime is identical in development and production, and nothing depends on the owner's host toolchain.

`.gitignore` blocks `.env*` (except `.env.example`), `*.csv`, `*.xlsx`, `*.dump`, `/statements/` at
the repo root **before the first commit**, so a real statement cannot be committed by accident.

---

## 13. Authentication Flow

**Google is configured exactly once — in Cloudflare Access.** Better Auth handles passkey registration,
passkey sign-in and the local session. There is no second OAuth client, no duplicated consent screen,
and no second place for the allowlist to drift out of sync.

```
Browser → app.burmy.me
   │
   ▼
Cloudflare Access — authenticated?
   │ no → Google OAuth (the ONLY Google integration) → email == OWNER_EMAIL ?
   │                                                      no → DENY at the edge
   │ yes ↓
Request reaches Next.js carrying Cf-Access-Jwt-Assertion
   │
   ▼
Verify the Access JWT against Cloudflare's JWKS (signature, aud, iss, exp)
   │  invalid → 403.  Protects the origin if the tunnel is ever reachable another way.
   │  The verified `email` claim is the owner identity. Better Auth never re-asks Google.
   ▼
Better Auth session cookie valid?
   │ no → /sign-in → passkey challenge (WebAuthn, rpID = app.burmy.me)
   │                    credential not bound to the owner → reject + audit
   ▼
Finance
```

**Session:** httpOnly, Secure, SameSite=Lax, **host-only — no `Domain` attribute, never
`.burmy.me`**, 7-day expiry with rolling refresh, stored server-side in Postgres for instant
revocation. Monthly usage means re-authentication is normal; a passkey makes it one touch.

**Sensitive actions require re-authentication:** bulk transaction deletion, account deletion, passkey
removal, full data export, changing `OWNER_EMAIL`.

### Bootstrap and recovery — prototyped before it is locked in

Better Auth's passkey plugin documents **no** recovery, backup-code or lost-passkey guidance. Two
questions must be answered by a working prototype rather than a design assumption:

1. **Bootstrap** — how does the very first passkey get registered when there is no session and no
   password? Candidates to prototype: Better Auth's passkey-first registration
   (`registration.requireSession: false` with a signed context token), versus a one-time enrollment
   token minted by a server-side script.
2. **Recovery** — what happens when every enrolled passkey is lost? Candidate: a Tailscale-only
   server-side script that mints a short-lived single-use login token, requiring Tailscale membership
   **and** an SSH key **and** shell access, never exposed over HTTP.

**This is an explicit deliverable of Milestone 2**: prototype both, document the actual behaviour
observed, then choose. Until then, the only committed decisions are that **at least two passkeys must
be enrolled before onboarding completes** and that **recovery must not depend on email**.

---

## 14. Security Architecture

| Surface | Control |
| --- | --- |
| Network | No inbound ports; `cloudflared` dials out. `ufw` default-deny; SSH bound to the Tailscale interface, key-only, root disabled. Postgres never published to the host. |
| Origin trust | Access JWT verified in **`src/proxy.ts`** against Cloudflare's JWKS. Defends against tunnel misconfiguration. **This is defense-in-depth, not the security boundary** — see the next row. |
| **Server entry-point auth** | **Every protected server entry point independently authenticates and authorizes the owner** — Server Actions, Route Handlers, and any other server-invocable endpoint. Each begins with `await requireOwner()`, validating the session without relying on the proxy. This generalizes a specific Next.js hazard: Server Functions are handled as **POSTs to the route where they are used**, so a `matcher` change or a refactor that moves an action can **silently remove proxy coverage** — but the same exposure applies to any Route Handler the matcher misses, so the rule is stated for all of them rather than for Server Actions alone. **Unprotected endpoints are an explicit, enumerated allowlist**, currently: `/api/health` (liveness + DB reachability + migration state as booleans and a version string only — **no counts, no data, no error text, no environment detail**) and `/api/auth/*` (Better Auth's own flows, which authenticate by design). Anything not on that list is protected. Integration tests invoke every entry point unauthenticated with the proxy bypassed and assert rejection, and assert that the health endpoint's response body contains no sensitive fields. |
| Authorization | **Every Finance query goes through a data-access layer that takes an owner id and injects the `WHERE` clause.** Route handlers and Server Actions never build queries directly. Enforced by API shape and by integration tests that assert cross-owner isolation — **no custom lint rule**. |
| Sessions | httpOnly + Secure + SameSite=Lax + host-only; server-side store → instant revocation and "sign out everywhere". |
| CSRF | Next.js Server Action origin checks + Better Auth's own token. No state-changing GET routes. |
| XSS | React escaping; `dangerouslySetInnerHTML` banned. Strict nonce-based CSP, no `unsafe-inline`/`unsafe-eval`. Statement descriptions are untrusted text everywhere. |
| Headers | HSTS `max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, restrictive `Permissions-Policy`. |
| Rate limiting | Cloudflare at the edge; Better Auth's limiter on auth routes; per-owner limits on upload and export. |
| Upload | See §21. |
| Export | Formula-injection neutralization (§31). |
| Secrets | Never in git. `.env` on the VPS at `0600`, injected via `env_file`. **Secrets and recovery credentials are held in the password manager / offline process and are deliberately NOT bundled into Finance backups** — a stolen backup must not also carry the keys to the system it came from. |
| Audit | `audit_events` for sign-in success/failure, passkey add/remove, recovery use, import commit/discard, bulk category change, rule change, export, transaction delete. Metadata redacted. |
| Logging | Structured JSON. **Never logged:** raw statement rows, full descriptions, amounts at info level, tokens, cookies, `Authorization` headers, connection strings. Errors log a correlation id and a row *number*, never row *content*. |
| Dependencies | Renovate; `pnpm audit` in CI; lockfile committed; `--frozen-lockfile` in the Docker build. |

---

## 15. VPS Recommendation

### Correction: the Oracle PAYG exemption is not supported by Oracle's documentation

Oracle's Always Free page states the reclamation policy plainly:

> *"Idle Always Free compute instances may be reclaimed by Oracle. Oracle will deem virtual machine
> and bare metal compute instances as idle if, during a 7-day period, the following are true: CPU
> utilization for the 95th percentile is less than 20%; Network utilization is less than 20%; Memory
> utilization is less than 20% (applies to A1 shapes only)."*

On upgrading, it says only:

> *"Oracle doesn't charge for Always Free resources after you upgrade, and will only charge you for
> resource usage above the Always Free limits."*

**It does not say that upgrading exempts instances from reclamation**, and it does not distinguish
Always Free resources in a paid account from those in a free account. The widely-repeated claim that
PAYG prevents reclamation is community folklore, and **this plan does not rely on it.**

**Assume the instance will be reclaimed.** A once-a-month app sits near zero on CPU, network and
memory continuously, which is precisely the described condition. One mitigating detail from the same
documentation: a reclaimed instance is **stopped**, and *"you can restart it as long as the associated
compute shape is available in your region"* — so reclamation is an outage plus a capacity gamble,
not automatic destruction. That is survivable but not something to be surprised by.

| Provider | Spec | Free-tier reality (Aug 2026) | $/mo | Verdict |
| --- | --- | --- | --- | --- |
| **Oracle Always Free** | ARM A1, up to 2 OCPU / 12 GB, 200 GB, 10 TB egress | **Halved from 4 OCPU/24 GB on 15 Jun 2026 with no announcement**; over-limit instances terminated from 18 Aug 2026. **Idle instances reclaimed — assume this will happen.** | **$0** | **Chosen**, eyes open |
| Hetzner CX22 | 2 vCPU x86 / 4 GB / 40 GB / 1 TB | n/a | ~$4.59* | **Paid fallback** |
| Vultr HF | 2 vCPU / 2 GB / 64 GB NVMe | n/a | ~$12* | Alternative |
| DigitalOcean Basic | 2 vCPU / 2 GB / 60 GB | n/a | ~$18* | Alternative |
| GCP e2-micro | 2 shared vCPU / **1 GB** | Perpetual, but **1 GB/mo NA egress** | $0 | **Rejected** — cannot run Next.js + Postgres |
| AWS | — | **$200 credits / 6 months, then account shut down** | — | **Rejected** |

\* Third-party sourced; Hetzner's pricing page is JS-rendered and could not be read directly.
**Confirm in the provider console before purchase.**

**Mitigations that actually work, since the PAYG shortcut is unavailable:**

1. **A tested restore is the primary control.** Recovery onto any provider is a rehearsed drill.
2. **Right-size to 1 OCPU / 6 GB.** Ample for one user, and higher relative memory utilization gives a
   marginally better chance of failing the idle test — a hedge, not a guarantee.
3. **A weekly synthetic health probe** from an external free cron generates real request traffic. This
   is a modest, honest attempt at the network-utilization condition, not a promise.
4. **Keep the migration rehearsed.** If Oracle reclaims and capacity is unavailable, moving to a
   ~$5/month host is a 30-minute restore, not an emergency.
5. **PAYG upgrade is optional and its reclamation benefit is unverified.** If chosen (for capacity
   availability, not reclamation), pair it with a compartment quota and a $1 budget alert.

---

## 16. Docker Architecture

### Two networks — the single-network design was broken

`cloudflared` must reach Cloudflare's edge over the public internet. Putting it on a network marked
`internal: true` would have **blocked that outbound connection entirely** and the tunnel would never
have come up. The fix is two networks with different reachability:

```yaml
# compose.yml (shape, not final)
services:
  web:          # Next.js standalone, multi-stage, non-root (uid 1001)
                # networks: [edge, dbnet]
                # depends_on: postgres (service_healthy), migrate (completed_successfully)
                # healthcheck: GET /api/health
                # NO published ports — never reachable from the host
  migrate:      # same image, one-shot `db:migrate`, exits 0
                # networks: [dbnet]
  postgres:     # postgres:18-alpine
                # networks: [dbnet]   ← DB is unreachable from the internet
                # volumes: [pgdata:/var/lib/postgresql]   ← PG18 layout, see below
                # healthcheck: pg_isready
                # NO published ports
  cloudflared:  # tunnel run --token
                # networks: [edge]    ← MUST have outbound internet
                # depends_on: web

networks:
  edge:                        # normal bridge — outbound internet available
  dbnet:  { internal: true }   # no route off the host, in or out

volumes:
  pgdata:
```

`postgres` sits only on `dbnet`, so it has no route to or from the internet. `web` bridges both.
`cloudflared` sits only on `edge`, so it can dial out but has no path to the database.

### Postgres 18 volume layout — a silent data-loss trap

PostgreSQL 18's official image made a **breaking change**: `PGDATA` is now version-specific
(`/var/lib/postgresql/18/docker`) and the declared `VOLUME` moved to `/var/lib/postgresql`.

A named volume mounted at the pre-18 path `/var/lib/postgresql/data` is **silently ignored** — the
container starts normally, appears healthy, and the data disappears the next time it is recreated.

```yaml
volumes:
  - pgdata:/var/lib/postgresql        # ✅ correct for PG 18+
# - pgdata:/var/lib/postgresql/data   # ❌ pre-18 convention — starts fine, loses data
```

This is verified in the first backup/restore test of M1, not assumed: write rows, `docker compose
down && up`, confirm the rows survive.

- **Multi-stage build:** deps → build → runner; `output: 'standalone'` keeps the runtime image small.
- **Migrations run as a one-shot service from the same image** — identical runtime in dev and prod, no
  host toolchain dependency.
- **arm64 on Oracle**, built **on the box** — no registry, no QEMU, and no CI credential that can
  reach the server.
- **Non-root** runtime; `tmpfs` for upload scratch; read-only root filesystem where practical.
- **Postgres major pinned to 18.** Major upgrades require dump/restore — scripted, not improvised.
- Healthchecks on all services; `restart: unless-stopped`; SIGTERM with a 30s drain.

---

## 17. Repository Structure

```
burmy-os/
├── src/
│   ├── proxy.ts                         # ← project convention: level with app/, NOT inside it
│   │                                    #   Access JWT verify, security headers, CSP nonce
│   ├── app/
│   │   ├── (auth)/sign-in/
│   │   ├── (private)/
│   │   │   ├── page.tsx                 # redirect → /finance/monthly
│   │   │   ├── finance/
│   │   │   │   ├── monthly/             # ← THE LANDING VIEW
│   │   │   │   ├── transactions/
│   │   │   │   ├── review/
│   │   │   │   ├── imports/
│   │   │   │   ├── reconcile/
│   │   │   │   └── categories/
│   │   │   └── settings/
│   │   └── api/{auth/[...all], health}/
│   ├── features/finance/                # Finance UI
│   │   └── {components,monthly,review,import,transactions}/
│   ├── server/
│   │   ├── auth/                        # Better Auth (passkey), owner guard, bootstrap
│   │   ├── db/                          # Drizzle client, schema, seed
│   │   │   └── finance/          # OWNER-SCOPED data access
│   │   ├── security/                    # CSP, headers, rate limit, audit, theme
│   │   └── finance/                     # ← domain core: no React/Next/HTTP, NO DB
│   │       ├── money.ts                 # Cents type + ALL arithmetic
│   │       ├── taxonomy.ts              # names, slugs, last_four, reorder
│   │       ├── merchant.ts  dedupe.ts
│   │       ├── adapters/                # boa-deposit, boa-card, generic
│   │       └── import/  categorize/  classify/  reporting/
│   ├── components/   └── lib/
├── drizzle/                             # migrations (committed)
├── tests/{unit,integration,e2e,fixtures}/   # fixtures are SYNTHETIC ONLY
├── scripts/{provision,deploy,backup,restore,verify-restore}.sh
├── docs/{IMPLEMENTATION_PLAN,ARCHITECTURE,SECURITY,FINANCE,DEPLOYMENT,BACKUP_RESTORE,ROADMAP,RUNBOOK}.md
├── Dockerfile  compose.yml  compose.dev.yml  CLAUDE.md  .env.example  .gitignore
```

**Corrected in M3:** an earlier version of this tree put a `queries/` directory inside
`src/server/finance/`. That contradicted `ARCHITECTURE.md`, which places owner-scoped data access in
`src/server/db/` and states that `src/server/finance/` performs "no I/O beyond the repo layer". The
data-access layer is therefore `src/server/db/finance/`, and the domain core holds no Drizzle imports
at all — which is what keeps it testable in milliseconds without a database.

**Not a monorepo.** One deployable, no shared packages, no reason.

The load-bearing boundary: **`src/server/finance/` is pure TypeScript — no React, no Next.js, no
HTTP.** Money math, normalization, deduplication, categorization and classification are testable
without a browser or a server. That is what makes financial correctness verifiable.

---

## 18. Database Schema

Better Auth owns `user`, `session`, `account`, `passkey`, `verification`.

| Table | Purpose | Notes |
| --- | --- | --- |
| `finance_accounts` | Logical sources | `name`, `institution`, `type`, `last_four` **nullable**, `is_active`, `sort_order`. **Never a full account number.** |
| `finance_categories` | The grid's row axis | `name`, `slug`, `kind` (spending\|income\|investment), `parent_id` **nullable** (schema-only in V1), `sort_order`, `archived_at`. Unique on `(owner_id, lower(name))` where not archived. **Archive, never delete.** |
| `finance_imports` | One **batch** = one review session | `status` (uploaded\|parsing\|review\|committing\|committed\|failed\|discarded), date range, row count, `expires_at` |
| `finance_import_files` | Files in a batch | `original_filename`, `file_sha256`, `adapter`, `row_count`. **Multi-file batches are required for transfer/card-payment matching.** |
| `finance_import_rows` | **Sanitized** staging | See below |
| `finance_transactions` | **Source of truth** | See §20 |
| `finance_transaction_splits` | V1.1 | Must sum exactly to the parent |
| `finance_rules` | User rules | `field`, `operator`, `value`, `category_id` **nullable**, `transaction_type` **nullable**, `account_id` **nullable**, `priority`, `enabled` |
| `finance_merchant_memory` | Learned corrections | `merchant_key`, `category_id`, `confirmed_count`. **This is what makes month 6 nearly zero-review.** |
| `finance_balance_snapshots` | Point-in-time state | `(account_id, as_of_date)` unique. **Never derived from flows.** |
| `finance_expected_totals` | Excel ground truth | `period_month`, `category_label` (raw), `category_id` **nullable**, `expected_cents` |
| `finance_format_signatures` | Remembered CSV layouts | Normalized header-set hash → column mapping |
| `audit_events` | Security trail | Redacted metadata |

### Staging is sanitized, not raw

**The `raw` jsonb blob is removed.** Storing every parsed cell means retaining columns Burmy has no
use for — address fragments, internal bank codes, card identifiers — in a table that lives for weeks.
That contradicts §18 of the specification.

`finance_import_rows` stores **only the normalized fields the pipeline needs**:

```
import_id, file_id, row_number
transaction_date, posted_date, description, amount_cents, detected_direction
source_category, source_transaction_id        ← bank-provided id when present
normalized_merchant, merchant_key             ← EVOLVING: categorization + display only
dedupe_key, dedupe_key_version                ← IMMUTABLE: identity only (see §23)
suggested_category_id, suggested_type, confidence, categorization_source
duplicate_of_transaction_id, duplicate_kind
decision (pending | include | exclude), review_note
parse_error                                   ← message only, never the offending content
```

**`dedupe_key` and `merchant_key` are deliberately separate and must never be conflated.**
`merchant_key` changes whenever a normalization rule is added — that is its job. If identity were
derived from it, adding one strip rule would silently break duplicate matching against every
previously imported transaction. `dedupe_key` is computed once, from the raw description, under a
frozen versioned algorithm, and persisted. Details in §23.

Unmapped source columns are **discarded at parse time and never persisted.** On commit, staging rows
are reduced to what `finance_transactions` needs and the remaining transient columns
(`detected_direction`, `source_category`, `confidence`, `parse_error`) are dropped with the staging
row. Discarded and expired imports are deleted wholesale.

**Retention: 60 days, or explicit discard by the owner** — corrected from 7 days, which would have
deleted an in-progress review before a monthly user ever returned to it. `expires_at` is set on
creation and extended on every edit.

**Ownership (§53):** every Finance table carries `owner_id`. Enforcement lives in the data-access
layer, verified by integration tests that assert cross-owner isolation. One column, one `WHERE`
clause, no tenancy machinery, and **no custom lint rule**.

**Indexes:** `(owner_id, transaction_date)`, `(owner_id, category_id, transaction_date)`,
`(owner_id, account_id, transaction_date)`, `(owner_id, dedupe_key)` **non-unique**,
`(owner_id, account_id, source_transaction_id)` **non-unique — see §23**,
`(owner_id, review_status) WHERE review_status = 'needs_review'`.

> **No unique constraint on `source_transaction_id` in the initial schema.** It is added only after
> Milestone 4 verifies stability, uniqueness and coverage against real overlapping BoA exports, per
> account type (§23). A constraint added on the strength of a column's *name* would either reject
> legitimate rows or silently merge distinct transactions.

---

## 19. Money Model

**Signed `BIGINT` minor units (cents). Positive = outflow. Not `NUMERIC`.**

1. **Exact.** Integer arithmetic has no rounding bug class; `SUM(bigint)` is exact and fast.
2. **`NUMERIC` is a boundary hazard.** The `pg` driver returns it as a **string**. Every aggregate
   would need parsing, and the obvious `parseFloat` is precisely the floating-point bug the spec
   forbids. The type that looks safest introduces the failure mode.
3. **JS-safe.** Cents fit `Number.MAX_SAFE_INTEGER` to ~$90 trillion.

**Sign convention falls out of the confirmed reimbursement rule:**

```
Food — August
  Velvet Taco        +6000
  Zelle from Alex    -3000     ← reimbursement, same category
  H-E-B              +5914
  ──────────────────────────
  SUM(amount_cents) = 8914 → $89.14    ✓ plain SUM, no special cases
```

A `direction` column is **deliberately absent** from `finance_transactions` — it is
`sign(amount_cents)`, and duplicating it invites disagreement. `detected_direction` lives on staging
only, where the adapter records the convention it observed so the normalizer can **assert** rather
than assume (BoA uses a single signed column in some exports and separate Debit/Credit columns in
others).

One `money.ts` exports a branded `Cents` type and every operation. Nothing else does money
arithmetic. Splits use **largest-remainder allocation** so children sum to the parent exactly.

---

## 20. Transaction Model

```
finance_transactions
  id, owner_id, account_id, import_id (nullable)
  transaction_date        posted_date (nullable)
  original_description    normalized_merchant (nullable)
  amount_cents (bigint, signed)     currency char(3) default 'USD'
  transaction_type (enum)           category_id (nullable)
  source_transaction_id (nullable)  ← bank-provided id, when available
  counterpart_transaction_id (nullable, self-ref)
  review_status (auto | needs_review | confirmed)
  categorization_source · categorization_confidence · type_source
  notes (nullable)
  dedupe_key, dedupe_key_version    ← immutable identity, never recomputed in place
  created_at, updated_at
```

| Type | In category grid? | In Expenses? | In Total Outflow? |
| --- | --- | --- | --- |
| `expense` | **Yes** | Yes | Yes |
| `refund` | **Yes** (negative → reduces category) | Yes (net) | Yes (net) |
| `fee` | **Yes** | Yes | Yes |
| `income` | **Its own section** (see below) | No | No |
| `transfer` | **No** | No | No |
| `credit_card_payment` | **No** | No | No |
| `investment` | **Yes** (e.g. a `Stocks` row) | **No** | **Yes** |
| `adjustment` | Yes | Yes | Yes |

**§23 — Card payments cannot double-count.** Card purchases ($20 + $100 + $80 = $200) are `expense`.
The checking-side $200 payment is `credit_card_payment`. The card-side "PAYMENT THANK YOU" credit is
also `credit_card_payment`. Both payment legs are excluded everywhere, so the total stays **$200** —
not $400, not $0.

**§25 — Investments** produce the requested reporting:

```
Expenses          $4,183
Investments         $800     ← the Stocks row still appears in the grid
──────────────────────────
Total Outflow     $4,983
```

**§26 — Refunds are not income.** A refund carries the *same category* as the purchase and nets the
category down. Explicit refund→purchase linking is V1.1; the arithmetic is already correct.

---

## 21. Import Architecture

```
UPLOAD (multi-file: checking + card + savings together)
  │  ≤10 MB/file, ≤10 files, extension allowlist, magic-byte sniff
  │  → temp file, 0600, outside webroot, random name
  ▼
HASH each file → already committed? warn BEFORE parsing
  ▼
PARSE  Papa Parse (streaming) · 50k row cap · 4KB cell cap
  │  adapter chosen by HEADER SIGNATURE, never by filename
  ▼
NORMALIZE  dates · sign convention asserted · merchant normalized · Cents
  │  UNMAPPED SOURCE COLUMNS ARE DISCARDED HERE — never persisted
  ▼
STAGE → finance_import_rows (sanitized shape, single DB transaction)
  ▼
DELETE the temp file — always, including on failure (finally)
  ▼
DEDUPE   count/multiset reconciliation + source ids  (§23)
  ▼
CLASSIFY transfers · card payments · investments
  │  matched against THIS BATCH **and** COMMITTED HISTORY (±7 days)
  ▼
CATEGORIZE rules → memory → history → source category → heuristics → Needs Review
  ▼
PREVIEW  server-rendered from staged rows — survives refresh, deploy, device change
  ▼
REVIEW   edits mutate staged rows only; expires_at extended on each edit
  ▼
COMMIT   one DB transaction: staged → finance_transactions,
         update merchant memory, drop transient staging columns, status='committed'
```

**Persistence at each stage:** the raw file exists only between upload and parse. Sanitized staged
rows live in Postgres until commit or discard (60-day expiry). Only normalized transactions persist
long-term. Import metadata retained: source, filename, timestamp, date range, row count, status —
**never the file, never account numbers, never statement addresses**.

**Why staged in Postgres, not memory:** an in-memory preview loses a 500-row import to a refresh, a
deploy or a phone locking; pushes the file through a request body twice; and turns commit into one
large failure-prone write. Staging makes it recoverable and resumable across devices, and reduces
commit to a short set-based insert.

**Failure handling:** failures mark the import `failed` with a message, leaving staged rows for
inspection. Commit is one transaction — nothing partially enters `finance_transactions`.

**Upload security:** every file is hostile input. Size, count, extension, magic bytes, row count, cell
length, encoding (UTF-8 + BOM), date sanity (reject >1 year future, >30 years past), amount sanity.
Never written to `public/` or any statically served path. XLSX parsed with **formulas never
evaluated** and external links ignored; uncompressed-size limits guard against zip bombs.

---

## 22. Adapter Architecture

```
                       Uploaded CSV
                            │
                    HEADER SIGNATURE  (normalized column-name set → hash)
                            │
        ┌───────────────────┼───────────────────┐
   BoA deposit         BoA card            Generic CSV
   Date/Description/   Posted Date/        ┌──────────────────────┐
   Amount              Payee/Amount        │ Which column is the  │
                       or Debit+Credit     │ transaction date?    │
        │                   │              │ [ Posting Date  ▼ ]  │
        │                   │              │ [✓] Remember format  │
        └───────────────────┼──────────────┴──────────┬───────────┘
                            ▼                         │
                  NormalizedTransaction ◀─────────────┘
```

**Signatures, not filenames** — a renamed file must still be recognized, and an unrecognized file must
never be silently mis-parsed. Confirmed mappings persist in `finance_format_signatures`.

> **Open item, non-blocking.** BoA's exact column layout could not be verified from an authoritative
> primary source; results were dominated by third-party converter marketing pages. Established:
> layouts differ by product, some exports use separate Debit/Credit columns, descriptions embed
> reference numbers and city/state, and online history reaches back only ~12–18 months. **Milestone 4
> begins by reading one real redacted export.** The generic mapper means this cannot block progress.

**Sign convention is detected and asserted, never assumed.** A credit-card export where every row is
an inflow fails the import loudly rather than silently inverting a month of spending.

---

## 23. Duplicate Detection

**Corrected design: source ids first, then count-based multiset reconciliation.** The previous
`occurrence_index` approach was persistent positional state — deleting or editing one transaction
would shift indices and silently corrupt future matching.

**Tier 1 — source transaction id (authoritative *only once proven*).**

A column named "Reference Number" is not evidence that it is a stable, unique transaction identifier.
It could be a batch id, a merchant reference reused across transactions, or a value that changes
between exports of the same period. **Trusting it on the strength of its name — and enshrining that
trust in a unique database constraint — would reject legitimate transactions or silently merge
distinct ones.**

So Tier 1 is **gated on verification in Milestone 4**, against real overlapping exports for each BoA
account type:

1. **Stability** — export the same date range twice, on different days. The identifier for a given
   transaction must be byte-identical both times.
2. **Uniqueness** — across overlapping exports covering the same account, no identifier may appear on
   two genuinely different transactions.
3. **Coverage** — the proportion of rows that actually carry one (a mostly-empty column is not a
   dedupe key).

**Until all three pass for an account type, `source_transaction_id` is stored as advisory metadata
only and Tier 2 does all the work. No unique constraint is created.** If verification passes, the
constraint `unique (owner_id, account_id, source_transaction_id) where source_transaction_id is not
null` is added in a later migration, per account type, with the evidence recorded in `docs/FINANCE.md`.
Tier 2 remains the fallback for rows without an identifier either way.

**Tier 2 — count-based multiset reconciliation (when no source id).**

**Identity is derived from the raw description, never from `merchant_key`.** Merchant normalization is
*meant* to evolve — every new strip rule improves categorization. If identity depended on it, adding a
single rule would change the key for every future import and silently stop matching against years of
already-committed transactions, quietly reintroducing duplicates. So the two are separated:

| | `dedupe_key` | `merchant_key` |
| --- | --- | --- |
| Purpose | **Identity only** | Categorization matching + display |
| Input | Raw `original_description` | Aggressively normalized merchant |
| Normalization | **Frozen**: trim, uppercase, collapse internal whitespace. Nothing else, ever. | Evolving: strips prefixes, store numbers, city/state, ref numbers |
| Lifecycle | Computed **once at import**, persisted, never recomputed in place | Recomputable at any time |
| Versioned | Yes — `dedupe_key_version` | No |

```
dedupe_key = hash( account_id,
                   transaction_date,
                   amount_cents,
                   sha256(collapse_ws(upper(trim(original_description)))) )   -- NOT unique

For each dedupe_key in the batch:
    staged_count     = rows in this batch with that key
    committed_count  = existing transactions with that key in the same date window
    surplus          = staged_count − committed_count

    surplus ≤ 0  → all already present  → excluded by default, shown, one click to include
    surplus > 0  → import exactly `surplus` rows; the remainder are marked duplicates
```

This is safe because a bank emits a byte-identical description string for the same transaction every
time it is exported — that string is the most stable identity signal available short of a source id.

**If the algorithm must ever change**, `dedupe_key_version` bumps and a migration recomputes *every*
row in one pass, so all rows always share one version. `original_description` is retained precisely to
make that possible. Mixed-version comparison is never permitted.

Two genuine $5 coffees on the same day produce `staged_count = 2`; if one is already committed, one
is imported. No positional index, nothing to corrupt, and re-running is naturally idempotent.

**Tier 3 — near matches.** Same account, same amount, date ±3 days, similar merchant → **flagged,
requires a decision. Never auto-excluded.**

**Plus a file-level pre-check:** an already-committed `file_sha256` warns *before* parsing.

**Nothing is ever silently destroyed.** Every exclusion is visible and reversible in the preview.

---

## 24. Categorization Architecture

```
1. USER RULE          → confidence 100, source='rule'     ← always wins
2. MERCHANT MEMORY    → 95   (exact merchant_key previously confirmed)
3. HISTORY            → 85   (≥3 prior confirmed, same merchant, unanimous)
4. SOURCE CATEGORY    → 60   (BoA's own category, via user-editable mapping)
5. HEURISTICS         → 70
6. AI (V1.1, off)     → capped 50, NEVER overrides 1–5
7. NEEDS REVIEW
```

Below the threshold (default 70) → Needs Review regardless of source. `categorization_source` and
`categorization_confidence` are stored so the review UI can explain *why*, and a bad rule can be found
later.

### Exclusionary types demand deterministic evidence

**Category suggestions and type decisions do not carry the same consequence.** A wrong category moves
money between two visible rows and is obvious in the grid. A wrong **exclusionary type** — `transfer`,
`credit_card_payment`, `investment` — removes money from spending entirely, where it is invisible and
silently understates every total.

Those three types are therefore **never assigned by graded heuristic.** They require one of:

1. an explicit user rule naming the type, **or**
2. a **qualified counterpart match** (defined below), **or**
3. **explicit confirmation in the review queue.**

#### A qualified counterpart match — amount and date alone are not enough

Equal amount, opposite sign and a nearby date are **coincidence-prone**. A $200 rent payment and a
$200 card payment on the same day satisfy all three and have nothing to do with each other. Auto-pairing
on that evidence would silently delete $200 of real spending. So a match requires **all** of the
following:

**Structural conditions (necessary, never sufficient):**
- equal absolute `amount_cents`
- opposite sign
- both accounts owned by the owner
- dates within ±7 days
- **account-type compatibility** — `credit_card_payment` requires exactly one `credit_card` account
  and one deposit account; `transfer` requires two non-card accounts; `investment` requires a
  `brokerage` account on one leg

**Plus at least one semantic signal:**
- a recognized keyword on either leg's description (`PAYMENT`, `TRANSFER`, `XFER`, `ONLINE BANKING
  TRANSFER`, `AUTOPAY`, `EPAY`, `PMT`), **or**
- the counterpart account's name fragment or last-four appearing in the other leg's description

**Plus uniqueness:**
- **exactly one** candidate counterpart. Two or more candidates → **review item**, never a guess.

If the structural conditions hold but no semantic signal is present, or the candidate is ambiguous,
the result is a **review item with the suspected counterpart shown side by side** — the owner confirms
in one keystroke. `type_source` records which of the three paths applied.

The asymmetry is deliberate: the cost of asking is one review card; the cost of guessing wrong is a
permanently understated year that nobody notices.

**Merchant normalization** is table-driven and pure — strips processor prefixes (`TST*`, `SQ *`,
`SP `), trailing store numbers, city/state, reference and phone numbers, then uppercases and
collapses whitespace. Emits `normalized_merchant` (readable: `VIA 313`) and `merchant_key`
(aggressive, for matching). Every rule is a test case.

**Learning (§33):** changing a suggested category offers *Always categorize merchants matching
"VIA 313" as Food?*. Accepting writes `finance_merchant_memory` — memory is learned and per-merchant;
rules are explicit and user-authored. Month 1 might need 20 decisions; month 6 should need 2. That
convergence is the product.

---

## 25. Review Workflow

Built for **one long monthly sitting**.

```
IMPORT READY — August 2026 · 3 files · 172 transactions

  158  categorized automatically
    9  need a category
    3  possible transfers          ← must be confirmed, never auto-excluded
    2  possible duplicates
                                              [ Review 14 ]
```

```
┌──────────────────────────────────────────────┐
│  3 of 14                    ← →  navigate    │
│  SQ *K1 SPEED                                │
│  Aug 08 · BoA Checking · $48.95              │
│                                              │
│  Suggested: Entertainment                    │
│  why: 2 similar past transactions            │
│                                              │
│  Category  [ Entertainment      ▼ ]  ⌘K      │
│  Type      [ Expense            ▼ ]          │
│  [✓] Remember merchant "K1 SPEED"            │
│  [ Skip ]                     [ Confirm ⏎ ]  │
└──────────────────────────────────────────────┘
```

Keyboard-first (`↑↓`, `⌘K`, `⏎`, `1–9` recent, `⌫` skip). Bulk actions on merchant groups. Duplicates
and suspected transfers get their own passes with side-by-side comparison — they are judgement calls,
not category picks. Mobile gets the same flow as a card stack.

---

## 26. Monthly Spreadsheet Architecture

**The grid is a VIEW.** Nothing is stored. It is also the landing route.

**One query feeds both sections.** An earlier draft omitted `income` from the type list while also
sourcing the Income section from this result — the Income rows would always have been empty. `income`
is included; the *sections* are split downstream on `finance_categories.kind`, not by running the
query twice.

```sql
SELECT c.id, c.name, c.kind,
       date_trunc('month', t.transaction_date) AS period,
       SUM(t.amount_cents) AS total_cents
FROM finance_transactions t
JOIN finance_categories c ON c.id = t.category_id
WHERE t.owner_id = $1
  AND t.transaction_date >= $2 AND t.transaction_date < $3
  AND t.transaction_type IN (
        'expense','refund','fee','adjustment',   -- → Spending section (kind='spending')
        'investment',                            -- → Spending section (kind='investment')
        'income'                                 -- → Income section   (kind='income')
      )
  -- 'transfer' and 'credit_card_payment' are absent by design:
  -- they are neither spending nor income, and including them would double-count.
GROUP BY 1,2,3,4;
```

Postgres does the arithmetic; ~40 rows × 12 months are pivoted in TypeScript, which splits rows into
the Spending and Income sections by `kind`, flips the sign on Income rows for display, and derives
`Expenses`, `Investments`, `Total Outflow`, `Total Income` and `Net`.

**Transfers and card payments are excluded in exactly one place — this `IN` clause.** That is where
the double-counting guarantee lives, and it is covered by tests.

### How Income appears — exact V1 layout

Income was confirmed as first-class tracking, so it needs a defined place rather than "its own
section" left vague. The grid renders **two sections from the same query**, split on
`finance_categories.kind`:

```
                         JAN        FEB        MAR

SPENDING
  Mortgage             $2,019     $2,019     $2,019
  Car Payment            $791       $791       $791
  Gas                    $217        $71       $194
  Food                   $149       $214       $298
  Travel               $2,622         $0       $381
  ───────────────────────────────────────────────────
  Expenses             $5,798     $3,095     $3,683
  Stocks (investment)    $800       $800       $800     ← kind='investment'
  ───────────────────────────────────────────────────
  Total Outflow        $6,598     $3,895     $4,483

INCOME                                                  ← collapsible section
  Paycheck             $6,400     $6,400     $6,400
  Interest                 $12        $11        $13
  ───────────────────────────────────────────────────
  Total Income         $6,412     $6,411     $6,413

  ═══════════════════════════════════════════════════
  Net                    -$186    +$2,516    +$1,930
```

Precise rules:

- **Sign is flipped for display in the Income section only.** Stored income is negative (money in,
  per §19's convention); a paycheck must read `$6,400`, not `-$6,400`. The flip happens in the view
  layer; the stored sign is never touched.
- **`Expenses`** = sum of `kind='spending'` rows (types `expense`, `refund`, `fee`, `adjustment`).
- **`Investments`** rows sit inside the Spending section — they are outflows and the owner wants a
  `Stocks` row — but are excluded from `Expenses` and included in `Total Outflow`.
- **`Total Outflow`** = `Expenses` + `Investments`.
- **`Net`** = `Total Income` − `Total Outflow`, the only row that mixes the two sections.
- **Income cells drill down identically** to spending cells.
- **`transfer` and `credit_card_payment` appear in neither section** — they are not spending and not
  income.
- The **Income section is collapsible**, defaulting to expanded. Collapsing hides `Net` as well,
  returning the grid to a pure spending view.

**A purpose-built component, not a data grid.** At 40 × 12 there is nothing to virtualize, and the
headline interaction is *clicking a cell*, which a grid engine obstructs. Sticky first column and
header, `tabular-nums`, right-aligned currency, Expenses / Investments / Total Outflow subtotals,
keyboard cell navigation. This also sidesteps AG Grid's pivoting being an Enterprise feature.

---

## 27. Cell Drill-down

```
Food — January 2026                                    ✕
  Jan 03   Taco Bell                          $11.34
  Jan 07   Starbucks                           $9.16
  Jan 12   Whole Foods                        $46.82
  Jan 19   Velvet Taco                        $22.49
  Jan 26   H-E-B                              $59.14
  ─────────────────────────────────────────────────
  Total                                      $148.95
  [ Open in Transactions ]        [ Export cell ]
```

A side panel; rows editable in place; a category change updates the grid total immediately
(optimistic, reconciled with the server). Always current — never a hand-maintained comment.

---

## 28. Transactions Table

**TanStack Table + Virtual.** Columns: Date · Merchant · Description · Amount · Category · Type ·
Account · Import · Review · Notes. Sorting, multi-filter, search, inline category/type edit, bulk
category change, column visibility, virtualization.

**Why not AG Grid Community:** row grouping, pivoting, master/detail and the server-side row model are
Enterprise ($999/dev/yr). Today's needs fit Community, but the natural next asks all land on the paid
side. TanStack is MIT with no cliff, ships a smaller bundle, and **its headless row model drives the
mobile card list from the same definitions**, so filters and sorting behave identically on both. Cost:
selection UX, column resizing and keyboard nav are hand-built (~1–2 days).

**Mobile** gets a card list with a filter sheet and tap-to-edit — not a squeezed grid.

---

## 29. Finance Overview

**Not a V1 route.** The monthly grid is the landing experience and carries the summary. A separate
Overview, if ever wanted, is V1.1 — and would be limited to current-month spend with a previous-month
delta, trailing 6-month average, investments YTD, review count, and latest balance snapshots. **At
most one chart**, added only if it earns its place.

---

## 30. Existing Excel Migration

**No aggregate-import path is built.** All original CSVs exist, so history enters through the normal
importer as real, drillable transactions — one code path, no second reporting layer.

The Excel sheets serve a better purpose: **ground truth.**

```
RECONCILIATION — 2025
Category      Excel       Burmy        Delta
Mortgage     $2,019      $2,019            —
Gas            $217        $217            —
Food           $149        $161      +$12.14   → 1 transaction categorized differently
Travel       $2,622      $2,180     -$442.00   → 2 transactions missing from import
                                    ────────
                          14 of 16 categories match
```

Excel totals import into `finance_expected_totals` (raw label preserved, mapped once via a mapping
UI). For each non-zero delta the view offers candidate explanations: uncategorized transactions that
month, transactions in that category assigned elsewhere, or date-coverage gaps.

This validates the importer, duplicate detection, categorization, classification and money arithmetic
against **years of human-verified data** — the strongest correctness signal available, and it exists
only because the owner already did the work by hand. If a month turns out to lack a CSV, its numbers
are already in `finance_expected_totals` and an aggregate display path can be added later without a
schema change.

---

## 31. CSV / XLSX Import & Export

**Import:** Papa Parse (CSV), ExcelJS (XLSX — **provisional**).

> **Dependency gate (M9).** Before XLSX work begins: check ExcelJS's current release cadence, open
> advisories and `pnpm audit` status. If it has gone stale, evaluate `write-excel-file` /
> `xlsx-populate` / SheetJS-from-own-CDN. **The npm `xlsx` package remains prohibited** — abandoned at
> 0.18.5 with unfixed prototype-pollution and ReDoS advisories. ExcelJS is confined to one adapter
> module so replacing it touches a single file.

**Export:** transactions to CSV and XLSX, monthly summary to XLSX, per-cell export from drill-down.

**Formula injection is handled at the writer.** `=HYPERLINK("http://evil","refund")` in a merchant
description is inert in Postgres and inert in Burmy's UI — it becomes dangerous only when the export
is opened in Excel. Any cell starting with `= + - @ TAB CR` is prefixed with a single quote. Applies
to **every** string cell including headers and category names. Tested with a payload fixture.

---

## 32. AI

**Not in V1.** The first five pipeline stages are deterministic and improve every month as merchant
memory fills. The residual tail is a handful of novel merchants per month — exactly where a
three-second human decision creates a permanent rule. Adding a provider dependency, a key, a privacy
surface and non-determinism to the subsystem that most needs predictability, *before* measuring the
tail, is backwards.

Correct order: ship deterministic categorization, measure the real Needs-Review count after two or
three months, then decide. It may simply not be needed.

If ever enabled: minimal payload (`{merchant, amount, allowedCategories}`), structured response
(`category, confidence, reason`), confidence capped at 50, **never** overriding a rule/memory/history/
heuristic, **never** assigned an exclusionary type, and **never** performing arithmetic — SUM, AVERAGE
and all totals remain Postgres's job permanently.

---

## 33. Backup Architecture

**Sequenced so it protects what is irreplaceable first, without stalling early feature work.**

**Immediately (Milestone 1) — the owner's local CSV archive.** BoA serves only ~12–18 months of
history; anything older exists **only** on the owner's disk. That archive is more irreplaceable than
the database, which can be rebuilt from it. This is a manual, verified copy to two destinations (one
off-site) plus a checksum manifest. It requires no VPS, no restic, and no infrastructure — so it
happens on day one.

**Local development (Milestone 1) —** a one-command `pg_dump` script, so local work is never lost.

**Full automation (Milestone 10, before the first production import) —**

```
  Nightly (systemd timer — better logging and failure visibility than cron)
      ├─ pg_dump -Fc
      ├─ restic backup (AES-256, client-side, deduplicated) → b2:burmy-backups
      ├─ restic forget --prune   → 7 daily · 4 weekly · 12 monthly · 3 yearly
      └─ healthcheck ping → alert if a night is missed
```

**Retention evaluated:** 7/4/12 is sound; a compressed dump is single-digit megabytes so retention is
effectively free. **3 yearly snapshots are added**, because the failure mode that matters is silent
corruption discovered months later, and 12 monthly snapshots may not reach far enough back.

**Secrets are deliberately excluded from this backup path.** The `.env`, the tunnel credential and the
restic password itself live in the password manager and the offline recovery process. Bundling them
with the data would mean a single stolen backup carries both the ciphertext and the keys.

**Verification is part of the backup, not a hope:** a weekly job restores the latest snapshot into a
scratch database and asserts table counts and per-year `SUM(amount_cents)` checksums. A backup is not
green until it has been restored.

---

## 34. Disaster Recovery

> *The VPS disappears completely tomorrow.*

**Target: under 30 minutes. Rehearsed in Milestone 10, then quarterly.**

```
1. PROVISION  ./scripts/provision.sh   → docker, ufw, tailscale, users, timers
2. SECRETS    Restore .env and the restic password from the password manager
              (offline process — never from the data backup)
3. CODE       git clone git@github.com:Burmy/burmy-os.git
4. DATA       ./scripts/restore.sh --latest   → restic restore → pg_restore
5. DEPLOY     ./scripts/deploy.sh             → build on box, migrate via container, up
6. NETWORK    New tunnel token → cloudflared. DNS follows the tunnel.
              Access policy unchanged. tailscale up, approve node.
7. VERIFY     ./scripts/verify.sh
              · row counts vs the backup manifest
              · SUM(amount_cents) checksum per year
              · latest transaction date
              · passkey auth round-trip
              · monthly grid totals match the reconciliation baseline
```

**Single points of failure and their answers:** the restic password (password manager + printed
copy); the domain (Cloudflare recovery codes, offline); the passkey (two enrolled devices minimum,
plus whatever break-glass the Milestone 2 prototype settles on).

Every step is a script, not a paragraph — which is what "limited Linux experience" requires.

---

## 35. CI/CD

**GitHub Actions on every push:** typecheck, lint, `vitest run`, `next build`, `pnpm audit`. Playwright
on PRs. **CI holds no deployment credentials and cannot reach the VPS** — a compromised Action cannot
touch the server.

**Deployment is one command from the owner's PC over Tailscale:**

```bash
./scripts/deploy.sh
  → preflight: clean tree, tests green, Tailscale up
  → ssh over Tailscale → git pull → docker compose build   (arm64, on the box)
  → pg_dump                                  (safety artifact — NOT an auto-rollback target)
  → docker compose run --rm migrate          (migrations run IN the image)
  → docker compose up -d
  → healthcheck /api/health, 30s
  → FAIL → roll back the IMAGE only, leave the database untouched, alert, stop
```

### The database is never restored automatically

An earlier draft rolled the database back to the pre-migration dump when the healthcheck failed.
**That was dangerous and is removed.** A failed healthcheck usually means a bad build, a missing env
var, or a transient startup race — the database is typically fine and may already contain newer
writes. Restoring a dump in that situation destroys real data to fix a problem the data had nothing
to do with, automatically, at the moment the owner is least able to reason about it.

The corrected behaviour:

- **On healthcheck failure:** restart the previous image tag, leave Postgres completely untouched,
  print the correlation id and the last 200 log lines, exit non-zero. Nothing is destroyed.
- **The pre-migration `pg_dump` is a safety *artifact*, not a rollback trigger.** It is retained and
  its path printed, so a human can choose to use it.
- **If the migration itself failed**, the script says so explicitly and stops — because rolling the
  image back under a partially-migrated schema is its own hazard, and that call belongs to a person.
- **Restoring the database is always a separate, explicit command** (`./scripts/restore.sh`) with a
  typed confirmation. It is never a side effect of a deploy.

No registry, no cross-compilation, no CI secrets, no host toolchain.

---

## 36. Testing Strategy

`src/server/finance/` is framework-free, so all of this runs in milliseconds without a browser.

**Unit — the core**

| Area | What is pinned |
| --- | --- |
| Money | parse, format, add, sum, negate; negatives; zero; largest-remainder residual |
| Merchant normalization | processor prefixes, store numbers, city/state, reference numbers |
| Dedupe | source-id path; **count reconciliation** with genuine same-day repeats; cross-account non-collision; repeat import → 0 new |
| Adapters | BoA deposit, BoA card, generic; signed **and** Debit/Credit variants; **wrong-sign file fails loudly** |
| Categorization | rule priority; memory promotion; threshold behaviour |
| **Type classification** | **exclusionary types require rule, matched counterpart, or explicit confirmation — a bare heuristic produces a review item, never an exclusion** |
| Classification correctness | **§23 yields $200, not $400**; transfers excluded; investments out of Expenses but in Total Outflow; refunds reduce their category; counterpart matching against committed history |
| Aggregation | monthly and category totals; type exclusions; empty months; month boundaries; timezone independence |
| **Income & Net** | Income rows appear in the Income section and **never** in Spending; sign-flip is display-only and leaves stored values negative; `Total Income`, `Expenses`, `Investments`, `Total Outflow` and **`Net` = Income − Outflow** each verified against a hand-computed fixture; a month with income but no spending, and a month with spending but no income, both render correctly; collapsing the Income section hides `Net` and leaves spending totals unchanged |
| Export | formula-injection across `= + - @ TAB CR` |

**Integration (real Postgres via Testcontainers):** staged → commit atomicity; failed commit leaves
zero rows; idempotent re-import; **cross-owner isolation** (the data-access layer must make an
unscoped read impossible); **every Server Action rejects an unauthenticated call with the proxy
bypassed**; `dedupe_key` stability across a `merchant_key` normalization change (add a strip rule,
re-import, assert zero new duplicates); 60-day expiry sweep does not touch active imports.

**E2E (Playwright, three journeys):**
1. Passkey sign-in → upload three fake CSVs → preview → review an unknown merchant → commit →
   **the monthly grid updates** → drill into the changed cell.
2. Re-upload the same file → zero new transactions.
3. Import the Excel baseline → reconciliation shows zero deltas against the fixture set.

**Fixtures are synthetic, always** — `fake-boa-checking.csv`, `fake-boa-card.csv`, `generic-bank.csv`,
`duplicate-import.csv`, `transfers.csv`, `refunds.csv`, `investments.csv`, `formula-injection.csv`,
`malformed.csv`.

---

## 37. Observability

- **`/api/health`** — process, DB connectivity, last migration. Used by Docker and `deploy.sh`.
- **Structured JSON logs** to journald, rotated, with §14 redaction.
- **Backup healthcheck ping** — a missed nightly backup is the one failure worth alerting on.
- **Error pages surface a correlation id**, so problems are traceable without logs holding financial
  content.
- **No APM, tracing or metrics stack in V1.**

---

## 38. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **Oracle reclaims the instance** — a monthly app sits under all three idle thresholds continuously, and **no documented PAYG exemption exists** | **High** | Medium | Assume it happens. Reclaimed instances are *stopped* and restartable subject to regional capacity. Tested restore + rehearsed 30-min migration to a ~$5/mo host is the real control. |
| **Oracle changes free limits again without notice** (already did, Jun 2026) | Medium | Medium | Provider-agnostic architecture; rehearsed migration |
| **Passkey lost / bootstrap fails** — Better Auth documents no recovery | Medium | **Critical** | **Prototyped in M2 before the design is locked**; two passkeys required at onboarding; recovery must not depend on email |
| **Silent double-counting** (transfers, card payments) | Medium | **Critical** | Exclusion lives in one SQL clause; **exclusionary types require deterministic evidence**; reconciliation against years of hand-verified totals catches it empirically |
| **Sign-convention inversion** on a BoA variant | Medium | High | Detected and asserted per adapter; an all-inflow card file fails the import |
| **BoA changes its CSV format** | Medium | Medium | Header-signature detection fails loudly; generic mapper always available |
| **Loss of the local CSV archive** (older than BoA's ~18-month window — genuinely unrecoverable) | Low | **Critical** | **Backed up in Milestone 1, before any feature work** |
| **Cloudflare/VPS provider access to plaintext** | Certain (inherent) | Medium | Acknowledged in §10, not hidden; alternatives documented with their costs |
| **Formula injection into Excel** | Low | Medium | Neutralized at the writer, tested |
| **Secret committed to git** | Low | High | `.gitignore` hardened before first commit; secret scanning in CI; repo private |
| **ExcelJS goes unmaintained** | Medium | Low | Provisional, isolated behind one module, **review gated at M9** |
| **Scope creep into future modules** | Medium | Medium | No speculative abstractions; a module is a directory |

---

## 39. Milestones

Ten milestones, reordered so that **production launch comes after transactions, export, reconciliation,
hardening and backup/restore are all ready.** Every milestone ends with typecheck, lint, tests and
build green — **reported honestly, never claimed without running them.**

---

### M1 — Foundation, domain core, and protecting what is irreplaceable
**Goal:** the project builds, the schema exists, money arithmetic is proven, and the CSV archive is safe.
**Depends on:** approval.
**Work:** repo made **private**; `.gitignore` hardened *before* the first commit; the eight `docs/`
files and `CLAUDE.md`; Next.js 16 + TS strict + Tailwind + shadcn + pnpm; ESLint/Prettier; Vitest +
RTL; Playwright config; **an initial `Dockerfile` and `compose.dev.yml`** with **Postgres 18** and the
one-shot `migrate` service — containerized migrations are a M1 deliverable, so the image that runs
them must exist here, not at M10; Drizzle client and the full §18 schema; `money.ts` with the branded
`Cents` type; seed script; local `pg_dump` helper. **First task of all: back up the owner's local CSV
archive** to two destinations with a checksum manifest.

> **On the Docker image across milestones:** M1 creates the working image and compose stack that
> development and containerized migrations depend on. **M10 hardens and finalizes that same image for
> production** — multi-stage slimming, `output: 'standalone'`, non-root user, arm64 target, read-only
> root filesystem, healthchecks, drain behaviour. It is one image evolving, not two images.
**Tests:** the complete Money suite including allocation residuals; migrations apply and roll back;
**Postgres 18 volume persistence verified explicitly** — write rows, `docker compose down && up`,
confirm they survive. PG18's `VOLUME` moved to `/var/lib/postgresql`, and the pre-18 mount path fails
*silently*, so this is checked rather than assumed.
**DoD:** CSV archive verifiably backed up; repo private; `pnpm dev/test/lint/typecheck/build` green;
migrations run from the image, not the host; database survives a container recreate.

### M2 — Authentication, bootstrap prototype, and security baseline
**Goal:** only the owner gets in — and can always get back in.
**Depends on:** M1.
**Work:** Access JWT verification in **`src/proxy.ts`** (JWKS, aud, iss); **`requireOwner()` at the top
of every protected server entry point — Server Actions *and* Route Handlers alike** — with the
unprotected allowlist enumerated explicitly (`/api/health`, `/api/auth/*`) and `/api/health` returning
booleans and a version string only; the proxy is defense-in-depth, not the boundary, because a matcher
change can silently drop coverage; **Better Auth with the passkey plugin only —
no Google client configured here**; owner identity taken from the verified Access `email` claim against
`OWNER_EMAIL`; **prototype both bootstrap approaches and both recovery approaches from §13, document
observed behaviour, then choose**; two-passkey onboarding requirement; CSP with nonces; security
headers; rate limits; `audit_events`.
**Tests:** non-owner rejected; session revocation; unauthenticated routes blocked; **every Server
Action rejects an unauthenticated invocation even with the proxy bypassed**; the chosen bootstrap path
works from an empty database; the chosen recovery path mints a single-use token.
**DoD:** passkey sign-in works; **bootstrap and recovery are documented from a working prototype, not
assumed**; a non-owner identity is refused.

### M3 — App shell, accounts, and categories
**Goal:** the owner's taxonomy exists and the app is navigable.
**Depends on:** M2.
**Work:** `(private)` layout with `Finance` / `Settings`; **`/` redirects to `/finance/monthly`** — no
Home dashboard; responsive nav; theme; error/loading states; CRUD for `finance_accounts`; CRUD +
archive + reorder for `finance_categories` with `kind`.
**Tests:** archive preserves history; duplicate-name rejection.
**DoD:** the owner's real category list can be entered; the shell works on desktop and mobile.

### M4 — Parsing and normalization core *(no UI)*
**Goal:** the domain heart, provably correct.
**Depends on:** M1.
**Work:** **starts by reading one real redacted BoA export**; `NormalizedTransaction`; Papa Parse
harness; header-signature detection; BoA deposit and BoA card adapters; generic mapper;
`merchant.ts`; `dedupe.ts` (Tier 2 count reconciliation, which does all the work by default).
**Plus the §23 Tier 1 verification, per account type:** obtain two overlapping real exports for the
same period and check whether any candidate identifier column is (a) byte-stable across exports,
(b) unique across genuinely different transactions, and (c) present on enough rows to matter. Record
the findings in `docs/FINANCE.md`.
**Tests:** adapter suites; both sign conventions; malformed rows; encoding; `dedupe_key` stability
across a `merchant_key` normalization change.
**DoD:** fixtures parse to exact expected output; a wrong-sign file fails loudly; **the Tier 1
verdict is recorded with evidence, and no unique constraint is added unless all three checks passed**.

### M5 — Import pipeline, preview, and duplicates
**Goal:** multi-file batch → sanitized staging → preview → commit, idempotently.
**Depends on:** M3, M4.
**Work:** upload with all §21 validations; temp-file lifecycle with guaranteed deletion; **sanitized**
staging (no raw blob, unmapped columns discarded at parse); **60-day expiry** with extension on edit;
preview UI; count-based duplicate reconciliation; file-hash pre-check; commit in one DB transaction;
failure and cleanup paths.
**Tests:** commit atomicity; failed commit writes zero rows; temp file always deleted; repeat import →
0 new; overlapping ranges; genuine same-day repeats preserved; expiry sweep spares active imports.
**DoD:** three fake CSVs upload together, preview, and commit; the same file twice changes nothing.

### M6 — Categorization and classification
**Goal:** most transactions categorize themselves, and **nothing is silently excluded from spending.**
**Depends on:** M5.
**Work:** rules CRUD with priority; merchant memory; history inference; source-category mapping;
confidence scoring; transfer / card-payment / investment detection with **counterpart matching against
this batch and committed history (±7 days)**; **exclusionary types gated on rule, matched counterpart,
or explicit confirmation**; reporting exclusions in one shared SQL clause.
**Tests:** rule priority; memory promotion; **§23 yields $200**; transfers excluded; investments out of
Expenses but in Total Outflow; refunds reduce their category; **a bare heuristic never produces an
exclusion**; ambiguous counterpart candidates produce a review item, not a pairing.
**DoD — correctness, plus a measured property, not an invented percentage:**

The previous "≥80% auto-categorized" target was arbitrary — 80% of what corpus, and a number that says
nothing about whether the answers were *right*. Replaced with two things that are actually verifiable:

1. **Correctness on fixtures (hard gate).** Every fixture transaction resolves to its expected
   category *and* type. Precedence is verified end to end (rule > memory > history > source category >
   heuristic). **Zero false auto-exclusions** — no fixture transaction is assigned `transfer`,
   `credit_card_payment` or `investment` without deterministic evidence.
2. **The learning loop demonstrably closes (measured on real data).** Import the owner's first real
   month and **record** the observed auto-categorization rate and review count as a baseline — no
   target attached. Then import a second month and assert the property that actually matters:
   **every merchant confirmed in month 1 requires zero review in month 2.**

The milestone summary reports the observed rates as findings. A number the owner can watch fall month
over month is worth more than a threshold invented before any real data existed.

### M7 — Review queue
**Goal:** 172 transactions become ~14 decisions.
**Depends on:** M6.
**Work:** queue UI; keyboard navigation; category palette; bulk actions; merchant grouping; "remember
merchant"; separate duplicate and suspected-transfer passes; mobile card stack.
**Tests:** RTL keyboard flow; memory written on confirm; confirming a suspected transfer is what
assigns the exclusionary type.
**DoD:** 14 items reviewable in under two minutes, keyboard only.

### M8 — Monthly grid and drill-down *(the product)*
**Goal:** the Excel view, maintained automatically, as the landing experience.
**Depends on:** M6.
**Work:** SQL pivot; grid component with sticky header/column and `tabular-nums`; Expenses /
Investments / Total Outflow subtotals; cell drill-down panel with inline edit and per-cell export;
year switching.
**Tests:** pivot correctness; empty months; month boundaries; timezone independence; an edit moves the
total.
**DoD:** the grid matches a hand-computed fixture exactly; `/finance/monthly` is the landing route.

### M9 — Transactions table, Excel reconciliation, and export
**Goal:** the detailed view, proof of correctness, and no lock-in.
**Depends on:** M8.
**Work:** TanStack Table + Virtual with sort/filter/search, inline and bulk edits, column visibility,
mobile card list from the same row model; **ExcelJS dependency/security review gate**, then the XLSX
reader; `finance_expected_totals`; label→category mapping UI; reconciliation view with delta
explanations; CSV/XLSX export with formula-injection neutralization.
**Tests:** filter/sort correctness; bulk edit atomicity; reconciliation deltas; injection payload
across every string cell.
**DoD:** smooth at 10k synthetic rows; **the owner's real Excel imports and every non-zero delta is
explainable**; exports open cleanly in Excel with no formula execution.

### M10 — Backup automation, deployment, hardening, and launch
**Goal:** live at `app.burmy.me`, with recovery proven **before** real data lands there.
**Depends on:** M9.
**Work, in this order:**
1. **Harden the M1 image for production** — multi-stage slimming, `output: 'standalone'`, non-root
   user, arm64 target, read-only root filesystem where practical, healthchecks, SIGTERM drain — and
   the production `compose.yml` with the `edge` / `dbnet` split and the one-shot migrate service;
   `provision.sh`.
2. VPS provisioned; Cloudflare Tunnel + Access; Tailscale; ufw; `deploy.sh` with rollback.
3. **Backup automation and a verified restore — before the first production import.**
4. **Full DR drill:** destroy a scratch host, rebuild from backup, timed.
5. Balance snapshots UI; audit-event coverage review; log-redaction audit; dependency audit; CSP
   tightening; the three Playwright journeys; performance pass; `RUNBOOK.md`.
6. **Then** the first real production import.

**Tests:** healthchecks; deploy rollback; restore onto a scratch host with matching row counts and
per-year checksums.
**DoD:** reachable only through Cloudflare; no public ports; Postgres unreachable from outside the
Docker network; a non-owner refused at Access; **DR rehearsed end to end under 30 minutes**; backups
green and verified **before** real data is imported.

**Post-V1 (deferred decision):** optional AI, only if the residual review tail after two to three
months of real usage justifies it. Burmy must remain fully functional with no API key — verified by
running the whole suite without one.

---

## Verification

**Per milestone:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, plus that milestone's
stated tests. Failures are reported as failures, with output.

**Financial correctness (the gate that matters):**
1. Import the full CSV history through the normal pipeline.
2. Import the Excel sheets as expected totals.
3. **Reconciliation must explain every non-zero delta.** An unexplained delta is a bug, not rounding.
4. Spot-check three cells by hand against the original statements.

**Security:** a second Google account is refused at Access; direct origin access without a valid Access
JWT is refused; Postgres is unreachable from outside the Docker network; a revoked session dies
immediately; `git log -p` contains no secret; an integration test proves an unscoped Finance read is
impossible.

**Disaster recovery:** destroy a scratch VPS, rebuild from backup, timed under 30 minutes, with row
counts and per-year sum checksums matching.

---

## Post-approval sequence

1. `docs/IMPLEMENTATION_PLAN.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`,
   `docs/FINANCE.md`, `docs/DEPLOYMENT.md`, `docs/BACKUP_RESTORE.md`, `docs/ROADMAP.md`
2. Then one milestone at a time. Before each: current milestone, objective, planned changes. After
   each: what was implemented, files changed, tests run, typecheck, lint, build, known issues, next
   milestone.
