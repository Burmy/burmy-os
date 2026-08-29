import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Fail the production build on type errors. The default is already to fail,
  // but stating it prevents a future "just ship it" flag from being added
  // quietly to a codebase that handles money.
  //
  // There is no `eslint` key here: Next.js 16 removed the built-in `next lint`
  // integration. Linting runs as its own step (`pnpm lint`) in CI and locally.
  typescript: { ignoreBuildErrors: false },

  // Do not advertise the framework version to the internet.
  poweredByHeader: false,

  // IGDB (Games module cover art) serves images from images.igdb.com.
  // PSN (per-game trophy icons, fetched live — see psn-client.ts's
  // fetchGameTrophies) serves from Sony's own asset CDN. Hostname taken from
  // psn-api's own doc-comment example URLs for a sibling icon field
  // (conceptIconUrl) on the same CDN family — confirm against one real
  // trophyIconUrl the first time this runs against a live account, and
  // correct here if it differs.
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'images.igdb.com' },
      { protocol: 'https', hostname: 'image.api.playstation.com' },
      // AniList cover art. `s4` is the CDN host the API's `coverImage` URLs
      // currently use — confirm against one real response before trusting it,
      // the same caveat this list already carries for the PSN host.
      { protocol: 'https', hostname: 's4.anilist.co' },
    ],
  },

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
