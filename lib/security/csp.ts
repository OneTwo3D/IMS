// Content-Security-Policy construction for the middleware (proxy.ts).
//
// A nonce-based, `strict-dynamic` script policy is the strong form of CSP: only
// scripts carrying the per-request nonce (and scripts they load) execute, so an
// injected inline <script> without the nonce is blocked. Next.js auto-applies
// the nonce to its own framework/hydration scripts when it sees a nonce'd CSP on
// the request; our one custom inline script (the theme script in app/layout.tsx)
// reads the nonce from the `x-nonce` header.
//
// Rollout safety: CSP_MODE defaults to `report-only`, which emits
// `Content-Security-Policy-Report-Only` — violations are reported but nothing is
// blocked, so shipping this cannot break the app. Flip to `enforce` (a
// build-time env, like other Next middleware env) only after confirming there
// are no violations in the browser console on a representative set of pages.

export type CspMode = 'enforce' | 'report-only' | 'off'

export function getCspMode(env: { CSP_MODE?: string } = process.env as { CSP_MODE?: string }): CspMode {
  const value = (env.CSP_MODE ?? '').trim().toLowerCase()
  if (value === 'enforce') return 'enforce'
  if (value === 'off') return 'off'
  return 'report-only'
}

/** 128-bit base64 nonce using the Web Crypto API (available in the edge runtime). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function cspHeaderName(mode: Exclude<CspMode, 'off'>): string {
  return mode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only'
}

/**
 * Build the CSP string for a request.
 *
 * Dev builds additionally allow `'unsafe-eval'` (Turbopack / React Fast Refresh
 * evaluate code) and websocket connect (HMR). Production omits both.
 */
export function buildCsp(nonce: string, isDev: boolean): string {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]
  if (isDev) scriptSrc.push("'unsafe-eval'")

  const connectSrc = ["'self'"]
  if (isDev) connectSrc.push('ws:', 'wss:')

  const directives = [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    // Next.js and Tailwind inject inline <style>; nonces do not reliably cover
    // all injected styles, so styles use 'unsafe-inline' (styles are a far
    // weaker XSS vector than scripts).
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src ${connectSrc.join(' ')}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `frame-src 'none'`,
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    `upgrade-insecure-requests`,
  ]
  return directives.join('; ')
}
