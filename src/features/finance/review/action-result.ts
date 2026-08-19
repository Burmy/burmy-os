export { type ActionResult, ok, fail } from '../action-result';

export type BulkActionResult =
  | { readonly ok: true; readonly updatedCount: number }
  | { readonly ok: false; readonly error: string };
