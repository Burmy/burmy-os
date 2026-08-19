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
| The Postgres database | **Yes** — rebuildable from the CSV archive by re-running imports, at the cost of redoing review decisions | Supabase |
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

## Stage 2 — The database (Supabase-hosted)

> **Superseded (2026-08-18):** the sections that used to follow here — local-dev backup tooling, the
> restic/Backblaze B2 nightly-timer design, the VPS disaster-recovery sequence, and the Oracle
> reclamation rationale — described the earlier self-hosted VPS architecture, which was dropped in
> favor of Netlify + Supabase. That design and its scripts are gone from the working tree; the full
> text is still in git history (`git log -p -- docs/BACKUP_RESTORE.md`) if it's ever useful again.
>
> The current backup and restore procedure — manual `pg_dump`/`pg_restore` (or the Supabase CLI's
> `supabase db dump`) against Supabase's direct connection string, when to run it, and the restore
> verification already proven locally — lives in **`docs/DEPLOYMENT.md`, "Backup strategy"**. The
> rollback procedure for a bad deploy or a bad migration lives in **`docs/DEPLOYMENT.md`, "Rollback
> procedure"**. This file no longer duplicates either.
>
> Supabase's own managed backups/PITR are Pro-tier only — Free has none — so the manual procedure in
> `docs/DEPLOYMENT.md` is not a stopgap; it is the actual plan until/unless the project upgrades tiers.

