#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Daily lightweight host check — disk usage and container restart-looping.
# Deliberately NOT a monitoring stack (Prometheus/Grafana/Loki): two `df`/
# `docker compose ps` checks and a ping, per the owner's explicit "keep this
# lightweight" instruction.
#
# Run via the burmy-check-host.timer/.service systemd unit (deploy/systemd/).
# ─────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."

if [ -f .env.backup ]; then
  set -a
  # shellcheck disable=SC1090
  source .env.backup
  set +a
fi

DISK_THRESHOLD="${DISK_THRESHOLD_PERCENT:-85}"
PING_BASE="${HEALTHCHECKS_CHECK_HOST_PING_URL:-}"
ping() {
  [ -n "${PING_BASE}" ] || return 0
  curl -fsS -m 10 --retry 3 "${PING_BASE}${1:-}" >/dev/null 2>&1 || true
}

problems=0
report=""

echo "== disk usage =="
# `$(NF-1)` (second-to-last field), not a fixed `$5` — a filesystem name
# containing a space (seen in local testing: "C:/Program Files/Git") shifts
# every positional column, but `df -P`'s last field is always "Mounted on"
# and the one before it is always "Capacity", regardless of how many fields
# the filesystem name itself splits into.
disk_used=$(df -P / | awk 'NR==2 {gsub("%","",$(NF-1)); print $(NF-1)}')
echo "root filesystem: ${disk_used}% used"
if [ "${disk_used}" -ge "${DISK_THRESHOLD}" ]; then
  problems=$((problems + 1))
  report="${report}disk usage ${disk_used}% >= threshold ${DISK_THRESHOLD}%\n"
fi

echo "== container restart counts =="
# `docker compose ps` doesn't expose restart counts directly, so this reads
# it via `docker inspect` per container — a restart count above the
# threshold in a single day is what "continuously restarting" looks like.
RESTART_THRESHOLD="${RESTART_THRESHOLD:-5}"
for cid in $(docker compose ps -q 2>/dev/null || true); do
  name=$(docker inspect --format '{{.Name}}' "${cid}" | sed 's#^/##')
  restarts=$(docker inspect --format '{{.RestartCount}}' "${cid}")
  state=$(docker inspect --format '{{.State.Status}}' "${cid}")
  echo "  ${name}: state=${state} restarts=${restarts}"
  if [ "${restarts}" -ge "${RESTART_THRESHOLD}" ]; then
    problems=$((problems + 1))
    report="${report}${name} has restarted ${restarts} times\n"
  fi
  if [ "${state}" != "running" ]; then
    problems=$((problems + 1))
    report="${report}${name} is not running (state=${state})\n"
  fi
done

if [ "${problems}" -eq 0 ]; then
  echo "host check OK."
  ping
  exit 0
else
  echo "host check found ${problems} problem(s):" >&2
  printf '%b' "${report}" >&2
  ping /fail
  exit 1
fi
