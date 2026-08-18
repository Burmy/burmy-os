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

## Stage 2 — Local development (Milestone 1)

A one-command `pg_dump` helper so local work is never lost. Local dumps are disposable; they exist to
make experimentation cheap, not as a retention strategy.

```bash
./scripts/backup.sh --local     # writes a timestamped dump outside the repo
```

---

## Stage 3 — Production automation (Milestone 10, before the first real import)

```
Nightly (systemd timer — better logging and failure visibility than cron)
    ├─ pg_dump -Fc
    ├─ restic backup (AES-256, client-side, deduplicated)  →  b2:burmy-backups
    ├─ restic forget --prune   →  7 daily · 4 weekly · 12 monthly · 3 yearly
    └─ healthcheck ping        →  alert if a night is missed
```

**Retention rationale.** A compressed dump of years of personal transactions is single-digit megabytes,
so retention is effectively free. The 3 yearly snapshots are deliberate: the failure mode that actually
matters is not disk loss but **silent corruption discovered months later**, and 12 monthly snapshots
may not reach far enough back to find a clean copy.

**Backblaze B2 never sees plaintext.** restic encrypts client-side on the VPS; keys never leave it.
First 10 GB is free and this dataset stays far inside that.

### Secrets are deliberately NOT in this backup

The `.env`, the Cloudflare tunnel credential, and the restic password itself live in the **password
manager** and the offline recovery process.

Bundling them with the data would mean a single stolen backup carries both the ciphertext and the keys
to decrypt it. Keep them separate.

> **The restic password must exist somewhere outside the VPS — password manager plus a printed copy.**
> A backup you cannot decrypt is not a backup.

### Verification is part of the backup, not a separate hope

Weekly, automatically:

1. Restore the latest snapshot into a **scratch** database.
2. Assert table row counts against the backup manifest.
3. Assert per-year `SUM(amount_cents)` checksums against production.
4. Report. **A backup is not green until it has been restored.**

---

## Restore

Restoring is **always an explicit, deliberate command.** It is never a side effect of a deploy, and
never triggered automatically by a failed healthcheck — a failed healthcheck usually means a bad
build, and the database may hold newer writes that a restore would destroy.

```bash
./scripts/restore.sh --latest          # requires typed confirmation
./scripts/restore.sh --snapshot <id>
./scripts/restore.sh --list            # what is available
```

---

## Disaster recovery — the VPS is gone

**Target: under 30 minutes. Rehearsed in Milestone 10, then quarterly.**

```
1. PROVISION   ./scripts/provision.sh
               → docker, ufw, tailscale, users, systemd timers
               (works on Oracle or any fallback host — the VPS is disposable)

2. SECRETS     Restore .env and the restic password from the password manager.
               Offline process — NEVER from the data backup.

3. CODE        git clone git@github.com:Burmy/burmy-os.git

4. DATA        ./scripts/restore.sh --latest
               → restic restore → pg_restore into a fresh volume
               (Postgres 18: volume mounts at /var/lib/postgresql, NOT /data)

5. DEPLOY      ./scripts/deploy.sh
               → build on the box → migrate via container → up

6. NETWORK     New Cloudflare tunnel token → cloudflared. DNS follows the tunnel.
               The Access policy is unchanged and needs no edit.
               tailscale up, approve the node.

7. VERIFY      ./scripts/verify.sh
               · row counts vs the backup manifest
               · SUM(amount_cents) checksum per year
               · latest transaction date
               · Cloudflare Access sign-in reaches /finance/monthly
               · monthly grid totals match the reconciliation baseline
```

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
