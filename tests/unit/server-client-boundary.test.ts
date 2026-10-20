import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A Server Action may not import a VALUE from a 'use client' module.
 *
 * Next turns a client module's exports into client references when a server
 * module imports them; calling one on the server throws at runtime
 * ("Attempted to call X() from the server but X is on the client"). That
 * shipped once: `updateGamePlayYearsAction` imported `isRealPlayYearDraft`
 * from `play-years-panel.tsx` ('use client'), every split save from the panel
 * was a 500, and no test saw it — Vitest calls actions directly and never
 * crosses the boundary. This walks the real import graph instead.
 *
 * Type-only imports are fine (erased); a mixed `import { fn, type T }` is a
 * value import and is flagged.
 */
const ROOT = path.resolve(__dirname, '../../src');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function directive(file: string): 'use server' | 'use client' | null {
  const head = fs.readFileSync(file, 'utf8').slice(0, 200);
  if (/^\s*['"]use server['"]/.test(head)) return 'use server';
  if (/^\s*['"]use client['"]/.test(head)) return 'use client';
  return null;
}

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? path.join(ROOT, specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(from), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every value import in a file: `import X from`, `import { a, type B } from` (a is a value), `import * as` — never `import type`. */
function valueImports(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /^import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
  for (const match of re.exec(source) ? source.matchAll(re) : []) {
    const [, typeOnly, clause, specifier] = match;
    if (typeOnly) continue;
    const named = clause?.match(/\{([\s\S]*)\}/)?.[1];
    if (named !== undefined) {
      const hasValue = named
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .some((s) => !s.startsWith('type '));
      const hasDefault = /^[A-Za-z_$][\w$]*\s*,/.test(clause ?? '');
      if (!hasValue && !hasDefault) continue;
    }
    out.push(specifier!);
  }
  return out;
}

describe('server/client boundary', () => {
  const serverFiles = walk(ROOT).filter((file) => directive(file) === 'use server');

  it('finds the Server Action modules', () => {
    expect(serverFiles.length).toBeGreaterThan(0);
  });

  it('no Server Action module imports a value from a "use client" module', () => {
    const offenders: string[] = [];
    for (const file of serverFiles) {
      for (const specifier of valueImports(file)) {
        const target = resolveImport(file, specifier);
        if (target !== null && directive(target) === 'use client') {
          offenders.push(`${path.relative(ROOT, file)} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
