# Backup & Restore

> **A backup that has never been restored is not a backup. It is a hope.**

The riskiest window in this project is between "months of hand-categorized financial history exist"
and "a restore has actually been tested". Everything below is sequenced to close that window early.

---

## What is actually irreplaceable (Finance)

Ranked, because the ranking drives the order of work. **This ranking, and the "database is derived"
framing below it, describe Finance only** — see "Games is the exception" further down for why Games
inverts it completely.

| Asset | Replaceable? | Where it lives |
| --- | --- | --- |
| **The owner's local CSV archive** | **No.** Bank of America serves only ~12–18 months of history online. Anything older exists on the owner's disk and nowhere else. | Owner's PC |
| **The owner's Excel sheets** | **No.** Years of hand-verified categorization decisions — the reconciliation ground truth. | Owner's PC |
| The Postgres database | **Yes** — rebuildable from the CSV archive by re-running imports, at the cost of redoing review decisions | Supabase |
| Secrets / recovery credentials | Yes, by rotation — but rotation requires access, which requires them | Password manager, offline |
| Source code | Yes | GitHub |

For **Finance**, the database is *derived*. The CSV archive is *source*. That is why the archive is
backed up before a single line of import code is written.

---

## Games is the exception — for Games, Postgres IS the source

Everything above is scoped to Finance's BoA CSV history, which genuinely lives on the owner's disk
independent of Postgres and can rebuild the database if it is ever lost. **Games has no such archive.**

The one-time import (`scripts/import-game-log.mjs`, see `docs/GAMES.md`, "The problem being solved")
reads the owner's "Game log" Google Sheet export once. The plan requires that export be deleted after
the import runs and never committed — there is no on-disk copy retained anywhere, by design, unlike
Finance's CSVs. Once that import completes:

| Asset | Replaceable? | Where it lives |
| --- | --- | --- |
| The source Google Sheet export | Irrelevant after import — deliberately not kept anywhere | Nowhere |
| The `games` table (Postgres) | **No.** The only copy of the Games data that exists, anywhere | Supabase |

Every status change, hours update, rating, note, and game added by hand since the import exists **only**
in Postgres. There is no CSV archive to re-import from if that table is lost — the Supabase
backup/restore procedure in `docs/DEPLOYMENT.md`, "Backup strategy" is Games' *only* protection, not a
convenience layered on top of a recoverable source file the way it is for Finance.

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
> `supabase db dump`) against Supabase's direct connection string, and when to run it — lives in
> **`docs/DEPLOYMENT.md`, "Backup strategy"**. The rollback procedure for a bad deploy or a bad
> migration lives in **`docs/DEPLOYMENT.md`, "Rollback procedure"**. This file no longer duplicates
> either.
>
> **Status (2026-08-28): NOT DONE, and this is the sentence that matters in this file.** The app is
> live and Supabase holds the only copy of the Games data and 32 months of hand-categorized Finance
> history. No backup of it has ever been taken. The restore procedure has been verified exactly once,
> against the local dev container, on a different Postgres major version, with five rows in it — which
> proves the *commands* work and proves nothing about the real database.
>
> Per the opening line of this document: a backup that has never been restored is not a backup, it is
> a hope. Right now there is not even that.
>
> Supabase's own managed backups/PITR are Pro-tier only — Free has none — so the manual procedure in
> `docs/DEPLOYMENT.md` is not a stopgap; it is the actual plan until/unless the project upgrades tiers.

