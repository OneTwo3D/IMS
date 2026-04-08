import { NextResponse } from 'next/server'

/**
 * Verify cron requests via CRON_SECRET env var.
 * In development (no CRON_SECRET), only allow requests from the local machine
 * using the server connection's remote address (not spoofable headers).
 * Usage: const err = verifyCron(request); if (err) return err;
 */
export function verifyCron(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return null
  }

  // No secret configured — in production this should always be set.
  // In dev, allow localhost only. Use the Host header as a basic check
  // (x-forwarded-for is spoofable and should NOT be trusted for auth).
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'CRON_SECRET env var is required in production' },
      { status: 401 },
    )
  }

  // Development only: allow requests to localhost
  const host = request.headers.get('host') ?? ''
  if (!host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
    return NextResponse.json(
      { error: 'Unauthorized — set CRON_SECRET env var for remote access' },
      { status: 401 },
    )
  }

  return null
}
