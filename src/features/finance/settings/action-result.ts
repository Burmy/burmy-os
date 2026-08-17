/**
 * The shape every Server Action in Settings returns.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A RESULT OBJECT INSTEAD OF THROWING
 *
 * A duplicate category name is ordinary user input, not an exception. Throwing
 * would hit the route's error boundary and replace the form — losing what the
 * owner typed — to report something a field label should say. So expected
 * failures come back as data.
 *
 * UNEXPECTED failures still throw. `requireOwner()` rejecting, or the database
 * being unreachable, must not be flattened into `{ ok: false }` and rendered as a
 * validation message: that would make a security refusal look like a typo.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export type ActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly field?: 'name' | 'lastFour' };

export function ok(): ActionResult {
  return { ok: true };
}

export function fail(error: string, field?: 'name' | 'lastFour'): ActionResult {
  return { ok: false, error, ...(field ? { field } : {}) };
}
