import { NextResponse } from 'next/server'

import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'

export const CRON_RATE_LIMIT_MAX = 1
export const CRON_RATE_LIMIT_WINDOW_MS = 60 * 60_000
export const CRON_RATE_LIMIT_FIVE_MINUTE_MAX = 15
export const CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX = 6

export type CronRateLimitChecker = (
  key: string,
  max: number,
  windowMs: number,
) => Promise<RateLimitResult>

export type CronRateLimitOptions = {
  max?: number
  windowMs?: number
  request?: Request
  checker?: CronRateLimitChecker
}

/**
 * Cron rate limits use the application's configured rate-limit backend.
 *
 * Deployment contract:
 * - Single-process installs can use the default memory backend.
 * - Multi-replica installs must set `RATE_LIMIT_BACKEND=redis` and `REDIS_URL`
 *   so all replicas share one quota window.
 * - Keys include the verified source IP when available. This scopes leaked
 *   CRON_SECRET quota exhaustion to the caller's IP slice; rotating the secret
 *   should still be paired with clearing/restarting the rate-limit backend if
 *   an incident consumed the legitimate caller's quota.
 * - Sub-hourly jobs intentionally use headroom above exact cadence. Do not set
 *   a 5-minute cron to exactly 12/hour or a 15-minute cron to exactly 4/hour;
 *   jitter, retries, and boundary timing will deny legitimate scheduled runs.
 */
export function cronRateLimitKey(jobName: string, sourceIp?: string | null): string {
  if (sourceIp?.trim()) return `cron:${jobName}:${sourceIp.trim()}`
  return `cron:${jobName}`
}

export async function enforceCronRateLimit(
  jobName: string,
  optionsOrChecker: CronRateLimitOptions | CronRateLimitChecker = {},
): Promise<Response | null> {
  const options = typeof optionsOrChecker === 'function'
    ? { checker: optionsOrChecker }
    : optionsOrChecker
  const max = options.max ?? CRON_RATE_LIMIT_MAX
  const windowMs = options.windowMs ?? CRON_RATE_LIMIT_WINDOW_MS
  const checker = options.checker ?? checkRateLimit
  const sourceIp = options.request ? getClientIp(options.request.headers) : null
  const result = await checker(
    cronRateLimitKey(jobName, sourceIp),
    max,
    windowMs,
  )
  if (result.allowed) return null

  return NextResponse.json(
    {
      error: 'Cron job rate limited',
      jobName,
      retryAfterSec: result.retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.retryAfterSec),
      },
    },
  )
}
