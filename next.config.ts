import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// Baseline security response headers applied to every route (framing,
// MIME-sniffing, referrer leakage, transport security). The full Content-Security-Policy
// is NOT set here: it needs a per-request nonce, so it is built in the middleware
// (proxy.ts / lib/security/csp.ts) and applied to HTML responses. Keeping CSP out
// of this static list also avoids emitting two conflicting CSP headers on pages.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  // Opt-in self-contained server bundle for the container image (see Dockerfile). Only the
  // Dockerfile's build stage sets NEXT_OUTPUT=standalone; every other build (CI, `next start`
  // on the stage host, `next dev`) leaves this undefined and behaves exactly as before.
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  compress: false,
  // Do not advertise the framework/version in responses.
  poweredByHeader: false,
  serverExternalPackages: ['pdfkit', 'sharp', 'ssh2-sftp-client'],
  // Origins allowed to reach `next dev` resources. An origin missing from this
  // list still renders SSR HTML, but its HMR socket is refused and the dev client
  // runtime never starts — so the page never hydrates and every button silently
  // does nothing (a form falls back to a native GET). The failure looks like a
  // broken login rather than a config gap, so add any new proxied dev hostname here.
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    'ims.onetwo3d.co.uk',
    'ims-stage.onetwo3d.co.uk',
    // Full-chain e2e rig (o3d-lgo): ims-e2e-dev.service on :3002, proxied by OLS.
    'ims-e2e.onetwo3d.co.uk',
  ],
  outputFileTracingExcludes: {
    '/api/backup/restore': ['./next.config.ts'],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

// Error tracking (GlitchTip). The wrapper only wires the SDK into the build; it reports nothing
// without a DSN. Build-time services are all switched off: no telemetry (it would call sentry.io),
// no auth token, no source-map upload, no tunnel route, quiet output.
export default withSentryConfig(nextConfig, {
  telemetry: false,
  silent: true,
  sourcemaps: { disable: true },
});
