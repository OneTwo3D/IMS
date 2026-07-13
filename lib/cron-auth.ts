import { timingSafeEqual } from 'crypto'
import { NextResponse, after } from 'next/server'
import { logActivity } from '@/lib/activity-log'
import { getCronSecret } from '@/lib/cron-secret'

export { MIN_CRON_SECRET_LENGTH, assertProductionCronSecretConfigured } from '@/lib/cron-secret-validation'

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

    // ryxy: rejected cron auth was COMPLETELY silent (curl -sf on the caller
    // side, nothing app-side) — a stale rotated secret 401'd every scheduled
    // job for months unnoticed. Surface it in the activity log, throttled per
    // route so a misconfigured scheduler can't flood the log. Deferred via
    // after() (Codex r2/r3): the 401 never waits on logging, but the write is
    // still tied to the request lifecycle so it completes under serverless.
    scheduleCronAuthRejectedLog(request)
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

const CRON_AUTH_REJECT_LOG_INTERVAL_MS = 60 * 60_000
// Process-local throttle (Codex r2): deliberately NOT the shared rate-limit
// backend — that put a Redis round trip on the hot 401-reject path (latency
// under a black-holed Redis) and its fail-open defeated the throttle during an
// outage. Per-replica 1/route/hour is the right bound for an advisory WARNING;
// the static cron route set keeps the Map bounded.
const lastRejectLogAt = new Map<string, number>()

/**
 * Schedule the throttled reject-log write on the request's after() hook so it
 * completes under serverless without blocking the 401 (Codex r3). The slot is
 * RESERVED synchronously here — before any await — so concurrent rejects in the
 * same window don't all pass the check (Codex r3); the write itself is
 * best-effort (logActivity swallows failures).
 */
function scheduleCronAuthRejectedLog(request: Request): void {
  let pathname = 'unknown'
  try {
    pathname = new URL(request.url).pathname
  } catch {
    // keep 'unknown'
  }
  const now = Date.now()
  if (now - (lastRejectLogAt.get(pathname) ?? 0) < CRON_AUTH_REJECT_LOG_INTERVAL_MS) return
  lastRejectLogAt.set(pathname, now)
  const run = () =>
    logActivity({
      entityType: 'SYSTEM',
      tag: 'system',
      action: 'cron_auth_rejected',
      level: 'WARNING',
      description: `Cron request to ${pathname} rejected — bad or missing bearer secret. If this repeats hourly, the crontab's CRON_SECRET is stale (rotate drift): re-sync the scheduler in Settings → System → Scheduler.`,
      metadata: { pathname },
      resolveUser: false,
    })
  try {
    after(run)
  } catch {
    // Outside a request scope (after() unavailable) — fall back to detached.
    void run()
  }
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
