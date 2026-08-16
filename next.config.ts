import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Required for the production Docker image: emits a minimal self-contained
  // server bundle instead of shipping the whole node_modules tree.
  output: 'standalone',

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
