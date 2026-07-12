import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { sessionInvalidLoginReason } from '@/lib/auth/session-state'
import { buildCsp, cspHeaderName, generateNonce, getCspMode } from '@/lib/security/csp'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Per-request nonce + CSP for HTML responses. API routes return JSON and get
  // the static headers from next.config.ts instead; static assets are excluded
  // by the matcher below.
  const isApiRoute = pathname.startsWith('/api/')
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

  // Public routes — skip the auth check but still emit CSP on HTML.
  const isAuthPage =
    pathname.startsWith('/login') ||
    pathname.startsWith('/2fa') ||
    pathname.startsWith('/forgot-password') ||
    pathname.startsWith('/reset-password')

  if (isAuthPage || isApiRoute) return passThrough()

  // Wrap auth() in try/catch — if JWT is corrupt/expired, redirect to login
  // instead of showing a generic error page
  let session
  try {
    session = await auth()
  } catch {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    return withCsp(NextResponse.redirect(loginUrl))
  }

  if (!session?.user || session.user.sessionInvalidReason) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    if (session?.user?.sessionInvalidReason) {
      loginUrl.searchParams.set('reason', sessionInvalidLoginReason(session.user.sessionInvalidReason))
    }
    return withCsp(NextResponse.redirect(loginUrl))
  }

  // 2FA gate: if TOTP is enabled but not yet verified in this session, send to /2fa
  if (session.user.totpEnabled && !session.user.totpVerified && pathname !== '/2fa') {
    return withCsp(NextResponse.redirect(new URL('/2fa', request.url)))
  }

  return passThrough()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
