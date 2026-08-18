# Deployment

> **Status: repo-side M10 pieces are implemented and locally tested (production `compose.yml`, all
> `scripts/*.sh`, systemd units, CI) against the SIMPLIFIED architecture below. External infrastructure
> — the actual VPS, Cloudflare Tunnel/Access, Backblaze B2 bucket — has NOT been created yet; see
> "External setup" below for the exact manual steps still outstanding. Nothing here should be read as
> "already deployed".

**Simplified scope (owner decision):** `VPS + Cloudflare Access with Google + Burmy-OS/Postgres + B2
backups.` Nothing more, unless a concrete blocker shows up. Tailscale, healthchecks.io, automated
weekly restore verification, and quarterly DR drills were all in an earlier draft of this plan and are
now explicitly deferred — see "Deferred for V1" near the end of this document for exactly what that
means and why nothing was deleted, only made optional.

Production launch deliberately comes **after** transactions, export, reconciliation, hardening and a
verified backup/restore. Real financial data does not touch production until recovery has been proven —
see the 13-point launch checklist at the end of this document.

---

## Target topology

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

---

## Two networks — this is not optional

`cloudflared` must reach Cloudflare's edge over the public internet. Placing it on a network marked
`internal: true` **blocks that outbound connection entirely** and the tunnel never comes up.

| Network | `internal` | Members | Purpose |
| --- | --- | --- | --- |
| `edge` | no | `cloudflared`, `web` | Outbound internet for the tunnel |
| `dbnet` | **yes** | `web`, `migrate`, `postgres` | No route off the host, in or out |

`web` is the only service on both. `postgres` has no internet path. `cloudflared` has no database path.

---

## Postgres 18 volume layout — a silent data-loss trap

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

---

## Docker hardening

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

---

## Host provisioning

```bash
./scripts/provision.sh   # as root, over the provider's initial console
```

One command, because "limited Linux experience" is a stated constraint. It installs Docker, configures
`ufw` (default-deny inbound, SSH is the one allowed port), disables root login and password auth over
SSH, creates the app user (reusing root's authorized key so access survives disabling root login),
and prepares the systemd timer directory. Ubuntu/Debian (`apt`) assumed. **Untested against a real VPS
as of this commit** — reviewed carefully, but there is no way to exercise `ufw`/`sshd` changes against
a real remote host from this project's development machine; the first real run against the actual VPS
is the test.

No Tailscale, no VPN, no auth key to generate — see "Target topology" above for why. SSH stays on its
normal port, reachable from anywhere, secured by key-only authentication and disabled password/root
login, which is judged sufficient for a single-owner deployment.

**Right-sized to 2 OCPU / 12 GB** on Oracle's Ampere A1 Always Free tier (the current documented total,
not the 1 OCPU / 6 GB figure an earlier draft of this plan assumed) — ample for one user either way,
and using the larger allotment where available is a marginal hedge against the idle-reclamation policy
below, not a requirement. The architecture does not depend on this specific size and remains portable
to a smaller instance or a different provider if OCI capacity is unavailable when provisioning — see
"Provider portability".

---

## Image versioning — how rollback works with no registry

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

---

## Deploying

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

### The database is never restored automatically

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

---

## CI

`.github/workflows/ci.yml` — on every push to `main` and every pull request: `typecheck`, `lint`,
`test` (unit), `test:integration` (Testcontainers), `test:e2e` (Playwright, against a service-container
Postgres), `build`. **Test-only.** No production secrets, no deploy capability — the one Postgres
password it uses is a throwaway value scoped to that job's own ephemeral service container, never
reused anywhere real.

**No deployment credentials exist in CI.** Deployment is manual and SSH-key-gated by design.

---

## Environment — secrets scoped by consumer, not one blanket file

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
with correct permissions are sufficient for one host, one operator.

---

## Provider portability

Nothing in the application is Oracle-specific. The compose file, provisioning script and restore path
are identical on Hetzner, Vultr, DigitalOcean or a machine under a desk — the only differences are
architecture (`arm64` on Oracle, `x86` on most others) and the provider console.

**This is deliberate.** Oracle halved its Always Free ARM allowance in June 2026 with no announcement,
and reclaims idle instances. Migration is a rehearsed restore drill, not an emergency.

---

## DNS strategy for `app.burmy.me` — investigated, nothing changed yet

**No DNS, Cloudflare, Netlify, Namecheap, VPS, or B2 change has been made.** This section is the
investigation the owner asked for, corrected once already (see "Corrected from an earlier draft"
below), so a real migration plan can be reviewed before anything external is touched.

### Corrected from an earlier draft of this section

An earlier version of this document recommended delegating only the `app` subdomain to Cloudflare via
an NS record inside Netlify's DNS panel, leaving `burmy.me`'s authoritative DNS on Netlify/NS1
entirely. **That recommendation was wrong and has been withdrawn.** Cloudflare's subdomain-only /
partial (CNAME) setup — the feature that recommendation depended on — is **not available on Cloudflare
Free or Pro**; Cloudflare gates it to Enterprise. This project assumes **Cloudflare Free** unless a
concrete reason to pay for a higher plan shows up, so that path is not available here, full stop.

### The corrected strategy: move DNS authority, not the website

**`burmy.me`'s full DNS zone moves to Cloudflare. Netlify keeps hosting the site.** These are two
separate facts and it matters that they don't get conflated:

- **DNS authority** (which nameservers answer queries for `burmy.me`) moves from NS1/Netlify DNS to
  Cloudflare.
- **Website hosting** (what actually serves `burmy.me` and `www.burmy.me`'s content) stays on Netlify,
  completely unchanged. Cloudflare's DNS records for the apex and `www` simply point at the same
  Netlify infrastructure the current Netlify DNS records point at today — reproduced, not replaced.
- Every Netlify/website-facing record is added to Cloudflare **DNS only** (grey cloud, not the orange
  "Proxied" cloud) unless a concrete, verified reason to proxy one shows up later. Proxying changes
  the IP Netlify itself sees traffic arrive from and can interact with Netlify's own SSL — not a
  default to reach for.
- `app.burmy.me` is the **one** new record, added after the migration is verified healthy, pointing at
  the Cloudflare Tunnel instead.

### What's there today — from public, read-only lookups (no account access)

| Query | Result |
| --- | --- |
| `burmy.me` A | `98.84.224.111`, `18.208.88.157` |
| `www.burmy.me` A | `98.84.224.111`, `18.208.88.157` (same two addresses — not a CNAME; `-type=CNAME` for `www` returned no record) |
| `burmy.me` MX | none found |
| `burmy.me` TXT | none found |
| `_dmarc.burmy.me` TXT | **NXDOMAIN — confirmed absent**, not just unqueried |
| `burmy.me` NS | `dns1-4.p06.nsone.net` |
| SOA | `responsible mail addr = domains+netlify.netlify.com` → **hosted on Netlify**, using Netlify's own DNS product (built on NS1, hence the `nsone.net` nameservers) |

**Read from this, cautiously:** no email appears to be configured for `burmy.me` today (no MX, no SPF/
DMARC TXT) — if true, that's one whole category (email/SPF/DKIM/DMARC) the migration doesn't need to
carry. But a non-authoritative public resolver is not the source of truth here, and TTL values aren't
visible through this lookup method at all. **Per the "do not invent records" rule below, this table is
a starting point the Netlify dashboard must confirm or correct, not a substitute for it.**

### Confirmed from the actual Netlify dashboard (the real source of truth)

The owner opened Netlify → Domains → `burmy.me` → DNS directly and shared the real record list.
**Only 2 DNS records exist, both TTL 3600:**

| Type | Name | Value/Target |
| --- | --- | --- |
| `NETLIFY` | `burmy.me` | `infallible-visvesvaraya-eefd80.netlify.app` |
| `NETLIFY` | `www.burmy.me` | `infallible-visvesvaraya-eefd80.netlify.app` |

No MX, no TXT, no other subdomains — confirms the public-lookup inference above, now from the
authoritative source rather than an inference. IPv6 is **not enabled** (Netlify's dashboard shows an
unclicked "Enable IPv6" prompt) — nothing to carry over there either.

**One real correction this revealed:** `NETLIFY` is **not a standard DNS record type** — it's Netlify's
own dynamic record, resolved by Netlify's nameservers at query time to whatever load-balancer IPs are
currently live. The two A records the public lookup found (`98.84.224.111`, `18.208.88.157`) were only
*that moment's* resolved snapshot of this record, not a stable value. Reproducing them as static A
records in Cloudflare — the plan this table originally sketched — would work today and then silently
break the day Netlify ever rotates those IPs, exactly the scenario Netlify's own dynamic record type
exists to make invisible to the customer.

**The correct equivalent: a CNAME pointed at the same target**, `infallible-visvesvaraya-eefd80.netlify.app`,
not at its resolved IPs. `www.burmy.me` is an ordinary subdomain, so a plain CNAME works directly.
`burmy.me` is the zone apex, where a literal CNAME isn't allowed by the DNS standard — Cloudflare's
answer is **CNAME flattening**, a long-standing **Free**-tier feature (unrelated to the
Enterprise-gated partial-zone issue that ruled out the original subdomain-delegation idea — this is a
different Cloudflare feature, available regardless of plan) that lets a CNAME-shaped record sit at the
root and resolves it dynamically underneath, tracking the target the same way Netlify's own record
type does.

### DNS migration checklist

**Stop-and-confirm gate: Namecheap's nameservers are not touched until step 9 is explicitly approved.**

1. ✅ **DONE — inventory every currently published record.** Confirmed directly from the Netlify
   dashboard (Netlify → Domains → `burmy.me` → DNS), not just inferred from public lookup: **exactly 2
   records**, both TTL 3600, both the `NETLIFY` dynamic type, no MX/TXT/other subdomains, IPv6 not
   enabled. See "Confirmed from the actual Netlify dashboard" above.
2. ✅ **DONE — Netlify-dashboard confirmation.** Superseded step 1's public-lookup guess; nothing left
   unconfirmed for this domain's DNS.
3. **Record inventory table — CONFIRMED**, current Netlify config on the left, the Cloudflare
   recreation plan on the right:

   | Type (Netlify) | Hostname | Netlify value | TTL | → | Type (Cloudflare) | Cloudflare value | Proxy status |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | `NETLIFY` | `burmy.me` | `infallible-visvesvaraya-eefd80.netlify.app` | 3600 | → | CNAME (flattened at apex) | `infallible-visvesvaraya-eefd80.netlify.app` | **DNS only** |
   | `NETLIFY` | `www.burmy.me` | `infallible-visvesvaraya-eefd80.netlify.app` | 3600 | → | CNAME | `infallible-visvesvaraya-eefd80.netlify.app` | **DNS only** |
   | — | — | *(no MX, no TXT, no other subdomains — confirmed, not inferred)* | | | *(nothing else to recreate)* | | |
   | — | `app.burmy.me` | *(does not exist yet)* | — | → | CNAME | Cloudflare Tunnel's assigned target | **DNS only** (the Tunnel handles routing without needing the orange cloud) — added later, after the migration above is verified healthy |

   The `→` column is the one real translation, not a literal copy: `NETLIFY` isn't a portable record
   type, so its target is reproduced as a flattened CNAME rather than the point-in-time A records a
   public lookup would have suggested — see "Confirmed from the actual Netlify dashboard" above for why
   that distinction matters.
4. **Preserve everything required for**: the Netlify apex site, `www`. Email/MX/SPF/DKIM/DMARC and any
   other subdomain/service are confirmed **not present** — nothing there to preserve.
5. ✅ **DONE — the real current configuration is the source of truth.** Nothing in the table above is
   invented from generic Netlify documentation — every row is the actual Netlify dashboard's own
   record list, confirmed directly, not inferred.
6. **Create the Cloudflare zone first** — add `burmy.me` in Cloudflare, note the two nameservers it
   assigns. This alone changes nothing (Namecheap still points at NS1 until step 9).
7. **Reproduce every required record from the completed table inside Cloudflare**, DNS-only, before
   touching Namecheap.
8. **Comparison checklist** — side by side, Netlify DNS vs. the new Cloudflare zone, for owner
   sign-off before cutover:
   - [ ] Every row in the record inventory table exists in Cloudflare with an identical value.
   - [ ] Proxy status is **DNS only** for every website/email record (nothing accidentally proxied).
   - [ ] No extra record exists in Cloudflare that isn't in the inventory (nothing invented).
   - [ ] TTLs are sane (Cloudflare's DNS-only defaults are fine; they don't need to match Netlify's
     exactly, but shouldn't be absurdly long during the cutover window).
9. **Only after that comparison is explicitly approved** does the Namecheap nameserver change happen —
   from the four `nsone.net` servers to Cloudflare's two.
10. **Post-cutover verification** (DNS propagation can take up to ~48h in the worst case, though
    usually much faster):
    - [ ] `burmy.me` resolves
    - [ ] `www.burmy.me` resolves
    - [ ] The existing Netlify site loads correctly, full visual/functional check, not just "a page
      loads"
    - [ ] HTTPS/SSL is healthy (Netlify's cert continues working, or Cloudflare's own edge cert takes
      over cleanly — confirm which, don't assume)
    - [ ] Any existing redirects still behave correctly
    - [ ] Email-related DNS records still resolve correctly (moot if step 2 confirms no email exists,
      but checked either way, not assumed)
11. **Only once the existing site is confirmed healthy** does `app.burmy.me` get created:
    Cloudflare Tunnel → Cloudflare Access → Google OAuth identity provider. Not before.
12. VPS provisioning and Backblaze B2 setup remain separate, later stop-points — unrelated to the DNS
    migration and not blocked by it, but still not started until their own turn.

### Next step

Steps 1, 2 and 5 are done — the record inventory is confirmed from the real Netlify dashboard, not
inferred. Two small confirmations outstanding before step 6 (creating the Cloudflare zone):

1. OK with CNAME flattening as the apex mechanism (the one real translation from Netlify's own
   `NETLIFY` record type, not a literal copy)?
2. IPv6 stays off, matching Netlify's current unclicked state?

Waiting on those, then your explicit approval at step 9's gate before any Namecheap change. Nothing
past step 5 (this document) has been touched — no Cloudflare zone, no Netlify record, no Namecheap
change.

---

## VPS administration

Plain SSH, not a VPN mesh (see "Target topology"). Concretely, from `scripts/provision.sh`:

- Key-based authentication only; password authentication disabled in `sshd_config`.
- Root login disabled; the app user is created with root's own authorized key copied over first, so
  access survives that change.
- `ufw` default-denies all inbound traffic and allows exactly one port: SSH. Burmy-OS itself and
  Postgres are never given a firewall rule at all — the app is reached exclusively through the
  outbound-only Cloudflare Tunnel, and Postgres has no route to the internet on the `internal: true`
  `dbnet` network regardless of any firewall rule.
- No public web port for Burmy-OS, no public Postgres port, and no second private network built
  solely to reach SSH — the single inbound firewall rule *is* the admin path.

---

## External setup — not yet done, needs the owner

Nothing below is a repo/code change. None of it has been performed as of this commit; each is a real,
often hard-to-reverse external action, so none of it is done unilaterally. **Stop-and-confirm, one
service at a time** — not all of this at once.

**Netlify and Namecheap are not new services** — `burmy.me` already runs on both today; they only
appear below because the DNS migration touches them, not because they're being newly added.

1. **A Cloudflare account** (Free plan), so the `burmy.me` zone can be created — the first concrete
   step of the DNS migration checklist above (step 6). Creating the zone alone changes nothing. Two
   small confirmations first (CNAME flattening at the apex, IPv6 staying off) — see "Next step" above.
2. ✅ **DONE** — the Netlify-dashboard confirmation (checklist step 2). The record inventory is
   complete: 2 records, no email, no other subdomains.
3. **Explicit approval of the comparison checklist** (step 8) before I change anything at Namecheap
   (step 9).
4. *(Only after the migrated site is confirmed healthy — step 11)*: Cloudflare Zero Trust / Access
   enabled on the same Cloudflare account, plus a Google Cloud Console OAuth client for Access's
   Google identity provider.
5. VPS provider account — Oracle Cloud Always Free as documented, or a different provider. Unrelated
   to the DNS migration; can happen in parallel or after, your call.
6. Backblaze B2 account, one bucket, one application key scoped to that bucket. Also unrelated to DNS;
   its own later stop-point.
7. Password manager entries for: `RESTIC_PASSWORD` (+ a **printed offline copy**), `TUNNEL_TOKEN`,
   B2 keys, `POSTGRES_PASSWORD`, `OWNER_EMAIL`.
8. Initial SSH access to the VPS (cloud console) so `scripts/provision.sh` can run.

That's the complete list under the simplified scope — no Tailscale account, no healthchecks.io account
required. See "Deferred for V1" below if either is wanted later.

---

## Deferred for V1 — optional, not required, nothing deleted

Owner decision: reduce infrastructure complexity for the initial launch. Each of these existed in an
earlier draft of this plan; none were removed from the repo, all are clearly labeled where they live:

| Deferred | Where it still lives | How to opt in later |
| --- | --- | --- |
| Tailscale / VPN-gated admin access | Not in the repo at all — `scripts/provision.sh` was rewritten around plain SSH | A deliberate follow-up decision, not a flag to flip |
| healthchecks.io monitoring | `scripts/{backup,maintenance,restore-verify-weekly,check-host}.sh`'s `ping()` calls — genuine no-ops when the four `HEALTHCHECKS_*_PING_URL` vars in `.env.backup` are blank | Fill in the four ping URLs |
| Automated weekly restore verification | `scripts/restore-verify-weekly.sh` + `deploy/systemd/burmy-restore-verify.{service,timer}`, marked `[OPTIONAL]`, not enabled by `provision.sh` | Copy the two unit files, `systemctl enable --now burmy-restore-verify.timer` |
| Daily host check (disk/restart-loop) | `scripts/check-host.sh` + `deploy/systemd/burmy-check-host.{service,timer}`, marked `[OPTIONAL]`, not enabled by `provision.sh` | Copy the two unit files, `systemctl enable --now burmy-check-host.timer` |
| Quarterly DR drills | `docs/BACKUP_RESTORE.md`'s DR sequence remains fully documented and usable manually | Run it by hand whenever wanted; not scheduled |

What's still **required** for V1: nightly backup (`burmy-backup.timer`), weekly repository maintenance
(`burmy-maintenance.timer` — retention/pruning, a different concern from restore *verification*, and
not part of this deferral), and the **one manual** restore-and-verify proof before launch (Launch
checklist, item 11).

---

## Launch checklist — the actual Definition of Done for M10

Real financial data does not touch production until every item below is demonstrated, not assumed:

1. Production container starts cleanly
2. Database migrations execute correctly
3. Owner is resolved correctly
4. `app.burmy.me` works
5. Real Cloudflare Google Access works
6. Unauthorized access fails closed
7. Direct origin exposure is prevented/restricted
8. Backup completes
9. Backup integrity/check succeeds
10. Disposable restore succeeds
11. Restored app/data is verified
12. Documented DR procedure is usable
13. All application test/build gates remain green
