import { describe, expect, it } from 'vitest';

import {
  buildReport,
  formatFillList,
  isLocalDatabaseUrl,
  parseArgs,
} from '../../scripts/backfill-game-metadata.mjs';

/**
 * These test the one-off IGDB backfill script's pure helpers — CLI parsing,
 * report formatting, and the local-database guard. The network- and
 * database-touching parts of the script (`main`) are exercised manually (see
 * .superpowers/sdd/2026-08-20-game-tracker/backfill-report.md), not here —
 * same split as games-import-parsers.test.ts against import-game-log.mjs.
 *
 * Every title below is invented for the test, never a real title from the
 * owner's library.
 */

describe('isLocalDatabaseUrl', () => {
  it('accepts localhost, loopback IPv4, and both bracketed and bare loopback IPv6', () => {
    expect(isLocalDatabaseUrl('postgres://user:pass@localhost:5432/db')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://user:pass@127.0.0.1:5432/db')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://user:pass@[::1]:5432/db')).toBe(true);
  });

  it('rejects a remote host', () => {
    expect(isLocalDatabaseUrl('postgres://user:pass@db.supabase.co:5432/db')).toBe(false);
  });

  it('fails closed on an unparsable string rather than treating it as local', () => {
    expect(isLocalDatabaseUrl('not a url')).toBe(false);
  });
});

describe('parseArgs', () => {
  const argv0and1 = ['node', 'scripts/backfill-game-metadata.mjs'];

  it('parses the owner email with no flags, defaulting apply to false', () => {
    expect(parseArgs([...argv0and1, 'owner@example.com'])).toEqual({
      ownerEmail: 'owner@example.com',
      apply: false,
      reportPath: undefined,
    });
  });

  it('recognises --apply in any position', () => {
    expect(parseArgs([...argv0and1, '--apply', 'owner@example.com'])).toMatchObject({
      ownerEmail: 'owner@example.com',
      apply: true,
    });
    expect(parseArgs([...argv0and1, 'owner@example.com', '--apply'])).toMatchObject({
      ownerEmail: 'owner@example.com',
      apply: true,
    });
  });

  it('reads the value following --report as the report path', () => {
    expect(parseArgs([...argv0and1, 'owner@example.com', '--report', '/tmp/out.txt'])).toMatchObject({
      ownerEmail: 'owner@example.com',
      reportPath: '/tmp/out.txt',
    });
  });

  it('leaves ownerEmail undefined when no positional argument is given', () => {
    expect(parseArgs([...argv0and1, '--apply']).ownerEmail).toBeUndefined();
  });
});

describe('formatFillList', () => {
  it('lists every present field in a fixed, readable order', () => {
    expect(
      formatFillList({
        coverUrl: 'https://images.igdb.com/x.jpg',
        genre: 'RPG',
        metacritic: 88,
        averagePlaytimeHours: 40,
        esrbRating: 'T',
      }),
    ).toBe('cover_url, genre, metacritic, average_playtime_hours, esrb_rating');
  });

  it('lists only the fields actually present', () => {
    expect(formatFillList({ genre: 'RPG' })).toBe('genre');
  });

  it('reports nothing-to-fill for an empty object rather than an empty string', () => {
    expect(formatFillList({})).toBe('(nothing new to fill)');
  });
});

const HIGH_MATCH = {
  id: 'game-1',
  title: 'Quest of Legends',
  platform: 'ps5',
  match: {
    suggestion: { title: 'Quest of Legends' },
    score: { confidence: 'high', distance: 0 },
  },
  fill: { genre: 'RPG' },
};

const LOW_MATCH = {
  id: 'game-2',
  title: 'Quest of Legends',
  platform: 'psp',
  match: {
    suggestion: { title: 'Quest of Legends HD Remastered' },
    score: { confidence: 'low', distance: 0.32 },
  },
  fill: { genre: 'RPG' },
};

const NO_MATCH = {
  id: 'game-3',
  title: 'An Obscure Import',
  platform: 'steam',
  match: null,
  fill: {},
};

const FAILED = {
  id: 'game-4',
  title: 'Timed Out Title',
  platform: 'steam',
  match: null,
  fill: {},
  errorMessage: 'IGDB search request failed',
};

describe('buildReport', () => {
  it('puts the low-confidence and no-match section before the high-confidence section', () => {
    const report = buildReport({
      results: [HIGH_MATCH, LOW_MATCH, NO_MATCH],
      apply: false,
      appliedCount: 0,
      highCount: 1,
      lowCount: 1,
      noMatchCount: 1,
    });

    const decisionIndex = report.indexOf('NEEDS YOUR DECISION');
    const highIndex = report.indexOf('HIGH CONFIDENCE');
    expect(decisionIndex).toBeGreaterThanOrEqual(0);
    expect(highIndex).toBeGreaterThan(decisionIndex);
  });

  it('includes the summary counts', () => {
    const report = buildReport({
      results: [HIGH_MATCH, LOW_MATCH, NO_MATCH],
      apply: false,
      appliedCount: 0,
      highCount: 1,
      lowCount: 1,
      noMatchCount: 1,
    });
    expect(report).toContain('Total games processed:    3');
    expect(report).toContain('High confidence matches:  1');
    expect(report).toContain('Low confidence matches:   1');
    expect(report).toContain('No match found:           1');
  });

  it('reports DRY RUN and omits the applied count when apply is false', () => {
    const report = buildReport({
      results: [HIGH_MATCH],
      apply: false,
      appliedCount: 0,
      highCount: 1,
      lowCount: 0,
      noMatchCount: 0,
    });
    expect(report).toContain('DRY RUN');
    expect(report).not.toContain('Applied to the database');
  });

  it('reports the applied count when apply is true', () => {
    const report = buildReport({
      results: [HIGH_MATCH],
      apply: true,
      appliedCount: 1,
      highCount: 1,
      lowCount: 0,
      noMatchCount: 0,
    });
    expect(report).toContain('Applied to the database:  1');
  });

  it('distinguishes a request failure from a plain no-match in its own section', () => {
    const report = buildReport({
      results: [FAILED],
      apply: false,
      appliedCount: 0,
      highCount: 0,
      lowCount: 0,
      noMatchCount: 1,
    });
    expect(report).toContain('IGDB request failed: IGDB search request failed');
  });

  it('marks an empty section as "(none)" rather than leaving it blank', () => {
    const report = buildReport({
      results: [HIGH_MATCH],
      apply: false,
      appliedCount: 0,
      highCount: 1,
      lowCount: 0,
      noMatchCount: 0,
    });
    const decisionSection = report.slice(report.indexOf('NEEDS YOUR DECISION'), report.indexOf('HIGH CONFIDENCE'));
    expect(decisionSection).toContain('(none)');
  });
});
