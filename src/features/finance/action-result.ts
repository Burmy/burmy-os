/**
 * The shape every Finance Server Action returns, shared across features.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A RESULT OBJECT INSTEAD OF THROWING
 *
 * Expected failures (a bad id, a wrong owner, a file that will not parse) are
 * ordinary outcomes, not exceptions. Throwing would hit the route's error
 * boundary and replace the form — losing what the owner did — to report
 * something a message or field label should say. So expected failures come
 * back as data.
 *
 * UNEXPECTED failures still throw. `requireOwner()` rejecting, or the
 * database being unreachable, must not be flattened into `{ ok: false }` and
 * rendered as a validation message: that would make a security refusal look
 * like a typo.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export function ok(): ActionResult {
  return { ok: true };
}

export function fail(error: string): ActionResult {
  return { ok: false, error };
}
