/**
 * Pure authorization decision for the Next.js proxy (middleware) — extracted
 * from proxy.ts so the auth boundary is exhaustively unit-testable
 * (onetwo3d-ims-muid: regression coverage for unauthenticated proxy-bypass
 * request shapes, alongside the Next 16.2.10 advisory upgrade).
 *
 * The proxy is the FIRST authorization gate for HTML pages; dashboard layouts
 * and server actions re-check, but a bypass here is still a defense-in-depth
 * failure, so the routing rules are tested directly.
 */

import type { SessionInvalidReason } from '@/lib/auth/session-state'

/**
 * Public path segments that skip the session gate. Matched as an EXACT path or
 * a true sub-path (`/login`, `/login/…`) — NOT a loose prefix (Codex/muid: the
 * old `startsWith('/login')` also matched `/login-attacker`, silently exposing
 * any future route with such a name; scoping it closes that latent bypass).
 */
export const PUBLIC_PAGE_PATHS = ['/login', '/2fa', '/forgot-password', '/reset-password'] as const

/** The API prefix — API routes authenticate themselves (cron secret, session, HMAC), so the page gate skips them. */
export const API_PATH_PREFIX = '/api/'

/**
 * The proxy's Next.js matcher — which requests the middleware even RUNS on.
 * This is the OUTER bypass surface (muid / the Next advisories): a protected
 * page reached via an alternate App-Router transport (`.rsc`,
 * `.segments/*.segment.rsc`, root transport) must still be matched so the auth
 * gate runs. The exclusions are framework static prefixes (`_next/static`,
 * `_next/image`, `favicon.ico`) and any path ENDING in a public image
 * extension — the latter is path-shape based, so a (pathological) protected
 * route ending in such an extension would also skip the proxy; that residual
 * is backstopped by app/(dashboard)/layout.tsx requireAuth() (see the
 * KNOWN-LIMITATION test). Exported so proxy.ts's `config.matcher` and the
 * regression test share one source of truth.
 */
export const PROXY_MATCHER = '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'

/** True when the proxy middleware runs for this path (mirrors Next's matcher compilation). */
export function proxyRunsForPath(pathname: string): boolean {
  return new RegExp(`^${PROXY_MATCHER}$`).test(pathname)
}

/** True when the path is a public auth page (exact or sub-path) or an API route. */
export function isPublicProxyPath(pathname: string): boolean {
  if (pathname.startsWith(API_PATH_PREFIX)) return true
  return PUBLIC_PAGE_PATHS.some((base) => pathname === base || pathname.startsWith(`${base}/`))
}

export type ProxySessionUser = {
  sessionInvalidReason?: SessionInvalidReason | null
  totpEnabled?: boolean | null
  totpVerified?: boolean | null
}

export type ProxySession = { user?: ProxySessionUser | null } | null | undefined

export type ProxyAuthzDecision =
  /** Public route — emit CSP, no session required. */
  | { action: 'public' }
  /** No valid session — redirect to /login (optionally carrying an invalid-session reason). */
  | { action: 'redirect-login'; invalidReason: SessionInvalidReason | null }
  /** Valid session but TOTP not yet verified this session — redirect to /2fa. */
  | { action: 'redirect-2fa' }
  /** Authenticated and cleared — pass through. */
  | { action: 'allow' }

/**
 * Decide how the proxy should handle a request. Pure over (pathname, session);
 * proxy.ts resolves auth() (handling the throw→login case) and CSP, then acts
 * on this decision.
 */
export function evaluateProxyAuthz(pathname: string, session: ProxySession): ProxyAuthzDecision {
  if (isPublicProxyPath(pathname)) return { action: 'public' }

  const user = session?.user
  if (!user || user.sessionInvalidReason) {
    return { action: 'redirect-login', invalidReason: user?.sessionInvalidReason ?? null }
  }

  // 2FA gate: TOTP enabled but not verified this session. /2fa itself is a
  // public path (handled above), so here pathname is always a protected page.
  if (user.totpEnabled && !user.totpVerified) return { action: 'redirect-2fa' }

  return { action: 'allow' }
}
