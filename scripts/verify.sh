#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Compare a database's ACTUAL current facts against a backup manifest
# (scripts/backup.sh's output: row counts, per-year SUM(amount_cents),
# latest transaction date). "Restored successfully" means these match — not
# just that `pg_restore` exited 0.
#
# Usage:
#   scripts/verify.sh --container <postgres-container> --manifest <path> [--check-health <url>]
#
# Called by scripts/restore.sh after every restore (scratch or production).
# Can also be run standalone against the LIVE production database with a
# manifest pulled from the latest restic snapshot, as a plain sanity check
# with nothing being restored at all.
# ─────────────────────────────────────────────────────────────────────────────

CONTAINER=""
MANIFEST=""
HEALTH_URL=""
DB_USER="${POSTGRES_USER:-burmy}"
DB_NAME="${POSTGRES_DB:-burmy}"

while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --check-health) HEALTH_URL="$2"; shift 2 ;;
    --db-user) DB_USER="$2"; shift 2 ;;
    --db-name) DB_NAME="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

: "${CONTAINER:?--container is required}"
: "${MANIFEST:?--manifest is required}"
if [ ! -f "${MANIFEST}" ]; then
  echo "manifest not found: ${MANIFEST}" >&2
  exit 2
fi

psql_q() {
  docker exec -i "${CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" -tAc "$1"
}

manifest_get() {
  # A manifest line looks like `key=value`; this reads one key's value.
  grep -m1 "^$1=" "${MANIFEST}" | cut -d= -f2-
}

failures=0
check() {
  # $1: label, $2: expected (from manifest), $3: actual (freshly queried)
  if [ "$2" = "$3" ]; then
    echo "  OK   $1: ${3}"
  else
    echo "  FAIL $1: manifest says '${2}', restored database has '${3}'" >&2
    failures=$((failures + 1))
  fi
}

echo "== verifying ${CONTAINER} (${DB_USER}/${DB_NAME}) against ${MANIFEST} =="

check "user row count" \
  "$(manifest_get table_user_count)" \
  "$(psql_q 'select count(*) from "user"')"

check "finance_accounts row count" \
  "$(manifest_get table_finance_accounts_count)" \
  "$(psql_q 'select count(*) from "finance_accounts"')"

check "finance_categories row count" \
  "$(manifest_get table_finance_categories_count)" \
  "$(psql_q 'select count(*) from "finance_categories"')"

check "finance_transactions row count" \
  "$(manifest_get table_finance_transactions_count)" \
  "$(psql_q 'select count(*) from "finance_transactions"')"

check "latest transaction date" \
  "$(manifest_get latest_transaction_date)" \
  "$(psql_q 'select coalesce(max("transaction_date")::text, '"'"'none'"'"') from "finance_transactions"')"

# Per-year SUM(amount_cents) checksums — every `year_YYYY_sum_cents=` line in
# the manifest is checked against a fresh query for that same year.
while IFS='=' read -r key expected; do
  case "${key}" in
    year_*_sum_cents)
      year="${key#year_}"
      year="${year%_sum_cents}"
      actual="$(psql_q "select coalesce(sum(\"amount_cents\"), 0) from \"finance_transactions\" where extract(year from \"transaction_date\") = ${year}")"
      check "year ${year} SUM(amount_cents)" "${expected}" "${actual}"
      ;;
  esac
done < "${MANIFEST}"

if [ -n "${HEALTH_URL}" ]; then
  if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "  OK   /api/health reachable at ${HEALTH_URL}"
  else
    echo "  FAIL /api/health NOT reachable at ${HEALTH_URL}" >&2
    failures=$((failures + 1))
  fi
fi

echo "=========================================="
if [ "${failures}" -eq 0 ]; then
  echo "VERIFY PASSED — restored data matches the manifest."
  exit 0
else
  echo "VERIFY FAILED — ${failures} check(s) did not match." >&2
  exit 1
fi
