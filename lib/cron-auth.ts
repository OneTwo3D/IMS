import { timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'
import { getCronSecret } from '@/lib/cron-secret'

export const MIN_CRON_SECRET_LENGTH = 32

export function assertProductionCronSecretConfigured(
  env: Partial<Record<'NODE_ENV' | 'CRON_SECRET', string | undefined>> = process.env,
): void {
  if (env.NODE_ENV !== 'production') return

  const secret = env.CRON_SECRET?.trim() ?? ''
  if (secret.length === 0) {
    throw new Error('CRON_SECRET is required in production for cron endpoint authentication.')
  }
  if (secret.length < MIN_CRON_SECRET_LENGTH) {
    throw new Error(`CRON_SECRET must be at least ${MIN_CRON_SECRET_LENGTH} characters in production.`)
  }
}

/**
 * Verify cron requests via the configured cron secret.
 * Localhost bypass is allowed outside production only when CRON_SECRET is not
 * configured. Production cron endpoints always require the bearer secret.
 * Host and URL are used for the localhost check; x-forwarded-for is spoofable
 * and must not be trusted for cron auth.
 * Usage: const err = await verifyCron(request); if (err) return err;
 */
export async function verifyCron(request: Request): Promise<NextResponse | null> {
  const secret = await getCronSecret()

  if (secret) {
    const auth = request.headers.get('authorization')
    if (auth && bearerMatches(auth, `Bearer ${secret}`)) return null

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

function bearerMatches(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided)
  const expectedBytes = Buffer.from(expected)
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
}

export function isLocalhostCronBypassAllowed(): boolean {
  return process.env.NODE_ENV !== 'production'
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
