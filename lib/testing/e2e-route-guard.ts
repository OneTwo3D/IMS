import { NextRequest, NextResponse } from 'next/server'
import { type AuthSession, requireApiAdmin } from '@/lib/auth/server'

const LOCAL_E2E_HOSTS = new Set([
  '0.0.0.0',
  '127.0.0.1',
  '::1',
  'localhost',
])

export const E2E_SECRET_HEADER = 'x-e2e-secret'

export function getE2eRouteAccessError(request: NextRequest): NextResponse | null {
  if (process.env.NODE_ENV !== 'development' || process.env.E2E_TEST_MODE !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const hostname = request.nextUrl.hostname.trim().toLowerCase()
  if (!LOCAL_E2E_HOSTS.has(hostname)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const expectedSecret = process.env.E2E_ROUTE_SECRET?.trim()
  const providedSecret = request.headers.get(E2E_SECRET_HEADER)?.trim()
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return null
}

export async function requireE2eAdminRoute(
  request: NextRequest,
): Promise<NextResponse | AuthSession> {
  const authError = getE2eRouteAccessError(request)
  if (authError) return authError
  return requireApiAdmin()
}
