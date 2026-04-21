import { NextRequest, NextResponse } from 'next/server'

const LOCAL_E2E_HOSTS = new Set([
  '0.0.0.0',
  '127.0.0.1',
  '::1',
  'localhost',
])

export function getE2eRouteAccessError(request: NextRequest): NextResponse | null {
  if (process.env.NODE_ENV !== 'development' || process.env.E2E_TEST_MODE !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const hostname = request.nextUrl.hostname.trim().toLowerCase()
  if (!LOCAL_E2E_HOSTS.has(hostname)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return null
}
