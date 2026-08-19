# Deployment

> **Status (2026-08-18): the default production architecture changed.** Burmy-OS's production target
> is now **Netlify (hosting) + Supabase (managed Postgres) + Cloudflare (DNS only)** — not a VPS. The
> VPS/Docker/Tunnel/B2 design below is fully preserved and still works, but it is now the **optional
> self-hosting path**, not the default. See "Why the VPS was dropped" for the reasoning and "Optional:
> self-hosting on a VPS" for everything that moved there unchanged.
>
> **External state, as it actually exists today** (owner-reported, not independently verified by
> Claude): the Cloudflare DNS migration for `burmy.me` is complete and the zone is Active; Cloudflare
> Zero Trust Free + a Google identity provider + a Burmy-OS Access application are configured; an
> Oracle Cloud VPS was attempted and abandoned after repeated capacity failures — **no VPS was ever
> created, nothing was ever deployed to Oracle.** See "External state" below for the full detail.
>
> **One open decision blocks going live and is called out explicitly in "Authentication — the open
> decision": how the owner authenticates to a Netlify-hosted app, now that Cloudflare Access no longer
> sits in the request path by default.** Nothing else in this document is blocked on it.

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
never touched the filesystem, `scripts/migrate.mjs` and `scripts/provision-owner.mjs` are already
plain Node scripts with no Docker dependency of their own, and the Docker/VPS path (below) is fully
intact if self-hosting is ever wanted again.

---

## Target topology

```
Browser ──HTTPS──▶ Netlify (app.burmy.me)
                        │  Next.js 16 — Netlify's Next.js Runtime (OpenNext-based)
                        │  Server Components, Server Actions, Route Handlers as
                        │  Netlify Functions; src/proxy.ts as a Netlify Edge Function
                        ▼
                  Supabase Postgres
                    (Supavisor pooler, transaction mode, for the app runtime;
                     direct connection for migrations, run manually)

Namecheap (registrar) ──▶ Cloudflare (authoritative DNS only, DNS-only/grey-cloud records)
```

No VPS. No Cloudflare Tunnel. No production Docker host. No systemd. No mandatory Backblaze B2.

---

## External state — what actually exists today

Nothing in this section was performed by Claude; all of it was done manually by the owner, reported
back, and is recorded here for reference. **Claude has not touched Cloudflare, Netlify, Namecheap,
Supabase, or any VPS provider.**

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

### Cloudflare Zero Trust / Access (configured, not currently in the request path)

- A Cloudflare Zero Trust **Free** organization exists.
- Google is configured as the identity provider and a live authentication test against it succeeded.
- A Burmy-OS Access application exists: intended hostname `app.burmy.me`, Google as the only identity
  provider, an exact-email Allow policy, 24-hour application session, Instant Authentication, Cloudflare
  One Client disabled.
- **This configuration is real and complete, but nothing routes traffic through it today.** Access only
  intercepts a request when Cloudflare's edge actually sits in front of it — either via a Tunnel (the
  original, now-abandoned VPS design) or a *proxied* ("orange cloud") DNS record pointed at an origin
  Access is told to protect. `app.burmy.me` has no DNS record at all yet (see "`app.burmy.me`" below),
  so there is currently nothing for Access to gate. See "Authentication — the open decision" — this is
  the one thing that has to be decided, not silently assumed either way.

### Oracle VPS (abandoned, nothing created)

OCI networking configuration was created manually, then VM provisioning was attempted at
`VM.Standard.A1.Flex`, 2 OCPU/12 GB, Ubuntu 24.04 — capacity unavailable in AD-1, AD-2, and AD-3.
Retried at 1 OCPU/6 GB — still unavailable. The remaining Always Free option
(`VM.Standard.E2.1.Micro`) was rejected as too small. **No compute instance was ever created; nothing
was ever deployed.** See "Why the VPS was dropped" above for what this triggered.

---

## Authentication — the open decision

**This is the one thing blocking a real production deploy. Nothing else in this document depends on
it, and it is not decided here — it needs the owner's explicit call.**

`requireOwner()` (`src/server/auth/owner.ts`) has exactly one identity-verification path in
production: a Cloudflare Access JWT, checked against `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD`
(`src/server/auth/access.ts`). There is no in-app credential, no session, no fallback — see
`docs/SECURITY.md`, "Authentication," which is still an accurate description of how the *code* behaves.
The dev bypass triggers only when `NODE_ENV` is exactly `development`; Netlify sets `NODE_ENV=production`
for a production deploy, so the bypass does not apply there.

**The direct consequence: if Netlify serves `app.burmy.me` with Cloudflare's DNS record for it left
DNS-only (grey cloud, not proxied), Access never sees the request, `Cf-Access-Jwt-Assertion` is never
present, and `requireOwner()` fails closed on every single request — including the owner's own.** Not a
bug; exactly the fail-closed behavior `docs/SECURITY.md` documents and wants. But it means the app is
unusable, by anyone, until this is resolved one of two ways:

**Option A — keep Cloudflare Access, proxy the `app.burmy.me` record.** Cloudflare Access can protect a
*proxied* DNS record pointed at any public origin, including Netlify — this does **not** require a
Tunnel; Tunnel was only needed for the original VPS because that origin had no public route at all.
Turning on the orange cloud for `app.burmy.me` alone (leaving the apex/`www` portfolio records
untouched, still DNS-only) puts Cloudflare's edge in front of just that one hostname, which is exactly
what the already-completed Access application, Google IdP, and Allow policy were built for. **Reuses
100% of the external configuration already in place, at zero new services** — the cost is one Cloudflare
setting (DNS-only → Proxied) on one record, which is the "strong verified reason" the owner's own
instructions asked for before forcing the orange cloud on anything.

**Option B — build a minimal owner-auth path inside Burmy-OS itself**, independent of Cloudflare Access,
so the app can authenticate the owner even with Cloudflare staying DNS-only everywhere. This is real
application work (a new verification mechanism, new tests, a new attack surface to review) — not a
config toggle — and is explicitly what "Burmy-OS's own authentication remains the application security
layer" would require if Access is to stay unused going forward, since right now there *is no other*
Burmy-OS authentication mechanism to fall back on; Cloudflare Access **is** Burmy-OS's authentication
today, not a separate layer in front of one.

**Recommendation: Option A.** It requires no new code, no new external service, and no new security
review — only confirming the one Cloudflare record. Option B is a legitimate choice if the owner would
rather Burmy-OS not depend on Cloudflare Access at all going forward, but it should be a deliberate
decision made knowing it's genuinely new authentication work, not a smaller change than it looks.

**Until this is decided, `docs/SECURITY.md`'s "Authentication" section stays accurate as a description
of the code — it does not need to change either way.** What's undecided is purely the deployment-side
question of whether Access sits in front of the request.

---

## Environment variables (Netlify)

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Supabase **pooled** connection string (Supavisor, transaction mode, port `6543`, `?pgbouncer=true`) | The app runtime's connection — see "Database — Supabase Postgres" below for why pooled, not direct. |
| `OWNER_EMAIL` | the owner's Google account email | Same meaning as today — checked against the verified identity on every request. |
| `CF_ACCESS_TEAM_DOMAIN` | the Cloudflare Zero Trust team domain | Needed **only if Option A is chosen** above. Omit entirely if Option B. |
| `CF_ACCESS_AUD` | the Burmy-OS Access application's Audience tag | Same conditionality as `CF_ACCESS_TEAM_DOMAIN`. |
| `NODE_ENV` | `production` | Set by Netlify automatically for production deploys — not something to set manually, listed here only so its presence is never assumed away. |

Not needed at all under the new architecture (all VPS/Docker-only): `POSTGRES_USER`/`POSTGRES_PASSWORD`/
`POSTGRES_DB` (Supabase manages its own Postgres credentials), `TUNNEL_TOKEN`, `RESTIC_REPOSITORY`/
`RESTIC_PASSWORD`, `B2_ACCOUNT_ID`/`B2_ACCOUNT_KEY`, the four `HEALTHCHECKS_*_PING_URL` values.

Set these in Netlify's own dashboard (Site configuration → Environment variables), scoped to the
production deploy context. There is no `.env.<scope>` file scheme to maintain for Netlify — that
five-file split (`docs/DEPLOYMENT.md`'s old "Environment" section, preserved below) existed specifically
to keep VPS containers from seeing credentials they had no use for; Netlify's own environment-variable
store replaces it, with far fewer distinct credentials to begin with.

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

**Migration workflow**, replacing `docker compose run --rm migrate`:

```bash
DATABASE_URL="<supabase direct connection string>" node scripts/migrate.mjs
DATABASE_URL="<supabase direct connection string>" OWNER_EMAIL="<owner email>" node scripts/provision-owner.mjs
```

Run manually, deliberately, from a developer machine with network access to Supabase — not
automatically on every Netlify deploy. Both scripts are already plain ESM with zero Docker dependency
(`scripts/migrate.mjs`'s own header explains why: "It does not need the schema types," so no
TypeScript/tsx toolchain either) — this workflow needed no code change, only a different place to run
them from. `provision-owner.mjs` stays idempotent and safe to re-run.

Local development is unaffected: `docker compose -f compose.dev.yml up -d postgres` +
`docker compose -f compose.dev.yml run --rm --build migrate` continue to work exactly as before, against
the local Postgres container, not Supabase. Drizzle/`drizzle-kit` need no changes — `drizzle.config.ts`
already just reads `DATABASE_URL`.

---

## Backup strategy (simplified)

Supabase's **Free** plan includes no managed backups or point-in-time recovery at all — that starts at
Pro (7 days of daily backups) and PITR is a paid add-on above that. The old restic→B2 pipeline
(`scripts/backup.sh`/`maintenance.sh`/`restore.sh`/`restore-verify-weekly.sh`/`verify.sh`,
`deploy/systemd/burmy-{backup,maintenance,restore-verify}.*`) is real, tested, working code — but it is
VPS-shaped infrastructure (a host to run the timers on) that this architecture no longer has, and
building an equivalent automated pipeline just to protect a Free-tier database was explicitly ruled out
as its own new infrastructure stack.

**Proposed minimal strategy — a manual `pg_dump`, run periodically, no new infrastructure:**

```bash
pg_dump "<supabase direct connection string>" -Fc -f "burmy-$(date +%Y-%m-%d).dump"
```

Run by hand — after a real import, or on whatever cadence feels right for how infrequently the data
actually changes (this is a single-user app; a monthly statement import is the only thing that
meaningfully changes the database) — and saved wherever the owner already keeps things safe (a synced
folder, an external drive, anywhere off the Supabase project itself). Restore is the ordinary
`pg_restore` counterpart, same as `scripts/restore.sh`'s own restore step already does locally.

This is intentionally the simplest thing that provides real protection, not the final word — if Supabase
Free's lack of PITR becomes a real concern later, the options in order of effort are: enable it via a
Supabase Pro upgrade, or a small scheduled job (a Netlify Scheduled Function, or literally a line in the
owner's own crontab) running the `pg_dump` above automatically. Neither is built now, per explicit
instruction not to stand up new infrastructure preemptively.

---

## Deployment sequence

1. Create the Supabase project (external, owner-performed — not done by Claude).
2. Run migrations + owner provisioning against Supabase's **direct** connection string (see "Database"
   above).
3. Create the Burmy-OS Netlify site, pointed at this repository, with the environment variables from
   "Environment variables" above (using Supabase's **pooled** connection string for `DATABASE_URL`).
   `netlify.toml` pins the build command and Node version; no `publish` directory is set, deliberately
   — Netlify's Next.js Runtime wires up SSR/Server Actions/Edge middleware itself.
4. Deploy and verify on the temporary `*.netlify.app` URL, before touching any DNS:
   - Supabase connectivity (the app actually loads and queries succeed)
   - Authentication (resolve the "Authentication — the open decision" question above **first** — this
     step cannot be verified otherwise)
   - CSV import end to end
   - The Finance dashboard renders real data correctly
   - Migrations applied correctly (schema matches `drizzle/`)
5. Only once all of the above is confirmed working: add/update the Cloudflare DNS record for
   `app.burmy.me` pointed at the Netlify site — DNS-only unless Option A (above) was chosen, in which
   case it's proxied specifically so Access can gate it.
6. Verify HTTPS and production auth against the real `app.burmy.me` hostname.

The existing `burmy.me`/`www.burmy.me` portfolio deployment is untouched by any of this — it remains
exactly `→ Netlify` as it is today, and the new Burmy-OS Netlify site is a separate, independent Netlify
project, not a change to the existing one.

---

## Optional: self-hosting on a VPS

**Not the default path.** Everything below is preserved exactly as M10 built and locally tested it —
real, working, documented code — for local development reference and for anyone who later wants to
self-host instead of using Netlify + Supabase. None of it runs, or needs to run, under the default
Netlify + Supabase architecture above.

### Target topology (VPS)

```
Browser ──HTTPS──▶ Cloudflare  (TLS terminates here)
                        │  Access: Google OAuth, allowlisted to OWNER_EMAIL
                        │  outbound-only tunnel — NO inbound ports on the origin
                        ▼
        ┌────────────────── VPS ──────────────────┐
        │  network: edge      (outbound internet) │
        │    cloudflared ──▶ web (Next.js 16)     │
        │                      │                  │
        │  network: dbnet     (internal: true)    │
        │    migrate ──▶ postgres 18 ──▶ pgdata   │
        └─────────────────────────────────────────┘

        Owner's PC ──▶ ordinary key-based SSH ──▶ VPS (admin, deploys)
        ufw default-deny inbound · SSH is the ONE inbound rule · no VPN mesh
```

Deliberately no Tailscale, no VPN, no private admin network — a second piece of infrastructure whose
only job is protecting access to the first was judged not worth its own complexity for a single-owner
personal deployment. Key-only SSH on the public port, with password auth and root login disabled, is
the accepted tradeoff; see "VPS administration" below.

### Two networks — this is not optional

`cloudflared` must reach Cloudflare's edge over the public internet. Placing it on a network marked
`internal: true` **blocks that outbound connection entirely** and the tunnel never comes up.

| Network | `internal` | Members | Purpose |
| --- | --- | --- | --- |
| `edge` | no | `cloudflared`, `web` | Outbound internet for the tunnel |
| `dbnet` | **yes** | `web`, `migrate`, `postgres` | No route off the host, in or out |

`web` is the only service on both. `postgres` has no internet path. `cloudflared` has no database path.

### Postgres 18 volume layout — a silent data-loss trap

PostgreSQL 18's official image changed `PGDATA` to `/var/lib/postgresql/18/docker` and moved the
declared `VOLUME` to `/var/lib/postgresql`.

```yaml
volumes:
  - pgdata:/var/lib/postgresql        # ✅ correct for PG 18+
# - pgdata:/var/lib/postgresql/data   # ❌ pre-18 — starts cleanly, reports healthy, LOSES DATA
```

The wrong path fails **silently**: the container comes up, the healthcheck passes, and the data
disappears the next time the container is recreated. Verified explicitly in Milestone 1 by writing
rows, running `docker compose down && up`, and confirming survival.

### Docker hardening

Built into the `Dockerfile` already (M1/M9): multi-stage build, non-root user (`burmy`, uid 1001),
`output: 'standalone'`, a `HEALTHCHECK` via `node -e fetch(...)` (no curl/wget in the image),
`pnpm install --ignore-scripts`.

Added at the **compose level** for `web` in `compose.yml` (M10), and actually verified against the
real built image, not just written and assumed:

- `read_only: true` + `tmpfs: [/tmp]` — safe because M5 parses uploaded statements **in memory only,
  never to disk**, so there is no known runtime write path. Confirmed directly: `touch /app/x` fails
  with "Read-only file system"; `/tmp` stays writable.
- `init: true` — Docker's built-in tini, for correct SIGTERM forwarding and zombie reaping, cheaper
  than baking tini into the image.
- `stop_grace_period: 15s` — real drain time for in-flight requests before SIGKILL.
- **No per-container resource limits**, deliberately — one container set on a single small instance; a
  hard cap risks an unhelpful OOM-kill rather than buying anything at this scale.
- `arm64`: no Dockerfile change needed — `node:24-alpine` is already multi-arch, and the image is
  built ON the box itself (`scripts/deploy.sh`), never cross-compiled or pulled from a registry.

Confirmed working end to end locally (`docker compose up web` against the real built image, with
`/api/health` responding) — this surfaced one real, previously-latent bug: `output: 'standalone'`
does not reliably trace `@swc/helpers` under pnpm, and the image crash-looped on `MODULE_NOT_FOUND`
until fixed (see CLAUDE.md). Dev has always run via `pnpm dev` on the host, so nothing before M10 ever
actually started this image.

### Host provisioning

```bash
./scripts/provision.sh   # as root, over the provider's initial console
```

One command, because "limited Linux experience" is a stated constraint. It installs Docker, configures
`ufw` (default-deny inbound, SSH is the one allowed port), disables root login and password auth over
SSH, creates the app user (reusing root's authorized key so access survives disabling root login),
and prepares the systemd timer directory. Ubuntu/Debian (`apt`) assumed. **Untested against a real VPS
as of this commit** — reviewed carefully, but there is no way to exercise `ufw`/`sshd` changes against
a real remote host from this project's development machine; the first real run against an actual VPS
would be the test, if this path is ever picked up again.

No Tailscale, no VPN, no auth key to generate — see "Target topology (VPS)" above for why. SSH stays
on its normal port, reachable from anywhere, secured by key-only authentication and disabled
password/root login, which is judged sufficient for a single-owner deployment.

Sized to 2 OCPU / 12 GB on Oracle's Ampere A1 Always Free tier as originally planned — **capacity was
unavailable when this was actually attempted; see "Oracle VPS (abandoned, nothing created)" above.**
The architecture does not depend on this specific size or provider and remains portable to a smaller
instance or a different provider (Hetzner, Vultr, DigitalOcean, a machine under a desk) — see
"Provider portability" below.

### Image versioning — how rollback works with no registry

There is no image registry. `scripts/deploy.sh` builds locally, on the box, and tags every build with
the immutable git short-SHA:

```
burmy-web:<sha>        burmy-migrator:<sha>       (built once, never overwritten)
burmy-web:current      burmy-migrator:current     (what compose.yml actually runs — retagged, not rebuilt)
burmy-web:previous     burmy-migrator:previous    (what `current` pointed at before THIS deploy)
```

Rollback is therefore `docker tag burmy-web:previous burmy-web:current` plus a restart — instant, and
it cannot accidentally resurrect a *different*, later commit's code under the "previous" name, the way
re-pulling a floating `:latest` tag could. After a successful deploy, SHA tags older than `KEEP_IMAGES`
(default 5) are pruned, sorted by the image's actual **build time** (`docker images`'s own `CreatedAt`)
— never by the tag string itself, since a git short-SHA has no chronological ordering as text (a real
bug in an earlier draft, caught by testing a simulated deploy sequence — see CLAUDE.md).

Pruning never runs during a rollback, only after a successful deploy.

### Deploying

Run directly on the VPS, from inside the cloned repo, after reaching it over ordinary key-based SSH —
`scripts/deploy.sh` contains no SSH logic of its own. **CI never holds credentials that can reach the
VPS** — a compromised GitHub Action cannot touch the server.

```bash
ssh burmy@<vps-ip>
cd burmy-os && ./scripts/deploy.sh
```

```
preflight        clean working tree
   ↓
git pull --ff-only
   ↓
start postgres (if not already running) → wait healthy   ← does NOT assume a
   ↓                                                        pre-running stack;
pre-deploy pg_dump (safety ARTIFACT, not a rollback trigger) the same script
   ↓                                                        runs the DR sequence's
retag current -> previous                                   "start Postgres only"
   ↓                                                        step too
build (immutable git-SHA tag + current alias), on the box — arm64, no registry, no QEMU
   ↓
docker compose run --rm migrate         (migrations run IN the image)
   ↓
docker compose run --rm migrate node scripts/provision-owner.mjs   (idempotent, every deploy)
   ↓
docker compose up -d web cloudflared
   ↓
healthcheck /api/health, polled up to 30s
   ↓
FAIL → retag previous -> current (WEB IMAGE ONLY) · restart web · Postgres untouched
       · print the pre-deploy dump path and last 200 log lines · exit non-zero
SUCCEED → prune old SHA-tagged images (keep current, previous, last 5 by build time)
```

#### The database is never restored automatically

An earlier draft rolled the database back to the pre-migration dump on healthcheck failure. **That was
dangerous and was removed.**

A failed healthcheck usually means a bad build, a missing environment variable, or a transient startup
race. The database is typically fine, and may already hold newer writes. Restoring a dump in that
situation destroys real data to fix a problem the data had nothing to do with — automatically, at the
moment the owner is least able to reason about it.

- **On healthcheck failure:** previous image tag restarted, Postgres untouched, diagnostics printed.
- **The pre-deploy dump is retained (not deleted) and its path printed**, so a human can choose to use
  it — the one deliberate exception to the "never intentionally retain a plaintext dump" rule below,
  since this one exists specifically FOR a human to inspect after a bad deploy, not as routine backup
  output.
- **If the migration itself failed**, the script says so and stops — rolling an image back under a
  partially-migrated schema is its own hazard, and that call belongs to a person.
- **Restoring is always a separate explicit command** (`scripts/restore.sh`) with typed confirmation.
  Never a deploy side effect.

### CI

`.github/workflows/ci.yml` — on every push to `main` and every pull request: `typecheck`, `lint`,
`test` (unit), `test:integration` (Testcontainers), `test:e2e` (Playwright, against a service-container
Postgres), `build`. **Test-only.** No production secrets, no deploy capability — the one Postgres
password it uses is a throwaway value scoped to that job's own ephemeral service container, never
reused anywhere real. **Unchanged by the Netlify/Supabase move** — this gate has nothing to do with
which architecture the app deploys to; Netlify runs its own separate build/deploy on push, independent
of this workflow.

**No deployment credentials exist in CI.** Deployment (either path) is manual and credential-gated by
design — SSH keys for the VPS path, Netlify's own dashboard/CLI auth for the default path.

### Environment (VPS) — secrets scoped by consumer, not one blanket file

Five separate files, each `0600`, owned by the app user, each `env_file`-injected into only the
compose service(s) that actually need it — never one file handed to every container:

| File | Consumed by | Contents |
| --- | --- | --- |
| `.env.postgres` | `postgres` only | `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` |
| `.env.database` | `web`, `migrate` | `DATABASE_URL` (password must match `.env.postgres`, written once, not derived) |
| `.env.app` | `web`, `migrate` | `OWNER_EMAIL`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` — `migrate` needs `OWNER_EMAIL` too, since `scripts/deploy.sh` runs `provision-owner.mjs` through this same image |
| `.env.tunnel` | `cloudflared` only | `TUNNEL_TOKEN` |
| `.env.backup` | **no container at all** | `RESTIC_REPOSITORY` / `RESTIC_PASSWORD` / `B2_ACCOUNT_ID` / `B2_ACCOUNT_KEY` / four `HEALTHCHECKS_*_PING_URL` values — read directly by `scripts/{backup,maintenance,restore,restore-verify-weekly,check-host}.sh`, host-level shell scripts, never injected into Docker |

`web` never receives B2/restic/Tunnel credentials it has no use for — the property this scoping exists
to guarantee. Each `.env.<scope>.example` (committed) is the placeholder template; the real files are
gitignored and never committed. No secrets platform (Vault, SOPS, cloud KMS) — five host-level files
with correct permissions are sufficient for one host, one operator. **This whole scheme is VPS-only —
the default Netlify path uses Netlify's own environment-variable store instead; see "Environment
variables (Netlify)" above.**

### Provider portability

Nothing in the application is Oracle-specific. The compose file, provisioning script and restore path
are identical on Hetzner, Vultr, DigitalOcean or a machine under a desk — the only differences are
architecture (`arm64` on Oracle, `x86` on most others) and the provider console. This is exactly what
made abandoning Oracle for the Netlify/Supabase path a clean decision rather than a rewrite: nothing
here was ever locked to Oracle specifically.

### VPS administration

Plain SSH, not a VPN mesh (see "Target topology (VPS)"). Concretely, from `scripts/provision.sh`:

- Key-based authentication only; password authentication disabled in `sshd_config`.
- Root login disabled; the app user is created with root's own authorized key copied over first, so
  access survives that change.
- `ufw` default-denies all inbound traffic and allows exactly one port: SSH. Burmy-OS itself and
  Postgres are never given a firewall rule at all — the app is reached exclusively through the
  outbound-only Cloudflare Tunnel, and Postgres has no route to the internet on the `internal: true`
  `dbnet` network regardless of any firewall rule.
- No public web port for Burmy-OS, no public Postgres port, and no second private network built
  solely to reach SSH — the single inbound firewall rule *is* the admin path.

### Deferred for V1 (within the VPS path) — optional, not required, nothing deleted

Owner decision, from the original VPS-era simplification: reduce infrastructure complexity for launch.
Each of these existed in an earlier draft of the VPS plan; none were removed from the repo, all are
clearly labeled where they live:

| Deferred | Where it still lives | How to opt in later |
| --- | --- | --- |
| Tailscale / VPN-gated admin access | Not in the repo at all — `scripts/provision.sh` was rewritten around plain SSH | A deliberate follow-up decision, not a flag to flip |
| healthchecks.io monitoring | `scripts/{backup,maintenance,restore-verify-weekly,check-host}.sh`'s `ping()` calls — genuine no-ops when the four `HEALTHCHECKS_*_PING_URL` vars in `.env.backup` are blank | Fill in the four ping URLs |
| Automated weekly restore verification | `scripts/restore-verify-weekly.sh` + `deploy/systemd/burmy-restore-verify.{service,timer}`, marked `[OPTIONAL]`, not enabled by `provision.sh` | Copy the two unit files, `systemctl enable --now burmy-restore-verify.timer` |
| Daily host check (disk/restart-loop) | `scripts/check-host.sh` + `deploy/systemd/burmy-check-host.{service,timer}`, marked `[OPTIONAL]`, not enabled by `provision.sh` | Copy the two unit files, `systemctl enable --now burmy-check-host.timer` |
| Quarterly DR drills | `docs/BACKUP_RESTORE.md`'s DR sequence remains fully documented and usable manually | Run it by hand whenever wanted; not scheduled |

If self-hosting is picked up again, what was **required** for the VPS path's own V1: nightly backup
(`burmy-backup.timer`), weekly repository maintenance (`burmy-maintenance.timer`), and one manual
restore-and-verify proof before launch. `docs/BACKUP_RESTORE.md` still documents all of this in full —
untouched by the Netlify/Supabase move.

---

## Launch checklist — Definition of Done for the default (Netlify + Supabase) path

Real financial data does not touch production until every item below is demonstrated, not assumed:

1. The "Authentication — the open decision" question above is resolved (Option A or B), and confirmed
   working end to end on the deployed app, not just configured.
2. Netlify build succeeds against this repo with no configuration beyond `netlify.toml` and the
   environment variables in "Environment variables (Netlify)".
3. Migrations applied correctly against Supabase (`scripts/migrate.mjs`, direct connection) — schema
   matches `drizzle/`.
4. Owner is resolved correctly (`provision-owner.mjs` run once, `requireOwner()` succeeds for the real
   owner identity and fails closed for anything else).
5. `app.burmy.me` resolves to the Netlify deployment and HTTPS is healthy.
6. Unauthorized access fails closed (confirmed against the real deployed app, not just unit tests).
7. CSV import, categorization, and the Finance dashboard all work correctly against real Supabase data.
8. A manual `pg_dump` against the live Supabase database succeeds and is verified restorable
   (`pg_restore` into a scratch database, same verification spirit as the old `scripts/verify.sh`).
9. All application test/build gates remain green: `pnpm typecheck` / `lint` / `test` / `test:integration`
   / `test:e2e` / `build`.

If self-hosting is chosen instead (Option B or a future reversal back to a VPS), the original 13-point
VPS launch checklist is preserved in git history (this file, before this rewrite) and in
`docs/BACKUP_RESTORE.md`'s own DR checklist, which was never specific to any one hosting path.
