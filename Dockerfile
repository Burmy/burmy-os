# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Burmy container image.
#
# Two final targets from one base:
#
#   migrator  - applies database migrations. Production deps only.
#   runner    - the Next.js app. Standalone output, minimal surface.
#
# M1 creates this image so containerized migrations work in development.
# M10 hardens THIS SAME IMAGE for production (read-only rootfs, arm64 target,
# tighter healthchecks). It is one image evolving, not two images.
#
# NOTE ON `--ignore-scripts`
# pnpm blocks dependency install scripts by default as a supply-chain control.
# Rather than granting arbitrary code execution at image-build time, we pass
# `--ignore-scripts` explicitly: neither `next build` nor the migrator needs a
# native postinstall binary. If a future dependency genuinely requires one,
# that is a deliberate decision to revisit here — not a default to inherit.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=24-alpine

# ── base ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# ── deps: full install, for the build only ───────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# ── prod-deps: runtime dependencies only ─────────────────────────────────────
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts

# ── builder: compile the Next.js app ─────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ── migrator ─────────────────────────────────────────────────────────────────
# Needs only: production node_modules, the generated SQL, and two .mjs
# scripts. No TypeScript, no tsx, no esbuild.
#
# `provision-owner.mjs` rides along in this same stage (M10) rather than
# getting a third image — it has the identical minimal footprint as
# `migrate.mjs` (plain ESM, only `postgres` + a Node builtin), and
# `scripts/deploy.sh` runs it via this image right after migrations, on every
# deploy, not just the first one — it is idempotent and cheap. The default
# CMD stays `migrate.mjs`; deploy.sh overrides the command for the
# provision-owner invocation (`docker compose run --rm migrate node
# scripts/provision-owner.mjs`).
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

# ── runner ───────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S burmy && adduser -u 1001 -S burmy -G burmy

# `output: 'standalone'` emits a self-contained server plus a trimmed
# node_modules, so the full dependency tree never reaches the runtime image.
COPY --from=builder --chown=burmy:burmy /app/.next/standalone ./
COPY --from=builder --chown=burmy:burmy /app/.next/static ./.next/static

USER burmy
EXPOSE 3000

# No curl/wget in the image — using node keeps the attack surface smaller than
# installing an HTTP client purely for healthchecks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
