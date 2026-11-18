import { apiRouteAuthPolicy, type ApiRouteAccess } from '@/lib/security/route-auth-policy'

/**
 * Origin / Sec-Fetch-Site check for cookie-authenticated mutating API routes.
 *
 * The session cookie is SameSite=Lax, which is the only thing that stopped a cross-site form post from running as the
 * signed-in operator. This adds the second layer: a state-changing request from a browser must come from this
 * origin. Which routes are checked comes from the route-auth policy: routes that authenticate with something other
 * than the session cookie (signed webhooks, cron secret, the Xero OAuth callback, dev-only rigs, the shop/helper HMAC
 * handoffs) are exempt, everything else (session, admin, supplier, and any route the policy does not list) is checked.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const EXEMPT_ACCESS: ReadonlySet<ApiRouteAccess> = new Set<ApiRouteAccess>([
  'public-webhook',
  'cron-secret',
  'xero-oauth',
  'internal-dev-only',
])

// Catch-all patterns (`[...nextauth]`) go last so a specific route such as /api/auth/totp is never read as one.
const routeMatchers = Object.entries(apiRouteAuthPolicy)
  .sort(([a], [b]) => Number(a.includes('[...')) - Number(b.includes('[...')))
  .map(([pattern, entry]) => {
    const source = pattern
      .split('/')
      .map((segment) => {
        if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return '.+'
        if (/^\[[^\]]+\]$/.test(segment)) return '[^/]+'
        return segment.replace(/[.*+?^${}()|\\]/g, '\\$&')
      })
      .join('/')
    return { regex: new RegExp(`^${source}$`), access: entry.access as ApiRouteAccess }
  })

/** The policy access class of an API path, or undefined when the policy does not list the route. */
export function resolveApiRouteAccess(pathname: string): ApiRouteAccess | undefined {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return routeMatchers.find((m) => m.regex.test(clean))?.access
}

export function csrfOriginCheckApplies(method: string, pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false
  if (SAFE_METHODS.has(method.toUpperCase())) return false
  const access = resolveApiRouteAccess(pathname)
  return access === undefined || !EXEMPT_ACCESS.has(access)
}

export type CsrfOriginDecision = { allowed: true } | { allowed: false; reason: string }

type HeaderReader = { get(name: string): string | null }

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Pure decision. `Sec-Fetch-Site` (set by the browser, not forgeable by a page) wins when present; otherwise the
 * Origin header must match the host the request was addressed to. A request with neither header is not a browser
 * form or fetch (those always carry one), so it is a script or server client and is let through to the route's own
 * authentication.
 */
export function evaluateCsrfOrigin(input: { method: string; pathname: string; headers: HeaderReader }): CsrfOriginDecision {
  if (!csrfOriginCheckApplies(input.method, input.pathname)) return { allowed: true }

  const fetchSite = input.headers.get('sec-fetch-site')?.toLowerCase()
  if (fetchSite) {
    if (fetchSite === 'same-origin' || fetchSite === 'none') return { allowed: true }
    return { allowed: false, reason: `cross-origin request refused (Sec-Fetch-Site: ${fetchSite})` }
  }

  const origin = input.headers.get('origin')
  if (origin === null) return { allowed: true }
  const originHost = hostOf(origin)
  if (!originHost) return { allowed: false, reason: 'cross-origin request refused (unusable Origin header)' }

  const hosts = [input.headers.get('x-forwarded-host'), input.headers.get('host')]
    .flatMap((h) => (h ? h.split(',').map((part) => part.trim().toLowerCase()) : []))
  if (hosts.includes(originHost)) return { allowed: true }
  return { allowed: false, reason: 'cross-origin request refused (Origin does not match this host)' }
}
