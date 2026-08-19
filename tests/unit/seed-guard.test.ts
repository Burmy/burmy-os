import { describe, expect, it } from 'vitest';

import { databaseHostname, isLocalDatabaseUrl } from '@/server/db/seed-guard';

/**
 * `db:seed` inserts synthetic data and was once run against a real Supabase
 * database by accident. This is the guard that now prevents it — pinned here
 * because a hole in this specific check is exactly how that mistake repeats.
 */

describe('isLocalDatabaseUrl', () => {
  it.each([
    'postgres://burmy:burmy@localhost:5432/burmy',
    'postgres://burmy:burmy@127.0.0.1:5432/burmy',
    'postgres://burmy:burmy@[::1]:5432/burmy',
  ])('accepts %s', (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(true);
  });

  it.each([
    // A real Supabase-shaped host.
    'postgres://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
    // Supabase's pooler.
    'postgres://postgres.abcdefgh:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
    // Any other real host.
    'postgres://user:pw@10.0.0.5:5432/burmy',
    'postgres://user:pw@db.internal.example.com:5432/burmy',
    // A hostname that merely CONTAINS "localhost" is not localhost.
    'postgres://user:pw@localhost.attacker.example:5432/burmy',
    'postgres://user:pw@notlocalhost:5432/burmy',
  ])('refuses %s', (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(false);
  });

  it('refuses an unparseable connection string rather than throwing', () => {
    expect(isLocalDatabaseUrl('not a url')).toBe(false);
  });
});

describe('databaseHostname', () => {
  it('extracts the host from a real connection string', () => {
    expect(databaseHostname('postgres://user:pw@db.example.supabase.co:5432/postgres')).toBe(
      'db.example.supabase.co',
    );
  });

  it('never throws on unparseable input', () => {
    expect(databaseHostname('not a url')).toBeNull();
  });
});
