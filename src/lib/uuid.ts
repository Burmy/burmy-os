/**
 * Is this string shaped like a UUID?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SHAPE CHECK EXISTS AT ALL, WHEN POSTGRES ALREADY VALIDATES UUIDS
 *
 * It validates them by THROWING. A `uuid` column compared against a
 * non-uuid string raises SQLSTATE `22P02` (`invalid input syntax for type
 * uuid`) from inside the query, which arrives at a Server Component as an
 * unhandled error and renders a 500. `/finance/transactions?category=x` and
 * `/finance/review?category=x` both did exactly that: an id straight out of
 * the query string, through `parseLedgerFilters`, into
 * `eq(financeTransactions.categoryId, …)`.
 *
 * So this is a guard for the URL boundary specifically — a hand-edited or
 * truncated link must produce an ignored filter, not a crashed page. It is
 * NOT an authorization check and it is NOT a substitute for one: a
 * well-formed uuid belonging to another owner still has to be refused by the
 * owner-scoped `WHERE` in the DAL, exactly as it is today.
 *
 * Deliberately a regex rather than `z.string().uuid()`, even though this
 * codebase reaches for zod everywhere a Server Action validates input.
 * `filters.ts` is imported by `transactions-table.tsx`, a client component,
 * so a runtime zod import there would be shipped to the browser to check a
 * string shape. Server Actions keep using zod; the URL boundary uses this.
 *
 * Accepts any RFC 4122 version and variant, plus the nil uuid. The point is
 * to reject "garbage", not to police which generator produced the id.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
