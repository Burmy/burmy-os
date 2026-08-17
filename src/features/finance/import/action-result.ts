import type { CommitResult } from '@/server/db/finance/imports';

/**
 * The shapes every Server Action in the import feature returns.
 *
 * Same reasoning as settings/action-result.ts: expected failures (a mismatched
 * account, a file that will not parse, an import that already committed) come
 * back as data so the form can show them without losing what the owner did.
 * UNEXPECTED failures — `requireOwner()` rejecting, the database being
 * unreachable — still throw.
 */
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export function ok(): ActionResult {
  return { ok: true };
}

export function fail(error: string): ActionResult {
  return { ok: false, error };
}

export type UploadResult =
  | { readonly ok: true; readonly importId: string }
  | { readonly ok: false; readonly error: string };

export type CommitActionResult =
  | { readonly ok: true; readonly summary: CommitResult }
  | { readonly ok: false; readonly error: string };
