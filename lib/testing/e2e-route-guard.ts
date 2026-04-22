import { NextRequest, NextResponse } from 'next/server'
import { type AuthSession, requireApiAdmin } from '@/lib/auth/server'

const LOCAL_E2E_HOSTS = new Set([
  '0.0.0.0',
  '127.0.0.1',
  '::1',
  'localhost',
])

export const E2E_SECRET_HEADER = 'x-e2e-secret'

function isLocalUrl(value: string | undefined): boolean {
  if (!value?.trim()) return true

  try {
    const hostname = new URL(value).hostname.trim().toLowerCase()
    return LOCAL_E2E_HOSTS.has(hostname)
  } catch {
    return false
  }
}

export function assertE2eRouteModuleEnabled(routeId: string): void {
  if (process.env.NODE_ENV !== 'development' || process.env.E2E_TEST_MODE !== '1') {
    throw new Error(`${routeId} is only available when NODE_ENV=development and E2E_TEST_MODE=1`)
  }

  if (!isLocalUrl(process.env.AUTH_URL) || !isLocalUrl(process.env.NEXT_PUBLIC_APP_URL)) {
    throw new Error(`${routeId} requires local AUTH_URL and NEXT_PUBLIC_APP_URL values`)
  }

  if (!process.env.E2E_ROUTE_SECRET?.trim()) {
    throw new Error(`${routeId} requires E2E_ROUTE_SECRET to be configured`)
  }
}

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
