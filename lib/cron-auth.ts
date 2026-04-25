import { NextResponse } from 'next/server'
import { getCronSecret } from '@/lib/cron-secret'

/**
 * Verify cron requests via the configured cron secret.
 * Localhost bypass is allowed outside production, or in production only when
 * ALLOW_LOCALHOST_CRON_BYPASS=true, but only when CRON_SECRET is not configured.
 * Host and URL are used for the localhost check; x-forwarded-for is spoofable
 * and must not be trusted for cron auth.
 * Usage: const err = await verifyCron(request); if (err) return err;
 */
export async function verifyCron(request: Request): Promise<NextResponse | null> {
  const secret = await getCronSecret()

  if (secret) {
    const auth = request.headers.get('authorization')
    if (auth === `Bearer ${secret}`) return null

    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const isLocalhost = isLocalhostCronRequest(request)
  const allowLocalhostBypass = isLocalhostCronBypassAllowed()

  if (!allowLocalhostBypass) {
    return NextResponse.json(
      { error: 'Cron secret is required in production' },
      { status: 401 },
    )
  }

  if (!isLocalhost) {
    return NextResponse.json(
      { error: 'Unauthorized — configure a cron secret for remote access' },
      { status: 401 },
    )
  }

  return null
}

export function isLocalhostCronBypassAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' ||
    process.env.ALLOW_LOCALHOST_CRON_BYPASS === 'true'
}

function isLocalhostCronRequest(request: Request): boolean {
  const hostHeader = request.headers.get('host')
  if (hostHeader && isLocalhostHost(hostHeader)) return true

  try {
    return isLocalhostHost(new URL(request.url).host)
  } catch {
    return false
  }
}

function isLocalhostHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase()
  if (!normalizedHost) return false

  if (normalizedHost.startsWith('[')) {
    return normalizedHost.startsWith('[::1]')
  }

  const hostname = normalizedHost.split(':')[0]
  return hostname === 'localhost' || hostname === '127.0.0.1'
}
