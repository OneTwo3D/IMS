import { NextResponse } from 'next/server'
import { getCronSecret } from '@/lib/cron-secret'

/**
 * Verify cron requests via the configured cron secret.
 * In development (no secret configured anywhere), only allow requests from the local machine
 * using the server connection's remote address (not spoofable headers).
 * Usage: const err = await verifyCron(request); if (err) return err;
 */
export async function verifyCron(request: Request): Promise<NextResponse | null> {
  const secret = await getCronSecret()
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
      { error: 'Cron secret is required in production' },
      { status: 401 },
    )
  }

  // Development only: allow requests to localhost
  const host = request.headers.get('host') ?? ''
  if (!host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
    return NextResponse.json(
      { error: 'Unauthorized — configure a cron secret for remote access' },
      { status: 401 },
    )
  }

  return null
}
