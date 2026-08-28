# Deployment

> **Status (2026-08-28): DEPLOYED AND LIVE.** `https://app.burmy.me` is serving the real application
> behind Cloudflare Access, against a Supabase Postgres database holding the owner's real Finance and
> Games data. Everything below that reads as a plan — "Deployment sequence", "Launch checklist" — has
> been carried out; both sections are now the RECORD of how it was done, kept because a rollback, a
> rebuild, or a second environment would follow the same order.
>
> Read this document as describing a running system, not an intended one. Where something is still
> outstanding it says so explicitly, in bold, rather than being left implied. Three such items: two in
> "Backup strategy" — the restore-verification procedure has never been run against the live Supabase
> project (only against local dev), and no backup cadence has been established — plus one smaller,
> under "Netlify environment-variable policy": the function region pin has not been confirmed to have
> taken effect.
>
> **Not a VPS, not Docker, not a Cloudflare Tunnel.** See "Why the VPS was dropped" for the reasoning.
> The VPS/Docker Compose self-hosting design this repo carried through M10's first pass has been
> removed from the active repository — it is not documented here as an alternative path, and it is not
> code anyone should extend. It remains fully available in git history (see commit `205323c` onward)
> if self-hosting is ever deliberately picked up again; that would be a real, separate piece of work,
> not a flag to flip.
>
> **Authentication: Cloudflare Access exactly as built (Option A), and it is what gates the live
> site.** `requireOwner()` is unchanged. `burmy.me` and `www.burmy.me` remain DNS-only and untouched;
> `app.burmy.me` alone is proxied through Cloudflare, which is what puts the Access application's
> Google auth + exact-email Allow policy in front of it.
>
> **Everything external here was performed by the owner, not by Claude.** Claude has never touched
> Cloudflare, Netlify, Namecheap, or the Supabase dashboard. Statements about their configuration are
> owner-reported; statements about the database's *contents and health* were read directly through
> Supabase's own tooling and are marked where they appear.

---

## Why the VPS was dropped

The original M10 plan (`VPS + Cloudflare Access + Burmy-OS/Postgres + B2 backups`) was sized for a
service that needs to run itself: Linux host maintenance, a Docker production host, SSH/`ufw`
hardening, PostgreSQL administration, `cloudflared`, systemd timers, and a restic→B2 backup pipeline.

Two things changed the calculus:

1. **Oracle Cloud's Always Free `VM.Standard.A1.Flex` (Ampere ARM64) had no capacity** in any
   availability domain, at either the originally-planned 2 OCPU/12 GB or a retried 1 OCPU/6 GB. Oracle's
   only Always Free fallback, `VM.Standard.E2.1.Micro`, was judged too small for Burmy-OS and rejected.
   No VPS was ever provisioned.
2. **Reconsidering actual usage** — Burmy-OS has exactly one user, with light and occasional traffic
   (upload a statement, review categorization, glance at charts, sometimes not opening the app for
   weeks). An always-on VPS optimizes for a usage pattern this app doesn't have. Netlify (serverless,
   scale-to-zero) and Supabase (managed Postgres) match occasional single-user traffic far better than
   a host that has to stay up, patched, and backed up regardless of whether anyone used it that week.

The application itself did not need to change to make this decision reversible: `src/server/finance/`
never touched the filesystem, and `scripts/migrate.mjs`/`scripts/provision-owner.mjs` are already plain
Node scripts with no Docker dependency of their own. The removed Docker/VPS path itself (`compose.yml`,
the provisioning/deploy/backup scripts, the systemd units) is fully recoverable from git history if
self-hosting is ever deliberately picked up again.

---

## Target topology

```
Namecheap (registrar) ──▶ Cloudflare (authoritative DNS)
                              │
                              ├── burmy.me      ──DNS only──▶ Netlify (existing portfolio, untouched)
                              ├── www.burmy.me  ──DNS only──▶ Netlify (existing portfolio, untouched)
                              │
                              └── app.burmy.me  ──Proxied───▶ Cloudflare Access
                                                                 │ Google OAuth, exact-email Allow policy
                                                                 ▼
                                                               Netlify (Burmy-OS)
                                                                 │  Next.js 16 — Netlify's Next.js Runtime
                                                                 │  (OpenNext-based). Server Components,
                                                                 │  Server Actions, Route Handlers as
                                                                 │  Netlify Functions; src/proxy.ts as a
                                                                 │  Netlify Edge Function. requireOwner()
                                                                 │  re-verifies the Access JWT itself —
                                                                 │  the proxy is defense-in-depth, not the
                                                                 │  boundary, same as always.
                                                                 ▼
                                                               Supabase Postgres
                                                                 (Supavisor pooler, transaction mode, for
                                                                  the app runtime; direct connection for
                                                                  migrations, run manually)
```

**Only `app.burmy.me` is proxied.** The existing portfolio (`burmy.me`, `www.burmy.me`) stays exactly
DNS-only, exactly as it is today — proxying it was never asked for and would change nothing but risk.
Proxying `app.burmy.me` specifically is what puts Cloudflare's edge, and therefore Access, in front of
the one hostname that needs it.

No VPS. No Cloudflare Tunnel. No production Docker host. No systemd. No mandatory Backblaze B2.

---

## External state — what actually exists today

Nothing in this section was performed by Claude; all of it was done manually by the owner, reported
back, and is recorded here for reference. **Claude has not touched Cloudflare, Netlify, Namecheap,
Supabase, or any VPS provider.**

### Summary — everything below is live

| Piece | State |
| --- | --- |
| `burmy.me` DNS on Cloudflare | Active, zone migrated |
| `app.burmy.me` | Proxied through Cloudflare, resolving to the Burmy-OS Netlify site |
| Cloudflare Access | Gating `app.burmy.me`; Google IdP, exact-email Allow policy |
| Netlify (Burmy-OS site) | Deployed, serving |
| Supabase Postgres | Provisioned, migrated, holding the owner's real data |
| Oracle VPS | Never created. Abandoned before provisioning |

### DNS — Cloudflare migration (complete)

- `burmy.me`'s DNS authority moved from Netlify DNS/NS1 to Cloudflare. The Cloudflare zone reports
  **Active**.
- Namecheap's nameservers are now `arely.ns.cloudflare.com` and `cody.ns.cloudflare.com`.
- The existing `burmy.me` portfolio is still hosted on Netlify, unchanged. Cloudflare's records for it:

  | Type | Name | Target | Proxy |
  | --- | --- | --- | --- |
  | CNAME | `burmy.me` (apex, flattened) | `apex-loadbalancer.netlify.com` | DNS only |
  | CNAME | `www` | `infallible-visvesvaraya-eefd80.netlify.app` | DNS only |

  No AAAA record (intentional — IPv6 was never enabled on the old Netlify DNS either). DNSSEC/DS was
  confirmed absent before the migration, so there was no stale-DS hazard during cutover.
- The old Netlify DNS zone still exists in Netlify's dashboard but is no longer authoritative. It has
  not been deleted, and there's no need to — it costs nothing to leave alone.
- Full investigation trail (public-lookup findings, the corrected apex-target reasoning, the
  step-by-step migration checklist) is preserved in git history rather than repeated here — see commits
  `dc70a6b`, `1b1e186`, `3318170`, `3f7d70f` for the complete record if it's ever needed again.

### Cloudflare Zero Trust / Access (live — gating `app.burmy.me` now)

- A Cloudflare Zero Trust **Free** organization exists.
- Google is configured as the identity provider and a live authentication test against it succeeded.
- A Burmy-OS Access application exists: intended hostname `app.burmy.me`, Google as the only identity
  provider, an exact-email Allow policy, 24-hour application session, Instant Authentication, Cloudflare
  One Client disabled.
- **Decision: this stays exactly as built, and Burmy-OS keeps `requireOwner()`'s existing Cloudflare
  Access JWT verification unchanged (Option A) — no Supabase Auth, no Netlify Identity, no second OAuth
  implementation, no password auth, no new session framework.** Access only intercepts a request when
  Cloudflare's edge actually sits in front of it — a Tunnel (the original, now-abandoned VPS design) or
  a *proxied* ("orange cloud") DNS record pointed at an origin Access is told to protect.
- **`app.burmy.me` now has that proxied record, and Access is enforcing on it.** It went in DNS-only
  first so Netlify could verify the domain and provision HTTPS, then switched to Proxied — the
  order-sensitive rollout recorded in "Deployment sequence" below, which has since been carried out
  in full.

### Oracle VPS (abandoned, nothing created)

OCI networking configuration was created manually, then VM provisioning was attempted at
`VM.Standard.A1.Flex`, 2 OCPU/12 GB, Ubuntu 24.04 — capacity unavailable in AD-1, AD-2, and AD-3.
Retried at 1 OCPU/6 GB — still unavailable. The remaining Always Free option
(`VM.Standard.E2.1.Micro`) was rejected as too small. **No compute instance was ever created; nothing
was ever deployed.** See "Why the VPS was dropped" above for what this triggered.

---

## Authentication

**Decided: Option A. Cloudflare Access, exactly as already configured, stays the sole authentication
mechanism. No code change to `requireOwner()`/`src/server/auth/*`, no new auth system.**

`requireOwner()` (`src/server/auth/owner.ts`) has exactly one identity-verification path in
production: a Cloudflare Access JWT, checked against `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD`
(`src/server/auth/access.ts`). There is no in-app credential, no session, no fallback — see
`docs/SECURITY.md`, "Authentication," which remains an accurate description of how the *code* behaves,
unchanged by this decision. The dev bypass triggers only when `NODE_ENV` is exactly `development`;
Netlify sets `NODE_ENV=production` for a production deploy, so the bypass does not apply there.

**Why this works despite dropping the VPS/Tunnel:** Cloudflare Access can protect a *proxied* DNS
record pointed at any public origin, including Netlify — this does **not** require a Tunnel; Tunnel was
only ever needed for the original VPS design because that origin had no public route of its own.
Proxying `app.burmy.me` alone (leaving `burmy.me`/`www.burmy.me` untouched, still DNS-only) puts
Cloudflare's edge in front of just that one hostname, which is exactly what the already-completed
Access application, Google IdP, and exact-email Allow policy were built for. **Reuses 100% of the
external configuration already in place, at zero new services, zero new code.**

**Explicitly rejected, per owner instruction:** Supabase Auth, Netlify Identity, a second OAuth
implementation, password authentication, any other new session/auth framework. Building an independent
owner-auth mechanism inside Burmy-OS was the alternative (Option B) considered and declined — Cloudflare
Access already does this correctly, and a second implementation would only be a second thing to keep
secure for no functional gain.

**The one sequencing hazard this created, and why "Deployment sequence" below is written the way it
is:** `app.burmy.me` could not be proxied from the start — Netlify needs the domain DNS-only first to
verify ownership and provision its own HTTPS certificate. That meant a window in which the Burmy-OS
Netlify deployment existed but was not yet behind Access. The authenticated parts of the app
(everything behind `requireOwner()` — which is everything except `/api/health`) **could not be verified
during that window**, including on the temporary `*.netlify.app` URL, which never passes through
Cloudflare at all and so never carries the Access JWT `requireOwner()` needs. Only build/runtime/public
health (`/api/health`) was checkable before the DNS cutover; the sequence below reflects that rather
than assuming the temporary URL proved more than it did.

That window is closed — `app.burmy.me` is proxied and Access enforces on it — but the hazard is
recorded rather than deleted, because it recurs verbatim for any future custom domain, any second
environment, and any rebuild of the site from scratch.

### The boundary holds even if the Netlify origin is reached directly

Netlify's own `*.netlify.app` hostname for the Burmy-OS site stays reachable regardless of whether
`app.burmy.me` is proxied — proxying Cloudflare only adds a *second* path in front of Access, it doesn't
close the first. So the real question is: does the application itself still fail closed if someone
reaches that origin hostname directly, bypassing Cloudflare (and therefore Access) entirely? Audited
directly, not assumed:

- **Every private page, Route Handler, and Server Action calls `requireOwner()`.**
  `tests/integration/entry-points.test.ts` enumerates the filesystem (not a hand-maintained list) and
  proves this for all three categories — Route Handlers and Server Actions were already covered; this
  review added the same proof for `page.tsx` files under `(private)/` (8 pages checked; the two that
  don't call it directly — `/` and `/finance/import` — are bare `redirect()`s with no data to protect,
  on a small reviewed allowlist the same shape as the Route Handler one, and the test asserts they
  really are pure redirects, not silently unguarded).
- **`requireOwner()` has no path that serves data without a verified Access JWT for the exact owner
  email.** Traced through `src/server/auth/owner.ts` → `requireAccessIdentity()` →
  `verifyAccessToken()` in `src/server/auth/access.ts` — there is no fallback, no default-allow branch,
  and the dev bypass triggers only on `NODE_ENV === 'development'` exactly (never `!== 'production'`),
  which Netlify does not set for any deploy context.
- **New tests added, closing a real gap in what was actually exercised versus what the code's own
  comments claimed was covered** (`tests/unit/access.test.ts`'s `requireAccessIdentity` describe block
  previously had only 2 tests — dev-bypass and unconfigured-refusal — neither of which exercised
  *enforced* mode with a real signed token at all):
  - a structurally malformed token (not a well-formed JWT), at both `verifyAccessToken` and
    `requireAccessIdentity`
  - a validly-signed assertion for a real but non-owner email, in enforced mode
  - a validly-signed assertion for the real owner, in enforced mode — the success path, previously
    untested end to end at this layer
  - no assertion at all, in enforced mode
  - (already covered before this review, confirmed still passing: missing assertion, wrong signature,
    wrong audience, wrong issuer, expired token, tampered payload, no email claim)

**Conclusion: the boundary holds.** A request that reaches the Netlify origin directly, with no valid
Cloudflare Access JWT, is rejected the same way regardless of which hostname it arrived on — this was
already true of the application code before this review; the review's job was proving it with tests
rather than reading it and trusting it. No new authentication mechanism was added or considered
necessary.

---

## Netlify environment-variable policy

Netlify's environment variables have two independent axes, both used deliberately below — **scope**
(which parts of a deploy can read the value: Builds, Functions, other runtime features, Post
processing) and **deploy context** (Production, Deploy Previews, Branch deploys, Local development via
the CLI). A variable can hold a different value — or no value — per context. On top of both, marking a
variable "Contains secret values" (Netlify's Secrets Controller) makes it write-only in the dashboard
after it's set and restricts which scopes/contexts can use it at all, specifically to prevent a secret
being pulled into a scope (like Post processing, which touches build output) where it could leak.

| Variable | Value | Scope | Context | Secret? |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | Supabase **pooled** connection string (Supavisor, transaction mode, port `6543`, `?pgbouncer=true`) | Functions / Runtime only — the app never needs it at build time (see "Database" below for why) | **Production only** | Yes |
| `OWNER_EMAIL` | the owner's Google account email | Functions / Runtime only | **Production only** | Yes — not a credential, but a phishing target for the one account with access; treated the same as `.env.app.example` already treats it for the VPS path |
| `CF_ACCESS_TEAM_DOMAIN` | the Cloudflare Zero Trust team domain | Functions / Runtime only | **Production only** | No — identifies the team, not a secret by itself, but scoped to Production anyway since it has no purpose outside it |
| `CF_ACCESS_AUD` | the Burmy-OS Access application's Audience tag | Functions / Runtime only | **Production only** | Yes |
| `NODE_ENV` | `production` | — | Set by Netlify automatically | Not applicable — never set this manually |

### The five OPTIONAL Games variables

The four above are what the application REQUIRES. The Games module adds five more, and every one of
them is optional by contract — see `docs/GAMES.md` and `.env.example`, both of which spell out the
soft-failure behavior. They are listed here because the table above used to be the complete picture and
is not any more, and because "optional" makes their absence invisible rather than loud: with none of
them set the app runs correctly and simply offers less.

| Variable | What it enables | Absent behavior |
| --- | --- | --- |
| `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET` | Cover art and metadata suggestions (genre, developer/publisher, critic score, playtime, ESRB) | Lookup returns `[]`. No error, no crash — a game just has no art |
| `STEAM_API_KEY`, `STEAM_ID` | The Library's "Sync with Steam" button | Button renders DISABLED with a visible explanation naming both variables. Never hidden, never thrown |
| `PSN_NPSSO` | The Library's "Sync with PlayStation" button | Same: disabled, with a visible explanation naming the variable |

Same scoping rule as the required four — **Functions/Runtime only, Production only, secret-marked.**
They are credentials tied to the owner's personal Twitch, Steam and PlayStation accounts, and none of
them is needed at build time.

**`PSN_NPSSO` is the one that will need re-entering.** It expires roughly every two months and there is
no way to detect that except by attempting a sync, at which point the button surfaces a distinct "token
expired" message rather than a generic failure. Re-pasting it in Netlify's dashboard is a manual chore
with no automated alternative — see `docs/GAMES.md`, "The NPSSO token."

**None of the four required variables are given a Build scope.** `next build` never needs a live database or Access
config — `src/server/db/index.ts` connects lazily, on first query, specifically so `next build` (which
imports every route module to analyze it) never requires `DATABASE_URL` to be live or even present.
Scoping all four to Functions/Runtime only, Production context only, means: a Deploy Preview or Branch
deploy build succeeds with **zero** of these variables set, and none of the four ever appear in a build
log.

### `netlify.toml` pins the function region to `us-east-2`

The Supabase project is in `us-east-2`; Netlify's default function region is `us-east-1`. Pinning them
together removes a cross-region hop from every database round trip a page makes.

**Sized honestly, so nobody expects more from it than it can give.** A page's queries run through one
`Promise.all` against a pool of 10 connections, so a render pays roughly one or two round trips, not
one per query — this saves tens of milliseconds, not hundreds. It is worth doing because it is free and
permanent, not because it is the fix. The database is not the bottleneck either way (18 MB, ~1,100
transactions, slowest read ~100ms and everything else under 20ms); what costs time is the serverless
round trip itself, and a cold start most of all.

**Two things to verify rather than assume.** Region pinning may be plan-gated — if this deployment's
plan does not support it, Netlify falls back to the default region rather than failing the build, so
read the deploy log for the region the functions actually ran in. And if the Supabase project ever
moves, this value must move with it: a region pinned to the wrong place is worse than no pin, because
it looks deliberate.

**Never set any of the four in `netlify.toml`.** `netlify.toml` is committed to git; the four variables
above go in Netlify's dashboard (Site configuration → Environment variables) or the Netlify CLI/API,
never in the repo. `netlify.toml` itself stays exactly what it is today — build command and Node
version, nothing that could ever be a secret.

Not needed at all under this architecture: `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` (Supabase
manages its own Postgres credentials), `TUNNEL_TOKEN`, `RESTIC_REPOSITORY`/`RESTIC_PASSWORD`,
`B2_ACCOUNT_ID`/`B2_ACCOUNT_KEY`, the four `HEALTHCHECKS_*_PING_URL` values — none of these appear
anywhere in the active repository any more (the old VPS design's five-file `.env.<scope>` split that
used to carry them was removed along with the rest of that path; see git history if it's ever needed
again). Netlify's own environment-variable store is simply where the far-shorter list above lives.

### Preview deployment safety

**Deploy Previews and Branch deploys get none of the four production variables**, per the table above —
this is the whole policy, not a partial mitigation. What that means concretely for a preview:

- **Build succeeds.** `next build` needs none of them (see above).
- **The app boots and `/api/health` responds**, reporting `database: false` — it probes the connection
  and reports the boolean rather than crashing when there isn't one.
- **Every page under `(private)/` fails closed** with a `503` (`SecurityUnavailableError`) — the same
  documented fail-closed behavior production itself falls back to if it were ever misconfigured (see
  `docs/SECURITY.md`, "Authentication"). This isn't a workaround; it's `requireOwner()` doing exactly
  what it's built to do with no Access config present.
- **A preview is therefore safe by construction, not by convention** — even if a future mistake somehow
  exposed a preview's URL publicly, there is no production data reachable from it, because there are no
  production credentials on it to reach that data with. This holds independently of Cloudflare Access
  too: a preview's own Netlify-assigned URL never passes through Cloudflare at all (Access only gates
  `app.burmy.me`), so even a hypothetically-leaked credential would still need to clear `requireOwner()`
  with no Access JWT present — a second, independent reason it fails closed.

**Consequence, stated plainly: a Deploy Preview cannot be used to test the Finance dashboard, import, or
anything else behind `requireOwner()`.** It's useful for compile/build verification and whatever UI
renders without data (layout, static text, empty states) — not full functional testing. That's the
tradeoff this policy makes deliberately, per "do not weaken production secret isolation just to make
every preview fully functional."

---

## Database — Supabase Postgres

**Two different connection strings for two different purposes — this is the one Supabase-specific
detail that actually changes application behavior, not just configuration:**

- **App runtime (`DATABASE_URL` in Netlify): the pooled Supavisor connection, transaction mode, port
  `6543`.** Netlify Functions are short-lived and can run many concurrent invocations; each one opening
  its own small pool of direct Postgres connections is exactly the pattern that exhausts a database's
  connection ceiling under real (even light) concurrent traffic. Supavisor's transaction-mode pooler
  fans many serverless callers in over few real Postgres connections.
- **Migrations (run manually, from a developer machine): the direct connection, port `5432`, not
  pooled.** DDL and multi-statement transactions do not behave correctly through a transaction-mode
  pooler. `scripts/migrate.mjs` already uses a single dedicated connection (`max: 1`) for exactly this
  kind of correctness reason — nothing about it needs to change, only which connection string it's
  pointed at when it runs.

**Code change made:** `src/server/db/index.ts` now always caches its client/instance (previously gated
on `NODE_ENV !== 'production'`, which meant production never cached at all — a real latent bug,
harmless on a VPS's single long-lived process but fatal against Supabase's connection ceiling under
serverless), and always sets `prepare: false` (required through Supavisor's transaction-mode pooler;
harmless — a pure optimization, not a correctness requirement — against a direct connection, so this is
safe for local dev and migrations too).

**SSL:** not hardcoded in application code, deliberately — Supabase's own connection strings already
specify `sslmode=require`, and `postgres.js` respects that from the URL. Hardcoding `ssl: 'require'` in
`db/index.ts` would break the plain, no-TLS local dev connection (`postgres://burmy:burmy@localhost/burmy`).

### Production runs a different Postgres MAJOR version than local dev and CI

`compose.dev.yml` and `.github/workflows/ci.yml` both pin `postgres:18-alpine`. The live Supabase
project was observed running **17.6** — Supabase chooses its own version and does not track the newest
major release. So every migration is generated and tested on 18 and applied to 17.

**Nothing in this schema currently depends on the difference**, which is why this is recorded rather
than fixed: the migrations are ordinary DDL (tables, enums, indexes, foreign keys, one partial index)
with no 18-only syntax. But that is a property of what has been written so far, not a guarantee — a
future migration using an 18-only feature would generate cleanly, pass CI, and then fail against
production, which is the worst possible place to find out.

Two ways to close it, neither done: pin the local/CI image to the major version Supabase actually
runs, or upgrade the Supabase project. Pinning down is the cheaper and safer of the two — testing
against a version OLDER than production is the wrong direction, and matching exactly is better than
either.

**Re-check the live version before assuming this is still true** (`select version()`); Supabase
upgrades projects over time and this note will go stale silently.

**Migration credential is named and handled distinctly from the runtime credential — `MIGRATION_DATABASE_URL`
vs. `DATABASE_URL` — even though `scripts/migrate.mjs` itself doesn't need to change to make that true.**
The script already just reads whatever `DATABASE_URL` is present in the process it's invoked with; the
naming distinction is a documentation/runbook convention, not a code difference, and it's what keeps the
two credentials from ever being confused with each other (a password manager entry literally labeled
`MIGRATION_DATABASE_URL` cannot be mistaken for the one that belongs in Netlify's dashboard). Concretely:

```bash
# MIGRATION_DATABASE_URL — Supabase's DIRECT (non-pooled, port 5432) connection string.
# Exists ONLY on the operator's own shell for the moment a migration runs. It is
# NEVER stored in Netlify (the deployed runtime has no route to it, and does not
# need one — the pooled DATABASE_URL in Netlify is a functionally weaker, separately
# scoped credential), and never touches an ordinary Deploy Preview or Branch deploy.
export MIGRATION_DATABASE_URL="<supabase direct connection string>"

DATABASE_URL="$MIGRATION_DATABASE_URL" node scripts/migrate.mjs
DATABASE_URL="$MIGRATION_DATABASE_URL" OWNER_EMAIL="<owner email>" node scripts/provision-owner.mjs
```

Run manually, deliberately, from a developer machine with network access to Supabase — **never
automatically on every Netlify deploy; `netlify.toml`'s `command` is plain `pnpm build`, nothing more,
and there is no build plugin or post-deploy hook wired to run either script.** Both scripts are plain
ESM that run directly on whatever host invokes them — no Docker, no build step — so this workflow
needed no code change, only a different place to run them from, and a documented name for the
credential that keeps it out of Netlify's store entirely. `provision-owner.mjs` stays idempotent and
safe to re-run.

Local development is unaffected: `docker compose -f compose.dev.yml up -d postgres`, then
`pnpm db:migrate` — the same plain host script CI and production both use — against the local
Postgres container, not Supabase. Drizzle/`drizzle-kit` need no changes — `drizzle.config.ts`
already just reads `DATABASE_URL`.

### Running any OTHER script against production

`migrate.mjs` and `provision-owner.mjs` are the two scripts that are *supposed* to run against
Supabase. Everything else in `scripts/` guards itself, and the guards are not uniform, because the
right answer differs per script:

| Script | Guard |
| --- | --- |
| `migrate.mjs`, `provision-owner.mjs` | None — running against production is their purpose |
| `pnpm db:seed` | **Refuses** unless `DATABASE_URL`'s host is `localhost`/`127.0.0.1`/`::1` |
| `sync-steam-library.mjs`, `backfill-game-metadata.mjs`, `fix-game-platforms.mjs`, `import-game-log.mjs` | **Refuse** a non-local database outright — sync locally, then migrate the result deliberately |
| `link-game-collections.mjs`, `merge-duplicate-games.mjs` | Report by default; `--apply` writes; a non-local database additionally requires `--remote` |

**Why `db:seed`'s guard is a hostname check and not `NODE_ENV`.** It was added after `pnpm db:seed`
was once run against the real Supabase database by accident, immediately after legitimately pointing
`DATABASE_URL` at production for `db:migrate` and `db:provision-owner` in the same shell. An ad-hoc
operator shell running production commands typically has no `NODE_ENV` set at all, so a
`NODE_ENV !== 'production'` gate would have passed cleanly in exactly the situation that caused the
mistake. See `src/server/db/seed-guard.ts`.

**The two collections scripts are the exception that proves the rule.** They exist to fix data that
only exists in production, so they cannot carry the flat local-only refusal. `--remote` is the
deliberate second key: nothing about a mistyped command line produces it accidentally.

---

## Backup strategy (simplified)

**Per Supabase's own documentation as of this writing, the Free plan does not include managed daily
backups or point-in-time recovery** (Pro and above add daily backups; PITR is a further paid add-on on
top of that) — stated here as what Supabase's docs currently say, not as a permanent guarantee, since
plan terms can change. The old VPS design had an automated restic→B2 pipeline with nightly/weekly
systemd timers — real, tested, working code in its day, removed along with the rest of the VPS path
(see git history if it's ever needed again) because it was VPS-shaped infrastructure (a host to run the
timers on) this architecture no longer has, and building an equivalent automated pipeline just to
protect a Free-tier database was explicitly ruled out as its own new infrastructure stack.

**Policy: maintain an independent logical backup, initially as a manual periodic operation, no new
infrastructure.** Either of these is a compatible logical (not physical) dump, so either is fine —
the Supabase CLI's own wrapper, or plain `pg_dump` directly against the **direct** (non-pooled)
connection string:

```bash
# Supabase CLI (wraps pg_dump; requires the CLI linked to the project) —
supabase db dump -f "burmy-$(date +%Y-%m-%d).sql"

# …or plain pg_dump directly, no CLI dependency:
pg_dump "<supabase direct connection string>" -Fc -f "burmy-$(date +%Y-%m-%d).dump"
```

> **OUTSTANDING: no backup has been taken of the live database.** The policy below was written before
> the Supabase project existed. It is a good policy and it has never been executed. Both triggers have
> since occurred — real statement data was imported, and migrations `0011`–`0016` were applied — so the
> gap is not theoretical.

**Initial policy — run by hand at two specific triggers, not on a fixed schedule:**

1. **After a meaningful monthly import** — a real statement import is the only thing that meaningfully
   changes the database for a single-user app, so that's the moment worth protecting.
2. **Before a schema migration** — a migration that goes wrong is exactly the situation a backup exists
   for; taking one immediately before running `scripts/migrate.mjs` against Supabase means a bad
   migration is always recoverable to the moment just before it ran.

Saved wherever the owner already keeps things safe (a synced folder, an external drive) — anywhere off
the Supabase project itself, since a backup that lives next to what it's backing up doesn't protect
against losing the project.

**Restore procedure** (there is no `scripts/restore.sh` any more — restoring a plain `pg_dump`/
`supabase db dump` is two ordinary Postgres commands, not something that needs its own script):

```bash
# Plain-SQL dump (from `supabase db dump`):
psql "<supabase direct connection string>" -f burmy-2026-08-19.sql

# Custom-format dump (from `pg_dump -Fc`):
pg_restore -d "<supabase direct connection string>" --clean --if-exists burmy-2026-08-19.dump
```

### Restore-verification procedure — run against LOCAL DEV only, never against Supabase

> **OUTSTANDING. This is the single most important unfinished item in this document.** The procedure
> below was run once, against the local dev Postgres container, at a time when no Supabase project
> existed yet to dump from. It has **never been run against the live Supabase database**, which now
> holds the only copy of the owner's real Finance and Games data.
>
> Until it has, there is no proven backup of production — only a proven backup *procedure*, verified
> against a different database, on a different Postgres major version (see "Production runs a different
> Postgres MAJOR version" above), with 5 rows in it instead of thousands. Those differences are exactly
> where a restore goes wrong: role ownership, extensions, and version-specific dump format are all
> things the local test could not exercise.
>
> Run it against the real project, and record the result here. Everything else in this document
> describes something that has been done; this describes something that has not.

The mechanics are identical either way — only the connection string changes. The recorded local run:

```bash
# 1. Dump the source database, custom format.
pg_dump "<connection string>" -Fc -f burmy-verify-test.dump

# 2. Restore into a disposable SCRATCH database — never the source, never production.
psql "<connection string, but database=postgres>" -c "CREATE DATABASE burmy_restore_test;"
pg_restore -d "<connection string, database=burmy_restore_test>" --no-owner burmy-verify-test.dump

# 3. Compare row counts (or any other integrity signal) between source and restored.
psql "<...burmy_restore_test>" -c 'select count(*) from "user";'
psql "<...burmy_restore_test>" -c 'select count(*) from finance_transactions;'
psql "<...burmy_restore_test>" -c 'select count(*) from finance_categories;'

# 4. Clean up the scratch database and the dump file.
psql "<connection string, database=postgres>" -c "DROP DATABASE burmy_restore_test;"
rm burmy-verify-test.dump
```

**Result, actually observed (LOCAL DEV, 2026-08-19):** dump succeeded (57 KB from the then-current dev
dataset); restore into the scratch database completed with no errors; row counts matched exactly
between source and restored (`user`: 1/1, `finance_transactions`: 2/2, `finance_categories`: 2/2);
scratch database and dump file both removed afterward. `--no-owner` on restore is kept in the
documented command even though it made no difference in this same-cluster test — it matters once the
restore target's role structure doesn't exactly match the dump's recorded owner, which is the normal
case restoring into a fresh Supabase project or a different Postgres instance entirely.

**When repeating this against Supabase, compare more than three tables.** The row-count check above
was written when the database held two transactions. The live schema has 23 tables across Finance and
Games; a restore that silently dropped `game_trophies` or `finance_import_rows` would pass the check
exactly as written. Count every table that should be non-empty, or diff the full `\dt` output.

**This is intentionally the simplest thing that provides real, independent protection, not the final
word.** If a manual cadence turns out to be too easy to forget, or the lack of managed PITR becomes a
real concern given actual usage, the options in order of effort are: a Supabase Pro upgrade, or a small
scheduled job (a Netlify Scheduled Function, or a line in the owner's own crontab) running the dump
command above automatically. Neither is built now — automation is deferred until actual usage justifies
it, per explicit instruction not to stand up new infrastructure preemptively.

---

## Rollback procedure

Application rollback and database rollback are separate concerns, and **rolling back one does not roll
back the other** — stated explicitly because it's the easy mistake to make under pressure.

**Application (Netlify):** every deploy is retained as an immutable snapshot. Netlify → Deploys → pick
any previous successful deploy → **Publish deploy**. Instant, no rebuild. If the site auto-publishes
from Git, the next push to the production branch will overwrite a rolled-back deploy — **lock the
current deploy** (Netlify's own "Lock deploy" action) if a rollback needs to hold while the underlying
issue gets fixed.

**Database (Supabase): rolling back the Netlify deploy does NOT roll back the schema or the data.** A
previous code version now runs against whatever the database currently looks like — which may be
mid-migration, or already carrying newer writes the old code doesn't expect. Consequences:

- **Schema migrations should be backward-safe whenever practical** — additive (new nullable column, new
  table) rather than destructive, so an old code version rolled back onto a newer schema keeps working
  rather than erroring on a column/table it doesn't expect to be missing. Drizzle's generated migrations
  are additive by default unless a column/table is explicitly dropped or renamed.
- **A destructive migration (drop/rename column or table, `NOT NULL` added to existing data) requires a
  backup taken immediately before it runs** — see "Backup strategy" above, trigger #2. There is no
  automatic database rollback path; a bad destructive migration is recovered by restoring that backup,
  a deliberate manual action, never a side effect of a Netlify rollback.

---

## Deployment sequence

**This was carried out in full; `app.burmy.me` is live.** It is kept as the record of the order the
steps have to happen in, because that order is not obvious and is the part worth re-reading before a
rebuild, a second environment, or a domain change.

Order-sensitive, and corrected from an earlier draft that assumed the temporary `*.netlify.app` URL
could verify the whole app — it can't, since Cloudflare Access never sits in front of that hostname
(see "Authentication" above for why). Split explicitly below into what the temporary URL CAN prove
(build, runtime, public health) and what only the real `app.burmy.me` hostname, proxied, can prove
(everything behind `requireOwner()`):

1. Create/configure the Supabase project (external, owner-performed — not done by Claude).
2. Run migrations against Supabase's **direct** connection string (`MIGRATION_DATABASE_URL` — see
   "Database — Supabase Postgres" above), then owner provisioning:
   `DATABASE_URL="$MIGRATION_DATABASE_URL" node scripts/migrate.mjs`, then
   `DATABASE_URL="$MIGRATION_DATABASE_URL" OWNER_EMAIL="<owner email>" node scripts/provision-owner.mjs`.
3. Create the Burmy-OS Netlify site, pointed at this repository.
4. Configure its production environment variables (see "Netlify environment-variable policy" above,
   including scope/context/secret marking for each) — `DATABASE_URL` here is Supabase's **pooled**
   connection string, not `MIGRATION_DATABASE_URL` from step 2, and none of the four go in
   `netlify.toml`.
5. Deploy.
6. Verify build/runtime/public health **on the temporary `*.netlify.app` URL only, and only where
   authentication is not required** — concretely: the build succeeded, the app boots, and
   `/api/health` responds. Do **not** try to verify the Finance dashboard, import, or anything else
   behind `requireOwner()` here; it will correctly fail closed, since Access isn't in front of this
   hostname at all.
7. Add `app.burmy.me` as the custom domain in Netlify.
8. In Cloudflare, create the required `app` CNAME pointed at the Burmy-OS `*.netlify.app` hostname —
   **DNS only** at first, not proxied yet. (`burmy.me`/`www.burmy.me` are untouched throughout — see
   "Target topology" above.)
9. Wait until Netlify reports DNS verification and HTTPS/certificate provisioning healthy for
   `app.burmy.me`.
10. Change **only** the `app` DNS record to **Proxied** (orange cloud). This is the one moment Access
    starts gating the hostname. **At the same time, set Cloudflare's SSL/TLS encryption mode to `Full
    (strict)`** — Netlify already provisioned a real, validly-signed certificate for `app.burmy.me` in
    step 9, so strict validation between Cloudflare and the Netlify origin is achievable and is the
    correct mode; `Flexible` would leave that hop unencrypted, and plain `Full` wouldn't validate the
    origin certificate at all. `burmy.me`/`www.burmy.me` stay DNS-only throughout, so no Cloudflare TLS
    mode applies to them either way — TLS for those two is exactly what it is today, Netlify's own,
    untouched.
11. Verify visiting `https://app.burmy.me` invokes Cloudflare Access (a Google sign-in prompt, not the
    app directly).
12. Sign in through Google using the allowed owner email; verify `requireOwner()` accepts the resulting
    Cloudflare Access JWT (the app loads, rather than `/access-denied`).
13. **Only now**, with Access confirmed working end to end, perform full production verification behind
    real authentication: Finance dashboard, transactions, accounts/categories, CSV import,
    categorization, duplicate handling, Month/Year views.

The existing `burmy.me`/`www.burmy.me` portfolio deployment is untouched by any of this — it remains
exactly `→ Netlify`, DNS-only, as it is today, and the new Burmy-OS Netlify site is a separate,
independent Netlify project, not a change to the existing one.

---

## Git / release workflow

This described a repository with a long run of unpushed local commits on `main`. That is no longer the
case — `main` is on GitHub and the Netlify site deploys from it. The workflow below is what the project
follows now, not what it intends to:

1. Full local quality gate — `pnpm typecheck` / `lint` / `test` / `test:integration` / `test:e2e` /
   `build`, all green.
2. Review the working tree and commit history — nothing accidental staged, nothing that reads like it
   needs squashing or reordering before it becomes visible remotely.
3. Push a checkpoint or feature branch to GitHub — **not directly to `main`** — so the work exists
   remotely (backup, and reviewable) without asserting it's finished.
4. Connect that branch through Netlify as its own deploy (a Branch deploy, distinct from the production
   site) and test it there.
5. Production deployment, following "Deployment sequence" above.
6. Merge to `main` only after the branch has been verified — remote history then reflects what's
   actually been proven working, not just what compiled.

This is a process note, not a code or config change — nothing here was executed as part of this review;
pushing remains something only the owner triggers or explicitly asks for.

---

## Launch checklist — Definition of Done for the default (Netlify + Supabase) path

**Launched. Real financial data is in production.** Status against the original list, which was
written as a gate and is now a record:

| # | Item | Status |
| --- | --- | --- |
| 1 | Cloudflare Access working end to end on the deployed app | ✅ — the site is reachable only through it |
| 2 | Netlify build succeeds with no config beyond `netlify.toml` + env vars | ✅ |
| 3 | Migrations applied against Supabase | ✅ through `0015`. **`0016` (collections) is generated and committed but NOT YET APPLIED** — take a backup first (item 8) |
| 4 | Owner resolves correctly; fails closed for anything else | ✅ |
| 5 | `app.burmy.me` resolves, HTTPS healthy, SSL/TLS `Full (strict)` | ✅ |
| 6 | Unauthorized access fails closed against the real deployment | ✅ |
| 7 | Import, categorization and the dashboard work against real Supabase data | ✅ |
| 8 | A logical backup taken and verified restorable | ❌ **NOT DONE.** See "Backup strategy" — this is the outstanding item |
| 9 | All test/build gates green | ✅ locally. `test:integration` needs Docker and is CI-verified, not verified in every environment |
| 10 | Rollback procedure understood before it is needed | ✅ documented; never exercised |

The original wording of each item is preserved below.

1. Cloudflare Access (Option A) is confirmed working end to end on the deployed app via the "Deployment
   sequence" above (steps 11–12) — not just configured, actually invoked and passed.
2. Netlify build succeeds against this repo with no configuration beyond `netlify.toml` and the
   environment variables in "Netlify environment-variable policy".
3. Migrations applied correctly against Supabase (`scripts/migrate.mjs`, direct connection) — schema
   matches `drizzle/`.
4. Owner is resolved correctly (`provision-owner.mjs` run once, `requireOwner()` succeeds for the real
   owner identity and fails closed for anything else).
5. `app.burmy.me` resolves to the Netlify deployment and HTTPS is healthy, with Cloudflare's SSL/TLS
   mode set to `Full (strict)` — see "Deployment sequence," step 10.
6. Unauthorized access fails closed (confirmed against the real deployed app, not just unit tests) —
   see "The boundary holds even if the Netlify origin is reached directly" above.
7. CSV import, categorization, and the Finance dashboard all work correctly against real Supabase data.
8. A manual logical backup (`supabase db dump` or `pg_dump`) against the live Supabase database
   succeeds and is verified restorable into a scratch database — see "Backup strategy" above (the
   restore-verification procedure was already performed once, locally, in this review; repeat it
   against the real Supabase project before trusting a production backup specifically).
9. All application test/build gates remain green: `pnpm typecheck` / `lint` / `test` / `test:integration`
   / `test:e2e` / `build`.
10. The rollback procedure ("Rollback procedure" above) is understood, not just documented — know how
    to publish a previous Netlify deploy before the first real production deploy happens, not after
    something goes wrong.

If self-hosting is chosen instead of Netlify + Supabase (a future reversal back to a VPS), the original
13-point VPS launch checklist is preserved in git history (this file, before this rewrite) and in
`docs/BACKUP_RESTORE.md`'s own DR checklist, which was never specific to any one hosting path.
