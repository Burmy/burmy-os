#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Deploy the current git HEAD. Run ON THE VPS, from inside the cloned repo —
# the owner reaches the VPS over ordinary key-based SSH first, then runs
# this directly; this script contains no SSH/remote logic of its own, which
# is exactly what makes its core logic (build, tag, migrate, up,
# healthcheck, rollback) testable locally against a dev machine's own
# Docker daemon.
#
# IMAGE VERSIONING (read before changing this script)
#
# There is no registry — images are built locally, on the box, tagged with
# the immutable git short-SHA (`burmy-web:<sha>`), plus two floating aliases
# maintained by `docker tag` (never a rebuild):
#
#   current   <- what compose.yml actually runs
#   previous  <- what `current` pointed at before THIS deploy
#
# Rollback is therefore a `docker tag` + restart, not a rebuild — instant,
# and it cannot accidentally rebuild a different (later) commit's code under
# the "previous" name. SHA tags older than KEEP_IMAGES are pruned after a
# SUCCESSFUL deploy only, never during a rollback.
#
# On healthcheck failure: only the WEB image is rolled back. Postgres is
# never touched automatically — a failed healthcheck usually means a bad
# build, not bad data, and the database may already hold newer writes. If
# the MIGRATION itself fails, this script stops and does not attempt any
# rollback at all — rolling an image back under a partially-migrated schema
# is its own hazard, and that call belongs to a person. See
# docs/BACKUP_RESTORE.md / docs/DEPLOYMENT.md.
# ─────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."

KEEP_IMAGES="${KEEP_IMAGES:-5}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-15}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"
SKIP_GIT_PULL="${SKIP_GIT_PULL:-false}"

echo "== preflight =="
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is not clean — aborting" >&2
  exit 1
fi

if [ "${SKIP_GIT_PULL}" != true ]; then
  echo "== pull =="
  git pull --ff-only
fi

SHA="$(git rev-parse --short HEAD)"
echo "deploying ${SHA}"

echo "== start postgres (if not already running) =="
# Deliberately does NOT assume a pre-running production stack — on a fresh
# VPS (or right after scripts/restore.sh --target production) nothing else
# is up yet. This is the one dependency deploy.sh takes care of itself.
docker compose up -d --no-build postgres
echo "waiting for postgres..."
ready=false
for _ in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U burmy -d burmy >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [ "${ready}" != true ]; then
  echo "postgres never became ready — aborting before touching images" >&2
  exit 1
fi

echo "== pre-deploy safety dump (artifact only, not a rollback trigger) =="
PREDEPLOY_DUMP="/var/backups/burmy/predeploy-${SHA}-$(date +%Y%m%d%H%M%S).dump"
mkdir -p "$(dirname "${PREDEPLOY_DUMP}")"
if docker compose exec -T postgres psql -U burmy -d burmy -tAc "select 1 from pg_tables where tablename = 'user' limit 1" 2>/dev/null | grep -q 1; then
  (umask 077 && docker compose exec -T postgres pg_dump -U burmy -Fc burmy > "${PREDEPLOY_DUMP}")
  echo "safety dump written: ${PREDEPLOY_DUMP}"
else
  echo "schema not migrated yet — skipping pre-deploy dump (first-ever deploy)"
fi

echo "== retag current -> previous =="
for repo in burmy-web burmy-migrator; do
  if docker image inspect "${repo}:current" >/dev/null 2>&1; then
    docker tag "${repo}:current" "${repo}:previous"
  fi
done

echo "== build (immutable git-SHA tags + current alias) =="
docker build --target runner \
  --label org.opencontainers.image.revision="${SHA}" \
  -t "burmy-web:${SHA}" -t burmy-web:current .
docker build --target migrator \
  --label org.opencontainers.image.revision="${SHA}" \
  -t "burmy-migrator:${SHA}" -t burmy-migrator:current .

echo "== migrate =="
if ! docker compose run --rm migrate; then
  echo "MIGRATION FAILED. Stopping — this needs a human, not an automatic" >&2
  echo "rollback. Pre-deploy dump: ${PREDEPLOY_DUMP}" >&2
  exit 1
fi

echo "== provision owner (idempotent — safe to run on every deploy) =="
docker compose run --rm migrate node scripts/provision-owner.mjs

echo "== up =="
docker compose up -d --no-build web cloudflared

echo "== healthcheck =="
ok=false
for i in $(seq 1 "${HEALTH_RETRIES}"); do
  if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
    ok=true
    break
  fi
  echo "healthcheck ${i}/${HEALTH_RETRIES} not ready, waiting ${HEALTH_INTERVAL}s..."
  sleep "${HEALTH_INTERVAL}"
done

if [ "${ok}" != true ]; then
  echo "HEALTHCHECK FAILED. Rolling back the WEB IMAGE ONLY — Postgres is" >&2
  echo "untouched." >&2
  if docker image inspect burmy-web:previous >/dev/null 2>&1; then
    docker tag burmy-web:previous burmy-web:current
    docker compose up -d --no-build web
    echo "rolled back to the previous web image." >&2
  else
    echo "no previous web image exists — nothing to roll back to (likely the first deploy)." >&2
  fi
  echo "pre-deploy dump, if the schema needs inspecting: ${PREDEPLOY_DUMP}" >&2
  docker compose logs --tail=200 web >&2 || true
  exit 1
fi

echo "== prune old SHA-tagged images (keeping current, previous, last ${KEEP_IMAGES} by BUILD TIME) =="
# Sorted by `docker images`' own CreatedAt, NOT the tag string — a git
# short-SHA has no chronological ordering as text (`sort -r` on the tag name
# was an earlier draft's bug, caught by actually testing this against a
# sequence of fake deploys rather than trusting it by inspection: it kept
# whichever tags sorted alphabetically last, which is unrelated to which
# deploys were most recent). CreatedAt reflects the underlying image's real
# build timestamp, which IS meaningful here since every SHA tag corresponds
# to a genuinely distinct `docker build` from deploy.sh.
for repo in burmy-web burmy-migrator; do
  docker images "${repo}" --format '{{.CreatedAt}}|{{.Tag}}' \
    | grep -Ev '\|(current|previous|<none>)$' \
    | sort -r \
    | tail -n "+$((KEEP_IMAGES + 1))" \
    | cut -d'|' -f2 \
    | while read -r tag; do
        [ -n "${tag}" ] && docker rmi "${repo}:${tag}" >/dev/null 2>&1 || true
      done
done

echo "deploy ${SHA} succeeded."
