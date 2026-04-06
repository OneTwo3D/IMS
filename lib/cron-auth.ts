import { NextResponse } from 'next/server'

/**
 * Verify cron requests via CRON_SECRET env var or localhost origin.
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
  // No secret configured — only allow from localhost
  const forwarded = request.headers.get('x-forwarded-for')
  const host = request.headers.get('host') ?? ''
  if (forwarded && !['127.0.0.1', '::1', 'localhost'].includes(forwarded.split(',')[0].trim())) {
    if (!host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
      return NextResponse.json({ error: 'Unauthorized — set CRON_SECRET env var for remote access' }, { status: 401 })
    }
  }
  return null
}
