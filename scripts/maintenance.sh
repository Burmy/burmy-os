#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Weekly restic repository maintenance — `restic forget --prune` then
# `restic check`. Deliberately SEPARATE from scripts/backup.sh's nightly run
# (owner decision, M10): pruning and integrity-checking the whole repository
# is unnecessary work to repeat every night, and keeping it on its own timer
# means a slow `check` never delays the nightly backup itself.
#
# Retention (docs/BACKUP_RESTORE.md): 7 daily, 4 weekly, 12 monthly,
# 3 yearly. A compressed dump of years of personal transactions is single-
# digit MB, so this retention is effectively free to keep.
#
# Run via the burmy-maintenance.timer/.service systemd unit
# (deploy/systemd/). Reads .env.backup directly, same as backup.sh.
# ─────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."

if [ -f .env.backup ]; then
  set -a
  # shellcheck disable=SC1090
  source .env.backup
  set +a
fi

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY not set (.env.backup)}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD not set (.env.backup)}"
export RESTIC_REPOSITORY RESTIC_PASSWORD
if [ -n "${B2_ACCOUNT_ID:-}" ]; then
  export B2_ACCOUNT_ID B2_ACCOUNT_KEY
fi

PING_BASE="${HEALTHCHECKS_MAINTENANCE_PING_URL:-}"
ping() {
  [ -n "${PING_BASE}" ] || return 0
  curl -fsS -m 10 --retry 3 "${PING_BASE}${1:-}" >/dev/null 2>&1 || true
}

on_exit() {
  status=$?
  if [ "${status}" -eq 0 ]; then
    ping
  else
    echo "maintenance FAILED (exit ${status})" >&2
    ping /fail
  fi
  exit "${status}"
}
trap on_exit EXIT

ping /start

echo "== forget + prune (7 daily / 4 weekly / 12 monthly / 3 yearly) =="
restic forget \
  --tag burmy-nightly --host burmy \
  --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --keep-yearly 3 \
  --prune

echo "== check (repository integrity) =="
restic check

echo "maintenance complete."
