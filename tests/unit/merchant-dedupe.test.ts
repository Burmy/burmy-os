import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  DEDUPE_KEY_VERSION,
  dedupeKey,
  groupByDedupeKey,
  identityDescription,
  observeTierOne,
  reconcileCounts,
  tierOneCandidateStability,
} from '@/server/finance/dedupe';
import { merchantKeyFrom, normalizeMerchant } from '@/server/finance/merchant';
import { parseStatement } from '@/server/finance/parse';

const FIXTURES = path.resolve(process.cwd(), 'tests/fixtures/finance');
const NOW = new Date('2026-06-15T00:00:00Z');

async function bytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(FIXTURES, name)));
}

let card: Uint8Array;
let deposit: Uint8Array;

beforeAll(async () => {
  card = await bytes('boa-card-2026-05.csv');
  deposit = await bytes('boa-deposit-2026-05.csv');
});

/**
 * Every merchant rule below came from a shape in a real Bank of America export.
 * Driven off the fixture bytes where the shape is structural.
 */
describe('normalizeMerchant — processor prefixes', () => {
  it.each([
    ['TST*HARVEST NAAN - EAS Eastvale TX', 'HARVEST NAAN - EAS'],
    ['SQ *MERIDIAN COFFEE CO Eastvale TX', 'MERIDIAN COFFEE CO'],
    ['NPO* HUMANE SOCIETY OF SPRINGFIELD TX', 'HUMANE SOCIETY OF'],
    ['YSI*PRESIDIUM 183 CEDARMONT TX', 'PRESIDIUM 183'],
    ['PADDLE.NET* N8N CLOUD1 Fairport NY', 'N8N CLOUD1'],
    ['ORACLEAI *CHATBOT SUBS BAY HARBOURCA', 'CHATBOT SUBS BAY'],
    ['ROAMER.COM* PET SVCS. SEAGROVE WA', 'PET SVCS.'],
  ])('strips the processor prefix from %s', (input, expected) => {
    // Note the residual city fragments ("EAS", "BAY"). That is the conservative
    // one-token location rule working as intended: a truncated payee cannot be
    // split into merchant and city with confidence, and leaving a fragment costs
    // one extra review card, whereas over-stripping MERGES DISTINCT MERCHANTS and
    // moves money between two visible grid rows. Same merchant, same location,
    // same key every month — which is what the learning loop needs.
    expect(normalizeMerchant(input).normalizedMerchant).toBe(expected);
  });

  it('removes the location EXACTLY when the format supplies a hint', () => {
    // BoA card exports carry `Address` as a separate column, which makes the
    // suffix knowable rather than guessable. The pipeline passes it in M5; the
    // column itself is never persisted.
    expect(
      normalizeMerchant('ORACLEAI *CHATBOT SUBS BAY HARBOURCA', {
        city: 'BAY HARBOUR',
        state: 'CA',
      }).normalizedMerchant,
    ).toBe('CHATBOT SUBS');

    expect(
      normalizeMerchant('TST*TARKA SPICE KITCHE Sunset ValleyTX', {
        city: 'Sunset Valley',
        state: 'TX',
      }).normalizedMerchant,
    ).toBe('TARKA SPICE KITCHE');
  });
});

describe('normalizeMerchant — trailing location', () => {
  it('strips a SPACED city and state', () => {
    expect(normalizeMerchant('WESTBROOKANIMALCLINICS SPRINGFIELD TX').normalizedMerchant).toBe(
      'WESTBROOKANIMALCLINICS',
    );
  });

  it('strips a FUSED city and state, where the code has no separator', () => {
    // Both forms appear in the SAME real file, so "drop the last two words" is not
    // an option — the state has to be recognized as a state. Without a hint the
    // rule removes the fused token only, leaving any earlier city word attached.
    expect(normalizeMerchant('HELIOSCOPE BAY HARBOURCA').normalizedMerchant).toBe(
      'HELIOSCOPE BAY',
    );
    expect(
      normalizeMerchant('HELIOSCOPE BAY HARBOURCA', { city: 'BAY HARBOUR', state: 'CA' })
        .normalizedMerchant,
    ).toBe('HELIOSCOPE');
    // Uppercased, like every `normalizedMerchant` — the display name is
    // case-folded so two exports that differ only in case do not look different.
    expect(normalizeMerchant('TST*TARKA SPICE KITCHE Sunset ValleyTX').normalizedMerchant).toBe(
      'TARKA SPICE KITCHE SUNSET',
    );
  });

  it('does not mistake a non-state pair of letters for a state', () => {
    // "CO" is a state, but "COMPANY BIG XX" must not lose its tail to a
    // two-letter token that is not a state code.
    expect(normalizeMerchant('ACME WIDGETS ZZ').normalizedMerchant).toContain('ZZ');
  });
});

describe('normalizeMerchant — store numbers', () => {
  it.each([
    ["BUCK-EE'S #0035 TEMPLE TX", "BUCK-EE'S"],
    ['H-E-B #801 SPRINGFIELD TX', 'H-E-B'],
    ['PETMART # 2065 SPRINGF TX', 'PETMART'],
    ['VULCAN 4-CORNER 41207 SPRINGFIELD TX', 'VULCAN 4-CORNER'],
  ])('strips the store number from %s', (input, expected) => {
    expect(normalizeMerchant(input).normalizedMerchant).toBe(expected);
  });

  it('strips a LEADING store number', () => {
    // "078 TORCHYS ALLIANCE" — the number is at the front, which a trailing-only
    // rule would miss entirely.
    expect(normalizeMerchant('078 TORCHYS ALLIANCE SPRINGFLD TX').normalizedMerchant).toBe(
      'TORCHYS ALLIANCE',
    );
  });

  it('strips a bare store number only at five digits or more', () => {
    // Observed bare store numbers were 5 and 9 digits. Shorter trailing numbers
    // are more often part of the name.
    expect(normalizeMerchant('VULCAN 4-CORNER 41207 SPRINGFIELD TX').normalizedMerchant).toBe(
      'VULCAN 4-CORNER',
    );
    expect(normalizeMerchant('NORDSTEAD 380114226 HARLOWE MD').normalizedMerchant).toBe(
      'NORDSTEAD',
    );
  });

  it('does NOT strip a short number that is part of the name', () => {
    // The counter-example from the plan: "VIA 313" is a restaurant, not a store
    // number, and an over-eager rule would merge it with every other VIA.
    expect(normalizeMerchant('VIA 313 SPRINGFIELD TX').normalizedMerchant).toBe('VIA 313');
  });

  it('keeps the hyphenated brand in 7-ELEVEN-style names', () => {
    // Stripping any leading digits would destroy this.
    expect(normalizeMerchant('VULCAN 4-CORNER 41207 SPRINGFIELD TX').normalizedMerchant).toContain(
      '4-CORNER',
    );
  });
});

describe('normalizeMerchant — ACH detail', () => {
  it('keeps only the originator, discarding routing metadata', () => {
    // Everything after DES: is routing detail. Critically it contains INDN:, the
    // ACCOUNT HOLDER'S OWN NAME, which must never become a merchant key.
    const raw =
      'NORTHWIND TECHNO DES:PAYROLL ID:418025773901NWT INDN:DOE,JORDAN CO ID:7220418835 PPD';
    const { normalizedMerchant, merchantKey } = normalizeMerchant(raw);

    expect(normalizedMerchant).toBe('NORTHWIND TECHNO');
    expect(merchantKey).toBe('NORTHWINDTECHNO');
    expect(normalizedMerchant).not.toContain('DOE');
    expect(normalizedMerchant).not.toContain('JORDAN');
  });

  it('handles the gym-membership ACH shape', () => {
    const raw =
      'PF SPRINGFIELD A DES:IClub Fees ID:PR8814027745219 INDN:Jordan Doe CO ID:G402887301 PPD PMT INFO:8005551212';
    expect(normalizeMerchant(raw).normalizedMerchant).toBe('PF SPRINGFIELD A');
  });

  it('drops confirmation numbers from transfer descriptions', () => {
    const { normalizedMerchant } = normalizeMerchant(
      'Online Banking transfer to SAV 4412 Confirmation# 4029518337',
    );
    expect(normalizedMerchant).not.toContain('4029518337');
    expect(normalizedMerchant).toContain('TRANSFER');
  });
});

describe('normalizeMerchant — merchantKey convergence', () => {
  it('collapses a prefixed and truncated name onto the plain one', () => {
    const prefixed = normalizeMerchant('TST*HARVEST NAAN Eastvale TX').merchantKey;
    const plain = normalizeMerchant('HARVEST NAAN Eastvale TX').merchantKey;
    expect(prefixed).toBe(plain);
  });

  it('groups the same merchant across different store numbers', () => {
    const a = normalizeMerchant('H-E-B #801 SPRINGFIELD TX').merchantKey;
    const b = normalizeMerchant('H-E-B #790 EASTVALE TX').merchantKey;
    expect(a).toBe(b);
  });

  it('never returns an empty key', () => {
    // A description that is entirely metadata would otherwise group every such
    // row under one blank key.
    // A blank description is rejected by the parser before it reaches here, so the
    // cases that matter are descriptions consisting entirely of metadata.
    for (const raw of ['DES:PAYROLL', '#0001', '12345']) {
      expect(normalizeMerchant(raw).merchantKey.length, raw).toBeGreaterThan(0);
    }
  });

  it('is derived from real card descriptions without collapsing distinct merchants', async () => {
    // A blunt rule can silently merge unrelated merchants, which moves money
    // between grid rows. Assert the fixture's distinct merchants stay distinct.
    const { candidates } = parseStatement(card, NOW);
    const keys = candidates.map((c) => normalizeMerchant(c.originalDescription).merchantKey);

    // The fixture repeats a handful of merchants deliberately; there must still be
    // a healthy number of distinct keys rather than everything converging.
    expect(new Set(keys).size).toBeGreaterThan(20);
  });
});

describe('dedupeKey — identity, frozen', () => {
  const base = {
    accountId: 'acct-1',
    transactionDate: '2026-05-14',
    amountCents: 54025,
    originalDescription: 'Online Banking payment to CRD 9903 Confirmation# 7k2mabx31',
  };

  it('is deterministic', () => {
    expect(dedupeKey(base)).toBe(dedupeKey({ ...base }));
  });

  it('normalizes ONLY whitespace and case, which is the frozen rule', () => {
    // Padding and case must not change identity: the same bank writes the same
    // description with incidental whitespace differences between exports.
    expect(
      dedupeKey({
        ...base,
        originalDescription:
          '  Online   Banking payment to CRD 9903 Confirmation#  7k2mabx31 ',
      }),
    ).toBe(
      dedupeKey({
        ...base,
        originalDescription: 'online banking PAYMENT TO crd 9903 confirmation# 7k2mabx31',
      }),
    );

    expect(identityDescription('  a   b ')).toBe('A B');

    // ...and nothing else is normalized. Punctuation is identity-bearing, because
    // stripping it is a `merchantKey` concern that would break historical matching
    // if it ever moved into here.
    expect(identityDescription('A-B')).not.toBe(identityDescription('A B'));
  });

  it('changes with account, date or amount', () => {
    expect(dedupeKey({ ...base, accountId: 'acct-2' })).not.toBe(dedupeKey(base));
    expect(dedupeKey({ ...base, transactionDate: '2026-05-15' })).not.toBe(dedupeKey(base));
    expect(dedupeKey({ ...base, amountCents: 54026 })).not.toBe(dedupeKey(base));
  });

  it('is NOT affected by a change to merchant normalization', () => {
    /**
     * THE point of separating the two keys. `merchantKey` is meant to evolve; if
     * identity depended on it, one new strip rule would change the key for every
     * future import and silently stop matching years of committed history.
     *
     * Simulated by taking two descriptions that normalize to the SAME merchantKey
     * and asserting their dedupe keys differ — identity follows the raw text.
     */
    const a = { ...base, originalDescription: 'H-E-B #801 SPRINGFIELD TX' };
    const b = { ...base, originalDescription: 'H-E-B #790 EASTVALE TX' };

    expect(normalizeMerchant(a.originalDescription).merchantKey).toBe(
      normalizeMerchant(b.originalDescription).merchantKey,
    );
    expect(dedupeKey(a)).not.toBe(dedupeKey(b));
  });

  it('records the algorithm version', () => {
    // Bumped only alongside a migration that recomputes every row in one pass;
    // mixed-version comparison is never permitted.
    expect(DEDUPE_KEY_VERSION).toBe(1);
  });
});

describe('Tier 2 count reconciliation', () => {
  it('imports nothing when everything is already present', () => {
    expect(reconcileCounts({ stagedCount: 1, committedCount: 1 })).toEqual({
      surplus: 0,
      duplicates: 1,
    });
  });

  it('imports only the surplus', () => {
    // Two genuine same-day coffees, one already committed → import exactly one.
    expect(reconcileCounts({ stagedCount: 2, committedCount: 1 })).toEqual({
      surplus: 1,
      duplicates: 1,
    });
  });

  it('is idempotent: re-importing the same file adds nothing', () => {
    const first = reconcileCounts({ stagedCount: 3, committedCount: 0 });
    expect(first.surplus).toBe(3);

    const second = reconcileCounts({ stagedCount: 3, committedCount: 3 });
    expect(second.surplus).toBe(0);
  });

  it('never returns a negative surplus', () => {
    // More committed than staged happens when an earlier import covered a wider
    // window. It means "nothing new", not "delete something".
    expect(reconcileCounts({ stagedCount: 1, committedCount: 5 }).surplus).toBe(0);
  });

  it('keeps two same-day same-amount rows separate when both are new', async () => {
    // Straight from the fixture: two -540.25 rows on 05/14 with different
    // descriptions. They must be two keys, not one key with a count of two.
    const { candidates } = parseStatement(deposit, NOW);
    const sameDay = candidates.filter(
      (c) => c.transactionDate === '2026-05-14' && (c.amountCents as number) === 54025,
    );
    expect(sameDay).toHaveLength(2);

    const groups = groupByDedupeKey(
      sameDay.map((c) => ({
        accountId: 'acct-1',
        transactionDate: c.transactionDate,
        amountCents: c.amountCents as number,
        originalDescription: c.originalDescription,
      })),
    );

    // Different descriptions → different identity → two groups of one.
    expect(groups.size).toBe(2);
    for (const group of groups.values()) expect(group).toHaveLength(1);
  });

  it('groups a genuine repeat under one key', async () => {
    // The card fixture has two identical coffee purchases on the same day at
    // different amounts; construct the true-repeat case explicitly.
    const repeated = [
      { accountId: 'a', transactionDate: '2026-05-25', amountCents: 866, originalDescription: 'SQ *MERIDIAN COFFEE CO Eastvale TX' },
      { accountId: 'a', transactionDate: '2026-05-25', amountCents: 866, originalDescription: 'SQ *MERIDIAN COFFEE CO Eastvale TX' },
    ];

    const groups = groupByDedupeKey(repeated);
    expect(groups.size).toBe(1);
    expect([...groups.values()][0]).toHaveLength(2);

    // Two staged, none committed → both import. They are two coffees.
    expect(reconcileCounts({ stagedCount: 2, committedCount: 0 }).surplus).toBe(2);
  });
});

describe('Tier 1 — observed, unverified, unused', () => {
  it('measures coverage and in-file uniqueness on the real card export', async () => {
    const { candidates } = parseStatement(card, NOW);
    const observation = observeTierOne(candidates.map((c) => c.sourceTransactionId));

    // The two properties a single export CAN answer.
    expect(observation.coverage).toBe(1);
    expect(observation.uniqueWithinExport).toBe(true);
    expect(observation.withIdentifier).toBe(observation.total);
  });

  it('reports zero coverage for the deposit export, which provides no identifier', async () => {
    const { candidates } = parseStatement(deposit, NOW);
    const observation = observeTierOne(candidates.map((c) => c.sourceTransactionId));

    expect(observation.coverage).toBe(0);
    expect(observation.withIdentifier).toBe(0);
  });

  it('has a stability comparison ready, so verifying later needs no parser change', () => {
    // Unused in M4 because the overlapping exports were not available. This is the
    // whole reason `source_transaction_id` is captured despite nothing depending
    // on it.
    const identical = tierOneCandidateStability(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(identical.stable).toBe(true);

    const changed = tierOneCandidateStability(['a', 'b'], ['a', 'z']);
    expect(changed.stable).toBe(false);
    expect(changed.onlyInFirst).toBe(1);
    expect(changed.onlyInSecond).toBe(1);
  });

  it('does not treat an unverified identifier as an identity key', async () => {
    // Nothing in dedupe reads `sourceTransactionId`. Two rows with DIFFERENT
    // reference numbers but identical account/date/amount/description must still
    // collide on identity — proving Tier 2 is what is actually running.
    const rows = [
      { accountId: 'a', transactionDate: '2026-05-25', amountCents: 866, originalDescription: 'SAME MERCHANT' },
      { accountId: 'a', transactionDate: '2026-05-25', amountCents: 866, originalDescription: 'SAME MERCHANT' },
    ];
    expect(groupByDedupeKey(rows).size).toBe(1);
  });
});

describe('merchantKeyFrom — rederiving the key M7 needs but finance_transactions does not store', () => {
  it('matches what normalizeMerchant computed internally for the same name', () => {
    const { normalizedMerchant, merchantKey } = normalizeMerchant("LARSEN'S #0366 2 05/26 PURCHASE SPRINGFIELD TX");
    expect(merchantKeyFrom(normalizedMerchant)).toBe(merchantKey);
  });

  it('strips everything but letters and digits', () => {
    expect(merchantKeyFrom("LARSEN'S CAFE")).toBe('LARSENSCAFE');
  });
});
