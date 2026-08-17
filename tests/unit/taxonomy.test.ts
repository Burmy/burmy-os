import { describe, expect, it } from 'vitest';

import {
  InvalidLastFourError,
  InvalidNameError,
  MAX_NAME_LENGTH,
  assertValidName,
  denseOrder,
  moveInOrder,
  normalizeName,
  parseLastFour,
  slugifyName,
} from '@/server/finance/taxonomy';

/**
 * The pure rules behind accounts and categories.
 *
 * Runs in the `node` project — no jsdom, no database — because that is the point
 * of keeping this logic in `src/server/finance/`.
 */

describe('normalizeName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeName('  Planet   Fitness  ')).toBe('Planet Fitness');
    expect(normalizeName('Food\t\tand  Drink')).toBe('Food and Drink');
  });

  it('PRESERVES capitalisation', () => {
    // These are display labels — the row axis of the grid. Lowercasing
    // "Planet Fitness" would be a visible regression, and uniqueness is enforced
    // case-insensitively by the database anyway.
    expect(normalizeName('Planet Fitness')).toBe('Planet Fitness');
    expect(normalizeName('H-E-B')).toBe('H-E-B');
  });

  it('handles non-breaking and narrow spaces', () => {
    // U+00A0 and U+202F both arrive via copy-paste from a browser or a PDF.
    //
    // NAMED CONSTANTS, not literal characters. M1 shipped two regexes holding a
    // literal U+00A0 instead of a space, and its tests passed only because a
    // later `.trim()` happened to mask it. An invisible character in a test is a
    // test nobody can review: a reviewer cannot tell a real assertion from a
    // vacuous one. Naming them makes the intent checkable by eye.
    const NBSP = '\u00a0';
    const NARROW_NBSP = '\u202f';

    expect(normalizeName(`Velvet${NBSP}Taco`)).toBe('Velvet Taco');
    expect(normalizeName(`Via${NARROW_NBSP}313`)).toBe('Via 313');
    expect(normalizeName(`${NBSP}${NARROW_NBSP}Travel${NBSP}`)).toBe('Travel');

    // ...and the slug path must not carry them through either.
    expect(slugifyName(`Velvet${NBSP}Taco`)).toBe('velvet-taco');
  });
});

describe('assertValidName', () => {
  it('returns the normalized name', () => {
    expect(assertValidName('  Groceries ')).toBe('Groceries');
  });

  it('rejects empty and whitespace-only input', () => {
    expect(() => assertValidName('')).toThrow(InvalidNameError);
    expect(() => assertValidName('   ')).toThrow(InvalidNameError);
    expect(() => assertValidName('\t\n')).toThrow(InvalidNameError);
  });

  it('accepts a name exactly at the limit and rejects one past it', () => {
    expect(assertValidName('x'.repeat(MAX_NAME_LENGTH))).toHaveLength(MAX_NAME_LENGTH);
    expect(() => assertValidName('x'.repeat(MAX_NAME_LENGTH + 1))).toThrow(InvalidNameError);
  });

  it('measures length AFTER normalizing', () => {
    // Padding must not count against the limit.
    const padded = `   ${'x'.repeat(MAX_NAME_LENGTH)}   `;
    expect(assertValidName(padded)).toHaveLength(MAX_NAME_LENGTH);
  });
});

describe('slugifyName', () => {
  it('produces a URL-safe key', () => {
    expect(slugifyName('Planet Fitness')).toBe('planet-fitness');
    expect(slugifyName('Food & Drink')).toBe('food-drink');
    expect(slugifyName('  Car   Payment ')).toBe('car-payment');
  });

  it('strips leading and trailing separators', () => {
    expect(slugifyName('!!!Travel!!!')).toBe('travel');
    expect(slugifyName('-Gas-')).toBe('gas');
  });

  it('never returns an empty string', () => {
    // `slug` is NOT NULL. A name of pure punctuation must still produce something
    // writable rather than failing at the database.
    expect(slugifyName('!!!')).toBe('category');
    expect(slugifyName('---')).toBe('category');
    expect(slugifyName('   ')).toBe('category');
  });

  it('can collide, and that is fine', () => {
    // The slug is a convenience key, NOT an identity key. Uniqueness lives on
    // `lower(name)` in the database. Deriving identity from a slug is the mistake
    // docs/FINANCE.md warns about for dedupe_key.
    expect(slugifyName('Food & Drink')).toBe(slugifyName('Food Drink'));
  });
});

describe('parseLastFour', () => {
  it('accepts exactly four digits', () => {
    expect(parseLastFour('1234')).toBe('1234');
    expect(parseLastFour(' 0007 ')).toBe('0007');
  });

  it('treats blank as absent', () => {
    expect(parseLastFour('')).toBeNull();
    expect(parseLastFour('   ')).toBeNull();
    expect(parseLastFour(null)).toBeNull();
    expect(parseLastFour(undefined)).toBeNull();
  });

  it('REJECTS a full account number rather than truncating it', () => {
    // The single most important assertion in this file. Silently keeping the last
    // four of a pasted 16-digit card number would mean the full number was
    // accepted by the application — present in the request body, and in any error
    // report that captured it — with nothing telling anyone.
    expect(() => parseLastFour('4111111111111111')).toThrow(InvalidLastFourError);
    expect(() => parseLastFour('1234 5678 9012 3456')).toThrow(InvalidLastFourError);
  });

  it('rejects anything that is not four digits', () => {
    for (const value of ['1', '12', '123', '12345', 'abcd', '12a4', '12.4', '-123', '١٢٣٤']) {
      expect(() => parseLastFour(value), value).toThrow(InvalidLastFourError);
    }
  });
});

describe('moveInOrder', () => {
  const items = ['a', 'b', 'c', 'd'] as const;

  it('swaps with the previous item', () => {
    expect(moveInOrder(items, 2, -1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('swaps with the next item', () => {
    expect(moveInOrder(items, 1, 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('is a NO-OP at the ends rather than an error', () => {
    // The buttons are disabled at the ends, but a double-click racing the disable
    // must not throw or wrap around.
    expect(moveInOrder(items, 0, -1)).toEqual([...items]);
    expect(moveInOrder(items, 3, 1)).toEqual([...items]);
  });

  it('is a no-op for an out-of-range index', () => {
    expect(moveInOrder(items, -1, 1)).toEqual([...items]);
    expect(moveInOrder(items, 99, -1)).toEqual([...items]);
  });

  it('does not mutate the input', () => {
    const original = [...items];
    moveInOrder(original, 1, 1);
    expect(original).toEqual([...items]);
  });

  it('handles an empty list and a single item', () => {
    expect(moveInOrder([], 0, 1)).toEqual([]);
    expect(moveInOrder(['only'], 0, -1)).toEqual(['only']);
    expect(moveInOrder(['only'], 0, 1)).toEqual(['only']);
  });

  it('round-trips: up then down returns the original order', () => {
    const moved = moveInOrder(items, 2, -1);
    expect(moveInOrder(moved, 1, 1)).toEqual([...items]);
  });
});

describe('denseOrder', () => {
  it('numbers from zero with no gaps', () => {
    expect(denseOrder(['x', 'y', 'z'])).toEqual([
      { id: 'x', sortOrder: 0 },
      { id: 'y', sortOrder: 1 },
      { id: 'z', sortOrder: 2 },
    ]);
  });

  it('produces no duplicate orders', () => {
    // Duplicate sort orders make the grid's row sequence depend on whatever
    // secondary ordering Postgres picks — which is how a row appears to move on
    // its own between page loads.
    const orders = denseOrder(Array.from({ length: 50 }, (_, i) => `id-${i}`)).map(
      (row) => row.sortOrder,
    );
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('handles an empty list', () => {
    expect(denseOrder([])).toEqual([]);
  });
});
