import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * THE ANTI-SILENT-COVERAGE-GAP TEST.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Next.js handles Server Functions as POSTs to the route where they are USED.
 * So editing the proxy `matcher`, or moving an action to another component, can
 * remove proxy coverage from a mutation with no error, no type failure and no
 * failing test. That is the hazard docs/SECURITY.md is built around.
 *
 * A hand-maintained list of "routes that should be guarded" cannot catch it —
 * whoever forgets the guard forgets the list entry too. So this test ENUMERATES
 * THE FILESYSTEM and requires every discovered server entry point to be either
 * on a two-item allowlist or demonstrably guarded.
 *
 * It is intentionally the annoying kind of test: adding a route handler without
 * `requireOwner()` fails the suite, and the only way to make it pass is to add
 * the guard or to argue for the allowlist in a diff someone will read.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const APP_DIR = path.resolve(process.cwd(), 'src/app');

/**
 * The complete unprotected surface. Exactly two entries.
 *
 * Growing this list is a security decision, and it should require editing this
 * constant in a reviewed diff — never happen as a side effect.
 */
const UNPROTECTED_ALLOWLIST = ['/api/health', '/api/auth/[...all]'] as const;

interface EntryPoint {
  /** Route path, e.g. `/api/health`. */
  readonly route: string;
  readonly file: string;
  readonly source: string;
  readonly exportedVerbs: string[];
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    }),
  );
  return files.flat();
}

const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** `src/app/api/health/route.ts` → `/api/health` */
function toRoute(file: string): string {
  const relative = path.relative(APP_DIR, file).split(path.sep);
  relative.pop(); // drop the filename
  const segments = relative
    // Route groups like `(private)` do not appear in the URL.
    .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
  return `/${segments.join('/')}`;
}

let routeHandlers: EntryPoint[] = [];
let serverActionFiles: EntryPoint[] = [];

beforeAll(async () => {
  await harness();
  await resetDatabase();

  const files = await walk(APP_DIR);

  const handlers: EntryPoint[] = [];
  const actions: EntryPoint[] = [];

  for (const file of files) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = await readFile(file, 'utf8');
    const base = path.basename(file);

    if (base === 'route.ts' || base === 'route.tsx') {
      handlers.push({
        route: toRoute(file),
        file,
        source,
        exportedVerbs: HTTP_VERBS.filter((verb) =>
          new RegExp(`export\\s+(?:async\\s+)?(?:function\\s+${verb}\\b|const\\s+${verb}\\b)|export\\s+\\{[^}]*\\b${verb}\\b`).test(
            source,
          ),
        ),
      });
      continue;
    }

    // A file whose first non-comment statement is 'use server' exposes every
    // exported function as a POST endpoint.
    if (/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use server['"]/.test(source)) {
      actions.push({ route: toRoute(file), file, source, exportedVerbs: ['POST'] });
    }
  }

  routeHandlers = handlers;
  serverActionFiles = actions;
});

function isAllowlisted(route: string): boolean {
  return UNPROTECTED_ALLOWLIST.some((allowed) => route === allowed);
}

function callsGuard(source: string): boolean {
  return /\brequireOwner\s*\(/.test(source);
}

describe('the unprotected allowlist', () => {
  it('is exactly two entries', () => {
    // If this fails, someone widened the unauthenticated surface. That may be
    // correct — but it must be deliberate, and it must be reviewed.
    expect([...UNPROTECTED_ALLOWLIST]).toEqual(['/api/health', '/api/auth/[...all]']);
  });

  it('matches the routes that actually exist', () => {
    const discovered = routeHandlers.map((handler) => handler.route).sort();
    // Sanity check on the enumeration itself: a walker that silently found
    // nothing would make every assertion below vacuously true.
    expect(discovered.length).toBeGreaterThan(0);
    expect(discovered).toContain('/api/health');
    expect(discovered).toContain('/api/auth/[...all]');
  });
});

describe('every Route Handler is guarded or explicitly allowlisted', () => {
  it('found route handlers to check', () => {
    expect(routeHandlers.length).toBeGreaterThan(0);
  });

  it('has no unguarded, non-allowlisted handler', () => {
    const offenders = routeHandlers
      .filter((handler) => !isAllowlisted(handler.route))
      .filter((handler) => !callsGuard(handler.source))
      .map((handler) => `${handler.route} (${path.relative(process.cwd(), handler.file)})`);

    expect(offenders).toEqual([]);
  });

  it('allowlisted handlers document why they are unguarded', () => {
    // The two exceptions are load-bearing and non-obvious; an undocumented one
    // reads like an oversight to the next person.
    for (const handler of routeHandlers.filter((h) => isAllowlisted(h.route))) {
      expect(handler.source, handler.route).toMatch(/UNAUTHENTICATED/i);
    }
  });
});

describe('every Server Action file is guarded', () => {
  it('has no unguarded "use server" file', () => {
    // Empty today — M2 adds no Server Actions. The assertion is what makes M3+
    // safe: the first action added without a guard fails here.
    const offenders = serverActionFiles
      .filter((entry) => !callsGuard(entry.source))
      .map((entry) => path.relative(process.cwd(), entry.file));

    expect(offenders).toEqual([]);
  });
});

describe('unauthenticated invocation, with the proxy bypassed', () => {
  it('refuses every non-allowlisted handler', async () => {
    // Imports the module and calls it directly — no proxy in the path at all,
    // which is precisely the scenario the matcher hazard creates.
    const protectedHandlers = routeHandlers.filter((handler) => !isAllowlisted(handler.route));

    for (const handler of protectedHandlers) {
      const imported = (await import(handler.file)) as Record<
        string,
        ((request: Request) => Promise<Response>) | undefined
      >;

      for (const verb of handler.exportedVerbs) {
        const fn = imported[verb];
        if (typeof fn !== 'function') continue;

        const response = await fn(new Request(`http://localhost:3000${handler.route}`));
        expect(
          response.status,
          `${verb} ${handler.route} answered ${response.status} unauthenticated`,
        ).toBeGreaterThanOrEqual(400);
      }
    }

    // State the count so a future regression that empties the enumeration is
    // visible rather than passing silently.
    expect(protectedHandlers.length).toBe(0);
  });
});

describe('/api/health leaks nothing', () => {
  it('returns booleans and a version string only', async () => {
    const route = (await import('@/app/api/health/route')) as {
      GET: () => Promise<Response>;
    };

    const response = await route.GET();
    const body = (await response.json()) as Record<string, unknown>;

    // Reachable without Access (the container healthcheck has no assertion), so
    // the body is the entire security boundary here.
    expect(Object.keys(body).sort()).toEqual(['database', 'ok', 'version']);
    expect(typeof body.ok).toBe('boolean');
    expect(typeof body.database).toBe('boolean');
    expect(typeof body.version).toBe('string');
  });

  it('exposes no counts, table names, error text or environment detail', async () => {
    const route = (await import('@/app/api/health/route')) as {
      GET: () => Promise<Response>;
    };

    const serialized = JSON.stringify(await (await route.GET()).json()).toLowerCase();

    for (const forbidden of [
      'postgres',
      'transaction',
      'finance',
      'user',
      'error',
      'stack',
      'node_env',
      'database_url',
      'migration',
      'burmy_test',
      'localhost',
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }

    // And no numbers at all beyond the version string — a row count is exactly
    // the kind of detail that creeps in later.
    const body = (await (await route.GET()).json()) as Record<string, unknown>;
    expect(Object.values(body).some((value) => typeof value === 'number')).toBe(false);
  });

  it('sets no-store, so a proxy cannot serve a stale readiness answer', async () => {
    const route = (await import('@/app/api/health/route')) as {
      GET: () => Promise<Response>;
    };

    const response = await route.GET();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
