# Roadmap

Living status tracker. Full milestone definitions — goals, dependencies, tests, Definition of Done —
are in `IMPLEMENTATION_PLAN.md` §39.

**Working agreement:** one milestone at a time. Stop and report at the end of each before starting the
next. Never mark anything complete without having run the verification and seen the output.

| | Milestone | Status |
| --- | --- | --- |
| **M1** | Foundation, domain core, protecting what is irreplaceable | ✅ Complete |
| M2 | Authentication, bootstrap prototype, security baseline | ⚪ Not started |
| M3 | App shell, accounts, categories | ⚪ Not started |
| M4 | Parsing & normalization core *(no UI)* | ⚪ Not started |
| M5 | Import pipeline, preview, duplicates | ⚪ Not started |
| M6 | Categorization & classification | ⚪ Not started |
| M7 | Review queue | ⚪ Not started |
| M8 | Monthly grid & drill-down *(the product)* | ⚪ Not started |
| M9 | Transactions table, Excel reconciliation, export | ⚪ Not started |
| M10 | Backup automation, deployment, hardening, launch | ⚪ Not started |

Legend: ⚪ not started · 🔵 in progress · 🟡 blocked · ✅ complete

---

## M1 — Foundation, domain core, protecting what is irreplaceable

**Goal:** the project builds, the schema exists, money arithmetic is proven, and the CSV archive is
safe.

### Environment — verified

| Tool | Version | Status |
| --- | --- | --- |
| Node | v24.19.0 | ✅ matches the container target |
| npm | 11.6.0 | ✅ |
| pnpm | 11.22.0 | ✅ pinned via `packageManager` |
| Docker | 29.7.2 client + server | ✅ daemon responding |
| Docker Compose | v5.3.1 | ✅ |
| Repository visibility | private | ✅ |

### Scope change — historical CSV archive

The owner retains and backs up the original Bank of America CSVs and Excel files themselves.
**This is no longer an M1 deliverable.** Historical months will be uploaded through Burmy's normal
importer once it exists, exactly like a regular monthly import — which is the cleaner outcome anyway,
since it means history goes through the same tested code path as everything else.

**M4 action:** ask the owner for one representative real BoA **checking** CSV, and a **credit-card**
CSV if needed, to verify the actual export schema before writing the adapters.

### Checklist

- [x] Repository cloned
- [x] `.gitignore` hardened **before** the first commit
- [x] `CLAUDE.md`
- [x] `docs/IMPLEMENTATION_PLAN.md` (approved plan of record)
- [x] `docs/ARCHITECTURE.md`
- [x] `docs/SECURITY.md`
- [x] `docs/FINANCE.md`
- [x] `docs/DEPLOYMENT.md`
- [x] `docs/BACKUP_RESTORE.md`
- [x] `docs/ROADMAP.md`
- [x] `src/server/finance/money.ts` — branded `Cents`, all arithmetic
- [x] `tests/unit/money.test.ts` — **74 cases, all passing**
- [x] Repository set to private
- [x] Next.js 16.3 + TypeScript strict + Tailwind 4
- [x] ESLint + Prettier
- [x] Vitest (+ RTL installed for M3 components)
- [x] Playwright config
- [x] `Dockerfile` (base / deps / prod-deps / builder / migrator / runner) + `compose.dev.yml`
- [x] Drizzle client + full schema (§18) — **14 tables**
- [x] `scripts/migrate.mjs` + generated migration `0000_wet_malcolm_colcord.sql`
- [x] Seed script (synthetic — 4 accounts, 11 categories, zero transactions)
- [x] `src/app` shell, `/` → `/finance/monthly`, `/api/health`, `src/proxy.ts`
- ~~Owner's CSV archive backup~~ — **descoped**: owner retains and backs these up; history will be
  uploaded through the normal importer once it exists (M5)

### Verification actually run — M1

| Check | Result |
| --- | --- |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0, no errors or warnings |
| `pnpm test` | ✅ **74/74 passing** |
| `pnpm build` | ✅ exit 0 — 4 routes, Proxy detected |
| `docker compose up postgres` | ✅ postgres:18-alpine healthy |
| Migrations **in container** | ✅ `docker compose run --rm migrate` → complete |
| Schema applied | ✅ 14 tables |
| `PGDATA` path | ✅ `/var/lib/postgresql/18/docker` (PG18 layout) |
| **PG18 persistence** | ✅ after `down && up`: marker row survived, 14 tables survived, 1 migration recorded |
| `/api/health` live | ✅ `200` → `{"ok":true,"database":true,"version":"0.0.0"}` — booleans + version only |
| `.env` gitignored | ✅ matched by `.gitignore:16` |

### Bugs caught during M1

| Found by | Issue |
| --- | --- |
| Vitest | `negate(ZERO)` returned `-0`. `-0 === 0` is true so it hides from casual comparison, but `Object.is`, Map/Set keys and serializers distinguish it. Fixed at the source via a shared `wrap()`; all operations now normalize. Regression tests added. |
| ESLint `no-irregular-whitespace` | **Two regex literals in `money.ts` contained a non-breaking space (U+00A0) instead of a space.** Tests passed only because a later `.trim()` masked it. Replaced with an explicit `/[$\s]/g` (which also covers U+00A0 / U+202F, both of which appear in copied bank data) and pinned with a test. |
| `next build` | `playwright.config.ts` assigned `undefined` to an optional property, rejected by `exactOptionalPropertyTypes`. Fixed by omitting the key rather than relaxing the compiler setting. |
| Docker build | pnpm's build-script policy blocked the image build. Resolved by rewriting the migrator as plain ESM — no TS, no tsx, no esbuild — which also let the migrator image drop to production dependencies only. |
| Docker build | PowerShell's `Set-Content -Encoding utf8` wrote a UTF-8 BOM into `package.json`; pnpm in the container rejected it as `Invalid package.json`. |

---

### Definition of Done — met

- [x] Repository private
- [x] `pnpm typecheck` / `lint` / `test` / `build` all green
- [x] Migrations run from the image, **not** host pnpm
- [x] **Database survives `docker compose down && up`** — PG18 volume path verified, not assumed
- ~~CSV archive verifiably backed up~~ — descoped to the owner

---

## ▶ RESUME HERE — M2: Authentication, bootstrap prototype, security baseline

**Get running again:**

```bash
docker compose -f compose.dev.yml up -d postgres
docker compose -f compose.dev.yml run --rm migrate
pnpm dev
```

### M2 scope

1. **Cloudflare Access JWT verification** in `src/proxy.ts` — JWKS, `aud`, `iss`, `exp`. Bypassed
   when `NODE_ENV=development`.
2. **`requireOwner()` at the top of every protected server entry point** — Server Actions *and*
   Route Handlers. Unprotected allowlist is exactly `/api/health` and `/api/auth/*`.
3. **Better Auth, passkey plugin only.** No Google client here — Google is configured once, in
   Cloudflare Access. Owner identity comes from the verified Access `email` claim matched against
   `OWNER_EMAIL`.
4. **Prototype bootstrap AND recovery before locking either in.** Better Auth documents no recovery
   path, so M2 must produce a working prototype of both, document observed behaviour, then choose.
   Committed constraints: two passkeys minimum before onboarding completes, and recovery must not
   depend on email.
5. Nonce-based CSP in `src/proxy.ts`, rate limits, `audit_events` wiring.

### Watch out for

- Better Auth generates its own tables (`session`, `account`, `verification`, `passkey`). The `user`
  table already exists from M1, shaped to match — **reconcile rather than duplicate**, and read the
  generated migration before applying it.
- Passkeys need a secure context. `localhost` qualifies, so `rpID='localhost'` works in dev;
  production is `app.burmy.me`.
- Do not bump `typescript` past 6 or `eslint` past 9 — see the pin table in `CLAUDE.md`.

### Ask the owner at M4 — not before

One representative **real Bank of America checking CSV**, plus a **credit-card CSV** if the layout
differs, so adapters are written against observed reality rather than third-party blog posts. The
same milestone decides whether any identifier column is stable, unique and well-covered enough to
earn a unique constraint (§23 Tier 1).

---

## Carried forward

Items deliberately deferred to a later milestone, tracked so they are not lost.

| Item | Milestone | Why deferred |
| --- | --- | --- |
| BoA `source_transaction_id` verification (stability / uniqueness / coverage) | M4 | Requires real overlapping exports. No unique constraint until proven. |
| BoA adapter written against a real redacted export | M4 | Column layout unverified from primary sources |
| Passkey bootstrap + recovery design | M2 | Prototyped before being locked in — Better Auth documents no recovery path |
| ExcelJS dependency/security review | M9 | Gate immediately before XLSX work begins |
| Production Docker hardening | M10 | M1 creates the image; M10 hardens the same image |
| Optional AI categorization | Post-V1 | Only if the residual review tail after 2–3 real months justifies it |

---

## Deferred beyond V1

Split transactions · category `parent_id` in the UI · saved filter views · recurring-subscription
detection · refund→purchase linking · Home dashboard · Finance chat · Amazon item-level splitting ·
PDF parsing · multi-currency logic · budgets and category limits.

**All non-Finance modules** — Notes, Files, Sheets, Inbox, Bookmarks, Garage, Receipts, Subscriptions.
