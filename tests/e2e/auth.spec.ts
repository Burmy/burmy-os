import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import postgres from 'postgres';

/**
 * Cloudflare Access + Google as the SOLE authentication mechanism, through a
 * real browser.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PROVES, AND WHAT IT CANNOT
 *
 * There is no Cloudflare in a dev server, so this cannot exercise a real
 * Access JWT round trip — that is proven cryptographically against a real
 * ES256 key pair in tests/unit/access.test.ts and tests/integration/
 * owner-guard.test.ts instead. What THIS file proves is the thing only a real
 * browser can: that once Cloudflare Access has done its job (simulated here by
 * the dev-bypass every `pnpm dev` / production deployment shares — see
 * `resolveAccessMode` in src/server/auth/access.ts) and the owner row exists,
 * a plain navigation lands directly on /finance/monthly with no passkey
 * screen, no onboarding gate, and no session of Burmy's own in the way. And
 * that when the owner row does NOT exist, the browser sees a simple access
 * error rather than any kind of sign-in prompt.
 * ─────────────────────────────────────────────────────────────────────────────
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

test.describe.configure({ mode: 'serial' });

test.describe('authentication', () => {
  test.beforeEach(async () => {
    await resetAll();
  });

  test('a provisioned owner is taken straight to the monthly grid — no passkey step, no onboarding', async ({
    page,
  }) => {
    await provisionOwner();

    await page.goto('/');

    await expect(page).toHaveURL(/\/finance\/monthly$/);
    await expect(page.getByRole('heading', { name: 'Finance' })).toBeVisible();
  });

  test('reaching a deep private route directly also lands there with no sign-in redirect', async ({
    page,
  }) => {
    await provisionOwner();

    await page.goto('/settings/finance/accounts');

    // No bounce through /sign-in or /access-denied — the owner row resolves
    // and the page renders exactly where it was asked for.
    await expect(page).toHaveURL(/\/settings\/finance\/accounts$/);
  });

  test('an unprovisioned owner sees a simple access-denied page, not a passkey prompt', async ({
    page,
  }) => {
    // resetAll() already ran; no owner row exists.
    await page.goto('/finance/monthly');

    await expect(page).toHaveURL(/\/access-denied$/);
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();

    // The old passkey/recovery language must not appear anywhere on this page.
    await expect(page.getByText(/passkey/i)).toHaveCount(0);
  });
});
