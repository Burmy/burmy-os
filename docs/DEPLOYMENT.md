# Deployment

> **Status: architecture decided, implementation lands in Milestone 10.**
> Sections marked *(M10)* describe intended behaviour and are not yet built. Nothing in this document
> should be read as "already working".

Production launch deliberately comes **after** transactions, export, reconciliation, hardening and a
verified backup/restore. Real financial data does not touch production until recovery has been proven.

---

## Target topology

```
Browser ──HTTPS──▶ Cloudflare  (TLS terminates here)
                        │  Access: Google OAuth, allowlisted to OWNER_EMAIL
                        │  outbound-only tunnel — NO inbound ports on the origin
                        ▼
        ┌────────────────── VPS ──────────────────┐
        │  network: edge      (outbound internet) │
        │    cloudflared ──▶ web (Next.js 16)     │
        │                      │                  │
        │  network: dbnet     (internal: true)    │
        │    migrate ──▶ postgres 18 ──▶ pgdata   │
        └─────────────────────────────────────────┘

        Owner's PC ──▶ Tailscale ──▶ VPS (SSH, admin, deploys)
        ufw default-deny · SSH bound to the Tailscale interface only
```

---

## Two networks — this is not optional

`cloudflared` must reach Cloudflare's edge over the public internet. Placing it on a network marked
`internal: true` **blocks that outbound connection entirely** and the tunnel never comes up.

| Network | `internal` | Members | Purpose |
| --- | --- | --- | --- |
| `edge` | no | `cloudflared`, `web` | Outbound internet for the tunnel |
| `dbnet` | **yes** | `web`, `migrate`, `postgres` | No route off the host, in or out |

`web` is the only service on both. `postgres` has no internet path. `cloudflared` has no database path.

---

## Postgres 18 volume layout — a silent data-loss trap

PostgreSQL 18's official image changed `PGDATA` to `/var/lib/postgresql/18/docker` and moved the
declared `VOLUME` to `/var/lib/postgresql`.

```yaml
volumes:
  - pgdata:/var/lib/postgresql        # ✅ correct for PG 18+
# - pgdata:/var/lib/postgresql/data   # ❌ pre-18 — starts cleanly, reports healthy, LOSES DATA
```

The wrong path fails **silently**: the container comes up, the healthcheck passes, and the data
disappears the next time the container is recreated. Verified explicitly in Milestone 1 by writing
rows, running `docker compose down && up`, and confirming survival.

---

## Host provisioning *(M10)*

```bash
./scripts/provision.sh
```

One command, because "limited Linux experience" is a stated constraint. It installs Docker, configures
`ufw` (default-deny), installs and joins Tailscale, binds SSH to the Tailscale interface only,
disables root login and password auth, creates the app user, and installs the systemd timers.

**Right-sized to 1 OCPU / 6 GB** on Oracle — ample for one user, and higher relative memory
utilization is a marginal hedge against the idle-reclamation policy. It is a hedge, not a guarantee;
see `BACKUP_RESTORE.md`.

---

## Deploying *(M10)*

One command from the owner's PC, over Tailscale. **CI never holds credentials that can reach the
VPS** — a compromised GitHub Action cannot touch the server.

```bash
./scripts/deploy.sh
```

```
preflight   clean working tree · tests green · Tailscale up
   ↓
ssh over Tailscale
   ↓
git pull  →  docker compose build          (arm64, built ON the box —
   ↓                                        no registry, no QEMU, no CI secrets)
pg_dump                                     (safety ARTIFACT, not a rollback trigger)
   ↓
docker compose run --rm migrate             (migrations run IN the image)
   ↓
docker compose up -d
   ↓
healthcheck /api/health, 30s
   ↓
FAIL → roll back the IMAGE only · leave Postgres untouched · print correlation id
       and last 200 log lines · exit non-zero
```

### The database is never restored automatically

An earlier draft rolled the database back to the pre-migration dump on healthcheck failure. **That was
dangerous and was removed.**

A failed healthcheck usually means a bad build, a missing environment variable, or a transient startup
race. The database is typically fine, and may already hold newer writes. Restoring a dump in that
situation destroys real data to fix a problem the data had nothing to do with — automatically, at the
moment the owner is least able to reason about it.

- **On healthcheck failure:** previous image tag restarted, Postgres untouched, diagnostics printed.
- **The pre-migration dump is retained and its path printed**, so a human can choose to use it.
- **If the migration itself failed**, the script says so and stops — rolling an image back under a
  partially-migrated schema is its own hazard, and that call belongs to a person.
- **Restoring is always a separate explicit command** with typed confirmation. Never a deploy side
  effect.

---

## CI

GitHub Actions on every push: `typecheck`, `lint`, `vitest run`, `next build`, `pnpm audit`.
Playwright on pull requests.

**No deployment credentials exist in CI.** Deployment is manual and Tailscale-gated by design.

---

## Environment

`.env` on the VPS at `0600`, owned by the app user, injected via `env_file`. Never in git.
`.env.example` holds placeholders only.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection (internal `dbnet` hostname) |
| `OWNER_EMAIL` | The single allowlisted identity — checked against the verified Cloudflare Access JWT on every request |
| `CF_ACCESS_TEAM_DOMAIN` | For JWKS lookup |
| `CF_ACCESS_AUD` | Access application audience tag |
| `TUNNEL_TOKEN` | `cloudflared` |
| `RESTIC_REPOSITORY` / `RESTIC_PASSWORD` / `B2_*` | Backups *(M10)* |

---

## Provider portability

Nothing in the application is Oracle-specific. The compose file, provisioning script and restore path
are identical on Hetzner, Vultr, DigitalOcean or a machine under a desk — the only differences are
architecture (`arm64` on Oracle, `x86` on most others) and the provider console.

**This is deliberate.** Oracle halved its Always Free ARM allowance in June 2026 with no announcement,
and reclaims idle instances. Migration is a rehearsed restore drill, not an emergency.
