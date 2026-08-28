# Security

Burmy holds years of personal financial history for one person. This document states what is
defended, how, and what is explicitly *not* defended.

A private GitHub repository is not a security control. Neither is obscurity. Treat this repository as
if it were public — because it was, briefly, before the first commit.

---

## Threat model

**In scope:**

| Threat | Realistic? | Primary control |
| --- | --- | --- |
| Google account compromise | The single most likely path in | Cloudflare Access's own policy and Google's own account security — Burmy has no independent factor of its own (see "Authentication" below for why) |
| Stolen/borrowed device with a live Access session | Plausible | Cloudflare Access's own session duration and policy — not something Burmy controls or can re-check independently, since it has no session of its own |
| Malicious or malformed statement file | Certain, eventually — files come from outside | Treat every upload as hostile (below) |
| A file reaching the pipeline that the owner never chose | Would require a watched folder | There is no watched folder. The only input is the browser-selected file — see "The filesystem is not an input". |
| Formula injection into an export | Plausible — a merchant name is attacker-influenced text | Neutralized at the writer |
| Secret committed to git | Common failure mode | Broad `.gitignore` committed first; secret scanning in CI |
| Origin reached without passing Access | Requires a tunnel misconfiguration | Access JWT verified in `src/proxy.ts` |
| Server Action invoked without auth | Easy to introduce accidentally | Every entry point authenticates itself (below) |
| Data loss (Supabase project deleted/corrupted, account lost) | Low but not zero — managed Postgres, no host to reclaim | Independent logical backup, restore-verified locally (see `docs/DEPLOYMENT.md`, "Backup strategy") |
| Dependency compromise | Ongoing | Renovate, `pnpm audit` in CI, lockfile committed, frozen installs |

**Out of scope — accepted risks, stated so they are decisions rather than oversights:**

- **Cloudflare can technically read application content** in transit; TLS terminates at their edge.
- **Supabase, as the Postgres host, can technically read data at rest and in memory.**
- A targeted attacker with physical access to the owner's unlocked device carrying a live Cloudflare
  Access session.
- Nation-state adversaries.

---

## Authentication

**Cloudflare Access, authenticating against Google, is the SOLE authentication mechanism.** There is
no in-app credential, no session of Burmy's own, and no second factor:

```
app.burmy.me → Cloudflare Access / Google → Burmy application
```

> **Deployment-path note (2026-08-18, see `docs/DEPLOYMENT.md`, "Authentication"):** the default
> production target changed from a VPS+Tunnel to Netlify + Supabase. Cloudflare Access only intercepts
> a request when Cloudflare's edge actually sits in the path — decided as a *proxied* DNS record for
> `app.burmy.me` specifically (not a Tunnel, and not applied to the `burmy.me`/`www.burmy.me` portfolio
> records), added only after Netlify's own DNS verification and HTTPS provisioning complete on that
> hostname. This diagram stays literally true once that cutover happens; the code below was not changed
> by this decision and needed no change — Access already worked this way.

This replaced an earlier two-factor design (Cloudflare Access *plus* an in-app Better Auth passkey) —
see "Former design: Cloudflare Access + passkey (removed)" below for what that was and why it is gone.

**Google is configured exactly once, in Cloudflare Access.** There is no OAuth client anywhere inside
this application — nothing here could configure a second one even by accident, because there is no
auth library installed that has a slot for one.

**Cloudflare Access's JWT assertion is re-verified inside the application, not merely trusted, on
every single request:**

- `src/proxy.ts` verifies it at the edge, first — defense-in-depth, not the boundary (Next.js can
  route around a `matcher`, per "Authorization" below).
- `requireOwner()` (`src/server/auth/owner.ts`) verifies it again, independently, on every protected
  entry point: signature, `aud`, `iss`, `exp` against Cloudflare's JWKS (`src/server/auth/access.ts`),
  **and** that the verified email is `OWNER_EMAIL`. Only then does it resolve the matching row in
  `user` — a **read**, never a write. An incoming request, however well authenticated, can never
  create the owner row on its own; see "Owner provisioning" below.

Rules:

- No password authentication anywhere. No custom cryptography.
- **No signup route exists.** It is not registered, not merely hidden.
- `OWNER_EMAIL` is checked against the verified Access JWT claim on **every** request — there is no
  session in between two checks that could go stale, because there is no session.
- **Fail closed, always.** Missing or invalid Cloudflare Access configuration (`CF_ACCESS_TEAM_DOMAIN`,
  `CF_ACCESS_AUD`) makes the app refuse every request with `503`, in production, rather than serve
  traffic without the outer gate — `resolveAccessMode()` bypasses verification **only** when
  `NODE_ENV` is exactly `development`, never on `!== 'production'` (see the gotcha in `CLAUDE.md`).
- A missing owner row, or a validly-verified identity that is not `OWNER_EMAIL`, is rejected the same
  way: a bodiless `401`, and a browser navigation lands on `/access-denied` — a static page, not a
  sign-in screen, because there is no in-app action that could fix either case.

### Owner provisioning

`requireOwner()` only ever **resolves** the owner by verified email — it never inserts a row. The
first row has to come from somewhere else: `node scripts/provision-owner.mjs`, run once, out of band,
by whoever controls the host and the database. It is idempotent (safe to re-run) and inserts nothing
if a row for `OWNER_EMAIL` already exists.

This is a deliberate security property, not an oversight: an authenticated request must never be able
to conjure a database row into existence by itself, however trustworthy its Access identity looks.

### Former design: Cloudflare Access + passkey (removed)

Through Milestone 8, Burmy additionally required an in-app Better Auth passkey as a second factor,
with its own session, an out-of-band bootstrap/recovery grant system (`scripts/auth-grant.mjs`, a
`POST /api/auth/burmy/redeem-grant` endpoint, single-use 10-minute tokens minted over SSH through
Tailscale), and a two-passkey-minimum onboarding gate. Both bootstrap candidates considered at the
time — passkey-first registration versus session-first grant redemption — were implemented and
measured against a real Postgres before the session-first design shipped.

That entire mechanism was removed by deliberate product/security-model decision: Cloudflare Access
with Google is now the sole interactive authentication mechanism, and the in-app second factor was
judged to add operational complexity (break-glass recovery, passkey enrolment UX, a second session to
reason about) without a correspondingly distinct threat it defended against, given Access already
gates on the same Google identity. The full comparison and the M2 prototyping evidence remain in git
history for whoever wants the detail; this document no longer carries it, because none of that code is
live to reason about anymore.

**Five tables from that design are still in the schema and are referenced by nothing.** `session`,
`account`, `verification`, `passkey` and `rate_limit` are all defined in `src/server/db/schema.ts` and
appear in no query anywhere in `src/` — only `user` survived the removal, and it survived because
`requireOwner()` resolves the owner row from it.

They are left in place deliberately, not overlooked. Dropping a table is a destructive migration, and
these hold nothing: no rows are ever written to them, so they cost storage measured in bytes and leak
nothing. The one thing worth stating plainly is that **their presence is not evidence of a second auth
path** — a reader finding a `session` table could reasonably assume Burmy keeps sessions of its own. It
does not. There is exactly one identity mechanism, described above, and these are its predecessor's
empty furniture.

---

## Authorization — every entry point defends itself

Next.js documents that Server Functions are handled as **POSTs to the route where they are used**. A
`matcher` change, or refactoring an action to a different route, can therefore **silently remove proxy
coverage** — with no error and no test failure.

Consequently:

> **Every protected server entry point — Server Action or Route Handler — begins with
> `await requireOwner()`.** `src/proxy.ts` is defense-in-depth, not the security boundary.

**Unprotected endpoints are an explicit allowlist, not a judgement call — exactly one entry:**

| Endpoint | Why | Constraint |
| --- | --- | --- |
| `/api/health` | Netlify's own deploy healthchecks reach this directly, without a Cloudflare Access session, since the check runs before or outside the browser flow Access gates | Returns booleans and a version string **only**. No counts, no data, no error text, no environment detail. |

`/api/auth/*` was the second entry through Milestone 8 — Better Auth's own flows, which authenticated
by design. It no longer exists: there is no in-app authentication endpoint left to allowlist, since
Cloudflare Access is verified entirely outside this application.

Anything not listed is protected. Integration tests invoke every entry point unauthenticated with the
proxy bypassed and assert rejection, and assert the health response contains no sensitive fields.

**Data access** goes through a layer that takes an owner id and injects the `WHERE` clause. Routes and
actions never build queries directly. Enforced by API shape and by integration tests asserting
cross-owner isolation — deliberately *not* by a custom lint rule.

---

## The filesystem is not an input

**The only file Burmy ever touches is the one the owner picks in the browser upload control.**

No watched folders, no directory scanning, no "import from path", no filesystem polling, no configured
statement directory — not as a convenience, not as a development shortcut, not behind a flag. The
product workflow is manual and monthly: *select or drag a CSV → upload → parse → review → import*.

Why it is a security property and not just a product preference:

- A watched folder is an **implicit trust boundary**. Anything that can write to that directory —
  another application, a sync client, a browser download, a second user on the machine — becomes an
  input to the finance pipeline without the owner ever choosing it.
- It turns a deliberate monthly act into an ambient one, which is exactly how a file nobody meant to
  import ends up in a total nobody can explain.
- It would make the application require read access to a user directory, widening what a compromised
  process could reach far beyond the bytes of one statement.

**Server-side scratch space is a different thing and is permitted.** Writing the bytes the owner just
uploaded to a `0600` temp file outside the webroot, parsing it, and deleting it in a `finally` (§21 of
the plan) is not filesystem *access* — nothing is read that the owner did not hand over. The
distinction is direction: Burmy may write what it was given; it may never go looking.

*Development is bound by the same rule.* No part of the build, test suite or tooling may depend on a
local statement folder existing. The M4 parser fixtures are committed, redacted files under
`tests/fixtures/finance/`; the raw exports they derive from are supplied out of band and never stored
in the repository.

---

## Parser fixtures are redacted, not synthetic

**Amended in M4.** The original rule read "test fixtures are synthetic only". Synthetic fixtures encode
only the assumptions of whoever wrote them, which is precisely what a parser must not be tested
against — BoA's real exports carry quirks (encodings, junk preamble rows, ragged columns, parenthesised
negatives) that no invented file would contain. The parser corpus is therefore **redacted from real
exports**, and redaction becomes the safety property that "synthetic" used to provide.

**Preserved byte-for-byte** — these are what break parsers, so altering them would defeat the corpus:
encoding and BOM · line endings · quoting style · delimiters · header text verbatim · preamble and
trailer junk rows · date formats · amount formats (signs, parentheses, thousands separators, currency
symbols, empty cells) · description *shapes* (`TST*` / `SQ *` prefixes, trailing store numbers,
city/state, reference-number patterns) · every malformed or ragged row.

**Substituted** — account numbers and last-four digits · merchant identities · amounts · dates · names,
addresses, phone numbers, reference numbers. Substitutions keep the original shape, length and
character class, so the parser faces the same problem: `TST* <REAL NAME> 04821 AUSTIN TX` becomes
`TST* VELVET TACO 04821 AUSTIN TX`, never `merchant1`.

**Never committed** — the raw exports, and the substitution mapping. Only redacted output enters the
repository. What is recorded is which *classes* of value were changed, never the mapping itself.

> `.gitignore` force-unignores `tests/fixtures/**/*.csv` so the corpus is committable, which means that
> directory is the one place a real statement *would* be committed silently. Raw exports must never be
> written there, and a fixture guard test asserts no committed fixture contains anything
> account-number-shaped.

---

## Uploaded files are hostile input

Every statement file comes from outside the trust boundary.

**Validated:** size (≤10 MB/file, ≤10 files), extension allowlist, magic-byte sniff, row count
(≤50k), cell length (≤4 KB), encoding (UTF-8 + BOM), date sanity (reject >1 year future, >30 years
past), amount sanity.

**Guaranteed:**

- Written to a `0600` temp file outside the webroot with a random name.
- **Deleted immediately after parsing — always, including on the failure path** (`finally`).
- **Never** written to `public/` or any statically served path.
- XLSX parsed with **formulas never evaluated** and external links ignored.
- Uncompressed-size limits guard against zip bombs.
- Unmapped source columns are **discarded at parse time and never persisted** — no address fragments,
  no internal bank codes, no card identifiers sitting in a staging table for weeks.

---

## Export: formula injection

A merchant description reading `=HYPERLINK("http://evil","refund")` is inert in Postgres and inert in
Burmy's UI. It becomes dangerous only when the owner opens the export in Excel.

**Neutralized at the writer, not the reader.** Any cell whose first character is `=`, `+`, `-`, `@`,
TAB or CR is prefixed with a single quote. Applied to **every** string cell — including headers and
category names. Covered by a payload fixture test.

---

## Web hardening

| Control | Setting |
| --- | --- |
| CSP | Strict, nonce-based, per request, built in `src/proxy.ts`. `'unsafe-eval'` in **development only** (React Refresh cannot hot reload without it). `'unsafe-inline'` in exactly one directive — `style-src-attr` — as an accepted, non-neutral tradeoff (below). |
| HSTS | `max-age=63072000; includeSubDomains; preload` |
| Others | `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, restrictive `Permissions-Policy` |
| CSRF | Next.js Server Action origin checks. **No state-changing GET routes.** There is no auth-endpoint CSRF surface at all — authentication happens entirely at Cloudflare Access, outside this application. |
| XSS | React escaping; `dangerouslySetInnerHTML` banned by lint. Statement descriptions are untrusted text everywhere they are rendered. |
| Rate limiting | Cloudflare at the edge; per-owner limits on upload and export (M5+). No origin-side auth-endpoint limiter — there is no in-app auth endpoint left to rate limit. The `rate_limit` table remains in the schema, unused (see `src/server/db/schema.ts`), rather than dropped without a concrete reason. |

### The CSP: one accepted relaxation, and one refused

Two separate things go wrong under a nonce-only style policy, and they have
different answers. Both were established by capturing `securitypolicyviolation`
DOM events (`effectiveDirective` + `sourceFile`) rather than reading console text
— the console names the *fallback* directive and sends you after the wrong cause.

**1. Style ATTRIBUTES — relaxed, deliberately.** Radix positions floating elements
by writing inline `style="…"` attributes from JavaScript. Per CSP3 an attribute has
nowhere to carry a nonce, so `style-src-attr` admits only `'unsafe-inline'` or
hashes of runtime-computed geometry. There is no Radix configuration that avoids it.

> **This is not security-neutral.** Style-attribute injection can overlay or hide
> UI (clickjacking a confirm button) and can exfiltrate limited information via
> attribute selectors and background-image requests. It is accepted because the
> alternative was hand-rolling focus management and overlay accessibility for every
> dialog. What it does **not** permit is script: `script-src` stays nonce-only with
> `'strict-dynamic'` and no `'unsafe-inline'` in any environment, so this cannot
> become code execution. For it to be reachable at all, untrusted text would have to
> flow into a style attribute — React escapes interpolated output,
> `dangerouslySetInnerHTML` is banned by lint, and statement text is rendered as
> text nodes.

**2. Style ELEMENTS — refused, and solved properly.** Radix's scroll lock
(`react-remove-scroll`) injects a real `<style>` element, governed by
`style-src-elem` → `style-src`. The easy fix would have been adding
`'unsafe-inline'` to `style-src`, which is what most Next.js CSP examples do. That
was refused: it permits *any* injected stylesheet, a materially bigger hole than the
attribute case. Instead the per-request nonce is handed to `get-nonce`'s `setNonce()`
(`src/features/shell/style-nonce.tsx`), so the injected tag is legitimate under the
existing policy. **`<style>` elements and stylesheet links remain nonce-controlled.**

**3. The dev overlay is not a reason to relax anything.** Before Radix arrived, a
nonce-only policy still reported ~33 `style-src-elem` violations on `/sign-in` —
all sourced from `_next/static/chunks/…next-devtools…`, the development overlay,
which produces zero chunks in a production build. A `style-src-attr` exception was
once added for this, measured, and reverted. Application code produced zero
violations.

**What the tests pin.** `tests/unit/csp.test.ts` asserts `'unsafe-inline'` appears in
exactly one directive and that no `script-src-attr` escape hatch exists.
`tests/e2e/csp.spec.ts` proves the live header is byte-identical to
`buildCsp(...)` output, then asserts the four production properties directly:
`style-src-attr` permits `'unsafe-inline'`; `script-src` does not; production
`script-src` has no `'unsafe-eval'` (development does); and `style-src` stays
`'self'` + nonce. `tests/e2e/shell.spec.ts` opens a real Radix dialog and select and
asserts zero violations from application code.

---

## Network

There is no host to firewall — production is Netlify (hosting) + Supabase (managed Postgres), both
managed services with no VPS, no SSH, no `ufw`, no self-managed network to reason about.

- **`app.burmy.me` is proxied through Cloudflare specifically so Cloudflare Access sits in front of
  every request** — see "Authentication" above. `burmy.me`/`www.burmy.me` (the unrelated portfolio)
  stay DNS-only.
- **Cloudflare's SSL/TLS mode for `app.burmy.me` is `Full (strict)`** — Netlify provisions a real,
  validly-signed origin certificate, so the hop between Cloudflare and Netlify is validated, not just
  encrypted-but-unverified.
- **Supabase Postgres requires TLS** (`sslmode=require` in the connection string) and is never reached
  except through its Supavisor pooler (app runtime) or its direct connection (migrations only, from an
  operator's own machine, never stored anywhere in Netlify) — see `docs/DEPLOYMENT.md`, "Database —
  Supabase Postgres."
- This replaced an earlier VPS design (`cloudflared` Tunnel, `ufw`, key-based SSH, an `internal: true`
  Docker network for Postgres) — real, working code in its day, removed from the active repository when
  production moved to Netlify + Supabase; see `docs/DEPLOYMENT.md`, "Why the VPS was dropped," and git
  history if self-hosting is ever picked up again.

### Outbound HTTP — three destinations, all Games, all optional

**Finance makes no outbound requests at all.** "No bank connections, ever" is a CLAUDE.md invariant: no
Plaid, no bank APIs, no OAuth to a financial institution, no scraping, no stored bank credentials.
Statements arrive as a file the owner picks in the browser. Nothing in `src/server/finance/` or
`src/server/db/finance/` calls `fetch`.

The Games module calls three third-party APIs, and every one of them is confined to `src/server/db/games/`:

| Destination | Sends | Credential |
| --- | --- | --- |
| IGDB (auth via Twitch OAuth) | Game titles for lookup | `IGDB_CLIENT_ID`/`IGDB_CLIENT_SECRET` |
| Steam Web API | The owner's SteamID and app ids | `STEAM_API_KEY`/`STEAM_ID` |
| PlayStation Network | The owner's account context | `PSN_NPSSO` |

Three properties hold for all of them:

- **No Finance data ever crosses these boundaries.** The two modules share no data path.
- **Every one is optional and fails soft** — a missing credential, timeout, non-200 or malformed JSON
  yields `[]`/`null`, never a throw. The full test suite must pass with none of them set. A third party
  being down or slow can degrade a Games feature; it cannot break a page or affect Finance.
- **PSN's is an UNOFFICIAL API** reached with a browser-derived token (`PSN_NPSSO`) that expires roughly
  every two months. It is the least trustworthy dependency in the project: undocumented, unversioned,
  and revocable without notice. It is treated accordingly — an expired token surfaces a specific
  message, never a retry loop, and nothing about the app depends on it working.

---

## Secrets

- Never in git. `.gitignore` covers `.env*`, keys, certs.
- **Production secrets live in Netlify's own environment-variable store** — scoped to Functions/Runtime
  only (never Build), Production context only (never Deploy Previews or Branch deploys), and marked
  "Contains secret values" (Netlify's Secrets Controller) where applicable. Full policy, including which
  variable gets which scope, in `docs/DEPLOYMENT.md`, "Netlify environment-variable policy." None of
  them are ever written into `netlify.toml`, which is committed.
- **Four required variables, plus five optional ones for Games.** `DATABASE_URL`, `OWNER_EMAIL`,
  `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are what the application needs to run.
  `IGDB_CLIENT_ID`/`IGDB_CLIENT_SECRET`, `STEAM_API_KEY`/`STEAM_ID` and `PSN_NPSSO` are credentials for
  the owner's personal accounts on three third-party platforms; every one is optional by contract, and
  the full test suite must pass with none of them present. They get the same scoping and secret-marking
  as the required four — an optional credential is still a credential.
- **The Supabase migration credential (`MIGRATION_DATABASE_URL`) is never stored in Netlify at all** —
  it exists only on an operator's own shell for the moment a migration runs. See `docs/DEPLOYMENT.md`,
  "Database — Supabase Postgres."
- `.env.example` (local development only) holds placeholders only.
- **Secrets and recovery credentials are deliberately excluded from Finance backups.** A backup is a
  logical Postgres dump — application data only, never credentials — kept outside Supabase. See
  `docs/DEPLOYMENT.md`, "Backup strategy," for the current policy.

---

## Audit and logging

**Audited:** an entry point reached without a valid, owner-matched Access identity (distinguishing "no
or invalid assertion" from "verified as the owner, but the row is not provisioned yet"), Access
misconfiguration, import commit/discard, bulk category change, rule change, export, transaction
delete. Metadata is redacted — see `src/server/security/audit.ts`. There is no sign-in/sign-out event
of its own to audit: authentication happens entirely at Cloudflare Access, which keeps its own logs.

**Never logged:** raw statement rows, full descriptions, amounts at info level, tokens, cookies,
`Authorization` headers, OAuth secrets, connection strings.

Errors log a correlation id and a row *number* — never row *content*. Error pages surface the
correlation id so a problem is traceable without the logs holding financial data.

---

## Pre-release checklist

Run before the first production import (Milestone 10). Items marked ✅ are covered by automated
tests as of M2 and re-run on every suite; the rest need the real deployment.

- [ ] A second Google account is refused at Cloudflare Access *(needs the real Access policy)*
- [x] ✅ Direct origin access without a valid Access JWT is refused — `tests/unit/access.test.ts`
      covers signature, `aud`, `iss`, `exp`, tampering and non-owner rejection against a real ES256
      key pair; the proxy returns 403, and 503 when unconfigured outside development
- [x] ✅ Every Server Action and Route Handler rejects an unauthenticated call with the proxy bypassed
      — `tests/integration/entry-points.test.ts` enumerates the filesystem, so a new unguarded route
      fails the suite (validated by temporarily adding one and watching it fail both statically and
      by direct invocation)
- [x] ✅ `/api/health` response contains no counts, data, or environment detail
- [ ] Supabase connections use TLS end to end, and the pooled runtime connection string
      (`DATABASE_URL`) and the direct migration/backup connection string
      (`MIGRATION_DATABASE_URL`) are never exposed to the client — both live only in Netlify's
      server-side environment-variable store, never in a `NEXT_PUBLIC_*` variable *(needs the real
      Netlify + Supabase deployment to confirm end to end)*
- [x] ✅ Access is revoked from the Cloudflare Access policy takes effect on the owner's very next
      request — there is no session of Burmy's own to independently outlive it; asserted in
      `tests/integration/owner-guard.test.ts`'s "resolve, never create" and fail-closed cases
- [ ] The owner row is provisioned (`node scripts/provision-owner.mjs`) before the first real sign-in
      *(needs the production deployment)*
- [ ] `git log -p` contains no secret and no real financial data *(re-check at M10)*
- [ ] An integration test proves an unscoped Finance read is impossible *(M3+, when there is Finance
      data to read)*
- [x] ✅ Formula-injection fixture round-trips safely through CSV export — `tests/unit/export-csv.test.ts`
      (M9). XLSX export was never built (CSV alone covers the need; ExcelJS's dependency-security gate
      was never triggered), so there is no XLSX path to cover.
- [ ] A restore has been performed and verified — not merely configured. **Locally proven**: a real
      `pg_dump -Fc` → `pg_restore --no-owner` round trip against real seeded local Postgres data, into
      a scratch database, with the restored data compared row-for-row against the source (see
      `docs/DEPLOYMENT.md`, "Backup strategy"). *Still outstanding: the same drill against the real
      production Supabase project.*
