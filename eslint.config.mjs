import js from '@eslint/js';
import next from 'eslint-config-next';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'out/**',
      'dist/**',
      'coverage/**',
      'drizzle/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...next,

  {
    // Pin the React version explicitly.
    //
    // eslint-plugin-react 7.37.5 (pulled in by eslint-config-next) crashes on
    // ESLint 10 inside its version AUTO-DETECTION — it calls
    // `context.getFilename()`, removed in ESLint 10. Declaring the version here
    // short-circuits detection before that code runs.
    //
    // Revisit once eslint-plugin-react ships ESLint 10 support; until then this
    // is what keeps `pnpm lint` runnable at all.
    settings: {
      react: { version: '19.2' },
    },
  },

  {
    rules: {
      // ── Burmy-specific guards ──────────────────────────────────────────────

      // Statement descriptions are untrusted text from outside the trust
      // boundary. There is no legitimate reason to inject raw HTML in this app.
      'react/no-danger': 'error',

      // Unused vars are usually a half-finished refactor. Underscore opts out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // `any` erases the type safety that protects the money model.
      '@typescript-eslint/no-explicit-any': 'error',

      // console.log is how financial data accidentally reaches a log file.
      // Structured logging with redaction arrives in M2.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  {
    // The finance domain core must stay framework-free — that is what makes it
    // testable in milliseconds without a browser or a server. Importing React
    // or Next here is an architectural regression, not a style choice.
    files: ['src/server/finance/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-dom', 'next', 'next/*', '@/features/*', '@/components/*'],
              message:
                'src/server/finance/** is the framework-free domain core. Keep React/Next/UI out of it — see docs/ARCHITECTURE.md.',
            },
          ],
        },
      ],
    },
  },

  {
    // CLI entrypoints and tests. These are invoked from a terminal by a human,
    // so stdout IS the interface — and none of them touch financial rows.
    files: [
      'tests/**/*.{ts,tsx}',
      '*.config.{ts,mjs}',
      'scripts/**/*.{ts,mjs,js}',
      'src/server/db/seed.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },

  // Must stay last: turns off stylistic rules that would fight Prettier.
  prettier,
);
