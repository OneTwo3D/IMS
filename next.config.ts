import type { NextConfig } from "next";

// Baseline security response headers applied to every route. These are safe,
// script-agnostic defenses (framing, MIME-sniffing, referrer leakage, transport
// security). A full script-src CSP is intentionally left out here because it
// requires per-request nonces to coexist with Next.js inline hydration; it is
// tracked as a follow-up. `frame-ancestors`/`object-src`/`base-uri` below do
// not affect legitimate script loading, so they are safe to enforce now.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  },
];

const nextConfig: NextConfig = {
  compress: false,
  serverExternalPackages: ['pdfkit', 'sharp', 'ssh2-sftp-client'],
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    'ims.onetwo3d.co.uk',
    'ims-stage.onetwo3d.co.uk',
  ],
  outputFileTracingExcludes: {
    '/api/backup/restore': ['./next.config.ts'],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
