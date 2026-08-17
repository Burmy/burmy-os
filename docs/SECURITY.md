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

---

## Bootstrap and recovery — settled by prototype in M2

Better Auth's passkey plugin documents **no** bootstrap-without-a-session story and **no** recovery
path at all. Both candidates from the plan were implemented and measured against a real PostgreSQL 18
before anything was chosen. What follows is observed behaviour, not design intent.

### One mechanism serves both: the out-of-band grant

`scripts/auth-grant.mjs <bootstrap|recovery>` mints a **256-bit, single-use, 10-minute** token and
prints it once to the terminal. It is redeemed at `POST /api/auth/burmy/redeem-grant`, which verifies
Cloudflare Access itself, then creates a session.

| Property | How it is guaranteed |
| --- | --- |
| Single use | Better Auth's `consumeVerificationValue()` — an atomic `consumeOne` inside a transaction. Proven by a test firing 5 concurrent redemptions of one token: exactly 1 succeeded, 1 session row existed. |
| Short lived | `expiresAt` on the `verification` row, re-checked after consumption. |
| Not in a backup | Only `sha256(token)` is stored. The database can *recognize* a token, never produce one — so a restored dump contains no usable credential. |
| Never over HTTP | Minting requires Tailscale + an SSH key + shell access + the database password. There is no HTTP route that issues one. |
| Not email | There is no email path anywhere in Burmy. An emailed reset link would be a permanent phishable bypass of the very factor the passkey provides. |
| Audited | `issued` / `redeemed` / `rejected` with a reason, and never the token. |
| Rate limited | 5 attempts/hour on that path, counters in the **`rate_limit` table** — a restart does not clear them. |
| Factor 1 still required | Losing a passkey does not cost the owner their Google account, so recovery still passes Access. A leaked token alone is insufficient. |

Recovery additionally **revokes every existing session** before creating its own: the owner is there
because their credentials are gone, so any surviving session is forgotten at best.

A `bootstrap` grant is **refused once any passkey exists**, so a forgotten bootstrap token cannot
become a permanent side door. After enrolment, getting back in is recovery, and needs a recovery
grant. The two kinds are not interchangeable in either direction, and a mismatched token is still
consumed — a wrong guess is not a free probe.

### Bootstrap: why passkey-first registration was rejected

| | Candidate A — passkey-first | **Candidate B — session-first (shipped)** |
| --- | --- | --- |
| Config | `registration.requireSession: false` + a `resolveUser` gate | `requireSession` left at its default `true` |
| Unauthenticated surface | `/passkey/generate-register-options` answers anonymous callers **permanently**, for a once-ever operation | Endpoint is simply unreachable without a session |
| Token consumption | Could not consume at options time without burning the grant whenever the browser prompt was dismissed → **one token yielded unlimited challenges for its full 10 minutes** | Single use, consumed on redemption |
| Owner row creation | Created from an **anonymous request** | Created inside an authenticated redemption |
| Code paths to keep correct | Two token validators (`resolveUser` + redeem) | One |
| Recovery path exercised | Cold — first run on the worst day | **Same code as bootstrap, so it runs on day one** |

Both were verified working. B was chosen because A's cost is a standing unauthenticated endpoint in
exchange for an operation that happens exactly once, and because B makes the break-glass path
something that has already been used successfully rather than untested code.

**Candidate A's implementation was deleted, not left behind a flag.** A `requireSession: false` code
path in the tree is one edit away from being live.

### Committed constraints, both met

- **Two passkeys minimum** before onboarding completes — enforced in `requireOwner()`, not in the UI.
- **Recovery does not depend on email** — there is no email in the system.
- **The last passkey cannot be deleted.** Two → one is allowed (the gate then asks for a replacement);
  one → zero is refused, so a mis-click cannot force a break-glass recovery.

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
| CSP | Strict, nonce-based, per request, built in `src/proxy.ts`. No `unsafe-inline` in any directive. `'unsafe-eval'` in **development only** (React Refresh cannot hot reload without it). |
| HSTS | `max-age=63072000; includeSubDomains; preload` |
| Others | `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, restrictive `Permissions-Policy` |
| CSRF | Next.js Server Action origin checks + Better Auth token. **No state-changing GET routes.** |
| XSS | React escaping; `dangerouslySetInnerHTML` banned by lint. Statement descriptions are untrusted text everywhere they are rendered. |
| Rate limiting | Cloudflare at the edge; Better Auth limiter on auth routes, counters in the `rate_limit` **table** so a restart does not clear them; 5/hour on grant redemption; per-owner limits on upload and export (M5+) |

### The CSP investigation, recorded so it is not re-litigated

A nonce-only `style-src` reports ~33 violations on `/sign-in`. The obvious diagnosis — "React sets
inline `style` attributes, and CSP3 forbids a nonce from satisfying `style-src-attr`" — is **wrong
here**, and acting on it would have widened the policy for no reason.

Capturing `securitypolicyviolation` DOM events (which carry `effectiveDirective` and `sourceFile`,
unlike the console message) showed all 33 were `style-src-elem`, every one sourced from
`_next/static/chunks/…next-devtools….js` — the **development overlay**. A production build contains
zero `next-devtools` chunks. Application code produced **zero** violations, and `script-src` produced
zero in either mode.

So no relaxation exists. A `style-src-attr 'unsafe-inline'` was added, measured, and reverted.
`tests/unit/csp.test.ts` asserts `'unsafe-inline'` appears in **no** directive and that no `-attr`
escape hatch has crept in; `tests/e2e/passkey.spec.ts` asserts zero `script-src` violations and zero
violations from anything other than the dev overlay.

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
- [ ] Postgres is unreachable from outside the Docker network *(needs the production compose stack)*
- [x] ✅ A revoked session dies immediately — server-side session store, asserted in
      `tests/integration/owner-guard.test.ts`
- [x] ✅ Session cookie is host-only, `HttpOnly`, `SameSite=Lax`, and `Secure` in production
- [ ] `git log -p` contains no secret and no real financial data *(re-check at M10)*
- [ ] An integration test proves an unscoped Finance read is impossible *(M3+, when there is Finance
      data to read)*
- [ ] Formula-injection fixture round-trips safely through CSV and XLSX export *(M9)*
- [ ] A restore has been performed and verified — not merely configured *(M10)*
