import type { CommitResult } from '@/server/db/finance/imports';

export { type ActionResult, ok, fail } from '../action-result';

export type UploadResult =
  | { readonly ok: true; readonly importId: string }
  | { readonly ok: false; readonly error: string };

export type CommitActionResult =
  | { readonly ok: true; readonly summary: CommitResult }
  | { readonly ok: false; readonly error: string };
