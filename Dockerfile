# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Burmy migrator image — LOCAL DEVELOPMENT / CI ONLY.
#
# Production (Netlify + Supabase) does not use this file at all: Netlify builds
# and runs the app itself via its own Next.js Runtime, and CI
# (.github/workflows/ci.yml) runs `node scripts/migrate.mjs` directly on the
# runner, against a plain `postgres:18-alpine` service container — no Docker
# build involved there either. The one real consumer is local development's
# `compose.dev.yml`, whose `migrate` service builds this image's `migrator`
# target to apply migrations inside a container "identical to what a fresh
# clone gets," never through a host pnpm install.
#
# This used to also build a `runner` target (a standalone Next.js server
# image) for the original VPS/Docker Compose production deployment. That
# target, and the `deps`/`builder` stages that only existed to feed it, were
# removed when production moved to Netlify + Supabase — see
# docs/DEPLOYMENT.md, "Why the VPS was dropped." Git history has the full
# multi-target version if a self-hosted/Docker production deployment is ever
# picked up again.
#
# NOTE ON `--ignore-scripts`
# pnpm blocks dependency install scripts by default as a supply-chain control.
# Rather than granting arbitrary code execution at image-build time, we pass
# `--ignore-scripts` explicitly: the migrator needs no native postinstall
# binary. If a future dependency genuinely does, that is a deliberate decision
# to revisit here — not a default to inherit.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=24-alpine

# ── base ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# ── prod-deps: runtime dependencies only ─────────────────────────────────────
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts

# ── migrator ─────────────────────────────────────────────────────────────────
# Needs only: production node_modules, the generated SQL, and two .mjs
# scripts. No TypeScript, no tsx, no esbuild, no `next build`.
FROM base AS migrator
ENV NODE_ENV=production
RUN addgroup -g 1001 -S burmy && adduser -u 1001 -S burmy -G burmy

COPY --from=prod-deps --chown=burmy:burmy /app/node_modules ./node_modules
COPY --chown=burmy:burmy package.json ./
COPY --chown=burmy:burmy drizzle ./drizzle
COPY --chown=burmy:burmy scripts/migrate.mjs ./scripts/migrate.mjs
COPY --chown=burmy:burmy scripts/provision-owner.mjs ./scripts/provision-owner.mjs

USER burmy
CMD ["node", "scripts/migrate.mjs"]
