import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import postgres from 'postgres';

/**
 * Content Security Policy — through a real browser and a real live response.
 *
 * Split out of the old `passkey.spec.ts` (removed when Better Auth/passkeys
 * were replaced by Cloudflare Access + Google as the sole authentication
 * mechanism): none of this is about auth mechanics specifically, it is about
 * `src/proxy.ts`'s CSP construction, which applies to every request
 * regardless of how authentication works.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://burmy:burmy@localhost:5432/burmy';
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'dev@example.invalid';

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function resetAll(): Promise<void> {
  await withDb(async (sql) => {
    await sql.unsafe(
      'truncate table "audit_events", "rate_limit", "verification", "passkey", "session", ' +
        '"account", "finance_transactions", "finance_import_rows", "finance_import_files", ' +
        '"finance_imports", "finance_categories", "finance_accounts", "user" cascade',
    );
  });
}

async function provisionOwner(): Promise<void> {
  await withDb(async (sql) => {
    const email = OWNER_EMAIL.toLowerCase();
    await sql`
      insert into "user" ("id", "name", "email", "email_verified")
      values (${randomUUID()}, ${email}, ${email}, true)
    `;
  });
}

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

test.describe.configure({ mode: 'serial' });

test.describe('Content Security Policy', () => {
  test.beforeEach(async () => {
    await resetAll();
  });

  test('the live header is exactly what buildCsp produces', async ({ page, request }) => {
    /**
     * This test closes the chain the next one depends on.
     *
     * The production policy cannot be exercised through a browser here: outside
     * development the proxy REFUSES every request that lacks a verified
     * Cloudflare Access assertion, and there is no Cloudflare in a test run.
     * That is fail-closed behaviour this project will not weaken to make a
     * test easier.
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

    // The app itself still renders under this policy, on the one page
    // reachable without a provisioned owner.
    await page.goto('/access-denied');
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
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
     *
     * Uses /finance/monthly rather than the old static /sign-in form, so the
     * hydration proof is a real interactive component on actual product
     * surface, not an auth screen that no longer exists. The header's theme
     * toggle (present on every private page regardless of data state) is used
     * rather than the grid's own Year select, which only renders once at
     * least one category exists — this test seeds no fixture data.
     */
    await provisionOwner();

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.addInitScript(() => {
      const record: Array<{ directive: string; source: string }> = [];
      (window as unknown as { __cspViolations: typeof record }).__cspViolations = record;
      document.addEventListener('securitypolicyviolation', (event) => {
        record.push({ directive: event.effectiveDirective, source: event.sourceFile ?? '' });
      });
    });

    await page.goto('/finance/monthly');
    await expect(page.getByRole('heading', { name: 'Monthly' })).toBeVisible();

    // Hydration really happened: this is a client component responding.
    await expect(page.getByRole('button', { name: /^Theme:/ })).toBeEnabled();

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
