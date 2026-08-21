/**
 * `games.priceCents` display, and nothing else.
 *
 * `priceCents` uses the same signed-cents convention as Finance's
 * `amount_cents` (see docs/GAMES.md, "Price is independent of Finance"), but
 * Games never imports from `src/server/finance/` — that boundary is absolute.
 * This is the Games-side equivalent of `finance/money.ts`'s formatting half:
 * pure, framework-free, and the only place Games turns a cents figure into a
 * dollar string. There is no parsing counterpart here because the one place
 * Games parses owner-typed dollars (`game-actions.ts`'s `priceDollars` field)
 * already does it inline with `Math.round(dollars * 100)` — a single call
 * site, unlike hours, which needed a shared module because both the DAL and
 * the dialog convert in both directions.
 */

/**
 * `5999` -> `"$59.99"`. Rounds to the nearest cent first — every caller here
 * is a computed average (total spend ÷ a count), never a raw stored value, so
 * the input is not guaranteed to already be a whole cent.
 */
export function formatPriceCents(cents: number): string {
  const rounded = Math.round(cents);
  // Avoid printing "-$0.00" for a computed average that rounds to zero from
  // the negative side — the same -0 hazard `finance/grid.ts` guards against
  // when combining already-summed figures outside the branded `Cents` type.
  const normalized = rounded === 0 ? 0 : rounded;
  return `$${(normalized / 100).toFixed(2)}`;
}
