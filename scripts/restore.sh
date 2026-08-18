#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Restore is ALWAYS explicit, NEVER automatic — never triggered by a failed
# healthcheck, never a side effect of a deploy. Two targets:
#
#   --target scratch      (DEFAULT) A disposable, throwaway Postgres
#                          container, never the live database. Safe for the
#                          weekly unattended verification timer to run.
#   --target production   The REAL database. Requires --confirm with the
#                          exact literal string below. This is what the DR
#                          drill (docs/BACKUP_RESTORE.md) actually runs.
#
# DEPENDENCY ORDERING (owner-mandated, M10): on a totally fresh VPS there is
# no database to restore into — this script does NOT assume a pre-running
# production stack. For --target production it starts `postgres` itself and
# waits for it to be healthy before attempting anything. It does NOT start
# `web`/`migrate`/`cloudflared` — that is scripts/deploy.sh's job, run
# AFTER this script, per the documented DR sequence:
#
#   provision -> clone -> secrets -> start Postgres only -> wait healthy ->
#   restore -> run current migrations -> provision-owner idempotently ->
#   start web/cloudflared -> verify
#
# Usage:
#   scripts/restore.sh --list
#   scripts/restore.sh --snapshot latest --target scratch
#   scripts/restore.sh --snapshot <id> --target production --confirm I-UNDERSTAND-THIS-OVERWRITES-PRODUCTION
#
# Local testing: point RESTIC_REPOSITORY (.env.backup) at a local path — see
# scripts/backup.sh's header comment. This script needs no B2 credentials to
# be exercised end to end against a local restic repository.
# ─────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."

CONFIRM_STRING="I-UNDERSTAND-THIS-OVERWRITES-PRODUCTION"

SNAPSHOT=""
TARGET="scratch"
CONFIRM=""
LIST=false
KEEP=false

while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST=true; shift ;;
    --snapshot) SNAPSHOT="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --confirm) CONFIRM="$2"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for f in .env.postgres .env.backup; do
  if [ -f "${f}" ]; then
    set -a
    # shellcheck disable=SC1090
    source "${f}"
    set +a
  fi
done

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY not set (.env.backup)}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD not set (.env.backup)}"
export RESTIC_REPOSITORY RESTIC_PASSWORD
if [ -n "${B2_ACCOUNT_ID:-}" ]; then
  export B2_ACCOUNT_ID B2_ACCOUNT_KEY
fi
DB_USER="${POSTGRES_USER:-burmy}"
DB_NAME="${POSTGRES_DB:-burmy}"

if [ "${LIST}" = true ]; then
  restic snapshots --tag burmy-nightly --host burmy
  exit 0
fi

: "${SNAPSHOT:?--snapshot <id|latest> is required (or use --list)}"

if [ "${TARGET}" != scratch ] && [ "${TARGET}" != production ]; then
  echo "--target must be 'scratch' or 'production'" >&2
  exit 2
fi

if [ "${TARGET}" = production ] && [ "${CONFIRM}" != "${CONFIRM_STRING}" ]; then
  echo "Restoring into PRODUCTION requires:" >&2
  echo "  --confirm ${CONFIRM_STRING}" >&2
  exit 1
fi

# ── 1. restic restore the dump + manifest to a scratch local directory ─────
RESTORE_TMP="$(mktemp -d)"
cleanup_tmp() { rm -rf "${RESTORE_TMP}"; }
trap cleanup_tmp EXIT

echo "== restic restore (snapshot: ${SNAPSHOT}) =="
restic restore "${SNAPSHOT}" --tag burmy-nightly --host burmy --target "${RESTORE_TMP}"

DUMP_FILE="$(find "${RESTORE_TMP}" -name '*.dump' -type f | sort | tail -1)"
MANIFEST_FILE="$(find "${RESTORE_TMP}" -name 'manifest-*.txt' -type f | sort | tail -1)"
if [ -z "${DUMP_FILE}" ]; then
  echo "no .dump file found in the restored snapshot — aborting" >&2
  exit 1
fi
echo "dump: ${DUMP_FILE}"
echo "manifest: ${MANIFEST_FILE:-<none found>}"

# ── 2. target-specific Postgres ─────────────────────────────────────────────
if [ "${TARGET}" = scratch ]; then
  CONTAINER="burmy-restore-scratch"
  SCRATCH_PASSWORD="scratch-$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')"

  echo "== starting a DISPOSABLE scratch Postgres (${CONTAINER}) =="
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  docker run -d --name "${CONTAINER}" \
    -e POSTGRES_USER="${DB_USER}" -e POSTGRES_PASSWORD="${SCRATCH_PASSWORD}" -e POSTGRES_DB="${DB_NAME}" \
    postgres:18-alpine >/dev/null

  if [ "${KEEP}" != true ]; then
    trap 'docker rm -f "'"${CONTAINER}"'" >/dev/null 2>&1 || true; cleanup_tmp' EXIT
  fi
else
  CONTAINER="$(docker compose ps -q postgres)"
  if [ -z "${CONTAINER}" ]; then
    echo "== production postgres is not running — starting it (no other service is assumed to be up) =="
    docker compose up -d --no-build postgres
    CONTAINER="$(docker compose ps -q postgres)"
  fi
fi

echo "== waiting for ${CONTAINER} to be healthy =="
for _ in $(seq 1 30); do
  docker exec "${CONTAINER}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1 && break
  sleep 1
done

# ── 3. pg_restore ────────────────────────────────────────────────────────────
# No password needed for either `docker exec` call below: the official
# postgres image trusts local Unix-socket connections by default (no `-h`
# flag means psql/pg_restore use the socket, not TCP) — the same reason
# compose.dev.yml's own healthcheck (`pg_isready -U burmy -d burmy`) never
# needs one either. POSTGRES_PASSWORD above is only for the container's own
# first-boot initialization, not for these client calls.
echo "== pg_restore into ${CONTAINER} (--clean --if-exists: safe against an empty OR already-populated target) =="
docker cp "${DUMP_FILE}" "${CONTAINER}:/tmp/restore.dump"
docker exec "${CONTAINER}" pg_restore -U "${DB_USER}" -d "${DB_NAME}" --clean --if-exists /tmp/restore.dump
docker exec "${CONTAINER}" rm -f /tmp/restore.dump

# ── 4. verify ────────────────────────────────────────────────────────────────
if [ -n "${MANIFEST_FILE}" ]; then
  echo "== verify =="
  # No --check-health for a production restore, on purpose: web is
  # deliberately NOT started by this script (see the DR-ordering note
  # above) — deploy.sh does that next, and its own healthcheck poll is what
  # proves the app itself is up.
  ./scripts/verify.sh --container "${CONTAINER}" --manifest "${MANIFEST_FILE}" --db-user "${DB_USER}" --db-name "${DB_NAME}"
else
  echo "no manifest found in this snapshot — skipping the fact-comparison step (older backup, pre-manifest?)" >&2
fi

echo "restore into ${TARGET} complete."
if [ "${TARGET}" = scratch ] && [ "${KEEP}" = true ]; then
  echo "scratch container kept: ${CONTAINER} (docker rm -f ${CONTAINER} when done)"
fi
