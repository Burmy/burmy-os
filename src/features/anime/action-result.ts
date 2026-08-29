/**
 * Anime's own result type.
 *
 * Its own rather than a reuse of `@/features/games/action-result`: that one
 * carries `field?: 'title' | 'hours' | 'rating'`, a union that is meaningless
 * here, and importing it would couple two feature modules that CLAUDE.md says
 * share only generic UI primitives and the auth boundary.
 *
 * The doctrine is the same one both other modules hold. EXPECTED failures come
 * back as DATA, so a form can show an error without the route's error boundary
 * replacing what the owner typed. UNEXPECTED failures still THROW, so a
 * security refusal never gets flattened into something that reads like a typo.
 */
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export function ok(): ActionResult {
  return { ok: true };
}

export function fail(error: string): ActionResult {
  return { ok: false, error };
}
