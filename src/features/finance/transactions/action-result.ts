/**
 * Same shape as review/import/settings' own action-result.ts — expected
 * failures come back as data, not a thrown exception, so a bad id or a wrong
 * owner renders as a message rather than the route's error boundary.
 */
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export function ok(): ActionResult {
  return { ok: true };
}

export function fail(error: string): ActionResult {
  return { ok: false, error };
}
