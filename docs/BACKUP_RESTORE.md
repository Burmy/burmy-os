# Backup & Restore

> **A backup that has never been restored is not a backup. It is a hope.**

The riskiest window in this project is between "months of hand-categorized financial history exist"
and "a restore has actually been tested". Everything below is sequenced to close that window early.

---

## What is actually irreplaceable

Ranked, because the ranking drives the order of work.

| Asset | Replaceable? | Where it lives |
| --- | --- | --- |
| **The owner's local CSV archive** | **No.** Bank of America serves only ~12–18 months of history online. Anything older exists on the owner's disk and nowhere else. | Owner's PC |
| **The owner's Excel sheets** | **No.** Years of hand-verified categorization decisions — the reconciliation ground truth. | Owner's PC |
| The Postgres database | **Yes** — rebuildable from the CSV archive by re-running imports, at the cost of redoing review decisions | VPS |
| Secrets / recovery credentials | Yes, by rotation — but rotation requires access, which requires them | Password manager, offline |
| Source code | Yes | GitHub |

The database is *derived*. The CSV archive is *source*. That is why the archive is backed up before a
single line of import code is written.

---

## Stage 1 — The archive (Milestone 1, manual, before anything else)

No VPS, no restic, no infrastructure. This happens on day one.

1. **Inventory.** Locate every BoA CSV export and every Excel tracking sheet. Record filenames, sizes
   and a SHA-256 manifest.
2. **Copy to two destinations**, at least one off the owner's primary machine (external drive,
   encrypted cloud folder, or both).
3. **Verify** by re-hashing at each destination and diffing against the manifest. A copy that has not
   been hash-verified has not been verified.
4. **Never** place these files inside this repository. `.gitignore` blocks `*.csv` and `*.xlsx`
   repo-wide precisely because that mistake is easy and unrecoverable once pushed.

**Status: pending — awaiting archive location from the owner.**

---

## Stage 2 — Local development

> **Correction (M10):** the dedicated `--local` flag this section originally proposed was never
> actually built — only `scripts/migrate.mjs` and `scripts/provision-owner.mjs` existed before M10.
> Local dev data is synthetic (`pnpm db:seed`) and disposable by design (CLAUDE.md: no real financial
> data ever touches a local database), so a separate local-only backup tool was never a real gap in
> practice. What actually exists now is the SAME `scripts/backup.sh` M10 built for production, usable
> locally by pointing `.env.backup`'s `RESTIC_REPOSITORY` at a local filesystem path instead of a
> `b2:...` URL and overriding `BACKUP_SCRATCH_DIR` — exercised exactly this way while testing M10
> itself, no B2 credentials required.

---

## Stage 3 — Production automation (Milestone 10, before the first real import)

> **Status: implemented and tested locally** (`scripts/{backup,maintenance,restore,
> restore-verify-weekly}.sh` + the systemd units under `deploy/systemd/`), against a real local restic
> repository and real seeded Postgres data — not yet run against the actual production VPS/B2, since
> that infrastructure doesn't exist yet (see `docs/DEPLOYMENT.md`, "External setup").

**Three separate systemd timers, not one combined nightly job** (owner decision, M10) — repository
maintenance and restore verification are real work that a nightly backup should not pay for every
single night:

```
Nightly, 03:00 — scripts/backup.sh
    ├─ pg_dump -Fc                                        (Postgres's own consistent snapshot,
    ├─ manifest: row counts, per-year SUM(amount_cents),   NEVER a copy of the live pgdata dir)
    │  latest transaction date — coarse facts only, never row content
    ├─ restic backup (dump + manifest, AES-256, client-side, deduplicated)  →  b2:burmy-backups
    └─ healthchecks.io: /start on begin, plain ping on success, /fail on any failure

Weekly, Sunday 04:00 — scripts/maintenance.sh
    ├─ restic forget --prune   →  7 daily · 4 weekly · 12 monthly · 3 yearly
    └─ restic check            (repository integrity)

Weekly, Sunday 05:00 — scripts/restore-verify-weekly.sh (after maintenance)
    └─ scripts/restore.sh --snapshot latest --target scratch, then destroyed
       — the only automated caller of restore.sh, and the only one that can EVER reach
       --target scratch; --target production always requires a human and typed confirmation
```

**Retention rationale.** A compressed dump of years of personal transactions is single-digit megabytes,
so retention is effectively free. The 3 yearly snapshots are deliberate: the failure mode that actually
matters is not disk loss but **silent corruption discovered months later**, and 12 monthly snapshots
may not reach far enough back to find a clean copy.

**RPO ≈ 24 hours**, given the nightly cadence and the app's own once-a-month usage pattern — worst
case is a handful of review corrections, not a whole import. **RTO < 30 minutes**, proven by the timed
DR drill below, not assumed.

**Backblaze B2 never sees plaintext.** restic encrypts client-side on the VPS; keys never leave it.
First 10 GB is free and this dataset stays far inside that.

### Plaintext dump handling — nothing is intentionally retained

`scripts/backup.sh` creates the dump and manifest with `umask 077` (never group/world readable for the
instant they exist) and removes both with a single `EXIT` trap that fires on success **and** on any
failure alike — confirmed directly: after a real local run, the scratch directory is empty either way.
An earlier design considered leaving a failed run's plaintext dump for inspection; the owner rejected
that explicitly — an unencrypted copy of years of financial history sitting on disk after a failed run
is exactly the risk restic exists to remove. On failure, the monitor signal and the script's own log
output are the diagnostic trail, not a leftover file.

The **one** deliberate exception: `scripts/deploy.sh`'s pre-deploy safety dump is kept (not deleted) on
purpose — it exists specifically for a human to inspect after a bad deploy, not as routine backup
output, and is a one-off artifact rather than something a timer produces every night.

### Secrets are deliberately NOT in this backup

`.env.postgres` / `.env.database` / `.env.app` / `.env.tunnel` / `.env.backup` (see
`docs/DEPLOYMENT.md`, "Environment") and the restic password itself live in the **password manager**
and the offline recovery process — never inside the backup contents.

Bundling them with the data would mean a single stolen backup carries both the ciphertext and the keys
to decrypt it. Keep them separate.

> **The restic password must exist somewhere outside the VPS — password manager plus a printed copy.**
> A backup you cannot decrypt is not a backup.

### Monitoring — healthchecks.io, start + success/fail, not success-only

Each of the four jobs above (plus the daily host check) pings its own healthchecks.io URL — four/five
separate checks, not one shared one, so a missed run is attributable to the specific job that missed
it. Every script signals `/start` on begin and either a plain success ping or `/fail` on completion —
**not success-only** — so a script that starts and then hangs or crashes mid-run is caught by an
explicit `/fail` signal in addition to healthchecks.io's own missed-run grace-period detection. Ping
URLs are treated as secrets and stored in `.env.backup` alongside the restic/B2 credentials, per owner
decision — low sensitivity in practice (worst case is a spurious early ping), but scoped the same way
regardless.

### Verification is part of the backup, not a separate hope

Weekly, automatically (`scripts/restore-verify-weekly.sh`):

1. Restore the latest snapshot into a **disposable scratch** Postgres container — never the live
   database; the automated path can only ever reach `--target scratch`.
2. `pg_restore` into it.
3. Assert row counts and per-year `SUM(amount_cents)` checksums against the manifest that was backed
   up alongside that same snapshot (`scripts/verify.sh`).
4. Tear the scratch container down. Report. **A backup is not green until it has been restored.**

---

## Restore

Restoring is **always an explicit, deliberate command.** It is never a side effect of a deploy, and
never triggered automatically by a failed healthcheck — a failed healthcheck usually means a bad
build, and the database may hold newer writes that a restore would destroy.

```bash
./scripts/restore.sh --list
./scripts/restore.sh --snapshot latest --target scratch      # DEFAULT — disposable, never production
./scripts/restore.sh --snapshot <id> --target production --confirm I-UNDERSTAND-THIS-OVERWRITES-PRODUCTION
```

`--target production` requires that exact literal confirmation string — nothing less specific is
accepted. `--target scratch` is the default and needs no confirmation at all, since it can never touch
real data; it is the one mode the weekly automated timer is allowed to invoke.

**Does not assume a pre-running production stack.** For `--target production`, the script starts
`postgres` itself and waits for it to be healthy before attempting anything — on a totally fresh VPS
(or right after `scripts/provision.sh`) there is no database running yet to restore into, and the
script is self-sufficient about that rather than depending on an unstated prior step. It does **not**
start `web`/`migrate`/`cloudflared` itself — see the DR sequence below for what runs after it, in
order.

---

## Disaster recovery — the VPS is gone

**Target: under 30 minutes. Rehearsed once for M10 acceptance, then quarterly.**

The dependencies are made explicit on purpose (owner decision, M10) — on a totally fresh VPS there is
no database running yet, so nothing in this sequence may assume an unstated prior step is already up:

```
1. PROVISION   TAILSCALE_AUTHKEY=<fresh one-off key> ./scripts/provision.sh
               → docker, ufw, tailscale, app user, secret-file placeholders, systemd timer prep
               (works on Oracle or any fallback host — the VPS is disposable)

2. CLONE       git clone git@github.com:Burmy/burmy-os.git

3. SECRETS     Restore .env.postgres / .env.database / .env.app / .env.tunnel / .env.backup from the
               password manager. Offline process — NEVER from the data backup, which deliberately
               excludes all of them.

4. START POSTGRES ONLY   docker compose up -d postgres — wait for it to report healthy.
               Nothing else is started yet. (scripts/restore.sh does this step itself when run with
               --target production, so this is automatic if step 5 below is run directly.)

5. RESTORE     ./scripts/restore.sh --snapshot latest --target production \
                 --confirm I-UNDERSTAND-THIS-OVERWRITES-PRODUCTION
               → restic restore → pg_restore into the (empty) fresh Postgres volume
               (Postgres 18: volume mounts at /var/lib/postgresql, NOT /data)
               This restores the schema AS IT WAS at backup time, which may be older than HEAD.

6. MIGRATE     docker compose run --rm migrate
               Brings the just-restored schema up to the current migrations — this is why step 5's
               older schema is fine, not a problem to work around.

7. OWNER       docker compose run --rm migrate node scripts/provision-owner.mjs
               Idempotent — the owner row already came back with the restored data in the normal
               case; this is a safety check, not something assumed to be necessary.

8. DEPLOY      ./scripts/deploy.sh
               → builds the app image on the box, starts web + cloudflared, polls the healthcheck.
               (Steps 4–7 above are also exactly what scripts/deploy.sh itself does when it finds no
               running production stack — so in practice, after step 5's restore, running deploy.sh
               alone covers 6–8. Both are documented so the dependency is never assumed unstated.)

9. NETWORK     New Cloudflare tunnel token → .env.tunnel → cloudflared. DNS follows the tunnel.
               The Access APPLICATION/POLICY is reused, not recreated — it isn't tied to any one
               tunnel or device. tailscale up, approve the node.

10. VERIFY     ./scripts/verify.sh --container <postgres> --manifest <restored manifest> \
                 --check-health http://127.0.0.1:3000/api/health
               · row counts vs the backup manifest
               · SUM(amount_cents) checksum per year
               · latest transaction date
               · /api/health responds
               · Cloudflare Access sign-in reaches /finance/monthly (manual — needs the real Access
                 policy in place)
```

**Restored from backup vs. recreated, explicitly:**

| | Source |
| --- | --- |
| The Postgres database | **Restored** from the restic/B2 backup (step 5) |
| `.env.*`, restic password, tunnel token | **Restored from the password manager** — never the data backup |
| Application code, Dockerfile, compose.yml, all scripts | **From Git** (step 2) |
| The VPS itself, the Docker images, the Cloudflare Tunnel token | **Recreated fresh** — none of these are "restored" |
| The Cloudflare Access application/policy | **Reused**, untouched — not tied to the tunnel or the VPS |
| The owner row | Comes back automatically with the restored data; `provision-owner.mjs` (step 7) is a no-op check, not a required fix |

### Single points of failure, and their answers

| If this is lost | Recovery |
| --- | --- |
| The restic password | Password manager + printed offline copy |
| The domain / Cloudflare account | Cloudflare account recovery codes, stored offline |
| The Cloudflare Access policy | Reconfigured from the Cloudflare dashboard; the owner row itself (`node scripts/provision-owner.mjs`) is resolved by email, not tied to any device |
| The VPS | This entire procedure — it is why the VPS is treated as disposable |
| **The local CSV archive** | **Nothing.** This is why Stage 1 exists and comes first. |

---

## Why Oracle makes this non-optional

Oracle's Always Free documentation states that idle compute instances **may be reclaimed** when, over
a 7-day window, CPU 95th percentile, network, and memory utilization are all under 20%. A single-user
finance app opened once a month sits near zero on all three, continuously.

The widely repeated claim that upgrading to Pay-As-You-Go exempts an instance from reclamation is
**not present in Oracle's documentation** and this plan does not rely on it.

One mitigating detail from the same page: a reclaimed instance is **stopped** and can be restarted
"as long as the associated compute shape is available in your region". So reclamation is an outage
plus a capacity gamble — survivable, but only if the restore path works.

**Assume the instance will be reclaimed. The tested restore is the control.**
