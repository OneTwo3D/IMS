import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { sessionInvalidLoginReason } from '@/lib/auth/session-state'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Public routes — skip auth check entirely
  const isAuthPage = pathname.startsWith('/login') || pathname.startsWith('/2fa')
  const isApiRoute = pathname.startsWith('/api/')
  const isPublic = isAuthPage || isApiRoute

  if (isPublic) return NextResponse.next()

  // Wrap auth() in try/catch — if JWT is corrupt/expired, redirect to login
  // instead of showing a generic error page
  let session
  try {
    session = await auth()
  } catch {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (!session?.user || session.user.sessionInvalidReason) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    if (session?.user?.sessionInvalidReason) {
      loginUrl.searchParams.set('reason', sessionInvalidLoginReason(session.user.sessionInvalidReason))
    }
    return NextResponse.redirect(loginUrl)
  }

  // 2FA gate: if TOTP is enabled but not yet verified in this session, send to /2fa
  if (session.user.totpEnabled && !session.user.totpVerified && pathname !== '/2fa') {
    return NextResponse.redirect(new URL('/2fa', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
