#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# The weekly UNATTENDED restore-verification job: restore the latest backup
# into a disposable scratch database, verify it against its manifest, tear
# it down. Always --target scratch — this is the one automated caller of
# scripts/restore.sh, and it must never be able to reach --target
# production, which is why it doesn't accept any arguments of its own.
#
# "A backup that has never been restored is not a backup. It is a hope." —
# docs/BACKUP_RESTORE.md. This is what turns that line into a weekly proven
# fact instead of an assumption.
#
# Run via the burmy-restore-verify.timer/.service systemd unit
# (deploy/systemd/).
# ─────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."

if [ -f .env.backup ]; then
  set -a
  # shellcheck disable=SC1090
  source .env.backup
  set +a
fi

PING_BASE="${HEALTHCHECKS_RESTORE_VERIFY_PING_URL:-}"
ping() {
  [ -n "${PING_BASE}" ] || return 0
  curl -fsS -m 10 --retry 3 "${PING_BASE}${1:-}" >/dev/null 2>&1 || true
}

ping /start

if ./scripts/restore.sh --snapshot latest --target scratch; then
  echo "weekly restore verification PASSED."
  ping
  exit 0
else
  echo "weekly restore verification FAILED." >&2
  ping /fail
  exit 1
fi
