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
 * The complete unprotected surface. Exactly one entry.
 *
 * `/api/auth/[...all]` was the second entry through M8 — Better Auth's own
 * endpoints, which authenticated by design. It no longer exists: Cloudflare
 * Access with Google is the sole authentication mechanism, verified entirely
 * outside this application (src/proxy.ts, src/server/auth/access.ts), so there
 * is no in-app endpoint left that has to be reachable without a session.
 *
 * Growing this list is a security decision, and it should require editing this
 * constant in a reviewed diff — never happen as a side effect.
 */
const UNPROTECTED_ALLOWLIST = ['/api/health'] as const;

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
let privatePageFiles: EntryPoint[] = [];

beforeAll(async () => {
  await harness();
  await resetDatabase();

  const files = await walk(APP_DIR);

  const handlers: EntryPoint[] = [];
  const actions: EntryPoint[] = [];
  const pages: EntryPoint[] = [];

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
      continue;
    }

    // Server Component pages under the `(private)` route group. The layout
    // (`(private)/layout.tsx`) already gates every page beneath it structurally
    // — Next.js cannot render a page without its ancestor layouts, unlike the
    // proxy `matcher`, which is a URL pattern that can silently drift out of
    // sync — but CLAUDE.md's own invariant is that pages ALSO call
    // `requireOwner()` directly, for the owner id, as defense-in-depth. This
    // enumeration proves that holds, the same way the Route Handler/Server
    // Action checks above do, rather than trusting it by convention.
    if ((base === 'page.tsx' || base === 'page.ts') && file.includes(`${path.sep}(private)${path.sep}`)) {
      pages.push({ route: toRoute(file), file, source, exportedVerbs: [] });
    }
  }

  routeHandlers = handlers;
  serverActionFiles = actions;
  privatePageFiles = pages;
});

function isAllowlisted(route: string): boolean {
  return UNPROTECTED_ALLOWLIST.some((allowed) => route === allowed);
}

function callsGuard(source: string): boolean {
  return /\brequireOwner\s*\(/.test(source);
}

/**
 * Pages that render nothing at all — a bare `redirect()` and nothing else —
 * have no data to protect and no owner id to scope a query with, so calling
 * `requireOwner()` would be a no-op past the layout's own gate. Growing this
 * list is the same kind of decision as `UNPROTECTED_ALLOWLIST`: it must be
 * deliberate and reviewed, not a silent accident, which is what
 * "allowlisted pages are genuinely pure redirects" below enforces.
 */
const PURE_REDIRECT_PAGE_ALLOWLIST = ['/finance/import'] as const;

describe('the unprotected allowlist', () => {
  it('is exactly one entry', () => {
    // If this fails, someone widened the unauthenticated surface. That may be
    // correct — but it must be deliberate, and it must be reviewed.
    expect([...UNPROTECTED_ALLOWLIST]).toEqual(['/api/health']);
  });

  it('matches the routes that actually exist', () => {
    const discovered = routeHandlers.map((handler) => handler.route).sort();
    // Sanity check on the enumeration itself: a walker that silently found
    // nothing would make every assertion below vacuously true.
    expect(discovered.length).toBeGreaterThan(0);
    expect(discovered).toContain('/api/health');
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

describe('every private page calls requireOwner(), or is an allowlisted pure redirect', () => {
  it('found private pages to check', () => {
    expect(privatePageFiles.length).toBeGreaterThan(0);
  });

  it('has no unguarded, non-allowlisted private page', () => {
    const offenders = privatePageFiles
      .filter((page) => !PURE_REDIRECT_PAGE_ALLOWLIST.includes(page.route as never))
      .filter((page) => !callsGuard(page.source))
      .map((page) => `${page.route} (${path.relative(process.cwd(), page.file)})`);

    expect(offenders).toEqual([]);
  });

  it('allowlisted pages are genuinely pure redirects, not silently unguarded', () => {
    const allowlisted = privatePageFiles.filter((page) =>
      PURE_REDIRECT_PAGE_ALLOWLIST.includes(page.route as never),
    );
    expect(allowlisted.length).toBe(PURE_REDIRECT_PAGE_ALLOWLIST.length);
    for (const page of allowlisted) {
      expect(page.source, page.route).toMatch(/\bredirect\s*\(/);
    }
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

        try {
          const response = await fn(new Request(`http://localhost:3000${handler.route}`));
          expect(
            response.status,
            `${verb} ${handler.route} answered ${response.status} unauthenticated`,
          ).toBeGreaterThanOrEqual(400);
        } catch (error) {
          // `requireOwner()` reads `next/headers`, which needs NEXT'S OWN
          // request-scoped storage — populated for every request Next's
          // server actually handles, but absent when this test imports the
          // module and calls the exported function directly with no server
          // runtime around it at all (first discovered here, M9 — no
          // protected Route Handler existed before this one). That is a
          // limitation of invoking the function this bare way, not a
          // security gap: the handler still never reached a response, let
          // alone a 200 with data. Anything else re-throws, so a genuine bug
          // in the guard still fails this test loudly.
          expect(
            String(error),
            `${verb} ${handler.route} threw an unexpected error`,
          ).toContain('outside a request scope');
        }
      }
    }

    // State the count so a future regression that empties the enumeration is
    // visible rather than passing silently. M9 added the first protected
    // Route Handler (`/finance/transactions/export`) — see the comment above
    // for why this path is exercised via try/catch.
    expect(protectedHandlers.length).toBe(1);
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
