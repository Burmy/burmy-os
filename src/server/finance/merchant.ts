/**
 * Merchant normalization — table-driven and pure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO OUTPUTS, AND NEITHER IS AN IDENTITY KEY.
 *
 *   normalizedMerchant — readable, for display
 *   merchantKey        — aggressive, for equality matching
 *
 * Both are EXPECTED TO EVOLVE. Every new strip rule improves categorization, and
 * that is the point of them. `dedupe_key` is deliberately NOT derived from either
 * (see dedupe.ts): if identity depended on a rule set that changes, adding one
 * rule would silently stop matching years of committed history and quietly
 * reintroduce duplicates.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GOVERNING BIAS: UNDER-STRIP RATHER THAN OVER-STRIP.
 *
 * A rule that strips too little costs the owner one extra review card — they
 * confirm the same merchant twice and merchant memory learns both keys. A rule
 * that strips too much MERGES TWO DIFFERENT MERCHANTS, which moves money between
 * two visible grid rows and looks like a categorization mistake nobody made.
 *
 * That asymmetry decides every ambiguous case below, and it is why the location
 * rules are conservative: a truncated payee like `HARVEST NAAN - EAS Eastvale TX`
 * genuinely cannot be split into merchant and city with confidence, so the rule
 * removes only what it is sure about. The same merchant at the same location
 * always yields the same key, which is the property the learning loop actually
 * needs.
 *
 * Every rule came from a shape observed in a real Bank of America export during
 * M4, and every one has a test case.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * US state and territory codes.
 *
 * A closed set is required because BoA sometimes FUSES the state onto the city
 * with no separator — `BAY HARBOURCA`, `Sunset ValleyTX` — so the only way to find
 * the boundary is to recognize the trailing two characters as a state.
 */
const STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
  'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA',
  'RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP',
]);

/**
 * Payment-processor and platform prefixes, observed in the wild.
 *
 * Longer, more specific prefixes are listed first so `PADDLE.NET*` is tried before
 * anything shorter could match a fragment of it.
 */
const PROCESSOR_PREFIXES = [
  'PADDLE.NET*',
  'ROAMER.COM*',
  'ORACLEAI *',
  'OPENAI *',
  'NPO*',
  'TST*',
  'SQ *',
  'YSI*',
  'SP ',
  'IN *',
  'PY *',
] as const;

/**
 * A BoA deposit export writes ACH detail as
 * `ORIGINATOR DES:PURPOSE ID:… INDN:… CO ID:… PPD`.
 *
 * The merchant is the part before `DES:`. Everything after is routing detail — and
 * it includes `INDN:`, the ACCOUNT HOLDER'S OWN NAME, which must never become a
 * merchant key.
 */
const ACH_MARKER = /\s+DES:/;

/**
 * Bare trailing store numbers are stripped only at FIVE digits or more.
 *
 * Observed bare (unhashed) store numbers were 5 and 9 digits. Three- and
 * four-digit trailing numbers are more often part of the name — `VIA 313` is a
 * restaurant, and stripping it would merge it with every other `VIA`. Hash-marked
 * numbers (`#0366`, `# 2065`, `#801`) are unambiguous and stripped at any length.
 */
const BARE_STORE_NUMBER_MIN_DIGITS = 5;

/** A location hint taken from a separate column, when the format provides one. */
export interface LocationHint {
  readonly city: string;
  readonly state: string;
}

export interface MerchantNames {
  readonly normalizedMerchant: string;
  readonly merchantKey: string;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripProcessorPrefix(value: string): string {
  const upper = value.toUpperCase();
  for (const prefix of PROCESSOR_PREFIXES) {
    if (upper.startsWith(prefix)) return value.slice(prefix.length).trim();
  }
  return value;
}

/**
 * Remove the location using an EXACT hint from another column.
 *
 * BoA card exports carry `Address` as `city` padded to 14 columns plus the state,
 * which makes the suffix knowable rather than guessable. Handles both the spaced
 * and fused forms, since the payee column varies while the address column does not.
 *
 * The Address column itself is never persisted (plan §18 keeps address fragments
 * out of staging); it is read transiently to improve this one derivation. The
 * import pipeline in M5 supplies it from `ParseResult.rows`, which still carries
 * the source fields alongside the candidates.
 */
function stripLocationWithHint(value: string, hint: LocationHint): string {
  const city = hint.city.trim();
  const state = hint.state.trim();
  if (city === '' || state === '') return value;

  for (const suffix of [`${city} ${state}`, `${city}${state}`]) {
    const index = value.toUpperCase().lastIndexOf(suffix.toUpperCase());
    if (index > 0 && index + suffix.length === value.length) {
      return value.slice(0, index).trim();
    }
  }

  return value;
}

/**
 * Remove a trailing location WITHOUT a hint: the state code, plus at most ONE
 * preceding token as the city.
 *
 * Exactly one token, deliberately. Two would be right for `BAY HARBOUR` and wrong
 * for `MERIDIAN COFFEE CO Eastvale` — where `CO` is the company suffix, not
 * Colorado — and getting that wrong merges distinct merchants. One token is always
 * safe: it may leave a city fragment attached, but the same merchant at the same
 * location still produces the same key every month, which is what the learning
 * loop needs.
 *
 * Never strips the last remaining token, so a payee cannot be erased entirely.
 */
function stripTrailingLocation(value: string): string {
  const tokens = collapse(value).split(' ');
  if (tokens.length < 2) return value.trim();

  const last = tokens[tokens.length - 1] ?? '';

  // Spaced form: the final token is exactly a state code.
  if (STATE_CODES.has(last.toUpperCase())) {
    const withoutState = tokens.slice(0, -1);
    return (withoutState.length > 1 ? withoutState.slice(0, -1) : withoutState).join(' ').trim();
  }

  // Fused form: the final token ENDS with a state code and has a city glued to it.
  const fusedState = last.slice(-2).toUpperCase();
  const fusedCity = last.slice(0, -2);
  if (fusedCity.length >= 2 && STATE_CODES.has(fusedState) && /^[A-Za-z]+$/.test(fusedCity)) {
    // The fused token is itself the tail of the city, so drop it and nothing more.
    return tokens.slice(0, -1).join(' ').trim();
  }

  return value.trim();
}

function stripStoreNumber(value: string): string {
  let result = value;

  // Hash-marked, with or without a space. Unambiguous at any length.
  result = result.replace(/\s*#\s*\d+\b/g, '');

  // Bare trailing number, only when long enough to be a store id rather than part
  // of the name.
  result = result.replace(new RegExp(`\\s+\\d{${BARE_STORE_NUMBER_MIN_DIGITS},}\\s*$`), '');

  // Bare LEADING number, as in "078 TORCHYS ALLIANCE". Requires a following space,
  // so a hyphenated brand like "7-ELEVEN" is untouched.
  result = result.replace(/^\d{2,}\s+/, '');

  return result.trim();
}

/** Confirmation, reference and phone numbers that ride along in ACH detail. */
function stripReferenceNoise(value: string): string {
  return value
    .replace(/\b(?:CONF#|Confirmation#)\s*[A-Za-z0-9]+/gi, '')
    .replace(/\b\d{10,}\b/g, '')
    .trim();
}

/**
 * Derive display and matching names from a raw statement description.
 *
 * PURE: same input, same output, no clock and no I/O — so every rule is a
 * millisecond test case.
 *
 * @param hint Optional exact location, when the source format supplies one in a
 *             separate column. With it, the location suffix is removed precisely;
 *             without it, the conservative rule above applies.
 */
export function normalizeMerchant(
  rawDescription: string,
  hint?: LocationHint | undefined,
): MerchantNames {
  let working = collapse(rawDescription);

  // ACH detail: keep only the originator.
  const achMatch = ACH_MARKER.exec(working);
  if (achMatch) working = working.slice(0, achMatch.index).trim();

  working = stripReferenceNoise(working);
  working = stripProcessorPrefix(working);
  working = hint ? stripLocationWithHint(working, hint) : stripTrailingLocation(working);
  working = stripStoreNumber(working);
  working = collapse(working);

  // A description consisting entirely of metadata can normalize to nothing.
  // Falling back to the collapsed original beats an empty merchant, which would
  // group every such row under one blank key.
  if (working === '') working = collapse(rawDescription);

  const normalizedMerchant = working.toUpperCase();

  return { normalizedMerchant, merchantKey: merchantKeyFrom(normalizedMerchant) };
}

/**
 * The matching key from an ALREADY-normalized merchant name — extracted so M7
 * can rederive it from `finance_transactions.normalized_merchant` (which is
 * persisted; `merchant_key` itself is not) when the owner opts to remember a
 * category correction. Same rule `normalizeMerchant` uses internally: strip
 * everything but letters and digits.
 */
export function merchantKeyFrom(normalizedMerchant: string): string {
  return normalizedMerchant.replace(/[^A-Z0-9]/g, '');
}
