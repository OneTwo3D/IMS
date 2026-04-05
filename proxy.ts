import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'

export async function proxy(request: NextRequest) {
  const session = await auth()
  const { pathname } = request.nextUrl

  const isAuthPage = pathname.startsWith('/login') || pathname.startsWith('/2fa')
  const isApiAuth = pathname.startsWith('/api/auth')
  const isPublic = isAuthPage || isApiAuth

  if (isPublic) return NextResponse.next()

  if (!session?.user) {
    const loginUrl = new URL('/login', request.url)
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
