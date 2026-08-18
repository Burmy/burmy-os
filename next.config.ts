import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Required for the production Docker image: emits a minimal self-contained
  // server bundle instead of shipping the whole node_modules tree.
  output: 'standalone',

  // Next's own file tracer misses `@swc/helpers` under pnpm's per-package
  // isolated store — a documented Next.js + pnpm interaction, not specific
  // to this app. Discovered running the ACTUAL `runner` image end to end for
  // the first time (M10): `.next/standalone` builds and `next build` passes
  // cleanly either way, but `node server.js` crash-loops with
  // `Cannot find module '.../@swc/helpers/esm/_interop_require_default.js'`
  // — a runtime failure `pnpm build`/`next build` never surfaces on their
  // own, since dev always runs on the host via `pnpm dev`, never this image.
  // Forcing the whole package into the traced output (Node's directory-walk
  // resolution then finds it from any nested pnpm-hashed instance) fixes it.
  outputFileTracingIncludes: {
    '**/*': ['./node_modules/@swc/helpers/**/*'],
  },

  // Fail the production build on type errors. The default is already to fail,
  // but stating it prevents a future "just ship it" flag from being added
  // quietly to a codebase that handles money.
  //
  // There is no `eslint` key here: Next.js 16 removed the built-in `next lint`
  // integration. Linting runs as its own step (`pnpm lint`) in CI and locally.
  typescript: { ignoreBuildErrors: false },

  // Do not advertise the framework version to the internet.
  poweredByHeader: false,

  // Security headers. The nonce-based CSP is added in src/proxy.ts during M2 —
  // it needs per-request state that static headers cannot express.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
