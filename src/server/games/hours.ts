/**
 * Play time, stored and summed as TENTHS OF AN HOUR.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY TENTHS AND NOT A FLOAT
 *
 * The source spreadsheet records values like `0.7`, `0.8`, and `532.8`. Summing
 * those as JavaScript numbers reintroduces exactly the class of bug the money
 * layer exists to prevent — `0.1 + 0.2 !== 0.3`. An integer count of tenths
 * sums exactly, and one decimal place is the finest granularity the owner has
 * ever recorded.
 *
 * This module is the ONLY place that converts between display text and stored
 * tenths. Nothing else does hours math.
 * ─────────────────────────────────────────────────────────────────────────────
 */

declare const HOURS: unique symbol;

/** An integer count of tenths of an hour. 235 = 23.5 hours. */
export type Hours = number & { readonly [HOURS]: true };

export function hours(tenths: number): Hours {
  if (!Number.isInteger(tenths)) throw new Error(`Hours must be whole tenths, received ${tenths}`);
  return tenths as Hours;
}

/**
 * Parse owner-typed text ("53", "0.7", "23.5") into tenths.
 * Returns null for anything that is not a non-negative number — the caller
 * decides whether that is a validation error or simply an empty field.
 */
export function fromHoursInput(text: string): Hours | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;

  return hours(Math.round(parsed * 10));
}

/** `53h`, `0.7h`, `0h` — the decimal appears only when it carries information. */
export function formatHours(value: Hours): string {
  const whole = Math.trunc(value / 10);
  const remainder = value % 10;
  return remainder === 0 ? `${whole}h` : `${(value / 10).toFixed(1)}h`;
}

/**
 * The inverse of `fromHoursInput`, for a form's `defaultValue` — `"53"`,
 * `"0.7"`, no trailing `h`. The only other place that converts tenths back to
 * owner-facing text is `formatHours`, which is for DISPLAY (always carries the
 * `h` suffix); a form field needs plain numeric text a user can keep editing,
 * so this stays a distinct function rather than stripping the `h` at the call
 * site every time.
 */
export function toHoursInput(value: Hours): string {
  const whole = Math.trunc(value / 10);
  const remainder = value % 10;
  return remainder === 0 ? String(whole) : (value / 10).toFixed(1);
}

export function sumHours(values: readonly Hours[]): Hours {
  return hours(values.reduce<number>((total, value) => total + value, 0));
}
