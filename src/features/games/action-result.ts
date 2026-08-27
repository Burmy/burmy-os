/**
 * The shape every Games Server Action returns.
 *
 * Expected failures (a duplicate title, a bad rating) come back as DATA so the
 * form can show a field error without the route's error boundary replacing what
 * the owner typed. Unexpected failures — `requireOwner()` rejecting, the
 * database being unreachable — still THROW, so a security refusal never gets
 * flattened into something that renders like a typo.
 */
export type ActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly field?: 'title' | 'hours' | 'rating' };

export function ok(): ActionResult {
  return { ok: true };
}

export function fail(error: string, field?: 'title' | 'hours' | 'rating'): ActionResult {
  // `exactOptionalPropertyTypes` is on — spread the key in conditionally rather
  // than assigning `undefined`.
  return { ok: false, error, ...(field ? { field } : {}) };
}
