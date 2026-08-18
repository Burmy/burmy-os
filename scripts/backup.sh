#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Nightly database backup. ONLY: pg_dump -Fc -> restic backup -> monitoring
# signal. Deliberately does NOT run `restic forget`/`restic check` — that is
# scripts/maintenance.sh, on its own weekly timer, so a nightly run never
# pays for repository maintenance it doesn't need (owner decision, M10).
#
# The database is captured with `pg_dump`, Postgres's own consistent-snapshot
# tool — NEVER a copy of the live pgdata directory, which would not be a
# valid backup while the server is running.
#
# PLAINTEXT DUMP HANDLING (owner-mandated change from the original design):
# both the dump AND its manifest (below) are created with `umask 077` and
# removed by a single EXIT trap that fires on success AND on failure alike.
# Nothing is intentionally retained for "inspection" — an unencrypted copy of
# years of financial history sitting on disk after a failed run is exactly
# the risk restic exists to remove. If a run fails, the signal to the
# monitor and this script's own log output are the diagnostic trail, not a
# leftover plaintext file.
#
# MANIFEST: coarse facts about the database at backup time (row counts,
# per-year SUM(amount_cents), latest transaction date) — never row content.
# Backed up alongside the dump so scripts/verify.sh can assert a restored
# scratch database matches these facts, not just that `pg_restore` exited 0.
#
# Local testing: point RESTIC_REPOSITORY at a local path (e.g.
# /tmp/burmy-test-restic) instead of a b2:... URL to exercise this whole
# script — restic's local backend needs no B2 credentials at all. See
# docs/BACKUP_RESTORE.md.
#
# Run via the burmy-backup.timer/.service systemd unit (deploy/systemd/).
# Reads .env.postgres (database access) and .env.backup (restic/B2/
# healthchecks) directly — this script is never containerized and never
# injects these into any compose service.
# ─────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."

for f in .env.postgres .env.backup; do
  if [ -f "${f}" ]; then
    set -a
    # shellcheck disable=SC1090
    source "${f}"
    set +a
  fi
done

: "${POSTGRES_USER:?POSTGRES_USER not set (.env.postgres)}"
: "${POSTGRES_DB:?POSTGRES_DB not set (.env.postgres)}"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY not set (.env.backup)}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD not set (.env.backup)}"
export RESTIC_REPOSITORY RESTIC_PASSWORD
if [ -n "${B2_ACCOUNT_ID:-}" ]; then
  export B2_ACCOUNT_ID B2_ACCOUNT_KEY
fi

# OPTIONAL, deferred for V1 (owner decision, M10 simplification):
# healthchecks.io monitoring is not part of the required launch path — this
# is a genuine no-op, not a degraded mode, when HEALTHCHECKS_BACKUP_PING_URL
# is left blank in .env.backup. This script's own exit code (and systemd's
# own logging of it) is what's authoritative either way; the ping is an
# opt-in extra if it's ever wanted later.
PING_BASE="${HEALTHCHECKS_BACKUP_PING_URL:-}"
ping() {
  # $1: "" (success), "/start", or "/fail".
  [ -n "${PING_BASE}" ] || return 0
  curl -fsS -m 10 --retry 3 "${PING_BASE}${1:-}" >/dev/null 2>&1 || true
}

DUMP_DIR="${BACKUP_SCRATCH_DIR:-/var/backups/burmy}"
mkdir -p "${DUMP_DIR}"
DUMP_FILE="${DUMP_DIR}/burmy-$(date +%Y%m%d%H%M%S).dump"
# Declared empty up front (not just where it's written below) so the EXIT
# trap can safely `rm -f` it even if this script fails before the manifest
# step ever runs — `rm -f ""` is a harmless no-op.
MANIFEST_FILE=""

# ONE EXIT trap, capturing the real exit status FIRST — a chained trap that
# ran cleanup before checking `$?` would see the cleanup command's own status
# instead of the command that actually failed. Fires on success and on any
# failure alike (set -e triggers a trapped EXIT too).
on_exit() {
  status=$?
  rm -f "${DUMP_FILE}" "${MANIFEST_FILE}"
  if [ "${status}" -eq 0 ]; then
    ping
  else
    echo "backup FAILED (exit ${status})" >&2
    ping /fail
  fi
  exit "${status}"
}
trap on_exit EXIT

ping /start

echo "== dump =="
# umask 077 for the duration of dump creation only — the file is never
# group/world readable at any point it exists on disk.
(
  umask 077
  docker compose exec -T postgres pg_dump -U "${POSTGRES_USER}" -Fc "${POSTGRES_DB}" > "${DUMP_FILE}"
)
DUMP_BYTES=$(wc -c < "${DUMP_FILE}")
echo "dump written: ${DUMP_BYTES} bytes"

echo "== manifest =="
MANIFEST_FILE="${DUMP_DIR}/manifest-$(date +%Y%m%d%H%M%S).txt"

psql_q() {
  docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc "$1"
}

(
  umask 077
  {
    echo "generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "table_user_count=$(psql_q 'select count(*) from "user"')"
    echo "table_finance_accounts_count=$(psql_q 'select count(*) from "finance_accounts"')"
    echo "table_finance_categories_count=$(psql_q 'select count(*) from "finance_categories"')"
    echo "table_finance_transactions_count=$(psql_q 'select count(*) from "finance_transactions"')"
    echo "latest_transaction_date=$(psql_q 'select coalesce(max("transaction_date")::text, '"'"'none'"'"') from "finance_transactions"')"
    psql_q "select extract(year from \"transaction_date\")::int, sum(\"amount_cents\") from \"finance_transactions\" group by 1 order by 1" \
      | while IFS='|' read -r year sum; do
          [ -n "${year}" ] && echo "year_${year}_sum_cents=${sum:-0}"
        done
  } > "${MANIFEST_FILE}"
)
echo "manifest written: ${MANIFEST_FILE}"

echo "== restic backup =="
restic backup "${DUMP_FILE}" "${MANIFEST_FILE}" --tag burmy-nightly --host burmy

echo "backup complete."
