/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,

  // pdf-parse runs in a worker_threads worker (see app/api/upload/route.ts).
  // The worker uses `require('pdf-parse')` from inside a template-string
  // source, so:
  //   (1) `serverComponentsExternalPackages` keeps Next from bundling it.
  //   (2) `outputFileTracingIncludes` explicitly copies it into the
  //       standalone output, since the trace can't see require() inside a
  //       template string.
  experimental: {
    serverComponentsExternalPackages: ['pdf-parse'],
    outputFileTracingIncludes: {
      // pdf-parse's only dep is node-ensure; both must be present at runtime
      // because the trace can't see require() inside the worker template.
      '/api/upload': [
        './node_modules/pdf-parse/**/*',
        './node_modules/node-ensure/**/*',
      ],
    },
  },

  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'logo.clearbit.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 't0.gstatic.com',
        pathname: '/**',
      },
    ],
  },
  
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: https://logo.clearbit.com https://t0.gstatic.com",
              "connect-src 'self'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },

  // API route configuration
  async rewrites() {
    return [];
  },

  // Environment variables exposed to browser
  env: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  },
};

module.exports = nextConfig;
