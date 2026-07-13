import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { sessionInvalidLoginReason, type SessionInvalidReason } from '@/lib/auth/session-state'
import { buildCsp, cspHeaderName, generateNonce, getCspMode } from '@/lib/security/csp'
import { API_PATH_PREFIX, evaluateProxyAuthz, isPublicProxyPath } from '@/lib/security/proxy-authz'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Per-request nonce + CSP for HTML responses. API routes return JSON and get
  // the static headers from next.config.ts instead; static assets are excluded
  // by the matcher below.
  const isApiRoute = pathname.startsWith(API_PATH_PREFIX)
  const cspMode = getCspMode()
  const nonce = generateNonce()
  const csp = cspMode === 'off' || isApiRoute
    ? null
    : buildCsp(nonce, process.env.NODE_ENV !== 'production')

  // Attach the CSP response header (report-only or enforce) to any response.
  const withCsp = <T extends NextResponse>(response: T): T => {
    if (csp && cspMode !== 'off') response.headers.set(cspHeaderName(cspMode), csp)
    return response
  }

  // Pass-through for HTML pages: propagate the nonce to the request so Next.js
  // stamps it onto its own scripts, and app/layout.tsx can read `x-nonce`.
  const passThrough = (): NextResponse => {
    if (!csp) return NextResponse.next()
    const requestHeaders = new Headers(request.headers)
    requestHeaders.set('x-nonce', nonce)
    requestHeaders.set('content-security-policy', csp)
    return withCsp(NextResponse.next({ request: { headers: requestHeaders } }))
  }

  const redirectToLogin = (invalidReason: SessionInvalidReason | null): NextResponse => {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    if (invalidReason) loginUrl.searchParams.set('reason', sessionInvalidLoginReason(invalidReason))
    return withCsp(NextResponse.redirect(loginUrl))
  }

  // Public routes — skip the auth check but still emit CSP on HTML.
  if (isPublicProxyPath(pathname)) return passThrough()

  // Wrap auth() in try/catch — if the JWT is corrupt/expired, redirect to login
  // instead of showing a generic error page.
  let session
  try {
    session = await auth()
  } catch {
    return redirectToLogin(null)
  }

  // Authorization decision (lib/security/proxy-authz.ts — unit-tested against
  // proxy-bypass request shapes, onetwo3d-ims-muid).
  const decision = evaluateProxyAuthz(pathname, session)
  switch (decision.action) {
    case 'redirect-login':
      return redirectToLogin(decision.invalidReason)
    case 'redirect-2fa':
      return withCsp(NextResponse.redirect(new URL('/2fa', request.url)))
    case 'public':
    case 'allow':
      return passThrough()
  }
}

export const config = {
  // MUST be a static string literal — Next statically analyzes config.matcher
  // at build time and rejects a variable. Kept in sync with PROXY_MATCHER
  // (lib/security/proxy-authz.ts) by a drift-guard test.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
