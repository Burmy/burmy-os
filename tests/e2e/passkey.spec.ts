import { randomUUID } from 'node:crypto';

import { type Page, expect, test } from '@playwright/test';
import postgres from 'postgres';

import {
  GRANT_TTL_SECONDS,
  encodeGrantPayload,
  generateGrantToken,
  grantIdentifier,
} from '../../scripts/auth-grant.mjs';

/**
 * The Milestone 2 Definition of Done: passkey sign-in works END TO END.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS TEST HAS TO EXIST SEPARATELY FROM THE INTEGRATION SUITE
 *
 * Everything else about passkeys can be asserted without an authenticator —
 * which requests are refused, which rows are written, how the gate behaves. What
 * CANNOT be faked at that level is the WebAuthn ceremony itself: generating a
 * credential, signing a challenge with it, and having the server verify that
 * signature. That runs in the browser and in `@simplewebauthn/server`.
 *
 * Chrome's CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`) is a
 * REAL WebAuthn implementation with a software-backed key store, so the
 * cryptography being exercised here is genuine — only the hardware is virtual.
 * That makes this the one test that proves the credential path works at all.
 *
 * It deliberately uses the grant script's own exported helpers to mint the
 * bootstrap token, so the operator path is what gets exercised rather than a
 * test-only shortcut.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://burmy:burmy@localhost:5432/burmy';

/** Mirrors the dev `.env`, which the server under test is running with. */
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'dev@example.invalid';

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function resetAuthState(): Promise<void> {
  await withDb(async (sql) => {
    await sql.unsafe(
      'truncate table "audit_events", "rate_limit", "verification", "passkey", "session", "account", "user" cascade',
    );
  });
}

/** Mint a grant exactly as `node scripts/auth-grant.mjs <kind>` would. */
async function mintGrant(kind: 'bootstrap' | 'recovery'): Promise<string> {
  const token = generateGrantToken();

  await withDb(async (sql) => {
    await sql`
      insert into "verification" ("id", "identifier", "value", "expires_at")
      values (
        ${randomUUID()},
        ${grantIdentifier(token)},
        ${encodeGrantPayload({
          kind,
          email: OWNER_EMAIL.toLowerCase(),
          issuedAt: new Date().toISOString(),
        })},
        ${new Date(Date.now() + GRANT_TTL_SECONDS * 1000)}
      )
    `;
  });

  return token;
}

/**
 * A handle for adding virtual authenticators — i.e. simulated DEVICES.
 *
 * Two are needed, and that is not a testing quirk. Better Auth sends
 * `excludeCredentials` listing the user's existing passkeys, so an authenticator
 * that already holds a credential for this account correctly REFUSES to create a
 * second one. That is proper WebAuthn behaviour, and it is exactly what the
 * onboarding copy tells the owner ("use a different device for this one"), so the
 * test models two devices rather than working around it.
 *
 * Discovered by this test failing: one authenticator enrolled the first passkey
 * and silently declined the second.
 *
 * The FIRST device is `internal` (a platform authenticator — Windows Hello, a
 * phone). Every later one is `usb`, because Chrome permits only ONE internal
 * authenticator per environment. That is also the realistic pairing the
 * onboarding copy is asking for: the built-in credential plus a security key.
 */
async function authenticators(page: Page): Promise<{ addDevice: () => Promise<string> }> {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable', { enableUI: false });
  let deviceCount = 0;

  return {
    async addDevice() {
      const transport = deviceCount === 0 ? 'internal' : 'usb';
      deviceCount += 1;

      const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport,
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      return authenticatorId;
    },
  };
}

async function redeemGrant(page: Page, kind: 'bootstrap' | 'recovery'): Promise<void> {
  const token = await mintGrant(kind);

  await page.goto('/recovery');
  await page.getByRole('radio', { name: kind }).check();
  await page.getByLabel('Token').fill(token);
  await page.getByRole('button', { name: 'Redeem' }).click();

  await expect(page).toHaveURL(/\/onboarding\/passkeys$/);
}

test.describe.configure({ mode: 'serial' });

test.describe('passkey enrolment and sign-in', () => {
  test.beforeEach(async () => {
    await resetAuthState();
  });

  test('bootstrap → enrol two passkeys → reach the grid → sign in again', async ({ page }) => {
    const devices = await authenticators(page);
    await devices.addDevice();

    // ── Bootstrap: a grant minted on the host, redeemed once ──────────────────
    await redeemGrant(page, 'bootstrap');
    await expect(page.getByText('0 of 2 enrolled')).toBeVisible();

    // ── The gate is real: the grid is not reachable yet ───────────────────────
    await page.goto('/finance/monthly');
    await expect(page).toHaveURL(/\/onboarding\/passkeys$/);

    // ── Enrol the first credential. This is a genuine WebAuthn ceremony ───────
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.getByText('1 of 2 enrolled')).toBeVisible();

    // Still gated at one — the whole point of MIN_PASSKEYS.
    await page.goto('/finance/monthly');
    await expect(page).toHaveURL(/\/onboarding\/passkeys$/);

    // ── Second credential, on a SECOND device ──────────────────────────────────
    await devices.addDevice();
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.getByText('2 of 2 enrolled')).toBeVisible();

    await page.getByRole('button', { name: 'Continue to Burmy' }).click();
    await expect(page).toHaveURL(/\/finance\/monthly$/);
    await expect(page.getByRole('heading', { name: 'Monthly', level: 1 })).toBeVisible();

    // Two credentials really were persisted.
    const passkeyCount = await withDb(async (sql) => {
      const rows = await sql<{ n: string }[]>`select count(*)::text as n from "passkey"`;
      return Number(rows[0]?.n ?? '0');
    });
    expect(passkeyCount).toBe(2);

    // ── Sign out, then sign in with the passkey. THE DoD. ─────────────────────
    await withDb(async (sql) => {
      await sql`delete from "session"`;
    });

    await page.goto('/finance/monthly');
    await expect(page).toHaveURL(/\/sign-in$/);

    await page.getByRole('button', { name: 'Continue with a passkey' }).click();

    // A session created by verifying a signature over the server's challenge.
    await expect(page).toHaveURL(/\/finance\/monthly$/);
    await expect(page.getByRole('heading', { name: 'Monthly', level: 1 })).toBeVisible();
  });

  test('recovery after losing every passkey restores access', async ({ page, browser }) => {
    const devices = await authenticators(page);
    await devices.addDevice();

    // Get to a fully enrolled state, one credential per device.
    await redeemGrant(page, 'bootstrap');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.getByText('1 of 2 enrolled')).toBeVisible();
    await devices.addDevice();
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.getByText('2 of 2 enrolled')).toBeVisible();

    // ── The disaster: every credential gone, and the session with it ──────────
    await withDb(async (sql) => {
      await sql`delete from "passkey"`;
      await sql`delete from "session"`;
    });

    await page.goto('/finance/monthly');
    await expect(page).toHaveURL(/\/sign-in$/);

    /**
     * Recovery continues in a FRESH browser context with FRESH authenticators,
     * because that is the actual situation: the phone and laptop that held the
     * passkeys are gone, and the owner is on a replacement machine.
     *
     * It is also the only way to test this honestly. Reusing the original
     * context leaves the old virtual authenticators holding resident credentials
     * for the same (rpId, userHandle) — the rows are deleted server-side but the
     * key material is still in the simulated devices. Chrome then routes
     * enrolment to an authenticator that already has a credential for this user
     * and the ceremony is refused, which is an artefact of the simulation rather
     * than anything the application does.
     */
    const freshContext = await browser.newContext();
    try {
      const freshPage = await freshContext.newPage();
      const freshDevices = await authenticators(freshPage);
      await freshDevices.addDevice();

      // Break glass. A recovery grant — not a bootstrap one, and not an email.
      await redeemGrant(freshPage, 'recovery');

      // Straight into re-enrolment: there is nothing to authenticate with yet.
      await expect(freshPage.getByText('0 of 2 enrolled')).toBeVisible();

      await freshPage.getByRole('button', { name: 'Add a passkey' }).click();
      await expect(freshPage.getByText('1 of 2 enrolled')).toBeVisible();

      await freshDevices.addDevice();
      await freshPage.getByRole('button', { name: 'Add a passkey' }).click();
      await expect(freshPage.getByText('2 of 2 enrolled')).toBeVisible();

      await freshPage.getByRole('button', { name: 'Continue to Burmy' }).click();
      await expect(freshPage).toHaveURL(/\/finance\/monthly$/);

      // Same owner row — recovery restores access, it does not fork an identity.
      const users = await withDb(async (sql) => {
        const rows = await sql<{ n: string }[]>`select count(*)::text as n from "user"`;
        return Number(rows[0]?.n ?? '0');
      });
      expect(users).toBe(1);
    } finally {
      await freshContext.close();
    }
  });

  test('a used bootstrap token cannot be replayed from the browser', async ({ page }) => {
    const token = await mintGrant('bootstrap');

    await page.goto('/recovery');
    await page.getByRole('radio', { name: 'bootstrap' }).check();
    await page.getByLabel('Token').fill(token);
    await page.getByRole('button', { name: 'Redeem' }).click();
    await expect(page).toHaveURL(/\/onboarding\/passkeys$/);

    // Same token, second time.
    await page.goto('/recovery');
    await page.getByRole('radio', { name: 'bootstrap' }).check();
    await page.getByLabel('Token').fill(token);
    await page.getByRole('button', { name: 'Redeem' }).click();

    // Targeted rather than `getByRole('alert')`: Next.js renders its own
    // `role="alert"` route announcer, so the generic role matches two elements.
    await expect(page.getByText('That token was not accepted.')).toBeVisible();
    await expect(page).toHaveURL(/\/recovery$/);
  });
});

test.describe('Content Security Policy', () => {
  /**
   * Parse a policy string into directive -> sources.
   */
  function directives(policy: string): Map<string, string[]> {
    return new Map(
      policy
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [name, ...values] = part.split(/\s+/);
          return [name ?? '', values];
        }),
    );
  }

  test('the live header is exactly what buildCsp produces', async ({ page, request }) => {
    /**
     * This test closes the chain the next one depends on.
     *
     * The production policy cannot be exercised through a browser here: outside
     * development the proxy REFUSES every request that lacks a verified
     * Cloudflare Access assertion, and there is no Cloudflare in a test run.
     * That is the fail-closed behaviour M2 shipped and it is not worth weakening
     * to make a test easier.
     *
     * So the chain is: (1) prove the running server emits precisely
     * `buildCsp(...)` output, here; (2) assert the production properties of
     * `buildCsp({ development: false })` directly, next. Together those say
     * something real about production without pretending to have browsed it.
     */
    const { buildCsp } = await import('../../src/server/security/csp');

    const response = await request.get('/api/health');
    const header = response.headers()['content-security-policy'];
    expect(header, 'no CSP header on the response').toBeTruthy();

    const nonce = /'nonce-([^']+)'/.exec(header ?? '')?.[1];
    expect(nonce, 'CSP header carries no nonce').toBeTruthy();

    expect(header).toBe(buildCsp({ nonce: nonce as string, development: true }));

    // And a second request gets a different nonce — a reused one is a reusable
    // injection point.
    const again = await request.get('/api/health');
    const secondNonce = /'nonce-([^']+)'/.exec(
      again.headers()['content-security-policy'] ?? '',
    )?.[1];
    expect(secondNonce).not.toBe(nonce);

    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('PRODUCTION policy: the four properties that matter', async () => {
    const { buildCsp } = await import('../../src/server/security/csp');

    const production = directives(buildCsp({ nonce: 'N', development: false }));
    const development = directives(buildCsp({ nonce: 'N', development: true }));

    // 1. style-src-attr permits 'unsafe-inline'. Radix positions floating
    //    elements with inline style attributes and CSP3 gives an attribute
    //    nowhere to carry a nonce. A narrow, accepted relaxation — see csp.ts.
    expect(production.get('style-src-attr')).toEqual(["'unsafe-inline'"]);

    // 2. script-src does NOT permit 'unsafe-inline'. Nothing here may become
    //    code execution.
    expect(production.get('script-src')).not.toContain("'unsafe-inline'");
    expect(production.get('script-src')).toContain("'strict-dynamic'");
    expect(production.has('script-src-attr')).toBe(false);

    // 3. production script-src does NOT permit 'unsafe-eval'. Development needs
    //    it for React Refresh; production must never have it.
    expect(production.get('script-src')).not.toContain("'unsafe-eval'");
    expect(development.get('script-src')).toContain("'unsafe-eval'");

    // 4. <style> elements and stylesheet links stay under the nonce. Most
    //    Next.js CSP examples relax `style-src` wholesale; this does not, so an
    //    injected <style> block or a remote stylesheet is still refused.
    expect(production.get('style-src')).toEqual(["'self'", "'nonce-N'"]);
    expect(production.get('style-src')).not.toContain("'unsafe-inline'");

    // The relaxation is confined to exactly one directive, in both modes.
    for (const parsed of [production, development]) {
      const relaxed = [...parsed.entries()]
        .filter(([, values]) => values.includes("'unsafe-inline'"))
        .map(([name]) => name);
      expect(relaxed).toEqual(['style-src-attr']);
    }
  });

  test('the app renders and hydrates with no violations from application code', async ({
    page,
  }) => {
    /**
     * Captured via the `securitypolicyviolation` DOM event rather than console
     * text, because the event carries `effectiveDirective` and `sourceFile`. That
     * precision mattered: a blanket "zero violations" assertion once failed with
     * 33 entries that all turned out to come from
     * `…/chunks/…next-devtools….js` — the development overlay, absent from a
     * production build (verified: zero `next-devtools` chunks in `.next/static`).
     *
     * Rather than widen the policy for a dev-only tool, the assertion is scoped:
     * nothing from application code may be blocked, and NOTHING may ever be
     * blocked in `script-src`.
     */
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.addInitScript(() => {
      const record: Array<{ directive: string; source: string }> = [];
      (window as unknown as { __cspViolations: typeof record }).__cspViolations = record;
      document.addEventListener('securitypolicyviolation', (event) => {
        record.push({ directive: event.effectiveDirective, source: event.sourceFile ?? '' });
      });
    });

    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // Hydration really happened: this is a client component responding.
    await expect(page.getByRole('button', { name: 'Continue with a passkey' })).toBeEnabled();

    const violations = await page.evaluate(
      () =>
        (window as unknown as { __cspViolations: Array<{ directive: string; source: string }> })
          .__cspViolations,
    );

    expect(violations.filter((v) => v.directive.startsWith('script-src'))).toEqual([]);
    expect(violations.filter((v) => !v.source.includes('next-devtools'))).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
