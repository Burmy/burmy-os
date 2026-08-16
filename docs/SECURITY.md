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
| Google account compromise | The single most likely path in | Passkey at the app layer — a genuinely different factor |
| Stolen/borrowed device with a live session | Plausible | Cloudflare Access still gates; short session; re-auth for sensitive actions |
| Malicious or malformed statement file | Certain, eventually — files come from outside | Treat every upload as hostile (below) |
| Formula injection into an export | Plausible — a merchant name is attacker-influenced text | Neutralized at the writer |
| Secret committed to git | Common failure mode | Broad `.gitignore` committed first; secret scanning in CI |
| Origin reached without passing Access | Requires a tunnel misconfiguration | Access JWT verified in `src/proxy.ts` |
| Server Action invoked without auth | Easy to introduce accidentally | Every entry point authenticates itself (below) |
| Data loss (host reclaimed, disk failure) | **High** — see the Oracle analysis in the plan | Tested restore, not just backups |
| Dependency compromise | Ongoing | Renovate, `pnpm audit` in CI, lockfile committed, frozen installs |

**Out of scope — accepted risks, stated so they are decisions rather than oversights:**

- **Cloudflare can technically read application content** in transit; TLS terminates at their edge.
- **The VPS provider can technically read everything** at rest and in memory.
- A targeted attacker with physical access to the owner's unlocked, passkey-enrolled device.
- Nation-state adversaries.

---

## Authentication

Two factors with **different failure modes** — the point is not "two logins", it is that compromising
one does not compromise the other.

```
Cloudflare Access  →  Google identity, allowlisted to OWNER_EMAIL   ← factor 1
Burmy application  →  Passkey (WebAuthn), rpID = app.burmy.me       ← factor 2
```

**Google is configured exactly once, in Cloudflare Access.** Better Auth handles passkeys and the
local session only. There is no second OAuth client — one fewer place for the allowlist to drift.

Rules:

- No password authentication anywhere. No custom cryptography.
- **No signup route exists.** It is not registered, not merely hidden.
- `OWNER_EMAIL` is checked against the verified Access JWT claim *and* at session creation. Any other
  identity is rejected and audited.
- Session cookie: `httpOnly`, `Secure`, `SameSite=Lax`, **host-only — never `Domain=.burmy.me`**,
  7-day expiry with rolling refresh, stored server-side in Postgres for instant revocation.
- **At least two passkeys must be enrolled** before onboarding completes.
- Sensitive actions require re-authentication: bulk deletion, account deletion, passkey removal, full
  export, changing `OWNER_EMAIL`.

**Recovery is a designed feature, not an assumption.** Better Auth's passkey plugin documents no
recovery path. Milestone 2 prototypes both bootstrap and recovery before either is locked in. The only
committed constraints: two passkeys minimum, and recovery must not depend on email.

---

## Authorization — every entry point defends itself

Next.js documents that Server Functions are handled as **POSTs to the route where they are used**. A
`matcher` change, or refactoring an action to a different route, can therefore **silently remove proxy
coverage** — with no error and no test failure.

Consequently:

> **Every protected server entry point — Server Action or Route Handler — begins with
> `await requireOwner()`.** `src/proxy.ts` is defense-in-depth, not the security boundary.

**Unprotected endpoints are an explicit allowlist, not a judgement call:**

| Endpoint | Why | Constraint |
| --- | --- | --- |
| `/api/health` | Container and deploy healthchecks | Returns booleans and a version string **only**. No counts, no data, no error text, no environment detail. |
| `/api/auth/*` | Better Auth's own flows | Authenticates by design |

Anything not listed is protected. Integration tests invoke every entry point unauthenticated with the
proxy bypassed and assert rejection, and assert the health response contains no sensitive fields.

**Data access** goes through a layer that takes an owner id and injects the `WHERE` clause. Routes and
actions never build queries directly. Enforced by API shape and by integration tests asserting
cross-owner isolation — deliberately *not* by a custom lint rule.

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
| CSP | Strict, nonce-based. No `unsafe-inline`, no `unsafe-eval`. |
| HSTS | `max-age=63072000; includeSubDomains; preload` |
| Others | `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, restrictive `Permissions-Policy` |
| CSRF | Next.js Server Action origin checks + Better Auth token. **No state-changing GET routes.** |
| XSS | React escaping; `dangerouslySetInnerHTML` banned by lint. Statement descriptions are untrusted text everywhere they are rendered. |
| Rate limiting | Cloudflare at the edge; Better Auth limiter on auth routes; per-owner limits on upload and export |

---

## Network

- **No inbound ports.** `cloudflared` dials out.
- `ufw` default-deny. SSH bound to the Tailscale interface only, key-only, root login disabled.
- **Postgres is never published to the host** and sits only on the `internal: true` `dbnet` network.

---

## Secrets

- Never in git. `.gitignore` covers `.env*`, keys, certs, tunnel credentials.
- On the VPS: `.env` at `0600`, owned by the app user, injected via `env_file`.
- `.env.example` holds placeholders only.
- **Secrets and recovery credentials are deliberately excluded from Finance backups.** They live in
  the password manager and the offline recovery process. A stolen backup must not also carry the keys
  to the system it came from.

---

## Audit and logging

**Audited:** sign-in success/failure, passkey add/remove, recovery use, import commit/discard, bulk
category change, rule change, export, transaction delete. Metadata is redacted.

**Never logged:** raw statement rows, full descriptions, amounts at info level, tokens, cookies,
`Authorization` headers, OAuth secrets, connection strings.

Errors log a correlation id and a row *number* — never row *content*. Error pages surface the
correlation id so a problem is traceable without the logs holding financial data.

---

## Pre-release checklist

Run before the first production import (Milestone 10).

- [ ] A second Google account is refused at Cloudflare Access
- [ ] Direct origin access without a valid Access JWT is refused
- [ ] Every Server Action and Route Handler rejects an unauthenticated call with the proxy bypassed
- [ ] `/api/health` response contains no counts, data, or environment detail
- [ ] Postgres is unreachable from outside the Docker network
- [ ] A session revoked in Settings dies immediately
- [ ] `git log -p` contains no secret and no real financial data
- [ ] An integration test proves an unscoped Finance read is impossible
- [ ] Formula-injection fixture round-trips safely through CSV and XLSX export
- [ ] A restore has been performed and verified — not merely configured
